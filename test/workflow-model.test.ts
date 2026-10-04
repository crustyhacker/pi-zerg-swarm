import assert from 'node:assert/strict';
import test from 'node:test';
import { aggregateWorkflow, createReadOnlyReviewDefinition, freezeWorkflowData, resolveWorkflowRef,
  validateReviewInputs, validateWorkflowDefinition, validateWorkflowSchema, validateWorkflowValue,
  workflowHash, workflowJson } from '../workflow-model.js';
import type { WorkflowDefinition, WorkflowJson, WorkflowSchema } from '../workflow-model.js';

const text: WorkflowSchema = { type: 'string', maxLength: 100 };
const closed: WorkflowSchema = { type: 'object', properties: {}, required: [], additionalProperties: false };
function def(): WorkflowDefinition { return { id: 'test', version: 1, label: 'Test', inputSchema: structuredClone(closed), steps: [
  { id: 'one', kind: 'native', agentId: 'reviewer', prompt: 'Readonly', dependsOn: [], inputs: {}, outputSchema: text },
] }; }

test('canonical SHA is independent of key order and freezes deep detached copies', () => {
  assert.equal(workflowHash({ z: 1, a: [2, 3] }), workflowHash({ a: [2, 3], z: 1 }));
  assert.notEqual(workflowHash({ a: [3, 2], z: 1 }), workflowHash({ a: [2, 3], z: 1 }));
  const source = { a: [1] }, frozen = freezeWorkflowData(source); source.a[0] = 2;
  assert.deepEqual(frozen, { a: [1] }); assert.throws(() => frozen.a.push(3));
});

test('JSON rejects getters without invoking them, cycles, holes, prototypes and nonfinite values', () => {
  let calls = 0; const getter = Object.defineProperty({}, 'x', { enumerable: true, get() { calls++; return 1; } });
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  for (const value of [getter, cyclic, new Date(), [undefined], new Array(1), Infinity, NaN, 1n, () => 1, { x: undefined }, JSON.parse('{"__proto__":1}')]) assert.throws(() => workflowJson(value));
  assert.equal(calls, 0);
});

test('JSON byte, nesting, key and node budgets fail rather than clip', () => {
  assert.throws(() => workflowJson('é'.repeat(10), 10));
  let deep: WorkflowJson = null; for (let i = 0; i < 25; i++) deep = [deep]; assert.throws(() => workflowJson(deep));
  assert.throws(() => workflowJson(Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`k${i}`, i]))));
  assert.throws(() => workflowJson(Array.from({ length: 20001 }, () => null)));
});

test('closed bounded schema validates data and rejects extra/missing fields and enum mismatches', () => {
  const schema: WorkflowSchema = { type: 'object', properties: { x: { type: 'array', maxItems: 2, items: { type: 'integer' } }, verdict: { type: 'string', maxLength: 10, enum: ['yes', 'no'] } }, required: ['x', 'verdict'], additionalProperties: false };
  validateWorkflowSchema(schema); validateWorkflowValue({ x: [1, 2], verdict: 'yes' }, schema);
  const invalid: WorkflowJson[] = [{ x: [1], verdict: 'maybe' }, { x: [1.1], verdict: 'yes' }, { x: [1, 2, 3], verdict: 'yes' }, { x: [], verdict: 'yes', extra: true }, { x: [] }];
  for (const v of invalid) assert.throws(() => validateWorkflowValue(v, schema));
});

test('schema rejects unsupported, unbounded, contradictory and cyclic definitions', () => {
  for (const s of [{ type: 'string' }, { type: 'array', items: text }, { type: 'object', properties: {} }, { type: 'number', maxLength: 2 }, { type: 'boolean', enum: [] }, { type: 'boolean', enum: [true, true] }, { type: 'string', maxLength: 10, pattern: '.' }, { type: 'string', maxLength: 10, enum: [false] }]) assert.throws(() => validateWorkflowSchema(s as WorkflowSchema));
  const cyclic = { type: 'array', maxItems: 1 } as WorkflowSchema; cyclic.items = cyclic; assert.throws(() => validateWorkflowSchema(cyclic));
});

