import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { validateCheckProfile, profileHash, runCodingCheck, type CodingCheckProfile } from '../workflow-checks.js';

const node = process.execPath;
const testDir = dirname(fileURLToPath(import.meta.url));
const supervisorPath = resolve(testDir, '..', 'workflow-check-supervisor.py');
function hash(text: string): string { return createHash('sha256').update(text).digest('hex'); }

async function runPythonProbe(source: string): Promise<string> {
  return await new Promise((resolveProbe, rejectProbe) => {
    const child = spawn('python3', ['-B', '-c', source], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('error', rejectProbe);
    child.on('close', (code) => {
      if (code === 0) resolveProbe(stdout);
      else rejectProbe(new Error(`python probe exited ${code}: ${stderr}`));
    });
  });
}

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'workflow-checks-'));
  try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

async function waitForFile(path: string, attempts = 200): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    try { await access(path, constants.F_OK); return; } catch { await new Promise((resolveDelay) => setTimeout(resolveDelay, 10)); }
  }
  await access(path, constants.F_OK);
}

function baseProfile(dir: string, script = 'check.js', extra: Partial<CodingCheckProfile> = {}): CodingCheckProfile {
  return { id: 'node-check', executable: node, argv: [join(dir, script)], cwd: '.', env: {}, timeoutMs: 2_000, outputBytes: 1024, ...extra };
}

async function run(dir: string, profile: CodingCheckProfile, candidate = 'candidate'): Promise<Awaited<ReturnType<typeof runCodingCheck>>> {
  return await runCodingCheck({ profile, stageRoot: dir, expectedCandidateHash: hash(candidate), captureCandidate: () => candidate, assertAuthority: () => {} });
}

test('successful and failing actual node checks report exact process evidence', async () => {
  await withTmp(async (dir) => {
    await writeFile(join(dir, 'ok.js'), "console.log('ok'); console.error('warn');\n", 'utf8');
    const ok = await run(dir, baseProfile(dir, 'ok.js'));
    assert.equal(ok.passed, true);
    assert.equal(ok.outcome, 'passed');
    assert.equal(ok.exitCode, 0);
    assert.equal(ok.signal, null);
    assert.match(ok.stdout, /ok/);
    assert.match(ok.stderr, /warn/);
    assert.equal(ok.timedOut, false);
    assert.equal(ok.cancelled, false);
    assert.equal(ok.cleanup.outcome, 'ok');
    assert.equal(ok.candidateHashBefore, ok.expectedCandidateHash);
    assert.equal(ok.candidateHashAfter, ok.expectedCandidateHash);
    assert.equal(ok.profileHash, profileHash(baseProfile(dir, 'ok.js')));

    await writeFile(join(dir, 'fail.js'), "console.error('bad'); process.exit(7);\n", 'utf8');
    const fail = await run(dir, baseProfile(dir, 'fail.js'));
    assert.equal(fail.passed, false);
    assert.equal(fail.outcome, 'failed');
    assert.equal(fail.exitCode, 7);
    assert.match(fail.stderr, /bad/);
  });
});

test('stdout and stderr are bounded with truncation and dropped byte counts', async () => {
  await withTmp(async (dir) => {
    await writeFile(join(dir, 'loud.js'), "process.stdout.write('a'.repeat(80)); process.stderr.write('b'.repeat(90));\n", 'utf8');
    const result = await run(dir, baseProfile(dir, 'loud.js', { outputBytes: 16 }));
    assert.equal(result.passed, true);
    assert.equal(result.stdout.length, 16);
    assert.equal(result.stderr.length, 16);
    assert.equal(result.stdoutTruncated, true);
    assert.equal(result.stderrTruncated, true);
    assert.equal(result.stdoutDroppedBytes, 64);
    assert.equal(result.stderrDroppedBytes, 74);
  });
});

