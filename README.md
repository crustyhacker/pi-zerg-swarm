# pi-zerg-swarm

`pi-zerg-swarm` is a Pi coding-agent extension for native configurable agent teams, direct structured control, and zerg-style subagent orchestration. It is **not** a Raspberry Pi hardware swarm project.


> **v1.1.17 release status**
> Adds opt-in, explicitly authorized staged coding workflows with independent review and separate implementation/application approvals. Existing read-only workflows stay read-only.
> Restart restores inspectable history, not execution or authority. Checks execute trusted project code with host permissions; there is no filesystem/network sandbox or automatic Git operation.

## Release status

- Current release: **v1.1.18** (explicit durable workflow recovery and fresh approval gates).
- Historical milestones preserved for audit traceability: v0.8.0 implementation milestone and v0.8.1 audit follow-up patch.
- The release path requires general, milestone, security, performance, hardening, and cleanup audits.
- Canonical repository metadata is configured for the public repo: https://github.com/fluxgear/pi-zerg-swarm.

## Pi compatibility

Tested with **Pi 1.0.0** (`@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui`). Requires **Node.js 22.19.0 or newer**, matching the current Pi host requirement.

Pi supplies its SDK and TUI libraries to installed extensions. They are declared as host-provided peer dependencies, with Pi 1.0.0 development dependencies for local checks, rather than bundled runtime copies. Native runs use Pi's `ModelRuntime` for model selection and credentials.

## Commands

- `/zerg` — canonical command
- `/zerg-swarm` — alias
- `/swarm` — alias

At v1.1.0 these commands display help, status, expanded tree visibility, deterministic thinking-step parser output, Claude Code-style runtime agent-definition configuration, native Pi SDK-backed run execution, task-first subagent spawn state, explicit fresh/fork launch-mode metadata, command-host permission queue state, fine-grained lifecycle substate hints, bounded structured log/output inspection, restart-durable run/log recovery snapshots, process-lifetime background run status/interrupt/message support, and a componentized Pi-native interactive management TUI for live tree/detail/settings/chat/footer management views through snapshot-safe shared-state-backed Pi command handlers.
Command-host control grammar is available via `/zerg mode status|manual|assisted|automatic|revert [reason]`, `/zerg intervene agent|subagent|leader ...`, `/zerg agents list|show|create|update|delete` with per-agent `--model`, `--fallback-models`, `--max-turns`, tools, and permission settings, `/zerg agent`/`/zerg team` lifecycle configuration flags for team leaders/members/model metadata, `/zerg runs list|show <run-id>`, `/zerg permission status|list|request|approve|deny|cancel`, `/zerg logs status|list|show|json`, `/zerg config`, and `/zerg run <agent-or-team> <task> [--bg] [--fresh|--fork] [--model <model>]`; `/zerg run` does not require `pi-subagents` and uses the native Pi SDK runner when no slash bridge responds.

`/zerg config` is intended to stay simple: **Select** an agent/team/task, use **Settings** for mode/read-only/controller/permissions, and use **Message** to record an operator intervention. Press **v** in the tree/detail pane for the separate coding overlay, or **t** on a team/run for its timeline. The explicit live composer is distinct from the management intervention history. The overlay uses Pi theme colors when available and keeps the current key hints visible in the footer.

## Direct automation API

Automation should prefer structured control over terminal automation:

```ts
import { createZergControl } from 'pi-zerg-swarm';

const control = createZergControl({}, { persistence: { enabled: true, rootDir: process.cwd() } });
await control.execute({ action: 'agents.create', id: 'worker', prompt: 'Work directly.' });
const run = await control.execute({ action: 'run', agent: 'worker', task: 'Investigate', background: true });
const status = await control.execute({ action: 'runs.show', runId: run.runId! });
```

`registerZergSwarmExtension(...)` also registers a Pi custom tool named `zerg_control` when the installed Pi extension API exposes `registerTool(...)`. The tool calls the same structured control core and returns JSON-compatible `details`; callers do not need to parse slash-command output. Slash commands remain the human-facing wrapper.

Background jobs are inspectable through `/zerg runs`, `/zerg logs`, direct `runs.*`/`logs.list`, and `/zerg interrupt`/`{ action: 'interrupt' }` while the Pi process/session remains alive. v1.1.0 also supports opt-in durable snapshots under `.pi/zerg-swarm/v1/state.json` through `persistence: { enabled: true, rootDir }`, so restart can recover run/log history and mark previously active sessions as `needs-attention` instead of losing them.

Snapshots have a **64 MiB serialized UTF-8 byte limit**. Loading uses a verified regular-file descriptor and bounded reads, including a growth check; oversized or invalid inputs report `lastLoadError` without modifying the file or replacing current state. Oversized saves are rejected before temporary-file creation, leaving the previous snapshot intact. Exclusive temporary files and failure cleanup protect against pre-existing temporary-file collisions. A currently enabled read-only setting remains enabled after recovery, even if the saved state was writable.

Valid snapshot symlinks to regular files retain their existing load behavior; missing/dangling links behave as missing snapshots. Saving still atomically replaces the configured path itself, **not the symlink target**. This is not filesystem confinement, multi-writer coordination, or fsync/power-loss protection; use one owner per snapshot file. The separate native JSONL viewer limits remain unchanged.

If an external adapter throws during launch, execution may already have started. Zerg preserves observed terminal state or reports `needs-attention` with the original run/task identities; inspect manually rather than automatically retrying. Admission checks do not revoke capabilities from an already-running external adapter.

## Declarative read-only workflows

Workflows coordinate native single-agent units outside the parent conversation. They reuse existing agent definitions, run/task/Pi identities, logs, coding views, cancellation, and opt-in snapshots. There is no separate agent runtime, transcript mirror, daemon, or model-driven scheduler. Background execution lasts only while its owning Pi process is alive.

### Start the review preset

The built-in `read-only-review` performs discovery → parallel reviews → finding collection → independent verification → deduplicated report. It uses the existing `generalist` definition for discovery and `reviewer` for review/verification. First configure **explicit, available provider/model IDs** on those definitions; replace the placeholders below. Unsupported turn limits, fallback models, and permission overrides must be cleared.

```text
/zerg agents update generalist --model provider/model
/zerg agents update reviewer --model provider/model
/zerg workflows start {"definitionId":"read-only-review","inputs":{"candidatePaths":["index.ts"],"scope":"Review the supplied source without changing files"},"concurrency":8}
/zerg workflows monitor
```

The preset accepts 1–16 unique normalized relative candidate paths and a nonempty scope. Discovery may select only those candidates; each target produces at most two findings, with at most 32 verifications. Failed reviews, missing/mismatched/duplicate verifier IDs, disagreement, and unselected coverage remain visible. Partial coverage is **not** overall success. Verdicts are model evidence, not proof that findings are true.

Use structured `zerg_control` or `control.execute(...)` for automation:

| Action | Required fields / meaning |
| --- | --- |
| `workflows.list` | Compact definition/attempt summaries; no intermediate results or per-unit identity dump |
| `workflows.define` | `definition`: validated version-1 graph or version-2 conditional/repeat graph; replaces a name only when its prior work is settled |
| `workflows.show` | Exactly one of `definitionId` or `workflowRunId`; attempt view includes exact unit/native correlations |
| `workflows.start` | `definitionId`, `inputs`, optional `concurrency`; returns a fresh `data.view.workflowRunId` |
| `workflows.pause` / `workflows.resume` | `workflowRunId`; pause blocks new admission, not already-admitted work |
| `workflows.cancel` | `workflowRunId`; requests owned cancellation promptly, even after control becomes read-only |
| `workflows.retry` | `workflowRunId`; explicit new attempt in the same family, not in-place replay |
| `workflows.report` | `workflowRunId`; explicitly retrieves the final report, when available |
| `workflows.forget` | `workflowRunId`; explicitly removes a terminal, cleanup-settled workflow record, not its native history |

