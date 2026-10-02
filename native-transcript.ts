import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
import type { ZergNativeSessionReference } from './types.js';

export type NativeTranscriptKey = Pick<ZergNativeSessionReference, 'parentRunId' | 'memberRunId' | 'piSessionId'>;
export type NativeTranscriptBlock = {
  id: string; entryId?: string; kind: 'text' | 'thinking' | 'tool' | 'event'; role?: string;
  text: string; toolCallId?: string; parentToolCallId?: string; toolName?: string;
  argumentsText?: string; resultText?: string; status?: string;
};
export type NativeTranscriptBranch = { leafId: string; label: string };
export type NativeTranscriptSnapshot = {
  key: NativeTranscriptKey; revision: number; source: 'live' | 'saved' | 'captured' | 'unavailable';
  status: 'running' | 'settled' | 'closed' | 'unavailable'; diagnostic?: string;
  defaultLeafBasis: 'live' | 'recorded-tip'; inspectedLeafId?: string | null; liveLeafId?: string | null;
  branches: NativeTranscriptBranch[]; blocks: NativeTranscriptBlock[]; truncated: boolean; droppedBlocks: number;
};
export type NativeTranscriptReadHandle = {
  getSnapshot(selection?: { leafId?: string | null }): NativeTranscriptSnapshot;
  subscribe(listener: () => void): () => void; dispose(): void;
};
/** Runner-only public SDK read facade. Never exposed by a viewer handle. */
export type NativeTranscriptReadFacade = {
  subscribe(listener: (event: any) => void): () => void;
  getMessages(): unknown; getEntryCount(): number; getEntries(): unknown[]; getLeafId(): string | null;
};
export type NativeTranscriptService = ReturnType<typeof createNativeTranscriptService>;

const LIMIT = { bytes: 8 * 1024 * 1024, line: 256 * 1024, entries: 10000, blocks: 200,
  text: 32 * 1024, collector: 256 * 1024, owners: 32, tools: 64, listeners: 64 } as const;
const MARKER = 'pi-zerg-swarm/native-session/v1';
type Entry = { id: string; parentId: string | null; blocks: NativeTranscriptBlock[] };
type Data = { entries: Entry[]; leaf: string | null; extra: NativeTranscriptBlock[]; truncated: boolean; dropped: number };
const record = (value: unknown): value is Record<string, any> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const keyOf = (key: NativeTranscriptKey) => JSON.stringify([key.parentRunId, key.memberRunId, key.piSessionId]);
const copyKey = (key: NativeTranscriptKey): NativeTranscriptKey => ({ parentRunId: key.parentRunId, memberRunId: key.memberRunId, piSessionId: key.piSessionId });
const ignoreFault = (fn: () => void) => { try { fn(); } catch { /* Observation must never affect execution. */ } };

