/** Display-only primitives. No runtime, SDK, state, authorization or persistence imports. */
export interface ActivitySource<T> {
  snapshot(): Readonly<T>;
  subscribe(invalidate: () => void): () => void;
}
export type ActivityPhase = 'queued' | 'starting' | 'working' | 'compacting' | 'retry-wait'
  | 'waiting-approval' | 'paused' | 'checking' | 'applying' | 'cancelling'
  | 'cleanup' | 'completed' | 'failed' | 'cancelled' | 'unknown' | 'recovered';
export type ActivityCleanup = 'pending' | 'settled' | 'unknown';
export interface ActivityLineage {
  workflowRunId: string; familyId: string; attemptNo: number; stepId: string;
  unitId: string; inputHash: string; blockId?: string; iterationId?: string; iterationNo?: number;
}
export interface NativeActivityMember {
  parentRunId: string; memberRunId: string; taskId?: string; piSessionId?: string;
  agentDefinitionId: string; phase: ActivityPhase;
  attachment?: 'attached' | 'disposed' | 'unavailable'; cleanup: ActivityCleanup;
  /** Only owned SDK agent_start/end or compaction boundaries, never metadata.running. */
  observedExecution?: boolean;
  /** Existing native agent and task metadata must independently agree for a workflow join. */
  lineage?: ActivityLineage; taskLineage?: ActivityLineage;
}
export interface NativeActivityRun {
  runId: string; taskId?: string; teamId?: string; label?: string; startedAt: string; endedAt?: string;
  phase: ActivityPhase; local: boolean; members: readonly NativeActivityMember[];
}
export interface NativeActivitySnapshot { revision: number; runs: readonly NativeActivityRun[]; clipped: boolean }
export interface WorkflowActivityUnit extends ActivityLineage {
  status: string; kind: string; phase?: string; approvalStatus?: string;
  cleanup: ActivityCleanup; admitted: boolean; nativeRunId?: string; nativeTaskId?: string; reused: boolean;
}
export interface ActivityProgress {
  basis: 'top-level-steps'; total: number | null; completed: number; reused: number;
  failed: number; skipped: number; cancelled: number; unverified: number; reusedUnits: number;
}
export interface WorkflowActivityRun {
  workflowRunId: string; familyId: string; attemptNo: number;
  retryOf?: string; recoveryOf?: string; supersededBy?: string; definitionId: string; label?: string;
  startedAt: string; updatedAt: string; status: string; recovered: boolean; local: boolean;
  cleanup: ActivityCleanup; uncertain: boolean; progress: ActivityProgress;
  units: readonly WorkflowActivityUnit[];
}
export interface WorkflowActivitySnapshot {
  revision: number; available: boolean; uncertain: boolean;
  runs: readonly WorkflowActivityRun[]; clipped: boolean;
}
export interface ActivityFocus {
  key: string; kind: 'native' | 'workflow'; runId: string; familyId?: string; attemptNo?: number; label?: string;
  startedAt: string; endedAt?: string; phase: ActivityPhase; progress?: ActivityProgress;
}
export interface ActivityProjection {
  clipped: boolean;
  counts: { working: number; starting: number; queuedAgents: number; queuedUnits: number;
    waitingApproval: number; checking: number; applying: number; cleanup: number; unknown: number };
  focus?: ActivityFocus;
  attention: readonly { key: string; runId: string; phase: ActivityPhase }[];
  detail: readonly { parentRunId: string; memberRunId: string; piSessionId?: string;
    agentDefinitionId: string; phase: ActivityPhase }[];
  moreRuns: number;
}
export const ACTIVITY_LIMITS = Object.freeze({ nativeRuns: 32, nativeMembers: 256, workflowRuns: 16,
  workflowUnits: 256, candidates: 16, attention: 8, detail: 2, successGraceMs: 5000 });

