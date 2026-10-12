import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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

test('combined public validators enforce every nested pinned canonical request and response', async () => {
  const load = async name => JSON.parse(await readFile(join(root, `node_modules/@jevelopers/shared-contracts/fixtures/${name}.json`), 'utf8')).valid;
  const [usageEvent, reserveRequest, settleRequest, releaseRequest, reservation, summary] = await Promise.all([
    load('UsageEvent'), load('ReserveRequest'), load('SettleRequest'), load('ReleaseRequest'), load('BudgetReservation'), load('FinancialSummary'),
  ]);
  const scopeFor = value => ({ tenantId: value.tenant_id, projectId: value.project_id, environment: value.environment, billingMode: value.billing_mode, actorId: 'fixture-actor' });
  const attemptBinding = {
    logicalOperationId: usageEvent.logical_operation_id, transportAttemptId: usageEvent.transport_attempt_id,
    providerRequestId: usageEvent.provider_request_id, providerAttemptId: usageEvent.provider_attempt_id,
    billableAttemptId: usageEvent.billable_attempt_id,
  };
  const usageObservation = {
    schemaVersion: '1.0.0', requestId: 'combined-usage', idempotencyKey: 'combined-usage-idem', scope: scopeFor(usageEvent),
    usageEvent, evidenceMode: 'mocked', verificationStatus: 'verified', evidenceProvenanceRef: 'fixture:usage',
  };
  const estimateRequest = {
    schemaVersion: '1.0.0', requestId: 'combined-estimate', idempotencyKey: 'combined-estimate-idem', scope: scopeFor(usageEvent), usageEvent,
    selection: {
      policy: 'event_time', effectiveAt: usageEvent.occurred_at, requestedCurrency: 'USD', rateCardRef: null,
    },
  };
  const reservationRequest = {
    schemaVersion: '1.0.0', requestId: 'combined-reserve', idempotencyKey: 'combined-reserve-idem', scope: scopeFor(reserveRequest), canonicalRequest: reserveRequest,
    estimate: { completeness: 'complete', knownSubtotal: '0.000003', currency: 'USD', rateCardRef: null, missingDimensions: [] },
    allowPartialAuthorization: false, attemptBinding,
  };
  const reference = (contract, id, revision = 1) => ({ contract, schema_version: '1.0.0', id, revision, content_hash: hash });
  const commandBase = {
    schemaVersion: '1.0.0', idempotencyKey: 'combined-command-idem', actorReference: 'fixture-worker',
    sourceAuthorityRef: reference('BudgetReservation', settleRequest.reservation_id, settleRequest.expected_revision),
    attemptBinding, reservationId: settleRequest.reservation_id, expectedRevision: settleRequest.expected_revision,
  };
  const settleCommand = {
    ...commandBase, requestId: 'combined-settle', scope: scopeFor(settleRequest), action: 'settle', canonicalCommand: settleRequest,
    settlement: { measure: 'cumulative', finality: 'final', sequence: 1, cumulativeAmount: settleRequest.consumed.amount, currency: settleRequest.currency,
      usageCompleteness: 'complete', sourceObservationRefs: [reference('UsageEvent', usageEvent.source_observation_id)], allowObservedOverrun: true },
  };
  const releaseCommand = {
    ...commandBase, requestId: 'combined-release', scope: scopeFor(releaseRequest), action: 'release', canonicalCommand: releaseRequest,
    reservationId: releaseRequest.reservation_id, expectedRevision: releaseRequest.expected_revision,
    release: { amount: '0.009000', currency: releaseRequest.currency, reason: 'fixture-fenced-release', proof: 'never_dispatched_fenced', evidenceRefs: [reference('DispatchFence', 'fence-1')] },
  };
  const reservationSnapshot = {
    schemaVersion: '1.0.0', requestId: 'combined-snapshot', asOf: '2026-10-10T12:00:00Z', reservation,
    state: 'held', heldAmount: reservation.held.amount, effectiveConsumedAmount: reservation.consumed.amount,
    releasedAmount: '0', latestCumulativeSettlement: '0', overrunAmount: '0', usageFinality: 'unknown', expectedRevision: reservation.revision, attemptBinding,
  };
  const filters = { environments: ['test'], billingModes: ['simulated'], currency: summary.currency };
  const summaryPage = {
    schemaVersion: '1.0.0', requestId: 'combined-page', snapshotId: 'snapshot-1', queryContentHash: hash,
    asOf: '2026-10-10T12:00:00Z', timezone: 'UTC',
    watermark: { watermarkId: 'watermark-1', capturedAt: '2026-10-10T12:00:00Z', sources: [{ source: 'fixture-ledger', revision: 'r1', observedThrough: '2026-10-10T12:00:00Z', contentHash: hash, completeness: 'complete' }] },
    filters, summaryContentHash: hash, summary, hasMore: false, nextCursor: null,
  };
  const exportRequest = {
    schemaVersion: '1.0.0', requestId: 'combined-export', idempotencyKey: 'combined-export-idem',
    scope: { ...scopeFor(summary), environment: 'test', billingMode: 'simulated' }, summarySnapshot: summaryPage, summaryContentHash: hash,
    destination: 'cfo.ai', format: 'json', requestedAt: '2026-10-10T12:01:00Z', evidenceMode: 'mocked', requestedBy: 'fixture-user',
  };
  const cases = [
    { validate: api.validateUsageObservationBoundary, request: usageObservation, nestedPath: ['usageEvent'] },
    { validate: api.validateEstimateRequestBoundary, request: estimateRequest, nestedPath: ['usageEvent'] },
    { validate: api.validateReservationRequestBoundary, request: reservationRequest, nestedPath: ['canonicalRequest'] },
    { validate: api.validateSettleReservationCommandBoundary, request: settleCommand, nestedPath: ['canonicalCommand'] },
    { validate: api.validateReleaseReservationCommandBoundary, request: releaseCommand, nestedPath: ['canonicalCommand'] },
    { validate: api.validateReservationCommandBoundary, request: settleCommand, nestedPath: ['canonicalCommand'] },
    { validate: api.validateReservationSnapshotBoundary, request: reservationSnapshot, nestedPath: ['reservation'] },
    { validate: api.validateFinancialSummaryPageBoundary, request: summaryPage, nestedPath: ['summary'] },
    { validate: api.validateExportRequestBoundary, request: exportRequest, nestedPath: ['summarySnapshot', 'summary'] },
  ];
  const nestedAt = (object, path) => path.slice(0, -1).reduce((current, key) => current[key], object)[path.at(-1)];
  const replaceNested = (object, path, nested) => {
    const copy = structuredClone(object);
    path.slice(0, -1).reduce((current, key) => current[key], copy)[path.at(-1)] = nested;
    return copy;
  };

  for (const item of cases) {
    const valid = item.validate(item.request);
    assert.equal(valid.ok, true, 'pinned canonical fixture must pass the combined public boundary');
    const nested = nestedAt(item.request, item.nestedPath);
    assert.equal(item.validate(replaceNested(item.request, item.nestedPath, {})).error.code, 'VALIDATION_ERROR', 'missing canonical fields reject');
    assert.equal(item.validate(replaceNested(item.request, item.nestedPath, { ...structuredClone(nested), unexpectedCanonicalCanary: true })).error.code, 'VALIDATION_ERROR', 'unknown canonical fields reject');
    assert.equal(item.validate(replaceNested(item.request, item.nestedPath, { ...structuredClone(nested), schema_version: '99.0.0' })).error.code, 'UNSUPPORTED_VERSION', 'unsupported canonical versions reject');
  }
  const malformedPage = { ...summaryPage, summary: { secret: 'not a FinancialSummary' } };
  assert.equal(Value.Check(api.FinancialSummaryPageSchema, malformedPage), true, 'raw TypeBox artifact is explicitly a partial wrapper');
  assert.equal(api.validateFinancialSummaryPageBoundary(malformedPage).error.code, 'VALIDATION_ERROR');
  const malformedExport = { ...exportRequest, summarySnapshot: malformedPage };
  assert.equal(Value.Check(api.ExportRequestSchema, malformedExport), true, 'raw export artifact is explicitly a partial wrapper');
  assert.equal(api.validateExportRequestBoundary(malformedExport).error.code, 'VALIDATION_ERROR');

  const markDispatched = {
    ...commandBase, requestId: 'combined-dispatch', scope: scopeFor(usageEvent), action: 'mark_dispatched',
    dispatchIntentRef: reference('DispatchIntent', 'dispatch-1'), workerLeaseId: 'lease-1', workerLeaseExpiresAt: '2026-10-10T12:05:00Z',
  };
  assert.equal(api.validateReservationCommandBoundary(markDispatched).ok, true, 'union validator dispatches mark action');
  assert.equal(api.validateReservationCommandBoundary({ ...settleCommand, canonicalCommand: {} }).error.code, 'VALIDATION_ERROR');
});

