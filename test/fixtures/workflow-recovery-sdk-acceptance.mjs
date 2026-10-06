// Driver owns the model HTTP transport and independently closes the crash
// evidence. It never calls a recovery authority and never edits a snapshot.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { guardSource, readFixtureBody } from './host-fixture-safety.mjs';
import { workflowHash } from '../../workflow-model.ts';

const [root, mode, piPackage] = process.argv.slice(2);
assert(['sdk', 'regular', 'fullscreen'].includes(mode));
const ownedRoot = lstatSync(root);
const parentApproval = JSON.parse(readFileSync(join(root, 'evidence/parent-approval.json'), 'utf8'));
assert(ownedRoot.isDirectory() && !ownedRoot.isSymbolicLink() && realpathSync(root) === root && (ownedRoot.mode & 0o077) === 0 && ownedRoot.uid === process.getuid());
assert.deepEqual(parentApproval, { guard: 'parent-approved', root, uid: ownedRoot.uid, dev: ownedRoot.dev, ino: ownedRoot.ino }, 'parent-approved guard propagated as isolated root capability, not inherited credentials');
assert.equal(JSON.parse(readFileSync(join(piPackage, 'package.json'), 'utf8')).version, '1.0.2', 'Pin installed Pi 1.0.2, never install/fallback');
const require = createRequire(import.meta.url);
const loader = require.resolve('tsx');
const fixture = fileURLToPath(new URL('./workflow-recovery-host-fixture.ts', import.meta.url));
const python = fileURLToPath(new URL('./workflow-recovery-host-pty.py', import.meta.url));
const sdk = pathToFileURL(join(piPackage, 'dist/index.js')).href;
const cli = join(piPackage, 'dist/bundle/cli.js');
const sourceRoot = fileURLToPath(new URL('../../', import.meta.url));
const sha = v => createHash('sha256').update(v).digest('hex');
const read = n => JSON.parse(readFileSync(join(root, 'evidence', n), 'utf8'));
const put = (n, v) => writeFileSync(join(root, 'evidence', n), JSON.stringify(v, null, 2));
const sleep = ms => new Promise(r => setTimeout(r, ms));
function sourceHashes() { return Object.fromEntries(['index.ts', 'types.ts', 'state.ts', 'persistence.ts', 'workflow-model.ts', 'workflow-runtime.ts', 'workflow-recovery.ts', 'workflow-workspace.ts', 'workflow-checks.ts', 'workflow-check-supervisor.py', 'workflow-native-tools.ts', 'ui/workflow-overlay.ts'].map(p => [p, sha(readFileSync(join(sourceRoot, p)))])); }
const sourceBefore = sourceHashes();
let controller, controllerClosed = false, failure;
const diagnostics = [];
const sockets = new Set(), responses = new Set(), requests = [], oldIds = [];
let responseBytes = 0, heldClosed = false, heldResponse;
const budget = { hits: 0, max: 24 };
let stage = 'old';
const server = createServer(async (req, res) => {
  responses.add(res); res.once('close', () => { responses.delete(res); if (res === heldResponse) heldClosed = true; });
  try {
    const input = JSON.parse(await readFixtureBody(req, budget, 524288));
    assert.equal(req.headers.authorization, 'Bearer dummy-recovery-only');
    assert.equal(input.stream, true);
    if (stage === 'fresh') { assert(existsSync(join(root, 'evidence/implementation-approved.json')), 'zero HTTP work before separate implementation approval'); const approved = read('implementation-approved.json'), pending = read('implementation.json'); assert.equal(approved.id, pending.id); assert.equal(approved.hash, pending.requestHash); }
    const id = requests.length + 1;
    const tools = (input.tools ?? []).map(t => t.function.name).sort();
    const rows = input.messages.filter(m => m.role === 'tool');
    const text = r => typeof r.content === 'string' ? r.content : r.content.map(b => b.text ?? '').join('');
    const calls = new Map(input.messages.filter(m => m.role === 'assistant').flatMap(m => m.tool_calls ?? []).map(c => [c.id, c]));
    for (const r of rows) assert(calls.has(r.tool_call_id), 'genuine native tool responses');
    let tool, answer;
    if (input.model === 'writer') {
      assert.deepEqual(tools, ['workflow_stage_inspect', 'workflow_stage_read', 'workflow_stage_write']);
      if (rows.length === 0) tool = ['workflow_stage_read', { path: 'src/bug.js' }];
      else if (rows.length === 1) {
        assert(text(rows[0]).includes(stage === 'old' ? 'export const value = 1;' : 'export const value = 2;'), 'fresh native writer reads actual retained candidate, not replayed original');
        tool = ['workflow_stage_write', { path: 'src/bug.js', text: `export const value = ${stage === 'old' ? 2 : 3};\n` }];
      } else if (rows.length === 2) {
        assert(text(rows[1]).includes('staged write accepted'));
        if (stage === 'old') {
          heldResponse = res; requests.push({ id, stage, model: input.model, rows: rows.length, tools, calls: [...calls.values()] }); oldIds.push(id);
          res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': controlled stream held after actual stage write\n\n');
          put('http-count.json', { requests: requests.length });
          put('held.json', { requestId: id, exactStageWriteObserved: true }); return;
        }
        tool = ['workflow_stage_inspect', {}];
      } else { assert.equal(rows.length, 3); answer = JSON.stringify({ status: 'fresh-writer-complete' }); }
    } else {
      assert.equal(input.model, 'reviewer');
      assert.equal(stage, 'fresh', 'review cannot start in old process');
      assert.deepEqual(tools, ['workflow_stage_inspect', 'workflow_stage_read']);
      if (rows.length === 0) tool = ['workflow_stage_read', { path: 'src/bug.js' }];
      else { assert.equal(rows.length, 1); assert(text(rows[0]).includes('export const value = 3;')); answer = JSON.stringify({ verdict: 'pass', findings: [] }); }
    }
    requests.push({ id, stage, model: input.model, rows: rows.length, tools, calls: [...calls.values()], issued: tool ?? null });
    if (stage === 'old') oldIds.push(id);
    put('http-count.json', { requests: requests.length });
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const emit = (delta, finish_reason = null) => { const packet = 'data: ' + JSON.stringify({ id: 'recovery-' + id, object: 'chat.completion.chunk', created: 1, model: input.model, choices: [{ index: 0, delta, finish_reason }] }) + '\n\n'; responseBytes += Buffer.byteLength(packet); assert(responseBytes <= 1048576); res.write(packet); };
    emit({ role: 'assistant' });
    if (tool) { emit({ tool_calls: [{ index: 0, id: 'recovery-call-' + id, type: 'function', function: { name: tool[0], arguments: JSON.stringify(tool[1]) } }] }); emit({}, 'tool_calls'); }
    else { emit({ content: answer }); emit({}, 'stop'); }
    res.end('data: [DONE]\n\n');
  } catch (error) { failure ??= error; put('server-failure.json', { error: String(error.stack ?? error).slice(-8000) }); res.destroy(); }
});
server.on('connection', s => { sockets.add(s); s.once('close', () => sockets.delete(s)); });
server.on('clientError', (_e, s) => s.destroy());
async function until(check, label) {
  const end = Date.now() + 55_000;
  while (Date.now() < end) { if (failure) throw failure; if (await check()) return; if (controllerClosed) throw Error('Controller closed before ' + label); await sleep(20); }
  throw Error('Driver deadline: ' + label);
}
try {
  for (const p of ['work/src', 'stage', 'agent', 'evidence', 'home', 'tmp', 'xdg']) mkdirSync(join(root, p), { recursive: true, mode: 0o700 });
  writeFileSync(join(root, 'work/src/bug.js'), 'export const value = 1;\n');
  writeFileSync(join(root, 'work/src/untouched.txt'), 'UNRELATED_USER_BYTES\n');
  const settings = { packages: [], extensions: ['-builtin:mcp', '-builtin:llama.cpp', '-builtin:codemode', '-builtin:tool-search'], skills: [], prompts: [], themes: [], noThemes: true, defaultProjectTrust: 'never', enableInstallTelemetry: false, enableAnalytics: false, cacheWarming: 'off', compaction: { enabled: false }, retry: { enabled: false } };
  writeFileSync(join(root, 'agent/settings.json'), JSON.stringify(settings)); writeFileSync(join(root, 'agent/auth.json'), '{}');
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = 'http://127.0.0.1:' + server.address().port;
  writeFileSync(join(root, 'agent/models.json'), JSON.stringify({ providers: { fixture: { api: 'openai-completions', baseUrl: origin + '/v1', apiKey: 'dummy-recovery-only', models: ['writer', 'reviewer'].map(id => ({ id, reasoning: false, input: ['text'], contextWindow: 65536, maxTokens: 2048 })) } } }));
  // Fixture-local preload pins *source* SDK imports too; production remains read-only.
  // registerHooks covers native ESM and jiti's require, with no dependency install.
  const mapped = { '@earendil-works/pi-coding-agent': sdk, '@earendil-works/pi-tui': pathToFileURL(join(piPackage, '../pi-tui/dist/index.js')).href };
  writeFileSync(join(root, 'preload.mjs'), guardSource(root, origin) + `\nimport {registerHooks} from 'node:module';\nconst mapped=${JSON.stringify(mapped)};\nregisterHooks({resolve(specifier,context,next){if(mapped[specifier])return {url:mapped[specifier],shortCircuit:true};return next(specifier,context);}});\n`);
  put('source-fingerprint.json', { sourceRoot, hashes: sourceBefore, pinnedPiPackage: piPackage, piVersion: '1.0.2' });
  put('config.json', { root, mode, origin, sdk, cli, fixture, python, loader, node: process.execPath, piVersion: '1.0.2' });
  controller = spawn('/usr/bin/python3', [python, root], { cwd: join(root, 'work'), env: { PATH: '/usr/bin:/bin', HOME: join(root, 'home'), TMPDIR: join(root, 'tmp'), LANG: 'C.UTF-8' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let bytes = 0;
  for (const s of [controller.stdout, controller.stderr]) s.on('data', c => { bytes += c.length; if (bytes <= 65536) diagnostics.push(c); else { failure ??= Error('Controller output ceiling'); controller.kill('SIGTERM'); } });
  const closed = new Promise(resolve => { controller.once('close', () => { controllerClosed = true; resolve(); }); controller.once('error', error => { failure ??= error; controllerClosed = true; resolve(); }); });
  await until(() => existsSync(join(root, 'evidence/old-closed.json')), 'real old process SIGKILL + wait + owned work closure');
  const old = read('old.json'), dead = read('old-closed.json');
  assert.deepEqual(dead.identity, old.identity); assert.equal(dead.processExit, -9); assert.deepEqual(dead.remaining, []);
  await until(() => heldClosed && responses.size === 0 && sockets.size === 0, 'all old HTTP/native sockets close');
  assert.equal(oldIds.length, 3);
  assert.equal(sha(readFileSync(join(root, 'snapshot.json'))), old.snapshotHash, 'actual old durable snapshot, no metadata repair');
  const proof = { version: 1, transport: 'owned-sealed-loopback-sdk-v1', origin, bindingHash: workflowHash(old.binding), binding: old.binding, nativeReferenceHash: workflowHash(old.reference), identity: old.identity, processExit: dead.processExit, kernel: dead.kernel, remaining: dead.remaining, owned: dead.owned, sealedSessionId: old.sessions[0].id, sealedSessionFile: old.sessions[0].file, exactStageWriteObserved: read('held.json').exactStageWriteObserved, oldHttp: { active: responses.size, sockets: sockets.size, heldClosed, requestIds: oldIds }, closedAt: new Date().toISOString() };
  put('closed-proof.json', proof); stage = 'fresh'; put('launch-fresh.json', { approvedTransportClosure: true });
  await closed;
  writeFileSync(join(root, 'evidence/controller.log'), Buffer.concat(diagnostics));
  const pty = read('pty-result.json');
  assert.equal(controller.exitCode, 0, JSON.stringify(pty)); assert(!failure);
  assert(!existsSync(join(root, 'network-refused.txt')), 'no attempted nonpinned endpoint');
  assert.equal(read('result.json').ok, true);
  assert.equal(requests.length, 9, 'old 3 + fresh writer 4 + distinct readonly review 2');
  assert.deepEqual(requests.filter(r => r.issued?.[0] === 'workflow_stage_write').map(r => r.issued[1].text), ['export const value = 2;\n', 'export const value = 3;\n'], 'no duplicated/replayed old native stagewrite');
  assert.deepEqual(sourceHashes(), sourceBefore, 'READONLY mirror changed during acceptance; rerun after parent freeze');
  put('transport.json', { requests, responseBytes, oldProof: proof, sourceHashes: sourceBefore, ok: true });
  console.log('PASS workflow recovery acceptance ' + mode + '; requests=' + requests.length + '; evidence=' + join(root, 'evidence'));
} catch (error) { put('driver-failure.json', { error: String(error.stack ?? error).slice(-18000) }); throw error; }
finally {
  if (controller && !controllerClosed) { controller.kill('SIGTERM'); await Promise.race([new Promise(r => controller.once('close', r)), sleep(10_000)]); assert(controllerClosed, 'retain sandbox: controller cleanup unsettled'); }
  writeFileSync(join(root, 'evidence/controller.log'), Buffer.concat(diagnostics));
  server.closeAllConnections(); if (server.listening) await new Promise(r => server.close(r));
  assert.equal(sockets.size, 0, 'all model sockets closed'); assert.equal(responses.size, 0, 'all model responses closed');
  put('socket-cleanup.json', { listening: server.listening, sockets: sockets.size, responses: responses.size });
  // Retain bounded synthetic evidence only, after owned-process closure.
  const closure = existsSync(join(root, 'evidence/pty-result.json')) ? read('pty-result.json') : null;
  const ownedWorkClosed = controllerClosed && Array.isArray(closure?.remaining) && closure.remaining.length === 0;
  if (ownedWorkClosed) { const currentRoot = lstatSync(root); assert(currentRoot.dev === ownedRoot.dev && currentRoot.ino === ownedRoot.ino && currentRoot.uid === ownedRoot.uid && !currentRoot.isSymbolicLink(), 'root ownership changed: retain resources'); for (const n of readdirSync(root)) if (n !== 'evidence' && n !== 'supervisor-result.json') rmSync(join(root, n), { recursive: true, force: true }); }
  else put('retained-resources.json', { reason: 'owned controller closure evidence missing or unsettled; do not delete sandbox before outer supervisor settles' });
}