/** Terminal-safe transcript text; preserves indentation and newlines, not escape payloads. */
export function sanitizeNativeTranscriptText(value: string): string {
  return value.replace(/(?:\x1b\]|\x9d)[\s\S]*?(?:\x07|\x1b\\|\x9c|$)/g, '')
    .replace(/(?:\x1b[P_X^]|[\x90\x98\x9e\x9f])[\s\S]*?(?:\x1b\\|\x9c|$)/g, '')
    .replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '').replace(/\t/g, '    ');
}
function text(value: unknown, limit = LIMIT.text): string {
  return typeof value === 'string' ? sanitizeNativeTranscriptText(value.slice(0, limit)) + (value.length > limit ? '\n[truncated]' : '') : '';
}
function boundedArguments(value: unknown): string {
  let work = 0;
  const visit = (item: unknown, depth: number): unknown => {
    if (++work > 256 || depth > 6) return '[omitted]';
    if (typeof item === 'string') return text(item, 1024);
    if (item === null || typeof item === 'boolean' || typeof item === 'number') return item;
    if (Array.isArray(item)) return item.slice(0, 32).map((child) => visit(child, depth + 1));
    if (record(item)) return Object.fromEntries(Object.keys(item).slice(0, 32).map((key) => [text(key, 128),
      /signature|^data$/i.test(key) ? '[opaque payload omitted]' : visit(item[key], depth + 1)]));
    return '[omitted]';
  };
  return text(JSON.stringify(visit(value, 0)));
}
function contentText(value: unknown): string {
  if (typeof value === 'string') return text(value);
  if (!Array.isArray(value)) return '';
  return text(value.slice(0, LIMIT.blocks).map((part) => !record(part) ? '[unsupported content]' :
    part.type === 'text' ? text(part.text) : part.type === 'image' ? '[image omitted]' : '[opaque content omitted]').join('\n'));
}
function messageBlocks(message: unknown, id: string, entryId?: string): NativeTranscriptBlock[] {
  if (!record(message)) return [{ id, entryId, kind: 'event', text: '[unsupported message]' }];
  const role = text(message.role, 128);
  if (role === 'toolResult') return [{ id: `tool:${text(message.toolCallId, 256)}`, entryId, kind: 'tool', role,
    toolCallId: text(message.toolCallId, 256), toolName: text(message.toolName, 256), text: '',
    resultText: contentText(message.content), status: message.isError ? 'error' : 'done' }];
  if (!['user', 'assistant', 'system', 'custom'].includes(role)) return [{ id, entryId, kind: 'event', role, text: `[${role || 'unknown'} message omitted]` }];
  if (typeof message.content === 'string') return [{ id, entryId, kind: 'text', role, text: text(message.content) }];
  if (!Array.isArray(message.content)) return [{ id, entryId, kind: 'event', role, text: '[message metadata only]' }];
  return message.content.slice(0, LIMIT.blocks).map((part: unknown, index: number): NativeTranscriptBlock => {
    const base = { id: `${id}:${index}`, entryId, role };
    if (!record(part)) return { ...base, kind: 'event', text: '[unsupported content]' };
    if (part.type === 'text') return { ...base, kind: 'text', text: text(part.text) };
    if (part.type === 'thinking') return { ...base, kind: 'thinking', text: part.redacted ? '[redacted thinking; signature omitted]' : text(part.thinking) || '[thinking signature omitted]' };
    if (part.type === 'toolCall') return { ...base, id: `tool:${text(part.id, 256)}`, kind: 'tool', toolCallId: text(part.id, 256),
      toolName: text(part.name, 256), argumentsText: boundedArguments(part.arguments), text: '', status: 'pending' };
    return { ...base, kind: 'event', text: part.type === 'image' ? '[image omitted]' : '[opaque content omitted]' };
  });
}
function entryBlocks(entry: Record<string, any>): NativeTranscriptBlock[] {
  if (entry.type === 'message') return messageBlocks(entry.message, entry.id, entry.id);
  const base: NativeTranscriptBlock = { id: entry.id, entryId: entry.id, kind: 'event', text: '' };
  if (entry.type === 'compaction') base.text = `Compaction (raw history; not effective model context)\n${text(entry.summary)}`;
  else if (entry.type === 'context_edit') base.text = `Context edit of ${text(entry.targetId, 256)} (raw entry unchanged; replacement omitted)`;
  else if (entry.type === 'branch_summary') base.text = `Branch summary\n${text(entry.summary)}`;
  else if (entry.type === 'custom_message') base.text = `Custom message (payload omitted)`;
  else base.text = `${text(entry.type, 128)} metadata${entry.type === 'session_info' ? `: ${text(entry.name, 256)}` : ''}`;
  return [base];
}
function normalize(entries: unknown[], leaf: string | null): Data {
  let bytes = 0, blocks = 0, dropped = 0, truncated = false;
  const result: Entry[] = [];
  // Reserve half the aggregate budget for streaming and nested tool cards.
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!record(entry) || typeof entry.id !== 'string') continue;
    if (result.length >= LIMIT.blocks || bytes + 1024 >= LIMIT.collector / 2 || blocks >= LIMIT.blocks - 1) {
      dropped += i + 1; truncated = true; break;
    }
    const projected = entryBlocks(entry), retained: NativeTranscriptBlock[] = [];
    for (const block of projected) {
      const cost = JSON.stringify(block).length * 2;
      if (blocks >= LIMIT.blocks - 1 || bytes + cost + 1024 > LIMIT.collector / 2) { dropped++; truncated = true; continue; }
      bytes += cost; blocks++; retained.push(block);
      if ([block.text, block.resultText, block.argumentsText].some((value) => value?.includes('[truncated]'))) truncated = true;
    }
    if (!retained.length) { retained.push({ id: `${entry.id}:limit`, entryId: entry.id, kind: 'event', text: '[entry content omitted by limits]' }); blocks++; bytes += 512; }
    bytes += 1024;
    result.push({ id: text(entry.id, 256), parentId: typeof entry.parentId === 'string' ? text(entry.parentId, 256) : null, blocks: retained });
    if (Array.isArray(entry.message?.content) && entry.message.content.length > LIMIT.blocks) { truncated = true; dropped += entry.message.content.length - LIMIT.blocks; }
  }
  return { entries: result.reverse(), leaf, extra: [], truncated, dropped };
}
function project(data: Data, selection: string | null | undefined) {
  const byId = new Map(data.entries.map((entry) => [entry.id, entry]));
  const parents = new Set(data.entries.map((entry) => entry.parentId));
  const branches = data.entries.filter((entry) => !parents.has(entry.id)).map((entry) => ({ leafId: entry.id, label: `${entry.id} — ${entry.blocks[0]?.role ?? entry.blocks[0]?.kind ?? 'entry'}` }));
  const leaf = selection === undefined ? data.leaf : selection;
  if (leaf !== null && !byId.has(leaf ?? '')) return { branches, blocks: [], leaf, diagnostic: 'Selected entry unavailable or outside retained history' };
  const path: Entry[] = [];
  let next = leaf; let steps = 0;
  while (next && steps++ < LIMIT.entries) { const entry = byId.get(next); if (!entry) break; path.push(entry); next = entry.parentId; }
  const raw = path.reverse().flatMap((entry) => entry.blocks).concat(selection === undefined ? data.extra : []);
  // A final result and live event replace the same call card, never duplicate it.
  const blocks: NativeTranscriptBlock[] = [], tools = new Map<string, NativeTranscriptBlock>();
  for (const block of raw) {
    if (block.kind === 'tool' && block.toolCallId) {
      const existing = tools.get(block.toolCallId);
      if (existing) Object.assign(existing, block, { argumentsText: block.argumentsText ?? existing.argumentsText, parentToolCallId: block.parentToolCallId ?? existing.parentToolCallId });
      else { const copy = { ...block }; tools.set(block.toolCallId, copy); blocks.push(copy); }
    } else blocks.push({ ...block });
  }
  return { branches, blocks: blocks.slice(-LIMIT.blocks), leaf, diagnostic: next ? 'Earlier history omitted by retention limits' : undefined };
}
function unavailable(key: NativeTranscriptKey, diagnostic: string): NativeTranscriptSnapshot {
  return { key: copyKey(key), revision: 0, source: 'unavailable', status: 'unavailable', diagnostic,
    defaultLeafBasis: 'recorded-tip', branches: [], blocks: [], truncated: false, droppedBlocks: 0 };
}

