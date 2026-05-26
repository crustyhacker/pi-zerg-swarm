import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { createInterface } from 'node:readline';

import { installInternalPatch } from './internal-patch.js';
import { createZergPersistenceManager, type ZergPersistenceManager } from './persistence.js';
import { deriveThinkingSteps } from './parse.js';
import { openZergManagementOverlay } from './ui/management-overlay.js';
import { renderAgentDefinitionSummary, renderAgentDefinitionsList, renderAgentTree, renderHelp, renderMonitor, renderPermissionQueueList, renderPermissionQueueStatus, renderStatusLine, renderZergLogList, renderZergLogStatus, renderZergLogSummary, renderZergManagementOverlay, renderZergSubagentRunList, renderZergSubagentRunSummary, type ZergManagementOverlayRow } from './render.js';
import { appendZergLogRecord, applyInterventionRecord, applyModeTransition, applyRuntimeTransition, createZergState, createZergStateContainer, createZergSubagentRunSnapshot, enqueuePermissionRequest, getAgentDefinition, getAgentDefinitions, getPendingPermissionRequests, getPermissionQueueState, getSubagentRunSnapshot, getSubagentRunSnapshots, getZergLogs, getZergLogState, readSharedZergState, removeAgentDefinition, replaceSharedZergState, resolvePermissionRequest, seedBuiltinAgentDefinitions, snapshotZergState, upsertAgentDefinition, upsertTask, type ZergLogFilter } from './state.js';
import { ZERG_COMMANDS, type AgentKind, type AgentStatus, type AutomationMode, type PermissionModeTransitionInput, type StructuralPiCommand, type StructuralPiCommandContext, type StructuralPiCommandOptions, type StructuralPiExtensionContext, type StructuralPiToolDefinition, type StructuralPiTuiHandle, type TeamKind, type ZergAgentDefinition, ZERG_EXTENSION_VERSION, type ZergCommandName, type ZergCommandResult, type ZergConfigOverlayTab, type ZergControl, type ZergControlAction, type ZergControlController, type ZergControlResult, type ZergControlState, type ZergInternalPatchController, type ZergLifecycleSubstate, type ZergManagementTargetKind, type ZergOperatorMessageDeliveryStatus, type ZergOperatorMessageResult, type ZergPersistenceOptions, type ZergPermissionDecision, type ZergPermissionRequestKind, type ZergPiCommandHandler, type ZergRuntimeEntity, type ZergRuntimeTransition, type ZergRuntimeTransitionAction, type ZergState, type ZergStateContainer, type ZergSubagentControlAdapter, type ZergSubagentLaunchMode, type ZergSubagentLaunchRequest, type ZergSubagentRunSnapshot } from './types.js';

type ZergIdFactory = {
  runId?: () => string;
  taskId?: () => string;
};

export interface ZergCommandHandlerOptions {
  now?: () => Date;
  subagentAdapter?: ZergSubagentControlAdapter;
  idFactory?: ZergIdFactory;
  persistence?: ZergPersistenceOptions;
}

type RuntimeCommandOptions = ZergCommandHandlerOptions & { syncSharedState?: boolean; persistenceManager?: ZergPersistenceManager };

export interface ZergExtensionRegistration {
  commands: ZergCommandName[];
  control: ZergControl;
  /**
   * Snapshot of extension state at access time.
   *
   * Treat this as a read-only view: mutating the returned object does not update
   * live extension or shared state. Use state helpers or ZergStateContainer
   * read/update/replace APIs as the write channel.
   */
  readonly state: ZergState;
  patchInstalled: boolean;
  dispose(): void;
}

type ZergCommandTopic = 'help' | 'status' | 'tree' | 'steps' | 'agent' | 'team' | 'mode' | 'intervene' | 'monitor' | 'control' | 'config' | 'run' | 'interrupt' | 'agents' | 'runs' | 'permission' | 'logs';
type ZergCommandDispatcher = (payload: string) => ZergCommandResult;
type RuntimeParseResult = { ok: false; output: string } | { ok: true; transition: ZergRuntimeTransition };
type LogsParseResult = { ok: false; output: string } | { ok: true; filter: ZergLogFilter; json: boolean };

type ModeTransitionAction = 'status' | 'manual' | 'assisted' | 'automatic' | 'revert';
type ModeParseResult =
  | { ok: false; output: string }
  | { ok: true; action: ModeTransitionAction; reason?: string };
type InterveneKind = 'agent' | 'subagent' | 'leader';
type InterveneParseResult =
  | { ok: false; output: string }
  | {
    ok: true;
    kind: InterveneKind;
    targetId: string;
    targetLabel?: string;
    teamId?: string;
    leaderAgentId?: string;
    message: string;
  };
type ZergStateSource = ZergState | (() => ZergState) | ZergStateContainer;

const RUNTIME_WRITABLE_STATE_ERROR = 'Runtime lifecycle commands require writable zerg state.';
const MAX_INTERVENTION_MESSAGE_LENGTH = 240;
const MAX_INTERVENTION_MESSAGE_LENGTH_FOR_REASONS = 140;
const ZERG_CONTROL_EXTENSION_KEY = 'zergControl';
const CONFIG_OVERLAY_TABS: ZergConfigOverlayTab[] = ['monitor', 'control', 'targets', 'permissions', 'lifecycle', 'logs', 'intervene', 'config'];
const SLASH_SUBAGENT_REQUEST_EVENT = 'subagent:slash:request';
const SLASH_SUBAGENT_STARTED_EVENT = 'subagent:slash:started';
const SLASH_SUBAGENT_RESPONSE_EVENT = 'subagent:slash:response';
const SLASH_SUBAGENT_UPDATE_EVENT = 'subagent:slash:update';
const SLASH_SUBAGENT_CANCEL_EVENT = 'subagent:slash:cancel';
const DEFAULT_RUN_ID_PREFIX = 'zerg-';
const DEFAULT_TASK_ID_PREFIX = 'task-';
const NATIVE_BRIDGE_ACK_GRACE_MS = 100;
const OVERLAY_VISIBLE_ROWS = 14;
const DEFAULT_OVERLAY_INTERVENTION_DRAFT = 'operator intervention requested from overlay';
const OVERLAY_FILTER_DEFERRED_MESSAGE = 'text filter entry is deferred; use /zerg permission, /zerg logs, or /zerg runs command filters.';

const defaultIdFactory: Required<ZergIdFactory> = {
  runId: () => `${DEFAULT_RUN_ID_PREFIX}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  taskId: () => `${DEFAULT_TASK_ID_PREFIX}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
};

type PiNativeSessionHandle = {
  prompt?: (message: string, options?: { source?: string }) => Promise<unknown> | unknown;
  abort?: () => Promise<void> | void;
  dispose?: () => void;
};

type PiNativeActiveRun = {
  runId: string;
  cancelRequested: boolean;
  sessions: Set<PiNativeSessionHandle>;
  promise?: Promise<void>;
};

type PiNativeActiveRunRegistry = Map<string, PiNativeActiveRun>;


interface NormalizedZergCommandInput {
  topic: string;
  payload: string;
}

interface OverlayConfirmationState {
  action: 'approve' | 'deny';
  rowId: string;
  requestId: string;
}

interface SelectedCommandRegistrar {
  target: object;
  registerCommand(name: ZergCommandName, options: StructuralPiCommandOptions): unknown;
}

interface RegisteredCommandDisposer {
  target: object;
  name: ZergCommandName;
  dispose(): void;
}

interface DisposableRegistration {
  dispose(): void;
}

const registeredCommandsByTarget = new WeakMap<object, Set<ZergCommandName>>();

export function registerZergSwarmExtension(
  context: StructuralPiExtensionContext = {},
  options: ZergCommandHandlerOptions = {},
): ZergExtensionRegistration {
  const sharedSeedSource = readSharedZergState();
  const sharedSeed = seedBuiltinAgentDefinitions(sharedSeedSource);
  const stateContainer = createZergStateContainer(sharedSeed);
  const persistenceManager = createZergPersistenceManager(options.persistence);
  persistenceManager?.hydrate(stateContainer, options.now);
  if (sharedSeed !== sharedSeedSource) {
    replaceSharedZergState(stateContainer.snapshot());
  }
  let patch: ZergInternalPatchController | undefined;
  const commandDisposers: RegisteredCommandDisposer[] = [];
  const toolDisposers: DisposableRegistration[] = [];

  const syncSharedStateFromContainer = () => {
    replaceSharedZergState(stateContainer.snapshot());
  };

  const syncedStateContainer: ZergStateContainer = {
    read: () => stateContainer.read(),
    snapshot: () => stateContainer.snapshot(),
    replace: (nextState) => {
      const snapshot = stateContainer.replace(nextState);
      syncSharedStateFromContainer();
      persistenceManager?.save(snapshot, options.now);
      return snapshot;
    },
    update: (nextState, patchOptions) => {
      const snapshot = stateContainer.update(nextState, patchOptions);
      syncSharedStateFromContainer();
      persistenceManager?.save(snapshot, options.now);
      return snapshot;
    },
    subscribe: (listener) => stateContainer.subscribe?.(listener) ?? (() => undefined),
  };
  const runtimeOptions = { ...options, syncSharedState: true, persistenceManager } as RuntimeCommandOptions;
  const subagentAdapter = options.subagentAdapter ?? createPiSlashBridgeAdapter(context, syncedStateContainer, runtimeOptions);
  const control = createZergControl(syncedStateContainer, { ...runtimeOptions, subagentAdapter });

  try {
    const installedPatch = installInternalPatch(context, syncedStateContainer);
    patch = installedPatch;
    const handler = createPiZergCommandHandler(syncedStateContainer, { ...options, subagentAdapter, syncSharedState: true } as RuntimeCommandOptions);

    for (const name of ZERG_COMMANDS) {
      const commandDisposer = registerCommand(context, {
        name,
        description: 'Show pi-zerg-swarm command-surface status and help.',
        handler,
      });

      if (commandDisposer) {
        commandDisposers.push(commandDisposer);
      }
    }

    const toolDisposer = registerZergControlTool(context, control);
    if (toolDisposer) {
      toolDisposers.push(toolDisposer);
    }

    patch.emit({
      type: 'hook',
      message: patch.installed
        ? `pi-zerg-swarm v${ZERG_EXTENSION_VERSION} internal patch path active`
        : `pi-zerg-swarm v${ZERG_EXTENSION_VERSION} internal patch unavailable; command surface registered`,
      status: patch.installed ? 'running' : 'done',
    });
  } catch (error) {
    disposeStartupResources(commandDisposers, patch);
    for (const toolDisposer of toolDisposers.splice(0)) {
      try {
        toolDisposer.dispose();
      } catch {
        // Preserve startup failure.
      }
    }
    throw error;
  }

  const installedPatch = patch;
  let disposed = false;

  return {
    commands: [...ZERG_COMMANDS],
    control,
    get state() {
      return stateContainer.snapshot();
    },
    patchInstalled: installedPatch.installed,
    dispose() {
      if (disposed) {
        return;
      }

      disposed = true;
      let firstError: unknown;

      for (const commandDisposer of commandDisposers.splice(0)) {
        try {
          commandDisposer.dispose();
        } catch (error) {
          firstError ??= error;
        } finally {
          clearRegisteredCommand(commandDisposer.target, commandDisposer.name);
        }
      }

      for (const toolDisposer of toolDisposers.splice(0)) {
        try {
          toolDisposer.dispose();
        } catch (error) {
          firstError ??= error;
        }
      }

      try {
        control.dispose();
      } catch (error) {
        firstError ??= error;
      }

      try {
        installedPatch.dispose();
      } catch (error) {
        firstError ??= error;
      }

      try {
        subagentAdapter.dispose?.();
      } catch (error) {
        firstError ??= error;
      }

      if (firstError) {
        throw firstError;
      }
    },
  };
}

function disposeStartupResources(
  commandDisposers: RegisteredCommandDisposer[],
  patch: ZergInternalPatchController | undefined,
): void {
  for (const commandDisposer of commandDisposers.splice(0)) {
    try {
      commandDisposer.dispose();
    } catch {
      // Preserve the original startup error while still clearing local registration bookkeeping.
    } finally {
      clearRegisteredCommand(commandDisposer.target, commandDisposer.name);
    }
  }

  try {
    patch?.dispose();
  } catch {
    // Preserve the original startup error; normal dispose() still surfaces cleanup failures.
  }
}

const PI_COMMAND_OUTPUT_WIDTH = 240;

export interface ZergControlOptions extends ZergCommandHandlerOptions {
  seedState?: Partial<ZergState>;
  syncSharedState?: boolean;
}

export function createZergControl(
  stateOrContainer: ZergStateContainer | Partial<ZergState> = createZergStateContainer(),
  options: ZergControlOptions = {},
): ZergControl {
  const baseContainer = isZergStateContainer(stateOrContainer)
    ? stateOrContainer
    : createZergStateContainer(seedBuiltinAgentDefinitions(createZergState({ ...options.seedState, ...stateOrContainer })));
  const persistenceManager = createZergPersistenceManager(options.persistence);
  persistenceManager?.hydrate(baseContainer, options.now);
  const container: ZergStateContainer = persistenceManager
    ? {
      read: () => baseContainer.read(),
      snapshot: () => baseContainer.snapshot(),
      replace: (nextState) => {
        const snapshot = baseContainer.replace(nextState);
        persistenceManager.save(snapshot, options.now);
        return snapshot;
      },
      update: (nextState, patchOptions) => {
        const snapshot = baseContainer.update(nextState, patchOptions);
        persistenceManager.save(snapshot, options.now);
        return snapshot;
      },
      subscribe: (listener) => baseContainer.subscribe?.(listener) ?? (() => undefined),
    }
    : baseContainer;
  const runtimeOptions = { ...options, persistenceManager } as RuntimeCommandOptions;
  const adapter = options.subagentAdapter ?? createPiNativeAdapter({}, container, runtimeOptions);
  runtimeOptions.subagentAdapter = adapter;

  return {
    async execute(action: ZergControlAction): Promise<ZergControlResult> {
      return executeZergControlAction(container, action, runtimeOptions);
    },
    getState() {
      return container.snapshot();
    },
    dispose() {
      if (!options.subagentAdapter) {
        adapter.dispose?.();
      }
    },
  };
}

async function executeZergControlAction(
  container: ZergStateContainer,
  action: ZergControlAction,
  options: RuntimeCommandOptions,
): Promise<ZergControlResult> {
  try {
    switch (action.action) {
      case 'status': {
        const snapshot = container.snapshot();
        return controlOk(action.action, {
          version: ZERG_EXTENSION_VERSION,
          revision: snapshot.revision,
          lifecycle: snapshot.lifecycle,
          mode: snapshot.mode,
          counts: {
            agents: Object.keys(snapshot.agents).length,
            teams: Object.keys(snapshot.teams).length,
            tasks: Object.keys(snapshot.tasks).length,
            agentDefinitions: Object.keys(snapshot.agentDefinitions).length,
            logs: getZergLogState(snapshot).records.length,
            runs: getSubagentRunSnapshots(snapshot).length,
          },
          persistence: options.persistenceManager?.info ?? { enabled: false },
        }, renderStatusLine(snapshot, { width: PI_COMMAND_OUTPUT_WIDTH }), snapshot.revision);
      }
      case 'agents.list': {
        const snapshot = container.snapshot();
        const agents = getAgentDefinitions(snapshot);
        return controlOk(action.action, { agents }, renderAgentDefinitionsList(agents, { width: PI_COMMAND_OUTPUT_WIDTH }), snapshot.revision);
      }
      case 'agents.show': {
        const snapshot = container.snapshot();
        if (!action.id) return controlError(action.action, 'invalid_request', 'agents.show requires id.', snapshot.revision);
        const agent = getAgentDefinition(snapshot, action.id);
        if (!agent) return controlError(action.action, 'not_found', `Unknown agent definition: ${action.id}`, snapshot.revision);
        return controlOk(action.action, { agent }, renderAgentDefinitionSummary(agent, { width: PI_COMMAND_OUTPUT_WIDTH }), snapshot.revision, { agentId: agent.id });
      }
      case 'agents.create':
      case 'agents.update': {
        if (!action.id) return controlError(action.action, 'invalid_request', `${action.action} requires id.`, container.snapshot().revision);
        const existing = action.action === 'agents.update' ? getAgentDefinition(container.read(), action.id) : undefined;
        if (action.action === 'agents.update' && !existing) return controlError(action.action, 'not_found', `Unknown agent definition: ${action.id}`, container.snapshot().revision);
        const prompt = action.prompt ?? existing?.prompt;
        if (!prompt?.trim()) return controlError(action.action, 'invalid_request', 'agent create/update requires prompt.', container.snapshot().revision);
        const agent: ZergAgentDefinition = {
          id: action.id,
          label: action.label ?? existing?.label ?? action.id,
          description: action.description ?? existing?.description,
          prompt,
          source: existing?.source ?? 'runtime',
          model: action.model ?? existing?.model,
          fallbackModels: action.fallbackModels ?? existing?.fallbackModels,
          maxTurns: action.maxTurns ?? existing?.maxTurns,
          tools: action.tools ?? existing?.tools,
          disallowedTools: action.disallowedTools ?? existing?.disallowedTools,
          permissionMode: action.permissionMode ?? existing?.permissionMode,
          metadata: existing?.metadata,
          extensions: existing?.extensions,
        };
        const updated = container.replace(appendLogToState(upsertAgentDefinition(container.read(), agent), options, {
          source: 'command', level: 'info', kind: 'text', message: `agent definition ${agent.id} saved`, agentId: agent.id,
        }));
        const saved = getAgentDefinition(updated, agent.id) ?? agent;
        return controlOk(action.action, { agent: saved }, `agent definition ${saved.id} saved.`, updated.revision, { agentId: saved.id });
      }
      case 'agents.delete': {
        if (!action.id) return controlError(action.action, 'invalid_request', 'agents.delete requires id.', container.snapshot().revision);
        const existing = getAgentDefinition(container.read(), action.id);
        if (!existing) return controlError(action.action, 'not_found', `Unknown agent definition: ${action.id}`, container.snapshot().revision);
        const updated = container.replace(removeAgentDefinition(container.read(), action.id));
        return controlOk(action.action, { deletedId: existing.id }, `agent definition ${existing.id} deleted.`, updated.revision, { agentId: existing.id });
      }
      case 'team.create':
      case 'team.update': {
        if (!action.id) return controlError(action.action, 'invalid_request', `${action.action} requires id.`, container.snapshot().revision);
        const current = container.read();
        const existing = current.teams[action.id];
        if (action.action === 'team.update' && !existing) return controlError(action.action, 'not_found', `Unknown team: ${action.id}`, current.revision);
        const now = options.now ?? (() => new Date());
        const memberAgentIds = action.members ?? existing?.memberAgentIds ?? [];
        const teamState = applyRuntimeTransition(current, {
          entity: 'team',
          action: existing ? 'progress' : 'create',
          id: action.id,
          label: action.label ?? existing?.label ?? action.id,
          kind: action.kind ?? existing?.kind ?? 'team',
          leaderAgentId: action.leader ?? existing?.leaderAgentId,
          memberAgentIds,
          status: existing?.status ?? 'idle',
          substate: existing?.runtime?.substate ?? 'idle',
          substateReason: 'direct control team saved',
          metadata: { ...existing?.metadata, model: action.model ?? existing?.metadata?.model, fallbackModels: action.fallbackModels ?? existing?.metadata?.fallbackModels, maxTurns: action.maxTurns ?? existing?.metadata?.maxTurns },
        }, { now });
        const updated = container.replace(appendLogToState(teamState, options, {
          source: 'command', level: 'info', kind: 'text', message: `team ${action.id} saved`, teamId: action.id,
        }));
        return controlOk(action.action, { team: updated.teams[action.id] }, `team ${action.id} saved.`, updated.revision, { teamId: action.id });
      }
      case 'run': {
        if (!action.agent || !action.task) return controlError(action.action, 'invalid_request', 'run requires agent and task.', container.snapshot().revision);
        const result = dispatchRunRequest(container, {
          agent: action.agent,
          task: action.task,
          background: action.background,
          fork: action.launchMode === 'fork',
          launchMode: action.launchMode,
          ...(action.model ? { model: action.model } : {}),
          ...(action.fallbackModels?.length ? { fallbackModels: action.fallbackModels } : {}),
          ...(action.maxTurns ? { maxTurns: action.maxTurns } : {}),
        }, options);
        if (!result.ok) return controlError(action.action, 'launch_failed', result.output, container.snapshot().revision, { runId: result.runId, taskId: result.taskId });
        if (result.runId && !action.background && options.subagentAdapter?.awaitRun) {
          await options.subagentAdapter.awaitRun(result.runId);
        }
        const snapshot = container.snapshot();
        const run = result.runId ? getSubagentRunSnapshot(snapshot, result.runId) ?? options.subagentAdapter?.getRun?.(result.runId) : undefined;
        return controlOk(action.action, { run, request: { ...action }, taskId: result.taskId, runId: result.runId }, result.output, snapshot.revision, { runId: result.runId, taskId: result.taskId, agentId: action.agent });
      }
      case 'runs.list': {
        const runs = resolveAvailableRuns(container, options.subagentAdapter);
        return controlOk(action.action, { runs }, renderZergSubagentRunList(runs, { width: PI_COMMAND_OUTPUT_WIDTH }), container.snapshot().revision);
      }
      case 'runs.show': {
        const snapshot = container.snapshot();
        if (!action.runId) return controlError(action.action, 'invalid_request', 'runs.show requires runId.', snapshot.revision);
        const stateRun = getSubagentRunSnapshot(snapshot, action.runId);
        const adapterRun = options.subagentAdapter?.getRun?.(action.runId);
        const run = stateRun && isTerminalRunSnapshot(stateRun) ? stateRun : adapterRun ?? stateRun;
        if (!run) return controlError(action.action, 'not_found', `Unknown run: ${action.runId}`, snapshot.revision, { runId: action.runId });
        return controlOk(action.action, { run }, renderZergSubagentRunSummary(run, { width: PI_COMMAND_OUTPUT_WIDTH }), snapshot.revision, { runId: action.runId, taskId: run.taskId, agentId: run.agentId });
      }
      case 'logs.list': {
        const snapshot = container.snapshot();
        const records = getZergLogs(snapshot, { runId: action.runId, level: action.level, limit: action.limit });
        return controlOk(action.action, { records }, renderZergLogList(records, { width: PI_COMMAND_OUTPUT_WIDTH }), snapshot.revision, { runId: action.runId });
      }
      case 'message': {
        const snapshot = container.snapshot();
        if (!action.targetId || !action.body?.trim()) return controlError(action.action, 'invalid_request', 'message requires targetId and body.', snapshot.revision, { runId: action.runId });
        const result = await options.subagentAdapter?.sendMessage?.(action.targetId, action.body, action.runId);
        if (!result) return controlError(action.action, 'transport_unavailable', 'Current adapter does not support delivered message transport.', snapshot.revision, { runId: action.runId, agentId: action.targetId });
        const nextSnapshot = container.snapshot();
        return result.ok
          ? controlOk(action.action, { message: result }, result.message, nextSnapshot.revision, { runId: result.runId, agentId: result.routedTargetId ?? action.targetId })
          : controlError(action.action, result.status === 'transport-unavailable' ? 'transport_unavailable' : 'delivery_failed', result.message, nextSnapshot.revision, { runId: result.runId, agentId: result.routedTargetId ?? action.targetId });
      }
      case 'interrupt': {
        const result = dispatchInterruptCommand(container, action.runId ?? '', options);
        const snapshot = container.snapshot();
        if (!result.ok) return controlError(action.action, 'interrupt_failed', result.output, snapshot.revision, { runId: result.runId ?? action.runId });
        const runId = result.runId ?? action.runId ?? getZergControlState(snapshot).activeRunId;
        const run = runId ? getSubagentRunSnapshot(snapshot, runId) ?? options.subagentAdapter?.getRun?.(runId) : undefined;
        return controlOk(action.action, { run }, result.output, snapshot.revision, { runId, taskId: run?.taskId, agentId: run?.agentId });
      }
    }

    const actionName = typeof (action as { action?: unknown }).action === 'string'
      ? (action as { action: ZergControlAction['action'] }).action
      : 'status';
    return controlError(actionName, 'invalid_request', `Unknown zerg control action: ${String((action as { action?: unknown }).action)}`, container.snapshot().revision);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const actionName = typeof (action as { action?: unknown }).action === 'string'
      ? (action as { action: ZergControlAction['action'] }).action
      : 'status';
    return controlError(actionName, 'exception', message, container.snapshot().revision);
  }
}

