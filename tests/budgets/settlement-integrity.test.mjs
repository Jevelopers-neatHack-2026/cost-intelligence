import {diagnosticTest,diagnosticBudgetApi} from './static-diagnostics.mjs';
const test=diagnosticTest('settlement-integrity.test.mjs');
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Value} from '@sinclair/typebox/value';
import pg from 'pg';
import {databaseConfigFromEnvironment} from '../../scripts/test-db-lifecycle.mjs';
import * as rawApi from '../../dist/budgets/index.js';
const api=diagnosticBudgetApi(rawApi);
import * as reconciliation from '../../dist/reconciliation/index.js';
import {appendLedgerEvent} from '../../dist/ledger/store.js';
import {loadReserveFixture,setBudgetLimit,reservationPool,makeScope,makePorts,reservationRequest,markDispatchedCommand,settleCommand,releaseCommand,FIXED_TIME} from './reservation-harness.mjs';
import {signedSourceHarness} from './signed-source-harness.mjs';

async function fixture(label,options={}){
 const pool=reservationPool(),scope=makeScope(label);if(options.production)scope.environment='production';await setBudgetLimit(pool,scope,options.limit??'10');
 const request=reservationRequest(scope,await loadReserveFixture(),{amount:options.amount??'1.00',...(options.partial?{allowPartialAuthorization:true,workPlan:{requestedUnits:2,unit:'image',unitMaximumAmount:'1'}}:{})});
 request.attemptBinding.providerAttemptId=randomUUID();request.attemptBinding.transportAttemptId=randomUUID();
 let currentTime=Date.parse(FIXED_TIME);const clock={now:()=>new Date(currentTime)};
 const low=makePorts(pool,scope,{clock});
 const source=await signedSourceHarness(scope,request.authorityBinding,request.attemptBinding,low.clock);
 const digest=await api.pricingEconomicRequestDigest(request);
 request.pricingProfileRef=await source.publish('pricing_profile',{schemaVersion:'ci-budget-pricing-1.0.0',pricingUnit:'fixed_per_attempt',currency:'USD',economicRequestDigest:digest,fixedAttemptAmount:options.amount??'1.00',maximumPolicyRef:null},JSON.stringify({financial_pricing_policy:{schemaVersion:'ci-budget-pricing-1.0.0',pricingUnit:'fixed_per_attempt',currency:'USD',economicRequestDigest:digest,fixedAttemptAmount:options.amount??'1.00',maximumPolicyRef:null}}));
 const ports={...low,budgets:{database:low.database,budgetEvidence:low.budgetEvidence,reservationAuthority:low.reservationAuthority,sourceCollector:source.backend,reportedCostContractMode:options.native?'finance_collector_v1':'development_0_10_1'}};
 const reserved=await api.authorize(request,ports);assert.equal(reserved.ok,true);assert.equal(reserved.value.status,options.partial?'partial':'authorized');
 const dispatch=markDispatchedCommand(scope,reserved.value.reservationId,1,{attemptBinding:request.attemptBinding});
 if(!options.skipDispatch){const dispatched=await api.markDispatched(dispatch,ports);assert.equal(dispatched.ok,true);}
 return {pool,scope,request,ports,source,reservationId:reserved.value.reservationId,dispatch,grant:reserved.value,advance:ms=>{currentTime+=ms;}};
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

function expenseFixture(scope,{amount='0.3',billableAttemptId=randomUUID(),logicalOperationId=randomUUID()}={}){
  const id=randomUUID();const unknown=amount===null;
  return {schemaVersion:'1.0.0',requestId:id,idempotencyKey:id,scope,eventId:id,correlationId:randomUUID(),producer:{module:'ci05a.synthetic.test',sourceRevision:'a'.repeat(40),buildRevision:'fixture-1'},occurredAt:'2026-10-12T03:00:00Z',observedAt:'2026-10-12T03:00:01Z',evidenceMode:'mocked',verificationStatus:'verified',eventType:'expense',classification:'direct_cost',valuation:unknown?'unknown':'provider_confirmed',settlementStatus:'unpaid',reconciliationStatus:'unmatched',reservationLifecycle:null,identities:{logicalOperationId,sourceObservationId:randomUUID(),reservationId:null},postingMapping:{schemaVersion:'1.0.0',sourceLineId:id,transportAttemptId:{status:'not_applicable'},providerAttemptId:{status:'not_applicable'},providerRequestId:{status:'not_applicable'},billableAttemptId:{status:'known',id:billableAttemptId}},sourceIdentity:{source:'ci05a-synthetic',sourceEventId:id,sourceObjectId:id,revisionSubjectId:id,sourceRevision:'fixture-1',revisionSequence:0,contentHash:`sha256:${'d'.repeat(64)}`},usage:{completeness:unknown?'unknown':'complete',missingFields:unknown?['amount']:[],units:unknown?[]:[{name:'tokens',quantity:'1',scale:0,relation:'standalone'}]},money:{amount,currency:'USD',scale:typeof amount==='string'?(amount.split('.')[1]?.length??0):0},sourceRefs:[],dimensions:{},pricing:null,fxEvidence:null,financialEffect:true,reservationAuthorizationEventId:null,supersedesEventId:null,reversesEventId:null};
}

test('CI05B public durable recovery visits final/released attempts and authenticated reconciliation recognizes late actual exactly once',async()=>{
 const f=await fixture('recovery-late-final');try{
  const settled=await api.settle(native(await settlement(f,2,'0.8','final')),f.ports);assert.equal(settled.ok,true,JSON.stringify(settled));assert.equal(settled.value.outstandingHold,'0');
  const recovery={schemaVersion:'1.0.0',requestId:randomUUID(),idempotencyKey:randomUUID(),scope:f.scope,currency:'USD',jobReference:'late-evidence-cycle',expectedCursorRevision:0,pageSize:1,ownerReference:'synthetic-finance-investigator',actionReference:'collect-original-financial-source'};
  assert.equal(Value.Check(api.BudgetRecoveryRequestSchema,recovery),true);
  const batch=await api.recoverReservations(recovery,f.ports);assert.equal(batch.ok,true,JSON.stringify(batch));assert.equal(batch.value.status,'applied');assert.equal(batch.value.cursorRevision,1);assert.equal(batch.value.completedCycle,true);
  assert.equal(batch.value.candidates.length,1);const candidate=batch.value.candidates[0];assert.equal(candidate.reservationId,f.reservationId);assert.equal(candidate.revision,3);assert.equal(candidate.outstandingHold,'0');assert.deepEqual(candidate.authorityBinding,f.request.authorityBinding);
  const replay=await api.recoverReservations(recovery,f.ports);assert.equal(replay.ok,true);assert.equal(replay.value.status,'replay');assert.equal(replay.value.cursorRevision,1);
  const wrongOwner=await api.recoverReservations({...recovery,ownerReference:'different-investigator'},f.ports);assert.equal(wrongOwner.ok,false);assert.equal(wrongOwner.error.code,'IDEMPOTENCY_CONFLICT');
  const ref=await f.source.cost('1.1');const finality=await f.source.finality({schemaVersion:'ci-budget-finality-1.0.0',state:'final_billed',dispatchIntentRef:f.dispatch.dispatchIntentRef,cumulativeCostRef:ref,fenceReference:null});
  const reconcile={schemaVersion:'1.0.0',requestId:randomUUID(),idempotencyKey:randomUUID(),scope:f.scope,reservationId:f.reservationId,expectedRevision:3,actorReference:f.scope.actorId,sourceAuthorityRef:ref,attemptBinding:f.request.attemptBinding,ownerReference:recovery.ownerReference,actionReference:recovery.actionReference,finalityReference:finality};
  assert.equal(Value.Check(api.ReconcileReservationEvidenceRequestSchema,reconcile),true);
  const late=await api.reconcileEvidence(reconcile,f.ports);assert.equal(late.ok,true,JSON.stringify(late));assert.equal(late.value.consumedAmount,'1.1');assert.equal(late.value.releasedAmount,'0.2');assert.equal(late.value.outstandingHold,'0');
  const retried=await api.reconcileEvidence(reconcile,f.ports);assert.equal(retried.ok,true,JSON.stringify(retried));assert.equal(retried.value.status,'replay');assert.equal(retried.value.revision,4);
  const changed=await api.reconcileEvidence({...reconcile,actionReference:'different-action'},f.ports);assert.equal(changed.ok,false);assert.equal(changed.error.code,'IDEMPOTENCY_CONFLICT');
  const heads=await f.pool.query(`SELECT count(*)::int AS n,sum(e.amount)::text AS amount FROM cost_intelligence.financial_ledger_events e JOIN cost_intelligence.financial_source_revision_heads h ON h.current_event_id=e.event_id WHERE e.tenant_id=$1 AND e.project_id=$2 AND e.financial_effect`,[f.scope.tenantId,f.scope.projectId]);assert.equal(heads.rows[0].n,1);assert.equal(heads.rows[0].amount,'1.1');
  const cursors=await f.pool.query('SELECT count(*)::int AS n FROM cost_intelligence.budget_recovery_cursors WHERE tenant_id=$1 AND project_id=$2',[f.scope.tenantId,f.scope.projectId]);assert.equal(cursors.rows[0].n,1);
  const priorReceipts=await f.pool.query('SELECT count(*)::int AS n FROM cost_intelligence.budget_command_receipts WHERE tenant_id=$1 AND project_id=$2',[f.scope.tenantId,f.scope.projectId]);
  const event=(await f.pool.query(`SELECT e.event_hash FROM cost_intelligence.financial_ledger_events e JOIN cost_intelligence.financial_source_revision_heads h ON h.current_event_id=e.event_id WHERE e.tenant_id=$1 AND e.project_id=$2 AND e.financial_effect`,[f.scope.tenantId,f.scope.projectId])).rows[0];
  await f.pool.query(`INSERT INTO cost_intelligence.financial_privacy_quarantine(record_kind,record_hash,tenant_id,project_id,environment,billing_mode,reason_code) VALUES('ledger_event',$1,$2,$3,$4,$5,'legacy_sensitive_event_data')`,[event.event_hash,f.scope.tenantId,f.scope.projectId,f.scope.environment,f.scope.billingMode]);
  const quarantinedReplay=await api.reconcileEvidence(reconcile,f.ports);assert.equal(quarantinedReplay.ok,false);assert.equal(quarantinedReplay.error.code,'RECONCILIATION_PENDING');
  const afterReceipts=await f.pool.query('SELECT count(*)::int AS n FROM cost_intelligence.budget_command_receipts WHERE tenant_id=$1 AND project_id=$2',[f.scope.tenantId,f.scope.projectId]);assert.deepEqual(afterReceipts.rows,priorReceipts.rows);
  const immutable=await f.pool.query('SELECT count(*)::int AS n,sum(released_amount)::text AS released FROM cost_intelligence.budget_reservation_events WHERE reservation_id=$1',[f.reservationId]);assert.equal(immutable.rows[0].n,4);assert.equal(immutable.rows[0].released,'0.2');
 }finally{await f.pool.end();}
});
test('CI05B public native reconciliation discovers signed actual/finality and journals immutable complete run without issuing dispatch authority',async()=>{
 const f=await fixture('native-discovery-run',{native:true,production:true});try{
  const cost=await f.source.nativeCost('0.8'),finality=await f.source.finality({schemaVersion:'ci-budget-finality-1.0.0',state:'final_billed',dispatchIntentRef:f.dispatch.dispatchIntentRef,cumulativeCostRef:cost,fenceReference:null});
  let discoveries=0;const collector={...f.source.backend,findAttemptEvidence:async query=>{discoveries++;assert.deepEqual(query.scope,f.scope);assert.deepEqual(query.attempt,f.request.attemptBinding);assert.deepEqual(query.authorityBinding,f.request.authorityBinding);return {reportedCostRefs:[cost],finalityRef:finality};}};
  const ports={...f.ports,budgets:{...f.ports.budgets,sourceCollector:collector,authorityWaitMs:10000}};
  const request={schemaVersion:'2.0.0',requestId:randomUUID(),idempotencyKey:randomUUID(),scope:f.scope,currency:'USD',jobReference:'native-discovery-run',expectedCursorRevision:0,pageSize:1,ownerReference:'synthetic-finance-investigator',actionReference:'collect-independent-current-source'};
  assert.equal(Value.Check(reconciliation.BudgetReconciliationRequestSchema,request),true);
  const run=await reconciliation.startReconciliation(request,ports);assert.equal(run.ok,true,JSON.stringify(run));assert.equal(run.value.status,'complete');assert.equal(run.value.matchedCount,1);assert.equal(run.value.unresolvedCount,0);assert.equal(run.value.cursorRevision,2);assert.equal(run.value.dispatchEligible,false);assert.equal(discoveries,1);
  const repeated=await reconciliation.startReconciliation(request,ports);assert.equal(repeated.ok,true,JSON.stringify(repeated));assert.equal(repeated.value.replay,true);assert.equal(discoveries,1);
  const changed=await reconciliation.startReconciliation({...request,ownerReference:'different-owner'},ports);assert.equal(changed.ok,false);assert.equal(changed.error.code,'IDEMPOTENCY_CONFLICT');assert.equal(discoveries,1);
  const read=await reconciliation.getReconciliation({schemaVersion:'2.0.0',requestId:randomUUID(),scope:f.scope,runId:run.value.runId},ports);assert.equal(read.ok,true,JSON.stringify(read));assert.equal(read.value.status,'complete');assert.equal(read.value.dispatchEligible,false);
  const snapshot=await api.getReservationSnapshot({schemaVersion:'2.0.0',requestId:randomUUID(),scope:f.scope,reservationId:f.reservationId},ports);assert.equal(snapshot.ok,true);assert.equal(snapshot.value.consumedAmount,'0.8');assert.equal(snapshot.value.releasedAmount,'0.2');assert.equal(snapshot.value.outstandingHold,'0');
  const expenses=await f.pool.query(`SELECT count(*)::int AS n,sum(amount)::text AS amount FROM cost_intelligence.financial_ledger_events WHERE tenant_id=$1 AND project_id=$2 AND financial_effect`,[f.scope.tenantId,f.scope.projectId]);assert.equal(expenses.rows[0].n,1);assert.equal(expenses.rows[0].amount,'0.8');
  const journals=await f.pool.query('SELECT count(*)::int AS n FROM cost_intelligence.budget_recovery_cursors WHERE tenant_id=$1 AND project_id=$2',[f.scope.tenantId,f.scope.projectId]);assert.equal(journals.rows[0].n,2);
 }finally{await f.pool.end();}
});

test('CI05B expense capacity excludes cash/cash corrections and bounded reversal ancestry without dropping real expense corrections',async()=>{
 const f=await fixture('expense-axis');try{
  const post=async record=>{const result=await appendLedgerEvent(record,f.ports);assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.value.status,'accepted');return record;};
  const expense=await post(expenseFixture(f.scope,{amount:'1'})),cash=expenseFixture(f.scope,{amount:'-5'});cash.eventType='cash_movement';await post(cash);
  const afterCash=await api.readCapacity(f.scope,'USD','cash-does-not-offset',f.ports.budgets?{...f.ports,...f.ports.budgets}:f.ports);
  assert.equal(afterCash.ok,true,JSON.stringify(afterCash));assert.equal(afterCash.value.effectiveConsumedSpend,'1');assert.equal(afterCash.value.outstandingHolds,'1');assert.equal(afterCash.value.usedCapacity,'2');
  const correction=async(original,amount)=>{const next=structuredClone(original),id=randomUUID();Object.assign(next,{eventId:id,requestId:id,idempotencyKey:id,eventType:'correction',supersedesEventId:original.eventId});next.money={amount,currency:'USD',scale:amount.split('.')[1]?.length??0};next.sourceIdentity={...original.sourceIdentity,sourceEventId:id,revisionSequence:original.sourceIdentity.revisionSequence+1,sourceRevision:'fixture-2',contentHash:`sha256:${'e'.repeat(64)}`};const prior=await f.pool.query('SELECT event_hash FROM cost_intelligence.financial_ledger_events WHERE event_id=$1',[original.eventId]);next.sourceRefs=[{contract:'financial-ledger-event',schema_version:'1.0.0',id:original.eventId,revision:1,content_hash:prior.rows[0].event_hash}];return next;};
  await post(await correction(cash,'-7'));await post(await correction(expense,'0.8'));
  const corrected=await api.readCapacity(f.scope,'USD','correct-expense-axis',{...f.ports,...f.ports.budgets});assert.equal(corrected.value.effectiveConsumedSpend,'0.8');assert.equal(corrected.value.usedCapacity,'1.8');
 }finally{await f.pool.end();}
});
test('CI05B privacy-quarantined scoped financial history refuses admission replay/capacity/no-bill release and preserves the hold',async()=>{
 const f=await fixture('quarantine-hold');try{
  const expense=expenseFixture(f.scope,{amount:'0.5',billableAttemptId:f.request.attemptBinding.billableAttemptId,logicalOperationId:f.request.attemptBinding.logicalOperationId});
  const posted=await appendLedgerEvent(expense,f.ports);assert.equal(posted.ok,true,JSON.stringify(posted));
  const quarantine=async(project,hash)=>f.pool.query(`INSERT INTO cost_intelligence.financial_privacy_quarantine(record_kind,record_hash,tenant_id,project_id,environment,billing_mode,reason_code) VALUES('ledger_event',$1,$2,$3,$4,$5,'legacy_sensitive_event_data')`,[hash,f.scope.tenantId,project,f.scope.environment,f.scope.billingMode]);
  await quarantine(randomUUID(),`sha256:${'1'.repeat(64)}`);
  assert.equal((await api.readCapacity(f.scope,'USD','foreign-quarantine-control',{...f.ports,...f.ports.budgets})).ok,true);
  const row=await f.pool.query('SELECT event_hash FROM cost_intelligence.financial_ledger_events WHERE event_id=$1',[expense.eventId]);await quarantine(f.scope.projectId,row.rows[0].event_hash);
  assert.equal((await api.readCapacity(f.scope,'USD','quarantined-capacity',{...f.ports,...f.ports.budgets})).ok,false);
  assert.equal((await api.authorize(f.request,f.ports)).ok,false);
  const finality=await f.source.finality({schemaVersion:'ci-budget-finality-1.0.0',state:'final_no_bill',dispatchIntentRef:f.dispatch.dispatchIntentRef,cumulativeCostRef:null,fenceReference:null});
  const release=native(releaseCommand(f.scope,f.reservationId,2,{amount:'1',proof:'final_usage_known',attemptBinding:f.request.attemptBinding}));release.sourceAuthorityRef=finality;release.release.evidenceRefs=[finality];assert.equal(Value.Check(api.VerifiedReleaseRequestSchema,release),true);
  const refusedRelease=await api.release(release,f.ports);assert.equal(refusedRelease.ok,false);assert.equal(refusedRelease.error.code,'BUDGET_UNAVAILABLE');
  const held=await f.pool.query('SELECT sum(held_amount)::text AS held,sum(released_amount)::text AS released,count(*)::int AS events FROM cost_intelligence.budget_reservation_events WHERE reservation_id=$1',[f.reservationId]);assert.equal(held.rows[0].held,'1');assert.equal(held.rows[0].released,'0');assert.equal(held.rows[0].events,2);
 }finally{await f.pool.end();}
});
test('CI05B quarantine insertion serializes fresh admission and no-bill release before either can mutate financial commitments',{timeout:20000},async()=>{
 for(const action of ['admission','no_bill_release']){
  const f=await fixture(`quarantine-race-${action}`),observer=new pg.Pool(databaseConfigFromEnvironment('CI_TEST_DB'));
  const writer=await observer.connect();let pending;
  try{
   const expense=expenseFixture(f.scope,{amount:'0.5',billableAttemptId:f.request.attemptBinding.billableAttemptId,logicalOperationId:f.request.attemptBinding.logicalOperationId});
   const posted=await appendLedgerEvent(expense,f.ports);assert.equal(posted.ok,true,JSON.stringify(posted));
   const hash=(await observer.query('SELECT event_hash FROM cost_intelligence.financial_ledger_events WHERE event_id=$1',[expense.eventId])).rows[0].event_hash;
   const before=(await observer.query('SELECT count(*)::int AS events,sum(held_amount)::text AS held,sum(released_amount)::text AS released FROM cost_intelligence.budget_reservation_events WHERE tenant_id=$1 AND project_id=$2',[f.scope.tenantId,f.scope.projectId])).rows[0];
   await writer.query('BEGIN');
   // This INSERT must acquire the same scope lock as admission/release, before becoming visible.
   await writer.query(`INSERT INTO cost_intelligence.financial_privacy_quarantine(record_kind,record_hash,tenant_id,project_id,environment,billing_mode,reason_code) VALUES('ledger_event',$1,$2,$3,$4,$5,'legacy_sensitive_event_data')`,[hash,f.scope.tenantId,f.scope.projectId,f.scope.environment,f.scope.billingMode]);
   let runtimePid,notifyConnected;const connected=new Promise(resolve=>{notifyConnected=resolve;});
   const database={connect:async()=>{const client=await f.ports.database.connect();runtimePid=(await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;notifyConnected();return client;}};
   let request,ports;
   if(action==='admission'){
    request=reservationRequest(f.scope,await loadReserveFixture(),{amount:'1'});
    const low=makePorts(f.pool,f.scope,{clock:f.ports.clock});ports={...low,database,budgets:{database,authorityWaitMs:10000,budgetEvidence:low.budgetEvidence,reservationAuthority:low.reservationAuthority,sourceCollector:low.sourceCollector,reportedCostContractMode:'development_0_10_1'}};
    assert.equal(api.validateReservationRequestBoundary(request).ok,true);
    pending=api.authorize(request,ports);
   }else{
    const finality=await f.source.finality({schemaVersion:'ci-budget-finality-1.0.0',state:'final_no_bill',dispatchIntentRef:f.dispatch.dispatchIntentRef,cumulativeCostRef:null,fenceReference:null});
    request=native(releaseCommand(f.scope,f.reservationId,2,{amount:'1',proof:'final_usage_known',attemptBinding:f.request.attemptBinding}));request.sourceAuthorityRef=finality;request.release.evidenceRefs=[finality];
    assert.equal(Value.Check(api.VerifiedReleaseRequestSchema,request),true);
    ports={...f.ports,database,budgets:{...f.ports.budgets,database,authorityWaitMs:10000}};pending=api.release(request,ports);
   }
   await connected;
   const deadline=Date.now()+2000;let blocked=false;
   while(Date.now()<deadline){
    const state=await observer.query(`SELECT wait_event_type,wait_event FROM pg_catalog.pg_stat_activity WHERE pid=$1`,[runtimePid]);
    if(state.rows[0]?.wait_event_type==='Lock'&&state.rows[0]?.wait_event==='advisory'){blocked=true;break;}
    await new Promise(resolve=>setImmediate(resolve));
   }
   assert.equal(blocked,true,`public ${action} must wait on the quarantine scope lock`);
   const during=(await observer.query('SELECT count(*)::int AS events FROM cost_intelligence.budget_reservation_events WHERE tenant_id=$1 AND project_id=$2',[f.scope.tenantId,f.scope.projectId])).rows[0];assert.equal(during.events,before.events);
   await writer.query('COMMIT');
   const refused=await pending;pending=null;assert.equal(refused.ok,false);assert.equal(refused.error.code,'BUDGET_UNAVAILABLE');
   const after=(await observer.query('SELECT count(*)::int AS events,sum(held_amount)::text AS held,sum(released_amount)::text AS released FROM cost_intelligence.budget_reservation_events WHERE tenant_id=$1 AND project_id=$2',[f.scope.tenantId,f.scope.projectId])).rows[0];assert.deepEqual(after,before);
   const receipts=await observer.query('SELECT count(*)::int AS n FROM cost_intelligence.budget_command_receipts WHERE tenant_id=$1 AND project_id=$2 AND idempotency_key=$3',[f.scope.tenantId,f.scope.projectId,request.idempotencyKey]);assert.equal(receipts.rows[0].n,0);
  }finally{await writer.query('ROLLBACK').catch(()=>{});if(pending)await pending.catch(()=>{});writer.release();await observer.end();await f.pool.end();}
 }
});
test('CI05B authenticated no-bill release is terminal against stale unverified timeout, with late authenticated expense still recognized',async()=>{
 const f=await fixture('no-bill-terminal');try{
  const finality=await f.source.finality({schemaVersion:'ci-budget-finality-1.0.0',state:'final_no_bill',dispatchIntentRef:f.dispatch.dispatchIntentRef,cumulativeCostRef:null,fenceReference:null});
  const release=native(releaseCommand(f.scope,f.reservationId,2,{amount:'1',proof:'final_usage_known',attemptBinding:f.request.attemptBinding}));release.sourceAuthorityRef=finality;release.release.evidenceRefs=[finality];assert.equal(Value.Check(api.VerifiedReleaseRequestSchema,release),true);
  const released=await api.release(release,f.ports);assert.equal(released.ok,true,JSON.stringify(released));assert.equal(released.value.usageFinality,'final');assert.equal(released.value.releasedAmount,'1');assert.equal(released.value.outstandingHold,'0');
  const unknown={schemaVersion:'1.0.0',requestId:randomUUID(),idempotencyKey:randomUUID(),scope:f.scope,reservationId:f.reservationId,expectedRevision:3,actorReference:f.scope.actorId,sourceAuthorityRef:f.dispatch.sourceAuthorityRef,attemptBinding:f.request.attemptBinding,outcome:'timeout',httpStatus:524,dispatchIntentRef:f.dispatch.dispatchIntentRef};
  assert.equal((await api.retainUnknownOutcome(unknown,f.ports)).ok,false);
  const events=await f.pool.query('SELECT count(*)::int AS n FROM cost_intelligence.budget_reservation_events WHERE reservation_id=$1',[f.reservationId]);assert.equal(events.rows[0].n,3);
  const late=await api.settle(native(await settlement(f,3,'0.4','final')),f.ports);assert.equal(late.ok,true,JSON.stringify(late));assert.equal(late.value.consumedAmount,'0.4');assert.equal(late.value.releasedAmount,'1');assert.equal(late.value.outstandingHold,'0');
 }finally{await f.pool.end();}
});
test('CI05B signed private provider extras are absent from every runtime-readable source/proof receipt after settlement',async()=>{
 const f=await fixture('source-financial-projection');try{
  const canary='private-fixture-canary-'+randomUUID(),cost=await f.source.cost('0.25',{sourceExtra:{prompt:canary,image:canary,bearer:canary},payloadExtra:{prompt:canary}});
  const command=native(settleCommand(f.scope,f.reservationId,2,{cumulativeAmount:'0.25',finality:'partial',attemptBinding:f.request.attemptBinding}));command.sourceAuthorityRef=cost;command.settlement.sourceObservationRefs=[cost];
  const settled=await api.settle(command,f.ports);assert.equal(settled.ok,true,JSON.stringify(settled));
  for(const table of ['budget_source_observations','budget_command_receipts','budget_reported_observations','budget_reconciliation_exceptions']){
    const rows=await f.pool.query(`SELECT to_jsonb(t)::text AS body FROM cost_intelligence.${table} t WHERE tenant_id=$1 AND project_id=$2`,[f.scope.tenantId,f.scope.projectId]);assert.equal(rows.rows.some(row=>row.body.includes(canary)),false);
  }
 }finally{await f.pool.end();}
});

test('CI05B public Finance-native production-mode lifecycle posts exact reported USD18 without development decoder or canonical label',async()=>{
 const f=await fixture('native-production-lifecycle',{native:true,production:true});try{
  const amount='0.800000000000000001',cost=await f.source.nativeCost(amount);
  const finality=await f.source.finality({schemaVersion:'ci-budget-finality-1.0.0',state:'final_billed',dispatchIntentRef:f.dispatch.dispatchIntentRef,cumulativeCostRef:cost,fenceReference:null});
  const command=native(settleCommand(f.scope,f.reservationId,2,{cumulativeAmount:amount,finality:'final',attemptBinding:f.request.attemptBinding}));command.sourceAuthorityRef=cost;command.settlement.sourceObservationRefs=[cost];command.settlement.finalityEvidenceRef=finality;command.settlement.usageCompleteness='unknown';
  assert.equal(Value.Check(api.VerifiedSettlementRequestSchema,command),true);
  const settled=await api.settle(command,f.ports);assert.equal(settled.ok,true,JSON.stringify(settled));assert.equal(settled.value.consumedAmount,amount);assert.equal(settled.value.releasedAmount,'0.199999999999999999');assert.equal(settled.value.usageFinality,'final');
  const read=await api.getReservationSnapshot({schemaVersion:'2.0.0',requestId:randomUUID(),scope:f.scope,reservationId:f.reservationId},f.ports);assert.equal(read.ok,true,JSON.stringify(read));assert.equal(read.value.consumedAmount,amount);assert.equal(read.value.dispatchEligible,false);
  const replay=await api.settle(command,f.ports);assert.equal(replay.ok,true);assert.equal(replay.value.status,'replay');
  const ledger=await f.pool.query(`SELECT e.amount::text AS amount,e.valuation,count(*) OVER()::int AS count FROM cost_intelligence.financial_ledger_events e WHERE e.tenant_id=$1 AND e.project_id=$2 AND e.financial_effect`,[f.scope.tenantId,f.scope.projectId]);assert.equal(ledger.rows[0].count,1);assert.equal(ledger.rows[0].amount,amount);assert.equal(ledger.rows[0].valuation,'provider_reported_unsettled');
 }finally{await f.pool.end();}
});
test('CI05B public partial acknowledgement persists SHA text, replays one receipt, and permits exactly one held-to-dispatched transition',async()=>{
 const f=await fixture('partial-ack-persistence',{limit:'1',amount:'2',partial:true,skipDispatch:true});try{
  const ack={schemaVersion:'1.0.0',requestId:randomUUID(),idempotencyKey:randomUUID(),scope:f.scope,reservationId:f.reservationId,expectedRevision:1,
    actorReference:f.scope.actorId,sourceAuthorityRef:f.request.sourceAuthorityRef,attemptBinding:f.request.attemptBinding,
    allowedAmount:'1',allowedWorkUnits:1,unit:'image',revisedPlan:{requestedUnits:1,unit:'image',unitMaximumAmount:'1'},revisedPlanHash:await api.budgetDigest({requestedUnits:1,unit:'image',unitMaximumAmount:'1'})};
  assert.equal(Value.Check(api.PartialAcknowledgementRequestSchema,ack),true);
  const accepted=await api.acknowledgePartial(ack,f.ports);assert.equal(accepted.ok,true,JSON.stringify(accepted));assert.equal(accepted.value.state,'held');assert.equal(accepted.value.revision,2);
  const replay=await api.acknowledgePartial(ack,f.ports);assert.equal(replay.ok,true);assert.equal(replay.value.status,'replay');
  const command=markDispatchedCommand(f.scope,f.reservationId,2,{attemptBinding:f.request.attemptBinding});const dispatched=await api.markDispatched(command,f.ports);assert.equal(dispatched.ok,true,JSON.stringify(dispatched));assert.equal(dispatched.value.state,'dispatched');assert.equal(dispatched.value.expectedRevision,3);
  const rows=await f.pool.query(`SELECT count(*)::int AS n,min(content_hash)::text AS digest FROM cost_intelligence.budget_reservation_acknowledgements WHERE reservation_id=$1`,[f.reservationId]);assert.equal(rows.rows[0].n,1);assert.match(rows.rows[0].digest,/^sha256:[a-f0-9]{64}$/);
  const capacity=await api.readCapacity(f.scope,'USD','partial-conservation',{...f.ports,...f.ports.budgets});assert.equal(capacity.value.outstandingHolds,'1');assert.equal(capacity.value.usedCapacity,'1');
 }finally{await f.pool.end();}
});
