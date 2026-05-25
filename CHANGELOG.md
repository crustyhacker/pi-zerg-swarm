# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to semantic versioning after the bootstrap line is established.


## [Unreleased]

## [1.1.0] - 2026-05-25

### Added

- Added restart-durable run/log snapshot persistence and recovery helpers for native zerg sessions.
- Added additive structured operator-message transport hooks to direct control and adapters, with honest delivered/unavailable/failure states.

### Changed

- Bumped package/runtime metadata to `1.1.0` and included `persistence.ts` in the public package surface.
- Updated copyright and package author metadata for Marc Mironescu / `crustyhacker`.

### Fixed

- Recovered non-terminal pre-restart runs are now surfaced as `needs-attention` with recovery metadata instead of disappearing from run inspection.

## [1.0.6] - 2026-05-16

### Fixed

- Preserve original task text in terminal native run snapshots and allow direct control runs by configured team id.
- Persist fallback native team handoff files when the Pi session does not write the advertised coordination file.
- Keep native team leader prompts scope-safe so audit/read-only tasks are not upgraded into source-editing fix work.

### Changed

- Clarified stable-package wording and post-stable version-policy guidance.

## [1.0.5] - 2026-05-16

### Changed

- Simplified the `/zerg config` overlay into a KISS three-step flow: select a target, adjust settings/permissions, then send an operator message.
- Aligned the config overlay with Pi theme colors and clearer footer key hints, including `Ctrl+X` for clearing chat drafts.

### Fixed

- Preserved existing selected targets when opening `/zerg config` without locking tree navigation back to the first/default target.
- Made the overlay header report the real Zerg control controller instead of the permission-mode controller.

## [1.0.4] - 2026-05-15

### Added

- Added exported structured direct control via `createZergControl(...)` plus `ZergControlAction`/`ZergControlResult` contracts for automation without terminal or slash-command parsing.
- Added Pi custom tool registration for `zerg_control` when the installed Pi API exposes `registerTool(...)`; tool execution calls the same structured control core.
- Added process-lifetime native background run tracking, `awaitRun` support for foreground direct/native callers, enhanced run snapshots with final/error summaries, completion timestamps, and member progress.
- Added native team coordination directory creation and visible concurrent member progress before leader integration.

### Fixed

- Fixed stale terminal run rendering by making terminal state such as `done/completed`, `failed/failed`, or `cancelled/cancelled` win over older adapter `starting` snapshots.
- Wired native interrupt handling to active Pi `AgentSession.abort()` handles when available; cancellation is reported as `cancelling` until native execution actually reaches a terminal cancelled/failed state.

### Changed

- Bumped package manifest versions from `1.0.3` to `1.0.4` in `package.json` and `package-lock.json` (top-level + root package).
- Updated README current-release, direct API/tool, async durability, and validation wording for `v1.0.4`.

### Known Limitations

- Background run durability is process/session lifetime only; restart-durable persistence is not implemented.
- Native model fallback and max-turn settings are preserved in request/run metadata, but exact enforcement depends on installed Pi SDK model/session support.

## [1.0.3] - 2026-05-15

### Added

- Added native Pi SDK-backed `/zerg run` execution so `pi-zerg-swarm` can launch configured agents without the `pi-subagents` extension.
- Added native team execution fallback for leader runs: configured team members run first with shared coordination files, then the leader integrates and reports.

### Fixed

- Removed the hard runtime dependency on the `pi-subagents` slash bridge; missing bridge now starts the native runner instead of failing with “Ensure pi-subagents is loaded.”

### Changed

- Bumped package manifest versions from `1.0.2` to `1.0.3` in `package.json` and `package-lock.json` (top-level + root package).
- Added `@earendil-works/pi-coding-agent` as a runtime dependency for native Pi SDK execution.
- Updated README current-release and check-version wording from `v1.0.2` to `v1.0.3`.

## [1.0.2] - 2026-05-15

### Fixed

- Aligned runtime status/help/internal-patch messages with package release version `v1.0.2` instead of retaining stale `v1.0.0` command-surface strings.
- Centralized the command-surface version string for runtime rendering and registration messages to avoid future package/runtime drift.
- Made successful adapter launch output robust when an adapter returns `ok: true` without an optional message.
- Fixed custom run/task ID normalization so unprefixed ID factory values produce `zerg-*`/`task-*` IDs without doubled hyphens.

