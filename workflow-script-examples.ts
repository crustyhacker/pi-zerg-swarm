/**
 * Bounded Stage 8D authoring examples. Pure data on import: no compilation,
 * definition registration, workflow start, provider request, approval, or
 * workspace effect happens by importing this module. The script strings are
 * only inert text; they must be compiled explicitly through
 * `compileWorkflowScript` or the `workflows.scripts.*` controls, and the
 * equivalent definitions must be registered and started through the ordinary
 * existing workflow engine with separately configured agents that carry
 * explicit provider/model IDs. Compilation and this module never grant
 * approval, model availability, or execution authority.
 */
import type { WorkflowDefinition } from './workflow-model.js';

/** Read-only parallel review: two independent bounded fan-out reviews over the
 * declared targets, joined by an explicit deterministic collect aggregate.
 * Declared phases group progress only; they create no execution owner.
 */
export const READ_ONLY_PARALLEL_SCRIPT = `workflow({
  id: 'read-only-parallel-review',
  label: 'Read-only parallel review',
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['targets'],
    properties: { targets: { type: 'array', maxItems: 4, items: { type: 'string', maxLength: 512 } } },
  },
}, () => {
  const survey = native('survey', {
    dependsOn: [],
    agentId: 'generalist',
    prompt: 'Read the supplied target without changes. Return a JSON object with a short summary and up to four concerns you noticed; no edits, shell commands, or approvals.',
    inputs: { target: ref('item', []) },
    fanout: { from: ref('inputs', ['targets']), maxItems: 4 },
    outputSchema: {
      type: 'object', additionalProperties: false, required: ['summary', 'concerns'],
      properties: {
        summary: { type: 'string', maxLength: 2048 },
        concerns: { type: 'array', maxItems: 4, items: { type: 'string', maxLength: 512 } },
      },
    },
  });
  const verify = native('verify', {
    dependsOn: [],
    agentId: 'reviewer',
    prompt: 'Independently inspect the supplied target without changes. Return a JSON object with your verdict and the reason for it; this is your assessment, not proof, and grants no approval.',
    inputs: { target: ref('item', []) },
    fanout: { from: ref('inputs', ['targets']), maxItems: 4 },
    outputSchema: {
      type: 'object', additionalProperties: false, required: ['verdict', 'reason'],
      properties: {
        verdict: { type: 'string', maxLength: 16, enum: ['confirm', 'dispute', 'unclear'] },
        reason: { type: 'string', maxLength: 1024 },
      },
    },
  });
  const collect = aggregate('collect', {
    dependsOn: [survey, verify],
    inputs: { surveys: ref(survey, []), verifications: ref(verify, []) },
    operation: 'collect',
  });
  phase('review', [survey, verify]);
  phase('combine', [collect]);
});
`;

/** Conditional refinement: an extra review runs only when the boolean input
 * asks for it, an explicit skip-consuming join keeps the deliberate skip
 * distinguishable, and a bounded repeat refines structured findings for at
 * most three iterations. A false terminal condition at the iteration limit is
 * truthful non-convergence: the run fails, it never becomes success.
 */
export const CONDITIONAL_REFINEMENT_SCRIPT = `workflow({
  id: 'bounded-conditional-refinement',
  label: 'Bounded conditional refinement',
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['targets', 'extraReview'],
    properties: {
      targets: { type: 'array', maxItems: 4, items: { type: 'string', maxLength: 512 } },
      extraReview: { type: 'boolean' },
    },
  },
}, () => {
  const text = { type: 'string', maxLength: 1024 };
  const stateSchema = {
    type: 'object', additionalProperties: false, required: ['findings', 'questions', 'done'],
    properties: {
      findings: { type: 'array', maxItems: 4, items: text },
      questions: { type: 'array', maxItems: 4, items: text },
      done: { type: 'boolean' },
    },
  };
  const inspect = native('inspect', {
    dependsOn: [],
    agentId: 'generalist',
    prompt: 'Read only the supplied targets. Return schema JSON with your findings, open questions, and whether you believe the review is done; your belief is an assessment, not proof.',
    inputs: { targets: ref('inputs', ['targets']) },
    outputSchema: stateSchema,
  });
  const extra = native('extra', {
    dependsOn: [inspect],
    agentId: 'reviewer',
    when: { op: 'boolean', value: ref('inputs', ['extraReview']) },
    prompt: 'Only if scheduled: independently review these findings against the supplied targets, read-only. Return a JSON string.',
    inputs: { targets: ref('inputs', ['targets']), findings: ref(inspect, []) },
    outputSchema: text,
  });
  const coverage = aggregate('coverage', {
    dependsOn: [inspect, extra],
    inputs: { inspection: ref(inspect, []), additionalReview: ref(extra, []) },
    operation: 'collect',
    consumeSkips: true,
  });
  const refine = repeat('refine', {
    dependsOn: [inspect, coverage],
    initial: ref(inspect, []),
    stateSchema: stateSchema,
    outputSchema: stateSchema,
    maxIterations: 3,
  }, () => {
    const revise = native('revise', {
      dependsOn: [],
      agentId: 'generalist',
      prompt: 'Read only the supplied targets. Refine the previous structured findings and remaining questions and return schema JSON; no edits or shell commands.',
      inputs: { targets: ref('inputs', ['targets']), prior: ref('iteration', []) },
      outputSchema: stateSchema,
    });
    const assess = native('assess', {
      dependsOn: [revise],
      agentId: 'reviewer',
      prompt: 'Independently assess these refined findings using read-only inspection of the supplied targets. Preserve unresolved questions and set done only when none remain; this is your assessment, not proof. Return schema JSON.',
      inputs: { targets: ref('inputs', ['targets']), findings: ref(revise, []) },
      outputSchema: stateSchema,
    });
    return { feedback: ref(assess, []), until: { op: 'boolean', value: ref('iteration', ['done']) }, output: ref('iteration', []) };
  });
  const report = aggregate('report', {
    dependsOn: [coverage, refine],
    inputs: { coverage: ref(coverage, []), findings: ref(refine, []) },
    operation: 'collect',
    consumeFailures: true,
  });
  phase('inspect', [inspect, extra, coverage]);
  phase('refine', [refine, report]);
});
`;

