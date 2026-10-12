// Recovery acceptance (merged CI-04A usage-intake recovery + CI-05B budget
// settlement recovery). CI-05B: crash-schedule recovery, worker-lease expiry
// with unknown outcome, bounded rerunnable recovery scans, no-dispatch fencing,
// the typed billable-attempt conflict (consumer gap 3), and the scoped
// current-state read (consumer gap 1). CI-04A: durable usage-intake crash and
// replay recovery. Runs against a real disposable PostgreSQL; mocks never prove
// the atomic financial safety these scenarios require.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before } from 'node:test';
import pg from 'pg';
import {
  authorizeReservation, markReservationDispatched, settleReservation, releaseReservation,
  expireReservation, readReservationState, runRecoveryScan, listReconciliationExceptions, readCapacity,
  ingestUsage, rebuildLedgerProjection, replayUsageOutbox,
} from '../../dist/index.js';
import { bindFinancialDatabaseScope } from '../../dist/shared/database-scope.js';
import {
  assertDisposableMarker,
  databaseConfigFromEnvironment,
  runtimeDatabaseConfigFromEnvironment,
} from '../../scripts/test-db-lifecycle.mjs';
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

// ---- CI-04A usage-intake recovery suite ----

const { Pool } = pg;
const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const crashWorker = join(root, 'tests/recovery/crash-worker.mjs');
const fixture = JSON.parse(await readFile(join(root, 'fixtures/metering/usage-observation.request.json'), 'utf8'));
let observer;
let runtime;

function scopeFor() {
  return { tenantId: randomUUID(), projectId: randomUUID(),
    environment: 'test', billingMode: 'simulated', actorId: randomUUID() };
}

function observation(scope = scopeFor(), options = {}) {
  const event = structuredClone(fixture.usageEvent);
  const suffix = options.suffix ?? randomUUID();
  event.event_id = randomUUID();
  event.usage_event_id = randomUUID();
  event.source_observation_id = options.sourceObservationId ?? randomUUID();
  event.logical_operation_id = options.logicalOperationId ?? randomUUID();
  event.provider_attempt_id = options.providerAttemptId ?? randomUUID();
  event.billable_attempt_id = options.billableAttemptId ?? randomUUID();
  event.transport_attempt_id = options.transportAttemptId ?? randomUUID();
  event.correlation_id = options.correlationId ?? randomUUID();
  event.provider_request_id = options.providerRequestId ?? null;
  event.tenant_id = scope.tenantId;
  event.project_id = scope.projectId;
  event.environment = scope.environment;
  event.billing_mode = scope.billingMode;
  event.producer = { module: 'shared-contracts', source_revision: 'a'.repeat(40), build_revision: 'ci04a-synthetic-fixture' };
  event.occurred_at = options.occurredAt ?? new Date().toISOString();
  event.observed_at = options.observedAt ?? new Date().toISOString();
  event.ingested_at = new Date().toISOString();
  event.source = options.source ?? 'provider_response';
  event.provider = 'synthetic_provider';
  event.model = 'synthetic_model';
  event.completeness = options.completeness ?? 'complete';
  event.usage_units = options.usageUnits ?? [
    { name: 'input_tokens', quantity: '7', scale: 0, relation: 'standalone' },
    { name: 'cached_tokens', quantity: '2', scale: 0, relation: 'included_subset', included_in: 'input_tokens' },
  ];
  event.missing_fields = options.missingFields ?? [];
  event.outcome = options.outcome ?? 'succeeded';
  event.supersedes_observation_id = options.supersedesObservationId ?? null;
  event.reconciliation_ref = null;
  if (options.unknownValuation) {
    event.completeness = options.completeness ?? 'incomplete';
    event.usage_units = options.usageUnits ?? null;
    event.missing_fields = options.missingFields ?? ['usage', 'amount'];
    event.valuation = { basis: 'unknown', money: null, rate_card_ref: null };
    event.outcome = options.outcome ?? 'partial';
  } else {
    const basis = options.valuationBasis ?? 'estimated';
    const amount = options.amount ?? '0.000003';
    event.valuation = {
      basis,
      money: { amount, currency: 'USD', scale: 6 },
      rate_card_ref: {
        contract: 'RateCard', schema_version: '1.0.0', id: randomUUID(), revision: 1,
        content_hash: `sha256:${'c'.repeat(64)}`,
      },
    };
  }
  return {
    schemaVersion: '1.0.0', requestId: `ci04a-request-${suffix}`, idempotencyKey: options.idempotencyKey ?? `ci04a-idempotency-${suffix}`,
    scope, usageEvent: event, evidenceMode: 'mocked', verificationStatus: 'unverified',
    evidenceProvenanceRef: `fixture:synthetic:${suffix}`,
  };
}

function portsFor(scope, database = { connect: () => runtime.connect() }) {
  return {
    database,
    trustedContext: { resolve: async requested => requested },
    clock: { now: () => new Date() },
    financeAuthority: { authorizeCurrent: async request => {
      if (JSON.stringify(request.requestedScope) !== JSON.stringify(scope)) {
        return { status: 'denied', operation: request.operation, permission: request.permission, decisionId: 'ci04a-foreign-scope' };
      }
      return {
        status: 'allowed', decisionId: `ci04a-current:${request.operation}`,
        operation: request.operation, permission: request.permission, scope: request.requestedScope,
        principal: { kind: 'service', actorId: request.requestedScope.actorId, serviceStatus: 'active', serviceGrantRevision: 'ci04a-test-grant-1' },
        verifiedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
      };
    } },
  };
}

