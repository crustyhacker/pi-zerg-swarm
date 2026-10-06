import type { WorkflowRun } from './workflow-model.js';
import { WORKFLOW_LIMITS, workflowAssert, workflowStepEntries, workflowHash, workflowJson } from './workflow-model.js';

export type RecoveryOperationKind = 'native' | 'stage-write' | 'check' | 'review' | 'application' | 'application-gate' | 'cleanup';
export type RecoveryResultStatus = 'completed' | 'failed' | 'cancelled' | 'uncertain';
export type RecoveryCleanupStatus = 'settled' | 'uncertain' | 'not-required';
export type RecoveryClassification = 'never-admitted' | 'completed-valid' | 'completed-invalid' | 'interrupted-uncertain' | 'known-failed-cancelled' | 'conflicting-history';
export interface RecoveryBudgetV1 { maxAttempts: 3; maxAdmissions: 256; usedAdmissions: number; attemptIds: string[]; correctionsUsed: number }
export interface RecoveryIntentV1 { recordedAt: string }
export interface RecoveryResultV1 { recordedAt: string; status: RecoveryResultStatus; evidenceHash?: string; cleanup: RecoveryCleanupStatus; resultHash?: string }
export interface RecoveryOperationV1 {
  kind: RecoveryOperationKind; id: string; sequence: number; stepId: string; unitId: string; iterationId?: string;
  inputHash: string; dependencyHash: string; policyHash: string; generation?: string; paths: string[];
  preimage: Record<string, string | null> | null; postimage: Record<string, string | null> | null;
  intent: RecoveryIntentV1; result?: RecoveryResultV1;
}
export interface RecoverySelectionV1 { sourceAttemptId: string; assessmentFingerprint: string; continuationAttemptId: string; attemptNo: number; usedAdmissions: number; reuseUnitIds: string[]; rerunUnitIds: string[]; capabilities: string[] }
export interface RecoveryCheckpointV1 {
  version: 1; sequence: number; workflowRunId: string; familyId: string; attemptNo: number;
  definitionHash: string; inputsHash: string; policyHash: string; configurationHash: string;
  budget: RecoveryBudgetV1; operations: RecoveryOperationV1[];
  /** Outbound reservation written only on the selected source attempt. */
  selection?: RecoverySelectionV1;
  /** Immutable inbound provenance written on the selected child; does not reserve the child's future continuation. */
  origin?: RecoverySelectionV1;
}
export type RecoveryValidationResult = { ok: true; value: RecoveryCheckpointV1; errors: [] } | { ok: false; errors: RecoveryValidationError[] };
export interface RecoveryValidationError { path: string; code: string; message: string }
export interface RecoveryHostEvidence {
  admitted?: boolean; evidenceHash?: string; resultHash?: string; inputHash?: string; dependencyHash?: string; policyHash?: string;
  dependencyContractVersion?: string; contractVersion?: string; externalInputsKnown?: boolean; nativeAlreadyCompleted?: boolean; status?: RecoveryResultStatus;
}
export interface RecoveryClassificationResult { classification: RecoveryClassification; reasons: string[] }