function controlOk(action: ZergControlAction['action'], data: unknown, output: string | undefined, stateRevision: number, ids: Partial<Pick<ZergControlResult, 'runId' | 'taskId' | 'agentId' | 'teamId'>> = {}): ZergControlResult {
  return { ok: true, action, data: cloneJsonCompatible(data), output, stateRevision, ...ids };
}

function controlError(action: ZergControlAction['action'], code: string, message: string, stateRevision: number, ids: Partial<Pick<ZergControlResult, 'runId' | 'taskId' | 'agentId' | 'teamId'>> = {}): ZergControlResult {
  return { ok: false, action, output: message, error: { code, message }, stateRevision, ...ids };
}

function cloneJsonCompatible<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;
}

function registerZergControlTool(context: StructuralPiExtensionContext, control: ZergControl): DisposableRegistration | undefined {
  if (typeof context.registerTool !== 'function') {
    return undefined;
  }

  const definition: StructuralPiToolDefinition = {
    name: 'zerg_control',
    label: 'Zerg control',
    description: 'Structured pi-zerg-swarm control API for status, agents, teams, runs, logs, and interrupts.',
    promptSnippet: 'Control pi-zerg-swarm through structured actions without slash-command or terminal automation.',
    promptGuidelines: ['Use zerg_control for pi-zerg-swarm automation instead of driving /zerg through a terminal.'],
    parameters: {
      type: 'object',
      additionalProperties: true,
      properties: {
        action: { type: 'string' },
      },
      required: ['action'],
    },
    async execute(_toolCallId: string, params: unknown) {
      const action = parseZergControlToolParams(params);
      const result = action.ok
        ? await control.execute(action.action)
        : controlError('status', 'invalid_request', action.message, control.getState().revision);
      return {
        content: [{ type: 'text', text: result.output ?? JSON.stringify(result.data ?? result.error ?? {}, null, 2) }],
        details: result,
      };
    },
  };

  const registered = context.registerTool(definition);
  return normalizeDisposableRegistration(registered);
}

function parseZergControlToolParams(params: unknown): { ok: true; action: ZergControlAction } | { ok: false; message: string } {
  if (!params || typeof params !== 'object' || typeof (params as { action?: unknown }).action !== 'string') {
    return { ok: false, message: 'zerg_control requires an object with action.' };
  }

  const actionName = (params as { action: string }).action;
  if (!isZergControlActionName(actionName)) {
    return { ok: false, message: `Unknown zerg_control action: ${actionName}` };
  }

  return { ok: true, action: params as ZergControlAction };
}

function isZergControlActionName(value: string): value is ZergControlAction['action'] {
  return value === 'status'
    || value === 'agents.list'
    || value === 'agents.show'
    || value === 'agents.create'
    || value === 'agents.update'
    || value === 'agents.delete'
    || value === 'team.create'
    || value === 'team.update'
    || value === 'run'
    || value === 'runs.list'
    || value === 'runs.show'
    || value === 'logs.list'
    || value === 'message'
    || value === 'interrupt';
}

export { createZergPersistenceManager, recoverZergStateAfterRestart } from './persistence.js';
export type { ZergControl, ZergControlAction, ZergControlResult, ZergOperatorMessageResult, ZergPersistenceInfo, ZergPersistenceOptions, ZergRunRecoveryInfo, ZergSubagentRunSnapshot } from './types.js';

export function createZergCommandHandler(
  stateOrReader: ZergStateSource,
  options: ZergCommandHandlerOptions = {},
): (input?: string) => ZergCommandResult {
  const dispatchers: Record<ZergCommandTopic, ZergCommandDispatcher> = {
    help: () => ({ ok: true, output: renderHelp(resolveZergStateSnapshot(stateOrReader)) }),
    status: () => ({ ok: true, output: renderStatusLine(resolveZergStateSnapshot(stateOrReader), { width: PI_COMMAND_OUTPUT_WIDTH }) }),
    tree: () => ({ ok: true, output: renderAgentTree(resolveZergStateSnapshot(stateOrReader), { width: PI_COMMAND_OUTPUT_WIDTH }) }),
    steps: (payload: string) => {
      const steps = deriveThinkingSteps(payload);
      const output = steps.length
        ? steps.map((step) => `${step.sourceLine}. [${step.status}] ${step.title}`).join('\n')
        : 'No thinking steps detected.';
      return { ok: true, output };
    },
    agents: (payload: string) => dispatchAgentDefinitionsCommand(stateOrReader, payload, options),
    agent: (payload: string) => dispatchRuntimeCommand(stateOrReader, 'agent', payload, options),
    team: (payload: string) => dispatchRuntimeCommand(stateOrReader, 'team', payload, options),
    mode: (payload: string) => dispatchModeCommand(stateOrReader, payload, options),
    intervene: (payload: string) => dispatchInterventionCommand(stateOrReader, payload, options),
    monitor: (payload: string) => dispatchMonitorCommand(stateOrReader, payload, options),
    control: (payload: string) => dispatchControlCommand(stateOrReader, payload, options),
    permission: (payload: string) => dispatchPermissionCommand(stateOrReader, payload, options),
    logs: (payload: string) => dispatchLogsCommand(stateOrReader, payload),
    config: () => ({ ok: true, output: renderZergConfigOverlay(resolveZergStateSnapshot(stateOrReader), { width: PI_COMMAND_OUTPUT_WIDTH, activeTab: 'config', selectedIndex: 0 }) }),
    run: (payload: string) => dispatchRunCommand(stateOrReader, payload, options),
    runs: (payload: string) => dispatchRunsCommand(stateOrReader, payload, options),
    interrupt: (payload: string) => dispatchInterruptCommand(stateOrReader, payload, options),
  };

  return (input?: string): ZergCommandResult => {
    const normalized = normalizeZergCommandInput(input);

    if (isZergCommandTopic(normalized.topic)) {
      return dispatchers[normalized.topic](normalized.payload);
    }

    return {
      ok: false,
      output: `Unknown zerg command: ${normalized.topic}\n\n${renderHelp(resolveZergStateSnapshot(stateOrReader))}`,
    };
  };
}

function normalizeZergCommandInput(input?: string): NormalizedZergCommandInput {
  const commandText = (input ?? '').trim();

  if (!commandText) {
    return { topic: 'help', payload: '' };
  }

  const routedText = stripOptionalZergInvocation(commandText);
  const topicMatch = routedText.match(/^(\S+)/);

  if (!topicMatch) {
    return { topic: 'help', payload: '' };
  }

  return {
    topic: topicMatch[1].toLowerCase(),
    payload: routedText.slice(topicMatch[0].length).trimStart(),
  };
}

function stripOptionalZergInvocation(input: string): string {
  const tokenMatch = input.match(/^(\S+)/);

  if (!tokenMatch) {
    return '';
  }

  const token = tokenMatch[1];
  const slashlessToken = token.startsWith('/') ? token.slice(1) : token;

  if (!isZergInvocationToken(slashlessToken.toLowerCase())) {
    return input;
  }

  return input.slice(token.length).trimStart();
}

function isZergInvocationToken(value: string): value is ZergCommandName {
  return (ZERG_COMMANDS as readonly string[]).includes(value);
}

function isZergCommandTopic(value: string): value is ZergCommandTopic {
  return value === 'help' || value === 'status' || value === 'tree' || value === 'steps' || value === 'agents' || value === 'agent' || value === 'team' || value === 'mode' || value === 'intervene' || value === 'monitor' || value === 'control' || value === 'permission' || value === 'logs' || value === 'config' || value === 'run' || value === 'runs' || value === 'interrupt';
}

function dispatchAgentDefinitionsCommand(
  stateOrReader: ZergStateSource,
  payload: string,
  options: RuntimeCommandOptions,
): ZergCommandResult {
  const snapshot = resolveZergStateSnapshot(stateOrReader);
  const definitions = getAgentDefinitions(snapshot);
  const tokens = tokenizeRuntimePayload(payload);
  const action = tokens[0]?.toLowerCase();

  if (!action || action === 'list' || action === 'ls') {
    if (definitions.length === 0) {
      return { ok: true, output: 'No agent definitions are currently registered.' };
    }

    return {
      ok: true,
      output: renderAgentDefinitionsList(definitions, { width: PI_COMMAND_OUTPUT_WIDTH }),
    };
  }

  if (action === 'show') {
    const id = tokens[1];
    if (!id) {
      return { ok: false, output: 'Usage: /zerg agents show <id>' };
    }

    const definition = getAgentDefinition(snapshot, id);
    if (!definition) {
      return { ok: false, output: `Unknown agent definition: ${id}` };
    }

    return {
      ok: true,
      output: renderAgentDefinitionSummary(definition, { width: PI_COMMAND_OUTPUT_WIDTH }),
    };
  }

  if (action === 'create' || action === 'update' || action === 'upsert') {
    const container = getWritableStateContainer(stateOrReader);
    if (!container) {
      return { ok: false, output: RUNTIME_WRITABLE_STATE_ERROR };
    }

    const existing = action === 'create' ? undefined : getAgentDefinition(container.read(), tokens[1] ?? '');
    const parsed = parseAgentDefinitionMutation(action, tokens.slice(1), existing);
    if (!parsed.ok) {
      return parsed;
    }

    const nextState = appendLogToState(upsertAgentDefinition(container.read(), parsed.definition), options, {
      source: 'command',
      level: 'info',
      kind: 'text',
      message: `agent definition ${parsed.definition.id} saved`,
      agentId: parsed.definition.id,
      data: { model: parsed.definition.model, fallbackModels: parsed.definition.fallbackModels, maxTurns: parsed.definition.maxTurns },
    });
    const updated = container.replace(nextState);
    if (options.syncSharedState) {
      replaceSharedZergState(updated);
    }
    return { ok: true, output: `agent definition ${parsed.definition.id} saved.\n${renderAgentDefinitionSummary(parsed.definition, { width: PI_COMMAND_OUTPUT_WIDTH })}` };
  }

  if (action === 'delete' || action === 'remove' || action === 'rm' || action === 'del') {
    const id = tokens[1];
    if (!id) {
      return { ok: false, output: 'Usage: /zerg agents delete <id>' };
    }
    const container = getWritableStateContainer(stateOrReader);
    if (!container) {
      return { ok: false, output: RUNTIME_WRITABLE_STATE_ERROR };
    }
    const existing = getAgentDefinition(container.read(), id);
    if (!existing) {
      return { ok: false, output: `Unknown agent definition: ${id}` };
    }
    const updated = container.replace(removeAgentDefinition(container.read(), id));
    if (options.syncSharedState) {
      replaceSharedZergState(updated);
    }
    return { ok: true, output: `agent definition ${existing.id} deleted.` };
  }

  return {
    ok: false,
    output: `Unknown agents action: ${action}. Available: /zerg agents list, show <id>, create|update <id> --prompt <text> [--model <model>] [--tools a,b], delete <id>`,
  };
}

function parseAgentDefinitionMutation(
  action: string,
  tokens: string[],
  existing?: ZergAgentDefinition,
): { ok: false; output: string } | { ok: true; definition: ZergAgentDefinition } {
  const id = tokens[0];
  if (!id) {
    return { ok: false, output: 'Usage: /zerg agents create <id> --prompt <text> [--label <label>] [--model <model>] [--tools a,b]' };
  }

  if (action === 'update' && !existing) {
    return { ok: false, output: `Unknown agent definition: ${id}` };
  }

  const prompt = getOptionValue(tokens, '--prompt') ?? existing?.prompt;
  if (!prompt?.trim()) {
    return { ok: false, output: 'agent definition create/update requires --prompt <text>.' };
  }

  const permissionModeInput = getOptionValue(tokens, '--permission-mode') ?? getOptionValue(tokens, '--permission') ?? existing?.permissionMode;
  if (permissionModeInput && !isAgentDefinitionPermissionMode(permissionModeInput)) {
    return { ok: false, output: `Unknown permission mode: ${permissionModeInput}` };
  }
  const permissionMode = permissionModeInput && isAgentDefinitionPermissionMode(permissionModeInput) ? permissionModeInput : undefined;

  const maxTurnsText = getOptionValue(tokens, '--max-turns') ?? getOptionValue(tokens, '--maxTurns');
  const maxTurns = maxTurnsText ? Number(maxTurnsText) : existing?.maxTurns;
  if (maxTurns !== undefined && (!Number.isSafeInteger(maxTurns) || maxTurns <= 0)) {
    return { ok: false, output: '--max-turns must be a positive integer.' };
  }

  return {
    ok: true,
    definition: {
      id,
      label: getOptionValue(tokens, '--label') ?? existing?.label ?? id,
      description: getOptionValue(tokens, '--description') ?? existing?.description,
      prompt,
      source: existing?.source ?? 'runtime',
      model: getOptionValue(tokens, '--model') ?? existing?.model,
      fallbackModels: parseCsvOption(getOptionValue(tokens, '--fallback-models') ?? getOptionValue(tokens, '--fallback')) ?? existing?.fallbackModels,
      maxTurns,
      tools: parseCsvOption(getOptionValue(tokens, '--tools') ?? getOptionValue(tokens, '--tool')) ?? existing?.tools,
      disallowedTools: parseCsvOption(getOptionValue(tokens, '--disallowed-tools') ?? getOptionValue(tokens, '--disallow')) ?? existing?.disallowedTools,
      permissionMode,
      metadata: existing?.metadata,
      extensions: existing?.extensions,
    },
  };
}

function getOptionValue(tokens: string[], name: string): string | undefined {
  const equalsPrefix = `${name}=`;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token === name) {
      return tokens[index + 1];
    }
    if (token.startsWith(equalsPrefix)) {
      return token.slice(equalsPrefix.length);
    }
  }
  return undefined;
}

function parseCsvOption(value: string | undefined): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = value.split(',').map((part) => part.trim()).filter(Boolean);
  return parsed.length > 0 ? parsed : undefined;
}

function isAgentDefinitionPermissionMode(value: string): value is AutomationMode | 'inherit' {
  return value === 'manual' || value === 'assisted' || value === 'automatic' || value === 'inherit';
}

function dispatchRuntimeCommand(
  stateOrReader: ZergStateSource,
  entity: ZergRuntimeEntity,
  payload: string,
  options: RuntimeCommandOptions,
): ZergCommandResult {
  const container = getWritableStateContainer(stateOrReader);

  if (!container) {
    return { ok: false, output: RUNTIME_WRITABLE_STATE_ERROR };
  }

  const parsed = parseRuntimeTransition(entity, payload);

  if (!parsed.ok) {
    return parsed;
  }

  const nextState = applyRuntimeTransition(container.read(), parsed.transition, {
    now: options.now ?? (() => new Date()),
  });
  const withLog = appendLogToState(nextState, options, {
    source: 'lifecycle',
    level: parsed.transition.action === 'fail' ? 'error' : 'info',
    kind: parsed.transition.action === 'fail' ? 'error' : 'text',
    message: `${parsed.transition.entity} ${parsed.transition.id} ${parsed.transition.action}`,
    agentId: parsed.transition.entity === 'agent' ? parsed.transition.id : undefined,
    teamId: parsed.transition.entity === 'team' ? parsed.transition.id : undefined,
    data: { action: parsed.transition.action },
  });
  const snapshot = container.replace(withLog);

  if (options.syncSharedState) {
    replaceSharedZergState(snapshot);
  }

  return {
    ok: true,
    output: `${parsed.transition.entity} ${parsed.transition.id} ${parsed.transition.action} applied.\n${renderStatusLine(snapshot, { width: PI_COMMAND_OUTPUT_WIDTH })}`,
  };
}


function dispatchModeCommand(
  stateOrReader: ZergStateSource,
  payload: string,
  options: RuntimeCommandOptions,
): ZergCommandResult {
  const parsed = parseModeCommand(payload);

  if (!parsed.ok) {
    return parsed;
  }

  if (parsed.action === 'status') {
    return {
      ok: true,
      output: renderStatusLine(resolveZergStateSnapshot(stateOrReader), { width: PI_COMMAND_OUTPUT_WIDTH }),
    };
  }

  const container = getWritableStateContainer(stateOrReader);

  if (!container) {
    return { ok: false, output: RUNTIME_WRITABLE_STATE_ERROR };
  }

  if (parsed.action === 'revert') {
    const current = container.read();
    const previousMode = current.mode.previousMode;

    if (!previousMode) {
      return { ok: false, output: 'No prior mode snapshot to revert to.' };
    }

    const nextState = applyModeTransition(
      current,
      {
        automation: previousMode.automation,
        controller: previousMode.controller,
        interventionEnabled: previousMode.interventionEnabled,
        contextId: previousMode.contextId,
        reason: parsed.reason,
        clearActiveIntervention: true,
      },
      {
        now: options.now ?? (() => new Date()),
      },
    );
    const snapshot = container.replace(nextState);
    if (options.syncSharedState) {
      replaceSharedZergState(snapshot);
    }

    return { ok: true, output: renderModeTransitionStatus(snapshot, 'mode reverted') };
  }

  const transition: PermissionModeTransitionInput = {
    automation: parsed.action,
    controller: parsed.action === 'automatic' ? 'automation' : 'operator',
    interventionEnabled: true,
    reason: parsed.reason,
    clearActiveIntervention: true,
  };
  const nextState = applyModeTransition(container.read(), transition, {
    now: options.now ?? (() => new Date()),
  });
  const snapshot = container.replace(nextState);

  if (options.syncSharedState) {
    replaceSharedZergState(snapshot);
  }

  return { ok: true, output: renderModeTransitionStatus(snapshot, `mode set to ${parsed.action}`) };
}

function dispatchInterventionCommand(
  stateOrReader: ZergStateSource,
  payload: string,
  options: RuntimeCommandOptions,
): ZergCommandResult {
  const container = getWritableStateContainer(stateOrReader);

  if (!container) {
    return { ok: false, output: RUNTIME_WRITABLE_STATE_ERROR };
  }

  const parsed = parseInterventionCommand(container.read(), payload);

  if (!parsed.ok) {
    return parsed;
  }

  const nextState = applyInterventionRecord(
    container.read(),
    {
      kind: parsed.kind,
      targetId: parsed.targetId,
      targetLabel: parsed.targetLabel,
      teamId: parsed.teamId,
      leaderAgentId: parsed.leaderAgentId,
      message: parsed.message,
    },
    {
      now: options.now ?? (() => new Date()),
    },
  );

  const snapshot = container.replace(nextState);

  if (options.syncSharedState) {
    replaceSharedZergState(snapshot);
  }

  return {
    ok: true,
    output: parsed.kind === 'leader'
      ? `intervention recorded against leader ${parsed.targetId} (team ${parsed.teamId}): ${parsed.message}`
      : `intervention recorded against ${parsed.kind} ${parsed.targetId}: ${parsed.message}`,
  };
}

function dispatchMonitorCommand(
  stateOrReader: ZergStateSource,
  payload: string,
  options: RuntimeCommandOptions,
): ZergCommandResult {
  const normalizedPayload = tokenizeRuntimePayload(payload);
  const normalizedTopic = normalizedPayload[0]?.toLowerCase();
  const argument = normalizedPayload[1]?.toLowerCase();
  const snapshot = resolveZergStateSnapshot(stateOrReader);

  if (!normalizedTopic || normalizedTopic === 'status') {
    return {
      ok: true,
      output: renderMonitor(snapshot, { width: PI_COMMAND_OUTPUT_WIDTH }),
    };
  }

  if (isReadOnlyTopic(normalizedTopic)) {
    const container = getWritableStateContainer(stateOrReader);

    if (!container) {
      return { ok: false, output: RUNTIME_WRITABLE_STATE_ERROR };
    }

    if (!argument || argument === 'status') {
      const currentValue = Boolean(container.read().mode.readOnly);
      return {
        ok: true,
        output: `monitor read-only is currently ${currentValue ? 'enabled' : 'disabled'}`,
      };
    }

    const snapshotWithReadOnly = setReadOnlyMode(container, argument, options, 'monitor');

    if (typeof snapshotWithReadOnly === 'string') {
      return { ok: false, output: snapshotWithReadOnly };
    }

    return {
      ok: true,
      output: renderMonitor(snapshotWithReadOnly, { width: PI_COMMAND_OUTPUT_WIDTH }),
    };
  }

  return { ok: false, output: `Unknown monitor action: ${normalizedPayload[0] ?? ''}` };
}

