import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import { TextDecoder } from 'node:util';
import { fileURLToPath } from 'node:url';

export interface CodingCheckProfile {
  id: string;
  executable: string;
  argv: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs: number;
  outputBytes: number;
  generatedOutputs?: string[];
}

export interface DurableCheckProcessIdentity {
  bootId: string;
  pid: number;
  startTime: string;
}

export interface DurableCheckReceiptConfig {
  receiptDir: string;
  markerPath: string;
  generation: string;
  candidateId: string;
  profileId: string;
  nonce?: string;
}

export interface DurableCheckReceiptBlocked {
  blocked: true;
  error: string;
}

export interface DurableCheckIntent extends DurableCheckReceiptConfig {
  version: 1;
  nonce: string;
  profileHash: string;
  expectedCandidateHash: string;
  candidateHashBefore: string;
  nodeIdentity: DurableCheckProcessIdentity;
  launchPhase: 'intent';
}

export interface DurableCheckSupervisorReady {
  version: 1;
  launchPhase: 'supervisor-ready';
  nonce: string;
  supervisorIdentity: DurableCheckProcessIdentity;
  nodeIdentity: DurableCheckProcessIdentity;
}

export interface DurableCheckReceipt {
  version: 1;
  launchPhase: 'receipt-written';
  generation: string;
  nonce: string;
  candidateId: string;
  profileId: string;
  profileHash: string;
  expectedCandidateHash: string;
  candidateHashBefore: string;
  commandStarted: boolean;
  commandCompleted: boolean;
  commandOutcome?: {
    exitCode: number | null;
    signal: number | string | null;
    timedOut: boolean;
    cancelled: boolean;
  };
  cleanup: CodingCheckResult['cleanup'];
  originalObservation?: {
    parentEofObserved: boolean;
    ownershipLost: boolean;
    uncertain: boolean;
  };
  supervisorIdentity: DurableCheckProcessIdentity;
  nodeIdentity: DurableCheckProcessIdentity;
  receiptPath: string;
}

export interface DurableCheckContext extends DurableCheckReceiptConfig {
  onIntent: (intent: DurableCheckIntent) => void;
  onSupervisorReady?: (ready: DurableCheckSupervisorReady) => void;
  onReceipt: (receipt: DurableCheckReceipt) => void;
}

export interface CodingCheckResult {
  passed: boolean;
  outcome: 'passed' | 'failed' | 'uncertain';
  reason: string;
  profileHash: string;
  candidateHashBefore: string;
  candidateHashAfter: string;
  expectedCandidateHash: string;
  exitCode: number | null;
  signal: NodeJS.Signals | string | null;
  timedOut: boolean;
  cancelled: boolean;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  stdoutDroppedBytes: number;
  stderrDroppedBytes: number;
  startedAt: string;
  finishedAt: string;
  launchPhase: 'preflight' | 'supervisor-spawned' | 'supervisor-ready' | 'child-launched' | 'settled' | 'uncertain';
  durableReceipt?: DurableCheckReceipt;
  cleanup: {
    attempted: boolean;
    outcome: 'not_needed' | 'ok' | 'uncertain' | 'failed';
    error?: string;
  };
}

export interface RunCodingCheckArgs {
  profile: unknown;
  stageRoot: string;
  expectedCandidateHash: string;
  captureCandidate: () => string;
  assertAuthority: () => void;
  signal?: AbortSignal;
  durable?: DurableCheckContext;
}

const PROFILE_KEYS = new Set(['id', 'executable', 'argv', 'cwd', 'env', 'timeoutMs', 'outputBytes', 'generatedOutputs']);
const MAX_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 65_536;
const MAX_PROTOCOL_BYTES = 1024 * 1024;
const SUPERVISOR_READY_LINE = '{"supervisorReady":true}';
const MAX_PROTOCOL_WITH_READY_BYTES = MAX_PROTOCOL_BYTES + 4096;
const SUPERVISOR_PYTHON = '/usr/bin/python3';
const SUPERVISOR_HARD_EXTRA_MS = 4_000;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  const record = value as Record<string, unknown>;
  return '{' + Object.keys(record).sort().map((key) => JSON.stringify(key) + ':' + stableJson(record[key])).join(',') + '}';
}

function requirePlainRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${label} must be a strict plain record`);
  }
  return value as Record<string, unknown>;
}

function validateText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\u0000')) {
    throw new TypeError(`${label} must be a non-empty string without NUL bytes`);
  }
  return value;
}

function validateOptionalRelativeCwd(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const cwd = validateText(value, 'profile.cwd');
  if (cwd !== '.' && (cwd.startsWith('..') || cwd.includes('/../') || cwd.includes('\\..\\') || isAbsolute(cwd))) {
    throw new TypeError('profile.cwd must be a relative path inside stageRoot');
  }
  return cwd;
}

export function validateCheckProfile(profile: unknown): CodingCheckProfile {
  const record = requirePlainRecord(profile, 'profile');
  for (const key of Object.keys(record)) {
    if (!PROFILE_KEYS.has(key)) throw new TypeError(`profile contains unsupported field ${key}`);
  }
  const id = validateText(record.id, 'profile.id');
  const executable = validateText(record.executable, 'profile.executable');
  if (!isAbsolute(executable)) throw new TypeError('profile.executable must be absolute');
  if (!Array.isArray(record.argv) || !record.argv.every((arg) => typeof arg === 'string' && !arg.includes('\u0000'))) {
    throw new TypeError('profile.argv must be an array of strings without NUL bytes');
  }
  const cwd = validateOptionalRelativeCwd(record.cwd);
  const envInput = record.env === undefined ? {} : requirePlainRecord(record.env, 'profile.env');
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(envInput)) {
    if (key.length === 0 || key.includes('\u0000') || key.includes('=') || typeof value !== 'string' || value.includes('\u0000')) {
      throw new TypeError('profile.env must contain string keys/values without NUL bytes and keys without =');
    }
    env[key] = value;
  }
  const timeoutMs = record.timeoutMs;
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new TypeError(`profile.timeoutMs must be finite >0 and <=${MAX_TIMEOUT_MS}`);
  }
  const outputBytes = record.outputBytes;
  if (typeof outputBytes !== 'number' || !Number.isFinite(outputBytes) || outputBytes < 0 || outputBytes > MAX_OUTPUT_BYTES) {
    throw new TypeError(`profile.outputBytes must be finite >=0 and <=${MAX_OUTPUT_BYTES}`);
  }
  if (record.generatedOutputs !== undefined) {
    if (!Array.isArray(record.generatedOutputs) || !record.generatedOutputs.every((item) => typeof item === 'string')) {
      throw new TypeError('profile.generatedOutputs must be an array of strings when provided');
    }
    if (record.generatedOutputs.length > 0) throw new TypeError('profile.generatedOutputs are unsupported by this check executor');
  }
  return Object.freeze({ id, executable, argv: Object.freeze([...record.argv]) as unknown as string[], cwd, env: Object.freeze({ ...env }) as Record<string, string>, timeoutMs, outputBytes, generatedOutputs: Object.freeze([]) as unknown as string[] });
}

export function profileHash(profile: unknown): string {
  const validated = validateCheckProfile(profile);
  let executableIdentity: Record<string, unknown>;
  try {
    const executableRealpath = realpathSync.native(validated.executable);
    const st = statSync(executableRealpath);
    executableIdentity = {
      realpath: executableRealpath,
      dev: st.dev,
      ino: st.ino,
      mode: st.mode,
      uid: st.uid,
      gid: st.gid,
      size: st.size,
      mtimeMs: Math.trunc(st.mtimeMs),
    };
  } catch (error) {
    executableIdentity = { missing: true, path: validated.executable, error: error instanceof Error ? error.message : String(error) };
  }
  return sha256(stableJson({ profile: validated, executableIdentity }));
}

function ensureStageCwd(stageRoot: string, cwd: string | undefined): string {
  if (!isAbsolute(stageRoot)) throw new TypeError('stageRoot must be absolute');
  const stageReal = realpathSync.native(stageRoot);
  const target = resolve(stageReal, cwd ?? '.');
  const targetReal = realpathSync.native(target);
  if (targetReal !== stageReal && !targetReal.startsWith(stageReal.endsWith(sep) ? stageReal : stageReal + sep)) {
    throw new TypeError('profile.cwd escapes stageRoot');
  }
  return targetReal;
}

function appendBounded(current: { chunks: Buffer[]; kept: number; dropped: number }, chunk: Buffer, limit: number): void {
  const remaining = Math.max(0, limit - current.kept);
  if (remaining > 0) {
    const slice = chunk.subarray(0, remaining);
    current.chunks.push(slice);
    current.kept += slice.length;
  }
  if (chunk.length > remaining) current.dropped += chunk.length - remaining;
}

async function waitForClose(child: ReturnType<typeof spawn>): Promise<{ code: number | null; signal: NodeJS.Signals | string | null }> {
  return await new Promise((resolveClose) => {
    child.once('close', (code, signal) => resolveClose({ code, signal }));
  });
}

function validateSupervisorRuntime(): string {
  if (process.platform !== 'linux') throw new Error('workflow checks require Linux subreaper supervisor support');
  if (!isAbsolute(SUPERVISOR_PYTHON)) throw new Error('workflow check supervisor python path is not absolute');
  const st = statSync(SUPERVISOR_PYTHON);
  if (!st.isFile()) throw new Error('workflow check supervisor python is not a regular file');
  return realpathSync.native(SUPERVISOR_PYTHON);
}

interface SupervisorReport {
  supervisorOk?: boolean;
  exitCode: number | null;
  signal: number | string | null;
  timedOut: boolean;
  cancelled: boolean;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  stdoutDroppedBytes: number;
  stderrDroppedBytes: number;
  cleanup: CodingCheckResult['cleanup'];
  errors?: string[];
  errorsDropped?: number;
}

function supervisorPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), 'workflow-check-supervisor.py');
}


function safeString(value: string, label: string, max = 256): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || value.includes('\u0000')) throw new TypeError(`${label} must be a bounded non-empty string`);
  return value;
}

function readBootId(): string {
  return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
}

function readProcessStartTime(pid: number): string {
  const text = readFileSync(`/proc/${pid}/stat`, 'utf8');
  return text.split(') ').pop()!.trim().split(/\s+/)[19];
}

function currentNodeIdentity(): DurableCheckProcessIdentity {
  return { bootId: readBootId(), pid: process.pid, startTime: readProcessStartTime(process.pid) };
}

function sameIdentity(a: DurableCheckProcessIdentity | undefined, b: DurableCheckProcessIdentity): boolean {
  return !!a && a.bootId === b.bootId && a.pid === b.pid && a.startTime === b.startTime;
}

const MAX_DURABLE_JSON_BYTES = 1024 * 1024;
const RECEIPT_KEYS = new Set(['version','launchPhase','generation','nonce','candidateId','profileId','profileHash','expectedCandidateHash','candidateHashBefore','commandStarted','commandCompleted','commandOutcome','cleanup','originalObservation','supervisorIdentity','nodeIdentity','receiptPath']);
const MARKER_KEYS = new Set(['generation','nonce','candidateId','profileId']);
const IDENTITY_KEYS = new Set(['bootId','pid','startTime']);
const CLEANUP_KEYS = new Set(['attempted','outcome','error','errorsDropped','errors']);
const OBSERVATION_KEYS = new Set(['parentEofObserved','ownershipLost','uncertain']);
const COMMAND_OUTCOME_KEYS = new Set(['exitCode','signal','timedOut','cancelled']);

function assertExactKeys(record: Record<string, unknown>, allowed: Set<string>, label: string): void {
  for (const key of Object.keys(record)) if (!allowed.has(key)) throw new TypeError(`${label} contains unsupported field ${key}`);
}

function boundedError(error: unknown): DurableCheckReceiptBlocked {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return { blocked: true, error: raw.length > 512 ? raw.slice(0, 512) + '...[truncated]' : raw };
}

function readFdBoundedUtf8(fd: number, maxBytes: number, label: string): string {
  const chunks: Buffer[] = [];
  let total = 0;
  const buf = Buffer.allocUnsafe(64 * 1024);
  while (total <= maxBytes) {
    const n = readSync(fd, buf, 0, Math.min(buf.length, maxBytes + 1 - total), null);
    if (n === 0) break;
    chunks.push(Buffer.from(buf.subarray(0, n)));
    total += n;
  }
  if (total > maxBytes) throw new TypeError(`${label} exceeds bound`);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, total));
  } catch (error) {
    throw new TypeError(`${label} is not strict UTF-8: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assertStableFileStat(before: ReturnType<typeof fstatSync>, after: ReturnType<typeof fstatSync>, current: ReturnType<typeof lstatSync>, label: string): void {
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new TypeError(`${label} changed during read`);
  if (!current || current.dev !== after.dev || current.ino !== after.ino || current.size !== after.size || current.mtimeMs !== after.mtimeMs || current.ctimeMs !== after.ctimeMs) throw new TypeError(`${label} path identity changed during read`);
}


