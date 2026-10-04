import { randomUUID } from 'node:crypto';
import type { ZergAgentDefinition, ZergStateContainer } from './types.js';
import { WORKFLOW_EXTENSION_KEY, WORKFLOW_LIMITS, aggregateWorkflow, createReadOnlyReviewDefinition,
  freezeWorkflowData, normalizeWorkflowAgent, resolveWorkflowRef, validateReviewInputs, validateWorkflowDefinition, validateWorkflowValue,
  workflowAssert, workflowHash, workflowJson, workflowUnitHash, workflowUnitEnvelope, workflowView } from './workflow-model.js';
import type { WorkflowAction, WorkflowDefinition, WorkflowJson, WorkflowNativeIdentity, WorkflowNativeOutcome,
  WorkflowNativePort, WorkflowReply, WorkflowRun, WorkflowService, WorkflowServiceOptions, WorkflowState,
  WorkflowStep, WorkflowStepRun, WorkflowUnit, WorkflowUnitStatus } from './workflow-model.js';

const settled = (status: WorkflowUnitStatus) => !['queued', 'running'].includes(status);
const terminal = (run: WorkflowRun) => ['completed', 'failed', 'cancelled', 'needs-attention'].includes(run.status);
const errorText = (error: unknown) => error instanceof Error && error.message.length <= 1024 ? error.message : 'Workflow operation failed (missing or oversized diagnostic)';
const identityValid = (identity: WorkflowNativeIdentity | undefined): identity is WorkflowNativeIdentity => !!identity &&
  typeof identity.runId === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(identity.runId) &&
  typeof identity.taskId === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(identity.taskId);
const copy = <T>(value: T): T => workflowJson(value, WORKFLOW_LIMITS.ledgerBytes) as T;