test('timeout terminates child process group and reports cleanup', async () => {
  await withTmp(async (dir) => {
    await writeFile(join(dir, 'hang.js'), "setInterval(() => {}, 1000);\n", 'utf8');
    const result = await run(dir, baseProfile(dir, 'hang.js', { timeoutMs: 80 }));
    assert.equal(result.passed, false, JSON.stringify(result));
    assert.equal(result.timedOut, true, JSON.stringify(result));
    assert.equal(result.cleanup.attempted, true, JSON.stringify(result));
    assert.notEqual(result.cleanup.outcome, 'failed');
  });
});

test('abort before spawn returns cancelled uncertain without spawning', async () => {
  await withTmp(async (dir) => {
    await writeFile(join(dir, 'must-not-run.js'), "throw new Error('ran');\n", 'utf8');
    const ac = new AbortController();
    ac.abort();
    const result = await runCodingCheck({ profile: baseProfile(dir, 'must-not-run.js'), stageRoot: dir, expectedCandidateHash: hash('candidate'), captureCandidate: () => 'candidate', assertAuthority: () => {}, signal: ac.signal });
    assert.equal(result.passed, false);
    assert.equal(result.outcome, 'uncertain');
    assert.equal(result.cancelled, true);
    assert.equal(result.exitCode, null);
  });
});

test('mid-run abort terminates process group after checked process starts', async () => {
  await withTmp(async (dir) => {
    const descendantStarted = join(dir, 'descendant-started');
    const survived = join(dir, 'survived');
    await writeFile(join(dir, 'hang.js'), `const { spawn } = require('node:child_process');\nspawn(process.execPath, ['-e', ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(descendantStarted)}, '1'); setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(survived)}, 'x'), 700); setInterval(()=>{}, 1000);`)}], { stdio: 'ignore' });\nsetInterval(() => {}, 1000);\n`, 'utf8');
    const ac = new AbortController();
    const promise = runCodingCheck({ profile: baseProfile(dir, 'hang.js', { timeoutMs: 5_000 }), stageRoot: dir, expectedCandidateHash: hash('candidate'), captureCandidate: () => 'candidate', assertAuthority: () => {}, signal: ac.signal });
    let result!: Awaited<ReturnType<typeof runCodingCheck>>;
    try {
      await waitForFile(descendantStarted);
    } finally {
      ac.abort();
      result = await promise;
    }
    assert.equal(result.passed, false, JSON.stringify(result));
    assert.equal(result.cancelled, true, JSON.stringify(result));
    assert.equal(result.cleanup.attempted, true, JSON.stringify(result));
    assert.equal(result.cleanup.outcome, 'ok', JSON.stringify(result));
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 900));
    await assert.rejects(access(survived, constants.F_OK));
  });
});

test('early abort before supervisor readiness is queued and cleans up owned process', async () => {
  await withTmp(async (dir) => {
    const survived = join(dir, 'early-survived');
    await writeFile(join(dir, 'hang.js'), `const { spawn } = require('node:child_process');\nspawn(process.execPath, ['-e', ${JSON.stringify(`setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(survived)}, 'x'), 700); setInterval(()=>{}, 1000);`)}], { stdio: 'ignore' });\nsetInterval(() => {}, 1000);\n`, 'utf8');
    for (let i = 0; i < 8; i += 1) {
      const ac = new AbortController();
      const promise = runCodingCheck({ profile: baseProfile(dir, 'hang.js', { timeoutMs: 5_000 }), stageRoot: dir, expectedCandidateHash: hash('candidate'), captureCandidate: () => 'candidate', assertAuthority: () => {}, signal: ac.signal });
      ac.abort();
      const result = await promise;
      assert.equal(result.passed, false, JSON.stringify(result));
      assert.equal(result.cancelled, true, JSON.stringify(result));
      assert.equal(result.cleanup.attempted, true, JSON.stringify(result));
      assert.equal(result.cleanup.outcome, 'ok', JSON.stringify(result));
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 900));
    await assert.rejects(access(survived, constants.F_OK));
  });
});

test('delayed supervisor readiness queues early abort until owned child cleanup is provable', async () => {
  await withTmp(async (dir) => {
    const source = await readFile(resolve(testDir, '..', 'workflow-checks.ts'), 'utf8');
    await writeFile(join(dir, 'workflow-checks.ts'), source, 'utf8');
    await writeFile(join(dir, 'workflow-check-supervisor.py'), `#!/usr/bin/env python3\nimport runpy, time\ntime.sleep(0.15)\nrunpy.run_path(${JSON.stringify(supervisorPath)}, run_name='__main__')\n`, 'utf8');
    const survived = join(dir, 'delayed-ready-survived');
    await writeFile(join(dir, 'hang.js'), `const { spawn } = require('node:child_process');\nspawn(process.execPath, ['-e', ${JSON.stringify(`setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(survived)}, 'x'), 700); setInterval(()=>{}, 1000);`)}], { stdio: 'ignore' });\nsetInterval(() => {}, 1000);\n`, 'utf8');
    const mod = await import(pathToFileURL(join(dir, 'workflow-checks.ts')).href + `?v=${Date.now()}`) as typeof import('../workflow-checks.js');
    const ac = new AbortController();
    const promise = mod.runCodingCheck({ profile: baseProfile(dir, 'hang.js', { timeoutMs: 5_000 }), stageRoot: dir, expectedCandidateHash: hash('candidate'), captureCandidate: () => 'candidate', assertAuthority: () => {}, signal: ac.signal });
    ac.abort();
    const result = await promise;
    assert.equal(result.passed, false, JSON.stringify(result));
    assert.equal(result.cancelled, true, JSON.stringify(result));
    assert.equal(result.cleanup.attempted, true, JSON.stringify(result));
    assert.equal(result.cleanup.outcome, 'ok', JSON.stringify(result));
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 900));
    await assert.rejects(access(survived, constants.F_OK));
  });
});

