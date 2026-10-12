import './collector-evidence.test.mjs';
import './reported-cost.test.mjs';
import './settlement-integrity.test.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  authorizeReservation, changeBudgetPolicy, readCapacity, markReservationDispatched, normalizedBudgetRequest,
} from '../../dist/index.js';
import {
  loadReserveFixture, setBudgetLimit, reservationPool, makePorts, makeScope, policyChange, reservationRequest,
  scriptedClient, scriptedPorts, partitionRows, delay,
} from './reservation-harness.mjs';

const fixturePromise = loadReserveFixture();

async function intakeObservation(scope, { binding, money } = {}) {
  const request=JSON.parse(await readFile(new URL('../../fixtures/metering/usage-observation.request.json',import.meta.url),'utf8'));
  Object.assign(request,{scope,requestId:randomUUID(),idempotencyKey:randomUUID(),evidenceProvenanceRef:`fixture:synthetic:${randomUUID()}`});
  Object.assign(request.usageEvent,{tenant_id:scope.tenantId,project_id:scope.projectId,environment:scope.environment,billing_mode:scope.billingMode,
    event_id:randomUUID(),usage_event_id:randomUUID(),source_observation_id:randomUUID(),correlation_id:randomUUID(),
    logical_operation_id:binding?.logicalOperationId??randomUUID(),provider_attempt_id:binding?.providerAttemptId??randomUUID(),
    billable_attempt_id:binding?.billableAttemptId??randomUUID(),transport_attempt_id:binding?.transportAttemptId??randomUUID(),provider_request_id:null,
    occurred_at:'2026-10-12T04:00:00Z',observed_at:'2026-10-12T04:00:00Z',ingested_at:'2026-10-12T04:00:00Z'});
  if(money)request.usageEvent.valuation.money=money;
  else Object.assign(request.usageEvent,{completeness:'incomplete',usage_units:null,missing_fields:['usage','amount'],valuation:{basis:'unknown',money:null,rate_card_ref:null},outcome:'partial'});
  return request;
}

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
    policy_version_id: POLICY.id, policy_ref: POLICY, rate_card_ref: null, authorization_request:normalizedBudgetRequest(request),reservation_event_id:randomUUID(),content_hash:`sha256:${'c'.repeat(64)}`,authorized_cap:request.estimate.knownSubtotal,...overrides,
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
    attempt: { ...original, attemptBinding: { ...original.attemptBinding, providerAttemptId: 'another-attempt' } },
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
    if (sql.includes('WITH effective_spend')) await delay(80);
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
    actor_reference: change.actorReference, reason_reference: change.reasonReference, source_authority_ref: change.sourceAuthorityRef, change_request:normalizedBudgetRequest(change),
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
    const changedAttempt = { ...request, attemptBinding: { ...request.attemptBinding, providerAttemptId: `provider-${randomUUID()}` } };
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
        partial_allowed_amount: values[14], policy_version_id: values[15], rate_card_ref: values[16], policy_ref: values[17], attempt_binding: values[21], authorization_request:values[25],reservation_event_id:values[0],content_hash:values[24],authorized_cap:values[28],
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
        policy_version_id: values[15], rate_card_ref: values[16], policy_ref: values[17], attempt_binding: values[21], authorization_request:values[25],reservation_event_id:values[0],content_hash:values[24],authorized_cap:values[28],
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

