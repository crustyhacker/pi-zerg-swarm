import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Test-only Linux supervisor. Not a sandbox. Never import a host fixture into
// the operator process; use an approved allowlisted snapshot and empty env.
export function assertAncestorIsolation(root) {
  for (let ancestor = dirname(root); ; ancestor = dirname(ancestor)) {
    for (const leaf of ['.pi', 'AGENTS.override.md', 'AGENTS.md', 'AGENTS.MD', 'CLAUDE.md', 'CLAUDE.MD', 'SYSTEM.md', 'APPEND_SYSTEM.md']) {
      assert(!existsSync(join(ancestor, leaf)), 'Unexpected ancestor resource: ' + join(ancestor, leaf));
    }
    if (ancestor === dirname(ancestor)) break;
  }
}
export function cleanHostEnvironment(root) {
  for (const leaf of ['home', 'tmp', 'agent', 'xdg']) mkdirSync(join(root, leaf), { recursive: true });
  return { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', HOME: join(root, 'home'), TMPDIR: join(root, 'tmp'), XDG_CONFIG_HOME: join(root, 'xdg'), XDG_CACHE_HOME: join(root, 'xdg'), XDG_DATA_HOME: join(root, 'xdg'), PI_CODING_AGENT_DIR: join(root, 'agent'), PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0' };
}
export function guardSource(root, origin = null) {
  if (origin !== null) {
    const url = new URL(origin);
    assert.equal(url.protocol, 'http:'); assert.equal(url.hostname, '127.0.0.1');
    assert(url.port && url.href === origin + '/', 'Exact canonical loopback origin required');
  }
  return `import { appendFileSync, existsSync, statSync } from 'node:fs';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
const origin = ${JSON.stringify(origin)}, log = ${JSON.stringify(join(root, 'network-refused.txt'))};
function refuse(reason) {
  if (!existsSync(log) || statSync(log).size < 4096) appendFileSync(log, String(reason).slice(0, 256) + '\\n');
  throw Error('Fixture refused network');
}
const fetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
  if (!origin || url.origin !== origin || url.pathname !== '/v1/chat/completions' || url.search || url.hash || url.username || url.password || method !== 'POST') refuse('fetch');
  return fetch(input, { ...init, redirect: 'error' });
};
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const options = first && typeof first === 'object' ? first : { port: first, host: args[1] };
  if (!origin || this instanceof tls.TLSSocket || options?.path || options?.host !== '127.0.0.1' || String(options?.port) !== new URL(origin).port) refuse('socket');
  return connect.apply(this, args);
};
// Only fetch may issue HTTP requests; raw sockets still obey the exact endpoint
// socket allowlist. TLS/HTTP alternate APIs may not bypass the fetch contract.
http.request = http.get = https.request = https.get = () => refuse('alternate HTTP');
tls.connect = () => refuse('TLS');
syncBuiltinESMExports();
`;
}
export async function readFixtureBody(req, budget, limit = 524288) {
  assert(++budget.hits <= budget.max, 'Total request ceiling (including rejected requests)');
  assert.equal(req.method, 'POST'); assert.equal(req.url, '/v1/chat/completions');
  const timer = setTimeout(() => req.destroy(Error('Request body deadline')), 5000);
  let bytes = 0; const chunks = [];
  try {
    for await (const chunk of req) {
      bytes += chunk.length; assert(bytes <= limit, 'Model request byte ceiling'); chunks.push(chunk);
    }
    return Buffer.concat(chunks, bytes).toString('utf8');
  } finally { clearTimeout(timer); }
}

