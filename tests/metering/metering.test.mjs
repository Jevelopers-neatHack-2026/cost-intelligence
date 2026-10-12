import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Value } from '@sinclair/typebox/value';
import {
  ingestUsage,
  IngestionReceiptSchema,
  UsageObservationSchema,
  UsageOutboxReplayRequestSchema,
  UsageOutboxReplayReceiptSchema,
  validateUsageObservationBoundary,
  replayUsageOutbox,
} from '../../dist/index.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const loadFixture = async () => JSON.parse(await readFile(join(root, 'fixtures/metering/usage-observation.request.json'), 'utf8'));

test('usage intake wrapper and pinned UsageEvent fixture validate together', async () => {
  const request = await loadFixture();
  assert.equal(Value.Check(UsageObservationSchema, request), true);
  const validated = validateUsageObservationBoundary(request);
  assert.equal(validated.ok, true, validated.ok ? '' : validated.error.code);
  if (validated.ok) {
    assert.equal(validated.value.usageEvent.contract, 'UsageEvent');
    assert.equal(validated.value.usageEvent.billable_attempt_id, request.usageEvent.billable_attempt_id);
  }
});

test('source observation, logical operation, and attempt identities remain separate and missing IDs stay unknown', async () => {
  const request = await loadFixture();
  assert.notEqual(request.usageEvent.source_observation_id, request.usageEvent.billable_attempt_id);
  assert.notEqual(request.usageEvent.logical_operation_id, request.usageEvent.provider_attempt_id);
  const missingAttempt = structuredClone(request);
  missingAttempt.usageEvent.source = 'other';
  missingAttempt.usageEvent.provider = 'coding_session';
  missingAttempt.usageEvent.model = 'cumulative_snapshot';
  delete missingAttempt.usageEvent.provider_attempt_id;
  delete missingAttempt.usageEvent.billable_attempt_id;
  assert.equal(validateUsageObservationBoundary(missingAttempt).ok, false, 'pinned canonical validation rejects a missing provider attempt ID');
  const quarantinedReceipt = {
    schemaVersion: '1.0.0', requestId: request.requestId, asOf: '2026-10-11T12:00:00Z', status: 'quarantined',
    eventId: { status: 'unknown' }, sourceObservationId: { status: 'unknown' }, logicalOperationId: { status: 'unknown' },
    providerAttemptId: { status: 'unknown' }, billableAttemptId: { status: 'unknown' }, transportAttemptId: { status: 'unknown' },
    outboxStatus: 'dead_letter', completeness: 'unknown', valuation: 'unknown', durableCommit: true,
    quarantineCode: 'invalid_usage_event',
  };
  assert.equal(Value.Check(IngestionReceiptSchema, quarantinedReceipt), true);
  assert.equal(Value.Check(IngestionReceiptSchema, { ...quarantinedReceipt, billableAttemptId: { status: 'known', id: '' } }), false);
});

test('unknown valuation remains null and incomplete measures do not become zero', async () => {
  const request = await loadFixture();
  request.usageEvent.completeness = 'incomplete';
  request.usageEvent.usage_units = null;
  request.usageEvent.missing_fields = ['usage', 'amount'];
  request.usageEvent.valuation = { basis: 'unknown', money: null, rate_card_ref: null };
  const validated = validateUsageObservationBoundary(request);
  assert.equal(validated.ok, true, validated.ok ? '' : validated.error.code);
  if (validated.ok) {
    assert.equal(validated.value.usageEvent.valuation.money, null);
    assert.equal(validated.value.usageEvent.usage_units, null);
  }
  assert.equal(Value.Check(UsageObservationSchema, request), true);
  assert.equal(Value.Check(UsageObservationSchema, { ...request, unexpected: true }), false);
});

test('scope mismatch, unsupported canonical version, and unsafe source text fail the combined boundary', async () => {
  const request = await loadFixture();
  assert.equal(validateUsageObservationBoundary({ ...request, scope: { ...request.scope, tenantId: 'tenant-foreign' } }).error.code, 'FORBIDDEN_SCOPE');
  assert.equal(validateUsageObservationBoundary({ ...request, usageEvent: { ...request.usageEvent, schema_version: '9.0.0' } }).error.code, 'UNSUPPORTED_VERSION');
  assert.equal(validateUsageObservationBoundary({ ...request, usageEvent: { ...request.usageEvent, model: 'https://example.invalid/?token=secret' } }).error.code, 'VALIDATION_ERROR');
});