const owners = new WeakMap<ZergStateContainer, symbol>();
/** Non-executing recovery. Unknown/corrupt ledgers are errors, never an empty replacement. */
export function recoverWorkflowState(value: unknown): WorkflowState {
  const state = copy(value) as WorkflowState;
  workflowAssert(state && state.version === 1 && Array.isArray(state.definitions) && Array.isArray(state.runs) &&
    Object.keys(state).every(k => ['version', 'definitions', 'runs'].includes(k)), 'Invalid workflow ledger');
  workflowAssert(state.definitions.length <= 16 && state.runs.length <= 16, 'Workflow retention limit exceeded');
  workflowAssert(new Set(state.definitions.map(d => d.id)).size === state.definitions.length && new Set(state.runs.map(r => r.workflowRunId)).size === state.runs.length, 'Duplicate workflow identities');
  state.definitions = state.definitions.map(validateWorkflowDefinition);
  for (const run of state.runs) {
    const def = validateWorkflowDefinition(run.definition);
    workflowAssert(Object.keys(run).every(k => ['workflowRunId', 'familyId', 'attemptNo', 'retryOf', 'supersededBy', 'definition', 'definitionHash', 'inputs', 'agents', 'concurrency', 'status', 'createdAt', 'updatedAt', 'admissions', 'cleanupSettled', 'recovered', 'steps', 'report', 'error'].includes(k)), 'Unknown run ledger field');
    workflowAssert(typeof run.workflowRunId === 'string' && run.workflowRunId.length > 0 && run.workflowRunId.length <= 160 && typeof run.familyId === 'string' && run.familyId.length > 0 &&
      Number.isSafeInteger(run.attemptNo) && run.attemptNo >= 1 && run.attemptNo <= 3 && Number.isSafeInteger(run.admissions) && run.admissions >= 0 && run.admissions <= 256 &&
      Number.isSafeInteger(run.concurrency) && run.concurrency >= 1 && run.concurrency <= 32 &&
      typeof run.cleanupSettled === 'boolean' && typeof run.recovered === 'boolean' &&
      ['running', 'paused', 'cancelling', 'completed', 'failed', 'cancelled', 'needs-attention'].includes(run.status) &&
      typeof run.createdAt === 'string' && Number.isFinite(Date.parse(run.createdAt)) && typeof run.updatedAt === 'string' && Number.isFinite(Date.parse(run.updatedAt)) &&
      workflowHash(def) === run.definitionHash, 'Invalid workflow run');
    run.definition = def; run.inputs = workflowJson(run.inputs, WORKFLOW_LIMITS.inputBytes); validateWorkflowValue(run.inputs, def.inputSchema);
    workflowAssert(run.agents && typeof run.agents === 'object' && Array.isArray(run.steps) && run.steps.length === def.steps.length, 'Invalid workflow steps/agents');
    if (def.id === 'read-only-review') validateReviewInputs(run.inputs);
    if (run.report !== undefined) workflowJson(run.report);
    const expectedAgents = [...new Set(def.steps.filter(s => s.kind === 'native').map(s => s.agentId!))].sort();
    workflowAssert(Object.keys(run.agents).sort().join(',') === expectedAgents.join(','), 'Frozen agent set mismatch');
    for (const agent of Object.values(run.agents)) normalizeWorkflowAgent(agent);
    // Check fingerprints before recovery changes any dependency status.
    for (const [i, step] of run.steps.entries()) for (const unit of step.units)
      workflowAssert(unit.inputHash === workflowUnitHash(run, def.steps[i], unit.inputs), 'Recovered materialized input/dependency hash mismatch');
    const ids = new Set<string>(); let live = false;
    for (const [i, step] of run.steps.entries()) {
      const spec = def.steps[i];
      workflowAssert(Object.keys(step).every(k => ['id', 'status', 'units', 'output', 'error'].includes(k)), 'Unknown step ledger field');
      if (step.output !== undefined) workflowJson(step.output);
      workflowAssert(step.id === spec.id && Array.isArray(step.units) && step.units.length <= (spec.fanout?.maxItems ?? 1) &&
        ['queued', 'running', 'completed', 'failed', 'cancelled', 'skipped', 'unverified'].includes(step.status), 'Invalid step ledger');
      if (spec.kind === 'native') {
        const agent = run.agents[spec.agentId!]; workflowAssert(agent && agent.id === spec.agentId && typeof agent.model === 'string' && agent.model.length > 0, 'Missing frozen agent');
      }
      for (const [index, unit] of step.units.entries()) {
        workflowAssert(Object.keys(unit).every(k => ['id', 'stepId', 'index', 'status', 'inputHash', 'inputs', 'result', 'error', 'native', 'cleanupSettled', 'reusedFrom'].includes(k)), 'Unknown unit ledger field');
        workflowAssert(unit.stepId === step.id && unit.id === `${step.id}:${index}` && !ids.has(unit.id) && unit.index === index &&
          typeof unit.inputHash === 'string' && /^[a-f0-9]{64}$/.test(unit.inputHash) && typeof unit.cleanupSettled === 'boolean' &&
          ['queued', 'running', 'completed', 'failed', 'cancelled', 'skipped', 'unverified'].includes(unit.status), 'Invalid unit ledger');
        ids.add(unit.id); workflowJson(unit.inputs, WORKFLOW_LIMITS.promptBytes);
        if (unit.native) workflowAssert(identityValid(unit.native), 'Invalid native identity');
        if (unit.reusedFrom) workflowAssert(typeof unit.reusedFrom.workflowRunId === 'string' && typeof unit.reusedFrom.unitId === 'string' && identityValid(unit.reusedFrom.native), 'Invalid reuse identity');
        if (unit.status === 'completed' && spec.kind === 'native') {
          workflowAssert(unit.result !== undefined && identityValid(unit.native) && unit.cleanupSettled, 'Completed unit lacks validated result/identity/settlement');
          validateWorkflowValue(workflowJson(unit.result, WORKFLOW_LIMITS.resultBytes), spec.outputSchema!);
        }
        if (unit.status === 'running') { live = true; unit.status = 'unverified'; unit.cleanupSettled = false; unit.error = 'Recovered native work is not reconnected; settlement unverified'; }
        if (unit.status === 'queued') { unit.status = 'skipped'; unit.error = 'Recovery disables automatic admission'; }
      }
      if (['running', 'queued'].includes(step.status)) { live = true; step.status = 'unverified'; step.error = 'Recovered step requires attention; no replay'; }
    }
    if (!terminal(run) || live || !run.cleanupSettled) {
      run.status = 'needs-attention'; run.cleanupSettled = false; run.error = 'Recovered work is not live or reconnected; no automatic admission';
    }
    run.recovered = true;
  }
  return state;
}