test('supervisor protocol accepts only optional single ready line before exactly one final report', async () => {
  await withTmp(async (dir) => {
    const source = await readFile(resolve(testDir, '..', 'workflow-checks.ts'), 'utf8');
    await writeFile(join(dir, 'workflow-checks.ts'), source, 'utf8');
    await writeFile(join(dir, 'ok.js'), "process.exit(0);\n", 'utf8');
    const goodReport = { supervisorOk: true, exitCode: 0, signal: null, timedOut: false, cancelled: false, stdout: '', stderr: '', stdoutTruncated: false, stderrTruncated: false, stdoutDroppedBytes: 0, stderrDroppedBytes: 0, cleanup: { attempted: false, outcome: 'ok' }, errors: [], errorsDropped: 0 };
    const uncertainReport = { ...goodReport, supervisorOk: false, cleanup: { attempted: false, outcome: 'uncertain', error: 'first report was not proof' } };
    const cases: Array<[string, string]> = [
      ['duplicate-final-reports', JSON.stringify(uncertainReport) + '\n' + JSON.stringify(goodReport) + '\n'],
      ['duplicate-ready-lines', '{"supervisorReady":true}\n{"supervisorReady":true}\n' + JSON.stringify(goodReport) + '\n'],
      ['reordered-ready-line', JSON.stringify(goodReport) + '\n{"supervisorReady":true}\n'],
      ['extra-ready-after-report', '{"supervisorReady":true}\n' + JSON.stringify(goodReport) + '\n{"supervisorReady":true}\n'],
      ['malformed-then-valid-report', '{not-json}\n' + JSON.stringify(goodReport) + '\n'],
      ['valid-final', JSON.stringify(goodReport) + '\n'],
      ['valid-ready-final', '{"supervisorReady":true}\n' + JSON.stringify(goodReport) + '\n'],
    ];
    for (const [name, payload] of cases) {
      await writeFile(join(dir, 'workflow-check-supervisor.py'), `#!/usr/bin/env python3\nimport os\nos.write(3, ${JSON.stringify(payload)}.encode())\n`, 'utf8');
      const mod = await import(pathToFileURL(join(dir, 'workflow-checks.ts')).href + `?case=${name}-${Date.now()}`) as typeof import('../workflow-checks.js');
      const result = await mod.runCodingCheck({ profile: baseProfile(dir, 'ok.js'), stageRoot: dir, expectedCandidateHash: hash('candidate'), captureCandidate: () => 'candidate', assertAuthority: () => {} });
      if (name.startsWith('valid-')) {
        assert.equal(result.passed, true, name + ': ' + JSON.stringify(result));
        assert.equal(result.cleanup.outcome, 'ok');
        continue;
      }
      assert.equal(result.passed, false, name + ': ' + JSON.stringify(result));
      assert.equal(result.outcome, 'uncertain', name + ': ' + JSON.stringify(result));
      assert.equal(result.cleanup.outcome, 'uncertain', name + ': ' + JSON.stringify(result));
      assert.match(result.cleanup.error ?? '', /missing supervisor cleanup report/, name + ': ' + JSON.stringify(result));
    }
  });
});

