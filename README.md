# pi-zerg-swarm

`pi-zerg-swarm` is a Pi coding-agent extension for native configurable agent teams, direct structured control, and zerg-style subagent orchestration. It is **not** a Raspberry Pi hardware swarm project.


> **v1.1.1 release status**
> The release includes native asynchronous `/zerg run --bg`, durable run/log recovery snapshots, direct structured automation through `createZergControl(...)`, Pi `zerg_control` tool registration when supported by the installed Pi API, a simplified KISS `/zerg config` overlay, and native team handoff/task-preservation fixes.
> Restart recovery restores inspectable run/log state and marks previously active native sessions as needing attention; it does not reconnect to a pre-restart live LLM session.

## Release status

- Current release: **v1.1.1** (patch release with native Larra MCP tool exposure for zerg agents, plus the v1.1.0 restart-durable run/log recovery snapshots, native async/background execution, direct structured control API/tool registration, native team member concurrency, team-id direct runs, Claude Code-style runtime agent/team/model configuration, and simplified interactive TUI management overlay).
- Historical milestones preserved for audit traceability: v0.8.0 implementation milestone and v0.8.1 audit follow-up patch.
- Mandatory RC audits for the release path: `prompts/audit/generalized-deep-audit_v2-0-0.md`, `prompts/audit/milestone-audit_v2-0-0.md`, `prompts/audit/security-audit_v2-0-0.md`, `prompts/audit/performance-audit_v2-0-0.md`, `prompts/audit/hardening-sweep_v2-0-0.md`, and `prompts/audit/themed-cleanup_v2-0-0.md`.
- Canonical repository metadata is configured for the public repo: https://github.com/fluxgear/pi-zerg-swarm.

## Commands

- `/zerg` — canonical command
- `/zerg-swarm` — alias
- `/swarm` — alias

At v1.1.0 these commands display help, status, expanded tree visibility, deterministic thinking-step parser output, Claude Code-style runtime agent-definition configuration, native Pi SDK-backed run execution, task-first subagent spawn state, explicit fresh/fork launch-mode metadata, command-host permission queue state, fine-grained lifecycle substate hints, bounded structured log/output inspection, restart-durable run/log recovery snapshots, process-lifetime background run status/interrupt/message support, and a componentized Pi-native interactive management TUI for live tree/detail/settings/chat/footer management views through snapshot-safe shared-state-backed Pi command handlers.
Command-host control grammar is available via `/zerg mode status|manual|assisted|automatic|revert [reason]`, `/zerg intervene agent|subagent|leader ...`, `/zerg agents list|show|create|update|delete` with per-agent `--model`, `--fallback-models`, `--max-turns`, tools, and permission settings, `/zerg agent`/`/zerg team` lifecycle configuration flags for team leaders/members/model metadata, `/zerg runs list|show <run-id>`, `/zerg permission status|list|request|approve|deny|cancel`, `/zerg logs status|list|show|json`, `/zerg config`, and `/zerg run <agent-or-team> <task> [--bg] [--fresh|--fork] [--model <model>]`; `/zerg run` does not require `pi-subagents` and uses the native Pi SDK runner when no slash bridge responds.

`/zerg config` is intended to stay simple: **Select** an agent/team/task, use **Settings** for mode/read-only/controller/permissions, and use **Message** to record an operator intervention. The overlay uses Pi theme colors when available and keeps the current key hints visible in the footer.

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
- v1.1.1: patch release exposing Larra MCP tools to native zerg agents when requested (current release)
- post-v1.1.1: deeper delivered-process transport validation and richer multi-window operator console polish

## License

MIT © 2026 Marc Mironescu (@crustyhacker) <marcm@crustyhacker.dev>
