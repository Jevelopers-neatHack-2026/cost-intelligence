import './settlement-integrity.test.mjs';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {diagnosticTest, diagnosticBudgetOperation} from './static-diagnostics.mjs';
const test=diagnosticTest('lifecycle.test.mjs');
import {
  authorizeReservation as rawAuthorizeReservation, changeBudgetPolicy, readCapacity,
  markReservationDispatched as rawMarkReservationDispatched, normalizedBudgetRequest,
  settleReservation as rawSettleReservation, releaseReservation as rawReleaseReservation,
} from '../../dist/index.js';
import {pricingEconomicRequestDigest} from '../../dist/budgets/index.js';
import {
  loadReserveFixture, setBudgetLimit, reservationPool, makePorts, makeScope, policyChange, reservationRequest,
  markDispatchedCommand, settleCommand, releaseCommand, scriptedClient, scriptedPorts, partitionRows,
  refreshSyntheticPricing, FIXED_TIME,
} from './reservation-harness.mjs';
import {signedSourceHarness} from './signed-source-harness.mjs';

const authorizeReservation=diagnosticBudgetOperation(rawAuthorizeReservation);
const markReservationDispatched=diagnosticBudgetOperation(rawMarkReservationDispatched);
const settleReservation=diagnosticBudgetOperation(rawSettleReservation);
const releaseReservation=diagnosticBudgetOperation(rawReleaseReservation);

const fixturePromise = loadReserveFixture();

async function setLimit(pool, scope, limitAmount) {
  return setBudgetLimit(pool, scope, limitAmount);
}

// Explicit test-owner issuance, using the same signed/current source backend as
// settlement-integrity. These records remain mocked evidence, including in PostgreSQL.
async function signedFixture(scope, {amount='1', attemptBinding}={}) {
  const request=reservationRequest(scope, await fixturePromise, {amount});
  request.attemptBinding=attemptBinding??{...request.attemptBinding,providerAttemptId:randomUUID(),transportAttemptId:randomUUID()};
  request.canonicalRequest.logical_operation_id=request.attemptBinding.logicalOperationId;
  request.canonicalRequest.billable_attempt_id=request.attemptBinding.billableAttemptId;
  const clock={now:()=>new Date(FIXED_TIME)};
  const source=await signedSourceHarness(scope,request.authorityBinding,request.attemptBinding,clock);
  const payload={schemaVersion:'ci-budget-pricing-1.0.0',pricingUnit:'fixed_per_attempt',currency:'USD',
    economicRequestDigest:await pricingEconomicRequestDigest(request),fixedAttemptAmount:amount,maximumPolicyRef:null};
  request.pricingProfileRef=await source.publish('pricing_profile',payload,JSON.stringify({financial_pricing_policy:payload}));
  return {scope,request,clock,source,ports:pool=>makePorts(pool,scope,{clock,sourceCollector:source.backend})};
}

function dispatchFor(fixture,reservationId) {
  fixture.dispatch=markDispatchedCommand(fixture.scope,reservationId,1,{attemptBinding:fixture.request.attemptBinding});
  return fixture.dispatch;
}

async function signedSettlement(fixture,reservationId,revision,options) {
  const command=settleCommand(fixture.scope,reservationId,revision,{...options,attemptBinding:fixture.request.attemptBinding});
  command.sourceAuthorityRef=await fixture.source.cost(options.cumulativeAmount);
  command.settlement.sourceObservationRefs=[command.sourceAuthorityRef];
  if(command.settlement.finality==='final') {
    assert.ok(fixture.dispatch,'the fixture must identify its original durable dispatch');
    command.settlement.finalityEvidenceRef=await fixture.source.finality({schemaVersion:'ci-budget-finality-1.0.0',state:'final_billed',
      dispatchIntentRef:fixture.dispatch.dispatchIntentRef,cumulativeCostRef:command.sourceAuthorityRef,fenceReference:null});
  }
  return command;
}

async function signedRelease(fixture,reservationId,revision,options,evidence) {
  const command=releaseCommand(fixture.scope,reservationId,revision,{...options,attemptBinding:fixture.request.attemptBinding});
  command.sourceAuthorityRef=await fixture.source.finality({schemaVersion:'ci-budget-finality-1.0.0',...evidence});
  command.release.evidenceRefs=[command.sourceAuthorityRef];
  return command;
}

