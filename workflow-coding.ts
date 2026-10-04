import { createHash } from 'node:crypto';
import { workflowAssert, workflowHash, workflowJson } from './workflow-model.js';
import type { WorkflowJson } from './workflow-model.js';

export type WorkflowCodingCapability = 'investigate' | 'stage-write' | 'check' | 'review' | 'apply';
export type WorkflowCodingApprovalKind = 'implementation' | 'application';
export type WorkflowCodingApprovalStatus = 'pending' | 'granted' | 'rejected' | 'revoked' | 'expired' | 'invalidated';
export type WorkflowCodingPhase = 'idle' | 'awaiting-approval' | 'staging' | 'checking' | 'reviewing' | 'awaiting-apply' | 'applying' | 'completed' | 'failed' | 'uncertain';
export type WorkflowCodingGateStatus = 'missing' | 'pending' | 'passed' | 'failed' | 'skipped' | 'invalidated';

export interface WorkflowCodingBounds {
  maxFiles: number; maxFileBytes: number; maxTotalBytes: number; maxCandidateBytes: number;
  maxOutputBytes: number; maxCheckMs: number; maxReviewFindings: number; maxIterations: number;
}
export const WORKFLOW_CODING_LIMITS: WorkflowCodingBounds = Object.freeze({
  maxFiles: 32, maxFileBytes: 262_144, maxTotalBytes: 1_048_576, maxCandidateBytes: 1_048_576,
  maxOutputBytes: 65_536, maxCheckMs: 120_000, maxReviewFindings: 64, maxIterations: 8,
});

export interface WorkflowCodingFileManifestEntry { path: string; sha256: string; bytes: number; text: string }
export interface WorkflowCodingDependencyEntry { path: string; sha256: string; bytes: number; text: string }
export interface WorkflowCodingBaselineFingerprint { projectRootId: string; stateHash: string; packageVersion?: string; gitCommit?: string }
export interface WorkflowCodingIdentityBinding { parentRunId: string; workflowRunId?: string; taskId: string; attemptNo: number; rootAgentId: string; workerAgentId: string; model: string }
export interface WorkflowCodingScope {
  task: string; writablePaths: string[]; protectedPaths?: string[]; readonlyPaths?: string[];
  baseline: WorkflowCodingBaselineFingerprint; manifest: WorkflowCodingFileManifestEntry[]; dependencies?: WorkflowCodingDependencyEntry[];
}
export interface WorkflowCodingPolicy {
  version: 3; capabilities: WorkflowCodingCapability[]; identity: WorkflowCodingIdentityBinding; scope: WorkflowCodingScope;
  bounds?: Partial<WorkflowCodingBounds>; checkProfiles?: WorkflowCodingCheckProfile[]; reviewRequired?: boolean;
}
export interface WorkflowCodingCheckProfile { id: string; executable: string; argv: string[]; cwd: string; env?: Record<string, string>; timeoutMs: number; profileHash: string; allowGeneratedOutputs?: false }
export interface WorkflowCodingHumanReviewPayload {
  summary: string;
  workflow: { workflowRunId?: string; parentRunId: string; taskId: string; attemptNo: number; operation: WorkflowCodingCapability; task: string };
  trust: { projectRoot: string; stagingParent: string; writablePaths: string[]; inputPaths: string[]; networkSandbox: 'none'; warning: string };
  agent: { rootAgentId: string; workerAgentId: string; model: string; sealedToolPolicyHash: string; effectivePolicyHash: string };
  limits: { bounds: WorkflowCodingBounds; corrections: { maxIterations: number; admissionLimit: number } };
  baseline: unknown;
  checkProfiles: Array<{ id: string; executable: string; argv: string[]; cwd: string; env: Record<string, string>; timeoutMs: number; outputBytes: number; profileHash: string; allowGeneratedOutputs: false }>;
  application?: unknown;
  disclosures: string[];
}
export interface WorkflowCodingApprovalRequest {
  kind: WorkflowCodingApprovalKind; attemptKey: string; taskHash: string; policyHash: string; scopeHash: string; agentHash: string; model: string;
  baselineHash: string; candidateHash?: string; evidenceHash?: string; targetHash?: string; expiresAt?: string; humanReview?: WorkflowCodingHumanReviewPayload;
}
export interface WorkflowCodingApprovalRecord extends WorkflowCodingApprovalRequest { id: string; status: WorkflowCodingApprovalStatus; createdAt: string; decidedAt?: string; reason?: string }
export interface WorkflowCodingApprovalGrant { approvalId: string; requestHash: string; consumed?: boolean }
export interface WorkflowCodingTrustedApprovalHost {
  requestApproval(request: WorkflowCodingApprovalRequest): Promise<WorkflowCodingApprovalRecord> | WorkflowCodingApprovalRecord;
  consumeGrant(kind: WorkflowCodingApprovalKind, request: WorkflowCodingApprovalRequest): Promise<WorkflowCodingApprovalGrant> | WorkflowCodingApprovalGrant;
}
export interface WorkflowCodingCandidateFile { path: string; beforeSha256: string; afterSha256: string; beforeText: string; afterText: string }
export interface WorkflowCodingCandidate { id: string; policyHash: string; baselineHash: string; files: WorkflowCodingCandidateFile[]; changedPaths: string[]; bytes: number; candidateHash: string; iteration: number }
export interface WorkflowCodingCheckEvidence { profileId: string; status: 'passed' | 'failed' | 'skipped'; exitCode?: number; stdout?: string; stderr?: string; startedAt?: string; completedAt?: string; evidenceHash: string }
export interface WorkflowCodingReviewFinding { id: string; severity: 'low' | 'medium' | 'high'; path: string; message: string; evidence?: string }
export interface WorkflowCodingReviewEvidence { status: 'passed' | 'failed' | 'skipped'; reviewerIdentity: string; findings: WorkflowCodingReviewFinding[]; evidenceHash: string }
export interface WorkflowCodingGateEvidence { checks: WorkflowCodingCheckEvidence[]; review?: WorkflowCodingReviewEvidence; invalidatedByCandidateHash?: string }
export interface WorkflowCodingApplyOutcome { status: 'applied' | 'rejected' | 'partial' | 'uncertain'; candidateHash: string; appliedPaths: string[]; rejectedPaths: string[]; diagnostics?: string[]; outcomeHash: string }
export interface WorkflowCodingMonitorView { phase: WorkflowCodingPhase; approval?: { kind: WorkflowCodingApprovalKind; status: WorkflowCodingApprovalStatus }; owner: WorkflowCodingIdentityBinding; candidateHash?: string; changedPaths: string[]; gates: Record<'checks' | 'review' | 'applyApproval', WorkflowCodingGateStatus>; iteration: number; outcome?: WorkflowCodingApplyOutcome['status'] }

