import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, linkSync, chmodSync, existsSync, rmSync, unlinkSync, rmdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { captureCodingBaseline, createCodingWorkspace } from '../workflow-workspace.js';

function dirs() {
  const root = mkdtempSync(join(tmpdir(), 'cw-proj-'));
  const staging = mkdtempSync(join(tmpdir(), 'cw-stage-'));
  return { root, staging };
}
function file(root: string, path: string, text: string | Buffer) {
  const parts = path.split('/');
  let dir = root;
  for (const p of parts.slice(0, -1)) { dir = join(dir, p); mkdirSync(dir, { recursive: true }); }
  writeFileSync(join(root, path), text, { mode: 0o600 });
}

const skipWin = { skip: process.platform === 'win32' };

test('stages real bounded utf8 files, writes exact scoped candidates and applies', () => {
  const { root, staging } = dirs();
  file(root, 'src/a.txt', 'before');
  const ws = createCodingWorkspace({ workflowRunId: 'r1', projectRoot: root, stagingParent: staging, inputPaths: ['src/a.txt'], writablePaths: ['src/a.txt'], assertAuthority() {} });
  assert.equal(ws.read('src/a.txt'), 'before');
  ws.write('src/a.txt', 'after');
  const candidate = ws.inspect();
  assert.deepEqual(candidate.changedPaths, ['src/a.txt']);
  assert.equal(candidate.files[0].before?.toString(), 'before');
  assert.equal(candidate.files[0].after?.toString(), 'after');
  candidate.files[0].after?.write('MUTABLE');
  assert.equal(ws.apply(candidate.hash).status, 'applied');
  assert.equal(readFileSync(join(root, 'src/a.txt'), 'utf8'), 'after');
  assert.throws(() => ws.cleanup(), /after apply attempt/);
});

test('rejects path escape, absolute, backslash, dot and protected hidden paths', () => {
  const { root, staging } = dirs();
  for (const bad of ['../x', '/x', 'a\\b', 'a/./b', '.git/config', '.agents/x', 'credentials/token']) {
    assert.throws(() => createCodingWorkspace({ workflowRunId: 'r2', projectRoot: root, stagingParent: staging, inputPaths: [bad], writablePaths: [], assertAuthority() {} }), /invalid|ambiguous|protected|escapes/);
  }
});

test('rejects symlink components, hardlinks, specials, binary, executable and input bounds', skipWin, () => {
  const { root, staging } = dirs();
  file(root, 'real.txt', 'x');
  symlinkSync(join(root, 'real.txt'), join(root, 'sym.txt'));
  assert.throws(() => createCodingWorkspace({ workflowRunId: 'r3a', projectRoot: root, stagingParent: staging, inputPaths: ['sym.txt'], writablePaths: [], assertAuthority() {} }), /symlink|regular/);
  file(root, 'hard.txt', 'h'); linkSync(join(root, 'hard.txt'), join(root, 'hard2.txt'));
  assert.throws(() => createCodingWorkspace({ workflowRunId: 'r3b', projectRoot: root, stagingParent: staging, inputPaths: ['hard.txt'], writablePaths: [], assertAuthority() {} }), /hardlink/);
  try { execFileSync('mkfifo', [join(root, 'fifo')]); assert.throws(() => createCodingWorkspace({ workflowRunId: 'r3c', projectRoot: root, stagingParent: staging, inputPaths: ['fifo'], writablePaths: [], assertAuthority() {} }), /regular/); } catch {}
  writeFileSync(join(root, 'bin.txt'), Buffer.from([0xff, 0xfe]));
  assert.throws(() => createCodingWorkspace({ workflowRunId: 'r3d', projectRoot: root, stagingParent: staging, inputPaths: ['bin.txt'], writablePaths: [], assertAuthority() {} }), /utf8/);
  file(root, 'exec.txt', 'e'); chmodSync(join(root, 'exec.txt'), 0o700);
  assert.throws(() => createCodingWorkspace({ workflowRunId: 'r3e', projectRoot: root, stagingParent: staging, inputPaths: ['exec.txt'], writablePaths: [], assertAuthority() {} }), /executable/);
  file(root, 'big.txt', '12345');
  assert.throws(() => createCodingWorkspace({ workflowRunId: 'r3f', projectRoot: root, stagingParent: staging, inputPaths: ['big.txt'], writablePaths: [], limits: { maxFileBytes: 4 }, assertAuthority() {} }), /too large/);
});