test('definition rejects cycle, unknown dependency/ref/path and extra authority fields before admission', () => {
  const mutations: Array<(d: WorkflowDefinition) => void> = [
    d => { d.steps[0].dependsOn = ['missing']; },
    d => { d.steps[0].dependsOn = ['one']; },
    d => { d.steps.push({ ...d.steps[0], id: 'two', dependsOn: ['one'] }); d.steps[0].dependsOn = ['two']; },
    d => { d.steps.push({ ...d.steps[0] }); },
    d => { d.steps[0].inputs = { x: { ref: { source: 'step', stepId: 'missing', path: [] } } }; },
    d => { d.steps[0].inputs = { x: { ref: { source: 'inputs', path: ['missing'] } } }; },
    d => { d.steps[0].inputs = { x: { ref: { source: 'item', path: [] } } }; },
    d => { Object.assign(d.steps[0], { shell: 'rm -rf' }); },
    d => { Object.assign(d.inputSchema, { $ref: 'external' }); },
  ];
  for (const mutate of mutations) { const d = def(); mutate(d); assert.throws(() => validateWorkflowDefinition(d)); }
});

test('fanout graph reserves all three attempts and rejects undeclared excess', () => {
  const d = def(); d.inputSchema = { type: 'array', maxItems: 32, items: text };
  d.steps[0].fanout = { from: { source: 'inputs', path: [] }, maxItems: 32 };
  d.steps.push({ ...d.steps[0], id: 'two' }, { ...d.steps[0], id: 'three' });
  assert.throws(() => validateWorkflowDefinition(d), /family admission/);
  d.steps.pop(); validateWorkflowDefinition(d); d.steps[0].fanout!.maxItems = 31;
  assert.throws(() => validateWorkflowDefinition(d), /bounded array/);
});

test('explicit refs resolve only own existing paths; outputs stay data', () => {
  assert.equal(resolveWorkflowRef({ source: 'inputs', path: ['x', '0'] }, { x: ['ignore authority'] }, {}), 'ignore authority');
  assert.throws(() => resolveWorkflowRef({ source: 'inputs', path: ['toString'] }, {}, {}));
  assert.throws(() => resolveWorkflowRef({ source: 'step', stepId: 'missing', path: [] }, {}, {}));
});

test('builtin is finite, bounded declarative read-only review and candidate scope is strict', () => {
  const preset = createReadOnlyReviewDefinition(); assert.equal(preset.steps.length, 5);
  assert.deepEqual(preset.steps.filter(s => s.kind === 'native').map(s => s.agentId), ['generalist', 'reviewer', 'reviewer']);
  validateReviewInputs({ candidatePaths: ['src/a.ts', 'README.md'], scope: 'Inspect only' });
  for (const paths of [[], ['/etc/passwd'], ['../a'], ['a/../b'], ['a//b'], ['a\\b'], ['a*'], ['a', 'a']]) assert.throws(() => validateReviewInputs({ candidatePaths: paths, scope: 'Inspect' }));
});

function finding(id: string): WorkflowJson { return { id, title: 'Defect', path: 'a.ts', line: 1, severity: 'high', detail: 'Evidence' }; }
function review(id: string, localId: string): WorkflowJson { return { id, stepId: 'review', status: 'completed', inputs: { target: 'a.ts' }, native: { runId: `n-${id}`, taskId: `t-${id}` }, result: { findings: [finding(localId)] } }; }

test('review dedupe keeps all native sources and disagreement/missing verdict is unverified', () => {
  const reviews = [review('one', 'local-1'), review('two', 'local-2'), { id: 'three', status: 'failed', error: 'worker failure', inputs: { target: 'b.ts' } }];
  const findings = aggregateWorkflow('collect-findings', { reviews }) as Array<Record<string, WorkflowJson>>;
  assert.equal(findings.length, 2);
  const verifications: WorkflowJson[] = [{ id: 'verify:0', status: 'completed', inputs: { finding: findings[0] }, native: { runId: 'v1', taskId: 'vt1' }, result: { id: findings[0].id, verdict: 'verified', reason: 'Evidence' } }, { id: 'verify:1', status: 'failed', inputs: { finding: findings[1] }, error: 'Verifier failed' }];
  const report = aggregateWorkflow('review-report', { candidates: ['a.ts', 'b.ts'], discovery: { targets: ['a.ts', 'b.ts'] }, reviews, findings, verifications }) as Record<string, WorkflowJson>;
  assert.equal((report.unverified as WorkflowJson[]).length, 1); assert.equal((report.verified as WorkflowJson[]).length, 0);
  assert.equal(((report.unverified as Array<Record<string, WorkflowJson>>)[0].evidence as WorkflowJson[]).length, 2);
  assert.equal((report.workerFailures as WorkflowJson[]).length, 2); assert.equal(report.partial, true);
});

