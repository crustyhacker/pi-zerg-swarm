import { Text, isKeyRelease, truncateToWidth, type Focusable } from '@earendil-works/pi-tui';
import type { StructuralPiCommandContext, StructuralPiCustomComponent, StructuralPiTuiHandle } from '../types.js';
import { workflowStepEntries } from '../workflow-model.js';
import type { WorkflowAction, WorkflowNativeIdentity, WorkflowRun, WorkflowService, WorkflowStepRun, WorkflowUnit } from '../workflow-model.js';
import { sanitizeUiText, styleText, uiErrorText, visibleSlice, type UiThemeLike } from './components.js';
import { matchesKey } from './state.js';

export interface ZergWorkflowOverlayOptions {
  service: Pick<WorkflowService, 'list' | 'get' | 'subscribe' | 'execute'>;
  workflowRunId?: string;
  onOpenNative?(identity: WorkflowNativeIdentity): void | Promise<void>;
}
interface ViewState { level: 'list' | 'steps' | 'iterations' | 'body' | 'units' | 'result'; runId?: string; stepId?: string; blockId?: string; iterationId?: string; unitId?: string; restoredIdentity?: string; scroll: number }
interface Proof { iterationId?: string; runId: string; stepId?: string; unitId?: string; identity: string; status: WorkflowRun['status']; cleanup: boolean }
interface CodingResult { native: WorkflowNativeIdentity; state: ViewState }
const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\s\x00-\x1f\x7f-\x9f]/u.test(value);
const cleanup = (fn?: () => void) => { try { fn?.(); } catch { /* Finish every UI cleanup stage. */ } };
const terminal = (run: WorkflowRun) => ['completed', 'failed', 'cancelled', 'needs-attention'].includes(run.status);
const nativeOf = (unit?: WorkflowUnit) => unit?.reusedFrom?.native ?? unit?.native;
function copyNative(value?: WorkflowNativeIdentity): WorkflowNativeIdentity | undefined {
  return value && validId(value.runId) && validId(value.taskId) ? { runId: value.runId, taskId: value.taskId } : undefined;
}
function identity(run: WorkflowRun, stepId?: string, unitId?: string): string {
  const entry = stepId === undefined ? undefined : workflowStepEntries(run).find(({ step }) => step.id === stepId);
  const step = entry?.step;
  const unit = unitId === undefined ? undefined : step?.units.find((row) => row.id === unitId);
  if (!validId(run.workflowRunId) || !validId(run.familyId) || !validId(run.definition.id) || !Number.isSafeInteger(run.attemptNo)
    || typeof run.definitionHash !== 'string' || run.definitionHash.length > 256 || typeof run.createdAt !== 'string' || run.createdAt.length > 64
    || (stepId !== undefined && (!validId(stepId) || !step || workflowStepEntries(run).filter(({ step }) => step.id === stepId).length !== 1))
    || (unitId !== undefined && (!validId(unitId) || !unit || unit.stepId !== stepId || typeof unit.inputHash !== 'string' || unit.inputHash.length > 256 || step!.units.filter((row) => row.id === unitId).length !== 1))) throw new Error('Invalid/ambiguous workflow identity.');
  return JSON.stringify([run.workflowRunId, run.familyId, run.attemptNo, run.retryOf, run.definition.id, run.definitionHash, run.createdAt,
    stepId, entry?.blockId, entry?.iterationId, entry?.iterationNo, unitId, unit?.inputHash, unit?.native?.runId, unit?.native?.taskId,
    unit?.reusedFrom?.workflowRunId, unit?.reusedFrom?.unitId, unit?.reusedFrom?.native.runId, unit?.reusedFrom?.native.taskId]);
}
/** Report the recorded transition, never infer exhaustion from a generic failure. */
function repeatOutcome(step: WorkflowStepRun, recovered: boolean): string {
  if (step.status === 'unverified' || recovered || step.termination === 'recovery') return 'uncertain/unverified';
  if (step.status === 'cancelled' || step.termination === 'cancelled') return 'cancelled';
  if (step.termination === 'converged') return step.status === 'completed' ? 'converged' : 'convergence not confirmed';
  if (step.termination === 'max-iterations') return 'nonconverged (max-iterations)';
  if (step.termination === 'body-failed') return 'body-failed';
  if (step.termination === 'invalid-transition') return 'invalid-transition (schema/feedback/condition/output)';
  return step.status === 'failed' ? 'failed (termination unspecified)' : 'convergence not confirmed';
}
/** Explicit local result drill only. Bound traversal BEFORE formatting, not a context/transcript copy. */
function resultPreview(value: unknown): string {
  let budget = 3072; let nodes = 256; let clipped = false;
  const take = (text: string) => { if (text.length > budget) clipped = true; const out = text.slice(0, budget); budget -= out.length; return out; };
  const visit = (item: unknown, depth: number): string => {
    if (budget <= 0 || --nodes < 0 || depth > 8) { clipped = true; return ''; }
    if (typeof item === 'string') { if (item.length > 3072) clipped = true; return take(JSON.stringify(sanitizeUiText(item.slice(0, 3072)))); }
    if (item === null || typeof item === 'boolean' || typeof item === 'number') return take(String(item));
    if (Array.isArray(item)) {
      const pieces = [take('[')];
      for (let i = 0; i < item.length; i++) { if (budget <= 0 || nodes <= 0) { clipped = true; break; } if (i) pieces.push(take(', ')); pieces.push(visit(item[i], depth + 1)); }
      pieces.push(take(']')); return pieces.join('');
    }
    if (item && typeof item === 'object') {
      const pieces = [take('{')]; let index = 0;
      for (const key in item) {
        if (!Object.hasOwn(item, key)) continue;
        if (budget <= 0 || nodes <= 0) { clipped = true; break; }
        if (index++) pieces.push(take(', '));
        pieces.push(take(JSON.stringify(sanitizeUiText(key)) + ': '), visit((item as Record<string, unknown>)[key], depth + 1));
      }
      pieces.push(take('}')); return pieces.join('');
    }
    return take('(no structured result)');
  };
  const text = visit(value, 0);
  return `${text}${clipped ? ' [preview clipped: 3072 chars/256 nodes/depth 8]' : ''}`;
}