test('limits are validated against hard caps and writable-only paths count toward them', () => {
  const { root, staging } = dirs(); mkdirSync(join(root, 'src'));
  assert.throws(() => createCodingWorkspace({ workflowRunId: 'limits1', projectRoot: root, stagingParent: staging, inputPaths: [], writablePaths: ['src/a.txt'], limits: { maxFiles: 33 }, assertAuthority() {} }), /hard cap/);
  assert.throws(() => createCodingWorkspace({ workflowRunId: 'limits2', projectRoot: root, stagingParent: staging, inputPaths: [], writablePaths: ['src/a.txt'], limits: { maxFileBytes: 256 * 1024 + 1 }, assertAuthority() {} }), /hard cap/);
  const many = Array.from({ length: 33 }, (_, i) => `src/${i}.txt`);
  assert.throws(() => createCodingWorkspace({ workflowRunId: 'limits3', projectRoot: root, stagingParent: staging, inputPaths: [], writablePaths: many, assertAuthority() {} }), /too many/);
});

test('writable-only existing paths are staged and total cap includes readonly plus creates', () => {
  const { root, staging } = dirs();
  file(root, 'w.txt', 'old'); file(root, 'ro.txt', '123456');
  const ws = createCodingWorkspace({ workflowRunId: 'wonly', projectRoot: root, stagingParent: staging, inputPaths: ['ro.txt'], writablePaths: ['w.txt'], limits: { maxTotalBytes: 10 }, assertAuthority() {} });
  assert.equal(ws.read('w.txt'), 'old');
  ws.write('w.txt', '12345');
  assert.throws(() => ws.inspect(), /total too large/);
});

test('write guard requires exact writable scope and live authority', () => {
  const { root, staging } = dirs();
  file(root, 'a.txt', 'a'); file(root, 'b.txt', 'b');
  let ok = true;
  const ws = createCodingWorkspace({ workflowRunId: 'r4', projectRoot: root, stagingParent: staging, inputPaths: ['a.txt', 'b.txt'], writablePaths: ['a.txt'], assertAuthority() { if (!ok) throw new Error('cancelled'); } });
  assert.throws(() => ws.write('b.txt', 'x'), /not writable/);
  ok = false;
  assert.throws(() => ws.write('a.txt', 'x'), /cancelled/);
});

test('fresh destination detects external content and identity changes before apply', () => {
  const { root, staging } = dirs();
  file(root, 'a.txt', 'a');
  const ws = createCodingWorkspace({ workflowRunId: 'r5', projectRoot: root, stagingParent: staging, inputPaths: ['a.txt'], writablePaths: ['a.txt'], assertAuthority() {} });
  ws.write('a.txt', 'b');
  const c = ws.inspect();
  writeFileSync(join(root, 'a.txt'), 'outside');
  assert.throws(() => ws.assertFreshDestination(), /changed/);
  assert.equal(ws.apply(c.hash).status, 'rejected');
});

test('allows new file creation only under existing destination parent and rejects directory creation milestone', () => {
  const { root, staging } = dirs();
  mkdirSync(join(root, 'src'));
  const ws = createCodingWorkspace({ workflowRunId: 'r6', projectRoot: root, stagingParent: staging, inputPaths: [], writablePaths: ['src/new.txt'], assertAuthority() {} });
  ws.write('src/new.txt', 'new');
  const c = ws.inspect();
  assert.equal(ws.apply(c.hash).status, 'applied');
  assert.equal(readFileSync(join(root, 'src/new.txt'), 'utf8'), 'new');
  assert.throws(() => createCodingWorkspace({ workflowRunId: 'r6b', projectRoot: root, stagingParent: staging, inputPaths: [], writablePaths: ['missing/new.txt'], assertAuthority() {} }), /parent/);
});

