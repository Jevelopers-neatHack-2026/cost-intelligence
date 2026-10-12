// CI-05B recovery acceptance: crash-schedule recovery, worker-lease expiry with
// unknown outcome, bounded rerunnable recovery scans, no-dispatch fencing, the
// typed billable-attempt conflict (consumer gap 3), and the scoped current-state
// read (consumer gap 1). Runs against a real disposable PostgreSQL; mocks never
// prove the atomic financial safety these scenarios require.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  authorizeReservation, markReservationDispatched, settleReservation, releaseReservation,
  expireReservation, readReservationState, runRecoveryScan, listReconciliationExceptions, readCapacity,
} from '../../dist/index.js';
import {
  loadReserveFixture, setBudgetLimit, reservationPool, makePorts, makeScope, reservationRequest,
  markDispatchedCommand, settleCommand, expireCommand, recoveryScanRequest, clockAt,
} from '../budgets/reservation-harness.mjs';

const fixturePromise = loadReserveFixture();
const T0 = '2026-10-12T04:00:00.000Z';
const LEASE_EXP = '2026-10-12T04:30:00.000Z';
const T_AFTER_LEASE = '2026-10-12T05:00:00.000Z';

function ports(pool, scope, extra = {}) {
  const { financialExpiryMs, ...rest } = extra;
  const base = makePorts(pool, scope, rest);
  return financialExpiryMs === undefined ? base : { ...base, financialExpiryMs };
}

function requireDb() {
  assert.ok(process.env.CI_TEST_DB_RUNTIME_HOST, 'recovery suite requires the restricted disposable PostgreSQL role');
}

test('CI-05B.1/gap1 the scoped current-state read projects the whole log, not the first event', async () => {
  requireDb();
  const reserve = await fixturePromise;
  const pool = reservationPool(8);
  try {
    const scope = makeScope('recovery-read');
    await setBudgetLimit(pool, scope, '10.00');
    const authorized = await authorizeReservation(reservationRequest(scope, reserve, { amount: '2.00' }), ports(pool, scope));
    const id = authorized.value.reservationId;
    const own = authorized.value.attemptBinding;

    let view = await readReservationState(scope, id, 'read-held', ports(pool, scope));
    assert.equal(view.ok, true, view.ok ? '' : view.error.code);
    assert.equal(view.value.state, 'held');
    assert.equal(view.value.outstandingHold, '2');

    await markReservationDispatched(markDispatchedCommand(scope, id, 1, { attemptBinding: own }), ports(pool, scope));
    await settleReservation(settleCommand(scope, id, 2, { cumulativeAmount: '1.200000', finality: 'final', sequence: 1, attemptBinding: own }), ports(pool, scope));
    view = await readReservationState(scope, id, 'read-settled', ports(pool, scope));
    assert.equal(view.value.state, 'settled', 'a settled reservation reads settled, never the original authorized status');
    assert.equal(view.value.consumedAmount, '1.2');
    assert.equal(view.value.everDispatched, true);

    const absent = await readReservationState(scope, 'nonexistent-reservation', 'read-absent', ports(pool, scope));
    assert.equal(absent.value.state, 'absent');
    assert.equal(absent.value.exists, false);
  } finally {
    await pool.end();
  }
});

test('CI-05B.3 kill before dispatch: the held hold stays held and is freed only by a fenced expiry', async () => {
  requireDb();
  const reserve = await fixturePromise;
  const pool = reservationPool(8);
  try {
    const scope = makeScope('recovery-predispatch');
    await setBudgetLimit(pool, scope, '5.00');
    const authorized = await authorizeReservation(reservationRequest(scope, reserve, { amount: '1.00' }), ports(pool, scope));
    const id = authorized.value.reservationId;
    const own = authorized.value.attemptBinding;

    // A recovery scan never releases a held, never-dispatched hold with no matured expiry.
    const scan = await runRecoveryScan(recoveryScanRequest(scope), ports(pool, scope));
    assert.equal(scan.ok, true, scan.ok ? '' : scan.error.code);
    assert.equal(scan.value.opened, 0, 'a plain held hold is not aged into the queue');
    let capacity = await readCapacity(scope, 'USD', 'pre-cap', ports(pool, scope));
    assert.equal(capacity.value.availableCapacity, '4', 'the hold still stands after recovery');

    // Operator revocation fences the whole hold and frees the capacity.
    const expired = await expireReservation(expireCommand(scope, id, 1, { reason: 'operator_revocation', attemptBinding: own }), ports(pool, scope));
    assert.equal(expired.ok, true, expired.ok ? '' : expired.error.code);
    assert.equal(expired.value.state, 'expired');
    capacity = await readCapacity(scope, 'USD', 'post-cap', ports(pool, scope));
    assert.equal(capacity.value.availableCapacity, '5', 'the fenced expiry frees the whole hold with no spend');
    assert.equal(capacity.value.effectiveConsumedSpend, '0');
  } finally {
    await pool.end();
  }
});