function dispatchPermissionCommand(
  stateOrReader: ZergStateSource,
  payload: string,
  options: RuntimeCommandOptions,
): ZergCommandResult {
  const tokens = tokenizeRuntimePayload(payload);
  const action = tokens[0]?.toLowerCase() ?? 'status';
  const snapshot = resolveZergStateSnapshot(stateOrReader);

  if (action === 'status') {
    return { ok: true, output: renderPermissionQueueStatus(getPermissionQueueState(snapshot), { width: PI_COMMAND_OUTPUT_WIDTH }) };
  }

  if (action === 'list' || action === 'ls') {
    const filterToken = tokens[1]?.toLowerCase() ?? 'pending';
    if (!isPermissionListFilter(filterToken)) {
      return { ok: false, output: `Unknown permission list filter: ${tokens[1] ?? ''}` };
    }

    return { ok: true, output: renderPermissionQueueList(getPermissionQueueState(snapshot), filterToken, { width: PI_COMMAND_OUTPUT_WIDTH }) };
  }

  const container = getWritableStateContainer(stateOrReader);
  if (!container) {
    return { ok: false, output: RUNTIME_WRITABLE_STATE_ERROR };
  }

  if (action === 'request') {
    const kind = tokens[1]?.toLowerCase();
    const target = tokens[2];
    const summary = tokens.slice(3).join(' ');
    if (!isPermissionRequestKind(kind)) {
      return { ok: false, output: `Unknown permission request kind: ${tokens[1] ?? ''}` };
    }
    const sanitizedSummary = normalizePermissionCommandText(summary);
    if (!target || !sanitizedSummary) {
      return { ok: false, output: 'Usage: /zerg permission request <kind> <target> <summary...>' };
    }

    const queued = enqueuePermissionRequest(container.read(), {
      kind,
      targetId: target,
      requester: 'operator',
      summary: sanitizedSummary,
    }, { now: options.now ?? (() => new Date()) });
    const logged = appendLogToState(queued, options, {
      source: 'permission',
      level: 'info',
      kind: 'text',
      message: `permission request queued for ${kind} ${target}`,
      agentId: kind === 'run' || kind === 'interrupt' ? target : undefined,
      runId: kind === 'interrupt' ? target : undefined,
      data: { permissionKind: kind },
    });
    const next = container.replace(logged);
    if (options.syncSharedState) {
      replaceSharedZergState(next);
    }
    const requestId = getPermissionQueueState(next).lastRequestId;
    return { ok: true, output: `permission request queued: ${requestId}` };
  }

  if (action === 'approve' || action === 'deny' || action === 'cancel') {
    const requestId = tokens[1];
    const reason = tokens.slice(2).join(' ');
    if (!requestId) {
      return { ok: false, output: `Usage: /zerg permission ${action} <id> [reason...]` };
    }

    const current = container.read();
    const request = getPermissionQueueState(current).requests.find((candidate) => candidate.id === requestId);
    if (!request) {
      return { ok: false, output: `Unknown permission request: ${requestId}` };
    }
    if (request.status !== 'pending') {
      return { ok: false, output: `Permission request ${requestId} is already ${request.status}.` };
    }

    const decision = permissionDecisionForAction(action);
    const resolved = resolvePermissionRequest(current, requestId, decision, {
      now: options.now ?? (() => new Date()),
      reason,
      resolvedBy: 'operator',
    });
    const withLifecycle = decision === 'deny' || decision === 'cancel'
      ? markPermissionRequestTerminalLifecycle(resolved, request.runId, decision, options)
      : resolved;
    const logged = appendLogToState(withLifecycle, options, {
      source: 'permission',
      level: decision === 'approve' ? 'info' : 'warn',
      kind: decision === 'approve' ? 'text' : 'error',
      message: `permission ${decision}: ${requestId}`,
      runId: request.runId,
      agentId: request.agentId,
      data: { permissionKind: request.kind, decision },
    });
    const next = container.replace(logged);
    if (options.syncSharedState) {
      replaceSharedZergState(next);
    }
    return { ok: true, output: `permission request ${requestId} ${permissionPastTense(decision)}` };
  }

  return { ok: false, output: `Unknown permission action: ${tokens[0] ?? ''}` };
}

function dispatchLogsCommand(
  stateOrReader: ZergStateSource,
  payload: string,
): ZergCommandResult {
  const tokens = tokenizeRuntimePayload(payload);
  const action = tokens[0]?.toLowerCase() ?? 'status';
  const snapshot = resolveZergStateSnapshot(stateOrReader);

  if (action === 'status') {
    return { ok: true, output: renderZergLogStatus(getZergLogState(snapshot), { width: PI_COMMAND_OUTPUT_WIDTH }) };
  }

  if (action === 'list' || action === 'ls') {
    const parsed = parseLogFilters(tokens.slice(1));
    if (!parsed.ok) {
      return parsed;
    }

    return { ok: true, output: renderZergLogList(getZergLogs(snapshot, parsed.filter), { width: PI_COMMAND_OUTPUT_WIDTH }) };
  }

  if (action === 'json') {
    const parsed = parseLogFilters(tokens.slice(1));
    if (!parsed.ok) {
      return parsed;
    }

    const records = getZergLogs(snapshot, parsed.filter);
    return { ok: true, output: JSON.stringify({ count: records.length, records }, null, 2) };
  }

  if (action === 'show') {
    const id = tokens[1];
    if (!id) {
      return { ok: false, output: 'Usage: /zerg logs show <id|run-id> [--json]' };
    }

    const parsed = parseLogFilters(tokens.slice(2));
    if (!parsed.ok) {
      return parsed;
    }

    const records = getZergLogState(snapshot).records;
    const exact = records.find((record) => record.id === id);
    const matches = exact ? [exact] : records.filter((record) => record.runId === id);
    if (matches.length === 0) {
      return { ok: false, output: `Unknown log or run: ${id}` };
    }

    if (parsed.json) {
      return { ok: true, output: JSON.stringify({ count: matches.length, records: matches }, null, 2) };
    }

    return exact
      ? { ok: true, output: renderZergLogSummary(exact, { width: PI_COMMAND_OUTPUT_WIDTH }) }
      : { ok: true, output: renderZergLogList(matches.slice(-(parsed.filter.limit ?? 20)), { width: PI_COMMAND_OUTPUT_WIDTH }) };
  }

  return { ok: false, output: `Unknown logs action: ${tokens[0] ?? ''}` };
}

function dispatchRunCommand(
  stateOrReader: ZergStateSource,
  payload: string,
  options: RuntimeCommandOptions,
): ZergCommandResult {
  const parsed = parseRunCommand(payload);
  if (!parsed.ok) {
    return parsed;
  }

  return dispatchRunRequest(stateOrReader, parsed.request, options);
}

function dispatchRunRequest(
  stateOrReader: ZergStateSource,
  requestInput: ZergSubagentLaunchRequest,
  options: RuntimeCommandOptions,
): ZergCommandResult {
  const container = getWritableStateContainer(stateOrReader);
  if (!container) {
    return { ok: false, output: RUNTIME_WRITABLE_STATE_ERROR };
  }

  const current = container.read();
  const launchMode = resolveLaunchMode(requestInput);
  const definitions = getAgentDefinitions(current);
  const directDefinition = definitions.length > 0 ? getAgentDefinition(current, requestInput.agent) : undefined;
  const resolvedTeam = current.teams[requestInput.agent];
  const teamLeaderDefinition = resolvedTeam?.leaderAgentId ? getAgentDefinition(current, resolvedTeam.leaderAgentId) : undefined;
  const resolvedDefinition = directDefinition ?? teamLeaderDefinition;
  if (definitions.length > 0 && !resolvedDefinition) {
    if (resolvedTeam) {
      return { ok: false, output: `Team ${requestInput.agent} has no runnable leader agent definition.` };
    }
    return { ok: false, output: `Unknown agent definition: ${requestInput.agent}` };
  }

  const resolvedAgentId = resolvedDefinition?.id ?? requestInput.agent;
  const resolvedAgentLabel = resolvedTeam?.label ?? resolvedDefinition?.label ?? requestInput.agent;
  const teamMetadata = resolvedTeam?.metadata as { model?: unknown; fallbackModels?: unknown; maxTurns?: unknown } | undefined;
  const teamModel = typeof teamMetadata?.model === 'string' ? teamMetadata.model : undefined;
  const teamFallbackModels = Array.isArray(teamMetadata?.fallbackModels) ? teamMetadata.fallbackModels.filter((value): value is string => typeof value === 'string') : undefined;
  const teamMaxTurns = typeof teamMetadata?.maxTurns === 'number' ? teamMetadata.maxTurns : undefined;

  if (current.mode.readOnly) {
    const queued = enqueuePermissionRequest(current, {
      kind: 'run',
      targetId: resolvedTeam?.id ?? resolvedAgentId,
      agentId: resolvedAgentId,
      requester: 'operator',
      summary: `Run ${resolvedTeam?.id ?? resolvedAgentId}: ${requestInput.task}`,
      details: `read-only blocked /zerg run (${launchMode})`,
      metadata: {
        agent: resolvedAgentId,
        ...(resolvedTeam ? { teamId: resolvedTeam.id } : {}),
        task: requestInput.task,
        launchMode,
        background: requestInput.background,
        model: requestInput.model ?? resolvedDefinition?.model ?? teamModel,
        fallbackModels: requestInput.fallbackModels ?? resolvedDefinition?.fallbackModels ?? teamFallbackModels,
        maxTurns: requestInput.maxTurns ?? resolvedDefinition?.maxTurns ?? teamMaxTurns,
      },
    }, { now: options.now ?? (() => new Date()) });
    const logged = appendLogToState(queued, options, {
      source: 'permission',
      level: 'warn',
      kind: 'text',
      message: `read-only blocked zerg run for ${resolvedTeam?.id ?? resolvedAgentId}`,
      agentId: resolvedAgentId,
      teamId: resolvedTeam?.id,
      data: { launchMode, background: requestInput.background },
    });
    const snapshot = container.replace(logged);
    if (options.syncSharedState) {
      replaceSharedZergState(snapshot);
    }
    const requestId = getPermissionQueueState(snapshot).lastRequestId;
    return {
      ok: false,
      output: `zerg run is blocked while read-only is enabled; queued for permission as ${requestId}. Use /zerg permission approve ${requestId} or /zerg permission deny ${requestId}.`,
    };
  }

  const adapter = options.subagentAdapter;
  if (!adapter || adapter.kind === 'unavailable') {
    return { ok: false, output: 'No Pi native zerg adapter is available. Register the extension in Pi or provide a ZergSubagentControlAdapter.' };
  }

  const now = options.now ?? (() => new Date());
  const nowTimestamp = now().toISOString();
  const runId = resolveRunId(options.idFactory);
  const taskId = resolveTaskId(options.idFactory);

  const requestedModel = requestInput.model ?? resolvedDefinition?.model ?? teamModel;
  const requestedFallbackModels = requestInput.fallbackModels ?? resolvedDefinition?.fallbackModels ?? teamFallbackModels;
  const requestedMaxTurns = requestInput.maxTurns ?? resolvedDefinition?.maxTurns ?? teamMaxTurns;
  const request: ZergSubagentLaunchRequest = {
    ...requestInput,
    agent: resolvedAgentId,
    fork: launchMode === 'fork',
    launchMode,
    runId,
    taskId,
    agentDefinitionId: resolvedDefinition?.id,
    description: requestInput.task,
    ...(requestedModel ? { model: requestedModel } : {}),
    ...(requestedFallbackModels?.length ? { fallbackModels: requestedFallbackModels } : {}),
    ...(requestedMaxTurns ? { maxTurns: requestedMaxTurns } : {}),
  };

  const launchMetadata = {
    taskId,
    runId,
    originalTask: requestInput.task,
    launchMode,
    ...(resolvedTeam ? { teamId: resolvedTeam.id, teamLabel: resolvedTeam.label } : {}),
    ...(resolvedDefinition ? { agentDefinitionId: resolvedDefinition.id } : {}),
    agentDefinitionLabel: resolvedDefinition?.label,
    ...(request.model ? { model: request.model } : {}),
    ...(request.fallbackModels?.length ? { fallbackModels: request.fallbackModels } : {}),
    ...(request.maxTurns ? { maxTurns: request.maxTurns } : {}),
  } as const;

  const taskRecord = {
    id: taskId,
    title: requestInput.task,
    status: 'running' as const,
    ownerAgentId: runId,
    teamId: resolvedTeam?.id,
    updatedAt: nowTimestamp,
    substate: 'queued' as const,
    substateReason: 'waiting for adapter launch',
    substateUpdatedAt: nowTimestamp,
    metadata: launchMetadata,
  };

  const withTask = upsertTask(current, taskRecord);
  const withRun = applyRuntimeTransition(withTask, {
    entity: 'agent',
    action: 'create',
    id: runId,
    label: resolvedAgentLabel,
    kind: 'subagent',
    activity: requestInput.task,
    substate: 'spawning',
    substateReason: 'adapter launch requested',
  }, { now: () => new Date(nowTimestamp) });

  const withAgentMetadata = {
    ...withRun,
    agents: {
      ...withRun.agents,
      [runId]: {
        ...(withRun.agents[runId] ?? {}),
        metadata: {
          ...withRun.agents[runId]?.metadata,
          ...launchMetadata,
        },
      },
    },
  };

  const withLaunchLog = appendLogToState(withAgentMetadata, options, {
    source: 'command',
    level: 'info',
    kind: 'text',
    message: `zerg run queued for ${resolvedTeam?.id ?? resolvedAgentId}`,
    runId,
    agentId: resolvedAgentId,
    teamId: resolvedTeam?.id,
    taskId,
    data: { launchMode, background: requestInput.background, model: request.model, fallbackModels: request.fallbackModels, maxTurns: request.maxTurns },
  });

  const launchReadyState = container.replace(withLaunchLog);
  if (options.syncSharedState) {
    replaceSharedZergState(launchReadyState);
  }

  const result = adapter.launch(request);

  if (result.ok) {
    const successMessage = result.message || `adapter launch accepted ${runId}`;
    const logged = appendLogToContainer(container, options, {
      source: 'adapter',
      level: 'info',
      kind: 'text',
      message: successMessage,
      runId,
      agentId: resolvedAgentId,
      teamId: resolvedTeam?.id,
      taskId,
      data: { launchMode, model: request.model, fallbackModels: request.fallbackModels, maxTurns: request.maxTurns },
    });
    if (options.syncSharedState) {
      replaceSharedZergState(logged);
    }
    return {
      ok: true,
      runId,
      taskId,
      output: appendSpawnIdentifiers(appendSpawnLaunchMode(successMessage, launchMode), runId, taskId),
    };
  }

  const withFailure = upsertTask(
    applyRuntimeTransition(container.read(), {
      entity: 'agent',
      action: 'fail',
      id: runId,
      label: resolvedAgentLabel,
      kind: 'subagent',
      activity: result.message || 'adapter launch failed',
      substate: 'failed',
      substateReason: result.message || 'adapter launch failed',
    }, { now: () => new Date(nowTimestamp) }),
    {
      id: taskId,
      title: requestInput.task,
      status: 'failed',
      ownerAgentId: runId,
      teamId: resolvedTeam?.id,
      updatedAt: nowTimestamp,
      substate: 'failed',
      substateReason: result.message || 'adapter launch failed',
      substateUpdatedAt: nowTimestamp,
      metadata: launchMetadata,
    },
  );

  const failedState = container.replace(appendLogToState(withFailure, options, {
    source: 'adapter',
    level: 'error',
    kind: 'error',
    message: result.message || 'adapter launch failed',
    runId,
    agentId: resolvedAgentId,
    teamId: resolvedTeam?.id,
    taskId,
    data: { launchMode, model: request.model, fallbackModels: request.fallbackModels, maxTurns: request.maxTurns },
  }));
  if (options.syncSharedState) {
    replaceSharedZergState(failedState);
  }

  return {
    ok: false,
    runId,
    taskId,
    output: appendSpawnIdentifiers(appendSpawnLaunchMode(result.message, launchMode), runId, taskId),
  };
}

function dispatchRunsCommand(
  stateOrReader: ZergStateSource,
  payload: string,
  options: RuntimeCommandOptions,
): ZergCommandResult {
  const adapter = options.subagentAdapter;
  const tokens = tokenizeRuntimePayload(payload);
  const action = tokens[0]?.toLowerCase();
  const runId = tokens[1];
  const runs = resolveAvailableRuns(stateOrReader, adapter);

  if (!action || action === 'list' || action === 'ls') {
    return {
      ok: true,
      output: renderZergSubagentRunList(runs, { width: PI_COMMAND_OUTPUT_WIDTH }),
    };
  }

  if (action === 'show') {
    if (!runId) {
      return { ok: false, output: 'Usage: /zerg runs show <run-id>' };
    }

    const stateMatch = getSubagentRunSnapshot(resolveZergStateSnapshot(stateOrReader), runId);
    const adapterMatch = adapter?.getRun?.(runId);
    const match = stateMatch && isTerminalRunSnapshot(stateMatch) ? stateMatch : adapterMatch ?? stateMatch;
    if (!match) {
      return { ok: false, output: `Unknown run: ${runId}` };
    }

    return {
      ok: true,
      output: renderZergSubagentRunSummary(match, { width: PI_COMMAND_OUTPUT_WIDTH }),
    };
  }

  return {
    ok: false,
    output: `Unknown runs action: ${action}. Available: /zerg runs list | /zerg runs show <run-id>`,
  };
}

function dispatchInterruptCommand(
  stateOrReader: ZergStateSource,
  payload: string,
  options: RuntimeCommandOptions,
): ZergCommandResult {
  const [runId] = tokenizeRuntimePayload(payload);
  const container = getWritableStateContainer(stateOrReader);
  const currentSnapshot = container?.read() ?? resolveZergStateSnapshot(stateOrReader);

  if (currentSnapshot.mode.readOnly) {
    if (!container) {
      return { ok: false, output: 'zerg interrupt is blocked while read-only is enabled and requires writable zerg state to queue permission.' };
    }

    const current = currentSnapshot;
    const targetRunId = runId || getZergControlState(current).activeRunId;
    const queued = enqueuePermissionRequest(current, {
      kind: 'interrupt',
      targetId: targetRunId,
      runId: targetRunId,
      requester: 'operator',
      summary: `Interrupt ${targetRunId ?? 'active run'}`,
      details: 'read-only blocked /zerg interrupt',
    }, { now: options.now ?? (() => new Date()) });
    const requestId = getPermissionQueueState(queued).lastRequestId;
    const waiting = targetRunId && queued.agents[targetRunId]
      ? markRunWaitingForPermission(queued, targetRunId, requestId, options)
      : queued;
    const snapshot = container.replace(appendLogToState(waiting, options, {
      source: 'permission',
      level: 'warn',
      kind: 'text',
      message: `read-only blocked zerg interrupt for ${targetRunId ?? 'active run'}`,
      runId: targetRunId,
    }));
    if (options.syncSharedState) {
      replaceSharedZergState(snapshot);
    }
    return {
      ok: false,
      output: `zerg interrupt is blocked while read-only is enabled; queued for permission as ${requestId}. Use /zerg permission approve ${requestId} or /zerg permission deny ${requestId}.`,
    };
  }

  const adapter = options.subagentAdapter;
  if (!adapter || adapter.kind === 'unavailable' || typeof adapter.interrupt !== 'function') {
    return { ok: false, output: 'No interrupt-capable Pi subagent adapter is available.' };
  }

  const result = adapter.interrupt(runId);
  if (result.ok && container) {
    const targetRunId = result.runId || runId || getZergControlState(container.read()).activeRunId;
    if (targetRunId) {
      const interrupted = applyRuntimeTransition(container.read(), {
        entity: 'agent',
        action: 'progress',
        id: targetRunId,
        kind: 'subagent',
        status: 'running',
        activity: 'interrupt requested',
        substate: 'cancelling',
        substateReason: result.message,
      }, { now: options.now ?? (() => new Date()) });
      const snapshot = container.replace(appendLogToState(interrupted, options, {
        source: 'command',
        level: result.ok ? 'warn' : 'error',
        kind: result.ok ? 'text' : 'error',
        message: result.message,
        runId: targetRunId,
      }));
      if (options.syncSharedState) {
        replaceSharedZergState(snapshot);
      }
    }
  }
  return { ok: result.ok, output: result.message };
}

function dispatchControlCommand(
  stateOrReader: ZergStateSource,
  payload: string,
  options: RuntimeCommandOptions,
): ZergCommandResult {
  const tokens = tokenizeRuntimePayload(payload);
  const topic = tokens[0]?.toLowerCase() ?? 'status';
  const argument = tokens[1]?.toLowerCase();

  if (topic === 'status') {
    return { ok: true, output: renderZergControlStatus(resolveZergStateSnapshot(stateOrReader), PI_COMMAND_OUTPUT_WIDTH) };
  }

  const container = getWritableStateContainer(stateOrReader);

  if (!container) {
    return { ok: false, output: RUNTIME_WRITABLE_STATE_ERROR };
  }

  if (isReadOnlyTopic(topic)) {
    if (!argument || argument === 'status') {
      return { ok: true, output: `control read-only is currently ${container.read().mode.readOnly ? 'enabled' : 'disabled'}` };
    }

    const snapshot = setReadOnlyMode(container, argument, options, 'control');
    if (typeof snapshot === 'string') {
      return { ok: false, output: snapshot };
    }
    return { ok: true, output: renderZergControlStatus(snapshot, PI_COMMAND_OUTPUT_WIDTH) };
  }

  if (topic === 'controller') {
    if (!argument || argument === 'status') {
      return { ok: true, output: `zerg controller is ${getZergControlState(container.read()).controller}` };
    }

    if (!isZergControlController(argument)) {
      return { ok: false, output: `Unknown control controller: ${argument}` };
    }

    const snapshot = updateZergControlState(container, { controller: argument }, `controller set to ${argument}`, options);
    return { ok: true, output: renderZergControlStatus(snapshot, PI_COMMAND_OUTPUT_WIDTH) };
  }

  if (topic === 'mode') {
    if (!argument || !isAutomationMode(argument)) {
      return { ok: false, output: `Unknown control mode: ${argument ?? ''}` };
    }

    const snapshot = setAutomationMode(container, argument, options);
    return { ok: true, output: renderZergControlStatus(snapshot, PI_COMMAND_OUTPUT_WIDTH) };
  }

  return { ok: false, output: `Unknown control action: ${tokens[0] ?? ''}` };
}


function parseRunCommand(payload: string): { ok: false; output: string } | { ok: true; request: ZergSubagentLaunchRequest } {
  const tokens = tokenizeRuntimePayload(payload);
  let background = false;
  let launchMode: ZergSubagentLaunchMode = 'fresh';
  let sawFresh = false;
  let sawFork = false;
  let model: string | undefined;
  let fallbackModels: string[] | undefined;
  let maxTurns: number | undefined;
  const filtered: string[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const modelValue = readOptionValue(tokens, index, '--model');
    const fallbackValue = readOptionValue(tokens, index, '--fallback-models') ?? readOptionValue(tokens, index, '--fallback');
    const maxTurnsValue = readOptionValue(tokens, index, '--max-turns') ?? readOptionValue(tokens, index, '--maxTurns');

    if (token === '--bg' || token === '--background') {
      background = true;
    } else if (token === '--fresh') {
      sawFresh = true;
      launchMode = 'fresh';
    } else if (token === '--fork') {
      sawFork = true;
      launchMode = 'fork';
    } else if (modelValue !== undefined) {
      model = modelValue;
      if (token === '--model') index += 1;
    } else if (fallbackValue !== undefined) {
      fallbackModels = parseCsvOption(fallbackValue);
      if (token === '--fallback-models' || token === '--fallback') index += 1;
    } else if (maxTurnsValue !== undefined) {
      const parsed = Number(maxTurnsValue);
      if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        return { ok: false, output: '--max-turns must be a positive integer.' };
      }
      maxTurns = parsed;
      if (token === '--max-turns' || token === '--maxTurns') index += 1;
    } else {
      filtered.push(token);
    }
  }

  if (sawFresh && sawFork) {
    return { ok: false, output: 'Conflicting launch modes: use either --fresh or --fork, not both.' };
  }

  const [agent, ...taskTokens] = filtered;
  if (!agent) {
    return { ok: false, output: 'Usage: /zerg run <agent> <task> [--bg] [--fresh|--fork] [--model <model>]' };
  }

  const task = taskTokens.join(' ').trim();
  if (!task) {
    return { ok: false, output: 'zerg run requires a non-empty task.' };
  }

  return {
    ok: true,
    request: {
      agent,
      task,
      background,
      fork: launchMode === 'fork',
      launchMode,
      ...(model ? { model } : {}),
      ...(fallbackModels?.length ? { fallbackModels } : {}),
      ...(maxTurns ? { maxTurns } : {}),
    },
  };
}