test('allows missing exact writable paths in input manifest but rejects missing readonly inputs', () => {
  const { root, staging } = dirs();
  mkdirSync(join(root, 'src'));
  assert.throws(() => captureCodingBaseline({ projectRoot: root, inputPaths: ['src/missing.txt'], writablePaths: [] }), /input does not exist/);
  const baseline = captureCodingBaseline({ projectRoot: root, inputPaths: ['new.txt'], writablePaths: ['new.txt'] });
  assert.equal(baseline.entries[0].exists, false);
  const ws = createCodingWorkspace({ workflowRunId: 'r6input', projectRoot: root, stagingParent: staging, inputPaths: ['new.txt'], writablePaths: ['new.txt'], reviewedBaseline: baseline, assertAuthority() {} });
  assert.throws(() => ws.read('new.txt'), /does not exist|invalid/);
  assert.deepEqual(ws.inspect().changedPaths, []);
  ws.write('new.txt', 'new');
  const c = ws.inspect();
  assert.deepEqual(c.changedPaths, ['new.txt']);
  assert.equal(ws.apply(c.hash).status, 'applied');
  assert.equal(readFileSync(join(root, 'new.txt'), 'utf8'), 'new');
});

test('partial cancel preserves completed writes and reports evidence without rollback', () => {
  const { root, staging } = dirs();
  file(root, 'a.txt', 'a'); file(root, 'b.txt', 'b');
  let calls = 0;
  const ws = createCodingWorkspace({ workflowRunId: 'r7', projectRoot: root, stagingParent: staging, inputPaths: ['a.txt', 'b.txt'], writablePaths: ['a.txt', 'b.txt'], assertAuthority() { calls++; if (calls >= 3) throw new Error('cancel'); } });
  calls = -2; ws.write('a.txt', 'aa'); ws.write('b.txt', 'bb');
  calls = 0;
  const outcome = ws.apply(ws.inspect().hash);
  assert.equal(outcome.status, 'partial');
  assert.deepEqual(outcome.appliedPaths, ['a.txt']);
  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'aa');
  assert.equal(readFileSync(join(root, 'b.txt'), 'utf8'), 'b');
  assert.throws(() => ws.cleanup(), /after apply attempt/);
});

test('reviewed baseline rejects input mutation before any staging workspace is created', () => {
  const { root, staging } = dirs();
  file(root, 'a.txt', 'a');
  const baseline = captureCodingBaseline({ projectRoot: root, inputPaths: ['a.txt'], writablePaths: ['a.txt'] });
  writeFileSync(join(root, 'a.txt'), 'mutated');
  assert.throws(() => createCodingWorkspace({ workflowRunId: 'baseline-mutated', projectRoot: root, stagingParent: staging, inputPaths: ['a.txt'], writablePaths: ['a.txt'], reviewedBaseline: baseline, assertAuthority() {} }), /baseline changed/);
  assert.equal(existsSync(staging), true);
});

test('reviewed baseline ignores unrelated ancestor directory churn but detects directory identity changes', skipWin, () => {
  const { root, staging } = dirs();
  mkdirSync(join(root, 'src'));
  file(root, 'src/a.txt', 'a');
  const baseline = captureCodingBaseline({ projectRoot: root, inputPaths: ['src/a.txt'], writablePaths: ['src/a.txt'] });
  file(dirname(root), `unrelated-${process.pid}.txt`, 'tmp');
  unlinkSync(join(dirname(root), `unrelated-${process.pid}.txt`));
  file(root, 'root-sibling.txt', 'tmp');
  unlinkSync(join(root, 'root-sibling.txt'));
  file(root, 'src/sibling.txt', 'tmp');
  unlinkSync(join(root, 'src/sibling.txt'));
  const ws = createCodingWorkspace({ workflowRunId: 'baseline-dir-churn', projectRoot: root, stagingParent: staging, inputPaths: ['src/a.txt'], writablePaths: ['src/a.txt'], reviewedBaseline: baseline, assertAuthority() {} });
  ws.write('src/a.txt', 'b');
  const c = ws.inspect();
  file(root, 'apply-sibling.txt', 'tmp');
  unlinkSync(join(root, 'apply-sibling.txt'));
  file(root, 'src/apply-sibling.txt', 'tmp');
  unlinkSync(join(root, 'src/apply-sibling.txt'));
  assert.doesNotThrow(() => ws.assertFreshDestination());
  assert.equal(ws.apply(c.hash).status, 'applied');

  const { root: r2, staging: s2 } = dirs();
  mkdirSync(join(r2, 'src'));
  chmodSync(join(r2, 'src'), 0o700);
  file(r2, 'src/a.txt', 'a');
  const baseline2 = captureCodingBaseline({ projectRoot: r2, inputPaths: ['src/a.txt'], writablePaths: ['src/a.txt'] });
  chmodSync(join(r2, 'src'), 0o755);
  assert.throws(() => createCodingWorkspace({ workflowRunId: 'baseline-dir-mode', projectRoot: r2, stagingParent: s2, inputPaths: ['src/a.txt'], writablePaths: ['src/a.txt'], reviewedBaseline: baseline2, assertAuthority() {} }), /baseline changed/);
});

