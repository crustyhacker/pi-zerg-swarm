import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readSync, renameSync, rmSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export type CodingWorkspaceLimits = {
  maxFiles?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  maxPreviewBytes?: number;
};

export type CodingBaselineEntry = { path: string; abs: string; exists: boolean; parentPaths: string[]; parentChain: Identity[]; bytes?: number; sha256?: string; text?: string; mode?: number; file?: Identity };
export type CodingBaselineManifest = { projectRoot: string; projectRootIdentity: Identity; inputPaths: string[]; writablePaths: string[]; entries: CodingBaselineEntry[]; totalBytes: number; hash: string; clipped: boolean };
export type CaptureCodingBaselineOptions = { projectRoot: string; inputPaths: string[]; writablePaths: string[]; limits?: CodingWorkspaceLimits };

export type CreateCodingWorkspaceOptions = {
  workflowRunId: string;
  projectRoot: string;
  stagingParent: string;
  inputPaths: string[];
  writablePaths: string[];
  assertAuthority: () => void;
  limits?: CodingWorkspaceLimits;
  reviewedBaseline?: CodingBaselineManifest;
};

export type WorkspaceCandidate = {
  hash: string;
  changedPaths: string[];
  files: Array<{ path: string; before: Buffer | null; after: Buffer | null; beforeHash: string | null; afterHash: string | null; preview: string; clippedBytes: number }>;
  totalBytes: number;
  clippedBytes: number;
};

export type ApplyOutcome = { status: 'applied' | 'partial' | 'rejected'; appliedPaths: string[]; error?: string };

export type CodingWorkspace = {
  readonly stageRoot: string;
  read(path: string): string;
  write(path: string, text: string): void;
  inspect(): WorkspaceCandidate;
  assertFreshDestination(): void;
  apply(candidateHash: string): ApplyOutcome;
  cleanup(): void;
  settle(): void;
};

type Identity = { dev: number; ino: number; mode: number; uid: number; gid: number; size?: number; mtimeMs?: number; hash?: string };
type Baseline = { path: string; abs: string; exists: boolean; parentPaths: string[]; parentChain: Identity[]; bytes?: Buffer; mode?: number; file?: Identity };
type StageAuthority = { root: Identity; marker: Identity; dirs: Map<string, Identity>; files: Map<string, Identity> };

const DEFAULT_LIMITS = { maxFiles: 32, maxFileBytes: 256 * 1024, maxTotalBytes: 1024 * 1024, maxPreviewBytes: 4096 };
const TEXT_DECODER = new TextDecoder('utf-8', { fatal: true });
const TEXT_ENCODER = new TextEncoder();
const PROTECTED = new Set(['.git', '.pi', '.agents', 'config', 'configs', 'credential', 'credentials', 'secrets', 'secret']);
const ownedDestinations = new Map<string, string>();

export function captureCodingBaseline(options: CaptureCodingBaselineOptions): CodingBaselineManifest {
  if (process.platform === 'win32') throw new Error('coding baseline is unsupported on win32 path semantics');
  const limits = validateLimits(options.limits);
  const projectRoot = resolveExistingDirectory(options.projectRoot, 'projectRoot');
  assertNoSymlinkComponents(projectRoot);
  const inputs = unique(options.inputPaths.map(validateRelPath));
  const writables = unique(options.writablePaths.map(validateRelPath));
  const manifested = unique([...inputs, ...writables]);
  if (manifested.length > limits.maxFiles) throw new Error('too many manifested files');
  const entries: CodingBaselineEntry[] = [];
  let totalBytes = 0;
  for (const rel of manifested) {
    const abs = safeProjectAbs(projectRoot, rel);
    assertSafeExistingDirectory(dirname(abs), `baseline parent for ${rel}`);
    if (existsNoFollow(abs)) {
      assertSafeExistingFile(abs, rel);
      const bytes = readFileBounded(abs, limits.maxFileBytes, `baseline input too large: ${rel}`);
      totalBytes += bytes.length;
      if (totalBytes > limits.maxTotalBytes) throw new Error('baseline manifest total too large');
      decodeUtf8(bytes, `baseline input is not utf8 text: ${rel}`);
      const b = baselineFor(projectRoot, rel, bytes);
      entries.push({ path: rel, abs: b.abs, exists: true, parentPaths: b.parentPaths, parentChain: b.parentChain, bytes: bytes.length, sha256: hashBytes(bytes), text: bytes.toString('utf8'), mode: b.mode, file: b.file });
    } else {
      if (inputs.includes(rel) && !writables.includes(rel)) throw new Error(`input does not exist: ${rel}`);
      const b = baselineForMissing(projectRoot, rel);
      entries.push({ path: rel, abs: b.abs, exists: false, parentPaths: b.parentPaths, parentChain: b.parentChain });
    }
  }
  const rootSt = checkedLstat(projectRoot, 'projectRoot');
  const comparable = { projectRoot, projectRootIdentity: directoryIdentity(rootSt), inputPaths: inputs, writablePaths: writables, entries, totalBytes, clipped: false };
  return Object.freeze({ ...comparable, hash: hash(JSON.stringify(comparable)) });
}

