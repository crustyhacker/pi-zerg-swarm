import { randomUUID } from 'node:crypto';
import { approvalRequestHash, validateApprovalRecord } from './workflow-coding.js';
import { freezeWorkflowData } from './workflow-model.js';
import type { WorkflowCodingApprovalKind, WorkflowCodingApprovalRecord, WorkflowCodingApprovalRequest, WorkflowCodingApprovalStatus } from './workflow-coding.js';

export interface WorkflowApprovalInspection {
  id: string;
  kind: WorkflowCodingApprovalKind;
  status: WorkflowCodingApprovalStatus;
  requestHash: string;
  consumed: boolean;
  createdAt: string;
  decidedAt?: string;
  reason?: string;
  request: WorkflowCodingApprovalRequest;
  scope: { attemptKey: string; taskHash: string; policyHash: string; scopeHash: string; baselineHash: string; candidateHash?: string; evidenceHash?: string; targetHash?: string; expiresAt?: string };
}

export interface WorkflowTrustedApprovalRegistry {
  request(request: WorkflowCodingApprovalRequest): WorkflowCodingApprovalRecord;
  grant(id: string, request: WorkflowCodingApprovalRequest): WorkflowCodingApprovalRecord;
  grantFingerprint(id: string, requestHash: string): WorkflowCodingApprovalRecord;
  reject(id: string, request: WorkflowCodingApprovalRequest, reason?: string): WorkflowCodingApprovalRecord;
  revoke(id: string, request: WorkflowCodingApprovalRequest, reason?: string): WorkflowCodingApprovalRecord;
  requireLive(kind: WorkflowCodingApprovalKind, request: WorkflowCodingApprovalRequest): { approvalId: string; requestHash: string; consumed: false };
  requireLiveFingerprint(kind: WorkflowCodingApprovalKind, id: string, requestHash: string): { approvalId: string; requestHash: string; consumed: false };
  consume(kind: WorkflowCodingApprovalKind, request: WorkflowCodingApprovalRequest): { approvalId: string; requestHash: string; consumed: boolean };
  consumeFingerprint(kind: WorkflowCodingApprovalKind, id: string, requestHash: string): { approvalId: string; requestHash: string; consumed: boolean };
  inspect(id?: string): WorkflowApprovalInspection[];
  invalidate(predicate: (record: WorkflowCodingApprovalRecord) => boolean, reason?: string): void;
}

const IDENT = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const HASH = /^[a-f0-9]{64}$/;
const MAX_RECORDS = 128;
const requestKeys: Array<keyof WorkflowCodingApprovalRequest> = ['kind','attemptKey','taskHash','policyHash','scopeHash','agentHash','model','baselineHash','candidateHash','evidenceHash','targetHash','expiresAt','humanReview'];
function requestOnly(value: WorkflowCodingApprovalRequest | WorkflowCodingApprovalRecord): WorkflowCodingApprovalRequest {
  const out: Partial<WorkflowCodingApprovalRequest> = {};
  for (const key of requestKeys) if (value[key] !== undefined) (out as Record<string, unknown>)[key] = value[key];
  return freezeWorkflowData(out as WorkflowCodingApprovalRequest);
}
const keyFor = (request: WorkflowCodingApprovalRequest) => `${request.kind}:${approvalRequestHash(requestOnly(request))}`;
const expired = (request: WorkflowCodingApprovalRequest, now: Date) => !!request.expiresAt && Date.parse(request.expiresAt) <= now.getTime();

