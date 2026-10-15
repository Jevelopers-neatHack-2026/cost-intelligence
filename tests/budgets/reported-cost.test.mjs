import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {providerReportedCostEvidenceContentHash} from '@jevelopers/shared-contracts-reported-development/usage-reported-unsettled';
import {resolveReportedCost,resolveBudgetReportedCost,budgetSourcePersistence,exactSourceDecimal,parseFinancialSourceJson,budgetDigest,budgetSourceBytesHash,budgetCollectorSigningBytes,resolvePricingProfile,pricingEconomicRequestDigest} from '../../dist/budgets/index.js';

async function signedFixture(options={}){
 const fixture=JSON.parse(await readFile(new URL('../../node_modules/@jevelopers/shared-contracts-reported-development/fixtures/UsageEvent.2_0_0.json',import.meta.url),'utf8'));
 const usage=structuredClone(fixture.valid),evidence=structuredClone(fixture.context.evidence_lookup.record);
 const clock={now:()=>new Date('2026-10-12T12:00:00Z')};
 const scope={tenantId:usage.tenant_id,projectId:usage.project_id,environment:options.production?'production':usage.environment,billingMode:usage.billing_mode,actorId:'synthetic-signed-source'};
 const attempt={logicalOperationId:usage.logical_operation_id,providerAttemptId:usage.provider_attempt_id,billableAttemptId:usage.billable_attempt_id,transportAttemptId:usage.transport_attempt_id,providerRequestId:null};
 const keys=await crypto.subtle.generateKey('Ed25519',true,['sign','verify']);
 const key={publicKeySpkiBase64:Buffer.from(await crypto.subtle.exportKey('spki',keys.publicKey)).toString('base64'),revoked:false,allowedKinds:['reported_cost','execution_finality','pricing_profile','maximum_policy','aggregate_usage'],validFrom:'2026-10-12T11:00:00Z',validUntil:'2026-10-12T13:00:00Z'};
 const binding=options.native?{mappingVersion:'ci-reservation-authority-1.0.0',budgetScopeId:randomUUID(),grantRef:randomUUID(),accountRef:randomUUID(),projectRef:scope.projectId,provider:usage.provider,model:usage.model,operation:'generate',targetBindingSha256:`sha256:${'a'.repeat(64)}`,leaseRef:randomUUID(),leaseExpiresAt:'2026-10-12T13:00:00Z'}:null;
 const records=new Map();
 const sign=async(kind,value)=>Buffer.from(await crypto.subtle.sign('Ed25519',keys.privateKey,budgetCollectorSigningBytes(kind,value))).toString('base64');
 const publish=async(kind,payload,sourceBytes='{"usage":{"cost":0.000003}}')=>{
  if(kind==='pricing_profile')sourceBytes=JSON.stringify({financial_pricing_policy:payload});if(kind==='maximum_policy')sourceBytes=JSON.stringify({financial_maximum_policy:payload});
  const record={version:'ci-budget-source-1.0.0',issuerKeyId:'synthetic-owner',id:randomUUID(),revision:1,predecessorHash:null,scope,authorityBinding:binding,evidenceMode:'mocked',provider:usage.provider,model:usage.model,operation:'generate',targetBindingSha256:`sha256:${'a'.repeat(64)}`,attempt,kind,sourceFormat:kind==='pricing_profile'?'finance_pricing_policy_v1':kind==='maximum_policy'?'finance_maximum_policy_v1':'finance_synthetic_provider_response_v1',sourceBytesSha256:await budgetSourceBytesHash(sourceBytes),observedAt:clock.now().toISOString(),payload};
  const hash=await budgetDigest(record),{actorId,...financialScope}=scope;
  const current={version:record.version,issuerKeyId:record.issuerKeyId,recordId:record.id,revision:1,recordHash:hash,scopeHash:await budgetDigest(financialScope),verifiedAt:clock.now().toISOString(),expiresAt:'2026-10-12T12:00:30Z',revoked:false};
  const reference={contract:'ci-budget-source',schema_version:'1.0.0',id:record.id,revision:1,content_hash:hash};
  records.set(record.id,{record,current,sourceBytes,recordSignature:await sign('record',record),currentSignature:await sign('current',current)});
  return {scope,reference,kind,provider:record.provider,model:record.model,operation:record.operation,targetBindingSha256:record.targetBindingSha256,attempt,...(binding?{authorityBinding:binding}:{})};
 };
 const backend={loadCurrent:async ref=>structuredClone(records.get(ref.id)??null),loadCurrentIssuerKey:async id=>id==='synthetic-owner'?structuredClone(key):null};
 const payload=async(amount='0.000003',sourceBytes='{"usage":{"cost":0.000003}}')=>{
  const e=structuredClone(evidence),u=structuredClone(usage);e.source_bytes_hash=await budgetSourceBytesHash(sourceBytes);e.reported_cost.money.amount=amount;e.reported_cost.money.scale=amount.split('.')[1]?.length??0;e.content_hash=providerReportedCostEvidenceContentHash(e);
  u.valuation.money=structuredClone(e.reported_cost.money);u.valuation.provider_evidence_ref.content_hash=e.content_hash;
  return {usageEvent:u,providerEvidence:e,references:fixture.context.references,amountSemantics:'cumulative_attempt_total'};
 };
 return {clock,scope,attempt,records,backend,publish,payload};
}
test('development installed SDK decoding follows signed owner original bytes; known cost does not imply complete usage or finality',async()=>{
 const f=await signedFixture(),query=await f.publish('reported_cost',await f.payload());const cost=await resolveReportedCost(f.backend,f.clock,query);
 assert.ok(cost);assert.equal(cost.evidence.reported_cost.money.amount,'0.000003');assert.equal(cost.usage.completeness,'unknown');assert.equal(cost.usage.provider_request_id,null);assert.equal(cost.usage.valuation.rate_card_ref,null);assert.equal(cost.amountSemantics,'cumulative_attempt_total');
});
test('authenticated payload cannot invent zero from missing source cost or contradict its original receipt',async()=>{
 const f=await signedFixture();
 for(const bytes of ['{"usage":{}}','{"usage":{"cost":null}}','{"usage":{"cost":0.01}}']){
  const query=await f.publish('reported_cost',await f.payload('0',bytes),bytes);assert.equal(await resolveReportedCost(f.backend,f.clock,query),null);
 }
 const bytes='{"usage":{"cost":0}}';const query=await f.publish('reported_cost',await f.payload('0',bytes),bytes);assert.ok(await resolveReportedCost(f.backend,f.clock,query));
});
test('collector and canonical identities must both match; aggregate evidence cannot manufacture an attempt',async()=>{
 const f=await signedFixture(),payload=await f.payload();payload.usageEvent.transport_attempt_id=randomUUID();
 assert.equal(await resolveReportedCost(f.backend,f.clock,await f.publish('reported_cost',payload)),null);
 const aggregate=await f.payload();aggregate.providerEvidence.source_scope={kind:'api_key_aggregate',api_key_ref:'synthetic-key'};
 assert.equal(await resolveReportedCost(f.backend,f.clock,await f.publish('reported_cost',aggregate)),null);
});
test('authenticated redelivery reuses immutable observation facts; changed cumulative cost requires its exact predecessor',async()=>{
 const f=await signedFixture(),initial=await f.payload(),first=await resolveReportedCost(f.backend,f.clock,await f.publish('reported_cost',initial));assert.ok(first);
 const duplicate=structuredClone(initial);duplicate.usageEvent.event_id=randomUUID();duplicate.usageEvent.transport_attempt_id=randomUUID();
 const duplicateQuery=await f.publish('reported_cost',duplicate);
 assert.equal(await resolveReportedCost(f.backend,f.clock,duplicateQuery),null);
 assert.ok(await resolveReportedCost(f.backend,f.clock,duplicateQuery,first.usage));
 const bytes='{"usage":{"cost":0.000004}}',next=await f.payload('0.000004',bytes);
 next.usageEvent.source_observation_id=randomUUID();next.usageEvent.supersedes_observation_id=first.usage.source_observation_id;
 next.providerEvidence.evidence_id=randomUUID();next.providerEvidence.source_observation_id=next.usageEvent.source_observation_id;
 next.providerEvidence.content_hash=providerReportedCostEvidenceContentHash(next.providerEvidence);
 next.usageEvent.valuation.provider_evidence_ref={contract:'ProviderReportedCostEvidence',schema_version:'1.0.0',id:next.providerEvidence.evidence_id,revision:1,content_hash:next.providerEvidence.content_hash};
 const nextQuery=await f.publish('reported_cost',next,bytes);
 assert.equal(await resolveReportedCost(f.backend,f.clock,nextQuery),null);
 assert.ok(await resolveReportedCost(f.backend,f.clock,nextQuery,first.usage));
 const fork=structuredClone(next);fork.usageEvent.supersedes_observation_id=randomUUID();
 assert.equal(await resolveReportedCost(f.backend,f.clock,await f.publish('reported_cost',fork,bytes),first.usage),null);
 const changedDuplicate=structuredClone(duplicate);changedDuplicate.usageEvent.observed_at='2026-10-11T00:00:00Z';
 assert.equal(await resolveReportedCost(f.backend,f.clock,await f.publish('reported_cost',changedDuplicate),first.usage),null);
});
test('exact source decimals preserve USD18 precision and refuse truncation/binary floating rounding',()=>{
 assert.equal(parseFinancialSourceJson('{"usage":{"cost":1.000000000000000001}}').usage.cost,'1.000000000000000001');
 assert.equal(exactSourceDecimal('1e-18'),'0.000000000000000001');assert.equal(exactSourceDecimal('1e-19'),null);
 assert.equal(exactSourceDecimal('0.0000'),'0');assert.equal(exactSourceDecimal('-1'),null);
});
test('complete per-token subtotal remains subordinate to authenticated per-attempt maximum policy',async()=>{
 const f=await signedFixture(),request={requestId:'fixture',scope:f.scope,estimate:{completeness:'complete',knownSubtotal:'0.01'},attemptBinding:f.attempt,sourceAuthorityRef:null};
 const digest=await pricingEconomicRequestDigest(request);
 const max=await f.publish('maximum_policy',{schemaVersion:'ci-budget-maximum-1.0.0',currency:'USD',policyRef:{contract:'ci-fixture-maximum',schema_version:'1.0.0',id:randomUUID(),revision:1,content_hash:`sha256:${'0'.repeat(64)}`},authorizedMaximum:'0.10',economicRequestDigest:digest});
 const profile=await f.publish('pricing_profile',{schemaVersion:'ci-budget-pricing-1.0.0',currency:'USD',economicRequestDigest:digest,pricingUnit:'per_token',fixedAttemptAmount:null,maximumPolicyRef:max.reference});
 const value=await resolvePricingProfile(f.backend,f.clock,profile,request);assert.ok(value);assert.equal(value.maximum.record.payload.authorizedMaximum,'0.10');
 const invalid=await f.publish('pricing_profile',{...value.profile,maximumPolicyRef:null});assert.equal((await resolvePricingProfile(f.backend,f.clock,invalid,request)).maximum,null);
 assert.equal(await resolvePricingProfile(f.backend,f.clock,profile,{...request,estimate:{completeness:'complete',knownSubtotal:'0.02'}}),null);
});