test('unknown/missing/mismatched verifier ID never yields verified', () => {
  const reviews = [review('one', 'f')], findings = aggregateWorkflow('collect-findings', { reviews }) as WorkflowJson[];
  const invalid: WorkflowJson[] = [{ id: 'wrong', verdict: 'verified' }, { verdict: 'verified' }, { id: (findings[0] as Record<string, WorkflowJson>).id, verdict: 'unknown' }];
  for (const result of invalid) {
    const report = aggregateWorkflow('review-report', { candidates: ['a.ts'], discovery: { targets: ['a.ts'] }, reviews, findings, verifications: [{ id: 'v', status: 'completed', inputs: { finding: findings[0] }, result }] }) as Record<string, WorkflowJson>;
    assert.equal((report.unverified as WorkflowJson[]).length, 1); assert.equal((report.verified as WorkflowJson[]).length, 0);
  }
});

test('duplicate/fabricated verifier IDs yield unverified partial, including otherwise empty findings', () => {
  const reviews = [review('one', 'f')], findings = aggregateWorkflow('collect-findings', { reviews }) as Array<Record<string, WorkflowJson>>;
  const id = findings[0].id;
  const duplicate: WorkflowJson[] = [0, 1].map(i => ({ id: `v${i}`, status: 'completed', native: { runId: `vn${i}`, taskId: `vt${i}` }, inputs: { finding: findings[0] }, result: { id, verdict: 'verified', reason: 'same' } }));
  const report = aggregateWorkflow('review-report', { candidates: ['a.ts'], discovery: { targets: ['a.ts'] }, reviews, findings, verifications: duplicate }) as Record<string, WorkflowJson>;
  assert.equal(report.partial, true); assert.equal((report.unverified as WorkflowJson[]).length, 1);
  const fabricated = aggregateWorkflow('review-report', { candidates: ['a.ts'], discovery: { targets: ['a.ts'] }, reviews: [{ ...review('one', 'f') as Record<string, WorkflowJson>, result: { findings: [] } }], findings: [], verifications: duplicate }) as Record<string, WorkflowJson>;
  assert.equal(fabricated.partial, true); assert((fabricated.verificationIssues as WorkflowJson[]).length >= 1);
});

test('aggregate argument schemas and dependent finding expansion reject before admission', () => {
  const variants: Array<(d: WorkflowDefinition) => void> = [
    d => { d.steps[2].inputs = {}; },
    d => { d.steps[2].consumeFailures = false; },
    d => { d.steps[1].outputSchema!.properties!.findings.maxItems = 3; },
    d => { d.steps[3].fanout!.maxItems = 31; },
    d => { d.steps[4].inputs!.candidates = { value: 1 }; },
    d => { d.steps[4].inputs!.discovery = { ref: { source: 'step', stepId: 'review', path: [] } }; },
    d => { d.steps[3].inputs!.finding = { value: 'wrong source' }; },
  ];
  for (const mutate of variants) { const d = JSON.parse(JSON.stringify(createReadOnlyReviewDefinition())) as WorkflowDefinition; mutate(d); assert.throws(() => validateWorkflowDefinition(d)); }
});

test('v2 conditions evaluate every operator without hiding missing operands', async () => {
  const { evaluateWorkflowCondition: evaluate } = await import('../workflow-model.js');
  const resolve = (b: import('../workflow-model.js').WorkflowBinding) => 'value' in b ? b.value : resolveWorkflowRef(b.ref, {}, {});
  for (const [op, expected] of [['eq', false], ['ne', true], ['lt', true], ['lte', true], ['gt', false], ['gte', false]] as const)
    assert.equal(evaluate({ op, left: { value: 1 }, right: { value: 2 } }, resolve), expected);
  for (const value of [null, true, 2, 's']) assert.equal(evaluate({ op: 'eq', left: { value }, right: { value } }, resolve), true);
  for (const value of [[1], { a: 1 }]) assert.throws(() => evaluate({ op: 'eq', left: { value }, right: { value } }, resolve));
  assert.throws(() => evaluate({ op: 'ne', left: { value: 1 }, right: { value: '1' } }, resolve));
  assert.equal(evaluate({ op: 'not', condition: { op: 'boolean', value: { value: true } } }, resolve), false);
  for (const op of ['all', 'any'] as const) {
    assert.equal(evaluate({ op, conditions: [{ op: 'boolean', value: { value: true } }, { op: 'boolean', value: { value: false } }] }, resolve), op === 'any');
    assert.throws(() => evaluate({ op, conditions: [{ op: 'boolean', value: { value: op === 'any' } }, { op: 'boolean', value: { ref: { source: 'inputs', path: ['missing'] } } }] }, resolve), /Missing/);
  }
  for (const value of [null, 1, 'true', [], {}]) assert.throws(() => evaluate({ op: 'boolean', value: { value } }, resolve));
  for (const value of [null, true, '1', [], {}]) assert.throws(() => evaluate({ op: 'lt', left: { value }, right: { value: 2 } }, resolve));
});

