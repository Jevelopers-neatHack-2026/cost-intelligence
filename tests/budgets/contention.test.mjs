import assert from 'node:assert/strict';
import {diagnosticTest} from './static-diagnostics.mjs';
const test=diagnosticTest('contention.test.mjs');
import { authorizeReservation, changeBudgetPolicy, readCapacity } from '../../dist/index.js';
import {
  loadReserveFixture, setBudgetLimit, reservationPool, makePorts, makeScope, policyChange, reservationRequest,
} from './reservation-harness.mjs';

const fixturePromise = loadReserveFixture();
const SCALE = 1_000_000_000_000_000_000n;
function toBig(value) {
  const [whole, fraction = ''] = String(value).split('.');
  return BigInt(whole) * SCALE + BigInt(fraction.padEnd(18, '0') || '0');
}

async function setLimit(pool, scope, limitAmount) {
  await setBudgetLimit(pool, scope, limitAmount);
}

async function countEvents(pool, scope) {
  const result = await pool.query(
    `SELECT count(*)::int AS total FROM cost_intelligence.budget_reservation_events
     WHERE tenant_id = $1 AND project_id = $2 AND environment = $3 AND billing_mode = $4`,
    [scope.tenantId, scope.projectId, scope.environment, scope.billingMode],
  );
  return result.rows[0].total;
}

test('CI-05A.1 two concurrent 0.75 requests against a 1.00 limit yield at most one full authorization', async () => {
  assert.ok(process.env.CI_TEST_DB_RUNTIME_HOST, 'contention suite requires the restricted disposable PostgreSQL role');
  const reserve = await fixturePromise;
  const pool = reservationPool(16);
  try {
    const scope = makeScope('race-two');
    await setLimit(pool, scope, '1.00');
    const requestA = reservationRequest(scope, reserve, { amount: '0.75' });
    const requestB = reservationRequest(scope, reserve, { amount: '0.75' });
    const [a, b] = await Promise.all([
      authorizeReservation(requestA, makePorts(pool, scope)),
      authorizeReservation(requestB, makePorts(pool, scope)),
    ]);
    assert.equal(a.ok && b.ok, true, 'both attempts return a decision envelope');
    const statuses = [a.value.status, b.value.status].sort();
    assert.deepEqual(statuses, ['authorized', 'denied'], `real row-locked contention admits exactly one hold; got ${statuses}`);
    assert.equal(await countEvents(pool, scope), 1, 'only one reservation hold is persisted');

    const cap = await readCapacity(scope, 'USD', 'race-two-cap', makePorts(pool, scope));
    assert.equal(cap.ok, true);
    assert.ok(toBig(cap.value.usedCapacity) <= toBig('1.00'), 'used capacity never exceeds the limit');
    assert.equal(cap.value.usedCapacity, '0.75');
  } finally {
    await pool.end();
  }
});

test('CI-05A.2 many concurrent requests never over-commit the conserved capacity', async () => {
  const reserve = await fixturePromise;
  const pool = reservationPool(24);
  try {
    const scope = makeScope('race-many');
    await setLimit(pool, scope, '1.00');
    const requests = Array.from({ length: 8 }, () => reservationRequest(scope, reserve, { amount: '0.40' }));
    const results = await Promise.all(requests.map(request => authorizeReservation(request, makePorts(pool, scope))));
    assert.ok(results.every(result => result.ok), 'every attempt returns a decision');
    const authorized = results.filter(result => result.value.status === 'authorized');
    assert.equal(authorized.length, 2, 'only two 0.40 holds fit inside 1.00');
    const total = authorized.reduce((sum, result) => sum + toBig(result.value.heldAmount), 0n);
    assert.ok(total <= toBig('1.00'), 'the sum of concurrent holds never exceeds the conserved limit');
    assert.equal(await countEvents(pool, scope), authorized.length, 'denied attempts persist no hold and dispatch no work');
  } finally {
    await pool.end();
  }
});

test('CI-05A.4 concurrent identical idempotent retries create exactly one hold', async () => {
  const reserve = await fixturePromise;
  const pool = reservationPool(16);
  try {
    const scope = makeScope('race-idempotent');
    await setLimit(pool, scope, '2.00');
    const request = reservationRequest(scope, reserve, { amount: '0.75' });
    const results = await Promise.all(Array.from({ length: 6 }, () => authorizeReservation(request, makePorts(pool, scope))));
    assert.ok(results.every(result => result.ok), 'every retry returns a decision');
    const reservationIds = new Set(results.map(result => result.value.reservationId));
    assert.equal(reservationIds.size, 1, 'all idempotent retries resolve to the same reservation id');
    assert.ok(results.every(result => result.value.status === 'authorized'), 'every retry reports the single authorization');
    assert.equal(await countEvents(pool, scope), 1, 'a stampede of identical retries never creates a second hold');
  } finally {
    await pool.end();
  }
});

test('one economic attempt raced under different keys/currencies creates exactly one hold',async()=>{
  const pool=reservationPool();const scope=makeScope('attempt-unique');const fixture=await fixturePromise;
  try{
    await setBudgetLimit(pool,scope,'10','USD');await setBudgetLimit(pool,scope,'10','EUR');
    const first=reservationRequest(scope,fixture,{amount:'1'});const second=structuredClone(first);second.requestId='different-key';second.idempotencyKey='different-key';second.canonicalRequest.idempotency_key='different-key';
    const eur=structuredClone(second);eur.idempotencyKey='different-currency';eur.canonicalRequest.idempotency_key=eur.idempotencyKey;eur.estimate.currency='EUR';eur.canonicalRequest.currency='EUR';eur.canonicalRequest.requested.currency='EUR';
    const {policyRefFor}=await import('./reservation-harness.mjs');eur.canonicalRequest.policy_ref=policyRefFor(scope,'EUR');
    const results=await Promise.all([first,second,eur].map(r=>authorizeReservation(r,makePorts(pool,scope))));
    assert.equal(results.filter(r=>r.ok&&r.value.status==='authorized').length,1);assert.equal(results.filter(r=>!r.ok&&r.error.code==='IDEMPOTENCY_CONFLICT').length,2);assert.equal(await countEvents(pool,scope),1);
  }finally{await pool.end();}
});
test('approved budget reduction and admission serialize against the same commitments',async()=>{
  const pool=reservationPool();const scope=makeScope('policy-admission-race');const fixture=await fixturePromise;
  try{
    await setBudgetLimit(pool,scope,'1');const req=reservationRequest(scope,fixture,{amount:'0.75'});
    const [grant,change]=await Promise.all([authorizeReservation(req,makePorts(pool,scope)),changeBudgetPolicy(policyChange(scope,{limitAmount:'0.5',expectedPolicyRevision:1}),makePorts(pool,scope))]);
    const cap=await readCapacity(scope,'USD','policy-race',makePorts(pool,scope));
    assert.ok(toBig(cap.value.usedCapacity)<=toBig(cap.value.limitAmount));
    if(grant.ok&&grant.value.status==='authorized'){assert.equal(change.value.status,'denied');assert.equal(cap.value.limitAmount,'1');}else{assert.equal(change.value.status,'applied');assert.equal(cap.value.usedCapacity,'0');}
  }finally{await pool.end();}
});
