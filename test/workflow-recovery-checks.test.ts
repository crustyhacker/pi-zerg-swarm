import test from 'node:test';
import assert from 'node:assert/strict';
import { access, chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { constants, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { inspectDurableCheckReceipt, profileHash, runCodingCheck, type CodingCheckProfile, type DurableCheckContext, type DurableCheckProcessIdentity, type DurableCheckReceipt, type DurableCheckSupervisorReady } from '../workflow-checks.js';

const node = process.execPath;
const testDir = dirname(fileURLToPath(import.meta.url));
const checksUrl = pathToFileURL(resolve(testDir, '..', 'workflow-checks.ts')).href;
function hash(text: string): string { return createHash('sha256').update(text).digest('hex'); }
function delay(ms: number): Promise<void> { return new Promise((resolveDelay) => setTimeout(resolveDelay, ms)); }

function baseProfile(dir: string, script = 'check.js', extra: Partial<CodingCheckProfile> = {}): CodingCheckProfile {
  return { id: 'node-check', executable: node, argv: [join(dir, script)], cwd: '.', env: {}, timeoutMs: 2_000, outputBytes: 1024, ...extra };
}

async function waitForFile(path: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { await access(path, constants.F_OK); return; } catch { await delay(10); }
  }
  await access(path, constants.F_OK);
}

async function waitForJson<T>(path: string, timeoutMs = 2_000): Promise<T> {
  await waitForFile(path, timeoutMs);
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

function isIdentityAlive(identity: DurableCheckProcessIdentity): boolean {
  try {
    const boot = readFileSyncUtf8('/proc/sys/kernel/random/boot_id').trim();
    if (boot !== identity.bootId) return false;
    const stat = readFileSyncUtf8(`/proc/${identity.pid}/stat`);
    const close = stat.lastIndexOf(')');
    if (close < 0) throw new Error('invalid owned process stat');
    const fields = stat.slice(close + 2).trim().split(/\s+/);
    if (!/^\d+$/.test(fields[19] ?? '')) throw new Error('unknown owned process start identity');
    return fields[19] === identity.startTime && !['Z', 'X'].includes(fields[0]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return false;
    throw error;
  }
}

function readFileSyncUtf8(path: string): string {
  return readFileSync(path, 'utf8');
}

async function waitUntilIdentityDead(identity: DurableCheckProcessIdentity, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isIdentityAlive(identity)) return;
    await delay(25);
  }
  assert.equal(isIdentityAlive(identity), false, `identity still alive: ${JSON.stringify(identity)}`);
}

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'workflow-recovery-checks-'));
  let succeeded = false;
  try { const result = await fn(dir); succeeded = true; return result; }
  catch (error) { throw new Error(`Check recovery probe failed; evidence retained at ${dir}: ${error instanceof Error ? error.stack?.slice(-8192) ?? error.message : String(error)}`, { cause: error }); }
  finally { if (succeeded) await rm(dir, { recursive: true, force: true }); }
}

async function durableContext(dir: string, overrides: Partial<DurableCheckContext> = {}): Promise<DurableCheckContext> {
  const receiptDir = join(dir, 'receipt-' + Math.random().toString(16).slice(2));
  await mkdir(receiptDir, { recursive: true, mode: 0o700 });
  const ctx: DurableCheckContext = {
    receiptDir,
    markerPath: join(receiptDir, 'marker.json'),
    generation: 'gen-' + Math.random().toString(16).slice(2),
    nonce: 'nonce-' + Math.random().toString(16).slice(2),
    candidateId: 'candidate-a',
    profileId: 'profile-a',
    onIntent: () => {},
    onReceipt: () => {},
    ...overrides,
  };
  await writeFile(ctx.markerPath, JSON.stringify({ generation: ctx.generation, nonce: ctx.nonce, candidateId: ctx.candidateId, profileId: ctx.profileId }) + '\n', { encoding: 'utf8', mode: 0o600 });
  await chmod(ctx.markerPath, 0o600);
  return ctx;
}