test('signed whole provider body and arbitrary collector extras never enter runtime-readable financial provenance',async()=>{
 const f=await signedFixture(),canary='private-fixture-canary-'+randomUUID();
 const original=JSON.stringify({usage:{cost:'0.25'},prompt:canary,images:[canary],credentials:{bearer:canary}});
 const payload=await f.payload('0.25',original);payload.privateMetadata={prompt:canary};
 const query=await f.publish('reported_cost',payload,original),accepted=await resolveReportedCost(f.backend,f.clock,query);
 assert.ok(accepted);const persisted=await budgetSourcePersistence(accepted.source);
 assert.equal(JSON.stringify(persisted).includes(canary),false);
 assert.equal(persisted.collectorRecord.sourceBytesSha256,await budgetSourceBytesHash(original));
 assert.equal(persisted.collectorRecord.originalPayloadHash,await budgetDigest(payload));
 assert.equal(persisted.financialFacts.reportedCost.money.amount,'0.25');
 assert.equal('sourceBytes' in persisted,false);assert.equal('original_source_bytes' in persisted,false);
});

function nativeFinancialPayload(f,amount='1.10',changes={}){
 return {version:'ci-budget-reported-cost-1.0.0',observationId:randomUUID(),economicUsageId:randomUUID(),supersedesObservationId:null,
  evidenceId:randomUUID(),evidenceRevision:1,predecessorEvidenceHash:null,correlationId:randomUUID(),occurredAt:f.clock.now().toISOString(),observedAt:f.clock.now().toISOString(),
  producer:{module:'finance.synthetic.source',sourceRevision:'a'.repeat(40),buildRevision:'synthetic-1'},amountSemantics:'cumulative_attempt_total',
  money:{amount,currency:'USD',scale:amount.split('.')[1]?.length??0},usage:{completeness:'unknown',missingFields:['usage'],units:[]},...changes};
}
test('Finance-native production source preserves exact USD18 and unknown usage without canonical adoption or development helper authority',async()=>{
 const f=await signedFixture({native:true,production:true}),amount='1.000000000000000001',payload=nativeFinancialPayload(f,amount);
 const query=await f.publish('reported_cost',payload,`{"usage":{"cost":${amount}}}`);
 const resolved=await resolveBudgetReportedCost(f.backend,f.clock,query,'finance_collector_v1');assert.ok(resolved);
 assert.equal(resolved.evidence.reported_cost.money.amount,amount);assert.equal(resolved.usage.completeness,'unknown');
 assert.equal(resolved.usage.finance_mapping_version,'ci-budget-normalized-reported-1.0.0');assert.equal(resolved.usage.provider_request_id,null);
 assert.equal(resolved.usage.valuation.provider_evidence_ref.contract,'FinanceReportedCostEvidence');
 assert.equal(await resolveBudgetReportedCost(f.backend,f.clock,query,'development_0_10_1'),null);
 assert.equal(await resolveBudgetReportedCost(f.backend,f.clock,{...query,authorityBinding:undefined},'finance_collector_v1'),null);
 const money=await f.publish('reported_cost',nativeFinancialPayload(f,'0'),'{}');assert.equal(await resolveBudgetReportedCost(f.backend,f.clock,money,'finance_collector_v1'),null);
 const zero=await f.publish('reported_cost',nativeFinancialPayload(f,'0'),'{"usage":{"cost":0}}');assert.ok(await resolveBudgetReportedCost(f.backend,f.clock,zero,'finance_collector_v1'));
});
test('Finance-native immutable duplicate, current predecessor and source facts reject forks, false first parents and raw-cost contradictions',async()=>{
 const f=await signedFixture({native:true,production:true}),first=nativeFinancialPayload(f),firstQuery=await f.publish('reported_cost',first,'{"usage":{"cost":1.10}}');
 const prior=await resolveBudgetReportedCost(f.backend,f.clock,firstQuery,'finance_collector_v1');assert.ok(prior);
 const duplicate=await f.publish('reported_cost',first,'{"usage":{"cost":1.10}}');assert.ok(await resolveBudgetReportedCost(f.backend,f.clock,duplicate,'finance_collector_v1',prior.usage));
 const next=nativeFinancialPayload(f,'1.20',{economicUsageId:first.economicUsageId,supersedesObservationId:first.observationId,predecessorEvidenceHash:prior.evidence.content_hash});
 const nextQuery=await f.publish('reported_cost',next,'{"usage":{"cost":1.20}}');assert.ok(await resolveBudgetReportedCost(f.backend,f.clock,nextQuery,'finance_collector_v1',prior.usage));
 assert.equal(await resolveBudgetReportedCost(f.backend,f.clock,nextQuery,'finance_collector_v1'),null);
 for(const changes of [{supersedesObservationId:randomUUID()},{predecessorEvidenceHash:`sha256:${'f'.repeat(64)}`},{economicUsageId:randomUUID()}]){
  const fork=await f.publish('reported_cost',{...next,...changes},'{"usage":{"cost":1.20}}');assert.equal(await resolveBudgetReportedCost(f.backend,f.clock,fork,'finance_collector_v1',prior.usage),null);
 }
 const falseMoney=await f.publish('reported_cost',nativeFinancialPayload(f,'0'),'{"usage":{"cost":1.10}}');assert.equal(await resolveBudgetReportedCost(f.backend,f.clock,falseMoney,'finance_collector_v1'),null);
});
test('Finance-native financial projection retains source commitment while excluding authentic original response extras',async()=>{
 const f=await signedFixture({native:true,production:true}),canary='private-fixture-canary-'+randomUUID(),body=JSON.stringify({usage:{cost:'0.4'},prompt:canary,images:[canary]});
 const query=await f.publish('reported_cost',nativeFinancialPayload(f,'0.4'),body),resolved=await resolveBudgetReportedCost(f.backend,f.clock,query,'finance_collector_v1');assert.ok(resolved);
 const safe=await budgetSourcePersistence(resolved.source);assert.equal(JSON.stringify(safe).includes(canary),false);
 assert.equal(safe.collectorRecord.sourceBytesSha256,await budgetSourceBytesHash(body));assert.equal(safe.financialFacts.reportedCost.money.amount,'0.4');
});
test('Finance-native signed missing, out-of-range and contradictory invalid costs never compare as two valid equal amounts',async()=>{
 const f=await signedFixture({native:true,production:true});
 const cases=[
  ['10000000000000000000000','{}'],
  ['10000000000000000000000','{"usage":{"cost":10000000000000000000000}}'],
  ['10000000000000000000000','{"usage":{"cost":20000000000000000000000}}'],
  ['10000000000000000000000','{"usage":{"cost":null}}'],
  ['0','{"usage":{"cost":10000000000000000000000}}'],
  ['10000000000000000000000','{"usage":{"cost":0}}'],
 ];
 const accepted=[];for(const [amount,body] of cases){const query=await f.publish('reported_cost',nativeFinancialPayload(f,amount),body);accepted.push((await resolveBudgetReportedCost(f.backend,f.clock,query,'finance_collector_v1'))!==null);}
 assert.deepEqual(accepted,cases.map(()=>false));
 const zero=await f.publish('reported_cost',nativeFinancialPayload(f,'0'),'{"usage":{"cost":0}}');assert.ok(await resolveBudgetReportedCost(f.backend,f.clock,zero,'finance_collector_v1'));
 const exact=await f.publish('reported_cost',nativeFinancialPayload(f,'1.000000000000000001'),'{"usage":{"cost":1.000000000000000001}}');assert.ok(await resolveBudgetReportedCost(f.backend,f.clock,exact,'finance_collector_v1'));
});
