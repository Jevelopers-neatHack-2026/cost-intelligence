// CI-05B reconciliation acceptance: aging unresolved holds into the queue with
// owner/next-action/evidence, verified no-bill releases, confirmed-expense
// settlements, over-cap variance recorded in full (never truncated), partial
// settle-and-release conservation, and idempotent/typed-conflict resolutions.
// Runs against a real disposable PostgreSQL.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  authorizeReservation, markReservationDispatched, settleReservation, releaseReservation,
  expireReservation, runRecoveryScan, listReconciliationExceptions, resolveReconciliationException, readCapacity,
} from '../../dist/index.js';
import {
  loadReserveFixture, setBudgetLimit, reservationPool, makePorts, makeScope, reservationRequest,
  markDispatchedCommand, settleCommand, releaseCommand, expireCommand, recoveryScanRequest,
  resolveReconciliationRequest, clockAt,
} from '../budgets/reservation-harness.mjs';

const fixturePromise = loadReserveFixture();
const T0 = '2026-10-12T04:00:00.000Z';
const LEASE_EXP = '2026-10-12T04:30:00.000Z';
const T_AFTER = '2026-10-12T05:00:00.000Z';

function ports(pool, scope, extra = {}) {
  const { financialExpiryMs, ...rest } = extra;
  const base = makePorts(pool, scope, rest);
  return financialExpiryMs === undefined ? base : { ...base, financialExpiryMs };
}
function requireDb() {
  assert.ok(process.env.CI_TEST_DB_RUNTIME_HOST, 'reconciliation suite requires the restricted disposable PostgreSQL role');
}

async function dispatchedUnknown(pool, scope, reserve, amount) {
  const authorized = await authorizeReservation(reservationRequest(scope, reserve, { amount }), ports(pool, scope, { clock: clockAt(T0) }));
  const id = authorized.value.reservationId;
  const own = authorized.value.attemptBinding;
  const d = markDispatchedCommand(scope, id, 1, { attemptBinding: own });
  d.workerLeaseExpiresAt = LEASE_EXP; d.workerLeaseId = 'ci05b-recon-lease';
  assert.equal((await markReservationDispatched(d, ports(pool, scope, { clock: clockAt(T0) }))).ok, true);
  return { id, own };
}

test('CI-05B.4 recovery ages an unresolved hold into the queue with owner, next action and evidence', async () => {
  requireDb();
  const reserve = await fixturePromise;
  const pool = reservationPool(8);
  try {
    const scope = makeScope('recon-queue');
    await setBudgetLimit(pool, scope, '5.00');
    const { id } = await dispatchedUnknown(pool, scope, reserve, '1.00');
    const scan = await runRecoveryScan(recoveryScanRequest(scope, { agingThresholdMs: 0, ownerRole: 'finance-reliability' }), ports(pool, scope, { clock: clockAt(T_AFTER) }));
    assert.equal(scan.ok, true, scan.ok ? '' : scan.error.code);
    assert.equal(scan.value.opened, 1);
    const queue = await listReconciliationExceptions(scope, 'queue', ports(pool, scope, { clock: clockAt(T_AFTER) }));
    assert.equal(queue.value.exceptions.length, 1);
    const entry = queue.value.exceptions[0];
    assert.equal(entry.reservationId, id);
    assert.equal(entry.ownerRole, 'finance-reliability');
    assert.ok(entry.nextAction.length > 0, 'the exception carries an explicit next action');
    assert.ok(entry.evidence && entry.evidence.scanId, 'the exception carries scan evidence');
    assert.equal(entry.outstandingHold, '1', 'the full unresolved hold is recorded; nothing is released');
  } finally {
    await pool.end();
  }
});