// The outer Python remains alive after a controller hard-kill. Linux child
// subreaping adopts independent Pi groups BEFORE dummy env/files are removed.
// Descendant ancestry + pidfd identity, not a controller-provided PID file,
// authorizes each signal. Unknown/unowned PIDs are never signalled.
export const supervisorSource = String.raw`import ctypes, json, os, signal, subprocess, sys, time
root, deadline, *args = sys.argv[1:]
assert sys.platform == 'linux', 'Host fixtures require Linux subreaper'
assert hasattr(os, 'pidfd_open') and hasattr(signal, 'pidfd_send_signal'), 'pidfd support required'
assert ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) == 0, 'subreaper unavailable'
stopping = False
proc = None
seen = {}
reaped = 0
report = {'ok': False, 'remaining': [], 'reaped': 0}
def stop(_sig, _frame):
    global stopping
    stopping = True
signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
def stat(pid):
    try:
        with open('/proc/' + str(pid) + '/stat') as f: fields = f.read().rsplit(')', 1)[1].split()
        return {'pid': pid, 'ppid': int(fields[1]), 'group': int(fields[2]), 'birth': fields[19]}
    except (FileNotFoundError, ProcessLookupError): return None
def owned():
    global stopping
    all = {}
    for name in os.listdir('/proc'):
        if name.isdigit():
            entry = stat(int(name))
            if entry: all[int(name)] = entry
    parents = {os.getpid()}
    result = {}
    for _ in range(len(all) + 1):
        found = {pid: entry for pid, entry in all.items() if entry['ppid'] in parents and pid not in parents}
        if not found: break
        result.update(found); parents.update(found)
    if len(result) > 64:
        stopping = True; report['descendantCeiling'] = True
    for pid, entry in result.items():
        if len(seen) < 64 or str(pid) in seen: seen[str(pid)] = entry
    return result
def send(entry, sig):
    try:
        fd = os.pidfd_open(entry['pid'])
        try:
            current = stat(entry['pid'])
            if current and current['birth'] == entry['birth'] and entry['pid'] in owned():
                signal.pidfd_send_signal(fd, sig)
        finally: os.close(fd)
    except ProcessLookupError: pass
def reap():
    global reaped
    while True:
        try: pid, _status = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError: break
        if not pid: break
        reaped += 1
try:
    proc = subprocess.Popen(args, cwd=root + '/work', env=dict(os.environ), start_new_session=True)
    end = time.monotonic() + float(deadline)
    while proc.poll() is None and not stopping and time.monotonic() < end:
        owned(); time.sleep(0.02)
    timed_out = proc.poll() is None
    # Keep supervising even after a normal controller exit: leaked descendants
    # are cleanup failure, not successful acceptance.
    leaked = bool(owned()) if not timed_out else False
    report.update({'controllerPid': proc.pid, 'timedOut': timed_out, 'leakedAfterExit': leaked})
finally:
    cleanup_end = time.monotonic() + 8
    term_end = time.monotonic() + 3
    while time.monotonic() < cleanup_end:
        members = owned()
        if not members: break
        sig = signal.SIGTERM if time.monotonic() < term_end else signal.SIGKILL
        for entry in members.values(): send(entry, sig)
        if proc and proc.poll() is not None: reap()
        time.sleep(0.02)
    if proc: proc.poll()
    reap()
    remaining = list(owned())
    report.update({'remaining': remaining, 'reaped': reaped, 'seen': list(seen.values()), 'controllerExit': proc.returncode if proc else None})
    report['ok'] = not remaining and not report.get('descendantCeiling', False) and not report.get('timedOut', True) and not report.get('leakedAfterExit', True) and report['controllerExit'] == 0
    with open(root + '/supervisor-result.json', 'w') as f: json.dump(report, f)
if not report['ok']: sys.exit(1)
`;
export function spawnOwnedController(python, args, root, milliseconds) {
  assert.equal(process.platform, 'linux');
  const supervisor = join(root, 'host-supervisor.py');
  writeFileSync(supervisor, supervisorSource);
  rmSync(join(root, 'supervisor-result.json'), { force: true });
  const controller = spawn(python, [supervisor, root, String(milliseconds / 1000), python, ...args], { cwd: join(root, 'work'), env: cleanHostEnvironment(root), stdio: ['ignore', 'pipe', 'pipe'] });
  controller.fixtureRoot = root;
  controller.fixtureClosed = new Promise(resolve => { controller.once('close', resolve); controller.once('error', resolve); });
  let bytes = 0;
  for (const stream of [controller.stdout, controller.stderr]) stream.on('data', chunk => {
    bytes += chunk.length;
    if (bytes > 65536) { controller.fixtureOutputExceeded = true; controller.kill('SIGTERM'); }
  });
  return controller;
}
export async function settleOwnedController(controller) {
  if (!controller) return;
  if (controller.exitCode === null && controller.signalCode === null) controller.kill('SIGTERM');
  let timer;
  try {
    await Promise.race([controller.fixtureClosed, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Supervisor cleanup unsettled: RETAIN isolated resources')), 10000); })]);
  } finally { clearTimeout(timer); }
  const path = join(controller.fixtureRoot, 'supervisor-result.json');
  assert(existsSync(path), 'Missing supervisor cleanup proof: RETAIN isolated resources');
  const report = JSON.parse(readFileSync(path, 'utf8'));
  assert.deepEqual(report.remaining, [], 'Owned descendants remain: RETAIN isolated resources');
  assert(!controller.fixtureOutputExceeded, 'Controller output ceiling exceeded');
}

// Explicit pure regression entry point; never auto-starts when imported by a
// host fixture. Parent may invoke this in its own empty-env temporary directory.
export async function runHostSafetyChecks(root) {
  assertAncestorIsolation(root); cleanHostEnvironment(root);
  const { Readable } = await import('node:stream');
  const net = (await import('node:net')).default;
  const tls = (await import('node:tls')).default;
  const http = (await import('node:http')).default;
  const https = (await import('node:https')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const { pathToFileURL } = await import('node:url');
  const old = { fetch: globalThis.fetch, connect: net.Socket.prototype.connect, tls: tls.connect, http: http.request, httpGet: http.get, https: https.request, httpsGet: https.get };
  let allowedFetch, allowedSocket = 0;
  const guard = join(root, 'fake-guard.mjs');
  try {
    // Spies mean NO connection, HTTP request, TLS handshake or provider startup.
    globalThis.fetch = (_input, init) => { allowedFetch = init; return Promise.resolve('fake'); };
    net.Socket.prototype.connect = function () { allowedSocket++; return this; };
    writeFileSync(guard, guardSource(root, 'http://127.0.0.1:12345'));
    await import(pathToFileURL(guard).href);
    const exact = 'http://127.0.0.1:12345/v1/chat/completions';
    for (const url of ['https://127.0.0.1:12345/v1/chat/completions', 'http://localhost:12345/v1/chat/completions', exact + '?q=1', exact + '#hash', exact + '/other', 'http://user:pass@127.0.0.1:12345/v1/chat/completions']) assert.throws(() => globalThis.fetch(url, { method: 'POST' }));
    assert.throws(() => globalThis.fetch(exact, { method: 'GET' }));
    await globalThis.fetch(new Request(exact, { method: 'POST' }), { redirect: 'follow' });
    assert.equal(allowedFetch.redirect, 'error');
    const socket = new net.Socket();
    assert.throws(() => socket.connect({ host: 'localhost', port: 12345 }));
    assert.throws(() => socket.connect({ host: '127.0.0.1', port: 12346 }));
    assert.throws(() => socket.connect({ path: '/never-owned-socket' }));
    socket.connect([{ host: '127.0.0.1', port: 12345 }, () => {}]); assert.equal(allowedSocket, 1); socket.destroy();
    assert.throws(() => tls.connect({ host: '127.0.0.1', port: 12345 }));
    assert.throws(() => net.Socket.prototype.connect.call(Object.create(tls.TLSSocket.prototype), { host: '127.0.0.1', port: 12345 }));
    assert.throws(() => http.request(exact)); assert.throws(() => https.get(exact));
  } finally {
    globalThis.fetch = old.fetch; net.Socket.prototype.connect = old.connect; tls.connect = old.tls;
    http.request = old.http; http.get = old.httpGet; https.request = old.https; https.get = old.httpsGet; syncBuiltinESMExports();
  }
  const request = (chunks, url = '/v1/chat/completions') => Object.assign(Readable.from(chunks), { method: 'POST', url });
  const unicode = Buffer.from('界界');
  assert.equal(await readFixtureBody(request([unicode.subarray(0, 2), unicode.subarray(2)]), { hits: 0, max: 1 }, 6), '界界');
  await assert.rejects(readFixtureBody(request([unicode]), { hits: 0, max: 1 }, 5));
  const budget = { hits: 0, max: 1 };
  await assert.rejects(readFixtureBody(request([], '/wrong'), budget));
  await assert.rejects(readFixtureBody(request([]), budget)); assert.equal(budget.hits, 2);
  writeFileSync(join(root, 'AGENTS.md'), 'synthetic ancestor contamination');
  try { assert.throws(() => assertAncestorIsolation(join(root, 'nested'))); }
  finally { rmSync(join(root, 'AGENTS.md')); }
  // Deterministic exit-poll interleaving; success becomes visible between polls.
  for (const fixed of [false, true]) {
    let calls = 0; const poll = () => ++calls === 1 ? null : 0, check = () => poll() !== null;
    let accepted = check(); if (!accepted && poll() !== null) accepted = fixed && check();
    assert.equal(accepted, fixed);
  }
  const sibling = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { env: cleanHostEnvironment(root), stdio: 'ignore' });
  const siblingClosed = new Promise(resolve => sibling.once('close', resolve));
  const childCode = 'import signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);time.sleep(15)';
  const head = 'import os,signal,subprocess,sys,time;p=subprocess.Popen([sys.executable,"-c",' + JSON.stringify(childCode) + '],start_new_session=True);time.sleep(.15);';
  const cases = [['normal', 'pass', 'pass'], ['setup', 'fail', 'raise RuntimeError("synthetic setup")'], ['hardkill', 'fail', head + 'os.kill(os.getpid(),signal.SIGKILL)'], ['watchdog', 'fail', head + 'time.sleep(15)']];
  try {
    for (const [name, expected, source] of cases) {
      const caseRoot = join(root, name); mkdirSync(join(caseRoot, 'work'), { recursive: true });
      const path = join(caseRoot, 'controller.py'); writeFileSync(path, source);
      const controller = spawnOwnedController('/usr/bin/python3', [path], caseRoot, 400);
      await controller.fixtureClosed; await settleOwnedController(controller);
      const report = JSON.parse(readFileSync(join(caseRoot, 'supervisor-result.json'), 'utf8'));
      assert.equal(controller.exitCode === 0, expected === 'pass'); assert.deepEqual(report.remaining, []);
      assert.equal(sibling.exitCode, null); assert(!report.seen.some(entry => entry.pid === sibling.pid));
      if (name === 'hardkill' || name === 'watchdog') { assert(report.reaped >= 1); assert(new Set(report.seen.map(entry => entry.group)).size >= 2); }
    }
  } finally { sibling.kill('SIGTERM'); await siblingClosed; }
  return { ok: true, groups: ['exact-fetch-redirect', 'socket-TLS-alternate-HTTP', 'UTF8-byte-body-hit-ceiling', 'ancestor-contamination', 'poll-interleaving', 'normal-setup-hardkill-watchdog-owned-reaping'] };
}
