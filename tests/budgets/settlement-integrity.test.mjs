import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import * as api from '../../dist/budgets/index.js';
import {loadReserveFixture,setBudgetLimit,reservationPool,makeScope,makePorts,reservationRequest,markDispatchedCommand,settleCommand,releaseCommand,FIXED_TIME} from './reservation-harness.mjs';
import {signedSourceHarness} from './signed-source-harness.mjs';

async function fixture(label){
 const pool=reservationPool(),scope=makeScope(label);await setBudgetLimit(pool,scope,'10');
 const request=reservationRequest(scope,await loadReserveFixture(),{amount:'1.00'});
 request.attemptBinding.providerAttemptId=randomUUID();request.attemptBinding.transportAttemptId=randomUUID();
 let currentTime=Date.parse(FIXED_TIME);const clock={now:()=>new Date(currentTime)};
 const low=makePorts(pool,scope,{clock});
 const source=await signedSourceHarness(scope,request.authorityBinding,request.attemptBinding,low.clock);
 const digest=await api.pricingEconomicRequestDigest(request);
 request.pricingProfileRef=await source.publish('pricing_profile',{schemaVersion:'ci-budget-pricing-1.0.0',pricingUnit:'fixed_per_attempt',currency:'USD',economicRequestDigest:digest,fixedAttemptAmount:'1.00',maximumPolicyRef:null},JSON.stringify({financial_pricing_policy:{schemaVersion:'ci-budget-pricing-1.0.0',pricingUnit:'fixed_per_attempt',currency:'USD',economicRequestDigest:digest,fixedAttemptAmount:'1.00',maximumPolicyRef:null}}));
 const ports={...low,budgets:{database:low.database,budgetEvidence:low.budgetEvidence,reservationAuthority:low.reservationAuthority,sourceCollector:source.backend,reportedCostContractMode:'development_0_10_1'}};
 const reserved=await api.authorize(request,ports);assert.equal(reserved.ok,true);assert.equal(reserved.value.status,'authorized');
 const dispatch=markDispatchedCommand(scope,reserved.value.reservationId,1,{attemptBinding:request.attemptBinding});
 const dispatched=await api.markDispatched(dispatch,ports);assert.equal(dispatched.ok,true);
 return {pool,scope,request,ports,source,reservationId:reserved.value.reservationId,dispatch,advance:ms=>{currentTime+=ms;}};
}
function native(request){const {canonicalCommand,...value}=request;return {...value,schemaVersion:'2.0.0'};}
async function settlement(f,revision,amount,finality='partial'){
 const request=settleCommand(f.scope,f.reservationId,revision,{cumulativeAmount:amount,finality,sequence:revision,attemptBinding:f.request.attemptBinding});
 request.sourceAuthorityRef=await f.source.cost(amount);request.settlement.sourceObservationRefs=[request.sourceAuthorityRef];request.settlement.usageCompleteness='unknown';
 if(finality==='final')request.settlement.finalityEvidenceRef=await f.source.finality({schemaVersion:'ci-budget-finality-1.0.0',state:'final_billed',dispatchIntentRef:f.dispatch.dispatchIntentRef,cumulativeCostRef:request.sourceAuthorityRef,fenceReference:null});
 return request;
}
test('CI05B public atomic partial/final/late settlement posts replacement expense and releases unused hold once',async()=>{
 const f=await fixture('settlement-conservation');try{
  const partial=await api.settle(await settlement(f,2,'0.6'),f.ports);assert.equal(partial.ok,true,JSON.stringify(partial));
  assert.equal(partial.value.effectiveConsumedAmount,'0.6');assert.equal(partial.value.releasedAmount,'0');
  const finalRequest=await settlement(f,3,'0.8','final'),final=await api.settle(finalRequest,f.ports);assert.equal(final.ok,true,JSON.stringify(final));
  assert.equal(final.value.effectiveConsumedAmount,'0.8');assert.equal(final.value.releasedAmount,'0.2');
  const late=await api.settle(await settlement(f,4,'1.1','final'),f.ports);assert.equal(late.ok,true,JSON.stringify(late));
  assert.equal(late.value.effectiveConsumedAmount,'1.1');assert.equal(late.value.overrunAmount,'0.1');assert.equal(late.value.releasedAmount,'0.2');
  const replay=await api.settle(finalRequest,f.ports);assert.equal(replay.ok,true);assert.equal(replay.value.commandReceipt.consumedAmount,'0.8');assert.equal(replay.value.commandReceipt.revision,4);
  const expense=await f.pool.query(`SELECT sum(e.amount)::text AS actual,count(*)::int AS roots FROM cost_intelligence.financial_ledger_events e JOIN cost_intelligence.financial_source_revision_heads h ON h.current_event_id=e.event_id WHERE e.tenant_id=$1 AND e.project_id=$2 AND e.financial_effect`,[f.scope.tenantId,f.scope.projectId]);
  assert.equal(expense.rows[0].actual,'1.1');assert.equal(expense.rows[0].roots,1);
  const queue=await f.pool.query(`SELECT reason,variance_amount::text FROM cost_intelligence.budget_reconciliation_exceptions WHERE tenant_id=$1 AND project_id=$2`,[f.scope.tenantId,f.scope.projectId]);assert.ok(queue.rows.some(r=>r.reason==='over_cap'&&r.variance_amount==='0.1'));
 }finally{await f.pool.end();}
});
test('CI05B public post-send timeout is durable unknown exposure; caller finality and partial release cannot erase the hold',async()=>{
 const f=await fixture('settlement-unknown');try{
  const unknown={schemaVersion:'1.0.0',requestId:randomUUID(),idempotencyKey:randomUUID(),scope:f.scope,reservationId:f.reservationId,expectedRevision:2,
   actorReference:f.scope.actorId,sourceAuthorityRef:f.dispatch.sourceAuthorityRef,attemptBinding:f.request.attemptBinding,outcome:'timeout',httpStatus:408,dispatchIntentRef:f.dispatch.dispatchIntentRef};
  const result=await api.retainUnknownOutcome(unknown,f.ports);assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.value.state,'outcome_unknown');assert.equal(result.value.outstandingHold,'1');
  const replay=await api.retainUnknownOutcome(unknown,f.ports);assert.equal(replay.ok,true);assert.equal(replay.value.status,'replay');
  const original=await settlement(f,3,'0','final');delete original.settlement.finalityEvidenceRef;assert.equal((await api.settle(original,f.ports)).ok,false);
  const partial=releaseCommand(f.scope,f.reservationId,3,{amount:'0.5',proof:'final_usage_known',attemptBinding:f.request.attemptBinding});assert.equal((await api.release(partial,f.ports)).ok,false);
  const snapshot=await api.getReservationSnapshot({schemaVersion:'1.0.0',requestId:randomUUID(),scope:f.scope,reservationId:f.reservationId},f.ports);
  assert.equal(snapshot.value.state,'outcome_unknown');assert.equal(snapshot.value.effectiveConsumedAmount,'0');assert.equal(snapshot.value.releasedAmount,'0');
 }finally{await f.pool.end();}
});
test('CI05B authentic duplicate observation with another command posts one expense; USD18 read preserves exact actual',async()=>{
 const f=await fixture('settlement-exact-dedup');try{
  const command=native(await settlement(f,2,'0.000000000000000001'));
  const first=await api.settle(command,f.ports);assert.equal(first.ok,true,JSON.stringify(first));assert.equal(first.value.consumedAmount,'0.000000000000000001');
  const duplicate={...command,requestId:randomUUID(),idempotencyKey:randomUUID(),expectedRevision:3,settlement:{...command.settlement,sequence:3}};
  const second=await api.settle(duplicate,f.ports);assert.equal(second.ok,true,JSON.stringify(second));
  const read=await api.getReservationSnapshot({schemaVersion:'2.0.0',requestId:randomUUID(),scope:f.scope,reservationId:f.reservationId},f.ports);
  assert.equal(read.ok,true,JSON.stringify(read));assert.equal(read.value.consumedAmount,'0.000000000000000001');assert.equal(read.value.dispatchEligible,false);
  const ledger=await f.pool.query(`SELECT count(*)::int AS count,sum(amount)::text AS amount FROM cost_intelligence.financial_ledger_events WHERE tenant_id=$1 AND project_id=$2 AND financial_effect`,[f.scope.tenantId,f.scope.projectId]);
  assert.equal(ledger.rows[0].count,1);assert.equal(ledger.rows[0].amount,'0.000000000000000001');
  const observations=await f.pool.query('SELECT count(*)::int AS count FROM cost_intelligence.budget_reported_observations WHERE tenant_id=$1 AND project_id=$2',[f.scope.tenantId,f.scope.projectId]);assert.equal(observations.rows[0].count,1);
  const changed={...duplicate,idempotencyKey:command.idempotencyKey,actorReference:'different-owner'};
  assert.equal((await api.settle(changed,f.ports)).ok,false);
 }finally{await f.pool.end();}
});
test('CI05B ordinary decrease conflicts; separately granted authenticated source correction replaces expense and restores capacity',async()=>{
 const f=await fixture('settlement-source-correction');try{
  const original=native(await settlement(f,2,'0.8')),posted=await api.settle(original,f.ports);assert.equal(posted.ok,true,JSON.stringify(posted));
  const oldObservation=f.source.records.get(original.sourceAuthorityRef.id).record.payload.usageEvent.source_observation_id;
  const lower=native(await settlement(f,3,'0.6'));assert.equal((await api.settle(lower,f.ports)).ok,false);
  const correction={...lower,action:'record_expense_adjustment',correction:{originalSourceObservationId:oldObservation,reasonReference:'synthetic-current-source-revision'}};
  const applied=await api.recordExpenseAdjustment(correction,f.ports);assert.equal(applied.ok,true,JSON.stringify(applied));assert.equal(applied.value.consumedAmount,'0.6');assert.equal(applied.value.outstandingHold,'0.4');
  const replay=await api.recordExpenseAdjustment(correction,f.ports);assert.equal(replay.ok,true);assert.equal(replay.value.status,'replay');
  const ledger=await f.pool.query(`SELECT e.amount::text FROM cost_intelligence.financial_ledger_events e JOIN cost_intelligence.financial_source_revision_heads h ON h.current_event_id=e.event_id WHERE e.tenant_id=$1 AND e.project_id=$2 AND e.financial_effect`,[f.scope.tenantId,f.scope.projectId]);assert.equal(ledger.rows.length,1);assert.equal(ledger.rows[0].amount,'0.6');
  const capacity=await api.readCapacity(f.scope,'USD','corrected-capacity',f.ports);assert.equal(capacity.ok,true);assert.equal(capacity.value.effectiveConsumedSpend,'0.6');assert.equal(capacity.value.outstandingHolds,'0.4');
 }finally{await f.pool.end();}
});
test('CI05B expiry conserves exposure; acknowledging holds keeps latest queue open, and late authentic cost survives revoked execution authority',async()=>{
 const f=await fixture('settlement-expiry-current-queue');try{
  f.advance(61000);
  const expiry={schemaVersion:'1.0.0',requestId:randomUUID(),idempotencyKey:randomUUID(),scope:f.scope,reservationId:f.reservationId,expectedRevision:2,
   actorReference:f.scope.actorId,sourceAuthorityRef:f.request.sourceAuthorityRef,attemptBinding:f.request.attemptBinding,reasonReference:'synthetic-expiry-sweep'};
  const expired=await api.expireAuthorization(expiry,f.ports);assert.equal(expired.ok,true,JSON.stringify(expired));assert.equal(expired.value.outstandingHold,'1');assert.equal(expired.value.releasedAmount,'0');
  const query={schemaVersion:'1.0.0',requestId:randomUUID(),scope:f.scope,currency:'USD',pageSize:10,afterExceptionId:null,includeResolved:false};
  const queue=await api.getExceptions(query,f.ports);assert.equal(queue.ok,true,JSON.stringify(queue));assert.equal(queue.value.exceptions.length,1);
  const exception=queue.value.exceptions[0],hold={schemaVersion:'1.0.0',requestId:randomUUID(),idempotencyKey:randomUUID(),scope:f.scope,currency:'USD',exceptionId:exception.exceptionId,
   expectedRevision:exception.revision,action:'hold',ownerReference:'synthetic-investigator',actionReference:'await-original-source',evidenceReference:null};
  assert.equal((await api.acknowledgeException(hold,f.ports)).ok,true);
  const held=await api.getExceptions({...query,requestId:randomUUID()},f.ports);assert.equal(held.value.exceptions[0].state,'held_for_reconciliation');
  const changed={...hold,ownerReference:'other-owner'};assert.equal((await api.acknowledgeException(changed,f.ports)).ok,false);
  const rejected=await api.acknowledgeException({...hold,requestId:randomUUID(),idempotencyKey:randomUUID(),expectedRevision:exception.revision+1,action:'resolve'},f.ports);assert.equal(rejected.ok,false);
  const revoked={...f.ports,budgets:{...f.ports.budgets,reservationAuthority:{verifyCurrent:async()=>({status:'denied'})}}};
  const deniedDispatch=await api.revalidateAuthorization({schemaVersion:'1.0.0',requestId:randomUUID(),scope:f.scope,reservationId:f.reservationId,
   attemptBinding:f.request.attemptBinding,authorityBinding:f.request.authorityBinding,phase:'preparation'},revoked);assert.ok(!deniedDispatch.ok||deniedDispatch.value.status==='denied');
  const late=await api.settle(native(await settlement(f,3,'1.1','final')),revoked);assert.equal(late.ok,true,JSON.stringify(late));assert.equal(late.value.consumedAmount,'1.1');assert.equal(late.value.overrunAmount,'0.1');
 }finally{await f.pool.end();}
});
test('CI05B a complete per-token 0.01 estimate holds the authenticated 0.10 maximum and refuses subtotal-only or unissued caps',async()=>{
 const pool=reservationPool(),scope=makeScope('per-token-complete-maximum');try{
  await setBudgetLimit(pool,scope,'1');const reserve=await loadReserveFixture();
  const maximum={policyRef:{contract:'finance-owner-maximum',schema_version:'1.0.0',id:randomUUID(),revision:1,content_hash:`sha256:${'a'.repeat(64)}`},authorizedCap:'0.10',currency:'USD'};
  const estimate={completeness:'complete',knownSubtotal:'0.01',currency:'USD',rateCardRef:null,missingDimensions:[],boundedConservativeMaximum:'0.10',maximumPolicyRef:maximum.policyRef};
  const low=makePorts(pool,scope,{maximum}),ports={...low,budgets:{database:low.database,budgetEvidence:low.budgetEvidence,reservationAuthority:low.reservationAuthority,sourceCollector:low.sourceCollector,reportedCostContractMode:'development_0_10_1'}};
  const bounded=reservationRequest(scope,reserve,{provider:'openrouter',amount:'0.10',estimate,pricingUnit:'per_token',trustedMaximum:maximum});
  const grant=await api.authorize(bounded,ports);assert.equal(grant.ok,true,JSON.stringify(grant));assert.equal(grant.value.status,'authorized');assert.equal(grant.value.heldAmount,'0.1');assert.equal(grant.value.finance.authorized_cap.amount,'0.1');
  const subtotal=reservationRequest(scope,reserve,{provider:'openrouter',amount:'0.01',estimate,pricingUnit:'per_token',trustedMaximum:maximum});
  const refused=await api.authorize(subtotal,ports);assert.ok(!refused.ok||refused.value.status==='denied');
  const unissued=reservationRequest(scope,reserve,{provider:'openrouter',amount:'0.10',estimate,pricingUnit:'per_token'});
  const unknown=await api.authorize(unissued,ports);assert.equal(unknown.ok,true,JSON.stringify(unknown));assert.equal(unknown.value.status,'denied');assert.equal(unknown.value.heldAmount,'0');
  const capacity=await api.readCapacity(scope,'USD','per-token-conservation',low);assert.equal(capacity.value.usedCapacity,'0.1');assert.equal(capacity.value.outstandingHolds,'0.1');
 }finally{await pool.end();}
});
