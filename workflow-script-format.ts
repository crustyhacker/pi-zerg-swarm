/** Versioned, dependency-light authoring data. Never runtime authority. */
export const WORKFLOW_SCRIPT_FORMAT_VERSION = 1 as const;
export const WORKFLOW_SCRIPT_LANGUAGE_VERSION = 1 as const;
export const WORKFLOW_SCRIPT_COMPILER_VERSION = 1 as const;
export const WORKFLOW_SCRIPT_PARSER_VERSION = 'typescript@5.9.3' as const;
export const WORKFLOW_SCRIPT_LIMITS = Object.freeze({ sourceBytes: 65536, sourceLength: 65536, sourceName: 128,
  metadataBytes: 8192, steps: 16, phases: 16, lexicalDepth: 32, tokens: 8192, literalLength: 16384,
  astNodes: 12000, astDepth: 64, work: 100000, outputBytes: 65536,
  diagnostics: 8, diagnosticLength: 256, stdoutBytes: 131072, stderrBytes: 4096,
  deadlineMs: 5000, heapMiB: 256, queued: 4 });
export interface WorkflowScriptSpan { start: number; end: number; line: number; column: number }
export interface WorkflowScriptStepSource { path: string[]; span: WorkflowScriptSpan }
export interface WorkflowScriptPhase { id: string; paths: string[][]; span: WorkflowScriptSpan }
export interface WorkflowScriptAuthoring {
  formatVersion: 1; languageVersion: 1; compilerVersion: 1; parserVersion: 'typescript@5.9.3';
  sourceHash: string; graphHash: string; sourceName: string; sourceBytes: number; sourceLength: number;
  steps: WorkflowScriptStepSource[]; phases: WorkflowScriptPhase[];
}
export interface WorkflowScriptDiagnostic { code: string; message: string; span?: WorkflowScriptSpan }
export type WorkflowScriptAction =
  | { action: 'workflows.scripts.validate' | 'workflows.scripts.compile' | 'workflows.scripts.save'; source: string; sourceName?: string }
  | { action: 'workflows.scripts.inspect'; definitionId: string }
  | { action: 'workflows.scripts.import'; path: string };
export interface WorkflowScriptInspection {
  id: string; label: string; inputSchema: unknown;
  source?: { sourceName: string; sourceHash: string; graphHash: string };
  steps: Array<{ path: string[]; kind: string; agentId?: string; capability?: string; span?: WorkflowScriptSpan }>;
  phases: WorkflowScriptPhase[]; agentIds: string[]; codingCapabilities: string[];
  counts: { authored: number; expanded: number; native: number; coding: number; familyAdmissions: number };
  caps: { steps: number; fanout: number; admissions: number; attempts: number };
  disclaimer: string;
}
