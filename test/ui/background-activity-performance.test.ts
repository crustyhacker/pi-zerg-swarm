import assert from 'node:assert/strict';
import test from 'node:test';
import { performance } from 'node:perf_hooks';
import type { Component, TUI } from '@earendil-works/pi-tui';
import { visibleWidth } from '@earendil-works/pi-tui';
import type { Theme } from '@earendil-works/pi-coding-agent';
import type { ActivitySource, NativeActivitySnapshot, NativeActivityRun } from '../../activity.js';
import { createBackgroundActivityController } from '../../ui/background-activity.js';
import type { BackgroundActivityClock, BackgroundActivityContext } from '../../ui/background-activity.js';

/** Observer-only benchmark: fake compact source, no SDK/providers/runtime optimization. */
for (const workers of [8, 32, 128]) test(`observer update/render/event budget at ${workers} workers`, t => {
  let now = 100_000, id = 0, pulls = 0, scans = 0, renders = 0;
  const jobs = new Map<number, { at: number; callback: () => void }>();
  const clock: BackgroundActivityClock = { now: () => now,
    setTimeout(callback, delay) { const next = ++id; jobs.set(next, { at: now + delay, callback }); return next; },
    clearTimeout(handle) { jobs.delete(handle as number); } };
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      const entry = [...jobs].filter(([, job]) => job.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!entry) break;
      now = entry[1].at; jobs.delete(entry[0]); entry[1].callback();
    }
    now = end;
  };
  const rows: NativeActivityRun[] = Array.from({ length: 8 }, (_, group) => ({
    runId: `run-${group}`, label: '解析', phase: 'working', local: true, startedAt: new Date(0).toISOString(),
    members: Array.from({ length: workers / 8 }, (_, member) => ({
      parentRunId: `run-${group}`, memberRunId: `worker-${group}-${member}`, piSessionId: `session-${group}-${member}`,
      agentDefinitionId: `agent-${member}`, phase: 'working', cleanup: 'pending', observedExecution: true, attachment: 'attached',
    })),
  }));
  const dto: NativeActivitySnapshot = { revision: 1, clipped: false, get runs() { scans++; return rows; } };
  const listeners = new Set<() => void>();
  const source: ActivitySource<NativeActivitySnapshot> = { snapshot() { pulls++; return dto; },
    subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; } };
  let component: Component | undefined;
  const tui = { terminal: { rows: 30 }, requestRender() { renders++; } } as unknown as TUI;
  const theme = { fg: (_token: string, text: string) => `\x1b[36m${text}\x1b[0m` } as Theme;
  const ctx: BackgroundActivityContext = { mode: 'tui', hasUI: true, ui: { setWidget(_key: string, content: unknown) {
    if (typeof content === 'function') component = content(tui, theme); else component = undefined;
  } } };
  const controller = createBackgroundActivityController({ native: source, clock, activeShortcut: 'Alt+g' }); controller.attach(ctx);
  const updateMs: number[] = [], renderMs: number[] = [];
  const start = performance.now();
  // 20,000 source invalidations in 200 bursts -> exactly 200 additional cached pulls.
  for (let burst = 0; burst < 200; burst++) {
    const update = performance.now();
    for (let event = 0; event < 100; event++) for (const fn of listeners) fn();
    advance(50); updateMs.push(performance.now() - update);
    for (let frame = 0; frame < 5; frame++) {
      const before = performance.now(); const lines = component!.render(frame % 2 ? 40 : 120);
      renderMs.push(performance.now() - before);
      assert.ok(lines.length <= 2); for (const line of lines) assert.ok(visibleWidth(line) <= (frame % 2 ? 40 : 80));
      if (!(frame % 2)) {
        assert.match(lines[0]!, new RegExp(`${workers} agents working`));
        assert.match(lines[0]!, /\[Alt\+g\] Manage/);
      }
    }
  }
  assert.equal(pulls, 201); assert.equal(renders, 200);
  const pullsBeforeTick = pulls, scansBeforeTick = scans, rendersBeforeTick = renders;
  advance(10_000);
  assert.equal(pulls, pullsBeforeTick); assert.equal(scans, scansBeforeTick); assert.equal(renders - rendersBeforeTick, 10);
  const percentile = (samples: number[], fraction: number) => [...samples].sort((a, b) => a - b)[Math.floor(samples.length * fraction)]!;
  const updateP95 = percentile(updateMs, .95), renderP95 = percentile(renderMs, .95);
  // Half of a 16ms frame is available for observer work; catch regressions without hard real-time claims.
  assert.ok(updateP95 + renderP95 < 8, `p95 observer work ${updateP95 + renderP95}ms exceeds 8ms typing budget`);
  t.diagnostic(JSON.stringify({ workers, events: 20_000, sourcePulls: pulls, projectionRunAccesses: scans,
    renderCalls: renderMs.length, coalescedUpdates: 200, tickPulls: pulls - pullsBeforeTick,
    tickProjectionScans: scans - scansBeforeTick, updateP95Ms: updateP95, renderP95Ms: renderP95,
    elapsedMs: performance.now() - start }));
  // Elapsed frames retain the actual focus/count and full active hint without refreshing DTOs.
  assert.match(component!.render(120)[0]!, new RegExp(`${workers} agents working`));
  assert.match(component!.render(120)[0]!, /\[Alt\+g\] Manage/);
  assert.equal(pulls, pullsBeforeTick); assert.equal(scans, scansBeforeTick);
  // Also measure event-time eligibility discovery with active focus + 24 distinct nonfocus expiries.
  // Keep the original 20,000-event/201-pull/1,000-render metrics and 8ms budget above unchanged.
  const mixedStart = performance.now(), mixedUpdates: number[] = [];
  rows.push(...Array.from({ length: 24 }, (_, i): NativeActivityRun => ({
    runId: `done-${i}`, phase: 'completed', local: true, startedAt: new Date(0).toISOString(),
    endedAt: new Date(now - 2000 + i * 50).toISOString(), members: [],
  })));
  const mixedPulls = pulls;
  for (let burst = 0; burst < 20; burst++) {
    const before = performance.now();
    for (let event = 0; event < 100; event++) for (const fn of listeners) fn();
    advance(50); mixedUpdates.push(performance.now() - before);
  }
  assert.equal(pulls - mixedPulls, 20);
  const mixedP95 = percentile(mixedUpdates, .95);
  assert.ok(mixedP95 + renderP95 < 8, `mixed-success p95 observer work ${mixedP95 + renderP95}ms exceeds 8ms typing budget`);
  const cachedPulls = pulls, cachedScans = scans;
  advance(1000); component!.render(120);
  assert.equal(pulls, cachedPulls); assert.equal(scans, cachedScans);
  t.diagnostic(JSON.stringify({ workers, scenario: 'active-focus-24-nonfocus-successes', events: 2000,
    coalescedUpdates: 20, sourcePulls: pulls - mixedPulls, tickPulls: pulls - cachedPulls,
    tickProjectionScans: scans - cachedScans, updateP95Ms: mixedP95, renderP95Ms: renderP95,
    elapsedMs: performance.now() - mixedStart }));
  controller.setVisible(false); assert.equal(jobs.size, 0);
  controller.dispose(); assert.equal(listeners.size, 0); assert.equal(jobs.size, 0);
});