test('v2 condition syntax, depth, nodes, children, refs and v1 opt-in remain strict', async () => {
  const { validateWorkflowCondition } = await import('../workflow-model.js');
  const leaf: import('../workflow-model.js').WorkflowCondition = { op: 'boolean', value: { value: true } };
  let deep: import('../workflow-model.js').WorkflowCondition = leaf;
  for (let i = 0; i < 7; i++) deep = { op: 'not', condition: deep };
  validateWorkflowCondition(deep, () => {});
  assert.throws(() => validateWorkflowCondition({ op: 'not', condition: deep }, () => {}));
  assert.throws(() => validateWorkflowCondition({ op: 'all', conditions: Array(17).fill(leaf) }, () => {}));
  assert.throws(() => validateWorkflowCondition({ op: 'all', conditions: Array(4).fill({ op: 'all', conditions: Array(16).fill(leaf) }) }, () => {}));
  for (const when of [null, false, { ...leaf, extra: 1 }, { op: 'bogus' }]) { const d = def(); d.version = 2; d.steps[0].when = when as never; assert.throws(() => validateWorkflowDefinition(d)); }
  const d = def(); d.steps[0].when = leaf; assert.throws(() => validateWorkflowDefinition(d)); d.version = 2; validateWorkflowDefinition(d);
  d.steps[0].when = { op: 'boolean', value: { ref: { source: 'item', path: [] } } }; assert.throws(() => validateWorkflowDefinition(d));
  d.steps[0].when = { op: 'boolean', value: { ref: { source: 'iteration', path: [] } } }; assert.throws(() => validateWorkflowDefinition(d));
  d.steps[0].when = { op: 'boolean', value: { ref: { source: 'step', stepId: 'one', path: [] } } }; assert.throws(() => validateWorkflowDefinition(d));
});

function repeatDefinition(): WorkflowDefinition {
  return { id: 'repeat', version: 2, label: 'Repeat', inputSchema: closed, steps: [{ id: 'loop', kind: 'repeat', dependsOn: [], initial: { value: 0 }, stateSchema: { type: 'integer' }, maxIterations: 3,
    body: [{ id: 'body', kind: 'native', dependsOn: [], inputs: { state: { ref: { source: 'iteration', path: [] } } }, agentId: 'reviewer', prompt: 'Readonly', outputSchema: { type: 'integer' } }],
    feedback: { ref: { source: 'step', stepId: 'body', path: [] } }, until: { op: 'gte', left: { ref: { source: 'iteration', path: [] } }, right: { value: 2 } }, output: { ref: { source: 'iteration', path: [] } }, outputSchema: { type: 'integer' } }] };
}

test('repeat boundary scopes, authored IDs, nesting and expansion budgets validate before admission', () => {
  validateWorkflowDefinition(repeatDefinition());
  const mutations: Array<(d: WorkflowDefinition) => void> = [
    d => { d.steps[0].maxIterations = 0; }, d => { d.steps[0].maxIterations = 33; },
    d => { d.steps[0].id = 'loop@0'; }, d => { d.steps[0].body![0].id = 'body:1'; },
    d => { d.steps[0].initial = { ref: { source: 'iteration', path: [] } }; },
    d => { d.steps[0].feedback = { ref: { source: 'inputs', path: [] } }; },
    d => { d.steps[0].until = { op: 'boolean', value: { ref: { source: 'step', stepId: 'body', path: [] } } }; },
    d => { d.steps[0].body = [repeatDefinition().steps[0]]; },
    d => { d.steps[0].body![0].inputs = { value: { ref: { source: 'step', stepId: 'loop', path: [] } } }; },
    d => { d.steps[0].body = Array.from({ length: 16 }, (_, i) => ({ ...d.steps[0].body![0], id: `body${i}` })); },
    d => { d.steps[0].maxIterations = 32; d.steps[0].body = Array.from({ length: 3 }, (_, i) => ({ ...d.steps[0].body![0], id: `body${i}` })); d.steps[0].feedback = { value: 1 }; },
    d => { d.steps[0].maxIterations = 32; d.steps[0].body = Array.from({ length: 8 }, (_, i) => ({ id: `body${i}`, kind: 'aggregate', operation: 'collect', dependsOn: [], inputs: {} })); d.steps[0].feedback = { value: 1 }; },
  ];
  for (const mutate of mutations) { const d = repeatDefinition(); mutate(d); assert.throws(() => validateWorkflowDefinition(d)); }
});