const MAX_OPERATIONS = 512, MAX_PATHS_PER_OPERATION = 64, MAX_DISTINCT_PATHS = 128, MAX_ID = 160;
const MAX_ATTEMPTS = 3, MAX_ADMISSIONS = 256, MAX_CORRECTIONS = 96, MAX_ERRORS = 128;
const OP_KINDS = new Set(['native', 'stage-write', 'check', 'review', 'application', 'application-gate', 'cleanup']);
const RESULT_STATUSES = new Set(['completed', 'failed', 'cancelled', 'uncertain']);
const CLEANUP_STATUSES = new Set(['settled', 'uncertain', 'not-required']);
const CAPABILITIES = new Set(['reuse-completed', 'rerun-selected', 'carry-artifacts', 'assess-only']);
const HASH_RE = /^[a-f0-9]{64}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,159}$/;
type Err = RecoveryValidationError;
function err(errors: Err[], path: string, code: string, message: string): void {
  if (errors.length < MAX_ERRORS) errors.push({ path, code, message });
}
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const hasOwn = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
function safeClone(input: unknown, errors: Err[]): unknown {
  try { return workflowJson(input, WORKFLOW_LIMITS.ledgerBytes); }
  catch (e) { err(errors, '$', 'invalid-json-data', e instanceof Error ? e.message : 'input must be bounded plain JSON'); return undefined; }
}
function exactOpt(o: Record<string, unknown>, req: string[], opt: string[], path: string, errors: Err[]): void {
  const keys = req.concat(opt);
  for (const k of Object.keys(o)) if (!keys.includes(k)) err(errors, `${path}.${k}`, 'unknown-key', 'unknown key');
  for (const k of req) if (!hasOwn(o, k)) err(errors, `${path}.${k}`, 'missing-key', 'missing key');
}
const exact = (o: Record<string, unknown>, keys: string[], path: string, errors: Err[]) => exactOpt(o, keys, [], path, errors);
function str(v: unknown, path: string, errors: Err[]): string {
  if (typeof v !== 'string') { err(errors, path, 'invalid-string', 'expected string'); return ''; }
  if (v.length < 1 || v.length > MAX_ID || !ID_RE.test(v)) err(errors, path, 'invalid-id', 'invalid identifier');
  return v;
}
function hash(v: unknown, path: string, errors: Err[]): string {
  if (typeof v !== 'string' || !HASH_RE.test(v)) { err(errors, path, 'invalid-hash', 'expected lowercase sha256 hex64'); return ''; }
  return v;
}
function iso(v: unknown, path: string, errors: Err[]): string {
  if (typeof v !== 'string' || !ISO_RE.test(v)) { err(errors, path, 'invalid-iso-date', 'expected canonical ISO UTC timestamp'); return ''; }
  const d = new Date(v);
  if (Number.isNaN(d.getTime()) || d.toISOString() !== v) err(errors, path, 'invalid-iso-date', 'timestamp must round-trip exactly');
  return v;
}
function int(v: unknown, path: string, errors: Err[], min: number, max: number): number {
  if (!Number.isSafeInteger(v) || (v as number) < min || (v as number) > max) { err(errors, path, 'invalid-integer', `expected integer ${min}..${max}`); return 0; }
  return v as number;
}
function validPath(s: string): boolean {
  if (s.length < 1 || s.length > 512 || s.startsWith('/') || s.includes('\\') || s.includes('//') || /[\x00-\x1f\x7f]/.test(s)) return false;
  return s.split('/').every(part => part && part !== '.' && part !== '..' && !part.startsWith('.') &&
    !['__proto__', 'constructor', 'prototype', 'config', 'configs', 'credential', 'credentials', 'secrets', 'secret'].includes(part));
}
function uniqueStrings(v: unknown, path: string, errors: Err[], max: number, check: (s: string, p: string) => void): string[] {
  if (!Array.isArray(v)) { err(errors, path, 'invalid-array', 'expected array'); return []; }
  if (v.length > max) { err(errors, path, 'too-many-items', `max ${max}`); return []; }
  const seen = new Set<string>(), out: string[] = [];
  for (let i = 0; i < v.length; i++) {
    const x = v[i];
    if (typeof x !== 'string') { err(errors, `${path}[${i}]`, 'invalid-string', 'expected string'); continue; }
    check(x, `${path}[${i}]`);
    if (seen.has(x)) err(errors, `${path}[${i}]`, 'duplicate', 'duplicate value');
    seen.add(x); out.push(x);
  }
  return out;
}
function imageMap(v: unknown, path: string, errors: Err[]): Record<string, string | null> | null {
  if (v === null) return null;
  if (!isObj(v)) { err(errors, path, 'invalid-map', 'expected object or null'); return null; }
  const entries = Object.entries(v);
  if (entries.length > MAX_PATHS_PER_OPERATION) { err(errors, path, 'too-many-items', 'max 64 image entries'); return null; }
  const out: Record<string, string | null> = {};
  for (const [k, val] of entries) {
    if (!validPath(k)) err(errors, `${path}.${k}`, 'invalid-path', 'invalid path key');
    if (val !== null && (typeof val !== 'string' || !HASH_RE.test(val))) err(errors, `${path}.${k}`, 'invalid-hash', 'expected hash or null');
    out[k] = val as string | null;
  }
  return out;
}

