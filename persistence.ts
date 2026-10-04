import { closeSync, constants, fstatSync, mkdirSync, openSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { recoverWorkflowState } from './workflow-runtime.js';
import { WORKFLOW_EXTENSION_KEY } from './workflow-model.js';
import { recoverSessionMessages } from './session-messages.js';
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
const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const SNAPSHOT_SIZE_ERROR = 'Zerg persistence snapshot exceeds the 64 MiB UTF-8 byte limit.';
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
  try {
    // Follow legitimate final symlinks, including normal missing/dangling behavior.
    // This is file admission, not ancestor confinement or a filesystem sandbox.
    const expected = statSync(snapshotFile, { throwIfNoEntry: false });
    if (!expected) return { info: baseInfo };
    if (!expected.isFile()) throw new Error('Zerg persistence snapshot must be a regular file.');
    if (expected.size > MAX_SNAPSHOT_BYTES) throw new Error(SNAPSHOT_SIZE_ERROR);
    // Nonblocking admission prevents a file/target swapped for a FIFO from hanging open.
    const descriptor = openSync(snapshotFile, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    let envelope: Partial<ZergPersistenceEnvelope>;
    try {
      const opened = fstatSync(descriptor);
      if (!opened.isFile() || opened.dev !== expected.dev || opened.ino !== expected.ino) {
        throw new Error('Zerg persistence snapshot changed before reading.');
      }
      if (opened.size > MAX_SNAPSHOT_BYTES) throw new Error(SNAPSHOT_SIZE_ERROR);
      // Size admission alone cannot bound a file that grows during reading.
      // Decode incrementally with one fixed buffer, reading at most limit + 1.
      const chunk = Buffer.allocUnsafe(64 * 1024);
      const decoder = new StringDecoder('utf8');
      const text: string[] = [];
      let bytes = 0;
      for (;;) {
        const count = readSync(descriptor, chunk, 0, Math.min(chunk.length, MAX_SNAPSHOT_BYTES - bytes + 1), null);
        if (count === 0) break;
        bytes += count;
        if (bytes > MAX_SNAPSHOT_BYTES) throw new Error(SNAPSHOT_SIZE_ERROR);
        text.push(decoder.write(chunk.subarray(0, count)));
      }
      const finished = fstatSync(descriptor);
      if (!finished.isFile() || finished.dev !== opened.dev || finished.ino !== opened.ino) {
        throw new Error('Zerg persistence snapshot changed while reading.');
      }
      if (finished.size > MAX_SNAPSHOT_BYTES) throw new Error(SNAPSHOT_SIZE_ERROR);
      text.push(decoder.end());
      envelope = JSON.parse(text.join('')) as Partial<ZergPersistenceEnvelope>;
    } finally {
      closeSync(descriptor);
    }
    if (envelope.version !== 1 || !isPlainRecord(envelope.state)) {
      return { info: { ...baseInfo, lastLoadError: 'Unsupported zerg persistence snapshot format.' } };
    }
    const loaded = createZergState(envelope.state as Partial<ZergState>);
    // Recovery may retain saved readOnly, but must never revoke current authority.
    if (current.mode.readOnly === true) loaded.mode.readOnly = true;
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
  const serialized = `${JSON.stringify(envelope, null, 2)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > MAX_SNAPSHOT_BYTES) throw new Error(SNAPSHOT_SIZE_ERROR);
  mkdirSync(dirname(snapshotFile), { recursive: true });
  const tempFile = `${snapshotFile}.${process.pid}.${Date.now().toString(36)}.tmp`;
  // Exclusive creation refuses pre-existing files/symlinks. Do not clean up a
  // collision: only a successful open gives this save ownership of the temp.
  let descriptor: number | undefined = openSync(tempFile, 'wx', 0o600);
  try {
    writeFileSync(descriptor, serialized, 'utf8');
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(tempFile, snapshotFile);
  } catch (error) {
    const failures: unknown[] = [error];
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch (cleanupError) { failures.push(cleanupError); }
    }
    try { unlinkSync(tempFile); } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException)?.code !== 'ENOENT') failures.push(cleanupError);
    }
    if (failures.length > 1) throw new AggregateError(failures, 'Zerg snapshot save failed and temporary-file cleanup failed.');
    throw error;
  }
  return info;
}

export function recoverZergStateAfterRestart(
  state: ZergState,
  options: { now?: () => Date; previousWriterSessionId?: string } = {},
): { state: ZergState; recoveredRunIds: string[] } {
  const recoveredAt = (options.now ?? (() => new Date()))().toISOString();
  let next = recoverSessionMessages(state, recoveredAt);
  if (state.extensions[WORKFLOW_EXTENSION_KEY] !== undefined) {
    try {
      next = { ...next, extensions: { ...next.extensions,
        [WORKFLOW_EXTENSION_KEY]: recoverWorkflowState(state.extensions[WORKFLOW_EXTENSION_KEY]),
      } };
    } catch (error) {
      // Preserve the raw namespace for inspection. Core admission rejects it;
      // corrupt workflow data must not suppress unrelated native recovery.
      next = appendZergLogRecord(next, { source: 'adapter', level: 'warn', kind: 'error', createdAt: recoveredAt,
        message: `Workflow recovery disabled; original namespace retained: ${(error instanceof Error ? error.message : String(error)).slice(0, 1024)}`,
      });
    }
  }
  const recoveredRunIds: string[] = [];

  for (const run of getSubagentRunSnapshots(state)) {
    if (run.nativeSessions?.some((reference) => reference.attachment === 'attached')) {
      const agent = next.agents[run.runId]!;
      next = {
        ...next,
        agents: { ...next.agents, [run.runId]: { ...agent, metadata: {
          ...agent.metadata,
          nativeSessions: run.nativeSessions.map((reference) => reference.attachment === 'attached'
            ? { ...reference, attachment: 'unavailable', recoveredAt }
            : { ...reference }),
        } } },
      };
    }
    if (isTerminalRun(run.status, run.substate)) continue;
    const previousStatus = run.status;
    const previousSubstate = run.substate;
    // Durable continuation lineage is historical evidence only. Review tokens are
    // owner-local and are never restored, admitted, or replayed by recovery.
    const recoveryReason = run.nativeContinuation
      ? 'continuation interrupted by Pi restart; live session unavailable; new reviewed task required'
      : 'recovered after Pi restart; live session unavailable';
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
      activity: recoveryReason,
      substate: 'failed',
      substateReason: recoveryReason,
      metadata: { ...next.agents[run.runId]?.metadata, recovery },
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
            substateReason: recoveryReason,
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