function readOptionValue(tokens: string[], index: number, name: string): string | undefined {
  const token = tokens[index]!;
  if (token === name) {
    return tokens[index + 1];
  }
  const prefix = `${name}=`;
  return token.startsWith(prefix) ? token.slice(prefix.length) : undefined;
}

function parseLogFilters(tokens: string[]): LogsParseResult {
  const filter: ZergLogFilter = {};
  let json = false;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const lower = token.toLowerCase();

    if (lower === '--json') {
      json = true;
    } else if (lower === '--run') {
      const value = tokens[index + 1];
      if (!value) {
        return { ok: false, output: 'Usage: --run <id>' };
      }
      filter.runId = normalizeLogFilterText(value);
      index += 1;
    } else if (lower.startsWith('--run=')) {
      const value = token.slice('--run='.length);
      if (!value) {
        return { ok: false, output: 'Usage: --run <id>' };
      }
      filter.runId = normalizeLogFilterText(value);
    } else if (lower === '--level') {
      const value = tokens[index + 1]?.toLowerCase();
      if (!isZergLogLevel(value)) {
        return { ok: false, output: `Unknown log level: ${tokens[index + 1] ?? ''}` };
      }
      filter.level = value;
      index += 1;
    } else if (lower.startsWith('--level=')) {
      const value = token.slice('--level='.length).toLowerCase();
      if (!isZergLogLevel(value)) {
        return { ok: false, output: `Unknown log level: ${token.slice('--level='.length)}` };
      }
      filter.level = value;
    } else if (lower === '--limit') {
      const value = tokens[index + 1];
      const limit = parseLogLimit(value);
      if (limit === undefined) {
        return { ok: false, output: `Invalid log limit: ${value ?? ''}` };
      }
      filter.limit = limit;
      index += 1;
    } else if (lower.startsWith('--limit=')) {
      const value = token.slice('--limit='.length);
      const limit = parseLogLimit(value);
      if (limit === undefined) {
        return { ok: false, output: `Invalid log limit: ${value}` };
      }
      filter.limit = limit;
    } else {
      return { ok: false, output: `Unknown logs filter: ${token}` };
    }
  }

  return { ok: true, filter, json };
}

function parseModeCommand(payload: string): ModeParseResult {
  const [actionToken, ...rest] = tokenizeRuntimePayload(payload);
  const normalizedAction = actionToken?.toLowerCase() ?? 'status';

  if (normalizedAction === 'status' || normalizedAction === '') {
    return { ok: true, action: 'status' };
  }

  if (!isModeTransitionAction(normalizedAction)) {
    return { ok: false, output: `Unknown mode action: ${actionToken ?? ''}` };
  }

  const reason = normalizeInterventionText(rest.join(' '), MAX_INTERVENTION_MESSAGE_LENGTH_FOR_REASONS);

  if (rest.length > 0 && !reason) {
    return { ok: false, output: `mode reason exceeds ${MAX_INTERVENTION_MESSAGE_LENGTH_FOR_REASONS} characters or contains only control characters.` };
  }

  return { ok: true, action: normalizedAction, reason: reason || undefined };
}

function parseInterventionCommand(state: ZergState, payload: string): InterveneParseResult {
  const [targetKindToken, id, ...messageTokens] = tokenizeRuntimePayload(payload);
  const normalizedKind = targetKindToken?.toLowerCase();

  if (!isInterventionKind(normalizedKind)) {
    return { ok: false, output: `Unknown intervention target: ${targetKindToken ?? ''}` };
  }

  if (!id) {
    return { ok: false, output: `intervene ${normalizedKind} requires an id.` };
  }

  const messageText = messageTokens.join(' ');
  const message = normalizeInterventionText(messageText);
  if (!messageText.trim()) {
    return { ok: false, output: 'intervene requires a non-empty message.' };
  }

  if (!message) {
    return { ok: false, output: `intervention message exceeds ${MAX_INTERVENTION_MESSAGE_LENGTH} characters or contains only control characters.` };
  }

  if (normalizedKind === 'leader') {
    const team = state.teams[id];
    if (!team) {
      return { ok: false, output: `Cannot intervene leader for unknown team: ${id}` };
    }

    if (!team.leaderAgentId) {
      return { ok: false, output: `Team ${id} has no leader to intervene.` };
    }

    const leader = state.agents[team.leaderAgentId];
    if (!leader) {
      return { ok: false, output: `Team ${id} leader ${team.leaderAgentId} is missing.` };
    }

    return {
      ok: true,
      kind: normalizedKind,
      targetId: leader.id,
      targetLabel: leader.label,
      teamId: team.id,
      leaderAgentId: leader.id,
      message,
    };
  }

  const agent = state.agents[id];
  if (!agent) {
    return { ok: false, output: `Cannot intervene ${normalizedKind} for unknown agent: ${id}` };
  }

  if (normalizedKind === 'subagent' && agent.kind !== 'subagent') {
    return { ok: false, output: `intervene subagent requires target agent to be subagent: ${id}` };
  }

  return {
    ok: true,
    kind: normalizedKind,
    targetId: id,
    targetLabel: agent.label,
    message,
  };
}

function isModeTransitionAction(value: string): value is ModeTransitionAction {
  return value === 'status' || value === 'manual' || value === 'assisted' || value === 'automatic' || value === 'revert';
}

function isInterventionKind(value: string | undefined): value is InterveneKind {
  return value === 'agent' || value === 'subagent' || value === 'leader';
}

function renderModeTransitionStatus(state: ZergState, message: string): string {
  return `${message}
${renderStatusLine(state, { width: PI_COMMAND_OUTPUT_WIDTH })}`;
}

