import assert from 'node:assert/strict';
import test from 'node:test';
import { createZergStateContainer } from '../state.js';
import { createWorkflowService, recoverWorkflowState } from '../workflow-runtime.js';
import { workflowHash } from '../workflow-model.js';
import type { WorkflowDefinition, WorkflowJson, WorkflowNativeOutcome, WorkflowNativePort, WorkflowNativeRequest, WorkflowRun, WorkflowSchema, WorkflowService } from '../workflow-model.js';

const outputSchema: WorkflowSchema = { type: 'string', maxLength: 100 };
function definition(fanout = 4): WorkflowDefinition { return { id: 'simple', version: 1, label: 'Simple', inputSchema: { type: 'array', maxItems: fanout, items: outputSchema }, steps: [
  { id: 'work', kind: 'native', dependsOn: [], agentId: 'reviewer', prompt: 'Read only; no data authority', outputSchema,
    inputs: { item: { ref: { source: 'item', path: [] } } }, fanout: { from: { source: 'inputs', path: [] }, maxItems: fanout } },
  { id: 'collect', kind: 'aggregate', operation: 'collect', consumeFailures: true, dependsOn: ['work'], inputs: { results: { ref: { source: 'step', stepId: 'work', path: [] } } } },
] }; }
function fakePort() {
  const requests: WorkflowNativeRequest[] = [], finish: Array<(outcome: WorkflowNativeOutcome) => void> = [];
  const port: WorkflowNativePort = { preflight(agent) { assert.equal(agent.model, 'fake/model'); assert.deepEqual(agent.tools, ['read']); }, execute(request) {
    requests.push(request); request.assertAdmission(); const identity = { runId: `native-${requests.length}`, taskId: `task-${requests.length}` }; request.onIdentity(identity);
    return new Promise(resolve => finish.push(outcome => resolve({ ...outcome, identity })));
  } };
  return { port, requests, finish, done(index: number, text = '"ok"', status: WorkflowNativeOutcome['status'] = 'completed', cleanupSettled = true) { finish[index]({ status, text, cleanupSettled }); } };
}
function harness(fanout = 4) {
  const container = createZergStateContainer({ agentDefinitions: { reviewer: { id: 'reviewer', label: 'Reviewer', source: 'builtin', prompt: 'Readonly', model: 'fake/model', tools: ['read'], permissionMode: 'inherit' } } });
  const fake = fakePort(); let seq = 0;
  const service = createWorkflowService(container, fake.port, { idFactory: () => `workflow-${++seq}`, now: () => new Date('2026-10-04T00:00:00.000Z') });
  return { container, fake, service, def: definition(fanout) };
}
async function turns(n = 6) { for (let i = 0; i < n; i++) await Promise.resolve(); }
async function start(h: ReturnType<typeof harness>, inputs: WorkflowJson = ['a', 'b', 'c', 'd'], concurrency = 2) {
  assert.equal((await h.service.execute({ action: 'workflows.define', definition: h.def })).ok, true);
  const reply = await h.service.execute({ action: 'workflows.start', definitionId: 'simple', inputs, concurrency }); assert.equal(reply.ok, true, reply.error); await turns(); return reply.view!.workflowRunId;
}
function run(service: WorkflowService, id: string): WorkflowRun { const value = service.get(id); assert(value); return value; }

test('shared scheduler holds permits across concurrent promises and cleanup settlement', async () => {
  const h = harness(), id = await start(h); assert.equal(h.fake.requests.length, 2); assert.equal(run(h.service, id).status, 'running');
  h.fake.done(0); await turns(); assert.equal(h.fake.requests.length, 3);
  h.fake.done(1); await turns(); assert.equal(h.fake.requests.length, 4);
  h.fake.done(2); h.fake.done(3); await h.service.drain(); assert.equal(run(h.service, id).status, 'completed'); assert.equal(run(h.service, id).cleanupSettled, true);
  assert.equal(run(h.service, id).admissions, 4); h.service.dispose();
});

