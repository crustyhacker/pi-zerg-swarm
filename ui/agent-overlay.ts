import { Text, stripTerminalSequences, truncateToWidth } from '@earendil-works/pi-tui';
import type { NativeTranscriptKey, NativeTranscriptReadHandle, NativeTranscriptSnapshot } from '../native-transcript.js';
import type { StructuralPiCommandContext, StructuralPiCustomComponent, StructuralPiTuiHandle, ZergNativeSessionReference } from '../types.js';
import { styleText, type UiThemeLike } from './components.js';
import { matchesKey } from './state.js';

export interface ZergAgentOverlayOptions {
  getReferences(): ZergNativeSessionReference[];
  subscribeReferences(listener: () => void): () => void;
  open(key: NativeTranscriptKey, options?: { signal?: AbortSignal }): Promise<NativeTranscriptReadHandle>;
}

const MAX_CHOICES = 256;
const MAX_LINES = 2048;
const MAX_TEXT = 256 * 1024;
const MAX_FIELD = 32 * 1024;

/** Untrusted transcripts never supply terminal commands or hyperlinks. */
export function sanitizeTranscriptText(value: string): string {
  return stripTerminalSequences(value.slice(0, MAX_FIELD)
    .replace(/\r\n?/g, '\n')
    .replace(/(?:\x1b\]|\x9d)[^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c|$)/g, '')
    .replace(/(?:\x1b[PX^_]|[\x90\x98\x9e\x9f])[\s\S]*?(?:\x1b\\|\x9c|$)/g, '')
    .replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g, ''))
    .replace(/\x1b[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '')
    .replace(/\t/g, '    ');
}

function sameKey(a: NativeTranscriptKey, b: NativeTranscriptKey): boolean {
  return a.parentRunId === b.parentRunId && a.memberRunId === b.memberRunId && a.piSessionId === b.piSessionId;
}

function cleanup(callback?: () => void): void {
  try { callback?.(); } catch { /* Finish every viewer cleanup, even if a host observer fails. */ }
}

export async function openZergAgentOverlay(context: StructuralPiCommandContext, options: ZergAgentOverlayOptions): Promise<void> {
  if (context.hasUI === false || (context.mode !== undefined && context.mode !== 'tui') || !context.ui?.custom) {
    throw new Error('Coding viewer requires an interactive Pi TUI.');
  }
  await Promise.resolve(context.ui.custom(
    (tui?: StructuralPiTuiHandle, theme?: unknown, _keys?: unknown, done?: () => void) =>
      new ZergAgentOverlayComponent(tui, theme as UiThemeLike | undefined, done, options),
    { overlay: true, overlayOptions: { title: 'zerg coding', anchor: 'center', width: '90%', maxHeight: '82%' } },
  ));
}

/** A read-only observer: it owns no runner, SDK session or navigation API. */
export class ZergAgentOverlayComponent implements StructuralPiCustomComponent {
  private disposed = false;
  private mode: 'chooser' | 'transcript' | 'branches' = 'chooser';
  private references: ZergNativeSessionReference[] = [];
  private choice = 0;
  private branchChoice = 0;
  private key?: NativeTranscriptKey;
  private leafId?: string | null;
  private snapshot?: NativeTranscriptSnapshot;
  private handle?: NativeTranscriptReadHandle;
  private unsubscribeReferences?: () => void;
  private unsubscribeTranscript?: () => void;
  private abort?: AbortController;
  private generation = 0;
  private message = '';
  private referencesLimited = false;
  private loading = false;
  private follow = true;
  private scroll = 0;
  private viewport = 1;
  private cache?: { width: number; lines: string[]; limited: boolean };

  constructor(
    private readonly tui: StructuralPiTuiHandle | undefined,
    private readonly theme: UiThemeLike | undefined,
    private readonly done: (() => void) | undefined,
    private readonly options: ZergAgentOverlayOptions,
  ) {
    this.refreshReferences();
    try {
      this.unsubscribeReferences = options.subscribeReferences(() => {
        if (this.disposed) return;
        this.refreshReferences();
        this.requestRender();
      });
    } catch (error) { this.message = `Reference observer unavailable: ${String(error)}`; }
  }