test('settle preserves retained candidate but releases destination lease for a later workflow', () => {
  const { root, staging } = dirs(); const staging2 = mkdtempSync(join(tmpdir(), 'cw-stage-settle2-'));
  file(root, 'a.txt', 'a');
  const ws = createCodingWorkspace({ workflowRunId: 'settle1', projectRoot: root, stagingParent: staging, inputPaths: ['a.txt'], writablePaths: ['a.txt'], assertAuthority() {} });
  ws.write('a.txt', 'b');
  const candidate = ws.inspect();
  assert.equal(ws.apply(candidate.hash).status, 'applied');
  assert.throws(() => ws.cleanup(), /after apply attempt/);
  ws.settle();
  assert.deepEqual(ws.inspect().changedPaths, ['a.txt']);
  assert.throws(() => ws.write('a.txt', 'c'), /settled/);
  const baseline2 = captureCodingBaseline({ projectRoot: root, inputPaths: ['a.txt'], writablePaths: ['a.txt'] });
  assert.equal(baseline2.entries[0].sha256, candidate.files[0].afterHash);
  const ws2 = createCodingWorkspace({ workflowRunId: 'settle2', projectRoot: root, stagingParent: staging2, inputPaths: ['a.txt'], writablePaths: ['a.txt'], reviewedBaseline: baseline2, assertAuthority() {} });
  ws2.cleanup();
});

test('lease detects another workspace owner for same destination across different staging parents and cleanup releases it', () => {
  const { root, staging } = dirs(); const staging2 = mkdtempSync(join(tmpdir(), 'cw-stage2-'));
  file(root, 'a.txt', 'a');
  const ws = createCodingWorkspace({ workflowRunId: 'r8', projectRoot: root, stagingParent: staging, inputPaths: ['a.txt'], writablePaths: ['a.txt'], assertAuthority() {} });
  assert.throws(() => createCodingWorkspace({ workflowRunId: 'r8b', projectRoot: root, stagingParent: staging2, inputPaths: ['a.txt'], writablePaths: ['a.txt'], assertAuthority() {} }), /exist/i);
  ws.cleanup();
  const ws2 = createCodingWorkspace({ workflowRunId: 'r8c', projectRoot: root, stagingParent: staging2, inputPaths: ['a.txt'], writablePaths: ['a.txt'], assertAuthority() {} });
  ws2.cleanup();
});