export function createWorkflowApprovalRegistry(now: () => Date = () => new Date()): WorkflowTrustedApprovalRegistry {
  const records = new Map<string, WorkflowCodingApprovalRecord>();
  const byFingerprint = new Map<string, string>();
  const consumed = new Set<string>();
  const stamp = () => now().toISOString();
  const copyRecord = (r: WorkflowCodingApprovalRecord) => freezeWorkflowData(r) as WorkflowCodingApprovalRecord;
  const expireRecord = (id: string, r: WorkflowCodingApprovalRecord): WorkflowCodingApprovalRecord => {
    if (['pending', 'granted'].includes(r.status) && expired(r, now())) {
      const next = freezeWorkflowData({ ...r, status: 'expired' as const, decidedAt: stamp(), reason: 'approval expired' });
      records.set(id, next); return next;
    }
    return r;
  };
  const inspectOne = (input: WorkflowCodingApprovalRecord): WorkflowApprovalInspection => {
    const r = expireRecord(input.id, input);
    const request = requestOnly(r);
    return { id: r.id, kind: r.kind, status: r.status, requestHash: approvalRequestHash(request), consumed: consumed.has(r.id), createdAt: r.createdAt, ...(r.decidedAt ? { decidedAt: r.decidedAt } : {}), ...(r.reason ? { reason: r.reason } : {}), request, scope: { attemptKey: r.attemptKey, taskHash: r.taskHash, policyHash: r.policyHash, scopeHash: r.scopeHash, baselineHash: r.baselineHash, ...(r.candidateHash ? { candidateHash: r.candidateHash } : {}), ...(r.evidenceHash ? { evidenceHash: r.evidenceHash } : {}), ...(r.targetHash ? { targetHash: r.targetHash } : {}), ...(r.expiresAt ? { expiresAt: r.expiresAt } : {}), ...(r.humanReview ? { humanReview: r.humanReview } : {}) } };
  };
  const getHash = (id: string, requestHash: string) => {
    if (!IDENT.test(id) || !HASH.test(requestHash)) throw new Error('Invalid approval fingerprint');
    const original = records.get(id);
    const record = original && expireRecord(id, original);
    if (!record || approvalRequestHash(requestOnly(record)) !== requestHash) throw new Error('Approval id does not match exact fingerprint');
    validateApprovalRecord(record, requestOnly(record), now());
    return record;
  };
  const getExact = (id: string, request: WorkflowCodingApprovalRequest) => {
    const req = requestOnly(request);
    return getHash(id, approvalRequestHash(req));
  };
  const transition = (id: string, request: WorkflowCodingApprovalRequest, status: WorkflowCodingApprovalStatus, reason?: string) => {
    const record = getExact(id, request);
    if (record.status !== 'pending' && !(status === 'revoked' && record.status === 'granted' && record.kind === 'implementation')) throw new Error('Approval status transition is not allowed');
    if (consumed.has(record.id)) throw new Error('Approval already consumed');
    const next = freezeWorkflowData({ ...record, status, decidedAt: stamp(), ...(reason ? { reason } : {}) });
    records.set(id, next); return copyRecord(next);
  };
  const requireLiveHash = (kind: WorkflowCodingApprovalKind, id: string, requestHash: string, consume: boolean): { approvalId: string; requestHash: string; consumed: boolean } => {
    const record = getHash(id, requestHash);
    if (record.kind !== kind || record.status !== 'granted' || consumed.has(id)) throw new Error('Approval grant is not live/exact');
    if (consume) consumed.add(id);
    return { approvalId: id, requestHash, consumed: consume };
  };
  const requireLiveNoConsume = (kind: WorkflowCodingApprovalKind, id: string, requestHash: string): { approvalId: string; requestHash: string; consumed: false } => {
    const live = requireLiveHash(kind, id, requestHash, false);
    return { approvalId: live.approvalId, requestHash: live.requestHash, consumed: false };
  };
  return {
    request(request) {
      const req = requestOnly(request);
      const k = keyFor(req), existing = byFingerprint.get(k);
      if (existing) return copyRecord(expireRecord(existing, records.get(existing)!));
      if (records.size >= MAX_RECORDS) throw new Error('Approval request registry is full');
      const id = `approval-${randomUUID()}`;
      const record = freezeWorkflowData({ id, status: expired(req, now()) ? 'expired' as const : 'pending' as const, createdAt: stamp(), ...req });
      records.set(id, record); byFingerprint.set(k, id);
      return copyRecord(record);
    },
    grant: (id, request) => transition(id, request, 'granted'),
    grantFingerprint(id, requestHash) { const r = getHash(id, requestHash); return transition(id, requestOnly(r), 'granted'); },
    reject: (id, request, reason) => transition(id, request, 'rejected', reason),
    revoke: (id, request, reason) => transition(id, request, 'revoked', reason),
    requireLive(kind, request) { const id = byFingerprint.get(keyFor(requestOnly(request))); if (!id) throw new Error('Approval grant missing'); return requireLiveNoConsume(kind, id, approvalRequestHash(requestOnly(request))); },
    requireLiveFingerprint(kind, id, requestHash) { return requireLiveNoConsume(kind, id, requestHash); },
    consume(kind, request) { const id = byFingerprint.get(keyFor(requestOnly(request))); if (!id) throw new Error('Approval grant missing'); return requireLiveHash(kind, id, approvalRequestHash(requestOnly(request)), true); },
    consumeFingerprint(kind, id, requestHash) { return requireLiveHash(kind, id, requestHash, true); },
    inspect(id) { if (id) return records.has(id) ? [inspectOne(records.get(id)!)] : []; return [...records.values()].slice(0, MAX_RECORDS).map(inspectOne); },
    invalidate(predicate, reason = 'invalidated') {
      for (const [id, raw] of records) {
        const record = expireRecord(id, raw);
        if (!consumed.has(id) && ['pending','granted'].includes(record.status) && predicate(copyRecord(record))) records.set(id, freezeWorkflowData({ ...record, status: 'invalidated' as const, decidedAt: stamp(), reason }));
      }
    },
  };
}