function assertCurrentRegularIdentity(path: string, fd: number, label: string): void {
  const st = fstatSync(fd);
  const lst = lstatSync(path);
  if (!st.isFile() || !lst.isFile()) throw new TypeError(`${label} is not a regular file`);
  if (lst.isSymbolicLink()) throw new TypeError(`${label} must not be a symlink`);
  if (st.dev !== lst.dev || st.ino !== lst.ino) throw new TypeError(`${label} identity changed`);
  if (st.nlink !== 1 || lst.nlink !== 1) throw new TypeError(`${label} must not have hardlinks`);
  if (st.uid !== process.getuid?.()) throw new TypeError(`${label} uid mismatch`);
  if ((st.mode & 0o077) !== 0) throw new TypeError(`${label} mode must be private`);
}

function assertTrustedAncestry(absPath: string): void {
  if (!isAbsolute(absPath)) throw new TypeError('durable path must be absolute');
  const parts = absPath.split(sep).filter(Boolean);
  let cur: string = sep;
  for (const part of parts) {
    cur = cur === sep ? sep + part : cur + sep + part;
    const st = lstatSync(cur);
    if (st.isSymbolicLink()) throw new TypeError(`durable ancestor ${cur} must not be symlink`);
    if (cur === absPath) break;
    if (!st.isDirectory()) throw new TypeError(`durable ancestor ${cur} is not directory`);
    if ((st.mode & 0o002) !== 0 && (st.mode & 0o1000) === 0 && st.uid !== process.getuid?.()) throw new TypeError(`durable ancestor ${cur} is untrusted`);
  }
}

function verifyReceiptLocation(config: DurableCheckReceiptConfig): { dir: string; markerPath: string; receiptPath: string; nonce: string } {
  const generation = safeString(config.generation, 'durable.generation');
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/.test(generation)) throw new TypeError('durable.generation must be a single safe path component');
  const nonce = config.nonce === undefined ? randomBytes(24).toString('hex') : safeString(config.nonce, 'durable.nonce');
  safeString(config.candidateId, 'durable.candidateId');
  safeString(config.profileId, 'durable.profileId');
  if (!isAbsolute(config.receiptDir) || !isAbsolute(config.markerPath)) throw new TypeError('durable receipt paths must be absolute');
  assertTrustedAncestry(config.receiptDir);
  assertTrustedAncestry(config.markerPath);
  const dir = realpathSync.native(config.receiptDir);
  const markerPath = config.markerPath;
  if (markerPath !== dir + sep + 'marker.json') throw new TypeError('durable marker must be marker.json inside receiptDir');
  const dirStat = lstatSync(dir);
  if (!dirStat.isDirectory()) throw new TypeError('durable receiptDir is not a directory');
  if (dirStat.uid !== process.getuid?.() || (dirStat.mode & 0o077) !== 0) throw new TypeError('durable receiptDir must be private to current uid');
  let markerFd: number | undefined;
  try {
    const dirBefore = lstatSync(dir);
    markerFd = openSync(markerPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    assertCurrentRegularIdentity(markerPath, markerFd, 'durable marker');
    const markerBefore = fstatSync(markerFd);
    const marker = requirePlainRecord(JSON.parse(readFdBoundedUtf8(markerFd, MAX_DURABLE_JSON_BYTES, 'durable marker')), 'durable.marker');
    const markerAfter = fstatSync(markerFd);
    const markerCurrent = lstatSync(markerPath);
    const dirAfter = lstatSync(dir);
    assertStableFileStat(markerBefore, markerAfter, markerCurrent, 'durable marker');
    if (dirBefore.dev !== dirAfter.dev || dirBefore.ino !== dirAfter.ino || dirBefore.mtimeMs !== dirAfter.mtimeMs || dirBefore.ctimeMs !== dirAfter.ctimeMs) throw new TypeError('durable receiptDir changed during marker verification');
    assertExactKeys(marker, MARKER_KEYS, 'durable.marker');
    if (marker.generation !== generation || marker.nonce !== nonce || marker.candidateId !== config.candidateId || marker.profileId !== config.profileId) {
      throw new TypeError('durable marker identity mismatch');
    }
  } finally {
    if (markerFd !== undefined) closeSync(markerFd);
  }
  return { dir, markerPath, receiptPath: dir + sep + generation + '.receipt.json', nonce };
}