Slash equivalents use `/zerg workflows list`, `define <JSON>`, `start <JSON>`, `show {"workflowRunId":"..."}` (or `definitionId`), and `pause|resume|cancel|retry|report|forget <workflow-run-id>`. `/zerg workflows monitor [workflow-run-id]` adds the interactive view; aliases remain supported and noninteractive inspection does not require a TUI.

In the monitor, **Enter** drills from attempts to steps to units to an explicitly selected bounded result. **p** pauses/resumes, **x** cancels the whole selected workflow, and **r**, then **Enter on the rendered confirmation**, starts a new retry attempt. **c** opens the selected unit's exact native coding view; returning creates a fresh monitor instance. **q/Esc/Ctrl+C** closes the view, not the workflow. Stale selection cannot retarget an action. Active workflow units reject steer/follow-up messages to preserve frozen inputs; ordinary native messaging is unchanged.

### Define a small graph

Definitions are plain JSON, never executable code. For example, with an explicitly configured `reviewer`:

```ts
import type { WorkflowDefinition } from 'pi-zerg-swarm';

const definition: WorkflowDefinition = {
  id: 'review-one', version: 1, label: 'One read-only review',
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['target'],
    properties: { target: { type: 'string', maxLength: 512 } },
  },
  steps: [{
    id: 'review', kind: 'native', agentId: 'reviewer', dependsOn: [],
    prompt: 'Read target without changes. Return ONLY a JSON string summarizing evidence.',
    inputs: { target: { ref: { source: 'inputs', path: ['target'] } } },
    outputSchema: { type: 'string', maxLength: 8192 },
  }],
};
await control.execute({ action: 'workflows.define', definition });
await control.execute({ action: 'workflows.start', definitionId: definition.id, inputs: { target: 'index.ts' } });
```

- Steps have unique IDs and explicit `dependsOn` edges. Cycles, unknown references, unsupported fields, and excessive graphs are rejected before admission.
- Input bindings are `{ value: <JSON> }` or `{ ref: { source: 'inputs' | 'step' | 'item', path: [...], stepId?: 'dependency-id' } }`. Step references must name explicit dependencies. Paths into single native results are schema-checked; fan-out/aggregate results are referenced as whole envelopes.
- Native steps may declare `fanout: { from: <reference>, maxItems: N }` over a bounded array. Version 2 additionally supports the deterministic conditions and bounded repeat blocks below. There is no JavaScript, expression-string evaluation, shell step, write-capable workflow worker, team/fork step, or nested delegation.
- Deterministic aggregate steps use `kind: 'aggregate'`, `operation: 'collect' | 'collect-findings' | 'review-report'`, and input bindings. Only aggregates can explicitly set `consumeFailures: true`; otherwise unsuccessful dependencies skip downstream work. Review-specific aggregates expect the preset's envelope shapes.
- The schema subset supports closed objects, required properties, bounded arrays/strings, numbers/integers, booleans, null, and finite enums. No external references or regex/evaluation language. `maxLength` uses JavaScript string length; independent UTF-8 byte limits also apply.

### Typed conditions and bounded repetition (version 2)

Existing **version-1 definitions and the `read-only-review` preset are unchanged**. Opt in with `version: 2`; version-2 fields on version 1 and unsupported future versions are rejected. The existing version-1 snapshot namespace stores both formats, discriminated by each frozen definition's version. No second scheduler or transcript store is introduced.

A native, aggregate, or repeat step can declare `when`. Conditions are plain data:

| Condition | Fields | Meaning |
| --- | --- | --- |
| `boolean` | `value: <binding>` | A strictly boolean value |
| `eq` / `ne` | `left`, `right` bindings | Strict scalar equality/inequality |
| `lt` / `lte` / `gt` / `gte` | `left`, `right` bindings | Finite numeric comparison |
| `all` / `any` | `conditions: [...]` | Bounded conjunction/disjunction |
| `not` | `condition: {...}` | Boolean negation |

Bindings retain the `{value: ...}` / `{ref: ...}` syntax. Equality supports compatible scalar types, not object/array equality or coercion; integers and numbers are numeric. Conditions allow at most 8 expression levels, 64 nodes, and 16 children per composition. Every operand is validated and evaluated: an unavailable/missing value is an error even in a branch that would be unnecessary under short-circuit evaluation. References use explicit schema-checked path segments, never arbitrary property traversal. A step condition runs after dependencies settle and before materialization/native setup; it cannot reference a fan-out item.

A false condition records `condition-false` with **no unit, native identity, or fabricated result**. Dependency-blocked, cancelled, and recovered/unverified work remain distinguishable. An aggregate can explicitly set `consumeSkips: true` and bind an unavailable branch's **whole** output to receive a status envelope instead of a result. `consumeFailures: true` remains a separate opt-in. These joins do not convert required worker failures into overall success; deliberate condition skips alone are not failures. Ordinary downstream steps still require successful dependencies.

A repeat block declares:

```text
kind: "repeat"
initial: <binding>       stateSchema: <schema>
body: <non-nested DAG>   maxIterations: <integer 1..32>
feedback: <binding>     until: <condition>
output: <binding>       outputSchema: <schema>
```

The first iteration always runs from validated `initial` state. Body nodes support ordinary native steps, conditions, bounded fan-out, and compatible deterministic aggregates. `source: 'inputs'` still means original workflow inputs; `source: 'iteration'` means the current iteration's frozen state. Body `step` references name only explicit body dependencies—never outer nodes, earlier iterations, or future nodes.

After **all body work and native cleanup settle successfully** (allowing intentional skips), `feedback` selects current-body data or iteration state and validates it against `stateSchema`. `until` then reads only literals and the validated **next feedback state** through `source: 'iteration'`. If true, `output` selects that next state or current-body data and validates it against `outputSchema`. Otherwise the next iteration may start only after fresh authority, pause/cancellation, and budget checks. No previous conversation history is copied between iterations.

Failure, invalid feedback, missing termination data, cancellation, or uncertain cleanup prevents another iteration. A false condition at `maxIterations` is **non-convergence**, not success. Earlier structured observations remain bounded diagnostic history, not a verified final result. Explicit failure-consuming aggregates receive an unavailable envelope with termination and diagnostic iteration provenance; feedback larger than 16 KiB is represented there by its hash, while the bounded iteration ledger retains the feedback. `workflows.report` includes the orchestration view: use its repeat termination reason alongside report data, rather than treating a model's `done` field as independent proof of correctness.

### Trusted-host staged coding workflows (version 3, Stage 8B)

Version 3 is an explicit opt-in for trusted-host staged coding. Existing version-1 and version-2 workflow definitions remain read-only; adding a coding policy is rejected unless the definition itself uses `version: 3`. Defining or starting a workflow, inputs, prompts, and model output do **not** grant coding authority. A trusted owner must supply project/staging/check configuration through `registerZergSwarmExtension(..., { coding: { ... } })` or `createZergControl(..., { coding: { ... } })`, and the operator must grant each distinct approval. Applied-source validation passes build, package checks, and 630 tests with zero skips, including isolated actual SDK and regular/fullscreen Pi-host acceptance. This is scripted loopback evidence, not manual visual acceptance or real-model coding-quality evidence.

The default extension has no trusted coding project/staging/check configuration. Supplying ordinary `zerg_control` workflow actions can define/start/show/pause/cancel/retry/report workflows, but it cannot approve coding gates. The host-only API is `control.workflowApprovals` (or `workflowService.approvals` inside an owner integration). Interactive slash approval is deliberately human mediated:

```text
/zerg workflows show {"workflowRunId":"<exact-run-id>"}
/zerg workflows approve <exact-run-id> <approval-id>
```

The approve command requires `ui.confirm`, displays the exact bounded approval payload/fingerprint, rechecks the pending request after the modal, and then grants that exact fingerprint. There is no model-facing `confirm=true` path and ordinary `zerg_control` is no-approve.

The coding journey is:

1. `investigate`: read-only snapshot investigation through staged read/inspect tools only.
2. Operator reviews the implementation approval payload: full task, identity, bounded file scope, baseline, writable/readonly paths, check profiles, hashes, limits, and disclosures.
3. `stage-write`: writer receives only staged writable files and produces a candidate in a private stage.
4. `check`: runtime executes the approved deterministic profile (`executable` + `argv` + `cwd` + env) against the stage.
5. `review`: an independent read-only native reviewer receives the exact candidate, scope, task, and actual check evidence, including failures; it cannot write or approve application.
6. A bounded Stage 8A `repeat` can feed findings and settled failed-check evidence into another correction, retaining the candidate. Each change invalidates affected checks/review. Reviewer approval cannot turn a failed check into success; unresolved failures or iteration exhaustion block application.
7. Operator reviews the exact application approval payload bound to candidate hash, evidence hash, target baseline, and changed paths.
8. `apply`: runtime applies the exact approved candidate deterministically to the real project files.

Remember: **Prepared != checked != reviewed != approved != applied**. Application-capable policies require staged writing, checking, independent review, `reviewRequired: true`, and at least one approved check profile. A candidate may be prepared but fail gates, await application approval, or fail/partially apply after approval if destination state changes. Implementation authorization covers only its reviewed bounds; new scope, commands, or capabilities need a new request.

Supported file handling is intentionally narrow. Explicit UTF-8 text inputs and exact writable relative paths have hard limits of 32 files, 256 KiB per file, and 1 MiB total; workflow definition, evidence, and ledger budgets may impose smaller limits. Symlink components, hardlinks, hidden/protected paths, special files, executable inputs, and path escapes are rejected. Text-file edits and creation under existing real parent directories are supported. Generated outputs, dependency installation, binaries, deletion, renames, permission changes, and directory creation are unsupported. Workflow leases detect other workflow owners; they do not exclude unrelated editors or processes.

Dependency preparation is explicit: only manifested read-only text inputs are copied into the owned stage, with no automatic repository/dependency-tree copy or shared writable dependency link. Checks require Linux, an existing `/usr/bin/python3` with subreaper and pidfd support, and the bundled `workflow-check-supervisor.py`; unsupported or unverified cleanup fails closed. Exact executable/argv, working directory, minimal environment, time/output bounds, and actual candidate identity are recorded. Checks execute trusted project code with host permissions, **not** a filesystem or network sandbox. Command allowlisting and descendant supervision do not confine arbitrary project code. No downloads or external services are enabled automatically.

Cancellation stops subsequent admissions and writes where possible; it cannot undo a completed write. Apply is per file, not atomic across all files, and there is no automatic rollback or Git operation. Partial/uncertain outcomes retain evidence for inspection; settled ownership release does not delete retained candidates. Cleanup is restricted to provably owned artifacts, and uncertain application cannot be erased through generic forget. Restart is inspect-only: no live grants, native reconnection, automatic checks/application/rollback, or mutating retry. The Stage 8C implementation below adds explicit reconciliation and fresh authority, not automatic restart execution; retained paths alone prove neither ownership nor integrity.

A compile-tested disposable-project builder is exported directly from `workflow-coding-example.ts` (not from the package index):

```ts
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createZergControl } from 'pi-zerg-swarm';
import { buildTrustedCodingWorkflowExample } from 'pi-zerg-swarm/workflow-coding-example.ts';

const projectRoot = mkdtempSync(join(tmpdir(), 'zerg-coding-project-'));
const stagingParent = mkdtempSync(join(tmpdir(), 'zerg-coding-staging-'));
mkdirSync(join(projectRoot, 'src'));
const example = buildTrustedCodingWorkflowExample({ projectRoot, stagingParent, model: 'provider/model' });
for (const [path, text] of Object.entries(example.initialFiles)) {
  writeFileSync(join(projectRoot, path), text, { flag: 'wx' });
}

const control = createZergControl({}, { coding: example.coding });
await control.execute({ action: 'agents.create', id: 'worker', prompt: 'Use workflow coding tools only.', model: 'provider/model' });
await control.execute({ action: 'agents.create', id: 'reviewer', prompt: 'Independently review staged coding candidates.', model: 'provider/model' });
await control.execute({ action: 'workflows.define', definition: example.definition });
const started = await control.execute({ action: 'workflows.start', definitionId: example.definition.id, inputs: {}, concurrency: 1 });

// Wait for investigation to finish and inspect the exact pending request.
// Only trusted operator code may grant it after reviewing the full payload.
const pending = control.workflowApprovals.inspect().filter(r => r.status === 'pending');
// control.workflowApprovals.grantFingerprint(pending[0].id, pending[0].requestHash);
// Application has its own later request: never auto-grant it from model output.
```

For packaged consumers, the package allowlist includes the public workflow TypeScript modules, `workflow-check-supervisor.py`, and `workflow-coding-example.ts`; private agent artifacts remain excluded.

### Explicit workflow recovery (Stage 8C)

Version 1.1.18 adds opt-in explicit recovery under the conservative execution contract below. Applied-source tests, isolated SDK/host acceptance, and independent release review pass. Workflow recovery is distinct from `session.continuation.*`, which copies selected native history into a new task.

#### Inspect first; nothing replays

Recovery is opt-in through trusted host options `recovery: { enabled: true }` together with enabled persistence. Startup, `workflows.recovery.inspect`, and `workflows.recovery.prepare` are inert: no native/model calls, checks, stage creation/adoption, application, writer acquisition, or cleanup. Missing/corrupt evidence is retained, not repaired. A restored run is inspectable history, not a live SDK session; persisted selections never restore execution plans or approvals.

```text
/zerg workflows recovery inspect <workflow-run-id>
/zerg workflows recovery prepare <workflow-run-id>
```

Aliases `/zerg-swarm` and `/swarm` keep the same grammar. Structured actions use `workflowRunId`; `workflows.recovery.prepare` additionally accepts `selections: { reuseUnitIds, rerunUnitIds }`. Both return `data.assessment`; a successful read does not mean its plan is executable. Examine `blocked`, `plan.status`, and `fingerprint` (passed to authorization as `assessmentFingerprint`).

Keep **original recorded history** separate from **current observations**. `recoveryOriginal` preserves first recovered statuses; operation intents/results, original iterations, feedback, errors, and native identities remain history. Later verified owner/check/native settlement and destination byte observations do not rewrite recorded cleanup uncertainty or manufacture an old completion. Missing or uncertain receipts are not proof that an effect did or did not happen. Destination preimage/postimage equality is a current observation, not actor attribution.

#### Settlement is a trusted-host proof, not a model flag

Default interrupted native settlement is **unknown**. Checks require exact verified supervisor/receipt settlement; absent PIDs, supervisors, or elapsed time alone never establish that descendants or transport work stopped. Unknown relevant owner/check/native settlement blocks conflicting execution.

The optional synchronous trusted-host callback is `recovery.inspectNativeSettlement(request): 'settled' | 'unknown'`. Its exact request contains `workflowRunId`, `familyId`, `unitId`, `operationId`, `native` (the exact identity or `null`), `inputHash`, `dependencyHash`, and `policyHash`. Return `settled` only for caller-owned lifecycle evidence positively binding **all** those fields and proving the relevant owned work/transport/descendants closed. Missing, mismatched, unsupported, or unreadable evidence must return `unknown`. This callback is an observation, not implementation/application authority, result reuse, an environment snapshot, or a model-supplied boolean. A `settled` return must attest irreversible closure of the exact owned work, not temporary idleness or a revocable permission. The runtime rejects observed unknown/drift and checks physical owner/check/artifact fences, but repeated enum reads cannot certify hidden revocation by an adversarial final host callback. Such a host must supply immutable verified lifecycle-proof semantics or leave settlement unknown.

There is no positive generic native closure contract supplied by the default SDK host. A narrowly sealed, independently supervised local transport fixture can prove its own closure; that is not a production-wide settlement provider. Do not substitute an always-settled callback or infer closure from PID absence.

#### Select exactly, then confirm through the trusted host

Preparation exposes bounded `plan.executionAddresses`, `recommendedSelections`, `repeatFrontiers`, `correctionUsage`, and `effectiveScopes`. The current conservative route requires explicit rerun selection of **all potential native/coding addresses** derived from frozen `maxIterations`/`maxItems`, including future repeat/fan-out slots. Potential addresses are not admissions: only materialized work consumes admission budgets. Empty/partial/duplicate/overlapping/unknown selections block. Recommendations are data, never permission. Reprepare with the exact selection and review the **new fingerprint**, full addresses/counts, scopes, settlement observations, budgets, and fresh gates.