test('CI-05A.2/.4 full reservation lifecycle settles without double-counting and conserves capacity', async () => {
  assert.ok(process.env.CI_TEST_DB_RUNTIME_HOST, 'lifecycle suite requires the restricted disposable PostgreSQL role');
  const pool = reservationPool(8);
  try {
    const scope = makeScope('lifecycle');
    await setLimit(pool, scope, '10.00');
    const fixture=await signedFixture(scope,{amount:'2.00'}),ports=fixture.ports(pool);
    const authorized = await authorizeReservation(fixture.request, ports);
    assert.equal(authorized.ok, true, authorized.ok ? '' : authorized.error.code);
    assert.equal(authorized.value.status, 'authorized');
    const reservationId = authorized.value.reservationId;

    const dispatched = await markReservationDispatched(dispatchFor(fixture,reservationId), ports);
    assert.equal(dispatched.ok, true, dispatched.ok ? '' : dispatched.error.code);
    assert.equal(dispatched.value.status, 'applied');
    assert.equal(dispatched.value.state, 'dispatched');
    assert.equal(dispatched.value.revision, 2);

    const partial = await settleReservation(await signedSettlement(fixture,reservationId,2,{cumulativeAmount:'0.500000',finality:'partial',sequence:1}),ports);
    assert.equal(partial.ok, true, partial.ok ? '' : `${partial.error.code}: ${partial.error.safe_message}`);
    assert.equal(partial.value.state, 'partially_settled');
    assert.equal(partial.value.consumedAmount, '0.5');

    const final = await settleReservation(await signedSettlement(fixture,reservationId,3,{cumulativeAmount:'1.200000',finality:'final',sequence:2}),ports);
    assert.equal(final.ok, true, final.ok ? '' : final.error.code);
    assert.equal(final.value.state, 'settled');
    assert.equal(final.value.consumedAmount, '1.2');
    // Authenticated final billing posts the actual and releases the unused
    // remainder atomically; a second explicit release must not free it twice.
    assert.equal(final.value.releasedAmount,'0.8');
    const beforeRelease = await readCapacity(scope, 'USD', 'lifecycle-before', ports);
    assert.equal(beforeRelease.value.usedCapacity, '1.2');
    assert.equal(beforeRelease.value.outstandingHolds,'0');

    const released = await releaseReservation(releaseCommand(scope, reservationId, 4, { amount: '0.800000', proof: 'final_usage_known' , attemptBinding: authorized.value.attemptBinding }), ports);
    assert.equal(released.ok, false);
    assert.equal(released.error.code, 'VALIDATION_ERROR');

    // Effective consumed spend is 1.2; the settled portion is never double-counted with the hold.
    const after = await readCapacity(scope, 'USD', 'lifecycle-after', ports);
    assert.equal(after.value.usedCapacity, '1.2');
    assert.equal(after.value.effectiveConsumedSpend, '1.2');
    assert.equal(after.value.outstandingHolds, '0');
    const expense=await pool.query(`SELECT count(*)::int AS roots,sum(e.amount)::text AS actual FROM cost_intelligence.financial_ledger_events e
      JOIN cost_intelligence.financial_source_revision_heads h ON h.current_event_id=e.event_id
      WHERE e.tenant_id=$1 AND e.project_id=$2 AND e.financial_effect`,[scope.tenantId,scope.projectId]);
    assert.equal(expense.rows[0].roots,1,'partial and final observations share one effective economic expense');
    assert.equal(expense.rows[0].actual,'1.200000000000000000');
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
const ATTEMPT = { logicalOperationId: '123e4567-e89b-42d3-a456-000000000c01', transportAttemptId: '123e4567-e89b-42d3-a456-000000000c02', providerRequestId: null, providerAttemptId: '123e4567-e89b-42d3-a456-000000000c03', billableAttemptId: '123e4567-e89b-42d3-a456-000000000c04' };

/** The aggregated reservation row `loadReservation` reads. */
function reservationRow(overrides = {}) {
  return {
    currency: 'USD', policy_version_id: 'policy-1', held: '1', released: '0', consumed: '0', revision: 1, settlement_revision: 0,
    last_type: 'authorized', last_finality: 'unknown', ever_dispatched: false, first_type: 'authorized',
    financial_expires_at:'2026-10-12T04:01:00.000Z',authority_expires_at:'2026-10-12T04:01:00.000Z',
    original_binding: structuredClone(ATTEMPT), ...overrides,
  };
}

function scriptedLifecycle(row, storedCommand = [], intercept = () => undefined) {
  return scriptedClient((sql,values) => {
    const intercepted=intercept(sql,values);
    if(intercepted!==undefined)return intercepted;
    if (sql.includes('array_agg(event_type ORDER BY event_sequence DESC)')) return row ? [row] : [];
    if (sql.includes('SELECT reservation_id,authorization_request FROM cost_intelligence.budget_reservation_events')) {
      return row?.authorization_request?[{reservation_id:R1,authorization_request:row.authorization_request}]:[];
    }
    if (sql.includes('SELECT s.source_reference FROM cost_intelligence.budget_settlement_postings')) {
      return row?.settlement_source_reference?[{source_reference:row.settlement_source_reference}]:[];
    }
    if (sql.includes('SELECT usage_event FROM cost_intelligence.budget_reported_observations')) {
      return row?.latest_reported_usage?[{usage_event:row.latest_reported_usage}]:[];
    }
    if (row && sql.includes('INSERT INTO cost_intelligence.budget_reported_observations')) row.latest_reported_usage=JSON.parse(values[7]);
    if (row && sql.includes('INSERT INTO cost_intelligence.budget_reservation_events')) {
      Object.assign(row,{revision:values[7],last_type:values[8],last_finality:values[11]});
      if(values[8]==='settled')Object.assign(row,{consumed:values[9],settlement_revision:values[7],settlement_source_reference:JSON.parse(values[18])});
      // This control-flow fixture models one positive terminal release. Further
      // attempts must be rejected; the PostgreSQL cases prove durable summation.
      if(values[10]!=='0') { assert.equal(row.released,'0');row.released=values[10]; }
      if(values[8]==='dispatched')Object.assign(row,{ever_dispatched:true,dispatch_evidence:JSON.parse(values[23])});
    }
    if (sql.includes('idempotency_key = $5')) return storedCommand;
    return null;
  });
}

async function run(command, fn, row, storedCommand, options={}) {
  if(row && !row.authorization_request) {
    const original=reservationRequest(command.scope,await fixturePromise,{amount:row.held,
      logicalOperationId:row.original_binding.logicalOperationId,billableAttemptId:row.original_binding.billableAttemptId});
    original.attemptBinding=structuredClone(row.original_binding);
    refreshSyntheticPricing(original);
    row={...row,authorization_request:original};
  }
  const script = scriptedLifecycle(row, storedCommand);
  const result = await fn(command, scriptedPorts(command.scope, async () => script.client, options));
  return { script, result };
}

async function scriptedSignedFixture(scope,overrides={},intercept) {
  const fixture=await signedFixture(scope,{amount:overrides.held??'1',attemptBinding:ATTEMPT});
  dispatchFor(fixture,R1);
  const row=reservationRow({revision:2,last_type:'dispatched',ever_dispatched:true,authorization_request:fixture.request,
    financial_expires_at:'2026-10-12T04:00:30.000Z',
    dispatch_evidence:fixture.dispatch,...overrides});
  const script=scriptedLifecycle(row,[],intercept);
  return {...fixture,row,script,ports:scriptedPorts(scope,async()=>script.client,{clock:fixture.clock,sourceCollector:fixture.source.backend})};
}

const scopeFor = label => makeScope(label);

function correlationProbe() {
  const calls={source:0,issuer:0};
  return {
    sourceCollector:{loadCurrent:async()=>{calls.source+=1;return null;},loadCurrentIssuerKey:async()=>{calls.issuer+=1;return null;}},
    assertRefused(result) {
      assert.equal(result.ok,false);
      assert.equal(result.error.code,'VALIDATION_ERROR');
      assert.equal(result.error.safe_message,"The attempt binding does not match the reservation's original attempt.");
      assert.deepEqual(calls,{source:0,issuer:0},'attempt correlation must reject before resolving cost, finality or pricing evidence');
    },
  };
}

test('CI-05A.2 release of a dispatched reservation never frees capacity without authoritative evidence', async () => {
  const scope = scopeFor('release-dispatched');
  const dispatched = reservationRow({ revision: 2, last_type: 'dispatched', ever_dispatched: true });
  for (const [proof,code] of [['never_dispatched_fenced','BUDGET_UNAVAILABLE'],['final_usage_known','SOURCE_UNAVAILABLE']]) {
    const { script, result } = await run(releaseCommand(scope, R1, 2, { amount: '1.000000', proof , attemptBinding: ATTEMPT }), releaseReservation, dispatched);
    assert.equal(result.ok, false, proof);
    assert.equal(result.error.code, code, proof);
    assert.match(result.error.safe_message, /hold is preserved/);
    assert.equal(script.wrote(), false, `${proof}: the hold is preserved`);
    assert.equal(script.committed(), false);
  }
  // Partial (non-final) settlement is not final usage either.
  const partial = reservationRow({ revision: 3, last_type: 'settled', last_finality: 'partial', consumed: '0.4', ever_dispatched: true });
  const refused = await run(releaseCommand(scope, R1, 3, { amount: '0.600000', proof: 'final_usage_known' , attemptBinding: ATTEMPT }), releaseReservation, partial);
  assert.equal(refused.result.ok, false);
  assert.equal(refused.result.error.code, 'SOURCE_UNAVAILABLE');
  assert.equal(refused.script.wrote(), false);
  // final-usage proof on a never-settled held reservation is refused too.
  const unsettled = await run(releaseCommand(scope, R1, 1, { amount: '1.000000', proof: 'final_usage_known' , attemptBinding: ATTEMPT }), releaseReservation, reservationRow());
  assert.equal(unsettled.result.ok, false);
  assert.equal(unsettled.script.wrote(), false);
});

test('CI-05A.2 never-dispatched release is accepted only for a whole, durably undispatched hold', async () => {
  const scope = scopeFor('release-fenced');
  const fixture=await scriptedSignedFixture(scope,{revision:1,last_type:'authorized',ever_dispatched:false,dispatch_evidence:null});
  const evidence={state:'fenced_not_dispatched',dispatchIntentRef:null,cumulativeCostRef:null,fenceReference:'synthetic-owner-fence:ci05a-never-dispatched'};
  const command=await signedRelease(fixture,R1,1,{amount:'1.000000',proof:'never_dispatched_fenced'},evidence);
  const whole=await releaseReservation(command,fixture.ports);
  assert.equal(whole.ok, true, whole.ok ? '' : whole.error.code);
  assert.equal(whole.value.releasedAmount,'1');
  assert.equal(whole.value.outstandingHold,'0');
  assert.equal(fixture.script.wrote(), true);
  assert.equal(fixture.script.committed(), true);
  const writes=fixture.script.statements.filter(sql=>sql.startsWith('INSERT')).length;
  assert.equal((await markReservationDispatched({...fixture.dispatch,expectedRevision:2},fixture.ports)).ok,false);
  assert.equal(fixture.script.statements.filter(sql=>sql.startsWith('INSERT')).length,writes,'the released hold fences a late worker');
  // A partial release would leave a dispatchable remainder, so it is not a fence.
  const partial=await scriptedSignedFixture(scope,{revision:1,last_type:'authorized',ever_dispatched:false,dispatch_evidence:null});
  const some=await releaseReservation(await signedRelease(partial,R1,1,{amount:'0.500000',proof:'never_dispatched_fenced'},evidence),partial.ports);
  assert.equal(some.ok, false);
  assert.equal(some.error.code, 'VALIDATION_ERROR');
  assert.equal(partial.script.wrote(), false);
  assert.equal(partial.row.released,'0');
  // Already released: nothing to release.
  const again = await run(releaseCommand(scope, R1, 2, { amount: '0', proof: 'never_dispatched_fenced' , attemptBinding: ATTEMPT }), releaseReservation, reservationRow({ revision: 2, last_type: 'released' }));
  assert.equal(again.result.ok, false);
  assert.equal(again.script.wrote(), false);
});

test('CI-05A.2 final settlement atomically releases exactly the known unused remainder', async () => {
  const scope = scopeFor('release-final');
  const fixture=await scriptedSignedFixture(scope);
  const command=await signedSettlement(fixture,R1,2,{cumulativeAmount:'0.400000',finality:'final'});
  const ok=await settleReservation(command,fixture.ports);
  assert.equal(ok.ok,true,ok.ok?'':ok.error.code);
  assert.equal(ok.value.consumedAmount,'0.4');
  assert.equal(ok.value.releasedAmount,'0.6');
  assert.equal(ok.value.outstandingHold,'0');
  assert.equal(fixture.script.committed(),true);
  const writes=fixture.script.statements.filter(sql=>sql.startsWith('INSERT')).length;
  for(const amount of ['0.600000','0.700000']) {
    const release=releaseCommand(scope,R1,3,{amount,proof:'final_usage_known',attemptBinding:ATTEMPT});
    release.sourceAuthorityRef=command.settlement.finalityEvidenceRef;
    release.release.evidenceRefs=[release.sourceAuthorityRef];
    const over=await releaseReservation(release,fixture.ports);
    assert.equal(over.ok,false);
    assert.equal(over.error.code,'VALIDATION_ERROR');
    assert.equal(fixture.script.statements.filter(sql=>sql.startsWith('INSERT')).length,writes,'final settlement cannot release the same capacity twice');
  }
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
  const probe=correlationProbe();
  const refused = await run(unrelated, markReservationDispatched, reservationRow(),undefined,{sourceCollector:probe.sourceCollector});
  probe.assertRefused(refused.result);
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
    usage_finality: 'unknown', settlement_sequence: null, expected_revision: 1, attempt_binding: structuredClone(ATTEMPT),actor_reference:dispatch.actorReference,source_authority_ref:dispatch.sourceAuthorityRef,command_evidence:normalizedBudgetRequest(dispatch),
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
    const fixture=await signedFixture(scope,{amount:'1.00'}),ports=fixture.ports(pool);
    const authorized = await authorizeReservation(fixture.request, ports);
    assert.equal(authorized.value.status, 'authorized');
    const reservationId = authorized.value.reservationId;
    const dispatched = await markReservationDispatched(dispatchFor(fixture,reservationId), ports);
    assert.equal(dispatched.ok, true, dispatched.ok ? '' : dispatched.error.code);

    for (const [proof,code] of [['never_dispatched_fenced','BUDGET_UNAVAILABLE'],['final_usage_known','SOURCE_UNAVAILABLE']]) {
      const refused = await releaseReservation(releaseCommand(scope, reservationId, 2, { amount: '1.000000', proof , attemptBinding: authorized.value.attemptBinding }), ports);
      assert.equal(refused.ok, false, proof);
      assert.equal(refused.error.code, code, proof);
    }
    const capacity = await readCapacity(scope, 'USD', 'db-release-safety', makePorts(pool, scope));
    assert.equal(capacity.value.availableCapacity, '0', 'the dispatched exposure still holds the whole limit');
    const second = await authorizeReservation(reservationRequest(scope, reserve, { amount: '0.50' }), makePorts(pool, scope));
    assert.equal(second.value.status, 'denied', 'no second worker is authorized against unresolved exposure');

    // A later final settlement still succeeds because the reservation was never released.
    const final = await settleReservation(await signedSettlement(fixture,reservationId,2,{cumulativeAmount:'0.600000',finality:'final',sequence:1}), ports);
    assert.equal(final.ok, true, final.ok ? '' : final.error.code);
    assert.equal(final.value.releasedAmount,'0.4');
    assert.equal(final.value.outstandingHold,'0');
    const released = await releaseReservation(releaseCommand(scope, reservationId, 3, { amount: '0.400000', proof: 'final_usage_known' , attemptBinding: authorized.value.attemptBinding }), ports);
    assert.equal(released.ok,false,'authenticated final settlement already released the remainder');
    assert.equal(released.error.code,'VALIDATION_ERROR');
    const finalCapacity=await readCapacity(scope,'USD','db-final-release',ports);
    assert.equal(finalCapacity.value.effectiveConsumedSpend,'0.6');
    assert.equal(finalCapacity.value.outstandingHolds,'0');
    assert.equal(finalCapacity.value.availableCapacity,'0.4');

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

test('CI-05A.4 a never-acknowledged COMMIT returns unavailable within the deadline (authorize and lifecycle)', async t => {
  const scope = scopeFor('commit-hang');
  const policy = { contract: 'cost-intelligence.budget-policy', schema_version: '1.0.0', id: '123e4567-e89b-42d3-a456-000000000a01', revision: 1, content_hash: `sha256:${'a'.repeat(64)}` };
  const reserve = await fixturePromise;
  const request = reservationRequest(scope, reserve, { amount: '1', policyRef: policy });
  const realSetTimeout=globalThis.setTimeout,realClearTimeout=globalThis.clearTimeout;
  const within=async promise=>{
    let timer;
    try{return await Promise.race([promise,new Promise(resolve=>{timer=realSetTimeout(()=>resolve('hung'),1000);})]);}
    finally{realClearTimeout(timer);}
  };
  let commits=0,authReached,lifecycleReached;
  const authAtCommit=new Promise(resolve=>{authReached=resolve;}),lifecycleAtCommit=new Promise(resolve=>{lifecycleReached=resolve;});
  const rows=partitionRows(policy,'5');
  const auth=scriptedClient((sql,values)=>{
    if(sql==='COMMIT'){commits+=1;authReached();return new Promise(()=>{});}
    return rows(sql,values);
  });
  const fixture=await scriptedSignedFixture(scope,{},sql=>{
    if(sql==='COMMIT'){commits+=1;lifecycleReached();return new Promise(()=>{});}
    return undefined;
  });
  const command=await signedSettlement(fixture,R1,2,{cumulativeAmount:'0.5',finality:'final'});
  // Control elapsed time only in this scripted test. The configured deadline
  // remains 25 ms; real crypto/CPU latency cannot move the test before COMMIT.
  t.mock.timers.enable({apis:['Date','setTimeout'],now:Date.parse(FIXED_TIME)});
  try{
    for(const [kind,start,reached] of [
      ['authorize',()=>authorizeReservation(request,scriptedPorts(scope,async()=>auth.client,{authorityWaitMs:25})),authAtCommit],
      ['settle',()=>settleReservation(command,{...fixture.ports,authorityWaitMs:25}),lifecycleAtCommit],
    ]){
      let finished=false;
      const pending=start().then(result=>{finished=true;return result;});
      assert.notEqual(await within(reached),'hung',`${kind} must reach its intercepted COMMIT`);
      t.mock.timers.tick(24);
      await Promise.resolve();
      assert.equal(finished,false,`${kind} remains pending before the exact deadline`);
      t.mock.timers.tick(1);
      const result=await within(pending);
      assert.notEqual(result,'hung',`${kind} must not await COMMIT acknowledgement beyond its deadline`);
      if(kind==='authorize'){
        assert.equal(result.ok && result.value.status,'unavailable');
        assert.ok(result.value.retryAfterMs>0);
      }else{
        assert.equal(result.ok,false);
        assert.equal(result.error.code,'BUDGET_UNAVAILABLE');
        assert.equal(result.error.retryable,true);
      }
    }
    assert.equal(commits,2);
    assert.equal(fixture.script.statements.filter(sql=>sql.startsWith('INSERT INTO cost_intelligence.financial_ledger_events')).length,1,'the timeout follows the authenticated financial append');
  }finally{t.mock.timers.reset();}
});

test('CI-05A.2 incomplete or unknown caller usage cannot replace authenticated billing finality or release exposure', async () => {
  const scope = scopeFor('settle-unknown');
  for (const completeness of ['unknown', 'incomplete']) {
    const fixture=await scriptedSignedFixture(scope);
    const unsupported=settleCommand(scope,R1,2,{cumulativeAmount:'0.000000',finality:'final',attemptBinding:ATTEMPT});
    unsupported.settlement.usageCompleteness=completeness;
    const missingCost=await settleReservation(unsupported,fixture.ports);
    assert.equal(missingCost.ok,false,'an unregistered cost reference never becomes actual spend');
    assert.equal(missingCost.error.code,'VALIDATION_ERROR');
    assert.equal(fixture.script.wrote(),false);
    const command=await signedSettlement(fixture,R1,2,{cumulativeAmount:'0.000000',finality:'final'});
    delete command.settlement.finalityEvidenceRef;
    command.settlement.usageCompleteness = completeness;
    const refused=await settleReservation(command,fixture.ports);
    assert.equal(refused.ok,false,completeness);
    assert.equal(refused.error.code,'SOURCE_UNAVAILABLE');
    assert.equal(fixture.script.wrote(),false,'caller finality alone cannot append expense or free capacity');
    assert.equal(fixture.row.released,'0');
    assert.equal(fixture.row.consumed,'0');
    // A known reported zero may be posted as partial cost; unknown usage never
    // supplies finality. An unknown bill is not converted to a known zero.
    const settlement=await settleReservation({...command,settlement:{...command.settlement,finality:'partial'}},fixture.ports);
    assert.equal(settlement.ok,true,settlement.ok?'':settlement.error.code);
    assert.equal(settlement.value.usageFinality,'partial');
    assert.equal(settlement.value.state, 'partially_settled');
    assert.equal(settlement.value.outstandingHold, '1', 'the exposure stays held');
    const writes=fixture.script.statements.filter(sql=>sql.startsWith('INSERT')).length;
    const release = await releaseReservation(releaseCommand(scope, R1, 3, { amount: '1.000000', proof: 'final_usage_known', attemptBinding: ATTEMPT }), fixture.ports);
    assert.equal(release.ok, false, completeness);
    assert.equal(release.error.code, 'SOURCE_UNAVAILABLE');
    assert.equal(release.error.retryable, false);
    assert.equal(fixture.script.statements.filter(sql=>sql.startsWith('INSERT')).length,writes);
    assert.equal(fixture.row.released,'0');
  }
  // Genuine authenticated zero cost plus separate final-billed proof releases
  // the whole unused hold atomically, independently of caller usage labels.
  const zero=await scriptedSignedFixture(scope);
  const ok=await settleReservation(await signedSettlement(zero,R1,2,{cumulativeAmount:'0.000000',finality:'final'}),zero.ports);
  assert.equal(ok.ok,true,ok.ok?'':ok.error.code);
  assert.equal(ok.value.consumedAmount,'0');
  assert.equal(ok.value.releasedAmount,'1');
  assert.equal(ok.value.outstandingHold,'0');
});

/* Attempt binding for settle/release and canonical settlement agreement. */

const OTHER_ATTEMPT = { ...ATTEMPT, logicalOperationId: '123e4567-e89b-42d3-a456-000000000d01', billableAttemptId: '123e4567-e89b-42d3-a456-000000000d04' };

test('CI-05A.2 settle and release from an unrelated attempt are rejected without writing', async () => {
  const scope = scopeFor('unrelated-attempt');
  const dispatched = reservationRow({ revision: 2, last_type: 'dispatched', ever_dispatched: true });
  const settlementProbe=correlationProbe();
  const settle = await run(settleCommand(scope, R1, 2, { cumulativeAmount: '0.000000', finality: 'final', attemptBinding: OTHER_ATTEMPT }), settleReservation, dispatched,undefined,{sourceCollector:settlementProbe.sourceCollector});
  settlementProbe.assertRefused(settle.result);
  assert.equal(settle.script.wrote(), false);
  assert.equal(settle.script.committed(), false);

  const settled = reservationRow({ revision: 3, last_type: 'settled', last_finality: 'final', ever_dispatched: true });
  const releaseProbe=correlationProbe();
  const release = await run(releaseCommand(scope, R1, 3, { amount: '1.000000', proof: 'final_usage_known', attemptBinding: OTHER_ATTEMPT }), releaseReservation, settled,undefined,{sourceCollector:releaseProbe.sourceCollector});
  releaseProbe.assertRefused(release.result);
  assert.equal(release.script.wrote(), false);

  // The original attempt still settles and releases.
  const fixture=await scriptedSignedFixture(scope);
  const own=await settleReservation(await signedSettlement(fixture,R1,2,{cumulativeAmount:'0.000000',finality:'final'}),fixture.ports);
  assert.equal(own.ok,true,own.ok?'':own.error.code);
  assert.equal(own.value.releasedAmount,'1');
  assert.equal(own.value.outstandingHold,'0');
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
  const pool = reservationPool(8);
  const count = async scope => (await pool.query(
    `SELECT count(*)::int AS total FROM cost_intelligence.budget_reservation_events
     WHERE tenant_id = $1 AND project_id = $2 AND environment = $3 AND billing_mode = $4`,
    [scope.tenantId, scope.projectId, scope.environment, scope.billingMode])).rows[0].total;
  try {
    const scope = makeScope('db-unrelated-attempt');
    await setLimit(pool, scope, '1.00');
    const fixture=await signedFixture(scope,{amount:'1.00'}),ports=fixture.ports(pool);
    const authorized = await authorizeReservation(fixture.request, ports);
    const id = authorized.value.reservationId;
    const own = authorized.value.attemptBinding;
    const other = { ...own, logicalOperationId: randomUUID(), billableAttemptId: randomUUID() };
    const dispatched = await markReservationDispatched(dispatchFor(fixture,id), ports);
    assert.equal(dispatched.ok, true, dispatched.ok ? '' : dispatched.error.code);
    const events = await count(scope);

    const settlementProbe=correlationProbe();
    const unrelatedSettle = await settleReservation(settleCommand(scope, id, 2, { cumulativeAmount: '0.000000', finality: 'final', attemptBinding: other }), {...ports,sourceCollector:settlementProbe.sourceCollector});
    settlementProbe.assertRefused(unrelatedSettle);

    const contradictory = settleCommand(scope, id, 2, { cumulativeAmount: '0.000000', finality: 'final', attemptBinding: own });
    contradictory.canonicalCommand.consumed = { amount: '9', currency: 'EUR', scale: 0 };
    const mismatch = await settleReservation(contradictory, makePorts(pool, scope));
    assert.equal(mismatch.ok, false);

    const releaseProbe=correlationProbe();
    const unrelatedRelease = await releaseReservation(releaseCommand(scope, id, 2, { amount: '1.000000', proof: 'final_usage_known', attemptBinding: other }), {...ports,sourceCollector:releaseProbe.sourceCollector});
    releaseProbe.assertRefused(unrelatedRelease);

    assert.equal(await count(scope), events, 'no event is written by any rejected command');
    const expensesBefore=await pool.query('SELECT count(*)::int AS count FROM cost_intelligence.financial_ledger_events WHERE tenant_id=$1 AND project_id=$2',[scope.tenantId,scope.projectId]);
    assert.equal(expensesBefore.rows[0].count,0,'rejected commands cannot append expense outside reservation history');
    const capacity = await readCapacity(scope, 'USD', 'db-unrelated', makePorts(pool, scope));
    assert.equal(capacity.value.availableCapacity, '0', 'the dispatched exposure remains held');

    // The original attempt can still settle and release.
    const settled = await settleReservation(await signedSettlement(fixture,id,2,{cumulativeAmount:'0.250000',finality:'final'}),ports);
    assert.equal(settled.ok, true, settled.ok ? '' : settled.error.code);
    assert.equal(settled.value.consumedAmount,'0.25');
    assert.equal(settled.value.releasedAmount,'0.75');
    assert.equal(settled.value.outstandingHold,'0');
    const afterProbe=correlationProbe();
    const unrelatedAfter = await releaseReservation(releaseCommand(scope, id, 3, { amount: '0.750000', proof: 'final_usage_known', attemptBinding: other }), {...ports,sourceCollector:afterProbe.sourceCollector});
    afterProbe.assertRefused(unrelatedAfter);
    const released = await releaseReservation(releaseCommand(scope, id, 3, { amount: '0.750000', proof: 'final_usage_known', attemptBinding: own }), ports);
    assert.equal(released.ok,false,'the original attempt cannot release its final remainder twice');
    assert.equal(released.error.code,'VALIDATION_ERROR');
    assert.equal(await count(scope),events+1,'only the authenticated final settlement changes reservation history');
  } finally {
    await pool.end();
  }
});

/* Observed overrun and release currency agreement. */

test('CI-05A.2 an observed overrun above the hold is recorded in full with its variance (scripted)', async () => {
  const scope = scopeFor('overrun');
  const fixture=await scriptedSignedFixture(scope);
  const result=await settleReservation(await signedSettlement(fixture,R1,2,{cumulativeAmount:'1.100000',finality:'final'}),fixture.ports);
  assert.equal(result.ok, true, result.ok ? '' : result.error.code);
  assert.equal(result.value.heldAmount, '1');
  assert.equal(result.value.consumedAmount, '1.1', 'the full observed spend is recorded, not clamped to the hold');
  assert.equal(result.value.overrunAmount, '0.1');
  assert.equal(result.value.outstandingHold, '0');
  assert.equal(result.value.state, 'settled');
  assert.equal(fixture.script.committed(), true);
  assert.equal(fixture.script.statements.filter(sql=>sql.startsWith('INSERT INTO cost_intelligence.financial_ledger_events')).length,1);
  assert.equal(fixture.script.statements.filter(sql=>sql.startsWith('INSERT INTO cost_intelligence.budget_reconciliation_exceptions')).length,1);
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
  const pool = reservationPool(8);
  try {
    const scope = makeScope('db-overrun');
    await setLimit(pool, scope, '5.00');
    const fixture=await signedFixture(scope,{amount:'1.00'}),ports=fixture.ports(pool);
    const authorized = await authorizeReservation(fixture.request, ports);
    const id = authorized.value.reservationId;
    const own = authorized.value.attemptBinding;
    assert.equal((await markReservationDispatched(dispatchFor(fixture,id), ports)).ok, true);
    const settled = await settleReservation(await signedSettlement(fixture,id,2,{cumulativeAmount:'1.100000',finality:'final'}),ports);
    assert.equal(settled.ok, true, settled.ok ? '' : settled.error.code);
    assert.equal(settled.value.heldAmount, '1');
    assert.equal(settled.value.consumedAmount, '1.1');
    assert.equal(settled.value.overrunAmount, '0.1');
    assert.equal(settled.value.outstandingHold, '0');
    const capacity = await readCapacity(scope, 'USD', 'db-overrun', makePorts(pool, scope));
    assert.equal(capacity.value.effectiveConsumedSpend, '1.1');
    assert.equal(capacity.value.usedCapacity, '1.1');
    assert.equal(capacity.value.availableCapacity, '3.9');
    const expense=await pool.query('SELECT count(*)::int AS count,sum(amount)::text AS actual FROM cost_intelligence.financial_ledger_events WHERE tenant_id=$1 AND project_id=$2 AND financial_effect',[scope.tenantId,scope.projectId]);
    assert.equal(expense.rows[0].count,1);
    assert.equal(expense.rows[0].actual,'1.100000000000000000');
    const release = await releaseReservation(releaseCommand(scope, id, 3, { amount: '0.100000', proof: 'final_usage_known', attemptBinding: own }), makePorts(pool, scope));
    assert.equal(release.ok, false, 'there is no unused hold left to release');
    const badCurrency = releaseCommand(scope, id, 3, { amount: '0', proof: 'final_usage_known', attemptBinding: own });
    badCurrency.canonicalCommand.currency = 'EUR';
    assert.equal((await releaseReservation(badCurrency, makePorts(pool, scope))).ok, false);
  } finally {
    await pool.end();
  }
});