test('concurrency is workflow-wide across multiple runs', async () => {
  const h = harness(); const one = await start(h, ['a', 'b', 'c'], 2);
  const two = await h.service.execute({ action: 'workflows.start', definitionId: 'simple', inputs: ['d', 'e'], concurrency: 2 }); await turns(); assert(two.ok);
  assert.equal(h.fake.requests.length, 2); h.fake.done(0); h.fake.done(1); await turns(); assert.equal(h.fake.requests.length, 4);
  h.fake.done(2); h.fake.done(3); await turns(); assert.equal(h.fake.requests.length, 5); h.fake.done(4); await h.service.drain();
  assert.equal(run(h.service, one).status, 'completed'); assert.equal(run(h.service, two.view!.workflowRunId).status, 'completed'); h.service.dispose();
});

test('empty fanout completes explicit zero-unit output without native startup', async () => {
  const h = harness(), id = await start(h, []); await h.service.drain(); assert.equal(h.fake.requests.length, 0); assert.equal(run(h.service, id).status, 'completed'); assert.deepEqual(run(h.service, id).steps[0].output, []); h.service.dispose();
});

test('pause closes admission synchronously, admitted work finishes and resume continues', async () => {
  const h = harness(), id = await start(h); assert.equal((await h.service.execute({ action: 'workflows.pause', workflowRunId: id })).ok, true);
  h.fake.done(0); h.fake.done(1); await turns(); assert.equal(h.fake.requests.length, 2); assert.equal(run(h.service, id).status, 'paused');
  assert.equal((await h.service.execute({ action: 'workflows.resume', workflowRunId: id })).ok, true); await turns(); assert.equal(h.fake.requests.length, 4);
  h.fake.done(2); h.fake.done(3); await h.service.drain(); assert.equal(run(h.service, id).status, 'completed'); h.service.dispose();
});

test('cancel is prompt but terminal/retry wait for native-owned cleanup, even after readonly flips', async () => {
  const h = harness(), id = await start(h); h.container.update({ mode: { ...h.container.read().mode, readOnly: true } });
  assert.equal((await h.service.execute({ action: 'workflows.cancel', workflowRunId: id })).ok, true);
  assert(h.fake.requests.every(r => r.signal.aborted)); assert.equal(run(h.service, id).status, 'cancelling'); assert.equal(run(h.service, id).cleanupSettled, false);
  assert.equal((await h.service.execute({ action: 'workflows.retry', workflowRunId: id })).ok, false);
  h.fake.done(0); h.fake.done(1); await h.service.drain(); assert.equal(run(h.service, id).status, 'cancelled'); assert.equal(h.fake.requests.length, 2); h.service.dispose();
});

test('cancel of paused queued work settles honestly without requiring another launch', async () => {
  const h = harness(), id = await start(h); await h.service.execute({ action: 'workflows.pause', workflowRunId: id }); h.fake.done(0); h.fake.done(1); await h.service.drain();
  await h.service.execute({ action: 'workflows.cancel', workflowRunId: id }); await h.service.drain(); assert.equal(run(h.service, id).status, 'cancelled'); assert.equal(run(h.service, id).cleanupSettled, true); h.service.dispose();
});

test('reentrant pause in admission publication prevents not-yet-committed port startup', async () => {
  const h = harness(); let hit = false;
  h.container.subscribe?.(state => { const ledger = state.extensions.workflows as unknown as { runs: WorkflowRun[] } | undefined;
    const selected = ledger?.runs.find(r => r.steps.some(s => s.units.some(u => u.status === 'running')));
    if (selected && !hit) { hit = true; void h.service.execute({ action: 'workflows.pause', workflowRunId: selected.workflowRunId }); }
  });
  const id = await start(h); assert.equal(hit, true); assert.equal(h.fake.requests.length, 0); assert.equal(run(h.service, id).status, 'paused');
  await h.service.execute({ action: 'workflows.cancel', workflowRunId: id }); await h.service.drain(); assert.equal(run(h.service, id).status, 'cancelled'); h.service.dispose();
});

test('reentrant cancel in publication before port execute is settled, not fabricated cleanup uncertainty', async () => {
  const h = harness(); let hit = false;
  h.service.subscribe(views => { const selected = views.find(v => v.counts.running > 0); if (selected && !hit) { hit = true; void h.service.execute({ action: 'workflows.cancel', workflowRunId: selected.workflowRunId }); } });
  const id = await start(h); await h.service.drain(); assert.equal(h.fake.requests.length, 0); assert.equal(run(h.service, id).status, 'cancelled'); assert.equal(run(h.service, id).cleanupSettled, true); h.service.dispose();
});