/** Fresh interaction on return from the existing native coding viewer; no watcher survives drilldown. */
export async function openZergWorkflowOverlay(context: StructuralPiCommandContext, options: ZergWorkflowOverlayOptions): Promise<void> {
  if (context.hasUI === false || (context.mode !== undefined && context.mode !== 'tui') || !context.ui?.custom) throw new Error('Workflow monitor requires an interactive Pi TUI.');
  let state: ViewState | undefined; let notice = '';
  while (true) {
    let component: ZergWorkflowComponent | undefined; let result: CodingResult | undefined;
    try {
      await Promise.resolve(context.ui.custom((tui, theme, _keys, done) => {
        component?.dispose();
        component = new ZergWorkflowComponent(tui, theme as UiThemeLike | undefined, (value) => { result = value; done?.(value); }, options, state, notice);
        return component;
      }, { overlay: true, overlayOptions: { title: 'zerg workflows', anchor: 'center', width: '90%', maxHeight: '82%' } }));
    } finally { component?.dispose(); }
    if (!result || !options.onOpenNative) return;
    state = result.state; notice = '';
    try { await options.onOpenNative({ ...result.native }); }
    catch (error) { notice = `Exact coding viewer unavailable: ${uiErrorText(error)}`; }
  }
}

/** Owns UI observation only, never the workflow service or native worker lifetimes. */
export class ZergWorkflowComponent implements StructuralPiCustomComponent, Focusable {
  focused = false;
  private disposed = false;
  private unsubscribe?: () => void;
  private state: ViewState;
  private proof?: Proof;
  private rows: string[] = [];
  private notice: string;
  private observerNotice = '';
  private pending = false;
  private confirmation?: Proof;
  private confirmationRendered = false;
  private rejectingPaste = false;
  private pasteTail = '';
  private viewport = 1;