  invalidate(): void { this.cache = undefined; }

  render(width = 100, requestedHeight?: number): string[] {
    const w = Math.max(1, Math.min(512, Math.floor(width) || 1));
    const h = Math.max(1, Math.min(128, Math.floor(requestedHeight ?? (this.tui?.terminal?.rows ?? 32) * 0.82) || 1));
    const layout = this.mode === 'transcript' ? this.formatted(w) : undefined;
    const notice = [
      this.message || (this.snapshot?.truncated ? `Transcript truncated · ${this.snapshot.droppedBlocks} dropped blocks` : ''),
      layout?.limited ? 'UI display truncated: text/line limit' : '',
    ].filter(Boolean).join(' · ');
    const bodyCapacity = Math.max(0, h - 3);
    this.viewport = Math.max(1, bodyCapacity - (notice ? 1 : 0));
    const title = styleText(this.theme, 'accent', 'zerg coding · read-only raw history');
    const status = this.mode === 'chooser' ? `Exact session chooser (${this.references.length})${this.referencesLimited ? ' · list truncated' : ''}`
      : this.loading ? 'Loading exact session…'
      : this.snapshot ? `${this.snapshot.source} · ${this.snapshot.status} · ${this.snapshot.source === 'captured' ? 'detached capture (not connected or proven saved)' : this.leafId ? 'branch inspection' : this.snapshot.defaultLeafBasis === 'live' ? 'live leaf' : 'last recorded entry (not proven active leaf)'} · ${this.follow ? 'follow tail' : 'scroll paused'}`
      : 'unavailable';
    let body: string[];
    if (this.mode === 'chooser') {
      const offset = Math.max(0, this.choice - Math.floor(this.viewport / 3));
      body = this.references.slice(offset, offset + this.viewport).map((ref, index) => {
        const short = (id: string) => id.length > 22 ? `${id.slice(0, 8)}…${id.slice(-12)}` : id;
        return `${offset + index === this.choice ? '›' : ' '} ${offset + index + 1} ${ref.agentDefinitionId} · member ${short(ref.memberRunId)} · run ${short(ref.parentRunId)} · Pi ${short(ref.piSessionId)} · ${ref.attachment}`;
      });
      if (!body.length) body.push('No native sessions available. No implicit leader selection.');
    } else if (this.mode === 'branches') {
      const branches = this.snapshot?.branches.slice(0, MAX_CHOICES) ?? [];
      const choices = ['Default: live leaf / last recorded entry', ...branches.map((branch) => `${branch.label} · ${branch.leafId}`)];
      const offset = Math.max(0, this.branchChoice - Math.floor(this.viewport / 2));
      body = choices.slice(offset, offset + this.viewport).map((label, index) => `${offset + index === this.branchChoice ? '›' : ' '} ${label}`);
    } else {
      const cache = layout!;
      const maxScroll = Math.max(0, cache.lines.length - this.viewport);
      this.scroll = this.follow ? maxScroll : Math.max(0, Math.min(this.scroll, maxScroll));
      body = cache.lines.slice(this.scroll, this.scroll + this.viewport);
    }
    if (this.mode !== 'transcript') body = body.map((line) => sanitizeTranscriptText(line).replace(/\n/g, ' '));
    if (notice) body = [sanitizeTranscriptText(notice).replace(/\n/g, ' '), ...body];
    body = body.slice(0, bodyCapacity);
    const footer = this.mode === 'chooser' ? '↑↓ select · Enter inspect · q/Esc close'
      : this.mode === 'branches' ? '↑↓ select · Enter inspect locally · s sessions · q/Esc close'
      : 's sessions · b branches · ↑↓/PgUp/PgDn/Home scroll · End follow · q/Esc close';
    return [title, status, ...body, styleText(this.theme, 'dim', footer)]
      .slice(0, h).map((line) => truncateToWidth(line, w, '', true));
  }