test('CI-05B.4 a verified no-bill outcome is released by a fenced expiry and the exception resolves', async () => {
  requireDb();
  const reserve = await fixturePromise;
  const pool = reservationPool(8);
  try {
    const scope = makeScope('recon-nobill');
    await setBudgetLimit(pool, scope, '2.00');
    // Never-dispatched hold with a matured financial expiry: recovery flags it, expiry frees it.
    const authorized = await authorizeReservation(reservationRequest(scope, reserve, { amount: '1.00' }), ports(pool, scope, { clock: clockAt(T0), financialExpiryMs: 60_000 }));
    const id = authorized.value.reservationId;
    const own = authorized.value.attemptBinding;
    const scan = await runRecoveryScan(recoveryScanRequest(scope, { agingThresholdMs: 0 }), ports(pool, scope, { clock: clockAt(T_AFTER) }));
    assert.equal(scan.value.opened, 1);
    assert.equal(scan.value.entries[0].category, 'never_dispatched_financial_expiry');

    const expired = await expireReservation(expireCommand(scope, id, 1, { reason: 'financial_expiry', attemptBinding: own }), ports(pool, scope, { clock: clockAt(T_AFTER) }));
    assert.equal(expired.ok, true, expired.ok ? '' : expired.error.code);
    const resolved = await resolveReconciliationException(resolveReconciliationRequest(scope, id, { disposition: 'verified_no_bill_released', resolution: 'no provider bill; hold fenced and expired', nextAction: 'close' }), ports(pool, scope, { clock: clockAt(T_AFTER) }));
    assert.equal(resolved.ok, true, resolved.ok ? '' : resolved.error.code);
    assert.equal(resolved.value.status, 'resolved');
    assert.equal(resolved.value.disposition, 'verified_no_bill_released');

    const queue = await listReconciliationExceptions(scope, 'queue', ports(pool, scope, { clock: clockAt(T_AFTER) }));
    assert.equal(queue.value.exceptions.length, 0, 'a resolved exception leaves the open queue');
    const capacity = await readCapacity(scope, 'USD', 'nobill-cap', ports(pool, scope, { clock: clockAt(T_AFTER) }));
    assert.equal(capacity.value.availableCapacity, '2');
    assert.equal(capacity.value.effectiveConsumedSpend, '0', 'a verified no-bill outcome records no spend');
  } finally {
    await pool.end();
  }
});

test('CI-05B.4 a confirmed expense settles and the exception resolves with linked evidence', async () => {
  requireDb();
  const reserve = await fixturePromise;
  const pool = reservationPool(8);
  try {
    const scope = makeScope('recon-expense');
    await setBudgetLimit(pool, scope, '5.00');
    const { id, own } = await dispatchedUnknown(pool, scope, reserve, '2.00');
    await runRecoveryScan(recoveryScanRequest(scope, { agingThresholdMs: 0 }), ports(pool, scope, { clock: clockAt(T_AFTER) }));
    const settled = await settleReservation(settleCommand(scope, id, 2, { cumulativeAmount: '1.500000', finality: 'final', sequence: 1, attemptBinding: own }), ports(pool, scope, { clock: clockAt(T_AFTER) }));
    assert.equal(settled.ok, true, settled.ok ? '' : settled.error.code);
    const resolved = await resolveReconciliationException(resolveReconciliationRequest(scope, id, { disposition: 'confirmed_expense_settled', resolution: 'provider confirmed 1.50', nextAction: 'post expense' }), ports(pool, scope, { clock: clockAt(T_AFTER) }));
    assert.equal(resolved.ok, true, resolved.ok ? '' : resolved.error.code);
    assert.equal(resolved.value.status, 'resolved');
    const capacity = await readCapacity(scope, 'USD', 'expense-cap', ports(pool, scope, { clock: clockAt(T_AFTER) }));
    assert.equal(capacity.value.effectiveConsumedSpend, '1.5', 'the confirmed expense is the settled consumption');
  } finally {
    await pool.end();
  }
});

test('CI-05B.4 an over-cap actual cost is recorded in full and raised as a variance, never truncated to the reservation', async () => {
  requireDb();
  const reserve = await fixturePromise;
  const pool = reservationPool(8);
  try {
    const scope = makeScope('recon-overcap');
    await setBudgetLimit(pool, scope, '5.00');
    const authorized = await authorizeReservation(reservationRequest(scope, reserve, { amount: '1.00' }), ports(pool, scope));
    const id = authorized.value.reservationId;
    const own = authorized.value.attemptBinding;
    assert.equal((await markReservationDispatched(markDispatchedCommand(scope, id, 1, { attemptBinding: own }), ports(pool, scope))).ok, true);
    // Settle 1.10 against a 1.00 hold.
    const settled = await settleReservation(settleCommand(scope, id, 2, { cumulativeAmount: '1.100000', finality: 'final', sequence: 1, attemptBinding: own }), ports(pool, scope));
    assert.equal(settled.ok, true, settled.ok ? '' : settled.error.code);
    assert.equal(settled.value.consumedAmount, '1.1', 'the full observed spend is recorded, not clamped to the hold');
    assert.equal(settled.value.overrunAmount, '0.1', 'the over-cap amount surfaces as a variance');
    const capacity = await readCapacity(scope, 'USD', 'overcap-cap', ports(pool, scope));
    assert.equal(capacity.value.effectiveConsumedSpend, '1.1');
    assert.equal(capacity.value.usedCapacity, '1.1', 'the real over-cap cost reduces remaining capacity');
    assert.equal(capacity.value.availableCapacity, '3.9');
    const resolved = await resolveReconciliationException(resolveReconciliationRequest(scope, id, { disposition: 'over_cap_variance_recorded', resolution: 'actual exceeded reservation by 0.10', nextAction: 'reduce future capacity' }), ports(pool, scope));
    // No open exception for this reservation (it was never aged), so resolution reports not_open without inventing one.
    assert.equal(resolved.ok, true, resolved.ok ? '' : resolved.error.code);
    assert.equal(resolved.value.status, 'not_open');
  } finally {
    await pool.end();
  }
});