  constructor(private readonly tui: StructuralPiTuiHandle | undefined, private readonly theme: UiThemeLike | undefined,
    private readonly done: ((result?: CodingResult) => void) | undefined, private readonly options: ZergWorkflowOverlayOptions,
    restored?: ViewState, notice = '') {
    if (options.workflowRunId !== undefined && !validId(options.workflowRunId)) throw new Error('Invalid exact workflow run ID.');
    this.state = restored ? { ...restored } : { level: options.workflowRunId ? 'steps' : 'list', runId: options.workflowRunId, scroll: 0 };
    this.notice = notice;
    // Nothing that can throw follows subscription acquisition. Late callbacks are always inert.
    try {
      const unsubscribe = options.service.subscribe(() => { if (!this.disposed) this.redraw(); });
      if (this.disposed) cleanup(unsubscribe); else this.unsubscribe = unsubscribe;
    } catch (error) { this.observerNotice = `Observer unavailable: ${uiErrorText(error)}`; }
  }
  invalidate(): void { /* No themed output retained in state. Last-rendered proof survives invalidation, never selection changes. */ }
  private redraw(): void {
    if (this.disposed) return;
    this.invalidate();
    try { this.tui?.requestRender?.(); } catch { this.observerNotice = 'Workflow redraw unavailable.'; }
  }
  private selectedId(): string | undefined { return this.state.level === 'list' ? this.state.runId : this.state.level === 'iterations' ? this.state.iterationId : ['steps', 'body'].includes(this.state.level) ? this.state.stepId : this.state.unitId; }
  private select(id?: string): void {
    if (this.state.level === 'list') { this.state.runId = id; this.state.stepId = this.state.unitId = undefined; }
    else if (this.state.level === 'iterations') { this.state.iterationId = id; this.state.unitId = undefined; }
    else if (['steps', 'body'].includes(this.state.level)) { this.state.stepId = id; this.state.unitId = undefined; }
    else this.state.unitId = id;
    this.state.restoredIdentity = undefined; this.state.scroll = 0; this.proof = undefined;
  }
  render(width = 100, requestedHeight?: number): string[] {
    if (this.disposed) return [];
    const bound = (n: number, max: number) => Number.isFinite(n) ? Math.max(1, Math.min(max, Math.floor(n))) : 1;
    const w = bound(width, 512); const h = bound(requestedHeight ?? (this.tui?.terminal?.rows ?? 32) * 0.82, 128);
    this.proof = undefined; this.confirmationRendered = false;
    try { return this.renderSafe(w, h); }
    catch (error) { this.rows = []; this.proof = undefined; return [truncateToWidth(`Workflow view unavailable: ${uiErrorText(error)}`, w, '', true)]; }
  }
  private renderSafe(w: number, h: number): string[] {
    const views = this.options.service.list().slice(0, 16);
    const unique = (ids: string[]) => ids.filter((id) => validId(id) && ids.filter((other) => other === id).length === 1);
    if (this.state.level === 'list') {
      this.rows = unique(views.map((view) => view.workflowRunId));
      if (this.state.runId === undefined) this.select(this.rows[0]);
    }
    const run = this.state.runId ? this.options.service.get(this.state.runId) : undefined;
    if (run && run.workflowRunId !== this.state.runId) throw new Error('Wrong workflow returned for exact ID.');
    const entries = run ? workflowStepEntries(run) : [];
    const block = run?.steps.find((row) => row.id === this.state.blockId);
    const iteration = block?.iterations?.find((row) => row.id === this.state.iterationId);
    const step = entries.find(({ step }) => step.id === this.state.stepId)?.step;
    if (this.state.level === 'steps') { this.rows = unique(run?.steps.slice(0, 16).map((row) => row.id) ?? []); if (this.state.stepId === undefined) this.select(this.rows[0]); }
    if (this.state.level === 'iterations') { this.rows = unique(block?.iterations?.slice(0, 32).map((row) => row.id) ?? []); if (this.state.iterationId === undefined) this.select(this.rows[0]); }
    if (this.state.level === 'body') { this.rows = unique(iteration?.steps.slice(0, 16).map((row) => row.id) ?? []); if (this.state.stepId === undefined) this.select(this.rows[0]); }
    if (this.state.level === 'units' || this.state.level === 'result') { this.rows = unique(step?.units.slice(0, 32).map((row) => row.id) ?? []); if (this.state.unitId === undefined) this.select(this.rows[0]); }
    const selectedEntry = entries.find(({ step }) => step.id === this.state.stepId);
    const selectedStep = selectedEntry?.step;
    if (this.state.blockId && ['body', 'units', 'result'].includes(this.state.level)
      && (selectedEntry?.blockId !== this.state.blockId || selectedEntry?.iterationId !== this.state.iterationId)) throw new Error('Exact iteration selection missing/changed; no fallback.');
    if (this.state.restoredIdentity && (!run || identity(run, this.state.stepId, this.state.unitId) !== this.state.restoredIdentity)) throw new Error('Exact coding selection changed; no fallback.');
    const unit = selectedStep?.units.find((row) => row.id === this.state.unitId);
    const status = run ? `${run.status}${!run.cleanupSettled ? ' · cleanup-pending' : ''}${run.recovered ? ' · recovered/unverified history' : ''}` : 'missing/evicted (no fallback)';
    const label = run?.definition.label ?? 'workflow runs';
    const blockSpec = entries.find(({ step }) => step.id === block?.id)?.spec;
    const repeatStatus = block && blockSpec?.kind === 'repeat'
      ? ` · ${block.id} iteration ${block.iterations?.length ?? 0}/${blockSpec.maxIterations} · ${block.status} · ${repeatOutcome(block, run!.recovered)}${block.skipReason ? ` · ${block.skipReason}` : ''}${block.error ? ` · ${block.error}` : ''}` : '';
    const header = [`zerg workflows · ${this.state.level} · ${label}`, `${this.state.runId ?? 'all retained runs'} · attempt ${run?.attemptNo ?? '?'} · ${status}${repeatStatus}`,
      `${this.pending ? 'Control pending. ' : ''}${this.notice} ${this.observerNotice} ${run?.error ? `Workflow error: ${sanitizeUiText(run.error)} · ` : ''}Pause closes admission only; admitted workers continue. UI bounds: 16 runs/16 phases/32 iterations/32 units.`];
    const headerCount = Math.min(3, Math.max(0, h - 2)); const footerCount = h >= 3 ? 1 : 0;
    const capacity = Math.max(1, h - headerCount - footerCount); this.viewport = capacity;
    const selected = this.selectedId();
    const index = this.rows.indexOf(selected ?? '');
    const slice = visibleSlice(this.rows, Math.max(0, index), capacity);
    let body: string[]; let shown: boolean;
    if (this.confirmation) {
      body = [`Retry NEW attempt for ${this.confirmation.runId}? Enter confirms · Esc cancels (current policy rechecked).`];
      shown = false;
    } else if (this.state.level === 'result' && unit) {
      const values = [`unit ${unit.id} · ${unit.status}${!unit.cleanupSettled ? ' · cleanup-pending' : ''}`,
        unit.reusedFrom ? `reused from workflow ${unit.reusedFrom.workflowRunId} / unit ${unit.reusedFrom.unitId} / native ${unit.reusedFrom.native.runId}` : 'Original attempt result; no inferred replies.',
        `native run ${nativeOf(unit)?.runId ?? 'unlinked'} · task ${nativeOf(unit)?.taskId ?? 'unlinked'}`, `error: ${unit.error ?? '(none)'}`, resultPreview(unit.result), 'Local structured result preview only; no transcript copy.'];
      const lines: string[] = [];
      for (const value of values) {
        const wrapped = new Text(sanitizeUiText(value), 0, 0).render(w);
        const remaining = 511 - lines.length;
        lines.push(...wrapped.slice(0, remaining));
        if (wrapped.length > remaining || lines.length >= 511) { lines.push('UI detail clipped: 512 line bound.'); break; }
      }
      this.state.scroll = Math.max(0, Math.min(this.state.scroll, Math.max(0, lines.length - capacity)));
      body = lines.slice(this.state.scroll, this.state.scroll + capacity); shown = body.length > 0;
    } else {
      body = slice.rows.map((id) => {
        const mark = id === selected ? '›' : ' ';
        if (this.state.level === 'list') {
          const view = views.find((row) => row.workflowRunId === id)!;
          const counts = ['queued', 'running', 'completed', 'failed', 'cancelled', 'skipped', 'unverified'].map((key) => `${key}:${view.counts[key as keyof typeof view.counts]}`).join(' ');
          return `${mark} ${id} · ${view.definitionId} · attempt ${view.attemptNo} · ${view.status}${view.cleanupSettled ? '' : ' · cleanup-pending'} · ${counts}`;
        }
        if (this.state.level === 'iterations') {
          const row = block!.iterations!.find((entry) => entry.id === id)!;
          return `${mark} iteration ${id} · ${row.index + 1} · decision ${row.decision ?? 'pending'} · ${row.error ?? ''}`;
        }
        if (this.state.level === 'steps' || this.state.level === 'body') {
          const entry = entries.find(({ step }) => step.id === id)!;
          const row = entry.step;
          return `${mark} phase ${id} · ${row.status} · ${row.units.length} units${entry.spec.kind === 'repeat' ? ` · iteration ${row.iterations?.length ?? 0}/${entry.spec.maxIterations}` : ''} · ${row.skipReason ?? ''} ${row.error ?? ''}${entry.spec.kind === 'repeat' ? ` · ${repeatOutcome(row, run!.recovered)}` : ''}`;
        }
        const row = selectedStep!.units.find((entry) => entry.id === id)!;
        return `${mark} unit ${id} · ${row.status}${row.cleanupSettled ? '' : ' · cleanup-pending'}${row.reusedFrom ? ` · reused from ${row.reusedFrom.workflowRunId}/${row.reusedFrom.unitId} native:${row.reusedFrom.native.runId}` : ''} · ${row.error ?? ''}`;
      });
      shown = index >= 0 && slice.rows.includes(selected!);
      if (!body.length) body = ['No retained selection. Missing IDs never select another run/unit.'];
    }
    const footer = this.confirmation ? 'Enter confirmed retry · Esc/q dismiss · Ctrl+C close UI only'
      : '↑↓/Home/End select · Enter drill · Esc/q back · p pause/resume admission · x cancel whole workflow · r retry · c coding · Ctrl+C close UI';
    const output = [...header.slice(0, headerCount).map((line, i) => styleText(this.theme, i === 0 ? 'accent' : 'muted', sanitizeUiText(line))),
      ...body.map((line) => sanitizeUiText(line)), ...(footerCount ? [styleText(this.theme, 'dim', footer)] : [])].slice(0, h).map((line) => truncateToWidth(line, w, '', true));
    if (this.confirmation) this.confirmationRendered = true;
    else if (shown && run) {
      if (this.state.level === 'list') {
        const view = views.find((row) => row.workflowRunId === run.workflowRunId);
        if (!view || view.familyId !== run.familyId || view.attemptNo !== run.attemptNo || view.createdAt !== run.createdAt || view.status !== run.status || view.cleanupSettled !== run.cleanupSettled) return output;
      }
      const stepId = this.state.level === 'list' ? undefined : this.state.stepId;
      const unitId = ['units', 'result'].includes(this.state.level) ? this.state.unitId : undefined;
      this.proof = { iterationId: this.state.iterationId, runId: run.workflowRunId, stepId, unitId, identity: identity(run, stepId, unitId), status: run.status, cleanup: run.cleanupSettled };
    }
    return output;
  }
  private current(proof: Proof | undefined): WorkflowRun | undefined {
    if (!proof || proof.runId !== this.state.runId || (proof.stepId !== undefined && proof.stepId !== this.state.stepId) || (proof.unitId !== undefined && proof.unitId !== this.state.unitId)) return;
    const run = this.options.service.get(proof.runId);
    if (proof.iterationId !== this.state.iterationId) return;
    if (proof.iterationId && (!run || run.steps.find((row) => row.id === this.state.blockId)?.iterations?.filter((row) => row.id === proof.iterationId).length !== 1)) return;
    if (!run || identity(run, proof.stepId, proof.unitId) !== proof.identity) return;
    return run;
  }
  handleInput(data: string): void {
    if (this.disposed || isKeyRelease(data)) return;
    // Drop entire paste streams, never interpret a later chunk as a control shortcut.
    if (this.rejectingPaste || data.includes('\x1b[200~')) {
      const ended = (this.pasteTail + data).includes('\x1b[201~');
      this.rejectingPaste = !ended; this.pasteTail = ended ? '' : data.slice(-5); return;
    }
    if (data.length > 64 || data.includes('\x1b[201~') || (/[\x00-\x1f\x7f-\x9f]/u.test(data)
      && !['\x1b', '\x03', '\r', '\n'].includes(data) && !/^\x1b\[[0-9;:]*[A-Za-z~]$/.test(data) && !/^\x1bO[A-Za-z]$/.test(data))) return;
    if (matchesKey(data, 'ctrl+c')) { this.dispose(); return; }
    if (matchesKey(data, 'escape', 'q')) {
      if (this.confirmation) { this.confirmation = undefined; this.confirmationRendered = false; }
      else if (this.state.level === 'list') { this.dispose(); return; }
      else {
        if (this.state.level === 'result') this.state.level = 'units';
        else if (this.state.level === 'units') this.state.level = this.state.blockId ? 'body' : 'steps';
        else if (this.state.level === 'body') { this.state.level = 'iterations'; this.state.stepId = this.state.blockId; }
        else if (this.state.level === 'iterations') { this.state.level = 'steps'; this.state.stepId = this.state.blockId; this.state.blockId = this.state.iterationId = undefined; }
        else this.state.level = 'list';
        this.proof = undefined; this.state.restoredIdentity = undefined; this.state.scroll = 0;
      }
      this.redraw(); return;
    }
    if (this.pending) return;
    try {
      if (this.confirmation) {
        if (matchesKey(data, 'enter')) {
          const proof = this.confirmation;
          if (!this.confirmationRendered) { this.notice = 'Confirmation not yet rendered; repeat after redraw.'; }
          else { this.confirmation = undefined; this.confirmationRendered = false; this.control('workflows.retry', proof); }
        }
      } else if (matchesKey(data, 'p', 'x', 'r', 'c', 'enter')) {
        const proof = this.proof; const run = this.current(proof);
        if (!run || !proof) { this.notice = 'Selection changed/missing/not yet rendered; no action taken.'; this.proof = undefined; }
        else if (matchesKey(data, 'p')) {
          if (proof.status === 'running' || proof.status === 'paused') this.control(proof.status === 'paused' ? 'workflows.resume' : 'workflows.pause', proof);
          else this.notice = 'Pause/resume unavailable for this rendered state.';
        } else if (matchesKey(data, 'x')) this.control('workflows.cancel', proof);
        else if (matchesKey(data, 'r')) {
          if (run.status !== proof.status || run.cleanupSettled !== proof.cleanup || !terminal(run) || !run.cleanupSettled) this.notice = 'Retry requires terminal attempt and settled cleanup; redraw before retry.';
          else { this.confirmation = { ...proof }; this.confirmationRendered = false; }
        } else if (matchesKey(data, 'c')) {
          const native = copyNative(nativeOf(workflowStepEntries(run).find(({ step }) => step.id === proof.stepId)?.step.units.find((unit) => unit.id === proof.unitId)));
          if (!native || !this.options.onOpenNative) this.notice = 'Select a unit with exact recorded native identity; coding unavailable.';
          else { this.finish({ native, state: { ...this.state, restoredIdentity: proof.identity } }); return; }
        } else {
          if (this.state.level === 'list') this.state.level = 'steps';
          else if (this.state.level === 'iterations') { this.state.level = 'body'; this.state.stepId = undefined; }
          else if (this.state.level === 'steps' || this.state.level === 'body') {
            const entry = workflowStepEntries(run).find(({ step }) => step.id === this.state.stepId);
            if (entry?.spec.kind === 'repeat') { this.state.level = 'iterations'; this.state.blockId = this.state.stepId; this.state.iterationId = undefined; }
            else this.state.level = 'units';
          } else this.state.level = 'result';
          this.state.restoredIdentity = undefined; this.state.scroll = 0; this.proof = undefined;
        }
      } else if (this.state.level === 'result' && matchesKey(data, 'up', 'down', 'pageup', 'pagedown', 'home', 'end')) {
        this.state.scroll = matchesKey(data, 'home') ? 0 : matchesKey(data, 'end') ? 512 : Math.max(0, this.state.scroll + (matchesKey(data, 'up', 'pageup') ? -1 : 1) * (matchesKey(data, 'pageup', 'pagedown') ? this.viewport : 1));
      } else if (matchesKey(data, 'up', 'down', 'home', 'end')) {
        const index = this.rows.indexOf(this.selectedId() ?? '');
        const next = matchesKey(data, 'home') ? 0 : matchesKey(data, 'end') ? this.rows.length - 1 : Math.max(0, Math.min(this.rows.length - 1, index + (matchesKey(data, 'up') ? -1 : 1)));
        this.select(this.rows[next]);
      }
    } catch (error) { this.proof = undefined; this.notice = `Workflow action unavailable: ${uiErrorText(error)}`; }
    this.redraw();
  }
  private control(action: Extract<WorkflowAction, { workflowRunId: string }>['action'], proof: Proof): void {
    const run = this.current(proof);
    if (!run || run.status !== proof.status || run.cleanupSettled !== proof.cleanup) { this.notice = 'Rendered attempt state changed; redraw before control.'; this.proof = undefined; return; }
    if (action === 'workflows.retry' && (!terminal(run) || !run.cleanupSettled)) { this.notice = 'Retry blocked: cleanup not settled.'; return; }
    this.pending = true; this.proof = undefined;
    // Do not abort the workflow when the UI closes; control ownership belongs to the service.
    void (async () => {
      try {
        const reply = await this.options.service.execute({ action, workflowRunId: proof.runId });
        if (!this.disposed) this.notice = reply.ok ? `${action} accepted${reply.view ? ` · ${reply.view.workflowRunId} · ${reply.view.status}` : ''}.` : `Control rejected: ${sanitizeUiText(reply.error)}`;
      } catch (error) { if (!this.disposed) this.notice = `Control failed: ${uiErrorText(error)}`; }
      finally { if (!this.disposed) { this.pending = false; this.redraw(); } }
    })();
  }
  dispose(): void { this.finish(); }
  private finish(result?: CodingResult): void {
    if (this.disposed) return;
    this.disposed = true; const unsubscribe = this.unsubscribe; this.unsubscribe = undefined;
    this.proof = undefined; this.confirmation = undefined; this.rows = []; this.focused = false;
    cleanup(unsubscribe); cleanup(() => this.done?.(result));
  }
}