test('usage intake boundary keeps unknown valuation null and quarantines no invented attempt identities', async () => {
  const request = JSON.parse(await readFile(join(root, 'fixtures/metering/usage-observation.request.json'), 'utf8'));
  assert.equal(api.validateUsageObservationBoundary(request).ok, true);
  const unknown = structuredClone(request);
  unknown.usageEvent.completeness = 'incomplete';
  unknown.usageEvent.usage_units = null;
  unknown.usageEvent.missing_fields = ['usage', 'amount'];
  unknown.usageEvent.valuation = { basis: 'unknown', money: null, rate_card_ref: null };
  const unknownBoundary = api.validateUsageObservationBoundary(unknown);
  assert.equal(unknownBoundary.ok, true, unknownBoundary.ok ? '' : unknownBoundary.error.code);
  if (unknownBoundary.ok) {
    assert.equal(unknownBoundary.value.usageEvent.valuation.money, null);
    assert.equal(unknownBoundary.value.usageEvent.usage_units, null);
  }
  const missing = structuredClone(request);
  delete missing.usageEvent.provider_attempt_id;
  assert.equal(api.validateUsageObservationBoundary(missing).ok, false, 'canonical attempt IDs remain required by the pinned schema');
  const receipt = {
    schemaVersion: '1.0.0', requestId: 'usage-quarantine-receipt', asOf: '2026-10-11T12:00:00Z', status: 'quarantined',
    eventId: { status: 'unknown' }, sourceObservationId: { status: 'unknown' }, logicalOperationId: { status: 'unknown' },
    providerAttemptId: { status: 'unknown' }, billableAttemptId: { status: 'unknown' }, transportAttemptId: { status: 'unknown' },
    outboxStatus: 'dead_letter', completeness: 'unknown', valuation: 'unknown', durableCommit: true,
    quarantineCode: 'invalid_usage_event',
  };
  assert.equal(Value.Check(api.IngestionReceiptSchema, receipt), true);
  assert.equal(Value.Check(api.IngestionReceiptSchema, { ...receipt, eventId: { status: 'known', id: '' } }), false);
});

