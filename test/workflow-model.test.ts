import assert from 'node:assert/strict';
import test from 'node:test';
import { aggregateWorkflow, createReadOnlyReviewDefinition, freezeWorkflowData, resolveWorkflowRef,
  validateReviewInputs, validateWorkflowDefinition, validateWorkflowSchema, validateWorkflowValue,
  workflowHash, workflowJson } from '../workflow-model.js';
import type { WorkflowDefinition, WorkflowJson, WorkflowSchema } from '../workflow-model.js';

const text: WorkflowSchema = { type: 'string', maxLength: 100 };
const closed: WorkflowSchema = { type: 'object', properties: {}, required: [], additionalProperties: false };
function def(): WorkflowDefinition { return { id: 'test', version: 1, label: 'Test', inputSchema: closed, steps: [
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
    d => { d.steps[4].inputs.candidates = { value: 1 }; },
    d => { d.steps[4].inputs.discovery = { ref: { source: 'step', stepId: 'review', path: [] } }; },
    d => { d.steps[3].inputs.finding = { value: 'wrong source' }; },
  ];
  for (const mutate of variants) { const d = JSON.parse(JSON.stringify(createReadOnlyReviewDefinition())) as WorkflowDefinition; mutate(d); assert.throws(() => validateWorkflowDefinition(d)); }
});