test('inspect rejects unexpected stage files, unlisted dirs, symlinks; cleanup refuses unexpected state', skipWin, () => {
  const { root, staging } = dirs();
  file(root, 'a.txt', 'a'); file(root, 'target.txt', 't');
  const ws = createCodingWorkspace({ workflowRunId: 'r9', projectRoot: root, stagingParent: staging, inputPaths: ['a.txt'], writablePaths: ['a.txt'], assertAuthority() {} });
  writeFileSync(join(ws.stageRoot, 'extra.txt'), 'x');
  assert.throws(() => ws.inspect(), /unexpected/);
  const { root: root2, staging: staging2 } = dirs(); file(root2, 'a.txt', 'a');
  const ws2 = createCodingWorkspace({ workflowRunId: 'r9b', projectRoot: root2, stagingParent: staging2, inputPaths: ['a.txt'], writablePaths: ['a.txt'], assertAuthority() {} });
  symlinkSync(join(root2, 'a.txt'), join(ws2.stageRoot, 'link.txt'));
  assert.throws(() => ws2.inspect(), /symlink|hidden|unexpected/);
  assert.throws(() => ws2.cleanup(), /symlink|hidden|unexpected/);
  const { root: root3, staging: staging3 } = dirs(); file(root3, 'a.txt', 'a');
  const ws3 = createCodingWorkspace({ workflowRunId: 'r9c', projectRoot: root3, stagingParent: staging3, inputPaths: ['a.txt'], writablePaths: [], assertAuthority() {} });
  mkdirSync(join(ws3.stageRoot, 'empty'));
  assert.throws(() => ws3.inspect(), /unexpected stage directory/);
});

test('candidate hash is content addressed and stale hashes are rejected after stage changes', () => {
  const { root, staging } = dirs();
  file(root, 'a.txt', 'a');
  const ws = createCodingWorkspace({ workflowRunId: 'r10', projectRoot: root, stagingParent: staging, inputPaths: ['a.txt'], writablePaths: ['a.txt'], assertAuthority() {} });
  ws.write('a.txt', 'b');
  const old = ws.inspect().hash;
  ws.write('a.txt', 'c');
  const out = ws.apply(old);
  assert.equal(out.status, 'rejected');
  assert.match(out.error ?? '', /mismatch/);
});

test('hostile symlink staging parent, stage parent replacement and marker link are rejected', skipWin, () => {
  const { root, staging } = dirs(); file(root, 'dir/a.txt', 'a');
  const real = mkdtempSync(join(tmpdir(), 'cw-real-stage-'));
  symlinkSync(real, join(staging, 'link'));
  assert.throws(() => createCodingWorkspace({ workflowRunId: 'symparent', projectRoot: root, stagingParent: join(staging, 'link'), inputPaths: ['dir/a.txt'], writablePaths: ['dir/a.txt'], assertAuthority() {} }), /symlink/);
  const ws = createCodingWorkspace({ workflowRunId: 'replace', projectRoot: root, stagingParent: staging, inputPaths: ['dir/a.txt'], writablePaths: ['dir/a.txt'], assertAuthority() {} });
  rmSync(join(ws.stageRoot, 'dir'), { recursive: true, force: true });
  symlinkSync(root, join(ws.stageRoot, 'dir'));
  assert.throws(() => ws.read('dir/a.txt'), /unsafe|invalid|symlink|parent\/path/);
  assert.throws(() => ws.write('dir/a.txt', 'x'), /unsafe|symlink|directory/);
  const { root: r2, staging: s2 } = dirs(); file(r2, 'a.txt', 'a'); file(r2, 'm.txt', 'm');
  const ws2 = createCodingWorkspace({ workflowRunId: 'marker', projectRoot: r2, stagingParent: s2, inputPaths: ['a.txt'], writablePaths: ['a.txt'], assertAuthority() {} });
  unlinkSync(join(ws2.stageRoot, '.coding-workspace-owner.json'));
  symlinkSync(join(r2, 'm.txt'), join(ws2.stageRoot, '.coding-workspace-owner.json'));
  assert.throws(() => ws2.inspect(), /marker|symlink|owner/);
});

test('huge candidate files are rejected before unbounded allocation paths', () => {
  const { root, staging } = dirs(); file(root, 'a.txt', 'a');
  const ws = createCodingWorkspace({ workflowRunId: 'huge', projectRoot: root, stagingParent: staging, inputPaths: ['a.txt'], writablePaths: ['a.txt'], limits: { maxFileBytes: 8 }, assertAuthority() {} });
  chmodSync(join(ws.stageRoot, 'a.txt'), 0o600);
  writeFileSync(join(ws.stageRoot, 'a.txt'), '0123456789abcdef');
  assert.throws(() => ws.inspect(), /too large/);
  assert.throws(() => ws.read('a.txt'), /too large/);
});