test('bounded outbox replay command and unknown identity receipt reject extra fields and oversized batches', async () => {
  const request = await loadFixture();
  const replay = { schemaVersion: '1.0.0', requestId: 'drain-1', scope: request.scope, limit: 100 };
  assert.equal(Value.Check(UsageOutboxReplayRequestSchema, replay), true);
  assert.equal(Value.Check(UsageOutboxReplayRequestSchema, { ...replay, limit: 101 }), false);
  assert.equal(Value.Check(UsageOutboxReplayRequestSchema, { ...replay, other: true }), false);
  let authorityCalls = 0;
  let connectionAttempts = 0;
  const oversizedReplay = await replayUsageOutbox({ ...replay, limit: 101 }, {
    clock: { now: () => new Date('2026-10-11T12:00:00.000Z') },
    financeAuthority: { authorizeCurrent: async () => { authorityCalls++; throw new Error('invalid replay limit must stop before authorization'); } },
    database: { connect: async () => { connectionAttempts++; throw new Error('invalid replay limit must stop before persistence'); } },
  });
  assert.equal(oversizedReplay.ok, false);
  if (!oversizedReplay.ok) assert.equal(oversizedReplay.error.code, 'VALIDATION_ERROR');
  assert.equal(authorityCalls, 0);
  assert.equal(connectionAttempts, 0);
  assert.equal(Value.Check(UsageOutboxReplayReceiptSchema, {
    schemaVersion: '1.0.0', requestId: 'drain-1', asOf: '2026-10-11T12:00:00Z',
    scanned: 0, posted: 0, retried: 0, deadLettered: 0, durableCommit: true,
  }), true);
});

test('oversized source payload is rejected before authority or persistence and is omitted from diagnostics', async () => {
  const exactLimit = 'x'.repeat(65_534);
  const overLimit = 'x'.repeat(65_535);
  assert.equal(new TextEncoder().encode(JSON.stringify(exactLimit)).byteLength, 65_536);
  assert.equal(new TextEncoder().encode(JSON.stringify(overLimit)).byteLength, 65_537);
  let boundaryAuthorityCalls = 0;
  let boundaryConnectionAttempts = 0;
  const boundaryPorts = {
    clock: { now: () => new Date('2026-10-11T12:00:00.000Z') },
    financeAuthority: { authorizeCurrent: async () => { boundaryAuthorityCalls++; throw new Error('byte guard precedes authority'); } },
    database: { connect: async () => { boundaryConnectionAttempts++; throw new Error('byte guard precedes persistence'); } },
  };
  const atLimit = await ingestUsage(exactLimit, boundaryPorts);
  assert.equal(atLimit.ok, false);
  if (!atLimit.ok) assert.equal(atLimit.error.code, 'VALIDATION_ERROR');
  if (!atLimit.ok) assert.doesNotMatch(atLimit.error.safe_message, /64 KiB/,
    'exactly 64 KiB passes the byte guard and reaches wrapper validation');
  const oneByteOver = await ingestUsage(overLimit, boundaryPorts);
  assert.equal(oneByteOver.ok, false);
  if (!oneByteOver.ok) assert.match(oneByteOver.error.safe_message, /64 KiB/);
  assert.equal(boundaryAuthorityCalls, 0);
  assert.equal(boundaryConnectionAttempts, 0);

  const request = await loadFixture();
  const canary = 'CI04A_OVERSIZED_PRIVATE_CANARY';
  request.usageEvent.model = `${canary}${'x'.repeat(66 * 1024)}`;
  assert.ok(new TextEncoder().encode(JSON.stringify(request)).byteLength > 64 * 1024);
  let authorityCalls = 0;
  let connectionAttempts = 0;
  const result = await ingestUsage(request, {
    clock: { now: () => new Date('2026-10-11T12:00:00.000Z') },
    financeAuthority: { authorizeCurrent: async () => { authorityCalls++; throw new Error('oversized input must stop before authority'); } },
    database: { connect: async () => { connectionAttempts++; throw new Error('oversized input must stop before persistence'); } },
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, 'VALIDATION_ERROR');
    assert.match(result.error.safe_message, /64 KiB/);
  }
  assert.equal(authorityCalls, 0);
  assert.equal(connectionAttempts, 0);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(canary));
});