// CI05A public Finance-local mapping; host/source grants here are explicitly synthetic offline fixtures.
const api = await import('../../dist/index.js');
function publicPorts(pool, scope, options={}) {
  const low=makePorts(pool,scope,options);
  return {...low,storage:{isAvailable:async()=>true},providerSource:{isAvailable:async()=>true},budgets:{database:low.database,authorityWaitMs:low.authorityWaitMs,reservationAuthority:low.reservationAuthority,budgetEvidence:low.budgetEvidence,sourceCollector:low.sourceCollector,reportedCostContractMode:low.reportedCostContractMode}};
}
function currentQuery(scope,request,id,phase='preparation',extra={}) {
  return {schemaVersion:'1.0.0',requestId:randomUUID(),scope,reservationId:id,attemptBinding:request.attemptBinding,authorityBinding:request.authorityBinding,phase,...extra};
}
test('public authority returns exact Finance fields and revalidates current revocation, lifetime, scope and target in both phases',async()=>{
  const pool=reservationPool();const scope=makeScope('public-current');const fixture=await fixturePromise;
  let revoked=false;let sourceRevoked=false;let time=new Date('2026-10-12T04:00:00Z');
  const base=makePorts(pool,scope,{clock:{now:()=>new Date(time)}});
  const options={clock:{now:()=>new Date(time)},reservationAuthority:{verifyCurrent:async query=>revoked?null:base.reservationAuthority.verifyCurrent(query)},budgetEvidence:{verifyCurrent:async query=>sourceRevoked?null:base.budgetEvidence.verifyCurrent(query)}};
  const ports=publicPorts(pool,scope,options);
  try{
    await setBudgetLimit(pool,scope,'2');
    const req=reservationRequest(scope,fixture,{amount:'0.75'});const result=await api.authorize(req,ports);assert.equal(result.ok,true);assert.equal(result.value.status,'authorized');
    const f=result.value.finance;assert.equal(f.billable_attempt_id,req.attemptBinding.billableAttemptId);assert.equal(f.budget_scope_id,req.canonicalRequest.budget_scope_id);assert.equal(f.authorized_cap.amount,'0.75');assert.equal(f.held_amount.amount,'0.75');assert.equal(f.grant_ref,req.authorityBinding.grantRef);assert.match(f.evidence_sha256,/^sha256:[a-f0-9]{64}$/);
    const read=await api.getReservationSnapshot({schemaVersion:'1.0.0',requestId:randomUUID(),scope,reservationId:result.value.reservationId},ports);assert.equal(read.ok,true);assert.equal(read.value.dispatchEligible,false);assert.equal(api.validateReservationSnapshotBoundary(read.value).ok,true);
    const query=currentQuery(scope,req,result.value.reservationId);let current=await api.revalidateAuthorization(query,ports);assert.equal(current.value.status,'authorized');
    for(const field of ['grantRef','accountRef','projectRef','provider','model','operation','targetBindingSha256','leaseRef','budgetScopeId']){
      const bad={...query,authorityBinding:{...query.authorityBinding,[field]:field==='targetBindingSha256'?`sha256:${'c'.repeat(64)}`:'wrong'}};
      current=await api.revalidateAuthorization(bad,ports);assert.equal(current.value.status,'denied',field);
    }
    current=await api.revalidateAuthorization({...query,expectedRevision:999},ports);assert.equal(current.value.status,'denied');
    const dispatch=(await import('./reservation-harness.mjs')).markDispatchedCommand(scope,result.value.reservationId,1,{attemptBinding:req.attemptBinding});
    const marked=await api.markDispatched(dispatch,ports);assert.equal(marked.ok,true);assert.equal(marked.value.state,'dispatched');
    const post=currentQuery(scope,req,result.value.reservationId,'post_transport_ack',{dispatchIntentRef:dispatch.dispatchIntentRef,transportAttemptId:req.attemptBinding.transportAttemptId,expectedRevision:2});
    current=await api.revalidateAuthorization(post,ports);assert.equal(current.value.status,'authorized');
    current=await api.revalidateAuthorization({...post,dispatchIntentRef:authorityRefForTest()},ports);assert.equal(current.value.status,'denied');
    revoked=true;for(const q of [query,post])assert.equal((await api.revalidateAuthorization(q,ports)).value.status,'denied');revoked=false;
    sourceRevoked=true;assert.equal((await api.revalidateAuthorization(post,ports)).value.status,'denied');sourceRevoked=false;
    time=new Date('2026-10-12T05:00:00Z');current=await api.revalidateAuthorization(post,ports);assert.equal(current.value.status,'denied');
    const cap=await readCapacity(scope,'USD','retained',makePorts(pool,scope));assert.equal(cap.value.usedCapacity,'0.75','expiry/revocation never releases uncertain exposure');
    const foreign=await api.getReservationSnapshot({schemaVersion:'1.0.0',requestId:randomUUID(),scope:makeScope('foreign'),reservationId:result.value.reservationId},ports);assert.equal(foreign.ok,false);
  }finally{await pool.end();}
});
function authorityRefForTest(){return {contract:'cost-intelligence.authority',schema_version:'1.0.0',id:randomUUID(),revision:1,content_hash:`sha256:${'a'.repeat(64)}`};}
test('public unknown-price authority preserves provenance and requires current exact maximum and independent source authentication',async()=>{
  const pool=reservationPool();const scope=makeScope('maximum');const fixture=await fixturePromise;
  try{
    await setBudgetLimit(pool,scope,'2');const maxRef=authorityRefForTest();
    const maximum={policyRef:maxRef,authorizedCap:'0.75',currency:'USD'};
    const req=reservationRequest(scope,fixture,{amount:'0.75',provider:'openrouter',trustedMaximum:maximum,estimate:{completeness:'unknown',knownSubtotal:'0',currency:'USD',rateCardRef:null,missingDimensions:['output_image_tokens'],boundedConservativeMaximum:'0.75',maximumPolicyRef:maxRef}});
    const granted=await api.authorize(req,publicPorts(pool,scope,{maximum}));assert.equal(granted.value.status,'authorized');assert.equal(granted.value.estimateCompleteness,'unknown');assert.equal(granted.value.finance.authorized_cap.amount,'0.75');
    for(const bad of [{...maximum,authorizedCap:'1'},{...maximum,currency:'EUR'},{...maximum,policyRef:{...maxRef,revision:2}}]){
      const newReq=reservationRequest(scope,fixture,{amount:'0.75',estimate:req.estimate,provider:'openrouter',trustedMaximum:maximum});
      const denied=await api.authorize(newReq,publicPorts(pool,scope,{maximum:bad}));assert.equal(denied.value.status,'denied');
    }
    const untrusted=await api.authorize(reservationRequest(scope,fixture),publicPorts(pool,scope,{budgetEvidence:{verifyCurrent:async()=>({status:'verified',queryDigest:`sha256:${'a'.repeat(64)}`,verifiedAt:'2026-10-12T04:00:00Z',expiresAt:'2026-10-12T05:00:00Z'})}}));assert.equal(untrusted.ok,false);
    const query=currentQuery(scope,req,granted.value.reservationId);assert.equal((await api.revalidateAuthorization(query,publicPorts(pool,scope,{maximum}))).value.status,'authorized');assert.equal((await api.revalidateAuthorization(query,publicPorts(pool,scope))).value.status,'denied');
  }finally{await pool.end();}
});
test('public partial authorization requires exact bounded acknowledged revised work and current plan evidence',async()=>{
  const pool=reservationPool();const scope=makeScope('partial-ack');const fixture=await fixturePromise;
  try{
    await setBudgetLimit(pool,scope,'0.6');const req=reservationRequest(scope,fixture,{amount:'1',allowPartialAuthorization:true,workPlan:{requestedUnits:10,unit:'synthetic_work_unit',unitMaximumAmount:'0.1'}});const ports=publicPorts(pool,scope);
    const grant=await api.authorize(req,ports);assert.equal(grant.value.status,'partial');assert.equal(grant.value.partialAuthorization.allowedWorkUnits,'6');
    const query=currentQuery(scope,req,grant.value.reservationId);assert.equal((await api.revalidateAuthorization(query,ports)).value.status,'denied');
    const revisedPlan={requestedUnits:6,unit:'synthetic_work_unit',unitMaximumAmount:'0.1'};
    const ack={schemaVersion:'1.0.0',requestId:randomUUID(),idempotencyKey:randomUUID(),scope,reservationId:grant.value.reservationId,expectedRevision:1,actorReference:scope.actorId,attemptBinding:req.attemptBinding,sourceAuthorityRef:authorityRefForTest(),allowedAmount:'0.6',allowedWorkUnits:6,unit:'synthetic_work_unit',revisedPlan,revisedPlanHash:await api.budgetDigest(revisedPlan)};
    const bad=await api.acknowledgePartial({...ack,revisedPlan:{...revisedPlan,requestedUnits:7}},ports);assert.equal(bad.ok,false);
    const earlyDispatch=(await import('./reservation-harness.mjs')).markDispatchedCommand(scope,grant.value.reservationId,1,{attemptBinding:req.attemptBinding});
    const [applied,early]=await Promise.all([api.acknowledgePartial(ack,ports),api.markDispatched(earlyDispatch,ports)]);assert.equal(applied.ok,true);assert.equal(applied.value.revision,2);assert.ok(!early.ok||early.value.state==='held','an ack/dispatch race cannot dispatch against the pre-ack revision');
    const ackCount=await pool.query('SELECT count(*)::int AS count FROM cost_intelligence.budget_reservation_acknowledgements WHERE reservation_id=$1',[grant.value.reservationId]);assert.equal(ackCount.rows[0].count,1);
    const replay=await api.acknowledgePartial(ack,ports);assert.equal(replay.value.status,'replay');
    const changed=await api.acknowledgePartial({...ack,allowedAmount:'0.5'},ports);assert.equal(changed.ok,false);assert.equal(changed.error.code,'IDEMPOTENCY_CONFLICT');
    assert.equal((await api.revalidateAuthorization({...query,expectedRevision:2},ports)).value.status,'authorized');
    const base=makePorts(pool,scope);const revoked=publicPorts(pool,scope,{budgetEvidence:{verifyCurrent:async q=>q.operation==='acknowledgePartial'?null:base.budgetEvidence.verifyCurrent(q)}});
    assert.equal((await api.revalidateAuthorization(query,revoked)).value.status,'denied');
    const command=(await import('./reservation-harness.mjs')).markDispatchedCommand(scope,grant.value.reservationId,2,{attemptBinding:req.attemptBinding});
    assert.equal((await api.markDispatched(command,revoked)).ok,false);const dispatched=await api.markDispatched(command,ports);assert.equal(dispatched.ok,true);assert.equal(dispatched.value.state,'dispatched');
  }finally{await pool.end();}
});
test('public changeBudget rejects reductions below commitments, replays exact commands and exposes exact 80 percent state',async()=>{
  const pool=reservationPool();const scope=makeScope('approved-policy');const fixture=await fixturePromise;
  try{
    const prior=await setBudgetLimit(pool,scope,'1');const ports=publicPorts(pool,scope);await api.authorize(reservationRequest(scope,fixture,{amount:'0.8'}),ports);
    const cap=await readCapacity(scope,'USD','threshold',makePorts(pool,scope));assert.equal(cap.value.capacityState,'near_limit');assert.equal(cap.value.policyWindow,'project_lifetime');
    const command={schemaVersion:'1.0.0',requestId:randomUUID(),idempotencyKey:randomUUID(),scope,newLimit:'0.7',currency:'USD',expectedPolicyRevision:1,expectedLedgerRevision:0,actorReference:scope.actorId,reasonReference:'approved-rule-test',sourceAuthorityRef:authorityRefForTest()};
    const denied=await api.changeBudget(command,ports);assert.equal(denied.value.status,'denied');const deniedReplay=await api.changeBudget(command,ports);assert.equal(deniedReplay.value.status,'replay');assert.equal(deniedReplay.value.replayedStatus,'denied');assert.equal(denied.value.effectiveLimit,'1');assert.equal(denied.value.activeUnconsumedCommitments,'0.8');
    const allowed={...command,idempotencyKey:randomUUID(),newLimit:'2'};const change=await api.changeBudget(allowed,ports);assert.equal(change.value.status,'applied');const replay=await api.changeBudget(allowed,ports);assert.equal(replay.value.status,'replay');assert.equal(replay.value.previousLimit,'1');
    const staleCommand={...command,idempotencyKey:randomUUID(),newLimit:'3'};const stale=await api.changeBudget(staleCommand,ports);assert.equal(stale.value.status,'stale');assert.equal((await api.changeBudget(staleCommand,ports)).value.replayedStatus,'stale');
    const changed=await api.changeBudget({...allowed,reasonReference:'changed'},ports);assert.equal(changed.error.code,'IDEMPOTENCY_CONFLICT');
    assert.equal(prior.policyRevision,1);
  }finally{await pool.end();}
});

