import assert from 'node:assert/strict';
import test from 'node:test';

import { createZergState, createZergStateContainer } from '../../state.js';
import type { StructuralPiCommandContext, ZergManagementTargetKind } from '../../types.js';
import { openZergManagementOverlay, ZergManagementOverlayComponent, type ZergManagementOverlayActions } from '../../ui/management-overlay.js';

test('M9 management overlay uses ctx.ui.custom component path and disposes subscription exactly once', () => {
  const container = createZergStateContainer();
  let requestRenderCount = 0;
  let doneCount = 0;
  let component: { render(width?: number, height?: number): string[]; handleInput?(data: string): void; dispose?(): void; invalidate(): void } | undefined;
  let optionsSeen: Record<string, unknown> | undefined;
  const actions: ZergManagementOverlayActions = {
    now: () => new Date('2026-05-01T00:00:00.000Z'),
    toggleReadOnly: () => 'readonly toggled',
    setAutomation: (mode) => `mode ${mode}`,
    setController: (controller) => `controller ${controller}`,
    approvePermission: (requestId) => `approved ${requestId}`,
    denyPermission: (requestId) => `denied ${requestId}`,
    selectTarget: (target: { id: string; kind: ZergManagementTargetKind }) => `selected ${target.kind} ${target.id}`,
    interruptSelected: () => 'interrupt unavailable',
    sendOperatorMessage: () => ({ status: 'transport-unavailable', statusDetail: 'transport unavailable' }),
  };
  const context: StructuralPiCommandContext = {
    ui: {
      custom(factory, options) {
        optionsSeen = options as Record<string, unknown>;
        assert.equal(optionsSeen.overlay, true);
        component = (factory as (tui: { requestRender(): void }, theme: unknown, keybindings: unknown, done: () => void) => typeof component)(
          { requestRender: () => { requestRenderCount += 1; } },
          undefined,
          undefined,
          () => { doneCount += 1; },
        );
        return { close: () => component?.dispose?.() };
      },
    },
  };

  openZergManagementOverlay(context, {
    getSnapshot: () => container.snapshot(),
    subscribe: (listener) => container.subscribe?.(listener) ?? (() => undefined),
    adapterKind: 'unavailable',
    actions,
  });

  assert.equal((optionsSeen?.overlayOptions as { title?: string } | undefined)?.title, 'zerg config');
  const initialRender = component?.render(100, 24).join('\n') ?? '';
  assert.ok(initialRender.includes('zerg config'));
  assert.ok(initialRender.includes('Use three steps'));
  assert.ok(initialRender.includes('1 Select'));
  assert.ok(initialRender.includes('2 Settings'));
  assert.ok(initialRender.includes('3 Message'));
  container.update({ metadata: { ...container.snapshot().metadata, updatedAt: '2026-05-01T00:00:01.000Z' } });
  assert.equal(requestRenderCount, 1);
  component?.handleInput?.('q');
  component?.dispose?.();
  assert.equal(doneCount, 1);
  const afterDispose = requestRenderCount;
  container.update({ metadata: { ...container.snapshot().metadata, updatedAt: '2026-05-01T00:00:02.000Z' } });
  assert.equal(requestRenderCount, afterDispose);
});

test('M9 management overlay preserves existing selected target and shows zerg control controller', async () => {
  const container = createZergStateContainer(createZergState({
    selectedNodeId: 'node-b',
    agents: {
      a: { id: 'a', label: 'Alpha', kind: 'subagent', status: 'idle' },
      b: { id: 'b', label: 'Beta', kind: 'subagent', status: 'running' },
    },
    tree: {
      'node-b': { id: 'node-b', label: 'Beta', kind: 'agent', refId: 'b', childIds: [] },
    },
    extensions: {
      zergControl: { controller: 'pi' },
    },
  }));
  let component: { render(width?: number, height?: number): string[]; dispose?(): void } | undefined;
  const actions: ZergManagementOverlayActions = {
    now: () => new Date('2026-05-01T00:00:00.000Z'),
    toggleReadOnly: () => 'readonly toggled',
    setAutomation: (mode) => `mode ${mode}`,
    setController: (controller) => `controller ${controller}`,
    approvePermission: (requestId) => `approved ${requestId}`,
    denyPermission: (requestId) => `denied ${requestId}`,
    selectTarget: (target: { id: string; kind: ZergManagementTargetKind }) => `selected ${target.kind} ${target.id}`,
    interruptSelected: () => 'interrupt unavailable',
    sendOperatorMessage: () => ({ status: 'transport-unavailable', statusDetail: 'transport unavailable' }),
  };

  await openZergManagementOverlay({
    ui: {
      custom(factory) {
        component = (factory as () => typeof component)();
        return undefined;
      },
    },
  }, {
    getSnapshot: () => container.snapshot(),
    subscribe: () => () => undefined,
    adapterKind: 'fake',
    actions,
  });

  const rendered = component?.render(110, 24).join('\n') ?? '';
  assert.ok(rendered.includes('Controller pi'));
  assert.ok(rendered.includes('Selected: agent b'));
  assert.ok(rendered.includes('agent: Beta (b)'));
  assert.equal(rendered.includes('Selected: agent a'), false);
  component?.dispose?.();
});