/** Freeze only newly produced compact DTOs, never full runtime objects or SDK handles. */
function immutable<T>(value: T): Readonly<T> {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
      if (!('value' in descriptor)) throw new Error('Activity DTO must contain data only');
      immutable(descriptor.value);
    }
    Object.freeze(value);
  }
  return value;
}
export function createActivityChannel<T>(initial: T): {
  source: ActivitySource<T>; publish(value: T): void;
} {
  let cached = immutable(initial), scheduled = false;
  const listeners = new Set<() => void>();
  const source = Object.freeze({ snapshot: () => cached, subscribe(invalidate: () => void) {
    listeners.add(invalidate); return () => { listeners.delete(invalidate); };
  } });
  return { source, publish(value) {
    cached = immutable(value);
    if (scheduled || listeners.size === 0) return;
    scheduled = true;
    queueMicrotask(() => { scheduled = false; for (const listener of [...listeners]) {
      if (listeners.has(listener)) { try { listener(); } catch { /* Observation cannot affect execution. */ } }
    } });
  } };
}
export const EMPTY_NATIVE_ACTIVITY: Readonly<NativeActivitySnapshot> = immutable({ revision: 0, runs: [], clipped: false });
export const UNAVAILABLE_WORKFLOW_ACTIVITY: Readonly<WorkflowActivitySnapshot> = immutable({ revision: 0,
  available: false, uncertain: false, runs: [], clipped: false });

const lineageFields = ['workflowRunId', 'familyId', 'attemptNo', 'stepId', 'unitId', 'inputHash',
  'blockId', 'iterationId', 'iterationNo'] as const;