function budgetLedgerEvent(scope,{amount='0.3',billableAttemptId=randomUUID(),logicalOperationId=randomUUID()}={}){
  const id=randomUUID();const unknown=amount===null;
  return {schemaVersion:'1.0.0',requestId:id,idempotencyKey:id,scope,eventId:id,correlationId:randomUUID(),producer:{module:'ci05a.synthetic.test',sourceRevision:'a'.repeat(40),buildRevision:'fixture-1'},occurredAt:'2026-10-12T03:00:00Z',observedAt:'2026-10-12T03:00:01Z',evidenceMode:'mocked',verificationStatus:'verified',eventType:'expense',classification:'direct_cost',valuation:unknown?'unknown':'provider_confirmed',settlementStatus:'unpaid',reconciliationStatus:'unmatched',reservationLifecycle:null,identities:{logicalOperationId,sourceObservationId:randomUUID(),reservationId:null},postingMapping:{schemaVersion:'1.0.0',sourceLineId:id,transportAttemptId:{status:'not_applicable'},providerAttemptId:{status:'not_applicable'},providerRequestId:{status:'not_applicable'},billableAttemptId:{status:'known',id:billableAttemptId}},sourceIdentity:{source:'ci05a-synthetic',sourceEventId:id,sourceObjectId:id,revisionSubjectId:id,sourceRevision:'fixture-1',revisionSequence:0,contentHash:`sha256:${'d'.repeat(64)}`},usage:{completeness:unknown?'unknown':'complete',missingFields:unknown?['amount']:[],units:unknown?[]:[{name:'tokens',quantity:'1',scale:0,relation:'standalone'}]},money:{amount,currency:'USD',scale:typeof amount==='string'?(amount.split('.')[1]?.length??0):0},sourceRefs:[],dimensions:{},pricing:null,fxEvidence:null,financialEffect:true,reservationAuthorizationEventId:null,supersedesEventId:null,reversesEventId:null};
}
test('effective ledger costs and reservation holds conserve spend, sum distinct economic source costs and never count settled portions twice',async()=>{
  const pool=reservationPool();const scope=makeScope('ledger-capacity');const fixture=await fixturePromise;const ports=makePorts(pool,scope);
  try{
    await setBudgetLimit(pool,scope,'2');const req=reservationRequest(scope,fixture,{amount:'1'});const grant=await api.authorize(req,publicPorts(pool,scope));
    for(const amount of ['0.2','0.3']){
      const posted=await api.appendLedgerEvent(budgetLedgerEvent(scope,{amount,billableAttemptId:req.attemptBinding.billableAttemptId,logicalOperationId:req.attemptBinding.logicalOperationId}),ports);assert.equal(posted.ok,true,posted.ok?'':posted.error.safe_message);assert.equal(posted.value.status,'accepted');
    }
    let cap=await readCapacity(scope,'USD','joined',ports);assert.equal(cap.value.effectiveConsumedSpend,'0.5');assert.equal(cap.value.outstandingHolds,'0.5');assert.equal(cap.value.usedCapacity,'1');
    const helpers=await import('./reservation-harness.mjs');const settlement=helpers.settleCommand(scope,grant.value.reservationId,1,{cumulativeAmount:'0.4',finality:'partial',attemptBinding:req.attemptBinding});assert.equal((await api.settleReservation(settlement,ports)).ok,true);
    cap=await readCapacity(scope,'USD','joined-settled',ports);assert.equal(cap.value.usedCapacity,'1');assert.equal(cap.value.effectiveConsumedSpend,'0.5','two distinct source cost rows sum before comparison to cumulative reservation consumption');
    const other=await api.appendLedgerEvent(budgetLedgerEvent(scope,{amount:'0.7'}),ports);assert.equal(other.value.status,'accepted');
    cap=await readCapacity(scope,'USD','unlinked',ports);assert.equal(cap.value.usedCapacity,'1.7');
    const denied=await api.authorize(reservationRequest(scope,fixture,{amount:'0.4'}),publicPorts(pool,scope));assert.equal(denied.value.status,'denied');
    const unknown=await api.appendLedgerEvent(budgetLedgerEvent(scope,{amount:null}),ports);assert.equal(unknown.value.status,'accepted');
    cap=await readCapacity(scope,'USD','unknown',ports);assert.equal(cap.value.unresolvedExposure,true);
    const unavailable=await api.authorize(reservationRequest(scope,fixture,{amount:'0.1'}),publicPorts(pool,scope));assert.equal(unavailable.value.status,'unavailable','unknown ledger exposure cannot be treated as zero');
  }finally{await pool.end();}
});
test('public authority bounds late connection and preserves denial-before-unavailable for missing host composition',async()=>{
  const scope=makeScope('public-timeout');const req=await scriptedRequest(scope,{amount:'0.1'});const script=scriptedClient(partitionRows(POLICY,'2'));
  const ports=publicPorts({connect:async()=>{await delay(80);return script.client;}},scope,{authorityWaitMs:20});
  const result=await api.authorize(req,ports);assert.equal(result.value.status,'unavailable');assert.ok(result.value.retryAfterMs>0);await delay(100);assert.equal(script.wrote(),false);
  const noBudget=publicPorts({connect:async()=>script.client},scope,{financeAuthority:{authorizeCurrent:async r=>({status:'denied',operation:r.operation,permission:r.permission})}});delete noBudget.budgets;const denied=await api.authorize(req,noBudget);assert.equal(denied.ok,false);assert.equal(denied.error.code,'FORBIDDEN_SCOPE');
});