function validateIdentity(value: unknown, label: string): DurableCheckProcessIdentity {
  const record = requirePlainRecord(value, label);
  assertExactKeys(record, IDENTITY_KEYS, label);
  const pid = record.pid;
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0 || pid > 4_194_304) throw new TypeError(`${label}.pid invalid`);
  const bootId = validateText(record.bootId, `${label}.bootId`);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(bootId)) throw new TypeError(`${label}.bootId must be UUID text`);
  const startTime = validateText(record.startTime, `${label}.startTime`);
  if (!/^\d{1,20}$/.test(startTime)) throw new TypeError(`${label}.startTime must be bounded digit text`);
  return { bootId, pid, startTime };
}

function processIdentityForPid(pid: number): DurableCheckProcessIdentity {
  return { bootId: readBootId(), pid, startTime: readProcessStartTime(pid) };
}

function validateCleanup(value: unknown, label: string): CodingCheckResult['cleanup'] {
  const cleanup = requirePlainRecord(value, label);
  assertExactKeys(cleanup, CLEANUP_KEYS, label);
  if (typeof cleanup.attempted !== 'boolean') throw new TypeError(`${label}.attempted must be boolean`);
  if (!['not_needed','ok','uncertain','failed'].includes(cleanup.outcome as string)) throw new TypeError(`${label}.outcome invalid`);
  if (cleanup.error !== undefined && typeof cleanup.error !== 'string') throw new TypeError(`${label}.error must be string`);
  if (cleanup.errorsDropped !== undefined && (typeof cleanup.errorsDropped !== 'number' || !Number.isSafeInteger(cleanup.errorsDropped) || cleanup.errorsDropped < 0)) throw new TypeError(`${label}.errorsDropped invalid`);
  if (cleanup.errors !== undefined && (!Array.isArray(cleanup.errors) || !cleanup.errors.every((item) => typeof item === 'string'))) throw new TypeError(`${label}.errors invalid`);
  return cleanup as unknown as CodingCheckResult['cleanup'];
}



function validateCommandOutcome(value: unknown, label: string): DurableCheckReceipt['commandOutcome'] {
  const record = requirePlainRecord(value, label);
  assertExactKeys(record, COMMAND_OUTCOME_KEYS, label);
  if (!(record.exitCode === null || (typeof record.exitCode === 'number' && Number.isSafeInteger(record.exitCode)))) throw new TypeError(`${label}.exitCode invalid`);
  if (!(record.signal === null || typeof record.signal === 'number' || typeof record.signal === 'string')) throw new TypeError(`${label}.signal invalid`);
  if (typeof record.timedOut !== 'boolean' || typeof record.cancelled !== 'boolean') throw new TypeError(`${label} booleans invalid`);
  return record as DurableCheckReceipt['commandOutcome'];
}

function validateSupervisorReport(value: unknown): SupervisorReport | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ['supervisorOk','timedOut','cancelled','stdoutTruncated','stderrTruncated'] as const) {
    if (typeof record[key] !== 'boolean') return undefined;
  }
  if (!(record.exitCode === null || (typeof record.exitCode === 'number' && Number.isSafeInteger(record.exitCode)))) return undefined;
  if (!(record.signal === null || typeof record.signal === 'number' || typeof record.signal === 'string')) return undefined;
  if (typeof record.stdout !== 'string' || typeof record.stderr !== 'string') return undefined;
  if (typeof record.stdoutDroppedBytes !== 'number' || !Number.isSafeInteger(record.stdoutDroppedBytes) || record.stdoutDroppedBytes < 0) return undefined;
  if (typeof record.stderrDroppedBytes !== 'number' || !Number.isSafeInteger(record.stderrDroppedBytes) || record.stderrDroppedBytes < 0) return undefined;
  try { validateCleanup(record.cleanup, 'supervisor.cleanup'); } catch { return undefined; }
  if (record.errors !== undefined && (!Array.isArray(record.errors) || !record.errors.every((item) => typeof item === 'string'))) return undefined;
  if (record.errorsDropped !== undefined && (typeof record.errorsDropped !== 'number' || !Number.isSafeInteger(record.errorsDropped) || record.errorsDropped < 0)) return undefined;
  return record as unknown as SupervisorReport;
}

