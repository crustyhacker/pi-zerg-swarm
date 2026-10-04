import assert from 'node:assert/strict';
import test from 'node:test';
import { approvalRequestHash, assertLiveApprovalGrant, codingGatesPassed, codingPolicyHash, createCodingApprovalRequest, createCodingCandidate, createCodingMonitorView, invalidateCodingEvidence, validateApprovalRecord, validateCodingCheckProfile, validateCodingPolicy, validateReviewEvidence } from '../workflow-coding.js';
import type { WorkflowCodingCheckEvidence, WorkflowCodingCheckProfile, WorkflowCodingPolicy, WorkflowCodingReviewEvidence } from '../workflow-coding.js';
import { workflowHash } from '../workflow-model.js';

const sha = (s: string) => workflowHash(s).slice(0, 64); // wrong on purpose? replaced below
async function digest(text: string): Promise<string> { const { createHash } = await import('node:crypto'); return createHash('sha256').update(text).digest('hex'); }
async function policy(): Promise<WorkflowCodingPolicy> {
  const text = 'old\n';
  const profileBase = { id: 'unit', executable: '/usr/bin/node', argv: ['--test'], cwd: 'repo', env: { CI: '1' }, timeoutMs: 1000, allowGeneratedOutputs: false as const };
  const profile: WorkflowCodingCheckProfile = { ...profileBase, profileHash: workflowHash(profileBase) };
  return { version: 3, capabilities: ['investigate','stage-write','check','review','apply'], identity: { parentRunId: 'parent', taskId: 'task', attemptNo: 1, rootAgentId: 'root', workerAgentId: 'worker', model: 'model' },
    scope: { task: 'Change one file', writablePaths: ['src/a.ts'], protectedPaths: ['.git'], baseline: { projectRootId: 'root:1', stateHash: 'base' }, manifest: [{ path: 'src/a.ts', text, bytes: Buffer.byteLength(text), sha256: await digest(text) }], dependencies: [{ path: 'README.md', text: 'doc', bytes: 3, sha256: await digest('doc') }] },
    checkProfiles: [profile], reviewRequired: true };
}

test('coding policy binds explicit text manifest, capabilities, profiles and protected paths', async () => {
  const p = await policy(); validateCodingPolicy(p); validateCodingCheckProfile(p.checkProfiles![0]);
  for (const mutate of [
    (x: WorkflowCodingPolicy) => { x.version = 2 as never; },
    (x: WorkflowCodingPolicy) => { x.scope.manifest[0].sha256 = '0'.repeat(64); },
    (x: WorkflowCodingPolicy) => { x.scope.manifest[0].path = 'README.md'; },
    (x: WorkflowCodingPolicy) => { x.scope.writablePaths = ['../escape']; },
    (x: WorkflowCodingPolicy) => { x.scope.protectedPaths = ['src']; },
    (x: WorkflowCodingPolicy) => { x.scope.dependencies![0].path = 'src/a.ts'; },
    (x: WorkflowCodingPolicy) => { x.checkProfiles![0].allowGeneratedOutputs = true as never; },
    (x: WorkflowCodingPolicy) => { x.checkProfiles![0].profileHash = 'bad'; },
  ]) { const copy = structuredClone(p); mutate(copy); assert.throws(() => validateCodingPolicy(copy)); }
});

test('apply policy validation requires mandatory review, check profile, capabilities and distinct agents', async () => {
  const p = await policy();
  assert.equal(validateCodingPolicy(p).reviewRequired, true);
  for (const mutate of [
    (x: WorkflowCodingPolicy) => { delete x.reviewRequired; },
    (x: WorkflowCodingPolicy) => { x.reviewRequired = false; },
    (x: WorkflowCodingPolicy) => { x.capabilities = ['stage-write','check','apply']; },
    (x: WorkflowCodingPolicy) => { x.checkProfiles = []; },
    (x: WorkflowCodingPolicy) => { x.identity.rootAgentId = x.identity.workerAgentId; },
  ]) { const copy = structuredClone(p); mutate(copy); assert.throws(() => validateCodingPolicy(copy)); }
  const stageOnly = structuredClone(p); stageOnly.capabilities = ['stage-write']; delete stageOnly.checkProfiles; stageOnly.reviewRequired = false; stageOnly.identity.rootAgentId = stageOnly.identity.workerAgentId;
  assert.equal(validateCodingPolicy(stageOnly).capabilities.includes('apply'), false);
});

test('approval requests are exact, memory-only grants are not bearer IDs, and application binds candidate/evidence/target', async () => {
  const p = await policy();
  const implementation = createCodingApprovalRequest('implementation', p, { expiresAt: '2999-01-01T00:00:00.000Z' });
  const record = { id: 'approval-1', status: 'granted' as const, createdAt: '2026-01-01T00:00:00.000Z', ...implementation };
  validateApprovalRecord(record, implementation, new Date('2026-01-01T00:00:00.000Z'));
  assertLiveApprovalGrant({ approvalId: 'approval-1', requestHash: approvalRequestHash(implementation) }, record, implementation);
  assert.throws(() => assertLiveApprovalGrant({ approvalId: 'approval-1', requestHash: approvalRequestHash({ ...implementation, model: 'other' }) }, record, implementation));
  assert.throws(() => createCodingApprovalRequest('application', p));
  const app = createCodingApprovalRequest('application', p, { candidateHash: 'c', evidenceHash: 'e', targetHash: 't' });
  assert.notEqual(approvalRequestHash(app), approvalRequestHash(implementation));
});

test('candidate creation refuses out-of-manifest edits, changed before hashes and duplicate path overlap', async () => {
  const p = await policy(); const candidate = createCodingCandidate(p, [{ path: 'src/a.ts', beforeText: 'old\n', afterText: 'new\n' }]);
  assert.equal(candidate.changedPaths[0], 'src/a.ts'); assert.equal(candidate.policyHash, codingPolicyHash(p));
  for (const edits of [
    [{ path: 'README.md', beforeText: 'doc', afterText: 'x' }],
    [{ path: 'src/a.ts', beforeText: 'changed', afterText: 'x' }],
    [{ path: 'src/a.ts', beforeText: 'old\n', afterText: 'x' }, { path: 'src/a.ts', beforeText: 'old\n', afterText: 'y' }],
  ]) assert.throws(() => createCodingCandidate(p, edits));
});

test('check/review gates require exact passed evidence and every correction invalidates prior gates', async () => {
  const p = await policy(); const candidate = createCodingCandidate(p, [{ path: 'src/a.ts', beforeText: 'old\n', afterText: 'new\n' }]);
  const checkBase = { profileId: 'unit', status: 'passed' as const, exitCode: 0, stdout: 'ok', stderr: '' };
  const check: WorkflowCodingCheckEvidence = { ...checkBase, evidenceHash: workflowHash(checkBase) };
  const reviewBase = { status: 'passed' as const, reviewerIdentity: 'different:model', findings: [] };
  const review: WorkflowCodingReviewEvidence = { ...reviewBase, evidenceHash: workflowHash(reviewBase) };
  validateReviewEvidence(review, p);
  assert.equal(codingGatesPassed(p, { checks: [check], review }, candidate), true);
  const invalidated = invalidateCodingEvidence(candidate, { checks: [check], review });
  assert.equal(codingGatesPassed(p, invalidated, candidate), false);
  assert.equal(createCodingMonitorView(p, candidate, invalidated).gates.checks, 'invalidated');
  const badReview = { ...review, reviewerIdentity: 'worker:model' }; assert.throws(() => validateReviewEvidence(badReview, p));
});