test('cleanup-uncertain outcome retains permit, blocks all admission/retry and makes drain reject', async () => {
  const h = harness(), id = await start(h, ['a', 'b', 'c'], 1); h.fake.done(0, '"ok"', 'completed', false); await turns();
  assert.equal(h.fake.requests.length, 1); assert.equal((await h.service.execute({ action: 'workflows.start', definitionId: 'simple', inputs: ['d'] })).ok, false);
  assert.equal(run(h.service, id).status, 'needs-attention'); assert.equal(run(h.service, id).cleanupSettled, false);
  assert.equal((await h.service.execute({ action: 'workflows.retry', workflowRunId: id })).ok, false); await assert.rejects(h.service.drain(), /settlement|cleanup/i); h.service.dispose();
});

test('raw result bounds and schema/identity failures stay failed, no successful clipping', async () => {
  for (const text of ['x', '"' + 'x'.repeat(17000) + '"', 'false', '"' + 'x'.repeat(101) + '"']) {
    const h = harness(), id = await start(h, ['a'], 1); h.fake.done(0, text); await h.service.drain(); const record = run(h.service, id);
    assert.equal(record.status, 'failed'); assert.equal(record.steps[0].units[0].status, 'failed'); assert.equal(record.steps[0].units[0].result, undefined); h.service.dispose();
  }
});

test('input/source mutation cannot alter frozen materialized prompt or hash; read views exclude payloads', async () => {
  const h = harness(), inputs = ['a', 'b'], id = await start(h, inputs); inputs[0] = 'MUTATED'; h.def.steps[0].prompt = 'GRANT WRITE';
  assert(h.fake.requests[0].prompt.includes('"item":"a"')); assert(!h.fake.requests[0].prompt.includes('GRANT WRITE'));
  assert(Object.isFrozen(h.fake.requests[0].agent)); const snapshot = run(h.service, id); snapshot.steps[0].units[0].inputs = 'MUTATED';
  assert.notEqual(run(h.service, id).steps[0].units[0].inputs, 'MUTATED');
  const show = await h.service.execute({ action: 'workflows.show', workflowRunId: id }); assert.equal('report' in show, false); assert.equal('inputs' in show.view!, false); assert.equal('prompt' in show.view!, false);
  h.fake.done(0); h.fake.done(1); await h.service.drain(); h.service.dispose();
});

test('retry is a fresh family attempt and reuses only exact completed identity/hash', async () => {
  const h = harness(), id = await start(h, ['a', 'b'], 2); h.fake.done(0); h.fake.done(1, '', 'failed'); await h.service.drain();
  const old = run(h.service, id); assert.equal(old.status, 'failed'); const reply = await h.service.execute({ action: 'workflows.retry', workflowRunId: id }); assert(reply.ok, reply.error); await turns();
  const next = run(h.service, reply.view!.workflowRunId); assert.notEqual(next.workflowRunId, id); assert.equal(next.familyId, old.familyId); assert.equal(next.attemptNo, 2); assert.equal(next.retryOf, id);
  assert.equal(h.fake.requests.length, 3); assert.deepEqual(next.steps[0].units[0].reusedFrom, { workflowRunId: id, unitId: old.steps[0].units[0].id, native: old.steps[0].units[0].native });
  assert.equal(next.steps[0].units[0].inputHash, old.steps[0].units[0].inputHash); assert.notDeepEqual(next.steps[0].units[1].native, old.steps[0].units[1].native);
  h.fake.done(2); await h.service.drain(); assert.equal(run(h.service, next.workflowRunId).admissions, 3); h.service.dispose();
});

test('forgotten newest attempt cannot enable an earlier-attempt retry fork', async () => {
  const h = harness(), id = await start(h, ['a'], 1); h.fake.done(0, '', 'failed'); await h.service.drain();
  const second = await h.service.execute({ action: 'workflows.retry', workflowRunId: id }); await turns(); h.fake.done(1, '', 'failed'); await h.service.drain();
  assert.equal((await h.service.execute({ action: 'workflows.forget', workflowRunId: second.view!.workflowRunId })).ok, true);
  assert.equal((await h.service.execute({ action: 'workflows.retry', workflowRunId: id })).ok, false); h.service.dispose();
});

