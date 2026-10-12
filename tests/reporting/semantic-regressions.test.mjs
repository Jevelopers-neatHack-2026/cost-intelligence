// Regression inputs adapted from frozen54 independent review; this is author validation, not an independent review.
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import test from 'node:test';
import * as root from '../../dist/index.js';
import * as reporting from '../../dist/reporting/index.js';
import {projectReporting,hash} from '../../dist/reporting/projection.js';
const oracle=JSON.parse(await readFile(new URL('../../fixtures/reporting/ci08-manual-oracle.json',import.meta.url),'utf8'));
const results=[];
function scope() { return { tenantId:randomUUID(),projectId:randomUUID(),actorId:'synthetic-reporting-service',environment:'test',billingMode:'live' }; }
function appendRequest(scope, id, options={}) {
  const subject=options.subject??id; const prefix=scope.projectId.slice(0,8);
  const money=Object.hasOwn(options,'amount')?options.amount:'1';
  return { schemaVersion:'1.0.0',requestId:`request-${prefix}-${id}`,idempotencyKey:`posting-${prefix}-${id}`,scope,eventId:`event-${prefix}-${id}`,correlationId:`correlation-${prefix}-${id}`,
    producer:{module:'ci08.synthetic.fixture',sourceRevision:'a'.repeat(40),buildRevision:'fixture-1'},occurredAt:options.occurredAt??'2026-10-10T12:00:00.000Z',observedAt:'2026-10-10T12:01:00.000Z',
    evidenceMode:'mocked',verificationStatus:'verified',eventType:options.eventType??'expense',classification:options.classification??'direct_cost',valuation:options.valuation??(money===null?'unknown':'provider_confirmed'),settlementStatus:options.settlement??'unpaid',reconciliationStatus:'unmatched',reservationLifecycle:null,
    identities:{logicalOperationId:`operation-${prefix}-${subject}`,sourceObservationId:`observation-${prefix}-${id}`,reservationId:null},
    postingMapping:{schemaVersion:'1.0.0',sourceLineId:`line-${prefix}-${subject}`,transportAttemptId:{status:'known',id:`transport-${prefix}-${subject}`},providerAttemptId:{status:'known',id:`provider-${prefix}-${subject}`},providerRequestId:{status:'not_applicable'},billableAttemptId:{status:'known',id:`billable-${prefix}-${subject}`}},
    sourceIdentity:{source:'ci08-synthetic',sourceEventId:`source-${prefix}-${id}`,sourceObjectId:`object-${prefix}-${subject}`,revisionSubjectId:`line-${prefix}-${subject}`,sourceRevision:`fixture-${options.revision??0}`,revisionSequence:options.revision??0,contentHash:hash({prefix,id,options})},
    usage:{completeness:money===null?'unknown':'complete',missingFields:money===null?['tokens']:[],units:money===null?[]:[{name:'tokens',quantity:'1',scale:0,relation:'standalone'}]},money:{amount:money,currency:options.currency??'USD',scale:money?.split('.')[1]?.length??0},sourceRefs:['correction','reversal'].includes(options.eventType)?[{contract:'ci08.synthetic.evidence',schema_version:'1.0.0',id:'ci08-confirmed-correction',revision:1,content_hash:hash({id,amount:money})}]:[],dimensions:options.dimensions??{},pricing:options.valuation==='estimated'?{policyVersion:'synthetic-1',ruleVersion:'synthetic-1',rateCardRef:null}:null,fxEvidence:null,financialEffect:true,reservationAuthorizationEventId:null,supersedesEventId:options.supersedes??null,reversesEventId:options.reverses??null };
}
function query(scope, extra={}) { return {schemaVersion:'2.0.0',requestId:'synthetic-query',idempotencyKey:'synthetic-query',scope,period:oracle.period,timezone:'America/New_York',policyVersion:reporting.REPORTING_POLICY_VERSION,pageSize:2,filters:{environments:[scope.environment],billingModes:[scope.billingMode]},groupings:[...reporting.REPORTING_DIMENSIONS],...extra}; }

