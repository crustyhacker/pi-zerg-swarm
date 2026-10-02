import { Input, type Component, type Focusable } from '@earendil-works/pi-tui';
import type { AutomationMode, StructuralPiCommandContext, StructuralPiCustomComponent, StructuralPiTuiHandle, ZergControlController, ZergManagementTargetKind, ZergManagementUiState, ZergOperatorMessageDeliveryStatus, ZergState } from '../types.js';
import { boldText, columns, fitRawLine, styleText, type UiThemeLike } from './components.js';
import { ChatPaneActions, cancelChatDraft, renderChatPane, sendChatDraft } from './chat-pane.js';
import { renderDetailPane, resolveSelectedTarget } from './detail-pane.js';
import { renderManagementFooter } from './footer.js';
import { SettingsPaneActions, applyPermissionFromSettings, createSettingsPaneState, cycleController, movePendingPermissionCursor, renderSettingsPane } from './settings-pane.js';
import { MANAGEMENT_PANES, createManagementUiState, matchesKey, movePaneFocus, setSelectedTarget } from './state.js';
import { activateTreeSelection, buildManagementTreeRows, collapseTreeSelection, createTreePaneState, expandTreeSelection, moveTreeCursor, renderTreePane } from './tree-pane.js';

export interface ZergManagementOverlayActions extends SettingsPaneActions, ChatPaneActions {
  selectTarget(target: { id: string; kind: ZergManagementTargetKind }): string;
  interruptSelected(target: { id: string; kind: ZergManagementTargetKind } | undefined): string;
}

export interface ZergManagementOverlayOptions {
  getSnapshot(): ZergState;
  subscribe(listener: () => void): () => void;
  adapterKind: string;
  actions: ZergManagementOverlayActions;
  viewCoding?(target: { id: string; kind: ZergManagementTargetKind } | undefined): Promise<void>;
}

export async function openZergManagementOverlay(context: StructuralPiCommandContext, options: ZergManagementOverlayOptions): Promise<void> {
  await Promise.resolve(context.ui?.custom?.(
    (tui?: StructuralPiTuiHandle, theme?: unknown, _keybindings?: unknown, done?: (result?: void) => void) => new ZergManagementOverlayComponent(tui, theme as UiThemeLike | undefined, () => done?.(undefined), options),
    {
      overlay: true,
      overlayOptions: {
        title: 'zerg config',
        anchor: 'center',
        width: '78%',
        maxHeight: '82%',
        minWidth: 72,
      },
    },
  ));
}

export class ZergManagementOverlayComponent implements StructuralPiCustomComponent, Component, Focusable {
  focused = false;
  private readonly uiState: ZergManagementUiState = createManagementUiState();
  private readonly treeState = createTreePaneState();
  private readonly settingsState = createSettingsPaneState();
  private readonly chatInput = new Input();
  private codingViewerOpen = false;
  private disposed = false;
  private unsubscribe: () => void;
  private cachedWidth?: number;
  private cachedHeight?: number;
  private cachedLines?: string[];

  constructor(
    private readonly tui: StructuralPiTuiHandle | undefined,
    private readonly theme: UiThemeLike | undefined,
    private readonly done: (() => void) | undefined,
    private readonly options: ZergManagementOverlayOptions,
  ) {
    this.chatInput.onSubmit = (value) => {
      this.uiState.chatDraft = value;
      this.uiState.statusMessage = sendChatDraft(this.options.getSnapshot(), this.uiState, this.options.actions);
      this.chatInput.setValue('');
    };
    this.chatInput.onEscape = () => {
      this.dispose();
    };
    this.unsubscribe = options.subscribe(() => this.requestRender());
  }