test('M9 management overlay keeps tree navigation usable after default selection render', async () => {
  const container = createZergStateContainer(createZergState({
    agents: {
      a: { id: 'a', label: 'Alpha', kind: 'subagent', status: 'idle' },
      b: { id: 'b', label: 'Beta', kind: 'subagent', status: 'idle' },
    },
  }));
  let component: { render(width?: number, height?: number): string[]; handleInput?(data: string): void; dispose?(): void } | undefined;
  const actions: ZergManagementOverlayActions = {
    now: () => new Date('2026-05-01T00:00:00.000Z'),
    toggleReadOnly: () => 'readonly toggled',
    setAutomation: (mode) => `mode ${mode}`,
    setController: (controller) => `controller ${controller}`,
    approvePermission: (requestId) => `approved ${requestId}`,
    denyPermission: (requestId) => `denied ${requestId}`,
    selectTarget: (target: { id: string; kind: ZergManagementTargetKind }) => `selected ${target.kind} ${target.id}`,
    interruptSelected: () => 'interrupt unavailable',
    sendOperatorMessage: () => ({ status: 'transport-unavailable', statusDetail: 'transport unavailable' }),
  };
  await openZergManagementOverlay({ ui: { custom(factory) { component = (factory as () => typeof component)(); return undefined; } } }, {
    getSnapshot: () => container.snapshot(),
    subscribe: () => () => undefined,
    adapterKind: 'fake',
    actions,
  });

  component?.render(110, 24);
  component?.handleInput?.('down');
  component?.render(110, 24);
  component?.handleInput?.('enter');
  const rendered = component?.render(110, 24).join('\n') ?? '';
  assert.ok(rendered.includes('Selected: agent b'));
  component?.dispose?.();
});

test('M9 management overlay routes focus and chat keys through focused pane', () => {
  const container = createZergStateContainer({
    agents: { worker: { id: 'worker', label: 'Worker', kind: 'subagent', status: 'running' } },
  });
  let component: { render(width?: number, height?: number): string[]; handleInput?(data: string): void; dispose?(): void } | undefined;
  const actions: ZergManagementOverlayActions = {
    now: () => new Date('2026-05-01T00:00:00.000Z'),
    toggleReadOnly: () => 'readonly toggled',
    setAutomation: (mode) => `mode ${mode}`,
    setController: (controller) => `controller ${controller}`,
    approvePermission: (requestId) => `approved ${requestId}`,
    denyPermission: (requestId) => `denied ${requestId}`,
    selectTarget: () => 'selected target',
    interruptSelected: () => 'interrupt unavailable',
    sendOperatorMessage: (_target, body) => ({ status: 'intervention-recorded', statusDetail: `intervention recorded: ${body}`, routedTargetId: 'worker' }),
  };
  openZergManagementOverlay({ ui: { custom(factory) { component = (factory as () => typeof component)(); return undefined; } } }, {
    getSnapshot: () => container.snapshot(),
    subscribe: () => () => undefined,
    adapterKind: 'fake',
    actions,
  });

  component?.handleInput?.('down');
  component?.handleInput?.('down');
  component?.handleInput?.('enter');
  component?.handleInput?.('tab');
  component?.handleInput?.('tab');
  for (const char of 'remote rapid quorum') component?.handleInput?.(char);
  component?.handleInput?.('enter');
  const rendered = component?.render(110, 30).join('\n') ?? '';
  assert.ok(rendered.includes('intervention-recorded'));
  assert.ok(rendered.includes('remote rapid quorum'));
  assert.ok((component?.render(110) ?? []).length <= 32);
});