### Changed

- Bumped package manifest versions from `1.0.1` to `1.0.2` in `package.json` and `package-lock.json` (top-level + root package).
- Updated README current-release and check-version wording from `v1.0.1` to `v1.0.2`.

## [1.0.1] - 2026-05-15

### Added

- Added Claude Code-style runtime agent configuration: `/zerg agents create|update|delete` can set prompts, tools, permission mode, model, fallback models, and max turns.
- Added `/zerg run --model/--fallback-models/--max-turns` routing and bridge metadata propagation, plus `/zerg agent` and `/zerg team` flags for leaders, members, teams, and model metadata.

### Changed

- Bumped package manifest versions from `1.0.0` to `1.0.1` in `package.json` and `package-lock.json` (top-level + root package).
- Updated README current-release and check-version wording from `v1.0.0` to `v1.0.1`.

## [1.0.0] - 2026-05-15

### Changed

- Finalized the stable `v1.0.0` release after the M9 interactive management TUI implementation.
- Aligned `/zerg config` with the working Pi overlay pattern from `pi-jarvis`: the overlay launch is awaited, rendering uses the real single-argument component contract, key handling uses Pi TUI key helpers, and chat composition uses the Pi TUI `Input` component with focus/cursor support.
- Bumped package manifest versions from `1.0.0-rc.11` to `1.0.0` in `package.json` and `package-lock.json` (top-level + root package).
- Updated README current-release wording, runtime/help strings, and matching tests from `v1.0.0-rc.11` to `v1.0.0`.

### Known Limitations

- Delivered chat/process transport remains future scope; operator messages are recorded as local/unavailable or intervention-recorded only.
- External network/subprocess transport was not added for the stable release.

## [1.0.0-rc.11] - 2026-05-14

### Added

- Added the M9 componentized Pi-native interactive management TUI for `/zerg config`, split across `ui/management-overlay.ts`, tree, detail, chat, settings, footer, component, and local UI-state modules.
- Added live tree browsing for agents, teams, and tasks with expand/collapse, clamped navigation, confirmed selection, and detail drill-down.
- Added detail, settings/action, chat/operator-message, and footer panes with focus routing, live state refresh, bounded rendering, and exact-once teardown.
- Added honest operator message handling: team messages resolve to leaders when present, unavailable transport is explicit, and intervention records are never labeled as delivered chat.
- Added focused UI tests for overlay lifecycle/dispose, tree navigation, settings/actions, chat delivery semantics, and package/test coverage for the new UI modules.

### Changed

- Changed `/zerg config` to launch the M9 interactive TUI through `ctx.ui.custom()` while preserving the M8 text management overlay fallback and the simple `/zerg monitor` path.
- Reused existing audited command/state paths for read-only, automation mode, controller, permission approve/deny, interrupt, target selection, and intervention recording.
- Bumped package manifest versions from `1.0.0-rc.10` to `1.0.0-rc.11` in `package.json` and `package-lock.json` (top-level + root package).
- Updated README current-candidate wording, runtime/help strings, package inclusion, and matching tests from `v1.0.0-rc.10` to `v1.0.0-rc.11`.

### Known Limitations

- Manual Pi host smoke for `/zerg config` was not run in this environment, so this candidate is locally validated but not release-complete until interactive host verification passes.
- Delivered chat/process transport remains unavailable; UI messages are recorded as local/unavailable or intervention-recorded only.
- The interactive TUI uses structural component composition and line rendering; it does not add new external network/subprocess transport.

## [1.0.0-rc.10] - 2026-05-14

### Added

- Added the full `/zerg config` management overlay with monitor, control, targets, permissions, lifecycle, logs, intervene, and config tabs.
- Added overlay-local selection, scroll, detail, confirmation, status-message, and exact-once close/dispose handling for the Pi custom overlay path.
- Added keyboard support for tab cycling, left/right tab navigation, clamped up/down row movement, enter detail toggle and explicit selection, permission approve/deny confirmation, interrupt requests, and deterministic deferred filter messaging.
- Added regression coverage for overlay contract/dispose semantics, tab/navigation/scroll behavior, refresh/unsubscribe handling, no-writable-container mutation blocking, permission confirmation, and render immutability.