function event(payload){const checked=root.validateLedgerAppendRequestBoundary(payload);assert.equal(checked.ok,true,JSON.stringify(checked));return {eventId:payload.eventId,eventHash:hash(payload),rootId:payload.eventId,economicEventType:payload.eventType,payload};}
function projection(q,events,coverage=false){return projectReporting({query:q,asOf:'2026-10-12T22:00:00.000Z',events,lifetimeEvents:events,intake:{unposted:0,awaiting:0,quarantine:0},budgetSources:[],allocations:[],productEvidence:coverage?{sourceCoverage:[{currency:'USD',source:'expense',status:'complete',expected:1},{currency:'USD',source:'cash',status:'complete',expected:1},{currency:'USD',source:'revenue',status:'complete',expected:0}],denominators:[]}:null});}
function portsFor(q,events){const records=new Map();const now='2026-10-12T22:00:00.000Z';return {
 clock:{now:()=>new Date(now)},storage:{isAvailable:async()=>true},providerSource:{isAvailable:async()=>false},trustedContext:{resolve:async()=>structuredClone(q.scope)},
 financeAuthority:{authorizeCurrent:async r=>({status:'allowed',decisionId:'review-fixture',operation:r.operation,permission:r.permission,scope:structuredClone(q.scope),principal:{kind:'service',actorId:q.scope.actorId,serviceStatus:'active',serviceGrantRevision:'review-r1'},verifiedAt:now,expiresAt:'2026-10-12T22:01:00.000Z'})},
 reporting:{producer:{sourceRevision:'a'.repeat(40),buildRevision:'review-only'},cursorSigningKey:'review-only-key-000000000000000000000000',database:{connect:async()=>({release(){},query:async(sql,v=[])=>{
 if(sql.includes('reporting_health'))return{rows:[{migrations_ready:true}]};
 if(sql.includes('financial_privacy_quarantine'))return{rows:[]};
 if(sql.startsWith('INSERT INTO cost_intelligence.reporting_snapshots')){records.set(v[0],JSON.parse(v[7]));return{rows:[]};}
 if(sql.includes('SELECT snapshot_content'))return{rows:records.has(v[4])?[{snapshot_content:structuredClone(records.get(v[4]))}]:[]};
 if(sql.includes('FROM cost_intelligence.financial_ledger_events e JOIN'))return{rows:events.map(e=>({event_id:e.eventId,event_hash:e.eventHash,economic_root_event_id:e.rootId,event_payload:structuredClone(e.payload),economic_event_type:e.economicEventType,lineage_valid:true,economic_lineage:e.economicLineage??[{eventId:e.rootId,eventType:e.economicEventType,reversesId:null,scope:q.scope,ingestedAt:now,financialEffect:true,payload:structuredClone(e.payload),depth:0,cycle:false}],root_occurred_at:e.payload.occurredAt}))};
 if(sql.includes(' AS count'))return{rows:[{count:'0'}]};
 return{rows:[]};
 }})}}};}

test('cash movement must not change recognized expense in the public query',async()=>{
 const s=scope(),q=query(s);const events=[event(appendRequest(s,'recognized',{amount:'1'})),event(appendRequest(s,'cash-payment',{eventType:'cash_movement',classification:'operating_expense',amount:'-5'}))];
 const result=await root.querySummaryV2(q,portsFor(q,events));assert.equal(result.ok,true,JSON.stringify(result));const row=result.value.summary.currencies[0];results.push({case:'cash',expense:row.metrics.expense,cashPayouts:row.metrics.cashPayouts,budget:result.value.summary.budgets,details:result.value.details});
 assert.equal(row.metrics.cashPayouts.knownSubtotal,'5');assert.equal(row.metrics.expense.knownSubtotal,'1','cash settlement must not change recognized expense');
});
test('known standalone expense and separate cash classification preserve the expected positive control',async()=>{
 const s=scope(),q=query(s);const events=[event(appendRequest(s,'recognized',{amount:'1'})),event(appendRequest(s,'cash-payment',{eventType:'cash_movement',classification:'payout_transfer',amount:'5'}))];
 const result=await root.querySummaryV2(q,portsFor(q,events));assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.value.summary.currencies[0].metrics.expense.knownSubtotal,'1');assert.equal(result.value.summary.currencies[0].metrics.cashPayouts.knownSubtotal,'5');
});
test('unknown simulated charge must not become an unconditional numeric zero aggregate',async()=>{
 const s={...scope(),billingMode:'simulated'},q=query(s);const events=[event(appendRequest(s,'unknown-sim',{amount:null}))];const result=await root.querySummaryV2(q,portsFor(q,events));assert.equal(result.ok,true,JSON.stringify(result));const row=result.value.summary.currencies[0];results.push({case:'unknown-simulated',simulated:row.simulated,coverage:result.value.summary.coverage,actualExpense:row.metrics.expense});assert.equal(result.value.summary.coverage.unknownAmountCount,1);assert.deepEqual(row.simulated.expense,{status:'unknown',knownSubtotal:null,total:null,unknownCount:1});
});
test('simulated known charge stays out of actual expense',async()=>{
 const s={...scope(),billingMode:'simulated'},q=query(s);const events=[event(appendRequest(s,'known-sim',{amount:'5'}))];const result=await root.querySummaryV2(q,portsFor(q,events));assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.value.summary.currencies[0].simulated.expense.knownSubtotal,'5');assert.equal(result.value.summary.currencies[0].metrics.expense.total,null);
});
test('correction of a cash receipt retains its cash economic type',()=>{
 const s=scope(),q=query(s);const original=appendRequest(s,'cash-original',{eventType:'cash_movement',classification:'operating_revenue',amount:'5'});
 const correction=event(appendRequest(s,'cash-corrected',{eventType:'correction',classification:'operating_revenue',amount:'7',subject:'cash-original',supersedes:original.eventId,revision:1}));
 correction.economicEventType='cash_movement';correction.rootId=original.eventId;
 const originalResult=projection(q,[event(original)]);assert.equal(originalResult.summary.currencies[0].metrics.cashReceipts.knownSubtotal,'5');
 const result=projection(q,[correction]);results.push({case:'cash-correction',row:result.summary.currencies[0],detail:result.details[0]});assert.equal(result.summary.currencies[0].metrics.cashReceipts.knownSubtotal,'7','latest valid correction replaces old receipt with its effective amount');
});
// Pure source-port reproductions are provisional; paired real PostgreSQL subtests live in reporting.test.mjs.