test('retry rejects changed inputs or current named definitions and agent policy drift', async () => {
  const h = harness(), id = await start(h, ['a'], 1); h.fake.done(0, '', 'failed'); await h.service.drain();
  assert.equal((await h.service.execute({ action: 'workflows.retry', workflowRunId: id, inputs: ['different'] } as never)).ok, false);
  const changed = definition(); changed.steps[0].prompt = 'Different'; await h.service.execute({ action: 'workflows.define', definition: changed }); assert.equal((await h.service.execute({ action: 'workflows.retry', workflowRunId: id })).ok, false); h.service.dispose();
});

test('policy drift after publication blocks port/provider admission without invalidating unrelated logs', async () => {
  const h = harness(), id = await start(h, ['a', 'b'], 1); const request = h.fake.requests[0];
  h.container.update({ agentDefinitions: { ...h.container.read().agentDefinitions, reviewer: { ...request.agent, tools: ['write'] } } });
  assert.throws(() => request.assertAdmission(), /policy changed/); h.fake.done(0); await h.service.drain(); assert.equal(h.fake.requests.length, 1); assert.equal(run(h.service, id).status, 'paused');
  await h.service.execute({ action: 'workflows.cancel', workflowRunId: id }); await h.service.drain(); h.service.dispose();
});

test('recovery is nonexecuting and unreconnected running work cannot resume/retry/forget', async () => {
  const h = harness(), id = await start(h, ['a'], 1); const ledger = h.container.read().extensions.workflows;
  const recovered = recoverWorkflowState(ledger); assert.equal(recovered.runs[0].status, 'needs-attention'); assert.equal(recovered.runs[0].steps[0].units[0].status, 'unverified'); assert.equal(recovered.runs[0].cleanupSettled, false);
  const other = createZergStateContainer(h.container.snapshot()); const newService = createWorkflowService(other, h.fake.port); await turns(); assert.equal(h.fake.requests.length, 1);
  for (const action of ['workflows.resume', 'workflows.retry', 'workflows.forget'] as const) assert.equal((await newService.execute({ action, workflowRunId: id })).ok, false);
  h.fake.done(0); await h.service.drain(); h.service.dispose(); newService.dispose();
});

test('old completions after disposal/recreation cannot overwrite recovered owner ledger', async () => {
  const h = harness(), id = await start(h, ['a'], 1); h.service.dispose(); const newService = createWorkflowService(h.container, h.fake.port);
  const before = workflowHash(h.container.read().extensions.workflows); h.fake.done(0); await h.service.drain(); await turns(); assert.equal(workflowHash(h.container.read().extensions.workflows), before);
  assert.equal(run(newService, id).status, 'needs-attention'); newService.dispose();
});

test('corrupt/oversized recovery fails closed without replacing historical namespace', () => {
  for (const ledger of [{ version: 2, definitions: [], runs: [] }, { version: 1, definitions: [], runs: ['wrong'] }, { version: 1, definitions: [], runs: [], raw: 'x'.repeat(2100000) }]) {
    const container = createZergStateContainer({ extensions: { workflows: ledger } }); const before = JSON.stringify(container.read().extensions.workflows);
    assert.throws(() => createWorkflowService(container, fakePort().port)); assert.equal(JSON.stringify(container.read().extensions.workflows), before);
  }
});

test('invalid action/schema/input/concurrency and pre-aborted caller cause zero native startup', async () => {
  const h = harness(); await h.service.execute({ action: 'workflows.define', definition: h.def });
  for (const concurrency of [0, 33, 1.5, NaN]) assert.equal((await h.service.execute({ action: 'workflows.start', definitionId: 'simple', inputs: [], concurrency })).ok, false);
  const aborted = new AbortController(); aborted.abort(); assert.equal((await h.service.execute({ action: 'workflows.start', definitionId: 'simple', inputs: [] }, aborted.signal)).ok, false);
  assert.equal((await h.service.execute({ action: 'workflows.start', definitionId: 'simple', inputs: ['x'.repeat(101)] })).ok, false);
  assert.equal((await h.service.execute({ action: 'workflows.start', definitionId: 'simple', inputs: [], permissions: 'write' } as never)).ok, false);
  assert.equal(h.fake.requests.length, 0); h.service.dispose(); h.service.dispose(); await h.service.drain();
});