function inertHandle(snapshot: NativeTranscriptReadHandle['getSnapshot']): NativeTranscriptReadHandle {
  return { getSnapshot: snapshot, subscribe: () => () => undefined, dispose() {} };
}
export function createNativeTranscriptService(options: { getReferences: () => ZergNativeSessionReference[]; agentDir?: string }) {
  type Collector = { snapshot(selection?: { leafId?: string | null }): NativeTranscriptSnapshot; listeners: Set<() => void>; release(): void };
  const collectors = new Map<string, Collector>();
  const handles = new Set<() => void>();
  let stopped = false, loads = 0;
  const list = (parentRunId?: string): ZergNativeSessionReference[] => {
    try { return options.getReferences().filter((ref) => !parentRunId || ref.parentRunId === parentRunId).map((ref) => ({ ...ref })); }
    catch { return []; }
  };
  function handle(snapshot: Collector['snapshot'], listeners = new Set<() => void>(), signal?: AbortSignal): NativeTranscriptReadHandle {
    if (stopped) return inertHandle(snapshot);
    let disposed = false; const owned = new Set<() => void>();
    const dispose = () => { if (disposed) return; disposed = true; snapshot = () => unavailable({ parentRunId: '', memberRunId: '', piSessionId: '' }, 'Viewer handle disposed'); for (const fn of owned) listeners.delete(fn); owned.clear(); handles.delete(dispose); signal?.removeEventListener('abort', dispose); };
    handles.add(dispose); signal?.addEventListener('abort', dispose, { once: true });
    if (signal?.aborted) dispose();
    return {
      getSnapshot(selection) { return snapshot(selection); },
      subscribe(listener) {
        if (disposed || listeners.size >= LIMIT.listeners) return () => undefined;
        const safe = () => ignoreFault(listener); owned.add(safe); listeners.add(safe);
        return () => { owned.delete(safe); listeners.delete(safe); };
      }, dispose,
    };
  }
  function register(ref: ZergNativeSessionReference, facade: NativeTranscriptReadFacade): () => void {
    if (stopped || collectors.size >= LIMIT.owners) return () => undefined;
    const key = copyKey(ref), identity = keyOf(key);
    collectors.get(identity)?.release();
    let data: Data = { entries: [], leaf: null, extra: [], truncated: false, dropped: 0 };
    let active = true, revision = 0, status: NativeTranscriptSnapshot['status'] = 'running', diagnostic: string | undefined;
    let reader: NativeTranscriptReadFacade | undefined = facade, unsubscribe: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined, pending = false, generation = 0, epoch = 0;
    let stream: NativeTranscriptBlock[] = [], finishedGeneration: number | undefined;
    const tools = new Map<string, NativeTranscriptBlock>();
    const listeners = new Set<() => void>();
    const notify = () => {
      revision++;
      if (!timer && active) timer = setTimeout(() => { timer = undefined; if (active) for (const fn of listeners) ignoreFault(fn); }, 33);
    };
    const reconcile = () => {
      if (!active || !reader) return;
      try {
        const count = reader.getEntryCount();
        if (!Number.isSafeInteger(count) || count > LIMIT.entries || count < 0) { diagnostic = 'Live history exceeds entry limit'; data.truncated = true; return; }
        data = normalize(reader.getEntries(), reader.getLeafId());
        for (const entry of data.entries) for (const block of entry.blocks) {
          const live = block.toolCallId ? tools.get(block.toolCallId) : undefined;
          if (live && block.kind === 'tool') { block.parentToolCallId = live.parentToolCallId; if (block.resultText !== undefined) tools.delete(block.toolCallId!); }
        }
        if (finishedGeneration === generation) stream = [];
        finishedGeneration = undefined;
        data.extra = boundExtra([...tools.values(), ...stream], data, tools);
      } catch { diagnostic = 'Live observer read failed'; }
    };
    const job = () => {
      if (pending) return; pending = true; const token = epoch;
      queueMicrotask(() => { pending = false; if (!active || token !== epoch) return; ignoreFault(() => { reconcile(); notify(); }); });
    };
    const collector: Collector = {
      listeners,
      snapshot(selection) {
        const view = project(data, selection?.leafId);
        return { key: copyKey(key), revision, source: active ? 'live' : 'captured', status, diagnostic: diagnostic ?? view.diagnostic,
          defaultLeafBasis: 'live', inspectedLeafId: view.leaf, liveLeafId: data.leaf,
          branches: view.branches, blocks: view.blocks, truncated: data.truncated, droppedBlocks: data.dropped };
      },
      release() {
        if (!active) return;
        ignoreFault(reconcile); active = false; epoch++; if (status !== 'settled') status = 'unavailable'; diagnostic = [diagnostic, 'Live observation detached; captured output is not a persistence claim'].filter(Boolean).join('; ');
        if (timer) clearTimeout(timer); timer = undefined;
        ignoreFault(() => unsubscribe?.()); unsubscribe = undefined; reader = undefined;
        tools.clear(); stream = [];
        if (collectors.get(identity) === collector) collectors.delete(identity);
        for (const fn of listeners) ignoreFault(fn); listeners.clear();
      },
    };
    collectors.set(identity, collector);
    try {
      reconcile();
      // SDK emits message_end before its synchronous append: reconcile after dispatch.
      unsubscribe = reader.subscribe((event: unknown) => ignoreFault(() => {
        if (!active || !record(event)) return;
        if (event.type === 'agent_settled') status = 'settled';
        if (event.type === 'agent_start') status = 'running';
        if (event.type === 'message_update' || event.type === 'message_start' || event.type === 'message_end') {
          const partial = record(event.assistantMessageEvent) ? event.assistantMessageEvent.partial : undefined;
          const message = event.message ?? partial;
          if (event.type === 'message_start') generation++;
          stream = messageBlocks(message, `stream:${generation}`);
          if (event.type === 'message_end') finishedGeneration = generation;
          data.extra = boundExtra([...tools.values(), ...stream], data, tools);
          // Retain only the bounded projection, not the unbounded incoming partial.
          stream = data.extra.filter((block) => !tools.has(block.toolCallId ?? ''));
          if (event.type === 'message_end') job();
        }
        if (typeof event.type === 'string' && event.type.startsWith('tool_execution_')) {
          const id = text(event.toolCallId, 256);
          // A tardy update callback must not undo persisted tool-result edits.
          if (data.entries.some((entry) => entry.blocks.some((block) => block.kind === 'tool' && block.toolCallId === id && block.resultText !== undefined))) return;
          if (tools.size < LIMIT.tools || tools.has(id)) {
            const old = tools.get(id);
            tools.set(id, { ...old, id: `tool:${id}`, kind: 'tool', toolCallId: id, parentToolCallId: text(event.parentToolCallId, 256) || old?.parentToolCallId,
              toolName: text(event.toolName, 256), text: '', argumentsText: event.args ? boundedArguments(event.args) : old?.argumentsText,
              resultText: contentText((event.result ?? event.partialResult)?.content) || old?.resultText,
              status: event.type === 'tool_execution_end' ? event.isError ? 'error' : 'done' : 'running' });
            // Bounded active-tool memory; completed cards live in finalized entries.
            // Keep each tool card small enough for the fixed 64-card budget.
            const card = tools.get(id)!;
            for (const field of ['argumentsText', 'resultText'] as const) {
              const value = card[field];
              if (value !== undefined && value.length > 256) { card[field] = text(value, 256); data.truncated = true; }
            }
            while (JSON.stringify([...tools.values()]).length * 2 > LIMIT.collector / 4) { tools.delete(tools.keys().next().value!); data.truncated = true; data.dropped++; }
            data.extra = boundExtra([...tools.values(), ...stream], data, tools);
            if (event.type === 'tool_execution_end') job();
          } else { data.truncated = true; data.dropped++; }
        }
        if (['entry_appended', 'compaction_end', 'agent_settled'].includes(event.type)) job();
        notify();
      }));
    } catch { diagnostic = 'Live observer subscription failed'; collector.release(); }
    return collector.release;
  }
  return {
    list, register,
    async open(key: NativeTranscriptKey, openOptions: { signal?: AbortSignal } = {}): Promise<NativeTranscriptReadHandle> {
      const signal = openOptions.signal;
      if (stopped || signal?.aborted) return inertHandle(() => unavailable(key, 'Viewer closed or load aborted'));
      if (handles.size >= LIMIT.owners) return inertHandle(() => unavailable(key, 'Viewer handle limit reached'));
      const ref = list().find((item) => keyOf(item) === keyOf(key));
      if (!ref) return handle(() => unavailable(key, 'Exact native session reference not found'), undefined, signal);
      const collector = collectors.get(keyOf(key));
      if (collector) return handle(collector.snapshot, collector.listeners, signal);
      if (loads >= 2) return handle(() => unavailable(key, 'Saved history load limit reached'), undefined, signal);
      loads++;
      try {
        const data = await readSaved(ref, options.agentDir, signal);
        if (stopped || signal?.aborted || !list().some((item) => keyOf(item) === keyOf(key) && item.sessionFile === ref.sessionFile)) throw new Error('Load aborted or reference changed');
        return handle((selection) => {
          const view = project(data, selection?.leafId);
          return { key: copyKey(key), revision: 0, source: 'saved', status: ref.attachment === 'disposed' ? 'closed' : 'unavailable', defaultLeafBasis: 'recorded-tip',
            inspectedLeafId: view.leaf, liveLeafId: null, branches: view.branches, blocks: view.blocks,
            diagnostic: [ref.attachment !== 'disposed' ? 'History only; no live observer connected (closure not confirmed)' : '', view.diagnostic ?? '', data.truncated ? 'Saved history truncated by display limits' : ''].filter(Boolean).join('; ') || undefined, truncated: data.truncated, droppedBlocks: data.dropped };
        }, undefined, signal);
      } catch (error) { return handle(() => unavailable(key, error instanceof Error ? error.message : 'Saved history unavailable'), undefined, signal); }
      finally { loads--; }
    },
    shutdown() { if (stopped) return; stopped = true; for (const collector of [...collectors.values()]) collector.release(); for (const dispose of [...handles]) dispose(); },
  };
}