/** Validate inert recorded evidence only. No persisted field is an approval capability. */
export function validateRecoveryCheckpoint(input: unknown): RecoveryValidationResult {
  const errors: Err[] = [], clean = safeClone(input, errors);
  if (clean === undefined) return { ok: false, errors };
  if (!isObj(clean)) { err(errors, '$', 'invalid-checkpoint', 'expected object'); return { ok: false, errors }; }
  exactOpt(clean, ['version', 'sequence', 'workflowRunId', 'familyId', 'attemptNo', 'definitionHash', 'inputsHash', 'policyHash', 'configurationHash', 'budget', 'operations'], ['selection', 'origin'], '$', errors);
  if (clean.version !== 1) err(errors, '$.version', 'unsupported-version', 'only version 1 is supported');
  const cp: RecoveryCheckpointV1 = {
    version: 1, sequence: int(clean.sequence, '$.sequence', errors, 0, Number.MAX_SAFE_INTEGER),
    workflowRunId: str(clean.workflowRunId, '$.workflowRunId', errors), familyId: str(clean.familyId, '$.familyId', errors),
    attemptNo: int(clean.attemptNo, '$.attemptNo', errors, 1, MAX_ATTEMPTS), definitionHash: hash(clean.definitionHash, '$.definitionHash', errors),
    inputsHash: hash(clean.inputsHash, '$.inputsHash', errors), policyHash: hash(clean.policyHash, '$.policyHash', errors),
    configurationHash: hash(clean.configurationHash, '$.configurationHash', errors), budget: parseBudget(clean.budget, errors), operations: parseOperations(clean.operations, errors),
  };
  if ('selection' in clean) cp.selection = parseSelection(clean.selection, errors);
  if ('origin' in clean) cp.origin = parseSelection(clean.origin, errors);
  crossValidate(cp, errors);
  return errors.length ? { ok: false, errors } : { ok: true, value: cp, errors: [] };
}
function parseBudget(v: unknown, errors: Err[]): RecoveryBudgetV1 {
  if (!isObj(v)) { err(errors, '$.budget', 'invalid-budget', 'expected object'); return { maxAttempts: 3, maxAdmissions: 256, usedAdmissions: 0, attemptIds: [], correctionsUsed: 0 }; }
  exact(v, ['maxAttempts', 'maxAdmissions', 'usedAdmissions', 'attemptIds', 'correctionsUsed'], '$.budget', errors);
  if (v.maxAttempts !== 3) err(errors, '$.budget.maxAttempts', 'invalid-budget-link', 'maxAttempts must be 3');
  if (v.maxAdmissions !== 256) err(errors, '$.budget.maxAdmissions', 'invalid-budget-link', 'maxAdmissions must be 256');
  return { maxAttempts: 3, maxAdmissions: 256, usedAdmissions: int(v.usedAdmissions, '$.budget.usedAdmissions', errors, 0, MAX_ADMISSIONS),
    attemptIds: uniqueStrings(v.attemptIds, '$.budget.attemptIds', errors, MAX_ATTEMPTS, (s, p) => { if (!ID_RE.test(s)) err(errors, p, 'invalid-id', 'invalid attempt id'); }),
    correctionsUsed: int(v.correctionsUsed, '$.budget.correctionsUsed', errors, 0, MAX_CORRECTIONS) };
}
function parseOperations(v: unknown, errors: Err[]): RecoveryOperationV1[] {
  if (!Array.isArray(v)) { err(errors, '$.operations', 'invalid-array', 'expected array'); return []; }
  if (v.length > MAX_OPERATIONS) { err(errors, '$.operations', 'too-many-operations', 'max 512 operations'); return []; }
  const out: RecoveryOperationV1[] = [];
  for (let i = 0; i < v.length; i++) {
    const x = v[i], p = `$.operations[${i}]`;
    if (!isObj(x)) { err(errors, p, 'invalid-operation', 'expected object'); continue; }
    exactOpt(x, ['kind', 'id', 'sequence', 'stepId', 'unitId', 'inputHash', 'dependencyHash', 'policyHash', 'paths', 'preimage', 'postimage', 'intent'], ['iterationId', 'generation', 'result'], p, errors);
    if (typeof x.kind !== 'string' || !OP_KINDS.has(x.kind)) err(errors, `${p}.kind`, 'invalid-kind', 'unsupported operation kind');
    const op: RecoveryOperationV1 = {
      kind: (OP_KINDS.has(String(x.kind)) ? x.kind : 'native') as RecoveryOperationKind, id: str(x.id, `${p}.id`, errors),
      sequence: int(x.sequence, `${p}.sequence`, errors, 0, Number.MAX_SAFE_INTEGER), stepId: str(x.stepId, `${p}.stepId`, errors), unitId: str(x.unitId, `${p}.unitId`, errors),
      inputHash: hash(x.inputHash, `${p}.inputHash`, errors), dependencyHash: hash(x.dependencyHash, `${p}.dependencyHash`, errors), policyHash: hash(x.policyHash, `${p}.policyHash`, errors),
      paths: uniqueStrings(x.paths, `${p}.paths`, errors, MAX_PATHS_PER_OPERATION, (s, pp) => { if (!validPath(s)) err(errors, pp, 'invalid-path', 'invalid relative workspace path'); }),
      preimage: imageMap(x.preimage, `${p}.preimage`, errors), postimage: imageMap(x.postimage, `${p}.postimage`, errors), intent: parseIntent(x.intent, `${p}.intent`, errors),
    };
    if ('iterationId' in x) op.iterationId = str(x.iterationId, `${p}.iterationId`, errors);
    if ('generation' in x) op.generation = str(x.generation, `${p}.generation`, errors);
    if ('result' in x) op.result = parseResult(x.result, `${p}.result`, errors);
    out.push(op);
  }
  return out;
}
function parseIntent(v: unknown, path: string, errors: Err[]): RecoveryIntentV1 {
  if (!isObj(v)) { err(errors, path, 'invalid-intent', 'expected object'); return { recordedAt: '' }; }
  exact(v, ['recordedAt'], path, errors);
  return { recordedAt: iso(v.recordedAt, `${path}.recordedAt`, errors) };
}
function parseResult(v: unknown, path: string, errors: Err[]): RecoveryResultV1 {
  if (!isObj(v)) { err(errors, path, 'invalid-result', 'expected object'); return { recordedAt: '', status: 'uncertain', cleanup: 'uncertain' }; }
  exactOpt(v, ['recordedAt', 'status', 'cleanup'], ['evidenceHash', 'resultHash'], path, errors);
  if (typeof v.status !== 'string' || !RESULT_STATUSES.has(v.status)) err(errors, `${path}.status`, 'invalid-status', 'invalid result status');
  if (typeof v.cleanup !== 'string' || !CLEANUP_STATUSES.has(v.cleanup)) err(errors, `${path}.cleanup`, 'invalid-cleanup', 'invalid cleanup status');
  const r: RecoveryResultV1 = { recordedAt: iso(v.recordedAt, `${path}.recordedAt`, errors), status: (RESULT_STATUSES.has(String(v.status)) ? v.status : 'uncertain') as RecoveryResultStatus,
    cleanup: (CLEANUP_STATUSES.has(String(v.cleanup)) ? v.cleanup : 'uncertain') as RecoveryCleanupStatus };
  if ('evidenceHash' in v) r.evidenceHash = hash(v.evidenceHash, `${path}.evidenceHash`, errors);
  if ('resultHash' in v) r.resultHash = hash(v.resultHash, `${path}.resultHash`, errors);
  return r;
}
function parseSelection(v: unknown, errors: Err[]): RecoverySelectionV1 {
  if (!isObj(v)) { err(errors, '$.selection', 'invalid-selection', 'expected object'); return { sourceAttemptId: '', assessmentFingerprint: '', continuationAttemptId: '', attemptNo: 1, usedAdmissions: 0, reuseUnitIds: [], rerunUnitIds: [], capabilities: [] }; }
  exact(v, ['sourceAttemptId', 'assessmentFingerprint', 'continuationAttemptId', 'attemptNo', 'usedAdmissions', 'reuseUnitIds', 'rerunUnitIds', 'capabilities'], '$.selection', errors);
  return { sourceAttemptId: str(v.sourceAttemptId, '$.selection.sourceAttemptId', errors), assessmentFingerprint: hash(v.assessmentFingerprint, '$.selection.assessmentFingerprint', errors),
    continuationAttemptId: str(v.continuationAttemptId, '$.selection.continuationAttemptId', errors), attemptNo: int(v.attemptNo, '$.selection.attemptNo', errors, 1, MAX_ATTEMPTS),
    usedAdmissions: int(v.usedAdmissions, '$.selection.usedAdmissions', errors, 0, MAX_ADMISSIONS),
    reuseUnitIds: uniqueStrings(v.reuseUnitIds, '$.selection.reuseUnitIds', errors, MAX_ADMISSIONS, (s, p) => { if (!ID_RE.test(s)) err(errors, p, 'invalid-id', 'invalid unit id'); }),
    rerunUnitIds: uniqueStrings(v.rerunUnitIds, '$.selection.rerunUnitIds', errors, MAX_ADMISSIONS, (s, p) => { if (!ID_RE.test(s)) err(errors, p, 'invalid-id', 'invalid unit id'); }),
    capabilities: uniqueStrings(v.capabilities, '$.selection.capabilities', errors, 16, (s, p) => { if (!CAPABILITIES.has(s)) err(errors, p, 'arbitrary-authority', 'unsupported recovery capability'); }) };
}
const admits = (k: RecoveryOperationKind) => k === 'native' || k === 'check' || k === 'review' || k === 'application' || k === 'application-gate';
function admissionUnits(ops: RecoveryOperationV1[]): Set<string> {
  const units = new Set<string>();
  for (const op of ops) if (admits(op.kind)) units.add(op.unitId);
  return units;
}
function crossValidate(cp: RecoveryCheckpointV1, errors: Err[]): void {
  const minimumSequence = cp.operations.length + cp.operations.filter(op => op.result !== undefined).length + (cp.selection ? 1 : 0) + (cp.origin ? 1 : 0);
  if (cp.sequence < minimumSequence) err(errors, '$.sequence', 'checkpoint-sequence-contradiction', 'checkpoint sequence precedes recorded intent/result/selection events');
  if (cp.budget.attemptIds.length !== cp.attemptNo) err(errors, '$.budget.attemptIds', 'attempt-lineage-discrepancy', 'attemptIds must be exact bounded prefix through current attempt');
  if (cp.budget.attemptIds[0] !== cp.familyId) err(errors, '$.familyId', 'attempt-lineage-discrepancy', 'familyId must equal first attempt id');
  if (cp.budget.attemptIds[cp.attemptNo - 1] !== cp.workflowRunId) err(errors, '$.attemptNo', 'attempt-lineage-discrepancy', 'attemptNo/current attempt mismatch');
  if (cp.budget.usedAdmissions < admissionUnits(cp.operations).size) err(errors, '$.budget.usedAdmissions', 'used-admission-invalid', 'usedAdmissions cannot be less than unique admitted executable units');
  const ids = new Set<string>(), paths = new Set<string>(), unitOwners = new Map<string, string>(), results = new Map<string, string>();
  for (let i = 0; i < cp.operations.length; i++) {
    const op = cp.operations[i];
    if (op.sequence !== i) err(errors, `$.operations[${i}].sequence`, 'nonsequential', 'operation sequence must equal array index');
    if (ids.has(op.id)) err(errors, `$.operations[${i}].id`, 'duplicate-id', 'duplicate operation id');
    ids.add(op.id);
    const owner = `${op.stepId}\0${op.iterationId ?? ''}`, prior = unitOwners.get(op.unitId);
    if (prior && prior !== owner) err(errors, `$.operations[${i}].unitId`, 'unit-contradiction', 'unitId reused with contradictory step/iteration');
    unitOwners.set(op.unitId, owner);
    for (const p of op.paths) paths.add(p);
    if (op.kind === 'stage-write' || op.kind === 'application') {
      const expected = [...op.paths].sort().join('\0');
      if (!op.generation || op.paths.length === 0 || op.preimage === null || op.postimage === null ||
        Object.keys(op.preimage).sort().join('\0') !== expected || Object.keys(op.postimage).sort().join('\0') !== expected)
        err(errors, `$.operations[${i}]`, 'effect-scope-mismatch', 'mutating intent requires an owned generation and exact pre/postimage path coverage');
    }
    if (op.result) {
      if (op.result.recordedAt && op.intent.recordedAt && op.result.recordedAt < op.intent.recordedAt) err(errors, `$.operations[${i}].result.recordedAt`, 'result-before-intent', 'result timestamp precedes intent');
      const key = `${op.id}\0${op.result.status}\0${op.result.cleanup}\0${op.result.evidenceHash ?? ''}\0${op.result.resultHash ?? ''}`, previous = results.get(op.id);
      if (previous && previous !== key) err(errors, `$.operations[${i}].result`, 'contradictory-result', 'contradictory repeated operation result');
      results.set(op.id, key);
      if (op.kind === 'native' && op.result.status === 'completed' && !op.result.evidenceHash) err(errors, `$.operations[${i}].result`, 'invalid-native-evidence', 'native completed result requires legitimate evidence hash');
    }
  }
  if (paths.size > MAX_DISTINCT_PATHS) err(errors, '$.operations', 'too-many-distinct-paths', 'max 128 distinct paths');
  if (cp.selection) validateSelectionLink(cp, cp.selection, 'selection', true, errors);
  if (cp.origin) validateSelectionLink(cp, cp.origin, 'origin', false, errors);
}
function validateSelectionLink(cp: RecoveryCheckpointV1, selection: RecoverySelectionV1, field: 'selection' | 'origin', outbound: boolean, errors: Err[]): void {
  if (outbound) {
    if (selection.sourceAttemptId !== cp.workflowRunId || selection.continuationAttemptId === cp.workflowRunId || selection.attemptNo !== cp.attemptNo + 1 || cp.attemptNo >= MAX_ATTEMPTS) err(errors, `$.${field}.attemptNo`, 'attempt-lineage-discrepancy', 'source reservation must name the exact next attempt');
  } else {
    const src = cp.budget.attemptIds.indexOf(selection.sourceAttemptId), dst = cp.budget.attemptIds.indexOf(selection.continuationAttemptId);
    if (src < 0 || dst < 0 || dst !== src + 1 || selection.sourceAttemptId === selection.continuationAttemptId) err(errors, `$.${field}`, 'attempt-lineage-discrepancy', 'origin must name exact adjacent distinct source child');
    if (selection.continuationAttemptId !== cp.workflowRunId || selection.attemptNo !== cp.attemptNo) err(errors, `$.${field}.attemptNo`, 'attempt-lineage-discrepancy', 'origin continuation must be current attempt');
  }
  if (outbound ? selection.usedAdmissions !== cp.budget.usedAdmissions : selection.usedAdmissions > cp.budget.usedAdmissions) err(errors, `$.${field}.usedAdmissions`, 'used-admission-invalid', 'selection/origin admissions contradict historical budget');
  const reuse = new Set(selection.reuseUnitIds);
  for (const u of selection.rerunUnitIds) if (reuse.has(u)) err(errors, `$.${field}.rerunUnitIds`, 'selection-duplicate', 'reuse/rerun unit sets must be disjoint');
}