test('descendant in same POSIX process group is cleaned up on timeout', { skip: process.platform === 'win32' }, async () => {
  await withTmp(async (dir) => {
    const marker = join(dir, 'survived');
    await writeFile(join(dir, 'group.js'), `const { spawn } = require('node:child_process');\nspawn(process.execPath, ['-e', ${JSON.stringify(`setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x'), 600); setInterval(()=>{}, 1000);`)}], { stdio: 'ignore' });\nsetInterval(() => {}, 1000);\n`, 'utf8');
    const result = await run(dir, baseProfile(dir, 'group.js', { timeoutMs: 80 }));
    assert.equal(result.timedOut, true, JSON.stringify(result));
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 900));
    await assert.rejects(access(marker, constants.F_OK));
  });
});

test('missing executable makes supervisor result uncertain with evidence', async () => {
  await withTmp(async (dir) => {
    const result = await run(dir, { ...baseProfile(dir), executable: join(dir, 'missing-node') });
    assert.equal(result.passed, false);
    assert.equal(result.outcome, 'uncertain');
    assert.match(result.stderr, /ENOENT|No such file|supervisor/i);
    assert.equal(result.cleanup.outcome, 'uncertain');
  });
});

test('supervisor cleanup is uncertain when proc child enumeration is ambiguous', { skip: process.platform !== 'linux' }, async () => {
  const output = await runPythonProbe(`
import importlib.util, json
spec = importlib.util.spec_from_file_location('supervisor', ${JSON.stringify(supervisorPath)})
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
called = []
mod.signal_pid = lambda *args: called.append(args)
mod.live_children = lambda: ([], ['permission reading children for supervisor tid 1: denied'])
result = mod.cleanup(123456, {}, {}, False, False)
print(json.dumps({'result': result, 'signals': len(called)}))
`);
  const probe = JSON.parse(output);
  assert.equal(probe.result.outcome, 'uncertain');
  assert.match(probe.result.error, /permission reading children/);
  assert.equal(probe.signals, 0);
});

test('supervisor refuses to signal pid whose starttime cannot be verified', { skip: process.platform !== 'linux' }, async () => {
  const output = await runPythonProbe(`
import importlib.util, json, os
spec = importlib.util.spec_from_file_location('supervisor', ${JSON.stringify(supervisorPath)})
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
errors = []
os.kill = lambda *args: (_ for _ in ()).throw(AssertionError('os.kill must not be used'))
mod.pidfd_supported = lambda: True
mod.read_starttime = lambda pid: (None, 'permission reading proc stat')
identity = mod.remember_pid(424242, {}, errors)
signalled = mod.signal_pid(424242, mod.signal.SIGTERM, {}, errors)
print(json.dumps({'identity': identity, 'signalled': signalled, 'errors': errors}))
`);
  const probe = JSON.parse(output);
  assert.equal(probe.identity, null);
  assert.equal(probe.signalled, false);
  assert.match(probe.errors.join('\n'), /permission reading proc stat|unverified pid/);
});

