import type { ExtensionAPI, ResourceLoader, ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { WorkflowControlledCodingContext, WorkflowNativeRequest } from './workflow-model.js';

export type WorkflowNativeCodingMode = 'investigate' | 'stage-write' | 'review';

export interface WorkflowNativeCodingAuthority {
  assert(): void;
}

export interface WorkflowNativeCodingToolsResult {
  tools: ToolDefinition[];
  toolNames: string[];
  assertToolCall(toolName: string): void;
}

const READ_TOOL = 'workflow_stage_read';
const WRITE_TOOL = 'workflow_stage_write';
const INSPECT_TOOL = 'workflow_stage_inspect';
const ALL_TOOLS = Object.freeze([READ_TOOL, WRITE_TOOL, INSPECT_TOOL]);

function assertCodingRequest(request: WorkflowNativeRequest): WorkflowControlledCodingContext {
  request.assertAdmission();
  const coding = request.coding;
  if (!coding) throw new Error('Workflow coding authority is missing.');
  if (coding.operation !== 'investigate' && coding.operation !== 'stage-write' && coding.operation !== 'review') throw new Error('Workflow native coding tools are only available to investigation/writer/reviewer sessions.');
  return coding;
}

function textResult(text: string, details: unknown = undefined) {
  return { content: [{ type: 'text' as const, text }], details };
}

export function createWorkflowNativeCodingTools(request: WorkflowNativeRequest, authority: WorkflowNativeCodingAuthority): WorkflowNativeCodingToolsResult {
  const assert = () => { authority.assert(); assertCodingRequest(request); };
  const readTool: ToolDefinition = {
    name: READ_TOOL,
    label: 'Workflow staged read',
    description: 'Read one explicitly admitted staged workflow path. This cannot access shell, project extensions, MCP, or arbitrary files.',
    parameters: { type: 'object', additionalProperties: false, properties: { path: { type: 'string', description: 'Exact relative path from the workflow coding policy.' } }, required: ['path'] },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async execute(_toolCallId: string, params: { path?: string }) {
      assert();
      const coding = assertCodingRequest(request);
      const path = String(params?.path ?? '');
      const text = coding.read(path);
      assert();
      return textResult(text, { path, bytes: Buffer.byteLength(text, 'utf8') });
    },
  } as ToolDefinition;
  const writeTool: ToolDefinition = {
    name: WRITE_TOOL,
    label: 'Workflow staged write',
    description: 'Replace the text of one explicitly writable staged workflow path. Requires the current workflow admission after every await.',
    parameters: { type: 'object', additionalProperties: false, properties: { path: { type: 'string' }, text: { type: 'string' } }, required: ['path', 'text'] },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    async execute(_toolCallId: string, params: { path?: string; text?: string }) {
      assert();
      const coding = assertCodingRequest(request);
      if (coding.operation !== 'stage-write') throw new Error('This workflow coding session is read-only; writes are refused.');
      const path = String(params?.path ?? '');
      const text = String(params?.text ?? '');
      request.assertAdmission();
      coding.write(path, text);
      assert();
      return textResult(`staged write accepted for ${path}`, { path, bytes: Buffer.byteLength(text, 'utf8') });
    },
  } as ToolDefinition;
  const inspectTool: ToolDefinition = {
    name: INSPECT_TOOL,
    label: 'Workflow staged inspect',
    description: 'Inspect the bounded staged workflow candidate manifest and hashes.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async execute() {
      assert();
      const coding = assertCodingRequest(request);
      const details = coding.inspect();
      assert();
      return textResult(JSON.stringify(details, null, 2), details);
    },
  } as ToolDefinition;
  const tools = request.coding?.operation === 'stage-write' ? [readTool, writeTool, inspectTool] : [readTool, inspectTool];
  const toolNames = tools.map((tool) => tool.name);
  return {
    tools,
    toolNames,
    assertToolCall(toolName: string) {
      assert();
      if (!toolNames.includes(toolName)) throw new Error('Workflow coding tool boundary refused undeclared tool.');
    },
  };
}

export function createSealedWorkflowResourceLoader(sdk: { createExtensionRuntime(): unknown }, systemPrompt: string, extensionFactories: Array<(pi: ExtensionAPI) => void> = []): ResourceLoader {
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: sdk.createExtensionRuntime(), extensionFactories }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => undefined,
    reload: async () => undefined,
  } as ResourceLoader;
}

export const WORKFLOW_NATIVE_CODING_TOOL_NAMES = ALL_TOOLS;