export function appendRecoveryIntent(checkpoint: RecoveryCheckpointV1, operation: Omit<RecoveryOperationV1, 'sequence' | 'intent' | 'result'> & { intent: RecoveryIntentV1 }): RecoveryValidationResult {
  const base = validateRecoveryCheckpoint(checkpoint);
  if (!base.ok) return base;
  if (base.value.operations.length >= MAX_OPERATIONS) return fail('$operation', 'too-many-operations', 'max 512 operations');
  const next: RecoveryCheckpointV1 = JSON.parse(JSON.stringify(base.value)), errors: Err[] = [];
  const clean = safeClone(operation, errors);
  if (!isObj(clean)) return { ok: false, errors: errors.length ? errors : [{ path: '$operation', code: 'invalid-operation', message: 'expected plain operation object' }] };
  const op = clean as unknown as Omit<RecoveryOperationV1, 'sequence' | 'result'> & { sequence?: number; result?: RecoveryResultV1 };
  if (base.value.operations.some(previous => previous.id === op.id)) return fail('$operation.id', 'duplicate-id', 'repeated publication rejected');
  delete op.sequence; delete op.result;
  const debit = admits(op.kind) && !admissionUnits(next.operations).has(op.unitId) ? 1 : 0;
  if (next.budget.usedAdmissions + debit > next.budget.maxAdmissions) return fail('$.budget.usedAdmissions', 'budget-exhausted', 'admission budget exhausted');
  next.sequence += 1; next.operations.push({ ...op, sequence: next.operations.length });
  next.budget.usedAdmissions += debit;
  return validateRecoveryCheckpoint(next);
}
export function appendRecoveryResult(checkpoint: RecoveryCheckpointV1, operationId: string, result: RecoveryResultV1, hostEvidence?: RecoveryHostEvidence): RecoveryValidationResult {
  const base = validateRecoveryCheckpoint(checkpoint);
  if (!base.ok) return base;
  const idx = base.value.operations.findIndex(op => op.id === operationId);
  if (idx < 0) return fail('$operationId', 'unknown-operation', 'no such operation');
  const op = base.value.operations[idx];
  if (op.result) return fail(`$.operations[${idx}].result`, 'repeated-publication', 'result already recorded');
  const errors: Err[] = [], clean = safeClone(result, errors), validated = parseResult(clean, '$result', errors);
  if (errors.length) return { ok: false, errors };
  if (validated.recordedAt < op.intent.recordedAt) return fail(`$.operations[${idx}].result.recordedAt`, 'result-before-intent', 'result timestamp precedes intent');
  if (op.kind === 'native' && validated.status === 'completed' && hostEvidence?.nativeAlreadyCompleted !== true) return fail(`$.operations[${idx}].result`, 'invalid-native-evidence', 'native completion must be host-legitimate already completed evidence');
  const next: RecoveryCheckpointV1 = JSON.parse(JSON.stringify(base.value));
  next.sequence += 1; next.operations[idx].result = validated;
  return validateRecoveryCheckpoint(next);
}
function validateSingleOperation(operation: unknown): RecoveryOperationV1 | undefined {
  const errors: Err[] = [], clean = safeClone(operation, errors);
  if (!isObj(clean)) return undefined;
  const sequence = int(clean.sequence, '$operation.sequence', errors, 0, Number.MAX_SAFE_INTEGER);
  if (errors.length) return undefined;
  const kind = typeof clean.kind === 'string' && OP_KINDS.has(clean.kind) ? clean.kind as RecoveryOperationKind : 'stage-write';
  const cp = { version: 1, sequence: clean.result === undefined ? 1 : 2, workflowRunId: 'attempt1', familyId: 'attempt1', attemptNo: 1,
    definitionHash: '0'.repeat(64), inputsHash: '0'.repeat(64), policyHash: '0'.repeat(64), configurationHash: '0'.repeat(64),
    budget: { maxAttempts: 3, maxAdmissions: 256, usedAdmissions: admits(kind) ? 1 : 0, attemptIds: ['attempt1'], correctionsUsed: 0 }, operations: [{ ...clean, sequence: 0 }] };
  const validated = validateRecoveryCheckpoint(cp);
  return validated.ok ? { ...validated.value.operations[0], sequence } : undefined;
}
/** A completed flag alone, or a hash without current matching evidence, never permits reuse. */
export function classifyRecoveryOperation(rawOperation: unknown, hostEvidence: RecoveryHostEvidence = {}): RecoveryClassificationResult {
  const operation = validateSingleOperation(rawOperation);
  if (!operation) return { classification: 'conflicting-history', reasons: ['invalid operation record'] };
  if (!operation.result) return { classification: 'interrupted-uncertain', reasons: [hostEvidence.admitted === false ? 'intent exists despite host non-admission evidence' : 'intent exists without recorded result'] };
  if (hostEvidence.admitted === false) return { classification: 'conflicting-history', reasons: ['recorded result contradicts independent non-admission evidence'] };
  if (operation.result.status === 'failed' || operation.result.status === 'cancelled') return { classification: 'known-failed-cancelled', reasons: [`recorded ${operation.result.status}`, ...(operation.result.cleanup === 'uncertain' ? ['cleanup remains uncertain'] : [])] };
  if (operation.result.status === 'uncertain') return { classification: 'interrupted-uncertain', reasons: ['recorded uncertain result'] };
  if (operation.kind === 'application-gate') return { classification: 'completed-invalid', reasons: ['application admission is history only; fresh exact approval is required'] };
  if (hostEvidence.status && hostEvidence.status !== operation.result.status) return { classification: 'conflicting-history', reasons: ['host status contradicts completed record'] };
  const invalid: string[] = [];
  const match = (name: string, stored: string | undefined, observed: string | undefined) => {
    if (!stored || !observed) invalid.push(`missing ${name}`);
    else if (stored !== observed) invalid.push(`${name} changed`);
  };
  match('evidence hash', operation.result.evidenceHash, hostEvidence.evidenceHash);
  match('result hash', operation.result.resultHash, hostEvidence.resultHash);
  match('input hash', operation.inputHash, hostEvidence.inputHash);
  match('dependency hash', operation.dependencyHash, hostEvidence.dependencyHash);
  match('policy hash', operation.policyHash, hostEvidence.policyHash);
  if (hostEvidence.externalInputsKnown !== true) invalid.push('external inputs unknown');
  if ((hostEvidence.dependencyContractVersion ?? hostEvidence.contractVersion) !== 'v1') invalid.push('missing versioned dependency contract');
  if (['native', 'check', 'review'].includes(operation.kind) && operation.result.cleanup !== 'settled') invalid.push('cleanup not settled');
  if (operation.kind === 'native' && hostEvidence.nativeAlreadyCompleted !== true) invalid.push('native identity not host-confirmed');
  return invalid.length ? { classification: 'completed-invalid', reasons: invalid } : { classification: 'completed-valid', reasons: ['all required fingerprints, cleanup and contracts match'] };
}
export function selectRecoveryContinuation(checkpoint: RecoveryCheckpointV1, selection: RecoverySelectionV1): RecoveryValidationResult {
  const base = validateRecoveryCheckpoint(checkpoint);
  if (!base.ok) return base;
  if (base.value.selection) return fail('$.selection', 'repeated-publication', 'continuation already selected');
  const errors: Err[] = [], clean = safeClone(selection, errors);
  const parsed = parseSelection(clean, errors);
  if (errors.length) return { ok: false, errors };
  const next: RecoveryCheckpointV1 = JSON.parse(JSON.stringify(base.value));
  next.sequence += 1;
  next.selection = parsed;
  if (parsed.usedAdmissions !== next.budget.usedAdmissions) return fail('$.selection', 'used-admission-invalid', 'selection cannot debit or reset admissions');
  return validateRecoveryCheckpoint(next);
}