### Changed

- Kept `/zerg monitor` read-only while expanding `/zerg config` into the full management surface.
- Reused existing audited command/state paths for read-only, automation mode, permission resolution, interrupt, and intervention mutations instead of adding overlay-only direct state writes.
- Bumped package manifest versions from `1.0.0-rc.9` to `1.0.0-rc.10` in `package.json` and `package-lock.json` (top-level + root package).
- Updated README current-candidate wording, runtime/help strings, and matching tests from `v1.0.0-rc.9` to `v1.0.0-rc.10`.

### Known Limitations

- Manual Pi smoke for the management overlay was not run in this environment, so live host-behavior verification remains outstanding.
- Text filter entry (`/` or `f`) is deferred to a deterministic status message; freeform in-overlay filtering is not yet implemented.
- Live overlay chat/process transport and external transport wiring remain future scope.

## [1.0.0-rc.9] - 2026-05-11

### Added

- Added typed structured log contracts for `ZergLogLevel`, `ZergLogSource`, `ZergOutputKind`, `ZergLogRecord`, and `ZergLogState`.
- Added bounded structured log state under `state.extensions.zergLogs` with clone-safe helpers for appending records, appending batches, reading filtered records, max-record trimming, and JSON-safe structured data sanitization.
- Added `/zerg logs status|list|show|json` command surfaces with `--run`, `--level`, `--limit`, and `--json` support for stable text and parseable JSON inspection.
- Added command, lifecycle, permission, adapter, Pi slash-bridge, run, and interrupt log integration using verified fields only.
- Added monitor, control, config, and help rendering for structured log counts and latest warning/error summaries.
- Added regression coverage for log helper cloning/trimming/sanitization, cyclic and unsupported data handling, BigInt JSON safety, log command filters, JSON parsing, bridge tool/text/error/result update logs, and render immutability.

### Changed

- Kept logs in bounded in-memory extension state; no persistent filesystem logs, telemetry, or unbounded raw output storage were added.
- Bumped package manifest versions from `1.0.0-rc.8` to `1.0.0-rc.9` in `package.json` and `package-lock.json` (top-level + root package).
- Updated README current-candidate wording, runtime/help strings, and matching tests from `v1.0.0-rc.8` to `v1.0.0-rc.9`.

### Known Limitations

- External Pi log/output event integration remains limited to verified slash-bridge event fields; private Pi event payloads are not guessed.
- `/zerg logs clear` is not implemented; log deletion/retention policy beyond bounded in-memory trimming remains future scope.
- Structured logs are in-memory extension state and are not durable across process restarts.

## [1.0.0-rc.8] - 2026-05-09

### Added

- Added `ZergLifecycleSubstate` with fine-grained queued, spawning, starting, waiting, executing, tool-running, compacting, cancelling, completed, failed, and reset lifecycle values while preserving coarse `AgentStatus` and `TaskStatus` compatibility.
- Added optional lifecycle substate, reason, and update timestamp fields to runtime state, task records, lifecycle events, and subagent run snapshots.
- Added deterministic runtime transition substate mapping, sanitized bounded substate reasons, and clone-safe snapshot handling.
- Added lifecycle command `--substate`, `--substate=<value>`, and `substate=<value>` parsing with invalid-substate no-mutation rejection.
- Added run, Pi slash-bridge, interrupt, and permission-wait lifecycle substate integration, including bridge task completion/failure state updates.
- Added compact substate hints to status, tree, monitor, control, config, and run list/show rendering.
- Added regression coverage for substate mapping, sanitization, clone isolation, command parsing, bridge run/task flow, interrupt cancellation, permission waits, rendering, and coarse status compatibility.

### Changed

- Kept public coarse lifecycle status unions unchanged while layering detailed substates onto runtime/task metadata.
- Bumped package manifest versions from `1.0.0-rc.7` to `1.0.0-rc.8` in `package.json` and `package-lock.json` (top-level + root package).
- Updated README current-candidate wording, runtime/help strings, and matching tests from `v1.0.0-rc.7` to `v1.0.0-rc.8`.

### Known Limitations

- External Pi lifecycle payload semantics remain limited to verified slash-bridge events; private Pi lifecycle event integration is deferred.
- Lifecycle substates are in-memory command/runtime metadata and do not add process supervision or durable run logs.