function sameLineage(a: ActivityLineage | undefined, b: ActivityLineage): boolean {
  return !!a && lineageFields.every(field => a[field] === b[field]);
}
function joined(member: NativeActivityMember, run: WorkflowActivityRun, unit: WorkflowActivityUnit): boolean {
  return run.local && !run.recovered && !unit.reused
    && run.workflowRunId === unit.workflowRunId && run.familyId === unit.familyId && run.attemptNo === unit.attemptNo
    && member.memberRunId === unit.nativeRunId
    && !!member.taskId && member.taskId === unit.nativeTaskId
    && sameLineage(member.lineage, unit) && sameLineage(member.taskLineage, unit);
}
const terminalPhases = new Set<ActivityPhase>(['completed', 'failed', 'cancelled', 'unknown', 'recovered']);
const time = (stamp: string | undefined) => stamp ? Date.parse(stamp) : NaN;
function successVisible(end: string | undefined, nowMs: number): boolean {
  const elapsed = nowMs - time(end); return elapsed >= 0 && elapsed < ACTIVITY_LIMITS.successGraceMs;
}
/** Pure bounded observer projection. Counts are lower bounds when any source is clipped. */
export function projectActivity(native: Readonly<NativeActivitySnapshot>, workflows: Readonly<WorkflowActivitySnapshot>,
  nowMs: number, previousFocus?: string): ActivityProjection {
  const counts: ActivityProjection['counts'] = { working: 0, starting: 0, queuedAgents: 0, queuedUnits: 0,
    waitingApproval: 0, checking: 0, applying: 0, cleanup: 0, unknown: 0 };
  let clipped = native.clipped || workflows.clipped, visibleRuns = 0, memberCount = 0;
  if (!workflows.available && workflows.uncertain) counts.unknown++;
  type Candidate = { focus: ActivityFocus; rank: number };
  const candidates: Candidate[] = [], attention: ActivityProjection['attention'][number][] = [];
  const details: Array<ActivityProjection['detail'][number] & { focusKey: string }> = [];
  const order = (a: Candidate, b: Candidate) => a.rank - b.rank
    || Number(b.focus.key === previousFocus) - Number(a.focus.key === previousFocus)
    || (time(a.focus.startedAt) || 0) - (time(b.focus.startedAt) || 0)
    || a.focus.key.localeCompare(b.focus.key);
  const add = (focus: ActivityFocus, rank: number) => {
    visibleRuns++;
    candidates.push({ focus, rank }); candidates.sort(order);
    if (candidates.length > ACTIVITY_LIMITS.candidates) candidates.pop();
  };
  const workflowRuns = workflows.runs.slice(0, ACTIVITY_LIMITS.workflowRuns);
  if (workflows.runs.length > workflowRuns.length) clipped = true;
  // At most 4096 compact units, no payload or full-state traversal.
  const unitsByNative = new Map<string, Array<{ run: WorkflowActivityRun; unit: WorkflowActivityUnit }>>();
  const workflowKeys = new Set<string>();
  for (const run of workflowRuns) {
    if (workflowKeys.has(run.workflowRunId)) { clipped = true; continue; }
    workflowKeys.add(run.workflowRunId);
    const units = run.units.slice(0, ACTIVITY_LIMITS.workflowUnits);
    if (run.units.length > units.length) clipped = true;
    let approval = false, checking = false, applying = false, unknown = run.uncertain || run.cleanup === 'unknown';
    const seenUnits = new Set<string>();
    for (const unit of units) {
      const unitKey = JSON.stringify(lineageFields.map(field => unit[field]));
      if (seenUnits.has(unitKey)) { clipped = true; unknown = true; continue; }
      seenUnits.add(unitKey);
      if (unit.nativeRunId && unit.nativeTaskId) {
        const key = JSON.stringify([unit.nativeRunId, unit.nativeTaskId]);
        const entries = unitsByNative.get(key) ?? []; entries.push({ run, unit }); unitsByNative.set(key, entries);
      }
      if (!run.local || run.recovered || run.uncertain || unit.reused) continue;
      if (unit.status === 'queued') counts.queuedUnits++;
      const pendingApproval = unit.status === 'running' && unit.approvalStatus === 'pending';
      if (pendingApproval) { counts.waitingApproval++; approval = true; }
      // Receipts/postcheck phases are settlement observations, not continued check work.
      if (unit.status === 'running' && unit.admitted && unit.cleanup === 'pending' && !pendingApproval) {
        if (['check', 'check-intent', 'check-ready'].includes(unit.phase ?? '')) { counts.checking++; checking = true; }
        if (unit.phase === 'applying' || unit.phase === 'apply') { counts.applying++; applying = true; }
      }
      if (unit.cleanup === 'unknown' || unit.status === 'unverified') unknown = true;
    }
    if (unknown) counts.unknown++;
    const settling = run.cleanup === 'pending' && (run.status === 'cancelling'
      || ['completed', 'failed', 'cancelled'].includes(run.status)
      || units.some(unit => unit.status === 'running' && unit.phase === 'check-receipt'));
    if (settling) counts.cleanup++;
    const historical = !run.local || run.recovered;
    const phase: ActivityPhase = historical ? (unknown ? 'unknown' : 'recovered')
      : approval ? 'waiting-approval' : unknown || run.status === 'needs-attention' ? 'unknown'
      : run.status === 'failed' ? 'failed' : run.status === 'cancelling' ? 'cancelling'
      : checking ? 'checking' : applying ? 'applying' : settling ? 'cleanup' : run.status === 'paused' ? 'paused'
      : run.status === 'completed' ? (run.cleanup === 'settled' ? 'completed' : 'cleanup')
      : run.status === 'cancelled' ? (run.cleanup === 'settled' ? 'cancelled' : 'cleanup') : 'starting';
    const focus: ActivityFocus = { key: `workflow:${run.workflowRunId}`, kind: 'workflow', runId: run.workflowRunId,
      familyId: run.familyId, attemptNo: run.attemptNo, ...(run.label ? { label: run.label.slice(0, 128) } : {}), startedAt: run.startedAt, phase, progress: { ...run.progress },
      ...(['completed', 'failed', 'cancelled'].includes(run.status) ? { endedAt: run.updatedAt } : {}) };
    if (run.supersededBy && run.cleanup === 'settled' && ['failed', 'completed', 'cancelled'].includes(phase)) continue;
    if (historical) {
      // One static historical notice; never priority over local activity or new success grace.
      if (unknown) add(focus, 4);
    } else if (phase === 'waiting-approval') add(focus, 0);
    else if (phase === 'failed' || phase === 'unknown') add(focus, 1);
    else if (!terminalPhases.has(phase)) add(focus, 2);
    else if (phase === 'completed' && successVisible(run.updatedAt, nowMs)) add(focus, 3);
  }
  const memberKey = (member: NativeActivityMember) => JSON.stringify([member.parentRunId, member.memberRunId, member.piSessionId ?? null]);
  const canonical = new Map<string, NativeActivityMember>(), conflicts = new Set<string>();
  const sessionOwners = new Map<string, string>();
  let inspected = 0;
  outer: for (const run of native.runs.slice(0, ACTIVITY_LIMITS.nativeRuns)) for (let index = 0; index < run.members.length; index++) {
    if (inspected >= ACTIVITY_LIMITS.nativeMembers) { clipped = true; break outer; }
    const member = run.members[index]; inspected++;
    const key = memberKey(member), old = canonical.get(key);
    if (member.piSessionId) {
      const ownerKey = sessionOwners.get(member.piSessionId);
      if (ownerKey && ownerKey !== key) { conflicts.add(ownerKey); conflicts.add(key); }
      else sessionOwners.set(member.piSessionId, key);
    }
    if (!old) canonical.set(key, member);
    else if (old.phase !== member.phase || old.observedExecution !== member.observedExecution
      || old.taskId !== member.taskId || old.cleanup !== member.cleanup || old.attachment !== member.attachment
      || !lineageFields.every(f => old.lineage?.[f] === member.lineage?.[f] && old.taskLineage?.[f] === member.taskLineage?.[f])) conflicts.add(key);
  }
  const workingWorkflows = new Set<string>();
  const seenMembers = new Set<string>(), seenRuns = new Set<string>();
  for (const run of native.runs.slice(0, ACTIVITY_LIMITS.nativeRuns)) {
    if (seenRuns.has(run.runId)) { clipped = true; continue; } seenRuns.add(run.runId);
    let linkedRun: WorkflowActivityRun | undefined, ambiguous = false;
    let hasWork = false, hasAgentWork = false, hasStart = false, hasQueue = false, hasUnknownPhase = false;
    let hasCleanup = false, hasRetryWait = false;
    let hasUnknownCleanup = false, hasPendingCleanup = false, allCleanupSettled = true, inspectedAll = true;
    const runDetails: typeof details = [];
    for (let index = 0; index < run.members.length; index++) {
      if (memberCount >= ACTIVITY_LIMITS.nativeMembers) { clipped = true; inspectedAll = false; break; }
      const member = run.members[index]; memberCount++;
      hasUnknownCleanup ||= member.cleanup === 'unknown';
      hasUnknownPhase ||= member.phase === 'unknown';
      hasPendingCleanup ||= member.cleanup === 'pending';
      allCleanupSettled &&= member.cleanup === 'settled';
      const key = memberKey(member);
      if (seenMembers.has(key)) continue;
      seenMembers.add(key);
      if (conflicts.has(key)) { counts.unknown++; ambiguous = true; continue; }
      if (!run.local) continue;
      const matches = (unitsByNative.get(JSON.stringify([member.memberRunId, member.taskId])) ?? [])
        .filter(entry => joined(member, entry.run, entry.unit));
      const hasWorkflow = !!member.lineage || !!member.taskLineage;
      const match = hasWorkflow && matches.length === 1 ? matches[0] : undefined;
      const linked = match?.run;
      if (linked) linkedRun = linked;
      if (hasWorkflow && !linked) { counts.unknown++; ambiguous = true; continue; }
      // Linked workflows already count cleanup on their own run basis.
      if (!linked && member.cleanup === 'pending'
        && ['cleanup', 'cancelling', 'completed', 'failed', 'cancelled'].includes(member.phase)) counts.cleanup++;
      const execution = (!match || (!match.run.uncertain && match.unit.status === 'running'
        && match.unit.admitted && match.unit.cleanup === 'pending')) && member.observedExecution === true && !!member.piSessionId && member.attachment === 'attached'
        && member.cleanup === 'pending' && ['working', 'compacting'].includes(member.phase)
        && !['cancelling', 'cleanup', 'failed', 'unknown', 'cancelled', 'recovered', 'completed'].includes(run.phase);
      if (execution) { counts.working++; hasWork = true; hasAgentWork ||= member.phase === 'working'; if (linked) workingWorkflows.add(linked.workflowRunId); }
      else if (member.phase === 'starting' && member.cleanup !== 'unknown') { counts.starting++; hasStart = true; }
      else if (member.phase === 'queued') { counts.queuedAgents++; hasQueue = true; }
      hasCleanup ||= member.cleanup === 'pending' && member.phase === 'cleanup';
      hasRetryWait ||= member.phase === 'retry-wait';
      if (!linked && (member.cleanup === 'unknown' || member.phase === 'unknown'
        || (!execution && ['working', 'compacting'].includes(member.phase)))) counts.unknown++;
      if (runDetails.length < ACTIVITY_LIMITS.detail && (execution || member.phase === 'starting' || member.phase === 'retry-wait')) {
        runDetails.push({ parentRunId: member.parentRunId, memberRunId: member.memberRunId,
          piSessionId: member.piSessionId, agentDefinitionId: member.agentDefinitionId,
          phase: execution ? member.phase : member.phase === 'working' ? 'unknown' : member.phase,
          focusKey: linked ? `workflow:${linked.workflowRunId}` : `native:${run.runId}` });
      }
    }
    details.push(...runDetails);
    if (!run.local || linkedRun) continue; // An exact workflow join has one displayed run, not two.
    const phase: ActivityPhase = ambiguous || hasUnknownCleanup || hasUnknownPhase ? 'unknown'
      : ['completed', 'cancelled'].includes(run.phase) && hasPendingCleanup ? 'cleanup' : hasWork ? (hasAgentWork ? 'working' : 'compacting') : hasStart ? 'starting'
      : hasCleanup ? 'cleanup' : hasRetryWait ? 'retry-wait' : hasQueue ? 'queued' : run.phase === 'working' || run.phase === 'compacting' ? 'unknown' : run.phase;
    const focus: ActivityFocus = { key: `native:${run.runId}`, kind: 'native', runId: run.runId,
      startedAt: run.startedAt, endedAt: run.endedAt, phase, ...(run.label ? { label: run.label.slice(0, 128) } : {}) };
    if (phase === 'failed' || phase === 'unknown') add(focus, 1);
    else if (!terminalPhases.has(phase)) add(focus, 2);
    else if (phase === 'completed' && inspectedAll && allCleanupSettled && successVisible(run.endedAt, nowMs)) add(focus, 3);
  }
  if (native.runs.length > ACTIVITY_LIMITS.nativeRuns) clipped = true;
  // Native SDK evidence decorates workflow display, never adds a second workflow working count.
  for (const candidate of candidates) if (candidate.focus.kind === 'workflow' && candidate.focus.phase === 'starting'
    && workingWorkflows.has(candidate.focus.runId)) candidate.focus.phase = 'working';
  for (const candidate of candidates) if ((candidate.rank === 0 || candidate.rank === 1 || candidate.rank === 4)
    && attention.length < ACTIVITY_LIMITS.attention) attention.push({ key: candidate.focus.key,
      runId: candidate.focus.runId, phase: candidate.focus.phase });
  const focus = candidates[0]?.focus;
  return immutable({ clipped, counts, ...(focus ? { focus } : {}), attention,
    detail: details.filter(d => d.focusKey === focus?.key).slice(0, ACTIVITY_LIMITS.detail).map(({ focusKey: _, ...d }) => d),
    moreRuns: Math.max(0, visibleRuns - (focus ? 1 : 0)) });
}