async function readSaved(ref: ZergNativeSessionReference, agentDir?: string, signal?: AbortSignal): Promise<Data> {
  const abort = () => { if (signal?.aborted) throw new Error('Saved history load aborted'); };
  abort();
  const root = resolve(agentDir ?? (await import('@earendil-works/pi-coding-agent')).getAgentDir(), 'sessions');
  const group = `--${resolve(ref.cwd).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
  const path = resolve(ref.sessionFile);
  if (!isAbsolute(ref.sessionFile) || path !== ref.sessionFile || !path.startsWith(`${join(root, group)}${sep}`) ||
      path.slice(join(root, group).length + 1).includes(sep) || !path.endsWith('.jsonl')) throw new Error('Saved history locator denied');
  const checkPath = async () => {
    const parts = path.split(sep).filter(Boolean); let current: string = sep;
    for (const part of parts) { abort(); current = join(current, part); const stat = await lstat(current); if (stat.isSymbolicLink()) throw new Error('Saved history symlink denied'); }
    if (await realpath(path) !== path) throw new Error('Saved history canonical path mismatch');
  };
  await checkPath();
  const before = await lstat(path);
  if (!before.isFile()) throw new Error('Saved history is not a regular file');
  if (before.size > LIMIT.bytes) throw new Error('Saved history exceeds byte limit');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let bytes: Buffer;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino || stat.size > LIMIT.bytes) throw new Error('Saved history identity changed');
    bytes = Buffer.alloc(Math.min(stat.size + 1, LIMIT.bytes + 1));
    let length = 0;
    while (length < bytes.length) { abort(); const read = await file.read(bytes, length, Math.min(65536, bytes.length - length), length); if (!read.bytesRead) break; length += read.bytesRead; }
    const after = await file.stat(); await checkPath(); const locator = await lstat(path);
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs || locator.dev !== stat.dev || locator.ino !== stat.ino || length !== stat.size) throw new Error('Saved history changed during read');
    bytes = bytes.subarray(0, length);
  } finally { await file.close(); }
  abort();
  let decoded: string;
  try { decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new Error('Saved history invalid UTF-8'); }
  const lines = decoded.split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (!lines.length || lines.length > LIMIT.entries + 1) throw new Error('Saved history entry limit or empty file');
  if (lines.some((line) => Buffer.byteLength(line) > LIMIT.line)) throw new Error('Saved history line limit exceeded');
  let rows: Record<string, any>[];
  try { rows = lines.map((line) => { const value: unknown = JSON.parse(line); if (!record(value)) throw new Error(); return value; }); }
  catch { throw new Error('Saved history corrupt or partial JSONL'); }
  const header = rows.shift()!;
  if (header.type !== 'session' || header.version !== 3) throw new Error('Unsupported saved session header (requires v3)');
  if (header.id !== ref.piSessionId || header.cwd !== ref.cwd || rows.some((entry) => entry.type === 'session')) throw new Error('Saved history header identity mismatch');
  const markers = rows.filter((entry) => entry.type === 'custom' && entry.customType === MARKER);
  const identityFields = ['schemaVersion', 'parentRunId', 'memberRunId', 'agentDefinitionId', 'piSessionId', 'sessionFile', 'cwd', 'createdAt'] as const;
  if (markers.length !== 1 || !record(markers[0].data) || Object.keys(markers[0].data).length !== identityFields.length || identityFields.some((field) => markers[0].data[field] !== ref[field])) throw new Error('Saved history provenance mismatch');
  const byId = new Map<string, Record<string, any>>();
  for (const row of rows) {
    if (typeof row.id !== 'string' || !row.id || row.id.length > 256 || byId.has(row.id) ||
        !(row.parentId === null || typeof row.parentId === 'string') || typeof row.type !== 'string') throw new Error('Saved history invalid or duplicate entry');
    byId.set(row.id, row);
  }
  const visited = new Set<string>(); let steps = 0;
  for (const row of rows) {
    const path = new Set<string>(); let cursor: Record<string, any> | undefined = row;
    while (cursor && !visited.has(cursor.id)) {
      if (++steps > LIMIT.entries || path.has(cursor.id)) throw new Error('Saved history cyclic graph or work limit');
      path.add(cursor.id);
      if (cursor.parentId === null) break;
      cursor = byId.get(cursor.parentId); if (!cursor) throw new Error('Saved history orphan entry');
    }
    for (const id of path) visited.add(id);
  }
  return normalize(rows, rows.at(-1)?.id ?? null);
}

function boundExtra(blocks: NativeTranscriptBlock[], data: Data, tools: Map<string, NativeTranscriptBlock>): NativeTranscriptBlock[] {
  let bytes = (JSON.stringify(data.entries).length + JSON.stringify([...tools.values()]).length) * 2;
  const result: NativeTranscriptBlock[] = [];
  for (const block of blocks) {
    if ([block.text, block.resultText, block.argumentsText].some((value) => value?.includes('[truncated]'))) data.truncated = true;
    const cost = JSON.stringify(block).length * 2;
    if (bytes + cost > LIMIT.collector || result.length + data.entries.reduce((n, entry) => n + entry.blocks.length, 0) >= LIMIT.blocks) { data.truncated = true; data.dropped++; break; }
    bytes += cost; result.push(block);
  }
  return result;
}
