import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { __zergNativeTestInternals, createPiZergCommandHandler, createZergCommandHandler, createZergControl, registerZergSwarmExtension, type ZergExtensionRegistration } from '../index.js';
import { installInternalPatch } from '../internal-patch.js';
import { deriveThinkingSteps } from '../parse.js';
import { createZergPersistenceManager } from '../persistence.js';
import { renderAgentDefinitionSummary, renderAgentDefinitionsList, renderAgentTree, renderHelp, renderMonitor, renderPermissionQueueList, renderStatusLine, renderZergLogList, renderZergLogStatus, renderZergManagementOverlay } from '../render.js';
import { appendHookEvent, appendZergLogRecord, appendZergLogRecords, applyInterventionRecord, applyModeTransition, applyRuntimeTransition, createBuiltinAgentDefinitions, createZergState, createZergStateContainer, createZergSubagentRunSnapshot, enqueuePermissionRequest, getAgentDefinition, getAgentDefinitions, getCurrentAgents, getCurrentMode, getCurrentTasks, getCurrentTeams, getCurrentTree, getPendingPermissionRequests, getPermissionQueueState, getSelectedTreeNode, getSubagentRunSnapshot, getZergLogs, getZergLogState, readSharedZergState, removeAgentDefinition, replaceSharedZergState, replayRuntimeTransitions, resetZergState, resolvePermissionRequest, selectNode, setMode, snapshotZergState, upsertAgentDefinition, updateSharedZergState, updateZergState, upsertAgent, upsertTask, upsertTeam, upsertTreeNode } from '../state.js';
import { ZERG_EXTENSION_VERSION, ZERG_STATE_SCHEMA_VERSION, type AgentStatus, type HookLifecycleEvent, type StructuralPiCommandContext, type StructuralPiCommandOptions, type TaskStatus, type TeamIdentity, type ZergLifecycleSubstate, type ZergLogRecord, type ZergRuntimeTransition, type ZergState, type ZergStateContainer, type ZergSubagentControlAdapter, type ZergSubagentControlResult, type ZergSubagentLaunchRequest, type ZergSubagentRunSnapshot, type ZergTreeNode } from '../types.js';

type AssertAssignable<T extends true> = T;
type ContainerReadReturnsState = AssertAssignable<ReturnType<ZergStateContainer['read']> extends ZergState ? true : false>;
type RegistrationStateExposesSnapshot = AssertAssignable<ZergExtensionRegistration['state'] extends ZergState ? true : false>;
type _assertAgentStatusCompatibility = AssertAssignable<AgentStatus extends 'idle' | 'running' | 'blocked' | 'needs-attention' | 'done' | 'failed' | 'cancelled' ? true : false>;
type _assertTaskStatusCompatibility = AssertAssignable<TaskStatus extends AgentStatus ? true : false>;
type _assertLifecycleSubstateIncludesWaitingPermission = AssertAssignable<'waiting-permission' extends ZergLifecycleSubstate ? true : false>;

test('runtime extension version matches package metadata', () => {
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: unknown };
  assert.equal(packageJson.version, ZERG_EXTENSION_VERSION);
});

const VALID_AGENT_RUNTIME_TRANSITION = {
  entity: 'agent',
  action: 'create',
  id: 'agent-valid',
  kind: 'subagent',
  parentId: 'root',
} satisfies ZergRuntimeTransition;

const VALID_TEAM_RUNTIME_TRANSITION = {
  entity: 'team',
  action: 'create',
  id: 'team-valid',
  kind: 'team',
  memberAgentIds: ['agent-valid'],
} satisfies ZergRuntimeTransition;

const INVALID_AGENT_TEAM_KIND_TRANSITION = {
  entity: 'agent',
  action: 'create',
  id: 'agent-invalid-kind',
  kind: 'team',
} as const;

const INVALID_AGENT_TEAM_FIELDS_TRANSITION = {
  entity: 'agent',
  action: 'create',
  id: 'agent-invalid-fields',
  leaderAgentId: 'lead-1',
} as const;

const INVALID_TEAM_AGENT_FIELDS_TRANSITION = {
  entity: 'team',
  action: 'create',
  id: 'team-invalid-fields',
  parentId: 'parent-1',
} as const;

type _assertInvalidAgentTeamKindTransition = AssertAssignable<typeof INVALID_AGENT_TEAM_KIND_TRANSITION extends ZergRuntimeTransition ? false : true>;
type _assertInvalidAgentTeamFieldsTransition = AssertAssignable<typeof INVALID_AGENT_TEAM_FIELDS_TRANSITION extends ZergRuntimeTransition ? false : true>;
type _assertInvalidTeamAgentFieldsTransition = AssertAssignable<typeof INVALID_TEAM_AGENT_FIELDS_TRANSITION extends ZergRuntimeTransition ? false : true>;

void VALID_AGENT_RUNTIME_TRANSITION;
void VALID_TEAM_RUNTIME_TRANSITION;

function createCommandSurfaceState(): ZergState {
  return createZergState({
    agents: {
      root: { id: 'root', label: 'Root', kind: 'team-leader', status: 'running' },
    },
    tasks: {
      task: { id: 'task', title: 'Implement command surface', status: 'running', ownerAgentId: 'root', updatedAt: '2026-04-30T00:00:00.000Z' },
    },
  });
}

interface FakePiSubscription {
  disposed: boolean;
  disposeCount: number;
  dispose(): void;
}

interface FakePiEventBus {
  emit(eventName: unknown, ...args: unknown[]): number;
  on(eventName: unknown, handler: (...args: unknown[]) => unknown): FakePiSubscription;
  emitted: Array<{ eventName: unknown; args: unknown[] }>;
  subscriptions: Array<{ eventName: unknown; handler: (...args: unknown[]) => unknown; disposable: FakePiSubscription }>;
}

function createNowSequence(...timestamps: string[]): () => Date {
  const queue = [...timestamps];

  return () => {
    const next = queue.shift();
    assert.ok(next, 'expected another queued timestamp');
    return new Date(next);
  };
}

function createFakePiEventBus(): FakePiEventBus {
  const eventBus: FakePiEventBus = {
    emitted: [],
    subscriptions: [],
    emit(eventName, ...args) {
      eventBus.emitted.push({ eventName, args });
      return eventBus.emitted.length;
    },
    on(eventName, handler) {
      const disposable: FakePiSubscription = {
        disposed: false,
        disposeCount: 0,
        dispose() {
          disposable.disposed = true;
          disposable.disposeCount += 1;
        },
      };

      eventBus.subscriptions.push({ eventName, handler, disposable });
      return disposable;
    },
  };

  return eventBus;
}

test('createZergState provides deterministic v0.2.0 defaults', () => {
  const state = createZergState();

  assert.equal(state.schemaVersion, ZERG_STATE_SCHEMA_VERSION);
  assert.equal(state.lifecycle, 'ready');
  assert.equal(state.revision, 0);
  assert.deepEqual(state.agents, {});
  assert.deepEqual(state.tasks, {});
  assert.deepEqual(state.teams, {});
  assert.deepEqual(state.tree, {});
  assert.deepEqual(state.events, []);
  assert.deepEqual(state.mode, { automation: 'manual', interventionEnabled: true, controller: 'operator' });
  assert.deepEqual(state.agentDefinitions, {});
  assert.deepEqual(state.metadata, { createdAt: '1970-01-01T00:00:00.000Z', updatedAt: '1970-01-01T00:00:00.000Z', resetCount: 0, source: undefined, labels: undefined, extensions: undefined });
  assert.deepEqual(resetZergState(), state);
});

test('createZergState clones seeded nested state', () => {
  const seed = {
    revision: 4,
    agents: {
      root: { id: 'root', label: 'Root', kind: 'team-leader' as const, status: 'running' as const, childIds: ['child'] },
    },
    tasks: {
      task: { id: 'task', title: 'Seed task', status: 'blocked' as const, blockedBy: ['dep'], updatedAt: '2026-04-30T00:00:00.000Z' },
    },
    teams: {
      team: { id: 'team', label: 'Team', kind: 'team' as const, status: 'running' as const, memberAgentIds: ['root'], taskIds: ['task'] },
    },
    tree: {
      node: { id: 'node', kind: 'agent' as const, label: 'Root', childIds: ['task-node'], refId: 'root' },
    },
  };

  const state = createZergState(seed);
  seed.agents.root.childIds.push('later');
  seed.tasks.task.blockedBy.push('later');
  seed.teams.team.memberAgentIds.push('later');
  seed.tree.node.childIds.push('later');

  assert.deepEqual(state.agents.root?.childIds, ['child']);
  assert.deepEqual(state.tasks.task?.blockedBy, ['dep']);
  assert.deepEqual(state.teams.team?.memberAgentIds, ['root']);
  assert.deepEqual(state.tree.node?.childIds, ['task-node']);
  assert.equal(state.revision, 4);
});

test('createBuiltinAgentDefinitions returns deterministic seeded definitions', () => {
  const builtins = createBuiltinAgentDefinitions();
  const again = createBuiltinAgentDefinitions();

  assert.deepEqual(Object.keys(builtins), ['generalist', 'planner', 'reviewer']);
  assert.deepEqual(builtins.generalist.id, 'generalist');
  assert.deepEqual(builtins.planner.label, 'Planner');
  assert.deepEqual(builtins.reviewer.source, 'builtin');

  again.generalist.prompt = 'tampered';
  assert.notEqual(builtins.generalist.prompt, 'tampered');
});

test('snapshotZergState returns independent copies', () => {
  const state = createZergState({
    agents: { root: { id: 'root', label: 'Root', kind: 'team-leader', status: 'running', childIds: ['child'] } },
    teams: { team: { id: 'team', label: 'Team', kind: 'team', status: 'running', memberAgentIds: ['root'] } },
  });

  const snapshot = snapshotZergState(state);
  snapshot.agents.root?.childIds?.push('mutated');
  snapshot.teams.team?.memberAgentIds.push('mutated');

  assert.deepEqual(state.agents.root?.childIds, ['child']);
  assert.deepEqual(state.teams.team?.memberAgentIds, ['root']);
});

test('snapshot and read helpers deep clone nested metadata and extensions', () => {
  const state = createZergState({
    metadata: {
      createdAt: '1970-01-01T00:00:00.000Z',
      updatedAt: '1970-01-01T00:00:00.000Z',
      resetCount: 0,
      extensions: {
        preferences: { flags: ['state-original'] },
      },
    },
    extensions: {
      runtime: { labels: ['extension-original'] },
    },
    agentDefinitions: {
      reviewer: {
        id: 'reviewer',
        label: 'Reviewer',
        prompt: 'review tasks',
        source: 'user',
        tools: ['analysis', 'analysis'],
        metadata: {
          metadataBucket: { tags: ['meta-original'] },
        },
        extensions: {
          extensionBucket: { scopes: ['ext-original'] },
        },
      },
    },
    agents: {
      root: {
        id: 'root',
        label: 'Root',
        kind: 'team-leader',
        status: 'running',
        metadata: {
          profile: { tags: ['metadata-original'] },
        },
        extensions: {
          config: { modes: ['extension-original'] },
        },
      },
    },
  });

  const snapshot = snapshotZergState(state);
  (snapshot.metadata.extensions?.preferences as { flags: string[] }).flags.push('state-mutated');
  (snapshot.extensions?.runtime as { labels: string[] }).labels.push('extension-mutated');
  (snapshot.agents.root?.metadata?.profile as { tags: string[] }).tags.push('metadata-mutated');
  (snapshot.agents.root?.extensions?.config as { modes: string[] }).modes.push('extension-mutated');
  const snapshotDefinition = snapshot.agentDefinitions.reviewer as unknown as {
    metadata: { metadataBucket: { tags: string[] } };
    extensions: { extensionBucket: { scopes: string[] } };
  };
  snapshotDefinition.metadata.metadataBucket.tags.push('meta-mutated');
  snapshotDefinition.extensions.extensionBucket.scopes.push('ext-mutated');

  assert.deepEqual((state.metadata.extensions?.preferences as { flags: string[] }).flags, ['state-original']);
  assert.deepEqual((state.extensions?.runtime as { labels: string[] }).labels, ['extension-original']);
  assert.deepEqual((state.agents.root?.metadata?.profile as { tags: string[] }).tags, ['metadata-original']);
  assert.deepEqual((state.agents.root?.extensions?.config as { modes: string[] }).modes, ['extension-original']);
  assert.deepEqual((state.agentDefinitions.reviewer as unknown as { metadata: { metadataBucket: { tags: string[] } } }).metadata.metadataBucket.tags, ['meta-original']);
  assert.deepEqual((state.agentDefinitions.reviewer as unknown as { extensions: { extensionBucket: { scopes: string[] } } }).extensions.extensionBucket.scopes, ['ext-original']);

  const container = createZergStateContainer(state);
  const readState = container.read();
  (readState.metadata.extensions?.preferences as { flags: string[] }).flags.push('read-mutated');
  (readState.extensions?.runtime as { labels: string[] }).labels.push('read-mutated');
  (readState.agents.root?.metadata?.profile as { tags: string[] }).tags.push('read-mutated');
  (readState.agents.root?.extensions?.config as { modes: string[] }).modes.push('read-mutated');

  const rereadState = container.read();
  assert.deepEqual((rereadState.metadata.extensions?.preferences as { flags: string[] }).flags, ['state-original']);
  assert.deepEqual((rereadState.extensions?.runtime as { labels: string[] }).labels, ['extension-original']);
  assert.deepEqual((rereadState.agents.root?.metadata?.profile as { tags: string[] }).tags, ['metadata-original']);
  assert.deepEqual((rereadState.agents.root?.extensions?.config as { modes: string[] }).modes, ['extension-original']);
});

test('agent definition helpers normalize ids, clone deep, dedupe tools, and reject invalid inputs', () => {
  const seeded = createZergState();
  const withPlanner = upsertAgentDefinition(seeded, {
    id: '  Planner_  ',
    label: 'Planner',
    prompt: '  plan tasks clearly ',
    source: 'user',
    tools: ['shell', ' shell ', 'search', 'search'],
    disallowedTools: ['tool-a', 'tool-a', ''],
    metadata: { notes: { tags: ['original'] } },
  });
  const listed = getAgentDefinitions(withPlanner);
  const planner = getAgentDefinition(withPlanner, 'planner');

  assert.deepEqual(listed.map((definition) => definition.id), ['planner']);
  assert.deepEqual(planner?.tools, ['search', 'shell']);
  assert.deepEqual(planner?.disallowedTools, ['tool-a']);
  assert.deepEqual(planner?.prompt, 'plan tasks clearly');
  assert.equal(planner?.label, 'Planner');

  listed[0]!.prompt = 'mutated from getter';
  assert.equal(withPlanner.agentDefinitions.planner?.prompt, 'plan tasks clearly');

  const withGeneralist = upsertAgentDefinition(withPlanner, {
    id: 'generalist',
    label: 'Generalist',
    prompt: 'default support',
    source: 'user',
    tools: ['analysis'],
  });
  const sortedDefinitions = getAgentDefinitions(withGeneralist);

  assert.deepEqual(sortedDefinitions.map((definition) => definition.id), ['generalist', 'planner']);

  const withoutPlanner = removeAgentDefinition(withGeneralist, 'planner');
  assert.deepEqual(Object.keys(withoutPlanner.agentDefinitions), ['generalist']);

  assert.throws(() => upsertAgentDefinition(withGeneralist, {
    id: '___',
    label: 'No id',
    prompt: 'missing id',
    source: 'user',
  }), /agent definition id must be a non-empty string/);

  assert.throws(() => upsertAgentDefinition(withPlanner, {
    id: 'invalid',
    label: 'No prompt',
    prompt: '   ',
    source: 'user',
  }), /agent definition prompt must be a non-empty string/);
});

test('state update helpers are immutable and deterministic', () => {
  const initial = createZergState();
  const withAgent = upsertAgent(initial, { id: 'root', label: 'Root', kind: 'team-leader', status: 'running' });
  const selected = selectNode(withAgent, 'root');
  const assisted = setMode(selected, { automation: 'assisted' });
  const preserved = updateZergState(assisted, { lifecycle: 'ready' }, { preserveRevision: true });

  assert.notEqual(withAgent, initial);
  assert.deepEqual(initial.agents, {});
  assert.equal(withAgent.revision, 1);
  assert.equal(selected.revision, 2);
  assert.equal(assisted.revision, 3);
  assert.equal(preserved.revision, 3);
  assert.equal(assisted.mode.automation, 'assisted');
  assert.deepEqual(getCurrentAgents(assisted).map((agent) => agent.id), ['root']);
});

test('appendHookEvent truncates events and leaves the original state unchanged', () => {
  const event = (id: string): HookLifecycleEvent => ({ id, type: 'hook', message: id, createdAt: '2026-04-30T00:00:00.000Z' });
  const initial = createZergState();
  const first = appendHookEvent(initial, event('one'), 2);
  const second = appendHookEvent(first, event('two'), 2);
  const third = appendHookEvent(second, event('three'), 2);

  assert.deepEqual(initial.events, []);
  assert.deepEqual(third.events.map((item) => item.id), ['two', 'three']);
  assert.equal(third.revision, 3);
});

test('shared state replacement and reads are snapshot isolated', () => {
  replaceSharedZergState(createZergState({
    agents: { root: { id: 'root', label: 'Root', kind: 'team-leader', status: 'running' } },
  }));

  const first = readSharedZergState();
  first.agents.root!.label = 'Mutated';
  const second = readSharedZergState();

  assert.equal(second.agents.root?.label, 'Root');
  assert.equal(second.revision, 0);

  replaceSharedZergState();
});

test('state container subscriptions publish async-safe snapshots and unsubscribe cleanly', () => {
  const container = createZergStateContainer();
  const revisions: number[] = [];
  const labels: string[] = [];
  const unsubscribe = container.subscribe?.((state) => {
    revisions.push(state.revision);
    labels.push(state.agents.root?.label ?? 'missing');
    if (state.agents.root) {
      state.agents.root.label = 'mutated-listener-copy';
    }
  });

  assert.equal(typeof unsubscribe, 'function');
  container.update({ agents: { root: { id: 'root', label: 'Root', kind: 'team-leader', status: 'running' } } });
  container.replace(createZergState({ agents: { root: { id: 'root', label: 'Replacement', kind: 'team-leader', status: 'idle' } } }));
  unsubscribe?.();
  container.update({ agents: { root: { id: 'root', label: 'After unsubscribe', kind: 'team-leader', status: 'done' } } });

  assert.deepEqual(revisions, [1, 0]);
  assert.deepEqual(labels, ['Root', 'Replacement']);
  assert.equal(container.snapshot().agents.root?.label, 'After unsubscribe');
});

test('installInternalPatch emits monotonic IDs through truncation', () => {
  const state = createZergState();
  const patch = installInternalPatch({}, state, {
    maxEvents: 2,
    now: () => new Date('2026-04-30T00:00:00.000Z'),
  });

  const emitted = [
    patch.emit({ type: 'hook', message: 'one' }),
    patch.emit({ type: 'hook', message: 'two' }),
    patch.emit({ type: 'hook', message: 'three' }),
    patch.emit({ type: 'hook', message: 'four' }),
  ];

  assert.equal(patch.installed, false);
  assert.deepEqual(emitted.map((event) => event.id), ['event-1', 'event-2', 'event-3', 'event-4']);
  assert.deepEqual(state.events.map((event) => event.id), ['event-3', 'event-4']);
  assert.deepEqual(state.events.map((event) => event.message), ['three', 'four']);
  assert.deepEqual(state.events.map((event) => event.createdAt), ['2026-04-30T00:00:00.000Z', '2026-04-30T00:00:00.000Z']);
  assert.equal(state.revision, 4);

  patch.dispose();
  assert.throws(() => patch.emit({ type: 'hook', message: 'after dispose' }), /Cannot emit/);
});

test('installInternalPatch wraps Pi event bus once and restores on dispose', () => {
  const state = createZergState();
  const eventBus = createFakePiEventBus();
  const originalEmit = eventBus.emit;
  const originalOn = eventBus.on;
  const patch = installInternalPatch({ events: eventBus }, state, {
    maxEvents: 2,
    now: () => new Date('2026-04-30T00:00:00.000Z'),
  });

  assert.equal(patch.installed, true);
  assert.notEqual(eventBus.emit, originalEmit);
  assert.notEqual(eventBus.on, originalOn);

  assert.equal(eventBus.emit('agent:started', { id: 'root' }), 1);
  assert.deepEqual(state.events.map((event) => event.message), ['pi-zerg-swarm observed Pi event bus emit: agent:started']);

  eventBus.emit('agent:continued');
  eventBus.emit('agent:finished');

  assert.deepEqual(state.events.map((event) => event.id), ['event-2', 'event-3']);
  assert.deepEqual(state.events.map((event) => event.message), [
    'pi-zerg-swarm observed Pi event bus emit: agent:continued',
    'pi-zerg-swarm observed Pi event bus emit: agent:finished',
  ]);

  patch.dispose();
  assert.equal(eventBus.emit, originalEmit);
  assert.equal(eventBus.on, originalOn);

  const reinstalled = installInternalPatch({ events: eventBus }, state);
  assert.equal(reinstalled.installed, true);
  reinstalled.dispose();
});

test('installInternalPatch observes event-bus subscriptions once and preserves disposables', () => {
  const state = createZergState();
  const eventBus = createFakePiEventBus();
  const originalOn = eventBus.on;
  const first = installInternalPatch({ events: eventBus }, state, {
    now: () => new Date('2026-04-30T00:00:00.000Z'),
  });
  const wrappedOn = eventBus.on;
  const duplicate = installInternalPatch({ events: eventBus }, state);

  assert.equal(first.installed, true);
  assert.equal(duplicate.installed, false);

  const handler = () => 'handled';
  const subscription = eventBus.on('agent:started', handler);

  assert.equal(eventBus.subscriptions.length, 1);
  assert.equal(eventBus.subscriptions[0]?.eventName, 'agent:started');
  assert.equal(eventBus.subscriptions[0]?.handler, handler);
  assert.equal(subscription, eventBus.subscriptions[0]?.disposable);

  subscription.dispose();
  assert.equal(subscription.disposed, true);
  assert.equal(subscription.disposeCount, 1);

  assert.equal(state.events.filter((event) => event.message.includes('event bus subscription: agent:started')).length, 1);

  duplicate.dispose();
  assert.equal(eventBus.on, wrappedOn);

  eventBus.on('agent:continued', () => undefined);
  assert.equal(state.events.filter((event) => event.message.includes('event bus subscription: agent:continued')).length, 1);

  first.dispose();
  assert.equal(eventBus.on, originalOn);

  const eventCountAfterDispose = state.events.length;
  eventBus.on('agent:stopped', () => undefined);

  assert.equal(eventBus.subscriptions.length, 3);
  assert.equal(state.events.length, eventCountAfterDispose);
  assert.equal(state.events.filter((event) => event.message.includes('event bus subscription: agent:stopped')).length, 0);
});

