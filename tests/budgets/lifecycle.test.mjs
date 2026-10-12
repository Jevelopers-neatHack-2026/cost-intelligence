import assert from 'node:assert/strict';
import test from 'node:test';
import {
  authorizeReservation, changeBudgetPolicy, readCapacity,
  markReservationDispatched, settleReservation, releaseReservation,
} from '../../dist/index.js';
import {
  loadReserveFixture, setBudgetLimit, reservationPool, makePorts, makeScope, policyChange, reservationRequest,
  markDispatchedCommand, settleCommand, releaseCommand, scriptedClient, scriptedPorts, partitionRows, delay,
} from './reservation-harness.mjs';

const fixturePromise = loadReserveFixture();

async function setLimit(pool, scope, limitAmount) {
  return setBudgetLimit(pool, scope, limitAmount);
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

    const dispatched = await markReservationDispatched(markDispatchedCommand(scope, reservationId, 1, { attemptBinding: authorized.value.attemptBinding }), makePorts(pool, scope));
    assert.equal(dispatched.ok, true, dispatched.ok ? '' : dispatched.error.code);
    assert.equal(dispatched.value.status, 'applied');
    assert.equal(dispatched.value.state, 'dispatched');
    assert.equal(dispatched.value.revision, 2);

    const partial = await settleReservation(settleCommand(scope, reservationId, 2, { cumulativeAmount: '0.500000', finality: 'partial', sequence: 1 , attemptBinding: authorized.value.attemptBinding }), makePorts(pool, scope));
    assert.equal(partial.ok, true, partial.ok ? '' : `${partial.error.code}: ${partial.error.safe_message}`);
    assert.equal(partial.value.state, 'partially_settled');
    assert.equal(partial.value.consumedAmount, '0.5');

    const final = await settleReservation(settleCommand(scope, reservationId, 3, { cumulativeAmount: '1.200000', finality: 'final', sequence: 2 , attemptBinding: authorized.value.attemptBinding }), makePorts(pool, scope));
    assert.equal(final.ok, true, final.ok ? '' : final.error.code);
    assert.equal(final.value.state, 'settled');
    assert.equal(final.value.consumedAmount, '1.2');
    // Capacity before releasing the unused remainder still holds the full estimate.
    const beforeRelease = await readCapacity(scope, 'USD', 'lifecycle-before', makePorts(pool, scope));
    assert.equal(beforeRelease.value.usedCapacity, '2', 'the hold stands until the unused remainder is released');

    const released = await releaseReservation(releaseCommand(scope, reservationId, 4, { amount: '0.800000', proof: 'final_usage_known' , attemptBinding: authorized.value.attemptBinding }), makePorts(pool, scope));
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
    const stale = await markReservationDispatched(markDispatchedCommand(scope, reservationId, 5, { attemptBinding: authorized.value.attemptBinding }), makePorts(pool, scope));
    assert.equal(stale.ok, true, stale.ok ? '' : stale.error.code);
    assert.equal(stale.value.status, 'stale_revision');
    assert.equal(stale.value.state, 'held', 'a stale command does not advance the reservation');

    // A retried command reuses its idempotency key and does not re-apply.
    const dispatch = markDispatchedCommand(scope, reservationId, 1, { attemptBinding: authorized.value.attemptBinding });
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
    const over = await releaseReservation(releaseCommand(scope, reservationId, 1, { amount: '5.000000' , attemptBinding: authorized.value.attemptBinding }), makePorts(pool, scope));
    assert.equal(over.ok, false);
    if (!over.ok) assert.equal(over.error.code, 'VALIDATION_ERROR');
  } finally {
    await pool.end();
  }
});

/* ------------------------------------------------------------------ *
 * Review-remediation regressions (PR #32 findings 1, 2, 3).
 * Scripted-client tests run without PostgreSQL and exercise only the engine's
 * control flow; the PostgreSQL-backed variants run in the budgets suite on CI.
 * ------------------------------------------------------------------ */