  handleInput(data: string): void {
    if (this.disposed) return;
    if (matchesKey(data, 'escape') || data.toLowerCase() === 'q') { this.dispose(); return; }
    if (data.toLowerCase() === 's') {
      this.detach();
      this.mode = 'chooser';
      this.message = '';
      this.refreshReferences();
    } else if (data.toLowerCase() === 'b' && this.snapshot && this.mode !== 'chooser') {
      this.mode = 'branches';
      this.branchChoice = 0;
    } else if (this.mode === 'chooser') {
      if (matchesKey(data, 'up')) this.choice = Math.max(0, this.choice - 1);
      if (matchesKey(data, 'down')) this.choice = Math.min(Math.max(0, this.references.length - 1), this.choice + 1);
      if (matchesKey(data, 'enter')) void this.openSelected();
    } else if (this.mode === 'branches') {
      if (matchesKey(data, 'up')) this.branchChoice = Math.max(0, this.branchChoice - 1);
      if (matchesKey(data, 'down')) this.branchChoice = Math.min(Math.min(MAX_CHOICES, this.snapshot?.branches.length ?? 0), this.branchChoice + 1);
      if (matchesKey(data, 'enter')) {
        this.leafId = this.branchChoice === 0 ? undefined : this.snapshot?.branches[this.branchChoice - 1]?.leafId;
        this.mode = 'transcript';
        this.follow = !this.leafId && this.snapshot?.source === 'live';
        this.scroll = 0;
        this.readSnapshot();
      }
    } else {
      if (matchesKey(data, 'end')) { this.follow = !this.leafId && this.snapshot?.source === 'live'; this.scroll = MAX_LINES; }
      else if (matchesKey(data, 'home')) { this.follow = false; this.scroll = 0; }
      else if (matchesKey(data, 'up', 'pageup')) { this.follow = false; this.scroll = Math.max(0, this.scroll - (matchesKey(data, 'pageup') ? this.viewport : 1)); }
      else if (matchesKey(data, 'down', 'pagedown')) { this.follow = false; this.scroll += matchesKey(data, 'pagedown') ? this.viewport : 1; }
    }
    this.requestRender();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.detach();
    cleanup(this.unsubscribeReferences);
    this.unsubscribeReferences = undefined;
    cleanup(this.done);
  }

  private requestRender(): void {
    if (this.disposed) return;
    try { this.tui?.requestRender?.(); } catch { this.message = 'Viewer redraw unavailable.'; }
  }

  private refreshReferences(): void {
    const prior = this.references[this.choice];
    try {
      const refs = this.options.getReferences();
      this.referencesLimited = refs.length > MAX_CHOICES;
      this.references = refs.slice(0, MAX_CHOICES).map((ref) => ({ ...ref }));
      const retained = prior ? this.references.findIndex((ref) => sameKey(ref, prior)) : -1;
      this.choice = retained >= 0 ? retained : Math.min(this.choice, Math.max(0, this.references.length - 1));
      if (this.key && !refs.some((ref) => sameKey(ref, this.key!))) {
        this.detach();
        this.mode = 'chooser';
        this.message = 'Selected reference is no longer available. Choose an exact session again.';
      }
    } catch (error) { this.references = []; this.message = `References unavailable: ${String(error)}`; }
  }

  private async openSelected(): Promise<void> {
    const ref = this.references[this.choice];
    if (!ref) return;
    this.detach();
    const generation = this.generation;
    const key: NativeTranscriptKey = { parentRunId: ref.parentRunId, memberRunId: ref.memberRunId, piSessionId: ref.piSessionId };
    this.key = key;
    this.mode = 'transcript';
    this.loading = true;
    this.message = '';
    this.follow = true;
    this.scroll = 0;
    const abort = this.abort = new AbortController();
    let opened: NativeTranscriptReadHandle | undefined;
    try {
      if (!this.options.getReferences().some((current) => sameKey(current, key))) throw new Error('Selected reference is stale.');
      opened = await this.options.open(key, { signal: abort.signal });
      if (this.disposed || generation !== this.generation || abort.signal.aborted) { cleanup(() => opened?.dispose()); return; }
      this.handle = opened;
      this.loading = false;
      this.readSnapshot();
      this.follow = this.snapshot?.source === 'live';
      this.unsubscribeTranscript = opened.subscribe(() => {
        if (this.disposed || generation !== this.generation) return;
        this.readSnapshot();
        this.requestRender();
      });
    } catch (error) {
      if (this.disposed || generation !== this.generation) return;
      this.detach();
      this.mode = 'transcript';
      this.key = key;
      this.message = `Transcript unavailable: ${String(error)}`;
    }
    this.requestRender();
  }