test('installInternalPatch duplicate controllers do not double-wrap or restore active patch', () => {
  const state = createZergState();
  const eventBus = createFakePiEventBus();
  const originalEmit = eventBus.emit;
  const first = installInternalPatch({ events: eventBus }, state);
  const wrappedEmit = eventBus.emit;
  const duplicate = installInternalPatch({ events: eventBus }, state);

  assert.equal(first.installed, true);
  assert.equal(duplicate.installed, false);
  assert.equal(eventBus.emit, wrappedEmit);

  eventBus.emit('tick');
  assert.equal(state.events.filter((event) => event.message.includes('event bus emit: tick')).length, 1);

  duplicate.dispose();
  assert.equal(eventBus.emit, wrappedEmit);

  eventBus.emit('tock');
  assert.equal(state.events.filter((event) => event.message.includes('event bus emit: tock')).length, 1);

  first.dispose();
  assert.equal(eventBus.emit, originalEmit);
});

test('installInternalPatch rolls back partial event-bus patch failure', () => {
  const state = createZergState();
  const eventBus = createFakePiEventBus();
  const originalEmit = eventBus.emit;

  Object.defineProperty(eventBus, 'on', {
    configurable: true,
    get() {
      return () => ({ dispose() {} });
    },
    set() {
      throw new Error('cannot patch on');
    },
  });

  assert.throws(() => installInternalPatch({ events: eventBus }, state), /cannot patch on/);
  assert.equal(eventBus.emit, originalEmit);

  const reusableBus = createFakePiEventBus();
  const patch = installInternalPatch({ events: reusableBus }, state);
  assert.equal(patch.installed, true);
  patch.dispose();
});

test('installInternalPatch unsupported contexts use fallback lifecycle emission', () => {
  const state = createZergState();
  const patch = installInternalPatch({}, state, {
    now: () => new Date('2026-04-30T00:00:00.000Z'),
  });

  assert.equal(patch.installed, false);
  const emitted = patch.emit({ type: 'hook', message: 'fallback explicit lifecycle' });

  assert.equal(emitted.id, 'event-1');
  assert.equal(emitted.createdAt, '2026-04-30T00:00:00.000Z');
  assert.deepEqual(state.events.map((event) => event.message), ['fallback explicit lifecycle']);

  patch.dispose();
  assert.throws(() => patch.emit({ type: 'hook', message: 'after dispose' }), /Cannot emit/);
});

test('createZergStateContainer read snapshot replace and update return isolated state', () => {
  const container = createZergStateContainer({
    agents: {
      root: { id: 'root', label: 'Root', kind: 'team-leader', status: 'running', childIds: ['child'] },
    },
  });

  const readState = container.read();
  const snapshotState = container.snapshot();
  readState.agents.root!.label = 'Mutated read';
  snapshotState.agents.root!.childIds!.push('mutated-snapshot');

  assert.equal(container.read().agents.root?.label, 'Root');
  assert.deepEqual(container.snapshot().agents.root?.childIds, ['child']);

  const replaced = container.replace({
    tasks: {
      task: { id: 'task', title: 'Container task', status: 'running', updatedAt: '2026-04-30T00:00:00.000Z' },
    },
  });
  replaced.tasks.task!.title = 'Mutated replace result';

  assert.deepEqual(container.read().agents, {});
  assert.equal(container.read().tasks.task?.title, 'Container task');

  const updated = container.update((state) => ({
    tasks: {
      ...state.tasks,
      second: { id: 'second', title: 'Second task', status: 'done', updatedAt: '2026-04-30T00:00:00.000Z' },
    },
    mode: { ...state.mode, automation: 'automatic' },
  }), { updatedAt: '2026-04-30T01:00:00.000Z' });
  updated.tasks.second!.title = 'Mutated update result';
  updated.mode.automation = 'manual';

  const afterUpdate = container.snapshot();
  assert.equal(afterUpdate.revision, 1);
  assert.equal(afterUpdate.metadata.updatedAt, '2026-04-30T01:00:00.000Z');
  assert.equal(afterUpdate.tasks.second?.title, 'Second task');
  assert.equal(afterUpdate.mode.automation, 'automatic');
});

test('registration.state exposes event snapshots, not a write channel', () => {
  const registration = registerZergSwarmExtension({});

  try {
    const firstSnapshot = registration.state;
    assert.equal(firstSnapshot.events.length, 1);
    assert.equal(firstSnapshot.events[0]?.message, `pi-zerg-swarm v${ZERG_EXTENSION_VERSION} internal patch unavailable; command surface registered`);

    firstSnapshot.events[0]!.message = 'mutated registration event';
    firstSnapshot.events.push({
      id: 'external',
      type: 'state',
      message: 'external mutation',
      createdAt: '2026-04-30T00:00:00.000Z',
    });
    firstSnapshot.mode.automation = 'automatic';

    const secondSnapshot = registration.state;
    assert.equal(secondSnapshot.events.length, 1);
    assert.equal(secondSnapshot.events[0]?.message, `pi-zerg-swarm v${ZERG_EXTENSION_VERSION} internal patch unavailable; command surface registered`);
    assert.equal(secondSnapshot.mode.automation, 'manual');

    secondSnapshot.events[0]!.message = 'mutated second snapshot';
    assert.equal(registration.state.events[0]?.message, `pi-zerg-swarm v${ZERG_EXTENSION_VERSION} internal patch unavailable; command surface registered`);
  } finally {
    registration.dispose();
  }
});

test('shared team tree helpers and readers return clones', () => {
  replaceSharedZergState();

  try {
    const shared = updateSharedZergState((state) => ({
      agents: {
        ...state.agents,
        root: { id: 'root', label: 'Root', kind: 'team-leader', status: 'running' },
      },
      tasks: {
        ...state.tasks,
        task: { id: 'task', title: 'Shared task', status: 'running', ownerAgentId: 'root', updatedAt: '2026-04-30T00:00:00.000Z', blockedBy: ['dep'] },
      },
    }), { updatedAt: '2026-04-30T02:00:00.000Z' });
    shared.agents.root!.label = 'Mutated shared snapshot';

    const rereadShared = readSharedZergState();
    assert.equal(rereadShared.revision, 1);
    assert.equal(rereadShared.metadata.updatedAt, '2026-04-30T02:00:00.000Z');
    assert.equal(rereadShared.agents.root?.label, 'Root');

    const team: TeamIdentity = {
      id: 'team',
      label: 'Team',
      kind: 'team',
      status: 'running',
      leaderAgentId: 'root',
      memberAgentIds: ['root'],
      taskIds: ['task'],
    };
    const node: ZergTreeNode = {
      id: 'root-node',
      kind: 'agent',
      label: 'Root node',
      status: 'running',
      refId: 'root',
      childIds: ['task-node'],
    };

    let state = createZergState({
      tasks: { task: rereadShared.tasks.task! },
      mode: { automation: 'assisted', interventionEnabled: false, controller: 'operator' },
    });
    state = upsertTeam(state, team);
    state = upsertTreeNode(state, node);
    state = selectNode(state, 'root-node');
    team.memberAgentIds.push('mutated-after-upsert');
    node.childIds.push('mutated-after-upsert');

    const tasks = getCurrentTasks(state);
    const teams = getCurrentTeams(state);
    const tree = getCurrentTree(state);
    const mode = getCurrentMode(state);
    const selected = getSelectedTreeNode(state);

    tasks[0]!.title = 'Mutated task reader';
    tasks[0]!.blockedBy!.push('mutated-reader');
    teams[0]!.memberAgentIds.push('mutated-reader');
    tree['root-node']!.childIds.push('mutated-reader');
    mode.automation = 'automatic';
    selected!.childIds.push('mutated-selected-reader');

    assert.equal(state.tasks.task?.title, 'Shared task');
    assert.deepEqual(state.tasks.task?.blockedBy, ['dep']);
    assert.deepEqual(state.teams.team?.memberAgentIds, ['root']);
    assert.deepEqual(state.tree['root-node']?.childIds, ['task-node']);
    assert.equal(state.mode.automation, 'assisted');
    assert.deepEqual(getSelectedTreeNode(state)?.childIds, ['task-node']);
  } finally {
    replaceSharedZergState();
  }
});


