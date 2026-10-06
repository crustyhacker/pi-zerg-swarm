import test from 'node:test';
import assert from 'node:assert/strict';
import { workflowHash } from '../workflow-model.js';
import { appendRecoveryIntent, appendRecoveryResult, classifyRecoveryOperation, recoveryPlanFingerprint, validateRecoveryCheckpoint, type RecoveryCheckpointV1 } from '../workflow-recovery.js';

const H = 'a'.repeat(64), H2 = 'b'.repeat(64);
const now = '2026-10-05T00:00:00.000Z', later = '2026-10-05T00:00:01.000Z';
function base(): RecoveryCheckpointV1 {
  return { version: 1, sequence: 2, workflowRunId: 'attempt1', familyId: 'attempt1', attemptNo: 1, definitionHash: H, inputsHash: H, policyHash: H, configurationHash: H,
    budget: { maxAttempts: 3, maxAdmissions: 256, usedAdmissions: 1, attemptIds: ['attempt1'], correctionsUsed: 0 },
    operations: [{ kind: 'check', id: 'op1', sequence: 0, stepId: 'step1', unitId: 'unit1', inputHash: H, dependencyHash: H, policyHash: H, paths: ['src/a.ts'],
      preimage: { 'src/a.ts': null }, postimage: { 'src/a.ts': H }, intent: { recordedAt: now },
      result: { recordedAt: now, status: 'completed', cleanup: 'settled', evidenceHash: H, resultHash: H } }] };
}