const R1 = '123e4567-e89b-42d3-a456-000000000b01';
const R2 = '123e4567-e89b-42d3-a456-000000000b02';
const ATTEMPT = { logicalOperationId: 'logical-1', transportAttemptId: 'transport-1', providerRequestId: null, providerAttemptId: 'provider-1', billableAttemptId: 'billable-1' };

/** The aggregated reservation row `loadReservation` reads. */
function reservationRow(overrides = {}) {
  return {
    currency: 'USD', policy_version_id: 'policy-1', held: '1', released: '0', consumed: '0', revision: 1,
    last_type: 'authorized', last_finality: 'unknown', ever_dispatched: false, first_type: 'authorized',
    original_binding: structuredClone(ATTEMPT), ...overrides,
  };
}

function scriptedLifecycle(row, storedCommand = []) {
  return scriptedClient(sql => {
    if (sql.includes('array_agg(event_type ORDER BY event_sequence DESC)')) return row ? [row] : [];
    if (sql.includes('idempotency_key = $5')) return storedCommand;
    return null;
  });
}

async function run(command, fn, row, storedCommand) {
  const script = scriptedLifecycle(row, storedCommand);
  const result = await fn(command, scriptedPorts(command.scope, async () => script.client));
  return { script, result };
}

const scopeFor = label => makeScope(label);

test('CI-05A.2 release of a dispatched reservation never frees capacity without authoritative evidence', async () => {
  const scope = scopeFor('release-dispatched');
  const dispatched = reservationRow({ revision: 2, last_type: 'dispatched', ever_dispatched: true });
  for (const proof of ['never_dispatched_fenced', 'final_usage_known']) {
    const { script, result } = await run(releaseCommand(scope, R1, 2, { amount: '1.000000', proof , attemptBinding: ATTEMPT }), releaseReservation, dispatched);
    assert.equal(result.ok, false, proof);
    assert.equal(result.error.code, 'BUDGET_UNAVAILABLE', proof);
    assert.match(result.error.safe_message, /hold is preserved/);
    assert.equal(script.wrote(), false, `${proof}: the hold is preserved`);
    assert.equal(script.committed(), false);
  }
  // Partial (non-final) settlement is not final usage either.
  const partial = reservationRow({ revision: 3, last_type: 'settled', last_finality: 'partial', consumed: '0.4', ever_dispatched: true });
  const refused = await run(releaseCommand(scope, R1, 3, { amount: '0.600000', proof: 'final_usage_known' , attemptBinding: ATTEMPT }), releaseReservation, partial);
  assert.equal(refused.result.ok, false);
  assert.equal(refused.result.error.code, 'BUDGET_UNAVAILABLE');
  assert.equal(refused.script.wrote(), false);
  // final-usage proof on a never-settled held reservation is refused too.
  const unsettled = await run(releaseCommand(scope, R1, 1, { amount: '1.000000', proof: 'final_usage_known' , attemptBinding: ATTEMPT }), releaseReservation, reservationRow());
  assert.equal(unsettled.result.ok, false);
  assert.equal(unsettled.script.wrote(), false);
});

test('CI-05A.2 never-dispatched release is accepted only for a whole, durably undispatched hold', async () => {
  const scope = scopeFor('release-fenced');
  const whole = await run(releaseCommand(scope, R1, 1, { amount: '1.000000', proof: 'never_dispatched_fenced' , attemptBinding: ATTEMPT }), releaseReservation, reservationRow());
  assert.equal(whole.result.ok, true, whole.result.ok ? '' : whole.result.error.code);
  assert.equal(whole.script.wrote(), true);
  assert.equal(whole.script.committed(), true);
  // A partial release would leave a dispatchable remainder, so it is not a fence.
  const some = await run(releaseCommand(scope, R1, 1, { amount: '0.500000', proof: 'never_dispatched_fenced' , attemptBinding: ATTEMPT }), releaseReservation, reservationRow());
  assert.equal(some.result.ok, false);
  assert.equal(some.result.error.code, 'BUDGET_UNAVAILABLE');
  assert.equal(some.script.wrote(), false);
  // Already released: nothing to release.
  const again = await run(releaseCommand(scope, R1, 2, { amount: '0', proof: 'never_dispatched_fenced' , attemptBinding: ATTEMPT }), releaseReservation, reservationRow({ revision: 2, last_type: 'released' }));
  assert.equal(again.result.ok, false);
  assert.equal(again.script.wrote(), false);
});

