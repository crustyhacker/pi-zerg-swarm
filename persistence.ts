import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';

import {
  appendZergLogRecord,
  applyRuntimeTransition,
  createZergState,
  getSubagentRunSnapshots,
  getZergLogState,
} from './state.js';
import {
  ZERG_EXTENSION_VERSION,
  ZERG_STATE_SCHEMA_VERSION,
  type AgentIdentity,
  type AgentStatus,
  type TaskRecord,
  type ZergExtensionFields,
  type ZergLifecycleSubstate,
  type ZergPersistenceInfo,
  type ZergPersistenceOptions,
  type ZergRunRecoveryInfo,
  type ZergState,
  type ZergStateContainer,
} from './types.js';

const DEFAULT_PERSISTENCE_RELATIVE_PATH = '.pi/zerg-swarm/v1/state.json';
const ZERG_CONTROL_EXTENSION_KEY = 'zergControl';
const ZERG_PERSISTENCE_EXTENSION_KEY = 'zergPersistence';

interface ZergPersistenceEnvelope {
  version: 1;
  packageVersion: string;
  stateSchemaVersion: string;
  writerSessionId: string;
  savedAt: string;
  state: ZergState;
}

export interface ZergPersistenceManager {
  readonly info: ZergPersistenceInfo;
  hydrate(container: ZergStateContainer, now?: () => Date): ZergPersistenceInfo;
  save(state: ZergState, now?: () => Date): ZergPersistenceInfo;
}

