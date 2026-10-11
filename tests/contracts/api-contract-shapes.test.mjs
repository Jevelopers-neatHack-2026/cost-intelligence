import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Value } from '@sinclair/typebox/value';
import * as api from '../../dist/index.js';
import { validateRequest } from '../../dist/shared/contracts.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const scope = { tenantId: 'tenant-a', projectId: 'project-a', environment: 'test', billingMode: 'simulated', actorId: 'actor-a' };
const hash = `sha256:${'a'.repeat(64)}`;

test('local envelopes reject unknown fields and unsupported exact schema versions', () => {
  const base = { schemaVersion: '1.0.0', requestId: 'safe-req-1', idempotencyKey: 'idem-1', scope };
  assert.equal(Value.Check(api.RequestBaseSchema, base), true);
  assert.equal(Value.Check(api.RequestBaseSchema, { ...base, added: true }), false);
  assert.equal(validateRequest(api.RequestBaseSchema, { ...base, schemaVersion: '1.1.0' }, 'test', 'version').error.code, 'UNSUPPORTED_VERSION');
  assert.equal(validateRequest(api.RequestBaseSchema, { ...base, schemaVersion: '2.0.0' }, 'test', 'version').error.code, 'UNSUPPORTED_VERSION');
  assert.equal(validateRequest(api.RequestBaseSchema, { ...base, added: true }, 'test', 'extra').error.code, 'VALIDATION_ERROR');
});

test('financial scalar boundaries preserve canonical economic modes and 18-place exact decimals', () => {
  for (const billingMode of ['live', 'sandbox', 'simulated']) assert.equal(Value.Check(api.TrustedScopeSchema, { ...scope, billingMode }), true);
  for (const billingMode of ['included', 'subscription', 'credits', 'paid']) assert.equal(Value.Check(api.TrustedScopeSchema, { ...scope, billingMode }), false);
  assert.equal(Value.Check(api.DecimalAmountSchema, '0.123456789012345678'), true);
  assert.equal(Value.Check(api.DecimalAmountSchema, '0.1234567890123456789'), false);
});

test('all public local error codes have bounded safe diagnostic envelopes', async () => {
  const canary = 'PRIVATE_REQUEST_ID_CANARY';
  const errorFixture = JSON.parse(await readFile(join(root, 'fixtures/api/error-envelope.response.json'), 'utf8'));
  assert.equal(Value.Check(api.ErrorEnvelopeSchema, errorFixture), true, 'documented finance-owned error response fixture');
  for (const code of ['VALIDATION_ERROR', 'UNSUPPORTED_VERSION', 'FORBIDDEN_SCOPE', 'IDEMPOTENCY_CONFLICT', 'PRICING_UNKNOWN', 'BUDGET_EXCEEDED', 'BUDGET_UNAVAILABLE', 'RECONCILIATION_PENDING', 'SOURCE_UNAVAILABLE']) {
    const envelope = api.errorEnvelope('metering', 'ingestUsage', code, canary, 'Safe error text.');
    assert.equal(Value.Check(api.ErrorEnvelopeSchema, envelope), true);
    assert.ok(envelope.diagnostic_ref.length <= 160);
    assert.ok(!JSON.stringify(envelope).includes(canary));
  }
});

test('typed accounting and reservation contracts include partial, unavailable, overrun, and adjustment lineage', () => {
  const attemptBinding = { logicalOperationId: 'op-1', transportAttemptId: 'transport-1', providerRequestId: null, providerAttemptId: 'provider-1', billableAttemptId: 'billable-1' };
  for (const status of ['authorized', 'denied', 'partial', 'unavailable']) {
    const decision = {
      schemaVersion: '1.0.0', requestId: 'decision-1', decidedAt: '2026-10-10T12:00:00Z', status,
      reservationId: 'reservation-1', heldAmount: '0.000000000000000001', availableAmount: '1.00', currency: 'USD',
      estimateCompleteness: 'unknown', knownSubtotal: '0', boundedConservativeMaximum: null, rateCardRef: null,
      policyRef: { contract: 'BudgetPolicy', schema_version: '1.0.0', id: 'policy-1', revision: 1, content_hash: hash },
      expiryEligibility: 'held_for_reconciliation', attemptBinding, partialAuthorization: null, retryAfterMs: null,
    };
    assert.equal(Value.Check(api.AuthorizationDecisionSchema, decision), true, status);
  }

  const settle = {
    schemaVersion: '1.0.0', requestId: 'settle-1', idempotencyKey: 'settle-idem', scope, reservationId: 'reservation-1', expectedRevision: 2,
    actorReference: 'worker-1', sourceAuthorityRef: { contract: 'BudgetReservation', schema_version: '1.0.0', id: 'reservation-1', revision: 2, content_hash: hash },
    attemptBinding, action: 'settle', canonicalCommand: {},
    settlement: { measure: 'cumulative', finality: 'final', sequence: 2, cumulativeAmount: '0.25', currency: 'USD', usageCompleteness: 'incomplete', sourceObservationRefs: [{ contract: 'UsageEvent', schema_version: '1.0.0', id: 'usage-1', revision: 1, content_hash: hash }], allowObservedOverrun: true },
  };
  assert.equal(Value.Check(api.SettleReservationCommandSchema, settle), true);
  assert.equal(Value.Check(api.ReservationCommandSchema, settle), true);
  assert.equal(Value.Check(api.SettleReservationCommandSchema, { ...settle, settlement: { ...settle.settlement, allowObservedOverrun: false } }), false);

  const adjustment = {
    schemaVersion: '1.0.0', requestId: 'adjust-1', idempotencyKey: 'adjust-idem', scope, adjustmentId: 'adjustment-1', amount: '1.23', currency: 'USD',
    direction: 'increase_expense', expectedLedgerRevision: 9, actorReference: 'controller-1', reasonReference: 'invoice-correction-1',
    originalPostingRef: { contract: 'FinancialEvent', schema_version: '1.0.0', id: 'posting-1', revision: 8, content_hash: hash },
    sourceReference: 'invoice-1', sourceContentHash: hash, evidenceMode: 'sandbox',
  };
  assert.equal(Value.Check(api.ExpenseAdjustmentRequestSchema, adjustment), true);
  assert.equal(Value.Check(api.ExpenseAdjustmentRequestSchema, { ...adjustment, sourceContentHash: 'not-a-hash' }), false);
});

