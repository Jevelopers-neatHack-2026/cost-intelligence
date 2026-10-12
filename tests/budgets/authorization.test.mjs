import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  authorizeReservation, changeBudgetPolicy, readCapacity, markReservationDispatched,
} from '../../dist/index.js';
import {
  loadReserveFixture, setBudgetLimit, reservationPool, makePorts, makeScope, policyChange, reservationRequest,
  scriptedClient, scriptedPorts, partitionRows, delay,
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
  const receipt = await setBudgetLimit(pool, scope, limitAmount, currency);
  assert.equal(Number(receipt.effectiveLimit), Number(limitAmount), 'the limit round-trips as a canonical exact decimal');
  return receipt;
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

test('CI-05A.3 unknown or unbounded pricing cannot auto-authorize (no trusted maximum-policy resolver)', async () => {
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

    // A caller-supplied maximumPolicyRef is not authority: no trusted resolver exists, so it stays denied.
    const boundedEstimate = {
      completeness: 'incomplete', knownSubtotal: '0.20', currency: 'USD', rateCardRef: null, missingDimensions: ['provider'],
      boundedConservativeMaximum: '2.00',
      maximumPolicyRef: { contract: 'cost-intelligence.max-policy', schema_version: '1.0.0', id: `max-${randomUUID()}`, revision: 1, content_hash: `sha256:${'a'.repeat(64)}` },
    };
    const bounded = await authorizeReservation(reservationRequest(scope, reserve, { amount: '0.20', estimate: boundedEstimate }), makePorts(pool, scope));
    assert.equal(bounded.ok, true, bounded.ok ? '' : bounded.error.code);
    assert.equal(bounded.value.status, 'denied', 'a forged maximum policy reference cannot authorize unknown exposure');
    assert.equal(await countEvents(pool, scope), 0);
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

/* ------------------------------------------------------------------ *
 * Review-remediation regressions (PR #32 findings 1, 4, 5, 6).
 * The scripted-client tests below run without PostgreSQL: they exercise the
 * engine's own control flow and are NOT database validation. The
 * PostgreSQL-backed variants follow and run in the budgets suite on CI.
 * ------------------------------------------------------------------ */

const POLICY = { contract: 'cost-intelligence.budget-policy', schema_version: '1.0.0', id: '123e4567-e89b-42d3-a456-000000000a01', revision: 1, content_hash: `sha256:${'a'.repeat(64)}` };

/** The stored authorization event row for a request, as the database would return it. */
function storedAuthorization(request, overrides = {}) {
  return {
    reservation_id: 'stored-reservation', event_type: 'authorized', event_sequence: 1, currency: request.estimate.currency,
    held_amount: request.estimate.knownSubtotal, partial_allowed_amount: null,
    estimate_completeness: request.estimate.completeness, known_subtotal: request.estimate.knownSubtotal, bounded_maximum: null,
    allow_partial: request.allowPartialAuthorization, attempt_binding: structuredClone(request.attemptBinding),
    policy_version_id: POLICY.id, policy_ref: POLICY, rate_card_ref: null, ...overrides,
  };
}

function scriptedAuthorization(rowsForReplay = []) {
  const partition = partitionRows(POLICY, '5.00');
  const script = scriptedClient(sql => {
    if (sql.includes('ORDER BY event_sequence ASC')) return rowsForReplay;
    return partition(sql);
  });
  return { ...script, connectCalls: 0 };
}

async function scriptedRequest(scope, options = {}) {
  const reserve = await fixturePromise;
  return reservationRequest(scope, reserve, { policyRef: POLICY, ...options });
}

test('CI-05A.1 replaying an idempotency key with a different currency, amount, policy or attempt is a typed conflict', async () => {
  const scope = makeScope('replay-conflict');
  const original = await scriptedRequest(scope, { amount: '0.75' });
  const variants = {
    currency: { ...original, estimate: { ...original.estimate, currency: 'EUR' }, canonicalRequest: { ...original.canonicalRequest, currency: 'EUR', requested: { ...original.canonicalRequest.requested, currency: 'EUR' } } },
    amount: { ...original, estimate: { ...original.estimate, knownSubtotal: '100' }, canonicalRequest: { ...original.canonicalRequest, requested: { amount: '100', currency: 'USD', scale: 0 } } },
    attempt: { ...original, attemptBinding: { ...original.attemptBinding, billableAttemptId: 'another-attempt' } },
    policy: { ...original, canonicalRequest: { ...original.canonicalRequest, policy_ref: { ...POLICY, revision: 2 } } },
    partial: { ...original, allowPartialAuthorization: true },
  };
  for (const [label, changed] of Object.entries(variants)) {
    const script = scriptedAuthorization([storedAuthorization(original)]);
    const result = await authorizeReservation(changed, scriptedPorts(scope, async () => script.client));
    assert.equal(result.ok, false, `${label}: a conflicting replay must not produce a decision`);
    assert.equal(result.error.code, 'IDEMPOTENCY_CONFLICT', label);
    assert.equal(script.wrote(), false, `${label}: no hold is written`);
    assert.equal(script.committed(), false, `${label}: nothing is committed`);
    assert.equal(script.state.released, 1, `${label}: the connection is returned`);
  }

  // The identical request still replays the single stored hold with its stored binding.
  const script = scriptedAuthorization([storedAuthorization(original)]);
  const replay = await authorizeReservation(original, scriptedPorts(scope, async () => script.client));
  assert.equal(replay.ok, true);
  assert.equal(replay.value.status, 'authorized');
  assert.equal(replay.value.reservationId, 'stored-reservation');
  assert.deepEqual(replay.value.attemptBinding, original.attemptBinding);
  assert.equal(script.wrote(), false);

  // A stored row that is not the authorization event of this key is also a conflict.
  const command = scriptedAuthorization([storedAuthorization(original, { event_type: 'dispatched', event_sequence: 2 })]);
  const notAuthorization = await authorizeReservation(original, scriptedPorts(scope, async () => command.client));
  assert.equal(notAuthorization.ok, false);
  assert.equal(notAuthorization.error.code, 'IDEMPOTENCY_CONFLICT');
});

test('CI-05A.1 the review probe: a prior USD hold is never replayed as an EUR authorization', async () => {
  const scope = makeScope('probe');
  const usd = await scriptedRequest(scope, { amount: '0.75', idempotencyKey: 'prior-usd-key' });
  const eur = await scriptedRequest(scope, { currency: 'EUR', amount: '100', idempotencyKey: 'prior-usd-key' });
  const script = scriptedAuthorization([storedAuthorization(usd, { reservation_id: 'prior-usd-reservation' })]);
  const result = await authorizeReservation(eur, scriptedPorts(scope, async () => script.client));
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'IDEMPOTENCY_CONFLICT');
});

test('CI-05A.6 a stale or foreign canonical policy reference is rejected before any hold', async () => {
  const scope = makeScope('stale-policy');
  for (const [label, policyRef] of Object.entries({
    stale_revision: { ...POLICY, revision: 0 },
    foreign_id: { ...POLICY, id: '123e4567-e89b-42d3-a456-000000000a02' },
    foreign_hash: { ...POLICY, content_hash: `sha256:${'b'.repeat(64)}` },
  })) {
    const request = await scriptedRequest(scope, { amount: '0.50', policyRef });
    const script = scriptedAuthorization();
    const result = await authorizeReservation(request, scriptedPorts(scope, async () => script.client));
    assert.equal(result.ok, false, label);
    assert.equal(result.error.code, 'VALIDATION_ERROR', label);
    assert.equal(script.wrote(), false, label);
    assert.equal(script.committed(), false, label);
  }
  // The exact applicable policy reference authorizes.
  const script = scriptedAuthorization();
  const ok = await authorizeReservation(await scriptedRequest(scope, { amount: '0.50' }), scriptedPorts(scope, async () => script.client));
  assert.equal(ok.ok, true);
  assert.equal(ok.value.status, 'authorized');
  assert.equal(script.wrote(), true);
});

test('CI-05A.6 contradictory financial fields, including a zero estimate for a nonzero request, are rejected', async () => {
  const scope = makeScope('contradiction');
  let connects = 0;
  const countingPorts = () => scriptedPorts(scope, async () => { connects += 1; return scriptedAuthorization().client; });
  const zeroEstimate = await scriptedRequest(scope, { amount: '100', estimate: { completeness: 'complete', knownSubtotal: '0', currency: 'USD', rateCardRef: null, missingDimensions: [] } });
  const lowEstimate = await scriptedRequest(scope, { amount: '100', estimate: { completeness: 'complete', knownSubtotal: '1', currency: 'USD', rateCardRef: null, missingDimensions: [] } });
  const requestedCurrency = await scriptedRequest(scope, { amount: '1' });
  requestedCurrency.canonicalRequest.requested = { ...requestedCurrency.canonicalRequest.requested, currency: 'EUR' };
  for (const [label, request] of Object.entries({ zeroEstimate, lowEstimate, requestedCurrency })) {
    const result = await authorizeReservation(request, countingPorts());
    assert.equal(result.ok, false, label);
    assert.equal(result.error.code, 'VALIDATION_ERROR', label);
  }
  assert.equal(connects, 0, 'contradictions are rejected before any database work');
  // Equal amounts with different decimal scale are the same exact money.
  const scaled = await scriptedRequest(scope, { amount: '0.50', requestedAmount: '0.500000' });
  const script = scriptedAuthorization();
  const result = await authorizeReservation(scaled, scriptedPorts(scope, async () => script.client));
  assert.equal(result.ok && result.value.status, 'authorized');
});

test('CI-05A.3 a caller-supplied maximumPolicyRef is not authority for unknown or unbounded exposure', async () => {
  const scope = makeScope('forged-maximum');
  const forged = { contract: 'cost-intelligence.max-policy', schema_version: '1.0.0', id: 'forged', revision: 1, content_hash: `sha256:${'c'.repeat(64)}` };
  for (const completeness of ['unknown', 'incomplete']) {
    const request = await scriptedRequest(scope, {
      amount: '0.20',
      estimate: { completeness, knownSubtotal: '0.20', currency: 'USD', rateCardRef: null, missingDimensions: ['provider'], boundedConservativeMaximum: '2.00', maximumPolicyRef: forged },
    });
    const script = scriptedAuthorization();
    const result = await authorizeReservation(request, scriptedPorts(scope, async () => script.client));
    assert.equal(result.ok, true, completeness);
    assert.equal(result.value.status, 'denied', completeness);
    assert.equal(result.value.heldAmount, '0');
    assert.equal(script.wrote(), false, completeness);
  }
});

test('CI-05A.4 zero, infinite and malformed wait settings are rejected', async () => {
  const scope = makeScope('wait-config');
  const request = await scriptedRequest(scope, { amount: '0.10' });
  for (const authorityWaitMs of [0, -1, Infinity, NaN, 1.5, 60_001, '100']) {
    let connects = 0;
    const ports = scriptedPorts(scope, async () => { connects += 1; return scriptedAuthorization().client; }, { authorityWaitMs });
    ports.authorityWaitMs = authorityWaitMs;
    const decision = await authorizeReservation(request, ports);
    assert.equal(decision.ok, false, `authorize ${String(authorityWaitMs)}`);
    assert.equal(decision.error.code, 'VALIDATION_ERROR');
    const capacity = await readCapacity(scope, 'USD', 'wait-config', ports);
    assert.equal(capacity.ok, false, `readCapacity ${String(authorityWaitMs)}`);
    const policy = await changeBudgetPolicy(policyChange(scope, { limitAmount: '1.00' }), ports);
    assert.equal(policy.ok, false, `changeBudget ${String(authorityWaitMs)}`);
    assert.equal(connects, 0);
  }
});

test('CI-05A.4 a stalled authority returns unavailable within the bound and never creates a hold afterwards', async () => {
  const scope = makeScope('stalled-authority');
  const request = await scriptedRequest(scope, { amount: '0.10' });
  let connects = 0;
  let releaseAuthority;
  const stalled = new Promise(resolve => { releaseAuthority = resolve; });
  const script = scriptedAuthorization();
  const ports = scriptedPorts(scope, async () => { connects += 1; return script.client; }, { authorityWaitMs: 25 });
  const grant = ports.financeAuthority;
  ports.financeAuthority = { authorizeCurrent: async input => { await stalled; return grant.authorizeCurrent(input); } };
  const started = Date.now();
  const result = await authorizeReservation(request, ports);
  assert.ok(Date.now() - started < 1_000, 'the call returns promptly instead of waiting on the authority');
  assert.equal(result.ok, true);
  assert.equal(result.value.status, 'unavailable');
  assert.ok(result.value.retryAfterMs > 0, 'retry guidance is returned');
  // The authority answers late: the abandoned work must not connect, write or commit.
  releaseAuthority();
  await delay(60);
  assert.equal(connects, 0, 'late authority never opens a connection');
  assert.equal(script.wrote(), false);
  assert.equal(script.committed(), false);
});

test('CI-05A.4 an exhausted connection pool is bounded, and a late connection is returned unused', async () => {
  const scope = makeScope('pool-exhausted');
  const request = await scriptedRequest(scope, { amount: '0.10' });
  const never = await authorizeReservation(request, scriptedPorts(scope, () => new Promise(() => {}), { authorityWaitMs: 25 }));
  assert.equal(never.ok, true);
  assert.equal(never.value.status, 'unavailable');

  let grantConnection;
  const script = scriptedAuthorization();
  const late = authorizeReservation(request, scriptedPorts(scope, () => new Promise(resolve => { grantConnection = () => resolve(script.client); }), { authorityWaitMs: 25 }));
  const result = await late;
  assert.equal(result.value.status, 'unavailable');
  grantConnection();
  await delay(60);
  assert.equal(script.wrote(), false, 'a connection granted after the deadline creates no hold');
  assert.equal(script.committed(), false);
  assert.equal(script.statements.includes('BEGIN'), false, 'a late connection does not even begin a transaction');
  assert.equal(script.state.released, 1, 'the late connection is released back to the pool');
});

test('CI-05A.4 slow database work past the deadline is rolled back and cannot commit a hold', async () => {
  const scope = makeScope('slow-database');
  const request = await scriptedRequest(scope, { amount: '0.10' });
  const partition = partitionRows(POLICY, '5.00');
  const script = scriptedClient(async sql => {
    if (sql.includes('WITH per_reservation')) await delay(80);
    return partition(sql);
  });
  const result = await authorizeReservation(request, scriptedPorts(scope, async () => script.client, { authorityWaitMs: 25 }));
  assert.equal(result.ok, true);
  assert.equal(result.value.status, 'unavailable');
  await delay(150);
  assert.equal(script.wrote(), false, 'work finishing after the deadline never inserts a hold');
  assert.equal(script.committed(), false, 'work finishing after the deadline never commits');
  assert.ok(script.statements.includes('ROLLBACK'));
  assert.equal(script.state.released, 1);
});

test('CI-05A.1 a conflicting policy-change replay is a typed conflict', async () => {
  const scope = makeScope('policy-replay');
  const change = policyChange(scope, { limitAmount: '5.00', idempotencyKey: 'policy-key' });
  const stored = {
    policy_version_id: 'p1', policy_revision: 1, currency: 'USD', limit_amount: '5.00', content_hash: POLICY.content_hash,
    actor_reference: change.actorReference, reason_reference: change.reasonReference, source_authority_ref: change.sourceAuthorityRef,
  };
  const run = async candidate => {
    const script = scriptedClient(sql => (sql.includes('idempotency_key = $5') ? [stored] : partitionRows(POLICY, '5.00')(sql)));
    return { script, result: await changeBudgetPolicy(candidate, scriptedPorts(scope, async () => script.client)) };
  };
  const same = await run(change);
  assert.equal(same.result.ok && same.result.value.status, 'replay');
  for (const candidate of [
    { ...change, limitAmount: '500.00' }, { ...change, currency: 'EUR' }, { ...change, reasonReference: 'other' },
    { ...change, actorReference: 'other' }, { ...change, expectedPolicyRevision: 3 },
  ]) {
    const { script, result } = await run(candidate);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'IDEMPOTENCY_CONFLICT');
    assert.equal(script.wrote(), false);
  }
});

test('CI-05A.1/.6 PostgreSQL: conflicting replays and stale policy references create no second hold', async () => {
  assert.ok(process.env.CI_TEST_DB_RUNTIME_HOST, 'authorization suite requires the restricted disposable PostgreSQL role');
  const reserve = await fixturePromise;
  const pool = reservationPool(6);
  try {
    const scope = makeScope('db-replay');
    const first = await setLimit(pool, scope, '5.00');
    const request = reservationRequest(scope, reserve, { amount: '0.75' });
    const authorized = await authorizeReservation(request, makePorts(pool, scope));
    assert.equal(authorized.value.status, 'authorized');

    // Same key, different currency / amount / attempt: typed conflict, one hold.
    const eur = reservationRequest(scope, reserve, { amount: '0.75', currency: 'EUR', idempotencyKey: request.idempotencyKey });
    const changedAmount = reservationRequest(scope, reserve, { amount: '4.00', idempotencyKey: request.idempotencyKey });
    const changedAttempt = { ...request, attemptBinding: { ...request.attemptBinding, billableAttemptId: `billable-${randomUUID()}` } };
    for (const conflicting of [eur, changedAmount, changedAttempt]) {
      const result = await authorizeReservation(conflicting, makePorts(pool, scope));
      assert.equal(result.ok, false);
      assert.equal(result.error.code, 'IDEMPOTENCY_CONFLICT');
    }
    assert.equal(await countEvents(pool, scope), 1);

    // After a newer policy revision, the stored policy reference still replays identically,
    // while a fresh request carrying the superseded reference is rejected as stale.
    const second = await changeBudgetPolicy(policyChange(scope, { limitAmount: '6.00', expectedPolicyRevision: 1 }), makePorts(pool, scope));
    assert.equal(second.value.status, 'applied');
    const replay = await authorizeReservation(request, makePorts(pool, scope));
    assert.equal(replay.ok && replay.value.reservationId, authorized.value.reservationId);
    const stale = await authorizeReservation(reservationRequest(scope, reserve, { amount: '0.10', policyRef: first.policyRef }), makePorts(pool, scope));
    assert.equal(stale.ok, false);
    assert.equal(stale.error.code, 'VALIDATION_ERROR');
    const zero = await authorizeReservation(reservationRequest(scope, reserve, { amount: '0.10', policyRef: second.value.policyRef,
      estimate: { completeness: 'complete', knownSubtotal: '0', currency: 'USD', rateCardRef: null, missingDimensions: [] } }), makePorts(pool, scope));
    assert.equal(zero.ok, false);
    assert.equal(zero.error.code, 'VALIDATION_ERROR');
    assert.equal(await countEvents(pool, scope), 1, 'rejections persist nothing');
  } finally {
    await pool.end();
  }
});

test('CI-05A.4 PostgreSQL: a held partition lock yields unavailable within the bound', async () => {
  assert.ok(process.env.CI_TEST_DB_RUNTIME_HOST, 'authorization suite requires the restricted disposable PostgreSQL role');
  const reserve = await fixturePromise;
  const pool = reservationPool(6);
  try {
    const scope = makeScope('db-lock-timeout');
    await setLimit(pool, scope, '5.00');
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`ci05a-budget:${scope.tenantId}:${scope.projectId}:${scope.environment}:${scope.billingMode}:USD`]);
      const started = Date.now();
      const result = await authorizeReservation(reservationRequest(scope, reserve, { amount: '0.10' }), makePorts(pool, scope, { authorityWaitMs: 200 }));
      assert.equal(result.ok && result.value.status, 'unavailable');
      assert.ok(Date.now() - started < 3_000);
      await holder.query('ROLLBACK');
    } finally {
      holder.release();
    }
    assert.equal(await countEvents(pool, scope), 0);
  } finally {
    await pool.end();
  }
});

