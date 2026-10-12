import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  authorizeReservation, changeBudgetPolicy, readCapacity, markReservationDispatched,
} from '../../dist/index.js';
import {
  loadReserveFixture, reservationPool, makePorts, makeScope, policyChange, reservationRequest,
} from './reservation-harness.mjs';

const fixturePromise = loadReserveFixture();

async function countEvents(pool, scope) {
  const result = await pool.query(
    `SELECT count(*)::int AS total FROM cost_intelligence.budget_reservation_events
     WHERE tenant_id = $1 AND project_id = $2 AND environment = $3 AND billing_mode = $4`,
    [scope.tenantId, scope.projectId, scope.environment, scope.billingMode],
  );
  return result.rows[0].total;
}

async function setLimit(pool, scope, limitAmount, currency = 'USD') {
  const receipt = await changeBudgetPolicy(policyChange(scope, { limitAmount, currency }), makePorts(pool, scope));
  assert.equal(receipt.ok, true, receipt.ok ? '' : `${receipt.error.code}: ${receipt.error.safe_message}`);
  assert.equal(receipt.value.status, 'applied');
  assert.equal(Number(receipt.value.effectiveLimit), Number(limitAmount), 'the limit round-trips as a canonical exact decimal');
  return receipt.value;
}

test('CI-05A.1/.2/.3 authorizes within capacity, denies by default, and opts into partial', async () => {
  assert.ok(process.env.CI_TEST_DB_RUNTIME_HOST, 'authorization suite requires the restricted disposable PostgreSQL role');
  const reserve = await fixturePromise;
  const pool = reservationPool(8);
  try {
    // Authorized within a 1.00 limit.
    const scopeA = makeScope('authorized');
    await setLimit(pool, scopeA, '1.00');
    const authorized = await authorizeReservation(reservationRequest(scopeA, reserve, { amount: '0.75' }), makePorts(pool, scopeA));
    assert.equal(authorized.ok, true, authorized.ok ? '' : authorized.error.code);
    assert.equal(authorized.value.status, 'authorized');
    assert.equal(authorized.value.heldAmount, '0.75');
    assert.equal(authorized.value.availableAmount, '0.25');
    assert.equal(authorized.value.currency, 'USD');
    assert.equal(authorized.value.expiryEligibility, 'eligible_if_never_dispatched');
    assert.ok(authorized.value.reservationId.length > 0);

    // Default deny: a second full 0.75 estimate cannot fit the 0.25 remainder.
    const denied = await authorizeReservation(reservationRequest(scopeA, reserve, { amount: '0.75' }), makePorts(pool, scopeA));
    assert.equal(denied.ok, true, denied.ok ? '' : denied.error.code);
    assert.equal(denied.value.status, 'denied');
    assert.equal(denied.value.heldAmount, '0');
    assert.equal(await countEvents(pool, scopeA), 1, 'a denial dispatches no work and creates no hold');

    // Explicit partial opt-in reserves only the allowed cap and requires acknowledgement.
    const partial = await authorizeReservation(
      reservationRequest(scopeA, reserve, { amount: '0.75', allowPartialAuthorization: true }), makePorts(pool, scopeA));
    assert.equal(partial.ok, true, partial.ok ? '' : partial.error.code);
    assert.equal(partial.value.status, 'partial');
    assert.equal(partial.value.heldAmount, '0.25');
    assert.equal(partial.value.partialAuthorization.allowedAmount, '0.25');
    assert.equal(partial.value.partialAuthorization.callerAcknowledgementRequired, true);
    assert.equal(partial.value.partialAuthorization.replanBeforeDispatch, true);
  } finally {
    await pool.end();
  }
});