## [1.0.0-rc.7] - 2026-05-08

### Added

- Added typed command-host permission queue contracts for `ZergPermissionRequest`, request status/decision/kind values, and queue snapshots under `state.extensions.zergPermissions`.
- Added immutable permission queue helpers for enqueueing, resolving, expiring, listing pending requests, bounded trimming, sanitization, and clone-safe snapshots.
- Added `/zerg permission status|list|request|approve|deny|cancel` commands for local operator-visible approval audit flow.
- Added read-only `/zerg run` and `/zerg interrupt` gating that records permission requests or blocks adapter side effects instead of launching/cancelling.
- Added permission queue indicators to status, control, monitor, config, help, and list rendering.
- Added regression coverage for queue helpers, command behavior, read-only adapter gating, sanitization, clone isolation, and rendering surfaces.

### Changed

- Kept approval/denial/cancel decisions as audit-only state transitions; approved queued requests do not auto-execute adapter actions in this milestone.
- Bumped package manifest versions from `1.0.0-rc.6` to `1.0.0-rc.7` in `package.json` and `package-lock.json` (top-level + root package).
- Updated README current-candidate wording, runtime/help strings, and matching tests from `v1.0.0-rc.6` to `v1.0.0-rc.7`.

### Known Limitations

- External Pi permission event integration is deferred because exact event names and payloads were not verified; M5 is command-host/local queue only.
- Approved queued requests are not automatically executed; operator execution remains a future milestone.
- Permission queues are in-memory state extension data and are not persisted to disk.

## [1.0.0-rc.6] - 2026-05-08

### Added

- Added explicit `ZergSubagentLaunchMode` values for `fresh` and `fork` subagent launch requests.
- Added `--fresh` and `--fork` launch-mode parsing for `/zerg run`, with fresh as the default isolated launch mode.
- Added launch-mode metadata to task-first task/agent records, adapter run snapshots, and `/zerg runs` list/show rendering.
- Added regression coverage for default fresh, explicit fresh, fork bridge payloads, fresh no-context payloads, conflicting mode flags, legacy `fork: true` compatibility, launch failure audit metadata, and help text.

### Changed

- Updated Pi slash bridge launch handling so fork emits `context: 'fork'` and fresh omits inherited-context bridge payloads.
- Preserved deprecated `fork?: boolean` launch-request compatibility while normalizing internal behavior to `launchMode`.
- Bumped package manifest versions from `1.0.0-rc.5` to `1.0.0-rc.6` in `package.json` and `package-lock.json` (top-level + root package).
- Updated README current-candidate wording, runtime/help strings, and matching tests from `v1.0.0-rc.5` to `v1.0.0-rc.6`.

### Known Limitations

- Fresh/fork behavior records and transmits launch-mode intent only; transcript copying or stripping remains outside this milestone.
- Permission queues, mailbox messaging, background output retrieval, cancellation details, and live UI management remain future milestones.

## [1.0.0-rc.5] - 2026-05-08

### Added

- Added task-first `/zerg run` spawn state that allocates run and task identities before adapter launch.
- Added launch request/result identity fields for `runId`, `taskId`, agent-definition linkage, and task descriptions.
- Added regression coverage for deterministic task-first IDs, definition resolution, read-only no-mutation behavior, sync launch failure visibility, Pi slash bridge request ID reuse, and divergent legacy adapter IDs.

### Changed

- Updated Pi slash bridge launch handling to respect provided run IDs and carry task IDs through run snapshots and metadata.
- Updated `/zerg runs` rendering to show task/run linkage.
- Bumped package manifest versions from `1.0.0-rc.4` to `1.0.0-rc.5` in `package.json` and `package-lock.json` (top-level + root package).
- Updated README current-candidate wording, runtime/help strings, and matching tests from `v1.0.0-rc.4` to `v1.0.0-rc.5`.

### Known Limitations

- Fresh/fork launch-mode semantics, background task output storage, mailbox messaging, and filesystem-defined agents remain future milestones.
- Live TUI overlays, chat, and external transport remain unimplemented and unvalidated.

## [1.0.0-rc.4] - 2026-05-07

### Added