test('action getters never execute and unknown cleanup recovery closes all new admissions', async () => {
  const h = harness(); let calls = 0;
  const hostile = Object.defineProperty({}, 'action', { enumerable: true, get() { calls++; return 'workflows.start'; } });
  assert.equal((await h.service.execute(hostile as never)).ok, false); assert.equal(calls, 0);
  const id = await start(h, ['a'], 1); const other = createZergStateContainer(h.container.snapshot());
  const recovered = createWorkflowService(other, h.fake.port);
  assert.equal((await recovered.execute({ action: 'workflows.start', definitionId: 'simple', inputs: ['b'] })).ok, false);
  assert.equal(run(recovered, id).status, 'needs-attention'); await assert.rejects(recovered.drain(), /cleanup/);
  recovered.dispose(); h.fake.done(0); await h.service.drain(); h.service.dispose();
});

test('three explicit attempts are finite, never automatic, and retain cumulative admission budget', async () => {
  const h = harness(); let id = await start(h, ['a'], 1);
  for (let attempt = 1; attempt <= 3; attempt++) {
    h.fake.done(attempt - 1, '', 'failed'); await h.service.drain(); assert.equal(h.fake.requests.length, attempt);
    assert.equal(run(h.service, id).admissions, attempt); const retry = await h.service.execute({ action: 'workflows.retry', workflowRunId: id });
    if (attempt === 3) assert.equal(retry.ok, false);
    else { assert(retry.ok, retry.error); id = retry.view!.workflowRunId; await turns(); }
  }
  h.service.dispose();
});

test('sixteen retained runs are bounded and forget deletes no native history', async () => {
  const h = harness(); const first = await start(h, [], 1); await h.service.drain();
  for (let i = 1; i < 16; i++) { assert.equal((await h.service.execute({ action: 'workflows.start', definitionId: 'simple', inputs: [] })).ok, true); await h.service.drain(); }
  assert.equal((await h.service.execute({ action: 'workflows.start', definitionId: 'simple', inputs: [] })).ok, false);
  assert.equal(h.service.list().length, 16); assert.equal(h.fake.requests.length, 0);
  h.container.update({ extensions: { ...h.container.read().extensions, unrelatedNativeHistory: { sentinel: true } } });
  assert.equal((await h.service.execute({ action: 'workflows.forget', workflowRunId: first })).ok, true);
  assert.deepEqual(h.container.read().extensions.unrelatedNativeHistory, { sentinel: true }); h.service.dispose();
});

async function presetHarness() {
  const h = harness(); const reviewer = h.container.read().agentDefinitions.reviewer;
  h.container.update({ agentDefinitions: { ...h.container.read().agentDefinitions, generalist: { ...reviewer, id: 'generalist' } } });
  const reply = await h.service.execute({ action: 'workflows.start', definitionId: 'read-only-review', inputs: { candidatePaths: ['a.ts', 'b.ts'], scope: 'Read only evidence' }, concurrency: 2 });
  assert(reply.ok, reply.error); await turns(); return { ...h, id: reply.view!.workflowRunId };
}

test('failed discovery produces explicit partial final coverage, not successful empty report', async () => {
  const h = await presetHarness(); h.fake.done(0, '', 'failed'); await h.service.drain();
  const record = run(h.service, h.id); assert.equal(record.status, 'failed'); assert.equal(h.fake.requests.length, 1);
  assert(record.report && typeof record.report === 'object'); const report = record.report as Record<string, WorkflowJson>;
  assert.equal(report.partial, true); assert((report.workerFailures as WorkflowJson[]).length >= 1);
  assert.deepEqual((report.coverage as Record<string, WorkflowJson>).candidates, ['a.ts', 'b.ts']); h.service.dispose();
});

