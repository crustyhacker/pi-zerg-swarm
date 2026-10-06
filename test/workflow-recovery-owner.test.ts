import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkflowService } from '../workflow-runtime.js';
import { type WorkflowNativePort, type WorkflowDefinition, type WorkflowRecoveryDurablePort } from '../workflow-model.js';

const agent = { id: 'agent', label: 'Agent', prompt: 'Return JSON.', source: 'test', model: 'm' } as const;
const container = (ext?: unknown) => {
  let state: any = { mode: {}, agentDefinitions: { agent }, extensions: ext ? { workflows: ext } : {} };
  return { read: () => state, update: (patch: any) => { state = { ...state, ...patch, extensions: { ...state.extensions, ...patch.extensions } }; } } as any;
};
const native: WorkflowNativePort = { preflight() {}, async execute(req) { req.onIdentity({ runId: `n-${req.unitId}`, taskId: `t-${req.unitId}` }); return { status: 'completed', text: '{"ok":true}', cleanupSettled: true }; } };
const def: WorkflowDefinition = { id: 'wf', version: 1, label: 'wf', inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false }, steps: [{ id: 's', dependsOn: [], kind: 'native', agentId: 'agent', prompt: 'p', inputs: {}, outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false } }] };

function spyingDurable() {
  const calls = { ensureWriter: 0, inspectOwner: 0, authorize: 0, check: 0, edit: 0, cleanup: 0 };
  const port: WorkflowRecoveryDurablePort & { check?(): never; edit?(): never; cleanup?(): never } = {
    ensureWriter: () => { calls.ensureWriter++; return { bootId: 'b', pid: 1, startTimeTicks: '2', writerSessionId: 'w', generation: 'g' }; },
    inspectOwner: () => { calls.inspectOwner++; return { snapshotFile: 's', lockDir: 'l', claimDir: 'c', claimPresent: false, ownerValid: true, owner: { bootId: 'b', pid: 1, startTimeTicks: '2', writerSessionId: 'w', generation: 'g' } }; },
    check: () => { calls.check++; throw new Error('check must not be called'); },
    edit: () => { calls.edit++; throw new Error('edit must not be called'); },
    cleanup: () => { calls.cleanup++; throw new Error('cleanup must not be called'); },
  };
  return { calls, port };
}

async function completedRecoveryRun() {
  const { calls, port } = spyingDurable();
  const c = container(); const svc = createWorkflowService(c, native, { recovery: { enabled: true, durablePort: port } });
  await svc.execute({ action: 'workflows.define', definition: def });
  const started = await svc.execute({ action: 'workflows.start', definitionId: 'wf', inputs: {} });
  assert.equal(started.ok, true);
  await svc.drain();
  calls.ensureWriter = calls.authorize = calls.check = calls.edit = calls.cleanup = 0;
  return { c, svc, id: started.view!.workflowRunId, calls };
}

test('inspect and prepare are pure readonly assessments and never authorize or allocate child work', async () => {
  const { c, svc, id, calls } = await completedRecoveryRun();
  const before = JSON.stringify(c.read().extensions.workflows);
  const inspect = await svc.execute({ action: 'workflows.recovery.inspect', workflowRunId: id });
  assert.equal(inspect.ok, true);
  assert.equal((inspect.assessment as any).schema.authority, 'inspect-prepare-only');
  assert.equal((inspect.assessment as any).schema.prepareIsPermission, false);
  assert.equal((inspect.assessment as any).plan.status, 'blocked');
  assert.equal((inspect.assessment as any).units[0].reuseEligible, false);
  assert.match(JSON.stringify((inspect.assessment as any).blocked), /source-attempt-is-not-a-recovered-interruption/);
  const prepare = await svc.execute({ action: 'workflows.recovery.prepare', workflowRunId: id });
  assert.equal(prepare.ok, true);
  assert.equal((prepare.assessment as any).plan.status, 'blocked');
  assert.match(JSON.stringify((prepare.assessment as any).blocked), /unselected-required-execution-address/);
  assert.equal((prepare.assessment as any).fingerprint, (inspect.assessment as any).fingerprint);
  assert.equal(JSON.stringify(c.read().extensions.workflows), before);
  assert.deepEqual({ ensureWriter: calls.ensureWriter, authorize: calls.authorize, check: calls.check, edit: calls.edit, cleanup: calls.cleanup }, { ensureWriter: 0, authorize: 0, check: 0, edit: 0, cleanup: 0 });
});

test('prepare action shape rejects stale confirmation fields and raw boolean self authorization', async () => {
  const { svc, id, calls } = await completedRecoveryRun();
  const extra = await svc.execute({ action: 'workflows.recovery.prepare', workflowRunId: id, assessmentFingerprint: 'x' } as any);
  assert.equal(extra.ok, false);
  assert.match(extra.error ?? '', /Unknown workflow action field/);
  const bool = await svc.execute(true as any);
  assert.equal(bool.ok, false);
  assert.equal(calls.authorize, 0);
});

test('missing legacy checkpoint is inspect-only blocked rather than inspection rejection', async () => {
  const c = container();
  const live = createWorkflowService(c, native);
  await live.execute({ action: 'workflows.define', definition: def });
  const started = await live.execute({ action: 'workflows.start', definitionId: 'wf', inputs: {} });
  await live.drain();
  const { calls, port } = spyingDurable();
  const recovered = createWorkflowService(c, native, { recovery: { enabled: true, durablePort: port } });
  const reply = await recovered.execute({ action: 'workflows.recovery.inspect', workflowRunId: started.view!.workflowRunId });
  assert.equal(reply.ok, true);
  assert.match(JSON.stringify((reply.assessment as any).blocked), /source-checkpoint-missing-legacy-inspect-only/);
  assert.equal(calls.ensureWriter, 0);
  assert.equal(calls.authorize, 0);
});

