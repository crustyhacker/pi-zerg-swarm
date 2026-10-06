import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { basename, isAbsolute, resolve, sep } from 'node:path';
import { validateWorkflowDefinition, WORKFLOW_LIMITS, type WorkflowDefinition, type WorkflowReply, type WorkflowState } from './workflow-model.js';
import type { WorkflowScriptAction } from './workflow-script-format.js';
import { compileWorkflowScript, inspectWorkflowScriptDefinition } from './workflow-script.js';

const SOURCE_BYTES = 65536;
export const WORKFLOW_SCRIPT_COMMAND_BYTES = SOURCE_BYTES * 6 + 2048;
const names = new Set(['workflows.scripts.validate', 'workflows.scripts.compile', 'workflows.scripts.inspect', 'workflows.scripts.save', 'workflows.scripts.import']);
export function isWorkflowScriptActionName(name: unknown): name is WorkflowScriptAction['action'] {
  return typeof name === 'string' && names.has(name);
}

/** Close this authoring surface independently of the scheduler action union. */
export function parseWorkflowScriptAction(input: unknown): WorkflowScriptAction {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw new Error('Script action requires a plain object.');
  const keys = Reflect.ownKeys(input);
  if (keys.length > 3 || keys.some(key => typeof key !== 'string')) throw new Error('Unsupported script action fields.');
  const value: Record<string, unknown> = Object.create(null);
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key)!;
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw new Error('Script action requires enumerable data fields.');
    value[key] = descriptor.value;
  }
  if (!isWorkflowScriptActionName(value.action)) throw new Error('Unknown script action.');
  const allowed = value.action === 'workflows.scripts.inspect' ? ['action', 'definitionId']
    : value.action === 'workflows.scripts.import' ? ['action', 'path'] : ['action', 'source', 'sourceName'];
  if (keys.some(key => !allowed.includes(key as string))) throw new Error('Unsupported script action fields; source cannot grant authority or start work.');
  if (value.action === 'workflows.scripts.inspect') {
    if (typeof value.definitionId !== 'string' || value.definitionId.length > 80 || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value.definitionId)) throw new Error('Script inspect requires an exact definitionId.');
  } else if (value.action === 'workflows.scripts.import') {
    validateScriptPath(value.path);
  } else {
    if (typeof value.source !== 'string' || value.source.length > SOURCE_BYTES || Buffer.byteLength(value.source, 'utf8') > SOURCE_BYTES) throw new Error('Script source must be a string of at most 65536 UTF8 bytes.');
    if (Object.hasOwn(value, 'sourceName') && (typeof value.sourceName !== 'string' || value.sourceName.length > 128 || Buffer.byteLength(value.sourceName, 'utf8') > 512)) throw new Error('Script sourceName must be a display string of at most 128 characters.');
  }
  return value as unknown as WorkflowScriptAction;
}

function validateScriptPath(path: unknown): asserts path is string {
  if (typeof path !== 'string' || !path || path.length > 1024 || isAbsolute(path) || /[\\\x00-\x1f\x7f-\x9f:]/u.test(path)) throw new Error('Script import requires an explicit bounded relative path.');
  const parts = path.split('/');
  if (parts.length > 64 || parts.some(part => !part || part === '.' || part === '..')) throw new Error('Script import rejects traversal and non-normalized paths.');
}

/** Descriptor-anchored Linux walk: no ancestor can be swapped into a symlink
 * between checks and open. Fail closed when this local capability is absent.
 * This reads exactly one supplied file; it provides no execution authority. */
export function readWorkflowScriptFile(path: string, cwd: string): string {
  validateScriptPath(path);
  if (process.platform !== 'linux' || !constants.O_NOFOLLOW || !constants.O_DIRECTORY) throw new Error('Safe script import requires Linux nofollow descriptor paths.');
  const absoluteCwd = resolve(cwd);
  const descriptors: number[] = [];
  try {
    let directory = openSync(sep, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    descriptors.push(directory);
    const components = [...absoluteCwd.split(sep).filter(Boolean), ...path.split('/').slice(0, -1)];
    if (components.length > 128) throw new Error('Script import directory depth exceeds bound.');
    for (const component of components) {
      directory = openSync(`/proc/self/fd/${directory}/${component}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      descriptors.push(directory);
      if (!fstatSync(directory).isDirectory()) throw new Error('Script import ancestor is not a directory.');
    }
    const fd = openSync(`/proc/self/fd/${directory}/${basename(path)}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    descriptors.push(fd);
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.size > BigInt(SOURCE_BYTES)) throw new Error('Script import requires a regular file of at most 65536 bytes.');
    const bytes = Buffer.alloc(SOURCE_BYTES + 1);
    let size = 0;
    while (size < bytes.length) {
      const read = readSync(fd, bytes, size, bytes.length - size, size);
      if (!read) break;
      size += read;
    }
    const after = fstatSync(fd, { bigint: true });
    if (size > SOURCE_BYTES || BigInt(size) !== before.size || after.size !== before.size || after.dev !== before.dev || after.ino !== before.ino
      || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) throw new Error('Script import changed or grew during bounded read.');
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, size));
  } finally {
    for (const fd of descriptors.reverse()) closeSync(fd);
  }
}