function normalizeInterventionText(input: string, maxLength = MAX_INTERVENTION_MESSAGE_LENGTH): string {
  const sanitized = input
    .replace(/[\u0000-\u001F\u007F-\u009F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!sanitized || sanitized.length === 0) {
    return '';
  }

  if (sanitized.length > maxLength) {
    return '';
  }

  return sanitized;
}


function resolveRunId(idFactory?: ZergIdFactory): string {
  const generator = idFactory?.runId ?? defaultIdFactory.runId;
  const candidate = generator();
  return sanitizeSpawnId(candidate, DEFAULT_RUN_ID_PREFIX);
}

function resolveTaskId(idFactory?: ZergIdFactory): string {
  const generator = idFactory?.taskId ?? defaultIdFactory.taskId;
  const candidate = generator();
  return sanitizeSpawnId(candidate, DEFAULT_TASK_ID_PREFIX);
}

function resolveLaunchMode(request: Pick<ZergSubagentLaunchRequest, 'fork' | 'launchMode'>): ZergSubagentLaunchMode {
  if (request.launchMode === 'fork' || request.fork === true) {
    return 'fork';
  }

  return 'fresh';
}

function sanitizeSpawnId(value: string, prefix: string): string {
  const safe = value.trim().replace(/\s+/g, '-');
  const base = safe.replace(/[^a-zA-Z0-9._-]/g, '-');
  const normalized = `${base}`.replace(/-+/g, '-').replace(/^-+|-+$/g, '');
  if (normalized.length === 0) {
    return `${prefix}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }
  return normalized.startsWith(prefix) ? normalized : `${prefix}${normalized}`;
}

function appendSpawnIdentifiers(message: string, runId: string, taskId: string): string {
  const includesRun = message.includes(runId);
  const includesTask = message.includes(taskId);
  if (includesRun && includesTask) {
    return message;
  }

  const suffix = `${includesRun ? '' : ` (${runId})`} ${includesTask ? '' : `task:${taskId}`}`.trim();
  return `${message}${suffix ? ` ${suffix}` : ''}`;
}

function appendSpawnLaunchMode(message: string, launchMode: ZergSubagentLaunchMode): string {
  const suffix = `(${launchMode})`;
  return message.includes(suffix) ? message : `${message} ${suffix}`;
}

function parseRuntimeTransition(entity: ZergRuntimeEntity, payload: string): RuntimeParseResult {
  const [actionToken, id, ...rest] = tokenizeRuntimePayload(payload);
  const action = actionToken?.toLowerCase();

  if (!isRuntimeAction(action)) {
    return { ok: false, output: `Unknown ${entity} runtime action: ${actionToken ?? ''}` };
  }

  if (!id) {
    return { ok: false, output: `${entity} ${action} requires an id.` };
  }

  const parsedSubstate = parseLifecycleSubstateOptions(rest);
  if (!parsedSubstate.ok) {
    return parsedSubstate;
  }

  const parsedOptions = parseRuntimeEntityOptions(entity, parsedSubstate.tokens);
  if (!parsedOptions.ok) {
    return parsedOptions;
  }

  const text = parsedOptions.tokens.join(' ').trim();
  const metadata = buildRuntimeConfigMetadata(parsedOptions);
  const common = {
    action,
    id,
    ...(action === 'create' && text ? { label: text } : {}),
    ...((action === 'progress' || action === 'fail') && text ? { activity: text } : {}),
    ...(parsedSubstate.substate ? { substate: parsedSubstate.substate } : {}),
    ...(parsedSubstate.substateReason ? { substateReason: parsedSubstate.substateReason } : {}),
    ...(metadata ? { metadata } : {}),
  } as const;

  if (entity === 'agent') {
    return {
      ok: true,
      transition: {
        entity: 'agent',
        ...common,
        ...(parsedOptions.kind && isRuntimeAgentKind(parsedOptions.kind) ? { kind: parsedOptions.kind } : {}),
        ...(parsedOptions.team ? { teamId: parsedOptions.team } : {}),
        ...(parsedOptions.parent ? { parentId: parsedOptions.parent } : {}),
        ...(parsedOptions.children ? { childIds: parsedOptions.children } : {}),
      },
    };
  }

  return {
    ok: true,
    transition: {
      entity: 'team',
      ...common,
      ...(parsedOptions.kind && isRuntimeTeamKind(parsedOptions.kind) ? { kind: parsedOptions.kind } : {}),
      ...(parsedOptions.leader ? { leaderAgentId: parsedOptions.leader } : {}),
      ...(parsedOptions.members ? { memberAgentIds: parsedOptions.members } : {}),
      ...(parsedOptions.parentTeam ? { parentTeamId: parsedOptions.parentTeam } : {}),
      ...(parsedOptions.tasks ? { taskIds: parsedOptions.tasks } : {}),
    },
  };
}

interface RuntimeEntityOptions {
  ok: true;
  tokens: string[];
  kind?: string;
  leader?: string;
  members?: string[];
  parentTeam?: string;
  tasks?: string[];
  parent?: string;
  team?: string;
  children?: string[];
  model?: string;
  fallbackModels?: string[];
  maxTurns?: number;
  agentDefinitionId?: string;
}

type RuntimeEntityOptionsParseResult = RuntimeEntityOptions | { ok: false; output: string };

function parseRuntimeEntityOptions(entity: ZergRuntimeEntity, tokens: string[]): RuntimeEntityOptionsParseResult {
  const remaining: string[] = [];
  const options: RuntimeEntityOptions = { ok: true, tokens: remaining };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const kind = readOptionValue(tokens, index, '--kind');
    const leader = readOptionValue(tokens, index, '--leader');
    const members = readOptionValue(tokens, index, '--members') ?? readOptionValue(tokens, index, '--member');
    const parentTeam = readOptionValue(tokens, index, '--parent-team');
    const tasks = readOptionValue(tokens, index, '--tasks') ?? readOptionValue(tokens, index, '--task');
    const parent = readOptionValue(tokens, index, '--parent');
    const team = readOptionValue(tokens, index, '--team');
    const children = readOptionValue(tokens, index, '--children') ?? readOptionValue(tokens, index, '--child');
    const model = readOptionValue(tokens, index, '--model');
    const fallbackModels = readOptionValue(tokens, index, '--fallback-models') ?? readOptionValue(tokens, index, '--fallback');
    const maxTurns = readOptionValue(tokens, index, '--max-turns') ?? readOptionValue(tokens, index, '--maxTurns');
    const agentDefinitionId = readOptionValue(tokens, index, '--agent-definition') ?? readOptionValue(tokens, index, '--agent-def');

    if (kind !== undefined) {
      if (entity === 'agent' && !isRuntimeAgentKind(kind)) return { ok: false, output: `Unknown agent kind: ${kind}` };
      if (entity === 'team' && !isRuntimeTeamKind(kind)) return { ok: false, output: `Unknown team kind: ${kind}` };
      options.kind = kind;
      if (token === '--kind') index += 1;
    } else if (leader !== undefined) {
      if (!leader || leader.startsWith('--')) return { ok: false, output: 'Usage: --leader <agent-id>' };
      options.leader = leader;
      if (token === '--leader') index += 1;
    } else if (members !== undefined) {
      const parsed = parseCsvOption(members);
      if (!parsed) return { ok: false, output: 'Usage: --members <agent-id>[,<agent-id>...]' };
      options.members = [...new Set([...(options.members ?? []), ...parsed])];
      if (token === '--members' || token === '--member') index += 1;
    } else if (parentTeam !== undefined) {
      options.parentTeam = parentTeam;
      if (token === '--parent-team') index += 1;
    } else if (tasks !== undefined) {
      options.tasks = [...new Set([...(options.tasks ?? []), ...(parseCsvOption(tasks) ?? [])])];
      if (token === '--tasks' || token === '--task') index += 1;
    } else if (parent !== undefined) {
      options.parent = parent;
      if (token === '--parent') index += 1;
    } else if (team !== undefined) {
      options.team = team;
      if (token === '--team') index += 1;
    } else if (children !== undefined) {
      options.children = [...new Set([...(options.children ?? []), ...(parseCsvOption(children) ?? [])])];
      if (token === '--children' || token === '--child') index += 1;
    } else if (model !== undefined) {
      options.model = model;
      if (token === '--model') index += 1;
    } else if (fallbackModels !== undefined) {
      options.fallbackModels = parseCsvOption(fallbackModels);
      if (token === '--fallback-models' || token === '--fallback') index += 1;
    } else if (maxTurns !== undefined) {
      const parsed = Number(maxTurns);
      if (!Number.isSafeInteger(parsed) || parsed <= 0) return { ok: false, output: '--max-turns must be a positive integer.' };
      options.maxTurns = parsed;
      if (token === '--max-turns' || token === '--maxTurns') index += 1;
    } else if (agentDefinitionId !== undefined) {
      options.agentDefinitionId = agentDefinitionId;
      if (token === '--agent-definition' || token === '--agent-def') index += 1;
    } else {
      remaining.push(token);
    }
  }

  return options;
}

function buildRuntimeConfigMetadata(options: RuntimeEntityOptions): Record<string, unknown> | undefined {
  const metadata = {
    ...(options.model ? { model: options.model } : {}),
    ...(options.fallbackModels?.length ? { fallbackModels: options.fallbackModels } : {}),
    ...(options.maxTurns ? { maxTurns: options.maxTurns } : {}),
    ...(options.agentDefinitionId ? { agentDefinitionId: options.agentDefinitionId } : {}),
  };
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function isRuntimeAgentKind(value: string): value is AgentKind {
  return value === 'subagent' || value === 'teammate' || value === 'team-leader';
}

function isRuntimeTeamKind(value: string): value is TeamKind {
  return value === 'team' || value === 'squad' || value === 'worktree';
}

function parseLifecycleSubstateOptions(tokens: string[]): { ok: true; tokens: string[]; substate?: ZergLifecycleSubstate; substateReason?: string } | { ok: false; output: string } {
  const remaining: string[] = [];
  let substate: ZergLifecycleSubstate | undefined;
  let substateReason: string | undefined;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const lower = token.toLowerCase();
    if (lower === '--substate') {
      const value = tokens[index + 1];
      if (!isLifecycleSubstate(value)) {
        return { ok: false, output: `Unknown lifecycle substate: ${value ?? ''}` };
      }
      substate = value;
      index += 1;
    } else if (lower.startsWith('--substate=')) {
      const value = token.slice('--substate='.length);
      if (!isLifecycleSubstate(value)) {
        return { ok: false, output: `Unknown lifecycle substate: ${value}` };
      }
      substate = value;
    } else if (lower.startsWith('substate=')) {
      const value = token.slice('substate='.length);
      if (!isLifecycleSubstate(value)) {
        return { ok: false, output: `Unknown lifecycle substate: ${value}` };
      }
      substate = value;
    } else if (lower === '--substate-reason') {
      const value = tokens[index + 1] ?? '';
      const normalized = normalizeInterventionText(value, MAX_INTERVENTION_MESSAGE_LENGTH_FOR_REASONS);
      if (value && !normalized) {
        return { ok: false, output: `lifecycle substate reason exceeds ${MAX_INTERVENTION_MESSAGE_LENGTH_FOR_REASONS} characters or contains only control characters.` };
      }
      substateReason = normalized || undefined;
      index += 1;
    } else if (lower.startsWith('substatereason=') || lower.startsWith('substate-reason=')) {
      const separator = token.indexOf('=');
      const value = separator >= 0 ? token.slice(separator + 1) : '';
      const normalized = normalizeInterventionText(value, MAX_INTERVENTION_MESSAGE_LENGTH_FOR_REASONS);
      if (value && !normalized) {
        return { ok: false, output: `lifecycle substate reason exceeds ${MAX_INTERVENTION_MESSAGE_LENGTH_FOR_REASONS} characters or contains only control characters.` };
      }
      substateReason = normalized || undefined;
    } else {
      remaining.push(token);
    }
  }

  return { ok: true, tokens: remaining, substate, substateReason };
}

function tokenizeRuntimePayload(payload: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  let escaping = false;

  const flush = () => {
    if (current.length > 0) {
      tokens.push(current);
      current = '';
    }
  };

  for (const char of payload) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === '\\') {
      escaping = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      flush();
      continue;
    }

    current += char;
  }

  if (escaping) {
    current += '\\';
  }
  flush();

  return tokens;
}

function normalizePermissionCommandText(input: string): string {
  return input
    .replace(/[\u0000-\u001F\u007F-\u009F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeLogFilterText(input: string): string {
  return normalizePermissionCommandText(input).slice(0, 160);
}

function parseLogLimit(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) {
    return undefined;
  }

  const limit = Number(value);
  return Number.isSafeInteger(limit) && limit > 0 ? limit : undefined;
}

function isZergLogLevel(value: string | undefined): value is NonNullable<ZergLogFilter['level']> {
  return value === 'debug' || value === 'info' || value === 'warn' || value === 'error';
}

function isRuntimeAction(value: string | undefined): value is ZergRuntimeTransitionAction {
  return value === 'create' || value === 'start' || value === 'progress' || value === 'stop' || value === 'fail' || value === 'reset';
}

function isLifecycleSubstate(value: string | undefined): value is ZergLifecycleSubstate {
  return value === 'queued'
    || value === 'spawning'
    || value === 'starting'
    || value === 'planning'
    || value === 'waiting-permission'
    || value === 'waiting-input'
    || value === 'executing'
    || value === 'tool-running'
    || value === 'streaming-output'
    || value === 'compacting'
    || value === 'idle'
    || value === 'stopping'
    || value === 'cancelling'
    || value === 'completed'
    || value === 'failed'
    || value === 'cancelled'
    || value === 'reset';
}

function isPermissionRequestKind(value: string | undefined): value is ZergPermissionRequestKind {
  return value === 'run' || value === 'interrupt' || value === 'tool' || value === 'mode' || value === 'intervention' || value === 'adapter';
}

function isPermissionListFilter(value: string): value is 'all' | 'pending' | 'resolved' {
  return value === 'all' || value === 'pending' || value === 'resolved';
}

function permissionDecisionForAction(action: 'approve' | 'deny' | 'cancel'): ZergPermissionDecision {
  return action === 'approve' ? 'approve' : action === 'deny' ? 'deny' : 'cancel';
}

function permissionPastTense(decision: ZergPermissionDecision): string {
  return decision === 'approve'
    ? 'approved'
    : decision === 'deny'
      ? 'denied'
      : decision === 'cancel'
        ? 'cancelled'
        : 'expired';
}

function appendLogToState(
  state: ZergState,
  _options: RuntimeCommandOptions,
  input: Parameters<typeof appendZergLogRecord>[1],
): ZergState {
  return appendZergLogRecord(state, input);
}

function appendLogToContainer(
  container: ZergStateContainer,
  options: RuntimeCommandOptions,
  input: Parameters<typeof appendZergLogRecord>[1],
): ZergState {
  const updated = container.replace(appendLogToState(container.read(), options, input));
  options.persistenceManager?.save(updated, options.now);
  return updated;
}

function updateRunTaskLifecycle(
  state: ZergState,
  taskId: string | undefined,
  status: AgentStatus,
  substate: ZergLifecycleSubstate,
  substateReason: string | undefined,
  updatedAt: string,
): ZergState {
  if (!taskId || !state.tasks[taskId]) {
    return state;
  }

  const task = state.tasks[taskId];
  return upsertTask(state, {
    ...task,
    status,
    substate,
    substateReason,
    substateUpdatedAt: updatedAt,
    updatedAt,
  });
}

function markPermissionRequestTerminalLifecycle(
  state: ZergState,
  runId: string | undefined,
  decision: ZergPermissionDecision,
  options: RuntimeCommandOptions,
): ZergState {
  if (!runId || !state.agents[runId]) {
    return state;
  }

  const reason = decision === 'deny' ? 'permission denied' : 'permission cancelled';
  return applyRuntimeTransition(state, {
    entity: 'agent',
    action: 'fail',
    id: runId,
    kind: 'subagent',
    activity: reason,
    substate: 'failed',
    substateReason: reason,
  }, { now: options.now ?? (() => new Date()) });
}

function markRunWaitingForPermission(
  state: ZergState,
  runId: string,
  permissionRequestId: string | undefined,
  options: RuntimeCommandOptions,
): ZergState {
  const waiting = applyRuntimeTransition(state, {
    entity: 'agent',
    action: 'progress',
    id: runId,
    kind: 'subagent',
    status: 'blocked',
    activity: 'waiting for permission',
    substate: 'waiting-permission',
    substateReason: permissionRequestId ? `permission ${permissionRequestId}` : 'permission required',
  }, { now: options.now ?? (() => new Date()) });
  const agent = waiting.agents[runId];
  if (!agent || !permissionRequestId) {
    return waiting;
  }

  return {
    ...waiting,
    agents: {
      ...waiting.agents,
      [runId]: {
        ...agent,
        metadata: {
          ...agent.metadata,
          permissionRequestId,
        },
      },
    },
  };
}

function resolveAvailableRuns(
  stateOrReader: ZergStateSource,
  adapter: ZergSubagentControlAdapter | undefined,
): ZergSubagentRunSnapshot[] {
  const stateRuns = getSubagentRunSnapshots(resolveZergStateSnapshot(stateOrReader));
  const runsById = new Map(stateRuns.map((run) => [run.runId, run]));
  const adapterRuns = typeof adapter?.listRuns === 'function' ? adapter.listRuns() : undefined;

  if (adapterRuns) {
    for (const run of adapterRuns) {
      const snapshot = createZergSubagentRunSnapshot(run);
      const existing = runsById.get(snapshot.runId);
      if (existing && isTerminalRunSnapshot(existing)) {
        runsById.set(snapshot.runId, createZergSubagentRunSnapshot({
          ...snapshot,
          ...existing,
          task: existing.task ?? snapshot.task,
          agentId: existing.agentId ?? snapshot.agentId,
          agentLabel: existing.agentLabel ?? snapshot.agentLabel,
          metadata: {
            ...snapshot.metadata,
            ...existing.metadata,
          },
        }));
      } else {
        runsById.set(snapshot.runId, existing ? createZergSubagentRunSnapshot({ ...existing, ...snapshot }) : snapshot);
      }
    }
  }

  return [...runsById.values()]
    .map((run) => createZergSubagentRunSnapshot(run))
    .sort((left, right) => {
      const leftTimestamp = left.startedAt ?? left.updatedAt ?? '';
      const rightTimestamp = right.startedAt ?? right.updatedAt ?? '';
      return rightTimestamp.localeCompare(leftTimestamp) || left.runId.localeCompare(right.runId);
    });
}

function getWritableStateContainer(stateOrReader: ZergStateSource): ZergStateContainer | undefined {
  return isZergStateContainer(stateOrReader) ? stateOrReader : undefined;
}

function isZergStateContainer(value: unknown): value is ZergStateContainer {
  return typeof value === 'object'
    && value !== null
    && typeof (value as Partial<ZergStateContainer>).read === 'function'
    && typeof (value as Partial<ZergStateContainer>).snapshot === 'function'
    && typeof (value as Partial<ZergStateContainer>).replace === 'function'
    && typeof (value as Partial<ZergStateContainer>).update === 'function';
}

function subscribeToZergState(stateOrReader: ZergStateSource, listener: () => void): () => void {
  if (isZergStateContainer(stateOrReader) && typeof stateOrReader.subscribe === 'function') {
    return stateOrReader.subscribe(listener);
  }

  return () => undefined;
}

function isReadOnlyTopic(value: string): boolean {
  return value === 'readonly' || value === 'read-only' || value === 'ro';
}

function parseReadOnlyValue(value: string, currentValue: boolean): boolean | undefined {
  return value === 'on'
    ? true
    : value === 'off'
      ? false
      : value === 'enable'
        ? true
        : value === 'disable'
          ? false
          : value === 'true'
            ? true
            : value === 'false'
              ? false
              : value === 'toggle'
                ? !currentValue
                : undefined;
}

function setReadOnlyMode(
  container: ZergStateContainer,
  value: string,
  options: RuntimeCommandOptions,
  source: string,
): ZergState | string {
  const current = container.read();
  const targetValue = parseReadOnlyValue(value, Boolean(current.mode.readOnly));

  if (targetValue === undefined) {
    return `Unknown ${source} readonly value: ${value}`;
  }

  const nextState = applyModeTransition(
    current,
    {
      automation: current.mode.automation,
      controller: current.mode.controller,
      interventionEnabled: current.mode.interventionEnabled,
      readOnly: targetValue,
      reason: `${source} read-only ${targetValue ? 'enabled' : 'disabled'}`,
      clearActiveIntervention: false,
    },
    {
      now: options.now ?? (() => new Date()),
    },
  );

  const snapshot = container.replace(nextState);
  if (options.syncSharedState) {
    replaceSharedZergState(snapshot);
  }
  return snapshot;
}

function setAutomationMode(container: ZergStateContainer, automation: AutomationMode, options: RuntimeCommandOptions): ZergState {
  const current = container.read();
  const nextState = applyModeTransition(
    current,
    {
      automation,
      controller: automation === 'automatic' ? 'automation' : 'operator',
      interventionEnabled: current.mode.interventionEnabled,
      readOnly: current.mode.readOnly,
      reason: `overlay mode set to ${automation}`,
      clearActiveIntervention: false,
    },
    {
      now: options.now ?? (() => new Date()),
    },
  );
  const snapshot = container.replace(nextState);
  if (options.syncSharedState) {
    replaceSharedZergState(snapshot);
  }
  return snapshot;
}

function getZergControlState(state: ZergState): ZergControlState {
  const candidate = state.extensions[ZERG_CONTROL_EXTENSION_KEY] as Partial<ZergControlState> | undefined;
  const controller = isZergControlController(candidate?.controller) ? candidate.controller : 'operator';
  return {
    controller,
    selectedTargetId: typeof candidate?.selectedTargetId === 'string' ? candidate.selectedTargetId : undefined,
    selectedTargetKind: candidate?.selectedTargetKind === 'agent' || candidate?.selectedTargetKind === 'team' || candidate?.selectedTargetKind === 'task' ? candidate.selectedTargetKind : undefined,
    selectedRunId: typeof candidate?.selectedRunId === 'string' ? candidate.selectedRunId : undefined,
    activeRunId: typeof candidate?.activeRunId === 'string' ? candidate.activeRunId : undefined,
    auditLog: Array.isArray(candidate?.auditLog) ? candidate.auditLog.slice(-20) : [],
  };
}

function updateZergControlState(
  container: ZergStateContainer,
  patch: Partial<ZergControlState>,
  message: string,
  options: RuntimeCommandOptions,
): ZergState {
  const now = (options.now ?? (() => new Date()))().toISOString();
  const current = container.read();
  const control = getZergControlState(current);
  const nextControl: ZergControlState = {
    ...control,
    ...patch,
    auditLog: [
      ...(control.auditLog ?? []),
      { id: `control-${current.revision + 1}`, action: 'control', message, createdAt: now },
    ].slice(-20),
  };
  const snapshot = container.update((state) => ({
    extensions: {
      ...state.extensions,
      [ZERG_CONTROL_EXTENSION_KEY]: nextControl,
    },
  }), { updatedAt: now });
  if (options.syncSharedState) {
    replaceSharedZergState(snapshot);
  }
  options.persistenceManager?.save(snapshot, options.now);
  return snapshot;
}

function isZergControlController(value: unknown): value is ZergControlController {
  return value === 'operator' || value === 'pi' || value === 'zerg';
}

function isAutomationMode(value: string): value is AutomationMode {
  return value === 'manual' || value === 'assisted' || value === 'automatic';
}

function getConfigTargets(state: ZergState): Array<{ id: string; label: string; kind: string; status: string }> {
  return [
    ...Object.values(state.agents).map((agent) => ({ id: agent.id, label: agent.label, kind: agent.kind, status: formatConfigStatus(agent.status, agent.runtime?.substate) })),
    ...Object.values(state.teams).map((team) => ({ id: team.id, label: team.label, kind: team.kind, status: formatConfigStatus(team.status, team.runtime?.substate) })),
    ...Object.values(state.tasks).map((task) => ({ id: task.id, label: task.title, kind: 'task', status: formatConfigStatus(task.status, task.substate) })),
  ].sort((left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id));
}

function formatConfigStatus(status: string, substate?: string): string {
  return substate ? `${status}/${substate}` : status;
}

function renderZergControlStatus(state: ZergState, width: number): string {
  const control = getZergControlState(state);
  const readOnly = state.mode.readOnly ? 'enabled' : 'disabled';
  const latestAudit = control.auditLog?.at(-1)?.message ?? 'none';
  const permissionQueue = getPermissionQueueState(state);
  const latestPermission = getPendingPermissionRequests(state).at(-1);
  const logState = getZergLogState(state);
  const latestLogWarning = logState.records.filter((record) => record.level === 'warn' || record.level === 'error').at(-1);
  const activeRun = control.activeRunId ? state.agents[control.activeRunId] : undefined;
  const activeRunSubstate = activeRun?.runtime?.substate ? ` [${activeRun.status}/${activeRun.runtime.substate}]` : '';
  const activeRunReason = activeRun?.runtime?.substateReason ? ` ${activeRun.runtime.substateReason}` : '';
  return [
    'zerg control',
    `controller: ${control.controller}`,
    `mode: ${state.mode.automation}`,
    `read-only: ${readOnly}`,
    `permissions: ${permissionQueue.pendingCount} pending${latestPermission ? ` latest:${latestPermission.id} ${latestPermission.kind} ${latestPermission.summary}` : ''}`,
    `logs: ${logState.records.length}/${logState.maxRecords}${latestLogWarning ? ` latest:${latestLogWarning.id} ${latestLogWarning.level} ${latestLogWarning.message}` : ''}`,
    `selected target: ${control.selectedTargetId ?? 'none'}`,
    `active run: ${control.activeRunId ?? 'none'}${activeRunSubstate}${activeRunReason}`,
    `adapter: Pi native runner; commands /zerg run and /zerg interrupt`,
    `latest audit: ${latestAudit}`,
  ].map((line) => line.length > width ? `${line.slice(0, Math.max(0, width - 1))}…` : line).join('\n');
}

function isTerminalRunSnapshot(run: ZergSubagentRunSnapshot): boolean {
  return run.status === 'done' || run.status === 'failed' || run.status === 'cancelled' || run.substate === 'completed' || run.substate === 'failed' || run.substate === 'cancelled';
}

function createPiNativeActiveRun(runId: string): PiNativeActiveRun {
  return { runId, cancelRequested: false, sessions: new Set<PiNativeSessionHandle>() };
}

function requestPiNativeAbort(runId: string, activeRuns: PiNativeActiveRunRegistry): { ok: boolean; message: string; activeRun?: PiNativeActiveRun } {
  const activeRun = activeRuns.get(runId);
  if (!activeRun) {
    return { ok: false, message: `No active cancellable native zerg run: ${runId}` };
  }

  activeRun.cancelRequested = true;
  let abortCount = 0;
  for (const session of activeRun.sessions) {
    if (typeof session.abort === 'function') {
      abortCount += 1;
      void Promise.resolve(session.abort()).catch(() => undefined);
    }
  }

  return {
    ok: true,
    message: abortCount > 0 ? `interrupt requested for ${runId}; abort signalled to ${abortCount} native session(s)` : `interrupt requested for ${runId}; native session is still starting`,
    activeRun,
  };
}

function setRunMetadata(container: ZergStateContainer, runId: string, metadata: Record<string, unknown>, options?: RuntimeCommandOptions): ZergState {
  const state = container.read();
  const agent = state.agents[runId];
  if (!agent) return state;
  const updated = container.replace({
    ...state,
    agents: {
      ...state.agents,
      [runId]: {
        ...agent,
        metadata: {
          ...agent.metadata,
          ...metadata,
        },
      },
    },
  });
  options?.persistenceManager?.save(updated, options.now);
  return updated;
}

function createPiSlashBridgeAdapter(
  context: StructuralPiExtensionContext,
  container: ZergStateContainer,
  options: RuntimeCommandOptions,
): ZergSubagentControlAdapter {
  const events = context.events;
  if (!events || typeof events.emit !== 'function' || typeof events.on !== 'function') {
    return createPiNativeAdapter(context, container, options);
  }

  type PendingRun = ZergSubagentRunSnapshot & { launched: boolean; started: boolean; completed: boolean };
  const runsById = new Map<string, PendingRun>();
  const activeRuns: PiNativeActiveRunRegistry = new Map();
  const fallbackLaunches = new Map<string, Promise<void>>();
  const resolveTimestamp = () => (options.now ?? (() => new Date()))().toISOString();

  const resolveTaskIdFromRun = (request: ZergSubagentLaunchRequest): string | undefined => {
    return typeof request.taskId === 'string' && request.taskId.length > 0 ? request.taskId : undefined;
  };

  const resolveLaunchMetadata = (request: ZergSubagentLaunchRequest, taskId: string | undefined, launchMode: ZergSubagentLaunchMode) => {
    const metadata = {
      ...(taskId ? { taskId } : {}),
      launchMode,
      ...(request.agentDefinitionId ? { agentDefinitionId: request.agentDefinitionId } : {}),
      ...(request.description ? { description: request.description } : {}),
      ...(request.model ? { model: request.model } : {}),
      ...(request.fallbackModels?.length ? { fallbackModels: request.fallbackModels } : {}),
      ...(request.maxTurns ? { maxTurns: request.maxTurns } : {}),
    };

    return Object.keys(metadata).length > 0 ? metadata : undefined;
  };

  const refreshRun = (runId: string): ZergSubagentRunSnapshot | undefined => {
    const stateRun = getSubagentRunSnapshot(container.read(), runId);
    const pending = runsById.get(runId);

    if (!stateRun) {
      return pending ? createZergSubagentRunSnapshot(pending) : undefined;
    }

    if (isTerminalRunSnapshot(stateRun)) {
      return createZergSubagentRunSnapshot({
        ...pending,
        ...stateRun,
        task: stateRun.task ?? pending?.task,
        agentId: stateRun.agentId ?? pending?.agentId ?? stateRun.runId,
        agentLabel: stateRun.agentLabel ?? pending?.agentLabel,
        metadata: {
          ...pending?.metadata,
          ...stateRun.metadata,
        },
      });
    }

    return createZergSubagentRunSnapshot({
      ...stateRun,
      ...pending,
      task: pending?.task ?? stateRun.task,
      agentId: pending?.agentId ?? stateRun.agentId,
      agentLabel: pending?.agentLabel ?? stateRun.agentLabel,
    });
  };

  const resolveRuns = (): ZergSubagentRunSnapshot[] => {
    const stateRuns = getSubagentRunSnapshots(container.read());
    const merged = new Map<string, ZergSubagentRunSnapshot>();

    for (const stateRun of stateRuns) {
      merged.set(stateRun.runId, createZergSubagentRunSnapshot(stateRun));
    }

    for (const [runId, pending] of runsById) {
      const existing = merged.get(runId);
      if (existing) {
        const terminal = isTerminalRunSnapshot(existing);
        merged.set(runId, createZergSubagentRunSnapshot(terminal ? {
          ...pending,
          ...existing,
          task: existing.task ?? pending.task,
          agentId: existing.agentId ?? pending.agentId,
          agentLabel: existing.agentLabel ?? pending.agentLabel,
          metadata: {
            ...pending.metadata,
            ...existing.metadata,
          },
        } : {
          ...existing,
          ...pending,
          status: existing.status ?? pending.status,
          task: pending.task ?? existing.task,
          agentId: pending.agentId ?? existing.agentId,
          agentLabel: pending.agentLabel ?? existing.agentLabel,
          metadata: {
            ...existing.metadata,
            ...pending.metadata,
          },
          taskId: pending.taskId ?? existing.taskId,
          launchMode: pending.launchMode ?? existing.launchMode,
          updatedAt: existing.updatedAt ?? pending.updatedAt,
          startedAt: existing.startedAt ?? pending.startedAt,
        }));
      } else {
        merged.set(runId, createZergSubagentRunSnapshot(pending));
      }
    }

    return [...merged.values()].sort((left, right) => {
      const leftTimestamp = left.updatedAt ?? left.startedAt ?? '';
      const rightTimestamp = right.updatedAt ?? right.startedAt ?? '';
      return rightTimestamp.localeCompare(leftTimestamp) || left.runId.localeCompare(right.runId);
    });
  };

  const updatePendingRun = (runId: string, status?: AgentStatus, eventTimestamp = resolveTimestamp(), activity?: string, substate?: ZergLifecycleSubstate, substateReason?: string): void => {
    const pending = runsById.get(runId);
    if (!pending) {
      return;
    }

    pending.updatedAt = eventTimestamp;
    if (status) {
      pending.status = status;
    }

    if (status === 'running' && !pending.startedAt) {
      pending.startedAt = eventTimestamp;
    }

    if (substate) {
      pending.substate = substate;
      pending.substateUpdatedAt = eventTimestamp;
    }

    if (substateReason) {
      pending.substateReason = substateReason;
    }

    if (activity) {
      pending.task ||= activity;
    }
  };

  const disposers = [
    subscribePiEvent(events, SLASH_SUBAGENT_STARTED_EVENT, (data) => {
      const requestId = getEventRequestId(data);
      if (!requestId) return;

      const pending = runsById.get(requestId);
      if (pending) {
        pending.started = true;
      }

      updatePendingRun(requestId, 'running', resolveTimestamp(), getSubagentRunSnapshot(container.read(), requestId)?.task, 'starting', 'bridge started');
      const snapshot = updateZergControlState(container, { activeRunId: requestId }, `subagent ${requestId} started`, options);
      const started = applyRuntimeTransition(snapshot, {
        entity: 'agent',
        action: 'start',
        id: requestId,
        label: pending?.agentLabel ?? pending?.agentId ?? requestId,
        kind: 'subagent',
        activity: pending?.task,
        substate: 'starting',
        substateReason: 'bridge started',
      }, { now: options.now ?? (() => new Date()) });
      container.replace(updateRunTaskLifecycle(started, pending?.taskId, 'running', 'starting', 'bridge started', resolveTimestamp()));
      appendLogToContainer(container, options, {
        source: 'adapter',
        level: 'info',
        kind: 'text',
        message: `bridge started ${requestId}`,
        runId: requestId,
        agentId: pending?.agentId,
        taskId: pending?.taskId,
      });
    }),
    subscribePiEvent(events, SLASH_SUBAGENT_UPDATE_EVENT, (data) => {
      const requestId = getEventRequestId(data);
      if (!requestId) return;

      const hasCurrentTool = data && typeof data === 'object' && typeof (data as { currentTool?: unknown }).currentTool === 'string';
      const currentTool = hasCurrentTool
        ? (data as { currentTool: string }).currentTool
        : 'progress';
      const substate: ZergLifecycleSubstate = hasCurrentTool ? 'tool-running' : 'executing';
      const bridgeLog = parseBridgeUpdateLog(data, hasCurrentTool ? currentTool : undefined);
      const pending = runsById.get(requestId);
      updatePendingRun(requestId, 'running', resolveTimestamp(), currentTool, substate, hasCurrentTool ? currentTool : undefined);
      const snapshot = applyRuntimeTransition(container.read(), {
        entity: 'agent',
        action: 'progress',
        id: requestId,
        kind: 'subagent',
        activity: currentTool,
        substate,
        substateReason: hasCurrentTool ? currentTool : undefined,
      }, { now: options.now ?? (() => new Date()) });
      container.replace(updateRunTaskLifecycle(snapshot, pending?.taskId, 'running', substate, hasCurrentTool ? currentTool : undefined, resolveTimestamp()));
      appendLogToContainer(container, options, {
        source: 'adapter',
        level: bridgeLog.level,
        kind: bridgeLog.kind,
        message: bridgeLog.message,
        runId: requestId,
        agentId: pending?.agentId,
        taskId: pending?.taskId,
        data: bridgeLog.data,
      });
    }),
    subscribePiEvent(events, SLASH_SUBAGENT_RESPONSE_EVENT, (data) => {
      const requestId = getEventRequestId(data);
      if (!requestId) return;

      const isError = data && typeof data === 'object' && (data as { isError?: unknown }).isError === true;
      const status: AgentStatus = isError ? 'failed' : 'done';
      const pending = runsById.get(requestId);
      if (pending) {
        pending.completed = true;
        updatePendingRun(requestId, status, resolveTimestamp(), isError ? 'subagent failed' : 'subagent complete', isError ? 'failed' : 'completed', isError ? 'subagent failed' : 'subagent complete');
      }

      const snapshot = applyRuntimeTransition(container.read(), {
        entity: 'agent',
        action: isError ? 'fail' : 'stop',
        id: requestId,
        label: pending?.agentId ?? requestId,
        kind: 'subagent',
        activity: isError ? 'subagent failed' : 'subagent complete',
        substate: isError ? 'failed' : 'completed',
        substateReason: isError ? 'subagent failed' : 'subagent complete',
      }, { now: options.now ?? (() => new Date()) });
      container.replace(updateRunTaskLifecycle(snapshot, pending?.taskId, isError ? 'failed' : 'done', isError ? 'failed' : 'completed', isError ? 'subagent failed' : 'subagent complete', resolveTimestamp()));
      appendLogToContainer(container, options, {
        source: 'adapter',
        level: isError ? 'error' : 'info',
        kind: isError ? 'error' : 'result',
        message: isError ? 'subagent failed' : 'subagent complete',
        runId: requestId,
        agentId: pending?.agentId,
        taskId: pending?.taskId,
      });
      if (pending?.launched) {
        runsById.delete(requestId);
      }
    }),
  ];

  return {
    kind: 'pi-native',
    listAgentDefinitions() {
      return getAgentDefinitions(container.read());
    },
    getAgentDefinition(id) {
      return getAgentDefinition(container.read(), id);
    },
    listRuns() {
      return resolveRuns().map((run) => createZergSubagentRunSnapshot(run));
    },
    getRun(runId) {
      return refreshRun(runId);
    },
    launch(request) {
      const requestId = request.runId
        ?? `zerg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const now = resolveTimestamp();
      const selectedDefinition = getAgentDefinition(container.read(), request.agent);
      const agentLabel = selectedDefinition?.label;
      const taskId = resolveTaskIdFromRun(request);
      const launchMode = resolveLaunchMode(request);
      const launchMetadata = resolveLaunchMetadata(request, taskId, launchMode);
      const hasExistingRun = container.read().agents[requestId] !== undefined;

      runsById.set(requestId, {
        runId: requestId,
        agentId: request.agent,
        agentLabel,
        task: request.task,
        status: 'idle',
        taskId,
        launchMode,
        substate: 'spawning',
        substateReason: 'bridge request emitted',
        substateUpdatedAt: now,
        updatedAt: now,
        startedAt: undefined,
        metadata: launchMetadata,
        launched: false,
        started: false,
        completed: false,
      });

      if (!hasExistingRun) {
        const before = applyRuntimeTransition(container.read(), {
          entity: 'agent',
          action: 'create',
          id: requestId,
          label: agentLabel ?? request.agent,
          kind: 'subagent',
          activity: request.task,
          substate: 'spawning',
          substateReason: 'bridge request emitted',
        }, { now: options.now ?? (() => new Date()) });

        const created = before.agents[requestId];
        if (created && launchMetadata) {
          container.replace({
            ...before,
            agents: {
              ...before.agents,
              [requestId]: {
                ...created,
                metadata: {
                  ...created.metadata,
                  ...launchMetadata,
                },
              },
            },
          });
        } else {
          container.replace(before);
        }
      } else {
        const existing = container.read().agents[requestId];
        if (existing) {
          container.replace({
            ...container.read(),
            agents: {
              ...container.read().agents,
              [requestId]: {
                ...existing,
                metadata: {
                  ...existing.metadata,
                  ...launchMetadata,
                },
              },
            },
          });
        }
      }

      appendLogToContainer(container, options, {
        source: 'adapter',
        level: 'info',
        kind: 'text',
        message: `bridge request emitted for ${requestId}`,
        runId: requestId,
        agentId: request.agent,
        taskId,
        data: { launchMode, background: request.background === true, model: request.model, fallbackModels: request.fallbackModels, maxTurns: request.maxTurns },
      });

      events.emit!(SLASH_SUBAGENT_REQUEST_EVENT, {
        requestId,
        params: {
          agent: request.agent,
          task: request.task,
          taskId,
          agentDefinitionId: request.agentDefinitionId,
          description: request.description,
          ...(request.model ? { model: request.model } : {}),
          ...(request.fallbackModels?.length ? { fallbackModels: request.fallbackModels } : {}),
          ...(request.maxTurns ? { maxTurns: request.maxTurns } : {}),
          clarify: false,
          agentScope: 'both',
          ...(request.background ? { async: true } : {}),
          ...(launchMode === 'fork' ? { context: 'fork' as const } : {}),
        },
      });

      const run = runsById.get(requestId);
      if (!run) {
        return { ok: false, runId: requestId, taskId, message: `failed to initialize zerg run ${requestId}` };
      }

      if (!run.started) {
        const fallbackLaunch = new Promise<void>((resolve) => {
          setTimeout(() => {
            if (run.started || run.completed || activeRuns.has(requestId)) {
              resolve();
              return;
            }
            run.started = true;
            run.launched = true;
            updatePendingRun(requestId, 'running', resolveTimestamp(), request.task, 'starting', 'pi native runner started');
            const started = applyRuntimeTransition(container.read(), {
              entity: 'agent',
              action: 'start',
              id: requestId,
              label: agentLabel ?? request.agent,
              kind: 'subagent',
              activity: request.task,
              substate: 'starting',
              substateReason: 'pi native runner started',
            }, { now: options.now ?? (() => new Date()) });
            container.replace(updateRunTaskLifecycle(started, taskId, 'running', 'starting', 'pi native runner started', resolveTimestamp()));
            appendLogToContainer(container, options, {
              source: 'adapter',
              level: 'info',
              kind: 'text',
              message: `pi native launch started ${requestId}`,
              runId: requestId,
              agentId: request.agent,
              taskId,
              data: { launchMode, model: request.model, fallbackModels: request.fallbackModels, maxTurns: request.maxTurns },
            });
            const activeRun = createPiNativeActiveRun(requestId);
            activeRuns.set(requestId, activeRun);
            activeRun.promise = runPiNativeZergRequest(context, container, options, request, requestId, taskId, launchMode, activeRun)
              .finally(() => activeRuns.delete(requestId));
            void activeRun.promise.finally(resolve);
          }, NATIVE_BRIDGE_ACK_GRACE_MS);
        }).finally(() => fallbackLaunches.delete(requestId));
        fallbackLaunches.set(requestId, fallbackLaunch);
      }

      run.launched = true;
      updateZergControlState(container, { activeRunId: requestId }, `launched ${request.agent}`, options);
      appendLogToContainer(container, options, {
        source: 'adapter',
        level: 'info',
        kind: 'text',
        message: `bridge launch confirmed ${requestId}`,
        runId: requestId,
        agentId: request.agent,
        taskId,
        data: { launchMode, model: request.model, fallbackModels: request.fallbackModels, maxTurns: request.maxTurns },
      });
      return { ok: true, runId: requestId, taskId, message: `zerg launched ${request.agent} as ${requestId} (${launchMode})` };
    },
    async awaitRun(runId) {
      const fallbackLaunch = fallbackLaunches.get(runId);
      if (fallbackLaunch) {
        await fallbackLaunch;
      }
      const activeRun = activeRuns.get(runId);
      return activeRun?.promise?.then(() => getSubagentRunSnapshot(container.read(), runId)) ?? Promise.resolve(getSubagentRunSnapshot(container.read(), runId));
    },
    interrupt(runId) {
      const target = runId || getZergControlState(container.read()).activeRunId;
      if (!target) {
        return { ok: false, message: 'No active zerg subagent run to interrupt.' };
      }
      events.emit!(SLASH_SUBAGENT_CANCEL_EVENT, { requestId: target });
      const abortResult = requestPiNativeAbort(target, activeRuns);
      const snapshot = updateZergControlState(container, { activeRunId: target }, `interrupt requested for ${target}`, options);
      container.replace(applyRuntimeTransition(snapshot, {
        entity: 'agent',
        action: 'progress',
        id: target,
        kind: 'subagent',
        status: 'running',
        activity: 'interrupt requested',
        substate: 'cancelling',
        substateReason: abortResult.ok ? abortResult.message : 'bridge interrupt requested; native abort handle unavailable',
      }, { now: options.now ?? (() => new Date()) }));
      appendLogToContainer(container, options, {
        source: 'adapter',
        level: 'warn',
        kind: 'text',
        message: abortResult.ok ? abortResult.message : `bridge interrupt requested for ${target}`,
        runId: target,
      });
      return { ok: true, runId: target, message: abortResult.ok ? abortResult.message : `bridge interrupt requested for ${target}; native abort handle unavailable` };
    },
    dispose() {
      for (const dispose of disposers) dispose();
      for (const runId of activeRuns.keys()) {
        requestPiNativeAbort(runId, activeRuns);
      }
      activeRuns.clear();
      fallbackLaunches.clear();
      runsById.clear();
    },
  };
}