  render(width = 120, requestedHeight?: number): string[] {
    const height = this.resolveHeight(requestedHeight);
    if (this.cachedLines && this.cachedWidth === width && this.cachedHeight === height) {
      return this.cachedLines;
    }
    const snapshot = this.options.getSnapshot();
    const safeWidth = Math.max(72, Math.floor(width));
    const safeHeight = Math.max(18, Math.floor(height));
    this.ensureDefaultTarget(snapshot);
    const footer = renderManagementFooter(snapshot, this.uiState, this.options.adapterKind, safeWidth, this.theme);
    const header = this.renderHeader(snapshot, safeWidth);
    const bodyHeight = Math.max(8, safeHeight - header.length - footer.length - 1);
    const topHeight = Math.max(4, Math.floor(bodyHeight * 0.58));
    const bottomHeight = Math.max(4, bodyHeight - topHeight);
    const leftWidth = Math.max(30, Math.floor((safeWidth - 2) * 0.42));
    const rightWidth = safeWidth - 2 - leftWidth;
    const tree = renderTreePane(snapshot, this.uiState, this.treeState, leftWidth, topHeight, this.theme);
    const detail = renderDetailPane(snapshot, this.uiState, rightWidth, topHeight, this.theme);
    const settings = renderSettingsPane(snapshot, this.uiState, this.settingsState, this.options.adapterKind, leftWidth, bottomHeight, this.theme);
    this.chatInput.focused = this.focused && this.uiState.focusedPane === 'chat';
    const composerLines = this.chatInput.render(Math.max(8, rightWidth - 12));
    const chat = renderChatPane(snapshot, this.uiState, rightWidth, bottomHeight, composerLines, this.theme);
    const body = [
      ...columns(tree, detail, safeWidth),
      ...columns(settings, chat, safeWidth),
    ];
    this.cachedWidth = width;
    this.cachedHeight = height;
    this.cachedLines = [...header, ...body, '', ...footer].map((line) => fitRawLine(line, safeWidth)).slice(0, safeHeight);
    return this.cachedLines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedHeight = undefined;
    this.cachedLines = undefined;
  }

  handleInput(data: string): void {
    if (this.disposed) return;
    if (matchesKey(data, 'escape') || ((data === 'q' || data === 'Q') && (this.uiState.focusedPane !== 'chat' || this.uiState.chatDraft.length === 0))) {
      this.dispose();
      return;
    }
    if (this.uiState.focusedPane === 'chat' && this.isChatTextInput(data)) {
      this.handleChatInput(data);
      this.requestRender();
      return;
    }
    if (matchesKey(data, 'tab')) {
      movePaneFocus(this.uiState, 1);
      this.requestRender();
      return;
    }
    if (matchesKey(data, 'shift-tab')) {
      movePaneFocus(this.uiState, -1);
      this.requestRender();
      return;
    }
    if ((data === 'v' || data === 'V') && (this.uiState.focusedPane === 'tree' || this.uiState.focusedPane === 'detail')) {
      this.openCodingViewer();
      return;
    }

    if (this.handleGlobalAction(data)) {
      this.requestRender();
      return;
    }

    switch (this.uiState.focusedPane) {
      case 'tree':
        this.handleTreeInput(data);
        break;
      case 'settings':
        this.handleSettingsInput(data);
        break;
      case 'chat':
        this.handleChatInput(data);
        break;
      case 'detail':
        if (matchesKey(data, 'enter')) {
          this.uiState.statusMessage = 'detail pane is read-only; use tree/settings/chat actions';
        }
        break;
    }
    this.requestRender();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
    this.done?.();
  }

  getStateForTests(): ZergManagementUiState {
    return {
      ...this.uiState,
      expandedNodeIds: [...this.uiState.expandedNodeIds],
      messages: this.uiState.messages.map((message) => ({ ...message })),
    };
  }

  private resolveHeight(requestedHeight?: number): number {
    if (typeof requestedHeight === 'number') {
      return Math.max(18, Math.floor(requestedHeight));
    }
    const rows = typeof this.tui?.terminal?.rows === 'number' ? this.tui.terminal.rows : 32;
    return Math.max(18, Math.floor(rows * 0.82));
  }

  private requestRender(): void {
    if (this.disposed) return;
    this.invalidate();
    try { this.tui?.requestRender?.(); } catch { this.uiState.statusMessage = 'management redraw unavailable'; }
  }