test('CI-05B.3/.4 lease expiry with unknown outcome keeps the hold and ages it into the queue; a late settlement still lands', async () => {
  requireDb();
  const reserve = await fixturePromise;
  const pool = reservationPool(8);
  try {
    const scope = makeScope('recovery-unknown');
    await setBudgetLimit(pool, scope, '3.00');
    const authorized = await authorizeReservation(reservationRequest(scope, reserve, { amount: '1.00' }), ports(pool, scope, { clock: clockAt(T0) }));
    const id = authorized.value.reservationId;
    const own = authorized.value.attemptBinding;
    const dispatch = markDispatchedCommand(scope, id, 1, { attemptBinding: own });
    dispatch.workerLeaseExpiresAt = LEASE_EXP;
    dispatch.workerLeaseId = 'ci05b-lease-unknown';
    assert.equal((await markReservationDispatched(dispatch, ports(pool, scope, { clock: clockAt(T0) }))).ok, true);

    // After the worker lease lapses, the outcome is unknown but the hold REMAINS.
    const view = await readReservationState(scope, id, 'unknown-view', ports(pool, scope, { clock: clockAt(T_AFTER_LEASE) }));
    assert.equal(view.value.state, 'outcome_unknown', 'a lapsed lease with no outcome reads outcome_unknown');
    assert.equal(view.value.workerLeaseExpired, true);
    assert.equal(view.value.outstandingHold, '1', 'the lease lapse never releases the hold');

    const capacityBefore = await readCapacity(scope, 'USD', 'unknown-cap', ports(pool, scope, { clock: clockAt(T_AFTER_LEASE) }));
    assert.equal(capacityBefore.value.availableCapacity, '2', 'the unknown hold still consumes capacity');

    // Recovery ages it into the exception queue but NEVER releases it.
    const scan = await runRecoveryScan(recoveryScanRequest(scope, { agingThresholdMs: 0 }), ports(pool, scope, { clock: clockAt(T_AFTER_LEASE) }));
    assert.equal(scan.ok, true, scan.ok ? '' : scan.error.code);
    assert.equal(scan.value.opened, 1);
    assert.equal(scan.value.entries[0].category, 'outcome_unknown_in_flight');
    const queue = await listReconciliationExceptions(scope, 'queue-read', ports(pool, scope, { clock: clockAt(T_AFTER_LEASE) }));
    assert.equal(queue.value.exceptions.length, 1);
    assert.equal(queue.value.exceptions[0].reservationId, id);
    const stillHeld = await readCapacity(scope, 'USD', 'unknown-cap-2', ports(pool, scope, { clock: clockAt(T_AFTER_LEASE) }));
    assert.equal(stillHeld.value.availableCapacity, '2', 'recovery does not free an unknown hold');

    // A rerun of the bounded scan is a no-op (idempotent/rerunnable).
    const rerun = await runRecoveryScan(recoveryScanRequest(scope, { agingThresholdMs: 0 }), ports(pool, scope, { clock: clockAt(T_AFTER_LEASE) }));
    assert.equal(rerun.value.opened, 0);
    assert.equal(rerun.value.alreadyOpen, 1);

    // When the provider outcome finally arrives, settlement still lands without a leak or double charge.
    const settled = await settleReservation(settleCommand(scope, id, 2, { cumulativeAmount: '0.600000', finality: 'final', sequence: 1, attemptBinding: own }), ports(pool, scope, { clock: clockAt(T_AFTER_LEASE) }));
    assert.equal(settled.ok, true, settled.ok ? '' : settled.error.code);
    assert.equal(settled.value.consumedAmount, '0.6');
  } finally {
    await pool.end();
  }
});