function createPiNativeAdapter(
  context: StructuralPiExtensionContext,
  container: ZergStateContainer,
  options: RuntimeCommandOptions,
): ZergSubagentControlAdapter {
  const activeRuns: PiNativeActiveRunRegistry = new Map();
  const persistenceManager = options.persistenceManager ?? createZergPersistenceManager(options.persistence);
  const runtimeOptions = { ...options, persistenceManager } as RuntimeCommandOptions;
  persistenceManager?.hydrate(container, runtimeOptions.now);
  persistenceManager?.save(container.read(), runtimeOptions.now);
  return {
    kind: 'pi-native',
    listAgentDefinitions() {
      return getAgentDefinitions(container.read());
    },
    getAgentDefinition(id) {
      return getAgentDefinition(container.read(), id);
    },
    listRuns() {
      return getSubagentRunSnapshots(container.read());
    },
    getRun(runId) {
      return getSubagentRunSnapshot(container.read(), runId);
    },
    launch(request) {
      const requestId = request.runId ?? `zerg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const taskId = typeof request.taskId === 'string' && request.taskId.length > 0 ? request.taskId : undefined;
      const launchMode = resolveLaunchMode(request);
      const now = (runtimeOptions.now ?? (() => new Date()))().toISOString();
      const definition = getAgentDefinition(container.read(), request.agent);
      const label = definition?.label ?? request.agent;
      updateZergControlState(container, { activeRunId: requestId }, `launched ${request.agent}`, runtimeOptions);
      const started = applyRuntimeTransition(container.read(), {
        entity: 'agent',
        action: 'start',
        id: requestId,
        label,
        kind: 'subagent',
        activity: request.task,
        substate: 'starting',
        substateReason: 'pi native runner started',
        metadata: {
          ...(taskId ? { taskId } : {}),
          launchMode,
          ...(request.agentDefinitionId ? { agentDefinitionId: request.agentDefinitionId } : {}),
          ...(request.model ? { model: request.model } : {}),
          ...(request.fallbackModels?.length ? { fallbackModels: request.fallbackModels } : {}),
          ...(request.maxTurns ? { maxTurns: request.maxTurns } : {}),
        },
      }, { now: () => new Date(now) });
      container.replace(updateRunTaskLifecycle(started, taskId, 'running', 'starting', 'pi native runner started', now));
      persistenceManager?.save(container.read(), runtimeOptions.now);
      appendLogToContainer(container, runtimeOptions, {
        source: 'adapter',
        level: 'info',
        kind: 'text',
        message: `pi native launch started ${requestId}`,
        runId: requestId,
        agentId: request.agent,
        taskId,
        data: { launchMode, model: request.model, fallbackModels: request.fallbackModels, maxTurns: request.maxTurns },
      });
      const activeRun = createPiNativeActiveRun(requestId);
      activeRuns.set(requestId, activeRun);
      activeRun.promise = runPiNativeZergRequest(context, container, runtimeOptions, request, requestId, taskId, launchMode, activeRun)
        .finally(() => activeRuns.delete(requestId));
      void activeRun.promise;
      return { ok: true, runId: requestId, taskId, message: `zerg launched ${request.agent} as ${requestId} (${launchMode})` };
    },
    async sendMessage(targetId, body, runId): Promise<ZergOperatorMessageResult> {
      const activeRun = runId ? activeRuns.get(runId) : Array.from(activeRuns.values()).at(-1);
      const targetRunId = activeRun?.runId ?? runId;
      if (!activeRun || activeRun.sessions.size === 0) {
        return { ok: false, runId: targetRunId, targetId, routedTargetId: targetId, status: 'transport-unavailable', message: targetRunId ? `No live native session is available for ${targetRunId}.` : 'No live native zerg run is available.' };
      }
      const session = Array.from(activeRun.sessions).find((candidate) => typeof candidate.prompt === 'function');
      if (!session?.prompt) {
        return { ok: false, runId: targetRunId, targetId, routedTargetId: targetId, status: 'transport-unavailable', message: `Native session for ${activeRun.runId} does not expose prompt transport.` };
      }
      try {
        await session.prompt(`Operator message for ${targetId}: ${body}`, { source: 'extension' });
        appendLogToContainer(container, runtimeOptions, { source: 'overlay', level: 'info', kind: 'text', message: `operator message delivered to ${targetId}`, runId: activeRun.runId, agentId: targetId, data: { targetId, body } });
        return { ok: true, runId: activeRun.runId, targetId, routedTargetId: targetId, status: 'delivered', message: `operator message delivered to ${targetId}` };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        appendLogToContainer(container, runtimeOptions, { source: 'overlay', level: 'warn', kind: 'error', message: `operator message delivery failed for ${targetId}: ${detail}`, runId: activeRun.runId, agentId: targetId, data: { targetId } });
        return { ok: false, runId: activeRun.runId, targetId, routedTargetId: targetId, status: 'delivery-failed', message: `operator message delivery failed for ${targetId}: ${detail}` };
      }
    },
    async awaitRun(runId) {
      await Promise.resolve();
      const activeRun = activeRuns.get(runId);
      return activeRun?.promise?.then(() => getSubagentRunSnapshot(container.read(), runId)) ?? Promise.resolve(getSubagentRunSnapshot(container.read(), runId));
    },
    interrupt(runId) {
      const target = runId || getZergControlState(container.read()).activeRunId;
      if (!target) {
        return { ok: false, message: 'No active zerg run to interrupt.' };
      }
      const abortResult = requestPiNativeAbort(target, activeRuns);
      if (!abortResult.ok) {
        return { ok: false, runId: target, message: abortResult.message };
      }
      const snapshot = applyRuntimeTransition(container.read(), {
        entity: 'agent',
        action: 'progress',
        id: target,
        kind: 'subagent',
        status: 'running',
        activity: 'interrupt requested',
        substate: 'cancelling',
        substateReason: abortResult.message,
      }, { now: runtimeOptions.now ?? (() => new Date()) });
      container.replace(snapshot);
      persistenceManager?.save(container.read(), runtimeOptions.now);
      appendLogToContainer(container, runtimeOptions, {
        source: 'adapter',
        level: 'warn',
        kind: 'text',
        message: abortResult.message,
        runId: target,
      });
      return { ok: true, runId: target, message: abortResult.message };
    },
    dispose() {
      for (const runId of activeRuns.keys()) {
        requestPiNativeAbort(runId, activeRuns);
      }
      activeRuns.clear();
      persistenceManager?.save(container.read(), runtimeOptions.now);
    },
  };
}

async function runPiNativeZergRequest(
  context: StructuralPiExtensionContext,
  container: ZergStateContainer,
  options: RuntimeCommandOptions,
  request: ZergSubagentLaunchRequest,
  runId: string,
  taskId: string | undefined,
  launchMode: ZergSubagentLaunchMode,
  activeRun?: PiNativeActiveRun,
): Promise<void> {
  const timestamp = () => (options.now ?? (() => new Date()))().toISOString();
  const state = container.read();
  const leaderDefinition = getAgentDefinition(state, request.agent);
  const ledTeam = Object.values(state.teams).find((team) => team.leaderAgentId === request.agent);
  const memberDefinitions = ledTeam
    ? (ledTeam.memberAgentIds ?? [])
      .filter((memberId) => memberId !== request.agent)
      .map((memberId) => getAgentDefinition(state, memberId))
      .filter((definition): definition is ZergAgentDefinition => definition !== undefined)
    : [];
  const cwd = resolvePiNativeCwd(context);
  const coordDir = `coord/zerg-${runId.replace(/^zerg-/, '')}`;
  const coordPath = resolvePath(cwd, coordDir);

  try {
    mkdirSync(coordPath, { recursive: true });
    setRunMetadata(container, runId, { coordDir, coordPath, originalTask: request.task }, options);

    const promptBase = [
      `Run id: ${runId}`,
      `Task: ${request.task}`,
      `Launch mode: ${launchMode}`,
      `Communication directory: ${coordDir}`,
      'Use Larra or project intelligence tools when the task or project instructions request them and the tools are available.',
      'Follow the task scope exactly. Do not edit source, run mutating commands, or change git state unless the task explicitly asks for implementation work.',
      'Write concise status/handoff notes in the communication directory.',
    ].join('\n');

    let workerSummaries = '';
    if (memberDefinitions.length > 0) {
      const startedAt = timestamp();
      setRunMetadata(container, runId, { memberProgress: memberDefinitions.map((definition) => ({ agentId: definition.id, runId: `${runId}-${definition.id}`, status: 'queued', handoffPath: `${coordDir}/${definition.id}.md` })) }, options);
      const settledSummaries = await Promise.allSettled(memberDefinitions.map((definition) => runSinglePiNativeAgent(context, definition, {
        task: `${promptBase}\n\nYou are team member ${definition.id}. Complete your assigned slice for the team task, read existing files as needed, preserve the caller's scope, and write only ${coordDir}/${definition.id}.md with your handoff.`,
        runId: `${runId}-${definition.id}`,
        taskId,
        parentRunId: runId,
        request,
        options,
        container,
        activeRun,
        handoffPath: `${coordDir}/${definition.id}.md`,
        teamStartedAt: startedAt,
      })));
      const summaries = settledSummaries.map((summary, index) => summary.status === 'fulfilled'
        ? summary.value
        : { agentId: memberDefinitions[index]?.id ?? `member-${index}`, status: 'failed' as const, message: summary.reason instanceof Error ? summary.reason.message : String(summary.reason) });
      workerSummaries = summaries.map((summary) => `- ${summary.agentId}: ${summary.status}${summary.message ? ` (${summary.message})` : ''}`).join('\n');
    }

    const leaderInstruction = memberDefinitions.length > 0
      ? `The worker pass finished with:\n${workerSummaries}\n\nRead ${coordDir}/ and project files as needed, integrate the workers' results within the original task scope, and write ${coordDir}/team-lead-final.md. Only run validation or modify files when the original task explicitly requests that work.`
      : 'Complete the requested task according to its stated scope, only run validation or modify files when that scope requires it, and report final status.';
    const leaderPrompt = `${promptBase}\n\nYou are ${leaderDefinition?.id ?? request.agent}, the team lead reporting to Arria. ${leaderInstruction}`;
    const leaderResult = await runSinglePiNativeAgent(context, leaderDefinition ?? { id: request.agent, label: request.agent, prompt: '', source: 'runtime' }, {
      task: leaderPrompt,
      runId,
      taskId,
      parentRunId: runId,
      request,
      options,
      container,
      activeRun,
      handoffPath: memberDefinitions.length > 0 ? `${coordDir}/team-lead-final.md` : undefined,
    });

    if (leaderResult.status === 'failed') {
      throw new Error(leaderResult.message ?? 'pi native leader failed');
    }

    const doneAt = timestamp();
    const wasCancelled = activeRun?.cancelRequested === true || leaderResult.status === 'cancelled';
    const finalSummary = wasCancelled ? 'pi native run cancelled' : (leaderResult.message ?? 'pi native run complete');
    const finalActivity = finalSummary.split(/\r?\n/, 1)[0]?.trim() || (wasCancelled ? 'pi native run cancelled' : 'pi native run complete');
    const stopped = applyRuntimeTransition(container.read(), {
      entity: 'agent',
      action: wasCancelled ? 'fail' : 'stop',
      id: runId,
      label: leaderDefinition?.label ?? request.agent,
      kind: 'subagent',
      status: wasCancelled ? 'cancelled' : 'done',
      activity: finalActivity,
      substate: wasCancelled ? 'cancelled' : 'completed',
      substateReason: wasCancelled ? 'pi native run cancelled' : finalActivity,
      metadata: { completedAt: doneAt, finalSummary, originalTask: request.task },
    }, { now: () => new Date(doneAt) });
    container.replace(updateRunTaskLifecycle(stopped, taskId, wasCancelled ? 'cancelled' : 'done', wasCancelled ? 'cancelled' : 'completed', wasCancelled ? 'pi native run cancelled' : finalActivity, doneAt));
    appendLogToContainer(container, options, {
      source: 'adapter',
      level: 'info',
      kind: 'result',
      message: wasCancelled ? 'pi native run cancelled' : 'pi native run complete',
      runId,
      agentId: request.agent,
      taskId,
      data: { finalSummary },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failedAt = timestamp();
    const failed = applyRuntimeTransition(container.read(), {
      entity: 'agent',
      action: 'fail',
      id: runId,
      label: leaderDefinition?.label ?? request.agent,
      kind: 'subagent',
      activity: message,
      status: activeRun?.cancelRequested ? 'cancelled' : 'failed',
      substate: activeRun?.cancelRequested ? 'cancelled' : 'failed',
      substateReason: activeRun?.cancelRequested ? 'pi native run cancelled' : message,
      metadata: { completedAt: failedAt, errorSummary: activeRun?.cancelRequested ? undefined : message, originalTask: request.task },
    }, { now: () => new Date(failedAt) });
    container.replace(updateRunTaskLifecycle(failed, taskId, activeRun?.cancelRequested ? 'cancelled' : 'failed', activeRun?.cancelRequested ? 'cancelled' : 'failed', activeRun?.cancelRequested ? 'pi native run cancelled' : message, failedAt));
    appendLogToContainer(container, options, {
      source: 'adapter',
      level: 'error',
      kind: 'error',
      message,
      runId,
      agentId: request.agent,
      taskId,
    });
  }
}

type PiNativeRunContext = {
  task: string;
  runId: string;
  parentRunId: string;
  taskId: string | undefined;
  request: ZergSubagentLaunchRequest;
  options: RuntimeCommandOptions;
  container: ZergStateContainer;
  activeRun?: PiNativeActiveRun;
  handoffPath?: string;
  teamStartedAt?: string;
};

async function runSinglePiNativeAgent(
  context: StructuralPiExtensionContext,
  definition: ZergAgentDefinition,
  run: PiNativeRunContext,
): Promise<{ agentId: string; status: 'done' | 'failed' | 'cancelled'; message?: string }> {
  if (run.activeRun?.cancelRequested) {
    updateMemberProgress(run, definition.id, 'cancelled', { completedAt: (run.options.now ?? (() => new Date()))().toISOString(), handoffPath: run.handoffPath, message: 'cancel requested before session start' });
    return { agentId: definition.id, status: 'cancelled', message: 'cancel requested before session start' };
  }

  const sdk = await import('@earendil-works/pi-coding-agent');
  const cwd = resolvePiNativeCwd(context);
  const authStorage = sdk.AuthStorage.create();
  const modelRegistry = sdk.ModelRegistry.create(authStorage);
  const modelSpec = definition.model ?? run.request.model;
  const { modelId, thinkingLevel } = splitModelAndThinking(modelSpec);
  const model = await resolvePiNativeModel(modelRegistry as never, modelId);
  const tools = resolvePiNativeTools(definition.tools);
  const settingsManager = sdk.SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: true, maxRetries: 2 },
  });
  const resourceLoader = await createPiNativeResourceLoader(sdk, definition, run.task, cwd, settingsManager);
  const customTools = createPiNativeCustomTools(tools);
  const sessionManager = sdk.SessionManager.create(cwd);
  const { session } = await sdk.createAgentSession({
    cwd,
    model: model as never,
    thinkingLevel: thinkingLevel as never,
    authStorage,
    modelRegistry,
    resourceLoader: resourceLoader as never,
    tools,
    customTools: customTools as never,
    sessionManager,
    settingsManager,
  });
  const updateAt = () => (run.options.now ?? (() => new Date()))().toISOString();
  let capturedResponse: string | undefined;
  const captureResponse = (value: unknown) => {
    capturedResponse = extractPiNativePromptResponse(value) ?? capturedResponse;
  };
  run.activeRun?.sessions.add(session as PiNativeSessionHandle);
  updateMemberProgress(run, definition.id, 'running', { startedAt: updateAt(), handoffPath: run.handoffPath });
  const unsubscribe = session.subscribe((event: { type?: string; [key: string]: unknown }) => {
    if (event.type === 'message_end' || event.type === 'turn_end' || event.type === 'agent_end') {
      captureResponse(event);
    }
    if (event.type === 'tool_execution_start') {
      appendLogToContainer(run.container, run.options, {
        source: 'adapter',
        level: 'info',
        kind: 'tool',
        message: `tool running: ${String((event as { toolName?: unknown }).toolName ?? 'tool')}`,
        runId: run.parentRunId,
        agentId: definition.id,
        taskId: run.taskId,
      });
    }
  });

  try {
    appendLogToContainer(run.container, run.options, {
      source: 'adapter',
      level: 'info',
      kind: 'text',
      message: `pi native agent started ${definition.id}`,
      runId: run.parentRunId,
      agentId: definition.id,
      taskId: run.taskId,
      data: { model: modelSpec, tools },
    });
    if (run.activeRun?.cancelRequested) {
      return { agentId: definition.id, status: 'cancelled', message: 'cancel requested before prompt' };
    }
    const promptResult = await session.prompt(run.task, { source: 'extension' as never });
    captureResponse(promptResult);
    captureResponse((session as { messages?: unknown }).messages);
    if (run.activeRun?.cancelRequested) {
      updateMemberProgress(run, definition.id, 'cancelled', { completedAt: updateAt(), handoffPath: run.handoffPath, message: 'cancelled' });
      return { agentId: definition.id, status: 'cancelled', message: 'cancelled' };
    }
    const handoffMessage = ensurePiNativeHandoff(context, run, definition.id, capturedResponse ?? promptResult);
    appendLogToContainer(run.container, run.options, {
      source: 'adapter',
      level: 'info',
      kind: 'result',
      message: `pi native agent complete ${definition.id}`,
      runId: run.parentRunId,
      agentId: definition.id,
      taskId: run.taskId,
      data: { completedAt: updateAt(), handoffPath: run.handoffPath, handoff: handoffMessage },
    });
    updateMemberProgress(run, definition.id, 'done', { completedAt: updateAt(), handoffPath: run.handoffPath, message: handoffMessage });
    return { agentId: definition.id, status: 'done', message: handoffMessage };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendLogToContainer(run.container, run.options, {
      source: 'adapter',
      level: 'error',
      kind: 'error',
      message: `${definition.id}: ${message}`,
      runId: run.parentRunId,
      agentId: definition.id,
      taskId: run.taskId,
    });
    const status = run.activeRun?.cancelRequested ? 'cancelled' : 'failed';
    updateMemberProgress(run, definition.id, status, { completedAt: updateAt(), handoffPath: run.handoffPath, message });
    return { agentId: definition.id, status, message };
  } finally {
    run.activeRun?.sessions.delete(session as PiNativeSessionHandle);
    unsubscribe();
    session.dispose();
  }
}

