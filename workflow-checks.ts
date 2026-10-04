import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
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
}

const PROFILE_KEYS = new Set(['id', 'executable', 'argv', 'cwd', 'env', 'timeoutMs', 'outputBytes', 'generatedOutputs']);
const MAX_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 65_536;
const MAX_PROTOCOL_BYTES = 1024 * 1024;
const SUPERVISOR_READY_LINE = '{"supervisorReady":true}';
const MAX_PROTOCOL_WITH_READY_BYTES = MAX_PROTOCOL_BYTES + Buffer.byteLength(SUPERVISOR_READY_LINE + '\n');
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

function parseSupervisorProtocol(protocolText: string, protocolBytes: number): SupervisorReport | undefined {
  const rawLines = protocolText.split('\n');
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') rawLines.pop();
  const lines = rawLines.map((line) => line.trim()).filter(Boolean);
  if (lines.length < 1 || lines.length > 2) return undefined;
  let reportLine: string;
  if (lines[0] === SUPERVISOR_READY_LINE) {
    if (lines.length !== 2) return undefined;
    reportLine = lines[1];
  } else {
    if (lines.length !== 1) return undefined;
    reportLine = lines[0];
  }
  const reportBytes = protocolBytes - (lines[0] === SUPERVISOR_READY_LINE ? Buffer.byteLength(SUPERVISOR_READY_LINE + '\n') : 0);
  if (reportBytes > MAX_PROTOCOL_BYTES) return undefined;
  try {
    const message = JSON.parse(reportLine) as SupervisorReport & { supervisorReady?: boolean };
    if (message && typeof message === 'object' && message.supervisorReady !== true) return message;
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
    cleanup: args.cleanup ?? { attempted: false, outcome: 'not_needed' },
  };
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
  let spawnErrorMessage = '';
  child.stdout?.on('data', (chunk: Buffer) => appendBounded(supervisorStdout, chunk, MAX_OUTPUT_BYTES));
  child.stderr?.on('data', (chunk: Buffer) => appendBounded(supervisorStderr, chunk, MAX_OUTPUT_BYTES));
  let cancelled = false;
  let supervisorReady = false;
  let abortPendingReady = false;
  let readyPrefix = '';
  let readyPrefixDone = false;
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
        if (readyPrefix.trim() === SUPERVISOR_READY_LINE) {
          supervisorReady = true;
          if (abortPendingReady) requestSupervisorCancel();
        }
        return;
      }
      if (readyPrefix.length <= SUPERVISOR_READY_LINE.length) readyPrefix += String.fromCharCode(byte);
      if (readyPrefix.length > SUPERVISOR_READY_LINE.length) {
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
  child.stdin?.end(JSON.stringify({ executable: validated.executable, argv: validated.argv, cwd, env: validated.env, timeoutMs: validated.timeoutMs, outputBytes: validated.outputBytes }));
  let hardExpired = false;
  const hardTimeout = setTimeout(() => {
    hardExpired = true;
    try { child.kill('SIGKILL'); } catch { /* hard fallback reported below */ }
  }, validated.timeoutMs + SUPERVISOR_HARD_EXTRA_MS);
  let close: { code: number | null; signal: NodeJS.Signals | string | null };
  try {
    close = await waitForClose(child);
  } finally {
    clearTimeout(hardTimeout);
    if (abortListener) args.signal?.removeEventListener('abort', abortListener);
  }
  args.assertAuthority();
  const candidateAfter = sha256(args.captureCandidate());
  args.assertAuthority();
  const protocolText = Buffer.concat(protocolState.chunks).toString('utf8');
  const report = parseSupervisorProtocol(protocolText, protocolState.kept);
  const supervisorNoise = [Buffer.concat(supervisorStdout.chunks).toString('utf8'), Buffer.concat(supervisorStderr.chunks).toString('utf8')].filter(Boolean).join('\n');
  const candidateChanged = candidateAfter !== args.expectedCandidateHash;
  const protocolTruncated = protocolState.dropped > 0;
  const supervisorReportedErrors = (report?.errors?.length ?? 0) > 0 || (report?.errorsDropped ?? 0) > 0;
  const supervisorFailed = !report?.supervisorOk || hardExpired || close.code !== 0 || spawnErrorMessage !== '' || protocolTruncated || supervisorReportedErrors;
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
  const errors = [spawnErrorMessage, ...(report?.errors ?? []), report?.errorsDropped ? `supervisor dropped ${report.errorsDropped} diagnostics` : '', supervisorNoise, protocolTruncated ? `supervisor protocol truncated by ${protocolState.dropped} bytes` : ''].filter(Boolean).join('\n');
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
    cleanup,
  };
}