test('CI-05B.3 an in-flight or unknown hold is never expired; a late worker cannot be fenced out by expiry', async () => {
  requireDb();
  const reserve = await fixturePromise;
  const pool = reservationPool(8);
  try {
    const scope = makeScope('recovery-fence');
    await setBudgetLimit(pool, scope, '2.00');
    const authorized = await authorizeReservation(reservationRequest(scope, reserve, { amount: '1.00' }), ports(pool, scope));
    const id = authorized.value.reservationId;
    const own = authorized.value.attemptBinding;
    assert.equal((await markReservationDispatched(markDispatchedCommand(scope, id, 1, { attemptBinding: own }), ports(pool, scope))).ok, true);

    const refused = await expireReservation(expireCommand(scope, id, 2, { reason: 'operator_revocation', attemptBinding: own }), ports(pool, scope));
    assert.equal(refused.ok, false);
    assert.equal(refused.error.code, 'BUDGET_UNAVAILABLE');
    assert.match(refused.error.safe_message, /hold is preserved/);
    const capacity = await readCapacity(scope, 'USD', 'fence-cap', ports(pool, scope));
    assert.equal(capacity.value.availableCapacity, '1', 'the dispatched hold is never freed by expiry');
  } finally {
    await pool.end();
  }
});

test('CI-05B.3/gap2 financial expiry is separate from the lease: it releases a never-dispatched hold only after it matures', async () => {
  requireDb();
  const reserve = await fixturePromise;
  const pool = reservationPool(8);
  try {
    const scope = makeScope('recovery-finexp');
    await setBudgetLimit(pool, scope, '2.00');
    // Financial expiry = T0 + 60s. The hold is stamped with expires_at at authorization.
    const authorized = await authorizeReservation(reservationRequest(scope, reserve, { amount: '1.00' }), ports(pool, scope, { clock: clockAt(T0), financialExpiryMs: 60_000 }));
    const id = authorized.value.reservationId;
    const own = authorized.value.attemptBinding;

    // Before maturity the hold is preserved.
    const early = await expireReservation(expireCommand(scope, id, 1, { reason: 'financial_expiry', attemptBinding: own }), ports(pool, scope, { clock: clockAt('2026-10-12T04:00:30.000Z') }));
    assert.equal(early.ok, false);
    assert.equal(early.error.code, 'BUDGET_UNAVAILABLE');
    assert.match(early.error.safe_message, /has not matured/);

    const view = await readReservationState(scope, id, 'finexp-view', ports(pool, scope, { clock: clockAt('2026-10-12T04:02:00.000Z') }));
    assert.equal(view.value.financialExpiryMatured, true);
    assert.equal(view.value.workerLeaseExpired, false, 'no worker lease was ever bound; financial expiry is independent');

    // After maturity the fenced expiry releases the whole never-dispatched hold.
    const matured = await expireReservation(expireCommand(scope, id, 1, { reason: 'financial_expiry', attemptBinding: own }), ports(pool, scope, { clock: clockAt('2026-10-12T04:02:00.000Z') }));
    assert.equal(matured.ok, true, matured.ok ? '' : matured.error.code);
    assert.equal(matured.value.state, 'expired');
    const capacity = await readCapacity(scope, 'USD', 'finexp-cap', ports(pool, scope, { clock: clockAt('2026-10-12T04:02:00.000Z') }));
    assert.equal(capacity.value.availableCapacity, '2');
  } finally {
    await pool.end();
  }
});