function codingManagementFixture(viewCoding?: (target: { id: string; kind: ZergManagementTargetKind } | undefined) => Promise<void>, onRender?: () => void, viewTimeline?: (target: { id: string; kind: ZergManagementTargetKind } | undefined) => Promise<void>) {
  const container = createZergStateContainer({ agents: { worker: { id: 'worker', label: 'Worker', kind: 'subagent', status: 'running' } } });
  let mutations = 0;
  let renders = 0;
  const actions: ZergManagementOverlayActions = {
    now: () => new Date('2026-10-02T00:00:00Z'),
    toggleReadOnly: () => { mutations += 1; return 'toggle'; },
    setAutomation: () => { mutations += 1; return 'mode'; },
    setController: () => { mutations += 1; return 'controller'; },
    approvePermission: () => { mutations += 1; return 'approve'; },
    denyPermission: () => { mutations += 1; return 'deny'; },
    selectTarget: () => 'selected', interruptSelected: () => { mutations += 1; return 'interrupt'; },
    sendOperatorMessage: () => ({ status: 'transport-unavailable', statusDetail: 'unavailable' }),
  };
  const component = new ZergManagementOverlayComponent({ requestRender: () => { renders += 1; onRender?.(); } }, undefined, undefined, {
    getSnapshot: () => container.snapshot(), subscribe: () => () => undefined, adapterKind: 'fake', actions, viewCoding, viewTimeline,
  });
  component.render(110, 30);
  return { component, get mutations() { return mutations; }, get renders() { return renders; } };
}
const codingTick = () => new Promise<void>((resolve) => setImmediate(resolve));

test('coding view is separate from mutations, guards nested opens and preserves exact selected target', async () => {
  const targets: Array<{ id: string; kind: ZergManagementTargetKind } | undefined> = [];
  let finish: () => void = () => undefined;
  const f = codingManagementFixture((target) => { targets.push(target); return new Promise<void>((resolve) => { finish = resolve; }); });
  f.component.handleInput('v');
  f.component.handleInput('v');
  await codingTick();
  assert.deepEqual(targets, [{ id: 'worker', kind: 'agent' }]);
  assert.equal(f.mutations, 0);
  finish();
  await codingTick();
  assert.match(f.component.getStateForTests().statusMessage ?? '', /viewer closed/);
  f.component.handleInput('v');
  await codingTick();
  assert.equal(targets.length, 2);
  finish();
  await codingTick();
  f.component.dispose();
});

test('coding key only applies to tree/detail, remains chat text and leaves settings usable', async () => {
  let calls = 0;
  const f = codingManagementFixture(async () => { calls += 1; });
  f.component.handleInput('tab'); // settings
  f.component.handleInput('v');
  await codingTick();
  assert.equal(calls, 0);
  f.component.handleInput('tab'); // chat
  f.component.handleInput('v');
  assert.equal(f.component.getStateForTests().chatDraft, 'v');
  f.component.handleInput('tab'); // detail
  f.component.handleInput('v');
  await codingTick();
  assert.equal(calls, 1);
  f.component.handleInput('r');
  assert.equal(f.mutations, 1);
  assert.equal(f.component.getStateForTests().chatDraft, 'v');
  f.component.dispose();
});

test('coding callback synchronous/async failures are contained and retryable', async () => {
  for (const synchronous of [true, false]) {
    let calls = 0;
    const f = codingManagementFixture(() => { calls += 1; if (synchronous) throw new Error('host failure'); return Promise.reject(new Error('host failure')); });
    f.component.handleInput('v');
    await codingTick();
    assert.match(f.component.getStateForTests().statusMessage ?? '', /coding viewer unavailable: Error: host failure/);
    f.component.handleInput('v');
    await codingTick();
    assert.equal(calls, 2);
    f.component.handleInput('r');
    assert.equal(f.mutations, 1);
    f.component.dispose();
  }
  const absent = codingManagementFixture();
  absent.component.handleInput('v');
  assert.match(absent.component.getStateForTests().statusMessage ?? '', /coding viewer unavailable/);
  absent.component.dispose();
});

test('disposing management during nested viewer ignores late completion/failure', async () => {
  for (const reject of [true, false]) {
    let finish: (error?: Error) => void = () => undefined;
    const f = codingManagementFixture(() => new Promise<void>((resolve, rejectPromise) => { finish = (error) => error ? rejectPromise(error) : resolve(); }));
    f.component.handleInput('v');
    await codingTick();
    f.component.dispose();
    const before = f.renders;
    const status = f.component.getStateForTests().statusMessage;
    finish(reject ? new Error('late failure') : undefined);
    await codingTick();
    assert.equal(f.renders, before);
    assert.equal(f.component.getStateForTests().statusMessage, status);
  }
  let calls = 0;
  const immediate = codingManagementFixture(async () => { calls += 1; });
  immediate.component.handleInput('v');
  immediate.component.dispose();
  await codingTick();
  assert.equal(calls, 0);
});

test('nested coding management survives injected redraw throws without unhandled rejection', async () => {
  let calls = 0;
  const f = codingManagementFixture(async () => { calls += 1; }, () => { throw new Error('redraw failed'); });
  assert.doesNotThrow(() => f.component.handleInput('v'));
  await codingTick();
  assert.equal(calls, 1);
  assert.match(f.component.getStateForTests().statusMessage ?? '', /management redraw unavailable/);
  assert.doesNotThrow(() => f.component.handleInput('v'));
  await codingTick();
  assert.equal(calls, 2);
  f.component.dispose();
});

