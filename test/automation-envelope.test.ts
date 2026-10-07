/**
 * Stage 8E focused test: AutomationRequestV1 envelope contract.
 *
 * Owns ONLY the strict, fixed-input envelope the external scheduler or trusted
 * local caller supplies. No event text, inputs, commands, cwd, provider
 * credentials, approval decisions, definitions or working directory may appear
 * here. Identity, occurrence and per-field bound are verified against the
 * current frozen automation-profile.ts staging.
 *
 * Source: s8e-profile-impl staged automation-profile.ts validateAutomationRequest.
 * No replay action, no recovery grant, no execution is exercised.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAutomationRequest, AUTOMATION_PROFILE_BOUNDS } from '../automation-profile.js';
import type { AutomationRequestV1 } from '../automation-profile.js';

const VALID_ID = 'p1';
const VALID_OCCURRENCE = '2026-10-06T12:34:56.789Z';

function valid(): AutomationRequestV1 {
  return { version: 1, profileId: VALID_ID, eventId: VALID_OCCURRENCE, occurrenceTime: VALID_OCCURRENCE };
}

test('envelope accepts the only canonical fixed input shape and freezes ordering', () => {
  const out = validateAutomationRequest(valid());
  assert.equal(out.version, 1);
  assert.equal(out.profileId, VALID_ID);
  assert.equal(out.eventId, VALID_OCCURRENCE);
  assert.equal(out.occurrenceTime, VALID_OCCURRENCE);
  assert.deepEqual(Object.keys(out).sort(), ['eventId', 'occurrenceTime', 'profileId', 'version']);
  // Frozen: further mutation must be impossible.
  assert.throws(() => { (out as { profileId: string }).profileId = 'tampered'; });
  // Equality is bytewise identical to itself regardless of insertion order.
  const reordered = { occurrenceTime: VALID_OCCURRENCE, eventId: VALID_OCCURRENCE, profileId: VALID_ID, version: 1 };
  assert.deepEqual(validateAutomationRequest(reordered), out);
});

test('envelope rejects every unknown authority field including inputs, command, cwd, provider, credential, approval and definition', () => {
  const forbidden: Record<string, unknown> = {
    inputs: { candidatePaths: ['x'] }, command: 'rm -rf /', cmd: 'echo', cwd: '/srv', workingDirectory: '/root',
    provider: 'openrouter', credentials: { token: 'secret' }, env: { API: 'k' }, definition: { id: 'd' },
    definitionId: 'd', definitionHash: '0'.repeat(64), approval: true, approved: true, replay: true, recovery: true,
    modelConfig: { foo: 1 }, modelConfigFile: { path: '/etc/passwd' }, modelPolicy: { provider: 'p', id: 'm', thinkingLevel: 'off' },
    readPaths: ['a'], agents: [], limits: {}, snapshot: {}, read: 'yes', write: 'yes', edit: 'yes', exec: 'yes',
  };
  for (const [key, value] of Object.entries(forbidden)) {
    const candidate = { ...valid(), [key]: value };
    assert.throws(() => validateAutomationRequest(candidate), new RegExp(`unsupported-fields|${key}`), `must reject ${key}`);
  }
});

test('envelope rejects version != 1 and missing or non-integer version', () => {
  for (const version of [0, 2, -1, 1.5, '1', null, undefined, true]) {
    const v: Record<string, unknown> = { ...valid() };
    if (version === undefined) delete v.version; else v.version = version;
    assert.throws(() => validateAutomationRequest(v), /invalid-request-identity|unsupported-fields/);
  }
});

test('envelope rejects non-string, non-identifier and out-of-bound profileId', () => {
  for (const profileId of ['', 'has.dot', 'has space', 'has/slash', 'a'.repeat(81), null, undefined, 42, true, {}, []]) {
    const v: Record<string, unknown> = { ...valid() };
    if (profileId === undefined) delete v.profileId; else v.profileId = profileId;
    assert.throws(() => validateAutomationRequest(v), /invalid-request-identity|unsupported-fields/);
  }
  // Hyphens and underscores are part of the identifier alphabet.
  assert.equal(validateAutomationRequest({ ...valid(), profileId: 'good_id-1' }).profileId, 'good_id-1');
});

test('envelope enforces strict canonical UTC ms and rejects any non-canonical occurrence', () => {
  for (const occurrence of [
    '2026-10-06T12:34:56Z', '2026-10-06T12:34:56.7Z', '2026-10-06T12:34:56.78Z', '2026-10-06T12:34:56.789',
    '2026-10-06 12:34:56.789Z', '2026-10-06T12:34:56.789+00:00', '2026-10-06T12:34:56.789-00:00',
    '2026-13-06T12:34:56.789Z', '2026-10-32T12:34:56.789Z', '2026-10-06T24:00:00.000Z', '2026-10-06T12:60:00.000Z',
    '2026-10-06T12:34:56.789z', '', 'not-a-date', '2026-10-06T12:34:56,789Z', null, undefined, 0, {}, [],
  ]) {
    const v: Record<string, unknown> = { ...valid() };
    if (occurrence === undefined) { delete v.occurrenceTime; delete v.eventId; }
    else { v.occurrenceTime = occurrence; v.eventId = occurrence; }
    assert.throws(() => validateAutomationRequest(v), /invalid-occurrence|unsupported-fields/);
  }
  // JavaScript Date round-trip must equal the input.
  const iso = '2025-01-01T00:00:00.000Z';
  assert.equal(new Date(Date.parse(iso)).toISOString(), iso);
  assert.equal(validateAutomationRequest({ ...valid(), eventId: iso, occurrenceTime: iso }).occurrenceTime, iso);
});

test('envelope requires eventId strictly equal to occurrenceTime (UTC identity) and never accepts coincidence-only', () => {
  // Different string, same instant: rejected.
  for (const pair of [
    ['2026-10-06T12:34:56.789Z', '2026-10-06T12:34:56.790Z'],
    ['2026-10-06T12:34:56.789Z', '2026-10-06t12:34:56.789Z'],
    ['2026-10-06T12:34:56.789Z', '2026-10-06T12:34:56.789Z '],
  ]) {
    const v = { ...valid(), eventId: pair[0], occurrenceTime: pair[1] };
    assert.throws(() => validateAutomationRequest(v), /invalid-occurrence/);
  }
  // eventId missing or null: rejected.
  for (const eventId of [null, undefined, '', 0, true, {}]) {
    const v: Record<string, unknown> = { ...valid() };
    if (eventId === undefined) delete v.eventId; else v.eventId = eventId;
    assert.throws(() => validateAutomationRequest(v), /invalid-occurrence|unsupported-fields/);
  }
  // No implicit coercion of eventId back into occurrenceTime.
  assert.throws(() => validateAutomationRequest({ version: 1, profileId: VALID_ID, occurrenceTime: VALID_OCCURRENCE }), /unsupported-fields/);
  assert.throws(() => validateAutomationRequest({ version: 1, profileId: VALID_ID, eventId: VALID_OCCURRENCE }), /unsupported-fields/);
});

test('envelope applies the request byte bound before identity checks and rejects oversized input', () => {
  assert.equal(AUTOMATION_PROFILE_BOUNDS.requestBytes, 4096);
  const huge = valid();
  const big = 'x'.repeat(AUTOMATION_PROFILE_BOUNDS.requestBytes);
  // Adding an extra byte via a single field trips the byte bound.
  const oversized: Record<string, unknown> = { version: 1, profileId: VALID_ID, eventId: VALID_OCCURRENCE, occurrenceTime: big };
  assert.throws(() => validateAutomationRequest(oversized), /exceeded|invalid/);
  // JSON encoding path stays bounded: an arbitrarily nested object also rejects.
  const deep: unknown = { version: 1, profileId: VALID_ID, eventId: VALID_OCCURRENCE, occurrenceTime: { x: 1 } };
  assert.throws(() => validateAutomationRequest(deep as never));
});

test('envelope is a pure validator: returns frozen canonical data and never parses execution or schedule', () => {
  const out = validateAutomationRequest(valid());
  // Must NOT carry an execution timestamp or scheduler hint.
  for (const forbiddenKey of ['scheduledAt', 'nextRun', 'delayMs', 'intervalMs', 'attempts', 'retry', 'workflowRunId']) {
    assert.equal(({ ...out } as Record<string, unknown>)[forbiddenKey], undefined, `${forbiddenKey} must not exist`);
  }
  // Returned object is deeply frozen and shares the same identity values.
  const again = validateAutomationRequest(valid());
  assert.deepEqual(out, again);
  assert.equal(out.occurrenceTime, again.occurrenceTime);
});

test('envelope rejects arrays, numbers, getters and prototypes at the boundary', () => {
  for (const value of [[], 7, true, null, undefined, () => 1]) {
    assert.throws(() => validateAutomationRequest(value as never));
  }
  // Prototype-tampered object: should still go through workflowJson's plain-object check.
  const proto = Object.create({ version: 1, profileId: VALID_ID, eventId: VALID_OCCURRENCE, occurrenceTime: VALID_OCCURRENCE });
  assert.throws(() => validateAutomationRequest(proto as never));
  // Getter-defined field is detected and refused before identity can be coerced.
  const getter = { version: 1, profileId: VALID_ID, eventId: VALID_OCCURRENCE, occurrenceTime: VALID_OCCURRENCE };
  Object.defineProperty(getter, 'profileId', { enumerable: true, get() { return VALID_ID; } });
  assert.throws(() => validateAutomationRequest(getter as never));
});

test('envelope accepts a wide range of legal ISO ms timestamps and identical-event idempotence holds', () => {
  const samples = [
    '1970-01-01T00:00:00.000Z', '2024-02-29T23:59:59.999Z', '2025-12-31T23:59:59.999Z',
    '2099-06-30T00:00:00.000Z', '2026-10-06T12:34:56.789Z',
  ];
  for (const occurrence of samples) {
    const v = { version: 1, profileId: VALID_ID, eventId: occurrence, occurrenceTime: occurrence };
    const out = validateAutomationRequest(v);
    assert.equal(out.occurrenceTime, occurrence);
    assert.equal(out.eventId, occurrence);
  }
  // Two calls with identical input must be deep-equal but NOT referentially the same frozen object.
  const a = validateAutomationRequest(valid());
  const b = validateAutomationRequest(valid());
  assert.deepEqual(a, b);
  assert.notEqual(a, b);
});