test('CI-05B.1 between commit and ack: a retried settlement replays without double-charging', async () => {
  requireDb();
  const reserve = await fixturePromise;
  const pool = reservationPool(8);
  try {
    const scope = makeScope('recovery-commitack');
    await setBudgetLimit(pool, scope, '2.00');
    const authorized = await authorizeReservation(reservationRequest(scope, reserve, { amount: '1.00' }), ports(pool, scope));
    const id = authorized.value.reservationId;
    const own = authorized.value.attemptBinding;
    assert.equal((await markReservationDispatched(markDispatchedCommand(scope, id, 1, { attemptBinding: own }), ports(pool, scope))).ok, true);
    const settle = settleCommand(scope, id, 2, { cumulativeAmount: '0.700000', finality: 'final', sequence: 1, attemptBinding: own });
    const first = await settleReservation(settle, ports(pool, scope));
    assert.equal(first.ok, true, first.ok ? '' : first.error.code);
    assert.equal(first.value.status, 'applied');
    const retry = await settleReservation(settle, ports(pool, scope));
    assert.equal(retry.value.status, 'replay', 'the ack-lost retry replays the single settlement');
    assert.equal(retry.value.consumedAmount, '0.7', 'no double charge');
    const capacity = await readCapacity(scope, 'USD', 'commitack-cap', ports(pool, scope));
    assert.equal(capacity.value.effectiveConsumedSpend, '0.7');
  } finally {
    await pool.end();
  }
});

test('CI-05B/gap3 a duplicate first-event billable attempt is a typed IDEMPOTENCY_CONFLICT, never masked as unavailable', async () => {
  requireDb();
  const reserve = await fixturePromise;
  const pool = reservationPool(8);
  try {
    const scope = makeScope('recovery-billable');
    await setBudgetLimit(pool, scope, '10.00');
    const sharedBillable = `billable-shared-${Math.random().toString(16).slice(2)}`;
    const first = await authorizeReservation(reservationRequest(scope, reserve, { amount: '1.00', billableAttemptId: sharedBillable }), ports(pool, scope));
    assert.equal(first.ok, true, first.ok ? '' : first.error.code);
    assert.equal(first.value.status, 'authorized');
    // A different idempotency key but the same billable attempt id is a conflict, not a second hold.
    const dup = await authorizeReservation(reservationRequest(scope, reserve, { amount: '1.00', billableAttemptId: sharedBillable }), ports(pool, scope));
    assert.equal(dup.ok, false, 'a duplicate billable attempt must not create a second hold');
    assert.equal(dup.error.code, 'IDEMPOTENCY_CONFLICT');
    assert.equal(dup.error.retryable, false, 'a billable-attempt conflict is deterministic, not a transient outage');
    const capacity = await readCapacity(scope, 'USD', 'billable-cap', ports(pool, scope));
    assert.equal(capacity.value.reservationCount, 1, 'exactly one hold exists for the billable attempt');
  } finally {
    await pool.end();
  }
});

test('CI-05B.4 the recovery scan is bounded: it never returns more than the requested batch', async () => {
  requireDb();
  const reserve = await fixturePromise;
  const pool = reservationPool(8);
  try {
    const scope = makeScope('recovery-bounded');
    await setBudgetLimit(pool, scope, '10.00');
    for (let i = 0; i < 3; i++) {
      const authorized = await authorizeReservation(reservationRequest(scope, reserve, { amount: '1.00' }), ports(pool, scope, { clock: clockAt(T0) }));
      const d = markDispatchedCommand(scope, authorized.value.reservationId, 1, { attemptBinding: authorized.value.attemptBinding });
      d.workerLeaseExpiresAt = LEASE_EXP; d.workerLeaseId = `lease-${i}`;
      assert.equal((await markReservationDispatched(d, ports(pool, scope, { clock: clockAt(T0) }))).ok, true);
    }
    const scan = await runRecoveryScan(recoveryScanRequest(scope, { agingThresholdMs: 0, maxReservations: 2 }), ports(pool, scope, { clock: clockAt(T_AFTER_LEASE) }));
    assert.equal(scan.ok, true, scan.ok ? '' : scan.error.code);
    assert.equal(scan.value.scannedReservations, 2, 'the batch is capped at the requested bound');
    assert.equal(scan.value.bounded, true, 'the scan reports that more work remains');
  } finally {
    await pool.end();
  }
});

