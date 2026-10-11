import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import * as api from '../../dist/index.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const scope = { tenantId: '123e4567-e89b-42d3-a456-426614174000', projectId: '123e4567-e89b-42d3-a456-426614174000', environment: 'test', billingMode: 'simulated', actorId: 'actor-1' };
const ports = {
  clock: { now: () => new Date('2026-10-10T12:00:00Z') },
  storage: { isAvailable: async () => true },
  providerSource: { isAvailable: async () => true },
  trustedContext: { resolve: async value => value },
};
const hash = `sha256:${'b'.repeat(64)}`;
const ref = (contract, id = 'ref-1') => ({ contract, schema_version: '1.0.0', id, revision: 1, content_hash: hash });
const loadFixture = async name => JSON.parse(await readFile(join(root, `node_modules/@jevelopers/shared-contracts/fixtures/${name}.json`), 'utf8')).valid;
const loadApiFixture = async name => JSON.parse(await readFile(join(root, `fixtures/api/${name}`), 'utf8'));

function assertError(result, code, operation) {
  assert.equal(result.ok, false, `${operation} must not report a fabricated successful domain result`);
  assert.equal(result.error.code, code, operation);
  assert.ok(!JSON.stringify(result.error).includes('PRIVATE_REQUEST_ID_CANARY'));
}

async function assertInvalidBoundaryMatrix(requests) {
  for (const { operation, request } of requests) {
    const unknownVersion = { ...structuredClone(request), schemaVersion: '99.0.0' };
    assertError(await api[operation](unknownVersion, ports), 'UNSUPPORTED_VERSION', `${operation}: unsupported major version`);

    const unknownField = { ...structuredClone(request), unexpectedBoundaryCanary: true };
    assertError(await api[operation](unknownField, ports), 'VALIDATION_ERROR', `${operation}: unknown field`);

    const missingRequired = structuredClone(request);
    delete missingRequired.requestId;
    assertError(await api[operation](missingRequired, ports), 'VALIDATION_ERROR', `${operation}: missing requestId`);
  }
}

