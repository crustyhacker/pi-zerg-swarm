import { isAbsolute } from 'node:path';
import { validateAutomationRequest, type AutomationProfileV1, type AutomationRequestV1 } from './automation-profile.js';
import { freezeWorkflowData, normalizeWorkflowAgent, workflowAssert, workflowHash, workflowJson, workflowStepEntries, workflowView } from './workflow-model.js';
import type { WorkflowRun, WorkflowState, WorkflowView } from './workflow-model.js';

/** Admission metadata only. Workflow state remains the sole execution/cleanup truth. */
export const AUTOMATION_EXTENSION_KEY = 'automation';
export const AUTOMATION_LEDGER_BYTES = 32768;
export interface AutomationEventBindingV1 {
  eventId: string; occurrenceTime: string; profileGenerationHash: string; definitionHash: string; fixedInputsHash: string;
  workflowRunId: string; familyId: string; attemptNo: 1; ownerGeneration: string; acceptedAt: number;
}
export interface AutomationLedgerV1 {
  version: 1; namespace: string; profileId: string; projectRoot: string; snapshotFile: string; profileGenerationHash: string;
  rejectBefore: number; lastOccurrence: number; lastAcceptedAt: number; clockWatermark: number;
  events: AutomationEventBindingV1[];
}
export type AutomationLookup = { kind: 'missing' } | { kind: 'duplicate' | 'conflict'; binding: AutomationEventBindingV1 };
const digest = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const identity = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(v);
const millis = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= 8640000000000000;
function exact(value: object, keys: string[]): void {
  workflowAssert(value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k)), 'Invalid automation metadata fields');
}
function occurrence(value: unknown): number {
  workflowAssert(typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value), 'Invalid automation occurrence');
  const time = Date.parse(value); workflowAssert(millis(time) && new Date(time).toISOString() === value, 'Invalid automation occurrence'); return time;
}
function namespace(profile: Pick<AutomationProfileV1, 'id' | 'projectRoot' | 'snapshotFile'>): string {
  return workflowHash({ profileId: profile.id, projectRoot: profile.projectRoot, snapshotFile: profile.snapshotFile });
}
function matchingNamespace(ledger: AutomationLedgerV1, profile: AutomationProfileV1): void {
  workflowAssert(ledger.namespace === namespace(profile) && ledger.profileId === profile.id && ledger.projectRoot === profile.projectRoot && ledger.snapshotFile === profile.snapshotFile && ledger.profileGenerationHash === profile.approvedProfileHash, 'Automation namespace/profile generation changed; explicit operator migration or new state required');
}
function requestIdentity(profile: AutomationProfileV1, request: AutomationRequestV1): number {
  const normalized = validateAutomationRequest(request);
  workflowAssert(normalized.profileId === profile.id, 'Invalid automation request identity');
  return occurrence(normalized.occurrenceTime);
}
export function validateAutomationLedger(value: unknown, workflows?: WorkflowState): AutomationLedgerV1 {
  const ledger = workflowJson(value, AUTOMATION_LEDGER_BYTES) as unknown as AutomationLedgerV1;
  exact(ledger, ['version', 'namespace', 'profileId', 'projectRoot', 'snapshotFile', 'profileGenerationHash', 'rejectBefore', 'lastOccurrence', 'lastAcceptedAt', 'clockWatermark', 'events']);
  workflowAssert(ledger.version === 1 && identity(ledger.profileId) && digest(ledger.namespace) && digest(ledger.profileGenerationHash), 'Invalid automation namespace identity');
  for (const path of [ledger.projectRoot, ledger.snapshotFile]) workflowAssert(typeof path === 'string' && path.length <= 4096 && isAbsolute(path) && !path.includes('\0'), 'Invalid automation metadata path');
  workflowAssert(ledger.namespace === namespace({ id: ledger.profileId, projectRoot: ledger.projectRoot, snapshotFile: ledger.snapshotFile }), 'Automation namespace hash mismatch');
  for (const time of [ledger.rejectBefore, ledger.lastOccurrence, ledger.lastAcceptedAt, ledger.clockWatermark]) workflowAssert(millis(time), 'Invalid automation time floor');
  workflowAssert(ledger.lastAcceptedAt <= ledger.clockWatermark, 'Automation clock floor inconsistent');
  workflowAssert(Array.isArray(ledger.events) && ledger.events.length <= 16, 'Automation retention bound exceeded');
  const ids = new Set<string>(), runs = new Set<string>(); let lastOccurrence = -1, lastAccepted = -1;
  for (const event of ledger.events) {
    exact(event, ['eventId', 'occurrenceTime', 'profileGenerationHash', 'definitionHash', 'fixedInputsHash', 'workflowRunId', 'familyId', 'attemptNo', 'ownerGeneration', 'acceptedAt']);
    const time = occurrence(event.occurrenceTime);
    workflowAssert(event.eventId === event.occurrenceTime && !ids.has(event.eventId) && time > lastOccurrence && time <= ledger.lastOccurrence, 'Automation event collision/order mismatch');
    workflowAssert(digest(event.profileGenerationHash) && event.profileGenerationHash === ledger.profileGenerationHash && digest(event.definitionHash) && digest(event.fixedInputsHash), 'Invalid automation event generation/hash');
    workflowAssert(identity(event.workflowRunId) && event.familyId === event.workflowRunId && event.attemptNo === 1 && identity(event.ownerGeneration) && !runs.has(event.workflowRunId), 'Invalid automation attempt binding');
    workflowAssert(millis(event.acceptedAt) && event.acceptedAt >= lastAccepted && event.acceptedAt <= ledger.lastAcceptedAt, 'Invalid automation acceptance time');
    ids.add(event.eventId); runs.add(event.workflowRunId); lastOccurrence = time; lastAccepted = event.acceptedAt;
  }
  if (workflows) for (const binding of ledger.events) {
    const matches = workflows.runs.filter(run => run.workflowRunId === binding.workflowRunId);
    workflowAssert(matches.length === 1, 'Automation snapshot has missing or ambiguous attempt');
    boundRun(binding, matches[0]);
  }
  return freezeWorkflowData(ledger, AUTOMATION_LEDGER_BYTES);
}
export function createAutomationLedger(profile: AutomationProfileV1): AutomationLedgerV1 {
  return validateAutomationLedger({ version: 1, namespace: namespace(profile), profileId: profile.id, projectRoot: profile.projectRoot, snapshotFile: profile.snapshotFile,
    profileGenerationHash: profile.approvedProfileHash, rejectBefore: 0, lastOccurrence: 0, lastAcceptedAt: 0, clockWatermark: 0, events: [] });
}
export function lookupAutomationEvent(raw: AutomationLedgerV1, profile: AutomationProfileV1, request: AutomationRequestV1): AutomationLookup {
  const ledger = validateAutomationLedger(raw); requestIdentity(profile, request);
  workflowAssert(ledger.profileId === profile.id && ledger.namespace === namespace(profile), 'Automation namespace mismatch');
  const binding = ledger.events.find(e => e.eventId === request.eventId);
  if (!binding) { matchingNamespace(ledger, profile); return { kind: 'missing' }; }
  return { kind: binding.profileGenerationHash === profile.approvedProfileHash && binding.definitionHash === profile.definitionHash && binding.fixedInputsHash === workflowHash(profile.fixedInputs) ? 'duplicate' : 'conflict', binding };
}
function boundRun(binding: AutomationEventBindingV1, run: Readonly<WorkflowRun>): void {
  workflowAssert(binding.workflowRunId === run.workflowRunId && binding.familyId === run.familyId && binding.attemptNo === run.attemptNo && !run.retryOf && !run.recoveryOf && binding.definitionHash === run.definitionHash && run.definitionHash === workflowHash(run.definition) && binding.fixedInputsHash === workflowHash(run.inputs), 'Automation event/attempt binding mismatch');
}
export function reserveAutomationEvent(raw: AutomationLedgerV1, profile: AutomationProfileV1, request: AutomationRequestV1, run: Readonly<WorkflowRun>, ownerGeneration: string, now: number): AutomationLedgerV1 {
  const ledger = validateAutomationLedger(raw); matchingNamespace(ledger, profile);
  const time = requestIdentity(profile, request);
  workflowAssert(profile.enabled === true, 'Automation profile disabled');
  workflowAssert(lookupAutomationEvent(ledger, profile, request).kind === 'missing', 'Automation duplicate/conflict never grants replay');
  workflowAssert(millis(now) && now >= ledger.clockWatermark, 'Automation clock rollback');
  workflowAssert(time > ledger.rejectBefore && time > ledger.lastOccurrence && time >= now - profile.limits.maxEventAgeMs && time <= now + profile.limits.maxFutureSkewMs, 'Automation event expired, stale or future');
  workflowAssert(ledger.lastAcceptedAt === 0 || now - ledger.lastAcceptedAt >= profile.limits.minIntervalMs, 'Automation frequency limit');
  workflowAssert(ledger.events.length < profile.limits.maxRetainedEvents && ledger.events.length < 16, 'Automation retention full; uncertain records cannot be evicted');
  workflowAssert(identity(ownerGeneration) && run.status === 'running' && !run.recovered && run.admissions === 0 && run.cleanupSettled && run.attemptNo === 1 && run.familyId === run.workflowRunId && !run.supersededBy && run.definition.id === profile.definitionId && run.concurrency <= profile.limits.concurrency && workflowHash(run.agents) === workflowHash(Object.fromEntries(profile.agents.filter(agent => Object.hasOwn(run.agents, agent.id)).map(agent => [agent.id, normalizeWorkflowAgent(agent)]))), 'Automation reservation requires exact fresh profile attempt');
  workflowAssert(workflowStepEntries(run as WorkflowRun).every(({ step }) => step.status === 'queued' && step.units.length === 0 && !step.iterations?.length), 'Automation attempt already started');
  const binding: AutomationEventBindingV1 = { eventId: request.eventId, occurrenceTime: request.occurrenceTime, profileGenerationHash: profile.approvedProfileHash, definitionHash: profile.definitionHash, fixedInputsHash: workflowHash(profile.fixedInputs), workflowRunId: run.workflowRunId, familyId: run.familyId, attemptNo: 1, ownerGeneration, acceptedAt: now };
  boundRun(binding, run);
  return validateAutomationLedger({ ...ledger, lastOccurrence: time, lastAcceptedAt: now, clockWatermark: now, events: [...ledger.events, binding] });
}
/** Validate the ONLY metadata mutation permitted from a trusted start hook. */
export function validateAutomationReservation(previous: unknown, value: unknown, run: Readonly<WorkflowRun>): AutomationLedgerV1 {
  const next = validateAutomationLedger(value);
  const old = previous === undefined ? undefined : validateAutomationLedger(previous);
  workflowAssert(next.events.length === (old?.events.length ?? 0) + 1, 'Reservation must append exactly one event');
  if (old) {
    for (const key of ['version', 'namespace', 'profileId', 'projectRoot', 'snapshotFile', 'profileGenerationHash'] as const) workflowAssert(old[key] === next[key], 'Reservation cannot replace namespace');
    workflowAssert(next.rejectBefore === old.rejectBefore && next.lastOccurrence > old.lastOccurrence && next.lastAcceptedAt >= old.lastAcceptedAt && next.clockWatermark >= old.clockWatermark, 'Reservation cannot lower or rewrite floors');
    workflowAssert(workflowHash(next.events.slice(0, -1)) === workflowHash(old.events), 'Reservation cannot rewrite existing event bindings');
  }
  const binding = next.events.at(-1)!; boundRun(binding, run);
  workflowAssert(binding.acceptedAt === next.lastAcceptedAt && binding.acceptedAt === next.clockWatermark && occurrence(binding.occurrenceTime) === next.lastOccurrence && next.lastOccurrence > next.rejectBefore, 'Reservation floors mismatch');
  return next;
}
export function projectAutomationEvent(raw: AutomationLedgerV1, workflows: WorkflowState, profile: AutomationProfileV1, request: AutomationRequestV1): { lookup: AutomationLookup; view?: WorkflowView } {
  const lookup = lookupAutomationEvent(raw, profile, request);
  if (lookup.kind === 'missing') return { lookup };
  const matches = workflows.runs.filter(r => r.workflowRunId === lookup.binding.workflowRunId);
  workflowAssert(matches.length === 1, 'Reserved automation attempt missing or ambiguous'); boundRun(lookup.binding, matches[0]);
  return { lookup, view: freezeWorkflowData(workflowView(matches[0])) };
}
export function pruneAutomationEvents(raw: AutomationLedgerV1, workflows: WorkflowState, profile: AutomationProfileV1, now: number): { ledger: AutomationLedgerV1; workflows: WorkflowState; removedWorkflowRunIds: string[] } {
  const ledger = validateAutomationLedger(raw); matchingNamespace(ledger, profile);
  workflowAssert(millis(now) && now >= ledger.clockWatermark, 'Automation clock rollback');
  const state = workflowJson(workflows, 2097152) as unknown as WorkflowState;
  const removedWorkflowRunIds: string[] = [];
  const referenced = (run: WorkflowRun) => state.runs.some(other => other !== run && JSON.stringify(other).includes(JSON.stringify(run.workflowRunId)));
  const events = ledger.events.filter(binding => {
    const matches = state.runs.filter(r => r.workflowRunId === binding.workflowRunId);
    workflowAssert(matches.length === 1, 'Automation retention attempt missing or ambiguous');
    const run = matches[0]; boundRun(binding, run);
    const safe = ['completed', 'failed', 'cancelled'].includes(run.status) && run.cleanupSettled && !referenced(run) && !run.retryOf && !run.recoveryOf && !run.supersededBy && !run.recovery?.selection && !run.recovery?.origin
      && (!run.recovery || run.recovery.operations.every(op => op.result?.cleanup === 'settled' && op.result.status !== 'uncertain'))
      && workflowStepEntries(run).every(({ step }) => !['queued', 'running', 'unverified'].includes(step.status) && step.units.every(unit => unit.cleanupSettled && !['queued', 'running', 'unverified'].includes(unit.status)));
    if (occurrence(binding.occurrenceTime) < now - profile.limits.maxEventAgeMs && safe) { removedWorkflowRunIds.push(run.workflowRunId); return false; }
    return true;
  });
  const rejectBefore = Math.max(ledger.rejectBefore, ...ledger.events.filter(e => removedWorkflowRunIds.includes(e.workflowRunId)).map(e => occurrence(e.occurrenceTime)));
  return { ledger: validateAutomationLedger({ ...ledger, events, rejectBefore, clockWatermark: now }), workflows: freezeWorkflowData({ ...state, runs: state.runs.filter(r => !removedWorkflowRunIds.includes(r.workflowRunId)) }, 2097152), removedWorkflowRunIds };
}