test('validates strict checkpoint and does not mutate input', () => {
  const cp = base(), before = JSON.stringify(cp);
  assert.equal(validateRecoveryCheckpoint(cp).ok, true);
  assert.equal(JSON.stringify(cp), before);
});
test('rejects malformed custom proto getter cycle and UTF8 oversize before unsafe stringify', () => {
  const custom = Object.create({}); Object.assign(custom, base());
  assert.equal(validateRecoveryCheckpoint(custom).ok, false);
  const getter: Record<string, unknown> = { ...base() };
  Object.defineProperty(getter, 'sequence', { enumerable: true, get() { throw new Error('must not visit getter'); } });
  assert.equal(validateRecoveryCheckpoint(getter).ok, false);
  const cyc: Record<string, unknown> = { ...base() }; cyc.self = cyc;
  assert.equal(validateRecoveryCheckpoint(cyc).ok, false);
  assert.equal(validateRecoveryCheckpoint({ ...base(), workflowRunId: 'é'.repeat(1024 * 1024) }).ok, false);
});
test('rejects malformed truncated unsupported and oversize records', () => {
  assert.equal(validateRecoveryCheckpoint('{').ok, false);
  assert.match(validateRecoveryCheckpoint({ ...base(), version: 2 }).errors[0].code, /unsupported-version|unknown-key|invalid/);
  assert.equal(validateRecoveryCheckpoint({ ...base(), extra: true }).ok, false);
  const huge = { ...base(), operations: Array.from({ length: 513 }, (_, i) => ({ ...base().operations[0], id: `op${i}`, sequence: i })) };
  const errors = validateRecoveryCheckpoint(huge).errors.map(e => e.code);
  assert(errors.includes('too-many-operations'));
  assert(errors.length < 20);
});
test('rejects contradictory evidence, bad canonical dates, strict paths, hashes and lineage', () => {
  for (const bad of [
    { ...base(), operations: [{ ...base().operations[0], sequence: 2 }] },
    { ...base(), operations: [{ ...base().operations[0], intent: { recordedAt: '2026-02-30T00:00:00.000Z' } }] },
    { ...base(), operations: [{ ...base().operations[0], result: { ...base().operations[0].result!, recordedAt: '2026-10-04T23:59:59.000Z' } }] },
    { ...base(), operations: [{ ...base().operations[0], paths: ['../x'] }] },
    { ...base(), operations: [{ ...base().operations[0], paths: ['.hidden/x'] }] },
    { ...base(), operations: [{ ...base().operations[0], paths: ['src//x'] }] },
    { ...base(), operations: [{ ...base().operations[0], paths: ['src\\x'] }] },
    { ...base(), operations: [{ ...base().operations[0], paths: ['src/__proto__/x'] }] },
    { ...base(), sequence: 0 },
    { ...base(), operations: [{ ...base().operations[0], kind: 'application', generation: 'stage-generation', paths: ['src/a.ts'], postimage: { 'src/other.ts': H } }] },
    { ...base(), definitionHash: 'ABC' }, { ...base(), familyId: 'other' },
    { ...base(), budget: { ...base().budget, attemptIds: ['other'] } },
  ]) assert.equal(validateRecoveryCheckpoint(bad).ok, false);
});
test('selection lineage duplicates arbitrary authority and budgets reject', () => {
  const cp = { ...base(), attemptNo: 2, workflowRunId: 'attempt2', budget: { ...base().budget, attemptIds: ['attempt1', 'attempt2'], usedAdmissions: 1 },
    selection: { sourceAttemptId: 'attempt2', assessmentFingerprint: H, continuationAttemptId: 'attempt2', attemptNo: 2, usedAdmissions: 1, reuseUnitIds: ['u'], rerunUnitIds: ['u'], capabilities: ['shell'] } };
  const errors = validateRecoveryCheckpoint(cp).errors.map(e => e.code);
  assert(errors.includes('selection-duplicate'));
  assert(errors.includes('arbitrary-authority'));
  assert(errors.includes('attempt-lineage-discrepancy'));
  const receipts = { ...base(), operations: [{ ...base().operations[0], kind: 'stage-write' as const, generation: 'stage-generation' }], budget: { ...base().budget, usedAdmissions: 0 } };
  assert.equal(validateRecoveryCheckpoint(receipts).ok, true);
  const exhausted = { ...base(), operations: [], budget: { ...base().budget, usedAdmissions: 256 } };
  assert.equal(appendRecoveryIntent(exhausted, { ...base().operations[0], id: 'op2', intent: { recordedAt: now } }).ok, false);
});
test('immutable append helpers debit only unique executable unit starts', () => {
  const cp = { ...base(), operations: [], budget: { ...base().budget, usedAdmissions: 0 } };
  const one = appendRecoveryIntent(cp, { ...base().operations[0], id: 'op2', intent: { recordedAt: now } });
  assert.equal(one.ok, true);
  if (!one.ok) return;
  assert.equal(one.value.operations[0].sequence, 0);
  assert.equal(one.value.budget.usedAdmissions, 1);
  const receipt = appendRecoveryIntent(one.value, { ...base().operations[0], kind: 'stage-write', generation: 'stage-generation', id: 'receipt', unitId: 'unit-file', intent: { recordedAt: now } });
  assert.equal(receipt.ok, true);
  if (!receipt.ok) return;
  assert.equal(receipt.value.budget.usedAdmissions, 1);
  assert.equal(cp.operations.length, 0);
  assert.equal(appendRecoveryIntent(cp, null as never).ok, false);
  assert.equal(appendRecoveryIntent(cp, Object.create({}) as never).ok, false);
  assert.equal(appendRecoveryIntent(one.value, { ...base().operations[0], id: 'op2', intent: { recordedAt: now } }).ok, false);
  const two = appendRecoveryResult(one.value, 'op2', { recordedAt: later, status: 'completed', cleanup: 'settled', evidenceHash: H, resultHash: H }, { nativeAlreadyCompleted: true });
  assert.equal(two.ok, true);
  if (!two.ok) return;
  assert.equal(appendRecoveryResult(two.value, 'op2', { recordedAt: later, status: 'failed', cleanup: 'settled' }).ok, false);
});
test('classification requires validation and exact positive reusable evidence', () => {
  const op = base().operations[0], noResult = { ...op }; delete noResult.result;
  assert.equal(classifyRecoveryOperation(noResult, { admitted: false }).classification, 'interrupted-uncertain');
  assert.equal(classifyRecoveryOperation({ ...op, result: { recordedAt: now, status: 'failed', cleanup: 'settled' } }).classification, 'known-failed-cancelled');
  assert.equal(classifyRecoveryOperation(op, { externalInputsKnown: true, contractVersion: 'v1' }).classification, 'completed-invalid');
  assert.equal(classifyRecoveryOperation(op, { externalInputsKnown: true, dependencyContractVersion: 'v1', evidenceHash: H, resultHash: H, inputHash: H, dependencyHash: H2, policyHash: H }).classification, 'completed-invalid');
  assert.equal(classifyRecoveryOperation({ ...op, result: { ...op.result!, cleanup: 'uncertain' } }).classification, 'completed-invalid');
  const proof = { externalInputsKnown: true, dependencyContractVersion: 'v1', evidenceHash: H, resultHash: H, inputHash: H, dependencyHash: H, policyHash: H };
  const a = classifyRecoveryOperation(op, proof), b = classifyRecoveryOperation(op, proof);
  assert.deepEqual(a, b);
  assert.equal(a.classification, 'completed-valid');
  assert.equal(classifyRecoveryOperation({ ...op, sequence: 7 }, proof).classification, 'completed-valid');
});
test('native cleanup/proof nonreuse and result without intent are rejected', () => {
  const native = { ...base(), operations: [{ ...base().operations[0], kind: 'native' as const }] };
  assert.equal(validateRecoveryCheckpoint(native).ok, true);
  const unsettled = { ...native, operations: [{ ...native.operations[0], result: { ...native.operations[0].result!, cleanup: 'uncertain' as const } }] };
  assert.equal(validateRecoveryCheckpoint(unsettled).ok, true);
  assert.equal(classifyRecoveryOperation(unsettled.operations[0]).classification, 'completed-invalid');
  const nativeWithoutResult = { ...native, operations: [{ ...native.operations[0] }] }; delete nativeWithoutResult.operations[0].result;
  assert.equal(appendRecoveryResult(nativeWithoutResult, 'op1', { recordedAt: later, status: 'completed', cleanup: 'settled', evidenceHash: H, resultHash: H }).ok, false);
  const noIntent = { ...base(), operations: [{ ...base().operations[0], intent: undefined }] };
  assert.equal(classifyRecoveryOperation(noIntent.operations[0]).classification, 'conflicting-history');
});
test('plan fingerprint uses existing workflowHash canonical UTF8 hashing', () => {
  const parts = { sourceCheckpoint: base(), frozenConfiguration: { z: 'é', a: 1 }, currentConfiguration: { b: 2 }, evidence: { c: 3 }, selections: ['x'], budget: base().budget };
  const fp = recoveryPlanFingerprint(parts);
  assert.equal(fp, workflowHash(parts));
  assert.equal(workflowHash({ b: 1, a: 'é' }), workflowHash({ a: 'é', b: 1 }));
  assert.equal(workflowHash('é'), 'f2886017e9c7abacf804b54d64787dce2b611c9544ba21f3affdd126a6e50086');
  assert.match(fp, /^[a-f0-9]{64}$/);
});