function validateReceipt(value: unknown, expected: DurableCheckIntent & { receiptPath: string }, supervisorIdentity?: DurableCheckProcessIdentity): DurableCheckReceipt {
  const record = requirePlainRecord(value, 'receipt');
  assertExactKeys(record, RECEIPT_KEYS, 'receipt');
  const cleanup = validateCleanup(record.cleanup, 'receipt.cleanup');
  const receiptSupervisor = validateIdentity(record.supervisorIdentity, 'receipt.supervisorIdentity');
  const receiptNode = validateIdentity(record.nodeIdentity, 'receipt.nodeIdentity');
  if (record.originalObservation !== undefined) {
    const obs = requirePlainRecord(record.originalObservation, 'receipt.originalObservation');
    assertExactKeys(obs, OBSERVATION_KEYS, 'receipt.originalObservation');
    for (const key of OBSERVATION_KEYS) if (typeof obs[key] !== 'boolean') throw new TypeError(`receipt.originalObservation.${key} must be boolean`);
  }
  if (record.version !== 1 || record.launchPhase !== 'receipt-written') throw new TypeError('receipt version/phase mismatch');
  for (const key of ['generation','nonce','candidateId','profileId','profileHash','expectedCandidateHash','candidateHashBefore','receiptPath'] as const) {
    if (record[key] !== expected[key]) throw new TypeError(`receipt ${key} mismatch`);
  }
  if (typeof record.commandStarted !== 'boolean' || typeof record.commandCompleted !== 'boolean') throw new TypeError('receipt command status malformed');
  if (record.commandCompleted && !record.commandStarted) throw new TypeError('receipt command completion contradicts start status');
  if (record.commandCompleted) validateCommandOutcome(record.commandOutcome, 'receipt.commandOutcome');
  if (!record.commandCompleted && record.commandOutcome !== undefined) throw new TypeError('receipt command outcome without completion');
  if (!sameIdentity(receiptNode, expected.nodeIdentity)) throw new TypeError('receipt parent identity mismatch');
  if (supervisorIdentity && !sameIdentity(receiptSupervisor, supervisorIdentity)) throw new TypeError('receipt supervisor identity mismatch');
  const cleanupOk = cleanup.outcome === 'ok' || (!record.commandStarted && !record.commandCompleted && cleanup.outcome === 'not_needed');
  if (!cleanupOk) throw new TypeError('receipt cleanup is not settled ok/not_needed');
  return record as unknown as DurableCheckReceipt;
}

function isBlockedReceipt(value: unknown): value is DurableCheckReceiptBlocked {
  return !!value && typeof value === 'object' && (value as DurableCheckReceiptBlocked).blocked === true;
}

function isDurableReceipt(value: unknown): value is DurableCheckReceipt {
  return !!value && typeof value === 'object' && (value as DurableCheckReceipt).launchPhase === 'receipt-written';
}

/** Read-only receipt inspection is fail-closed: it never spawns, mkdirs, cleans up, or throws; unsafe/mismatched evidence returns a bounded blocked error. */
export function inspectDurableCheckReceipt(config: DurableCheckReceiptConfig & { profileHash: string; expectedCandidateHash: string; candidateHashBefore: string; nodeIdentity: DurableCheckProcessIdentity; supervisorIdentity?: DurableCheckProcessIdentity }): DurableCheckReceipt | DurableCheckReceiptBlocked | undefined {
  let fd: number | undefined;
  try {
    const loc = verifyReceiptLocation(config);
    const expected = { version: 1 as const, launchPhase: 'intent' as const, generation: config.generation, nonce: loc.nonce, candidateId: config.candidateId, profileId: config.profileId, profileHash: config.profileHash, expectedCandidateHash: config.expectedCandidateHash, candidateHashBefore: config.candidateHashBefore, nodeIdentity: config.nodeIdentity, receiptDir: loc.dir, markerPath: loc.markerPath, receiptPath: loc.receiptPath };
    assertTrustedAncestry(loc.receiptPath);
    fd = openSync(loc.receiptPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    assertCurrentRegularIdentity(loc.receiptPath, fd, 'durable receipt');
    const before = fstatSync(fd);
    const text = readFdBoundedUtf8(fd, MAX_DURABLE_JSON_BYTES, 'durable receipt');
    const after = fstatSync(fd);
    const cur = lstatSync(loc.receiptPath);
    assertStableFileStat(before, after, cur, 'durable receipt');
    return validateReceipt(JSON.parse(text), expected, config.supervisorIdentity);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    return boundedError(error);
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* inspection is already fail-closed above */ } }
  }
}

function parseSupervisorProtocol(protocolText: string, protocolBytes: number): SupervisorReport | undefined {
  const rawLines = protocolText.split('\n');
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') rawLines.pop();
  const lines = rawLines.map((line) => line.trim()).filter(Boolean);
  if (lines.length < 1 || lines.length > 2) return undefined;
  let reportLine: string;
  let readyBytes = 0;
  let firstIsReady = lines[0] === SUPERVISOR_READY_LINE;
  if (!firstIsReady) {
    try { firstIsReady = JSON.parse(lines[0])?.supervisorReady === true; } catch { firstIsReady = false; }
  }
  if (firstIsReady) {
    if (lines.length !== 2) return undefined;
    reportLine = lines[1];
    readyBytes = Buffer.byteLength(lines[0] + '\n');
  } else {
    if (lines.length !== 1) return undefined;
    reportLine = lines[0];
  }
  const reportBytes = protocolBytes - readyBytes;
  if (reportBytes > MAX_PROTOCOL_BYTES) return undefined;
  try {
    const message = JSON.parse(reportLine) as SupervisorReport & { supervisorReady?: boolean };
    if (message && typeof message === 'object' && message.supervisorReady !== true) return validateSupervisorReport(message);
  } catch {
    return undefined;
  }
  return undefined;
}

function emptyResult(args: { reason: string; outcome?: 'failed' | 'uncertain'; profileHashValue: string; before: string; after?: string; expected: string; startedAt?: string; cancelled?: boolean; timedOut?: boolean; cleanup?: CodingCheckResult['cleanup']; stderr?: string }): CodingCheckResult {
  const now = new Date().toISOString();
  return {
    passed: false,
    outcome: args.outcome ?? 'failed',
    reason: args.reason,
    profileHash: args.profileHashValue,
    candidateHashBefore: args.before,
    candidateHashAfter: args.after ?? args.before,
    expectedCandidateHash: args.expected,
    exitCode: null,
    signal: null,
    timedOut: args.timedOut ?? false,
    cancelled: args.cancelled ?? false,
    stdout: '',
    stderr: args.stderr ?? '',
    stdoutTruncated: false,
    stderrTruncated: false,
    stdoutDroppedBytes: 0,
    stderrDroppedBytes: 0,
    startedAt: args.startedAt ?? now,
    finishedAt: now,
    launchPhase: 'preflight',
    cleanup: args.cleanup ?? { attempted: false, outcome: 'not_needed' },
  };
}