test('CI-05A.2 final settlement permits releasing exactly the known unused remainder', async () => {
  const scope = scopeFor('release-final');
  const settled = reservationRow({ revision: 3, last_type: 'settled', last_finality: 'final', consumed: '0.4', ever_dispatched: true });
  const ok = await run(releaseCommand(scope, R1, 3, { amount: '0.600000', proof: 'final_usage_known' , attemptBinding: ATTEMPT }), releaseReservation, settled);
  assert.equal(ok.result.ok, true, ok.result.ok ? '' : ok.result.error.code);
  assert.equal(ok.script.committed(), true);
  const over = await run(releaseCommand(scope, R1, 3, { amount: '0.700000', proof: 'final_usage_known' , attemptBinding: ATTEMPT }), releaseReservation, settled);
  assert.equal(over.result.ok, false);
  assert.equal(over.result.error.code, 'VALIDATION_ERROR');
  assert.equal(over.script.wrote(), false);
});

test('CI-05A.3 a partially authorized reservation cannot dispatch without acknowledgement evidence', async () => {
  const scope = scopeFor('partial-dispatch');
  const command = markDispatchedCommand(scope, R1, 1, { attemptBinding: ATTEMPT });
  const partial = await run(command, markReservationDispatched, reservationRow({ last_type: 'partially_authorized', first_type: 'partially_authorized' }));
  assert.equal(partial.result.ok, false);
  assert.equal(partial.result.error.code, 'BUDGET_UNAVAILABLE');
  assert.equal(partial.result.error.retryable, false);
  assert.match(partial.result.error.safe_message, /acknowledgement or replan evidence/);
  assert.equal(partial.script.wrote(), false);
  assert.equal(partial.script.committed(), false);
});

test('CI-05A.3 dispatch is bound to the original attempt binding', async () => {
  const scope = scopeFor('dispatch-binding');
  const unrelated = markDispatchedCommand(scope, R1, 1);
  const refused = await run(unrelated, markReservationDispatched, reservationRow());
  assert.equal(refused.result.ok, false);
  assert.equal(refused.result.error.code, 'VALIDATION_ERROR');
  assert.equal(refused.script.wrote(), false);
  const matching = markDispatchedCommand(scope, R1, 1, { attemptBinding: ATTEMPT });
  const accepted = await run(matching, markReservationDispatched, reservationRow());
  assert.equal(accepted.result.ok, true, accepted.result.ok ? '' : accepted.result.error.code);
  assert.equal(accepted.result.value.status, 'applied');
  assert.equal(accepted.script.committed(), true);
});