test('current host/source refusal or never-resolving verification after the lock releases the transaction without late admission',async()=>{
  const fixture=await fixturePromise;const pool=reservationPool();
  try{
    for(const mode of ['host_refused','host_never','source_refused','source_never']){
      const scope=makeScope(`cleanup-${mode}`);await setBudgetLimit(pool,scope,'1');const req=reservationRequest(scope,fixture,{amount:'0.75'});const normal=makePorts(pool,scope);let hostCalls=0,sourceCalls=0;
      const options={authorityWaitMs:150,reservationAuthority:{verifyCurrent:async query=>{hostCalls++;if(mode.startsWith('host')&&hostCalls===2)return mode.endsWith('never')?new Promise(()=>{}):null;return normal.reservationAuthority.verifyCurrent(query);}},budgetEvidence:{verifyCurrent:async query=>{sourceCalls++;if(mode.startsWith('source')&&sourceCalls===2)return mode.endsWith('never')?new Promise(()=>{}):null;return normal.budgetEvidence.verifyCurrent(query);}}};
      const result=await api.authorize(req,publicPorts(pool,scope,options));
      if(mode.endsWith('never'))assert.equal(result.value.status,'unavailable',mode);else assert.equal(result.error.code,'FORBIDDEN_SCOPE',mode);
      assert.equal(mode.startsWith('host')?hostCalls:sourceCalls,2,`${mode} reaches the final check inside the transaction`);
      await delay(30);assert.equal(await countEvents(pool,scope),0,`${mode} persists no authorization`);
      const retry=await api.authorize(req,publicPorts(pool,scope,{authorityWaitMs:500}));assert.equal(retry.value.status,'authorized',`${mode} leaves the lock available for an identical-key retry`);assert.equal(await countEvents(pool,scope),1);
    }
  }finally{await pool.end();}
});

