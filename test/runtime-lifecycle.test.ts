import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { createZergControl, registerZergSwarmExtension } from '../index.js';
import { createZergPersistenceManager } from '../persistence.js';
import { applyRuntimeTransition, createZergState, createZergStateContainer, getZergLogs, readSharedZergState, replaceSharedZergState, upsertTask } from '../state.js';
import type { ZergState, ZergStateContainer, ZergSubagentControlAdapter } from '../types.js';

const ids = { runId: () => 'zerg-runtime-test', taskId: () => 'task-runtime-test' };
const seed = () => createZergState({ agentDefinitions: { worker: { id: 'worker', label: 'Worker', prompt: 'Literal task only.', source: 'runtime' } } });
const fakeAdapter = (launch: ZergSubagentControlAdapter['launch'] = () => ({ ok: true, message: 'accepted' })): ZergSubagentControlAdapter => ({ kind: 'fake', launch });

for (const method of ['replace', 'update'] as const) {
  test(`control persistence saves canonical state after reentrant ${method}`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'zerg-runtime-persist-'));
    const container = createZergStateContainer(seed());
    const snapshotFile = join(root, 'state.json');
    const control = createZergControl(container, { persistence: { snapshotFile }, subagentAdapter: fakeAdapter() });
    let reentered = false;
    const unsubscribe = container.subscribe!(() => {
      if (reentered) return;
      reentered = true;
      const current = container.read();
      container.replace({ ...current, mode: { ...current.mode, readOnly: true } });
    });
    try {
      if (method === 'replace') {
        await control.execute({ action: 'agents.create', id: 'extra', prompt: 'Extra.' });
      } else {
        // Exercise the owning wrapper's update, which public actions rarely use.
        const wrapped = extractControlPersistenceWrapper(container, snapshotFile);
        wrapped.update({ mode: { ...container.read().mode, readOnly: false } });
      }
      const saved = JSON.parse(readFileSync(snapshotFile, 'utf8')) as { state: ZergState };
      assert.equal(container.read().mode.readOnly, true);
      assert.equal(saved.state.mode.readOnly, true);
    } finally {
      unsubscribe();
      control.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

// Pure exact-source extraction avoids adding public test seams or starting SDKs.
const indexSource = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
const parsed = ts.createSourceFile('index.ts', indexSource, ts.ScriptTarget.ES2022, true);
function declaration(name: string, ownerName: string): ts.VariableDeclaration {
  let found: ts.VariableDeclaration | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) found = node;
    ts.forEachChild(node, visit);
  };
  const owner = parsed.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === ownerName);
  assert.ok(owner, `Exact source owner missing: ${ownerName}`);
  visit(owner);
  assert.ok(found, `Exact source declaration missing: ${name}`);
  return found;
}
function compileExpression(node: ts.Node, parameters: string[]): (...args: unknown[]) => unknown {
  const source = `const extracted = ${node.getText(parsed)};`;
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  return new Function(...parameters, `${js}\nreturn extracted;`) as (...args: unknown[]) => unknown;
}
function extractControlPersistenceWrapper(container: ZergStateContainer, snapshotFile: string): ZergStateContainer {
  const initializer = declaration('container', 'createZergControl').initializer;
  assert.ok(initializer && ts.isConditionalExpression(initializer));
  const make = compileExpression(initializer.whenTrue, ['baseContainer', 'persistenceManager', 'options']);
  // Use the actual persistence implementation, not a handwritten save stand-in.
  return make(container, createPersistence(snapshotFile), {}) as ZergStateContainer;
}
function createPersistence(snapshotFile: string) { return createZergPersistenceManager({ snapshotFile }); }

for (const method of ['replace', 'update'] as const) {
  test(`registration persistence wrapper saves canonical reentrant ${method}`, () => {
    const root = mkdtempSync(join(tmpdir(), 'zerg-runtime-registration-'));
    const container = createZergStateContainer(seed());
    const snapshotFile = join(root, 'state.json');
    const initializer = declaration('syncedStateContainer', 'registerZergSwarmExtension').initializer;
    assert.ok(initializer);
    const make = compileExpression(initializer, ['stateContainer', 'persistenceManager', 'options', 'syncSharedStateFromContainer']);
    let shared: ZergState | undefined;
    const wrapped = make(container, createPersistence(snapshotFile), {}, () => { shared = container.snapshot(); }) as ZergStateContainer;
    let reentered = false;
    const unsubscribe = container.subscribe!(() => {
      if (reentered) return;
      reentered = true;
      const state = container.read();
      container.replace({ ...state, mode: { ...state.mode, readOnly: true } });
    });
    try {
      const result = wrapped[method](container.snapshot());
      assert.equal(result.mode.readOnly, true);
      assert.equal(shared?.mode.readOnly, true);
      assert.equal((JSON.parse(readFileSync(snapshotFile, 'utf8')) as { state: ZergState }).state.mode.readOnly, true);
    } finally { unsubscribe(); rmSync(root, { recursive: true, force: true }); }
  });
}