export function createCodingWorkspace(options: CreateCodingWorkspaceOptions): CodingWorkspace {
  if (process.platform === 'win32') throw new Error('coding workspace is unsupported on win32 path semantics');
  const limits = validateLimits(options.limits);
  if (!options.workflowRunId || /[\0/\\]/.test(options.workflowRunId) || options.workflowRunId.length > 80) throw new Error('invalid workflowRunId');
  const projectRoot = resolveExistingDirectory(options.projectRoot, 'projectRoot');
  assertNoSymlinkComponents(projectRoot);
  const stagingParent = resolveExistingDirectory(options.stagingParent, 'stagingParent');
  assertNoSymlinkComponents(stagingParent);
  if (!isAbsolute(stagingParent)) throw new Error('stagingParent must be absolute');
  const inputs = unique(options.inputPaths.map(validateRelPath));
  const writables = unique(options.writablePaths.map(validateRelPath));
  const manifested = unique([...inputs, ...writables]);
  if (manifested.length > limits.maxFiles) throw new Error('too many manifested files');
  const writableSet = new Set(writables);
  const inputSet = new Set(inputs);
  if (options.reviewedBaseline) {
    const fresh = captureCodingBaseline({ projectRoot, inputPaths: inputs, writablePaths: writables, limits });
    if (fresh.hash !== options.reviewedBaseline.hash) throw new Error('reviewed coding baseline changed before workspace creation');
  }
  const owner = `${options.workflowRunId}:${process.pid}:${randomUUID()}`;
  const expectedDirs = expectedStageDirs(manifested);
  const expectedFiles = new Set<string>();

  const leaseRoot = ensureLeaseRoot();
  const leases: string[] = [];
  const ownedKeys: string[] = [];
  const baselines = new Map<string, Baseline>();
  let stageRoot = '';
  let marker = '';
  let authority: StageAuthority | undefined;
  let applyAttempted = false;

  try {
    options.assertAuthority();
    for (const rel of writables) acquireLease(leaseRoot, projectRoot, rel, owner, leases, ownedKeys);

    stageRoot = mkdtempSync(join(stagingParent, `coding-${options.workflowRunId}-`));
    chmodSync(stageRoot, 0o700);
    const rootSt = checkedLstat(stageRoot, 'stageRoot');
    if (!rootSt.isDirectory() || rootSt.isSymbolicLink()) throw new Error('stageRoot is not a private directory');
    marker = join(stageRoot, '.coding-workspace-owner.json');
    writeFileSync(marker, JSON.stringify({ owner, projectRoot, createdAt: new Date().toISOString() }), { mode: 0o600, flag: 'wx' });
    const markerSt = checkedLstat(marker, 'workspace marker');
    if (!markerSt.isFile() || markerSt.isSymbolicLink() || markerSt.size > 4096) throw new Error('workspace marker invalid');
    authority = { root: identity(rootSt), marker: identity(markerSt), dirs: new Map([['', identity(rootSt)]]), files: new Map() };

    let total = 0;
    for (const rel of manifested) {
      const abs = safeProjectAbs(projectRoot, rel);
      const parent = dirname(abs);
      assertSafeExistingDirectory(parent, `writable parent for ${rel}`);
      if (existsNoFollow(abs)) {
        assertSafeExistingFile(abs, rel);
        const bytes = readFileBounded(abs, limits.maxFileBytes, `input too large: ${rel}`);
        total += bytes.length;
        if (total > limits.maxTotalBytes) throw new Error('manifest total too large');
        decodeUtf8(bytes, `${inputSet.has(rel) ? 'input' : 'writable'} is not utf8 text: ${rel}`);
        const st = checkedLstat(abs, rel);
        if ((st.mode & 0o111) !== 0) throw new Error(`executable input rejected: ${rel}`);
        baselines.set(rel, baselineFor(projectRoot, rel, bytes));
        if (inputSet.has(rel) || writableSet.has(rel)) {
          writeStageFile(stageRoot, rel, bytes, writableSet.has(rel), expectedDirs, authority);
          expectedFiles.add(rel);
        }
      } else {
        if (inputSet.has(rel) && !writableSet.has(rel)) throw new Error(`input does not exist: ${rel}`);
        baselines.set(rel, baselineForMissing(projectRoot, rel));
      }
    }
  } catch (error) {
    try { if (stageRoot && marker && authority) cleanupArtifacts(stageRoot, marker, owner, authority, leases, ownedKeys); } catch {}
    releaseLeases(leases, ownedKeys);
    throw error;
  }

  let cleaned = false;
  let activeWorkspace = true;
  let leasesReleased = false;

  function assertOwnedRetained() {
    if (cleaned) throw new Error('workspace has been cleaned up');
    if (!authority) throw new Error('workspace initialization incomplete');
    assertOwnedStage(stageRoot, marker, owner, authority);
  }
  function assertActive() {
    assertOwnedRetained();
    if (!activeWorkspace) throw new Error('workspace has been settled');
  }

  function inspect(): WorkspaceCandidate {
    assertOwnedRetained();
    inventoryStage(stageRoot, authority!, expectedDirs, expectedFiles, inputSet, writableSet, limits);
    verifyReadonlyInputs(stageRoot, baselines, inputSet, writableSet, limits);
    const files: WorkspaceCandidate['files'] = [];
    let totalManifestedBytes = 0;
    for (const rel of inputs) if (!writableSet.has(rel)) totalManifestedBytes += baselines.get(rel)?.bytes?.length ?? 0;
    if (totalManifestedBytes > limits.maxTotalBytes) throw new Error('candidate total too large');
    for (const rel of writables) {
      const baseline = baselines.get(rel)!;
      const abs = join(stageRoot, rel);
      const exists = existsNoFollow(abs);
      if (exists) assertStageFile(abs, rel);
      if (!exists && baseline.exists) throw new Error(`candidate deletion unsupported: ${rel}`);
      const after = exists ? readFileBounded(abs, limits.maxFileBytes, `candidate file too large: ${rel}`) : null;
      if (after) decodeUtf8(after, `candidate is not utf8 text: ${rel}`);
      const before = baseline.exists ? Buffer.from(baseline.bytes!) : null;
      totalManifestedBytes += after?.length ?? 0;
      if (totalManifestedBytes > limits.maxTotalBytes) throw new Error('candidate total too large');
      if (!bufEqual(before, after)) {
        if (!exists && !baseline.exists) continue;
        const previewBytes = after ?? Buffer.alloc(0);
        const clipped = Math.max(0, previewBytes.length - limits.maxPreviewBytes);
        files.push({ path: rel, before: before ? Buffer.from(before) : null, after: after ? Buffer.from(after) : null, beforeHash: before ? hashBytes(before) : null, afterHash: after ? hashBytes(after) : null, preview: previewBytes.subarray(0, limits.maxPreviewBytes).toString('utf8'), clippedBytes: clipped });
      }
    }
    if (files.length > limits.maxFiles) throw new Error('too many candidate files');
    const serial = files.map((f) => ({ path: f.path, beforeHash: f.beforeHash, afterHash: f.afterHash, after: f.after?.toString('base64') ?? null }));
    return { hash: hash(JSON.stringify(serial)), changedPaths: files.map((f) => f.path), files, totalBytes: totalManifestedBytes, clippedBytes: files.reduce((n, f) => n + f.clippedBytes, 0) };
  }

  function assertFreshDestination(): void {
    assertActive();
    for (const rel of writables) assertFreshOne(projectRoot, baselines.get(rel)!, limits);
  }

  function apply(candidateHash: string): ApplyOutcome {
    applyAttempted = true;
    try {
      assertActive();
      options.assertAuthority();
      const candidate = inspect();
      if (candidate.hash !== candidateHash) return { status: 'rejected', appliedPaths: [], error: 'candidate hash mismatch' };
      for (const rel of writables) assertFreshOne(projectRoot, baselines.get(rel)!, limits);
      for (const file of candidate.files) if (file.after === null) return { status: 'rejected', appliedPaths: [], error: `deletion is unsupported: ${file.path}` };
      const appliedPaths: string[] = [];
      for (const file of candidate.files) {
        try {
          options.assertAuthority();
          assertFreshOne(projectRoot, baselines.get(file.path)!, limits);
          writeDestination(projectRoot, file.path, file.after, baselines.get(file.path)!, limits);
          appliedPaths.push(file.path);
        } catch (error) {
          return { status: appliedPaths.length ? 'partial' : 'rejected', appliedPaths, error: message(error) };
        }
      }
      return { status: 'applied', appliedPaths };
    } catch (error) {
      return { status: 'rejected', appliedPaths: [], error: message(error) };
    }
  }

  return {
    get stageRoot() { return stageRoot; },
    read(path: string): string {
      assertActive();
      const rel = validateRelPath(path);
      if (!inputSet.has(rel) && !writableSet.has(rel)) throw new Error(`path not staged: ${rel}`);
      const abs = join(stageRoot, rel);
      assertStageFile(abs, rel);
      return decodeUtf8(readFileBounded(abs, limits.maxFileBytes, `read too large: ${rel}`), `not utf8 text: ${rel}`);
    },
    write(path: string, text: string): void {
      assertActive();
      options.assertAuthority();
      const rel = validateRelPath(path);
      if (!writableSet.has(rel)) throw new Error(`path is not writable: ${rel}`);
      const bytes = Buffer.from(TEXT_ENCODER.encode(text));
      if (bytes.length > limits.maxFileBytes) throw new Error(`write too large: ${rel}`);
      writeStageFile(stageRoot, rel, bytes, true, expectedDirs, authority!);
      expectedFiles.add(rel);
    },
    inspect,
    assertFreshDestination,
    apply,
    cleanup(): void {
      assertActive();
      if (applyAttempted) throw new Error('cleanup refused after apply attempt; reconcile workspace manually');
      inventoryStage(stageRoot, authority!, expectedDirs, expectedFiles, inputSet, writableSet, limits);
      cleanupArtifacts(stageRoot, marker, owner, authority!, leases, ownedKeys);
      leasesReleased = true;
      cleaned = true;
    },
    settle(): void {
      assertOwnedRetained();
      inventoryStage(stageRoot, authority!, expectedDirs, expectedFiles, inputSet, writableSet, limits);
      if (!leasesReleased) { releaseLeases(leases, ownedKeys); leasesReleased = true; }
      activeWorkspace = false;
    },
  };
}