function ensurePiNativeHandoff(
  context: StructuralPiExtensionContext,
  run: PiNativeRunContext,
  agentId: string,
  promptResult: unknown,
): string {
  const fallback = stringifyPiNativePromptResult(promptResult) ?? `${agentId} completed; no textual response was captured by the Pi session.`;
  if (!run.handoffPath) {
    return fallback;
  }

  const cwd = resolvePiNativeCwd(context);
  const fullPath = resolvePath(cwd, run.handoffPath);
  const existing = readPiNativeHandoff(fullPath);
  if (existing) {
    return `handoff:${run.handoffPath}`;
  }

  try {
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, `${fallback.trim()}\n`, 'utf8');
    return `handoff:${run.handoffPath}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `handoff unavailable: ${message}`;
  }
}

function readPiNativeHandoff(path: string): string | undefined {
  if (!existsSync(path)) {
    return undefined;
  }
  try {
    const content = readFileSync(path, 'utf8').trim();
    return content || undefined;
  } catch {
    return undefined;
  }
}

function stringifyPiNativePromptResult(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const text = value.trim();
    return text || undefined;
  }
  if (Array.isArray(value)) {
    const text = value.map((entry) => stringifyPiNativePromptResult(entry)).filter(Boolean).join('\n').trim();
    return text || undefined;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of ['text', 'message', 'output', 'summary', 'content']) {
      const text = stringifyPiNativePromptResult(record[key]);
      if (text) return text;
    }
    try {
      const serialized = JSON.stringify(value);
      return serialized && serialized !== '{}' ? serialized : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function isPiNativeAssistantMessage(value: unknown): boolean {
  if (!isNativePlainRecord(value)) return false;
  return value.role === 'assistant' || value.type === 'assistant' || value.kind === 'assistant';
}

function extractPiNativePromptResponse(value: unknown): string | undefined {
  if (!value) return undefined;
  if (typeof value === 'string') return stringifyPiNativePromptResult(value);
  if (Array.isArray(value)) {
    for (let index = value.length - 1; index >= 0; index -= 1) {
      const text = extractPiNativePromptResponse(value[index]);
      if (text) return text;
    }
    return undefined;
  }
  if (!isNativePlainRecord(value)) return stringifyPiNativePromptResult(value);

  const messages = value.messages;
  if (Array.isArray(messages)) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const text = extractPiNativePromptResponse(messages[index]);
      if (text) return text;
    }
  }

  const message = value.message;
  if (message && isPiNativeAssistantMessage(message)) {
    return stringifyPiNativePromptResult(message);
  }

  if (isPiNativeAssistantMessage(value)) {
    return stringifyPiNativePromptResult(value);
  }

  return undefined;
}

function updateMemberProgress(
  run: PiNativeRunContext,
  agentId: string,
  status: 'queued' | 'starting' | 'running' | 'done' | 'failed' | 'cancelled',
  patch: { startedAt?: string; completedAt?: string; handoffPath?: string; message?: string } = {},
): void {
  const state = run.container.read();
  const parent = state.agents[run.parentRunId];
  if (!parent) return;
  const existing = Array.isArray(parent.metadata?.memberProgress) ? parent.metadata.memberProgress as Array<Record<string, unknown>> : [];
  const next = [...existing];
  const index = next.findIndex((member) => member.agentId === agentId);
  const current = index >= 0 ? next[index]! : { agentId, runId: run.runId, handoffPath: run.handoffPath };
  const updated = { ...current, agentId, runId: run.runId, status, ...patch };
  if (index >= 0) next[index] = updated;
  else next.push(updated);
  setRunMetadata(run.container, run.parentRunId, { memberProgress: next }, run.options);
}

const LARRA_NATIVE_TOOL_NAMES = [
  'larra_orient_session',
  'larra_get_project_memory',
  'larra_get_work_context',
  'larra_register_agent',
  'larra_search_symbols',
  'larra_get_symbol_source',
  'larra_get_module_interface',
  'larra_search_files',
  'larra_get_impact_analysis',
  'larra_describe_param',
] as const;

const LARRA_MCP_TOOL_ALIASES: Record<string, string> = {
  larra_orient_session: 'orient_session',
  larra_get_project_memory: 'get_project_memory',
  larra_get_work_context: 'get_work_context',
  larra_register_agent: 'register_agent',
  larra_search_symbols: 'search_symbols',
  larra_get_symbol_source: 'get_symbol_source',
  larra_get_module_interface: 'get_module_interface',
  larra_search_files: 'search_files',
  larra_get_impact_analysis: 'get_impact_analysis',
  larra_describe_param: 'describe_param',
};

type LarraMcpJson = null | boolean | number | string | LarraMcpJson[] | { [key: string]: LarraMcpJson };
type LarraMcpToolResult = { content?: Array<{ type?: string; text?: string }>; isError?: boolean; [key: string]: unknown };

function createPiNativeCustomTools(activeToolNames: readonly string[]): StructuralPiToolDefinition[] {
  const active = new Set(activeToolNames);
  const wantsLarra = active.has('mcp') || active.has('larra') || LARRA_NATIVE_TOOL_NAMES.some((name) => active.has(name));
  if (!wantsLarra) return [];

  return [
    createLarraMcpGatewayTool(),
    ...LARRA_NATIVE_TOOL_NAMES.map((toolName) => createLarraMcpAliasTool(toolName, LARRA_MCP_TOOL_ALIASES[toolName])),
  ];
}

function createLarraMcpGatewayTool(): StructuralPiToolDefinition {
  return {
    name: 'mcp',
    label: 'Larra MCP gateway',
    description: 'Call Larra MCP tools from a native zerg agent. Set tool to a Larra tool name such as larra_orient_session and args to the JSON arguments.',
    promptSnippet: 'Use mcp with server=larra to call Larra MCP tools when project instructions require Larra-first code understanding.',
    promptGuidelines: ['For pi-zerg-swarm planning, call Larra tools through mcp before falling back to raw file scanning.'],
    parameters: {
      type: 'object',
      additionalProperties: true,
      properties: {
        server: { type: 'string' },
        tool: { type: 'string' },
        args: {},
      },
      required: ['tool'],
    },
    async execute(_toolCallId: string, params: unknown, signal?: AbortSignal) {
      const record = isNativePlainRecord(params) ? params : {};
      const server = typeof record.server === 'string' ? record.server : 'larra';
      if (server !== 'larra') {
        return createLarraToolTextResult(`Unsupported MCP server: ${server}. Native zerg currently exposes only the Larra MCP bridge.`, { ok: false, server });
      }
      const requestedTool = typeof record.tool === 'string' ? record.tool : '';
      if (!requestedTool) {
        return createLarraToolTextResult('mcp requires a Larra tool name in the tool parameter.', { ok: false });
      }
      const args = parseLarraMcpArguments(record.args ?? record.arguments ?? {});
      const result = await callLarraMcpTool(requestedTool, args, signal);
      return createLarraToolTextResult(formatLarraMcpToolResult(result), { ok: !result.isError, server, tool: requestedTool, result });
    },
  };
}

function createLarraMcpAliasTool(publicName: string, mcpName: string | undefined): StructuralPiToolDefinition {
  return {
    name: publicName,
    label: publicName.replace(/^larra_/, 'Larra '),
    description: `Call the Larra MCP ${mcpName ?? publicName} tool.`,
    promptSnippet: `Use ${publicName} for Larra-backed project context when instructed to use Larra.`,
    parameters: { type: 'object', additionalProperties: true, properties: {} },
    async execute(_toolCallId: string, params: unknown, signal?: AbortSignal) {
      const result = await callLarraMcpTool(mcpName ?? publicName, parseLarraMcpArguments(params), signal);
      return createLarraToolTextResult(formatLarraMcpToolResult(result), { ok: !result.isError, tool: publicName, result });
    },
  };
}

function parseLarraMcpArguments(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return isNativePlainRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return isNativePlainRecord(value) ? { ...value } : {};
}

function isNativePlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeLarraMcpToolName(toolName: string): string {
  const mapped = LARRA_MCP_TOOL_ALIASES[toolName];
  if (mapped) return mapped;
  return toolName.startsWith('larra_') ? toolName.slice('larra_'.length) : toolName;
}

function formatLarraMcpToolResult(result: LarraMcpToolResult): string {
  const text = result.content?.map((entry) => typeof entry.text === 'string' ? entry.text : '').filter(Boolean).join('\n').trim();
  if (text) return text;
  return JSON.stringify(result, null, 2);
}

function createLarraToolTextResult(text: string, details: Record<string, unknown>) {
  return { content: [{ type: 'text', text }], details };
}

async function callLarraMcpTool(toolName: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<LarraMcpToolResult> {
  const command = process.env.LARRA_MCP_PYTHON ?? '/opt/larra/venv/bin/python';
  const child = spawn(command, ['-m', 'larra.mcp.stdio', '--no-auth'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const stdout = createInterface({ input: child.stdout });
  let nextId = 1;
  let stderr = '';
  let settled = false;
  const pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>();

  const failAll = (error: Error) => {
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  };
  const cleanup = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    stdout.close();
    if (!child.killed) child.kill();
  };
  const timeout = setTimeout(() => failAll(new Error(`Larra MCP tool ${toolName} timed out.`)), 30_000);

  child.stderr.on('data', (chunk: Buffer | string) => { stderr += chunk.toString(); });
  child.on('error', (error) => failAll(error));
  child.on('exit', (code) => {
    if (pending.size > 0) failAll(new Error(`Larra MCP process exited with code ${code ?? 'unknown'}${stderr ? `: ${stderr.trim()}` : ''}`));
  });
  signal?.addEventListener('abort', () => failAll(new Error('Larra MCP tool call aborted.')), { once: true });

  stdout.on('line', (line) => {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    const id = typeof message.id === 'number' ? message.id : undefined;
    if (id === undefined) return;
    const waiter = pending.get(id);
    if (!waiter) return;
    pending.delete(id);
    if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
    else waiter.resolve(message);
  });

  const call = (method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  };

  try {
    await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'pi-zerg-swarm', version: ZERG_EXTENSION_VERSION } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);
    const response = await call('tools/call', { name: normalizeLarraMcpToolName(toolName), arguments: args as LarraMcpJson });
    return response.result as LarraMcpToolResult;
  } finally {
    cleanup();
  }
}

function resolvePiNativeCwd(context: StructuralPiExtensionContext): string {
  const candidate = (context as { cwd?: unknown }).cwd;
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : process.cwd();
}

function splitModelAndThinking(modelSpec: string | undefined): { modelId: string | undefined; thinkingLevel: string | undefined } {
  if (!modelSpec) return { modelId: undefined, thinkingLevel: undefined };
  const index = modelSpec.lastIndexOf(':');
  if (index <= 0) return { modelId: modelSpec, thinkingLevel: undefined };
  return { modelId: modelSpec.slice(0, index), thinkingLevel: modelSpec.slice(index + 1) };
}

async function resolvePiNativeModel(modelRegistry: { getAvailable(): Array<{ provider: string; id: string }> | Promise<Array<{ provider: string; id: string }>> }, modelId: string | undefined): Promise<unknown> {
  const available = await Promise.resolve(modelRegistry.getAvailable());
  if (available.length === 0) {
    throw new Error('No available Pi models for native zerg run.');
  }
  if (!modelId) return available[0];
  const requested = modelId.includes('/')
    ? available.find((model) => `${model.provider}/${model.id}` === modelId)
    : available.find((model) => model.id === modelId || `${model.provider}/${model.id}` === modelId);
  if (!requested) {
    throw new Error(`Model ${modelId} is not available for native zerg run.`);
  }
  return requested;
}

function resolvePiNativeTools(tools: readonly string[] | undefined): string[] {
  const mapped = new Set<string>();
  const source = tools && tools.length > 0 ? tools : ['read', 'bash'];
  for (const tool of source) {
    if (tool === 'files') {
      mapped.add('read');
      mapped.add('edit');
      mapped.add('write');
    } else if (tool === 'shell') {
      mapped.add('bash');
    } else if (tool === 'mcp' || tool === 'larra') {
      mapped.add('mcp');
      for (const larraTool of LARRA_NATIVE_TOOL_NAMES) mapped.add(larraTool);
    } else {
      mapped.add(tool);
    }
  }
  return [...mapped];
}

async function createPiNativeResourceLoader(
  sdk: {
    createExtensionRuntime(): unknown;
    DefaultResourceLoader?: new (options: any) => { reload(): Promise<void> };
    getAgentDir?: () => string;
  },
  definition: ZergAgentDefinition,
  task: string,
  cwd: string,
  settingsManager: unknown,
): Promise<unknown> {
  const systemPrompt = [
    definition.prompt || `You are ${definition.label ?? definition.id}, a zerg coding agent.`,
    '',
    'You are running inside pi-zerg-swarm native execution, not pi-subagents.',
    'Use available project intelligence tools, including Larra, when the task or project instructions require them.',
    'Coordinate through project files when asked to work in a team.',
    `Current assigned task:\n${task}`,
  ].join('\n');

  if (sdk.DefaultResourceLoader && typeof sdk.getAgentDir === 'function') {
    const loader = new sdk.DefaultResourceLoader({ cwd, agentDir: sdk.getAgentDir(), settingsManager, systemPrompt });
    await loader.reload();
    return loader;
  }

  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: sdk.createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getAppendSystemPrompt: () => [],
    extendResources: () => undefined,
    reload: async () => undefined,
  };
}

function subscribePiEvent(
  events: NonNullable<StructuralPiExtensionContext['events']>,
  eventName: string,
  handler: (data: unknown) => void,
): () => void {
  const registration = events.on?.(eventName, handler);
  if (typeof registration === 'function') {
    return () => { (registration as () => void)(); };
  }
  if (registration && typeof registration === 'object' && typeof (registration as { dispose?: unknown }).dispose === 'function') {
    return () => (registration as { dispose(): void }).dispose();
  }
  return () => undefined;
}

function getEventRequestId(data: unknown): string | undefined {
  return data && typeof data === 'object' && typeof (data as { requestId?: unknown }).requestId === 'string'
    ? (data as { requestId: string }).requestId
    : undefined;
}

function parseBridgeUpdateLog(data: unknown, currentTool: string | undefined): { level: 'info' | 'error'; kind: 'text' | 'tool' | 'error'; message: string; data?: Record<string, unknown> } {
  if (!data || typeof data !== 'object') {
    return { level: 'info', kind: 'text', message: 'bridge progress update' };
  }

  const payload = data as { isError?: unknown; currentTool?: unknown; output?: unknown; message?: unknown; progress?: unknown };
  if (payload.isError === true) {
    return {
      level: 'error',
      kind: 'error',
      message: firstString(payload.message, payload.output, payload.progress) ?? 'bridge update error',
      data: currentTool ? { currentTool } : undefined,
    };
  }

  if (currentTool) {
    return {
      level: 'info',
      kind: 'tool',
      message: `tool running: ${currentTool}`,
      data: { currentTool },
    };
  }

  const text = firstString(payload.output, payload.message, payload.progress);
  if (text) {
    return { level: 'info', kind: 'text', message: text };
  }

  return { level: 'info', kind: 'text', message: 'bridge progress update' };
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value;
    }
  }

  return undefined;
}

function toOverlayTextRows(text: string, kind: ZergManagementOverlayRow['kind'] = 'text'): ZergManagementOverlayRow[] {
  return text.split('\n').map((line, index) => ({
    id: `${kind}-${index}`,
    kind,
    label: line,
    selectable: false,
  }));
}

function buildTargetDetailLines(
  state: ZergState,
  target: ReturnType<typeof getConfigTargets>[number],
): string[] {
  const agent = state.agents[target.id];
  if (agent) {
    return [
      `id: ${agent.id}`,
      `kind: ${agent.kind}`,
      `status: ${formatConfigStatus(agent.status, agent.runtime?.substate)}`,
      `health: ${agent.runtime?.health ?? 'unknown'}`,
      `last activity: ${agent.runtime?.lastActivity ?? 'none'}`,
      `reason: ${agent.runtime?.substateReason ?? 'none'}`,
    ];
  }

  const team = state.teams[target.id];
  if (team) {
    return [
      `id: ${team.id}`,
      `kind: ${team.kind}`,
      `status: ${formatConfigStatus(team.status, team.runtime?.substate)}`,
      `leader: ${team.leaderAgentId ?? 'none'}`,
      `members: ${(team.memberAgentIds ?? []).join(', ') || 'none'}`,
      `reason: ${team.runtime?.substateReason ?? 'none'}`,
    ];
  }

  const task = state.tasks[target.id];
  if (task) {
    return [
      `id: ${task.id}`,
      `status: ${formatConfigStatus(task.status, task.substate)}`,
      `owner: ${task.ownerAgentId ?? 'none'}`,
      `team: ${task.teamId ?? 'none'}`,
      `updated: ${task.updatedAt}`,
      `reason: ${task.substateReason ?? 'none'}`,
    ];
  }

  return [`id: ${target.id}`, `status: ${target.status}`];
}

function buildPermissionDetailLines(request: ReturnType<typeof getPermissionQueueState>['requests'][number]): string[] {
  return [
    `id: ${request.id}`,
    `kind: ${request.kind}`,
    `status: ${request.status}`,
    `requester: ${request.requester}`,
    `target: ${request.targetId ?? 'none'}`,
    `run: ${request.runId ?? 'none'}`,
    `created: ${request.createdAt}`,
    `resolved: ${request.resolvedAt ?? 'none'}`,
    `reason: ${request.decisionReason ?? 'none'}`,
    `details: ${request.details ?? 'none'}`,
  ];
}

function buildLifecycleRows(
  state: ZergState,
  adapter: ZergSubagentControlAdapter | undefined,
): ZergManagementOverlayRow[] {
  const runs = resolveAvailableRuns(state, adapter);
  const runRows = runs.map((run) => ({
    id: `run-${run.runId}`,
    kind: 'run' as const,
    label: `${run.runId} [${run.status}${run.substate ? `/${run.substate}` : ''}] ${run.agentLabel ?? run.agentId}${run.task ? ` — ${run.task}` : ''}`,
    selectable: true,
    runId: run.runId,
    targetId: run.agentId,
    detailLines: [
      `agent: ${run.agentId}`,
      `label: ${run.agentLabel ?? 'none'}`,
      `task: ${run.task ?? 'none'}`,
      `task-id: ${run.taskId ?? 'none'}`,
      `launch-mode: ${run.launchMode ?? 'none'}`,
      `updated: ${run.updatedAt ?? 'unknown'}`,
      `reason: ${run.substateReason ?? 'none'}`,
    ],
  }));
  const eventRows = state.events
    .filter((event) => event.type === 'agent' || event.type === 'team' || event.type === 'permission' || event.type === 'mode')
    .slice(-8)
    .reverse()
    .map((event, index) => ({
      id: `event-${event.id}-${index}`,
      kind: 'event' as const,
      label: `${event.type}${event.action ? `/${event.action}` : ''}${event.substate ? `/${event.substate}` : ''} ${event.message}`,
      selectable: true,
      detailLines: [
        `created: ${event.createdAt}`,
        `revision: ${event.revision ?? 'none'}`,
        `reason: ${event.substateReason ?? 'none'}`,
      ],
    }));
  return [...runRows, ...eventRows];
}

function buildLogRows(state: ZergState): ZergManagementOverlayRow[] {
  const control = getZergControlState(state);
  const focusId = [control.selectedTargetId, control.activeRunId].find((candidate) => candidate && getZergLogState(state).records.some((record) => record.runId === candidate || record.agentId === candidate || record.taskId === candidate || record.teamId === candidate));
  const records = (focusId
    ? getZergLogState(state).records.filter((record) => record.runId === focusId || record.agentId === focusId || record.taskId === focusId || record.teamId === focusId)
    : getZergLogState(state).records)
    .slice(-20)
    .reverse();

  return records.map((record) => ({
    id: `log-${record.id}`,
    kind: 'log',
    label: `${record.id} [${record.level}/${record.source}/${record.kind}] ${record.message}`,
    selectable: true,
    runId: record.runId,
    targetId: record.agentId ?? record.runId,
    detailLines: [
      `created: ${record.createdAt}`,
      `run: ${record.runId ?? 'none'}`,
      `agent: ${record.agentId ?? 'none'}`,
      `task: ${record.taskId ?? 'none'}`,
      `team: ${record.teamId ?? 'none'}`,
      `data: ${record.data ? JSON.stringify(record.data) : 'none'}`,
    ],
  }));
}

function buildInterventionRows(state: ZergState, draft: string): ZergManagementOverlayRow[] {
  const rows: ZergManagementOverlayRow[] = [];
  const activeIntervention = state.mode.activeIntervention;

  if (activeIntervention) {
    rows.push({
      id: 'intervention-current',
      kind: 'intervention',
      label: `current ${activeIntervention.kind} ${activeIntervention.targetId}: ${activeIntervention.message}`,
      selectable: true,
      targetId: activeIntervention.targetId,
      detailLines: [
        `created: ${activeIntervention.createdAt}`,
        `target-label: ${activeIntervention.targetLabel ?? 'none'}`,
        `team: ${activeIntervention.teamId ?? 'none'}`,
      ],
    });
  }

  const targets = getConfigTargets(state)
    .filter((target) => state.agents[target.id] || state.teams[target.id])
    .slice(0, 20);

  if (targets.length === 0) {
    rows.push({
      id: 'intervention-empty',
      kind: 'intervention',
      label: 'select a target in the targets tab, then use enter here to record a canned intervention',
      selectable: false,
      detailLines: [`draft: ${draft}`],
    });
    return rows;
  }

  rows.push(...targets.map((target) => ({
    id: `intervention-${target.id}`,
    kind: 'intervention' as const,
    label: `${target.kind === 'team' ? 'leader' : target.kind === 'subagent' ? 'subagent' : 'agent'} ${target.id} ${target.label}`,
    selectable: true,
    targetId: target.id,
    detailLines: [
      `draft: ${draft}`,
      'enter records intervention through existing command semantics',
    ],
  })));

  return rows;
}

function buildConfigRows(
  state: ZergState,
  adapter: ZergSubagentControlAdapter | undefined,
): ZergManagementOverlayRow[] {
  const control = getZergControlState(state);
  const permissionQueue = getPermissionQueueState(state);
  const latestPermission = getPendingPermissionRequests(state).at(-1);
  const logState = getZergLogState(state);
  const latestLogWarning = logState.records.filter((record) => record.level === 'warn' || record.level === 'error').at(-1);
  const activeRun = control.activeRunId ? state.agents[control.activeRunId] : undefined;
  return [
    {
      id: 'config-controller',
      kind: 'config',
      label: `controller: ${control.controller}`,
      selectable: false,
      detailLines: ['command fallback: /zerg control controller pi|zerg|operator'],
    },
    {
      id: 'config-mode',
      kind: 'config',
      label: `automation: ${state.mode.automation}`,
      selectable: false,
      detailLines: ['keys: m manual | a assisted | u automatic'],
    },
    {
      id: 'config-readonly',
      kind: 'config',
      label: `read-only: ${state.mode.readOnly ? 'enabled' : 'disabled'}`,
      selectable: false,
      detailLines: ['key: r toggles read-only through existing audited state path'],
    },
    {
      id: 'config-active-run',
      kind: 'config',
      label: `active run: ${control.activeRunId ?? 'none'}${activeRun?.runtime?.substate ? ` [${activeRun.status}/${activeRun.runtime.substate}]` : ''}`,
      selectable: false,
      detailLines: [`reason: ${activeRun?.runtime?.substateReason ?? 'none'}`],
    },
    {
      id: 'config-permissions',
      kind: 'config',
      label: `permissions: ${permissionQueue.pendingCount} pending${latestPermission ? ` latest:${latestPermission.id} ${latestPermission.kind} ${latestPermission.summary}` : ''}`,
      selectable: false,
      detailLines: ['command fallback: /zerg permission status'],
    },
    {
      id: 'config-logs',
      kind: 'config',
      label: `logs: ${logState.records.length}/${logState.maxRecords}${latestLogWarning ? ` latest:${latestLogWarning.id} ${latestLogWarning.level} ${latestLogWarning.message}` : ''}`,
      selectable: false,
      detailLines: ['command fallback: /zerg logs status'],
    },
    {
      id: 'config-adapter',
      kind: 'config',
      label: `adapter: ${adapter?.kind ?? 'unavailable'}`,
      selectable: false,
      detailLines: ['commands /zerg run and /zerg interrupt share the same adapter boundary'],
    },
  ];
}

function buildZergConfigOverlayRows(
  state: ZergState,
  activeTab: ZergConfigOverlayTab,
  adapter: ZergSubagentControlAdapter | undefined,
  interventionDraft: string,
): ZergManagementOverlayRow[] {
  if (activeTab === 'monitor') {
    return toOverlayTextRows(renderMonitor(state, { width: PI_COMMAND_OUTPUT_WIDTH }), 'text');
  }
  if (activeTab === 'control') {
    return toOverlayTextRows(renderZergControlStatus(state, PI_COMMAND_OUTPUT_WIDTH), 'config');
  }
  if (activeTab === 'targets') {
    return getConfigTargets(state).map((target) => ({
      id: `target-${target.id}`,
      kind: 'target',
      label: `${target.kind} ${target.id} ${target.label} [${target.status}]`,
      selectable: true,
      targetId: target.id,
      runId: state.agents[target.id] ? target.id : undefined,
      detailLines: buildTargetDetailLines(state, target),
    }));
  }
  if (activeTab === 'permissions') {
    return getPermissionQueueState(state).requests.slice().reverse().map((request) => ({
      id: `permission-${request.id}`,
      kind: 'permission',
      label: `${request.id} [${request.status}/${request.kind}] ${request.summary}`,
      selectable: true,
      requestId: request.id,
      runId: request.runId,
      targetId: request.targetId,
      detailLines: buildPermissionDetailLines(request),
    }));
  }
  if (activeTab === 'lifecycle') {
    return buildLifecycleRows(state, adapter);
  }
  if (activeTab === 'logs') {
    return buildLogRows(state);
  }
  if (activeTab === 'intervene') {
    return buildInterventionRows(state, interventionDraft);
  }
  return buildConfigRows(state, adapter);
}

function renderZergConfigOverlay(
  state: ZergState,
  options: {
    width: number;
    height?: number;
    activeTab: ZergConfigOverlayTab;
    selectedIndex: number;
    scrollOffset?: number;
    detailRowId?: string;
    statusMessage?: string;
    confirmMessage?: string;
    interventionDraft?: string;
    adapter?: ZergSubagentControlAdapter;
  },
): string {
  const rows = buildZergConfigOverlayRows(state, options.activeTab, options.adapter, options.interventionDraft ?? DEFAULT_OVERLAY_INTERVENTION_DRAFT);
  return renderZergManagementOverlay(state, {
    width: options.width,
    height: options.height,
    activeTab: options.activeTab,
    tabs: CONFIG_OVERLAY_TABS,
    rows,
    selectedIndex: options.selectedIndex,
    scrollOffset: options.scrollOffset,
    detailRowId: options.detailRowId,
    statusMessage: options.statusMessage,
    confirmMessage: options.confirmMessage,
    adapterKind: options.adapter?.kind ?? 'unavailable',
  });
}

function createManagementOverlayActions(stateOrReader: ZergStateSource, runtimeOptions: RuntimeCommandOptions) {
  const mutateControl = (payload: string) => dispatchControlCommand(stateOrReader, payload, runtimeOptions).output;
  const mutatePermission = (payload: string) => dispatchPermissionCommand(stateOrReader, payload, runtimeOptions).output;

  return {
    now: () => (runtimeOptions.now ?? (() => new Date()))(),
    toggleReadOnly: () => mutateControl('readonly toggle'),
    setAutomation: (mode: AutomationMode) => mutateControl(`mode ${mode}`),
    setController: (controller: ZergControlController) => mutateControl(`controller ${controller}`),
    approvePermission: (requestId: string) => mutatePermission(`approve ${requestId}`),
    denyPermission: (requestId: string) => mutatePermission(`deny ${requestId}`),
    selectTarget: (target: { id: string; kind: ZergManagementTargetKind }) => {
      const container = getWritableStateContainer(stateOrReader);
      if (!container) {
        return RUNTIME_WRITABLE_STATE_ERROR;
      }
      updateZergControlState(container, { selectedTargetId: target.id, selectedTargetKind: target.kind }, `selected target ${target.kind} ${target.id}`, runtimeOptions);
      return `selected ${target.kind} ${target.id}`;
    },
    interruptSelected: (target: { id: string; kind: ZergManagementTargetKind } | undefined) => {
      const snapshot = resolveZergStateSnapshot(stateOrReader);
      const control = getZergControlState(snapshot);
      const runId = control.selectedRunId ?? (target?.kind === 'agent' && target.id.startsWith(DEFAULT_RUN_ID_PREFIX)
        ? target.id
        : control.activeRunId);
      if (!runId) {
        return 'no active run selected for interrupt';
      }
      return dispatchInterruptCommand(stateOrReader, runId, runtimeOptions).output;
    },
    sendOperatorMessage: (target: { id: string; kind: ZergManagementTargetKind }, body: string): { status: ZergOperatorMessageDeliveryStatus; statusDetail: string; routedTargetId?: string } => {
      const snapshot = resolveZergStateSnapshot(stateOrReader);
      if (target.kind === 'task') {
        return { status: 'transport-unavailable', statusDetail: 'Tasks have no verified live message transport; operator message retained locally.' };
      }
      const routedTargetId = target.kind === 'team' ? snapshot.teams[target.id]?.leaderAgentId : target.id;
      if (!routedTargetId) {
        return { status: 'transport-unavailable', statusDetail: `${target.kind} ${target.id} is unavailable; operator message retained locally.` };
      }
      const control = getZergControlState(snapshot);
      const activeRunId = control.selectedRunId ?? control.activeRunId;
      if (runtimeOptions.subagentAdapter?.sendMessage && activeRunId) {
        void Promise.resolve(runtimeOptions.subagentAdapter.sendMessage(routedTargetId, body, activeRunId)).catch(() => undefined);
        return { status: 'accepted', statusDetail: `delivery requested for ${routedTargetId}; check logs for delivered/failed status.`, routedTargetId };
      }
      const agent = snapshot.agents[routedTargetId];
      if (!agent && target.kind !== 'team') {
        return { status: 'transport-unavailable', statusDetail: `Agent ${routedTargetId} is unavailable; operator message retained locally.` };
      }
      const result = target.kind === 'team'
        ? dispatchInterventionCommand(stateOrReader, `leader ${target.id} ${body}`, runtimeOptions)
        : dispatchInterventionCommand(stateOrReader, `${agent?.kind === 'subagent' ? 'subagent' : 'agent'} ${routedTargetId} ${body}`, runtimeOptions);
      return {
        status: result.ok ? 'intervention-recorded' : 'transport-unavailable',
        statusDetail: result.ok ? `${result.output}; live transport unavailable, intervention recorded.` : result.output,
        routedTargetId,
      };
    },
  };
}

export function createPiZergCommandHandler(
  stateOrReader: ZergStateSource,
  options: ZergCommandHandlerOptions = {},
): ZergPiCommandHandler {
  const scaffoldHandler = createZergCommandHandler(stateOrReader, options);
  const runtimeOptions = options as RuntimeCommandOptions;

  return async (input: string, context: StructuralPiCommandContext): Promise<void> => {
    const normalized = normalizeZergCommandInput(input);
    const result = await scaffoldHandler(input);
    const output = typeof result === 'string' ? result : result.output;

    if ((normalized.topic === 'monitor' || normalized.topic === 'config') && context.ui?.custom) {
      if (normalized.topic === 'config') {
        try {
          await openZergManagementOverlay(context, {
            getSnapshot: () => resolveZergStateSnapshot(stateOrReader),
            subscribe: (listener) => subscribeToZergState(stateOrReader, listener),
            adapterKind: runtimeOptions.subagentAdapter?.kind ?? 'unavailable',
            actions: createManagementOverlayActions(stateOrReader, runtimeOptions),
          });
          return;
        } catch {
          // Fall back to the M8 text management overlay path below when the M9 component path is unavailable.
        }
      }

      const overlayTopic = normalized.topic as 'monitor' | 'config';
      let activeTab: ZergConfigOverlayTab = overlayTopic === 'monitor' ? 'monitor' : 'config';
      const selectedIndexByTab: Record<ZergConfigOverlayTab, number> = {
        monitor: 0,
        control: 0,
        targets: 0,
        permissions: 0,
        lifecycle: 0,
        logs: 0,
        intervene: 0,
        config: 0,
      };
      const scrollOffsetByTab: Record<ZergConfigOverlayTab, number> = {
        monitor: 0,
        control: 0,
        targets: 0,
        permissions: 0,
        lifecycle: 0,
        logs: 0,
        intervene: 0,
        config: 0,
      };
      const detailRowIdByTab: Partial<Record<ZergConfigOverlayTab, string | undefined>> = {};
      let confirmation: OverlayConfirmationState | undefined;
      let statusMessage: string | undefined;
      let interventionDraft = DEFAULT_OVERLAY_INTERVENTION_DRAFT;
      const clearConfirmation = () => {
        confirmation = undefined;
      };
      const getSnapshot = () => resolveZergStateSnapshot(stateOrReader);
      const getRows = (tab: ZergConfigOverlayTab = activeTab) => buildZergConfigOverlayRows(getSnapshot(), tab, runtimeOptions.subagentAdapter, interventionDraft);
      const clampOverlayState = (tab: ZergConfigOverlayTab = activeTab) => {
        const rows = getRows(tab);
        const currentIndex = selectedIndexByTab[tab] ?? 0;
        const nextIndex = rows.length === 0 ? 0 : Math.max(0, Math.min(currentIndex, rows.length - 1));
        selectedIndexByTab[tab] = nextIndex;
        const maxScrollOffset = Math.max(0, rows.length - OVERLAY_VISIBLE_ROWS);
        let nextScrollOffset = Math.max(0, Math.min(scrollOffsetByTab[tab] ?? 0, maxScrollOffset));
        if (rows.length > 0) {
          if (nextIndex < nextScrollOffset) {
            nextScrollOffset = nextIndex;
          } else if (nextIndex >= nextScrollOffset + OVERLAY_VISIBLE_ROWS) {
            nextScrollOffset = Math.max(0, nextIndex - OVERLAY_VISIBLE_ROWS + 1);
          }
        }
        scrollOffsetByTab[tab] = nextScrollOffset;
        if (detailRowIdByTab[tab] && !rows.some((row) => row.id === detailRowIdByTab[tab])) {
          detailRowIdByTab[tab] = undefined;
        }
        const currentConfirmation = confirmation;
        if (currentConfirmation && !rows.some((row) => row.id === currentConfirmation.rowId && row.requestId === currentConfirmation.requestId)) {
          confirmation = undefined;
        }
        return rows;
      };
      const getSelectedRow = (tab: ZergConfigOverlayTab = activeTab) => {
        const rows = clampOverlayState(tab);
        return rows[selectedIndexByTab[tab]];
      };
      const renderOverlayOutput = (width?: number, height?: number) => {
        const outputWidth = typeof width === 'number' ? width : PI_COMMAND_OUTPUT_WIDTH;
        if (!result.ok) {
          return output;
        }

        const snapshot = getSnapshot();
        if (overlayTopic === 'monitor') {
          return renderMonitor(snapshot, { width: outputWidth });
        }

        clampOverlayState(activeTab);
        return renderZergConfigOverlay(snapshot, {
          width: outputWidth,
          height,
          activeTab,
          selectedIndex: selectedIndexByTab[activeTab],
          scrollOffset: scrollOffsetByTab[activeTab],
          detailRowId: detailRowIdByTab[activeTab],
          statusMessage,
          confirmMessage: confirmation ? `press ${confirmation.action === 'approve' ? 'p' : 'd'} again for ${confirmation.requestId}` : undefined,
          interventionDraft,
          adapter: runtimeOptions.subagentAdapter,
        });
      };

      try {
        context.ui.custom(
          (tui?: StructuralPiTuiHandle, _theme?: unknown, _keybindings?: unknown, done?: () => void) => {
            let closed = false;
            let invalidated = false;
            const requestRender = () => {
              if (closed) {
                return;
              }
              invalidated = true;
              tui?.requestRender?.();
            };
            const unsubscribe = subscribeToZergState(stateOrReader, requestRender);
            const close = () => {
              if (closed) {
                return;
              }
              closed = true;
              unsubscribe();
              done?.();
            };
            const switchTab = (direction: 1 | -1) => {
              clearConfirmation();
              const currentIndex = CONFIG_OVERLAY_TABS.indexOf(activeTab);
              activeTab = CONFIG_OVERLAY_TABS[(currentIndex + direction + CONFIG_OVERLAY_TABS.length) % CONFIG_OVERLAY_TABS.length]!;
              clampOverlayState(activeTab);
              requestRender();
            };
            const moveSelection = (direction: 1 | -1) => {
              clearConfirmation();
              const rows = clampOverlayState(activeTab);
              if (rows.length === 0) {
                statusMessage = `${activeTab}: none`;
                requestRender();
                return;
              }
              selectedIndexByTab[activeTab] = Math.max(0, Math.min(selectedIndexByTab[activeTab] + direction, rows.length - 1));
              clampOverlayState(activeTab);
              requestRender();
            };
            const recordIntervention = (row: ZergManagementOverlayRow | undefined) => {
              if (!row?.targetId) {
                statusMessage = 'select an intervention target first';
                requestRender();
                return;
              }
              const snapshot = getSnapshot();
              const payload = snapshot.teams[row.targetId]
                ? `leader ${row.targetId} ${interventionDraft}`
                : `${snapshot.agents[row.targetId]?.kind === 'subagent' ? 'subagent' : 'agent'} ${row.targetId} ${interventionDraft}`;
              const interventionResult = dispatchInterventionCommand(stateOrReader, payload, runtimeOptions);
              statusMessage = interventionResult.output;
              requestRender();
            };
            const toggleDetail = () => {
              clearConfirmation();
              const row = getSelectedRow();
              if (!row) {
                statusMessage = `${activeTab}: none`;
                requestRender();
                return;
              }
              detailRowIdByTab[activeTab] = detailRowIdByTab[activeTab] === row.id ? undefined : row.id;
              if (activeTab === 'targets' && row.targetId) {
                const container = getWritableStateContainer(stateOrReader);
                if (!container) {
                  statusMessage = RUNTIME_WRITABLE_STATE_ERROR;
                } else {
                  updateZergControlState(container, { selectedTargetId: row.targetId }, `selected target ${row.targetId}`, runtimeOptions);
                  statusMessage = `selected target ${row.targetId}`;
                }
              } else if (activeTab === 'intervene') {
                recordIntervention(row);
              }
              requestRender();
            };
            const applyControlMutation = (payload: string) => {
              clearConfirmation();
              const controlResult = dispatchControlCommand(stateOrReader, payload, runtimeOptions);
              statusMessage = controlResult.output;
              requestRender();
            };
            const applyPermissionDecision = (action: 'approve' | 'deny') => {
              if (activeTab !== 'permissions') {
                statusMessage = 'switch to the permissions tab first';
                requestRender();
                return;
              }
              const row = getSelectedRow();
              if (!row?.requestId) {
                statusMessage = 'select a permission request first';
                requestRender();
                return;
              }
              const request = getPermissionQueueState(getSnapshot()).requests.find((candidate) => candidate.id === row.requestId);
              if (!request || request.status !== 'pending') {
                clearConfirmation();
                statusMessage = `permission request ${row.requestId} is not pending`;
                requestRender();
                return;
              }
              if (confirmation?.action === action && confirmation.rowId === row.id && confirmation.requestId === row.requestId) {
                clearConfirmation();
                const permissionResult = dispatchPermissionCommand(stateOrReader, `${action} ${row.requestId}`, runtimeOptions);
                statusMessage = permissionResult.output;
                requestRender();
                return;
              }
              confirmation = { action, rowId: row.id, requestId: row.requestId };
              statusMessage = `press ${action === 'approve' ? 'p' : 'd'} again to ${action} ${row.requestId}`;
              requestRender();
            };
            const applyInterrupt = () => {
              clearConfirmation();
              const row = getSelectedRow();
              const snapshot = getSnapshot();
              const runId = row?.runId
                ?? (row?.targetId && snapshot.agents[row.targetId] ? row.targetId : undefined)
                ?? getZergControlState(snapshot).activeRunId;
              if (!runId) {
                statusMessage = 'no active run selected for interrupt';
                requestRender();
                return;
              }
              const interruptResult = dispatchInterruptCommand(stateOrReader, runId, runtimeOptions);
              statusMessage = interruptResult.output;
              requestRender();
            };
            const deferFilter = () => {
              clearConfirmation();
              statusMessage = OVERLAY_FILTER_DEFERRED_MESSAGE;
              requestRender();
            };

            return {
              render: (width?: number) => {
                invalidated = false;
                return renderOverlayOutput(width).split('\n');
              },
              invalidate: () => {
                invalidated = true;
              },
              handleInput: (data: string) => {
                if (data === 'q' || data === 'Q' || data === '\u001b') {
                  close();
                } else if (overlayTopic === 'config' && (data === '\t' || data === 'tab' || data === '\u001b[C' || data === 'right')) {
                  switchTab(1);
                } else if (overlayTopic === 'config' && (data === '\u001b[Z' || data === 'shift-tab' || data === '\u001b[D' || data === 'left')) {
                  switchTab(-1);
                } else if (overlayTopic === 'config' && (data === '\u001b[A' || data === 'up')) {
                  moveSelection(-1);
                } else if (overlayTopic === 'config' && (data === '\u001b[B' || data === 'down')) {
                  moveSelection(1);
                } else if (overlayTopic === 'config' && (data === '\r' || data === '\n' || data === 'enter')) {
                  toggleDetail();
                } else if (overlayTopic === 'config' && (data === 'r' || data === 'R')) {
                  applyControlMutation('readonly toggle');
                } else if (overlayTopic === 'config' && (data === 'm' || data === 'M')) {
                  applyControlMutation('mode manual');
                } else if (overlayTopic === 'config' && (data === 'a' || data === 'A')) {
                  applyControlMutation('mode assisted');
                } else if (overlayTopic === 'config' && (data === 'u' || data === 'U')) {
                  applyControlMutation('mode automatic');
                } else if (overlayTopic === 'config' && (data === 'p' || data === 'P')) {
                  applyPermissionDecision('approve');
                } else if (overlayTopic === 'config' && (data === 'd' || data === 'D')) {
                  applyPermissionDecision('deny');
                } else if (overlayTopic === 'config' && (data === 'i' || data === 'I')) {
                  applyInterrupt();
                } else if (overlayTopic === 'config' && (data === '/' || data === 'f' || data === 'F')) {
                  deferFilter();
                } else if (invalidated) {
                  tui?.requestRender?.();
                }
              },
              dispose: close,
            };
          },
          {
            overlay: true,
            overlayOptions: {
              title: overlayTopic === 'monitor' ? 'zerg monitor' : 'zerg config',
            },
          },
        );
        return;
      } catch {
        try {
          await Promise.resolve(context.ui.custom(
            (_tui?: StructuralPiTuiHandle, _theme?: unknown, _keybindings?: unknown, done?: (result?: void) => void) => ({
              render: (width?: number) => renderOverlayOutput(width).split('\n'),
              invalidate: () => undefined,
              handleInput: (data: string) => {
                if (data === 'q' || data === 'Q' || data === '\u001b') {
                  done?.(undefined);
                }
              },
            }),
            {
              overlay: true,
              overlayOptions: {
                title: overlayTopic === 'monitor' ? 'zerg monitor' : 'zerg config',
              },
            },
          ));
          return;
        } catch {
          // Fall back to textual output when custom overlay hooks are unavailable.
        }
      }
    }

    context.ui?.notify?.(output, 'info');
  };
}

function resolveZergStateSnapshot(stateOrReader: ZergStateSource): ZergState {
  if (isZergStateContainer(stateOrReader)) {
    return stateOrReader.snapshot();
  }

  const state = typeof stateOrReader === 'function' ? stateOrReader() : stateOrReader;
  return snapshotZergState(state);
}

function registerCommand(context: StructuralPiExtensionContext, command: StructuralPiCommand): RegisteredCommandDisposer | undefined {
  const registrar = selectCommandRegistrar(context);

  if (!registrar) {
    return undefined;
  }

  const registeredNames = registeredCommandsByTarget.get(registrar.target) ?? new Set<ZergCommandName>();

  if (registeredNames.has(command.name)) {
    return undefined;
  }

  const options: StructuralPiCommandOptions = {
    description: command.description,
    handler: command.handler,
  };

  const registration = registrar.registerCommand(command.name, options);
  registeredNames.add(command.name);
  registeredCommandsByTarget.set(registrar.target, registeredNames);

  if (!isDisposableRegistration(registration)) {
    return undefined;
  }

  return {
    target: registrar.target,
    name: command.name,
    dispose: registration.dispose.bind(registration),
  };
}

function clearRegisteredCommand(target: object, name: ZergCommandName): void {
  const registeredNames = registeredCommandsByTarget.get(target);

  if (!registeredNames) {
    return;
  }

  registeredNames.delete(name);

  if (registeredNames.size === 0) {
    registeredCommandsByTarget.delete(target);
  }
}

function normalizeDisposableRegistration(value: unknown): DisposableRegistration | undefined {
  if (typeof value === 'function') {
    return { dispose: value as () => void };
  }
  if (isDisposableRegistration(value)) {
    return { dispose: value.dispose.bind(value) };
  }
  return undefined;
}

function isDisposableRegistration(value: unknown): value is DisposableRegistration {
  return typeof value === 'object' && value !== null && typeof (value as { dispose?: unknown }).dispose === 'function';
}

function selectCommandRegistrar(context: StructuralPiExtensionContext): SelectedCommandRegistrar | undefined {
  if (context.registerCommand) {
    return { target: context, registerCommand: context.registerCommand.bind(context) };
  }

  if (context.commands?.registerCommand) {
    return { target: context.commands, registerCommand: context.commands.registerCommand.bind(context.commands) };
  }

  if (context.commands?.register) {
    return { target: context.commands, registerCommand: context.commands.register.bind(context.commands) };
  }

  if (context.commandRegistrar?.registerCommand) {
    return {
      target: context.commandRegistrar,
      registerCommand: context.commandRegistrar.registerCommand.bind(context.commandRegistrar),
    };
  }

  return undefined;
}

export const __zergNativeTestInternals = {
  callLarraMcpTool,
  createPiNativeCustomTools,
  createLarraMcpGatewayTool,
  createPiNativeResourceLoader,
  extractPiNativePromptResponse,
  resolvePiNativeTools,
};

export default registerZergSwarmExtension;