export function recoveryPlanFingerprint(parts: { sourceCheckpoint: RecoveryCheckpointV1; frozenConfiguration: unknown; currentConfiguration: unknown; evidence: unknown; selections: unknown; budget: RecoveryBudgetV1 }): string {
  return workflowHash(workflowJson(parts, WORKFLOW_LIMITS.ledgerBytes));
}
function fail(path: string, code: string, message: string): RecoveryValidationResult { return { ok: false, errors: [{ path, code, message }] }; }

/** Derive per-block family usage from retained admitted writer operations, never iteration
 * cursors or completed flags. Old producer counters are only a conservative lower bound. */
export function recoveryWriterUsage(runs: readonly WorkflowRun[], run: WorkflowRun, pendingAdmission = false): { blocks: Array<{ blockId: string; admittedWriters: number; limit: number; corrections: number }>; correctionsUsed: number } {
  const family = runs.filter(r => r.familyId === run.familyId && r.attemptNo <= run.attemptNo);
  workflowAssert(family.length === run.attemptNo && family.every(r => r.recovery), 'Recovery correction accounting lacks retained family anchors');
  for (const attempt of family) {
    const previous = family.find(r => r.attemptNo === attempt.attemptNo - 1);
    const admitted = admissionUnits(attempt.recovery!.operations).size;
    workflowAssert(attempt.admissions + (pendingAdmission && attempt === run ? 1 : 0) === (previous?.admissions ?? 0) + admitted, 'Family admission/correction accounting lacks exact admitted operations');
  }
  const blocks = run.definition.steps.filter(s => s.kind === 'repeat').map(block => {
    const writers = block.body!.filter(s => s.coding?.operation === 'stage-write');
    const limits = writers.map(s => ((s.coding!.policy as { bounds?: { maxIterations?: number } }).bounds?.maxIterations ?? 8));
    let admittedWriters = 0;
    for (const attempt of family) {
      const operations = attempt.recovery!.operations;
      for (const entry of workflowStepEntries(attempt).filter(e => e.blockId === block.id && e.spec.coding?.operation === 'stage-write')) {
        for (const unit of entry.step.units) {
          const admissions = operations.filter(op => op.kind === 'native' && op.unitId === unit.id);
          workflowAssert(admissions.length <= 1, 'Duplicate repeat writer admission');
          workflowAssert(!unit.native || admissions.length === 1, 'Repeat writer identity lacks admission accounting');
          admittedWriters += admissions.length;
        }
      }
    }
    return { blockId: block.id, admittedWriters, limit: Math.min(block.maxIterations!, ...limits), corrections: Math.max(0, admittedWriters - 1) };
  });
  const derivedCorrections = blocks.reduce((n, b) => n + b.corrections, 0);
  workflowAssert(family.every(r => r.recovery!.budget.correctionsUsed <= derivedCorrections), 'Cumulative corrections lack retained admitted writer operations');
  return { blocks, correctionsUsed: derivedCorrections };
}