test('response reference mutation cannot poison independently registered Finance definitions',async()=>{
 const s=scope(),q=query(s);const events=[event(appendRequest(s,'reference-alias',{amount:'1'}))];const registry=reporting.REPORTING_CANONICAL_REFERENCE_REGISTRY.metrics.expense.reference;const original=structuredClone(registry);
 try{
  const page=await root.querySummaryV2(q,portsFor(q,events));assert.equal(page.ok,true,JSON.stringify(page));
  try{page.value.canonicalSummaries[0].metrics.expense.definition_ref.content_hash='sha256:'+'f'.repeat(64);}catch{}
  results.push({case:'returned-reference-alias',before:original,after:structuredClone(registry)});
  assert.deepEqual(registry,original,'consumer mutation of a response must not alter the independent Finance registry');
 }finally{assert.deepEqual(registry,original);}
});
test('caller request mutation during authorization cannot redirect the private query',async()=>{
 const s=scope(),q=query(s);const events=[event(appendRequest(s,'caller-alias',{amount:'1'}))];const ports=portsFor(q,events);ports.trustedContext.resolve=async()=>structuredClone(s);const auth=ports.financeAuthority.authorizeCurrent;let first=true;
 ports.financeAuthority.authorizeCurrent=async r=>{const result=await auth(r);if(first){first=false;q.filters.currency='EUR';}return result;};
 const page=await root.querySummaryV2(q,ports);assert.equal(page.ok,true,JSON.stringify(page));assert.equal(page.value.summary.currencies[0].currency,'USD');assert.equal(page.value.filters.currency,undefined);
});

test('provisional public cash reversal ancestry preserves receipt and payout signed axes',async()=>{
 for(const [classification,base,reversed,restored,axis] of [['operating_revenue','7','-2','1','cashReceipts'],['operating_expense','-7','2','-1','cashPayouts'],['payout_transfer','7','-2','1','cashPayouts']]){
  const s=scope(),q=query(s);const original=event(appendRequest(s,'axis-original',{eventType:'cash_movement',classification,amount:base}));
  const reversalRequest=appendRequest(s,'axis-reversal',{eventType:'reversal',classification,amount:reversed,subject:'axis-original',reverses:original.eventId});
  reversalRequest.sourceIdentity.sourceObjectId+='-reverse';reversalRequest.sourceIdentity.revisionSubjectId+='-reverse';
  assert.equal(root.validateLedgerAppendRequestBoundary(reversalRequest).ok,false,'mismatched source-line identity must be rejected before constructing source facts');
  reversalRequest.postingMapping.sourceLineId=reversalRequest.sourceIdentity.revisionSubjectId;const reversal=event(reversalRequest);
  const restoreRequest=appendRequest(s,'axis-restored',{eventType:'reversal',classification,amount:restored,subject:'axis-original',reverses:reversal.eventId});
  restoreRequest.sourceIdentity.sourceObjectId+='-restore';restoreRequest.sourceIdentity.revisionSubjectId+='-restore';restoreRequest.postingMapping.sourceLineId=restoreRequest.sourceIdentity.revisionSubjectId;const restore=event(restoreRequest);
  const node=(e,depth,reversesId)=>({eventId:e.eventId,eventType:e.economicEventType,reversesId,scope:s,ingestedAt:'2026-10-12T22:00:00.000Z',financialEffect:true,payload:e.payload,depth,cycle:false});
  original.economicLineage=[node(original,0,null)];reversal.economicLineage=[node(reversal,0,original.eventId),node(original,1,null)];restore.economicLineage=[node(restore,0,reversal.eventId),node(reversal,1,original.eventId),node(original,2,null)];
  const result=await root.querySummaryV2(q,portsFor(q,[original,reversal,restore]));assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.value.summary.currencies[0].metrics[axis].knownSubtotal,'6');assert.equal(result.value.summary.budgets[0].ledgerExpense,'0');
  restore.economicLineage[1].cycle=true;assert.equal((await root.querySummaryV2(q,portsFor(q,[restore]))).ok,false);
 }
});