// R1 review regressions use synthetic independent proofs and deterministic trusted time on actual PostgreSQL.
function assertNoCurrentAuthority(result,message){assert.ok(!result.ok||result.value.status==='denied'||result.value.status==='unavailable',message);assert.equal(result.value?.finance,undefined,message);}
async function partialFixture(pool,scope,fixture,clock){
  await setBudgetLimit(pool,scope,'0.6');const req=reservationRequest(scope,fixture,{amount:'1',allowPartialAuthorization:true,workPlan:{requestedUnits:10,unit:'unit',unitMaximumAmount:'0.1'}});
  const ports=publicPorts(pool,scope,{clock});const grant=await api.authorize(req,ports);assert.equal(grant.value.status,'partial');
  const revisedPlan={requestedUnits:6,unit:'unit',unitMaximumAmount:'0.1'};
  const ack={schemaVersion:'1.0.0',requestId:randomUUID(),idempotencyKey:randomUUID(),scope,reservationId:grant.value.reservationId,expectedRevision:1,actorReference:scope.actorId,attemptBinding:req.attemptBinding,sourceAuthorityRef:authorityRefForTest(),allowedAmount:'0.6',allowedWorkUnits:6,unit:'unit',revisedPlan,revisedPlanHash:await api.budgetDigest(revisedPlan)};
  return {req,ports,grant,ack};
}
test('R1-001 partial proof expiry refuses ack, both current phases and dispatch, retains exposure and bounds a fresh envelope',async()=>{
  const pool=reservationPool();const fixture=await fixturePromise;const scope=makeScope('r1-plan');let now=Date.parse('2026-10-12T04:00:00Z');const clock={now:()=>new Date(now)};
  try{
    const {req,ports,grant,ack}=await partialFixture(pool,scope,fixture,clock);const ordinary=makePorts(pool,scope,{clock});
    const expired=publicPorts(pool,scope,{clock,budgetEvidence:{verifyCurrent:async q=>{const d=await ordinary.budgetEvidence.verifyCurrent(q);if(q.operation==='acknowledgePartial'){d.expiresAt=new Date(now+1).toISOString();now+=10;}return d;}}});
    assertNoCurrentAuthority(await api.acknowledgePartial(ack,expired),'expired plan cannot create acknowledgement');assert.equal(await countEvents(pool,scope),1);
    assert.equal((await api.acknowledgePartial(ack,ports)).value.status,'applied');
    const pre=currentQuery(scope,req,grant.value.reservationId,'preparation',{expectedRevision:2});assertNoCurrentAuthority(await api.revalidateAuthorization(pre,expired),'expired preparation plan');
    const command=(await import('./reservation-harness.mjs')).markDispatchedCommand(scope,grant.value.reservationId,2,{attemptBinding:req.attemptBinding});
    assertNoCurrentAuthority(await api.markDispatched(command,expired),'expired dispatch plan');assert.equal(await countEvents(pool,scope),1);
    let expiry;const fresh=publicPorts(pool,scope,{clock,budgetEvidence:{verifyCurrent:async q=>{const d=await ordinary.budgetEvidence.verifyCurrent(q);if(q.operation==='acknowledgePartial'){expiry=new Date(now+50).toISOString();d.expiresAt=expiry;}return d;}}});
    const current=await api.revalidateAuthorization(pre,fresh);assert.equal(current.value.status,'authorized');assert.equal(current.value.finance.expires_at,expiry,'Finance envelope includes the revised-plan TTL');
    assert.equal((await api.markDispatched(command,ports)).value.state,'dispatched');
    const post=currentQuery(scope,req,grant.value.reservationId,'post_transport_ack',{expectedRevision:3,dispatchIntentRef:command.dispatchIntentRef,transportAttemptId:req.attemptBinding.transportAttemptId});
    assertNoCurrentAuthority(await api.revalidateAuthorization(post,expired),'expired post-ack plan');
    assert.equal((await readCapacity(scope,'USD','retained-plan',makePorts(pool,scope,{clock}))).value.usedCapacity,'0.6');
    assert.equal((await api.revalidateAuthorization(post,ports)).value.status,'authorized','independently fresh evidence recovers the same hold');
  }finally{await pool.end();}
});
test('R1-002 expired final host or maximum-source proof rejects admission before any hold',async()=>{
  const pool=reservationPool();const fixture=await fixturePromise;
  try{for(const mode of ['host','maximum']){
    const scope=makeScope(`r1-admission-${mode}`);await setBudgetLimit(pool,scope,'2');let now=Date.parse('2026-10-12T04:00:00Z');const clock={now:()=>new Date(now)};const maximumRef=authorityRefForTest();
    const estimate={completeness:'unknown',knownSubtotal:'0',currency:'USD',rateCardRef:null,missingDimensions:['output_image_tokens'],boundedConservativeMaximum:'0.75',maximumPolicyRef:maximumRef};
    const req=reservationRequest(scope,fixture,mode==='maximum'?{amount:'0.75',estimate,trustedMaximum:{policyRef:maximumRef,authorizedCap:'0.75',currency:'USD'}}:{amount:'0.75'});const ordinary=makePorts(pool,scope,{clock,maximum:{policyRef:maximumRef,authorizedCap:'0.75',currency:'USD'}});let sourceCalls=0,financeCalls=0;
    const ports=publicPorts(pool,scope,{clock,financeAuthority:{authorizeCurrent:async q=>{financeCalls++;const d=await ordinary.financeAuthority.authorizeCurrent(q);if(mode==='maximum'&&financeCalls===3)now+=10;return d;}},reservationAuthority:{verifyCurrent:async q=>{const d=await ordinary.reservationAuthority.verifyCurrent(q);if(mode==='host')d.expiresAt=new Date(now+1).toISOString();return d;}},budgetEvidence:{verifyCurrent:async q=>{sourceCalls++;const d=await ordinary.budgetEvidence.verifyCurrent(q);if(sourceCalls===2){if(mode==='host')now+=10;else d.expiresAt=new Date(now+1).toISOString();}return d;}}});
    assertNoCurrentAuthority(await api.authorize(req,ports),mode);assert.equal(await countEvents(pool,scope),0,'rejected pre-commit proof cannot create a hold');
  }}finally{await pool.end();}
});
test('R1-002 final supporting evidence is persisted and emitted expiry includes source and Finance proof lifetimes',async()=>{
  const pool=reservationPool();const fixture=await fixturePromise;const scope=makeScope('r1-provenance');const clock={now:()=>new Date('2026-10-12T04:00:00Z')};
  try{
    await setBudgetLimit(pool,scope,'2');const ordinary=makePorts(pool,scope,{clock});let hostCalls=0,sourceCalls=0;const req=reservationRequest(scope,fixture);
    const ports=publicPorts(pool,scope,{clock,financeAuthority:{authorizeCurrent:async q=>{const d=await ordinary.financeAuthority.authorizeCurrent(q);d.expiresAt='2026-10-12T04:00:03Z';return d;}},reservationAuthority:{verifyCurrent:async q=>{const d=await ordinary.reservationAuthority.verifyCurrent(q);hostCalls++;d.evidenceRef=hostCalls===1?'first-pass':'final-support';d.expiresAt='2026-10-12T04:00:05Z';return d;}},budgetEvidence:{verifyCurrent:async q=>{const d=await ordinary.budgetEvidence.verifyCurrent(q);sourceCalls++;d.expiresAt=sourceCalls===1?'2026-10-12T04:00:30Z':'2026-10-12T04:00:02Z';return d;}}});
    const granted=await api.authorize(req,ports);assert.equal(granted.value.status,'authorized');assert.equal(granted.value.finance.expires_at,'2026-10-12T04:00:02.000Z');
    const row=(await pool.query('SELECT authority_evidence FROM cost_intelligence.budget_reservation_events WHERE reservation_id=$1',[granted.value.reservationId])).rows[0];
    assert.equal(row.authority_evidence.host.evidenceRef,'final-support');assert.equal(row.authority_evidence.source.expiresAt,'2026-10-12T04:00:02Z');assert.equal(row.authority_evidence.finance.operation,'budgets.authorize');
  }finally{await pool.end();}
});
test('R1-002 proof expiry at COMMIT acknowledgement returns unavailable, retains one hold and requires fresh current revalidation',async()=>{
  const pool=reservationPool();const fixture=await fixturePromise;const scope=makeScope('r1-commit-expiry');let now=Date.parse('2026-10-12T04:00:00Z');const clock={now:()=>new Date(now)};
  try{
    await setBudgetLimit(pool,scope,'2');const ordinary=makePorts(pool,scope,{clock});const req=reservationRequest(scope,fixture);
    const commitPool={connect:async()=>{const c=await pool.connect();return {query:async(text,values)=>{const r=await c.query(text,values);if(text==='COMMIT')now+=10;return r;},release:()=>c.release()};}};
    const ports=publicPorts(commitPool,scope,{clock,reservationAuthority:{verifyCurrent:async q=>{const d=await ordinary.reservationAuthority.verifyCurrent(q);d.expiresAt=new Date(now+1).toISOString();return d;}}});
    const result=await api.authorize(req,ports);assertNoCurrentAuthority(result,'post-commit expiry');assert.equal(result.value.status,'unavailable');assert.equal(await countEvents(pool,scope),1,'acknowledged hold is retained, never erased on proof TTL');
    const recovery=publicPorts(pool,scope,{clock});const replay=await api.authorize(req,recovery);assert.equal(replay.value.reservationId,(await pool.query('SELECT reservation_id FROM cost_intelligence.budget_reservation_events WHERE tenant_id=$1',[scope.tenantId])).rows[0].reservation_id);assert.equal(replay.value.historicalReplay,true);assert.equal(replay.value.finance,undefined);assert.equal(await countEvents(pool,scope),1);
    assert.equal((await api.revalidateAuthorization(currentQuery(scope,req,replay.value.reservationId),recovery)).value.status,'authorized');
  }finally{await pool.end();}
});
test('R1-003 Finance permission expiry or revocation across host verification refuses both phases without releasing exposure',async()=>{
  const pool=reservationPool();const fixture=await fixturePromise;
  try{for(const mode of ['expired','revoked']){
    const scope=makeScope(`r1-finance-${mode}`);await setBudgetLimit(pool,scope,'2');let now=Date.parse('2026-10-12T04:00:00Z');const clock={now:()=>new Date(now)};const req=reservationRequest(scope,fixture);const normal=publicPorts(pool,scope,{clock});const grant=await api.authorize(req,normal);
    const command=(await import('./reservation-harness.mjs')).markDispatchedCommand(scope,grant.value.reservationId,1,{attemptBinding:req.attemptBinding});assert.equal((await api.markDispatched(command,normal)).value.state,'dispatched');
    for(const phase of ['preparation','post_transport_ack']){
      let revoked=false,calls=0;const ordinary=makePorts(pool,scope,{clock});const ports=publicPorts(pool,scope,{clock,financeAuthority:{authorizeCurrent:async q=>{calls++;if(revoked)return {status:'denied',operation:q.operation,permission:q.permission};const d=await ordinary.financeAuthority.authorizeCurrent(q);if(mode==='expired')d.expiresAt=new Date(now+1).toISOString();return d;}},reservationAuthority:{verifyCurrent:async q=>{const d=await ordinary.reservationAuthority.verifyCurrent(q);if(mode==='revoked')revoked=true;else now+=10;return d;}}});
      const query=currentQuery(scope,req,grant.value.reservationId,phase,{expectedRevision:2,...(phase==='post_transport_ack'?{dispatchIntentRef:command.dispatchIntentRef,transportAttemptId:req.attemptBinding.transportAttemptId}:{})});
      assertNoCurrentAuthority(await api.revalidateAuthorization(query,ports),`${mode}/${phase}`);assert.ok(calls>=2,'distinct Finance permission is rechecked after the host wait');
    }
    assert.equal((await readCapacity(scope,'USD','finance-retained',makePorts(pool,scope,{clock}))).value.usedCapacity,'0.75');
  }}finally{await pool.end();}
});
test('R1 mutation proof chain refuses expired source authority in budget policy, acknowledgement and dispatch',async()=>{
  const pool=reservationPool();const fixture=await fixturePromise;
  try{for(const operation of ['policy','ack','dispatch']){
    const scope=makeScope(`r1-mutation-${operation}`);let now=Date.parse('2026-10-12T04:00:00Z');const clock={now:()=>new Date(now)};let prepared;
    if(operation==='policy')await setBudgetLimit(pool,scope,'2');else prepared=await partialFixture(pool,scope,fixture,clock);
    if(operation==='dispatch')assert.equal((await api.acknowledgePartial(prepared.ack,prepared.ports)).value.status,'applied');
    const ordinary=makePorts(pool,scope,{clock});let calls=0;const ports=publicPorts(pool,scope,{clock,financeAuthority:{authorizeCurrent:async q=>{calls++;const d=await ordinary.financeAuthority.authorizeCurrent(q);if(calls===2)now+=10;return d;}},budgetEvidence:{verifyCurrent:async q=>{const d=await ordinary.budgetEvidence.verifyCurrent(q);d.expiresAt=new Date(now+1).toISOString();return d;}}});
    let result;if(operation==='policy')result=await api.changeBudget({schemaVersion:'1.0.0',requestId:randomUUID(),idempotencyKey:randomUUID(),scope,newLimit:'3',currency:'USD',expectedPolicyRevision:1,expectedLedgerRevision:0,actorReference:scope.actorId,reasonReference:'r1-lifetime',sourceAuthorityRef:authorityRefForTest()},ports);
    else if(operation==='ack')result=await api.acknowledgePartial(prepared.ack,ports);
    else result=await api.markDispatched((await import('./reservation-harness.mjs')).markDispatchedCommand(scope,prepared.grant.value.reservationId,2,{attemptBinding:prepared.req.attemptBinding}),ports);
    assertNoCurrentAuthority(result,operation);const capacity=await readCapacity(scope,'USD','mutation-retained',makePorts(pool,scope,{clock}));assert.equal(capacity.value.limitAmount,operation==='policy'?'2':'0.6');assert.equal(capacity.value.usedCapacity,operation==='policy'?'0':'0.6');assert.equal(await countEvents(pool,scope),operation==='policy'?0:1);
  }}finally{await pool.end();}
});

