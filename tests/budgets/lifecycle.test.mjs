import assert from 'node:assert/strict';
import test from 'node:test';
import {
  authorizeReservation, changeBudgetPolicy, readCapacity,
  markReservationDispatched, settleReservation, releaseReservation,
} from '../../dist/index.js';
import {
  loadReserveFixture, reservationPool, makePorts, makeScope, policyChange, reservationRequest,
  markDispatchedCommand, settleCommand, releaseCommand,
} from './reservation-harness.mjs';

const fixturePromise = loadReserveFixture();

async function setLimit(pool, scope, limitAmount) {
  const receipt = await changeBudgetPolicy(policyChange(scope, { limitAmount }), makePorts(pool, scope));
  assert.equal(receipt.ok, true, receipt.ok ? '' : `${receipt.error.code}: ${receipt.error.safe_message}`);
  return receipt.value;
}

test('CI-05A.2/.4 full reservation lifecycle settles without double-counting and conserves capacity', async () => {
  assert.ok(process.env.CI_TEST_DB_RUNTIME_HOST, 'lifecycle suite requires the restricted disposable PostgreSQL role');
  const reserve = await fixturePromise;
  const pool = reservationPool(8);
  try {
    const scope = makeScope('lifecycle');
    await setLimit(pool, scope, '10.00');
    const authorized = await authorizeReservation(reservationRequest(scope, reserve, { amount: '2.00' }), makePorts(pool, scope));
    assert.equal(authorized.ok, true, authorized.ok ? '' : authorized.error.code);
    assert.equal(authorized.value.status, 'authorized');
    const reservationId = authorized.value.reservationId;

    const dispatched = await markReservationDispatched(markDispatchedCommand(scope, reservationId, 1), makePorts(pool, scope));
    assert.equal(dispatched.ok, true, dispatched.ok ? '' : dispatched.error.code);
    assert.equal(dispatched.value.status, 'applied');
    assert.equal(dispatched.value.state, 'dispatched');
    assert.equal(dispatched.value.revision, 2);

    const partial = await settleReservation(settleCommand(scope, reservationId, 2, { cumulativeAmount: '0.500000', finality: 'partial', sequence: 1 }), makePorts(pool, scope));
    assert.equal(partial.ok, true, partial.ok ? '' : `${partial.error.code}: ${partial.error.safe_message}`);
    assert.equal(partial.value.state, 'partially_settled');
    assert.equal(partial.value.consumedAmount, '0.5');

    const final = await settleReservation(settleCommand(scope, reservationId, 3, { cumulativeAmount: '1.200000', finality: 'final', sequence: 2 }), makePorts(pool, scope));
    assert.equal(final.ok, true, final.ok ? '' : final.error.code);
    assert.equal(final.value.state, 'settled');
    assert.equal(final.value.consumedAmount, '1.2');
    // Capacity before releasing the unused remainder still holds the full estimate.
    const beforeRelease = await readCapacity(scope, 'USD', 'lifecycle-before', makePorts(pool, scope));
    assert.equal(beforeRelease.value.usedCapacity, '2', 'the hold stands until the unused remainder is released');

    const released = await releaseReservation(releaseCommand(scope, reservationId, 4, { amount: '0.800000', proof: 'final_usage_known' }), makePorts(pool, scope));
    assert.equal(released.ok, true, released.ok ? '' : released.error.code);
    assert.equal(released.value.state, 'released');
    assert.equal(released.value.releasedAmount, '0.8');

    // Effective consumed spend is 1.2; the settled portion is never double-counted with the hold.
    const after = await readCapacity(scope, 'USD', 'lifecycle-after', makePorts(pool, scope));
    assert.equal(after.value.usedCapacity, '1.2');
    assert.equal(after.value.effectiveConsumedSpend, '1.2');
    assert.equal(after.value.outstandingHolds, '0');
    assert.equal(after.value.availableCapacity, '8.8');
  } finally {
    await pool.end();
  }
});

test('CI-05A.1 lifecycle commands enforce the expected revision and are idempotent', async () => {
  const reserve = await fixturePromise;
  const pool = reservationPool(8);
  try {
    const scope = makeScope('revision');
    await setLimit(pool, scope, '10.00');
    const authorized = await authorizeReservation(reservationRequest(scope, reserve, { amount: '1.00' }), makePorts(pool, scope));
    const reservationId = authorized.value.reservationId;

    // A wrong expected revision is reported as a stale-revision conflict, not a mutation.
    const stale = await markReservationDispatched(markDispatchedCommand(scope, reservationId, 5), makePorts(pool, scope));
    assert.equal(stale.ok, true, stale.ok ? '' : stale.error.code);
    assert.equal(stale.value.status, 'stale_revision');
    assert.equal(stale.value.state, 'held', 'a stale command does not advance the reservation');

    // A retried command reuses its idempotency key and does not re-apply.
    const dispatch = markDispatchedCommand(scope, reservationId, 1);
    const firstDispatch = await markReservationDispatched(dispatch, makePorts(pool, scope));
    assert.equal(firstDispatch.value.status, 'applied');
    const replayDispatch = await markReservationDispatched(dispatch, makePorts(pool, scope));
    assert.equal(replayDispatch.value.status, 'replay');
    assert.equal(replayDispatch.value.revision, firstDispatch.value.revision, 'a replayed command does not advance the revision');
  } finally {
    await pool.end();
  }
});

test('CI-05A.2 a release cannot exceed the outstanding hold', async () => {
  const reserve = await fixturePromise;
  const pool = reservationPool(8);
  try {
    const scope = makeScope('over-release');
    await setLimit(pool, scope, '10.00');
    const authorized = await authorizeReservation(reservationRequest(scope, reserve, { amount: '1.00' }), makePorts(pool, scope));
    const reservationId = authorized.value.reservationId;
    const over = await releaseReservation(releaseCommand(scope, reservationId, 1, { amount: '5.000000' }), makePorts(pool, scope));
    assert.equal(over.ok, false);
    if (!over.ok) assert.equal(over.error.code, 'VALIDATION_ERROR');
  } finally {
    await pool.end();
  }
});