test('public domain boundaries return explicit unavailable results and never fabricate successful accounting', async () => {
  const [usageEvent, reserveRequest, settleRequest, releaseRequest, financialSummary] = await Promise.all([
    loadFixture('UsageEvent'), loadFixture('ReserveRequest'), loadFixture('SettleRequest'), loadFixture('ReleaseRequest'), loadFixture('FinancialSummary'),
  ]);
  const base = { schemaVersion: '1.0.0', requestId: 'smoke-1', idempotencyKey: 'smoke-idem', scope };
  const validRequests = [];
  const checkBoundary = async (operation, request, code) => {
    validRequests.push({ operation, request });
    assertError(await api[operation](request, ports), code, operation);
  };
  const usage = {
    ...base, usageEvent, evidenceMode: 'mocked', verificationStatus: 'verified', evidenceProvenanceRef: 'fixture:usage-event',
  };
  await checkBoundary('ingestUsage', usage, 'SOURCE_UNAVAILABLE');
  const estimate = {
    ...base, usageEvent,
    selection: { policy: 'event_time', effectiveAt: '2026-10-10T12:00:00Z', requestedCurrency: 'USD', rateCardRef: null },
  };
  await checkBoundary('estimate', estimate, 'PRICING_UNKNOWN');

  const attemptBinding = {
    logicalOperationId: usageEvent.logical_operation_id, transportAttemptId: usageEvent.transport_attempt_id,
    providerRequestId: usageEvent.provider_request_id, providerAttemptId: usageEvent.provider_attempt_id,
    billableAttemptId: usageEvent.billable_attempt_id,
  };
  const reservation = {
    ...base, canonicalRequest: reserveRequest,
    estimate: { completeness: 'complete', knownSubtotal: '0.000003', currency: 'USD', rateCardRef: ref('RateCard'), missingDimensions: [] },
    allowPartialAuthorization: false, attemptBinding,
  };
  await checkBoundary('authorize', reservation, 'BUDGET_UNAVAILABLE');

  const commandBase = {
    ...base, reservationId: releaseRequest.reservation_id, expectedRevision: releaseRequest.expected_revision,
    actorReference: 'agent-1', sourceAuthorityRef: ref('BudgetReservation', releaseRequest.reservation_id), attemptBinding,
  };
  const dispatch = {
    ...commandBase, action: 'mark_dispatched', dispatchIntentRef: ref('DispatchIntent'), workerLeaseId: 'lease-1',
    workerLeaseExpiresAt: '2026-10-10T12:05:00Z',
  };
  await checkBoundary('markDispatched', dispatch, 'BUDGET_UNAVAILABLE');
  const settle = {
    ...commandBase, reservationId: settleRequest.reservation_id, expectedRevision: settleRequest.expected_revision,
    action: 'settle', canonicalCommand: settleRequest,
    settlement: { measure: 'cumulative', finality: 'partial', sequence: 1, cumulativeAmount: settleRequest.consumed.amount, currency: settleRequest.currency,
      usageCompleteness: 'incomplete', sourceObservationRefs: [ref('UsageEvent', usageEvent.source_observation_id)], allowObservedOverrun: true },
  };
  await checkBoundary('settle', settle, 'BUDGET_UNAVAILABLE');
  const release = {
    ...commandBase, action: 'release', canonicalCommand: releaseRequest,
    release: { amount: '0.009000', currency: 'USD', reason: 'fenced-unused-allowance', proof: 'never_dispatched_fenced', evidenceRefs: [ref('DispatchFence')] },
  };
  await checkBoundary('release', release, 'BUDGET_UNAVAILABLE');

  for (const [operation, command] of [
    ['markDispatched', settle], ['markDispatched', release],
    ['settle', dispatch], ['settle', release],
    ['release', dispatch], ['release', settle],
  ]) {
    assertError(await api[operation](command, ports), 'VALIDATION_ERROR', `${operation} rejects ${command.action} action`);
  }
  assertError(await api.settle({ ...settle, canonicalCommand: {} }, ports), 'VALIDATION_ERROR', 'settle validates its pinned nested command');
  assertError(await api.release({ ...release, canonicalCommand: {} }, ports), 'VALIDATION_ERROR', 'release validates its pinned nested command');

  const changeBudget = {
    ...base, newLimit: '100', currency: 'USD', expectedPolicyRevision: 4, expectedLedgerRevision: 8,
    actorReference: 'finance-controller', reasonReference: 'monthly-budget-review',
  };
  await checkBoundary('changeBudget', changeBudget, 'BUDGET_UNAVAILABLE');
  const adjustment = {
    ...base, adjustmentId: 'adjustment-1', amount: '1.00', currency: 'USD', direction: 'increase_expense',
    expectedLedgerRevision: 8, actorReference: 'finance-controller', reasonReference: 'invoice-correction',
    originalPostingRef: ref('FinancialEvent', 'posting-1'), sourceReference: 'invoice-1', sourceContentHash: hash, evidenceMode: 'mocked',
  };
  await checkBoundary('recordExpenseAdjustment', adjustment, 'SOURCE_UNAVAILABLE');

  const financialEvent = await loadApiFixture('financial-event-unknown.request.json');
  await checkBoundary('ingestFinancial', financialEvent, 'SOURCE_UNAVAILABLE');
  assertError(await api.ingestFinancial({ ...financialEvent, amount: '0' }, ports), 'VALIDATION_ERROR', 'unknown valuation cannot be coerced to zero');
  assertError(await api.ingestFinancial({ ...financialEvent, valuation: 'estimated' }, ports), 'VALIDATION_ERROR', 'estimated valuation requires an amount');

  const query = await loadApiFixture('summary-query.request.json');
  await checkBoundary('querySummary', query, 'SOURCE_UNAVAILABLE');
  const reconciliation = {
    ...base, sourceSnapshots: [{ name: 'fixture-source', revision: 'r1', contentHash: hash, evidenceMode: 'mocked', verificationStatus: 'verified' }],
    windowStart: '2026-10-01T00:00:00Z', windowEnd: '2026-10-02T00:00:00Z', pageSize: 50, requestedBy: 'finance-user',
  };
  await checkBoundary('startReconciliation', reconciliation, 'RECONCILIATION_PENDING');
  await checkBoundary('getReconciliation', reconciliation, 'RECONCILIATION_PENDING');

  const snapshot = {
    schemaVersion: '1.0.0', requestId: 'summary-request', snapshotId: 'snapshot-1', queryContentHash: hash,
    asOf: '2026-10-10T12:00:00Z', timezone: 'UTC',
    watermark: { watermarkId: 'wm-1', capturedAt: '2026-10-10T12:00:00Z', sources: [{ source: 'provider-ledger', revision: 'r1', observedThrough: '2026-10-10T12:00:00Z', contentHash: hash, completeness: 'partial' }] },
    filters: { environments: ['test'], billingModes: ['simulated'], currency: 'USD' }, summaryContentHash: hash, summary: financialSummary,
    hasMore: false, nextCursor: null,
  };
  const exportRequest = {
    ...base, summarySnapshot: snapshot, summaryContentHash: hash, destination: 'cfo.ai', format: 'json',
    requestedAt: '2026-10-10T12:00:00Z', evidenceMode: 'mocked', requestedBy: 'finance-user',
  };
  await checkBoundary('exportSummary', exportRequest, 'SOURCE_UNAVAILABLE');
  const scopeViolations = [
    ['summary includes an additional production environment', value => { value.summarySnapshot.summary.included_environments = ['test', 'production']; }],
    ['summary substitutes production for the authorized environment', value => { value.summarySnapshot.summary.included_environments = ['production']; }],
    ['summary includes an additional live billing mode', value => { value.summarySnapshot.summary.included_billing_modes = ['simulated', 'live']; }],
    ['summary substitutes live for the authorized billing mode', value => { value.summarySnapshot.summary.included_billing_modes = ['live']; }],
    ['page filters add production', value => { value.summarySnapshot.filters.environments = ['test', 'production']; }],
    ['page filters add live', value => { value.summarySnapshot.filters.billingModes = ['simulated', 'live']; }],
    ['page environment selection differs from export scope', value => { value.summarySnapshot.filters.environments = ['production']; }],
    ['page billing mode selection differs from export scope', value => { value.summarySnapshot.filters.billingModes = ['live']; }],
  ];
  for (const [label, mutate] of scopeViolations) {
    const invalidScope = structuredClone(exportRequest);
    mutate(invalidScope);
    assertError(await api.exportSummary(invalidScope, ports), 'FORBIDDEN_SCOPE', label);
  }

  assert.deepEqual(new Set(validRequests.map(({ operation }) => operation)), new Set([
    'ingestUsage', 'estimate', 'authorize', 'markDispatched', 'settle', 'release', 'changeBudget',
    'recordExpenseAdjustment', 'ingestFinancial', 'querySummary', 'startReconciliation', 'getReconciliation', 'exportSummary',
  ]));
  await assertInvalidBoundaryMatrix(validRequests);
});