test('CI-05A.1 a lifecycle command key reused for a different command is a typed conflict', async () => {
  const scope = scopeFor('command-conflict');
  const dispatch = markDispatchedCommand(scope, R1, 1, { attemptBinding: ATTEMPT });
  const storedDispatch = {
    reservation_id: R1, event_type: 'dispatched', event_sequence: 2, currency: 'USD', consumed_amount: '0', released_amount: '0',
    usage_finality: 'unknown', settlement_sequence: null, expected_revision: 1, attempt_binding: structuredClone(ATTEMPT),
  };
  const same = await run(dispatch, markReservationDispatched, reservationRow({ revision: 2, last_type: 'dispatched', ever_dispatched: true }), [storedDispatch]);
  assert.equal(same.result.ok && same.result.value.status, 'replay');

  const otherReservation = await run({ ...dispatch, reservationId: R2 }, markReservationDispatched, reservationRow(), [storedDispatch]);
  assert.equal(otherReservation.result.error.code, 'IDEMPOTENCY_CONFLICT');
  const otherAttempt = await run({ ...dispatch, attemptBinding: { ...ATTEMPT, billableAttemptId: 'x' } }, markReservationDispatched, reservationRow(), [storedDispatch]);
  assert.equal(otherAttempt.result.error.code, 'IDEMPOTENCY_CONFLICT');

  // The same key now used to settle a different amount, or to release, conflicts rather than replaying the dispatch.
  const settle = settleCommand(scope, R1, 1, { cumulativeAmount: '0.500000', finality: 'final', sequence: 1, idempotencyKey: dispatch.idempotencyKey , attemptBinding: ATTEMPT });
  const settleConflict = await run(settle, settleReservation, reservationRow(), [storedDispatch]);
  assert.equal(settleConflict.result.error.code, 'IDEMPOTENCY_CONFLICT');
  const release = releaseCommand(scope, R1, 1, { amount: '1.000000', idempotencyKey: dispatch.idempotencyKey , attemptBinding: ATTEMPT });
  const releaseConflict = await run(release, releaseReservation, reservationRow(), [storedDispatch]);
  assert.equal(releaseConflict.result.error.code, 'IDEMPOTENCY_CONFLICT');
  for (const conflict of [otherReservation, otherAttempt, settleConflict, releaseConflict]) {
    assert.equal(conflict.script.wrote(), false);
    assert.equal(conflict.script.committed(), false);
  }
});

test('CI-05A.2/.3 PostgreSQL: a dispatched hold keeps its capacity until final settlement, and partial dispatch is unavailable', async () => {
  assert.ok(process.env.CI_TEST_DB_RUNTIME_HOST, 'lifecycle suite requires the restricted disposable PostgreSQL role');
  const reserve = await fixturePromise;
  const pool = reservationPool(8);
  try {
    const scope = makeScope('db-release-safety');
    await setLimit(pool, scope, '1.00');
    const authorized = await authorizeReservation(reservationRequest(scope, reserve, { amount: '1.00' }), makePorts(pool, scope));
    assert.equal(authorized.value.status, 'authorized');
    const reservationId = authorized.value.reservationId;
    const dispatched = await markReservationDispatched(markDispatchedCommand(scope, reservationId, 1, { attemptBinding: authorized.value.attemptBinding }), makePorts(pool, scope));
    assert.equal(dispatched.ok, true, dispatched.ok ? '' : dispatched.error.code);

    for (const proof of ['never_dispatched_fenced', 'final_usage_known']) {
      const refused = await releaseReservation(releaseCommand(scope, reservationId, 2, { amount: '1.000000', proof , attemptBinding: authorized.value.attemptBinding }), makePorts(pool, scope));
      assert.equal(refused.ok, false, proof);
      assert.equal(refused.error.code, 'BUDGET_UNAVAILABLE', proof);
    }
    const capacity = await readCapacity(scope, 'USD', 'db-release-safety', makePorts(pool, scope));
    assert.equal(capacity.value.availableCapacity, '0', 'the dispatched exposure still holds the whole limit');
    const second = await authorizeReservation(reservationRequest(scope, reserve, { amount: '0.50' }), makePorts(pool, scope));
    assert.equal(second.value.status, 'denied', 'no second worker is authorized against unresolved exposure');

    // A later final settlement still succeeds because the reservation was never released.
    const final = await settleReservation(settleCommand(scope, reservationId, 2, { cumulativeAmount: '0.600000', finality: 'final', sequence: 1 , attemptBinding: authorized.value.attemptBinding }), makePorts(pool, scope));
    assert.equal(final.ok, true, final.ok ? '' : final.error.code);
    const released = await releaseReservation(releaseCommand(scope, reservationId, 3, { amount: '0.400000', proof: 'final_usage_known' , attemptBinding: authorized.value.attemptBinding }), makePorts(pool, scope));
    assert.equal(released.ok, true, released.ok ? '' : released.error.code);

    // Partial authorization: the hold is created but dispatch stays unavailable and the hold is preserved.
    const partialScope = makeScope('db-partial-dispatch');
    await setLimit(pool, partialScope, '1.00');
    const filler = await authorizeReservation(reservationRequest(partialScope, reserve, { amount: '0.75' }), makePorts(pool, partialScope));
    assert.equal(filler.value.status, 'authorized');
    const partial = await authorizeReservation(reservationRequest(partialScope, reserve, { amount: '0.75', allowPartialAuthorization: true }), makePorts(pool, partialScope));
    assert.equal(partial.value.status, 'partial');
    const blocked = await markReservationDispatched(markDispatchedCommand(partialScope, partial.value.reservationId, 1, { attemptBinding: partial.value.attemptBinding }), makePorts(pool, partialScope));
    assert.equal(blocked.ok, false);
    assert.equal(blocked.error.code, 'BUDGET_UNAVAILABLE');
    const preserved = await readCapacity(partialScope, 'USD', 'db-partial', makePorts(pool, partialScope));
    assert.equal(preserved.value.outstandingHolds, '1', 'the partial hold stays held');
  } finally {
    await pool.end();
  }
});