  private readSnapshot(): void {
    try {
      const snapshot = this.handle?.getSnapshot({ leafId: this.leafId });
      if (snapshot && this.key && !sameKey(snapshot.key, this.key)) throw new Error('Transcript identity mismatch.');
      this.snapshot = snapshot;
      if (snapshot?.source !== 'live') this.follow = false;
      this.message = '';
    } catch (error) { this.snapshot = undefined; this.message = `Transcript unavailable: ${String(error)}`; }
    this.invalidate();
  }

  private detach(): void {
    this.generation += 1;
    this.abort?.abort();
    this.abort = undefined;
    cleanup(this.unsubscribeTranscript);
    this.unsubscribeTranscript = undefined;
    const handle = this.handle;
    this.handle = undefined;
    cleanup(() => handle?.dispose());
    this.snapshot = undefined;
    this.key = undefined;
    this.leafId = undefined;
    this.loading = false;
    this.invalidate();
  }

  private formatted(width: number): { width: number; lines: string[]; limited: boolean } {
    if (this.cache?.width === width) return this.cache;
    const lines: string[] = [];
    let remaining = MAX_TEXT;
    let limited = false;
    const add = (value: string | undefined, color = 'text') => {
      if (value === undefined) return;
      if (lines.length >= MAX_LINES || remaining <= 0) { limited = true; return; }
      const clean = sanitizeTranscriptText(value.slice(0, remaining));
      if (value.length > Math.min(remaining, MAX_FIELD)) limited = true;
      remaining -= clean.length;
      // Bound wrapping work before using Pi's public Text component.
      for (const part of clean.split('\n')) {
        if (lines.length >= MAX_LINES) { limited = true; break; }
        const wrapped = new Text(part || ' ', 0, 0).render(width);
        const available = MAX_LINES - lines.length;
        if (wrapped.length > available) limited = true;
        lines.push(...wrapped.slice(0, available).map((line) => styleText(this.theme, color, line)));
      }
    };
    if (this.key) {
      add(`parent run: ${this.key.parentRunId}`);
      add(`member run: ${this.key.memberRunId}`);
      add(`Pi session: ${this.key.piSessionId}`);
    }
    add('Raw branch history only; compaction/context_edit notices are not effective model context.', 'dim');
    const snapshot = this.snapshot;
    if (snapshot?.source === 'captured') add('Live observation detached; captured output is not connected or proven saved.', 'warning');
    add(snapshot?.diagnostic, 'warning');
    if (snapshot?.truncated) add(`Transcript truncated: ${snapshot.droppedBlocks} dropped blocks`, 'warning');
    add(`inspected leaf: ${snapshot?.inspectedLeafId ?? 'default'} · live leaf: ${snapshot?.liveLeafId ?? 'unknown'}`, 'dim');
    if (!snapshot?.blocks.length) add(this.loading ? 'Loading…' : 'No transcript blocks available.');
    for (const block of snapshot?.blocks.slice(0, MAX_CHOICES) ?? []) {
      if (lines.length >= MAX_LINES || remaining <= 0) { limited = true; break; }
      add(`[${block.kind}${block.role ? ` · ${block.role}` : ''}${block.toolName ? ` · ${block.toolName}` : ''}${block.status ? ` · ${block.status}` : ''}]`, 'accent');
      if (block.toolCallId) add(`tool call: ${block.toolCallId}${block.parentToolCallId ? ` · parent: ${block.parentToolCallId}` : ''}`, 'dim');
      add(block.text, block.kind === 'thinking' ? 'dim' : 'text');
      if (block.argumentsText) { add('arguments:', 'muted'); add(block.argumentsText); }
      if (block.resultText) { add('result:', 'muted'); add(block.resultText); }
      add('');
    }
    if ((snapshot?.blocks.length ?? 0) > MAX_CHOICES) limited = true;
    return this.cache = { width, lines, limited };
  }
}