for (const revoke of ['readonly', 'disposed', 'cancelled', 'cancelling'] as const) {
  test(`run rechecks canonical ${revoke} after observable publication`, async () => {
    const container = createZergStateContainer(seed());
    let launches = 0;
    const control = createZergControl(container, { idFactory: ids, subagentAdapter: fakeAdapter(() => { launches++; return { ok: true, message: 'accepted' }; }) });
    let reentered = false;
    const unsubscribe = container.subscribe!((state) => {
      if (reentered || !state.tasks[ids.taskId()]) return;
      reentered = true;
      if (revoke === 'readonly') container.replace({ ...state, mode: { ...state.mode, readOnly: true } });
      else if (revoke === 'disposed') container.replace({ ...state, lifecycle: 'disposed' });
      else {
        const status = revoke === 'cancelled' ? 'cancelled' : 'running';
        const cancelled = applyRuntimeTransition(state, { entity: 'agent', action: 'progress', id: ids.runId(), kind: 'subagent', status, substate: revoke, substateReason: 'subscriber cancelled' });
        container.replace(upsertTask(cancelled, { ...state.tasks[ids.taskId()]!, status, substate: revoke }));
      }
    });
    try {
      const result = await control.execute({ action: 'run', agent: 'worker', task: 'Never start.', background: true });
      assert.equal(result.ok, false);
      assert.equal(launches, 0);
      const expected = revoke === 'cancelled' || revoke === 'cancelling' ? 'cancelled' : 'failed';
      assert.equal(container.read().agents[ids.runId()]?.status, expected);
      assert.equal(container.read().tasks[ids.taskId()]?.status, expected);
    } finally { unsubscribe(); control.dispose(); }
  });
}

for (const outcome of ['reject', 'throw', 'cancel-reject', 'cancel-throw'] as const) {
  test(`launch ${outcome} terminalizes without reviving cancelled authority`, async () => {
    const container = createZergStateContainer(seed());
    const adapter = fakeAdapter(() => {
      if (outcome.startsWith('cancel')) {
        const state = container.read();
        container.replace(upsertTask(applyRuntimeTransition(state, { entity: 'agent', action: 'fail', id: ids.runId(), kind: 'subagent', status: 'cancelled', substate: 'cancelled', substateReason: 'cancelled during adapter launch' }), { ...state.tasks[ids.taskId()]!, status: 'cancelled', substate: 'cancelled' }));
      }
      if (outcome.endsWith('throw')) throw new Error('original startup fault');
      return { ok: false, message: 'original rejected launch' };
    });
    const control = createZergControl(container, { idFactory: ids, subagentAdapter: adapter });
    try {
      const result = await control.execute({ action: 'run', agent: 'worker', task: 'Fail deterministically.', background: true });
      assert.equal(result.ok, false);
      assert.equal(result.error?.code, 'launch_failed');
      assert.match(result.error?.message ?? '', /original/);
      assert.equal(result.runId, ids.runId());
      assert.equal(result.taskId, ids.taskId());
      if (outcome.endsWith('throw')) assert.match(result.output ?? '', /execution may have started.*no automatic retry/);
      const expected = outcome.startsWith('cancel') ? 'cancelled' : outcome === 'throw' ? 'needs-attention' : 'failed';
      assert.equal(container.read().agents[ids.runId()]?.status, expected);
      assert.equal(container.read().tasks[ids.taskId()]?.status, expected);
      if (expected === 'cancelled') assert.equal(container.read().agents[ids.runId()]?.runtime?.substateReason, 'cancelled during adapter launch');
    } finally { control.dispose(); }
  });
}