async function scopedCounts(scope) {
  const result = await observer.query(
    `SELECT
      (SELECT count(*)::integer FROM cost_intelligence.usage_intake_inbox WHERE tenant_id=$1 AND project_id=$2 AND environment=$3 AND billing_mode=$4) AS inbox,
      (SELECT count(*)::integer FROM cost_intelligence.usage_intake_attempts WHERE tenant_id=$1 AND project_id=$2 AND environment=$3 AND billing_mode=$4) AS attempts,
      (SELECT count(*)::integer FROM cost_intelligence.usage_intake_outbox WHERE tenant_id=$1 AND project_id=$2 AND environment=$3 AND billing_mode=$4) AS outbox,
      (SELECT count(*)::integer FROM cost_intelligence.financial_ledger_events WHERE tenant_id=$1 AND project_id=$2 AND environment=$3 AND billing_mode=$4) AS ledger_history,
      (SELECT count(*)::integer FROM cost_intelligence.financial_source_revision_heads head
       JOIN cost_intelligence.financial_ledger_events event ON event.event_id=head.current_event_id
       WHERE head.tenant_id=$1 AND head.project_id=$2 AND head.environment=$3 AND head.billing_mode=$4
         AND event.financial_effect) AS effective_events,
       (SELECT trim_scale(COALESCE(sum(event.amount), 0))::text FROM cost_intelligence.financial_source_revision_heads head
       JOIN cost_intelligence.financial_ledger_events event ON event.event_id=head.current_event_id
       WHERE head.tenant_id=$1 AND head.project_id=$2 AND head.environment=$3 AND head.billing_mode=$4
         AND event.financial_effect) AS effective_amount`,
    [scope.tenantId, scope.projectId, scope.environment, scope.billingMode],
  );
  return result.rows[0];
}

async function outboxRows(scope) {
  const result = await observer.query(
    `SELECT source_observation_id, status, retry_count, last_error_code, ledger_event_id, available_at
     FROM cost_intelligence.usage_intake_outbox
     WHERE tenant_id=$1 AND project_id=$2 AND environment=$3 AND billing_mode=$4
     ORDER BY created_at, source_observation_id`,
    [scope.tenantId, scope.projectId, scope.environment, scope.billingMode],
  );
  return result.rows;
}

async function projection(scope, ports, asOf) {
  const result = await rebuildLedgerProjection({
    schemaVersion: '1.0.0', requestId: `ci04a-projection-${randomUUID()}`, scope, asOf,
  }, ports);
  assert.equal(result.ok, true, result.ok ? '' : `${result.error.code}: ${result.error.safe_message}`);
  return result.value;
}

function waitForSignal(child, expectedState) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`child did not reach ${expectedState}`)), 20_000);
    child.on('message', message => {
      if (message?.state === expectedState) { clearTimeout(timeout); resolve(); }
      else if (message?.state === 'returned') { clearTimeout(timeout); reject(new Error('child returned before crash barrier')); }
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`child exited before crash barrier (${code ?? signal})`));
    });
  });
}