test('CI-05B.2 a partial final settlement releases exactly the known-unused portion, conserving capacity', async () => {
  requireDb();
  const reserve = await fixturePromise;
  const pool = reservationPool(8);
  try {
    const scope = makeScope('recon-partial');
    await setBudgetLimit(pool, scope, '5.00');
    const authorized = await authorizeReservation(reservationRequest(scope, reserve, { amount: '1.00' }), ports(pool, scope));
    const id = authorized.value.reservationId;
    const own = authorized.value.attemptBinding;
    assert.equal((await markReservationDispatched(markDispatchedCommand(scope, id, 1, { attemptBinding: own }), ports(pool, scope))).ok, true);
    const settled = await settleReservation(settleCommand(scope, id, 2, { cumulativeAmount: '0.600000', finality: 'final', sequence: 1, attemptBinding: own }), ports(pool, scope));
    assert.equal(settled.value.consumedAmount, '0.6');
    const released = await releaseReservation(releaseCommand(scope, id, 3, { amount: '0.400000', proof: 'final_usage_known', attemptBinding: own }), ports(pool, scope));
    assert.equal(released.ok, true, released.ok ? '' : released.error.code);
    assert.equal(released.value.releasedAmount, '0.4');
    const capacity = await readCapacity(scope, 'USD', 'partial-cap', ports(pool, scope));
    assert.equal(capacity.value.effectiveConsumedSpend, '0.6', 'consumed is 0.60');
    assert.equal(capacity.value.outstandingHolds, '0', 'the unused 0.40 is released');
    assert.equal(capacity.value.availableCapacity, '4.4');
  } finally {
    await pool.end();
  }
});

test('CI-05B.2 reconciliation resolutions are idempotent and reject a reused key for a different disposition', async () => {
  requireDb();
  const reserve = await fixturePromise;
  const pool = reservationPool(8);
  try {
    const scope = makeScope('recon-idem');
    await setBudgetLimit(pool, scope, '3.00');
    const { id } = await dispatchedUnknown(pool, scope, reserve, '1.00');
    await runRecoveryScan(recoveryScanRequest(scope, { agingThresholdMs: 0 }), ports(pool, scope, { clock: clockAt(T_AFTER) }));
    const request = resolveReconciliationRequest(scope, id, { disposition: 'held_for_reconciliation', resolution: 'await provider', nextAction: 'revisit' });
    const first = await resolveReconciliationException(request, ports(pool, scope, { clock: clockAt(T_AFTER) }));
    assert.equal(first.value.status, 'resolved');
    const replay = await resolveReconciliationException(request, ports(pool, scope, { clock: clockAt(T_AFTER) }));
    assert.equal(replay.value.status, 'replay', 'the identical resolution replays');
    const conflict = await resolveReconciliationException({ ...request, disposition: 'verified_no_bill_released' }, ports(pool, scope, { clock: clockAt(T_AFTER) }));
    assert.equal(conflict.ok, false);
    assert.equal(conflict.error.code, 'IDEMPOTENCY_CONFLICT');
  } finally {
    await pool.end();
  }
});