In the workflow monitor, **n** prepares; **s** applies recommendations only to a new read-only preparation; **a** arms the exact displayed proof. After that proof renders, **Enter** invokes host confirmation. Nothing is authorized by n/s/a alone. Changed observations/fingerprint, navigation, closing, or incomplete/clipped disclosure invalidates confirmation; a proof that cannot be displayed completely cannot authorize through that pane. Closing a view does not cancel a submitted child.

The host-only API is `control.workflowRecovery.authorize({ workflowRunId, assessmentFingerprint, selections }, signal?)`, returning a `WorkflowReply` (direct `view`/`assessment`, unlike `control.execute`'s `data` wrapper). It is optional and requires a recovery-enabled owner. The service-level equivalent is `workflowService.recovery.authorize`. There is **no model-callable recovery grant, slash JSON confirmation flag, or persisted grant authority**. Ordinary slash/structured recovery commands inspect/prepare only.

Public SDK example (inspection only):

```ts
import { createZergControl } from 'pi-zerg-swarm';

const control = createZergControl({}, {
  persistence: { enabled: true, rootDir: process.cwd() },
  recovery: {
    enabled: true,
    inspectNativeSettlement: (_request) => {
      // Safe placeholder: no externally owned lifecycle proof is supplied.
      // A real trusted host must verify exact request binding AND closure.
      return 'unknown';
    },
  },
  // Coding continuation also needs separately reviewed trusted coding config.
});
const workflowRunId = '<exact-retained-workflow-run-id>';
const prepared = await control.execute({
  action: 'workflows.recovery.prepare', workflowRunId,
});
// Inspect prepared.data.assessment. Unknown settlement deliberately blocks.
// Reprepare with explicitly chosen selections; review its new fingerprint.
// Do not call authorize automatically from recommendations or model output.
```

Only after a trusted operator reviews an eligible, exact re-prepared assessment may host code call `control.workflowRecovery.authorize` with that assessment's fingerprint and the same explicit selections. Writer fencing and revalidation precede durable publication of one linked child (`recoveryOf`/origin and source selection). Repeated confirmation returns that child or fails, never allocates another. Admission is not completion. Relevant drift, read-only mode, cancellation, stale snapshot/owner/scope, competing selection, uncertain acquisition/publication, or poisoned persistence blocks further effects; uncertain committed state is retained, not rolled back or silently retried. A selected child interrupted before admission is inert on restart and needs a new assessment/linked confirmation, not ordinary mutating retry.

#### Fresh attempt, fresh gates, bounded family

Continuation uses the existing scheduler and a new linked attempt with fresh task/run/Pi identities, **not reconnection**. An eligible retained managed candidate can be carried into a newly owned stage under current exact scope; original artifacts remain evidence. Carried bytes are **not reuse of an old completed writer**. The coding route requires fresh implementation authority, a new writer that inspects/refines those bytes, new approved checks, independent read-only review, and **separate exact application approval**. Confirmation alone grants none of those coding approvals. Already-satisfied destination paths become read-only effective scope, are freshly revalidated before effects, and are skipped by application writes. Conflicting/unknown destinations block.

The current **all-satisfied, zero-write completion shortcut is blocked** until an explicit current-observation completion validator and fresh host decision exist. Inspection may show `alreadySatisfiedReadonlyPaths`; it must not invent writer/application completion from byte equality.

- Family limits remain **3 attempts / 256 admissions**, cumulative across linked attempts; per-file receipts have separate bounds and are not extra unit admissions. Exhaustion blocks before effects/publication.
- Each repeat block retains its frozen writer allowance: the first admitted writer is initial work, later writer admissions (including rerunning an attempted frontier) consume corrections. Failed/cancelled/interrupted work is not refunded; limits derive from frozen repeat/coding `maxIterations`, not a new `maxCorrections` field. Retain family anchors, every ancestor, and referenced provenance; forgetting cannot reset budgets or erase unresolved evidence.
- Generic native/check/review result reuse is disabled without positive trusted versioned input/dependency/policy/environment capture and settled evidence. Current capture is unknown, so repeat reconstruction normally starts at **frontier zero**, with later source history retained rather than copied as valid completion. No generic environment capture is provided. Deterministic aggregates recompute from actual ordered envelopes; candidate carry is a separate byte operation.

#### Guarantee boundary and validation

The durable contract is for **Linux local filesystems**: exact boot/PID/start identity, a process-lifetime writer generation, exclusive snapshot-adjacent claim, expected-head fencing, and owned lease/manifest identities. Read-only inspection does not acquire those locks or clean them up. Live/unreadable/contradictory owners, incomplete claims, malformed evidence, stale artifacts, and unsupported multi-generation reconciliation remain blocked; there is no age-based takeover or unrelated process killing. Save-before-publication and per-effect intent/observation failures stop admission and preserve uncertainty, including after-effect failures.

Bounded metadata, no-follow evidence reads, ownership checks, and fsync are not an OS sandbox, arbitrary-project containment, exactly-once execution, or power-loss certification. Checks still execute trusted project code with host permissions. Recovery never automatically invokes Git, installs dependencies, publishes to npm, calls external providers, or runs external triggers; newly authorized native work still uses its explicit current model. Ordinary legacy snapshot/native-history compatibility is separate from this stricter recovery contract.

New isolated SDK and regular/fullscreen Pi-host recovery fixtures use actual native sessions/tools, owned process interruption, exact loopback transport closure proof, fresh writer/check/independent review, and separate application. The synchronized applied-source suite, all three new transport journeys, and independent release review pass. Scripted local evidence does not certify real-model coding quality, manual visual usability, universal Pi compatibility, or unsupported generic native settlement.

#### Read-only refinement example

Configure explicit provider/model IDs on `generalist` and `reviewer` first. This separate example does not modify the preset. It inspects supplied targets, conditionally adds a review, then refines findings and independently assesses remaining questions for at most three iterations:

```ts
import type { WorkflowBinding, WorkflowDefinition, WorkflowRef, WorkflowSchema } from 'pi-zerg-swarm';

const text: WorkflowSchema = { type: 'string', maxLength: 2048 };
const stateSchema: WorkflowSchema = {
  type: 'object', additionalProperties: false,
  required: ['findings', 'questions', 'done'],
  properties: {
    findings: { type: 'array', maxItems: 4, items: text },
    questions: { type: 'array', maxItems: 4, items: text },
    done: { type: 'boolean' },
  },
};
// Authoring helper only: no functions enter the submitted JSON definition.
const ref = (source: WorkflowRef['source'], path: string[] = [], stepId?: string): WorkflowBinding => ({ ref: {
  source, path, ...(stepId ? { stepId } : {}),
} });
const definition: WorkflowDefinition = {
  id: 'bounded-read-only-refinement', version: 2, label: 'Read-only refinement',
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['targets', 'extraReview'],
    properties: {
      targets: { type: 'array', maxItems: 4, items: { type: 'string', maxLength: 512 } },
      extraReview: { type: 'boolean' },
    },
  },
  steps: [
    { id: 'inspect', kind: 'native', dependsOn: [], agentId: 'generalist',
      prompt: 'Read only the supplied targets. Return structured findings and open questions; no edits or shell commands.',
      inputs: { targets: ref('inputs', ['targets']) }, outputSchema: stateSchema },
    { id: 'extra', kind: 'native', dependsOn: ['inspect'], agentId: 'reviewer',
      when: { op: 'boolean', value: ref('inputs', ['extraReview']) },
      prompt: 'Independently review these findings against supplied targets, read-only. Return a JSON string.',
      inputs: { targets: ref('inputs', ['targets']), findings: ref('step', [], 'inspect') },
      outputSchema: text },
    { id: 'coverage', kind: 'aggregate', operation: 'collect', consumeSkips: true,
      dependsOn: ['inspect', 'extra'],
      inputs: { inspection: ref('step', [], 'inspect'), additionalReview: ref('step', [], 'extra') } },
    { id: 'refine', kind: 'repeat', dependsOn: ['inspect', 'coverage'],
      initial: ref('step', [], 'inspect'), stateSchema, maxIterations: 3,
      body: [
        { id: 'revise', kind: 'native', dependsOn: [], agentId: 'generalist',
          prompt: 'Read only supplied targets. Refine the structured findings and remaining questions; return schema JSON.',
          inputs: { targets: ref('inputs', ['targets']), prior: ref('iteration') },
          outputSchema: stateSchema },
        { id: 'assess', kind: 'native', dependsOn: ['revise'], agentId: 'reviewer',
          prompt: 'Independently assess these findings using read-only inspection of supplied targets. Preserve unresolved questions. Set done only if none remain; this is your assessment, not proof. Return schema JSON.',
          inputs: { targets: ref('inputs', ['targets']), findings: ref('step', [], 'revise') },
          outputSchema: stateSchema },
      ],
      feedback: ref('step', [], 'assess'),
      until: { op: 'boolean', value: ref('iteration', ['done']) },
      output: ref('iteration'), outputSchema: stateSchema },
    { id: 'report', kind: 'aggregate', operation: 'collect', consumeFailures: true,
      dependsOn: ['coverage', 'refine'],
      inputs: { coverage: ref('step', [], 'coverage'), findings: ref('step', [], 'refine') } },
  ],
};

await control.execute({ action: 'workflows.define', definition });
const started = await control.execute({ action: 'workflows.start',
  definitionId: definition.id, inputs: { targets: ['README.md'], extraReview: false } });
// Later, after inspecting progress:
await control.execute({ action: 'workflows.report',
  workflowRunId: started.data.view.workflowRunId });
```

For two alternative branches, give one `when: condition` and the other `when: {op: 'not', condition}`; join both with an explicit `collect` aggregate and `consumeSkips: true`, then make the common reporting step depend on that join. Missing values still fail either condition rather than silently selecting the other branch.

The monitor shows selection/skip reasons, current/max iteration, and termination/non-convergence. Enter drills into the exact iteration, body step, and unit; **c** opens that unit's native coding view. Stable qualified identities, not visible row positions, preserve selection on return. Closing the monitor does not cancel work.

### Authority, bounds, retries, and recovery

- Each attempt freezes its definition, declared JSON inputs, agent definitions, and explicit model selections. Relevant current-agent/model/tool drift fails closed. Effective tools are the definition's expanded tools minus denials, **intersected with `read`, `grep`, `find`, `ls`**; an empty intersection is refused. Broad definitions are restricted, not silently granted new tools. Replacement builtins and dynamically activated gateways are refused.
- Starting work authorizes normal current Pi resources and hooks. Outputs/source text remain data, not permission. Read-only tools are not filesystem confinement or an OS sandbox, and trusted extensions are not universally certified. Zerg's read-only **control mode** blocks new workflow execution; it is separate from the workflow's read-only tool policy.
- Limits: **16 authored steps including repeat containers and body nodes**, **32 fan-out items**, at most **32 iterations per repeat**, concurrency **1–32** (default **8**), **3 attempts** and at most **256 native admissions per family**. Validation conservatively counts every conditional branch, fan-out bound, and repeat iteration, budgets all three attempts, and caps expanded orchestration nodes at 256 per attempt. Runtime ledger/admission limits still apply; these are not increased for loops. Iterations are sequential; independent body work shares the same workflow-wide permits. An owner also shares a conservative ceiling no greater than its most restrictive unsettled workflow's concurrency; this is not a provider-wide limit. Bounded iteration/admission counts do **not** guarantee bounded provider cost or wall-clock duration.
- A permit covers native setup, execution, and owned cleanup—not just the final answer. Pause does not free active permits; cancel may remain `cancelling`. Missing/uncertain cleanup is `needs-attention`, blocks further admission/retry, and is not represented as successful disposal. Unit states distinguish completed, failed, cancelled, skipped, and unverified work.
- UTF-8 limits: definition **64 KiB**, start inputs **32 KiB**, resolved workflow prompt/input **256 KiB**, raw native unit result **16 KiB before JSON parsing**, aggregate **256 KiB**. The **entire workflow namespace** (registry plus retained runs) is capped at **2 MiB**, with at most **16 definitions / 16 retained attempts**. Complexity limits also apply. Overflow is explicit; results are not silently clipped and history is not automatically pruned. Normal Pi resource context and native JSONL have separate limits; these are not token budgets.
- Retry requires a fully settled failed/cancelled latest attempt and unchanged frozen identities. It creates a new workflow run with the same family, incremented attempt number, and `retryOf`; only matching completed units are reused, retaining their original native identities. Newly executed units receive fresh task/run/Pi identities. There is no automatic retry, permission replay, or exactly-once guarantee.
- Version-2 unit identities include block, iteration, body step, and fan-out item where applicable. Retry reuse additionally binds exact iteration state, feedback/transition history, dependency results, frozen definition, and agent policy; similar prompts or identical values in different iterations do not authorize reuse. Newly executed units always receive fresh native identities. An explicit retry can reproduce non-convergence using exact cached completed units without new provider calls; it does not force those units to execute again.
- Frozen inputs and their hashes are **not a filesystem snapshot or proof of workspace freshness**. Reused results describe their original observations; after workspace changes, start a new workflow rather than assume cached results are fresh. Retry cannot replace inputs; changed inputs require a new run. The separate Stage 8C recovery implementation above requires current-state reconciliation and fresh host authority; legacy retry matching alone does not satisfy it.
- Workflow state uses the existing `extensions.workflows` snapshot namespace. Without opt-in persistence it is process-local. Recovery never starts work, reconnects SDK sessions, or replays messages; interrupted work is marked unverified/`needs-attention` and cannot simply resume or retry with unknown cleanup. Corrupt workflow data is retained and workflow actions fail closed without suppressing unrelated run recovery. Snapshot persistence retains its existing error/durability limitations.

## Native session reference foundation

Native runs expose `nativeSessions` through existing structured `runs.list` / `runs.show` results and a bounded `/zerg runs show <run-id>` summary. The parent run's `metadata.nativeSessions` is the canonical ledger; typed results are isolated copies. Each schema-version-1 reference maps the exact parent/member run and agent definition to Pi's own session ID, file locator, cwd, creation timestamp, and attachment state. Team workers and the leader have separate references; simultaneous runs of the same definition are separate conversations.

Before extension binding or prompting, each native Pi manager receives a namespaced `pi-zerg-swarm/native-session/v1` custom identity entry and session name. Custom identity is tree metadata, not model context. Pi owns the JSONL transcript and branching/compaction format; Zerg does not duplicate it. **The SDK allocates the ID/path before writing a file**: setup/custom entries alone do not create a transcript, and a file can be absent after startup failure or cancellation before prompting. A locator is not proof of existence, persistence, or permission to read that path.

Sessions still dispose after each task. `disposed` means confirmed SDK cleanup, not lost history; a throwing cleanup leaves the reference `unavailable` without claiming disposal. With opt-in Zerg snapshot persistence enabled, the ledger survives restart; restored `attached` references become `unavailable`, even for terminal parent runs, without inventing disposal. `unavailable` does not mean reconnected. With persistence disabled, Pi's marker/history survives independently **once Pi actually writes its file**, but Zerg does not rediscover the mapping on restart.

Session runtimes still end after their tasks. Reference inspection and hydration do not read, create, repair, or scan transcript files. Explicit viewing is separate and validates the known location, Pi header, immutable provenance, and entry graph; it never resumes execution or changes the active branch.

## Agent coding overlay

- `/zerg sessions [parent-run-id]` opens an **exact-session chooser** in an interactive Pi TUI. No leader or operator conversation is selected implicitly. `/zerg sessions list [parent-run-id]` prints bounded references and also works without a terminal UI; command aliases are preserved.
- Select a row and press **Enter** to inspect live text, available thinking text, and tool arguments/results. **Home** exposes full parent/member/Pi IDs. **Up/Down**, **PageUp/PageDown**, and **Home** pause tail following; **End** follows the tail on the live default branch. **s** returns to sessions, **b** chooses a raw branch locally (choose **Default** to return), and **q/Esc** closes when not composing.
- `live` means an observer is connected to this owner's native runtime. An already-open viewer becomes `captured` when observation ends: its bounded final display remains, without claiming a durable file or reconnection. Reopening reads `saved` history when validation succeeds; `unavailable` explains missing, unsupported, unsafe, or disconnected state. A saved history from an unconfirmed attachment is explicitly history-only, not a live or confirmed-closed session.
- This is **raw branch history, not effective model context**. Compaction/context-edit records are notices, not reconstructed model context. Saved history defaults to the last recorded entry, which is not proof of the active leaf. Branch selection never navigates or mutates the native session.
- Pi JSONL is the sole transcript store. Reads are limited to known, regular, non-symlink v3 files under the configured Pi agent session directory, with matching header and provenance. Missing/corrupt/partial/oversized files are not repaired or opened through `SessionManager.open`; no directories are created or transcripts scanned. Moving a file or changing the agent directory can make its reference unavailable.
- Views are bounded: saved inputs allow up to 8 MiB, 256 KiB per line, and 10,000 entries; normalized display retains up to 200 blocks with aggregate and per-field limits. Live tool previews can be shorter than finalized results. UI line/text limits and omission notices are explicit. Images, opaque payloads, and thinking signatures are omitted; terminal controls are stripped.
- Closing/switching a viewer unsubscribes only that viewer. Runs, native persistence, concurrency slots, cancellation, and task-final SDK disposal retain their existing ownership. There is no transcript tool action, automatic prompt/replay/resume, active-branch mutation, or retained completed SDK session.

### Explicit live messages and receipts

On an exact, accepting **live default branch**, press **c** to compose. **Enter** inserts a newline; **Ctrl+S** explicitly sends; **Alt+M** selects `followUp` (default) or `steer`. **Esc** leaves composition while retaining the draft; another Esc closes the viewer. Pi's public editor handles text editing and normalizes pasted newlines/tabs. Drafts are bounded to 16,384 UTF-16 code units; unsafe/oversized paste packets are rejected visibly. Composition is disabled below 12 columns or 10 rows. Saved, captured, disconnected, completed, read-only, and explicitly selected historical branches cannot send.

Messages target the exact `{parentRunId, memberRunId, piSessionId}` in this owner, never a guessed leader or another run of the same definition. `steer` enters at the next steering boundary; `followUp` waits for current tool/steering work to drain. Literal message content uses Pi's public custom-message queue, bypassing slash commands, templates, and input handlers. Receipt metadata stays outside model context. Closing the viewer does not cancel an already submitted message or the run.

The additive control actions also work without a TUI:

```ts
const key = { parentRunId, memberRunId, piSessionId }; // exact chosen reference
await control.execute({ action: 'session.message.send', ...key,
  messageId: 'operator-unique-001', body: 'Check the failing test first.', mode: 'followUp' });
await control.execute({ action: 'session.messages.list', ...key, limit: 32 });
```

Equivalent slash commands (aliases remain supported):

```text
/zerg sessions send <parent> <member> <pi-id> <message-id> <steer|followUp> -- <literal body>
/zerg sessions messages <parent> <member> <pi-id> [limit]
```

Send mode is explicit in the new API/CLI. The body after the `-- ` separator is literal, including legal tabs, newlines, indentation, and trailing whitespace; shell-style quotes are not removed. Responses expose `data.receipt` or `data.receipts`. The existing `message` action and management intervention history are unchanged.

| Receipt | Meaning |
| --- | --- |
| `recorded` | Local intent recorded; not native acceptance. |
| `queued` | Native queue accepted it; consumption is not yet confirmed. |
| `delivered` | ID-correlated native `message_start` consumption observed—not provider acknowledgement, understanding, completion, or transcript durability. |
| `failed` | Rejected before native enqueue. |
| `needs-attention` | Enqueue/consumption is uncertain, or a pending receipt survived detachment/restart. |

A caller ID is unique across the retained ledger. Repeating the same ID with the same exact key/body/mode returns its receipt without sending again; conflicting reuse rejects. The composer keeps its attempt ID for an unchanged unconfirmed draft. **There are no automatic retries or restart replays.** A deliberately new ID is a new message, not a safe retry of an uncertain one.

Receipt persistence is independently `memory`, `saved`, or `failed`. With existing opt-in snapshot persistence, a successful intent write is required before enqueue; a later save failure does not revoke known queued/delivered status. `saved` means a successful Zerg snapshot write—not fsync/power-loss protection or a durable native transcript. Recovery quarantines pending receipts as `needs-attention` without scanning history, reconnecting, or executing anything. Use one owner per snapshot file; this is not a cross-process mailbox.

The ledger retains at most 128 receipts and 262,144 aggregate body UTF-16 code units, with at most 32 pending per exact session. Capacity exhaustion rejects new messages instead of silently evicting idempotency records; there is no automatic pruning. The overlay shows at most eight receipts; structured listing supports limits 1–128. Outgoing intent bodies are stored for inspection/idempotency, not as a second conversation transcript. Long-lived agents and automatic sibling push/wakeup remain separate work.

## New task from saved native history

Continuation creates a **new task and native Pi session** using an explicitly selected saved history entry as context. It does not reconnect to, resume in place, or modify the original session. Only the selected agent continues—not its former team or siblings.

The workflow has two separate steps:

1. **Prepare and review** the exact parent/member/Pi identity, selected entry, source fingerprint, literal new task, and current execution policy. Preparation does not construct an agent session, load executable resources, or call a model; it is also available in read-only mode.
2. **Explicitly authorize startup.** The owner-local review is consumed once. Changed source or fingerprinted policy inputs, expiry, read-only execution admission, or a disposed owner rejects startup; there is no automatic re-prepare or retry. Restart does not restore review tokens or execute anything.

Historical permissions are **unknown**, not inferred from old tool use. Review authorizes a new task under the current selected agent definition, configured tools/denials, model, project instructions, and ordinary Pi resource-loading policy. Normal Pi extensions, skills, and resources remain available; this is not a reduced-capability mode. Confirmation authorizes resource loading and extension startup as well as the task, so startup itself can have side effects before a model request. Cancellation is not rollback.

In the coding overlay, **n** opens the separate new-task flow from the last displayed non-live entry, validated against saved native history. **b** still inspects branches; **c** still sends to an accepting live session. Enter/Ctrl+S prepares a review; only **Ctrl+Y** on the review authorizes the new task. **e** edits and invalidates the review; Escape discards it and returns to the original viewer. Closing after submission does not cancel or retarget the new run. The public Pi editor normalizes newlines/tabs before review; the reviewed draft is then bound unchanged. Oversized disclosure disables confirmation instead of silently hiding part of the policy.

Structured control uses the same flow:

```ts
const prepared = await control.execute({
  action: 'session.continuation.prepare', parentRunId, memberRunId, piSessionId,
  entryId, body: 'Investigate this alternative without modifying files.',
  model: 'provider/model', // explicit override, or an explicit current definition model
});
if (!prepared.ok) throw new Error(prepared.error?.message ?? 'Review unavailable');
const review = prepared.data.review;
// Inspect the full review. Stop here; never automatically confirm it.
```

Only after explicit approval of that exact review:

```ts
const started = await control.execute({
  action: 'session.continuation.start', reviewId: review.reviewId, confirm: true,
});
// Admission is not completion; inspect the returned runId through runs.show.
```

Alternatively discard an unused review with `session.continuation.discard` and its `reviewId`.

Equivalent human-facing commands:

```text
/zerg sessions continue prepare <parent> <member> <pi-id> <entry-id> [--model provider/model] [--ack-unconfirmed] -- <literal new task>
/zerg sessions continue start <review-id> --confirm
/zerg sessions continue discard <review-id>
```

Structured/CLI task bodies preserve legal whitespace and are submitted without slash-command, skill-command, or prompt-template expansion. Normal Pi input and before-agent-start hooks still run and may transform or handle that input; the review discloses this ordinary extension authority. An inherited final assistant response is never counted as completion of the new task.

Attached sources reject. An `unavailable` attachment—including uncertain restart recovery—requires explicit `acknowledgeUnconfirmedSource: true` (UI **Alt+A** / CLI `--ack-unconfirmed`). This acknowledges uncertain closure, not proof that the old process stopped. A confirmed disposed source does not become unconfirmed merely because its view was captured or recovered. The feature copies history only: it neither reconnects nor replays old queues, approvals, or receipts.

Pi's authoritative session projection handles compaction and context edits—not the coding viewer's truncated blocks. The original transcript is never passed to SDK open/fork methods. A fresh, exclusively created native file receives the copied tree; only copied Zerg identity/lineage metadata namespaces change to explicit ancestor metadata. Payloads, entry IDs, and parent links remain intact. A new owning identity and source lineage are recorded, while legacy owning-marker validation remains strict.

**Limits:** this does not restore workspace files, tool processes, historical resource code, credentials, or the old environment. Known current policy inputs are fingerprinted for drift detection, not frozen into an environment snapshot or security sandbox; legacy global npm fallback and transitive/dynamic dependencies are not resolved or sealed during review. Existing native capability checks still apply. The model must be explicit in the current definition or review override; current requested thinking follows normal Pi capability normalization. Missing, malformed, oversized, incomplete tool-call history and unsupported legacy plain system content remain inspectable where supported but cannot be executed through continuation. No fallback silently drops history or broadens permission.

## Team/run communication timeline

Open `/zerg timeline`, or press **t** on a team/run in the management tree/detail pane. Unsupported or ambiguous selections do not silently open all runs or a leader. The timeline is read-only; send messages through the existing exact-session coding composer, not this view.

```text
/zerg timeline --team <team-id> --run <parent-run-id>
/zerg timeline list --run <parent-run-id> --member <member-run-id> --session <pi-session-id> --limit 64
```

Structured control provides the same projection in `data`:

```json
{"action":"timeline.list","parentRunId":"zerg-run-id","limit":128}
```

Optional flat fields are `teamId`, `parentRunId`, `memberRunId`, `piSessionId`, and `limit`. Filters combine with exact **AND** semantics: valid unknown IDs return no matches; malformed values, unsupported fields, and duplicate/unknown command flags reject rather than broaden scope. IDs are bounded to 256 UTF-16 code units without whitespace/control characters. Default limit is 128; maximum is 256. `list`, or a noninteractive host, returns bounded text instead of opening the TUI.

- **f** edits the four exact filters; Tab/Shift+Tab changes fields, Enter applies, and Escape cancels. Complete, bounded bracketed paste is literal inside a field; unsafe/mixed packets reject without executing suffix keys.
- **Enter** opens row details with stable row/message IDs and full identities. Arrows/Home select rows and pause following; **End** follows the newest retained tail. Detail text scrolls with PgUp/PgDn.
- **v** opens coding only when the last rendered selected row still has the same proven parent/member/Pi identity. Missing or changed proof rejects—never a chooser, another row, or an implicit leader. Closing coding restores a fresh timeline view with its plain selection/filter/scroll state.
- **q/Escape** closes the timeline. Closing either view never aborts a run, holds a worker slot, retains a completed SDK session, or changes the active native branch. Abbreviated list labels are display-only, never routing keys.

Rows distinguish **operator receipts**, **native output/handoffs**, **recorded events**, and **current run/member snapshots**. A receipt is one stable row ordered by creation time with its current status—not fabricated delivery-transition history. Native output is **not an addressed reply** to a nearby message. Snapshots are **not historical events**. Historical receipt/member scope remains visible even without a current exact coding link; legacy logs never guess Pi identities. Team attribution uses recorded metadata, not current team membership.

This projects existing retained state/logs/receipts; it adds no transcript mirror, timeline file, SDK observer, replay, or reconnect. Native handoffs appear when the runner records them, not for every streamed token or assistant message; use coding view for live text/tools and saved raw history. Existing opt-in snapshot persistence and native JSONL remain the only stores.

Previews are bounded (1,024 body and 256 summary UTF-16 code units; 65,536 aggregate preview units), with newest content preserved under projection/text-display budgets. Source windows and UI bounds can omit older content, and notices distinguish known omissions, unknown coverage, and clipping. Unscoped/team attribution examines the newest 512 stored run keys—not a complete timestamp-sorted history; an explicit parent filter can inspect an older retained run outside that window. No timestamp or reply relationship is synthesized to fill gaps.

## Architecture

```mermaid
flowchart TB
  subgraph Runtime["Public command runtime (implemented)"]
    PiContext["Pi extension context"] --> Index["index.ts command entry"]
    Index --> State["state.ts shared state"]
    Index --> Patch["internal-patch.ts safe bridge"]
    Patch --> State
    Parse["parse.ts thinking-step parser"] --> State
    State --> Render["render.ts text renderers"]
    Render --> Operator["operator output"]
  end

  Parse -->|"thinking-step derivation"| Render
  Index -->|"registered commands"| Operator
```

```mermaid
flowchart TD
  subgraph CommandHost["Command-host flows (implemented)"]
    Operator["operator"] --> Host["/zerg mode + /zerg intervene command surface"]
    Host --> Views["help / status / tree"]
    Views --> Snapshots["shared snapshots + audit records"]
    Snapshots -->|"renders"| Rendered["visible runtime text"]
  end

  subgraph Planned["Planned runtime"]
    Leader["team leader"] --> SubA["subagent"]
    SubA --> Queue["task queue"]
  end

  Host -.-> Leader
```

Future milestones keep runtime, hooks, tasks, and rendering separate so monitoring can evolve without coupling to private Pi internals.

## Package shape

The package advertises a Pi extension entry in `package.json`:

```json
{
  "pi": {
    "extensions": ["./index.ts"]
  }
}
```

The TypeScript modules are intentionally small:

- `types.ts` — shared contracts and structural Pi context types
- `state.ts` — deterministic state helpers
- `parse.ts` — pure thinking-step derivation
- `render.ts` — width-aware text rendering
- `persistence.ts` — restart-durable run/log snapshot save, load, and recovery helpers
- `native-transcript.ts` — owner-scoped read-only live observers and bounded transcript projections
- `native-history.ts` — strict saved-history validation, native context projection, and exclusive fresh-copy import
- `native-continuation.ts` — bounded current-policy capture, exact one-use reviews, and execution admission
- `session-messages.ts` — exact live message admission, bounded receipts, persistence barriers, and no-replay recovery
- `timeline.ts` — pure bounded projection of retained receipts, provenance-linked output, events, and current snapshots
- `ui/agent-overlay.ts` — exact-session chooser, bounded transcript display, explicit composer, and local branch inspection
- `ui/continuation-review.ts` — separate literal-task editor, current-authority disclosure, and explicit continuation confirmation
- `ui/team-timeline.ts` — exact filters, bounded timeline/details, and identity-checked coding-view round trips
- `workflow-model.ts` — bounded declarative contracts, validation, immutable identities, and review aggregation
- `workflow-runtime.ts` — dependency scheduling, explicit attempts, owned permits, inert recovery assessment, and trusted selected execution
- `workflow-recovery.ts` — bounded checkpoint, operation, selection, and family evidence contracts
- `ui/workflow-overlay.ts` — progress/step/unit/result views and exact native coding-view navigation
- `internal-patch.ts` — no-op-safe internal bridge scaffold
- `index.ts` — extension registration, command handling, direct control API, and native runner wiring

## Development

```sh
npm install
npm run build
npm test
npm run check:package
npm run check:version
```
`npm run build` performs strict TypeScript no-emit checking. `npm test` runs parser plus command-surface coverage, direct control API/tool registration coverage, state/container behavior, registration snapshot semantics, internal-patch event-bus wrapping/duplicate/rollback/dispose paths, render/lifecycle/mode/permission/log regressions, and focused M9 UI coverage for management overlay lifecycle, tree navigation, settings/actions, chat delivery semantics, and fake-Pi shared-state parity checks using Node's built-in test runner and `tsx`.
`npm run check:package` validates MIT/license metadata, package/build private-path guards, package-lock↔package version sync, and repository metadata fields for release discoverability and consistency.
`npm run check:version` confirms that the package release tag matching `package.json` is at `HEAD` in post-tag state. During explicit pre-tag release prep, skip this check until the release tag exists at `HEAD`; if run earlier, the failure is expected.

Workflow model, scheduler, fake-native control, and UI regressions run in `npm test`, alongside the existing suites and SDK fixtures. The additional workflow SDK/PTY acceptance is opt-in after reviewing its harnesses:

```sh
ZERG_WORKFLOW_ACCEPTANCE=parent-approved node --import tsx --test test/workflow-integration.test.ts
```

These Linux/Python/installed-Pi fixtures use empty owned environments, scripted localhost responses, bounded requests/output/time, and owned-process cleanup checks. They exercise real SDK tools and regular/fullscreen terminal input/resize/recovery. They are automated integration evidence—not an OS sandbox, manual visual acceptance, external-model quality evaluation, or universal third-party compatibility certification.

## Roadmap

- v0.1.0: command surface hardening (completed)
- v0.2.0: richer types and state (completed)
- v0.3.0: baseline thinking-step parser hardening and Pi command integration (completed)
- v0.4.0: Pi internal bridge validation and safe event-bus observation (completed)
- v0.4.1: audit bugfix and release-hygiene version-surface consistency (completed)
- v0.5.0: render and tree visibility expansion with explicit tree, fallback hierarchy, safety markers, and truncation bounds (completed)
- v0.5.1: audit bugfix patch for fallback childIds hierarchy, explicit missing-child markers, and durable render regressions (completed)
- v0.6.1: subagent runtime lifecycle and monitoring/status/tree command surfaces (completed)
- v0.7.0: command-host mode/intervention controls with audited global state transitions and bounded intervention records (completed)
- v0.7.1: audit bugfix patch for read-only `/zerg mode status`, mode-revert `contextId` clearing, and invalid/control-only/overlong mode reason regression coverage (completed)
- v0.8.0: package readiness and config hardening (completed implementation milestone)
- v0.8.1: audit bugfix patch for release-surface/version-alignment follow-ups (completed milestone)
- v0.9.0: release-prep/doc and package-readiness polish (completed)
- v0.9.1: publication/public repository readiness and check:version doc polish (completed)
- v1.0.0-rc.3: release-candidate agent-definition registry and metadata finalization (completed)
- v1.0.0-rc.4: release-candidate adapter read APIs and run inspection surfaces (completed)
- v1.0.0-rc.5: release-candidate task-first spawn and task/run identity surfaces (completed)
- v1.0.0-rc.6: release-candidate fresh/fork launch modes and run metadata surfaces (completed)
- v1.0.0-rc.7: release-candidate command-host permission queue and approval audit surfaces (completed)
- v1.0.0-rc.8: release-candidate fine-grained lifecycle substates for agents, teams, tasks, runs, and permission waits (completed)
- v1.0.0-rc.9: release-candidate structured output and bounded logs for runs, permissions, lifecycle events, and management views (completed)
- v1.0.0-rc.10: release-candidate full management overlay for monitor, control, targets, permissions, lifecycle, logs, intervention, and config views (completed)
- v1.0.0-rc.11: release-candidate interactive TUI management product with live tree/detail/settings/chat/footer surfaces (completed)
- v1.0.0: stable release with Pi-native interactive management TUI alignment (completed)
- v1.0.1: patch release with Claude Code-style runtime agent/team/model configuration (completed)
- v1.0.2: patch release with package/runtime version alignment (completed)
- v1.0.3: patch release with native Pi SDK-backed `/zerg run` execution without pi-subagents (completed)
- v1.0.4: patch release with native async/background runs, direct structured control API/tool registration, accurate terminal run status, cancellation hooks, and concurrent native team workers (completed)
- v1.0.5: patch release with simplified KISS `/zerg config` overlay UX and Pi theme-aware management panes (completed)
- v1.0.6: patch release with native team handoff fallback persistence, original task preservation, team-id direct runs, and scope-safe native team prompts (completed)
- v1.1.0: minor release with restart-durable run/log recovery snapshots, additive direct message transport hooks, and author/copyright metadata alignment
- v1.1.1: patch release exposing Larra MCP tools to native zerg agents when requested
- v1.1.2: patch release capturing final assistant handoffs from native single-agent zerg runs
- v1.1.3: patch release updating native execution and extension integration for Pi 1.0.0
- v1.1.4: patch release hardening native outcomes, cancellation, tool policy, explicit teams, and targeted messaging
- v1.1.5: patch release isolating state subscribers and bounding extension metadata traversal
- v1.1.6: patch release propagating required worker failures to native team outcomes while preserving handoffs and cancellation
- v1.1.7: patch release bounding native team worker concurrency with configurable FIFO admission and cancellation-safe queuing
- v1.1.8: patch release rejecting unsupported native fork, turn limits, and fallback models before session startup
- v1.1.9: patch release mapping exact native session identities and immutable transcript provenance
- v1.1.10: patch release adding read-only live coding overlays and safe saved raw-history inspection
- v1.1.11: patch release adding exact live messaging, an explicit composer, and bounded no-replay receipts
- v1.1.12: patch release adding a read-only team/run timeline, exact filters, and safe coding-view navigation
- v1.1.13: patch release adding explicit reviewed continuation into a fresh native session
- v1.1.14: patch release hardening runtime admission, history/UI lifetimes, terminal rendering, and bounded snapshot recovery
- v1.1.15: patch release adding bounded declarative read-only workflows and exact progress/inspection controls
- v1.1.16: patch release adding bounded read-only conditions and repeat workflows
- v1.1.17: patch release adding trusted staged coding with separate approval gates
- v1.1.18: patch release adding explicit durable workflow recovery and fresh linked execution (Stage 8C; current release)
- Stage 8D: optional scripted bounded workflows (future proposal only; separate authority required)

## License

MIT © 2026 Marc Mironescu (@crustyhacker) <marcm@crustyhacker.dev>

## Native execution and control

- Use explicit team ids when launching teams; a bare shared leader runs as a single leader, not the first matching team.
- All selected team members are required: a worker failure or independent cancellation fails the overall run/task even if the leader succeeds. Parent or leader cancellation still yields a cancelled run; successful handoffs remain available.
- `tools: []` means no tools. `disallowedTools`/denylist entries remove tools from an allowlist; this is not a sandbox boundary.
- Native permission modes `manual` and `assisted` are not supported for Pi SDK runner launches; use inherited/default automatic behavior or reject before model execution.
- Native Pi SDK execution fails closed for `--fork`/`launchMode: 'fork'`, nondefault `maxTurns`, and nonempty `fallbackModels`: the selected leader and every selected team member are checked before any SDK session starts. Clear those options for native runs, or use a supported external adapter/acknowledged slash bridge that implements them. Reviewed continuation is a separate explicit history-import path, not support for these legacy launch options.
- Legacy operator `message` calls require a live run/member route. Their Pi `steer`/`followUp` acknowledgement remains `queued` or `handled`; UI-local management drafts may use `queued-local` and are not delivery proof. The additive exact-session API has the separate receipt contract described above.
- Legacy structured `zerg_control` `message` mode accepts only `steer` or `followUp` (default `steer`); ambiguous live target routes require an explicit `runId`. New `session.message.send` requires an explicit mode and all three session IDs.
- Native team workers have a per-run concurrency limit (default **8**). Set it with `/zerg run <team> "<task>" --concurrency <n>` (also `--concurrency=<n>`) or a positive safe-integer number in structured `zerg_control` run `concurrency: n`. This is not a global/provider-wide limit, and external adapters are responsible for their own enforcement.
- Workers are admitted FIFO; each slot covers session setup and execution. Worker failure releases its slot without blocking the remaining queue. The leader runs after all workers settle, unless the run is cancelled. Cancellation prevents queued workers from starting; skipped workers finish as cancelled without a start timestamp.
