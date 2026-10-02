import assert from 'node:assert/strict';
import test from 'node:test';
import { visibleWidth } from '@earendil-works/pi-tui';
import type { NativeTranscriptKey, NativeTranscriptReadHandle, NativeTranscriptSnapshot } from '../../native-transcript.js';
import type { ZergNativeSessionReference } from '../../types.js';
import { openZergAgentOverlay, sanitizeTranscriptText, ZergAgentOverlayComponent, type ZergAgentOverlayOptions } from '../../ui/agent-overlay.js';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function reference(member = 'worker-a', parent = 'team-a'): ZergNativeSessionReference {
  return { schemaVersion: 1, parentRunId: parent, memberRunId: member, piSessionId: `pi-${parent}-${member}`, agentDefinitionId: 'same-definition', sessionFile: '/never-opened-by-ui', cwd: '/fixture', createdAt: '2026-10-02T00:00:00Z', attachment: 'attached' };
}
function snapshot(key: NativeTranscriptKey, patch: Partial<NativeTranscriptSnapshot> = {}): NativeTranscriptSnapshot {
  return { key, revision: 1, source: 'live', status: 'running', defaultLeafBasis: 'live', inspectedLeafId: 'tip', liveLeafId: 'tip', branches: [{ leafId: 'old-leaf', label: 'old branch' }, { leafId: 'tip', label: 'current branch' }], blocks: [{ id: 'a', kind: 'text', role: 'assistant', text: 'hello' }], truncated: false, droppedBlocks: 0, ...patch };
}
function fixture(refs = [reference()]) {
  let references = refs;
  let referenceListener: () => void = () => undefined;
  const opened: NativeTranscriptKey[] = [];
  const handles: Array<{ value: NativeTranscriptSnapshot; disposeCount: number; unsubscribeCount: number; readCount: number; selections: Array<{ leafId?: string | null } | undefined>; listener: () => void; signal?: AbortSignal }> = [];
  let renders = 0;
  let done = 0;
  let referenceUnsubscribes = 0;
  const options: ZergAgentOverlayOptions = {
    getReferences: () => references,
    subscribeReferences: (listener) => { referenceListener = listener; return () => { referenceUnsubscribes += 1; }; },
    open: async (key, options) => {
      opened.push(key);
      const state = { value: snapshot(key), disposeCount: 0, unsubscribeCount: 0, readCount: 0, selections: [] as Array<{ leafId?: string | null } | undefined>, listener: (() => undefined) as () => void, signal: options?.signal };
      handles.push(state);
      return { getSnapshot: (selection) => { state.readCount += 1; state.selections.push(selection); return { ...state.value, blocks: selection?.leafId === null ? [] : state.value.blocks, inspectedLeafId: selection?.leafId === null ? null : selection?.leafId ?? state.value.inspectedLeafId }; }, subscribe: (listener) => { state.listener = listener; return () => { state.unsubscribeCount += 1; }; }, dispose: () => { state.disposeCount += 1; } };
    },
  };
  const component = new ZergAgentOverlayComponent({ requestRender: () => { renders += 1; } }, undefined, () => { done += 1; }, options);
  return { component, options, opened, handles, get renders() { return renders; }, get done() { return done; }, get referenceUnsubscribes() { return referenceUnsubscribes; }, setReferences: (refs: ZergNativeSessionReference[]) => { references = refs; referenceListener(); }, referenceListener: () => referenceListener() };
}

test('coding chooser never implicitly chooses a leader; concurrent definitions use exact triples', async () => {
  const refs = [reference('leader'), reference('worker'), reference('worker', 'team-b')];
  const f = fixture(refs);
  assert.equal(f.opened.length, 0);
  assert.match(f.component.render(180, 20).join('\n'), /team-b/);
  f.component.handleInput('down');
  f.component.handleInput('down');
  f.component.handleInput('enter');
  await tick();
  assert.deepEqual(f.opened, [{ parentRunId: 'team-b', memberRunId: 'worker', piSessionId: 'pi-team-b-worker' }]);
  f.component.handleInput('home');
  assert.match(f.component.render(100, 20).join('\n'), /parent run: team-b/);
  assert.match(f.component.render(100, 20).join('\n'), /Pi session: pi-team-b-worker/);
  f.component.dispose();
});