test('CI-05A.3 unknown or unbounded pricing cannot auto-authorize without an explicit maximum policy', async () => {
  const reserve = await fixturePromise;
  const pool = reservationPool(6);
  try {
    const scope = makeScope('unknown');
    await setLimit(pool, scope, '10.00');
    const unknownEstimate = { completeness: 'unknown', knownSubtotal: '0', currency: 'USD', rateCardRef: null, missingDimensions: ['provider'] };
    const unknown = await authorizeReservation(reservationRequest(scope, reserve, { amount: '0.50', estimate: unknownEstimate }), makePorts(pool, scope));
    assert.equal(unknown.ok, true, unknown.ok ? '' : unknown.error.code);
    assert.equal(unknown.value.status, 'denied', 'unknown exposure cannot auto-authorize');
    assert.equal(await countEvents(pool, scope), 0, 'no conservative hold is created for unbounded pricing');

    // An authorized explicit maximum policy makes it conservative-but-authorizable.
    const boundedEstimate = {
      completeness: 'incomplete', knownSubtotal: '0.20', currency: 'USD', rateCardRef: null, missingDimensions: ['provider'],
      boundedConservativeMaximum: '2.00',
      maximumPolicyRef: { contract: 'cost-intelligence.max-policy', schema_version: '1.0.0', id: `max-${randomUUID()}`, revision: 1, content_hash: `sha256:${'a'.repeat(64)}` },
    };
    const bounded = await authorizeReservation(reservationRequest(scope, reserve, { amount: '0.20', estimate: boundedEstimate }), makePorts(pool, scope));
    assert.equal(bounded.ok, true, bounded.ok ? '' : bounded.error.code);
    assert.equal(bounded.value.status, 'authorized');
    assert.equal(bounded.value.heldAmount, '2', 'the conservative maximum is held, not the known subtotal');
  } finally {
    await pool.end();
  }
});

test('CI-05A.2 forged scope, stale currency, and cross-currency pooling are rejected', async () => {
  const reserve = await fixturePromise;
  const pool = reservationPool(6);
  try {
    const scope = makeScope('forged');
    await setLimit(pool, scope, '5.00', 'USD');

    // Authority bound to a different scope denies the request before any hold.
    const foreignScope = makeScope('foreign');
    const forgedAuthority = await authorizeReservation(reservationRequest(scope, reserve, { amount: '0.10' }), makePorts(pool, foreignScope));
    assert.equal(forgedAuthority.ok, false);
    if (!forgedAuthority.ok) assert.equal(forgedAuthority.error.code, 'FORBIDDEN_SCOPE');

    // The wrapper scope must match the pinned canonical request scope.
    const mismatched = reservationRequest(scope, reserve, { amount: '0.10' });
    // A valid-but-foreign canonical tenant: passes contract validation, then the
    // boundary rejects the scope mismatch rather than the shape.
    mismatched.canonicalRequest = { ...mismatched.canonicalRequest, tenant_id: randomUUID() };
    const forgedWrapper = await authorizeReservation(mismatched, makePorts(pool, scope));
    assert.equal(forgedWrapper.ok, false);
    if (!forgedWrapper.ok) assert.equal(forgedWrapper.error.code, 'FORBIDDEN_SCOPE');

    // Estimate currency must match the reservation currency.
    const staleCurrency = reservationRequest(scope, reserve, { amount: '0.10' });
    staleCurrency.estimate = { ...staleCurrency.estimate, currency: 'EUR' };
    const staleResult = await authorizeReservation(staleCurrency, makePorts(pool, scope));
    assert.equal(staleResult.ok, false);
    if (!staleResult.ok) assert.equal(staleResult.error.code, 'VALIDATION_ERROR');

    // A EUR request has no EUR policy partition: no cross-currency pooling with the USD limit.
    const crossCurrency = await authorizeReservation(reservationRequest(scope, reserve, { amount: '0.10', currency: 'EUR' }), makePorts(pool, scope));
    assert.equal(crossCurrency.ok, true, crossCurrency.ok ? '' : crossCurrency.error.code);
    assert.equal(crossCurrency.value.status, 'denied', 'the USD limit never backs a EUR reservation');
    assert.equal(await countEvents(pool, scope), 0);
  } finally {
    await pool.end();
  }
});