test('CI-05B.4/defect-a a quiet partially-settled (unknown finality) hold is aged into the queue and its unused remainder is reclaimed', async () => {
  requireDb();
  const reserve = await fixturePromise;
  const pool = reservationPool(8);
  try {
    const scope = makeScope('recon-partialsettle-leak');
    await setBudgetLimit(pool, scope, '5.00');
    const authorized = await authorizeReservation(reservationRequest(scope, reserve, { amount: '1.00' }), ports(pool, scope, { clock: clockAt(T0) }));
    const id = authorized.value.reservationId;
    const own = authorized.value.attemptBinding;
    assert.equal((await markReservationDispatched(markDispatchedCommand(scope, id, 1, { attemptBinding: own }), ports(pool, scope, { clock: clockAt(T0) }))).ok, true);
    // Settle 0.60 of a 1.00 hold with UNKNOWN usage completeness -> finality projects
    // 'unknown' (the per-token provider default). 0.40 stays reserved; the hold then goes quiet.
    const settled = await settleReservation(settleCommand(scope, id, 2, { cumulativeAmount: '0.600000', finality: 'partial', usageCompleteness: 'unknown', sequence: 1, attemptBinding: own }), ports(pool, scope, { clock: clockAt(T0) }));
    assert.equal(settled.ok, true, settled.ok ? '' : settled.error.code);
    assert.equal(settled.value.usageFinality, 'unknown', 'unknown completeness keeps the settlement non-final');
    assert.equal(settled.value.state, 'partially_settled');

    const before = await readCapacity(scope, 'USD', 'leak-before', ports(pool, scope, { clock: clockAt(T_AFTER) }));
    assert.equal(before.value.outstandingHolds, '0.4', 'the unused 0.40 is still reserved before recovery');

    // The quiet partial settlement MUST be aged into the reconciliation queue (regression for the leak).
    const scan = await runRecoveryScan(recoveryScanRequest(scope, { agingThresholdMs: 0 }), ports(pool, scope, { clock: clockAt(T_AFTER) }));
    assert.equal(scan.ok, true, scan.ok ? '' : scan.error.code);
    assert.equal(scan.value.opened, 1, 'a quiet partially-settled hold is no longer invisible to recovery');
    assert.equal(scan.value.entries[0].category, 'partially_settled_outstanding');
    assert.equal(scan.value.entries[0].outstandingHold, '0.4');

    // Resolving as a confirmed expense releases the unused remainder: capacity reclaimed, spend preserved.
    const resolved = await resolveReconciliationException(resolveReconciliationRequest(scope, id, { disposition: 'confirmed_expense_settled', resolution: 'final per-key usage was 0.60; remainder reclaimed', nextAction: 'close' }), ports(pool, scope, { clock: clockAt(T_AFTER) }));
    assert.equal(resolved.ok, true, resolved.ok ? '' : resolved.error.code);
    assert.equal(resolved.value.status, 'resolved');
    assert.equal(resolved.value.outstandingHold, '0', 'the unused remainder is no longer reserved');

    const after = await readCapacity(scope, 'USD', 'leak-after', ports(pool, scope, { clock: clockAt(T_AFTER) }));
    assert.equal(after.value.outstandingHolds, '0', 'the remainder is reclaimed; nothing is reserved forever');
    assert.equal(after.value.effectiveConsumedSpend, '0.6', 'the confirmed expense is preserved, not truncated or inflated');
    assert.equal(after.value.availableCapacity, '4.4');
  } finally {
    await pool.end();
  }
});

test('CI-05B.4/defect-c a verified-no-bill resolution itself releases the stuck hold and restores capacity (idempotent)', async () => {
  requireDb();
  const reserve = await fixturePromise;
  const pool = reservationPool(8);
  try {
    const scope = makeScope('recon-nobill-move');
    await setBudgetLimit(pool, scope, '3.00');
    const { id } = await dispatchedUnknown(pool, scope, reserve, '1.00');
    await runRecoveryScan(recoveryScanRequest(scope, { agingThresholdMs: 0 }), ports(pool, scope, { clock: clockAt(T_AFTER) }));
    const before = await readCapacity(scope, 'USD', 'nobill-before', ports(pool, scope, { clock: clockAt(T_AFTER) }));
    assert.equal(before.value.availableCapacity, '2', 'the unknown hold still reserves capacity before resolution');
    // No separate release/expiry: the resolution ITSELF moves the money.
    const req = resolveReconciliationRequest(scope, id, { disposition: 'verified_no_bill_released', resolution: 'provider confirmed no charge', nextAction: 'close' });
    const resolved = await resolveReconciliationException(req, ports(pool, scope, { clock: clockAt(T_AFTER) }));
    assert.equal(resolved.ok, true, resolved.ok ? '' : resolved.error.code);
    assert.equal(resolved.value.status, 'resolved');
    assert.equal(resolved.value.reservationState, 'released', 'the resolution released the hold');
    assert.equal(resolved.value.outstandingHold, '0');
    const after = await readCapacity(scope, 'USD', 'nobill-after', ports(pool, scope, { clock: clockAt(T_AFTER) }));
    assert.equal(after.value.availableCapacity, '3', 'the verified no-bill resolution reclaimed the full hold');
    assert.equal(after.value.effectiveConsumedSpend, '0', 'a no-bill outcome records no spend');
    // Idempotent: the same resolution replays and never double-releases.
    const replay = await resolveReconciliationException(req, ports(pool, scope, { clock: clockAt(T_AFTER) }));
    assert.equal(replay.value.status, 'replay');
    const after2 = await readCapacity(scope, 'USD', 'nobill-after2', ports(pool, scope, { clock: clockAt(T_AFTER) }));
    assert.equal(after2.value.availableCapacity, '3', 'the replay does not re-release');
  } finally {
    await pool.end();
  }
});