test('accepted unpriced public intake blocks uncovered capacity without inventing currency and isolates trusted scopes',async()=>{
  const pool=reservationPool();const scope=makeScope('unpriced-intake');const fixture=await fixturePromise;
  try{
    await setBudgetLimit(pool,scope,'1');await setBudgetLimit(pool,scope,'1','EUR');const ports=publicPorts(pool,scope);
    const observation=await intakeObservation(scope);const receipt=await api.ingestUsage(observation,ports);assert.equal(receipt.ok,true);assert.equal(receipt.value.status,'accepted');assert.equal(receipt.value.outboxStatus,'awaiting_evidence');
    assert.equal((await api.ingestUsage(observation,ports)).value.status,'duplicate');
    for(const currency of ['USD','EUR']){const result=await api.authorize(reservationRequest(scope,fixture,{currency,amount:'0.75'}),ports);assert.equal(result.value.status,'unavailable');assert.equal(result.value.finance,undefined);}
    assert.equal(await countEvents(pool,scope),0,'uncovered unknown exposure grants no hold');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM cost_intelligence.financial_ledger_events WHERE tenant_id=$1',[scope.tenantId])).rows[0].n,0,'unknown intake manufactures no monetary row');
    for(const foreign of [{...scope,tenantId:randomUUID()},{...scope,projectId:randomUUID()},{...scope,environment:'development'},{...scope,billingMode:'sandbox'}]){
      const foreignPorts=publicPorts(pool,foreign);const {limitAmount,...setup}=policyChange(foreign,{limitAmount:'1',expectedPolicyRevision:0});
      const policy=await api.changeBudget({...setup,newLimit:limitAmount,expectedLedgerRevision:0},foreignPorts);assert.equal(policy.ok,true,policy.ok?'':policy.error.code);assert.equal(policy.value.status,'applied');
      const foreignRequest=reservationRequest(foreign,fixture,{policyRef:policy.value.decisionReference,logicalOperationId:observation.usageEvent.logical_operation_id,billableAttemptId:observation.usageEvent.billable_attempt_id});
      foreignRequest.attemptBinding.providerAttemptId=observation.usageEvent.provider_attempt_id;foreignRequest.attemptBinding.transportAttemptId=observation.usageEvent.transport_attempt_id;
      const foreignGrant=await api.authorize(foreignRequest,foreignPorts);assert.equal(foreignGrant.ok,true,foreignGrant.ok?'':foreignGrant.error.code);assert.equal(foreignGrant.value.status,'authorized');
      assert.equal((await api.authorize(reservationRequest(scope,fixture),ports)).value.status,'unavailable','a foreign scoped hold cannot cover this accepted attempt');
    }
  }finally{await pool.end();}
});