- Added optional adapter read APIs for agent definitions and subagent run snapshots: `listAgentDefinitions`, `getAgentDefinition`, `listRuns`, and `getRun`.
- Added clone-safe `ZergSubagentRunSnapshot` contracts and state helpers for run snapshot retrieval.
- Added read-only `/zerg runs` and `/zerg runs show <run-id>` command output with bounded render helpers and regression coverage.

### Changed

- Bumped package manifest versions from `1.0.0-rc.3` to `1.0.0-rc.4` in `package.json` and `package-lock.json` (top-level + root package).
- Updated README current-candidate wording, runtime/help strings, and matching tests from `v1.0.0-rc.3` to `v1.0.0-rc.4`.

### Known Limitations

- Task-first spawn semantics, filesystem-backed agent loading, and hard `/zerg run` definition enforcement remain future milestones.
- Live TUI overlays, chat, and external transport remain unimplemented and unvalidated.

## [1.0.0-rc.3] - 2026-05-06

### Added

- Added a typed in-memory agent-definition registry with deterministic builtin `generalist`, `planner`, and `reviewer` definitions.
- Added read-only `/zerg agents list` and `/zerg agents show <id>` command support for inspecting registered agent policies.
- Added registry helper APIs, clone-safe state storage, rendering support, and regression coverage for definition normalization, cloning, sorting, and command output.

### Changed

- Bumped package manifest versions from `1.0.0-rc.2` to `1.0.0-rc.3` in `package.json` and `package-lock.json` (top-level + root package).
- Updated README current-candidate wording, runtime/help strings, and matching tests from `v1.0.0-rc.2` to `v1.0.0-rc.3`.

### Known Limitations

- Filesystem-backed agent loading, markdown frontmatter parsing, and hard `/zerg run` definition enforcement remain future milestones.
- Live TUI overlays, chat, and external transport remain unimplemented and unvalidated.

## [1.0.0-rc.2] - 2026-05-05

### Added

- Added release-candidate notes for the single `v1.0.0-rc.2` gate and the mandatory RC audit set.

### Changed

- Bumped package manifest versions from `0.9.1` to `1.0.0-rc.2` in `package.json` and `package-lock.json` (top-level + root package).
- Updated README current-candidate wording, runtime/help strings, and matching tests from `v0.9.1` to `v1.0.0-rc.2`.
- Finalized candidate metadata without introducing new feature scope.

### Known Limitations

- `npm run check:version` is a post-tag confirmation; skip it during pre-tag RC prep until `v1.0.0-rc.2` exists at `HEAD`.
- Manual end-to-end smoke for TUI, lifecycle, intervention, and mode switching remains required before tagging.
- Live TUI overlays, chat, and external transport remain unimplemented and unvalidated.

## [0.9.1] - 2026-05-05

### Added

- Added canonical repository metadata for the public GitHub repository in `package.json` so npm/`pi` consumers can discover and verify project origin: `git+https://github.com/fluxgear/pi-zerg-swarm.git`.
- Documented publication/readiness status updates for README/CHANGELOG and check:version guidance in public docs.

### Changed

- Bumped package manifest versions from `0.9.0` to `0.9.1` in `package.json` and `package-lock.json` (top-level + root package).
- Updated current-release wording from v0.9.0 to v0.9.1 in public release notes.

### Fixed

- Polished README and changelog `check:version` guidance to reflect state-aware, post-tag behavior.
- Removed stale statements claiming canonical repository metadata was still unavailable.
- Updated publication-readiness wording so repository metadata and release checks are documented as resolved for v0.9.1.

### Known Limitations

- Live TUI overlays, chat, and external transport remain unimplemented and unvalidated.

## [0.9.0] - 2026-05-04

### Added

- Added v0.9.0 release-prep documentation polish for README hierarchy, Mermaid visuals, and truthful current-release status.
- Added release/package-readiness context for package-check behavior and post-tag `check:version` expectations.

### Changed

- Updated release messaging in public docs and version references from v0.8.1 to v0.9.0 while preserving completed milestone history.
- Bumped package metadata versions from `0.8.1` to `0.9.0` in package manifest files.
- Reserved the follow-up audit backlog (`prompts/audit/themed-cleanup_v2-0-0.md` and `prompts/audit/generalized-deep-audit_v2-0-0.md`) for v0.9.1.

### Known Limitations