test('empty, removed and stale references are explicit and do not fall back', async () => {
  const f = fixture([]);
  f.component.handleInput('enter');
  assert.equal(f.opened.length, 0);
  assert.match(f.component.render(100, 20).join('\n'), /No native sessions/);
  f.setReferences([reference()]);
  f.component.handleInput('enter');
  await tick();
  f.setReferences([reference('other')]);
  assert.match(f.component.render(100, 20).join('\n'), /no longer available/);
  assert.equal(f.handles[0]!.disposeCount, 1);
  assert.equal(f.opened.length, 1);
  f.component.dispose();
  let refs = [reference()];
  const stale = new ZergAgentOverlayComponent(undefined, undefined, undefined, { getReferences: () => refs, subscribeReferences: () => () => undefined, open: async () => { throw new Error('must not open stale'); } });
  refs = [];
  stale.handleInput('enter');
  await tick();
  assert.match(stale.render(100, 20).join('\n'), /Selected reference is stale/);
  stale.dispose();
});

test('raw branch inspection uses only handle selection; default leaf is not a navigation action', async () => {
  const f = fixture();
  f.component.handleInput('enter');
  await tick();
  f.component.handleInput('b');
  assert.match(f.component.render(100, 20).join('\n'), /old branch/);
  f.component.handleInput('down');
  f.component.handleInput('enter');
  assert.deepEqual(f.handles[0]!.selections.at(-1), { leafId: 'old-leaf' });
  assert.equal(f.handles[0]!.value.liveLeafId, 'tip');
  assert.match(f.component.render(100, 20).join('\n'), /branch inspection/);
  f.handles[0]!.listener();
  assert.deepEqual(f.handles[0]!.selections.at(-1), { leafId: 'old-leaf' });
  f.component.handleInput('b');
  f.component.handleInput('enter');
  assert.deepEqual(f.handles[0]!.selections.at(-1), { leafId: undefined });
  assert.match(f.component.render(100, 20).join('\n'), /hello/);
  f.component.dispose();
});

test('streamed text/thinking/tool cards render IDs, arguments/results and raw context notices', async () => {
  const f = fixture();
  f.component.handleInput('enter');
  await tick();
  const h = f.handles[0]!;
  h.value = snapshot(h.value.key, { blocks: [
    { id: 'thinking', kind: 'thinking', text: '[thinking signature omitted]\nreasoning' },
    { id: 'tool', kind: 'tool', text: 'read output', toolName: 'read', toolCallId: 'call-2', parentToolCallId: 'call-1', status: 'done', argumentsText: '{\n    "path": "x.ts"\n}', resultText: '    indented result\n[image omitted]' },
    { id: 'event', kind: 'event', text: 'compaction/context_edit notice' },
  ] });
  h.listener();
  f.component.handleInput('home');
  const output = f.component.render(140, 40).join('\n');
  for (const text of ['thinking', 'read output', 'tool call: call-2 · parent: call-1', 'arguments:', '    "path"', '    indented result', '[image omitted]', 'not effective model context', 'compaction/context_edit']) assert.ok(output.includes(text), text);
  f.component.dispose();
});

test('switch and close abort only viewer loads; late handles disposed and callbacks ignored', async () => {
  let referenceListener: () => void = () => undefined;
  const pending: Array<{ key: NativeTranscriptKey; signal?: AbortSignal; resolve(handle: NativeTranscriptReadHandle): void }> = [];
  const disposals = [0, 0];
  let subscriptions = 0;
  let done = 0;
  let renders = 0;
  const component = new ZergAgentOverlayComponent({ requestRender: () => { renders += 1; } }, undefined, () => { done += 1; }, {
    getReferences: () => [reference('a'), reference('b')],
    subscribeReferences: (listener) => { referenceListener = listener; return () => undefined; },
    open: (key, options) => new Promise((resolve) => { pending.push({ key, signal: options?.signal, resolve }); }),
  });
  component.handleInput('enter');
  component.handleInput('s');
  component.handleInput('down');
  component.handleInput('enter');
  assert.equal(pending[0]!.signal?.aborted, true);
  pending[0]!.resolve({ getSnapshot: () => snapshot(pending[0]!.key), subscribe: () => { subscriptions += 1; return () => undefined; }, dispose: () => { disposals[0]! += 1; } });
  await tick();
  assert.deepEqual(disposals, [1, 0]);
  assert.equal(subscriptions, 0);
  component.handleInput('q');
  component.dispose();
  assert.equal(done, 1);
  assert.equal(pending[1]!.signal?.aborted, true);
  pending[1]!.resolve({ getSnapshot: () => snapshot(pending[1]!.key), subscribe: () => { subscriptions += 1; return () => undefined; }, dispose: () => { disposals[1]! += 1; } });
  const before = renders;
  await tick();
  referenceListener();
  assert.deepEqual(disposals, [1, 1]);
  assert.equal(renders, before);
  assert.equal(subscriptions, 0);
});