/* Re-review regressions: unacknowledged COMMIT and non-authoritative final usage. */

test('CI-05A.4 a never-acknowledged COMMIT returns unavailable within the deadline (authorize and lifecycle)', async () => {
  const scope = scopeFor('commit-hang');
  const policy = { contract: 'cost-intelligence.budget-policy', schema_version: '1.0.0', id: '123e4567-e89b-42d3-a456-000000000a01', revision: 1, content_hash: `sha256:${'a'.repeat(64)}` };
  const reserve = await fixturePromise;
  const request = reservationRequest(scope, reserve, { amount: '1', policyRef: policy });
  let commits = 0;
  const hanging = base => scriptedClient((sql, values) => {
    if (sql === 'COMMIT') { commits += 1; return new Promise(() => {}); }
    return base(sql, values);
  });
  const within = async promise => Promise.race([promise, delay(1_000).then(() => 'hung')]);

  const auth = hanging(partitionRows(policy, '5'));
  const decision = await within(authorizeReservation(request, scriptedPorts(scope, async () => auth.client, { authorityWaitMs: 25 })));
  assert.notEqual(decision, 'hung', 'authorize must not wait on an unacknowledged COMMIT');
  assert.equal(decision.ok && decision.value.status, 'unavailable');
  assert.ok(decision.value.retryAfterMs > 0);

  const dispatched = reservationRow({ revision: 2, last_type: 'dispatched', ever_dispatched: true });
  const lifecycle = hanging(sql => (sql.includes('array_agg(event_type ORDER BY event_sequence DESC)') ? [dispatched] : null));
  const settled = await within(settleReservation(settleCommand(scope, R1, 2, { cumulativeAmount: '0.5', finality: 'final' , attemptBinding: ATTEMPT }), scriptedPorts(scope, async () => lifecycle.client, { authorityWaitMs: 25 })));
  assert.notEqual(settled, 'hung', 'a lifecycle command must not wait on an unacknowledged COMMIT');
  assert.equal(settled.ok, false);
  assert.equal(settled.error.code, 'BUDGET_UNAVAILABLE');
  assert.equal(settled.error.retryable, true);
  assert.ok(commits >= 2);
});