test('CI-05B.4/defect-c a confirmed-expense resolution settles, appends a linked ledger posting, and releases the remainder (idempotent)', async () => {
  requireDb();
  const reserve = await fixturePromise;
  const pool = reservationPool(8);
  try {
    const scope = makeScope('recon-expense-move');
    await setBudgetLimit(pool, scope, '5.00');
    const { id, own } = await dispatchedUnknown(pool, scope, reserve, '2.00');
    await runRecoveryScan(recoveryScanRequest(scope, { agingThresholdMs: 0 }), ports(pool, scope, { clock: clockAt(T_AFTER) }));
    // The confirmed expense is settled first (1.50 final), leaving 0.50 unused.
    await settleReservation(settleCommand(scope, id, 2, { cumulativeAmount: '1.500000', finality: 'final', sequence: 1, attemptBinding: own }), ports(pool, scope, { clock: clockAt(T_AFTER) }));
    const req = resolveReconciliationRequest(scope, id, { disposition: 'confirmed_expense_settled', resolution: 'provider confirmed 1.50', nextAction: 'post expense' });
    const resolved = await resolveReconciliationException(req, ports(pool, scope, { clock: clockAt(T_AFTER) }));
    assert.equal(resolved.ok, true, resolved.ok ? '' : resolved.error.code);
    assert.equal(resolved.value.status, 'resolved');
    assert.equal(resolved.value.outstandingHold, '0', 'the unused remainder is released by the resolution');
    // The resolution appended a linked budget-ledger posting, recorded in the exception evidence.
    const resolvedRow = await pool.query(
      `SELECT evidence FROM cost_intelligence.budget_reconciliation_exceptions WHERE reservation_id = $1 AND status = 'resolved'`,
      [id],
    );
    assert.equal(resolvedRow.rows.length, 1);
    const evidence = typeof resolvedRow.rows[0].evidence === 'string' ? JSON.parse(resolvedRow.rows[0].evidence) : resolvedRow.rows[0].evidence;
    assert.ok(evidence.linkedPostingEventId, 'the resolution links a budget-ledger posting event id');
    const posting = await pool.query(
      `SELECT event_type FROM cost_intelligence.budget_reservation_events WHERE reservation_event_id = $1`,
      [evidence.linkedPostingEventId],
    );
    assert.equal(posting.rows.length, 1, 'the linked posting exists in the append-only budget ledger');
    assert.equal(posting.rows[0].event_type, 'released');
    const after = await readCapacity(scope, 'USD', 'expense-move-cap', ports(pool, scope, { clock: clockAt(T_AFTER) }));
    assert.equal(after.value.effectiveConsumedSpend, '1.5', 'the confirmed expense is recorded in full');
    assert.equal(after.value.outstandingHolds, '0', 'the unused remainder is reclaimed');
    // Idempotent: the same resolution replays and never re-posts or re-releases.
    const replay = await resolveReconciliationException(req, ports(pool, scope, { clock: clockAt(T_AFTER) }));
    assert.equal(replay.value.status, 'replay');
    const after2 = await readCapacity(scope, 'USD', 'expense-move-cap2', ports(pool, scope, { clock: clockAt(T_AFTER) }));
    assert.equal(after2.value.effectiveConsumedSpend, '1.5');
    assert.equal(after2.value.outstandingHolds, '0');
  } finally {
    await pool.end();
  }
});
