import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { estimateV2, validateEstimateRequestV2Boundary } from '../../dist/index.js';

const usageEvent = JSON.parse(await readFile(new URL(
  '../../node_modules/@jevelopers/shared-contracts/fixtures/UsageEvent.json', import.meta.url,
), 'utf8')).valid;
const now = '2026-10-10T12:00:00.000Z';
const scope = {
  tenantId: usageEvent.tenant_id,
  projectId: usageEvent.project_id,
  environment: usageEvent.environment,
  billingMode: usageEvent.billing_mode,
  actorId: 'synthetic-pricing-clock-reader',
};
const request = {
  schemaVersion: '2.0.0', requestId: 'pricing-clock', idempotencyKey: 'pricing-clock', scope,
  usageEvent,
  selection: {
    policy: 'event_time', effectiveAt: usageEvent.occurred_at, product: 'responses',
    requestedCurrency: 'USD', rateCardRef: null, fxRateRef: null, contractTimeEvidenceRef: null,
    contextTier: null, serviceTier: null, reasoningMode: null, toolClass: null, dimensionsEvidenceRef: null,
  },
};
assert.equal(validateEstimateRequestV2Boundary(request).ok, true);

function runtime(authority, valuationClock) {
  const calls = { clock: 0, authorization: 0, database: 0 };
  const ports = {
    trustedContext: { resolve: async () => scope },
    database: { connect: async () => { calls.database++; throw new Error('UNEXPECTED_DATABASE_ACCESS'); } },
    // First read verifies the freshly returned authorization. The second read
    // stamps the valuation, which must independently contain a clock failure.
    clock: { now: () => ++calls.clock === 1 ? new Date(now) : valuationClock() },
  };
  if (authority === 'finance') {
    ports.financeAuthority = { authorizeCurrent: async ({ operation, permission }) => {
      calls.authorization++;
      return {
        status: 'allowed', decisionId: 'synthetic-current-pricing', operation, permission, scope,
        principal: { kind: 'user', actorId: scope.actorId, membershipStatus: 'active', membershipRevision: 'fixture-1' },
        verifiedAt: now, expiresAt: '2026-10-10T12:01:00.000Z',
      };
    } };
  } else {
    ports.actionAuthority = { authorize: async ({ action }) => {
      calls.authorization++;
      return {
        decisionId: 'synthetic-compatible-pricing', action, scope, actorId: scope.actorId,
        allowed: true, issuedAt: now, expiresAt: '2026-10-10T12:01:00.000Z',
      };
    } };
  }
  return { ports, calls };
}

const invalidClocks = [
  ['throws', () => { throw new Error('PRIVATE_CLOCK_CANARY'); }],
  ['returns an invalid Date', () => new Date(NaN)],
  ['returns null', () => null],
  ['returns a date-like object', () => ({ toISOString: () => now })],
  ['throws while serializing a Date', () => Object.assign(new Date(now), {
    toISOString: () => { throw new Error('PRIVATE_SERIALIZATION_CANARY'); },
  })],
];

for (const authority of ['finance', 'legacy pricing']) {
  for (const [label, valuationClock] of invalidClocks) {
    test(`CI-03.3 ${authority} authorization contains a valuation clock that ${label}`, async () => {
      const { ports, calls } = runtime(authority, valuationClock);
      const result = await estimateV2(request, ports);
      assert.equal(result.ok, false);
      assert.equal(result.error.code, 'SOURCE_UNAVAILABLE');
      assert.equal(result.error.retryable, true);
      assert.equal(result.error.module, 'pricing');
      assert.equal(result.error.operation, 'estimate');
      assert.match(result.error.diagnostic_ref, /^ci1:/);
      assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|Invalid time value|UNEXPECTED_DATABASE/);
      assert.deepEqual(calls, { clock: 2, authorization: 1, database: 0 });
    });
  }

  test(`CI-03.2 ${authority} authorization preserves a valid valuation clock`, async () => {
    const { ports, calls } = runtime(authority, () => new Date(now));
    const result = await estimateV2(request, ports);
    assert.equal(result.ok, true);
    assert.equal(result.value.estimatedAt, now);
    // The retained fixture uses a legacy rate-card reference. Its preexisting
    // typed result needs no catalog and must be unaffected by this repair.
    assert.equal(result.value.status, 'pricing_unknown');
    assert.deepEqual(result.value.missingDimensions, ['legacy_rate_card_reference_requires_versioned_migration']);
    assert.deepEqual(calls, { clock: 2, authorization: 1, database: 0 });
  });
}