test('close removes both watchers once and never receives a runner API', async () => {
  const f = fixture();
  f.component.handleInput('enter');
  await tick();
  f.component.handleInput('s');
  assert.equal(f.handles[0]!.unsubscribeCount, 1);
  assert.equal(f.handles[0]!.disposeCount, 1);
  f.component.handleInput('enter');
  await tick();
  f.component.dispose();
  f.component.dispose();
  const before = f.renders;
  f.handles[1]!.listener();
  f.referenceListener();
  assert.equal(f.renders, before);
  assert.equal(f.handles[1]!.unsubscribeCount, 1);
  assert.equal(f.handles[1]!.disposeCount, 1);
  assert.equal(f.referenceUnsubscribes, 1);
  assert.equal(f.done, 1);
});

test('failed open, identity mismatch and throwing observers cannot leak handles', async () => {
  for (const fault of ['open', 'snapshot', 'identity', 'subscribe']) {
    let disposed = 0;
    const component = new ZergAgentOverlayComponent(undefined, undefined, undefined, {
      getReferences: () => [reference()], subscribeReferences: () => () => { throw new Error('watcher'); },
      open: async (key) => {
        if (fault === 'open') throw new Error('missing transcript file');
        return { getSnapshot: () => { if (fault === 'snapshot') throw new Error('corrupt history'); return snapshot(fault === 'identity' ? reference('wrong') : key); }, subscribe: () => { if (fault === 'subscribe') throw new Error('observer unavailable'); return () => { throw new Error('unsubscribe'); }; }, dispose: () => { disposed += 1; throw new Error('cleanup'); } };
      },
    });
    component.handleInput('enter');
    await tick();
    assert.match(component.render(120, 20).join('\n'), /unavailable/i, fault);
    component.dispose();
    component.dispose();
    assert.equal(disposed, fault === 'open' ? 0 : 1, fault);
  }
});

test('saved/unavailable/truncated are honest; missing file never reports live', async () => {
  const f = fixture();
  f.component.handleInput('enter');
  await tick();
  const h = f.handles[0]!;
  h.value = snapshot(h.value.key, { source: 'saved', status: 'closed', defaultLeafBasis: 'recorded-tip', liveLeafId: null, diagnostic: 'saved raw history', truncated: true, droppedBlocks: 4 });
  h.listener();
  f.component.handleInput('home');
  assert.match(f.component.render(150, 30).join('\n'), /saved · closed/);
  assert.match(f.component.render(150, 30).join('\n'), /last recorded entry \(not proven active leaf\)/);
  assert.match(f.component.render(150, 30).join('\n'), /4 dropped blocks/);
  h.value = snapshot(h.value.key, { source: 'unavailable', status: 'unavailable', diagnostic: 'missing transcript file', blocks: [] });
  h.listener();
  assert.match(f.component.render(150, 30).join('\n'), /missing transcript file/);
  assert.match(f.component.render(150, 30).join('\n'), /unavailable · unavailable/);
  f.component.dispose();
});

test('user scroll pauses live follow; End follows again without changing branch', async () => {
  const f = fixture();
  f.component.handleInput('enter');
  await tick();
  const h = f.handles[0]!;
  h.value.blocks = [{ id: 'long', kind: 'text', text: Array.from({ length: 70 }, (_, i) => `line ${i}`).join('\n') }];
  h.listener();
  assert.match(f.component.render(100, 14).join('\n'), /line 69/);
  f.component.handleInput('home');
  const paused = f.component.render(100, 14).join('\n');
  h.value.blocks[0]!.text += '\nNEW TAIL';
  h.value.revision += 1;
  h.listener();
  assert.equal(f.component.render(100, 14).join('\n'), paused);
  f.component.handleInput('end');
  assert.match(f.component.render(100, 14).join('\n'), /NEW TAIL/);
  f.component.handleInput('pageup');
  assert.match(f.component.render(100, 14).join('\n'), /scroll paused/);
  f.component.dispose();
});

