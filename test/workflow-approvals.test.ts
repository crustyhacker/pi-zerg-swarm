import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkflowApprovalRegistry } from '../workflow-approvals.js';
import { approvalRequestHash } from '../workflow-coding.js';
import type { WorkflowCodingApprovalRequest } from '../workflow-coding.js';

const request = (extra: Partial<WorkflowCodingApprovalRequest> = {}): WorkflowCodingApprovalRequest => ({
  kind: 'implementation', attemptKey: 'run:task:1', taskHash: 'a'.repeat(64), policyHash: 'b'.repeat(64), scopeHash: 'c'.repeat(64), agentHash: 'd'.repeat(64), model: 'model', baselineHash: 'e'.repeat(64), ...extra,
});

test('approval registry freezes typed human-review payload into exact request fingerprint', () => {
  const registry = createWorkflowApprovalRegistry(() => new Date('2026-01-01T00:00:00.000Z'));
  const humanReview = { summary: 'approve <b>&baseline', workflow: { workflowRunId: 'wf1', parentRunId: 'p', taskId: 't', attemptNo: 1, operation: 'stage-write', task: 'task' }, trust: { projectRoot: '/p', stagingParent: '/s', writablePaths: ['a.txt'], inputPaths: ['a.txt'], networkSandbox: 'none', warning: 'no network sandbox' }, agent: { rootAgentId: 'root', workerAgentId: 'worker', model: 'm', sealedToolPolicyHash: 'tool', effectivePolicyHash: 'policy' }, limits: { bounds: { maxFiles: 1, maxFileBytes: 10, maxTotalBytes: 10, maxCandidateBytes: 10, maxOutputBytes: 10, maxCheckMs: 10, maxReviewFindings: 1, maxIterations: 1 }, corrections: { maxIterations: 1, admissionLimit: 2 } }, baseline: { hash: 'base', entries: [{ path: 'a.txt', text: 'before' }] }, checkProfiles: [], disclosures: ['bounded'] } as any;
  const record = registry.request(request({ humanReview }));
  humanReview.baseline.entries[0].text = 'mutated';
  const inspected = registry.inspect(record.id)[0];
  assert.equal((inspected.request.humanReview as any).baseline.entries[0].text, 'before');
  assert.equal(inspected.requestHash, approvalRequestHash(inspected.request as WorkflowCodingApprovalRequest));
  assert.notEqual(inspected.requestHash, approvalRequestHash(request({ humanReview })));
  assert.throws(() => registry.grant(record.id, request({ humanReview })), /fingerprint|exact/i);
  registry.grantFingerprint(record.id, inspected.requestHash);
});

test('approval registry uses exact immutable request fingerprints, expiration, strict transitions and bounded inspect evidence', () => {
  let now = new Date('2026-01-01T00:00:00.000Z');
  const registry = createWorkflowApprovalRegistry(() => now);
  const input = request({ expiresAt: '2026-01-01T00:01:00.000Z' });
  const record = registry.request(input);
  assert.match(record.id, /^approval-/);
  assert.notEqual(record.id, 'approval-1');
  (input as unknown as Record<string, unknown>).model = 'mutated';
  const inspected = registry.inspect(record.id)[0];
  assert.equal(inspected.request.model, 'model');
  assert.equal(inspected.requestHash, approvalRequestHash(request({ expiresAt: '2026-01-01T00:01:00.000Z' })));
  assert.deepEqual(inspected.scope.candidateHash, undefined);
  registry.grantFingerprint(record.id, inspected.requestHash);
  assert.equal(registry.requireLiveFingerprint('implementation', record.id, inspected.requestHash).consumed, false);
  registry.revoke(record.id, inspected.request, 'operator revoked');
  assert.throws(() => registry.requireLiveFingerprint('implementation', record.id, inspected.requestHash), /not live|status|expired/i);
  assert.throws(() => registry.grantFingerprint(record.id, inspected.requestHash), /transition|expired/i);

  const rejected = registry.request(request({ attemptKey: 'run:task:2' }));
  registry.reject(rejected.id, registry.inspect(rejected.id)[0].request, 'no');
  assert.throws(() => registry.grantFingerprint(rejected.id, registry.inspect(rejected.id)[0].requestHash), /transition/i);

  const app = request({ kind: 'application', attemptKey: 'run:task:3', candidateHash: 'f'.repeat(64), evidenceHash: '1'.repeat(64), targetHash: '2'.repeat(64), expiresAt: '2026-01-01T00:01:00.000Z' });
  const appRecord = registry.request(app);
  const appHash = registry.inspect(appRecord.id)[0].requestHash;
  registry.grantFingerprint(appRecord.id, appHash);
  assert.equal(registry.consumeFingerprint('application', appRecord.id, appHash).consumed, true);
  assert.throws(() => registry.consumeFingerprint('application', appRecord.id, appHash), /not live|consumed/i);

  const expiring = registry.request(request({ attemptKey: 'run:task:4', expiresAt: '2026-01-01T00:00:01.000Z' }));
  now = new Date('2026-01-01T00:00:02.000Z');
  assert.equal(registry.inspect(expiring.id)[0].status, 'expired');
  assert.throws(() => registry.grantFingerprint(expiring.id, registry.inspect(expiring.id)[0].requestHash), /expired/i);
});