export function createZergPersistenceManager(options: ZergPersistenceOptions | undefined): ZergPersistenceManager | undefined {
  if (!options?.enabled && !options?.rootDir && !options?.snapshotFile) {
    return undefined;
  }
  if (options.enabled === false) {
    return undefined;
  }
  const snapshotFile = options.snapshotFile
    ? resolvePath(options.snapshotFile)
    : resolvePath(options.rootDir ?? process.cwd(), DEFAULT_PERSISTENCE_RELATIVE_PATH);
  const writerSessionId = `zerg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  let info: ZergPersistenceInfo = { enabled: true, snapshotFile, writerSessionId };

  return {
    get info() {
      return { ...info, recoveredRunIds: info.recoveredRunIds ? [...info.recoveredRunIds] : undefined };
    },
    hydrate(container, now) {
      const hydrated = hydrateZergState(container.read(), snapshotFile, writerSessionId, now);
      info = hydrated.info;
      if (hydrated.state) {
        container.replace(hydrated.state);
      }
      return this.info;
    },
    save(state, now) {
      info = saveZergStateSnapshot(state, snapshotFile, writerSessionId, info, now);
      return this.info;
    },
  };
}

function hydrateZergState(
  current: ZergState,
  snapshotFile: string,
  writerSessionId: string,
  now: (() => Date) | undefined,
): { state?: ZergState; info: ZergPersistenceInfo } {
  const baseInfo: ZergPersistenceInfo = { enabled: true, snapshotFile, writerSessionId };
  if (!existsSync(snapshotFile)) {
    return { info: baseInfo };
  }

  try {
    const envelope = JSON.parse(readFileSync(snapshotFile, 'utf8')) as Partial<ZergPersistenceEnvelope>;
    if (envelope.version !== 1 || !isPlainRecord(envelope.state)) {
      return { info: { ...baseInfo, lastLoadError: 'Unsupported zerg persistence snapshot format.' } };
    }
    const loaded = createZergState(envelope.state as Partial<ZergState>);
    const recovered = recoverZergStateAfterRestart(loaded, {
      now,
      previousWriterSessionId: typeof envelope.writerSessionId === 'string' ? envelope.writerSessionId : undefined,
    });
    const info: ZergPersistenceInfo = {
      ...baseInfo,
      lastLoadedAt: new Date().toISOString(),
      recoveredRunIds: recovered.recoveredRunIds,
    };
    return { state: writePersistenceInfo(recovered.state, info), info };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { info: { ...baseInfo, lastLoadError: message } };
  }
}

function saveZergStateSnapshot(
  state: ZergState,
  snapshotFile: string,
  writerSessionId: string,
  previousInfo: ZergPersistenceInfo,
  now: (() => Date) | undefined,
): ZergPersistenceInfo {
  const savedAt = (now ?? (() => new Date()))().toISOString();
  const info: ZergPersistenceInfo = { ...previousInfo, enabled: true, snapshotFile, writerSessionId, lastSavedAt: savedAt };
  const stateToSave = writePersistenceInfo(state, info);
  const envelope: ZergPersistenceEnvelope = {
    version: 1,
    packageVersion: ZERG_EXTENSION_VERSION,
    stateSchemaVersion: ZERG_STATE_SCHEMA_VERSION,
    writerSessionId,
    savedAt,
    state: sanitizeJsonValue(stateToSave) as ZergState,
  };
  mkdirSync(dirname(snapshotFile), { recursive: true });
  const tempFile = `${snapshotFile}.${process.pid}.${Date.now().toString(36)}.tmp`;
  writeFileSync(tempFile, `${JSON.stringify(envelope, null, 2)}\n`, 'utf8');
  renameSync(tempFile, snapshotFile);
  return info;
}

export function recoverZergStateAfterRestart(
  state: ZergState,
  options: { now?: () => Date; previousWriterSessionId?: string } = {},
): { state: ZergState; recoveredRunIds: string[] } {
  const recoveredAt = (options.now ?? (() => new Date()))().toISOString();
  let next = state;
  const recoveredRunIds: string[] = [];

  for (const run of getSubagentRunSnapshots(state)) {
    if (isTerminalRun(run.status, run.substate)) continue;
    const previousStatus = run.status;
    const previousSubstate = run.substate;
    const recovery: ZergRunRecoveryInfo = {
      recoveredAt,
      reason: 'process-restart',
      previousStatus,
      previousSubstate,
      previousWriterSessionId: options.previousWriterSessionId,
    };
    next = applyRuntimeTransition(next, {
      entity: 'agent',
      action: 'fail',
      id: run.runId,
      label: run.agentLabel ?? run.agentId,
      kind: 'subagent',
      status: 'needs-attention',
      health: 'degraded',
      activity: 'recovered after Pi restart; live session unavailable',
      substate: 'failed',
      substateReason: 'recovered after Pi restart; live session unavailable',
      metadata: { ...run.metadata, recovery },
    }, { now: () => new Date(recoveredAt) });
    if (run.taskId && next.tasks[run.taskId]) {
      const task = next.tasks[run.taskId]!;
      next = {
        ...next,
        tasks: {
          ...next.tasks,
          [run.taskId]: {
            ...task,
            status: 'needs-attention',
            substate: 'failed',
            substateReason: 'recovered after Pi restart; live session unavailable',
            substateUpdatedAt: recoveredAt,
            updatedAt: recoveredAt,
            metadata: { ...task.metadata, recovery } as ZergExtensionFields,
          },
        },
      };
    }
    next = appendZergLogRecord(next, {
      source: 'adapter',
      level: 'warn',
      kind: 'text',
      runId: run.runId,
      agentId: run.agentId,
      taskId: run.taskId,
      message: `recovered ${run.runId} after Pi restart; live session unavailable`,
      data: { recovery },
      createdAt: recoveredAt,
    });
    recoveredRunIds.push(run.runId);
  }

  if (recoveredRunIds.length > 0) {
    next = clearRecoveredActiveRun(next, recoveredRunIds);
  }
  return { state: next, recoveredRunIds };
}

function clearRecoveredActiveRun(state: ZergState, recoveredRunIds: readonly string[]): ZergState {
  const control = state.extensions[ZERG_CONTROL_EXTENSION_KEY];
  if (!isPlainRecord(control) || typeof control.activeRunId !== 'string' || !recoveredRunIds.includes(control.activeRunId)) {
    return state;
  }
  return {
    ...state,
    extensions: {
      ...state.extensions,
      [ZERG_CONTROL_EXTENSION_KEY]: { ...control, activeRunId: undefined },
    },
  };
}

function writePersistenceInfo(state: ZergState, info: ZergPersistenceInfo): ZergState {
  return {
    ...state,
    extensions: {
      ...state.extensions,
      [ZERG_PERSISTENCE_EXTENSION_KEY]: { ...info, recoveredRunIds: info.recoveredRunIds ? [...info.recoveredRunIds] : undefined },
      zergLogs: getZergLogState(state),
    },
  };
}

function isTerminalRun(status: AgentStatus, substate: ZergLifecycleSubstate | undefined): boolean {
  return status === 'done' || status === 'failed' || status === 'cancelled' || substate === 'completed' || substate === 'failed' || substate === 'cancelled';
}

function sanitizeJsonValue(value: unknown, seen = new Set<object>()): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') return undefined;
  if (Array.isArray(value)) return value.map((entry) => sanitizeJsonValue(entry, seen));
  if (typeof value !== 'object') return undefined;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const clean = sanitizeJsonValue(entry, seen);
    if (clean !== undefined) output[key] = clean;
  }
  seen.delete(value);
  return output;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