/** Equivalent canonical graph for READ_ONLY_PARALLEL_SCRIPT without authoring
 * metadata. Plain read-only graphs are root version 2, never informal v1. */
const readOnlyParallelGraph: WorkflowDefinition = {
  id: 'read-only-parallel-review', version: 2, label: 'Read-only parallel review',
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['targets'],
    properties: { targets: { type: 'array', maxItems: 4, items: { type: 'string', maxLength: 512 } } },
  },
  steps: [
    {
      id: 'survey', kind: 'native', dependsOn: [], agentId: 'generalist',
      prompt: 'Read the supplied target without changes. Return a JSON object with a short summary and up to four concerns you noticed; no edits, shell commands, or approvals.',
      inputs: { target: { ref: { source: 'item', path: [] } } },
      fanout: { from: { source: 'inputs', path: ['targets'] }, maxItems: 4 },
      outputSchema: {
        type: 'object', additionalProperties: false, required: ['summary', 'concerns'],
        properties: {
          summary: { type: 'string', maxLength: 2048 },
          concerns: { type: 'array', maxItems: 4, items: { type: 'string', maxLength: 512 } },
        },
      },
    },
    {
      id: 'verify', kind: 'native', dependsOn: [], agentId: 'reviewer',
      prompt: 'Independently inspect the supplied target without changes. Return a JSON object with your verdict and the reason for it; this is your assessment, not proof, and grants no approval.',
      inputs: { target: { ref: { source: 'item', path: [] } } },
      fanout: { from: { source: 'inputs', path: ['targets'] }, maxItems: 4 },
      outputSchema: {
        type: 'object', additionalProperties: false, required: ['verdict', 'reason'],
        properties: {
          verdict: { type: 'string', maxLength: 16, enum: ['confirm', 'dispute', 'unclear'] },
          reason: { type: 'string', maxLength: 1024 },
        },
      },
    },
    {
      id: 'collect', kind: 'aggregate', dependsOn: ['survey', 'verify'], operation: 'collect',
      inputs: {
        surveys: { ref: { source: 'step', stepId: 'survey', path: [] } },
        verifications: { ref: { source: 'step', stepId: 'verify', path: [] } },
      },
    },
  ],
};
export const READ_ONLY_PARALLEL_DEFINITION = Object.freeze(readOnlyParallelGraph);

/** Equivalent canonical graph for CONDITIONAL_REFINEMENT_SCRIPT without
 * authoring metadata. Plain read-only graphs are root version 2. */