async function boundedNode(args: string[], opts: { cwd?: string; timeoutMs?: number } = {}): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  const child = spawn(node, args, { cwd: opts.cwd, env: {}, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  const keep = (current: string, chunk: Buffer) => (current + chunk.toString('utf8')).slice(0, 8192);
  child.stdout.on('data', (chunk: Buffer) => { stdout = keep(stdout, chunk); });
  child.stderr.on('data', (chunk: Buffer) => { stderr = keep(stderr, chunk); });
  const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs ?? 4_000);
  return await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
  });
}

async function waitForOwnedClose(child: ReturnType<typeof spawn>, timeoutMs = 4_000): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
  return await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
}

async function awaitReceipt(ctx: DurableCheckContext, args: { profileHash: string; expectedCandidateHash: string; candidateHashBefore: string; nodeIdentity: DurableCheckProcessIdentity; supervisorIdentity: DurableCheckProcessIdentity }, timeoutMs = 3_000): Promise<DurableCheckReceipt> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const inspected = inspectDurableCheckReceipt({ ...ctx, ...args });
    if (inspected && !('blocked' in inspected)) return inspected;
    await delay(25);
  }
  const inspected = inspectDurableCheckReceipt({ ...ctx, ...args });
  assert.ok(inspected && !('blocked' in inspected), JSON.stringify(inspected));
  return inspected;
}

test('durable admission rechecks after intent and ready publication before command launch', async () => {
  await withTmp(async (dir) => {
    for (const point of ['intent', 'ready'] as const) {
      for (const mutation of ['authority', 'signal', 'candidate', 'generation'] as const) {
        const effect = join(dir, `admission-${point}-${mutation}-effect`);
        await writeFile(join(dir, `admission-${point}-${mutation}.js`), `require('node:fs').writeFileSync(${JSON.stringify(effect)}, 'ran');\n`, 'utf8');
        let candidate = 'candidate';
        let revoked = false;
        const ac = new AbortController();
        const ctx = await durableContext(dir);
        const mutate = () => {
          if (mutation === 'authority') revoked = true;
          if (mutation === 'signal') ac.abort();
          if (mutation === 'candidate') candidate = 'changed';
          if (mutation === 'generation') {
            writeFileSync(ctx.markerPath, JSON.stringify({ generation: ctx.generation + '-changed', nonce: ctx.nonce, candidateId: ctx.candidateId, profileId: ctx.profileId }) + '\n', { encoding: 'utf8', mode: 0o600 });
          }
        };
        const result = await runCodingCheck({
          profile: baseProfile(dir, `admission-${point}-${mutation}.js`, { timeoutMs: 700 }),
          stageRoot: dir,
          expectedCandidateHash: hash('candidate'),
          captureCandidate: () => candidate,
          assertAuthority: () => { if (revoked) throw new Error(`${mutation} admission closed`); },
          signal: ac.signal,
          durable: { ...ctx, onIntent: () => { if (point === 'intent') mutate(); }, onSupervisorReady: () => { if (point === 'ready') mutate(); }, onReceipt: ctx.onReceipt },
        });
        assert.equal(result.passed, false, `${point}/${mutation}: ${JSON.stringify(result)}`);
        assert.notEqual(result.launchPhase, 'child-launched', `${point}/${mutation}: ${JSON.stringify(result)}`);
        await assert.rejects(access(effect, constants.F_OK), `${point}/${mutation} admitted command effect`);
      }
    }
  });
});

test('durable receipt collection reports post-effect authority loss using event marker', async () => {
  await withTmp(async (dir) => {
    const effect = join(dir, 'after-effect-authority-close');
    await writeFile(join(dir, 'effect-authority.js'), `require('node:fs').writeFileSync(${JSON.stringify(effect)}, 'done');\n`, 'utf8');
    const ctx = await durableContext(dir);
    const result = await runCodingCheck({ profile: baseProfile(dir, 'effect-authority.js'), stageRoot: dir, expectedCandidateHash: hash('candidate'), captureCandidate: () => 'candidate', assertAuthority: () => { if (existsSync(effect)) throw new Error('readonly after effect'); }, durable: ctx });
    assert.equal(result.passed, false, JSON.stringify(result));
    assert.equal(result.outcome, 'uncertain', JSON.stringify(result));
    assert.equal(result.launchPhase, 'settled', JSON.stringify(result));
    assert.ok(result.durableReceipt, JSON.stringify(result));
    assert.equal(result.cleanup.outcome, 'ok', JSON.stringify(result));
    assert.equal(await readFile(effect, 'utf8'), 'done');
    assert.match(result.stderr, /authority failed after possible check effect/);
  });
});

