import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error Public JavaScript fixture intentionally has no declaration file.
import { acceptance } from './fixtures/automation-cli-acceptance.mjs';

const enabled = process.env.ZERG_WORKFLOW_AUTOMATION_ACCEPTANCE === 'parent-approved';

test('explicit opt-in owned-loopback actual automation CLI/SDK acceptance', { skip: !enabled, timeout: 180000 }, async t => {
  // This selector belongs to the trusted test operator, never to an automation event.
  // Copy a declared installed dependency closure here to test a packed layout offline.
  const layout = resolve(process.env.ZERG_AUTOMATION_PACKAGE_ROOT ?? fileURLToPath(new URL('../', import.meta.url)));
  const evidence = process.env.ZERG_AUTOMATION_ACCEPTANCE_EVIDENCE ?? mkdtempSync(resolve(tmpdir(), 's8e-final-b2-evidence-'));
  const focus = process.env.S8E_ACCEPTANCE_FOCUS;
  assert.ok(focus === undefined || focus === 'quota-outcome');
  const result = await acceptance(layout, evidence, focus);
  for (const scenario of result.results) await t.test(scenario.name, () => assert.equal(scenario.pass, true, scenario.error));
  assert.equal(result.failed, 0);
  assert.equal(result.passed, focus === 'quota-outcome' ? 5 : 23);
  assert.ok(['1.0.0', '1.0.4'].includes(result.sdkVersion), `Unreviewed SDK ${result.sdkVersion}; obtain a fresh acceptance grant.`);
});