const conditionalRefinementGraph: WorkflowDefinition = {
  id: 'bounded-conditional-refinement', version: 2, label: 'Bounded conditional refinement',
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['targets', 'extraReview'],
    properties: {
      targets: { type: 'array', maxItems: 4, items: { type: 'string', maxLength: 512 } },
      extraReview: { type: 'boolean' },
    },
  },
  steps: [
    {
      id: 'inspect', kind: 'native', dependsOn: [], agentId: 'generalist',
      prompt: 'Read only the supplied targets. Return schema JSON with your findings, open questions, and whether you believe the review is done; your belief is an assessment, not proof.',
      inputs: { targets: { ref: { source: 'inputs', path: ['targets'] } } },
      outputSchema: {
        type: 'object', additionalProperties: false, required: ['findings', 'questions', 'done'],
        properties: {
          findings: { type: 'array', maxItems: 4, items: { type: 'string', maxLength: 1024 } },
          questions: { type: 'array', maxItems: 4, items: { type: 'string', maxLength: 1024 } },
          done: { type: 'boolean' },
        },
      },
    },
    {
      id: 'extra', kind: 'native', dependsOn: ['inspect'], agentId: 'reviewer',
      when: { op: 'boolean', value: { ref: { source: 'inputs', path: ['extraReview'] } } },
      prompt: 'Only if scheduled: independently review these findings against the supplied targets, read-only. Return a JSON string.',
      inputs: {
        targets: { ref: { source: 'inputs', path: ['targets'] } },
        findings: { ref: { source: 'step', stepId: 'inspect', path: [] } },
      },
      outputSchema: { type: 'string', maxLength: 1024 },
    },
    {
      id: 'coverage', kind: 'aggregate', dependsOn: ['inspect', 'extra'], operation: 'collect', consumeSkips: true,
      inputs: {
        inspection: { ref: { source: 'step', stepId: 'inspect', path: [] } },
        additionalReview: { ref: { source: 'step', stepId: 'extra', path: [] } },
      },
    },
    {
      id: 'refine', kind: 'repeat', dependsOn: ['inspect', 'coverage'],
      initial: { ref: { source: 'step', stepId: 'inspect', path: [] } },
      stateSchema: {
        type: 'object', additionalProperties: false, required: ['findings', 'questions', 'done'],
        properties: {
          findings: { type: 'array', maxItems: 4, items: { type: 'string', maxLength: 1024 } },
          questions: { type: 'array', maxItems: 4, items: { type: 'string', maxLength: 1024 } },
          done: { type: 'boolean' },
        },
      },
      outputSchema: {
        type: 'object', additionalProperties: false, required: ['findings', 'questions', 'done'],
        properties: {
          findings: { type: 'array', maxItems: 4, items: { type: 'string', maxLength: 1024 } },
          questions: { type: 'array', maxItems: 4, items: { type: 'string', maxLength: 1024 } },
          done: { type: 'boolean' },
        },
      },
      maxIterations: 3,
      body: [
        {
          id: 'revise', kind: 'native', dependsOn: [], agentId: 'generalist',
          prompt: 'Read only the supplied targets. Refine the previous structured findings and remaining questions and return schema JSON; no edits or shell commands.',
          inputs: {
            targets: { ref: { source: 'inputs', path: ['targets'] } },
            prior: { ref: { source: 'iteration', path: [] } },
          },
          outputSchema: {
            type: 'object', additionalProperties: false, required: ['findings', 'questions', 'done'],
            properties: {
              findings: { type: 'array', maxItems: 4, items: { type: 'string', maxLength: 1024 } },
              questions: { type: 'array', maxItems: 4, items: { type: 'string', maxLength: 1024 } },
              done: { type: 'boolean' },
            },
          },
        },
        {
          id: 'assess', kind: 'native', dependsOn: ['revise'], agentId: 'reviewer',
          prompt: 'Independently assess these refined findings using read-only inspection of the supplied targets. Preserve unresolved questions and set done only when none remain; this is your assessment, not proof. Return schema JSON.',
          inputs: {
            targets: { ref: { source: 'inputs', path: ['targets'] } },
            findings: { ref: { source: 'step', stepId: 'revise', path: [] } },
          },
          outputSchema: {
            type: 'object', additionalProperties: false, required: ['findings', 'questions', 'done'],
            properties: {
              findings: { type: 'array', maxItems: 4, items: { type: 'string', maxLength: 1024 } },
              questions: { type: 'array', maxItems: 4, items: { type: 'string', maxLength: 1024 } },
              done: { type: 'boolean' },
            },
          },
        },
      ],
      feedback: { ref: { source: 'step', stepId: 'assess', path: [] } },
      until: { op: 'boolean', value: { ref: { source: 'iteration', path: ['done'] } } },
      output: { ref: { source: 'iteration', path: [] } },
    },
    {
      id: 'report', kind: 'aggregate', dependsOn: ['coverage', 'refine'], operation: 'collect', consumeFailures: true,
      inputs: {
        coverage: { ref: { source: 'step', stepId: 'coverage', path: [] } },
        findings: { ref: { source: 'step', stepId: 'refine', path: [] } },
      },
    },
  ],
};
export const CONDITIONAL_REFINEMENT_DEFINITION = Object.freeze(conditionalRefinementGraph);