test('financial event valuation preserves unknown as null and rejects incompatible amount states', async () => {
  const event = JSON.parse(await readFile(join(root, 'fixtures/api/financial-event-unknown.request.json'), 'utf8'));
  assert.equal(Value.Check(api.FinancialEventSchema, event), true, 'unknown valuation has no invented numeric amount');
  assert.equal(Value.Check(api.FinancialEventSchema, { ...event, amount: '0' }), false, 'unknown valuation cannot be represented as zero');
  assert.equal(Value.Check(api.FinancialEventSchema, { ...event, valuation: 'estimated', amount: null }), false, 'estimated valuation requires a known amount');
  assert.equal(Value.Check(api.FinancialEventSchema, { ...event, valuation: 'provider_confirmed', amount: null }), false, 'confirmed valuation requires a known amount');
});

test('budget and posting receipts accept the versioned applied, denied, stale, replay, and conflict outcomes', async () => {
  const outcomes = JSON.parse(await readFile(join(root, 'fixtures/api/decision-results.response.json'), 'utf8'));
  const expectedStatuses = ['applied', 'denied', 'stale', 'replay', 'conflict'];
  assert.deepEqual(outcomes.budgetChange.map(result => result.status), expectedStatuses);
  assert.deepEqual(outcomes.expenseAdjustment.map(result => result.status), expectedStatuses);
  for (const result of outcomes.budgetChange) assert.equal(Value.Check(api.BudgetChangeReceiptSchema, result), true, `budget change ${result.status} result fixture`);
  for (const result of outcomes.expenseAdjustment) assert.equal(Value.Check(api.PostingReceiptSchema, result), true, `expense adjustment ${result.status} result fixture`);
});

test('finance-owned summary query and snapshot wrappers carry reproducible identity and scoped filters', async () => {
  const query = JSON.parse(await readFile(join(root, 'fixtures/api/summary-query.request.json'), 'utf8'));
  assert.equal(Value.Check(api.FinancialSummaryQuerySchema, query), true);
  assert.equal(Value.Check(api.FinancialSummaryQuerySchema, { ...query, filters: { ...query.filters, customerIds: ['customer-a'], privateScope: true } }), false);
  assert.equal(Value.Check(api.FinancialSummaryQuerySchema, { ...query, timezone: 'not a timezone' }), false);

  const fixture = JSON.parse(await readFile(join(root, 'node_modules/@jevelopers/shared-contracts/fixtures/FinancialSummary.json'), 'utf8')).valid;
  const page = {
    schemaVersion: '1.0.0', requestId: 'query-1', snapshotId: 'snapshot-1', queryContentHash: hash, asOf: '2026-10-02T00:00:00Z', timezone: 'America/New_York',
    watermark: { watermarkId: 'watermark-1', capturedAt: '2026-10-02T00:00:00Z', sources: [{ source: 'provider-ledger', revision: 'r9', observedThrough: '2026-10-02T00:00:00Z', contentHash: hash, completeness: 'partial' }] },
    filters: query.filters, summaryContentHash: hash, summary: fixture, hasMore: true, nextCursor: 'opaque-cursor',
  };
  assert.equal(Value.Check(api.FinancialSummaryPageSchema, page), true);
  assert.equal(Value.Check(api.ExportRequestSchema, {
    schemaVersion: '1.0.0', requestId: 'export-1', idempotencyKey: 'export-idem', scope, summarySnapshot: page, summaryContentHash: hash,
    destination: 'cfo.ai', format: 'json', requestedAt: '2026-10-02T00:01:00Z', evidenceMode: 'mocked', requestedBy: 'finance-user',
  }), true);
});