test('supervisor preserves Popen.poll returncode when it wins the waitpid race', { skip: process.platform !== 'linux' }, async () => {
  const output = await runPythonProbe(`
import importlib.util, io, json, sys
spec = importlib.util.spec_from_file_location('supervisor', ${JSON.stringify(supervisorPath)})
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
reports = []
mod.write_report = lambda report: reports.append(report.copy())
mod.pidfd_supported = lambda: True
mod.remember_pid = lambda pid, identities, errors: identities.setdefault(pid, {'starttime': '1', 'pidfd': 99})
mod.refresh_children = lambda identities, statuses, errors: []
mod.reap = lambda statuses, main_pid: True
mod.cleanup = lambda main_pid, identities, statuses, timed_out, cancelled: {'attempted': timed_out or cancelled, 'outcome': 'ok'}
clock = {'value': 0.0}
def fake_now():
    clock['value'] += 0.02
    return clock['value']
mod.now = fake_now
class FakeLibc:
    def prctl(self, *args): return 0
mod.ctypes.CDLL = lambda *args, **kwargs: FakeLibc()
class FakeProc:
    pid = 424242
    stdout = None
    stderr = None
    def poll(self): return -15
class FakePopenFactory:
    def Popen(self, *args, **kwargs): return FakeProc()
mod.subprocess.Popen = FakePopenFactory().Popen
class FakeSelector:
    def register(self, *args, **kwargs): pass
    def get_map(self): return {}
    def select(self, timeout): return []
mod.selectors.DefaultSelector = FakeSelector
cfg = {'executable': '/bin/true', 'argv': [], 'cwd': '/', 'env': {}, 'timeoutMs': 80, 'outputBytes': 1024}
sys.stdin = type('FakeStdin', (), {'buffer': io.BytesIO(json.dumps(cfg).encode('utf-8'))})()
mod.main()
print(json.dumps(reports[-1]))
`);
  const report = JSON.parse(output);
  assert.equal(report.supervisorOk, true);
  assert.equal(report.exitCode, null);
  assert.equal(report.signal, 15);
  assert.equal(report.timedOut, false);
  assert.equal(report.cleanup.outcome, 'ok');
});

test('supervisor error collection is bounded deduplicated and parseable', { skip: process.platform !== 'linux' }, async () => {
  const output = await runPythonProbe(`
import importlib.util, json
spec = importlib.util.spec_from_file_location('supervisor', ${JSON.stringify(supervisorPath)})
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
errors = mod.BoundedErrors(max_items=4, max_text=20)
for _ in range(1000):
    errors.append('duplicate diagnostic that is very long')
for idx in range(100):
    errors.append('unique diagnostic ' + str(idx))
report = {'supervisorOk': True, 'timedOut': False, 'cancelled': False, 'exitCode': 0, 'signal': None, 'stdout': '', 'stderr': '', 'stdoutTruncated': False, 'stderrTruncated': False, 'stdoutDroppedBytes': 0, 'stderrDroppedBytes': 0, 'cleanup': {'attempted': False, 'outcome': 'ok'}, 'errors': errors, 'errorsDropped': 0}
raw = mod._safe_report(report)
parsed = json.loads(raw.decode('utf-8'))
print(json.dumps({'length': len(raw), 'errors': parsed['errors'], 'dropped': parsed['errorsDropped']}))
`);
  const probe = JSON.parse(output);
  assert.ok(probe.length < 1024 * 1024);
  assert.ok(probe.errors.length <= 4);
  assert.ok(probe.dropped > 1000);
});