test('generated partial wrapper schemas name their complete public validator in both catalog and artifact', async () => {
  const index = JSON.parse(await readFile(join(root, 'docs/api/schema-index.json'), 'utf8'));
  for (const entry of index.schemas) {
    const bytes = await readFile(join(root, entry.path));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256, `generated schema digest ${entry.path}`);
  }
  const expected = new Map([
    ['UsageObservationSchema', 'validateUsageObservationBoundary'], ['EstimateRequestSchema', 'validateEstimateRequestBoundary'],
    ['ReservationRequestSchema', 'validateReservationRequestBoundary'], ['SettleReservationCommandSchema', 'validateSettleReservationCommandBoundary'],
    ['ReleaseReservationCommandSchema', 'validateReleaseReservationCommandBoundary'], ['ReservationCommandSchema', 'validateReservationCommandBoundary'],
    ['ReservationSnapshotSchema', 'validateReservationSnapshotBoundary'], ['FinancialSummaryPageSchema', 'validateFinancialSummaryPageBoundary'],
    ['ExportRequestSchema', 'validateExportRequestBoundary'],
  ]);
  for (const [name, validator] of expected) {
    const entry = index.schemas.find(schema => schema.name === name);
    assert.ok(entry, `schema catalog has ${name}`);
    assert.equal(entry.completeness, 'partial_wrapper_requires_combined_validation');
    assert.equal(entry.combined_validator, validator);
    assert.equal(typeof api[validator], 'function');
    const artifact = JSON.parse(await readFile(join(root, entry.path), 'utf8'));
    assert.equal(artifact['x-schema-completeness'], entry.completeness);
    assert.equal(artifact['x-combined-validator'], validator);
  }
});