test('applyRuntimeTransition records deterministic agent and team lifecycle state', () => {
  const initial = createZergState({
    metadata: { createdAt: '2026-05-02T20:00:00.000Z', updatedAt: '2026-05-02T20:00:00.000Z', resetCount: 0 },
  });

  let state = applyRuntimeTransition(initial, {
    entity: 'agent',
    action: 'create',
    id: 'worker',
    label: 'Worker',
    at: '2026-05-02T20:01:00.000Z',
    mode: { automation: 'assisted', interventionEnabled: false, contextId: 'ctx-runtime' },
  });
  state = applyRuntimeTransition(state, { entity: 'agent', action: 'start', id: 'worker', at: '2026-05-02T20:02:00.000Z' });
  state = applyRuntimeTransition(state, { entity: 'agent', action: 'progress', id: 'worker', activity: 'editing state', at: '2026-05-02T20:03:00.000Z' });
  state = applyRuntimeTransition(state, { entity: 'agent', action: 'stop', id: 'worker', at: '2026-05-02T20:04:00.000Z' });
  state = applyRuntimeTransition(state, { entity: 'team', action: 'create', id: 'ops', label: 'Ops', memberAgentIds: ['worker', 'worker'], at: '2026-05-02T20:05:00.000Z' });
  state = applyRuntimeTransition(state, { entity: 'team', action: 'fail', id: 'ops', activity: 'blocked on review', at: '2026-05-02T20:06:00.000Z' });
  state = applyRuntimeTransition(state, { entity: 'team', action: 'reset', id: 'ops', at: '2026-05-02T20:07:00.000Z' });

  assert.deepEqual(initial.agents, {});
  assert.equal(state.revision, 7);
  assert.equal(state.metadata.updatedAt, '2026-05-02T20:07:00.000Z');
  assert.equal(state.agents.worker?.status, 'done');
  assert.equal(state.agents.worker?.runtime?.health, 'stopped');
  assert.equal(state.agents.worker?.runtime?.createdAt, '2026-05-02T20:01:00.000Z');
  assert.equal(state.agents.worker?.runtime?.startedAt, '2026-05-02T20:02:00.000Z');
  assert.equal(state.agents.worker?.runtime?.stoppedAt, '2026-05-02T20:04:00.000Z');
  assert.equal(state.agents.worker?.runtime?.lastActivity, 'stopped');
  assert.equal(state.agents.worker?.runtime?.mode.automation, 'assisted');
  assert.equal(state.agents.worker?.runtime?.mode.interventionEnabled, false);
  assert.equal(state.agents.worker?.runtime?.mode.contextId, 'ctx-runtime');
  assert.equal(state.teams.ops?.status, 'idle');
  assert.deepEqual(state.teams.ops?.memberAgentIds, ['worker']);
  assert.equal(state.teams.ops?.runtime?.health, 'unknown');
  assert.equal(state.teams.ops?.runtime?.startedAt, undefined);
  assert.equal(state.teams.ops?.runtime?.stoppedAt, undefined);
  assert.deepEqual(state.events.map((event) => event.id), ['runtime-1', 'runtime-2', 'runtime-3', 'runtime-4', 'runtime-5', 'runtime-6', 'runtime-7']);
  assert.deepEqual(state.events.map((event) => event.sequence), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(state.events.map((event) => event.revision), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(state.events.map((event) => event.action), ['create', 'start', 'progress', 'stop', 'create', 'fail', 'reset']);
  assert.equal(state.events[2]?.message, 'agent worker progress: editing state');
  assert.equal(state.events[5]?.health, 'failed');
});

test('lifecycle substates map actions sanitize reasons and clone snapshots', () => {
  const longReason = `  waiting\n${String.fromCharCode(0)} ${'x'.repeat(200)}  `;
  let state = applyRuntimeTransition(createZergState(), {
    entity: 'agent',
    action: 'create',
    id: 'worker',
    label: 'Worker',
    substateReason: longReason,
    at: '2026-05-08T22:00:00.000Z',
  });
  state = applyRuntimeTransition(state, { entity: 'agent', action: 'start', id: 'worker', at: '2026-05-08T22:01:00.000Z' });
  state = applyRuntimeTransition(state, { entity: 'agent', action: 'progress', id: 'worker', activity: 'tool edit', at: '2026-05-08T22:02:00.000Z' });
  state = applyRuntimeTransition(state, { entity: 'agent', action: 'progress', id: 'worker', activity: 'custom', substate: 'waiting-input', substateReason: 'operator input', at: '2026-05-08T22:03:00.000Z' });
  state = applyRuntimeTransition(state, { entity: 'agent', action: 'stop', id: 'worker', at: '2026-05-08T22:04:00.000Z' });
  state = applyRuntimeTransition(state, { entity: 'team', action: 'fail', id: 'ops', at: '2026-05-08T22:05:00.000Z' });
  state = applyRuntimeTransition(state, { entity: 'team', action: 'reset', id: 'ops', at: '2026-05-08T22:06:00.000Z' });

  assert.equal(state.agents.worker?.status, 'done');
  assert.equal(state.agents.worker?.runtime?.substate, 'completed');
  assert.equal(state.agents.worker?.runtime?.substateUpdatedAt, '2026-05-08T22:04:00.000Z');
  assert.equal(state.teams.ops?.status, 'idle');
  assert.equal(state.teams.ops?.runtime?.substate, 'reset');
  assert.deepEqual(state.events.map((event) => event.substate), ['queued', 'starting', 'tool-running', 'waiting-input', 'completed', 'failed', 'reset']);
  assert.equal(state.events[0]?.substateReason?.includes('\n'), false);
  assert.equal((state.events[0]?.substateReason ?? '').length, 160);
  assert.equal(state.events[3]?.substateReason, 'operator input');

  const snapshot = snapshotZergState(state);
  snapshot.agents.worker!.runtime!.substateReason = 'mutated';
  assert.equal(state.agents.worker?.runtime?.substateReason, undefined);
});

test('replayRuntimeTransitions is deterministic and bounds transition events', () => {
  const transitions: ZergRuntimeTransition[] = [
    { entity: 'agent', action: 'create', id: 'worker', at: '2026-05-02T21:01:00.000Z' },
    { entity: 'agent', action: 'start', id: 'worker', at: '2026-05-02T21:02:00.000Z' },
    { entity: 'agent', action: 'progress', id: 'worker', activity: 'editing state', at: '2026-05-02T21:03:00.000Z' },
  ];
  const seed = createZergState({ metadata: { createdAt: '2026-05-02T21:00:00.000Z', updatedAt: '2026-05-02T21:00:00.000Z', resetCount: 0 } });

  const first = replayRuntimeTransitions(seed, transitions, { maxEvents: 2 });
  const second = replayRuntimeTransitions(seed, transitions, { maxEvents: 2 });

  assert.deepEqual(second, first);
  assert.equal(seed.revision, 0);
  assert.deepEqual(first.events.map((event) => event.id), ['runtime-2', 'runtime-3']);
  assert.equal(first.agents.worker?.runtime?.lastActivity, 'editing state');
  assert.equal(first.agents.worker?.runtime?.health, 'healthy');
});

test('applyModeTransition records audit snapshots and active intervention clearing deterministically', () => {
  const transitionAt = '2026-05-03T00:00:00.000Z';
  const activeIntervention = {
    kind: 'agent' as const,
    targetId: 'worker',
    targetLabel: 'Worker',
    message: 'operator is reviewing',
    createdAt: '2026-05-02T23:59:00.000Z',
  };
  const initial = createZergState({
    mode: {
      automation: 'assisted',
      interventionEnabled: false,
      controller: 'operator',
      contextId: 'ctx-before',
      activeIntervention,
    },
  });

  const transitioned = applyModeTransition(
    initial,
    {
      automation: 'automatic',
      controller: 'automation',
      interventionEnabled: true,
      contextId: 'ctx-after',
      reason: 'handoff accepted',
      clearActiveIntervention: true,
    },
    { now: () => new Date(transitionAt) },
  );

  assert.equal(initial.mode.automation, 'assisted');
  assert.equal(transitioned.revision, 1);
  assert.equal(transitioned.metadata.updatedAt, transitionAt);
  assert.deepEqual(transitioned.mode.previousMode, {
    automation: 'assisted',
    interventionEnabled: false,
    controller: 'operator',
    contextId: 'ctx-before',
  });
  assert.equal(transitioned.mode.automation, 'automatic');
  assert.equal(transitioned.mode.controller, 'automation');
  assert.equal(transitioned.mode.interventionEnabled, true);
  assert.equal(transitioned.mode.contextId, 'ctx-after');
  assert.equal(Object.hasOwn(transitioned.mode, 'activeIntervention'), false);

  const event = transitioned.events[0]!;
  assert.equal(event.id, 'mode-1');
  assert.equal(event.type, 'mode');
  assert.equal(event.createdAt, transitionAt);
  assert.equal(event.message, 'mode transition assisted/operator -> automatic/automation: handoff accepted');
  assert.deepEqual(event.previousMode, transitioned.mode.previousMode);
  assert.equal(event.mode?.automation, 'automatic');
  assert.equal(event.mode?.controller, 'automation');

  const retained = applyModeTransition(
    initial,
    {
      automation: 'manual',
      controller: 'operator',
      interventionEnabled: true,
      clearActiveIntervention: false,
    },
    { now: () => new Date(transitionAt) },
  );
  assert.deepEqual(retained.mode.activeIntervention, activeIntervention);

  const revertInput = createZergState({
    mode: {
      automation: 'assisted',
      interventionEnabled: true,
      controller: 'operator',
      contextId: 'ctx-revert-source',
      previousMode: {
        automation: 'automatic',
        interventionEnabled: true,
        controller: 'automation',
      },
    },
  });

  const clearedContext = applyModeTransition(
    revertInput,
    {
      automation: 'automatic',
      controller: 'automation',
      interventionEnabled: true,
      contextId: revertInput.mode.previousMode?.contextId,
      reason: 'revert without context',
      clearActiveIntervention: true,
    },
    { now: () => new Date(transitionAt) },
  );

  assert.equal(clearedContext.mode.contextId, undefined);
  assert.equal(clearedContext.events[0]?.mode?.contextId, undefined);
});

test('applyModeTransition supports read-only toggle without affecting interventionEnabled', () => {
  const transitioned = applyModeTransition(
    createZergState({
      mode: {
        automation: 'manual',
        controller: 'operator',
        interventionEnabled: true,
        readOnly: false,
      },
    }),
    {
      automation: 'manual',
      controller: 'operator',
      interventionEnabled: true,
      readOnly: true,
      reason: 'monitor readonly on',
    },
    { now: () => new Date('2026-05-03T04:00:00.000Z') },
  );

  const reverted = applyModeTransition(transitioned, {
    automation: 'manual',
    controller: 'operator',
    interventionEnabled: true,
    readOnly: false,
    reason: 'monitor readonly off',
    clearActiveIntervention: false,
  });

  assert.equal(transitioned.mode.readOnly, true);
  assert.equal(transitioned.events[0]?.message, 'mode transition manual/operator -> manual/operator: monitor readonly on');
  assert.equal(reverted.mode.readOnly, false);
});

test('applyInterventionRecord sanitizes messages and forces operator intervention state with audit payload', () => {
  const interventionAt = '2026-05-03T00:05:00.000Z';
  const previousMode = { automation: 'manual' as const, interventionEnabled: true, controller: 'operator' as const, contextId: 'ctx-manual' };
  const initial = createZergState({
    mode: {
      automation: 'automatic',
      interventionEnabled: false,
      controller: 'automation',
      previousMode,
    },
  });

  const recorded = applyInterventionRecord(
    initial,
    {
      kind: 'subagent',
      targetId: 'worker',
      targetLabel: 'Worker',
      message: '  Needs\noperator\t\u0000 review  ',
    },
    { now: () => new Date(interventionAt) },
  );

  assert.equal(initial.mode.controller, 'automation');
  assert.equal(recorded.mode.automation, 'automatic');
  assert.equal(recorded.mode.controller, 'operator');
  assert.equal(recorded.mode.interventionEnabled, true);
  assert.deepEqual(recorded.mode.previousMode, previousMode);
  assert.deepEqual(recorded.mode.activeIntervention, {
    kind: 'subagent',
    targetId: 'worker',
    targetLabel: 'Worker',
    message: 'Needs operator review',
    createdAt: interventionAt,
  });

  const event = recorded.events[0]!;
  assert.equal(event.id, 'permission-1');
  assert.equal(event.type, 'permission');
  assert.equal(event.message, 'intervention recorded: subagent worker');
  assert.deepEqual(event.intervention, recorded.mode.activeIntervention);
  assert.deepEqual(event.previousMode, previousMode);
});

test('permission queue helpers enqueue resolve trim and clone records', () => {
  const initial = createZergState();
  const queued = enqueuePermissionRequest(initial, {
    kind: 'run',
    targetId: 'worker\nagent',
    requester: 'operator',
    summary: '  Run\nworker\u0000 now  ',
    details: 'details\nline',
    metadata: { nested: { tags: ['original'] } },
  }, {
    id: 'perm-custom',
    now: () => new Date('2026-05-08T21:00:00.000Z'),
    maxRequests: 3,
  });

  assert.equal(initial.events.length, 0);
  assert.equal(queued.revision, 1);
  assert.equal(queued.events[0]?.type, 'permission');
  assert.equal(queued.events[0]?.message, 'permission requested: perm-custom run worker agent - Run worker now');

  const queue = getPermissionQueueState(queued);
  assert.equal(queue.pendingCount, 1);
  assert.equal(queue.lastRequestId, 'perm-custom');
  assert.equal(queue.requests[0]?.summary, 'Run worker now');
  assert.equal(queue.requests[0]?.targetId, 'worker agent');
  assert.equal(queue.requests[0]?.details, 'details line');

  queue.requests[0]!.summary = 'mutated';
  (queue.requests[0]!.metadata!.nested as { tags: string[] }).tags.push('mutated');
  assert.equal(getPermissionQueueState(queued).requests[0]?.summary, 'Run worker now');
  assert.deepEqual(((getPermissionQueueState(queued).requests[0]?.metadata?.nested as { tags: string[] }).tags), ['original']);

  const approved = resolvePermissionRequest(queued, 'perm-custom', 'approve', {
    now: () => new Date('2026-05-08T21:01:00.000Z'),
    reason: '  looks\nokay  ',
  });
  assert.equal(getPermissionQueueState(approved).requests[0]?.status, 'approved');
  assert.equal(getPermissionQueueState(approved).requests[0]?.decisionReason, 'looks okay');
  assert.equal(approved.events.at(-1)?.message, 'permission approve: perm-custom - looks okay');

  const unchangedUnknown = resolvePermissionRequest(approved, 'missing', 'deny');
  assert.deepEqual(unchangedUnknown, approved);
  const unchangedResolved = resolvePermissionRequest(approved, 'perm-custom', 'deny');
  assert.deepEqual(unchangedResolved, approved);

  let bounded = approved;
  bounded = enqueuePermissionRequest(bounded, { kind: 'tool', targetId: 'tool-1', summary: 'tool one' }, { id: 'perm-2', maxRequests: 3 });
  bounded = enqueuePermissionRequest(bounded, { kind: 'tool', targetId: 'tool-2', summary: 'tool two' }, { id: 'perm-3', maxRequests: 3 });
  bounded = enqueuePermissionRequest(bounded, { kind: 'tool', targetId: 'tool-3', summary: 'tool three' }, { id: 'perm-4', maxRequests: 3 });
  assert.deepEqual(getPermissionQueueState(bounded).requests.map((request) => request.id), ['perm-2', 'perm-3', 'perm-4']);
  assert.equal(getPermissionQueueState(bounded).pendingCount, 3);
});

test('permission command surface supports request list approve deny and cancel without mutating invalid cases', () => {
  const container = createZergStateContainer();
  const handler = createZergCommandHandler(container, { now: () => new Date('2026-05-08T21:05:00.000Z') });

  const requested = handler('/zerg permission request run worker "Needs\noperator"');
  assert.equal(requested.ok, true);
  assert.equal(requested.output, 'permission request queued: perm-1');
  assert.equal(getPermissionQueueState(container.snapshot()).pendingCount, 1);

  const status = handler('/zerg permission status');
  assert.equal(status.ok, true);
  assert.ok(status.output.includes('pending: 1'));
  assert.ok(status.output.includes('perm-1'));

  const list = handler('/zerg permission list all');
  assert.equal(list.ok, true);
  assert.ok(list.output.includes('perm-1 [pending/run] target:worker Needs operator'));

  const beforeInvalid = container.snapshot();
  assert.equal(handler('/zerg permission request banana worker nope').output, 'Unknown permission request kind: banana');
  assert.deepEqual(container.snapshot(), beforeInvalid);
  assert.equal(handler(`/zerg permission request run worker "${String.fromCharCode(0)}"`).output, 'Usage: /zerg permission request <kind> <target> <summary...>');
  assert.deepEqual(container.snapshot(), beforeInvalid);
  assert.equal(handler('/zerg permission approve missing').output, 'Unknown permission request: missing');
  assert.deepEqual(container.snapshot(), beforeInvalid);

  const approved = handler('/zerg permission approve perm-1 reviewed');
  assert.equal(approved.ok, true);
  assert.equal(approved.output, 'permission request perm-1 approved');
  assert.equal(getPermissionQueueState(container.snapshot()).requests[0]?.status, 'approved');

  const beforeResolved = container.snapshot();
  assert.equal(handler('/zerg permission deny perm-1 later').output, 'Permission request perm-1 is already approved.');
  assert.deepEqual(container.snapshot(), beforeResolved);

  handler('/zerg permission request interrupt run-1 stop it');
  assert.equal(handler('/zerg permission deny perm-3 unsafe').output, 'permission request perm-3 denied');
  handler('/zerg permission request adapter bridge check');
  assert.equal(handler('/zerg permission cancel perm-5 duplicate').output, 'permission request perm-5 cancelled');
  assert.ok(handler('/zerg permission list resolved').output.includes('perm-5 [cancelled/adapter]'));
});


test('read-only run queues permission without launching adapter', () => {
  const launches: ZergSubagentLaunchRequest[] = [];
  const adapter: ZergSubagentControlAdapter = {
    kind: 'fake',
    launch(request) {
      launches.push(request);
      return { ok: true, message: 'unexpected' };
    },
  };
  const container = createZergStateContainer(createZergState({ mode: { automation: 'manual', interventionEnabled: true, controller: 'operator', readOnly: true } }));
  const handler = createZergCommandHandler(container, { subagentAdapter: adapter, now: () => new Date('2026-05-08T21:10:00.000Z') });

  const result = handler('/zerg run worker "blocked task" --fork');
  assert.equal(result.ok, false);
  assert.ok(result.output.includes('queued for permission as perm-1'));
  assert.equal(launches.length, 0);
  assert.deepEqual(container.snapshot().agents, {});
  assert.deepEqual(container.snapshot().tasks, {});
  const request = getPermissionQueueState(container.snapshot()).requests[0];
  assert.equal(request?.kind, 'run');
  assert.equal(request?.summary, 'Run worker: blocked task');
  assert.deepEqual(request?.metadata, { agent: 'worker', task: 'blocked task', launchMode: 'fork', background: false, model: undefined, fallbackModels: undefined, maxTurns: undefined });
});


test('read-only interrupt blocks adapter calls for read-only snapshot sources', () => {
  let interrupted = 0;
  const handler = createZergCommandHandler(createZergState({
    mode: { automation: 'manual', interventionEnabled: true, controller: 'operator', readOnly: true },
  }), {
    subagentAdapter: {
      kind: 'fake',
      launch() {
        return { ok: true, message: 'unused' };
      },
      interrupt(runId) {
        interrupted += 1;
        return { ok: true, runId, message: `interrupted ${runId}` };
      },
    },
  });

  const result = handler('/zerg interrupt zerg-run-1');
  assert.equal(result.ok, false);
  assert.equal(result.output, 'zerg interrupt is blocked while read-only is enabled and requires writable zerg state to queue permission.');
  assert.equal(interrupted, 0);
});


test('read-only interrupt queues permission without emitting cancel', async () => {
  const eventBus = createFakePiEventBus();
  const notifications: string[] = [];
  let commandHandler: ((input: string, ctx: StructuralPiCommandContext) => Promise<void> | void) | undefined;
  const registration = registerZergSwarmExtension({
    events: eventBus,
    registerCommand(_name: string, options: StructuralPiCommandOptions) {
      commandHandler = options.handler;
      return { dispose: () => undefined };
    },
  }, { now: () => new Date('2026-05-08T21:11:00.000Z') });

  try {
    assert.ok(commandHandler);
    await commandHandler!('/zerg control readonly on', { ui: { notify: () => undefined } } as StructuralPiCommandContext);
    eventBus.emitted.length = 0;
    await commandHandler!('/zerg interrupt zerg-run-1', {
      ui: {
        notify(message: string) {
          notifications.push(message);
        },
      },
    } as StructuralPiCommandContext);

    assert.equal(eventBus.emitted.some((entry) => entry.eventName === 'subagent:slash:cancel'), false);
    assert.ok(notifications.at(-1)?.includes('queued for permission as perm-'));
    const request = getPermissionQueueState(registration.state).requests.at(-1);
    assert.equal(request?.kind, 'interrupt');
    assert.equal(request?.runId, 'zerg-run-1');
  } finally {
    registration.dispose();
    replaceSharedZergState();
  }
});


test('permission decisions update waiting run lifecycle without coarse status drift', () => {
  let state = applyRuntimeTransition(createZergState({
    mode: { automation: 'manual', interventionEnabled: true, controller: 'operator', readOnly: true },
  }), {
    entity: 'agent',
    action: 'start',
    id: 'zerg-existing',
    kind: 'subagent',
    at: '2026-05-08T21:12:00.000Z',
  });
  const container = createZergStateContainer(state);
  const handler = createZergCommandHandler(container, { now: () => new Date('2026-05-08T21:12:30.000Z') });

  const queued = handler('/zerg interrupt zerg-existing');
  assert.equal(queued.ok, false);
  state = container.snapshot();
  assert.equal(state.agents['zerg-existing']?.status, 'blocked');
  assert.equal(state.agents['zerg-existing']?.runtime?.substate, 'waiting-permission');
  const permissionRequestId = getPermissionQueueState(state).lastRequestId;
  assert.equal((state.agents['zerg-existing']?.metadata as { permissionRequestId?: string } | undefined)?.permissionRequestId, permissionRequestId);

  const denied = handler(`/zerg permission deny ${permissionRequestId} unsafe`);
  assert.equal(denied.ok, true);
  state = container.snapshot();
  assert.equal(state.agents['zerg-existing']?.status, 'failed');
  assert.equal(state.agents['zerg-existing']?.runtime?.substate, 'failed');
  assert.equal(getPermissionQueueState(state).requests[0]?.status, 'denied');
});

test('permission rendering surfaces pending count and sanitized summaries', () => {
  const state = enqueuePermissionRequest(createZergState(), {
    kind: 'adapter',
    targetId: 'bridge',
    summary: 'Need\nreview\u0000 now',
  }, { id: 'perm-render', now: () => new Date('2026-05-08T21:12:00.000Z') });
  const status = renderStatusLine(state, { width: 240 });
  const monitor = renderMonitor(state, { width: 240 });
  const help = renderHelp(state, { width: 240 });
  const list = renderPermissionQueueList(getPermissionQueueState(state), 'pending', { width: 240 });
  const configContainer = createZergStateContainer(state);
  const config = createZergCommandHandler(configContainer)('/zerg config');

  assert.ok(status.includes('permissions 1 pending'));
  assert.ok(monitor.includes('permissions: 1 pending latest:perm-render [pending/adapter] target:bridge Need review now'));
  assert.ok(help.includes('Permission syntax: /zerg permission status'));
  assert.ok(list.includes('perm-render [pending/adapter] target:bridge Need review now'));
  assert.ok(config.output.includes('permissions: 1 pending latest:perm-render adapter Need review now'));
  assert.equal(monitor.includes('Need\nreview'), false);
});

test('structured log helpers append trim sanitize and clone records', () => {
  const cyclic: Record<string, unknown> = { keep: 'value\nnext', fn: () => 'nope', nested: { ok: true } };
  cyclic.self = cyclic;
  let state = appendZergLogRecord(createZergState(), {
    id: 'log custom',
    source: 'adapter',
    level: 'warn',
    kind: 'tool',
    message: '  first\nmessage\u0000  ',
    runId: 'zerg-run-1',
    agentId: 'worker',
    taskId: 'task-1',
    data: cyclic as ZergLogRecord['data'],
  }, { now: () => new Date('2026-05-08T21:13:00.000Z') });

  assert.equal(state.revision, 0);
  assert.equal(getZergLogState(state).records[0]?.message, 'first message');
  assert.equal(getZergLogState(state).records[0]?.id, 'log-custom');
  assert.deepEqual(getZergLogState(state).records[0]?.data, { keep: 'value next', nested: { ok: true } });

  state = appendZergLogRecords(state, [
    { source: 'command', message: 'second', runId: 'zerg-run-1' },
    { source: 'permission', level: 'error', kind: 'error', message: 'third' },
  ], { maxRecords: 2 });

  assert.deepEqual(getZergLogState(state).records.map((record) => record.message), ['second', 'third']);
  assert.deepEqual(getZergLogs(state, { level: 'error' }).map((record) => record.message), ['third']);
  assert.deepEqual(getZergLogs(state, { runId: 'zerg-run-1' }).map((record) => record.message), ['second']);

  const snapshot = snapshotZergState(state);
  snapshot.extensions.zergLogs = { records: [], maxRecords: 1 };
  assert.equal(getZergLogState(state).records.length, 2);
});

test('logs command surface supports status list show json filters and deterministic errors', () => {
  const container = createZergStateContainer(appendZergLogRecords(createZergState(), [
    { id: 'log-one', source: 'command', level: 'info', kind: 'text', message: 'created run', runId: 'zerg-run-1' },
    { id: 'log-two', source: 'adapter', level: 'error', kind: 'error', message: 'failed\nline', runId: 'zerg-run-2' },
    { id: 'log-three', source: 'permission', level: 'warn', kind: 'text', message: 'blocked', runId: 'zerg-run-1' },
  ], { now: () => new Date('2026-05-08T21:14:00.000Z') }));
  const handler = createZergCommandHandler(container);

  assert.ok(handler('/zerg logs status').output.includes('records: 3'));
  assert.ok(handler('/zerg logs list --run zerg-run-1 --limit 1').output.includes('log-three [warn/permission/text] run:zerg-run-1 blocked'));
  assert.equal(handler('/zerg logs list --run zerg-run-1 --limit 1').output.includes('log-one'), false);
  assert.ok(handler('/zerg logs show log-two').output.includes('message: failed line'));

  const parsed = JSON.parse(handler('/zerg logs json --level error').output) as { count: number; records: ZergLogRecord[] };
  assert.equal(parsed.count, 1);
  assert.equal(parsed.records[0]?.id, 'log-two');
  assert.equal(parsed.records[0]?.message.includes('\n'), false);

  const runJson = JSON.parse(handler('/zerg logs show zerg-run-1 --json').output) as { count: number; records: ZergLogRecord[] };
  assert.equal(runJson.count, 2);
  assert.deepEqual(runJson.records.map((record) => record.id), ['log-one', 'log-three']);

  assert.equal(handler('/zerg logs list --level verbose').output, 'Unknown log level: verbose');
  assert.equal(handler('/zerg logs list --limit nope').output, 'Invalid log limit: nope');
  assert.equal(handler('/zerg logs show missing').output, 'Unknown log or run: missing');

  const unsafeHandler = createZergCommandHandler(createZergState({
    extensions: {
      zergLogs: {
        maxRecords: 10,
        records: [{ id: 'unsafe', source: 'adapter', level: 'info', kind: 'json', message: 'unsafe data', createdAt: '2026-05-08T21:14:00.000Z', data: { count: 1n } }],
      },
    },
  }));
  const unsafeJson = JSON.parse(unsafeHandler('/zerg logs json').output) as { count: number; records: ZergLogRecord[] };
  assert.equal(unsafeJson.count, 1);
  assert.equal(unsafeJson.records[0]?.data, undefined);
});

test('log rendering surfaces summaries and avoids mutation', () => {
  const state = appendZergLogRecords(createZergState(), [
    { id: 'log-info', source: 'command', message: 'info message' },
    { id: 'log-error', source: 'adapter', level: 'error', kind: 'error', message: 'bad\nthing', runId: 'zerg-run-1' },
  ]);
  const before = snapshotZergState(state);
  const status = renderStatusLine(state, { width: 240 });
  const monitor = renderMonitor(state, { width: 240 });
  const logStatus = renderZergLogStatus(getZergLogState(state), { width: 240 });
  const logList = renderZergLogList(getZergLogs(state), { width: 240 });
  const config = createZergCommandHandler(createZergStateContainer(state))('/zerg config');

  assert.ok(status.includes('permissions 0 pending'));
  assert.ok(monitor.includes('logs: 2/200 latest:log-error [error/adapter/error] run:zerg-run-1 bad thing'));
  assert.ok(logStatus.includes('errors: 1'));
  assert.ok(logList.includes('log-error [error/adapter/error] run:zerg-run-1 bad thing'));
  assert.ok(config.output.includes('logs: 2/200 latest:log-error error bad thing'));
  assert.deepEqual(state, before);
});


test('createZergCommandHandler applies mode status transitions and revert', () => {
  const readOnlyHandler = createZergCommandHandler(createZergState());

  const readOnlyStatus = readOnlyHandler('/zerg mode status');
  assert.equal(readOnlyStatus.ok, true);
  assert.ok(readOnlyStatus.output.includes(`zerg v${ZERG_EXTENSION_VERSION} command surface`));
  assert.ok(readOnlyStatus.output.includes('control operator'));
  assert.ok(readOnlyStatus.output.includes('mode manual'));
  assert.ok(readOnlyStatus.output.includes('no active intervention'));

  assert.equal(readOnlyHandler('/zerg mode manual').ok, false);
  assert.equal(readOnlyHandler('/zerg mode manual').output, 'Runtime lifecycle commands require writable zerg state.');

  const container = createZergStateContainer();
  const timestamps = createNowSequence(
    '2026-05-03T01:00:00.000Z',
    '2026-05-03T01:01:00.000Z',
    '2026-05-03T01:02:00.000Z',
    '2026-05-03T01:03:00.000Z',
  );
  const handler = createZergCommandHandler(container, { now: timestamps });

  const status = handler('/zerg mode status');
  assert.equal(status.ok, true);
  assert.ok(status.output.includes('control operator'));
  assert.ok(status.output.includes('mode manual'));
  assert.ok(status.output.includes('no active intervention'));

  const beforeInvalidMode = container.snapshot();
  const invalidMode = handler('/zerg mode wat');
  assert.equal(invalidMode.ok, false);
  assert.equal(invalidMode.output, 'Unknown mode action: wat');
  assert.deepEqual(container.snapshot(), beforeInvalidMode);

  const beforeControlOnlyReason = container.snapshot();
  const controlOnlyReasonText = String.fromCharCode(0);
  const controlOnlyReason = handler(`/zerg mode automatic "${controlOnlyReasonText}"`);
  assert.equal(controlOnlyReason.ok, false);
  assert.equal(controlOnlyReason.output, 'mode reason exceeds 140 characters or contains only control characters.');
  assert.deepEqual(container.snapshot(), beforeControlOnlyReason);

  const beforeLongReason = container.snapshot();
  const longReason = handler('/zerg mode automatic ' + 'x'.repeat(141));
  assert.equal(longReason.ok, false);
  assert.equal(longReason.output, 'mode reason exceeds 140 characters or contains only control characters.');
  assert.deepEqual(container.snapshot(), beforeLongReason);

  const rejectedRevert = handler('/zerg mode revert');
  assert.equal(rejectedRevert.ok, false);
  assert.equal(rejectedRevert.output, 'No prior mode snapshot to revert to.');

  const manual = handler('/zerg mode manual confirmed');
  assert.equal(manual.ok, true);
  assert.ok(manual.output.includes('mode set to manual'));
  assert.equal(container.snapshot().mode.controller, 'operator');

  const automatic = handler('/zerg mode automatic "hands off"');
  assert.equal(automatic.ok, true);
  assert.ok(automatic.output.includes('mode set to automatic'));
  assert.equal(container.snapshot().mode.automation, 'automatic');
  assert.equal(container.snapshot().mode.controller, 'automation');

  const assisted = handler('/zerg mode assisted operator-review');
  assert.equal(assisted.ok, true);
  assert.equal(container.snapshot().mode.automation, 'assisted');
  assert.equal(container.snapshot().mode.controller, 'operator');
  assert.deepEqual(container.snapshot().mode.previousMode, {
    automation: 'automatic',
    interventionEnabled: true,
    controller: 'automation',
    contextId: undefined,
  });

  const reverted = handler('/zerg mode revert rollback');
  assert.equal(reverted.ok, true);
  assert.ok(reverted.output.includes('mode reverted'));
  assert.equal(container.snapshot().mode.automation, 'automatic');
  assert.equal(container.snapshot().mode.controller, 'automation');
  assert.deepEqual(container.snapshot().events.map((event) => event.type), ['mode', 'mode', 'mode', 'mode']);
  assert.equal(container.snapshot().events.at(-1)?.message, 'mode transition assisted/operator -> automatic/automation: rollback');
});

test('createZergCommandHandler mode revert clears contextId when previous snapshot has no context', () => {
  const container = createZergStateContainer(createZergState({
    mode: {
      automation: 'assisted',
      interventionEnabled: true,
      controller: 'operator',
      contextId: 'ctx-current',
      previousMode: {
        automation: 'automatic',
        interventionEnabled: true,
        controller: 'automation',
      },
    },
  }));
  const handler = createZergCommandHandler(container, { now: () => new Date('2026-05-03T01:10:00.000Z') });

  const reverted = handler('/zerg mode revert rollback');
  assert.equal(reverted.ok, true);
  assert.equal(container.snapshot().mode.automation, 'automatic');
  assert.equal(container.snapshot().mode.contextId, undefined);
  assert.equal(container.snapshot().events.at(-1)?.mode?.contextId, undefined);
});

test('createZergCommandHandler applies intervention APIs and rejects invalid targets', () => {
  const interventionAt = '2026-05-03T02:00:00.000Z';
  const container = createZergStateContainer(createZergState({
    agents: {
      leader: { id: 'leader', label: 'Leader', kind: 'team-leader', status: 'running' },
      worker: { id: 'worker', label: 'Worker', kind: 'subagent', status: 'running' },
      teammate: { id: 'teammate', label: 'Teammate', kind: 'teammate', status: 'idle' },
    },
    teams: {
      ops: { id: 'ops', label: 'Ops', kind: 'team', status: 'running', leaderAgentId: 'leader', memberAgentIds: ['worker'] },
      leaderless: { id: 'leaderless', label: 'Leaderless', kind: 'team', status: 'idle', memberAgentIds: [] },
      missingLeader: { id: 'missingLeader', label: 'Missing leader', kind: 'team', status: 'idle', leaderAgentId: 'ghost', memberAgentIds: [] },
    },
  }));
  const handler = createZergCommandHandler(container, { now: () => new Date(interventionAt) });

  const agentIntervention = handler('/zerg intervene agent leader Please review');
  assert.equal(agentIntervention.ok, true);
  assert.equal(agentIntervention.output, 'intervention recorded against agent leader: Please review');
  assert.equal(container.snapshot().mode.activeIntervention?.targetId, 'leader');

  const subagentIntervention = handler('/zerg intervene subagent worker Take over');
  assert.equal(subagentIntervention.ok, true);
  assert.equal(subagentIntervention.output, 'intervention recorded against subagent worker: Take over');
  assert.equal(container.snapshot().mode.activeIntervention?.kind, 'subagent');
  assert.equal(container.snapshot().mode.controller, 'operator');

  const leaderIntervention = handler('/zerg intervene leader ops Lead please');
  assert.equal(leaderIntervention.ok, true);
  assert.equal(leaderIntervention.output, 'intervention recorded against leader leader (team ops): Lead please');
  assert.deepEqual(container.snapshot().mode.activeIntervention, {
    kind: 'leader',
    targetId: 'leader',
    targetLabel: 'Leader',
    teamId: 'ops',
    leaderAgentId: 'leader',
    message: 'Lead please',
    createdAt: interventionAt,
  });

  assert.deepEqual(container.snapshot().events.map((event) => event.type), ['permission', 'permission', 'permission']);
  assert.equal(handler('/zerg intervene banana worker msg').output, 'Unknown intervention target: banana');
  assert.equal(handler('/zerg intervene agent').output, 'intervene agent requires an id.');
  assert.equal(handler('/zerg intervene agent worker').output, 'intervene requires a non-empty message.');
  assert.equal(handler('/zerg intervene agent ghost msg').output, 'Cannot intervene agent for unknown agent: ghost');
  assert.equal(handler('/zerg intervene subagent leader msg').output, 'intervene subagent requires target agent to be subagent: leader');
  assert.equal(handler('/zerg intervene leader ghost msg').output, 'Cannot intervene leader for unknown team: ghost');
  assert.equal(handler('/zerg intervene leader leaderless msg').output, 'Team leaderless has no leader to intervene.');
  assert.equal(handler('/zerg intervene leader missingLeader msg').output, 'Team missingLeader leader ghost is missing.');
  assert.equal(handler(`/zerg intervene agent worker ${'x'.repeat(241)}`).output, 'intervention message exceeds 240 characters or contains only control characters.');
});

test('createZergCommandHandler uses wall-clock timestamps without now option for mode and intervention commands', () => {
  const epoch = '1970-01-01T00:00:00.000Z';
  const assertWallClockTimestamp = (timestamp: string, before: Date, after: Date) => {
    assert.notEqual(timestamp, epoch);
    const timestampMs = Date.parse(timestamp);
    assert.ok(
      timestampMs >= before.getTime() && timestampMs <= after.getTime(),
      `expected ${timestamp} to be between ${before.toISOString()} and ${after.toISOString()}`,
    );
  };
  const container = createZergStateContainer(createZergState({
    agents: {
      worker: { id: 'worker', label: 'Worker', kind: 'subagent', status: 'running' },
    },
  }));
  const handler = createZergCommandHandler(container);

  assert.equal(container.snapshot().metadata.updatedAt, epoch);

  const modeBefore = new Date();
  const modeResult = handler('/zerg mode automatic wall-clock');
  const modeAfter = new Date();
  assert.equal(modeResult.ok, true);

  const modeSnapshot = container.snapshot();
  const modeEvent = modeSnapshot.events.at(-1);
  assert.ok(modeEvent);
  assert.equal(modeEvent.type, 'mode');
  assertWallClockTimestamp(modeSnapshot.metadata.updatedAt, modeBefore, modeAfter);
  assertWallClockTimestamp(modeEvent.createdAt, modeBefore, modeAfter);

  const interventionBefore = new Date();
  const interventionResult = handler('/zerg intervene subagent worker Check clock');
  const interventionAfter = new Date();
  assert.equal(interventionResult.ok, true);

  const interventionSnapshot = container.snapshot();
  const interventionEvent = interventionSnapshot.events.at(-1);
  const activeIntervention = interventionSnapshot.mode.activeIntervention;
  assert.ok(interventionEvent);
  assert.ok(activeIntervention);
  assert.equal(interventionEvent.type, 'permission');
  assertWallClockTimestamp(interventionSnapshot.metadata.updatedAt, interventionBefore, interventionAfter);
  assertWallClockTimestamp(interventionEvent.createdAt, interventionBefore, interventionAfter);
  assertWallClockTimestamp(activeIntervention.createdAt, interventionBefore, interventionAfter);
  assert.ok(interventionEvent.intervention);
  assertWallClockTimestamp(interventionEvent.intervention.createdAt, interventionBefore, interventionAfter);
});

test('render surfaces expose control intervention status tree markers and help syntax', () => {
  const idleState = createZergState();
  const idleStatus = renderStatusLine(idleState, { width: 240 });
  const idleHelp = renderHelp(idleState, { width: 240 });

  assert.ok(idleStatus.includes('control operator'));
  assert.ok(idleStatus.includes('mode manual'));
  assert.ok(idleStatus.includes('no active intervention'));
  assert.equal(idleHelp.split('\n')[0], `pi-zerg-swarm v${ZERG_EXTENSION_VERSION} command-surface scaffold`);
  assert.ok(idleHelp.includes('Control syntax: /zerg mode status|manual|assisted|automatic|revert [reason]'));
  assert.ok(idleHelp.includes('Monitor syntax: /zerg monitor [readonly on|off|toggle|status]'));
  assert.ok(idleHelp.includes('Registry syntax: /zerg agents [list] | show <id> | create|update <id> --prompt <text> [--model <model>] [--tools a,b] | delete <id>'));
  assert.ok(idleHelp.includes('Intervention syntax: /zerg intervene agent <agent-id> <message>'));
  assert.ok(!idleHelp.includes('prompt:'));
  const registrySummary = renderAgentDefinitionsList(Object.values(createBuiltinAgentDefinitions()), { width: 240 });
  const registryDefinition = renderAgentDefinitionSummary(createBuiltinAgentDefinitions().reviewer, { width: 240 });

  assert.ok(registrySummary.includes('agent definitions:'));
  assert.ok(registrySummary.includes('reviewer'));
  assert.ok(registryDefinition.includes('agent definition: reviewer'));
  assert.equal(registryDefinition.includes('You are'), false);

  const activeState = createZergState({
    agents: {
      worker: { id: 'worker', label: 'Worker', kind: 'subagent', status: 'running' },
    },
    mode: {
      automation: 'manual',
      interventionEnabled: true,
      controller: 'operator',
      activeIntervention: {
        kind: 'subagent',
        targetId: 'worker',
        targetLabel: 'Worker',
        message: 'Please review the worker handoff now',
        createdAt: '2026-05-03T02:30:00.000Z',
      },
    },
  });
  const activeStatus = renderStatusLine(activeState, { width: 320 });
  const fallbackTree = renderAgentTree(activeState, { width: 240 });
  const explicitTree = renderAgentTree(createZergState({
    agents: activeState.agents,
    mode: activeState.mode,
    tree: {
      workerNode: { id: 'workerNode', kind: 'agent', label: 'Worker node', status: 'running', refId: 'worker', childIds: [] },
    },
  }), { width: 240 });

  assert.ok(activeStatus.includes('intervention subagent worker (Please review the worker handoff now)'));
  assert.ok(fallbackTree.includes('◉ Worker [subagent/running]'));
  assert.ok(explicitTree.includes('◉ agent Worker node [running]'));
});

test('renderMonitor combines monitor header, runtime status, tree, and recent events', () => {
  const state = createZergState({
    events: [
      { id: 'ev-1', type: 'hook', message: 'zerg monitor boot', createdAt: '2026-05-02T12:00:00.000Z' },
      { id: 'ev-2', type: 'agent', message: 'agent started', action: 'start', createdAt: '2026-05-02T12:01:00.000Z' },
      { id: 'ev-3', type: 'mode', message: 'mode\nchange\u0000', createdAt: '2026-05-02T12:02:00.000Z' },
    ],
    mode: {
      automation: 'manual',
      interventionEnabled: true,
      controller: 'operator',
      readOnly: true,
    },
    agents: {
      worker: { id: 'worker', label: 'Worker', kind: 'subagent', status: 'running' },
    },
  });

  const monitor = renderMonitor(state, { width: 240, recentEventCount: 2 });

  assert.ok(monitor.includes('zerg monitor'));
  assert.ok(monitor.includes(`status: zerg v${ZERG_EXTENSION_VERSION} command surface`));
  assert.ok(monitor.includes('read-only: enabled'));
  assert.ok(monitor.includes('tree:'));
  assert.ok(monitor.includes('recent events:'));
  assert.ok(monitor.includes('mode change'));
  assert.ok(!monitor.includes('mode\nchange'));
  assert.ok(monitor.includes('agent started'));
});

test('createZergCommandHandler supports monitor and read-only toggles', () => {
  const readOnlyHandler = createZergCommandHandler(createZergState());
  assert.equal(readOnlyHandler('/zerg monitor').ok, true);
  assert.ok(readOnlyHandler('/zerg monitor').output.includes('zerg monitor'));
  assert.ok(readOnlyHandler('/zerg monitor').output.includes('read-only: disabled'));
  assert.equal(readOnlyHandler('/zerg monitor readonly').output, 'Runtime lifecycle commands require writable zerg state.');

  const container = createZergStateContainer();
  const handler = createZergCommandHandler(container, {
    now: () => new Date('2026-05-02T22:20:00.000Z'),
  });

  const toggledOn = handler('/zerg monitor readonly on');
  assert.equal(toggledOn.ok, true);
  assert.ok(toggledOn.output.includes('read-only: enabled'));
  assert.equal(container.snapshot().mode.readOnly, true);

  const toggledOff = handler('/zerg monitor readonly off');
  assert.equal(toggledOff.ok, true);
  assert.ok(toggledOff.output.includes('read-only: disabled'));
  assert.equal(container.snapshot().mode.readOnly, false);

  const status = handler('/zerg monitor readonly status');
  assert.equal(status.ok, true);
  assert.ok(status.output.includes('disabled'));

  const invalid = handler('/zerg monitor readonly maybe');
  assert.equal(invalid.ok, false);
  assert.equal(invalid.output, 'Unknown monitor readonly value: maybe');
  assert.equal(handler('/zerg monitor unknown').output, 'Unknown monitor action: unknown');

  const readonlyHandler = createZergCommandHandler(createZergState());
  assert.equal(readonlyHandler('/zerg runs').ok, true);
  assert.equal(readonlyHandler('/zerg agents').output.includes('No agent definitions are currently registered.'), true);
});

test('registerZergSwarmExtension seeds builtin agent definitions in extension state', () => {
  replaceSharedZergState();

  const registration = registerZergSwarmExtension({});
  try {
    const definitions = getAgentDefinitions(registration.state);
    assert.deepEqual(definitions.map((definition) => definition.id), ['generalist', 'planner', 'reviewer']);
    assert.deepEqual(definitions.map((definition) => definition.source), ['builtin', 'builtin', 'builtin']);
  } finally {
    registration.dispose();
    replaceSharedZergState();
  }
});

test('createZergCommandHandler launches subagents through configured adapter and persists task/run state before launch', () => {
  const launches: ZergSubagentLaunchRequest[] = [];
  const adapterRuns: Record<string, { agentId: string; task: string; status: string }> = {
    'zerg-readonly-run': { agentId: 'worker', task: 'existing run', status: 'running' },
  };
  const interrupts: Array<string | undefined> = [];
  const runIds = ['run-1'];
  const taskIds = ['1'];
  const adapter: ZergSubagentControlAdapter = {
    kind: 'fake',
    launch(request) {
      launches.push(request);
      return {
        ok: true,
        runId: request.runId,
        taskId: request.taskId,
      } as ZergSubagentControlResult;
    },
    interrupt(runId) {
      interrupts.push(runId);
      return { ok: true, runId, message: `interrupted ${runId ?? 'current'}` };
    },
    listAgentDefinitions() {
      return [
        {
          id: 'worker',
          label: 'Worker',
          prompt: 'worker agent prompt',
          source: 'user',
        },
      ];
    },
    getAgentDefinition(id) {
      return id === 'worker' ? {
        id: 'worker',
        label: 'Worker',
        prompt: 'worker agent prompt',
        source: 'user',
      } : undefined;
    },
    listRuns() {
      const run = adapterRuns['zerg-readonly-run'];
      return [{
        runId: 'zerg-readonly-run',
        agentId: run.agentId,
        task: run.task,
        status: run.status as 'running',
      }];
    },
    getRun(runId) {
      if (runId !== 'zerg-readonly-run') {
        return undefined;
      }

      const run = adapterRuns[runId];
      return {
        runId,
        agentId: run.agentId,
        task: run.task,
        status: run.status as 'running',
      };
    },
  };
  const container = createZergStateContainer();
  const handler = createZergCommandHandler(container, {
    subagentAdapter: adapter,
    idFactory: {
      runId: () => runIds.shift() ?? `zerg-run-${Date.now()}`,
      taskId: () => taskIds.shift() ?? `task-${Date.now()}`,
    },
  });

  const run = handler('/zerg run worker "fix bug" --bg --fork');
  assert.equal(run.ok, true);
  assert.ok(run.output.includes('adapter launch accepted zerg-run-1'));
  assert.ok(run.output.includes('zerg-run-1'));
  assert.ok(run.output.includes('task-1'));
  assert.ok(run.output.includes('(fork)'));
  assert.deepEqual(launches[0], {
    agent: 'worker',
    task: 'fix bug',
    background: true,
    fork: true,
    launchMode: 'fork',
    runId: 'zerg-run-1',
    taskId: 'task-1',
    agentDefinitionId: undefined,
    description: 'fix bug',
  });
  assert.equal(launches[0].agentDefinitionId, undefined);

  const seededState = container.snapshot();
  assert.equal(seededState.tasks['task-1']?.title, 'fix bug');
  assert.equal(seededState.tasks['task-1']?.status, 'running');
  assert.equal(seededState.agents['zerg-run-1']?.status, 'idle');
  assert.equal(seededState.agents['zerg-run-1']?.runtime?.substate, 'spawning');
  assert.equal(seededState.tasks['task-1']?.substate, 'queued');
  assert.equal((seededState.agents['zerg-run-1']?.metadata as { taskId?: string } | undefined)?.taskId, 'task-1');
  assert.equal((seededState.agents['zerg-run-1']?.metadata as { launchMode?: string } | undefined)?.launchMode, 'fork');
  assert.equal((seededState.tasks['task-1']?.metadata as { launchMode?: string } | undefined)?.launchMode, 'fork');

  const runs = handler('/zerg runs');
  assert.equal(runs.ok, true);
  assert.ok(runs.output.includes('zerg-readonly-run'));
  assert.ok(runs.output.includes('zerg-run-1'));
  assert.ok(runs.output.includes('task-id:task-1'));
  assert.ok(runs.output.includes('mode:fork'));

  const runSummary = handler('/zerg runs show zerg-run-1');
  assert.equal(runSummary.ok, true);
  assert.ok(runSummary.output.includes('subagent run: zerg-run-1'));
  assert.ok(runSummary.output.includes('task-id: task-1'));

  const missingRunSummary = handler('/zerg runs show missing-run');
  assert.equal(missingRunSummary.ok, false);
  assert.equal(missingRunSummary.output, 'Unknown run: missing-run');

  const interrupted = handler('/zerg interrupt fake-run');
  assert.equal(interrupted.ok, true);
  assert.deepEqual(interrupts, ['fake-run']);
  assert.equal(container.snapshot().agents['fake-run']?.runtime?.substate, 'cancelling');
  assert.equal(container.snapshot().agents['fake-run']?.status, 'running');

  handler('/zerg control readonly on');
  const stateBeforeBlocked = container.snapshot();
  const blocked = handler('/zerg run worker "blocked"');
  assert.equal(blocked.ok, false);
  assert.ok(blocked.output.includes('read-only is enabled'));
  const stateAfterBlocked = container.snapshot();
  assert.deepEqual(stateBeforeBlocked.agents, stateAfterBlocked.agents);
  assert.deepEqual(stateBeforeBlocked.tasks, stateAfterBlocked.tasks);

  const readonlyRuns = handler('/zerg runs');
  assert.equal(readonlyRuns.ok, true);
  assert.ok(readonlyRuns.output.includes('zerg-run-1'));
});

test('createZergCommandHandler propagates model routing from /zerg run into adapter and run metadata', () => {
  const launches: ZergSubagentLaunchRequest[] = [];
  const adapter: ZergSubagentControlAdapter = {
    kind: 'fake',
    launch(request) {
      launches.push(request);
      return { ok: true, runId: request.runId, taskId: request.taskId, message: `launched ${request.agent}` };
    },
  };
  const container = createZergStateContainer();
  const handler = createZergCommandHandler(container, {
    subagentAdapter: adapter,
    idFactory: {
      runId: () => 'zerg-model-run',
      taskId: () => 'task-model-run',
    },
  });

  const result = handler('/zerg run worker "fix model bug" --model claude-sonnet-4 --fallback-models gpt-5-mini,gemini-pro --max-turns 9 --bg --fork');
  assert.equal(result.ok, true);
  assert.equal(launches[0]?.model, 'claude-sonnet-4');
  assert.deepEqual(launches[0]?.fallbackModels, ['gpt-5-mini', 'gemini-pro']);
  assert.equal(launches[0]?.maxTurns, 9);
  assert.equal(launches[0]?.task, 'fix model bug');
  assert.equal(launches[0]?.launchMode, 'fork');
  assert.equal((container.snapshot().agents['zerg-model-run']?.metadata as { model?: string } | undefined)?.model, 'claude-sonnet-4');
  assert.deepEqual((container.snapshot().tasks['task-model-run']?.metadata as { fallbackModels?: string[] } | undefined)?.fallbackModels, ['gpt-5-mini', 'gemini-pro']);
  assert.equal((container.snapshot().tasks['task-model-run']?.metadata as { maxTurns?: number } | undefined)?.maxTurns, 9);
  assert.ok(handler('/zerg runs').output.includes('model:claude-sonnet-4'));
});

test('createZergCommandHandler parses team and agent relationship/model flags', () => {
  const container = createZergStateContainer();
  const handler = createZergCommandHandler(container, { now: () => new Date('2026-05-09T00:00:00.000Z') });

  const leader = handler('/zerg agent create leader "Leader" --kind team-leader --team ops --model claude-sonnet-4');
  assert.equal(leader.ok, true);
  const worker = handler('/zerg agent create worker-a "Worker A" --kind teammate --team ops --model gpt-5-codex');
  assert.equal(worker.ok, true);
  const team = handler('/zerg team create ops "Ops Team" --kind squad --leader leader --members leader,worker-a');
  assert.equal(team.ok, true);

  const state = container.snapshot();
  assert.equal(state.agents.leader?.kind, 'team-leader');
  assert.equal(state.agents.leader?.teamId, 'ops');
  assert.equal((state.agents.leader?.metadata as { model?: string } | undefined)?.model, 'claude-sonnet-4');
  assert.equal(state.teams.ops?.kind, 'squad');
  assert.equal(state.teams.ops?.leaderAgentId, 'leader');
  assert.deepEqual(state.teams.ops?.memberAgentIds, ['leader', 'worker-a']);
  assert.equal(state.teams.ops?.label, 'Ops Team');
});

test('createZergCommandHandler defaults to fresh and supports explicit fresh without fork context', () => {
  const launches: ZergSubagentLaunchRequest[] = [];
  const adapter: ZergSubagentControlAdapter = {
    kind: 'fake',
    launch(request) {
      launches.push(request);
      return { ok: true, runId: request.runId, taskId: request.taskId, message: `launched ${request.agent}` };
    },
  };
  const ids = ['zerg-fresh-default', 'zerg-fresh-explicit'];
  const taskIds = ['task-fresh-default', 'task-fresh-explicit'];
  const container = createZergStateContainer();
  const handler = createZergCommandHandler(container, {
    subagentAdapter: adapter,
    idFactory: {
      runId: () => ids.shift() ?? 'zerg-fresh-extra',
      taskId: () => taskIds.shift() ?? 'task-fresh-extra',
    },
  });

  const defaultFresh = handler('/zerg run worker "default fresh"');
  assert.equal(defaultFresh.ok, true);
  assert.ok(defaultFresh.output.includes('(fresh)'));
  assert.equal(launches[0]?.launchMode, 'fresh');
  assert.equal(launches[0]?.fork, false);

  const explicitFresh = handler('/zerg run worker "explicit fresh" --fresh');
  assert.equal(explicitFresh.ok, true);
  assert.ok(explicitFresh.output.includes('(fresh)'));
  assert.equal(launches[1]?.launchMode, 'fresh');
  assert.equal(launches[1]?.fork, false);

  const state = container.snapshot();
  assert.equal((state.tasks['task-fresh-default']?.metadata as { launchMode?: string } | undefined)?.launchMode, 'fresh');
  assert.equal((state.agents['zerg-fresh-default']?.metadata as { launchMode?: string } | undefined)?.launchMode, 'fresh');

  const runs = handler('/zerg runs');
  assert.ok(runs.output.includes('mode:fresh'));
  const summary = handler('/zerg runs show zerg-fresh-default');
  assert.ok(summary.output.includes('launch-mode: fresh'));
});

test('createZergCommandHandler rejects conflicting fresh and fork flags before mutation', () => {
  let launchCount = 0;
  const adapter: ZergSubagentControlAdapter = {
    kind: 'fake',
    launch() {
      launchCount += 1;
      return { ok: true, message: 'unexpected launch' };
    },
  };
  const container = createZergStateContainer();
  const handler = createZergCommandHandler(container, {
    subagentAdapter: adapter,
    idFactory: {
      runId: () => 'zerg-conflict',
      taskId: () => 'task-conflict',
    },
  });

  const before = container.snapshot();
  const result = handler('/zerg run worker "conflict" --fresh --fork');
  assert.equal(result.ok, false);
  assert.equal(result.output, 'Conflicting launch modes: use either --fresh or --fork, not both.');
  assert.equal(launchCount, 0);
  assert.deepEqual(container.snapshot().agents, before.agents);
  assert.deepEqual(container.snapshot().tasks, before.tasks);
});

test('renderHelp documents fresh default and fork launch mode', () => {
  const help = renderHelp(createZergState());
  assert.ok(help.includes('--fresh|--fork'));
  assert.ok(help.includes('fresh is default isolated launch'));
  assert.ok(help.includes('fork requests inherited context'));
});

test('createZergCommandHandler blocks unknown definition run when registry is present', () => {
  const launches: ZergSubagentLaunchRequest[] = [];
  const adapter: ZergSubagentControlAdapter = {
    kind: 'fake',
    launch(request) {
      launches.push(request);
      return { ok: true, runId: request.runId, taskId: request.taskId, message: `launched ${request.agent}` };
    },
  };

  const container = createZergStateContainer({
    agentDefinitions: {
      worker: {
        id: 'worker',
        label: 'Worker',
        prompt: 'worker prompt',
        source: 'user',
      },
    },
  });

  const handler = createZergCommandHandler(container, {
    subagentAdapter: adapter,
    idFactory: {
      runId: () => 'zerg-blocked',
      taskId: () => 'task-blocked',
    },
  });

  const before = container.snapshot();
  const result = handler('/zerg run missing "fix missing"');
  assert.equal(result.ok, false);
  assert.equal(result.output, 'Unknown agent definition: missing');

  assert.equal(launches.length, 0);
  assert.deepEqual(container.snapshot().agents, before.agents);
  assert.deepEqual(container.snapshot().tasks, before.tasks);
});

test('createZergCommandHandler preserves existing task/agent records on sync launch failure', () => {
  const adapter: ZergSubagentControlAdapter = {
    kind: 'fake',
    launch(request) {
      return { ok: false, runId: request.runId, taskId: request.taskId, message: 'launch rejected' };
    },
  };
  const container = createZergStateContainer();
  const handler = createZergCommandHandler(container, {
    subagentAdapter: adapter,
    idFactory: {
      runId: () => 'zerg-failed-run',
      taskId: () => 'task-failed',
    },
  });

  const failure = handler('/zerg run worker "investigate failure" --fork');
  assert.equal(failure.ok, false);
  assert.ok(failure.output.includes('zerg-failed-run'));
  assert.ok(failure.output.includes('(fork)'));

  const state = container.snapshot();
  assert.equal(state.tasks['task-failed']?.status, 'failed');
  assert.equal(state.agents['zerg-failed-run']?.status, 'failed');
  assert.equal((state.agents['zerg-failed-run']?.metadata as { taskId?: string } | undefined)?.taskId, 'task-failed');
  assert.equal((state.agents['zerg-failed-run']?.metadata as { launchMode?: string } | undefined)?.launchMode, 'fork');
  assert.equal((state.tasks['task-failed']?.metadata as { launchMode?: string } | undefined)?.launchMode, 'fork');
  assert.ok(state.events.some((event) => event.type === 'agent' && event.action === 'fail'));
});

test('createZergCommandHandler ignores divergent adapter result IDs for task-first state', () => {
  const adapter: ZergSubagentControlAdapter = {
    kind: 'fake',
    launch() {
      return { ok: false, runId: 'adapter-run', taskId: 'adapter-task', message: 'legacy launch rejected' };
    },
  };
  const container = createZergStateContainer();
  const handler = createZergCommandHandler(container, {
    subagentAdapter: adapter,
    idFactory: {
      runId: () => 'zerg-parent-run',
      taskId: () => 'task-parent',
    },
  });

  const failure = handler('/zerg run worker "legacy mismatch"');
  assert.equal(failure.ok, false);
  assert.equal(failure.runId, 'zerg-parent-run');
  assert.equal(failure.taskId, 'task-parent');
  assert.ok(failure.output.includes('zerg-parent-run'));
  assert.ok(failure.output.includes('task-parent'));
  assert.ok(!failure.output.includes('adapter-run'));

  const state = container.snapshot();
  assert.equal(state.tasks['task-parent']?.status, 'failed');
  assert.equal(state.tasks['task-parent']?.ownerAgentId, 'zerg-parent-run');
  assert.equal(state.agents['zerg-parent-run']?.status, 'failed');
  assert.equal(state.tasks['adapter-task'], undefined);
  assert.equal(state.agents['adapter-run'], undefined);
});

test('dispatch run resolves agent definition IDs and passes normalized identity to adapter', () => {
  const launches: ZergSubagentLaunchRequest[] = [];
  const adapter: ZergSubagentControlAdapter = {
    kind: 'fake',
    launch(request) {
      launches.push(request);
      return { ok: true, runId: request.runId, taskId: request.taskId, message: `launched ${request.agent}` };
    },
  };

  const container = createZergStateContainer({
    agentDefinitions: {
      'bug-fixer': {
        id: 'bug-fixer',
        label: 'Bug Fixer',
        description: 'Fix issues',
        prompt: 'You fix things',
        source: 'user',
      },
    },
  });

  const handler = createZergCommandHandler(container, {
    subagentAdapter: adapter,
    idFactory: {
      runId: () => 'zerg-def-run-1',
      taskId: () => 'task-def-1',
    },
  });

  const run = handler('/zerg run Bug-Fixer "inspect issue"');
  assert.equal(run.ok, true);
  assert.deepEqual(launches[0], {
    agent: 'bug-fixer',
    task: 'inspect issue',
    runId: 'zerg-def-run-1',
    taskId: 'task-def-1',
    background: false,
    fork: false,
    launchMode: 'fresh',
    agentDefinitionId: 'bug-fixer',
    description: 'inspect issue',
  });

  const state = container.snapshot();
  assert.equal(state.agents['zerg-def-run-1']?.label, 'Bug Fixer');
  const summary = handler('/zerg runs show zerg-def-run-1');
  assert.equal(summary.ok, true);
  assert.ok(summary.output.includes('label: Bug Fixer'));
  assert.ok(summary.output.includes('launch-mode: fresh'));
});

test('fake adapter read APIs return cloned snapshots', () => {
  const definitions = createBuiltinAgentDefinitions();
  const fixture = createZergStateContainer({
    agentDefinitions: definitions,
  });
  const adapterRuns = {
    runId: 'zerg-run-readonly',
    agentId: 'planner',
    task: 'analyze tasks',
    status: 'running' as const,
    startedAt: '2026-05-07T00:00:00.000Z',
    updatedAt: '2026-05-07T00:00:01.000Z',
  };

  const adapter: ZergSubagentControlAdapter = {
    kind: 'fake',
    launch() {
      return { ok: true, runId: adapterRuns.runId, message: 'launched' };
    },
    listAgentDefinitions() {
      return getAgentDefinitions(fixture.read());
    },
    getAgentDefinition(id) {
      return getAgentDefinition(fixture.read(), id);
    },
    listRuns() {
      return [{ ...adapterRuns }];
    },
    getRun(runId) {
      return runId === adapterRuns.runId ? { ...adapterRuns } : undefined;
    },
  };

  const listedDefinitions = [...(adapter.listAgentDefinitions?.() ?? [])];
  listedDefinitions[0]!.prompt = 'modified prompt';
  listedDefinitions[0]!.label = 'Modified';
  const lookedUp = adapter.getAgentDefinition?.('planner');
  assert.ok(lookedUp);
  assert.equal(lookedUp.prompt, definitions.planner?.prompt);
  assert.equal(lookedUp.label, 'Planner');

  const listedRuns = [...(adapter.listRuns?.() ?? [])];
  listedRuns[0]!.task = 'tampered task';
  const run = adapter.getRun?.(adapterRuns.runId);
  assert.ok(run);
  assert.equal(run.task, 'analyze tasks');
});

test('run snapshot helper clones exact public shape', () => {
  const input = {
    runId: 'zerg-shape',
    agentId: 'planner',
    agentLabel: 'Planner',
    task: 'plan work',
    status: 'running' as const,
    taskId: 'task-1',
    launchMode: 'fresh' as const,
    substate: 'executing' as const,
    substateReason: 'running tool',
    substateUpdatedAt: '2026-05-07T00:00:00.500Z',
    startedAt: '2026-05-07T00:00:00.000Z',
    updatedAt: '2026-05-07T00:00:01.000Z',
    metadata: { nested: { tags: ['original'] } },
    launched: true,
    started: true,
    completed: false,
  };

  const snapshot = createZergSubagentRunSnapshot(input);
  (snapshot.metadata?.nested as { tags: string[] }).tags.push('mutated');

  assert.deepEqual(Object.keys(snapshot).sort(), [
    'agentDefinitionId',
    'agentId',
    'agentLabel',
    'completedAt',
    'errorSummary',
    'finalSummary',
    'launchMode',
    'memberProgress',
    'metadata',
    'runId',
    'startedAt',
    'status',
    'substate',
    'substateReason',
    'substateUpdatedAt',
    'task',
    'taskId',
    'updatedAt',
  ]);
  assert.equal('launched' in snapshot, false);
  assert.equal('started' in snapshot, false);
  assert.equal('completed' in snapshot, false);
  assert.deepEqual((input.metadata.nested as { tags: string[] }).tags, ['original']);
});

test('registerZergSwarmExtension unavailable slash bus returns empty run reads safely', async () => {
  const registrations: Array<{ options: StructuralPiCommandOptions }> = [];
  const notifications: string[] = [];
  const registration = registerZergSwarmExtension({
    registerCommand(_name: string, options: StructuralPiCommandOptions) {
      registrations.push({ options });
      return { dispose() {}};
    },
  });

  const handler = registrations[0]?.options.handler;
  assert.ok(handler);

  await handler!('/zerg runs', {
    ui: {
      notify(message: string) {
        notifications.push(message);
      },
    },
  } as StructuralPiCommandContext);

  assert.equal(notifications[0]?.includes('No subagent runs are currently known.'), true);
  registration.dispose();
});

test('registerZergSwarmExtension falls back to native runner when slash bridge does not respond', async () => {
  const eventBus = createFakePiEventBus();
  const notifications: string[] = [];
  const piCommandContext = {
    ui: {
      notify(message: string) {
        notifications.push(message);
      },
    },
  };
  let commandHandler: ((input: string, ctx: StructuralPiCommandContext) => Promise<void> | void) | undefined;
  const registration = registerZergSwarmExtension({
    events: eventBus,
    registerCommand(_name: string, options: StructuralPiCommandOptions) {
      commandHandler = options.handler;
      return { dispose: () => undefined };
    },
  }, {
    idFactory: {
      runId: () => 'zerg-stalled-run',
      taskId: () => 'task-stalled-run',
    },
  });

  assert.ok(commandHandler);
  await commandHandler!('/zerg run planner "wait forever"', piCommandContext as StructuralPiCommandContext);
  await new Promise((resolve) => setTimeout(resolve, 130));

  assert.equal(notifications.some((message) => message.includes('zerg launched planner as zerg-stalled-run')), true);
  assert.equal(notifications.some((message) => message.includes('task-stalled-run')), true);

  const requestEvent = eventBus.emitted.find((entry) => entry.eventName === 'subagent:slash:request');
  assert.equal((requestEvent?.args[0] as { requestId?: string } | undefined)?.requestId, 'zerg-stalled-run');
  const stalledParams = (requestEvent?.args[0] as { params?: { taskId?: string; context?: string } } | undefined)?.params;
  assert.equal(stalledParams?.taskId, 'task-stalled-run');
  assert.equal(stalledParams?.context, undefined);

  const state = registration.state;
  assert.equal(state.tasks['task-stalled-run']?.status, 'running');
  assert.equal(state.tasks['task-stalled-run']?.ownerAgentId, 'zerg-stalled-run');
  assert.equal(state.agents['zerg-stalled-run']?.status, 'running');
  assert.equal(state.agents['zerg-stalled-run']?.runtime?.substate, 'starting');
  assert.equal((state.agents['zerg-stalled-run']?.metadata as { taskId?: string } | undefined)?.taskId, 'task-stalled-run');
  assert.equal((state.agents['zerg-stalled-run']?.metadata as { launchMode?: string } | undefined)?.launchMode, 'fresh');
  assert.equal((state.tasks['task-stalled-run']?.metadata as { launchMode?: string } | undefined)?.launchMode, 'fresh');
  assert.ok(state.events.some((event) => event.type === 'agent' && event.action === 'start' && event.agentId === 'zerg-stalled-run'));
  assert.ok(getZergLogs(state, { level: 'info' }).some((record) => record.runId === 'zerg-stalled-run' && record.message.includes('pi native')));

  registration.dispose();
});

test('registerZergSwarmExtension wires zerg run to pi-subagents slash bridge events', async () => {
  const eventBus = createFakePiEventBus();
  eventBus.emit = (eventName: unknown, ...args: unknown[]) => {
    eventBus.emitted.push({ eventName, args });
    for (const subscription of eventBus.subscriptions) {
      if (subscription.eventName === eventName && !subscription.disposable.disposed) {
        subscription.handler(...args);
      }
    }
    return eventBus.emitted.length;
  };
  const notifications: string[] = [];
  const piCommandContext = {
    ui: {
      notify(message: string) {
        notifications.push(message);
      },
    },
  };
  let commandHandler: ((input: string, ctx: StructuralPiCommandContext) => Promise<void> | void) | undefined;
  const registeringContext = {
    events: eventBus,
    registerCommand(_name: string, options: StructuralPiCommandOptions) {
      commandHandler = options.handler;
      return { dispose: () => undefined };
    },
  };

  const registration = registerZergSwarmExtension(registeringContext, {
    idFactory: {
      runId: () => 'zerg-fixed-run',
      taskId: () => 'task-fixed-run',
    },
  });
  eventBus.on('subagent:slash:request', (data) => {
    const requestId = (data as { requestId: string }).requestId;
    eventBus.emit('subagent:slash:started', { requestId });
    eventBus.emit('subagent:slash:update', { requestId, currentTool: 'edit', toolCount: 1 });
    eventBus.emit('subagent:slash:update', { requestId, output: 'line one\nline two' });
    eventBus.emit('subagent:slash:update', { requestId, isError: true, message: 'temporary\nerror' });
    eventBus.emit('subagent:slash:response', { requestId, isError: false, result: { content: [{ type: 'text', text: 'done' }], details: { mode: 'single', results: [] } } });
  });

  assert.ok(commandHandler);
  await commandHandler!('/zerg run planner "fix bug" --fork', piCommandContext as StructuralPiCommandContext);

  assert.equal(notifications.some((message) => message.includes('zerg launched planner')), true);
  assert.equal(notifications.some((message) => message.includes('(fork)')), true);
  const requestEvent = eventBus.emitted.find((entry) => entry.eventName === 'subagent:slash:request');
  assert.equal((requestEvent?.args[0] as { requestId?: string } | undefined)?.requestId, 'zerg-fixed-run');
  const requestParams = (requestEvent?.args[0] as { params?: { taskId?: string; context?: string } } | undefined)?.params;
  assert.equal(requestParams?.taskId, 'task-fixed-run');
  assert.equal(requestParams?.context, 'fork');

  const state = registration.state;
  const fixedAgent = state.agents['zerg-fixed-run'];
  assert.ok(fixedAgent);
  assert.equal(fixedAgent.status, 'done');
  assert.equal(fixedAgent.runtime?.substate, 'completed');
  assert.equal(fixedAgent.id, 'zerg-fixed-run');
  assert.equal((fixedAgent.metadata as { taskId?: string } | undefined)?.taskId, 'task-fixed-run');
  assert.equal((fixedAgent.metadata as { launchMode?: string } | undefined)?.launchMode, 'fork');
  assert.equal(state.tasks['task-fixed-run']?.ownerAgentId, 'zerg-fixed-run');
  assert.equal((state.tasks['task-fixed-run']?.metadata as { launchMode?: string } | undefined)?.launchMode, 'fork');
  assert.equal(state.tasks['task-fixed-run']?.status, 'done');
  assert.equal(state.tasks['task-fixed-run']?.substate, 'completed');
  assert.ok(state.events.some((event) => event.agentId === 'zerg-fixed-run' && event.substate === 'starting'));
  assert.ok(state.events.some((event) => event.agentId === 'zerg-fixed-run' && event.substate === 'tool-running'));
  assert.ok(state.events.some((event) => event.agentId === 'zerg-fixed-run' && event.substate === 'completed'));
  assert.ok(getZergLogs(state, { runId: 'zerg-fixed-run' }).some((record) => record.kind === 'tool' && record.message === 'tool running: edit'));
  assert.ok(getZergLogs(state, { runId: 'zerg-fixed-run' }).some((record) => record.kind === 'text' && record.message === 'line one line two'));
  assert.ok(getZergLogs(state, { runId: 'zerg-fixed-run' }).some((record) => record.kind === 'error' && record.level === 'error' && record.message === 'temporary error'));
  assert.ok(getZergLogs(state, { runId: 'zerg-fixed-run' }).some((record) => record.kind === 'result' && record.message === 'subagent complete'));

  const currentRunId = fixedAgent.id;
  assert.ok(currentRunId);

  notifications.length = 0;
  await commandHandler!('/zerg runs', piCommandContext as StructuralPiCommandContext);
  assert.equal(notifications.some((message) => message.includes('subagent runs:')), true);
  assert.equal(notifications.some((message) => message.includes('task-id:task-fixed-run')), true);
  assert.equal(notifications.some((message) => message.includes('mode:fork')), true);
  assert.equal(notifications.some((message) => message.includes('(done/completed)')), true);

  if (currentRunId) {
    notifications.length = 0;
    await commandHandler!(`/zerg runs show ${currentRunId}`, piCommandContext as StructuralPiCommandContext);
    assert.equal(notifications.some((message) => message.includes(`subagent run: ${currentRunId}`)), true);
    assert.equal(notifications.some((message) => message.includes('task-id: task-fixed-run')), true);
    assert.equal(notifications.some((message) => message.includes('launch-mode: fork')), true);
    assert.equal(notifications.some((message) => message.includes('status: done/completed')), true);
  }

  registration.dispose();
});

test('createZergCommandHandler supports control and config command foundation', () => {
  const container = createZergStateContainer({
    agents: { worker: { id: 'worker', label: 'Worker', kind: 'subagent', status: 'idle' } },
  });
  const handler = createZergCommandHandler(container, {
    now: () => new Date('2026-05-07T01:00:00.000Z'),
  });

  const status = handler('/zerg control status');
  assert.equal(status.ok, true);
  assert.ok(status.output.includes('zerg control'));
  assert.ok(status.output.includes('controller: operator'));

  const controller = handler('/zerg control controller pi');
  assert.equal(controller.ok, true);
  assert.ok(controller.output.includes('controller: pi'));
  assert.equal((container.snapshot().extensions.zergControl as { controller?: string }).controller, 'pi');

  const readOnly = handler('/zerg control readonly toggle');
  assert.equal(readOnly.ok, true);
  assert.ok(readOnly.output.includes('read-only: enabled'));
  assert.equal(container.snapshot().mode.readOnly, true);

  const mode = handler('/zerg control mode automatic');
  assert.equal(mode.ok, true);
  assert.ok(mode.output.includes('mode: automatic'));
  assert.equal(container.snapshot().mode.automation, 'automatic');

  const config = handler('/zerg config');
  assert.equal(config.ok, true);
  assert.ok(config.output.includes('zerg config'));
  assert.ok(config.output.includes('[config]'));

  assert.equal(handler('/zerg control controller nope').output, 'Unknown control controller: nope');
  assert.equal(handler('/zerg control what').output, 'Unknown control action: what');
});

test('createPiZergCommandHandler renders full config overlay and reuses management control paths', async () => {
  let state = createZergState({
    agents: Object.fromEntries(Array.from({ length: 25 }, (_, index) => {
      const id = `worker-${String(index).padStart(2, '0')}`;
      return [id, { id, label: `Worker ${index}`, kind: 'subagent', status: index === 0 ? 'running' : 'idle' }];
    })),
  });
  state = enqueuePermissionRequest(state, {
    kind: 'run',
    targetId: 'worker-01',
    requester: 'operator',
    summary: 'Run worker-01 now',
  }, { id: 'perm-overlay', now: () => new Date('2026-05-07T01:09:00.000Z') });
  const container = createZergStateContainer(state);
  const handler = createPiZergCommandHandler(container, {
    now: () => new Date('2026-05-07T01:10:00.000Z'),
  });
  const rendered: string[] = [];
  let closeCount = 0;
  let requestRenderCount = 0;
  let selectedBeforeEnter: string | undefined;
  let customOptions: Record<string, unknown> | undefined;
  let callbackError: unknown;

  const context = {
    ui: {
      custom: (
        factory: (
          tui?: { requestRender?(): void },
          theme?: unknown,
          keybindings?: unknown,
          done?: () => void,
        ) => { render(width?: number, height?: number): string[]; invalidate(): void; handleInput?(data: string): void; dispose?(): void },
        options?: Record<string, unknown>,
      ) => {
        if (options?.overlay !== true) {
          return undefined;
        }
        customOptions = options;
        const component = factory(
          { requestRender: () => { requestRenderCount += 1; } },
          undefined,
          undefined,
          () => { closeCount += 1; },
        );
        try {
          rendered.push(component.render(120, 22).join('\n'));
          component.handleInput?.('r');
          component.handleInput?.('u');
          component.handleInput?.('right');
          component.handleInput?.('right');
          component.handleInput?.('right');
          for (let index = 0; index < 21; index += 1) {
            component.handleInput?.('down');
          }
          rendered.push(component.render(120, 22).join('\n'));
          selectedBeforeEnter = (container.snapshot().extensions.zergControl as { selectedTargetId?: string } | undefined)?.selectedTargetId;
          component.handleInput?.('enter');
          rendered.push(component.render(120, 22).join('\n'));
          component.handleInput?.('right');
          component.handleInput?.('p');
          rendered.push(component.render(120, 22).join('\n'));
          component.handleInput?.('p');
          rendered.push(component.render(120, 22).join('\n'));
        } catch (error) {
          callbackError = error;
          throw error;
        } finally {
          component.dispose?.();
        }
      },
    },
  };

  await handler('/zerg config', context as StructuralPiCommandContext);

  assert.equal(callbackError, undefined);
  assert.equal(closeCount, 1);
  assert.equal(container.snapshot().mode.readOnly, true);
  assert.equal(container.snapshot().mode.automation, 'automatic');
  assert.equal(selectedBeforeEnter, undefined);
  assert.equal(customOptions?.overlay, true);
  assert.equal((customOptions?.overlayOptions as { title?: string } | undefined)?.title, 'zerg config');
  assert.ok(rendered[0]?.includes('zerg config'));
  assert.ok(rendered[0]?.includes('Use three steps'));
  assert.ok(rendered[0]?.includes('1 Select'));
  assert.ok(rendered[0]?.includes('2 Settings'));
  assert.ok(rendered[1]?.includes('1 Select'));
  assert.ok(rendered[1]?.includes('worker-'));
  assert.ok(rendered[2]?.includes('selected agent worker-'));
  assert.ok(rendered[3]?.includes('press p again to approve perm-overlay'));
  assert.ok(rendered[4]?.includes('permission request perm-overlay approved'));
  assert.equal(requestRenderCount >= 10, true);
});

test('createPiZergCommandHandler config overlay refreshes from state updates and blocks mutations without writable state', async () => {
  const container = createZergStateContainer(createZergState());
  const handler = createPiZergCommandHandler(container);
  let requestRenderCount = 0;
  let closeCount = 0;
  let refreshed = '';

  const context = {
    ui: {
      custom: (
        factory: (
          tui?: { requestRender?(): void },
          theme?: unknown,
          keybindings?: unknown,
          done?: () => void,
        ) => { render(width?: number, height?: number): string[]; invalidate(): void; handleInput?(data: string): void; dispose?(): void },
      ) => {
        const component = factory(
          { requestRender: () => { requestRenderCount += 1; } },
          undefined,
          undefined,
          () => { closeCount += 1; },
        );
        try {
          container.replace(enqueuePermissionRequest(container.snapshot(), {
            kind: 'adapter',
            targetId: 'bridge',
            requester: 'operator',
            summary: 'Refresh overlay permission',
          }, { id: 'perm-refresh', now: () => new Date('2026-05-07T00:01:00.000Z') }));
          component.invalidate();
          refreshed = component.render(120, 22).join('\n');
        } finally {
          component.dispose?.();
        }
      },
    },
  };

  await handler('/zerg config', context as StructuralPiCommandContext);
  assert.equal(closeCount, 1);
  assert.ok(refreshed.includes('perm-refresh') || refreshed.includes('permissions: 1 pending'));
  const requestRenderCountAfterDispose = requestRenderCount;
  container.update((state) => ({ metadata: { ...state.metadata, updatedAt: '2026-05-07T00:02:00.000Z' } }));
  assert.equal(requestRenderCount, requestRenderCountAfterDispose);

  const plainHandler = createPiZergCommandHandler(createZergState({
    agents: { worker: { id: 'worker', label: 'Worker', kind: 'subagent', status: 'idle' } },
  }));
  let plainRendered = '';
  const plainContext = {
    ui: {
      custom: (
        factory: (
          tui?: { requestRender?(): void },
          theme?: unknown,
          keybindings?: unknown,
          done?: () => void,
        ) => { render(width?: number, height?: number): string[]; invalidate(): void; handleInput?(data: string): void; dispose?(): void },
      ) => {
        const component = factory(undefined, undefined, undefined, () => undefined);
        component.handleInput?.('r');
        plainRendered = component.render(120, 22).join('\n');
        component.handleInput?.('right');
        component.handleInput?.('right');
        component.handleInput?.('right');
        component.handleInput?.('enter');
        plainRendered += `\n${component.render(120, 22).join('\n')}`;
      },
    },
  };

  await plainHandler('/zerg config', plainContext as StructuralPiCommandContext);
  assert.ok(plainRendered.includes('Runtime lifecycle commands require writable zerg state.'));
});

test('renderZergManagementOverlay does not mutate state or rows', () => {
  const state = createZergState({
    mode: { automation: 'assisted', interventionEnabled: true, controller: 'operator', readOnly: true },
  });
  const rows = [{
    id: 'row-1',
    kind: 'target' as const,
    label: 'worker-1 Worker 1 [running/executing]',
    selectable: true,
    detailLines: ['detail one', 'detail two'],
  }];
  const before = snapshotZergState(state);
  const beforeRows = rows.map((row) => ({ ...row, detailLines: [...(row.detailLines ?? [])] }));

  const overlay = renderZergManagementOverlay(state, {
    width: 120,
    height: 22,
    activeTab: 'targets',
    tabs: ['monitor', 'control', 'targets', 'permissions', 'lifecycle', 'logs', 'intervene', 'config'] as const,
    rows,
    selectedIndex: 0,
    scrollOffset: 0,
    detailRowId: 'row-1',
    statusMessage: 'selected target worker-1',
    confirmMessage: 'press p again',
    adapterKind: 'fake',
  });

  assert.ok(overlay.includes('zerg config'));
  assert.deepEqual(state, before);
  assert.deepEqual(rows, beforeRows);
});

test('createPiZergCommandHandler renders monitor through real custom overlay options and preserves legacy fallback', async () => {
  const container = createZergStateContainer();
  const handler = createPiZergCommandHandler(container);
  const rendered: string[] = [];
  const notifications: string[] = [];
  const customCalls: Array<{ options: Record<string, unknown> | undefined }> = [];

  let closeCount = 0;
  let requestRenderCount = 0;
  let component: { render(width?: number, height?: number): string[]; invalidate(): void; handleInput?(data: string): void; dispose?(): void } | undefined;
  const monitorContext = {
    ui: {
      custom: (
        factory: (
          tui?: { requestRender?(): void },
          theme?: unknown,
          keybindings?: unknown,
          done?: () => void,
        ) => { render(width?: number, height?: number): string[]; invalidate(): void; handleInput?(data: string): void; dispose?(): void },
        options?: Record<string, unknown>,
      ) => {
        customCalls.push({ options });
        component = factory(
          { requestRender: () => { requestRenderCount += 1; } },
          undefined,
          undefined,
          () => { closeCount += 1; },
        );
        const lines = component.render(120);
        assert.equal(Array.isArray(lines), true);
        assert.equal(typeof component.invalidate, 'function');
        assert.equal(typeof component.handleInput, 'function');
        assert.equal(typeof component.dispose, 'function');
        const before = container.snapshot();
        component.handleInput?.('r');
        component.handleInput?.('m');
        component.handleInput?.('p');
        component.handleInput?.('\u001b[B');
        assert.deepEqual(container.snapshot(), before);
        container.update((state) => ({ metadata: { ...state.metadata, updatedAt: '2026-05-07T00:00:00.000Z' } }));
        component.invalidate();
        component.handleInput?.('q');
        rendered.push(lines.join('\n'));
      },
      notify: (message: string) => {
        notifications.push(message);
      },
    },
  };

  await handler('/zerg monitor', monitorContext as StructuralPiCommandContext);

  assert.equal(closeCount, 1);
  assert.equal(requestRenderCount, 1);
  assert.equal(rendered.length, 1);
  assert.ok(rendered[0]?.includes('zerg monitor'));
  assert.equal(notifications.length, 0);
  assert.equal(customCalls.length, 1);
  assert.equal(customCalls[0]?.options?.overlay, true);
  assert.deepEqual(customCalls[0]?.options?.overlayOptions, { title: 'zerg monitor' });
  component?.dispose?.();
  container.update((state) => ({ metadata: { ...state.metadata, updatedAt: '2026-05-07T00:01:00.000Z' } }));
  assert.equal(requestRenderCount, 1);

  const fallbackRendered: string[] = [];
  let rejectedFirstOverlayCall = false;
  const throwingNewApiContext = {
    ui: {
      custom: (factory: unknown, options?: Record<string, unknown>) => {
        if (typeof factory === 'function' && options?.overlay === true && !rejectedFirstOverlayCall) {
          rejectedFirstOverlayCall = true;
          throw new Error('legacy custom implementation');
        }
        const fallbackComponent = (factory as (
          tui?: { requestRender?(): void },
          theme?: unknown,
          keybindings?: unknown,
          done?: () => void,
        ) => { render(width?: number): string[]; invalidate(): void; handleInput?(data: string): void })(undefined, undefined, undefined, () => undefined);
        fallbackRendered.push(fallbackComponent.render(100).join('\n'));
      },
      notify: (message: string) => {
        notifications.push(message);
      },
    },
  };

  await handler('/zerg monitor', throwingNewApiContext as StructuralPiCommandContext);
  assert.equal(fallbackRendered.length, 1);
  assert.ok(fallbackRendered[0]?.includes('zerg monitor'));

  const fallbackContext = {
    ui: {
      notify: (message: string) => {
        notifications.push(message);
      },
    },
  };

  await handler('/zerg monitor', fallbackContext as StructuralPiCommandContext);
  assert.equal(notifications.length >= 1, true);
});

test('createZergCommandHandler applies lifecycle commands only with writable state and command timestamps', () => {
  const readOnlyHandler = createZergCommandHandler(createZergState());
  const readOnlyResult = readOnlyHandler('/zerg agent create worker Worker');

  assert.equal(readOnlyResult.ok, false);
  assert.equal(readOnlyResult.output, 'Runtime lifecycle commands require writable zerg state.');

  const commandAt = '2026-05-02T23:00:00.000Z';
  const container = createZergStateContainer();
  const handler = createZergCommandHandler(container, {
    now: () => new Date(commandAt),
  });

  assert.equal(handler('/zerg agent create worker Worker One').ok, true);
  assert.equal(handler('agent start worker').ok, true);
  const beforeInvalidSubstate = container.snapshot();
  const invalidSubstate = handler('agent progress worker --substate nope "bad"');
  assert.equal(invalidSubstate.ok, false);
  assert.equal(invalidSubstate.output, 'Unknown lifecycle substate: nope');
  assert.deepEqual(container.snapshot(), beforeInvalidSubstate);
  assert.equal(handler('agent progress worker "editing state" --substate tool-running --substate-reason "tool edit"').ok, true);
  assert.equal(handler('team create ops Operations').ok, true);
  assert.equal(handler('team start ops').ok, true);
  assert.equal(handler('team stop ops').ok, true);

  const snapshot = container.snapshot();
  assert.equal(snapshot.agents.worker?.label, 'Worker One');
  assert.equal(snapshot.agents.worker?.status, 'running');
  assert.equal(snapshot.agents.worker?.runtime?.createdAt, commandAt);
  assert.equal(snapshot.agents.worker?.runtime?.startedAt, commandAt);
  assert.equal(snapshot.agents.worker?.runtime?.lastActivityAt, commandAt);
  assert.equal(snapshot.agents.worker?.runtime?.lastActivity, 'editing state');
  assert.equal(snapshot.agents.worker?.runtime?.substate, 'tool-running');
  assert.equal(snapshot.agents.worker?.runtime?.substateReason, 'tool edit');
  assert.equal(snapshot.teams.ops?.label, 'Operations');
  assert.equal(snapshot.teams.ops?.status, 'done');
  assert.equal(snapshot.teams.ops?.runtime?.createdAt, commandAt);
  assert.equal(snapshot.teams.ops?.runtime?.startedAt, commandAt);
  assert.equal(snapshot.teams.ops?.runtime?.stoppedAt, commandAt);
  assert.equal(snapshot.metadata.updatedAt, commandAt);
  assert.notEqual(snapshot.metadata.updatedAt, '1970-01-01T00:00:00.000Z');
  assert.deepEqual(snapshot.events.map((event) => event.action), ['create', 'start', 'progress', 'create', 'start', 'stop']);
  assert.deepEqual(snapshot.events.map((event) => event.substate), ['queued', 'starting', 'tool-running', 'queued', 'starting', 'completed']);
  assert.deepEqual(snapshot.events.map((event) => event.createdAt), [commandAt, commandAt, commandAt, commandAt, commandAt, commandAt]);
});

test('registered Pi command handlers mutate extension and shared lifecycle state end to end', async () => {
  replaceSharedZergState();

  const registrations: Array<{ name: string; options: StructuralPiCommandOptions }> = [];
  const notifications: Array<{ message: string; type?: string }> = [];
  const registration = registerZergSwarmExtension({
    registerCommand(name, options) {
      registrations.push({ name, options });
    },
  }, {
    now: createNowSequence(
      '2026-05-02T23:10:00.000Z',
      '2026-05-02T23:11:00.000Z',
      '2026-05-02T23:12:00.000Z',
      '2026-05-02T23:13:00.000Z',
      '2026-05-02T23:14:00.000Z',
      '2026-05-02T23:15:00.000Z',
      '2026-05-02T23:16:00.000Z',
      '2026-05-02T23:17:00.000Z',
    ),
  });
  const notifyContext = {
    hasUI: true,
    ui: {
      notify(message: string, type?: string) {
        notifications.push({ message, type });
      },
    },
  };

  try {
    const handler = registrations[0]?.options.handler;
    assert.ok(handler);

    const commandOutput = async (input: string) => {
      const start = notifications.length;
      await handler(input, notifyContext);
      return notifications[start] as { message: string; type?: string };
    };

    const agentCreateNotification = await commandOutput('agent create worker Worker');
    const agentStartNotification = await commandOutput('agent start worker');
    const agentProgressNotification = await commandOutput('agent progress worker "editing state"');
    const agentStopNotification = await commandOutput('agent stop worker');
    const teamCreateNotification = await commandOutput('team create ops Operations');
    const teamStartNotification = await commandOutput('team start ops');
    const teamProgressNotification = await commandOutput('team progress ops "coordinating review"');
    const teamStopNotification = await commandOutput('team stop ops');
    const statusNotification = await commandOutput('status');
    const treeNotification = await commandOutput('tree');

    const extensionState = registration.state;
    const sharedState = readSharedZergState();
    const runtimeEvents = extensionState.events.slice(-8);
    const commandTimestamps = [
      '2026-05-02T23:10:00.000Z',
      '2026-05-02T23:11:00.000Z',
      '2026-05-02T23:12:00.000Z',
      '2026-05-02T23:13:00.000Z',
      '2026-05-02T23:14:00.000Z',
      '2026-05-02T23:15:00.000Z',
      '2026-05-02T23:16:00.000Z',
      '2026-05-02T23:17:00.000Z',
    ];

    assert.equal(extensionState.agents.worker?.label, 'Worker');
    assert.equal(extensionState.agents.worker?.status, 'done');
    assert.equal(extensionState.agents.worker?.runtime?.health, 'stopped');
    assert.equal(extensionState.agents.worker?.runtime?.createdAt, '2026-05-02T23:10:00.000Z');
    assert.equal(extensionState.agents.worker?.runtime?.startedAt, '2026-05-02T23:11:00.000Z');
    assert.equal(extensionState.agents.worker?.runtime?.lastActivityAt, '2026-05-02T23:13:00.000Z');
    assert.equal(extensionState.teams.ops?.label, 'Operations');
    assert.equal(extensionState.teams.ops?.status, 'done');
    assert.equal(extensionState.teams.ops?.runtime?.createdAt, '2026-05-02T23:14:00.000Z');
    assert.equal(extensionState.teams.ops?.runtime?.startedAt, '2026-05-02T23:15:00.000Z');
    assert.equal(extensionState.teams.ops?.runtime?.lastActivityAt, '2026-05-02T23:17:00.000Z');
    assert.equal(extensionState.metadata.updatedAt, '2026-05-02T23:17:00.000Z');
    assert.deepEqual(runtimeEvents.map((event) => event.type), ['agent', 'agent', 'agent', 'agent', 'team', 'team', 'team', 'team']);
    assert.deepEqual(runtimeEvents.map((event) => event.action), ['create', 'start', 'progress', 'stop', 'create', 'start', 'progress', 'stop']);
    assert.deepEqual(runtimeEvents.map((event) => event.createdAt), commandTimestamps);
    assert.deepEqual(runtimeEvents.map((event) => event.revision), [2, 3, 4, 5, 6, 7, 8, 9]);
    assert.ok(runtimeEvents.every((event) => event.mode?.automation === 'manual'));
    assert.ok(runtimeEvents.every((event) => event.mode?.interventionEnabled === true));
    assert.notEqual(runtimeEvents[0]?.createdAt, '1970-01-01T00:00:00.000Z');
    assert.equal(sharedState.agents.worker?.label, extensionState.agents.worker?.label);
    assert.equal(sharedState.teams.ops?.label, extensionState.teams.ops?.label);
    assert.deepEqual(sharedState.events.slice(-8), runtimeEvents);

    assert.ok(agentCreateNotification.message.includes('Worker: created'));
    assert.ok(agentProgressNotification.message.includes('Worker: editing state'));
    assert.ok(agentStopNotification.message.includes('Worker: stopped'));
    assert.ok(teamProgressNotification.message.includes('Operations: coordinating review'));
    assert.ok(teamStopNotification.message.includes('Operations: stopped'));
    assert.ok(statusNotification?.message.includes('agents 1 (0 running)'));
    assert.ok(statusNotification?.message.includes('teams 1 (0 running)'));
    assert.ok(statusNotification?.message.includes('last Operations: stopped [completed]'));
    assert.ok(treeNotification?.message.includes('Worker [subagent/done/completed] {health:stopped state:completed last:stopped}'));
    assert.ok(treeNotification?.message.includes('team Operations [team/done/completed] {health:stopped state:completed last:stopped}'));
    assert.ok(agentStartNotification.message.includes('agent worker start applied.'));
    assert.ok(teamCreateNotification.message.includes('team ops create applied.'));
    assert.ok(teamStartNotification.message.includes('team ops start applied.'));
    assert.ok(notifications.every((notification) => notification.type === 'info'));
  } finally {
    registration.dispose();
    replaceSharedZergState();
  }
});

test('registered Pi mode and intervention commands sync extension and shared state end to end', async () => {
  replaceSharedZergState(createZergState({
    agents: {
      leader: { id: 'leader', label: 'Leader', kind: 'team-leader', status: 'running' },
      worker: { id: 'worker', label: 'Worker', kind: 'subagent', status: 'running', teamId: 'ops' },
    },
    teams: {
      ops: { id: 'ops', label: 'Operations', kind: 'team', status: 'running', leaderAgentId: 'leader', memberAgentIds: ['leader', 'worker'] },
    },
  }));

  const registrations: Array<{ name: string; options: StructuralPiCommandOptions }> = [];
  const notifications: Array<{ message: string; type?: string }> = [];
  const registration = registerZergSwarmExtension({
    registerCommand(name, options) {
      registrations.push({ name, options });
    },
  }, {
    now: createNowSequence(
      '2026-05-03T03:00:00.000Z',
      '2026-05-03T03:01:00.000Z',
      '2026-05-03T03:02:00.000Z',
    ),
  });
  const notifyContext = {
    hasUI: true,
    ui: {
      notify(message: string, type?: string) {
        notifications.push({ message, type });
      },
    },
  };

  try {
    const handler = registrations[0]?.options.handler;
    assert.ok(handler);

    const commandOutput = async (input: string) => {
      const start = notifications.length;
      await handler(input, notifyContext);
      return notifications[start] as { message: string; type?: string };
    };

    const automaticNotification = await commandOutput('/zerg mode automatic "hands off"');
    const automaticState = registration.state;
    const automaticSharedState = readSharedZergState();

    assert.equal(automaticState.mode.automation, 'automatic');
    assert.equal(automaticState.mode.controller, 'automation');
    assert.equal(automaticSharedState.mode.automation, 'automatic');
    assert.equal(automaticSharedState.mode.controller, 'automation');
    assert.equal(automaticSharedState.events.at(-1)?.message, automaticState.events.at(-1)?.message);

    const leaderNotification = await commandOutput('/zerg intervene leader ops "review worker handoff"');
    const intervenedState = registration.state;
    const intervenedSharedState = readSharedZergState();

    assert.deepEqual(intervenedState.mode.activeIntervention, {
      kind: 'leader',
      targetId: 'leader',
      targetLabel: 'Leader',
      teamId: 'ops',
      leaderAgentId: 'leader',
      message: 'review worker handoff',
      createdAt: '2026-05-03T03:01:00.000Z',
    });
    assert.equal(intervenedState.mode.automation, 'automatic');
    assert.equal(intervenedState.mode.controller, 'operator');
    assert.deepEqual(intervenedSharedState.mode, intervenedState.mode);
    assert.equal(intervenedSharedState.events.at(-1)?.message, 'intervention recorded: leader leader');

    const assistedNotification = await commandOutput('/zerg mode assisted operator-review');
    const finalState = registration.state;
    const finalSharedState = readSharedZergState();
    const finalEvents = finalState.events.slice(-3);

    assert.equal(finalState.mode.automation, 'assisted');
    assert.equal(finalState.mode.controller, 'operator');
    assert.equal(Object.hasOwn(finalState.mode, 'activeIntervention'), false);
    assert.deepEqual(finalSharedState.mode, finalState.mode);
    assert.deepEqual(finalSharedState.events.slice(-3), finalEvents);
    assert.deepEqual(finalEvents.map((event) => event.type), ['mode', 'permission', 'mode']);
    assert.deepEqual(finalEvents.map((event) => event.createdAt), [
      '2026-05-03T03:00:00.000Z',
      '2026-05-03T03:01:00.000Z',
      '2026-05-03T03:02:00.000Z',
    ]);
    assert.deepEqual(finalEvents.map((event) => event.message), [
      'mode transition manual/operator -> automatic/automation: hands off',
      'intervention recorded: leader leader',
      'mode transition automatic/operator -> assisted/operator: operator-review',
    ]);
    assert.ok(automaticNotification.message.includes('mode set to automatic'));
    assert.ok(leaderNotification.message.includes('intervention recorded against leader leader (team ops): review worker handoff'));
    assert.ok(assistedNotification.message.includes('mode set to assisted'));
    assert.ok(notifications.every((notification) => notification.type === 'info'));
  } finally {
    registration.dispose();
    replaceSharedZergState();
  }
});

test('render monitoring summarizes runtime health activity without mutation', () => {
  let state = createZergState();
  state = applyRuntimeTransition(state, { entity: 'agent', action: 'create', id: 'worker', label: 'Worker', at: '2026-05-02T22:01:00.000Z' });
  state = applyRuntimeTransition(state, { entity: 'agent', action: 'progress', id: 'worker', activity: 'editing state', at: '2026-05-02T22:02:00.000Z' });
  state = applyRuntimeTransition(state, { entity: 'team', action: 'fail', id: 'ops', label: 'Ops', activity: 'blocked on review', at: '2026-05-02T22:03:00.000Z' });
  const before = JSON.stringify(state);

  const status = renderStatusLine(state, { width: 240 });
  const tree = renderAgentTree(state, { width: 240 });

  assert.ok(status.includes(`zerg v${ZERG_EXTENSION_VERSION} command surface`));
  assert.ok(status.includes('agents 1 (1 running)'));
  assert.ok(status.includes('teams 1 (0 running)'));
  assert.ok(status.includes('unhealthy 1'));
  assert.ok(status.includes('last Ops: blocked on review [failed]'));
  assert.ok(tree.includes('Worker [subagent/running/executing] {health:healthy state:executing last:editing state}'));
  assert.ok(tree.includes('team Ops [team/failed/failed] {health:failed state:failed last:blocked on review}'));
  assert.equal(JSON.stringify(state), before);
});

test('renderStatusLine uses deterministic latest runtime ordering when timestamps tie', () => {
  let state = createZergState();
  state = applyRuntimeTransition(state, { entity: 'agent', action: 'create', id: 'worker', label: 'Worker', at: '2026-05-02T23:20:00.000Z' });
  state = applyRuntimeTransition(state, { entity: 'team', action: 'create', id: 'ops', label: 'Operations', at: '2026-05-02T23:20:00.000Z' });
  state = applyRuntimeTransition(state, { entity: 'agent', action: 'progress', id: 'worker', activity: 'agent progress', at: '2026-05-02T23:20:00.000Z' });
  state = applyRuntimeTransition(state, { entity: 'team', action: 'progress', id: 'ops', activity: 'team review', at: '2026-05-02T23:20:00.000Z' });

  const status = renderStatusLine(state, { width: 240 });

  assert.equal(state.agents.worker?.runtime?.lastActivitySequence, 3);
  assert.equal(state.teams.ops?.runtime?.lastActivitySequence, 4);
  assert.ok(status.includes('last Operations: team review [executing]'));
});

test('renderStatusLine falls back to newest displayable runtime activity when latest sanitizes to empty', () => {
  let state = createZergState();
  state = applyRuntimeTransition(state, { entity: 'agent', action: 'create', id: 'worker', label: 'Worker', at: '2026-05-02T23:22:00.000Z' });
  state = applyRuntimeTransition(state, { entity: 'team', action: 'create', id: 'ops', label: 'Ops', at: '2026-05-02T23:22:30.000Z' });
  state = applyRuntimeTransition(state, { entity: 'agent', action: 'progress', id: 'worker', activity: 'editing state', at: '2026-05-02T23:23:00.000Z' });
  state = applyRuntimeTransition(state, { entity: 'team', action: 'progress', id: 'ops', activity: String.fromCharCode(0), at: '2026-05-02T23:24:00.000Z' });

  const status = renderStatusLine(state, { width: 240 });

  assert.ok(status.includes('last Worker: editing state [executing]'));
  assert.ok(!status.includes('last Ops:'));
});

test('explicit-tree rendering resolves referenced live agent and team runtimes', () => {
  let state = createZergState();
  state = applyRuntimeTransition(state, { entity: 'agent', action: 'create', id: 'worker', label: 'Worker', at: '2026-05-02T23:21:00.000Z' });
  state = applyRuntimeTransition(state, { entity: 'agent', action: 'start', id: 'worker', at: '2026-05-02T23:21:30.000Z' });
  state = applyRuntimeTransition(state, { entity: 'agent', action: 'progress', id: 'worker', activity: 'editing state', at: '2026-05-02T23:22:00.000Z' });
  state = applyRuntimeTransition(state, { entity: 'team', action: 'create', id: 'ops', label: 'Operations', memberAgentIds: ['worker'], at: '2026-05-02T23:23:00.000Z' });
  state = applyRuntimeTransition(state, { entity: 'team', action: 'fail', id: 'ops', activity: 'blocked on review', at: '2026-05-02T23:24:00.000Z' });

  state = upsertTreeNode(state, {
    id: 'ref-worker',
    kind: 'agent',
    label: 'Worker node',
    status: 'running',
    refId: 'worker',
    childIds: [],
  });
  state = upsertTreeNode(state, {
    id: 'ops',
    kind: 'team',
    label: 'Operations node',
    status: 'running',
    childIds: [],
  });

  const tree = renderAgentTree(state, { width: 240 });

  assert.ok(tree.includes('agent Worker node [running/executing] {health:healthy state:executing last:editing state}'));
  assert.ok(tree.includes('team Operations node [running/failed] {health:failed state:failed last:blocked on review}'));
});

test('runtime activity sanitizes control whitespace to keep status and tree output one line each', () => {
  const multilineActivity = 'line one\nline two\tline three';
  let state = createZergState();
  state = applyRuntimeTransition(state, { entity: 'agent', action: 'create', id: 'worker', label: 'Worker', at: '2026-05-02T23:25:00.000Z' });
  state = applyRuntimeTransition(state, { entity: 'agent', action: 'progress', id: 'worker', activity: multilineActivity, at: '2026-05-02T23:25:30.000Z' });
  state = upsertTreeNode(state, {
    id: 'worker-runtime',
    kind: 'agent',
    label: 'Worker node',
    status: 'running',
    refId: 'worker',
    childIds: [],
  });

  const status = renderStatusLine(state, { width: 160 });
  const tree = renderAgentTree(state, { width: 160 });
  const narrowStatus = renderStatusLine(state, { width: 60 });
  const narrowTree = renderAgentTree(state, { width: 60 });

  assert.equal(status.split('\n').length, 1);
  assert.equal(tree.split('\n').length, 2);
  assert.ok(status.includes('last Worker: line one line two line three'));
  assert.ok(renderStatusLine(state, { width: 240 }).includes('last Worker: line one line two line three [executing]'));
  assert.ok(tree.includes('line one line two line three'));
  assert.equal(narrowStatus.split('\n').length, 1);
  assert.equal(narrowTree.split('\n').length, 2);
  assert.ok(narrowStatus.length <= 60);
  assert.ok(Math.max(...narrowTree.split('\n').map((line) => line.length)) <= 60);
});

test('deriveThinkingSteps parses numbered reasoning steps with source-line IDs', () => {
  const steps = deriveThinkingSteps('1. inspect context\n2) implement scaffold');

  assert.deepEqual(steps.map((step) => step.title), ['inspect context', 'implement scaffold']);
  assert.deepEqual(steps.map((step) => step.status), ['unknown', 'unknown']);
  assert.deepEqual(steps.map((step) => step.id), ['step-1', 'step-2']);
  assert.deepEqual(steps.map((step) => step.sourceLine), [1, 2]);
});

test('deriveThinkingSteps output is deterministic for repeated identical input', () => {
  const input = 'plain prose\n1. inspect context\n- [x] done item\nneeds attention: blocked item';
  const first = deriveThinkingSteps(input);
  const second = deriveThinkingSteps(input);
  const third = deriveThinkingSteps(input);

  assert.deepEqual(second, first);
  assert.deepEqual(third, first);
  assert.deepEqual(first.map((step) => step.id), ['step-2', 'step-3', 'step-4']);
});

test('deriveThinkingSteps preserves source-line gaps after skipped lines', () => {
  const steps = deriveThinkingSteps('intro only\n1. first parsed\n\nqueued: unsupported prefix\n- second parsed');

  assert.deepEqual(steps, [
    { id: 'step-2', title: 'first parsed', status: 'unknown', sourceLine: 2 },
    { id: 'step-5', title: 'second parsed', status: 'unknown', sourceLine: 5 },
  ]);
});

test('deriveThinkingSteps treats arrays strings LF and CRLF consistently', () => {
  const lines = ['1. first step', '- [x] second step', 'needs-attention: third step'];
  const fromArray = deriveThinkingSteps(lines);

  assert.deepEqual(deriveThinkingSteps(lines.join('\n')), fromArray);
  assert.deepEqual(deriveThinkingSteps(lines.join('\r\n')), fromArray);
  assert.deepEqual(fromArray.map((step) => step.status), ['unknown', 'done', 'blocked']);
});

test('deriveThinkingSteps parses prefixed numbered and bullet items', () => {
  const steps = deriveThinkingSteps('1. todo: inspect context\n2) running - implement parser\n- done: write tests\n* failed: document bug');

  assert.deepEqual(steps.map((step) => step.title), ['inspect context', 'implement parser', 'write tests', 'document bug']);
  assert.deepEqual(steps.map((step) => step.status), ['todo', 'running', 'done', 'failed']);
});

test('deriveThinkingSteps normalizes uppercase status aliases', () => {
  const steps = deriveThinkingSteps(['DONE: context loaded', 'Needs Attention: reviewer blocked', 'NEEDS-ATTENTION - audit blocked']);

  assert.deepEqual(steps.map((step) => step.status), ['done', 'blocked', 'blocked']);
  assert.deepEqual(steps.map((step) => step.title), ['context loaded', 'reviewer blocked', 'audit blocked']);
});

test('deriveThinkingSteps gives checkbox status precedence over embedded prefixes', () => {
  const steps = deriveThinkingSteps('- [ ] done: still todo\n- [x] blocked: already done\n- [!] running: still blocked\n- [-] failed: also blocked');

  assert.deepEqual(steps.map((step) => step.status), ['todo', 'done', 'blocked', 'blocked']);
  assert.deepEqual(steps.map((step) => step.title), ['still todo', 'already done', 'still blocked', 'also blocked']);
});

test('deriveThinkingSteps preserves ordinary hyphenated marked titles', () => {
  const steps = deriveThinkingSteps([
    '- re-run tests',
    '- done-task cleanup',
    '1. follow-up audit',
    '1. failed-first attempt',
    '* command-surface check',
    '* todo-list cleanup',
    '- [ ] follow-up checkbox',
    '- [ ] done-task checkbox',
    '- [x] command-surface checkbox',
    '- [-] re-run blocked checkbox',
    '- [!] needs-attention checkbox title',
    '2) parse - render handoff',
    '3. needs-attention-task follow-up',
  ]);

  assert.deepEqual(steps.map((step) => step.title), [
    're-run tests',
    'done-task cleanup',
    'follow-up audit',
    'failed-first attempt',
    'command-surface check',
    'todo-list cleanup',
    'follow-up checkbox',
    'done-task checkbox',
    'command-surface checkbox',
    're-run blocked checkbox',
    'needs-attention checkbox title',
    'parse - render handoff',
    'needs-attention-task follow-up',
  ]);
  assert.deepEqual(steps.map((step) => step.status), ['unknown', 'unknown', 'unknown', 'unknown', 'unknown', 'unknown', 'todo', 'todo', 'done', 'blocked', 'blocked', 'unknown', 'unknown']);
  assert.deepEqual(steps.map((step) => step.id), ['step-1', 'step-2', 'step-3', 'step-4', 'step-5', 'step-6', 'step-7', 'step-8', 'step-9', 'step-10', 'step-11', 'step-12', 'step-13']);
  assert.deepEqual(steps.map((step) => step.sourceLine), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
});

test('deriveThinkingSteps skips malformed and ambiguous input deterministically', () => {
  const input = [
    '',
    'plain prose',
    '- ',
    '+ unsupported bullet',
    '- [y] unsupported checkbox',
    '- [] empty checkbox',
    'queued: unsupported status prefix',
    'done => unsupported separator',
    '1. queued: unsupported numbered prefix',
    'needs-attention-task',
    '* useful item',
  ];

  assert.deepEqual(deriveThinkingSteps(input), [
    { id: 'step-11', title: 'useful item', status: 'unknown', sourceLine: 11 },
  ]);
});

test('registerZergSwarmExtension uses Pi command registration and notifies command output', async () => {
  const registrations: Array<{ name: string; options: StructuralPiCommandOptions }> = [];
  const notifications: Array<{ message: string; type?: string }> = [];

  registerZergSwarmExtension({
    registerCommand(name, options) {
      registrations.push({ name, options });
    },
  });

  assert.deepEqual(registrations.map((registration) => registration.name), ['zerg', 'zerg-swarm', 'swarm']);
  assert.ok(registrations.every((registration) => typeof registration.options.handler === 'function'));

  const firstHandler = registrations[0]?.options.handler;
  assert.ok(firstHandler);
  assert.ok(registrations.every((registration) => registration.options.handler === firstHandler));

  await firstHandler('status', {
    hasUI: true,
    ui: {
      notify(message, type) {
        notifications.push({ message, type });
      },
    },
  });

  assert.equal(notifications.length, 1);
  assert.ok(notifications[0]?.message.includes(`zerg v${ZERG_EXTENSION_VERSION} command surface`));
  assert.equal(notifications[0]?.type, 'info');
});

test('registerZergSwarmExtension activates Pi event-bus patch once with command flow', async () => {
  const registrations: Array<{ name: string; options: StructuralPiCommandOptions }> = [];
  const notifications: Array<{ message: string; type?: string }> = [];
  const eventBus = createFakePiEventBus();

  replaceSharedZergState();
  const registration = registerZergSwarmExtension({
    events: eventBus,
    registerCommand(name, options) {
      registrations.push({ name, options });
    },
  });

  try {
    assert.equal(registration.patchInstalled, true);
    assert.deepEqual(registrations.map((registered) => registered.name), ['zerg', 'zerg-swarm', 'swarm']);
    assert.deepEqual(registration.state.events.map((event) => event.message), [`pi-zerg-swarm v${ZERG_EXTENSION_VERSION} internal patch path active`]);
    assert.deepEqual(readSharedZergState().events.map((event) => event.message), [`pi-zerg-swarm v${ZERG_EXTENSION_VERSION} internal patch path active`]);

    eventBus.emit('zerg:smoke');

    const observedEvents = registration.state.events.filter((event) => event.message.includes('event bus emit: zerg:smoke'));
    const observedSharedEvents = readSharedZergState().events.filter((event) => event.message.includes('event bus emit: zerg:smoke'));

    assert.equal(observedEvents.length, 1);
    assert.equal(observedSharedEvents.length, 1);
    assert.equal(observedSharedEvents[0]?.message, observedEvents[0]?.message);

    const firstHandler = registrations[0]?.options.handler;
    assert.ok(firstHandler);

    await firstHandler('status', {
      hasUI: true,
      ui: {
        notify(message, type) {
          notifications.push({ message, type });
        },
      },
    });

    assert.equal(notifications.length, 1);
    assert.ok(notifications[0]?.message.includes(`zerg v${ZERG_EXTENSION_VERSION} command surface`));
    assert.equal(notifications[0]?.type, 'info');
  } finally {
    registration.dispose();
    replaceSharedZergState();
  }
});

test('registerZergSwarmExtension restores patch and commands when startup fails', () => {
  const registrations: string[] = [];
  const disposedNames: string[] = [];
  const eventBus = createFakePiEventBus();
  const originalEmit = eventBus.emit;
  let fail = true;

  const context = {
    events: eventBus,
    registerCommand(name: string, _options: StructuralPiCommandOptions) {
      if (fail && name === 'zerg-swarm') {
        throw new Error('register failed');
      }

      registrations.push(name);
      return {
        dispose() {
          disposedNames.push(name);
        },
      };
    },
  };

  assert.throws(() => registerZergSwarmExtension(context), /register failed/);
  assert.equal(eventBus.emit, originalEmit);
  assert.deepEqual(disposedNames, ['zerg']);

  fail = false;
  const registration = registerZergSwarmExtension(context);

  try {
    assert.equal(registration.patchInstalled, true);
    assert.deepEqual(registrations, ['zerg', 'zerg', 'zerg-swarm', 'swarm']);
  } finally {
    registration.dispose();
  }
});

test('registered aliases dispatch status through equivalent handlers', async () => {
  const registrations: Array<{ name: string; options: StructuralPiCommandOptions }> = [];
  const notifications: Array<{ message: string; type?: string }> = [];

  registerZergSwarmExtension({
    registerCommand(name, options) {
      registrations.push({ name, options });
    },
  });

  for (const registration of registrations) {
    await registration.options.handler('status', {
      hasUI: true,
      ui: {
        notify(message, type) {
          notifications.push({ message, type });
        },
      },
    });
  }

  assert.deepEqual(registrations.map((registration) => registration.name), ['zerg', 'zerg-swarm', 'swarm']);
  assert.equal(notifications.length, 3);
  assert.equal(new Set(notifications.map((notification) => notification.message)).size, 1);
  assert.deepEqual(notifications.map((notification) => notification.type), ['info', 'info', 'info']);
});

test('createZergCommandHandler normalizes help, status, whitespace, case, and aliases', () => {
  const handler = createZergCommandHandler(createCommandSurfaceState());
  const helpOutput = handler('').output;
  const statusOutput = handler('status').output;

  assert.equal(handler('  help  ').output, helpOutput);
  assert.ok(helpOutput.includes('Commands: /zerg, /zerg-swarm, /swarm'));
  assert.ok(helpOutput.includes('/zerg agent create|start|progress|stop|fail|reset <agent-id> [label|activity]'));
  assert.ok(helpOutput.includes('/zerg team create|start|progress|stop|fail|reset <team-id> [label|activity]'));
  assert.ok(helpOutput.includes('Monitor syntax: /zerg monitor [readonly on|off|toggle|status]'));
  assert.ok(helpOutput.includes('Registry syntax: /zerg agents [list] | show <id> | create|update <id> --prompt <text> [--model <model>] [--tools a,b] | delete <id>'));
  assert.equal(handler(' STATUS ').output, statusOutput);
  assert.equal(handler('  /swarm   status ').output, statusOutput);
  assert.equal(handler('zerg status').output, statusOutput);
});

test('createZergCommandHandler supports /zerg agents list', () => {
  const handler = createZergCommandHandler(createZergState({ agentDefinitions: createBuiltinAgentDefinitions() }));
  const list = handler('/zerg agents list');
  const show = handler('/zerg agents show reviewer');
  const missing = handler('/zerg agents show ghost');

  assert.equal(list.ok, true);
  assert.ok(list.output.includes('agent definitions:'));
  assert.ok(list.output.includes('reviewer'));
  assert.equal(list.output.includes('Registry syntax'), false);
  assert.equal(show.ok, true);
  assert.ok(show.output.includes('agent definition: reviewer'));
  assert.ok(show.output.includes('source: builtin'));
  assert.equal(show.output.includes('You are'), false);
  assert.equal(missing.ok, false);
  assert.equal(missing.output, 'Unknown agent definition: ghost');
  assert.equal(handler('/zerg agents').output, list.output);
});

test('createZergCommandHandler supports /zerg agents create update and delete with model config', () => {
  const container = createZergStateContainer();
  const handler = createZergCommandHandler(container);

  const created = handler('/zerg agents create Bug_Fixer --label "Bug Fixer" --description "Fixes defects" --prompt "Fix bugs carefully" --model claude-sonnet-4 --fallback-models gpt-5-mini,gemini-pro --max-turns 12 --tools shell,search --disallowed-tools destructive-write');
  assert.equal(created.ok, true);

  let definition = getAgentDefinition(container.snapshot(), 'bug-fixer');
  assert.ok(definition);
  assert.equal(definition.id, 'bug-fixer');
  assert.equal(definition.label, 'Bug Fixer');
  assert.equal(definition.description, 'Fixes defects');
  assert.equal(definition.prompt, 'Fix bugs carefully');
  assert.equal(definition.source, 'runtime');
  assert.equal(definition.model, 'claude-sonnet-4');
  assert.deepEqual(definition.fallbackModels, ['gemini-pro', 'gpt-5-mini']);
  assert.equal(definition.maxTurns, 12);
  assert.deepEqual(definition.tools, ['search', 'shell']);
  assert.deepEqual(definition.disallowedTools, ['destructive-write']);

  const updated = handler('/zerg agents update bug-fixer --label "Bug Wrangler" --prompt "Wrangle bugs safely" --model gpt-5-codex --tools edit,shell');
  assert.equal(updated.ok, true);
  definition = getAgentDefinition(container.snapshot(), 'bug-fixer');
  assert.ok(definition);
  assert.equal(definition.label, 'Bug Wrangler');
  assert.equal(definition.prompt, 'Wrangle bugs safely');
  assert.equal(definition.description, 'Fixes defects');
  assert.equal(definition.model, 'gpt-5-codex');
  assert.deepEqual(definition.tools, ['edit', 'shell']);

  const list = handler('/zerg agents list');
  assert.equal(list.ok, true);
  assert.ok(list.output.includes('bug-fixer'));
  assert.ok(list.output.includes('model:gpt-5-codex'));

  const deleted = handler('/zerg agents delete bug-fixer');
  assert.equal(deleted.ok, true);
  assert.equal(getAgentDefinition(container.snapshot(), 'bug-fixer'), undefined);
  assert.equal(handler('/zerg agents show bug-fixer').output, 'Unknown agent definition: bug-fixer');
});


test('createZergCommandHandler preserves multiline steps payload and skipped source lines', () => {
  const handler = createZergCommandHandler(createCommandSurfaceState());
  const result = handler('/zerg steps plain prose\n- [ ] first step\nqueued: unsupported prefix\n- [x] second step');

  assert.equal(result.output, '2. [todo] first step\n4. [done] second step');
});

test('unknown zerg command returns consistent usage for every invocation', () => {
  const handler = createZergCommandHandler(createCommandSurfaceState());
  const outputs = ['wat', '/zerg wat', '/zerg-swarm wat', '/swarm wat'].map((input) => handler(input).output);

  assert.equal(new Set(outputs).size, 1);

  for (const output of outputs) {
    assert.ok(output.startsWith('Unknown zerg command: wat\n\n'));
    assert.ok(output.includes('/zerg'));
    assert.ok(output.includes('/zerg-swarm'));
    assert.ok(output.includes('/swarm'));
  }
});

test('registerZergSwarmExtension does not duplicate registrations for the same context', () => {
  const registrations: Array<{ name: string; options: StructuralPiCommandOptions }> = [];
  const context = {
    registerCommand(name: string, options: StructuralPiCommandOptions) {
      registrations.push({ name, options });
    },
  };

  const registration = registerZergSwarmExtension(context);
  registerZergSwarmExtension(context);
  registration.dispose();
  registerZergSwarmExtension(context);

  assert.deepEqual(registrations.map((registration) => registration.name), ['zerg', 'zerg-swarm', 'swarm']);
});

test('registerZergSwarmExtension dispose unregisters disposable commands once and permits clean re-registration', () => {
  const registrations: Array<{ name: string; options: StructuralPiCommandOptions }> = [];
  const disposedNames: string[] = [];
  const context = {
    events: createFakePiEventBus(),
    registerCommand(name: string, options: StructuralPiCommandOptions) {
      registrations.push({ name, options });
      let disposed = false;

      return {
        dispose() {
          assert.equal(disposed, false);
          disposed = true;
          disposedNames.push(name);
        },
      };
    },
  };

  const firstRegistration = registerZergSwarmExtension(context);
  const duplicateRegistration = registerZergSwarmExtension(context);

  assert.equal(firstRegistration.patchInstalled, true);
  assert.equal(duplicateRegistration.patchInstalled, false);
  assert.deepEqual(registrations.map((registration) => registration.name), ['zerg', 'zerg-swarm', 'swarm']);

  duplicateRegistration.dispose();
  firstRegistration.dispose();
  firstRegistration.dispose();

  assert.deepEqual(disposedNames, ['zerg', 'zerg-swarm', 'swarm']);

  const secondRegistration = registerZergSwarmExtension(context);

  assert.equal(secondRegistration.patchInstalled, true);
  assert.deepEqual(registrations.map((registration) => registration.name), [
    'zerg',
    'zerg-swarm',
    'swarm',
    'zerg',
    'zerg-swarm',
    'swarm',
  ]);

  secondRegistration.dispose();
});

test('renderAgentTree includes nested agents and their tasks', () => {
  const state = createZergState({
    agents: {
      root: { id: 'root', label: 'Root', kind: 'team-leader', status: 'running' },
      child: { id: 'child', label: 'Child', kind: 'subagent', status: 'idle', parentId: 'root' },
      grandchild: { id: 'grandchild', label: 'Grandchild', kind: 'teammate', status: 'blocked', parentId: 'child' },
    },
    tasks: {
      rootTask: { id: 'rootTask', title: 'Root task', status: 'running', ownerAgentId: 'root', updatedAt: '2026-04-30T00:00:00.000Z' },
      childTask: { id: 'childTask', title: 'Child task', status: 'done', ownerAgentId: 'child', updatedAt: '2026-04-30T00:00:00.000Z' },
      grandchildTask: { id: 'grandchildTask', title: 'Grandchild task', status: 'blocked', ownerAgentId: 'grandchild', updatedAt: '2026-04-30T00:00:00.000Z' },
    },
  });

  const tree = renderAgentTree(state);

  assert.ok(tree.includes('Root [team-leader/running]'));
  assert.ok(tree.includes('Child [subagent/idle]'));
  assert.ok(tree.includes('Grandchild [teammate/blocked]'));
  assert.ok(tree.includes('task Root task [running]'));
  assert.ok(tree.includes('task Child task [done]'));
  assert.ok(tree.includes('task Grandchild task [blocked]'));
});


test('renderAgentTree nests fallback childIds-only agents without duplicate roots', () => {
  const state = createZergState({
    selectedNodeId: 'parent',
    agents: {
      parent: { id: 'parent', label: 'Z Parent', kind: 'team-leader', status: 'running', childIds: ['child', 'child'] },
      child: { id: 'child', label: 'A Child', kind: 'subagent', status: 'idle' },
    },
  });

  const tree = renderAgentTree(state);
  const lines = tree.split('\n');
  const parentLine = lines.findIndex((line) => line.includes('Z Parent [team-leader/running]'));
  const childLine = lines.findIndex((line) => line.includes('A Child [subagent/idle]'));

  assert.ok(parentLine > -1);
  assert.ok(childLine > parentLine);
  assert.ok(lines[childLine]?.startsWith('│  ├─'));
  assert.equal(lines.filter((line) => line.includes('A Child [subagent/idle]')).length, 1);
  assert.ok(lines[parentLine]?.includes('├─▶ Z Parent [team-leader/running]'));
});

test('renderAgentTree shows explicit tree childIds parentId selected orphan missing and duplicate state', () => {
  const state = createZergState({
    selectedNodeId: 'child-ref',
    tree: {
      parent: { id: 'parent', kind: 'team', label: 'Z Parent', status: 'running', childIds: ['child', 'missing', 'child', 'missing'] },
      child: { id: 'child', kind: 'agent', label: 'A Child', status: 'idle', parentId: 'parent', refId: 'child-ref', childIds: [] },
      orphan: { id: 'orphan', kind: 'task', label: 'Orphan task', status: 'blocked', parentId: 'missing-parent', childIds: [] },
    },
  });

  const tree = renderAgentTree(state);
  const lines = tree.split('\n');
  const parentLine = lines.findIndex((line) => line.includes('team Z Parent [running]'));
  const childLines = lines.filter((line) => line.includes('agent A Child [idle]'));
  const missingLines = lines.filter((line) => line.includes('missing-child:missing [missing]'));
  const orphanLine = lines.find((line) => line.includes('task Orphan task [blocked]'));

  assert.ok(parentLine > -1);
  assert.equal(childLines.length, 1);
  assert.ok(childLines[0]?.startsWith('│  ├─▶ agent A Child [idle]'));
  assert.equal(missingLines.length, 1);
  assert.ok(missingLines[0]?.startsWith('│  └─⚠ missing-child:missing [missing]'));
  assert.ok(orphanLine?.includes('orphan-parent:missing-parent'));
});

test('renderAgentTree marks explicit cycles instead of recursing forever', () => {
  const state = createZergState({
    tree: {
      alpha: { id: 'alpha', kind: 'agent', label: 'Alpha', status: 'running', childIds: ['beta'] },
      beta: { id: 'beta', kind: 'agent', label: 'Beta', status: 'idle', childIds: ['alpha'] },
    },
  });

  const tree = renderAgentTree(state);

  assert.ok(tree.includes('agent Alpha [running]'));
  assert.ok(tree.includes('agent Beta [idle]'));
  assert.ok(tree.includes('↻ agent Alpha [cycle]'));
});

test('renderAgentTree renders fallback teams members selected marker and team tasks', () => {
  const state = createZergState({
    selectedNodeId: 'worker',
    agents: {
      leader: { id: 'leader', label: 'Leader', kind: 'team-leader', status: 'running', teamId: 'team' },
      worker: { id: 'worker', label: 'Worker', kind: 'subagent', status: 'idle' },
    },
    teams: {
      team: { id: 'team', label: 'Ops', kind: 'team', status: 'running', leaderAgentId: 'leader', memberAgentIds: ['worker', 'worker'], taskIds: ['team-task'] },
    },
    tasks: {
      teamTask: { id: 'team-task', title: 'Coordinate release', status: 'running', teamId: 'team', updatedAt: '2026-04-30T00:00:00.000Z' },
    },
  });

  const tree = renderAgentTree(state);

  assert.ok(tree.includes('team Ops [team/running]'));
  assert.equal(tree.split('\n').filter((line) => line.includes('Worker [subagent/idle]')).length, 1);
  assert.ok(tree.includes('│  ├─▶ Worker [subagent/idle]'));
  assert.ok(tree.includes('│  └─● task Coordinate release [running]'));
});

test('renderAgentTree truncates large render output at four hundred lines', () => {
  const agents = Object.fromEntries(Array.from({ length: 500 }, (_, index) => {
    const id = `agent-${String(index).padStart(3, '0')}`;
    return [id, { id, label: `Agent ${String(index).padStart(3, '0')}`, kind: 'subagent' as const, status: 'idle' as const }];
  }));
  const state = createZergState({ agents });

  const lines = renderAgentTree(state).split('\n');

  assert.equal(lines.length, 400);
  assert.ok(lines.at(-1)?.includes('render output truncated at 400 lines'));
});

test('renderAgentTree does not mutate render state input', () => {
  const state = createZergState({
    selectedNodeId: 'child-ref',
    agents: {
      parent: { id: 'parent', label: 'Parent', kind: 'team-leader', status: 'running', childIds: ['child'] },
      child: { id: 'child', label: 'Child', kind: 'subagent', status: 'idle' },
    },
    teams: {
      team: { id: 'team', label: 'Team', kind: 'team', status: 'running', memberAgentIds: ['parent'] },
    },
    tasks: {
      task: { id: 'task', title: 'Task', status: 'blocked', ownerAgentId: 'child', blockedBy: ['dep'], updatedAt: '2026-04-30T00:00:00.000Z' },
    },
    tree: {
      parentNode: { id: 'parentNode', kind: 'agent', label: 'Parent', status: 'running', refId: 'parent', childIds: ['childNode', 'missing'] },
      childNode: { id: 'childNode', kind: 'agent', label: 'Child', status: 'idle', refId: 'child-ref', parentId: 'parentNode', childIds: [] },
    },
  });
  const before = JSON.stringify(state);

  renderAgentTree(state);

  assert.equal(JSON.stringify(state), before);
});

test('direct Zerg control API manages agents, teams, runs, logs, and interrupts structurally', async () => {
  const container = createZergStateContainer();
  const launches: ZergSubagentLaunchRequest[] = [];
  const interrupts: string[] = [];
  let completeRun: (() => void) | undefined;
  const completed = new Promise<void>((resolve) => { completeRun = resolve; });
  const adapter: ZergSubagentControlAdapter = {
    kind: 'fake',
    launch(request) {
      launches.push(request);
      return { ok: true, runId: request.runId, taskId: request.taskId, message: `accepted ${request.runId}` };
    },
    interrupt(runId) {
      if (runId) interrupts.push(runId);
      return { ok: true, runId, message: `interrupt requested for ${runId}` };
    },
    async awaitRun(runId) {
      await completed;
      const now = '2026-05-15T10:00:00.000Z';
      const stopped = applyRuntimeTransition(container.read(), {
        entity: 'agent',
        action: 'stop',
        id: runId,
        kind: 'subagent',
        status: 'done',
        activity: 'fake complete',
        substate: 'completed',
        substateReason: 'fake complete',
        metadata: { completedAt: now, finalSummary: 'fake complete' },
      }, { now: () => new Date(now) });
      container.replace(upsertTask(stopped, {
        ...(stopped.tasks['task-direct-run']!),
        id: 'task-direct-run',
        title: stopped.tasks['task-direct-run']?.title ?? 'direct task',
        status: 'done',
        ownerAgentId: runId,
        updatedAt: now,
        substate: 'completed',
        substateReason: 'fake complete',
        substateUpdatedAt: now,
      }));
      return getSubagentRunSnapshot(container.read(), runId);
    },
  };
  const control = createZergControl(container, {
    subagentAdapter: adapter,
    idFactory: { runId: () => 'zerg-direct-run', taskId: () => 'task-direct-run' },
    now: () => new Date('2026-05-15T09:59:00.000Z'),
  });

  const created = await control.execute({ action: 'agents.create', id: 'worker-direct', label: 'Worker Direct', prompt: 'work directly', model: 'gpt-5-codex', fallbackModels: ['gpt-5-mini'], maxTurns: 5, tools: ['read'] });
  assert.equal(created.ok, true);
  assert.equal(created.agentId, 'worker-direct');
  assert.equal((created.data as { agent: { model?: string } }).agent.model, 'gpt-5-codex');

  const updated = await control.execute({ action: 'agents.update', id: 'worker-direct', prompt: 'updated prompt', model: 'gpt-5' });
  assert.equal(updated.ok, true);
  assert.equal((updated.data as { agent: { prompt?: string; model?: string } }).agent.prompt, 'updated prompt');
  assert.equal((updated.data as { agent: { model?: string } }).agent.model, 'gpt-5');

  const team = await control.execute({ action: 'team.create', id: 'direct-team', label: 'Direct Team', leader: 'worker-direct', members: ['worker-direct', 'reviewer'], model: 'gpt-5' });
  assert.equal(team.ok, true);
  assert.deepEqual((team.data as { team: TeamIdentity }).team.memberAgentIds, ['worker-direct', 'reviewer']);
  assert.equal(((team.data as { team: TeamIdentity }).team.metadata as { model?: string }).model, 'gpt-5');

  const background = await control.execute({ action: 'run', agent: 'worker-direct', task: 'direct task', background: true, launchMode: 'fork', maxTurns: 3 });
  assert.equal(background.ok, true);
  assert.equal(background.runId, 'zerg-direct-run');
  assert.equal(background.taskId, 'task-direct-run');
  assert.equal(launches[0]?.agent, 'worker-direct');
  assert.equal(launches[0]?.background, true);
  assert.equal((background.data as { run?: ZergSubagentRunSnapshot }).run?.substate, 'spawning');

  const listedBefore = await control.execute({ action: 'runs.list' });
  assert.equal((listedBefore.data as { runs: ZergSubagentRunSnapshot[] }).runs[0]?.runId, 'zerg-direct-run');
  assert.equal((listedBefore.data as { runs: ZergSubagentRunSnapshot[] }).runs[0]?.substate, 'spawning');

  completeRun?.();
  await adapter.awaitRun?.('zerg-direct-run');
  const shown = await control.execute({ action: 'runs.show', runId: 'zerg-direct-run' });
  assert.equal((shown.data as { run: ZergSubagentRunSnapshot }).run.status, 'done');
  assert.equal((shown.data as { run: ZergSubagentRunSnapshot }).run.substate, 'completed');
  assert.equal((shown.data as { run: ZergSubagentRunSnapshot }).run.finalSummary, 'fake complete');

  const logs = await control.execute({ action: 'logs.list', runId: 'zerg-direct-run' });
  assert.equal(logs.ok, true);
  assert.ok((logs.data as { records: ZergLogRecord[] }).records.some((record) => record.runId === 'zerg-direct-run'));

  const interrupted = await control.execute({ action: 'interrupt', runId: 'zerg-direct-run' });
  assert.equal(interrupted.ok, true);
  assert.deepEqual(interrupts, ['zerg-direct-run']);

  const deleted = await control.execute({ action: 'agents.delete', id: 'worker-direct' });
  assert.equal(deleted.ok, true);
  assert.equal(deleted.agentId, 'worker-direct');

  const invalid = await control.execute({ action: 'bogus' } as never);
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error?.code, 'invalid_request');
});

test('direct Zerg control API runs team ids through the configured leader and preserves original task text', async () => {
  const container = createZergStateContainer();
  const launches: ZergSubagentLaunchRequest[] = [];
  const adapter: ZergSubagentControlAdapter = {
    kind: 'fake',
    launch(request) {
      launches.push(request);
      return { ok: true, runId: request.runId, taskId: request.taskId, message: `accepted ${request.runId}` };
    },
    async awaitRun(runId) {
      const now = '2026-05-16T12:00:00.000Z';
      const stopped = applyRuntimeTransition(container.read(), {
        entity: 'agent',
        action: 'stop',
        id: runId,
        kind: 'subagent',
        status: 'done',
        activity: 'pi native run complete',
        substate: 'completed',
        substateReason: 'pi native run complete',
        metadata: { completedAt: now, finalSummary: 'pi native run complete' },
      }, { now: () => new Date(now) });
      container.replace(upsertTask(stopped, {
        ...(stopped.tasks['task-team-run']!),
        id: 'task-team-run',
        title: stopped.tasks['task-team-run']?.title ?? 'team task',
        status: 'done',
        ownerAgentId: runId,
        updatedAt: now,
        substate: 'completed',
        substateReason: 'pi native run complete',
        substateUpdatedAt: now,
      }));
      return getSubagentRunSnapshot(container.read(), runId);
    },
  };
  const control = createZergControl(container, {
    subagentAdapter: adapter,
    idFactory: { runId: () => 'zerg-team-run', taskId: () => 'task-team-run' },
    now: () => new Date('2026-05-16T11:59:00.000Z'),
  });

  assert.equal((await control.execute({ action: 'agents.create', id: 'lead-direct', label: 'Lead Direct', prompt: 'lead directly' })).ok, true);
  assert.equal((await control.execute({ action: 'agents.create', id: 'member-direct', label: 'Member Direct', prompt: 'member directly' })).ok, true);
  assert.equal((await control.execute({ action: 'team.create', id: 'team-direct', label: 'Team Direct', leader: 'lead-direct', members: ['lead-direct', 'member-direct'], model: 'gpt-5' })).ok, true);

  const task = 'preserve this original team task';
  const result = await control.execute({ action: 'run', agent: 'team-direct', task, background: false });
  assert.equal(result.ok, true);
  assert.equal(launches[0]?.agent, 'lead-direct');
  assert.equal(launches[0]?.agentDefinitionId, 'lead-direct');
  assert.equal(result.runId, 'zerg-team-run');
  assert.equal(result.taskId, 'task-team-run');
  const run = (result.data as { run?: ZergSubagentRunSnapshot }).run;
  assert.equal(run?.task, task);
  assert.equal((run?.metadata as { teamId?: string; originalTask?: string } | undefined)?.teamId, 'team-direct');
  assert.equal((run?.metadata as { teamId?: string; originalTask?: string } | undefined)?.originalTask, task);
});

test('direct Zerg control API sends operator messages through adapter transport honestly', async () => {
  const messages: Array<{ targetId: string; body: string; runId?: string }> = [];
  const control = createZergControl({}, {
    subagentAdapter: {
      kind: 'fake',
      launch() { return { ok: true, message: 'unused' }; },
      async sendMessage(targetId, body, runId) {
        messages.push({ targetId, body, runId });
        return { ok: true, targetId, routedTargetId: targetId, runId, status: 'delivered', message: `delivered ${targetId}` };
      },
    },
  });

  const result = await control.execute({ action: 'message', targetId: 'worker-direct', body: 'please report', runId: 'zerg-live-run' });
  assert.equal(result.ok, true);
  assert.equal(result.output, 'delivered worker-direct');
  assert.deepEqual(messages, [{ targetId: 'worker-direct', body: 'please report', runId: 'zerg-live-run' }]);
  assert.equal((result.data as { message?: { status?: string } }).message?.status, 'delivered');

  const unavailable = await createZergControl({}, { subagentAdapter: { kind: 'fake', launch() { return { ok: true, message: 'unused' }; } } })
    .execute({ action: 'message', targetId: 'worker-direct', body: 'please report' });
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.error?.code, 'transport_unavailable');
});

test('zerg persistence recovers non-terminal runs and durable logs after restart', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'pi-zerg-persist-'));
  try {
    const snapshotFile = join(rootDir, 'state.json');
    const manager = createZergPersistenceManager({ snapshotFile })!;
    const startedAt = '2026-05-25T00:00:00.000Z';
    let state = createZergState();
    state = applyRuntimeTransition(state, {
      entity: 'agent',
      action: 'start',
      id: 'zerg-persisted-run',
      kind: 'subagent',
      status: 'running',
      activity: 'durable task',
      substate: 'executing',
      metadata: { taskId: 'task-persisted', originalTask: 'durable task' },
    }, { now: () => new Date(startedAt) });
    state = upsertTask(state, { id: 'task-persisted', title: 'durable task', status: 'running', ownerAgentId: 'zerg-persisted-run', updatedAt: startedAt });
    state = appendZergLogRecord(state, { source: 'adapter', level: 'info', kind: 'text', message: 'persist me', runId: 'zerg-persisted-run', createdAt: startedAt });
    manager.save(state, () => new Date(startedAt));

    const restored = createZergStateContainer();
    const loadedInfo = manager.hydrate(restored, () => new Date('2026-05-25T00:01:00.000Z'));
    const run = getSubagentRunSnapshot(restored.read(), 'zerg-persisted-run');
    assert.equal(run?.status, 'needs-attention');
    assert.equal(run?.substate, 'failed');
    assert.equal(run?.recovery?.reason, 'process-restart');
    assert.deepEqual(loadedInfo.recoveredRunIds, ['zerg-persisted-run']);
    assert.ok(getZergLogs(restored.read(), { runId: 'zerg-persisted-run' }).some((record) => record.message.includes('recovered zerg-persisted-run')));
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('direct Zerg control API preserves quoted run task text structurally', async () => {
  const launches: ZergSubagentLaunchRequest[] = [];
  const control = createZergControl({}, {
    subagentAdapter: {
      kind: 'fake',
      launch(request) {
        launches.push(request);
        return { ok: true, runId: request.runId, taskId: request.taskId, message: 'accepted' };
      },
    },
    idFactory: { runId: () => 'zerg-quoted-run', taskId: () => 'task-quoted-run' },
  });

  const task = 'fix "quoted" and \'single quoted\' task';
  const result = await control.execute({ action: 'run', agent: 'planner', task, background: true });
  assert.equal(result.ok, true);
  assert.equal(launches[0]?.task, task);

  const optionLike = await control.execute({ action: 'run', agent: 'planner', task: '--bg', background: true });
  assert.equal(optionLike.ok, true);
  assert.equal(launches[1]?.task, '--bg');
});

test('native zerg runner exposes Larra MCP tools when requested', () => {
  const tools = __zergNativeTestInternals.resolvePiNativeTools(['mcp', 'read']);
  assert.ok(tools.includes('mcp'));
  assert.ok(tools.includes('read'));
  assert.ok(tools.includes('larra_orient_session'));
  assert.ok(tools.includes('larra_get_project_memory'));

  const customTools = __zergNativeTestInternals.createPiNativeCustomTools(tools);
  assert.ok(customTools.some((tool) => tool.name === 'mcp'));
  assert.ok(customTools.some((tool) => tool.name === 'larra_orient_session'));

  const defaultTools = __zergNativeTestInternals.resolvePiNativeTools(undefined);
  assert.deepEqual(defaultTools, ['read', 'bash']);
  assert.deepEqual(__zergNativeTestInternals.createPiNativeCustomTools(defaultTools), []);
});

test('native zerg runner extracts final assistant text from Pi session events', () => {
  const fromAgentEnd = __zergNativeTestInternals.extractPiNativePromptResponse({
    type: 'agent_end',
    messages: [
      { role: 'user', content: 'original task' },
      { role: 'assistant', content: [{ type: 'text', text: 'Final Larra-backed plan' }] },
    ],
  });
  assert.equal(fromAgentEnd, 'Final Larra-backed plan');

  const fromTurnEnd = __zergNativeTestInternals.extractPiNativePromptResponse({
    type: 'turn_end',
    message: { role: 'assistant', content: [{ type: 'text', text: 'Turn handoff' }] },
  });
  assert.equal(fromTurnEnd, 'Turn handoff');

  const userMessage = __zergNativeTestInternals.extractPiNativePromptResponse({
    type: 'message_end',
    message: { role: 'user', content: 'do not capture this task text' },
  });
  assert.equal(userMessage, undefined);
});

test('native zerg runner prompt no longer contradicts explicit Larra use', async () => {
  const loader = await __zergNativeTestInternals.createPiNativeResourceLoader({
    createExtensionRuntime: () => ({}),
  }, {
    id: 'larra-planner',
    label: 'Larra Planner',
    prompt: 'Use Larra first when asked.',
    source: 'runtime',
  }, 'Use Larra MCP first for this plan.', process.cwd(), {});

  const systemPrompt = (loader as { getSystemPrompt(): string | undefined }).getSystemPrompt() ?? '';
  assert.equal(systemPrompt.includes('Do not use Larra'), false);
  assert.ok(systemPrompt.includes('Use available project intelligence tools, including Larra'));
  assert.ok(systemPrompt.includes('Use Larra MCP first for this plan.'));
});

test('extension registers zerg_control Pi tool when registerTool is available', async () => {
  const tools: Array<{ name: string; execute?: (id: string, params: unknown) => Promise<unknown> | unknown }> = [];
  const registration = registerZergSwarmExtension({
    registerCommand() {
      return { dispose() {} };
    },
    registerTool(definition) {
      tools.push({ name: definition.name, execute: definition.execute });
      return { dispose() {} };
    },
  });

  try {
    const tool = tools.find((entry) => entry.name === 'zerg_control');
    assert.ok(tool?.execute);
    const result = await tool.execute('tool-1', { action: 'status' }) as { details?: { ok?: boolean; action?: string; data?: { version?: string } } };
    assert.equal(result.details?.ok, true);
    assert.equal(result.details?.action, 'status');
    assert.equal(result.details?.data?.version, ZERG_EXTENSION_VERSION);

    const invalid = await tool.execute('tool-2', { action: 'bogus' }) as { details?: { ok?: boolean; error?: { code?: string; message?: string } } };
    assert.equal(invalid.details?.ok, false);
    assert.equal(invalid.details?.error?.code, 'invalid_request');
    assert.equal(invalid.details?.error?.message, 'Unknown zerg_control action: bogus');
  } finally {
    registration.dispose();
  }
});

test('terminal run state wins over stale adapter starting substate', () => {
  const completedAt = '2026-05-15T10:10:00.000Z';
  let state = createZergState();
  state = applyRuntimeTransition(state, {
    entity: 'agent',
    action: 'stop',
    id: 'zerg-terminal-run',
    label: 'Terminal Worker',
    kind: 'subagent',
    status: 'done',
    substate: 'completed',
    substateReason: 'complete',
    activity: 'complete',
    metadata: { taskId: 'task-terminal', agentDefinitionId: 'worker', completedAt, finalSummary: 'complete' },
  }, { now: () => new Date(completedAt) });
  const container = createZergStateContainer(state);
  const adapter: ZergSubagentControlAdapter = {
    kind: 'fake',
    launch() { return { ok: true, message: 'unused' }; },
    getRun() {
      return { runId: 'zerg-terminal-run', agentId: 'worker', status: 'running', substate: 'starting', substateReason: 'stale', updatedAt: '2026-05-15T10:09:00.000Z' };
    },
  };
  const handler = createZergCommandHandler(container, { subagentAdapter: adapter });
  const listed = handler('/zerg runs');
  assert.equal(listed.ok, true);
  assert.ok(listed.output.includes('(done/completed)'));
  assert.equal(listed.output.includes('running/starting'), false);

  const shown = handler('/zerg runs show zerg-terminal-run');
  assert.equal(shown.ok, true);
  assert.ok(shown.output.includes('status: done/completed'));
  assert.equal(shown.output.includes('done/starting'), false);
});