test('CI-05A.1 advisory capacity read never authorizes or creates a reservation', async () => {
  const reserve = await fixturePromise;
  const pool = reservationPool(6);
  try {
    const scope = makeScope('advisory');
    await setLimit(pool, scope, '3.00');
    await authorizeReservation(reservationRequest(scope, reserve, { amount: '1.00' }), makePorts(pool, scope));
    const before = await countEvents(pool, scope);
    const capacity = await readCapacity(scope, 'USD', `cap-${randomUUID()}`, makePorts(pool, scope));
    assert.equal(capacity.ok, true, capacity.ok ? '' : capacity.error.code);
    assert.equal(capacity.value.advisoryOnly, true);
    assert.equal(capacity.value.usedCapacity, '1');
    assert.equal(capacity.value.availableCapacity, '2');
    assert.equal(capacity.value.outstandingHolds, '1');
    assert.equal(await countEvents(pool, scope), before, 'an advisory read adds no reservation events');
  } finally {
    await pool.end();
  }
});

test('CI-05A.1 identical idempotent authorization reuses the single hold', async () => {
  const reserve = await fixturePromise;
  const pool = reservationPool(6);
  try {
    const scope = makeScope('idempotent');
    await setLimit(pool, scope, '2.00');
    const request = reservationRequest(scope, reserve, { amount: '0.75' });
    const first = await authorizeReservation(request, makePorts(pool, scope));
    const second = await authorizeReservation(request, makePorts(pool, scope));
    assert.equal(first.ok && second.ok, true);
    assert.equal(first.value.status, 'authorized');
    assert.equal(second.value.status, 'authorized');
    assert.equal(second.value.reservationId, first.value.reservationId, 'a retry returns the same reservation');
    assert.equal(await countEvents(pool, scope), 1, 'a retry never creates a second hold');
  } finally {
    await pool.end();
  }
});

test('CI-05A.4 an unavailable or throwing authority rejects new work with retry guidance', async () => {
  const reserve = await fixturePromise;
  const pool = reservationPool(6);
  try {
    const scope = makeScope('unavailable');
    await setLimit(pool, scope, '5.00');

    // A throwing authority rejects, retryably, before any persistence.
    const throwing = await authorizeReservation(reservationRequest(scope, reserve, { amount: '0.10' }), makePorts(pool, scope, { authorityThrows: true }));
    assert.equal(throwing.ok, false);
    if (!throwing.ok) {
      assert.equal(throwing.error.code, 'BUDGET_UNAVAILABLE');
      assert.equal(throwing.error.retryable, true);
    }

    // An unreachable database returns an explicit unavailable decision with retry guidance.
    const dbDown = await authorizeReservation(reservationRequest(scope, reserve, { amount: '0.10' }), makePorts(pool, scope, { databaseError: true }));
    assert.equal(dbDown.ok, true, dbDown.ok ? '' : dbDown.error.code);
    assert.equal(dbDown.value.status, 'unavailable');
    assert.ok(Number.isInteger(dbDown.value.retryAfterMs) && dbDown.value.retryAfterMs > 0, 'unavailable returns retry guidance');

    assert.equal(await countEvents(pool, scope), 0, 'no reservation or dispatched work survives an unavailable authority');

    // A reservation that was never authorized cannot be dispatched.
    const orphanDispatch = await markReservationDispatched({
      schemaVersion: '1.0.0', requestId: `req-${randomUUID()}`, idempotencyKey: `cmd-${randomUUID()}`, scope,
      reservationId: `missing-${randomUUID()}`, expectedRevision: 1, actorReference: 'ci05a-worker',
      sourceAuthorityRef: { contract: 'cost-intelligence.authority', schema_version: '1.0.0', id: randomUUID(), revision: 1, content_hash: `sha256:${'b'.repeat(64)}` },
      attemptBinding: { logicalOperationId: `logical-${randomUUID()}`, transportAttemptId: 't', providerRequestId: null, providerAttemptId: 'p', billableAttemptId: `billable-${randomUUID()}` },
      action: 'mark_dispatched', workerLeaseId: 'l', workerLeaseExpiresAt: '2026-10-12T05:00:00.000Z',
      dispatchIntentRef: { contract: 'cost-intelligence.authority', schema_version: '1.0.0', id: randomUUID(), revision: 1, content_hash: `sha256:${'c'.repeat(64)}` },
    }, makePorts(pool, scope));
    assert.equal(orphanDispatch.ok, false);
    if (!orphanDispatch.ok) assert.equal(orphanDispatch.error.code, 'VALIDATION_ERROR');
  } finally {
    await pool.end();
  }
});