test('CI-05A.2 final settlement with incomplete or unknown usage is not authoritative and cannot release exposure', async () => {
  const scope = scopeFor('settle-unknown');
  for (const [completeness, expected] of [['unknown', 'unknown'], ['incomplete', 'partial']]) {
    const row = reservationRow({ revision: 2, last_type: 'dispatched', ever_dispatched: true });
    const script = scriptedClient((sql, values) => {
      if (sql.includes('array_agg(event_type ORDER BY event_sequence DESC)')) return [{ ...row }];
      if (sql.includes('INSERT INTO cost_intelligence.budget_reservation_events')) {
        Object.assign(row, { revision: values[7], last_type: values[8], consumed: values[9], last_finality: values[11] });
      }
      return null;
    });
    const ports = scriptedPorts(scope, async () => script.client);
    const command = settleCommand(scope, R1, 2, { cumulativeAmount: '0.000000', finality: 'final', attemptBinding: ATTEMPT });
    command.settlement.usageCompleteness = completeness;
    const settlement = await settleReservation(command, ports);
    assert.equal(settlement.ok, true, completeness);
    assert.equal(settlement.value.usageFinality, expected, `${completeness}: reported finality is demoted`);
    assert.equal(settlement.value.state, 'partially_settled');
    assert.equal(settlement.value.outstandingHold, '1', 'the exposure stays held');
    const release = await releaseReservation(releaseCommand(scope, R1, 3, { amount: '1.000000', proof: 'final_usage_known', attemptBinding: ATTEMPT }), ports);
    assert.equal(release.ok, false, completeness);
    assert.equal(release.error.code, 'BUDGET_UNAVAILABLE');
    assert.equal(release.error.retryable, false);
  }
  // Complete final usage of zero is authoritative and still releases the unused hold.
  const row = reservationRow({ revision: 3, last_type: 'settled', last_finality: 'final', ever_dispatched: true });
  const ok = await run(releaseCommand(scope, R1, 3, { amount: '1.000000', proof: 'final_usage_known' , attemptBinding: ATTEMPT }), releaseReservation, row);
  assert.equal(ok.result.ok, true);
});

/* Attempt binding for settle/release and canonical settlement agreement. */

const OTHER_ATTEMPT = { ...ATTEMPT, logicalOperationId: 'logical-other', billableAttemptId: 'billable-other' };

test('CI-05A.2 settle and release from an unrelated attempt are rejected without writing', async () => {
  const scope = scopeFor('unrelated-attempt');
  const dispatched = reservationRow({ revision: 2, last_type: 'dispatched', ever_dispatched: true });
  const settle = await run(settleCommand(scope, R1, 2, { cumulativeAmount: '0.000000', finality: 'final', attemptBinding: OTHER_ATTEMPT }), settleReservation, dispatched);
  assert.equal(settle.result.ok, false);
  assert.equal(settle.result.error.code, 'VALIDATION_ERROR');
  assert.equal(settle.script.wrote(), false);
  assert.equal(settle.script.committed(), false);

  const settled = reservationRow({ revision: 3, last_type: 'settled', last_finality: 'final', ever_dispatched: true });
  const release = await run(releaseCommand(scope, R1, 3, { amount: '1.000000', proof: 'final_usage_known', attemptBinding: OTHER_ATTEMPT }), releaseReservation, settled);
  assert.equal(release.result.ok, false);
  assert.equal(release.result.error.code, 'VALIDATION_ERROR');
  assert.equal(release.script.wrote(), false);

  // The original attempt still settles and releases.
  const own = await run(settleCommand(scope, R1, 2, { cumulativeAmount: '0.000000', finality: 'final', attemptBinding: ATTEMPT }), settleReservation, dispatched);
  assert.equal(own.result.ok, true);
});

test('CI-05A.2 a canonical settlement that contradicts the wrapper settlement is rejected before any database work', async () => {
  const scope = scopeFor('canonical-settle');
  const dispatched = reservationRow({ revision: 2, last_type: 'dispatched', ever_dispatched: true });
  const mismatches = {
    amountAndCurrency: c => { c.canonicalCommand.consumed = { amount: '9', currency: 'EUR', scale: 0 }; },
    amount: c => { c.canonicalCommand.consumed = { amount: '9', currency: 'USD', scale: 0 }; },
    currency: c => { c.canonicalCommand.consumed = { amount: '0', currency: 'EUR', scale: 0 }; },
    envelopeCurrency: c => { c.canonicalCommand.currency = 'EUR'; },
  };
  for (const [label, mutate] of Object.entries(mismatches)) {
    const command = settleCommand(scope, R1, 2, { cumulativeAmount: '0.000000', finality: 'final', attemptBinding: ATTEMPT });
    mutate(command);
    let connects = 0;
    const script = scriptedLifecycle(dispatched);
    const result = await settleReservation(command, scriptedPorts(scope, async () => { connects += 1; return script.client; }));
    assert.equal(result.ok, false, label);
    assert.ok(['VALIDATION_ERROR', 'FORBIDDEN_SCOPE'].includes(result.error.code), `${label}: ${result.error.code}`);
    assert.equal(connects, 0, label);
    assert.equal(script.wrote(), false, label);
  }
});