test('canonical ledger drift and cancelled inspection fail closed without live grants', async () => {
  const { c, svc, id, calls } = await completedRecoveryRun();
  const ctl = new AbortController(); ctl.abort();
  const cancelled = await svc.execute({ action: 'workflows.recovery.inspect', workflowRunId: id }, ctl.signal);
  assert.equal(cancelled.ok, false);
  const beforeInspectOwner = calls.inspectOwner;
  const raw = c.read().extensions.workflows;
  c.update({ extensions: { workflows: { ...raw, runs: raw.runs.map((r: any) => ({ ...r, error: 'drift' })) } } });
  const drift = await svc.execute({ action: 'workflows.recovery.inspect', workflowRunId: id });
  assert.equal(drift.ok, false);
  assert.match(drift.error ?? '', /changed outside its owner/);
  assert.equal(calls.inspectOwner, beforeInspectOwner);
  assert.equal(calls.authorize, 0);
});

test('malformed retained ledger is rejected before recovery callbacks', () => {
  const { calls, port } = spyingDurable();
  assert.throws(() => createWorkflowService(container({ version: 1, definitions: [], runs: [{ bad: true }] }), native, { recovery: { enabled: true, durablePort: port } }), /Invalid|Unknown|workflow|Expected plain JSON data/i);
  assert.deepEqual({ ensureWriter: calls.ensureWriter, inspectOwner: calls.inspectOwner, authorize: calls.authorize }, { ensureWriter: 0, inspectOwner: 0, authorize: 0 });
});


test('prepare fingerprint binds exact selections and rejects duplicates/overlap', async () => {
  const { svc, id } = await completedRecoveryRun();
  const inspect = await svc.execute({ action: 'workflows.recovery.inspect', workflowRunId: id });
  const reuse = await svc.execute({ action: 'workflows.recovery.prepare', workflowRunId: id, selections: { reuseUnitIds: ['s:0'] } });
  const rerun = await svc.execute({ action: 'workflows.recovery.prepare', workflowRunId: id, selections: { rerunUnitIds: ['s:0'] } });
  assert.equal(reuse.ok, true);
  assert.equal(rerun.ok, true);
  assert.notEqual((inspect.assessment as any).fingerprint, (reuse.assessment as any).fingerprint);
  assert.notEqual((reuse.assessment as any).fingerprint, (rerun.assessment as any).fingerprint);
  const duplicate = await svc.execute({ action: 'workflows.recovery.prepare', workflowRunId: id, selections: { reuseUnitIds: ['s:0', 's:0'] } });
  assert.equal(duplicate.ok, false);
  assert.match(duplicate.error ?? '', /Duplicate recovery reuse selection/);
  const overlap = await svc.execute({ action: 'workflows.recovery.prepare', workflowRunId: id, selections: { reuseUnitIds: ['s:0'], rerunUnitIds: ['s:0'] } });
  assert.equal(overlap.ok, false);
  assert.match(overlap.error ?? '', /selection overlap/);
});

test('current agent definition drift is assessed from container current definitions and blocks plan', async () => {
  const { c, svc, id } = await completedRecoveryRun();
  const raw = c.read();
  c.update({ agentDefinitions: { agent: { ...raw.agentDefinitions.agent, model: 'changed-model' } } });
  const drift = await svc.execute({ action: 'workflows.recovery.inspect', workflowRunId: id });
  assert.equal(drift.ok, true);
  assert.match(JSON.stringify((drift.assessment as any).blocked), /current-policy:agent-definition-drift:agent/);
  assert.equal((drift.assessment as any).plan.status, 'blocked');
});

test('legacy inspection works without recovery opt-in and never acquires writer', async () => {
  const c = container();
  const svc = createWorkflowService(c, native);
  await svc.execute({ action: 'workflows.define', definition: def });
  const started = await svc.execute({ action: 'workflows.start', definitionId: 'wf', inputs: {} });
  await svc.drain();
  const reply = await svc.execute({ action: 'workflows.recovery.inspect', workflowRunId: started.view!.workflowRunId });
  assert.equal(reply.ok, true);
  assert.match(JSON.stringify((reply.assessment as any).blocked), /durable-recovery-owner-port-not-configured-inspect-only/);
  assert.match(JSON.stringify((reply.assessment as any).blocked), /source-checkpoint-missing-legacy-inspect-only/);
});

test('prepare wrapper omits undefined selections and does not call disk/provider callbacks', async () => {
  const { svc, id, calls } = await completedRecoveryRun();
  assert.ok(svc.recovery);
  const reply = await svc.recovery!.prepare(id);
  assert.equal(reply.ok, true);
  assert.deepEqual((reply.assessment as any).selections, { reuseUnitIds: [], rerunUnitIds: [] });
  assert.equal((reply.assessment as any).plan.status, 'blocked');
  assert.match(JSON.stringify((reply.assessment as any).blocked), /unselected-required-execution-address/);
  assert.deepEqual((reply.assessment as any).plan.recommendedSelections, { reuseUnitIds: [], rerunUnitIds: ['s:0'] });
  assert.deepEqual({ ensureWriter: calls.ensureWriter, authorize: calls.authorize, check: calls.check, edit: calls.edit, cleanup: calls.cleanup }, { ensureWriter: 0, authorize: 0, check: 0, edit: 0, cleanup: 0 });
});