test('unpriced intake matches an existing economic hold once; priced intake charges only its known currency',async()=>{
  const pool=reservationPool();const scope=makeScope('covered-intake');const fixture=await fixturePromise;
  try{
    await setBudgetLimit(pool,scope,'1');await setBudgetLimit(pool,scope,'1','EUR');const ports=publicPorts(pool,scope);
    const req=reservationRequest(scope,fixture,{amount:'0.75'});req.attemptBinding.providerAttemptId=randomUUID();req.attemptBinding.transportAttemptId=randomUUID();
    const grant=await api.authorize(req,ports);assert.equal(grant.value.status,'authorized');
    const observation=await intakeObservation(scope,{binding:req.attemptBinding});assert.equal((await api.ingestUsage(observation,ports)).value.outboxStatus,'awaiting_evidence');
    assert.equal((await api.ingestUsage(observation,ports)).value.status,'duplicate');
    const replay=await api.authorize(req,ports);assert.equal(replay.value.reservationId,grant.value.reservationId);assert.equal(replay.value.historicalReplay,true);
    const next=await api.authorize(reservationRequest(scope,fixture,{amount:'0.25'}),ports);assert.equal(next.value.status,'authorized');assert.equal(next.value.availableAmount,'0');assert.equal(await countEvents(pool,scope),2,'the covered attempt adds no second hold or exposure');
    const eur=await api.authorize(reservationRequest(scope,fixture,{currency:'EUR',amount:'0.75'}),ports);assert.equal(eur.value.status,'authorized','a USD hold covering the exact unpriced attempt does not invent an EUR expense');
    const known=makeScope('priced-intake');await setBudgetLimit(pool,known,'1');await setBudgetLimit(pool,known,'1','EUR');const knownPorts=publicPorts(pool,known);
    const knownObservation=await intakeObservation(known,{money:{amount:'0.75',currency:'EUR',scale:2}});const receipt=await api.ingestUsage(knownObservation,knownPorts);assert.equal(receipt.ok,true);assert.equal(receipt.value.outboxStatus,'posted');
    assert.equal((await api.authorize(reservationRequest(known,fixture,{amount:'0.75'}),knownPorts)).value.status,'authorized');
    assert.equal((await api.authorize(reservationRequest(known,fixture,{currency:'EUR',amount:'0.5'}),knownPorts)).value.status,'denied');
  }finally{await pool.end();}
});