export interface WorkflowScriptControlPort {
  /** Read-only current namespace; never a lazy service getter. */
  readLedger(): unknown;
  cwd: string;
  define(definition: WorkflowDefinition, signal?: AbortSignal): Promise<WorkflowReply>;
}
export interface WorkflowScriptControlReply { ok: boolean; data?: unknown; error?: string }
export async function executeWorkflowScriptAction(input: unknown, port: WorkflowScriptControlPort, signal?: AbortSignal): Promise<WorkflowScriptControlReply> {
  const action = parseWorkflowScriptAction(input);
  if (signal?.aborted) throw new Error('Script action cancelled.');
  if (action.action === 'workflows.scripts.inspect') {
    const ledger = port.readLedger() as WorkflowState | undefined;
    if (!ledger || !Array.isArray(ledger.definitions) || ledger.definitions.length > WORKFLOW_LIMITS.definitions) throw new Error('Saved workflow definition not found; inspect does not initialize state.');
    const matches = ledger.definitions.filter(definition => definition?.id === action.definitionId);
    if (matches.length !== 1) throw new Error('Saved workflow definition missing or ambiguous; no fallback.');
    const definition = validateWorkflowDefinition(matches[0]);
    return { ok: true, data: { definition, inspection: inspectWorkflowScriptDefinition(definition) } };
  }
  const source = action.action === 'workflows.scripts.import' ? readWorkflowScriptFile(action.path, port.cwd) : action.source;
  const sourceName = action.action === 'workflows.scripts.import' ? basename(action.path) : action.sourceName;
  const compiled = await compileWorkflowScript(source, { ...(sourceName !== undefined ? { sourceName } : {}), ...(signal ? { signal } : {}) });
  if (!compiled.ok) return { ok: false, data: { diagnostics: compiled.diagnostics }, error: 'Workflow script compilation refused; inspect bounded diagnostics.' };
  if (signal?.aborted) throw new Error('Script action cancelled before save.');
  if (action.action === 'workflows.scripts.validate') return { ok: true, data: { inspection: compiled.inspection } };
  if (action.action === 'workflows.scripts.compile') return { ok: true, data: { definition: compiled.definition, inspection: compiled.inspection } };
  // This is the sole state-changing branch. Existing define owns all replacement,
  // unsettled-run and persistence gates. Neither save nor import implies start.
  const saved = await port.define(compiled.definition, signal);
  return saved.ok ? { ok: true, data: { saved: saved.definition, inspection: compiled.inspection } }
    : { ok: false, error: saved.error ?? 'Workflow definition save refused.' };
}

/** A control owner's compiler work is independently cancellable. Compiler promises
 * settle after owned process cleanup; drain does not initialize any runtime. */
export function createWorkflowScriptControlOwner() {
  const controller = new AbortController();
  const pending = new Set<Promise<WorkflowScriptControlReply>>();
  return {
    execute(input: unknown, port: WorkflowScriptControlPort, caller?: AbortSignal): Promise<WorkflowScriptControlReply> {
      const signal = caller ? AbortSignal.any([controller.signal, caller]) : controller.signal;
      const job = (async () => {
        if (signal.aborted) throw new Error('Workflow authoring owner/caller cancelled.');
        const reply = await executeWorkflowScriptAction(input, port, signal);
        if (signal.aborted) throw new Error('Workflow authoring owner/caller cancelled.');
        return reply;
      })();
      pending.add(job);
      // Install both handlers without an unobserved rejecting finally-promise.
      void job.then(() => pending.delete(job), () => pending.delete(job));
      return job;
    },
    dispose(): void { if (!controller.signal.aborted) controller.abort(); },
    async drain(): Promise<void> {
      while (pending.size) await Promise.allSettled([...pending]);
    },
  };
}
export type WorkflowScriptControlOwner = ReturnType<typeof createWorkflowScriptControlOwner>;