test('negative scope, version, pagination, and malformed cases fail before unavailable leaf behavior', async () => {
  const [usageEvent] = await Promise.all([loadFixture('UsageEvent')]);
  const base = { schemaVersion: '1.0.0', requestId: 'PRIVATE_REQUEST_ID_CANARY', idempotencyKey: 'idem', scope };
  const forged = { ...usageEvent, tenant_id: '123e4567-e89b-42d3-a456-000000000099' };
  const badUsage = { ...base, usageEvent: forged, evidenceMode: 'mocked', verificationStatus: 'unknown', evidenceProvenanceRef: 'fixture:unknown' };
  assertError(await api.ingestUsage(badUsage, ports), 'FORBIDDEN_SCOPE', 'forged usage scope');

  const unknownVersion = { ...base, schemaVersion: '1.1.0', usageEvent, evidenceMode: 'mocked', verificationStatus: 'verified', evidenceProvenanceRef: 'fixture:usage' };
  assertError(await api.ingestUsage(unknownVersion, ports), 'UNSUPPORTED_VERSION', 'usage unsupported version');

  const invalidQuery = {
    ...base, period: { start: '2026-10-02T00:00:00Z', end: '2026-10-01T00:00:00Z' }, timezone: 'UTC', pageSize: 20,
    filters: { environments: ['test'], billingModes: ['simulated'] },
  };
  assertError(await api.querySummary(invalidQuery, ports), 'VALIDATION_ERROR', 'reversed period');
  const cursorWithoutSnapshot = {
    ...base, period: { start: '2026-10-01T00:00:00Z', end: '2026-10-02T00:00:00Z' }, timezone: 'UTC', cursor: 'opaque', pageSize: 20,
    filters: { environments: ['test'], billingModes: ['simulated'] },
  };
  assertError(await api.querySummary(cursorWithoutSnapshot, ports), 'VALIDATION_ERROR', 'cursor without snapshot');
  const crossMode = { ...invalidQuery, period: { start: '2026-10-01T00:00:00Z', end: '2026-10-02T00:00:00Z' }, filters: { environments: ['test'], billingModes: ['live'] } };
  assertError(await api.querySummary(crossMode, ports), 'FORBIDDEN_SCOPE', 'cross billing mode filter');

  const wrongTrust = { ...ports, trustedContext: { resolve: async () => ({ ...scope, actorId: 'different-actor' }) } };
  const validQuery = { ...invalidQuery, period: { start: '2026-10-01T00:00:00Z', end: '2026-10-02T00:00:00Z' }, filters: { environments: ['test'], billingModes: ['simulated'] } };
  assertError(await api.querySummary(validQuery, wrongTrust), 'FORBIDDEN_SCOPE', 'unauthorized actor');
});