test('v1 preset hash golden and v2 primitive schema inference reject every mismatched operator before execution', () => {
  assert.equal(workflowHash(createReadOnlyReviewDefinition()), 'ad28a859b04ed40a0577642d043a895ad4b41c46dfe484f254746b92dd191778');
  for (const op of ['eq', 'ne', 'lt', 'lte', 'gt', 'gte'] as const) {
    const d = def(); d.version = 2; d.inputSchema = { type: 'integer' };
    d.steps[0].when = { op, left: { ref: { source: 'inputs', path: [] } }, right: { value: '1' } }; assert.throws(() => validateWorkflowDefinition(d));
    d.steps[0].when = { op, left: { ref: { source: 'inputs', path: [] } }, right: { value: 1 } }; validateWorkflowDefinition(d);
    d.steps[0].when = { op: 'any', conditions: [{ op: 'boolean', value: { value: true } }, { op, left: { value: [] }, right: { value: [] } }] }; assert.throws(() => validateWorkflowDefinition(d));
  }
  const d = def(); d.version = 2; d.steps.unshift({ id: 'aggregate', kind: 'aggregate', operation: 'collect', dependsOn: [], inputs: {} }); d.steps[1].dependsOn = ['aggregate'];
  d.steps[1].when = { op: 'eq', left: { ref: { source: 'step', stepId: 'aggregate', path: [] } }, right: { value: true } }; assert.throws(() => validateWorkflowDefinition(d));
  const repeat = repeatDefinition(); repeat.steps[0].stateSchema = { type: 'boolean' }; assert.throws(() => validateWorkflowDefinition(repeat));
});

test('v3 coding definitions validate opt-in controlled steps without changing v1/v2 defaults', async () => {
  const { createHash } = await import('node:crypto');
  const fileText = 'old\n'; const sha256 = createHash('sha256').update(fileText).digest('hex');
  const profileBase = { id: 'unit', executable: '/usr/bin/node', argv: ['--test'], cwd: 'repo', env: {}, timeoutMs: 1000, allowGeneratedOutputs: false as const };
  const policy = { version: 3 as const, capabilities: ['stage-write','check','review','apply'], identity: { parentRunId: 'parent', taskId: 'task', attemptNo: 1, rootAgentId: 'root', workerAgentId: 'worker', model: 'model' }, scope: { task: 'bounded edit', writablePaths: ['src/a.ts'], baseline: { projectRootId: 'root', stateHash: 'base' }, manifest: [{ path: 'src/a.ts', text: fileText, bytes: Buffer.byteLength(fileText), sha256 }] }, checkProfiles: [{ ...profileBase, profileHash: workflowHash(profileBase) }], reviewRequired: true };
  const v3: WorkflowDefinition = { id: 'coding', version: 3, label: 'Coding', inputSchema: closed, steps: [{ id: 'stage', kind: 'coding', dependsOn: [], inputs: {}, outputSchema: { type: 'object', properties: { candidateHash: text }, required: ['candidateHash'], additionalProperties: false }, coding: { operation: 'stage-write', policy } }] };
  validateWorkflowDefinition(v3);
  for (const mutate of [
    (d: WorkflowDefinition) => { d.version = 2; },
    (d: WorkflowDefinition) => { d.steps[0].kind = 'native'; },
    (d: WorkflowDefinition) => { d.steps[0].coding!.operation = 'investigate'; },
    (d: WorkflowDefinition) => { d.steps[0].coding!.checkProfileId = 'unit'; },
    (d: WorkflowDefinition) => { (d.steps[0] as any).prompt = 'model approves apply'; },
  ]) { const copy = structuredClone(v3); mutate(copy); assert.throws(() => validateWorkflowDefinition(copy)); }
  const check = structuredClone(v3); check.steps[0].coding!.operation = 'check'; check.steps[0].coding!.checkProfileId = 'unit'; validateWorkflowDefinition(check);
});