test('readonly staged files cannot be deleted, mutated, or mode changed', () => {
  const { root, staging } = dirs(); file(root, 'ro.txt', 'readonly');
  const ws = createCodingWorkspace({ workflowRunId: 'ro', projectRoot: root, stagingParent: staging, inputPaths: ['ro.txt'], writablePaths: [], assertAuthority() {} });
  chmodSync(join(ws.stageRoot, 'ro.txt'), 0o600);
  assert.throws(() => ws.inspect(), /readonly stage mode changed/);
  chmodSync(join(ws.stageRoot, 'ro.txt'), 0o600);
  writeFileSync(join(ws.stageRoot, 'ro.txt'), 'changed');
  chmodSync(join(ws.stageRoot, 'ro.txt'), 0o400);
  assert.throws(() => ws.inspect(), /readonly stage content changed/);
  unlinkSync(join(ws.stageRoot, 'ro.txt'));
  assert.throws(() => ws.inspect(), /does not exist|invalid/);
});

test('apply preflights all destinations before first write when a later target is stale', () => {
  const { root, staging } = dirs(); file(root, 'a.txt', 'a'); file(root, 'b.txt', 'b');
  const ws = createCodingWorkspace({ workflowRunId: 'preflight', projectRoot: root, stagingParent: staging, inputPaths: ['a.txt', 'b.txt'], writablePaths: ['a.txt', 'b.txt'], assertAuthority() {} });
  ws.write('a.txt', 'aa'); ws.write('b.txt', 'bb');
  const h = ws.inspect().hash;
  writeFileSync(join(root, 'b.txt'), 'stale');
  const out = ws.apply(h);
  assert.equal(out.status, 'rejected');
  assert.deepEqual(out.appliedPaths, []);
  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'a');
});

test('unsupported candidate deletion and unsafe destination permissions are refused', () => {
  const { root, staging } = dirs(); file(root, 'a.txt', 'a');
  const ws = createCodingWorkspace({ workflowRunId: 'del', projectRoot: root, stagingParent: staging, inputPaths: ['a.txt'], writablePaths: ['a.txt'], assertAuthority() {} });
  unlinkSync(join(ws.stageRoot, 'a.txt'));
  assert.throws(() => ws.inspect(), /deletion unsupported/);
  const { root: r2, staging: s2 } = dirs(); file(r2, 'x.txt', 'x');
  const ws2 = createCodingWorkspace({ workflowRunId: 'perm', projectRoot: r2, stagingParent: s2, inputPaths: ['x.txt'], writablePaths: ['x.txt'], assertAuthority() {} });
  ws2.write('x.txt', 'xx'); const h = ws2.inspect().hash;
  chmodSync(join(r2, 'x.txt'), 0o700);
  const out = ws2.apply(h);
  assert.equal(out.status, 'rejected');
  assert.match(out.error ?? '', /changed|executable/);
});

test('cleanup removes only owned exact files and refuses replaced directories', skipWin, () => {
  const { root, staging } = dirs(); file(root, 'dir/a.txt', 'a');
  const ws = createCodingWorkspace({ workflowRunId: 'clean', projectRoot: root, stagingParent: staging, inputPaths: ['dir/a.txt'], writablePaths: ['dir/a.txt'], assertAuthority() {} });
  ws.cleanup();
  assert.equal(existsSync(ws.stageRoot), false);
  const { root: r2, staging: s2 } = dirs(); file(r2, 'dir/a.txt', 'a');
  const ws2 = createCodingWorkspace({ workflowRunId: 'cleanhazard', projectRoot: r2, stagingParent: s2, inputPaths: ['dir/a.txt'], writablePaths: ['dir/a.txt'], assertAuthority() {} });
  unlinkSync(join(ws2.stageRoot, 'dir/a.txt'));
  rmdirSync(join(ws2.stageRoot, 'dir'));
  symlinkSync(r2, join(ws2.stageRoot, 'dir'));
  assert.throws(() => ws2.cleanup(), /symlink|directory identity|unsafe/);
  assert.equal(existsSync(join(r2, 'dir/a.txt')), true);
});