test('large legal stdout and stderr fit supervisor protocol as valid JSON', async () => {
  await withTmp(async (dir) => {
    const payload = 'ctl\u0000\u001b utf8 😀\n';
    await writeFile(join(dir, 'large.js'), `const payload = ${JSON.stringify(payload)}; process.stdout.write(payload.repeat(8192)); process.stderr.write(payload.repeat(8192));\n`, 'utf8');
    const result = await run(dir, baseProfile(dir, 'large.js', { outputBytes: 65_536 }));
    assert.equal(result.passed, true, JSON.stringify({ reason: result.reason, stderr: result.stderr.slice(0, 500) }));
    assert.equal(result.stdoutTruncated, true);
    assert.equal(result.stderrTruncated, true);
    assert.equal(result.stdout, payload.repeat(4096));
    assert.equal(result.stderr, payload.repeat(4096));
    assert.equal(result.stdoutDroppedBytes, 65_536);
    assert.equal(result.stderrDroppedBytes, 65_536);
  });
});

test('protocol diagnostics make an otherwise successful check uncertain with no false pass', async () => {
  await withTmp(async (dir) => {
    const source = await readFile(resolve(testDir, '..', 'workflow-checks.ts'), 'utf8');
    await writeFile(join(dir, 'workflow-checks.ts'), source, 'utf8');
    await writeFile(join(dir, 'workflow-check-supervisor.py'), `#!/usr/bin/env python3\nimport json, os\nreport = {'supervisorOk': True, 'exitCode': 0, 'signal': None, 'timedOut': False, 'cancelled': False, 'stdout': '', 'stderr': '', 'stdoutTruncated': False, 'stderrTruncated': False, 'stdoutDroppedBytes': 0, 'stderrDroppedBytes': 0, 'cleanup': {'attempted': False, 'outcome': 'ok'}, 'errors': ['synthetic diagnostic'], 'errorsDropped': 2}\nos.write(3, (json.dumps(report) + '\\n').encode())\n`, 'utf8');
    await writeFile(join(dir, 'ok.js'), "process.exit(0);\n", 'utf8');
    const mod = await import(pathToFileURL(join(dir, 'workflow-checks.ts')).href + `?v=${Date.now()}`) as typeof import('../workflow-checks.js');
    const result = await mod.runCodingCheck({ profile: baseProfile(dir, 'ok.js'), stageRoot: dir, expectedCandidateHash: hash('candidate'), captureCandidate: () => 'candidate', assertAuthority: () => {} });
    assert.equal(result.passed, false, JSON.stringify(result));
    assert.equal(result.outcome, 'uncertain');
    assert.match(result.stderr, /synthetic diagnostic/);
    assert.match(result.stderr, /dropped 2 diagnostics/);
  });
});

test('candidate tampering before or after prevents pass despite zero exit', async () => {
  await withTmp(async (dir) => {
    await writeFile(join(dir, 'ok.js'), "process.exit(0);\n", 'utf8');
    const before = await runCodingCheck({ profile: baseProfile(dir, 'ok.js'), stageRoot: dir, expectedCandidateHash: hash('expected'), captureCandidate: () => 'changed', assertAuthority: () => {} });
    assert.equal(before.passed, false);
    assert.match(before.reason, /before/);
    let candidate = 'candidate';
    const after = await runCodingCheck({ profile: baseProfile(dir, 'ok.js'), stageRoot: dir, expectedCandidateHash: hash('candidate'), captureCandidate: () => candidate, assertAuthority: () => { candidate = 'tampered'; } });
    assert.equal(after.passed, false);
    assert.match(after.reason, /after|before/);
  });
});