async function crashAtCommit(mode, request) {
  const child = spawn(process.execPath, [crashWorker, mode], {
    env: { ...process.env, CI04A_CRASH_PAYLOAD: JSON.stringify(request) },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  const stderr = [];
  child.stderr.on('data', chunk => stderr.push(chunk));
  try {
    await waitForSignal(child, mode);
  } catch (error) {
    child.kill('SIGKILL');
    throw new Error(`${error.message}; worker stderr=${Buffer.concat(stderr).toString('utf8').slice(0, 1200)}`);
  }
  child.kill('SIGKILL');
  await new Promise(resolve => child.once('exit', resolve));
}

async function crashDuringReplay(scope) {
  const child = spawn(process.execPath, [crashWorker, 'replay_during'], {
    env: { ...process.env, CI04A_REPLAY_SCOPE: JSON.stringify(scope) },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  const stderr = [];
  child.stderr.on('data', chunk => stderr.push(chunk));
  try {
    await waitForSignal(child, 'during_replay');
  } catch (error) {
    child.kill('SIGKILL');
    throw new Error(`${error.message}; replay worker stderr=${Buffer.concat(stderr).toString('utf8').slice(0, 1200)}`);
  }
  child.kill('SIGKILL');
  await new Promise(resolve => child.once('exit', resolve));
}

before(async () => {
  assert.ok(process.env.CI_TEST_DB_RUNTIME_HOST, 'recovery suite requires its restricted disposable PostgreSQL runtime role');
  observer = new Pool({ ...databaseConfigFromEnvironment(), max: 4 });
  runtime = new Pool({ ...runtimeDatabaseConfigFromEnvironment(), max: 12 });
  const marker = await observer.query('SELECT marker FROM ci_test.disposable_database_marker');
  assertDisposableMarker(marker.rows);
  const version = await runtime.query('SELECT version() AS version');
  assert.match(version.rows[0].version, /^PostgreSQL 16\./, 'durability scenarios use the pinned actual PostgreSQL 16 server');
});

after(async () => {
  await Promise.all([observer?.end().catch(() => {}), runtime?.end().catch(() => {})]);
});

test('restricted PostgreSQL runtime writes inbox, attempt, outbox, and ledger rows under exact RLS scope', async () => {
  const scope = scopeFor();
  const request = observation(scope);
  const result = await ingestUsage(request, portsFor(scope));
  assert.equal(result.ok, true, result.ok ? '' : `${result.error.code}: ${result.error.safe_message}`);
  assert.equal(result.value.status, 'accepted', JSON.stringify(result.value));
  assert.equal(result.value.durableCommit, true);
  assert.equal(result.value.outboxStatus, 'posted');
  assert.deepEqual(await scopedCounts(scope), {
    inbox: 1, attempts: 1, outbox: 1, ledger_history: 1, effective_events: 1, effective_amount: '0.000003',
  });
  assert.equal((await outboxRows(scope))[0].status, 'posted');

  const grants = await runtime.query(`SELECT current_user,
    has_table_privilege(current_user, 'cost_intelligence.usage_intake_inbox', 'SELECT') AS inbox_select,
    has_table_privilege(current_user, 'cost_intelligence.usage_intake_inbox', 'INSERT') AS inbox_insert,
    has_table_privilege(current_user, 'cost_intelligence.usage_intake_inbox', 'UPDATE') AS inbox_update,
    has_table_privilege(current_user, 'cost_intelligence.usage_intake_inbox', 'DELETE') AS inbox_delete,
    has_column_privilege(current_user, 'cost_intelligence.usage_intake_attempts', 'billable_attempt_id', 'UPDATE') AS can_rebind_attempt`);
  assert.deepEqual(grants.rows[0] && {
    inboxSelect: grants.rows[0].inbox_select, inboxInsert: grants.rows[0].inbox_insert,
    inboxUpdate: grants.rows[0].inbox_update, inboxDelete: grants.rows[0].inbox_delete,
    canRebindAttempt: grants.rows[0].can_rebind_attempt,
  }, { inboxSelect: true, inboxInsert: true, inboxUpdate: false, inboxDelete: false, canRebindAttempt: false });

  const unbound = await runtime.query('SELECT source_observation_id FROM cost_intelligence.usage_intake_inbox');
  assert.equal(unbound.rows.length, 0, 'runtime sees no intake rows without transaction-local four-part scope');
  const foreign = scopeFor();
  const client = await runtime.connect();
  try {
    await client.query('BEGIN');
    await bindFinancialDatabaseScope(client, foreign);
    const hidden = await client.query('SELECT source_observation_id FROM cost_intelligence.usage_intake_inbox WHERE tenant_id=$1', [scope.tenantId]);
    assert.equal(hidden.rows.length, 0, 'a different bound tenant cannot read intake rows');
    await assert.rejects(client.query(
      `INSERT INTO cost_intelligence.usage_intake_quarantine
       (diagnostic_ref,tenant_id,project_id,environment,billing_mode,reason_code,payload_sha256)
       VALUES ($1,$2,$3,$4,$5,'invalid_usage_event',$6)`,
      [`ci04aq:${'d'.repeat(64)}`, scope.tenantId, scope.projectId, scope.environment, scope.billingMode, `sha256:${'e'.repeat(64)}`],
    ), error => error.code === '42501');
    await client.query('ROLLBACK');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
});

test('concurrent duplicate deliveries converge; direct and trace observations share one billed attempt; real retries remain distinct', async () => {
  const scope = scopeFor();
  const request = observation(scope);
  const ports = portsFor(scope);
  const deliveries = await Promise.all(Array.from({ length: 12 }, () => ingestUsage(request, ports)));
  assert.ok(deliveries.every(result => result.ok));
  assert.equal(deliveries.filter(result => result.ok && result.value.status === 'accepted').length, 1);
  assert.equal(deliveries.filter(result => result.ok && result.value.status === 'duplicate').length, 11);
  assert.deepEqual(await scopedCounts(scope), {
    inbox: 1, attempts: 1, outbox: 1, ledger_history: 1, effective_events: 1, effective_amount: '0.000003',
  });

  const trace = structuredClone(request);
  trace.requestId = `ci04a-trace-${randomUUID()}`;
  trace.idempotencyKey = `ci04a-trace-idem-${randomUUID()}`;
  trace.evidenceProvenanceRef = 'fixture:synthetic:trace-copy';
  trace.usageEvent.event_id = randomUUID();
  trace.usageEvent.usage_event_id = randomUUID();
  trace.usageEvent.source_observation_id = randomUUID();
  trace.usageEvent.source = 'trace';
  trace.usageEvent.transport_attempt_id = randomUUID();
  const traced = await ingestUsage(trace, ports);
  assert.equal(traced.ok, true, traced.ok ? '' : traced.error.code);
  assert.equal(traced.value.outboxStatus, 'suppressed', 'different source observation is durably linked but does not duplicate expense');
  assert.deepEqual(await scopedCounts(scope), {
    inbox: 2, attempts: 1, outbox: 2, ledger_history: 1, effective_events: 1, effective_amount: '0.000003',
  });

  const billedRetry = observation(scope, {
    logicalOperationId: request.usageEvent.logical_operation_id,
    providerAttemptId: randomUUID(),
    billableAttemptId: randomUUID(),
    transportAttemptId: randomUUID(),
    amount: '0.000004',
  });
  const retry = await ingestUsage(billedRetry, ports);
  assert.equal(retry.ok, true, retry.ok ? '' : retry.error.code);
  assert.equal(retry.value.outboxStatus, 'posted');
  assert.deepEqual(await scopedCounts(scope), {
    inbox: 3, attempts: 2, outbox: 3, ledger_history: 2, effective_events: 2, effective_amount: '0.000007',
  });

  const conflict = structuredClone(request);
  conflict.usageEvent.valuation.money.amount = '0.000009';
  const contradictory = await ingestUsage(conflict, ports);
  assert.equal(contradictory.ok, true);
  assert.equal(contradictory.value.status, 'conflict');
  assert.deepEqual(await scopedCounts(scope), {
    inbox: 3, attempts: 2, outbox: 3, ledger_history: 2, effective_events: 2, effective_amount: '0.000007',
  }, 'same-key contradictory payload does not mutate accepted facts or financial effects');
});

test('estimate-to-confirmed enrichment replaces the effective posting; out-of-order partial usage cannot replace a final', async () => {
  const scope = scopeFor();
  const ports = portsFor(scope);
  const estimate = observation(scope, { amount: '0.000003', valuationBasis: 'estimated' });
  const first = await ingestUsage(estimate, ports);
  assert.equal(first.ok, true, first.ok ? '' : first.error.code);
  const confirmation = structuredClone(estimate);
  confirmation.requestId = `ci04a-confirm-${randomUUID()}`;
  confirmation.idempotencyKey = `ci04a-confirm-idem-${randomUUID()}`;
  confirmation.evidenceProvenanceRef = 'fixture:synthetic:provider-confirmation';
  confirmation.usageEvent.event_id = randomUUID();
  confirmation.usageEvent.usage_event_id = randomUUID();
  confirmation.usageEvent.source_observation_id = randomUUID();
  confirmation.usageEvent.observed_at = new Date(Date.now() + 5).toISOString();
  confirmation.usageEvent.supersedes_observation_id = estimate.usageEvent.source_observation_id;
  confirmation.usageEvent.source_refs = [{ kind: 'evidence', id: 'fixture:provider-confirmation',
    content_hash: `sha256:${'d'.repeat(64)}` }];
  confirmation.usageEvent.valuation.basis = 'provider_confirmed';
  confirmation.usageEvent.valuation.money.amount = '0.000005';
  const confirmed = await ingestUsage(confirmation, ports);
  assert.equal(confirmed.ok, true, confirmed.ok ? '' : confirmed.error.code);
  assert.equal(confirmed.value.outboxStatus, 'posted');
  assert.deepEqual(await scopedCounts(scope), {
    inbox: 2, attempts: 1, outbox: 2, ledger_history: 2, effective_events: 1, effective_amount: '0.000005',
  });
  const history = await observer.query(
    `SELECT event_id, event_type, valuation, trim_scale(amount)::text AS amount, supersedes_event_id
     FROM cost_intelligence.financial_ledger_events WHERE tenant_id=$1 AND project_id=$2
     ORDER BY source_revision_sequence`, [scope.tenantId, scope.projectId],
  );
  assert.equal(history.rows.length, 2);
  assert.equal(history.rows[0].amount, '0.000003');
  assert.equal(history.rows[1].event_type, 'correction');
  assert.equal(history.rows[1].valuation, 'provider_confirmed');
  assert.equal(history.rows[1].amount, '0.000005');
  assert.equal(history.rows[1].supersedes_event_id, history.rows[0].event_id);

  const orderedScope = scopeFor();
  const orderedPorts = portsFor(orderedScope);
  const partial = observation(orderedScope, { unknownValuation: true });
  const final = observation(orderedScope, {
    amount: '0.000008', valuationBasis: 'provider_confirmed',
    supersedesObservationId: partial.usageEvent.source_observation_id,
    logicalOperationId: partial.usageEvent.logical_operation_id,
    providerAttemptId: partial.usageEvent.provider_attempt_id,
    billableAttemptId: partial.usageEvent.billable_attempt_id,
  });
  const finalReceipt = await ingestUsage(final, orderedPorts);
  assert.equal(finalReceipt.ok, true, finalReceipt.ok ? '' : finalReceipt.error.code);
  const latePartial = await ingestUsage(partial, orderedPorts);
  assert.equal(latePartial.ok, true, latePartial.ok ? '' : latePartial.error.code);
  assert.equal(latePartial.value.outboxStatus, 'suppressed');
  assert.deepEqual(await scopedCounts(orderedScope), {
    inbox: 2, attempts: 1, outbox: 2, ledger_history: 1, effective_events: 1, effective_amount: '0.000008',
  });
  const head = await observer.query(
    `SELECT current_observation_id, current_ledger_event_id FROM cost_intelligence.usage_intake_attempts
     WHERE tenant_id=$1 AND project_id=$2`, [orderedScope.tenantId, orderedScope.projectId],
  );
  assert.equal(head.rows[0].current_observation_id, final.usageEvent.source_observation_id);
});

test('unknown final usage remains explicit and missing pinned attempt identity is hash-only quarantined', async () => {
  const scope = scopeFor();
  const ports = portsFor(scope);
  const unknown = observation(scope, { unknownValuation: true });
  const receipt = await ingestUsage(unknown, ports);
  assert.equal(receipt.ok, true, receipt.ok ? '' : receipt.error.code);
  assert.equal(receipt.value.status, 'accepted');
  assert.equal(receipt.value.valuation, 'unknown');
  assert.equal(receipt.value.outboxStatus, 'awaiting_evidence');
  assert.deepEqual(await scopedCounts(scope), {
    inbox: 1, attempts: 1, outbox: 1, ledger_history: 0, effective_events: 0, effective_amount: '0',
  });
  const initialAsOf = (await observer.query('SELECT clock_timestamp() AS as_of')).rows[0].as_of.toISOString();
  const unresolvedProjection = await projection(scope, ports, initialAsOf);
  assert.equal(unresolvedProjection.eventCount, 0);
  assert.deepEqual(unresolvedProjection.amounts, [], 'unknown currency and rate never become a zero ledger event');
  assert.deepEqual(unresolvedProjection.unresolvedIntake, {
    unknownEconomicExposureCount: 1, quarantinedObservationCount: 0,
    awaitingEvidenceAttemptCount: 1, unpostedAttemptCount: 1,
  }, 'the authoritative projection retains unknown exposure without fabricating an amount or attempt');
  const stored = await observer.query(
    `SELECT valuation_basis, payload_sha256, event_facts->'valuation' AS valuation, event_facts->'usage_units' AS usage_units
     FROM cost_intelligence.usage_intake_inbox WHERE tenant_id=$1 AND project_id=$2`,
    [scope.tenantId, scope.projectId],
  );
  assert.equal(stored.rows[0].valuation_basis, 'unknown');
  assert.equal(stored.rows[0].valuation.money, null);
  assert.equal(stored.rows[0].usage_units, null);
  assert.match(stored.rows[0].payload_sha256, /^sha256:[a-f0-9]{64}$/);

  const resolved = observation(scope, {
    logicalOperationId: unknown.usageEvent.logical_operation_id,
    providerAttemptId: unknown.usageEvent.provider_attempt_id,
    billableAttemptId: unknown.usageEvent.billable_attempt_id,
    supersedesObservationId: unknown.usageEvent.source_observation_id,
    valuationBasis: 'provider_confirmed', amount: '0.000005', completeness: 'complete',
    usageUnits: [{ name: 'input_tokens', quantity: '7', scale: 0, relation: 'standalone' }],
  });
  resolved.evidenceProvenanceRef = 'fixture:synthetic:unknown-valuation-resolution';
  const resolution = await ingestUsage(resolved, ports);
  assert.equal(resolution.ok, true, resolution.ok ? '' : resolution.error.code);
  assert.equal(resolution.value.outboxStatus, 'posted');
  const resolvedAsOf = (await observer.query('SELECT clock_timestamp() AS as_of')).rows[0].as_of.toISOString();
  const resolvedProjection = await projection(scope, ports, resolvedAsOf);
  assert.equal(resolvedProjection.eventCount, 1);
  assert.equal(resolvedProjection.amounts[0].totalAmount, '0.000005');
  assert.deepEqual(resolvedProjection.unresolvedIntake, {
    unknownEconomicExposureCount: 0, quarantinedObservationCount: 0,
    awaitingEvidenceAttemptCount: 0, unpostedAttemptCount: 0,
  });
  const replayedHistoricalProjection = await projection(scope, ports, initialAsOf);
  assert.equal(replayedHistoricalProjection.snapshotId, unresolvedProjection.snapshotId,
    'as-of replay preserves the original unknown exposure after later evidence resolves it');
  assert.deepEqual(replayedHistoricalProjection.unresolvedIntake, unresolvedProjection.unresolvedIntake);
  const attemptHistory = await observer.query(
    `SELECT source_observation_id, attempt_revision_accepted,
            event_facts->>'supersedes_observation_id' AS supersedes_observation_id
     FROM cost_intelligence.usage_intake_inbox
     WHERE tenant_id=$1 AND project_id=$2 AND billable_attempt_id=$3 ORDER BY created_at, source_observation_id`,
    [scope.tenantId, scope.projectId, unknown.usageEvent.billable_attempt_id],
  );
  assert.equal(attemptHistory.rows.length, 2);
  assert.equal(attemptHistory.rows[0].attempt_revision_accepted, true);
  assert.equal(attemptHistory.rows[1].attempt_revision_accepted, true);
  assert.equal(attemptHistory.rows[1].supersedes_observation_id, unknown.usageEvent.source_observation_id);

  const missing = structuredClone(unknown);
  missing.requestId = `ci04a-missing-${randomUUID()}`;
  missing.idempotencyKey = `ci04a-missing-idem-${randomUUID()}`;
  missing.usageEvent.source = 'other';
  const canary = 'CI04A_PRIVATE_USAGE_CANARY';
  missing.usageEvent.provider = canary;
  missing.usageEvent.model = 'cumulative_snapshot';
  delete missing.usageEvent.provider_attempt_id;
  delete missing.usageEvent.billable_attempt_id;
  const quarantined = await ingestUsage(missing, ports);
  assert.equal(quarantined.ok, true, quarantined.ok ? '' : quarantined.error.code);
  assert.equal(quarantined.value.status, 'quarantined');
  assert.equal(quarantined.value.providerAttemptId.status, 'unknown');
  assert.equal(quarantined.value.billableAttemptId.status, 'unknown');
  assert.deepEqual(await scopedCounts(scope), {
    inbox: 2, attempts: 1, outbox: 2, ledger_history: 1, effective_events: 1, effective_amount: '0.000005',
  }, 'a cumulative snapshot without genuine attempt identity adds no attempt coverage or charge');
  const diagnostics = await observer.query(
    `SELECT * FROM cost_intelligence.usage_intake_quarantine
     WHERE tenant_id=$1 AND project_id=$2`, [scope.tenantId, scope.projectId],
  );
  assert.equal(diagnostics.rows.length, 1);
  assert.equal(diagnostics.rows[0].reason_code, 'invalid_usage_event');
  assert.match(diagnostics.rows[0].payload_sha256, /^sha256:[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(quarantined), new RegExp(canary));
  assert.doesNotMatch(JSON.stringify(diagnostics.rows), new RegExp(canary), 'hash-only quarantine never stores unsafe source text');

  const duplicateQuarantine = structuredClone(missing);
  duplicateQuarantine.requestId = `ci04a-missing-retry-${randomUUID()}`;
  duplicateQuarantine.idempotencyKey = `ci04a-missing-retry-idem-${randomUUID()}`;
  const retriedQuarantine = await ingestUsage(duplicateQuarantine, ports);
  assert.equal(retriedQuarantine.ok, true, retriedQuarantine.ok ? '' : retriedQuarantine.error.code);
  const quarantinedAsOf = (await observer.query('SELECT clock_timestamp() AS as_of')).rows[0].as_of.toISOString();
  const quarantineProjection = await projection(scope, ports, quarantinedAsOf);
  assert.equal(quarantineProjection.eventCount, 1, 'quarantine exposure does not fabricate a financial event');
  assert.deepEqual(quarantineProjection.unresolvedIntake, {
    unknownEconomicExposureCount: 1, quarantinedObservationCount: 1,
    awaitingEvidenceAttemptCount: 0, unpostedAttemptCount: 0,
  }, 'hash-deduplicated privacy quarantine is visible as unknown economic exposure');
  assert.equal((await scopedCounts(scope)).effective_amount, '0.000005',
    'unknown intake and hash-only quarantine do not change the known ledger amount');
});

test('partial intake categories preserve nested quantity parents without adding subset charges', async () => {
  const scope = scopeFor();
  const ports = portsFor(scope);
  const request = observation(scope, {
    amount: '0.000003', completeness: 'incomplete', missingFields: ['cache_read_tokens'],
    usageUnits: [
      { name: 'tokens', quantity: '11', scale: 0, relation: 'standalone' },
      { name: 'input_tokens', quantity: '7', scale: 0, relation: 'standalone' },
      { name: 'cached_tokens', quantity: '2', scale: 0, relation: 'included_subset', included_in: 'input_tokens' },
      { name: 'output_tokens', quantity: '4', scale: 0, relation: 'standalone' },
      { name: 'reasoning_tokens', quantity: '1', scale: 0, relation: 'included_subset', included_in: 'output_tokens' },
    ],
  });
  const receipt = await ingestUsage(request, ports);
  assert.equal(receipt.ok, true, receipt.ok ? '' : receipt.error.code);
  assert.equal(receipt.value.outboxStatus, 'posted');
  const asOf = (await observer.query('SELECT clock_timestamp() AS as_of')).rows[0].as_of.toISOString();
  const result = await projection(scope, ports, asOf);
  assert.equal(result.eventCount, 1);
  assert.equal(result.amounts[0].totalAmount, '0.000003');
  assert.deepEqual(result.unresolvedIntake, {
    unknownEconomicExposureCount: 0, quarantinedObservationCount: 0,
    awaitingEvidenceAttemptCount: 1, unpostedAttemptCount: 0,
  }, 'known priced partial usage stays a single known charge while its intake completeness remains visible');
  assert.equal(result.quantities.find(row => row.unitName === 'cached_tokens')?.includedIn, 'input_tokens');
  assert.equal(result.quantities.find(row => row.unitName === 'reasoning_tokens')?.includedIn, 'output_tokens');
  assert.equal(result.quantities.find(row => row.unitName === 'input_tokens')?.knownSubtotal, '7');
  assert.equal(result.quantities.find(row => row.unitName === 'output_tokens')?.knownSubtotal, '4');
});

test('outbox replay scans no more than the 100-row batch limit', async () => {
  const scope = scopeFor();
  const prefix = `ci04a-batch-${randomUUID()}-`;
  const seededInbox = await observer.query(
    `WITH generated(seq) AS (SELECT value::text FROM generate_series(1, 101) AS generated_values(value))
     INSERT INTO cost_intelligence.usage_intake_inbox (
       tenant_id, project_id, environment, billing_mode, source_observation_id, idempotency_key, request_id,
       event_id, logical_operation_id, provider_attempt_id, billable_attempt_id, transport_attempt_id,
       source_name, occurred_at, observed_at, completeness, valuation_basis,
       payload_sha256, idempotency_sha256, provenance_sha256, event_facts
     )
     SELECT $1, $2, $3, $4, $5 || seq, $6 || seq, $7 || seq,
            $8 || seq, $9 || seq, $10 || seq, $11 || seq, $12 || seq,
            'provider_response', now(), now(), 'complete', 'estimated',
            'sha256:' || md5('batch-payload:' || seq) || md5('batch-payload-extra:' || seq),
            'sha256:' || md5('batch-idem:' || seq) || md5('batch-idem-extra:' || seq),
            'sha256:' || md5('batch-provenance:' || seq) || md5('batch-provenance-extra:' || seq), '{}'::jsonb
     FROM generated`,
    [scope.tenantId, scope.projectId, scope.environment, scope.billingMode,
      prefix, `ci04a-batch-key-${randomUUID()}-`, `ci04a-batch-request-${randomUUID()}-`,
      `ci04a-batch-event-${randomUUID()}-`, `ci04a-batch-operation-${randomUUID()}-`,
      `ci04a-batch-provider-${randomUUID()}-`, `ci04a-batch-billable-${randomUUID()}-`,
      `ci04a-batch-transport-${randomUUID()}-`],
  );
  assert.equal(seededInbox.rowCount, 101);
  const seededAttempts = await observer.query(
    `INSERT INTO cost_intelligence.usage_intake_attempts (
       tenant_id, project_id, environment, billing_mode, billable_attempt_id, logical_operation_id,
       provider_attempt_id, first_observation_id, current_observation_id,
       status, completeness, valuation_basis
     )
     SELECT tenant_id, project_id, environment, billing_mode, billable_attempt_id, logical_operation_id,
            provider_attempt_id, source_observation_id, source_observation_id,
            'pending', completeness, valuation_basis
     FROM cost_intelligence.usage_intake_inbox
     WHERE tenant_id=$1 AND project_id=$2 AND environment=$3 AND billing_mode=$4
       AND source_observation_id LIKE $5 || '%'`,
    [scope.tenantId, scope.projectId, scope.environment, scope.billingMode, prefix],
  );
  assert.equal(seededAttempts.rowCount, 101);
  const seededOutbox = await observer.query(
    `INSERT INTO cost_intelligence.usage_intake_outbox (
       tenant_id, project_id, environment, billing_mode, source_observation_id,
       billable_attempt_id, posting_payload, status
     )
     SELECT tenant_id, project_id, environment, billing_mode, source_observation_id,
            billable_attempt_id, '{"not_a_valid_ledger_request":true}'::jsonb, 'pending'
     FROM cost_intelligence.usage_intake_inbox
     WHERE tenant_id=$1 AND project_id=$2 AND environment=$3 AND billing_mode=$4
       AND source_observation_id LIKE $5 || '%'`,
    [scope.tenantId, scope.projectId, scope.environment, scope.billingMode, prefix],
  );
  assert.equal(seededOutbox.rowCount, 101);

  const replay = await replayUsageOutbox({
    schemaVersion: '1.0.0', requestId: `ci04a-batch-replay-${randomUUID()}`, scope, limit: 100,
  }, portsFor(scope));
  assert.equal(replay.ok, true, replay.ok ? '' : replay.error.code);
  assert.deepEqual({ scanned: replay.value.scanned, posted: replay.value.posted,
    retried: replay.value.retried, deadLettered: replay.value.deadLettered },
  { scanned: 100, posted: 0, retried: 0, deadLettered: 100 });
  const remaining = await observer.query(
    `SELECT status, count(*)::integer AS count FROM cost_intelligence.usage_intake_outbox
     WHERE tenant_id=$1 AND project_id=$2 AND environment=$3 AND billing_mode=$4
       AND source_observation_id LIKE $5 || '%' GROUP BY status ORDER BY status`,
    [scope.tenantId, scope.projectId, scope.environment, scope.billingMode, prefix],
  );
  assert.deepEqual(remaining.rows.map(row => ({ status: row.status, count: row.count })), [
    { status: 'dead_letter', count: 100 }, { status: 'pending', count: 1 },
  ], 'one outbox row remains after the maximum 100-row replay batch');
  assert.deepEqual(await scopedCounts(scope), {
    inbox: 101, attempts: 101, outbox: 101, ledger_history: 0,
    effective_events: 0, effective_amount: '0',
  }, 'invalid synthetic posting payloads are dead-lettered without a financial effect');
});

test('per-scope pending posting admission is capped at 1,000 durable intents', async () => {
  const scope = scopeFor();
  const acceptedRequest = observation(scope);
  const accepted = await ingestUsage(acceptedRequest, portsFor(scope));
  assert.equal(accepted.ok, true, accepted.ok ? '' : accepted.error.code);
  assert.equal(accepted.value.outboxStatus, 'posted');

  const sourcePrefix = `ci04a-limit-source-${randomUUID()}-`;
  const insertedInbox = await observer.query(
    `WITH generated(seq) AS (SELECT value::text FROM generate_series(1, $13::integer) AS generated_values(value))
     INSERT INTO cost_intelligence.usage_intake_inbox (
       tenant_id, project_id, environment, billing_mode, source_observation_id, idempotency_key, request_id,
       event_id, logical_operation_id, provider_attempt_id, billable_attempt_id, transport_attempt_id,
       provider_request_id, source_name, occurred_at, observed_at, completeness, valuation_basis,
       payload_sha256, idempotency_sha256, provenance_sha256, event_facts
     )
     SELECT $1, $2, $3, $4, $5 || seq, $6 || seq, $7 || seq,
            $8 || seq, $9, $10, $11, $12 || seq, NULL,
            'provider_response', now(), now(), 'complete', 'estimated',
            'sha256:' || md5('payload:' || seq) || md5('payload-extra:' || seq),
            'sha256:' || md5('idempotency:' || seq) || md5('idempotency-extra:' || seq),
            'sha256:' || md5('provenance:' || seq) || md5('provenance-extra:' || seq),
            jsonb_build_object('event_id', $8 || seq, 'source_observation_id', $5 || seq)
     FROM generated`,
    [scope.tenantId, scope.projectId, scope.environment, scope.billingMode,
      sourcePrefix, `ci04a-limit-key-${randomUUID()}-`, `ci04a-limit-request-${randomUUID()}-`,
      `ci04a-limit-event-${randomUUID()}-`, acceptedRequest.usageEvent.logical_operation_id,
      acceptedRequest.usageEvent.provider_attempt_id, acceptedRequest.usageEvent.billable_attempt_id,
      `ci04a-limit-transport-${randomUUID()}-`, 1_000],
  );
  assert.equal(insertedInbox.rowCount, 1_000);
  const insertedOutbox = await observer.query(
    `INSERT INTO cost_intelligence.usage_intake_outbox
       (tenant_id, project_id, environment, billing_mode, source_observation_id, billable_attempt_id, status)
     SELECT tenant_id, project_id, environment, billing_mode, source_observation_id, billable_attempt_id, 'pending'
     FROM cost_intelligence.usage_intake_inbox
     WHERE tenant_id=$1 AND project_id=$2 AND environment=$3 AND billing_mode=$4
       AND source_observation_id LIKE $5 || '%'`,
    [scope.tenantId, scope.projectId, scope.environment, scope.billingMode, sourcePrefix],
  );
  assert.equal(insertedOutbox.rowCount, 1_000);

  const overflow = await ingestUsage(observation(scope), portsFor(scope));
  assert.equal(overflow.ok, false);
  if (!overflow.ok) {
    assert.equal(overflow.error.code, 'SOURCE_UNAVAILABLE');
    assert.match(overflow.error.safe_message, /queue is full/);
  }
  assert.deepEqual(await scopedCounts(scope), {
    inbox: 1_001, attempts: 1, outbox: 1_001, ledger_history: 1, effective_events: 1, effective_amount: '0.000003',
  }, 'the rejected overflow leaves the accepted economic event unchanged and adds no new source record');
});

test('transactional ledger failure leaves durable retry outbox; bounded recovery posts one effect', async () => {
  const scope = scopeFor();
  let injectOnce = true;
  const faultDatabase = {
    connect: async () => {
      const client = await runtime.connect();
      return {
        query: async (text, values) => {
          if (injectOnce && /^INSERT INTO cost_intelligence\.financial_ledger_events/i.test(text)) {
            injectOnce = false;
            throw new Error('ci04a synthetic pre-insert fault');
          }
          return client.query(text, values);
        },
        release: () => client.release(),
      };
    },
  };
  const request = observation(scope);
  const accepted = await ingestUsage(request, portsFor(scope, faultDatabase));
  assert.equal(accepted.ok, true, accepted.ok ? '' : accepted.error.code);
  assert.equal(accepted.value.durableCommit, true);
  assert.equal(accepted.value.outboxStatus, 'retry');
  assert.deepEqual(await scopedCounts(scope), {
    inbox: 1, attempts: 1, outbox: 1, ledger_history: 0, effective_events: 0, effective_amount: '0',
  });
  const before = (await outboxRows(scope))[0];
  assert.equal(before.status, 'retry');
  assert.equal(before.retry_count, 1);
  assert.equal(before.last_error_code, 'source_unavailable');
  await observer.query(
    `UPDATE cost_intelligence.usage_intake_outbox SET available_at=now()-interval '1 second'
     WHERE tenant_id=$1 AND project_id=$2`, [scope.tenantId, scope.projectId],
  );
  const replay = await replayUsageOutbox({ schemaVersion: '1.0.0', requestId: `ci04a-drain-${randomUUID()}`, scope, limit: 10 }, portsFor(scope));
  assert.equal(replay.ok, true, replay.ok ? '' : replay.error.code);
  assert.equal(replay.value.scanned, 1);
  assert.equal(replay.value.posted, 1);
  assert.equal(replay.value.durableCommit, true);
  assert.deepEqual(await scopedCounts(scope), {
    inbox: 1, attempts: 1, outbox: 1, ledger_history: 1, effective_events: 1, effective_amount: '0.000003',
  });
  assert.equal((await outboxRows(scope))[0].status, 'posted');
});

test('posting retry uses bounded exponential backoff and dead-letters after five attempts', async () => {
  const scope = scopeFor();
  let postingAttempts = 0;
  const failingDatabase = {
    connect: async () => {
      const client = await runtime.connect();
      return {
        query: async (text, values) => {
          if (/^INSERT INTO cost_intelligence\.financial_ledger_events/i.test(text)) {
            postingAttempts++;
            throw new Error('ci04a synthetic repeated pre-insert failure');
          }
          return client.query(text, values);
        },
        release: () => client.release(),
      };
    },
  };
  const request = observation(scope);
  const accepted = await ingestUsage(request, portsFor(scope, failingDatabase));
  assert.equal(accepted.ok, true, accepted.ok ? '' : accepted.error.code);
  assert.equal(accepted.value.outboxStatus, 'retry');
  const initialRow = (await outboxRows(scope))[0];
  assert.equal(initialRow.retry_count, 1);
  assert.ok(Date.parse(initialRow.available_at) - Date.now() >= 1_000
    && Date.parse(initialRow.available_at) - Date.now() <= 4_000, 'first retry is scheduled about two seconds later');

  for (const [index, expectedDelaySeconds] of [4, 8, 16].entries()) {
    await observer.query(
      `UPDATE cost_intelligence.usage_intake_outbox SET available_at=now()-interval '1 second'
       WHERE tenant_id=$1 AND project_id=$2 AND environment=$3 AND billing_mode=$4 AND status='retry'`,
      [scope.tenantId, scope.projectId, scope.environment, scope.billingMode],
    );
    const before = Date.now();
    const replay = await replayUsageOutbox({ schemaVersion: '1.0.0', requestId: `ci04a-retry-${index}-${randomUUID()}`, scope, limit: 100 },
      portsFor(scope, failingDatabase));
    assert.equal(replay.ok, true, replay.ok ? '' : replay.error.code);
    assert.equal(replay.value.retried, 1);
    const row = (await outboxRows(scope))[0];
    assert.equal(row.retry_count, index + 2);
    const delay = Date.parse(row.available_at) - before;
    assert.ok(delay >= expectedDelaySeconds * 1_000 - 1_000
      && delay <= expectedDelaySeconds * 1_000 + 2_000,
    `retry ${index + 2} uses an approximately ${expectedDelaySeconds}s bounded delay`);
  }

  await observer.query(
    `UPDATE cost_intelligence.usage_intake_outbox SET available_at=now()-interval '1 second'
     WHERE tenant_id=$1 AND project_id=$2 AND environment=$3 AND billing_mode=$4 AND status='retry'`,
    [scope.tenantId, scope.projectId, scope.environment, scope.billingMode],
  );
  const finalReplay = await replayUsageOutbox({ schemaVersion: '1.0.0', requestId: `ci04a-retry-final-${randomUUID()}`, scope, limit: 100 },
    portsFor(scope, failingDatabase));
  assert.equal(finalReplay.ok, true, finalReplay.ok ? '' : finalReplay.error.code);
  assert.equal(finalReplay.value.deadLettered, 1);
  const dead = (await outboxRows(scope))[0];
  assert.equal(postingAttempts, 5);
  assert.equal(dead.status, 'dead_letter');
  assert.equal(dead.retry_count, 4, 'retry_count records four replays after the initial fifth failed posting attempt');
  assert.equal(dead.last_error_code, 'outbox_expired');
  assert.deepEqual(await scopedCounts(scope), {
    inbox: 1, attempts: 1, outbox: 1, ledger_history: 0, effective_events: 0, effective_amount: '0',
  }, 'exhausted retries retain the durable evidence without creating a partial ledger charge');
});

test('process death during outbox replay rolls posting back and a later replay posts exactly once', async () => {
  const scope = scopeFor();
  let injectOnce = true;
  const faultDatabase = {
    connect: async () => {
      const client = await runtime.connect();
      return {
        query: async (text, values) => {
          if (injectOnce && /^INSERT INTO cost_intelligence\.financial_ledger_events/i.test(text)) {
            injectOnce = false;
            throw new Error('ci04a synthetic pre-insert fault');
          }
          return client.query(text, values);
        },
        release: () => client.release(),
      };
    },
  };
  const request = observation(scope);
  const accepted = await ingestUsage(request, portsFor(scope, faultDatabase));
  assert.equal(accepted.ok, true, accepted.ok ? '' : accepted.error.code);
  assert.equal(accepted.value.outboxStatus, 'retry');
  await observer.query(
    `UPDATE cost_intelligence.usage_intake_outbox SET available_at=now()-interval '1 second'
     WHERE tenant_id=$1 AND project_id=$2`, [scope.tenantId, scope.projectId],
  );

  await crashDuringReplay(scope);
  assert.deepEqual(await scopedCounts(scope), {
    inbox: 1, attempts: 1, outbox: 1, ledger_history: 0, effective_events: 0, effective_amount: '0',
  }, 'the child died after the ledger insert inside replay but before commit, so PostgreSQL rolled it back');
  const afterCrash = (await outboxRows(scope))[0];
  assert.equal(afterCrash.status, 'retry');
  assert.equal(afterCrash.retry_count, 1, 'the killed transaction did not consume a retry attempt');

  await observer.query(
    `UPDATE cost_intelligence.usage_intake_outbox SET available_at=now()-interval '1 second'
     WHERE tenant_id=$1 AND project_id=$2`, [scope.tenantId, scope.projectId],
  );
  const replay = await replayUsageOutbox({ schemaVersion: '1.0.0', requestId: `ci04a-post-crash-${randomUUID()}`, scope, limit: 100 }, portsFor(scope));
  assert.equal(replay.ok, true, replay.ok ? '' : replay.error.code);
  assert.deepEqual({ scanned: replay.value.scanned, posted: replay.value.posted, retried: replay.value.retried },
    { scanned: 1, posted: 1, retried: 0 });
  assert.deepEqual(await scopedCounts(scope), {
    inbox: 1, attempts: 1, outbox: 1, ledger_history: 1, effective_events: 1, effective_amount: '0.000003',
  });
});

test('process death before commit rolls back; death after commit loses only acknowledgement and replay is idempotent', async () => {
  const beforeScope = scopeFor();
  const beforeRequest = observation(beforeScope);
  await crashAtCommit('before_commit', beforeRequest);
  assert.deepEqual(await scopedCounts(beforeScope), {
    inbox: 0, attempts: 0, outbox: 0, ledger_history: 0, effective_events: 0, effective_amount: '0',
  }, 'server recovery removes all rows from a killed uncommitted transaction');
  const afterCrash = await ingestUsage(beforeRequest, portsFor(beforeScope));
  assert.equal(afterCrash.ok, true, afterCrash.ok ? '' : afterCrash.error.code);
  assert.equal(afterCrash.value.status, 'accepted');
  assert.deepEqual(await scopedCounts(beforeScope), {
    inbox: 1, attempts: 1, outbox: 1, ledger_history: 1, effective_events: 1, effective_amount: '0.000003',
  });

  const afterScope = scopeFor();
  const afterRequest = observation(afterScope);
  await crashAtCommit('after_commit', afterRequest);
  assert.deepEqual(await scopedCounts(afterScope), {
    inbox: 1, attempts: 1, outbox: 1, ledger_history: 1, effective_events: 1, effective_amount: '0.000003',
  }, 'the commit is visible even though the worker died before returning its receipt');
  const replay = await ingestUsage(afterRequest, portsFor(afterScope));
  assert.equal(replay.ok, true, replay.ok ? '' : replay.error.code);
  assert.equal(replay.value.status, 'duplicate');
  assert.equal(replay.value.durableCommit, true);
  assert.equal(replay.value.existingEventId.status, 'known');
  assert.deepEqual(await scopedCounts(afterScope), {
    inbox: 1, attempts: 1, outbox: 1, ledger_history: 1, effective_events: 1, effective_amount: '0.000003',
  });
});

test('unauthorized and forged-scope intake requests open no database connection', async () => {
  const scope = scopeFor();
  const request = observation(scope);
  let connects = 0;
  const database = { connect: async () => { connects++; throw new Error('must not connect'); } };
  const deniedPorts = portsFor(scope, database);
  deniedPorts.financeAuthority.authorizeCurrent = async auth => ({ status: 'denied', operation: auth.operation, permission: auth.permission });
  const denied = await ingestUsage(request, deniedPorts);
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.equal(denied.error.code, 'FORBIDDEN_SCOPE');
  const forged = structuredClone(request);
  forged.usageEvent.tenant_id = randomUUID();
  const allowedPorts = portsFor(scope, database);
  const mismatch = await ingestUsage(forged, allowedPorts);
  assert.equal(mismatch.ok, false);
  if (!mismatch.ok) assert.equal(mismatch.error.code, 'FORBIDDEN_SCOPE');
  assert.equal(connects, 0);
});