  private renderHeader(snapshot: ZergState, width: number): string[] {
    const counts = `${Object.keys(snapshot.teams).length} teams · ${Object.keys(snapshot.agents).length} agents · ${Object.keys(snapshot.tasks).length} tasks`;
    const pendingPermissions = this.countPendingPermissions(snapshot);
    const readOnly = snapshot.mode.readOnly ? styleText(this.theme, 'warning', 'read-only on') : styleText(this.theme, 'success', 'edits allowed');
    const title = boldText(this.theme, styleText(this.theme, 'accent', 'zerg config'));
    return [
      fitRawLine(`${title} ${styleText(this.theme, 'muted', '·')} ${styleText(this.theme, 'muted', counts)} ${styleText(this.theme, 'muted', '·')} ${readOnly}`, width),
      fitRawLine(`${styleText(this.theme, 'dim', 'Use three steps:')} ${styleText(this.theme, 'accent', 'Select')} → ${styleText(this.theme, 'accent', 'Settings')} → ${styleText(this.theme, 'accent', 'Message')}   ${styleText(this.theme, 'dim', 'Tab changes focus')}`, width),
      fitRawLine(`${styleText(this.theme, 'muted', 'Mode')} ${snapshot.mode.automation}   ${styleText(this.theme, 'muted', 'Controller')} ${this.resolveControlController(snapshot)}   ${styleText(this.theme, 'muted', 'Pending approvals')} ${pendingPermissions}`, width),
    ];
  }

  private ensureDefaultTarget(snapshot: ZergState): void {
    if (this.uiState.selectedTargetId && this.uiState.selectedTargetKind) return;
    const rows = buildManagementTreeRows(snapshot, this.uiState);
    const existing = resolveSelectedTarget(snapshot, this.uiState);
    if (existing) {
      setSelectedTarget(this.uiState, existing.id, existing.kind);
      const existingIndex = rows.findIndex((row) => row.targetId === existing.id && row.targetKind === existing.kind);
      if (existingIndex >= 0) this.treeState.cursor = existingIndex;
      return;
    }
    const firstTargetIndex = rows.findIndex((row) => row.targetId && row.targetKind);
    if (firstTargetIndex < 0) return;
    const firstTarget = rows[firstTargetIndex]!;
    this.treeState.cursor = firstTargetIndex;
    setSelectedTarget(this.uiState, firstTarget.targetId, firstTarget.targetKind);
  }

  private resolveControlController(snapshot: ZergState): string {
    const candidate = snapshot.extensions.zergControl as { controller?: unknown } | undefined;
    return candidate?.controller === 'pi' || candidate?.controller === 'zerg' || candidate?.controller === 'operator'
      ? candidate.controller
      : 'operator';
  }

  private countPendingPermissions(snapshot: ZergState): number {
    const candidate = snapshot.extensions.zergPermissions;
    if (!candidate || typeof candidate !== 'object' || !Array.isArray((candidate as { requests?: unknown }).requests)) {
      return 0;
    }
    return (candidate as { requests: Array<{ status?: unknown }> }).requests.filter((request) => request.status === 'pending').length;
  }

  private isChatTextInput(data: string): boolean {
    return !matchesKey(data, 'tab', 'shift-tab');
  }

