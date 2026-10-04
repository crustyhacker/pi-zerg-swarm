import { createHash } from 'node:crypto';
import { workflowHash } from './workflow-model.js';
import type { WorkflowDefinition, WorkflowSchema, WorkflowTrustedCodingConfig } from './workflow-model.js';
import type { WorkflowCodingCheckProfile, WorkflowCodingPolicy } from './workflow-coding.js';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const str = (maxLength = 256): WorkflowSchema => ({ type: 'string', maxLength });
const bool: WorkflowSchema = { type: 'boolean' };
const arr = (items: WorkflowSchema, maxItems = 8): WorkflowSchema => ({ type: 'array', maxItems, items });
const obj = (properties: Record<string, WorkflowSchema>, required = Object.keys(properties)): WorkflowSchema => ({ type: 'object', properties, required, additionalProperties: false });

export interface TrustedCodingWorkflowExampleOptions {
  projectRoot: string;
  stagingParent: string;
  parentRunId?: string;
  taskId?: string;
  rootAgentId?: string;
  workerAgentId?: string;
  model?: string;
}

export interface TrustedCodingWorkflowExample {
  definition: WorkflowDefinition;
  coding: WorkflowTrustedCodingConfig & { enabled: true };
  initialFiles: Record<string, string>;
}

export function buildTrustedCodingWorkflowExample(options: TrustedCodingWorkflowExampleOptions): TrustedCodingWorkflowExample {
  const beforeText = 'hello from disposable project\n';
  const packageText = '{"type":"module","scripts":{"check":"python3 - <<\'PY\'\nfrom pathlib import Path\nassert Path(\'message.txt\').read_text() == \'hello from trusted workflow\\n\'\nPY"}}\n';
  const checkBase = {
    id: 'python-message-check',
    executable: '/usr/bin/python3',
    argv: ['-c', "from pathlib import Path; assert Path('message.txt').read_text() == 'hello from trusted workflow\\n'"],
    cwd: 'src',
    env: {},
    timeoutMs: 10_000,
    allowGeneratedOutputs: false as const,
  } satisfies Omit<WorkflowCodingCheckProfile, 'profileHash'>;
  const policy: WorkflowCodingPolicy = {
    version: 3,
    capabilities: ['investigate', 'stage-write', 'check', 'review', 'apply'],
    identity: {
      parentRunId: options.parentRunId ?? 'trusted-host-parent',
      taskId: options.taskId ?? 'disposable-message-change',
      attemptNo: 1,
      rootAgentId: options.rootAgentId ?? 'reviewer',
      workerAgentId: options.workerAgentId ?? 'worker',
      model: options.model ?? 'provider/model',
    },
    scope: {
      task: 'Change src/message.txt exactly to "hello from trusted workflow\\n". If independent review finds a defect, produce a corrected staged candidate before application approval.',
      writablePaths: ['src/message.txt'],
      readonlyPaths: ['package.json'],
      protectedPaths: ['.git', '.pi', '.agents'],
      baseline: { projectRootId: options.projectRoot, stateHash: sha256(beforeText) },
      manifest: [{ path: 'src/message.txt', sha256: sha256(beforeText), bytes: Buffer.byteLength(beforeText), text: beforeText }],
      dependencies: [{ path: 'package.json', sha256: sha256(packageText), bytes: Buffer.byteLength(packageText), text: packageText }],
    },
    bounds: { maxIterations: 3, maxFiles: 4, maxFileBytes: 64_000, maxTotalBytes: 128_000, maxCandidateBytes: 128_000, maxOutputBytes: 16_384, maxCheckMs: 30_000, maxReviewFindings: 8 },
    checkProfiles: [{ ...checkBase, profileHash: workflowHash(checkBase) }],
    reviewRequired: true,
  };

  const findingSchema = obj({ id: str(80), severity: str(10), path: str(512), message: str(4096) });
  const reviewOut = obj({ passed: bool, candidateHash: str(80), reviewer: str(160), findings: arr(findingSchema, 8) });
  const definition: WorkflowDefinition = {
    id: 'trusted-disposable-coding',
    version: 3,
    label: 'Trusted disposable coding workflow',
    inputSchema: obj({}),
    steps: [
      { id: 'investigate', kind: 'coding', dependsOn: [], inputs: {}, outputSchema: obj({ summary: str(2048), paths: arr(str(512), 8) }), coding: { operation: 'investigate', policy } },
      {
        id: 'correct-until-reviewed', kind: 'repeat', dependsOn: ['investigate'],
        initial: { value: { passed: false, candidateHash: '', reviewer: '', findings: [] } }, stateSchema: reviewOut, maxIterations: 3,
        body: [
          { id: 'stage', kind: 'coding', dependsOn: [], inputs: {}, outputSchema: obj({ candidateHash: str(80), changedPaths: arr(str(512), 4) }), coding: { operation: 'stage-write', policy } },
          { id: 'check', kind: 'coding', dependsOn: ['stage'], inputs: {}, outputSchema: obj({ passed: bool, profileId: str(80), candidateHash: str(80) }), coding: { operation: 'check', policy, checkProfileId: 'python-message-check' } },
          { id: 'review', kind: 'coding', dependsOn: ['check'], inputs: {}, outputSchema: reviewOut, coding: { operation: 'review', policy } },
        ],
        feedback: { ref: { source: 'step', stepId: 'review', path: [] } },
        until: { op: 'boolean', value: { ref: { source: 'iteration', path: ['passed'] } } },
        output: { ref: { source: 'iteration', path: [] } }, outputSchema: reviewOut,
      },
      { id: 'apply', kind: 'coding', dependsOn: ['correct-until-reviewed'], inputs: {}, outputSchema: obj({ status: str(16), candidateHash: str(80), appliedPaths: arr(str(512), 4), rejectedPaths: arr(str(512), 4), diagnostics: arr(str(512), 8), outcomeHash: str(80) }), coding: { operation: 'apply', policy } },
    ],
  };
  return {
    definition,
    coding: {
      enabled: true,
      projectRoot: options.projectRoot,
      stagingParent: options.stagingParent,
      writablePaths: ['src/message.txt'],
      checkProfiles: { 'python-message-check': { id: checkBase.id, executable: checkBase.executable, argv: checkBase.argv, cwd: checkBase.cwd, env: checkBase.env, timeoutMs: checkBase.timeoutMs, outputBytes: 16_384, generatedOutputs: [] } },
    },
    initialFiles: { 'src/message.txt': beforeText, 'package.json': packageText },
  };
}