test('throw after observed completion preserves done and task identity without claiming launch never executed', async () => {
  const container = createZergStateContainer(seed());
  const control = createZergControl(container, { idFactory: ids, subagentAdapter: fakeAdapter(() => {
    const state = container.read();
    container.replace(upsertTask(applyRuntimeTransition(state, { entity: 'agent', action: 'stop', id: ids.runId(), kind: 'subagent', status: 'done', substate: 'completed', substateReason: 'observed completion' }), { ...state.tasks[ids.taskId()]!, status: 'done', substate: 'completed' }));
    throw new Error('post-completion adapter fault');
  }) });
  try {
    const result = await control.execute({ action: 'run', agent: 'worker', task: 'Complete before error.', background: true });
    assert.equal(result.ok, false);
    assert.equal(result.runId, ids.runId());
    assert.equal(result.taskId, ids.taskId());
    assert.match(result.output ?? '', /post-completion adapter fault/);
    assert.equal(container.read().agents[ids.runId()]?.status, 'done');
    assert.equal(container.read().agents[ids.runId()]?.runtime?.substateReason, 'observed completion');
    assert.equal(container.read().tasks[ids.taskId()]?.status, 'done');
  } finally { control.dispose(); }
});
test('legacy messages obey readonly and pre-aborted signals, preserving literal supported delivery', async () => {
  const container = createZergStateContainer(seed());
  const deliveries: unknown[][] = [];
  const adapter = fakeAdapter();
  adapter.sendMessage = (...args) => { deliveries.push(args); return { ok: true, targetId: args[0], runId: args[2], status: 'queued', message: 'queued' }; };
  const control = createZergControl(container, { subagentAdapter: adapter });
  const action = { action: 'message' as const, targetId: 'worker', runId: 'legacy-run', body: ' literal\nbody ', mode: 'followUp' as const };
  try {
    const state = container.read();
    container.replace({ ...state, mode: { ...state.mode, readOnly: true } });
    assert.equal((await control.execute(action)).error?.code, 'read_only');
    container.replace(state);
    const abort = new AbortController(); abort.abort();
    assert.equal((await control.execute(action, abort.signal)).error?.code, 'request_cancelled');
    assert.equal(deliveries.length, 0);
    assert.equal((await control.execute(action)).ok, true);
    assert.deepEqual(deliveries, [['worker', ' literal\nbody ', 'legacy-run', 'followUp']]);
  } finally { control.dispose(); }
});

function eventBus(throwFirst = false) {
  const listeners = new Map<string, Set<(...args: unknown[]) => unknown>>();
  const attempts: string[] = [];
  return {
    listeners, attempts,
    emit(name: string, ...args: unknown[]) { for (const handler of listeners.get(name) ?? []) handler(...args); },
    on(name: string, handler: (...args: unknown[]) => unknown) {
      const set = listeners.get(name) ?? new Set(); listeners.set(name, set); set.add(handler);
      return () => {
        attempts.push(name);
        if (throwFirst && name === 'subagent:slash:started') throw new Error('external unsubscribe fault');
        set.delete(handler);
      };
    },
  };
}

for (const failAt of ['command', 'shutdown-hook'] as const) {
  test(`startup rollback cleans created adapter on ${failAt} failure and preserves original error`, () => {
    const shared = readSharedZergState();
    const bus = eventBus();
    const fault = new Error('original registration fault');
    try {
      assert.throws(() => registerZergSwarmExtension({
        events: bus,
        ...(failAt === 'shutdown-hook' ? { on() { throw fault; } } : {}),
        registerCommand() { throw fault; },
      }), (error) => error === fault);
      for (const name of ['subagent:slash:started', 'subagent:slash:update', 'subagent:slash:response']) assert.equal(bus.listeners.get(name)?.size, 0);
      assert.equal(bus.attempts.length, 3);
    } finally { replaceSharedZergState(shared); }
  });
}

test('startup rollback attempts supplied adapter disposal even when it throws', () => {
  const shared = readSharedZergState();
  const fault = new Error('startup fault');
  let disposed = 0;
  const adapter = fakeAdapter();
  adapter.dispose = () => { disposed++; throw new Error('rollback fault'); };
  try {
    assert.throws(() => registerZergSwarmExtension({ registerCommand() { throw fault; } }, { subagentAdapter: adapter }), (error) => error === fault);
    assert.equal(disposed, 1);
  } finally { replaceSharedZergState(shared); }
});