/** Owner-only bounded primitive recorder. It observes, never admits or cancels work. */
export interface NativeActivityRecorder {
  readonly source: ActivitySource<NativeActivitySnapshot>;
  begin(run: Omit<NativeActivityRun, 'members' | 'local'>): void;
  member(parentRunId: string, member: NativeActivityMember): void;
  patch(parentRunId: string, memberRunId: string, patch: Partial<NativeActivityMember>): void;
  event(parentRunId: string, memberRunId: string, type: string | undefined): void;
  cancel(parentRunId: string): void;
  finish(parentRunId: string, phase: ActivityPhase, endedAt?: string): void;
}
export function createNativeActivityRecorder(): NativeActivityRecorder {
  const channel = createActivityChannel<NativeActivitySnapshot>({ ...EMPTY_NATIVE_ACTIVITY });
  const runs = new Map<string, NativeActivityRun>();
  let revision = 0, members = 0, clipped = false;
  const publish = () => channel.publish({ revision: ++revision, runs: [...runs.values()], clipped });
  const evict = () => {
    for (const [id, run] of runs) if (['completed', 'failed', 'cancelled'].includes(run.phase)
      && run.members.every(member => member.cleanup === 'settled')) {
      members -= run.members.length; runs.delete(id); return true;
    }
    return false;
  };
  const primitiveMember = (member: NativeActivityMember): NativeActivityMember => ({
    parentRunId: member.parentRunId, memberRunId: member.memberRunId, taskId: member.taskId,
    piSessionId: member.piSessionId, agentDefinitionId: member.agentDefinitionId, phase: member.phase,
    attachment: member.attachment, cleanup: member.cleanup, observedExecution: member.observedExecution,
    ...(member.lineage ? { lineage: activityLineage(member.lineage) } : {}),
    ...(member.taskLineage ? { taskLineage: activityLineage(member.taskLineage) } : {}),
  });
  const patch = (id: string, memberId: string, change: Partial<NativeActivityMember>) => {
    const run = runs.get(id), old = run?.members.find(member => member.memberRunId === memberId);
    if (!run || !old) return;
    runs.set(id, { ...run, members: run.members.map(member => member === old ? primitiveMember({ ...old, ...change,
      parentRunId: old.parentRunId, memberRunId: old.memberRunId }) : member) }); publish();
  };
  return {
    source: channel.source,
    begin(run) {
      if (runs.has(run.runId)) return;
      while (runs.size >= ACTIVITY_LIMITS.nativeRuns && evict()) { /* Observer retention only. */ }
      if (runs.size >= ACTIVITY_LIMITS.nativeRuns) { clipped = true; publish(); return; }
      runs.set(run.runId, { runId: run.runId, taskId: run.taskId, teamId: run.teamId,
        label: run.label?.slice(0, 128), startedAt: run.startedAt, endedAt: run.endedAt, phase: run.phase, local: true, members: [] }); publish();
    },
    member(id, member) {
      const run = runs.get(id); if (!run) return;
      if (run.members.some(old => old.memberRunId === member.memberRunId)) { patch(id, member.memberRunId, member); return; }
      while (members >= ACTIVITY_LIMITS.nativeMembers && evict()) { /* Only settled observer rows. */ }
      if (members >= ACTIVITY_LIMITS.nativeMembers) { clipped = true; publish(); return; }
      members++; runs.set(id, { ...run, members: [...run.members, primitiveMember({ ...member, parentRunId: id })] }); publish();
    }, patch,
    event(id, memberId, type) {
      const run = runs.get(id), member = run?.members.find(member => member.memberRunId === memberId);
      if (!member || member.cleanup !== 'pending' || ['cancelling', 'cleanup', 'completed', 'failed', 'cancelled'].includes(run!.phase)
        || ['cancelling', 'cleanup'].includes(member.phase)) return;
      const phase: ActivityPhase | undefined = type === 'agent_start' ? 'working' : type === 'compaction_start' ? 'compacting'
        : type === 'auto_retry_start' || type === 'summarization_retry_scheduled' ? 'retry-wait'
        : type === 'summarization_retry_attempt_start' ? 'compacting'
        : type === 'agent_settled' ? 'cleanup'
        : ['agent_end', 'compaction_end', 'auto_retry_end', 'summarization_retry_finished'].includes(type ?? '') ? 'unknown' : undefined;
      if (phase) patch(id, memberId, { phase, observedExecution: phase === 'working' || phase === 'compacting' });
    },
    cancel(id) {
      const run = runs.get(id); if (!run) return;
      runs.set(id, { ...run, phase: 'cancelling', members: run.members.map(member => member.cleanup === 'settled' ? member
        : { ...member, phase: member.phase === 'queued' ? 'cancelled' : 'cancelling', observedExecution: false,
          cleanup: member.phase === 'queued' ? 'settled' : member.cleanup }) }); publish();
    },
    finish(id, phase, endedAt) {
      const run = runs.get(id); if (!run) return;
      runs.set(id, { ...run, phase, endedAt, members: run.members.map(member => member.phase === 'queued'
        ? { ...member, phase: phase === 'cancelled' ? 'cancelled' : 'failed', cleanup: 'settled', observedExecution: false }
        : member.cleanup === 'pending' ? { ...member, phase: 'unknown', cleanup: 'unknown', observedExecution: false } : member) }); publish();
    },
  };
}

/** Full primitive lineage copied independently from canonical agent and task records. */
export function activityLineage(value: unknown): ActivityLineage | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  if (!['workflowRunId', 'familyId', 'stepId', 'unitId', 'inputHash'].every(key => typeof v[key] === 'string')
    || !Number.isSafeInteger(v.attemptNo) || (v.attemptNo as number) < 1
    || ['blockId', 'iterationId'].some(key => v[key] !== undefined && typeof v[key] !== 'string')
    || v.iterationNo !== undefined && !Number.isSafeInteger(v.iterationNo)) return undefined;
  return Object.fromEntries(lineageFields.filter(key => v[key] !== undefined).map(key => [key, v[key]])) as unknown as ActivityLineage;
}