test('CI-05A.2 PostgreSQL: unrelated-attempt settle/release and a contradictory canonical settlement cannot free exposure', async () => {
  assert.ok(process.env.CI_TEST_DB_RUNTIME_HOST, 'lifecycle suite requires the restricted disposable PostgreSQL role');
  const reserve = await fixturePromise;
  const pool = reservationPool(8);
  const count = async scope => (await pool.query(
    `SELECT count(*)::int AS total FROM cost_intelligence.budget_reservation_events
     WHERE tenant_id = $1 AND project_id = $2 AND environment = $3 AND billing_mode = $4`,
    [scope.tenantId, scope.projectId, scope.environment, scope.billingMode])).rows[0].total;
  try {
    const scope = makeScope('db-unrelated-attempt');
    await setLimit(pool, scope, '1.00');
    const authorized = await authorizeReservation(reservationRequest(scope, reserve, { amount: '1.00' }), makePorts(pool, scope));
    const id = authorized.value.reservationId;
    const own = authorized.value.attemptBinding;
    const other = { ...own, logicalOperationId: `logical-${id}`, billableAttemptId: `billable-other-${id}` };
    const dispatched = await markReservationDispatched(markDispatchedCommand(scope, id, 1, { attemptBinding: own }), makePorts(pool, scope));
    assert.equal(dispatched.ok, true, dispatched.ok ? '' : dispatched.error.code);
    const events = await count(scope);

    const unrelatedSettle = await settleReservation(settleCommand(scope, id, 2, { cumulativeAmount: '0.000000', finality: 'final', attemptBinding: other }), makePorts(pool, scope));
    assert.equal(unrelatedSettle.ok, false);
    assert.equal(unrelatedSettle.error.code, 'VALIDATION_ERROR');

    const contradictory = settleCommand(scope, id, 2, { cumulativeAmount: '0.000000', finality: 'final', attemptBinding: own });
    contradictory.canonicalCommand.consumed = { amount: '9', currency: 'EUR', scale: 0 };
    const mismatch = await settleReservation(contradictory, makePorts(pool, scope));
    assert.equal(mismatch.ok, false);

    const unrelatedRelease = await releaseReservation(releaseCommand(scope, id, 2, { amount: '1.000000', proof: 'final_usage_known', attemptBinding: other }), makePorts(pool, scope));
    assert.equal(unrelatedRelease.ok, false);

    assert.equal(await count(scope), events, 'no event is written by any rejected command');
    const capacity = await readCapacity(scope, 'USD', 'db-unrelated', makePorts(pool, scope));
    assert.equal(capacity.value.availableCapacity, '0', 'the dispatched exposure remains held');

    // The original attempt can still settle and release.
    const settled = await settleReservation(settleCommand(scope, id, 2, { cumulativeAmount: '0.250000', finality: 'final', attemptBinding: own }), makePorts(pool, scope));
    assert.equal(settled.ok, true, settled.ok ? '' : settled.error.code);
    const unrelatedAfter = await releaseReservation(releaseCommand(scope, id, 3, { amount: '0.750000', proof: 'final_usage_known', attemptBinding: other }), makePorts(pool, scope));
    assert.equal(unrelatedAfter.ok, false);
    const released = await releaseReservation(releaseCommand(scope, id, 3, { amount: '0.750000', proof: 'final_usage_known', attemptBinding: own }), makePorts(pool, scope));
    assert.equal(released.ok, true, released.ok ? '' : released.error.code);
  } finally {
    await pool.end();
  }
});

/* Observed overrun and release currency agreement. */