/** One owned scheduler; no SDK, tools, files, eval, arbitrary loops or automatic retries. */
export function createWorkflowService(container: ZergStateContainer, port: WorkflowNativePort, options: WorkflowServiceOptions = {}): WorkflowService {
  const now = options.now ?? (() => new Date());
  const idFactory = options.idFactory ?? randomUUID;
  const existing = container.read().extensions[WORKFLOW_EXTENSION_KEY];
  const state: WorkflowState = existing === undefined ? { version: 1, definitions: [createReadOnlyReviewDefinition()], runs: [] } : recoverWorkflowState(existing);
  const owner = Symbol('workflow-owner'); owners.set(container, owner);
  const listeners = new Set<(views: ReturnType<typeof workflowView>[]) => void>();
  const active = new Map<string, { run: WorkflowRun; unit: WorkflowUnit; controller: AbortController }>();
  const pending = new Set<Promise<void>>();
  const abortListeners = new Map<string, () => void>();
  let disposed = false, scheduled = false, pumping = false, expectedHash = '', authorityLost = false;
  let cleanupUncertain = state.runs.some(r => !r.cleanupSettled);
  let initialized = false;

  const list = () => copy(state.runs.map(workflowView));
  const ledgerCurrent = () => {
    workflowAssert(!authorityLost && owners.get(container) === owner, 'Workflow ledger ownership lost');
    workflowAssert(workflowHash(container.read().extensions[WORKFLOW_EXTENSION_KEY]) === expectedHash, 'Workflow ledger changed outside its owner');
  };
  const persist = () => {
    if (initialized) ledgerCurrent();
    else workflowAssert(owners.get(container) === owner, 'Workflow ledger ownership lost');
    const data = workflowJson(state, WORKFLOW_LIMITS.ledgerBytes);
    expectedHash = workflowHash(data);
    const current = container.read();
    container.update({ extensions: { ...current.extensions, [WORKFLOW_EXTENSION_KEY]: data } });
    if (workflowHash(container.read().extensions[WORKFLOW_EXTENSION_KEY]) !== expectedHash) {
      authorityLost = true; active.forEach(a => a.controller.abort());
      throw new Error('Workflow ledger changed during publication');
    }
    initialized = true;
    for (const listener of [...listeners]) { try { listener(list()); } catch { /* Observers cannot alter ownership or settlement. */ } }
  };
  const stamp = (run: WorkflowRun) => { run.updatedAt = now().toISOString(); };
  const authority = (run?: WorkflowRun) => {
    workflowAssert(!disposed && !cleanupUncertain, 'Workflow admission closed: disposal or uncertain cleanup'); ledgerCurrent();
    const current = container.read(); workflowAssert(!current.mode.readOnly, 'Read-only caller state blocks workflow admission');
    if (run) {
      workflowAssert(workflowHash(state.definitions.find(d => d.id === run.definition.id)) === run.definitionHash, 'Workflow definition changed');
      for (const [id, agent] of Object.entries(run.agents)) {
        workflowAssert(current.agentDefinitions[id] && workflowHash(normalizeWorkflowAgent(current.agentDefinitions[id])) === workflowHash(agent), 'Frozen agent definition/policy changed'); port.preflight(agent);
      }
    }
  };
  const freshId = () => {
    const id = idFactory(); workflowAssert(typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(id) && !state.runs.some(r => r.workflowRunId === id), 'Workflow ID collision/invalid ID'); return id;
  };
  const freezeAgents = (def: WorkflowDefinition): Record<string, ZergAgentDefinition> => {
    const agents: Record<string, ZergAgentDefinition> = {};
    for (const step of def.steps) if (step.kind === 'native' && !agents[step.agentId!]) {
      const source = container.read().agentDefinitions[step.agentId!];
      workflowAssert(source, 'Workflow agent definition not found'); const agent = normalizeWorkflowAgent(source);
      workflowAssert(agent && typeof agent.model === 'string' && agent.model.trim().length > 0, 'Workflow agents require an explicit model');
      workflowAssert(agent.maxTurns === undefined && (!agent.fallbackModels || agent.fallbackModels.length === 0) &&
        (agent.permissionMode === undefined || agent.permissionMode === 'inherit'), 'Unsupported native overrides');
      agents[agent.id] = freezeWorkflowData(agent, WORKFLOW_LIMITS.definitionBytes); port.preflight(agents[agent.id]);
    }
    return agents;
  };
  const cancelRun = (run: WorkflowRun) => {
    if (terminal(run) && run.cleanupSettled) return;
    run.status = 'cancelling'; stamp(run);
    for (const step of run.steps) {
      for (const unit of step.units) if (unit.status === 'queued') { unit.status = 'cancelled'; unit.cleanupSettled = true; }
      if (step.status === 'queued') { step.status = 'cancelled'; step.output = { status: 'cancelled', error: 'Workflow cancellation before admission' }; }
      else if (step.units.length) outputStep(run.definition.steps.find(s => s.id === step.id)!, step);
    }
    active.forEach(a => { if (a.run === run) a.controller.abort(); });
    finishRun(run); persist(); schedule();
  };
  const attachSignal = (run: WorkflowRun, signal?: AbortSignal) => {
    if (!signal) return;
    const cancel = () => { if (authorityLost || owners.get(container) !== owner) return; cancelRun(run); };
    signal.addEventListener('abort', cancel, { once: true });
    abortListeners.set(run.workflowRunId, () => signal.removeEventListener('abort', cancel));
    if (signal.aborted) cancel();
  };
  const outputsFor = (run: WorkflowRun): Record<string, WorkflowJson> => Object.fromEntries(run.steps.filter(s => s.output !== undefined).map(s => [s.id, s.output!]));
  const materialize = (run: WorkflowRun, spec: WorkflowStep, item?: WorkflowJson): Record<string, WorkflowJson> => {
    const outputs = outputsFor(run), inputs: Record<string, WorkflowJson> = {};
    for (const [key, binding] of Object.entries(spec.inputs)) inputs[key] = 'value' in binding ? binding.value : resolveWorkflowRef(binding.ref, run.inputs, outputs, item);
    return freezeWorkflowData(inputs, WORKFLOW_LIMITS.promptBytes);
  };
  const hashUnit = workflowUnitHash;
  const setOutput = (step: WorkflowStepRun, output: WorkflowJson) => {
    const old = step.output; step.output = workflowJson(output);
    try { workflowJson(state, WORKFLOW_LIMITS.ledgerBytes); }
    catch (error) { if (old === undefined) delete step.output; else step.output = old; throw error; }
  };
  const outputStep = (spec: WorkflowStep, step: WorkflowStepRun) => {
    if (step.units.some(u => !settled(u.status))) { step.status = 'running'; return; }
    step.status = step.units.every(u => u.status === 'completed') ? 'completed' : step.units.some(u => u.status === 'unverified') ? 'unverified' : step.units.some(u => u.status === 'cancelled') ? 'cancelled' : 'failed';
    if (spec.fanout) setOutput(step, step.units.map(workflowUnitEnvelope));
    else if (step.units.length === 1) setOutput(step, step.units[0].status === 'completed' ? step.units[0].result! : workflowUnitEnvelope(step.units[0]));
    else setOutput(step, { status: step.status, error: step.error ?? 'Step did not produce a result' });
  };
  function finishRun(run: WorkflowRun) {
    if (terminal(run)) return;
    if (run.steps.some(s => s.units.some(u => !u.cleanupSettled && settled(u.status)))) {
      run.status = 'needs-attention'; run.cleanupSettled = false; stamp(run); return;
    }
    if (run.steps.some(s => !settled(s.status))) {
      run.cleanupSettled = run.steps.every(s => s.units.every(u => u.cleanupSettled)); return;
    }
    run.cleanupSettled = run.steps.every(s => s.units.every(u => u.cleanupSettled));
    if (!run.cleanupSettled) run.status = 'needs-attention';
    else if (run.status === 'cancelling') run.status = 'cancelled';
    else {
      const final = run.steps[run.steps.length - 1];
      if (final.output !== undefined) {
        run.report = final.output;
        try { workflowJson(state, WORKFLOW_LIMITS.ledgerBytes); }
        catch (error) { delete run.report; run.error = errorText(error); run.status = 'failed'; stamp(run); return; }
      }
      const partial = run.report && typeof run.report === 'object' && !Array.isArray(run.report) && run.report.partial === true;
      run.status = run.steps.every(s => s.status === 'completed') && !partial ? 'completed' : 'failed';
    }
    stamp(run); abortListeners.get(run.workflowRunId)?.(); abortListeners.delete(run.workflowRunId);
  }
  const budgetResult = (unit: WorkflowUnit, result: WorkflowJson) => {
    unit.result = result;
    try { workflowJson(state, WORKFLOW_LIMITS.ledgerBytes); } catch (error) { delete unit.result; throw error; }
  };
  const reuse = (run: WorkflowRun, unit: WorkflowUnit, spec: WorkflowStep) => {
    if (!run.retryOf || spec.kind !== 'native') return;
    const old = state.runs.find(r => r.workflowRunId === run.retryOf)?.steps.find(s => s.id === spec.id)?.units.find(u => u.index === unit.index && u.inputHash === unit.inputHash && u.status === 'completed' && u.cleanupSettled && u.native && u.result !== undefined);
    if (!old) return;
    validateWorkflowValue(old.result!, spec.outputSchema!); budgetResult(unit, freezeWorkflowData(old.result!, WORKFLOW_LIMITS.resultBytes));
    unit.status = 'completed'; unit.native = copy(old.native!); unit.cleanupSettled = true;
    unit.reusedFrom = { workflowRunId: run.retryOf, unitId: old.id, native: copy(old.native!) };
  };
  const prepare = (run: WorkflowRun, spec: WorkflowStep, step: WorkflowStepRun) => {
    try {
      const failedDependencies = spec.dependsOn.some(id => run.steps.find(s => s.id === id)!.status !== 'completed');
      if (failedDependencies && !(spec.kind === 'aggregate' && spec.consumeFailures)) {
        step.status = 'skipped'; step.error = 'Dependency did not complete successfully'; step.output = workflowJson({ status: 'skipped', error: step.error }); return;
      }
      if (spec.kind === 'aggregate') {
        const inputs = materialize(run, spec), unit: WorkflowUnit = { id: `${spec.id}:0`, stepId: spec.id, index: 0, status: 'running', inputHash: hashUnit(run, spec, inputs), inputs, cleanupSettled: true };
        step.units = [unit];
        budgetResult(unit, freezeWorkflowData(aggregateWorkflow(spec.operation!, inputs))); unit.status = 'completed'; outputStep(spec, step); return;
      }
      let items: WorkflowJson[] = [null];
      if (spec.fanout) {
        const source = resolveWorkflowRef(spec.fanout.from, run.inputs, outputsFor(run));
        workflowAssert(Array.isArray(source) && source.length <= spec.fanout.maxItems, 'Runtime fanout exceeds declared bound'); items = source;
      }
      step.units = items.map((item, index) => {
        const inputs = materialize(run, spec, spec.fanout ? item : undefined);
        const unit: WorkflowUnit = { id: `${spec.id}:${index}`, stepId: spec.id, index, status: 'queued', inputHash: hashUnit(run, spec, inputs), inputs, cleanupSettled: true };
        reuse(run, unit, spec); return unit;
      });
      if (!step.units.length) { step.status = 'completed'; step.output = []; } else outputStep(spec, step);
    } catch (error) {
      step.status = 'failed'; step.error = errorText(error); step.output = workflowJson({ status: 'failed', error: step.error });
      step.units.forEach(u => { if (!settled(u.status)) { u.status = 'failed'; u.cleanupSettled = true; u.error = step.error; } });
    }
  };
  const runActiveCount = (run: WorkflowRun) => [...active.values()].filter(a => a.run === run).length;
  const globalCap = () => Math.min(32, ...state.runs.filter(r => !terminal(r) || !r.cleanupSettled).map(r => r.concurrency));
  const launch = (run: WorkflowRun, spec: WorkflowStep, step: WorkflowStepRun, unit: WorkflowUnit) => {
    const controller = new AbortController();
    const key = `${run.workflowRunId}/${unit.id}`;
    let invoked = false;
    const assertAdmission = () => {
      authority(run); workflowAssert(!controller.signal.aborted && run.status !== 'cancelling' && !terminal(run), 'Workflow unit cancelled/closed');
      workflowAssert(invoked || run.status === 'running', 'Workflow paused before native admission');
      workflowAssert(unit.inputHash === hashUnit(run, spec, unit.inputs), 'Materialized dependency/input identity changed');
    };
    try {
      assertAdmission(); workflowAssert(run.admissions < 256, 'Workflow family admission budget exhausted');
      const prompt = `${spec.prompt}\n\nWORKFLOW_DATA_JSON\n${JSON.stringify({ inputs: unit.inputs, outputSchema: spec.outputSchema })}\nEND_WORKFLOW_DATA_JSON`;
      workflowAssert(Buffer.byteLength(prompt, 'utf8') <= WORKFLOW_LIMITS.promptBytes, 'Resolved workflow prompt exceeded');
      run.admissions++; unit.status = 'running'; unit.cleanupSettled = false; run.cleanupSettled = false;
      active.set(key, { run, unit, controller }); stamp(run); persist(); assertAdmission();
      const onIdentity = (identity: WorkflowNativeIdentity) => {
        workflowAssert(identityValid(identity) && !unit.native, 'Missing/duplicate/invalid native identity');
        workflowAssert(!state.runs.some(r => r.steps.some(s => s.units.some(u => u !== unit && !u.reusedFrom && u.native && (u.native.runId === identity.runId || u.native.taskId === identity.taskId)))), 'Native identity collision');
        unit.native = copy(identity); persist(); assertAdmission();
      };
      const operation = Promise.resolve().then(() => { assertAdmission(); invoked = true; return port.execute({ workflowRunId: run.workflowRunId, familyId: run.familyId, attemptNo: run.attemptNo, stepId: spec.id, unitId: unit.id, inputHash: unit.inputHash,
        agent: freezeWorkflowData(run.agents[spec.agentId!], WORKFLOW_LIMITS.definitionBytes), prompt, signal: controller.signal, assertAdmission, onIdentity }); })
        .then(outcome => complete(outcome), error => complete({ status: invoked ? 'unverified' : 'cancelled', error: errorText(error), cleanupSettled: !invoked }))
        .finally(() => { pending.delete(operation); schedule(); });
      pending.add(operation);
      function complete(rawOutcome: WorkflowNativeOutcome) {
        let outcome = rawOutcome;
        try {
          workflowAssert(outcome && typeof outcome === 'object' && !Array.isArray(outcome) && Object.getPrototypeOf(outcome) === Object.prototype && Object.getOwnPropertySymbols(outcome).length === 0, 'Invalid native outcome');
          const fields = Object.getOwnPropertyDescriptors(outcome);
          workflowAssert(Object.entries(fields).every(([k, d]) => ['status', 'text', 'error', 'identity', 'cleanupSettled'].includes(k) && d.enumerable && 'value' in d), 'Invalid native outcome fields/accessors');
          workflowAssert(typeof fields.cleanupSettled?.value === 'boolean' && typeof fields.status?.value === 'string' && ['completed', 'failed', 'cancelled', 'unverified'].includes(fields.status.value), 'Invalid native outcome status/settlement');
        } catch { outcome = { status: 'unverified', cleanupSettled: false, error: 'Malformed native outcome; cleanup settlement unknown' }; }
        const diagnostic = typeof outcome.error === 'string' && outcome.error.length <= 1024 ? outcome.error : outcome.error ? 'Oversized/invalid native diagnostic rejected' : undefined;
        unit.cleanupSettled = outcome.cleanupSettled === true;
        if (unit.cleanupSettled) active.delete(key); // Unknown cleanup retains ownership and its permit.
        else cleanupUncertain = true;
        if (owners.get(container) !== owner || authorityLost) return; // Old completion cannot publish into a recovered/new owner.
        if (!invoked && unit.cleanupSettled && run.status === 'paused') {
          unit.status = 'queued'; delete unit.error; outputStep(spec, step); stamp(run); finishRun(run); persist(); return;
        }
        try {
          workflowAssert(['completed', 'failed', 'cancelled', 'unverified'].includes(outcome.status), 'Invalid native outcome status');
          if (outcome.identity) workflowAssert(unit.native && workflowHash(outcome.identity) === workflowHash(unit.native), 'Native outcome identity mismatch');
          if (!unit.cleanupSettled) { unit.status = 'unverified'; unit.error = diagnostic ?? 'Native cleanup not proven settled'; }
          else if (controller.signal.aborted || run.status === 'cancelling') { unit.status = 'cancelled'; }
          else if (outcome.status !== 'completed') { unit.status = outcome.status; unit.error = diagnostic ?? 'Native unit did not complete'; }
          else {
            workflowAssert(identityValid(unit.native) && typeof outcome.text === 'string', 'Completed native result lacks identity/text');
            workflowAssert(Buffer.byteLength(outcome.text, 'utf8') <= WORKFLOW_LIMITS.resultBytes, 'Raw native result exceeded before parsing');
            const result = workflowJson(JSON.parse(outcome.text), WORKFLOW_LIMITS.resultBytes); validateWorkflowValue(result, spec.outputSchema!);
            if (run.definition.id === 'read-only-review' && spec.id === 'discover') {
              const targets = (result as Record<string, WorkflowJson>).targets as string[];
              const candidates = (run.inputs as Record<string, WorkflowJson>).candidatePaths as string[];
              workflowAssert(new Set(targets).size === targets.length && targets.every(t => candidates.includes(t)), 'Discovery target outside caller candidate scope');
            }
            if (run.definition.id === 'read-only-review' && spec.id === 'review') {
              const findings = (result as Record<string, WorkflowJson>).findings as Array<Record<string, WorkflowJson>>;
              const candidates = (run.inputs as Record<string, WorkflowJson>).candidatePaths as string[];
              workflowAssert(findings.every(f => typeof f.id === 'string' && f.id.trim().length > 0 && typeof f.path === 'string' && candidates.some(path => f.path === path || String(f.path).startsWith(`${path}/`)) && Number.isSafeInteger(f.line) && Number(f.line) > 0) && new Set(findings.map(f => f.id)).size === findings.length, 'Review finding missing/duplicate ID or outside caller candidate scope');
            }
            budgetResult(unit, freezeWorkflowData(result, WORKFLOW_LIMITS.resultBytes)); unit.status = 'completed';
          }
        } catch (error) { unit.status = unit.cleanupSettled ? 'failed' : 'unverified'; unit.error = errorText(error); }
        try { outputStep(spec, step); stamp(run); finishRun(run); persist(); }
        catch (error) {
          step.status = 'failed'; step.error = errorText(error); step.output = { status: 'failed', error: step.error };
          run.error = step.error; stamp(run); finishRun(run);
          try { persist(); } catch { authorityLost = true; active.forEach(a => a.controller.abort()); }
        }
      }
    } catch (error) {
      if (!invoked) { active.delete(key); unit.cleanupSettled = true; unit.status = run.status === 'paused' ? 'queued' : run.status === 'cancelling' ? 'cancelled' : 'failed'; }
      else { unit.status = 'unverified'; unit.cleanupSettled = false; controller.abort(); }
      unit.error = errorText(error); outputStep(spec, step); stamp(run); finishRun(run); persist();
    }
  };
  function pump() {
    scheduled = false; if (pumping || disposed || authorityLost) return; pumping = true;
    try {
      ledgerCurrent();
      let progress = true;
      while (progress) {
        progress = false;
        for (const run of state.runs) {
          if (run.status !== 'running') continue;
          try { authority(run); } catch (error) { run.status = 'paused'; run.error = errorText(error); stamp(run); persist(); continue; }
          for (const [index, spec] of run.definition.steps.entries()) {
            if (run.status !== 'running') break;
            const step = run.steps[index];
            if (step.status === 'queued' && spec.dependsOn.every(id => settled(run.steps.find(s => s.id === id)!.status))) {
              prepare(run, spec, step); stamp(run); persist(); progress = true;
            }
            if (run.status !== 'running') break;
            for (const unit of step.units) {
              if (run.status !== 'running' || active.size >= globalCap() || runActiveCount(run) >= run.concurrency) break;
              if (unit.status === 'queued') { launch(run, spec, step, unit); progress = true; }
            }
          }
          finishRun(run);
        }
      }
      persist();
    } catch (error) {
      authorityLost = true; active.forEach(a => a.controller.abort());
      for (const run of state.runs) if (!terminal(run)) { run.status = 'needs-attention'; run.error = errorText(error); }
    } finally { pumping = false; }
  }
  function schedule() { if (!scheduled && !disposed && !authorityLost) { scheduled = true; queueMicrotask(pump); } }
  const makeRun = (definition: WorkflowDefinition, inputs: WorkflowJson, concurrency: number, previous?: WorkflowRun): WorkflowRun => {
    workflowAssert(state.runs.length < 16, 'Workflow run retention full; explicitly forget a terminal run');
    workflowAssert(Number.isSafeInteger(concurrency) && concurrency >= 1 && concurrency <= 32, 'Concurrency must be integer 1..32');
    const frozenInputs = freezeWorkflowData(inputs, WORKFLOW_LIMITS.inputBytes); validateWorkflowValue(frozenInputs, definition.inputSchema);
    if (definition.id === 'read-only-review') validateReviewInputs(frozenInputs);
    const agents = freezeAgents(definition), workflowRunId = freshId(), time = now().toISOString();
    if (previous) workflowAssert(workflowHash(agents) === workflowHash(previous.agents), 'Retry frozen agent policy changed');
    return { workflowRunId, familyId: previous?.familyId ?? workflowRunId, attemptNo: previous ? previous.attemptNo + 1 : 1,
      ...(previous ? { retryOf: previous.workflowRunId } : {}), definition, definitionHash: workflowHash(definition), inputs: frozenInputs, agents, concurrency,
      status: 'running', createdAt: time, updatedAt: time, admissions: previous?.admissions ?? 0, cleanupSettled: true, recovered: false,
      steps: definition.steps.map(s => ({ id: s.id, status: 'queued', units: [] })) };
  };
  const execute = async (raw: WorkflowAction, signal?: AbortSignal): Promise<WorkflowReply> => {
    let action: WorkflowAction['action'] = 'workflows.list';
    try {
      const input = workflowJson(raw, WORKFLOW_LIMITS.definitionBytes + WORKFLOW_LIMITS.inputBytes) as unknown as WorkflowAction;
      action = input.action;
      const allowed: Record<string, string[]> = { 'workflows.list': [], 'workflows.define': ['definition'], 'workflows.show': ['definitionId', 'workflowRunId'], 'workflows.start': ['definitionId', 'inputs', 'concurrency'] };
      const known = ['workflows.pause', 'workflows.resume', 'workflows.cancel', 'workflows.retry', 'workflows.report', 'workflows.forget'];
      workflowAssert(Object.hasOwn(allowed, action) || known.includes(action), 'Unknown workflow action');
      workflowAssert(Object.keys(input).every(k => k === 'action' || (allowed[action] ?? ['workflowRunId']).includes(k)), 'Unknown workflow action field');
      if (action === 'workflows.list') {
        // Rich internal/UI views stay intact; default tool context carries attempts, not every unit identity.
        const runs = list().map(({ correlations, ...summary }) => summary);
        return { ok: true, action, runs, definitions: state.definitions.map(d => ({ id: d.id, label: d.label, stepCount: d.steps.length })) };
      }
      if (input.action === 'workflows.show') {
        workflowAssert(!!input.definitionId !== !!input.workflowRunId, 'Show requires exactly one identity');
        if (input.definitionId) { const definition = state.definitions.find(d => d.id === input.definitionId); workflowAssert(definition, 'Workflow definition not found'); return { ok: true, action, definition: { id: definition.id, label: definition.label, stepCount: definition.steps.length } }; }
        const run = state.runs.find(r => r.workflowRunId === input.workflowRunId); workflowAssert(run, 'Workflow run not found'); return { ok: true, action, view: copy(workflowView(run)) };
      }
      if (input.action === 'workflows.report') { const run = state.runs.find(r => r.workflowRunId === input.workflowRunId); workflowAssert(run, 'Workflow run not found'); return { ok: true, action, view: copy(workflowView(run)), ...(run.report !== undefined ? { report: copy(run.report) } : {}) }; }
      workflowAssert(!disposed, 'Workflow service disposed'); ledgerCurrent();
      if (input.action === 'workflows.define') {
        authority(); const definition = validateWorkflowDefinition(input.definition), index = state.definitions.findIndex(d => d.id === definition.id);
        workflowAssert(index >= 0 || state.definitions.length < 16, 'Workflow definition retention full');
        workflowAssert(!state.runs.some(r => r.definition.id === definition.id && (!terminal(r) || !r.cleanupSettled)), 'Cannot redefine an unsettled workflow');
        const definitions = [...state.definitions]; if (index >= 0) definitions[index] = definition; else definitions.push(definition);
        workflowJson({ ...state, definitions }, WORKFLOW_LIMITS.ledgerBytes); state.definitions = definitions;
        persist(); return { ok: true, action, definition: { id: definition.id, label: definition.label, stepCount: definition.steps.length } };
      }
      if (input.action === 'workflows.start') {
        authority(); workflowAssert(!signal?.aborted, 'Caller already cancelled'); const definition = state.definitions.find(d => d.id === input.definitionId); workflowAssert(definition, 'Workflow definition not found');
        const run = makeRun(definition, input.inputs, input.concurrency ?? 8);
        workflowJson({ ...state, runs: [...state.runs, run] }, WORKFLOW_LIMITS.ledgerBytes);
        state.runs.push(run); persist(); attachSignal(run, signal); schedule(); return { ok: true, action, view: copy(workflowView(run)) };
      }
      workflowAssert('workflowRunId' in input, 'Workflow run identity required');
      const run = state.runs.find(r => r.workflowRunId === input.workflowRunId); workflowAssert(run, 'Workflow run not found');
      if (input.action === 'workflows.cancel') { cancelRun(run); return { ok: true, action, view: copy(workflowView(run)) }; }
      if (input.action === 'workflows.pause') { workflowAssert(run.status === 'running', 'Only running workflows can pause'); run.status = 'paused'; stamp(run); persist(); }
      if (input.action === 'workflows.resume') { workflowAssert(run.status === 'paused' && !run.recovered, 'Only live paused workflows can resume'); authority(run); run.status = 'running'; delete run.error; stamp(run); persist(); schedule(); }
      if (input.action === 'workflows.retry') {
        authority(run); workflowAssert(['failed', 'cancelled'].includes(run.status) && run.cleanupSettled && run.attemptNo < 3 && run.admissions < 256, 'Retry requires fully settled failed/cancelled attempt within family budget');
        workflowAssert(!run.supersededBy && !state.runs.some(r => r.familyId === run.familyId && r.attemptNo > run.attemptNo), 'Retry requires latest family attempt');
        workflowAssert(!signal?.aborted, 'Caller already cancelled');
        const next = makeRun(run.definition, run.inputs, run.concurrency, run);
        workflowJson({ ...state, runs: [...state.runs.map(r => r === run ? { ...r, supersededBy: next.workflowRunId } : r), next] }, WORKFLOW_LIMITS.ledgerBytes);
        run.supersededBy = next.workflowRunId; state.runs.push(next); persist(); attachSignal(next, signal); schedule(); return { ok: true, action, view: copy(workflowView(next)) };
      }
      if (input.action === 'workflows.forget') { authority(); workflowAssert(terminal(run) && run.cleanupSettled, 'Forget requires terminal settled workflow'); state.runs.splice(state.runs.indexOf(run), 1); abortListeners.get(run.workflowRunId)?.(); abortListeners.delete(run.workflowRunId); persist(); }
      return { ok: true, action, view: copy(workflowView(run)) };
    } catch (error) { return { ok: false, action, error: errorText(error) }; }
  };
  persist();
  return { execute, list, get: id => { const run = state.runs.find(r => r.workflowRunId === id); return run ? copy(run) : undefined; },
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    dispose() {
      if (disposed) return; disposed = true;
      // Cleanup requests precede every observable/fallible ledger publication.
      active.forEach(a => a.controller.abort()); abortListeners.forEach(remove => remove()); abortListeners.clear(); listeners.clear();
      if (owners.get(container) === owner && !authorityLost) for (const run of state.runs) if (!terminal(run)) {
        try { cancelRun(run); }
        catch (error) { authorityLost = true; run.status = 'needs-attention'; run.error = errorText(error); }
      }
    },
    async drain() { await Promise.resolve(); while (pending.size) { await Promise.allSettled([...pending]); await Promise.resolve(); } workflowAssert(!cleanupUncertain, 'Native cleanup settlement is uncertain'); },
  };
}