test('authority guard revocation propagates after awaited process close', async () => {
  await withTmp(async (dir) => {
    await writeFile(join(dir, 'ok.js'), "process.exit(0);\n", 'utf8');
    let calls = 0;
    await assert.rejects(runCodingCheck({ profile: baseProfile(dir, 'ok.js'), stageRoot: dir, expectedCandidateHash: hash('candidate'), captureCandidate: () => 'candidate', assertAuthority: () => { if (++calls > 4) throw new Error('revoked'); } }), /revoked/);
  });
});

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function waitUntilDead(pid: number): Promise<void> {
  for (let i = 0; i < 30; i++) {
    if (!isPidAlive(pid)) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
}

test('successful check cannot pass while setsid escaped grandchild remains alive', { skip: process.platform !== 'linux' }, async () => {
  await withTmp(async (dir) => {
    const marker = join(dir, 'escaped.pid');
    await writeFile(join(dir, 'escape.sh'), `#!/bin/sh\nsetsid sh -c 'sleep 60 & echo $! > ${marker}; exit 0' >/dev/null 2>&1 &\nexit 0\n`, 'utf8');
    const result = await run(dir, { id: 'setsid-escape', executable: '/bin/sh', argv: [join(dir, 'escape.sh')], cwd: '.', env: {}, timeoutMs: 2_000, outputBytes: 1024 });
    const pid = Number((await readFile(marker, 'utf8')).trim());
    await waitUntilDead(pid);
    assert.equal(isPidAlive(pid), false);
    assert.equal(result.passed, true);
    assert.equal(result.cleanup.outcome, 'ok');
  });
});

test('denied authority before spawn prevents process execution', async () => {
  await withTmp(async (dir) => {
    const marker = join(dir, 'spawned');
    await writeFile(join(dir, 'must-not-run.js'), `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x');\n`, 'utf8');
    await assert.rejects(runCodingCheck({ profile: baseProfile(dir, 'must-not-run.js'), stageRoot: dir, expectedCandidateHash: hash('candidate'), captureCandidate: () => 'candidate', assertAuthority: () => { throw new Error('denied'); } }), /denied/);
    await assert.rejects(access(marker, constants.F_OK));
  });
});

test('environment is explicit and does not inherit ambient variables', async () => {
  await withTmp(async (dir) => {
    await writeFile(join(dir, 'env.js'), "console.log(String(process.env.WORKFLOW_CHECK_ONLY)); console.log(String(process.env.PATH));\n", 'utf8');
    const result = await run(dir, baseProfile(dir, 'env.js', { env: { WORKFLOW_CHECK_ONLY: 'yes' } }));
    assert.equal(result.passed, true);
    assert.match(result.stdout, /^yes\nundefined\n?$/);
  });
});

test('validation rejects unknown fields, bad args, generated outputs and cwd/path escapes', async () => {
  assert.throws(() => validateCheckProfile({ ...baseProfile(tmpdir()), extra: true }), /unsupported/);
  assert.throws(() => validateCheckProfile({ ...baseProfile(tmpdir()), executable: 'node' }), /absolute/);
  assert.throws(() => validateCheckProfile({ ...baseProfile(tmpdir()), argv: ['ok', 1] }), /argv/);
  assert.throws(() => validateCheckProfile({ ...baseProfile(tmpdir()), timeoutMs: 120_001 }), /timeout/);
  assert.throws(() => validateCheckProfile({ ...baseProfile(tmpdir()), outputBytes: 65_537 }), /output/);
  assert.throws(() => validateCheckProfile({ ...baseProfile(tmpdir()), generatedOutputs: ['x'] }), /unsupported/);
  assert.throws(() => validateCheckProfile({ ...baseProfile(tmpdir()), cwd: '../outside' }), /cwd/);

  await withTmp(async (dir) => {
    const outside = await mkdtemp(join(tmpdir(), 'workflow-checks-outside-'));
    try {
      await mkdir(join(dir, 'inside'));
      await symlink(outside, join(dir, 'inside', 'link'));
      await writeFile(join(dir, 'ok.js'), "process.exit(0);\n", 'utf8');
      await assert.rejects(run(dir, baseProfile(dir, 'ok.js', { cwd: 'inside/link' })), /escapes/);
    } finally { await rm(outside, { recursive: true, force: true }); }
  });
});