test('durable pre-ack parent EOF never admits command effect', { skip: process.platform !== 'linux' }, async () => {
  await withTmp(async (dir) => {
    const effect = join(dir, 'preack-effect');
    const readyFile = join(dir, 'ready.json');
    await writeFile(join(dir, 'child.js'), `require('node:fs').writeFileSync(${JSON.stringify(effect)}, 'ran'); setInterval(()=>{},1000);\n`, 'utf8');
    await writeFile(join(dir, 'driver.mjs'), `import { runCodingCheck } from ${JSON.stringify(checksUrl)};\nimport { mkdirSync, writeFileSync, chmodSync } from 'node:fs';\nimport { join } from 'node:path';\nconst dir=${JSON.stringify(dir)}; const receiptDir=join(dir,'receipt-preack'); mkdirSync(receiptDir,{recursive:true,mode:0o700});\nconst ctx={receiptDir, markerPath:join(receiptDir,'marker.json'), generation:'gen-preack', nonce:'nonce-preack', candidateId:'candidate-a', profileId:'profile-a', onIntent(){}, onSupervisorReady(ready){ writeFileSync(${JSON.stringify(readyFile)}, JSON.stringify(ready)); process.exit(0); }, onReceipt(){}};\nwriteFileSync(ctx.markerPath, JSON.stringify({generation:ctx.generation,nonce:ctx.nonce,candidateId:ctx.candidateId,profileId:ctx.profileId})+'\\n', {mode:0o600}); chmodSync(ctx.markerPath,0o600);\nvoid runCodingCheck({profile:{id:'p', executable:process.execPath, argv:[join(dir,'child.js')], cwd:'.', env:{}, timeoutMs:5000, outputBytes:1024}, stageRoot:dir, expectedCandidateHash:${JSON.stringify(hash('candidate'))}, captureCandidate:()=> 'candidate', assertAuthority(){}, durable:ctx});\n`, 'utf8');
    const close = await boundedNode(['--import', 'tsx', join(dir, 'driver.mjs')], { timeoutMs: 4_000 });
    assert.equal(close.code, 0, JSON.stringify(close));
    const ready = await waitForJson<DurableCheckSupervisorReady>(readyFile);
    await waitUntilIdentityDead(ready.supervisorIdentity);
    await assert.rejects(access(effect, constants.F_OK));
  });
});