test('throwing bridge unsubscriber does not block other cleanup; fault remains truthful and disposal idempotent', () => {
  const shared = readSharedZergState();
  const bus = eventBus(true);
  const registration = registerZergSwarmExtension({ events: bus, registerCommand() { return { dispose() {} }; } });
  try {
    assert.throws(() => registration.dispose(), /external unsubscribe fault/);
    assert.deepEqual(bus.attempts, ['subagent:slash:started', 'subagent:slash:update', 'subagent:slash:response']);
    assert.equal(bus.listeners.get('subagent:slash:started')?.size, 1, 'faulty external unsubscribe itself did not remove listener');
    assert.equal(bus.listeners.get('subagent:slash:update')?.size, 0);
    assert.equal(bus.listeners.get('subagent:slash:response')?.size, 0);
    assert.doesNotThrow(() => registration.dispose());
    assert.equal(bus.attempts.length, 3);
  } finally { registration.dispose(); replaceSharedZergState(shared); }
});

test('native abort isolates sync throws and async rejections and still signals siblings without SDK startup', async () => {
  const functionNode = parsed.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'requestPiNativeAbort');
  assert.ok(functionNode);
  const js = ts.transpileModule(functionNode.getText(parsed), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const abort = new Function('workflowActiveAdmissions', `${js}\nreturn requestPiNativeAbort;`)(new WeakMap()) as (id: string, runs: Map<string, unknown>) => { ok: boolean; message: string };
  const calls: string[] = [];
  const active = { cancelRequested: false, sessions: new Set([
    { abort() { calls.push('sync'); throw new Error('sync abort fault'); } },
    { abort() { calls.push('async'); return Promise.reject(new Error('async abort fault')); } },
    { abort() { calls.push('sibling'); } },
  ]) };
  const result = abort('run', new Map([['run', active]]));
  assert.equal(result.ok, true);
  assert.equal(active.cancelRequested, true);
  assert.deepEqual(calls, ['sync', 'async', 'sibling']);
  assert.match(result.message, /2 native session\(s\)/);
  assert.match(result.message, /1 native abort callback\(s\) threw/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(abort('missing', new Map()).ok, false);
});

for (const revoke of ['signal', 'owner-dispose'] as const) {
  test(`dispatch publication rechecks private ${revoke} before injected launch`, async () => {
    const container = createZergStateContainer(seed());
    const abort = new AbortController();
    let launches = 0;
    const control = createZergControl(container, { idFactory: ids, subagentAdapter: fakeAdapter(() => { launches++; return { ok: true, message: 'accepted' }; }) });
    let fired = false;
    const unsubscribe = container.subscribe!((state) => {
      if (fired || !state.tasks[ids.taskId()]) return;
      fired = true;
      if (revoke === 'signal') abort.abort(); else control.dispose();
    });
    try {
      const result = await control.execute({ action: 'run', agent: 'worker', task: 'Never launch.', background: true }, abort.signal);
      assert.equal(fired, true);
      assert.equal(result.ok, false);
      assert.equal(result.runId, ids.runId());
      assert.equal(result.taskId, ids.taskId());
      assert.equal(launches, 0);
      assert.equal(container.read().agents[ids.runId()]?.status, revoke === 'signal' ? 'cancelled' : 'failed');
    } finally { unsubscribe(); control.dispose(); }
  });
}

// Fake monitor is a public subscription surface for the registration-owned
// bridge container. No test seam, actual Pi host, resource loader or SDK starts.
for (const lane of ['native', 'bridge', 'fallback'] as const) {
  for (const revoke of ['readonly', 'signal', 'owner-dispose', 'cancelled', 'cancelling'] as const) {
    if (lane !== 'native' && revoke === 'cancelling') continue; // Public bridge interrupt is immediately cancelled.
    test(`${lane} publication rechecks ${revoke} before request delivery/native runner`, { timeout: 5_000 }, async () => {
      const shared = readSharedZergState();
      const container = createZergStateContainer(seed());
      const abort = new AbortController();
      const bus = eventBus();
      let requests = 0;
      let fired = false;
      let component: { dispose?(): void } | undefined;
      let handler: ((input: string, context: any) => unknown) | undefined;
      let registration: ReturnType<typeof registerZergSwarmExtension> | undefined;
      let control: ReturnType<typeof createZergControl>;
      const observe = (state: ZergState) => {
        const target = lane === 'bridge' ? `bridge request emitted for ${ids.runId()}` : `pi native launch started ${ids.runId()}`;
        if (fired || !getZergLogs(state).some((record) => record.message === target)) return;
        fired = true;
        if (revoke === 'signal') abort.abort();
        else if (revoke === 'owner-dispose') { if (registration) registration.dispose(); else control.dispose(); }
        else if (registration) {
          if (revoke === 'readonly') void handler!('/zerg control readonly on', { ui: { notify() {} } });
          else void control.execute({ action: 'interrupt', runId: ids.runId() });
        } else if (revoke === 'readonly') container.replace({ ...state, mode: { ...state.mode, readOnly: true } });
        else {
          const status = revoke === 'cancelled' ? 'cancelled' : 'running';
          container.replace(upsertTask(applyRuntimeTransition(state, { entity: 'agent', action: 'progress', id: ids.runId(), kind: 'subagent', status, substate: revoke, substateReason: 'publication cancelled' }), { ...state.tasks[ids.taskId()]!, status, substate: revoke }));
        }
      };
      let unsubscribe: (() => void) | undefined;
      try {
        if (lane === 'native') {
          control = createZergControl(container, { idFactory: ids });
          unsubscribe = container.subscribe!(observe);
        } else {
          replaceSharedZergState(seed());
          bus.on('subagent:slash:request', () => { requests++; });
          registration = registerZergSwarmExtension({ events: bus, registerCommand(_name, options) { handler = options.handler; return { dispose() {} }; } }, { idFactory: ids });
          control = registration.control;
          await handler!('/zerg monitor', { ui: { custom(factory: any) {
            component = factory({ requestRender() { observe(registration!.state); } }, undefined, undefined, () => undefined);
            return Promise.resolve();
          } } });
        }
        const result = await control!.execute({ action: 'run', agent: 'worker', task: 'Pure pre-SDK admission only.', background: true, maxTurns: 1 }, abort.signal);
        // Unsupported maxTurns is a fail-closed sentinel if admission regresses.
        // No supported request is ever allowed to initialize SDK/resources.
        const deadline = Date.now() + 2_000;
        while (!fired && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
        assert.equal(fired, true);
        const state = registration?.state ?? container.read();
        if (revoke === 'readonly') assert.equal(state.mode.readOnly, true);
        assert.equal(requests, lane === 'fallback' ? 1 : 0);
        if (lane !== 'fallback') assert.equal(result.ok, false);
        assert.equal(result.runId, ids.runId());
        assert.equal(result.taskId, ids.taskId());
        assert.doesNotMatch(state.agents[ids.runId()]?.runtime?.substateReason ?? '', /unsupported capability request before SDK startup/);
        const expectedCancelled = revoke === 'signal' || revoke === 'cancelled' || revoke === 'cancelling' || (lane !== 'bridge' && revoke === 'owner-dispose');
        assert.equal(state.agents[ids.runId()]?.status, expectedCancelled ? 'cancelled' : 'failed');
        assert.equal(state.tasks[ids.taskId()]?.status, state.agents[ids.runId()]?.status);
      } finally {
        unsubscribe?.(); component?.dispose?.(); registration?.dispose();
        if (!registration) control!.dispose();
        replaceSharedZergState(shared);
      }
    });
  }
}

for (const publication of ['control', 'lifecycle', 'log'] as const) {
  test(`public native interrupt owns cancellation before ${publication} publication returns`, async () => {
    const container = createZergStateContainer(seed());
    const control = createZergControl(container, { idFactory: ids });
    let interrupted: ReturnType<typeof control.execute> | undefined;
    let fired = false;
    const unsubscribe = container.subscribe!((state) => {
      if (fired) return;
      const visible = publication === 'control'
        ? (state.extensions.zergControl as { activeRunId?: string } | undefined)?.activeRunId === ids.runId()
        : publication === 'lifecycle'
          ? state.agents[ids.runId()]?.runtime?.substateReason === 'pi native runner started'
          : getZergLogs(state).some((record) => record.message === `pi native launch started ${ids.runId()}`);
      if (!visible) return;
      fired = true;
      interrupted = control.execute({ action: 'interrupt', runId: ids.runId() });
    });
    try {
      const launched = await control.execute({ action: 'run', agent: 'worker', task: 'Interrupt before delivery.', background: true, maxTurns: 1 });
      assert.equal(fired, true);
      assert.equal((await interrupted)?.ok, true);
      assert.equal(launched.ok, false);
      assert.equal(launched.runId, ids.runId());
      assert.equal(launched.taskId, ids.taskId());
      assert.equal(container.read().agents[ids.runId()]?.status, 'cancelled');
      assert.equal(container.read().tasks[ids.taskId()]?.status, 'cancelled');
      assert.doesNotMatch(container.read().agents[ids.runId()]?.runtime?.substateReason ?? '', /unsupported capability request before SDK startup/);
    } finally { unsubscribe(); control.dispose(); }
  });
}