function validateLimits(l?: CodingWorkspaceLimits): Required<CodingWorkspaceLimits> {
  const merged = { ...DEFAULT_LIMITS, ...(l ?? {}) };
  for (const [k, v] of Object.entries(merged)) if (!Number.isSafeInteger(v) || v <= 0) throw new Error(`invalid workspace limit: ${k}`);
  if (merged.maxFiles > DEFAULT_LIMITS.maxFiles) throw new Error('maxFiles exceeds hard cap');
  if (merged.maxFileBytes > DEFAULT_LIMITS.maxFileBytes) throw new Error('maxFileBytes exceeds hard cap');
  if (merged.maxTotalBytes > DEFAULT_LIMITS.maxTotalBytes) throw new Error('maxTotalBytes exceeds hard cap');
  if (merged.maxPreviewBytes > DEFAULT_LIMITS.maxPreviewBytes) throw new Error('maxPreviewBytes exceeds hard cap');
  return merged;
}
function validateRelPath(p: string): string {
  if (!p || p.includes('\0') || p.includes('\\') || isAbsolute(p)) throw new Error(`invalid relative path: ${p}`);
  const parts = p.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) throw new Error(`ambiguous path: ${p}`);
  if (parts.some((part) => PROTECTED.has(part) || part.startsWith('.'))) throw new Error(`protected path: ${p}`);
  return parts.join('/');
}
function unique<T>(items: T[]): T[] { return [...new Set(items)]; }
function hash(s: string): string { return createHash('sha256').update(s).digest('hex'); }
function hashBytes(b: Buffer): string { return createHash('sha256').update(b).digest('hex'); }
function message(e: unknown): string { return e instanceof Error ? e.message : String(e); }
function decodeUtf8(bytes: Buffer, err: string): string { try { return TEXT_DECODER.decode(bytes); } catch { throw new Error(err); } }
function bufEqual(a: Buffer | null, b: Buffer | null): boolean { return a === b || (!!a && !!b && a.equals(b)); }
function checkedLstat(abs: string, label: string) { try { return lstatSync(abs); } catch { throw new Error(`${label} parent/path does not exist`); } }
function directoryIdentity(st: ReturnType<typeof checkedLstat>): Identity { return { dev: st.dev, ino: st.ino, mode: st.mode, uid: st.uid, gid: st.gid }; }
function identity(st: ReturnType<typeof checkedLstat>): Identity { return { ...directoryIdentity(st), size: st.size, mtimeMs: st.mtimeMs }; }
function sameIdentity(a: Identity, st: ReturnType<typeof checkedLstat>): boolean { return a.dev === st.dev && a.ino === st.ino && a.mode === st.mode && a.uid === st.uid && a.gid === st.gid; }
function resolveExistingDirectory(path: string, name: string): string { const abs = resolve(path); assertSafeExistingDirectory(abs, name); return abs; }
function safeProjectAbs(root: string, rel: string): string { const abs = resolve(root, rel); const r = relative(root, abs); if (r.startsWith('..') || isAbsolute(r)) throw new Error(`path escapes project: ${rel}`); return abs; }
function assertSafeExistingDirectory(abs: string, label: string): void { assertNoSymlinkComponents(abs); const st = checkedLstat(abs, label); if (!st.isDirectory()) throw new Error(`${label} is not a directory`); if (st.isSymbolicLink()) throw new Error(`${label} is a symlink`); }
function assertSafeExistingFile(abs: string, rel: string): void { assertNoSymlinkComponents(abs); const st = checkedLstat(abs, rel); if (!st.isFile()) throw new Error(`not a regular file: ${rel}`); if (st.isSymbolicLink()) throw new Error(`symlink file rejected: ${rel}`); if (st.nlink !== 1) throw new Error(`hardlink rejected: ${rel}`); }
function assertStageFile(abs: string, rel: string): void { const st = checkedLstat(abs, rel); if (!st.isFile()) throw new Error(`stage file invalid: ${rel}`); if (st.isSymbolicLink() || st.nlink !== 1 || (st.mode & 0o111) !== 0) throw new Error(`unsafe stage file: ${rel}`); }
function assertNoSymlinkComponents(abs: string): void { let cur = isAbsolute(abs) ? sep : ''; for (const part of abs.split(sep).filter(Boolean)) { cur = join(cur, part); const st = checkedLstat(cur, cur); if (st.isSymbolicLink()) throw new Error(`symlink component rejected: ${abs}`); } }
function existsNoFollow(abs: string): boolean { try { lstatSync(abs); return true; } catch (e: any) { if (e?.code === 'ENOENT') return false; throw e; } }
function readFileBounded(abs: string, max: number, tooLarge: string): Buffer {
  const fd = openSync(abs, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.isSymbolicLink?.() || before.size > max) throw new Error(tooLarge);
    const out = Buffer.alloc(before.size);
    let off = 0;
    while (off < out.length) { const n = readSync(fd, out, off, out.length - off, off); if (n <= 0) break; off += n; }
    const after = fstatSync(fd);
    if (!sameIdentity(identity(before as any), after as any) || after.size !== before.size || off !== out.length) throw new Error(`file changed while reading: ${abs}`);
    return out;
  } finally { closeSync(fd); }
}
function parentPaths(abs: string): string[] { const out: string[] = []; let cur = dirname(abs); while (cur && cur !== dirname(cur)) { out.push(cur); cur = dirname(cur); if (out.length > 128) throw new Error('path too deep'); } return out; }
function parentChain(abs: string): { paths: string[]; ids: Identity[] } { const paths = parentPaths(abs); return { paths, ids: paths.map((p) => directoryIdentity(checkedLstat(p, p))) }; }
function baselineFor(root: string, rel: string, bytes: Buffer): Baseline { const abs = safeProjectAbs(root, rel); const st = checkedLstat(abs, rel); const parents = parentChain(abs); return { path: rel, abs, exists: true, parentPaths: parents.paths, parentChain: parents.ids, bytes: Buffer.from(bytes), mode: st.mode & 0o666, file: { ...identity(st), hash: hashBytes(bytes) } }; }
function baselineForMissing(root: string, rel: string): Baseline { const abs = safeProjectAbs(root, rel); const parents = parentChain(abs); return { path: rel, abs, exists: false, parentPaths: parents.paths, parentChain: parents.ids }; }
function expectedStageDirs(files: string[]): Set<string> { const dirs = new Set(['']); for (const f of files) { let cur = ''; for (const part of f.split('/').slice(0, -1)) { cur = cur ? `${cur}/${part}` : part; dirs.add(cur); } } return dirs; }
function ensureStageDir(root: string, relDir: string, expected: Set<string>, auth: StageAuthority): string {
  if (!expected.has(relDir)) throw new Error(`unexpected stage directory: ${relDir}`);
  let curRel = '';
  let curAbs = root;
  for (const part of relDir.split('/').filter(Boolean)) {
    curRel = curRel ? `${curRel}/${part}` : part;
    curAbs = join(root, curRel);
    if (!existsNoFollow(curAbs)) mkdirSync(curAbs, { mode: 0o700 });
    const st = checkedLstat(curAbs, curRel);
    if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`unsafe stage directory: ${curRel}`);
    const old = auth.dirs.get(curRel);
    if (old && !sameIdentity(old, st)) throw new Error(`stage directory identity changed: ${curRel}`);
    auth.dirs.set(curRel, identity(st));
  }
  return curAbs;
}
function writeStageFile(stageRoot: string, rel: string, bytes: Buffer, mutable: boolean, expectedDirs: Set<string>, auth: StageAuthority): void {
  const parent = ensureStageDir(stageRoot, dirname(rel) === '.' ? '' : dirname(rel), expectedDirs, auth);
  const abs = join(stageRoot, rel);
  if (existsNoFollow(abs)) { assertStageFile(abs, rel); chmodSync(abs, 0o600); }
  const tmp = join(parent, `.${basename(rel)}.${process.pid}.${randomUUID()}.tmp`);
  writeFileSync(tmp, bytes, { flag: 'wx', mode: mutable ? 0o600 : 0o400 });
  renameSync(tmp, abs);
  chmodSync(abs, mutable ? 0o600 : 0o400);
  auth.files.set(rel, identity(checkedLstat(abs, rel)));
}
function inventoryStage(root: string, auth: StageAuthority, expectedDirs: Set<string>, expectedFiles: Set<string>, inputs: Set<string>, writables: Set<string>, limits: Required<CodingWorkspaceLimits>): void {
  const stack = ['']; let count = 0;
  while (stack.length) {
    const rel = stack.pop()!;
    if (!expectedDirs.has(rel)) throw new Error(`unexpected stage directory: ${rel}`);
    const abs = rel ? join(root, rel) : root;
    const st = checkedLstat(abs, rel || 'stageRoot');
    if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`unsafe stage directory: ${rel}`);
    const old = auth.dirs.get(rel); if (!old || !sameIdentity(old, st)) throw new Error(`stage directory identity changed: ${rel || '.'}`);
    const names = readdirSync(abs);
    if (names.length > limits.maxFiles + expectedDirs.size + 2) throw new Error('stage listing too large');
    for (const name of names) {
      if (rel === '' && name === '.coding-workspace-owner.json') continue;
      if (name.startsWith('.')) throw new Error(`unexpected hidden stage entry: ${name}`);
      const childRel = rel ? `${rel}/${name}` : name;
      const childAbs = join(root, childRel);
      const cst = checkedLstat(childAbs, childRel);
      if (cst.isSymbolicLink()) throw new Error(`stage symlink rejected: ${childRel}`);
      if (cst.isDirectory()) { stack.push(childRel); continue; }
      if (!cst.isFile() || cst.nlink !== 1 || (cst.mode & 0o111) !== 0) throw new Error(`unsafe stage entry: ${childRel}`);
      if (!expectedFiles.has(childRel) && !writables.has(childRel)) throw new Error(`unexpected stage file: ${childRel}`);
      if (++count > limits.maxFiles) throw new Error('too many stage files');
    }
  }
}
function verifyReadonlyInputs(root: string, baselines: Map<string, Baseline>, inputs: Set<string>, writables: Set<string>, limits: Required<CodingWorkspaceLimits>): void {
  for (const rel of inputs) if (!writables.has(rel)) {
    const base = baselines.get(rel)!;
    const abs = join(root, rel);
    assertStageFile(abs, rel);
    const st = checkedLstat(abs, rel);
    if ((st.mode & 0o777) !== 0o400) throw new Error(`readonly stage mode changed: ${rel}`);
    const bytes = readFileBounded(abs, limits.maxFileBytes, `readonly stage too large: ${rel}`);
    if (!bytes.equals(base.bytes!)) throw new Error(`readonly stage content changed: ${rel}`);
  }
}
function assertOwnedStage(stageRoot: string, marker: string, owner: string, auth: StageAuthority): void {
  assertSafeExistingDirectory(stageRoot, 'stageRoot');
  const rst = checkedLstat(stageRoot, 'stageRoot'); if (!sameIdentity(auth.root, rst)) throw new Error('stageRoot identity changed');
  const mst = checkedLstat(marker, 'workspace marker'); if (!sameIdentity(auth.marker, mst) || !mst.isFile() || mst.size > 4096) throw new Error('workspace marker identity changed');
  const text = decodeUtf8(readFileBounded(marker, 4096, 'workspace marker too large'), 'workspace marker is not utf8');
  const data = JSON.parse(text); if (data.owner !== owner) throw new Error('workspace ownership marker mismatch');
}
function assertFreshOne(root: string, base: Baseline, limits: Required<CodingWorkspaceLimits>): void {
  const now = parentChain(base.abs);
  if (now.ids.length !== base.parentChain.length) throw new Error(`parent identity changed: ${base.path}`);
  for (let i = 0; i < now.ids.length; i++) if (now.paths[i] !== base.parentPaths[i] || !sameIdentity(base.parentChain[i], checkedLstat(now.paths[i], now.paths[i]))) throw new Error(`parent identity changed: ${base.path}`);
  if (!existsNoFollow(base.abs)) { if (base.exists) throw new Error(`destination deleted: ${base.path}`); return; }
  assertSafeExistingFile(base.abs, base.path);
  const st = checkedLstat(base.abs, base.path);
  if (!base.exists) throw new Error(`destination unexpectedly exists: ${base.path}`);
  if (!sameIdentity(base.file!, st)) throw new Error(`destination identity changed: ${base.path}`);
  if (st.size !== base.file!.size || st.mtimeMs !== base.file!.mtimeMs) throw new Error(`destination metadata changed: ${base.path}`);
  const bytes = readFileBounded(base.abs, limits.maxFileBytes, `destination too large: ${base.path}`);
  if (hashBytes(bytes) !== base.file!.hash) throw new Error(`destination content changed: ${base.path}`);
  if ((st.mode & 0o111) !== 0) throw new Error(`destination executable changed: ${base.path}`);
}
function writeDestination(root: string, rel: string, after: Buffer | null, base: Baseline, limits: Required<CodingWorkspaceLimits>): void {
  const abs = safeProjectAbs(root, rel);
  if (after === null) throw new Error(`deletion is unsupported: ${rel}`);
  if (after.length > limits.maxFileBytes) throw new Error(`candidate file too large: ${rel}`);
  decodeUtf8(after, `candidate is not utf8 text: ${rel}`);
  const parent = dirname(abs);
  assertSafeExistingDirectory(parent, `destination parent for ${rel}`);
  const pst = checkedLstat(parent, parent);
  const tmp = join(parent, `.${basename(abs)}.coding-${process.pid}-${randomUUID()}.tmp`);
  const fd = openSync(tmp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, base.exists ? (base.mode ?? 0o600) : 0o600);
  try { writeFileSync(fd, after); } finally { closeSync(fd); }
  const pst2 = checkedLstat(parent, parent); if (!sameIdentity(identity(pst), pst2)) { unlinkSync(tmp); throw new Error(`destination parent changed: ${rel}`); }
  assertFreshOne(root, base, limits);
  renameSync(tmp, abs);
}
function ensureLeaseRoot(): string {
  const uid = typeof process.getuid === 'function' ? process.getuid() : userInfo().uid;
  const dir = join(tmpdir(), `pi-zerg-swarm-coding-leases-${uid}`);
  if (!existsNoFollow(dir)) mkdirSync(dir, { mode: 0o700 });
  assertNoSymlinkComponents(dir);
  const st = checkedLstat(dir, 'leaseRoot');
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== uid || (st.mode & 0o077) !== 0) throw new Error('unsafe lease root');
  return dir;
}
function acquireLease(root: string, projectRoot: string, rel: string, owner: string, leases: string[], ownedKeys: string[]): void {
  const key = hash(`${projectRoot}\0${rel}`);
  const old = ownedDestinations.get(key); if (old) throw new Error(`destination lease exists: ${rel}`);
  const dir = join(root, key);
  mkdirSync(dir, { mode: 0o700 });
  writeFileSync(join(dir, 'owner'), owner, { flag: 'wx', mode: 0o600 });
  ownedDestinations.set(key, owner); ownedKeys.push(key); leases.push(dir);
}
function releaseLeases(leases: string[], keys: string[]): void {
  for (const key of keys.reverse()) ownedDestinations.delete(key);
  for (const lease of leases.reverse()) {
    try { unlinkSync(join(lease, 'owner')); } catch {}
    try { rmdirSync(lease); } catch {}
  }
}
function cleanupArtifacts(stageRoot: string, marker: string, owner: string, auth: StageAuthority, leases: string[], keys: string[]): void {
  assertOwnedStage(stageRoot, marker, owner, auth);
  for (const rel of [...auth.files.keys()].sort((a, b) => b.length - a.length)) { const abs = join(stageRoot, rel); if (existsNoFollow(abs)) { assertStageFile(abs, rel); unlinkSync(abs); } }
  const mst = checkedLstat(marker, 'workspace marker'); if (!sameIdentity(auth.marker, mst)) throw new Error('workspace marker identity changed'); unlinkSync(marker);
  for (const rel of [...auth.dirs.keys()].filter(Boolean).sort((a, b) => b.length - a.length)) { const abs = join(stageRoot, rel); const st = checkedLstat(abs, rel); const id = auth.dirs.get(rel)!; if (!sameIdentity(id, st) || !st.isDirectory()) throw new Error(`stage directory identity changed: ${rel}`); rmdirSync(abs); }
  const rst = checkedLstat(stageRoot, 'stageRoot'); if (!sameIdentity(auth.root, rst)) throw new Error('stageRoot identity changed'); rmdirSync(stageRoot);
  releaseLeases(leases, keys);
}