- `npm run check:version` is a post-tag check; pre-tag release-prep failures were expected while `v0.9.0` was not yet tagged.
- Live TUI overlays, chat, and external transport remain unimplemented and unvalidated.

## [0.8.1] - 2026-05-04

### Fixed

- Split the v0.8.0 audit follow-ups into an audit bugfix patch release.
- Added direct `renderHelp` header regression coverage and renamed stale v0.7-labeled intervention/render test titles to version-neutral wording.

### Changed

- Bumped package/package-lock top-level versions to `0.8.1`.
- Updated README and changelog release references plus command/status/help/runtime version strings and matching tests to v0.8.1 while preserving v0.8.0 as the completed package-readiness/config-hardening implementation milestone.

## [0.8.0] - 2026-05-03

### Added

- Added package-readiness/config-hardening release checks (`check:package`, `check:version`) and private-path build/package guards for `prompts`, `planning`, `.pi`, `.claude`, `.codex`, and `.agents` to prevent release/compile leakage.
- Added package metadata validation for MIT license consistency and package-lock sync checks, with repository metadata warning until canonical URL is configured.

### Changed

- Bumped package/package-lock top-level versions to `0.8.0` and aligned command/status/render/help surfaces and tests to the same release surface.
- Updated README roadmap, development script guidance, and changelog scope statements for v0.8.0 package/readiness hardening.

### Known Limitations

- Canonical repository URL is still unavailable in this environment; `check:package` warns about missing repository metadata until configured.

## [0.7.1] - 2026-05-03

### Fixed

- Fixed read-only `/zerg mode status` handling so status is available without writable-state permission.
- Fixed `/zerg mode revert` to clear `contextId` when reverting to the prior mode snapshot.
- Added regression coverage for invalid mode actions and invalid mode reasons (control-only and overlong), asserting rejection without state mutation.

## [0.7.0] - 2026-05-03

### Added

- Added command-host control grammar for `/zerg mode status|manual|assisted|automatic|revert [reason]` and `/zerg intervene agent|subagent|leader ...` without enabling live external transport.
- Added fake-Pi/shared-state regression coverage for registered command-host mode transitions and intervention recording paths.

### Changed

- Promoted package metadata and public version/help/status surfaces to v0.7.0.
- Mode control now records auditable and reversible global `state.mode` transitions including controller and prior-mode snapshots.
- Intervention records are sanitized and bounded before persistence, and rendered across status/help/tree surfaces with active target markers and previews.

### Known Limitations

- Live TUI overlays and chat/external process/network transport remain planned and unvalidated for this release.

## [0.6.1] - 2026-05-02

### Fixed

- Fixed v0.6.1 audit regressions in runtime monitoring: same-timestamp lifecycle activity ordering, explicit-tree runtime hints, sanitized runtime activity output, and fallback to the newest displayable activity.

## [0.6.0] - 2026-05-02

### Added

- Added subagent runtime and monitoring state for agent/team lifecycle transitions, runtime health, task/activity snapshots, and shared Pi command/event-bus reporting.
- Added fake-Pi lifecycle and monitoring regression coverage for `/zerg` agent/team create/progress/stop flows, latest activity, and tree runtime hints.

### Changed

- Promoted package metadata and command/status/help/test version surfaces to v0.6.0 for the subagent runtime and monitoring milestone.

### Known Limitations

- Manual Pi host command/runtime validation has been performed for /zerg help/status/tree and agent/team lifecycle commands in a tmux pseudo-TTY; live TUI overlay/intervention validation has not been performed, so avoid claiming live overlay validation has passed.

## [0.5.1] - 2026-05-02

### Fixed

- Fixed fallback tree rendering to honor `AgentIdentity.childIds`-only hierarchy without duplicate roots while preserving cycle and truncation guards.
- Added bounded explicit-tree missing-child markers and durable render regression coverage for fallback childIds, explicit missing/orphan/duplicate/selected/cycle paths, team fallback, truncation, and non-mutation.

### Changed

- Promoted package metadata and public command/status/help/docs/test version surfaces to v0.5.1 for the audit bugfix patch.

## [0.5.0] - 2026-05-02

### Added

- Added expanded render/tree visibility for explicit `state.tree` nodes, team/agent fallback hierarchies, selected/status markers, orphan/missing-child/cycle safety, duplicate suppression, and bounded output with truncation.