test('untrusted ANSI/OSC/C1/APC stripped; Unicode, indentation and narrow widths fit', async () => {
  assert.equal(sanitizeTranscriptText('\x1b]8;;https://evil\x07link\x1b]8;;\x07\x1b[31m red\x1b[0m\x1b[2J\x9b2J\x1b_Gimagebytes\x1b\\\x9d52;secret\x9c\x00\n\t界👩‍💻é'), 'link red\n    界👩‍💻é');
  const f = fixture();
  f.component.handleInput('enter');
  await tick();
  f.handles[0]!.value.blocks[0]!.text = '    界👩‍💻é\n\x1b]8;;bad\x07LINK\x1b]8;;\x07\n\x1b[2Jscreen';
  f.handles[0]!.listener();
  f.component.handleInput('home');
  for (const width of [1, 2, 3, 8, 21, 80]) {
    const lines = f.component.render(width, 60);
    assert.ok(lines.length <= 60);
    for (const line of lines) { assert.ok(visibleWidth(line) <= width, `${width}: ${line}`); assert.equal(line.replace(/\x1b\[[0-9;]*m/g, '').includes('\x1b'), false); } // Pi truncation inserts trusted SGR resets.
  }
  assert.match(f.component.render(80, 60).join('\n'), /    界👩‍💻é/);
  f.component.dispose();
});

test('formatted cache is single-width, bounded and invalidated for theme/revision changes', async () => {
  const f = fixture();
  let color = '31';
  let styles = 0;
  const component = new ZergAgentOverlayComponent(undefined, { fg: (_token, text) => { styles += 1; return `\x1b[${color}m${text}\x1b[0m`; } }, undefined, f.options);
  component.handleInput('enter');
  await tick();
  component.handleInput('home');
  const first = component.render(80, 30);
  assert.ok(first.some((line) => line.includes('\x1b[31m')));
  const before = styles;
  component.render(80, 30);
  assert.equal(styles - before, 2); // only title/footer; transcript layout reused
  color = '32';
  component.invalidate();
  assert.ok(component.render(80, 30).some((line) => line.includes('\x1b[32m')));
  const h = f.handles.at(-1)!;
  h.value.blocks = Array.from({ length: 300 }, (_, i) => ({ id: `b-${i}`, kind: 'text', text: 'x\n'.repeat(40000) }));
  h.listener();
  assert.match(component.render(30, 40).join('\n'), /UI display truncated/);
  for (let width = 1; width < 60; width += 7) for (const line of component.render(width, 18)) assert.ok(visibleWidth(line) <= width);
  component.dispose();
  f.component.dispose();
});

test('public overlay awaits custom completion, exposes no composer and rejects absent TUI', async () => {
  const f = fixture();
  let component: ZergAgentOverlayComponent | undefined;
  let seen: unknown;
  let resolved = false;
  const promise = openZergAgentOverlay({ ui: { custom: (factory, options) => {
    seen = options;
    return new Promise<void>((resolve) => { component = (factory as (tui: undefined, theme: undefined, keys: undefined, done: () => void) => ZergAgentOverlayComponent)(undefined, undefined, undefined, resolve); });
  } } }, f.options).then(() => { resolved = true; });
  await tick();
  assert.equal(resolved, false);
  assert.equal((seen as { overlay: boolean }).overlay, true);
  assert.equal('minWidth' in (seen as { overlayOptions: object }).overlayOptions, false);
  assert.equal(component!.render(80).join('\n').includes('composer'), false);
  component!.handleInput('\x1b');
  await promise;
  assert.equal(resolved, true);
  await assert.rejects(openZergAgentOverlay({}, f.options), /interactive Pi TUI/);
  f.component.dispose();
});

test('detached captured output remains visible without implying live connection or persistence', async () => {
  const f = fixture();
  f.component.handleInput('enter');
  await tick();
  const h = f.handles[0]!;
  h.value = snapshot(h.value.key, { source: 'captured', status: 'settled', diagnostic: 'live observation detached; captured output is not a persistence claim', blocks: [{ id: 'final', kind: 'text', text: 'FINAL CAPTURE' }] });
  h.listener();
  f.component.handleInput('home');
  const output = f.component.render(160, 30).join('\n');
  assert.match(output, /captured · settled/);
  assert.match(output, /not connected or proven saved/);
  assert.match(output, /FINAL CAPTURE/);
  h.value.status = 'unavailable';
  h.listener();
  assert.match(f.component.render(160, 30).join('\n'), /captured · unavailable/);
  assert.match(f.component.render(160, 30).join('\n'), /FINAL CAPTURE/);
  f.component.dispose();
});

test('branch Default restores live and saved history; null would mean before-root', async () => {
  for (const source of ['live', 'saved'] as const) {
    const f = fixture();
    f.component.handleInput('enter');
    await tick();
    const h = f.handles[0]!;
    h.value = snapshot(h.value.key, { source, status: source === 'live' ? 'running' : 'closed', defaultLeafBasis: source === 'live' ? 'live' : 'recorded-tip', blocks: [{ id: 'tip', kind: 'text', text: 'DEFAULT HISTORY' }] });
    h.listener();
    f.component.handleInput('b');
    f.component.handleInput('down');
    f.component.handleInput('enter');
    f.component.handleInput('b');
    f.component.handleInput('enter');
    assert.deepEqual(h.selections.at(-1), { leafId: undefined });
    assert.match(f.component.render(140, 30).join('\n'), /DEFAULT HISTORY/);
    f.component.dispose();
  }
});

test('throwing redraw callbacks are contained across async open, updates and close', async () => {
  const f = fixture();
  let done = 0;
  const component = new ZergAgentOverlayComponent({ requestRender: () => { throw new Error('host redraw'); } }, undefined, () => { done += 1; }, f.options);
  assert.doesNotThrow(() => component.handleInput('enter'));
  await tick(); // An unhandled rejection here fails the Node test runner.
  const h = f.handles[0]!;
  assert.doesNotThrow(() => h.listener());
  assert.match(component.render(100, 30).join('\n'), /Viewer redraw unavailable/);
  assert.doesNotThrow(() => component.handleInput('s'));
  component.handleInput('enter');
  await tick();
  assert.doesNotThrow(() => component.handleInput('q'));
  assert.equal(done, 1);
  assert.equal(f.handles.at(-1)!.disposeCount, 1);
  f.component.dispose();
});

test('public coding helper rejects RPC/print/JSON and hasUI=false even with custom stubs', async () => {
  const f = fixture();
  let customCalls = 0;
  for (const mode of ['rpc', 'print', 'json'] as const) {
    await assert.rejects(openZergAgentOverlay({ mode, hasUI: true, ui: { custom: () => { customCalls += 1; } } }, f.options), /interactive Pi TUI/);
  }
  await assert.rejects(openZergAgentOverlay({ mode: 'tui', hasUI: false, ui: { custom: () => { customCalls += 1; } } }, f.options), /interactive Pi TUI/);
  assert.equal(customCalls, 0);
  f.component.dispose();
});

test('chooser metadata and diagnostic newlines never escape a rendered terminal row', async () => {
  const ref = reference();
  ref.agentDefinitionId = 'label\nforged row';
  const f = fixture([ref]);
  for (const line of f.component.render(100, 20)) assert.equal(line.includes('\n'), false);
  f.options.open = async () => { throw new Error('missing\nforged row'); };
  f.component.handleInput('enter');
  await tick();
  for (const line of f.component.render(100, 20)) assert.equal(line.includes('\n'), false);
  f.component.dispose();
});


test('truncation notices reserve space without hiding retained tail or full identity at Home', async () => {
  const f = fixture();
  f.component.handleInput('enter');
  await tick();
  const h = f.handles[0]!;
  h.value = snapshot(h.value.key, { truncated: true, droppedBlocks: 3, blocks: [
    { id: 'long', kind: 'text', text: Array.from({ length: 3000 }, (_, i) => `TAIL-${i}`).join('\n') },
  ] });
  h.listener();
  const output = f.component.render(100, 14).join('\n');
  assert.match(output, /Transcript truncated/);
  assert.match(output, /UI display truncated/);
  assert.match(output, /TAIL-2040/); // Last retained line at the bounded 2048-line layout, not the unbounded input tail.
  assert.match(output, /q\/Esc close/);
  f.component.handleInput('home');
  assert.match(f.component.render(100, 14).join('\n'), /parent run: team-a/);
  for (const height of [4, 5, 6]) {
    const lines = f.component.render(100, height);
    assert.equal(lines.length, height);
    assert.match(lines.at(-1)!, /q\/Esc close/);
  }
  f.component.dispose();
});
