import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WORKFLOW_SCRIPT_LIMITS as L, type WorkflowScriptDiagnostic, type WorkflowScriptPhase, type WorkflowScriptStepSource } from './workflow-script-format.js';

export type WorkflowScriptParserReply =
  | { ok: true; definition: unknown; steps: WorkflowScriptStepSource[]; phases: WorkflowScriptPhase[] }
  | { ok: false; diagnostics: WorkflowScriptDiagnostic[] };
const failure = (code: string, message: string): WorkflowScriptParserReply => ({ ok: false, diagnostics: [{ code, message }] });
// JSON may escape every accepted source byte as six ASCII bytes, plus {"source":""}.
const INPUT_BYTES = 6 * L.sourceBytes + 13;
interface Job {
  source: string; signal?: AbortSignal; deadline: number; timer: ReturnType<typeof setTimeout>;
  abort: () => void; resolve: (result: WorkflowScriptParserReply) => void;
  child?: ChildProcessWithoutNullStreams; failure?: WorkflowScriptParserReply; done: boolean;
}
/** One owned parser child plus four waiting jobs. Slots release only after close/reaping.
 * No submitted code, shell, inherited execArgv, loader, NODE_OPTIONS or NODE_PATH.
 * The V8 cap is not an OS memory limit or a security sandbox.
 */
export function createWorkflowScriptParser() {
  let active: Job | undefined, disposed = false;
  const queue: Job[] = [];
  const drainWaiters: Array<() => void> = [];
  function finish(job: Job, result: WorkflowScriptParserReply) {
    if (job.done) return;
    job.done = true; clearTimeout(job.timer); job.signal?.removeEventListener('abort', job.abort);
    if (active === job) active = undefined;
    else { const i = queue.indexOf(job); if (i >= 0) queue.splice(i, 1); }
    job.resolve(result); pump();
    if (!active && !queue.length) drainWaiters.splice(0).forEach(resolve => resolve());
  }
  function stop(job: Job, code: string, message: string) {
    if (job.done) return;
    job.failure ??= failure(code, message);
    if (job.child) { try { job.child.kill('SIGKILL'); } catch { /* Retain ownership until close, never infer reaping. */ } } // close is the settlement certificate, not kill's return value.
    else finish(job, job.failure);
  }
  function pump() {
    if (active || disposed) return;
    const job = queue.shift(); if (!job) return;
    if (job.signal?.aborted || performance.now() >= job.deadline) { stop(job, job.signal?.aborted ? 'cancelled' : 'timeout', 'Compilation cancelled or deadline exceeded'); return; }
    active = job;
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(process.execPath, [`--max-old-space-size=${L.heapMiB}`, fileURLToPath(new URL('./workflow-script-compiler.mjs', import.meta.url))], {
        shell: false, env: { LANG: 'C', TZ: 'UTC' }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
        cwd: fileURLToPath(new URL('.', import.meta.url)),
      });
      job.child = child;
    } catch { finish(job, failure('process', 'Compiler process could not start')); return; }
    let stdoutBytes = 0, stderrBytes = 0; const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > L.stdoutBytes) stop(job, 'overflow', 'Compiler output budget exceeded');
      else if (!job.failure) chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => { stderrBytes += chunk.length; if (stderrBytes > L.stderrBytes) stop(job, 'overflow', 'Compiler diagnostic budget exceeded'); });
    child.stdin.on('error', () => { stop(job, 'process', 'Compiler input transport failed'); });
    child.on('error', () => { job.failure ??= failure('process', 'Compiler process failed'); });
    child.on('close', code => {
      if (job.failure) { finish(job, job.failure); return; }
      if (code !== 0) { finish(job, failure('process', 'Compiler process exited unsuccessfully')); return; }
      try {
        const reply: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
        if (!reply || typeof reply !== 'object' || Array.isArray(reply) || !('ok' in reply)) throw new Error();
        const r = reply as WorkflowScriptParserReply;
        if (r.ok === false) {
          if (Object.keys(r).some(k => !['ok', 'diagnostics'].includes(k)) || !Array.isArray(r.diagnostics) || r.diagnostics.length < 1 || r.diagnostics.length > L.diagnostics || r.diagnostics.some(d => {
            if (!d || typeof d !== 'object' || Array.isArray(d) || Object.keys(d).some(k => !['code', 'message', 'span'].includes(k)) || typeof d.code !== 'string' || !/^[a-z_]{1,32}$/.test(d.code) || typeof d.message !== 'string' || d.message.length > L.diagnosticLength) return true;
            const s = d.span;
            return s !== undefined && (!s || typeof s !== 'object' || Array.isArray(s) || Object.keys(s).sort().join(',') !== 'column,end,line,start' ||
              ![s.start, s.end, s.line, s.column].every(Number.isSafeInteger) || s.start < 0 || s.end < s.start || s.end > job.source.length || s.line < 1 || s.line > s.start + 1 || s.column < 0 || s.column > s.start);
          })) throw new Error();
        } else if (r.ok !== true || Object.keys(r).some(k => !['ok', 'definition', 'steps', 'phases'].includes(k)) || !Array.isArray(r.steps) || r.steps.length > L.steps || !Array.isArray(r.phases) || r.phases.length > L.phases) throw new Error();
        finish(job, r);
      } catch { finish(job, failure('protocol', 'Invalid compiler response')); }
    });
    try {
      const request = JSON.stringify({ source: job.source });
      if (Buffer.byteLength(request) > INPUT_BYTES) stop(job, 'source', 'Compiler input budget exceeded');
      else child.stdin.end(request);
    } catch { stop(job, 'process', 'Compiler input transport failed'); }
  }
  return {
    parse(source: string, signal?: AbortSignal): Promise<WorkflowScriptParserReply> {
      if (disposed) return Promise.resolve(failure('disposed', 'Compiler owner disposed'));
      if (typeof source !== 'string' || source.length > L.sourceLength || Buffer.byteLength(source) > L.sourceBytes || Buffer.from(source, 'utf8').toString('utf8') !== source) return Promise.resolve(failure('source', 'Invalid or oversized UTF-8 source'));
      if (signal?.aborted) return Promise.resolve(failure('cancelled', 'Compilation cancelled'));
      if (active && queue.length >= L.queued) return Promise.resolve(failure('busy', 'Compiler queue is full'));
      return new Promise(resolve => {
        const job: Job = { source, signal, deadline: performance.now() + L.deadlineMs, resolve, done: false,
          timer: undefined as unknown as ReturnType<typeof setTimeout>, abort: () => stop(job, 'cancelled', 'Compilation cancelled') };
        job.timer = setTimeout(() => stop(job, 'timeout', 'Compilation deadline exceeded'), L.deadlineMs);
        signal?.addEventListener('abort', job.abort, { once: true });
        queue.push(job); pump();
      });
    },
    dispose(): void { if (disposed) return; disposed = true; for (const job of [...queue]) stop(job, 'disposed', 'Compiler owner disposed'); if (active) stop(active, 'disposed', 'Compiler owner disposed'); },
    drain(): Promise<void> { return !active && !queue.length ? Promise.resolve() : new Promise(resolve => drainWaiters.push(resolve)); },
    inspect(): { active: number; queued: number; disposed: boolean } { return { active: active ? 1 : 0, queued: queue.length, disposed }; },
  };
}
const parser = createWorkflowScriptParser();
export function parseWorkflowScriptIsolated(source: string, signal?: AbortSignal): Promise<WorkflowScriptParserReply> { return parser.parse(source, signal); }