/* Optional bounded conservative maximum on a complete estimate must persist and replay identically. */

function persistingClient(policy) {
  let persisted;
  const script = scriptedClient((sql, values) => {
    if (sql.includes('INSERT INTO cost_intelligence.budget_reservation_events')) {
      persisted = {
        reservation_id: values[6], event_type: values[7], event_sequence: 1, currency: values[5], held_amount: values[9],
        estimate_completeness: values[10], known_subtotal: values[11], bounded_maximum: values[12], allow_partial: values[13],
        partial_allowed_amount: values[14], policy_version_id: values[15], rate_card_ref: values[16], policy_ref: values[17], attempt_binding: values[21],
      };
      return [];
    }
    if (sql.includes('ORDER BY event_sequence ASC')) return persisted ? [persisted] : [];
    return partitionRows(policy, '5', persisted ? '1' : '0')(sql);
  });
  return { script, inserts: () => script.statements.filter(sql => sql.startsWith('INSERT')).length };
}

test('CI-05A.1 a complete estimate with an optional bounded maximum persists it and replays the identical request', async () => {
  const scope = makeScope('optional-maximum');
  const request = await scriptedRequest(scope, { amount: '1' });
  request.estimate.boundedConservativeMaximum = '1.000';
  const { script, inserts } = persistingClient(POLICY);
  const ports = scriptedPorts(scope, async () => script.client);
  const initial = await authorizeReservation(request, ports);
  assert.equal(initial.ok && initial.value.status, 'authorized');
  assert.equal(initial.value.heldAmount, '1', 'a complete estimate holds its known subtotal');
  const retry = await authorizeReservation(request, ports);
  assert.equal(retry.ok, true, retry.ok ? '' : retry.error.code);
  assert.equal(retry.value.reservationId, initial.value.reservationId);
  assert.equal(inserts(), 1, 'the retry creates no second hold');

  // A changed, added or removed maximum is a typed conflict, never a silent replay.
  for (const maximum of ['2', '1.5', undefined]) {
    const changed = structuredClone(request);
    if (maximum === undefined) delete changed.estimate.boundedConservativeMaximum; else changed.estimate.boundedConservativeMaximum = maximum;
    const result = await authorizeReservation(changed, ports);
    assert.equal(result.ok, false, String(maximum));
    assert.equal(result.error.code, 'IDEMPOTENCY_CONFLICT', String(maximum));
  }
  assert.equal(inserts(), 1);
});