function durableAdmissionFailure(args: RunCodingCheckArgs, intent: DurableCheckIntent, expectedLocation: { dir: string; markerPath: string; receiptPath: string; nonce: string }, nodeIdentity: DurableCheckProcessIdentity, candidateBefore: string): string {
  try {
    args.assertAuthority();
    if (args.signal?.aborted) return 'check aborted before durable command admission';
    const candidateNow = sha256(args.captureCandidate());
    if (candidateNow !== args.expectedCandidateHash || candidateNow !== candidateBefore) return 'candidate hash changed before durable command admission';
    if (!args.durable) return 'durable context missing before command admission';
    if (args.durable.generation !== intent.generation || args.durable.candidateId !== intent.candidateId || args.durable.profileId !== intent.profileId) return 'durable ownership tuple changed before command admission';
    const current = verifyReceiptLocation(args.durable);
    if (current.dir !== expectedLocation.dir || current.markerPath !== expectedLocation.markerPath || current.receiptPath !== expectedLocation.receiptPath || current.nonce !== expectedLocation.nonce) return 'durable receipt generation changed before command admission';
    if (!sameIdentity(nodeIdentity, intent.nodeIdentity)) return 'durable node ownership identity changed before command admission';
    return '';
  } catch (error) {
    return `durable command admission authority failed before effect: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function noEffectAdmissionResult(args: { reason: string; profileHashValue: string; before: string; expected: string; startedAt: string; cancelled?: boolean; cleanup?: CodingCheckResult['cleanup']; stderr?: string }): CodingCheckResult {
  return emptyResult({ reason: args.reason, outcome: 'uncertain', profileHashValue: args.profileHashValue, before: args.before, after: args.before, expected: args.expected, startedAt: args.startedAt, cancelled: args.cancelled, cleanup: args.cleanup ?? { attempted: false, outcome: 'not_needed' }, stderr: args.stderr });
}

/**
 * Runs a trusted host-selected check process without shell interpolation and with no ambient env inheritance.
 * This is not a filesystem, network, kernel, or hostile-code sandbox. On Linux, cleanup relies on a
 * subreaper supervisor plus pidfd-verified child signalling; unsupported or ambiguous cleanup is uncertain.
 */
export async function runCodingCheck(args: RunCodingCheckArgs): Promise<CodingCheckResult> {
  const validated = validateCheckProfile(args.profile);
  args.assertAuthority();
  const ph = profileHash(validated);
  args.assertAuthority();
  const cwd = ensureStageCwd(args.stageRoot, validated.cwd);
  args.assertAuthority();
  const candidateBefore = sha256(args.captureCandidate());
  if (candidateBefore !== args.expectedCandidateHash) {
    return emptyResult({ reason: 'candidate hash before check does not match expected candidate hash', profileHashValue: ph, before: candidateBefore, expected: args.expectedCandidateHash });
  }
  if (args.signal?.aborted) {
    return emptyResult({ reason: 'check aborted before spawn', outcome: 'uncertain', profileHashValue: ph, before: candidateBefore, expected: args.expectedCandidateHash, cancelled: true, cleanup: { attempted: false, outcome: 'not_needed' } });
  }
  args.assertAuthority();
  const startedAt = new Date().toISOString();
  const nodeIdentity = args.durable ? currentNodeIdentity() : undefined;
  let durableIntent: DurableCheckIntent | undefined;
  let durableLocation: { dir: string; markerPath: string; receiptPath: string; nonce: string } | undefined;
  if (args.durable && nodeIdentity) {
    durableLocation = verifyReceiptLocation(args.durable);
    durableIntent = {
      version: 1, launchPhase: 'intent', generation: args.durable.generation, nonce: durableLocation.nonce, candidateId: args.durable.candidateId, profileId: args.durable.profileId,
      receiptDir: durableLocation.dir, markerPath: durableLocation.markerPath, profileHash: ph, expectedCandidateHash: args.expectedCandidateHash, candidateHashBefore: candidateBefore, nodeIdentity,
    };
    args.durable.onIntent(durableIntent);
    const admissionFailure = durableAdmissionFailure(args, durableIntent, durableLocation, nodeIdentity, candidateBefore);
    if (admissionFailure) {
      return noEffectAdmissionResult({ reason: admissionFailure, profileHashValue: ph, before: candidateBefore, expected: args.expectedCandidateHash, startedAt, cancelled: args.signal?.aborted, stderr: admissionFailure });
    }
  }
  let python: string;
  try {
    python = validateSupervisorRuntime();
  } catch (error) {
    const after = sha256(args.captureCandidate());
    return emptyResult({ reason: 'check supervisor unsupported', outcome: 'uncertain', profileHashValue: ph, before: candidateBefore, after, expected: args.expectedCandidateHash, stderr: error instanceof Error ? error.message : String(error), startedAt, cleanup: { attempted: false, outcome: 'uncertain', error: error instanceof Error ? error.message : String(error) } });
  }
  const protocolState = { chunks: [] as Buffer[], kept: 0, dropped: 0 };
  const supervisorStdout = { chunks: [] as Buffer[], kept: 0, dropped: 0 };
  const supervisorStderr = { chunks: [] as Buffer[], kept: 0, dropped: 0 };
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(python, ['-I', '-S', supervisorPath()], {
      cwd,
      env: {},
      shell: false,
      detached: false,
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (error) {
    const after = sha256(args.captureCandidate());
    return emptyResult({ reason: 'supervisor spawn failed', outcome: 'uncertain', profileHashValue: ph, before: candidateBefore, after, expected: args.expectedCandidateHash, stderr: error instanceof Error ? error.message : String(error), startedAt, cleanup: { attempted: false, outcome: 'uncertain', error: error instanceof Error ? error.message : String(error) } });
  }
  const closed = waitForClose(child);
  let spawnErrorMessage = '';
  child.stdin?.on('error', (error) => { spawnErrorMessage ||= error.message; });
  child.stdout?.on('data', (chunk: Buffer) => appendBounded(supervisorStdout, chunk, MAX_OUTPUT_BYTES));
  child.stderr?.on('data', (chunk: Buffer) => appendBounded(supervisorStderr, chunk, MAX_OUTPUT_BYTES));
  let cancelled = false;
  let supervisorReady = false;
  let supervisorIdentity: DurableCheckProcessIdentity | undefined;
  let abortPendingReady = false;
  let readyPrefix = '';
  let readyPrefixDone = false;
  let resolveReady: (() => void) | undefined;
  const readyPromise = new Promise<void>((resolve) => { resolveReady = resolve; });
  const requestSupervisorCancel = () => {
    cancelled = true;
    if (!supervisorReady) {
      abortPendingReady = true;
      return;
    }
    try { child.kill('SIGUSR1'); } catch { try { child.kill('SIGTERM'); } catch { /* fallback below */ } }
  };
  const observeProtocolReadiness = (chunk: Buffer) => {
    if (readyPrefixDone || supervisorReady) return;
    for (const byte of chunk) {
      if (byte === 10) {
        readyPrefixDone = true;
        const line = readyPrefix.trim();
        try {
          const ready = JSON.parse(line) as { supervisorReady?: boolean; nonce?: string; supervisorIdentity?: DurableCheckProcessIdentity; nodeIdentity?: DurableCheckProcessIdentity };
          if (ready?.supervisorReady === true) {
            if (!durableIntent) {
              supervisorReady = line === SUPERVISOR_READY_LINE;
            } else if (ready.nonce === durableIntent.nonce && sameIdentity(ready.nodeIdentity, durableIntent.nodeIdentity)) {
              const claimed = validateIdentity(ready.supervisorIdentity, 'supervisor.ready.supervisorIdentity');
              if (child.pid !== undefined && sameIdentity(claimed, processIdentityForPid(child.pid))) {
                supervisorReady = true;
                supervisorIdentity = claimed;
              }
            }
            if (supervisorReady) {
              resolveReady?.();
              if (abortPendingReady) requestSupervisorCancel();
            }
          }
        } catch { /* malformed ready is handled as protocol failure */ }
        return;
      }
      if (readyPrefix.length <= 4096) readyPrefix += String.fromCharCode(byte);
      if (readyPrefix.length > 4096) {
        readyPrefixDone = true;
        return;
      }
    }
  };
  const protocol = child.stdio[3];
  if (protocol && 'on' in protocol) {
    protocol.on('data', (chunk: Buffer) => {
      appendBounded(protocolState, chunk, MAX_PROTOCOL_WITH_READY_BYTES);
      observeProtocolReadiness(chunk);
    });
  }
  child.once('error', (error) => { spawnErrorMessage = error.message; });
  let abortListener: (() => void) | undefined;
  if (args.signal) {
    abortListener = requestSupervisorCancel;
    args.signal.addEventListener('abort', abortListener, { once: true });
    if (args.signal.aborted) requestSupervisorCancel();
  }
  const launchConfig = { executable: validated.executable, argv: validated.argv, cwd, env: validated.env, timeoutMs: validated.timeoutMs, outputBytes: validated.outputBytes };
  let durableLaunchAckSent = false;
  if (durableIntent && durableLocation && nodeIdentity) {
    child.stdin?.write(JSON.stringify({ ...launchConfig, durable: { generation: durableIntent.generation, nonce: durableIntent.nonce, candidateId: durableIntent.candidateId, profileId: durableIntent.profileId, profileHash: ph, expectedCandidateHash: args.expectedCandidateHash, candidateHashBefore: candidateBefore, receiptDir: durableLocation.dir, markerPath: durableLocation.markerPath, receiptPath: durableLocation.receiptPath, nodeIdentity } }) + '\n');
    let readyTimeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([readyPromise, closed.then(() => {}), new Promise<void>((resolve) => { readyTimeout = setTimeout(resolve, Math.min(1000, validated.timeoutMs)); })]);
    } finally { if (readyTimeout) clearTimeout(readyTimeout); }
    if (supervisorReady && supervisorIdentity && child.exitCode === null && child.signalCode === null) {
      const ready: DurableCheckSupervisorReady = { version: 1, launchPhase: 'supervisor-ready', nonce: durableIntent.nonce, supervisorIdentity, nodeIdentity };
      try {
        args.durable?.onSupervisorReady?.(ready);
        const admissionFailure = durableAdmissionFailure(args, durableIntent, durableLocation, nodeIdentity, candidateBefore);
        if (admissionFailure) {
          child.stdin?.end();
          spawnErrorMessage = admissionFailure;
        } else {
          child.stdin?.write(JSON.stringify({ launch: true, nonce: durableIntent.nonce, nodeIdentity }) + '\n');
          durableLaunchAckSent = true;
        }
      } catch (error) {
        child.stdin?.end();
        spawnErrorMessage = `durable supervisor ready persistence failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    } else {
      child.stdin?.end();
      spawnErrorMessage = 'durable supervisor ready identity missing or mismatched';
    }
  } else {
    child.stdin?.end(JSON.stringify(launchConfig));
  }
  let hardExpired = false;
  const hardTimeout = setTimeout(() => {
    hardExpired = true;
    try { child.kill('SIGKILL'); } catch { /* hard fallback reported below */ }
  }, validated.timeoutMs + SUPERVISOR_HARD_EXTRA_MS);
  let close: { code: number | null; signal: NodeJS.Signals | string | null };
  try {
    close = await closed;
  } finally {
    clearTimeout(hardTimeout);
    if (abortListener) args.signal?.removeEventListener('abort', abortListener);
  }
  let postEffectAuthorityError = '';
  try { args.assertAuthority(); } catch (error) { if (!args.durable) throw error; postEffectAuthorityError = `authority failed after possible check effect: ${error instanceof Error ? error.message : String(error)}`; }
  const candidateAfter = sha256(args.captureCandidate());
  try { args.assertAuthority(); } catch (error) { if (!args.durable) throw error; postEffectAuthorityError ||= `authority failed after possible check effect: ${error instanceof Error ? error.message : String(error)}`; }
  const protocolText = Buffer.concat(protocolState.chunks).toString('utf8');
  const report = parseSupervisorProtocol(protocolText, protocolState.kept);
  const supervisorNoise = [Buffer.concat(supervisorStdout.chunks).toString('utf8'), Buffer.concat(supervisorStderr.chunks).toString('utf8')].filter(Boolean).join('\n');
  const candidateChanged = candidateAfter !== args.expectedCandidateHash;
  const protocolTruncated = protocolState.dropped > 0;
  const supervisorReportedErrors = (report?.errors?.length ?? 0) > 0 || (report?.errorsDropped ?? 0) > 0;
  let receipt: DurableCheckReceipt | undefined;
  let receiptError = '';
  if (durableIntent && durableLocation && nodeIdentity) {
    const inspected = inspectDurableCheckReceipt({ receiptDir: durableLocation.dir, markerPath: durableLocation.markerPath, generation: durableIntent.generation, nonce: durableIntent.nonce, candidateId: durableIntent.candidateId, profileId: durableIntent.profileId, profileHash: ph, expectedCandidateHash: args.expectedCandidateHash, candidateHashBefore: candidateBefore, nodeIdentity, supervisorIdentity });
    if (isDurableReceipt(inspected)) {
      receipt = inspected;
      try { args.durable?.onReceipt(receipt); } catch (error) { receiptError = `durable receipt persistence failed after effect: ${error instanceof Error ? error.message : String(error)}`; }
    } else if (isBlockedReceipt(inspected)) {
      receiptError = `durable receipt blocked: ${inspected.error}`;
    } else {
      receiptError = 'durable receipt missing, malformed, mismatched, or cleanup not settled';
    }
  }
  const supervisorFailed = !report?.supervisorOk || hardExpired || close.code !== 0 || spawnErrorMessage !== '' || protocolTruncated || supervisorReportedErrors || receiptError !== '' || postEffectAuthorityError !== '';
  const cleanup = report?.cleanup ?? { attempted: false, outcome: 'uncertain' as const, error: 'missing supervisor cleanup report' };
  let outcome: CodingCheckResult['outcome'] = 'passed';
  let reason = 'check passed';
  if (supervisorFailed) {
    outcome = 'uncertain'; reason = 'check supervisor failed';
  } else if (cleanup.outcome === 'uncertain' || cleanup.outcome === 'failed') {
    outcome = 'uncertain'; reason = 'process cleanup uncertain';
  } else if (report!.timedOut) {
    outcome = 'failed'; reason = 'check timed out';
  } else if (cancelled || report!.cancelled) {
    outcome = 'uncertain'; reason = 'check cancelled';
  } else if (candidateChanged) {
    outcome = 'failed'; reason = 'candidate hash after check does not match expected candidate hash';
  } else if (report!.exitCode !== 0) {
    outcome = 'failed'; reason = 'check exited non-zero';
  }
  const errors = [spawnErrorMessage, receiptError, postEffectAuthorityError, ...(report?.errors ?? []), report?.errorsDropped ? `supervisor dropped ${report.errorsDropped} diagnostics` : '', supervisorNoise, protocolTruncated ? `supervisor protocol truncated by ${protocolState.dropped} bytes` : ''].filter(Boolean).join('\n');
  return {
    passed: outcome === 'passed',
    outcome,
    reason,
    profileHash: ph,
    candidateHashBefore: candidateBefore,
    candidateHashAfter: candidateAfter,
    expectedCandidateHash: args.expectedCandidateHash,
    exitCode: report?.exitCode ?? null,
    signal: report?.signal == null ? null : String(report.signal),
    timedOut: report?.timedOut ?? false,
    cancelled: cancelled || (report?.cancelled ?? false),
    stdout: report?.stdout ?? '',
    stderr: [report?.stderr ?? '', errors].filter(Boolean).join('\n'),
    stdoutTruncated: report?.stdoutTruncated ?? false,
    stderrTruncated: report?.stderrTruncated ?? false,
    stdoutDroppedBytes: report?.stdoutDroppedBytes ?? 0,
    stderrDroppedBytes: report?.stderrDroppedBytes ?? 0,
    startedAt,
    finishedAt: new Date().toISOString(),
    launchPhase: durableIntent ? (receipt ? 'settled' : (durableLaunchAckSent ? 'child-launched' : (supervisorReady ? 'supervisor-ready' : 'supervisor-spawned'))) : 'settled',
    durableReceipt: receipt,
    cleanup,
  };
}