test('preset retains failed review and verifier coverage with exact original native IDs', async () => {
  const h = await presetHarness(); h.fake.done(0, JSON.stringify({ targets: ['a.ts', 'b.ts'] })); await turns();
  assert.equal(h.fake.requests.length, 3);
  h.fake.done(1, JSON.stringify({ findings: [{ id: 'local', title: 'Issue', path: 'a.ts', line: 1, severity: 'high', detail: 'Evidence' }] })); h.fake.done(2, '', 'failed'); await turns(12);
  assert.equal(h.fake.requests.length, 4); h.fake.done(3, '', 'failed'); await h.service.drain();
  const record = run(h.service, h.id), report = record.report as Record<string, WorkflowJson>;
  assert.equal(record.status, 'failed'); assert.equal(report.partial, true); assert.equal((report.unverified as WorkflowJson[]).length, 1);
  assert.equal((report.workerFailures as WorkflowJson[]).length, 2);
  const serialized = JSON.stringify(report); assert(serialized.includes('native-2')); assert(serialized.includes('native-3')); assert(serialized.includes('native-4')); h.service.dispose();
});

test('out-of-scope discovery is failed before any review admission', async () => {
  const h = await presetHarness(); h.fake.done(0, JSON.stringify({ targets: ['outside.ts'] })); await h.service.drain();
  assert.equal(h.fake.requests.length, 1); assert.equal(run(h.service, h.id).status, 'failed'); assert.match(run(h.service, h.id).steps[0].units[0].error!, /caller candidate scope/); h.service.dispose();
});

test('malformed port outcomes cannot resolve a cleanup barrier or free ownership', async () => {
  const h = harness(); h.service.dispose();
  const malformed: WorkflowNativePort = { preflight() {}, execute: async () => null as never };
  const service = createWorkflowService(h.container, malformed);
  await service.execute({ action: 'workflows.define', definition: h.def }); const reply = await service.execute({ action: 'workflows.start', definitionId: 'simple', inputs: ['a'], concurrency: 1 });
  await turns(12); assert.equal(run(service, reply.view!.workflowRunId).status, 'needs-attention');
  await assert.rejects(service.drain(), /cleanup/); assert.equal((await service.execute({ action: 'workflows.start', definitionId: 'simple', inputs: ['b'] })).ok, false); service.dispose();
});

test('recovery rejects changed materialized hashes without replacing raw ledger', async () => {
  const h = harness(), id = await start(h, ['a'], 1); h.fake.done(0); await h.service.drain();
  const ledger = h.container.read().extensions.workflows as unknown as { runs: WorkflowRun[] };
  ledger.runs[0].steps[0].units[0].inputs = { item: 'CHANGED' };
  assert.throws(() => recoverWorkflowState(ledger), /hash mismatch/);
  assert.equal(run(h.service, id).status, 'completed'); h.service.dispose();
});

test('immediate pause between reservation and invocation retains queued live work until explicit resume', async () => {
  const h = harness(); await h.service.execute({ action: 'workflows.define', definition: h.def });
  const reply = await h.service.execute({ action: 'workflows.start', definitionId: 'simple', inputs: ['a'], concurrency: 1 }); const id = reply.view!.workflowRunId;
  assert.equal((await h.service.execute({ action: 'workflows.pause', workflowRunId: id })).ok, true); await turns();
  assert.equal(h.fake.requests.length, 0); assert.equal(run(h.service, id).status, 'paused'); assert.equal(run(h.service, id).steps[0].units[0].status, 'queued');
  assert.equal((await h.service.execute({ action: 'workflows.resume', workflowRunId: id })).ok, true); await turns(); assert.equal(h.fake.requests.length, 1);
  h.fake.done(0); await h.service.drain(); assert.equal(run(h.service, id).status, 'completed'); h.service.dispose();
});

test('dispose after ledger ownership loss still aborts every owned handle and never overwrites replacement', async () => {
  const h = harness(); await h.service.execute({ action: 'workflows.define', definition: h.def });
  const one = await h.service.execute({ action: 'workflows.start', definitionId: 'simple', inputs: ['a'], concurrency: 2 }); await turns();
  const two = await h.service.execute({ action: 'workflows.start', definitionId: 'simple', inputs: ['b'], concurrency: 2 }); await turns(); assert(one.ok && two.ok); assert.equal(h.fake.requests.length, 2);
  const replacement = { sentinel: 'NEW WORKFLOW OWNER' }; h.container.update({ extensions: { ...h.container.read().extensions, workflows: replacement } });
  assert.doesNotThrow(() => h.service.dispose()); assert(h.fake.requests.every(r => r.signal.aborted)); assert.doesNotThrow(() => h.service.dispose());
  h.fake.done(0); h.fake.done(1); await h.service.drain(); assert.deepEqual(h.container.read().extensions.workflows, replacement);
});