### Changed

- Promoted package metadata and public command/status/help/docs/test version surfaces to v0.5.0 for the render/tree milestone.

### Known Limitations

- Manual Pi overlay verification has not been performed; live TUI overlays, subagent runtime loops, task queues, and intervention controls remain planned.

## [0.4.1] - 2026-05-02

### Fixed

- Fixed audit release-hygiene drift by aligning package metadata, command/status/help output, README current-release wording, tests, and the top changelog section on v0.4.1.
- Clarified this patch as a consistency-only audit bugfix while preserving v0.4.0 as the historical internal-patch milestone.

## [0.4.0] - 2026-05-01

### Added

- Added safe Pi event-bus internal bridge validation for emit and subscription observation, including focused regression coverage for forwarding `eventBus.on(...)` subscriptions and preserving original disposable return values.
- Added regression coverage for duplicate controllers sharing one Pi event bus so duplicate installation does not double-observe subscriptions or restore the active wrapper.

### Changed

- Promoted command/status/help/docs public version surfaces to v0.4.0 for the internal patch milestone.

### Fixed

- Preserved event-bus wrapper behavior after duplicate-controller disposal and verified no subscription telemetry is recorded after the active patch is disposed.

## [0.3.0] - 2026-05-01

### Added

- Added deterministic thinking-step derivation with source-line IDs, LF/CRLF parity, explicit status aliases, checkbox precedence, malformed-input skipping, and `/zerg steps` integration coverage.
- Expanded regression coverage for ordinary hyphenated bullet, numbered, star, and checkbox titles.

### Changed

- Promoted user-facing command/status/help version strings to v0.3.0 for the parse/thinking-step milestone.

### Fixed

- Required known status prefixes to use `:`/`：` or a whitespace-delimited hyphen separator, preserving titles such as `done-task`, `failed-first`, `todo-list`, and `needs-attention-task` instead of truncating them.

## [0.2.0] - 2026-05-01

### Added

- Added v0.2.0 state schema metadata, lifecycle/revision guard fields, team/tree/context/thinking contracts, and deterministic state container APIs.
- Added focused regression coverage for shared state snapshots, container read/update/replace flows, team/tree helpers, registration state snapshots, and type fixture surfaces.

### Changed

- Promoted package metadata and public command/status/help version strings to v0.2.0 for the completed types/state milestone.
- Routed extension registration and internal patch event writes through snapshot-safe state container helpers.

## [0.1.1] - 2026-05-01

### Fixed

- Corrected README validation-scope wording so `npm test` is documented as covering parser, command-surface, and render behavior.
- Added command-registration disposal cleanup for disposable Pi command hosts, including idempotent dispose behavior and clean re-registration after dispose.
- Released owned internal patch context state during extension disposal to keep repeated registration lifecycles isolated.

### Changed

- Expanded tests for duplicate-registration disposal lifecycle and nested tree rendering; current validation covers 12 Node tests.
- Updated package and user-facing status/help version strings for the v0.1.1 Session B audit bugfix patch.

## [0.1.0] - 2026-04-30

### Added

- Hardened slash-free Pi command registration for `/zerg`, `/zerg-swarm`, and `/swarm` command aliases.
- Added Pi-shaped command handler notifications for help, status, tree, and thinking-step parser output.
- Added command-surface tests for aliases, normalization, unknown usage, multiline steps, and duplicate registration.

### Changed

- Updated package metadata and user-facing scaffold status/help text for the v0.1.0 command-surface milestone.

### Not Yet Implemented

- Real subagent spawning, team runtime/loops, task queues, live Pi TUI overlays, and manual/automation intervention controls remain planned.

## [0.0.0] - 2026-04-30

### Added

- Initial Pi extension package scaffold with `pi.extensions` pointing to `./index.ts`.
- Strict TypeScript no-emit configuration and Node test script.
- Structural contracts for commands, agents, tasks, hook events, state, and minimal Pi context support.
- Pure thinking-step parser, state helpers, text renderers, and no-op-safe internal patch bridge.
- Public README, MIT license, and parser tests for the bootstrap surface.

### Not Yet Implemented

- Real subagent spawning, team loops, task queues, live Pi TUI overlays, and manual/automation intervention controls.