test('CI-05B.3/defect-b a financially-expired hold cannot be dispatched (typed, hold preserved); a not-yet-expired dispatch still succeeds', async () => {
  requireDb();
  const reserve = await fixturePromise;
  const pool = reservationPool(8);
  try {
    const scope = makeScope('recovery-dispatch-expiry');
    await setBudgetLimit(pool, scope, '5.00');
    // Financial expiry = T0 + 60s. Dispatch is attempted AFTER it matures.
    const expiredAuth = await authorizeReservation(reservationRequest(scope, reserve, { amount: '1.00' }), ports(pool, scope, { clock: clockAt(T0), financialExpiryMs: 60_000 }));
    const expId = expiredAuth.value.reservationId;
    const expOwn = expiredAuth.value.attemptBinding;
    const rejected = await markReservationDispatched(markDispatchedCommand(scope, expId, 1, { attemptBinding: expOwn }), ports(pool, scope, { clock: clockAt(T_AFTER_LEASE) }));
    assert.equal(rejected.ok, false, 'a matured financial expiry blocks dispatch');
    assert.equal(rejected.error.code, 'VALIDATION_ERROR');
    assert.equal(rejected.error.retryable, false, 'a matured financial expiry is deterministic, not a transient outage');
    assert.match(rejected.error.safe_message, /financial expiry/i);
    // The hold is preserved: still held, not dispatched, still reserving capacity.
    const stillHeld = await readReservationState(scope, expId, 'b-held', ports(pool, scope, { clock: clockAt(T_AFTER_LEASE) }));
    assert.equal(stillHeld.value.state, 'held', 'a rejected dispatch leaves the hold held');
    assert.equal(stillHeld.value.everDispatched, false);
    assert.equal(stillHeld.value.outstandingHold, '1');

    // A legitimate, not-yet-matured dispatch still works; the worker lease stays separate from financial expiry.
    const freshAuth = await authorizeReservation(reservationRequest(scope, reserve, { amount: '1.00' }), ports(pool, scope, { clock: clockAt(T0), financialExpiryMs: 60_000 }));
    const freshId = freshAuth.value.reservationId;
    const freshOwn = freshAuth.value.attemptBinding;
    const ok = await markReservationDispatched(markDispatchedCommand(scope, freshId, 1, { attemptBinding: freshOwn }), ports(pool, scope, { clock: clockAt('2026-10-12T04:00:30.000Z') }));
    assert.equal(ok.ok, true, ok.ok ? '' : ok.error.code);
    assert.equal(ok.value.state, 'dispatched', 'a not-yet-expired hold still dispatches');
  } finally {
    await pool.end();
  }
});

test('CI-05B/defect-d authorize replay reproduces the original decision, not the current state; callers use readReservationState', async () => {
  requireDb();
  const reserve = await fixturePromise;
  const pool = reservationPool(8);
  try {
    const scope = makeScope('recovery-replay');
    await setBudgetLimit(pool, scope, '5.00');
    const request = reservationRequest(scope, reserve, { amount: '1.00' });
    const first = await authorizeReservation(request, ports(pool, scope));
    assert.equal(first.value.status, 'authorized');
    assert.equal(first.value.expiryEligibility, 'eligible_if_never_dispatched');
    const id = first.value.reservationId;
    const own = first.value.attemptBinding;
    // Progress the reservation all the way to settled.
    await markReservationDispatched(markDispatchedCommand(scope, id, 1, { attemptBinding: own }), ports(pool, scope));
    await settleReservation(settleCommand(scope, id, 2, { cumulativeAmount: '1.000000', finality: 'final', sequence: 1, attemptBinding: own }), ports(pool, scope));
    // The identical authorize replays. Its status is still the ORIGINAL 'authorized'
    // (the AuthorizationDecision contract cannot encode settled), but the eligibility
    // is downgraded so the replay never claims a progressed hold is freely expirable.
    const replay = await authorizeReservation(request, ports(pool, scope));
    assert.equal(replay.ok, true, replay.ok ? '' : replay.error.code);
    assert.equal(replay.value.reservationId, id, 'the replay returns the single existing hold');
    assert.equal(replay.value.status, 'authorized', 'replay reproduces the original first-event decision shape');
    assert.equal(replay.value.expiryEligibility, 'not_expired', 'a progressed reservation is no longer freely expirable on replay');
    // The live projected state is read via readReservationState, not the replay.
    const live = await readReservationState(scope, id, 'd-live', ports(pool, scope));
    assert.equal(live.value.state, 'settled', 'readReservationState projects the current lifecycle state');
    assert.equal(live.value.everDispatched, true);
  } finally {
    await pool.end();
  }
});