test('list/show/define responses contain definition summaries, never fixed prompts or schemas', async () => {
  const h = harness(); const defined = await h.service.execute({ action: 'workflows.define', definition: h.def });
  assert.deepEqual(defined.definition, { id: 'simple', label: 'Simple', stepCount: 2 });
  const shown = await h.service.execute({ action: 'workflows.show', definitionId: 'simple' }); assert.deepEqual(shown.definition, defined.definition);
  const listed = await h.service.execute({ action: 'workflows.list' });
  for (const reply of [defined, shown, listed]) { const json = JSON.stringify(reply); assert(!json.includes('Read only; no data authority')); assert(!json.includes('outputSchema')); assert(!json.includes('inputSchema')); }
  h.service.dispose();
});


test('structured list stays compact across retained attempts while internal list and show retain exact correlations', async () => {
  const h = harness(32);
  const ids: string[] = [];
  let observed = h.service.list();
  const unsubscribe = h.service.subscribe(views => { observed = views; });
  try {
    assert.equal((await h.service.execute({ action: 'workflows.define', definition: h.def })).ok, true);
    for (let attempt = 0; attempt < 16; attempt++) {
      const size = attempt === 0 ? 1 : attempt === 15 ? 32 : 2;
      const offset = h.fake.requests.length;
      const started = await h.service.execute({ action: 'workflows.start', definitionId: 'simple', inputs: Array(size).fill('PRIVATE_UNIT_PAYLOAD'), concurrency: 32 });
      assert(started.ok, started.error); ids.push(started.view!.workflowRunId); await turns();
      assert.equal(h.fake.requests.length - offset, size);
      for (let index = offset; index < offset + size; index++) h.fake.done(index, '"PRIVATE_RESULT_PAYLOAD"');
      await h.service.drain();
    }
    const listed = await h.service.execute({ action: 'workflows.list' });
    assert(listed.ok, listed.error); assert.equal(listed.runs!.length, 16);
    const rich = h.service.list(); assert.deepEqual(observed, rich);
    for (const [index, summary] of listed.runs!.entries()) {
      const { correlations, ...expected } = rich[index];
      assert.deepEqual(summary, expected);
      assert.equal(Object.hasOwn(summary, 'correlations'), false);
      assert.equal(summary.workflowRunId, ids[index]); assert.equal(summary.familyId, ids[index]); assert.equal(summary.attemptNo, 1);
      assert.equal(summary.status, 'completed'); assert.equal(summary.cleanupSettled, true);
      assert.equal(summary.counts.completed, index === 0 ? 2 : index === 15 ? 33 : 3); // Includes the deterministic collect unit.
      const shown = await h.service.execute({ action: 'workflows.show', workflowRunId: ids[index] });
      assert(shown.ok, shown.error); assert.deepEqual(shown.view, rich[index]);
      assert.deepEqual(shown.view!.correlations, correlations);
      assert.deepEqual(correlations.filter(c => c.native).map(c => c.native), run(h.service, ids[index]).steps[0].units.map(u => u.native));
    }
    const json = JSON.stringify(listed);
    for (const excluded of ['correlations', 'unitId', 'stepId', 'native-', 'task-', 'reusedFrom', 'PRIVATE_UNIT_PAYLOAD', 'PRIVATE_RESULT_PAYLOAD', 'Read only; no data authority']) assert(!json.includes(excluded), excluded);
    // Increasing fanout 1 -> 32 changes counts, not the number of identity fields or rows in the tool reply.
    assert.deepEqual(Object.keys(listed.runs![0]), Object.keys(listed.runs![15]));
    assert(Math.abs(JSON.stringify(listed.runs![15]).length - JSON.stringify(listed.runs![0]).length) < 16);
    listed.runs![0].counts.completed = -1;
    assert.equal(h.service.list()[0].counts.completed, 2); // Summary mutations cannot reach the ledger/UI.
  } finally { unsubscribe(); h.service.dispose(); }
});