test('CI-05A.3 a maximum policy reference on a complete estimate, or a maximum below the subtotal, is rejected before any write', async () => {
  const scope = makeScope('optional-maximum-reject');
  const withRef = await scriptedRequest(scope, { amount: '1' });
  withRef.estimate.boundedConservativeMaximum = '1';
  withRef.estimate.maximumPolicyRef = POLICY;
  const below = await scriptedRequest(scope, { amount: '1' });
  below.estimate.boundedConservativeMaximum = '0.5';
  for (const [label, request] of Object.entries({ withRef, below })) {
    let connects = 0;
    const result = await authorizeReservation(request, scriptedPorts(scope, async () => { connects += 1; return persistingClient(POLICY).script.client; }));
    assert.equal(result.ok, false, label);
    assert.equal(result.error.code, 'VALIDATION_ERROR', label);
    assert.equal(connects, 0, label);
  }
});

test('CI-05A.1 PostgreSQL: the exact same request with an optional bounded maximum replays the original hold', async () => {
  assert.ok(process.env.CI_TEST_DB_RUNTIME_HOST, 'authorization suite requires the restricted disposable PostgreSQL role');
  const reserve = await fixturePromise;
  const pool = reservationPool(6);
  try {
    const scope = makeScope('db-optional-maximum');
    await setLimit(pool, scope, '5.00');
    const request = reservationRequest(scope, reserve, { amount: '1' });
    request.estimate.boundedConservativeMaximum = '1';
    const first = await authorizeReservation(request, makePorts(pool, scope));
    assert.equal(first.ok && first.value.status, 'authorized', first.ok ? '' : first.error.code);
    const replay = await authorizeReservation(request, makePorts(pool, scope));
    assert.equal(replay.ok, true, replay.ok ? '' : replay.error.code);
    assert.equal(replay.value.reservationId, first.value.reservationId);
    assert.equal(replay.value.boundedConservativeMaximum, '1');
    assert.equal(await countEvents(pool, scope), 1);
    const changed = structuredClone(request);
    changed.estimate.boundedConservativeMaximum = '2';
    const conflict = await authorizeReservation(changed, makePorts(pool, scope));
    assert.equal(conflict.ok, false);
    assert.equal(conflict.error.code, 'IDEMPOTENCY_CONFLICT');
    assert.equal(await countEvents(pool, scope), 1);
  } finally {
    await pool.end();
  }
});