const IDENT = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const REL = /^(?!\.?(?:\/|$))(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\/\/)[A-Za-z0-9._@+\-\/ ]{1,512}$/;
function sha256(text: string): string { return createHash('sha256').update(text).digest('hex'); }
function hashValue(value: unknown): string { return workflowHash(value); }
function sortedUnique(values: string[], label: string): string[] {
  workflowAssert(Array.isArray(values) && values.length > 0, `${label} required`);
  const out = [...values].sort(); workflowAssert(new Set(out).size === out.length, `${label} must be unique`); return out;
}
export function validateCodingRelativePath(path: string): string {
  workflowAssert(typeof path === 'string' && REL.test(path) && !path.includes('\\') && !/[\x00-\x1f\x7f:*?<>|]/.test(path), 'Invalid coding relative path');
  workflowAssert(!path.split('/').some(part => part === '' || part === '.' || part === '..'), 'Invalid coding path segment');
  return path;
}
function validateTextEntry(entry: WorkflowCodingFileManifestEntry | WorkflowCodingDependencyEntry, bounds: WorkflowCodingBounds): void {
  workflowAssert(entry && typeof entry === 'object' && Object.keys(entry).sort().join(',') === 'bytes,path,sha256,text', 'Invalid text manifest entry');
  validateCodingRelativePath(entry.path); workflowAssert(typeof entry.text === 'string', 'Manifest text required');
  workflowAssert(Number.isSafeInteger(entry.bytes) && entry.bytes === Buffer.byteLength(entry.text, 'utf8') && entry.bytes <= bounds.maxFileBytes, 'Manifest byte count mismatch/exceeded');
  workflowAssert(/^[a-f0-9]{64}$/.test(entry.sha256) && sha256(entry.text) === entry.sha256, 'Manifest hash mismatch');
}
export function resolveCodingBounds(policy: Pick<WorkflowCodingPolicy, 'bounds'>): WorkflowCodingBounds {
  const b = { ...WORKFLOW_CODING_LIMITS, ...(policy.bounds ?? {}) };
  for (const [key, value] of Object.entries(b)) workflowAssert(Number.isSafeInteger(value) && value > 0 && value <= (WORKFLOW_CODING_LIMITS as unknown as Record<string, number>)[key], `Invalid coding bound ${key}`);
  return b;
}
export function validateCodingPolicy(policy: WorkflowCodingPolicy): WorkflowCodingPolicy {
  const p = workflowJson(policy, WORKFLOW_CODING_LIMITS.maxCandidateBytes) as unknown as WorkflowCodingPolicy;
  workflowAssert(p.version === 3 && Object.keys(p).every(k => ['version','capabilities','identity','scope','bounds','checkProfiles','reviewRequired'].includes(k)), 'Invalid coding policy');
  const bounds = resolveCodingBounds(p);
  workflowAssert(p.capabilities.every(c => ['investigate','stage-write','check','review','apply'].includes(c)) && new Set(p.capabilities).size === p.capabilities.length, 'Invalid coding capabilities');
  const id = p.identity;
  workflowAssert(id && [id.parentRunId, id.taskId, id.rootAgentId, id.workerAgentId, id.model].every(v => typeof v === 'string' && v.length > 0) && Number.isSafeInteger(id.attemptNo) && id.attemptNo >= 1, 'Invalid coding identity');
  if (p.capabilities.includes('review') || p.capabilities.includes('apply')) workflowAssert(id.rootAgentId !== id.workerAgentId, 'Coding worker and reviewer agents must be distinct');
  if (id.workflowRunId !== undefined) workflowAssert(IDENT.test(id.workflowRunId), 'Invalid workflow identity binding');
  const scope = p.scope; workflowAssert(scope && typeof scope.task === 'string' && scope.task.trim().length > 0 && scope.task.length <= 8192, 'Invalid coding task');
  const writable = sortedUnique(scope.writablePaths.map(validateCodingRelativePath), 'Writable paths');
  const protectedPaths = scope.protectedPaths?.map(validateCodingRelativePath) ?? [];
  workflowAssert(!writable.some(w => protectedPaths.some(p => w === p || w.startsWith(`${p}/`) || p.startsWith(`${w}/`))), 'Writable path overlaps protected path');
  workflowAssert(scope.baseline && typeof scope.baseline.projectRootId === 'string' && /^[A-Za-z0-9:._/-]{1,256}$/.test(scope.baseline.projectRootId) && typeof scope.baseline.stateHash === 'string' && scope.baseline.stateHash.length > 0, 'Invalid baseline fingerprint');
  workflowAssert(Array.isArray(scope.manifest) && scope.manifest.length > 0 && scope.manifest.length <= bounds.maxFiles, 'Invalid coding manifest');
  let total = 0; const seen = new Set<string>();
  for (const entry of scope.manifest) { validateTextEntry(entry, bounds); workflowAssert(writable.includes(entry.path), 'Manifest path is not explicitly writable'); workflowAssert(!seen.has(entry.path), 'Duplicate manifest path'); seen.add(entry.path); total += entry.bytes; }
  for (const dep of scope.dependencies ?? []) { validateTextEntry(dep, bounds); workflowAssert(!writable.includes(dep.path), 'Dependency cannot be writable resource'); total += dep.bytes; }
  workflowAssert(total <= bounds.maxTotalBytes, 'Coding manifest total bytes exceeded');
  for (const profile of p.checkProfiles ?? []) validateCodingCheckProfile(profile, bounds);
  if (p.capabilities.includes('apply')) {
    workflowAssert(['stage-write','check','review'].every(cap => p.capabilities.includes(cap as WorkflowCodingCapability)), 'Apply coding policy requires stage-write, check, and review capabilities');
    workflowAssert(p.reviewRequired === true, 'Apply coding policy requires mandatory independent review');
    workflowAssert(Array.isArray(p.checkProfiles) && p.checkProfiles.length > 0, 'Apply coding policy requires at least one approved check profile');
  }
  return Object.freeze(p);
}
export function validateCodingCheckProfile(profile: WorkflowCodingCheckProfile, bounds: WorkflowCodingBounds = WORKFLOW_CODING_LIMITS): WorkflowCodingCheckProfile {
  workflowAssert(profile && Object.keys(profile).every(k => ['id','executable','argv','cwd','env','timeoutMs','profileHash','allowGeneratedOutputs'].includes(k)), 'Invalid check profile field');
  workflowAssert(IDENT.test(profile.id) && typeof profile.executable === 'string' && profile.executable.length > 0 && !/[\x00\n\r]/.test(profile.executable), 'Invalid check executable');
  workflowAssert(Array.isArray(profile.argv) && profile.argv.length <= 32 && profile.argv.every(a => typeof a === 'string' && a.length <= 4096 && !a.includes('\0')), 'Invalid check argv');
  validateCodingRelativePath(profile.cwd); workflowAssert(Number.isSafeInteger(profile.timeoutMs) && profile.timeoutMs > 0 && profile.timeoutMs <= bounds.maxCheckMs, 'Invalid check timeout');
  workflowAssert(profile.allowGeneratedOutputs === undefined || profile.allowGeneratedOutputs === false, 'Generated outputs are not supported by core');
  const env = profile.env ?? {}; workflowAssert(Object.keys(env).length <= 64 && Object.entries(env).every(([k,v]) => /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(k) && typeof v === 'string' && v.length <= 4096 && !v.includes('\0')), 'Invalid minimal check environment');
  const canonical = { id: profile.id, executable: profile.executable, argv: profile.argv, cwd: profile.cwd, env, timeoutMs: profile.timeoutMs, allowGeneratedOutputs: false };
  workflowAssert(profile.profileHash === hashValue(canonical), 'Check profile hash mismatch');
  return profile;
}
export function codingPolicyHash(policy: WorkflowCodingPolicy): string { return hashValue(validateCodingPolicy(policy)); }
export function codingScopeHash(policy: WorkflowCodingPolicy): string { return hashValue(validateCodingPolicy(policy).scope); }
export function codingBaselineHash(policy: WorkflowCodingPolicy): string { return hashValue(validateCodingPolicy(policy).scope.baseline); }
export function createCodingApprovalRequest(kind: WorkflowCodingApprovalKind, policy: WorkflowCodingPolicy, extra: Partial<Pick<WorkflowCodingApprovalRequest,'candidateHash'|'evidenceHash'|'targetHash'|'expiresAt'|'humanReview'>> = {}): WorkflowCodingApprovalRequest {
  const p = validateCodingPolicy(policy); workflowAssert(kind === 'implementation' || kind === 'application', 'Invalid approval kind');
  if (kind === 'implementation') workflowAssert(p.capabilities.includes('stage-write'), 'Implementation approval requires stage-write capability');
  if (kind === 'application') workflowAssert(p.capabilities.includes('apply') && extra.candidateHash && extra.evidenceHash && extra.targetHash, 'Application approval requires bound candidate/evidence/target');
  return Object.freeze({ kind, attemptKey: `${p.identity.parentRunId}:${p.identity.taskId}:${p.identity.attemptNo}`, taskHash: hashValue(p.scope.task), policyHash: codingPolicyHash(p), scopeHash: codingScopeHash(p), agentHash: hashValue({ root: p.identity.rootAgentId, worker: p.identity.workerAgentId }), model: p.identity.model, baselineHash: codingBaselineHash(p), ...extra });
}
export function approvalRequestHash(request: WorkflowCodingApprovalRequest): string { return hashValue(request); }
export function validateApprovalRecord(record: WorkflowCodingApprovalRecord, request: WorkflowCodingApprovalRequest, now: Date = new Date()): WorkflowCodingApprovalRecord {
  workflowAssert(record && Object.keys(record).every(k => ['id','status','createdAt','decidedAt','reason','kind','attemptKey','taskHash','policyHash','scopeHash','agentHash','model','baselineHash','candidateHash','evidenceHash','targetHash','expiresAt','humanReview'].includes(k)), 'Invalid approval record');
  const bound = (({ kind, attemptKey, taskHash, policyHash, scopeHash, agentHash, model, baselineHash, candidateHash, evidenceHash, targetHash, expiresAt, humanReview }) => ({ kind, attemptKey, taskHash, policyHash, scopeHash, agentHash, model, baselineHash, ...(candidateHash !== undefined ? { candidateHash } : {}), ...(evidenceHash !== undefined ? { evidenceHash } : {}), ...(targetHash !== undefined ? { targetHash } : {}), ...(expiresAt !== undefined ? { expiresAt } : {}), ...(humanReview !== undefined ? { humanReview } : {}) }))(record);
  workflowAssert(approvalRequestHash(bound) === approvalRequestHash({ ...request }), 'Approval does not match exact request');
  workflowAssert(IDENT.test(record.id) && ['pending','granted','rejected','revoked','expired','invalidated'].includes(record.status), 'Invalid approval status');
  if (record.expiresAt) workflowAssert(Date.parse(record.expiresAt) > now.getTime(), 'Approval expired');
  return record;
}
export function assertLiveApprovalGrant(grant: WorkflowCodingApprovalGrant, record: WorkflowCodingApprovalRecord, request: WorkflowCodingApprovalRequest): void {
  workflowAssert(record.status === 'granted' && grant.approvalId === record.id && grant.requestHash === approvalRequestHash(request) && grant.consumed !== true, 'Approval grant is not live/exact');
}
export function createCodingCandidate(policy: WorkflowCodingPolicy, edits: Array<{ path: string; beforeText: string; afterText: string }>, iteration = 1): WorkflowCodingCandidate {
  const p = validateCodingPolicy(policy), bounds = resolveCodingBounds(p);
  workflowAssert(Number.isSafeInteger(iteration) && iteration >= 1 && iteration <= bounds.maxIterations, 'Invalid coding iteration');
  workflowAssert(Array.isArray(edits) && edits.length > 0 && edits.length <= p.scope.manifest.length, 'Invalid edit manifest');
  const files: WorkflowCodingCandidateFile[] = []; const seen = new Set<string>(); let bytes = 0;
  for (const edit of edits) {
    const path = validateCodingRelativePath(edit.path); workflowAssert(!seen.has(path), 'Overlapping duplicate candidate edit'); seen.add(path);
    const manifest = p.scope.manifest.find(e => e.path === path); workflowAssert(manifest, 'Candidate edit outside manifest');
    workflowAssert(edit.beforeText === manifest.text && sha256(edit.beforeText) === manifest.sha256, 'Candidate before text/hash changed');
    const afterBytes = Buffer.byteLength(edit.afterText, 'utf8'); workflowAssert(afterBytes <= bounds.maxFileBytes, 'Candidate file bytes exceeded'); bytes += afterBytes;
    files.push({ path, beforeSha256: sha256(edit.beforeText), afterSha256: sha256(edit.afterText), beforeText: edit.beforeText, afterText: edit.afterText });
  }
  workflowAssert(bytes <= bounds.maxCandidateBytes, 'Candidate byte budget exceeded');
  const candidateHash = hashValue({ policyHash: codingPolicyHash(p), baselineHash: codingBaselineHash(p), files, iteration });
  return Object.freeze({ id: candidateHash.slice(0, 32), policyHash: codingPolicyHash(p), baselineHash: codingBaselineHash(p), files, changedPaths: files.map(f => f.path).sort(), bytes, candidateHash, iteration });
}
export function invalidateCodingEvidence(candidate: WorkflowCodingCandidate, evidence?: WorkflowCodingGateEvidence): WorkflowCodingGateEvidence {
  return Object.freeze({ checks: (evidence?.checks ?? []).map(c => ({ ...c, status: c.status === 'passed' ? 'skipped' : c.status, evidenceHash: c.evidenceHash })), ...(evidence?.review ? { review: { ...evidence.review, status: evidence.review.status === 'passed' ? 'skipped' : evidence.review.status } } : {}), invalidatedByCandidateHash: candidate.candidateHash });
}
export function validateCheckEvidence(evidence: WorkflowCodingCheckEvidence, profile: WorkflowCodingCheckProfile, bounds: WorkflowCodingBounds = WORKFLOW_CODING_LIMITS): WorkflowCodingCheckEvidence {
  workflowAssert(evidence.profileId === profile.id && ['passed','failed','skipped'].includes(evidence.status), 'Invalid check evidence status/profile');
  workflowAssert((evidence.stdout ?? '').length + (evidence.stderr ?? '').length <= bounds.maxOutputBytes, 'Check output exceeded');
  const { evidenceHash: _checkHash, ...checkComparable } = evidence;
  workflowAssert(evidence.evidenceHash === hashValue(checkComparable), 'Check evidence hash mismatch'); return evidence;
}
export function validateReviewEvidence(evidence: WorkflowCodingReviewEvidence, policy: WorkflowCodingPolicy): WorkflowCodingReviewEvidence {
  const p = validateCodingPolicy(policy), bounds = resolveCodingBounds(p);
  workflowAssert(['passed','failed','skipped'].includes(evidence.status) && evidence.reviewerIdentity !== `${p.identity.workerAgentId}:${p.identity.model}`, 'Review must be independent reviewer identity');
  workflowAssert(evidence.findings.length <= bounds.maxReviewFindings, 'Review finding bound exceeded');
  for (const f of evidence.findings) { workflowAssert(IDENT.test(f.id) && ['low','medium','high'].includes(f.severity) && p.scope.writablePaths.includes(validateCodingRelativePath(f.path)) && typeof f.message === 'string' && f.message.length > 0 && f.message.length <= 4096, 'Invalid review finding'); }
  const { evidenceHash: _reviewHash, ...reviewComparable } = evidence;
  workflowAssert(evidence.evidenceHash === hashValue(reviewComparable), 'Review evidence hash mismatch'); return evidence;
}
export function codingGatesPassed(policy: WorkflowCodingPolicy, evidence: WorkflowCodingGateEvidence, candidate: WorkflowCodingCandidate): boolean {
  const p = validateCodingPolicy(policy); workflowAssert(candidate.policyHash === codingPolicyHash(p), 'Candidate/policy mismatch');
  if (evidence.invalidatedByCandidateHash) return false;
  const profiles = p.checkProfiles ?? [];
  return profiles.every(profile => evidence.checks.some(e => e.profileId === profile.id && e.status === 'passed')) && (!p.reviewRequired || evidence.review?.status === 'passed');
}
export function createCodingMonitorView(policy: WorkflowCodingPolicy, candidate?: WorkflowCodingCandidate, evidence?: WorkflowCodingGateEvidence, approval?: WorkflowCodingApprovalRecord, outcome?: WorkflowCodingApplyOutcome): WorkflowCodingMonitorView {
  const p = validateCodingPolicy(policy);
  const checks = !p.checkProfiles?.length ? 'skipped' : evidence?.invalidatedByCandidateHash ? 'invalidated' : p.checkProfiles.every(profile => evidence?.checks.some(e => e.profileId === profile.id && e.status === 'passed')) ? 'passed' : evidence?.checks.some(e => e.status === 'failed') ? 'failed' : 'missing';
  const review = !p.reviewRequired ? 'skipped' : evidence?.invalidatedByCandidateHash ? 'invalidated' : evidence?.review?.status === 'passed' ? 'passed' : evidence?.review?.status === 'failed' ? 'failed' : 'missing';
  const applyApproval: WorkflowCodingGateStatus = approval?.kind === 'application' ? approval.status === 'granted' ? 'passed' : approval.status === 'pending' ? 'pending' : approval.status === 'rejected' || approval.status === 'expired' || approval.status === 'revoked' ? 'failed' : 'invalidated' : 'missing';
  return { phase: outcome ? outcome.status === 'uncertain' ? 'uncertain' : outcome.status === 'applied' ? 'completed' : 'failed' : approval?.status === 'pending' ? 'awaiting-approval' : candidate ? 'awaiting-apply' : 'idle', approval: approval ? { kind: approval.kind, status: approval.status } : undefined, owner: p.identity, candidateHash: candidate?.candidateHash, changedPaths: candidate?.changedPaths ?? [], gates: { checks, review, applyApproval }, iteration: candidate?.iteration ?? p.identity.attemptNo, outcome: outcome?.status };
}