test('CI-05A.2 an observed overrun above the hold is recorded in full with its variance (scripted)', async () => {
  const scope = scopeFor('overrun');
  const row = reservationRow({ revision: 2, last_type: 'dispatched', ever_dispatched: true });
  const script = scriptedClient((sql, values) => {
    if (sql.includes('array_agg(event_type ORDER BY event_sequence DESC)')) return [{ ...row }];
    if (sql.includes('INSERT INTO cost_intelligence.budget_reservation_events')) {
      Object.assign(row, { revision: values[7], last_type: values[8], consumed: values[9], last_finality: values[11] });
    }
    return null;
  });
  const result = await settleReservation(settleCommand(scope, R1, 2, { cumulativeAmount: '1.100000', finality: 'final', attemptBinding: ATTEMPT }), scriptedPorts(scope, async () => script.client));
  assert.equal(result.ok, true, result.ok ? '' : result.error.code);
  assert.equal(result.value.heldAmount, '1');
  assert.equal(result.value.consumedAmount, '1.1', 'the full observed spend is recorded, not clamped to the hold');
  assert.equal(result.value.overrunAmount, '0.1');
  assert.equal(result.value.outstandingHold, '0');
  assert.equal(result.value.state, 'settled');
  assert.equal(script.committed(), true);
});

test('CI-05A.2 a canonical release currency that contradicts the release is rejected before any database work', async () => {
  const scope = scopeFor('release-currency');
  const command = releaseCommand(scope, R1, 3, { amount: '0.5', proof: 'final_usage_known', attemptBinding: ATTEMPT });
  command.canonicalCommand.currency = 'EUR';
  let connects = 0;
  const script = scriptedLifecycle(reservationRow({ revision: 3, last_type: 'settled', last_finality: 'final', ever_dispatched: true }));
  const result = await releaseReservation(command, scriptedPorts(scope, async () => { connects += 1; return script.client; }));
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'VALIDATION_ERROR');
  assert.equal(connects, 0);
});

test('CI-05A.2 PostgreSQL: an observed overrun is recorded in full, charged to capacity, and cannot be released', async () => {
  assert.ok(process.env.CI_TEST_DB_RUNTIME_HOST, 'lifecycle suite requires the restricted disposable PostgreSQL role');
  const reserve = await fixturePromise;
  const pool = reservationPool(8);
  try {
    const scope = makeScope('db-overrun');
    await setLimit(pool, scope, '5.00');
    const authorized = await authorizeReservation(reservationRequest(scope, reserve, { amount: '1.00' }), makePorts(pool, scope));
    const id = authorized.value.reservationId;
    const own = authorized.value.attemptBinding;
    assert.equal((await markReservationDispatched(markDispatchedCommand(scope, id, 1, { attemptBinding: own }), makePorts(pool, scope))).ok, true);
    const settled = await settleReservation(settleCommand(scope, id, 2, { cumulativeAmount: '1.100000', finality: 'final', attemptBinding: own }), makePorts(pool, scope));
    assert.equal(settled.ok, true, settled.ok ? '' : settled.error.code);
    assert.equal(settled.value.heldAmount, '1');
    assert.equal(settled.value.consumedAmount, '1.1');
    assert.equal(settled.value.overrunAmount, '0.1');
    assert.equal(settled.value.outstandingHold, '0');
    const capacity = await readCapacity(scope, 'USD', 'db-overrun', makePorts(pool, scope));
    assert.equal(capacity.value.effectiveConsumedSpend, '1.1');
    assert.equal(capacity.value.usedCapacity, '1.1');
    assert.equal(capacity.value.availableCapacity, '3.9');
    const release = await releaseReservation(releaseCommand(scope, id, 3, { amount: '0.100000', proof: 'final_usage_known', attemptBinding: own }), makePorts(pool, scope));
    assert.equal(release.ok, false, 'there is no unused hold left to release');
    const badCurrency = releaseCommand(scope, id, 3, { amount: '0', proof: 'final_usage_known', attemptBinding: own });
    badCurrency.canonicalCommand.currency = 'EUR';
    assert.equal((await releaseReservation(badCurrency, makePorts(pool, scope))).ok, false);
  } finally {
    await pool.end();
  }
});