test('CI-05B/defect-e the expiry reason is persisted so financial_expiry and operator_revocation stay distinguishable', async () => {
  requireDb();
  const reserve = await fixturePromise;
  const pool = reservationPool(8);
  try {
    const scope = makeScope('recovery-expreason');
    await setBudgetLimit(pool, scope, '5.00');
    // Operator revocation of a never-dispatched hold.
    const a = await authorizeReservation(reservationRequest(scope, reserve, { amount: '1.00' }), ports(pool, scope));
    const revoked = await expireReservation(expireCommand(scope, a.value.reservationId, 1, { reason: 'operator_revocation', attemptBinding: a.value.attemptBinding }), ports(pool, scope));
    assert.equal(revoked.ok, true, revoked.ok ? '' : revoked.error.code);
    // Matured financial expiry of another never-dispatched hold.
    const b = await authorizeReservation(reservationRequest(scope, reserve, { amount: '1.00' }), ports(pool, scope, { clock: clockAt(T0), financialExpiryMs: 60_000 }));
    const expired = await expireReservation(expireCommand(scope, b.value.reservationId, 1, { reason: 'financial_expiry', attemptBinding: b.value.attemptBinding }), ports(pool, scope, { clock: clockAt(T_AFTER_LEASE) }));
    assert.equal(expired.ok, true, expired.ok ? '' : expired.error.code);
    const rows = await pool.query(
      `SELECT reservation_id, expiry_reason FROM cost_intelligence.budget_reservation_events
       WHERE event_type = 'expired' AND reservation_id = ANY($1::text[])`,
      [[a.value.reservationId, b.value.reservationId]],
    );
    const byId = Object.fromEntries(rows.rows.map(r => [r.reservation_id, r.expiry_reason]));
    assert.equal(byId[a.value.reservationId], 'operator_revocation', 'an operator revocation records its reason');
    assert.equal(byId[b.value.reservationId], 'financial_expiry', 'a matured financial expiry records a distinct reason');
  } finally {
    await pool.end();
  }
});

test('CI-05B/gap3 behavioral: two idempotency keys reusing one billable_attempt_id at event_sequence=1 yield exactly one hold', async () => {
  requireDb();
  const reserve = await fixturePromise;
  const pool = reservationPool(8);
  try {
    const scope = makeScope('recovery-gap3-behavioral');
    await setBudgetLimit(pool, scope, '10.00');
    const sharedBillable = `billable-seq1-${Math.random().toString(16).slice(2)}`;
    // Two DIFFERENT idempotency keys, the SAME billable attempt id; both would be first events.
    const first = await authorizeReservation(reservationRequest(scope, reserve, { amount: '1.00', idempotencyKey: `k1-${sharedBillable}`, billableAttemptId: sharedBillable }), ports(pool, scope));
    assert.equal(first.ok, true, first.ok ? '' : first.error.code);
    assert.equal(first.value.status, 'authorized');
    const second = await authorizeReservation(reservationRequest(scope, reserve, { amount: '1.00', idempotencyKey: `k2-${sharedBillable}`, billableAttemptId: sharedBillable }), ports(pool, scope));
    assert.equal(second.ok, false, 'the second authorization must not create a second hold');
    assert.equal(second.error.code, 'IDEMPOTENCY_CONFLICT', 'it is a typed conflict, never swallowed into unavailable');
    assert.equal(second.error.retryable, false, 'a billable-attempt conflict is deterministic, not a transient outage');
    // At the DB: exactly one event_sequence=1 row bound to the shared billable attempt.
    const rows = await pool.query(
      `SELECT count(*)::int AS n FROM cost_intelligence.budget_reservation_events
       WHERE billable_attempt_id = $1 AND event_sequence = 1`,
      [sharedBillable],
    );
    assert.equal(rows.rows[0].n, 1, 'the partial unique index admits exactly one first-event hold per billable attempt');
  } finally {
    await pool.end();
  }
});