test('CI-05A.4 a COMMIT acknowledged only after the deadline leaves one hold that a same-key retry returns', async () => {
  const scope = makeScope('late-commit');
  const request = await scriptedRequest(scope, { amount: '1' });
  let acknowledge;
  let pending;
  let persisted;
  let inserts = 0;
  let firstCommit = true;
  const script = scriptedClient((sql, values) => {
    if (sql.includes('INSERT INTO cost_intelligence.budget_reservation_events')) {
      inserts += 1;
      pending = {
        reservation_id: values[6], event_type: values[7], event_sequence: 1, currency: values[5], held_amount: values[9],
        estimate_completeness: values[10], known_subtotal: values[11], bounded_maximum: values[12], allow_partial: values[13], partial_allowed_amount: values[14],
        policy_version_id: values[15], rate_card_ref: values[16], policy_ref: values[17], attempt_binding: values[21],
      };
      return [];
    }
    if (sql === 'COMMIT' && firstCommit) {
      firstCommit = false;
      return new Promise(resolve => { acknowledge = () => { persisted = pending; resolve([]); }; });
    }
    if (sql.includes('ORDER BY event_sequence ASC')) return persisted ? [persisted] : [];
    return partitionRows(POLICY, '5', persisted ? '1' : '0')(sql);
  });
  const ports = scriptedPorts(scope, async () => script.client, { authorityWaitMs: 25 });

  // The deadline expires while the COMMIT is unacknowledged: retryable unavailable, outcome ambiguous.
  const timedOut = await authorizeReservation(request, ports);
  assert.equal(timedOut.ok, true);
  assert.equal(timedOut.value.status, 'unavailable');
  assert.ok(timedOut.value.retryAfterMs > 0);
  assert.equal(inserts, 1);
  assert.equal(persisted, undefined, 'nothing is acknowledged yet, and no rollback is promised');

  // The COMMIT later persists; the abandoned work finishes and returns its connection.
  acknowledge();
  await delay(10);
  assert.equal(script.state.released, 1);

  // Retrying with the same idempotency key returns exactly the one persisted reservation, with no second insert.
  const retry = await authorizeReservation(request, ports);
  assert.equal(retry.ok, true, retry.ok ? '' : retry.error.code);
  assert.equal(retry.value.status, 'authorized');
  assert.equal(retry.value.reservationId, persisted.reservation_id);
  assert.equal(inserts, 1, 'the same-key retry creates no second hold');
});