  private openCodingViewer(): void {
    if (this.codingViewerOpen) return;
    if (!this.options.viewCoding) {
      this.uiState.statusMessage = 'coding viewer unavailable';
      this.requestRender();
      return;
    }
    this.ensureDefaultTarget(this.options.getSnapshot());
    const target = resolveSelectedTarget(this.options.getSnapshot(), this.uiState);
    this.codingViewerOpen = true;
    this.uiState.statusMessage = 'opening read-only coding viewer';
    this.requestRender();
    // Promise boundary catches synchronous throws as well as async host failures.
    void Promise.resolve().then(() => {
      if (!this.disposed) return this.options.viewCoding?.(target);
    }).then(() => {
      if (!this.disposed) this.uiState.statusMessage = 'coding viewer closed';
    }, (error: unknown) => {
      if (!this.disposed) this.uiState.statusMessage = `coding viewer unavailable: ${String(error)}`;
    }).finally(() => {
      this.codingViewerOpen = false;
      this.requestRender();
    });
  }
  private handleGlobalAction(data: string): boolean {
    if (data === 'r' || data === 'R') {
      this.uiState.statusMessage = this.options.actions.toggleReadOnly();
      return true;
    }
    if (data === 'm' || data === 'M') {
      this.uiState.statusMessage = this.options.actions.setAutomation('manual');
      return true;
    }
    if (data === 'a' || data === 'A') {
      this.uiState.statusMessage = this.options.actions.setAutomation('assisted');
      return true;
    }
    if (data === 'u' || data === 'U') {
      this.uiState.statusMessage = this.options.actions.setAutomation('automatic');
      return true;
    }
    if (data === 'c' || data === 'C') {
      this.uiState.statusMessage = cycleController(this.options.getSnapshot(), this.options.actions);
      return true;
    }
    if (data === 'i' || data === 'I') {
      const selected = this.uiState.selectedTargetId && this.uiState.selectedTargetKind ? { id: this.uiState.selectedTargetId, kind: this.uiState.selectedTargetKind } : undefined;
      this.uiState.statusMessage = this.options.actions.interruptSelected(selected);
      return true;
    }
    if (data === 'p' || data === 'P') {
      this.uiState.statusMessage = applyPermissionFromSettings(this.settingsState, this.options.getSnapshot(), 'approve', this.options.actions);
      return true;
    }
    if (data === 'd' || data === 'D') {
      this.uiState.statusMessage = applyPermissionFromSettings(this.settingsState, this.options.getSnapshot(), 'deny', this.options.actions);
      return true;
    }
    return false;
  }

  private handleTreeInput(data: string): void {
    const rows = buildManagementTreeRows(this.options.getSnapshot(), this.uiState);
    if (matchesKey(data, 'up')) {
      moveTreeCursor(this.treeState, rows, -1);
      this.uiState.statusMessage = 'tree cursor moved; press enter to confirm selection';
    } else if (matchesKey(data, 'down')) {
      moveTreeCursor(this.treeState, rows, 1);
      this.uiState.statusMessage = 'tree cursor moved; press enter to confirm selection';
    } else if (matchesKey(data, 'left')) {
      collapseTreeSelection(this.uiState, this.treeState, rows);
      this.uiState.statusMessage = 'tree node collapsed';
    } else if (matchesKey(data, 'right')) {
      expandTreeSelection(this.uiState, this.treeState, rows);
      this.uiState.statusMessage = 'tree node expanded';
    } else if (matchesKey(data, 'enter') || matchesKey(data, 'space')) {
      const row = activateTreeSelection(this.uiState, this.treeState, rows);
      this.uiState.statusMessage = row?.targetId && row.targetKind
        ? this.options.actions.selectTarget({ id: row.targetId, kind: row.targetKind })
        : 'tree group toggled';
    }
  }

  private handleSettingsInput(data: string): void {
    if (matchesKey(data, 'up')) {
      movePendingPermissionCursor(this.settingsState, this.options.getSnapshot(), -1);
      this.uiState.statusMessage = 'permission cursor moved';
    } else if (matchesKey(data, 'down')) {
      movePendingPermissionCursor(this.settingsState, this.options.getSnapshot(), 1);
      this.uiState.statusMessage = 'permission cursor moved';
    } else if (matchesKey(data, 'enter')) {
      this.uiState.statusMessage = 'settings focused: use r/m/a/u/c/p/d action keys';
    }
  }

  private handleChatInput(data: string): void {
    if (matchesKey(data, 'enter')) {
      this.uiState.chatDraft = this.chatInput.getValue();
      this.uiState.statusMessage = sendChatDraft(this.options.getSnapshot(), this.uiState, this.options.actions);
      this.chatInput.setValue('');
      return;
    }
    if (matchesKey(data, 'ctrl+x')) {
      this.chatInput.setValue('');
      this.uiState.statusMessage = cancelChatDraft(this.uiState);
      return;
    }
    this.chatInput.handleInput(data);
    this.uiState.chatDraft = this.chatInput.getValue();
    if (this.uiState.chatDraft) {
      this.uiState.statusMessage = 'editing chat draft';
    }
  }
}

export function paneOrderForTests(): readonly string[] {
  return MANAGEMENT_PANES;
}