test('durable parent death after launch ack records ownership loss and cleanup for owned identities', { skip: process.platform !== 'linux' }, async () => {
  await withTmp(async (dir) => {
    const firstEffect = join(dir, 'first-effect');
    const delayedSurvival = join(dir, 'delayed-survival');
    const childIdentityFile = join(dir, 'child-identity.json');
    const readyFile = join(dir, 'ready.json');
    const parentIdentityFile = join(dir, 'parent-identity.json');
    const unrelated = join(dir, 'unrelated');
    await writeFile(unrelated, 'unchanged', 'utf8');
    await writeFile(join(dir, 'child.js'), `const fs=require('node:fs');\nfunction ident(){ const stat=fs.readFileSync('/proc/'+process.pid+'/stat','utf8').split(') ').pop().trim().split(/\\s+/); return {bootId:fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim(), pid:process.pid, startTime:stat[19]}; }\nfs.writeFileSync(${JSON.stringify(childIdentityFile)}, JSON.stringify(ident()));\nfs.writeFileSync(${JSON.stringify(firstEffect)}, 'done');\nsetTimeout(()=>fs.writeFileSync(${JSON.stringify(delayedSurvival)}, 'survived'), 1200);\nsetInterval(()=>{},1000);\n`, 'utf8');
    await writeFile(join(dir, 'driver.mjs'), `import { runCodingCheck } from ${JSON.stringify(checksUrl)};\nimport { mkdirSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';\nimport { join } from 'node:path';\nfunction ident(){ const stat=readFileSync('/proc/'+process.pid+'/stat','utf8').split(') ').pop().trim().split(/\\s+/); return {bootId:readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim(), pid:process.pid, startTime:stat[19]}; }\nconst dir=${JSON.stringify(dir)}; writeFileSync(${JSON.stringify(parentIdentityFile)}, JSON.stringify(ident()));\nconst receiptDir=join(dir,'receipt-after-ack'); mkdirSync(receiptDir,{recursive:true,mode:0o700});\nconst ctx={receiptDir, markerPath:join(receiptDir,'marker.json'), generation:'gen-after-ack', nonce:'nonce-after-ack', candidateId:'candidate-a', profileId:'profile-a', onIntent(){}, onSupervisorReady(ready){ writeFileSync(${JSON.stringify(readyFile)}, JSON.stringify(ready)); }, onReceipt(){}};\nwriteFileSync(ctx.markerPath, JSON.stringify({generation:ctx.generation,nonce:ctx.nonce,candidateId:ctx.candidateId,profileId:ctx.profileId})+'\\n', {mode:0o600}); chmodSync(ctx.markerPath,0o600);\nvoid runCodingCheck({profile:{id:'p', executable:process.execPath, argv:[join(dir,'child.js')], cwd:'.', env:{}, timeoutMs:5000, outputBytes:1024}, stageRoot:dir, expectedCandidateHash:${JSON.stringify(hash('candidate'))}, captureCandidate:()=> 'candidate', assertAuthority(){}, durable:ctx});\nsetInterval(()=>{},1000);\n`, 'utf8');
    const parent = spawn(node, ['--import', 'tsx', join(dir, 'driver.mjs')], { env: {}, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let parentStdout = ''; let parentStderr = '';
    parent.stdout.on('data', (chunk: Buffer) => { parentStdout = (parentStdout + chunk.toString('utf8')).slice(0, 8192); });
    parent.stderr.on('data', (chunk: Buffer) => { parentStderr = (parentStderr + chunk.toString('utf8')).slice(0, 8192); });
    const parentClosed = waitForOwnedClose(parent, 10000);
    let ready: DurableCheckSupervisorReady | undefined;
    let childIdentity: DurableCheckProcessIdentity | undefined;
    try {
    ready = await waitForJson<DurableCheckSupervisorReady>(readyFile);
    childIdentity = await waitForJson<DurableCheckProcessIdentity>(childIdentityFile);
    await waitForFile(firstEffect);
    const parentIdentity = await waitForJson<DurableCheckProcessIdentity>(parentIdentityFile);
    assert.equal(parent.pid, parentIdentity.pid);
    parent.kill('SIGKILL');
    const close = await parentClosed;
    assert.equal(close.signal, 'SIGKILL', JSON.stringify({ close, parentStdout, parentStderr }));
    const ctx = { receiptDir: join(dir, 'receipt-after-ack'), markerPath: join(dir, 'receipt-after-ack', 'marker.json'), generation: 'gen-after-ack', nonce: 'nonce-after-ack', candidateId: 'candidate-a', profileId: 'profile-a' } as DurableCheckContext;
    const receipt = await awaitReceipt(ctx, { profileHash: profileHash({ id: 'p', executable: node, argv: [join(dir, 'child.js')], cwd: '.', env: {}, timeoutMs: 5000, outputBytes: 1024 }), expectedCandidateHash: hash('candidate'), candidateHashBefore: hash('candidate'), nodeIdentity: ready.nodeIdentity, supervisorIdentity: ready.supervisorIdentity });
    assert.equal(receipt.originalObservation?.ownershipLost, true, JSON.stringify(receipt));
    assert.equal(receipt.cleanup.outcome, 'ok', JSON.stringify(receipt));
    await waitUntilIdentityDead(ready.supervisorIdentity);
    await waitUntilIdentityDead(childIdentity);
    assert.equal(await readFile(firstEffect, 'utf8'), 'done');
    await assert.rejects(access(delayedSurvival, constants.F_OK));
    assert.equal(await readFile(unrelated, 'utf8'), 'unchanged');
    const fresh = await boundedNode(['--import', 'tsx', '-e', `import { inspectDurableCheckReceipt, profileHash } from ${JSON.stringify(checksUrl)}; const r=inspectDurableCheckReceipt({receiptDir:${JSON.stringify(ctx.receiptDir)},markerPath:${JSON.stringify(ctx.markerPath)},generation:'gen-after-ack',nonce:'nonce-after-ack',candidateId:'candidate-a',profileId:'profile-a',profileHash:profileHash({id:'p',executable:process.execPath,argv:[${JSON.stringify(join(dir, 'child.js'))}],cwd:'.',env:{},timeoutMs:5000,outputBytes:1024}),expectedCandidateHash:${JSON.stringify(hash('candidate'))},candidateHashBefore:${JSON.stringify(hash('candidate'))},nodeIdentity:${JSON.stringify(ready.nodeIdentity)},supervisorIdentity:${JSON.stringify(ready.supervisorIdentity)}}); console.log(JSON.stringify(r));`], { timeoutMs: 4_000 });
    assert.equal(fresh.code, 0, JSON.stringify(fresh));
    assert.match(fresh.stdout, /"ownershipLost":true/);
    } finally {
      if (parent.exitCode === null && parent.signalCode === null) parent.kill('SIGKILL');
      await parentClosed;
      if (ready) await waitUntilIdentityDead(ready.supervisorIdentity, 6000);
      if (childIdentity) await waitUntilIdentityDead(childIdentity, 6000);
    }
  });
});

test('durable inspector blocks symlink parent replacement and receipt identity changes', async () => {
  await withTmp(async (dir) => {
    await writeFile(join(dir, 'ok.js'), "process.exit(0);\n", 'utf8');
    const ctx = await durableContext(dir);
    const result = await runCodingCheck({ profile: baseProfile(dir, 'ok.js'), stageRoot: dir, expectedCandidateHash: hash('candidate'), captureCandidate: () => 'candidate', assertAuthority: () => {}, durable: ctx });
    assert.ok(result.durableReceipt, JSON.stringify(result));
    const args = { ...ctx, profileHash: result.profileHash, expectedCandidateHash: result.expectedCandidateHash, candidateHashBefore: result.candidateHashBefore, nodeIdentity: result.durableReceipt!.nodeIdentity, supervisorIdentity: result.durableReceipt!.supervisorIdentity };
    await rm(ctx.receiptDir, { recursive: true, force: true });
    const replacement = join(dir, 'replacement-receipts');
    await mkdir(replacement, { mode: 0o700 });
    await symlink(replacement, ctx.receiptDir);
    const symlinkParent = inspectDurableCheckReceipt(args);
    assert.equal((symlinkParent as { blocked?: boolean })?.blocked, true, JSON.stringify(symlinkParent));
  });
});

function currentTestIdentity(): DurableCheckProcessIdentity {
  const stat = readFileSyncUtf8(`/proc/${process.pid}/stat`);
  const close = stat.lastIndexOf(')');
  const fields = stat.slice(close + 2).trim().split(/\s+/);
  return { bootId: readFileSyncUtf8('/proc/sys/kernel/random/boot_id').trim(), pid: process.pid, startTime: fields[19] };
}

async function writeManualReceipt(ctx: DurableCheckContext, identity: DurableCheckProcessIdentity, overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const receipt: Record<string, unknown> = {
    version: 1,
    launchPhase: 'receipt-written',
    generation: ctx.generation,
    nonce: ctx.nonce,
    candidateId: ctx.candidateId,
    profileId: ctx.profileId,
    profileHash: hash('profile'),
    expectedCandidateHash: hash('candidate'),
    candidateHashBefore: hash('candidate'),
    commandStarted: true,
    commandCompleted: true,
    commandOutcome: { exitCode: 0, signal: null, timedOut: false, cancelled: false },
    cleanup: { attempted: false, outcome: 'ok' },
    originalObservation: { parentEofObserved: false, ownershipLost: false, uncertain: false },
    supervisorIdentity: identity,
    nodeIdentity: identity,
    receiptPath: join(ctx.receiptDir, `${ctx.generation}.receipt.json`),
    ...overrides,
  };
  await writeFile(receipt.receiptPath as string, JSON.stringify(receipt) + '\n', { encoding: 'utf8', mode: 0o600 });
  await chmod(receipt.receiptPath as string, 0o600);
  return receipt;
}

test('durable receipt inspector enforces strict malformed type and identity schema', async () => {
  await withTmp(async (dir) => {
    const identity = currentTestIdentity();
    for (const malformed of [
      { cleanup: { attempted: 'yes', outcome: 'ok' } },
      { originalObservation: { parentEofObserved: 'false', ownershipLost: false, uncertain: false } },
      { nodeIdentity: { ...identity, bootId: 'not-a-uuid' } },
      { nodeIdentity: { ...identity, startTime: '12x' } },
      { nodeIdentity: { ...identity, pid: 4_194_305 } },
      { commandStarted: false, commandCompleted: true },
      { commandStarted: true, commandCompleted: true, commandOutcome: undefined },
      { approved: true },
      { outcome: 'passed' },
    ]) {
      const ctx = await durableContext(dir);
      const receipt = await writeManualReceipt(ctx, identity, malformed);
      const inspected = inspectDurableCheckReceipt({ ...ctx, profileHash: receipt.profileHash as string, expectedCandidateHash: receipt.expectedCandidateHash as string, candidateHashBefore: receipt.candidateHashBefore as string, nodeIdentity: identity, supervisorIdentity: identity });
      assert.equal((inspected as { blocked?: boolean })?.blocked, true, JSON.stringify({ malformed, inspected }));
    }
  });
});

test('durable receipt inspector accepts never-admitted settled receipt without result authority', async () => {
  await withTmp(async (dir) => {
    const identity = currentTestIdentity();
    const ctx = await durableContext(dir);
    const receipt = await writeManualReceipt(ctx, identity, { commandStarted: false, commandCompleted: false, commandOutcome: undefined, cleanup: { attempted: false, outcome: 'not_needed' } });
    const inspected = inspectDurableCheckReceipt({ ...ctx, profileHash: receipt.profileHash as string, expectedCandidateHash: receipt.expectedCandidateHash as string, candidateHashBefore: receipt.candidateHashBefore as string, nodeIdentity: identity, supervisorIdentity: identity });
    assert.ok(inspected && !('blocked' in inspected), JSON.stringify(inspected));
    assert.equal((inspected as DurableCheckReceipt).commandStarted, false);
    assert.equal((inspected as DurableCheckReceipt).cleanup.outcome, 'not_needed');
  });
});

test('durable receipt inspector rechecks actual marker generation source file', async () => {
  await withTmp(async (dir) => {
    const identity = currentTestIdentity();
    const ctx = await durableContext(dir);
    const receipt = await writeManualReceipt(ctx, identity);
    await writeFile(ctx.markerPath, JSON.stringify({ generation: ctx.generation + '-mutated', nonce: ctx.nonce, candidateId: ctx.candidateId, profileId: ctx.profileId }) + '\n', { encoding: 'utf8', mode: 0o600 });
    await chmod(ctx.markerPath, 0o600);
    const inspected = inspectDurableCheckReceipt({ ...ctx, profileHash: receipt.profileHash as string, expectedCandidateHash: receipt.expectedCandidateHash as string, candidateHashBefore: receipt.candidateHashBefore as string, nodeIdentity: identity, supervisorIdentity: identity });
    assert.equal((inspected as { blocked?: boolean })?.blocked, true, JSON.stringify(inspected));
  });
});