test('timeline t is read-only tree/detail navigation, shares open guard, preserves draft and scoped target', async () => {
  const targets: Array<{ id: string; kind: ZergManagementTargetKind } | undefined> = [];
  let finish: () => void = () => undefined; let coding = 0;
  const f = codingManagementFixture(async () => { coding++; }, undefined, (target) => { targets.push(target); return new Promise<void>((resolve) => { finish = resolve; }); });
  f.component.handleInput('t'); f.component.handleInput('t'); f.component.handleInput('v');
  await codingTick(); assert.deepEqual(targets, [{ id: 'worker', kind: 'agent' }]); assert.equal(coding, 0); assert.equal(f.mutations, 0);
  finish(); await codingTick(); assert.match(f.component.getStateForTests().statusMessage ?? '', /timeline viewer closed/);
  f.component.handleInput('tab'); f.component.handleInput('t'); await codingTick(); assert.equal(targets.length, 1);
  f.component.handleInput('tab'); f.component.handleInput('t'); assert.equal(f.component.getStateForTests().chatDraft, 't');
  f.component.handleInput('tab'); f.component.handleInput('t'); await codingTick(); assert.equal(targets.length, 2);
  finish(); await codingTick(); assert.equal(f.component.getStateForTests().chatDraft, 't'); assert.equal(f.mutations, 0); f.component.dispose();
});

test('timeline callback faults/absence/disposal never launch a fallback coding viewer', async () => {
  let coding = 0;
  const absent = codingManagementFixture(async () => { coding++; }); absent.component.handleInput('t');
  assert.match(absent.component.getStateForTests().statusMessage ?? '', /timeline viewer unavailable/); absent.component.dispose();
  for (const sync of [true, false]) {
    let calls = 0;
    const f = codingManagementFixture(async () => { coding++; }, undefined, () => { calls++; if (sync) throw new Error('timeline host failed'); return Promise.reject(new Error('timeline host failed')); });
    f.component.handleInput('t'); await codingTick(); assert.match(f.component.getStateForTests().statusMessage ?? '', /timeline viewer unavailable/);
    f.component.handleInput('t'); await codingTick(); assert.equal(calls, 2); f.component.dispose();
  }
  let calls = 0;
  const closed = codingManagementFixture(undefined, undefined, async () => { calls++; }); closed.component.handleInput('t'); closed.component.dispose();
  await codingTick(); assert.equal(calls, 0); assert.equal(coding, 0);
});

test('shared viewer callbacks keep options receiver and contain noncoercible thrown values/redraw failures', async () => {
  let coding = 0; let timeline = 0;
  const container = createZergStateContainer({ agents: { worker: { id: 'worker', label: 'Worker', kind: 'subagent', status: 'running' } } });
  const actions: ZergManagementOverlayActions = {
    now: () => new Date('2026-10-03T00:00:00Z'), toggleReadOnly: () => '', setAutomation: () => '', setController: () => '', approvePermission: () => '', denyPermission: () => '', selectTarget: () => '', interruptSelected: () => '', sendOperatorMessage: () => ({ status: 'transport-unavailable', statusDetail: '' }),
  };
  const options = {
    marker: 'options-receiver', getSnapshot: () => container.snapshot(), subscribe: () => () => undefined, adapterKind: 'fake', actions,
    async viewCoding() { assert.equal(this.marker, 'options-receiver'); coding++; },
    async viewTimeline() { assert.equal(this.marker, 'options-receiver'); timeline++; },
  };
  const c = new ZergManagementOverlayComponent(undefined, undefined, undefined, options); c.render(110, 30);
  c.handleInput('v'); await codingTick(); c.handleInput('t'); await codingTick(); assert.equal(coding, 1); assert.equal(timeline, 1); c.dispose();
  for (const synchronous of [true, false]) {
    const nonText = Object.assign(Object.create(null), { toString: null });
    const f = codingManagementFixture(undefined, () => { throw nonText; }, () => { if (synchronous) throw nonText; return Promise.reject(nonText); });
    f.component.handleInput('t'); await codingTick(); assert.match(f.component.getStateForTests().statusMessage ?? '', /management redraw unavailable/); f.component.dispose();
    const visible = codingManagementFixture(undefined, undefined, () => { throw nonText; }); visible.component.handleInput('t'); await codingTick(); assert.match(visible.component.getStateForTests().statusMessage ?? '', /Unknown failure/); visible.component.dispose();
  }
});
