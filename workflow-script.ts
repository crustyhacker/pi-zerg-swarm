import { createHash } from 'node:crypto';
import { validateWorkflowDefinition, workflowHash, WORKFLOW_LIMITS } from './workflow-model.js';
import type { WorkflowDefinition, WorkflowStep } from './workflow-model.js';
import { parseWorkflowScriptIsolated } from './workflow-script-process.js';
import { WORKFLOW_SCRIPT_LIMITS as L, WORKFLOW_SCRIPT_FORMAT_VERSION, WORKFLOW_SCRIPT_LANGUAGE_VERSION,
  WORKFLOW_SCRIPT_COMPILER_VERSION, WORKFLOW_SCRIPT_PARSER_VERSION } from './workflow-script-format.js';
import type { WorkflowScriptAuthoring, WorkflowScriptDiagnostic, WorkflowScriptInspection } from './workflow-script-format.js';

export type WorkflowScriptCompileResult = { ok: true; definition: WorkflowDefinition; inspection: WorkflowScriptInspection }
  | { ok: false; diagnostics: WorkflowScriptDiagnostic[] };
/** Always isolated parsing, followed by the same ordinary graph validator used by define/start.
 * Compilation confers no approval, model availability, execution or recovery authority.
 */
export async function compileWorkflowScript(source: string, options: { sourceName?: string; signal?: AbortSignal } = {}): Promise<WorkflowScriptCompileResult> {
  const fail = (code: string, message: string): WorkflowScriptCompileResult => ({ ok: false, diagnostics: [{ code, message }] });
  if (options.sourceName !== undefined && (typeof options.sourceName !== 'string' || options.sourceName.length > L.sourceBytes)) return fail('source_name', 'Invalid source display name');
  const parsed = await parseWorkflowScriptIsolated(source, options.signal);
  if (!parsed.ok) return parsed;
  if (options.signal?.aborted) return fail('cancelled', 'Compilation cancelled');
  try {
    const graph = validateWorkflowDefinition(parsed.definition as WorkflowDefinition);
    const sourceName = (options.sourceName ?? 'workflow.workflow.js').split(/[\\/]/).pop()!.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, L.sourceName) || 'workflow.workflow.js';
    const authoring: WorkflowScriptAuthoring = {
      formatVersion: WORKFLOW_SCRIPT_FORMAT_VERSION, languageVersion: WORKFLOW_SCRIPT_LANGUAGE_VERSION,
      compilerVersion: WORKFLOW_SCRIPT_COMPILER_VERSION, parserVersion: WORKFLOW_SCRIPT_PARSER_VERSION,
      sourceHash: createHash('sha256').update(source, 'utf8').digest('hex'), graphHash: workflowHash(graph),
      sourceName, sourceBytes: Buffer.byteLength(source, 'utf8'), sourceLength: source.length,
      steps: parsed.steps, phases: parsed.phases,
    };
    if (Buffer.byteLength(JSON.stringify(authoring)) > L.metadataBytes) return fail('metadata', 'Authoring metadata budget exceeded');
    const definition = validateWorkflowDefinition({ ...graph, authoring } as WorkflowDefinition);
    const inspection = inspectWorkflowScriptDefinition(definition);
    if (inspection.counts.familyAdmissions > inspection.caps.admissions) return fail('budget', 'Authored worst-case admissions exceed workflow budget');
    return { ok: true, definition, inspection };
  } catch { return fail('definition', 'Compiled graph rejected by ordinary workflow validation'); }
}
/** Pure, bounded inspection of a validated frozen graph; no parser or runtime service startup. */
export function inspectWorkflowScriptDefinition(value: WorkflowDefinition): WorkflowScriptInspection {
  const definition = validateWorkflowDefinition(value);
  const authoring = (definition as WorkflowDefinition & { authoring?: WorkflowScriptAuthoring }).authoring;
  const steps: WorkflowScriptInspection['steps'] = [], agentIds = new Set<string>(), capabilities = new Set<string>();
  let expanded = 0, native = 0, coding = 0;
  const visit = (step: WorkflowStep, prefix: string[], multiplier: number) => {
    const path = [...prefix, step.id], location = authoring?.steps.find(s => JSON.stringify(s.path) === JSON.stringify(path));
    steps.push({ path, kind: step.kind, ...(step.agentId ? { agentId: step.agentId } : {}), ...(step.coding ? { capability: step.coding.operation } : {}), ...(location ? { span: location.span } : {}) });
    const units = (step.fanout?.maxItems ?? 1) * multiplier; expanded += units;
    if (step.kind === 'native') { native += units; agentIds.add(step.agentId!); }
    if (step.kind === 'coding') {
      coding += units; capabilities.add(step.coding!.operation);
      const identity = (step.coding!.policy as { identity: { rootAgentId: string; workerAgentId: string } }).identity;
      agentIds.add(identity.rootAgentId); agentIds.add(identity.workerAgentId);
    }
    for (const body of step.body ?? []) visit(body, path, multiplier * step.maxIterations!);
  };
  definition.steps.forEach(step => visit(step, [], 1));
  return {
    id: definition.id, label: definition.label, inputSchema: definition.inputSchema,
    ...(authoring ? { source: { sourceName: authoring.sourceName, sourceHash: authoring.sourceHash, graphHash: authoring.graphHash } } : {}),
    steps, phases: authoring?.phases ?? [], agentIds: [...agentIds].sort(), codingCapabilities: [...capabilities].sort(),
    counts: { authored: steps.length, expanded, native, coding, familyAdmissions: (native + coding) * WORKFLOW_LIMITS.attempts },
    caps: { steps: WORKFLOW_LIMITS.steps, fanout: WORKFLOW_LIMITS.fanout, admissions: WORKFLOW_LIMITS.admissions, attempts: WORKFLOW_LIMITS.attempts },
    disclaimer: 'Declared capabilities and worst-case counts only; not model availability, approval, external dependency, native settlement or result-reuse proof.',
  };
}
