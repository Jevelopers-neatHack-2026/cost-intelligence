import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';
import * as root from '../../dist/index.js';
import { Value } from '@sinclair/typebox/value';
import { checkFinancialSummary } from '@jevelopers/shared-contracts/operations';
import * as reporting from '../../dist/reporting/index.js';
import { allocateSharedExpense, ACCOUNTING_ALLOCATION_POLICY_VERSION } from '../../dist/accounting/index.js';
import { runtimeDatabaseConfigFromEnvironment, databaseConfigFromEnvironment, assertDisposableMarker } from '../../scripts/test-db-lifecycle.mjs';
import { makePorts as budgetPorts, setBudgetLimit, loadReserveFixture, reservationRequest, markDispatchedCommand } from '../budgets/reservation-harness.mjs';
const oracle = JSON.parse(await readFile(new URL('../../fixtures/reporting/ci08-manual-oracle.json', import.meta.url), 'utf8'));
const canonical = value => value === null || typeof value !== 'object' ? JSON.stringify(value) : Array.isArray(value) ? '['+value.map(canonical).join(',')+']' : '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';
const hash = value => 'sha256:'+createHash('sha256').update(canonical(value)).digest('hex');
const parse = value => { const negative=value.startsWith('-'); const [whole,fraction='']=(negative?value.slice(1):value).split('.'); return BigInt(whole+fraction.padEnd(18,'0'))*(negative?-1n:1n); };
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
function makePorts(pool,scope,clock,overrides={}) {
  const state={denied:false,calls:0,readCount:0};
  const authority={authorizeCurrent:async request=>{state.calls++;return state.denied||JSON.stringify(request.requestedScope)!==JSON.stringify(scope)?{status:'denied',operation:request.operation,permission:request.permission}:{status:'allowed',decisionId:'synthetic-current-grant',operation:request.operation,permission:request.permission,scope:request.requestedScope,principal:{kind:'service',actorId:scope.actorId,serviceStatus:'active',serviceGrantRevision:'synthetic-host-rev-1'},verifiedAt:clock.value,expiresAt:new Date(Date.parse(clock.value)+60000).toISOString()};}};
  const database={connect:async()=>{const client=await pool.connect();return {query:async(...args)=>{state.readCount++;return client.query(...args);},release:()=>client.release()};}};
  const ports={clock:{now:()=>new Date(clock.value)},storage:{isAvailable:async()=>true},providerSource:{isAvailable:async()=>false},trustedContext:{resolve:async requested=>JSON.stringify(requested)===JSON.stringify(scope)?{...scope}:null},financeAuthority:authority,
    reporting:{database,cursorSigningKey:'synthetic-only-pagination-key-0000000000000000000',producer:{sourceRevision:'a'.repeat(40),buildRevision:'ci08-synthetic-oracle-1'},...overrides},database};
  return {ports,state};
}
async function checked(result) { const actual=await result;assert.equal(actual.ok,true,JSON.stringify(actual));return actual.value; }
async function allDetails(first,q,ports,capture) {
  const rows=[...first.details];let page=first;
  capture?.push({request:structuredClone(q),response:structuredClone(first)});
  while(page.hasMore){const request={...q,snapshotId:page.snapshotId,cursor:page.nextCursor};page=await checked(root.querySummary(request,ports));capture?.push({request:structuredClone(request),response:structuredClone(page)});rows.push(...page.details);}
  return rows;
}

await test('CI-08 real scoped PostgreSQL public query and immutable financial oracle',async t=>{
  const admin=new pg.Pool({...databaseConfigFromEnvironment('CI_TEST_DB'),max:2});
  const pool=new pg.Pool({...runtimeDatabaseConfigFromEnvironment(),max:4});
  assertDisposableMarker((await admin.query('SELECT marker FROM ci_test.disposable_database_marker')).rows);
  const failures=[];
  const run=async(name,fn)=>t.test(name,async()=>{try {await fn();}catch(error){failures.push({name,message:error.message,stack:error.stack});throw error;}});
  try {
    const s={...scope(),tenantId:'11111111-1111-4111-8111-111111111111',projectId:'22222222-2222-4222-8222-222222222222'};const clock={value:'2026-10-12T22:00:00.000Z'};const {ports,state}=makePorts(pool,s,clock);
    const requests=[];
    for(const row of oracle.postings){const req=appendRequest(s,row.id,row);requests.push(req);await checked(root.appendLedgerEvent(req,ports));}
    const q=query(s);let first;const refusalObservations=[];
    const retainRefusal=(name,request,result,readsBefore)=>{assert.equal(result.ok,false);refusalObservations.push({name,request:structuredClone(request),result:structuredClone(result),readsBefore,readsAfter:state.readCount});};
    await run('public root and reporting subpath expose the same database implementation',async()=>{
      assert.equal(root.querySummary,reporting.querySummary);first=await checked(root.querySummary(q,ports));await mkdir(new URL('../../artifacts/reporting/',import.meta.url),{recursive:true});await writeFile(new URL('../../artifacts/reporting/producer-v2-page.json',import.meta.url),JSON.stringify(first,null,2)+'\n');assert.equal(first.detailCount,6);assert.equal(first.canonicalSummaries.length,2);assert.equal(reporting.validateFinancialSummaryPageV2Boundary(first).ok,true);
    });
    await run('canonical semantics resolve definition and policy references from the independently pinned Finance registry',async()=>{
      const registry=reporting.REPORTING_CANONICAL_REFERENCE_REGISTRY;
      for(const entry of Object.values(registry.metrics)){assert.equal(Value.Check(reporting.ReportingMetricDefinitionSchema,entry.definition),true);assert.equal(entry.reference.id,entry.definition.definitionId);assert.equal(entry.reference.content_hash,hash(entry.definition));}
      assert.equal(Value.Check(reporting.ReportingPolicyDefinitionSchema,registry.policy.definition),true);assert.equal(registry.policy.reference.content_hash,hash(registry.policy.definition));
      for(const summary of first.canonicalSummaries){const references={policy_ref:registry.policy.reference};for(const name of Object.keys(summary.metrics))references[`metrics/${name}/definition_ref`]=registry.metrics[name].reference;
        const context={scope:{tenant_id:s.tenantId,project_id:s.projectId},now:clock.value,policy_version:'1.0.0',references,currency:summary.currency,included_environments:['test'],included_billing_modes:['live']};
        assert.equal(checkFinancialSummary(summary,context).ok,true);assert.equal(checkFinancialSummary(summary,{...context,references:{}}).ok,false);assert.equal(checkFinancialSummary({...summary,completeness:'complete',coverage:{...summary.coverage,expected:null}},context).ok,false);
      }
    });
    await run('golden gross/net/direct/contribution, mixed currencies and all required groupings',async()=>{
      const usd=first.summary.currencies.find(row=>row.currency==='USD');const eur=first.summary.currencies.find(row=>row.currency==='EUR');
      for(const [key,value]of Object.entries(oracle.manualExpected.USD))assert.equal(usd.metrics[key].knownSubtotal,value,key);
      assert.equal(eur.metrics.directCosts.knownSubtotal,'2');assert.equal(usd.metrics.cashReceipts.total,null);assert.equal(usd.metrics.cashReceipts.status,'unknown');
      for(const dimension of reporting.REPORTING_DIMENSIONS)assert.ok(usd.groups.some(group=>group.dimension===dimension));assert.ok(usd.groups.some(group=>group.bucket==='unknown_unallocated'));
      assert.equal(first.summary.unitCosts[0].status,'unknown');assert.equal(first.summary.coverage.expected,null);assert.equal(first.summary.coverage.status,'partial');
    });
    await run('all scoped redacted detail sums equal exact aggregate inputs before any rounding',async()=>{
      const pages=[];const rows=await allDetails(first,q,ports,pages);assert.equal(new Set(rows.map(row=>row.detailId)).size,6);assert.equal(pages.length,3);
      const references=page=>page.canonicalSummaries.map(summary=>({summaryId:summary.summary_id,policy:summary.policy_ref,metrics:Object.fromEntries(Object.entries(summary.metrics).map(([name,value])=>[name,value.definition_ref]))}));
      const referenceHash=hash(references(first));
      for(const [index,observed]of pages.entries()){
        const page=observed.response;assert.equal(reporting.validateFinancialSummaryPageV2Boundary(page).ok,true);assert.equal(hash(page.summary),first.summaryContentHash);
        for(const key of ['snapshotId','queryContentHash','summaryContentHash','asOf','detailCount'])assert.equal(page[key],first[key]);
        for(const key of ['scope','period','filters','watermark','summary','canonicalSummaries'])assert.deepEqual(page[key],first[key]);
        assert.equal(hash(references(page)),referenceHash);assert.equal(page.details.length,2);
        if(index>0){assert.equal(observed.request.snapshotId,first.snapshotId);assert.equal(observed.request.cursor,pages[index-1].response.nextCursor);}
      }
      assert.equal(pages.at(-1).response.hasMore,false);assert.equal(pages.at(-1).response.nextCursor,null);
      const binding={snapshotId:first.snapshotId,queryContentHash:first.queryContentHash,summaryContentHash:first.summaryContentHash,referenceHash,asOf:first.asOf,scope:first.scope};
      const capture={captureVersion:'1.0.0',status:'TESTED_SYNTHETIC_PAGINATION_CAPTURE_NOT_CONSUMER_ACK',baseRevision:'815c3f9f9a2979d2c695b687ea26863c99e01d3a',producerPayloadRevisionMeaning:'explicit synthetic placeholder; actual test source/run bound by CI checkout and manifest',billingEvidence:'mocked synthetic fixture, requested live billing mode is not actual provider billing proof',binding,pages:pages.map((observed,index)=>({...observed,index,requestRecordHash:hash(observed.request),responseRecordHash:hash(observed.response)})),orderedDetailIds:rows.map(row=>row.detailId),detailCount:rows.length,terminal:true};
      for(const currency of first.summary.currencies)for(const key of ['grossSales','netSales','directCosts','contribution'])assert.equal(rows.filter(row=>row.currency===currency.currency).reduce((sum,row)=>sum+parse(row.metrics[key]),0n),parse(currency.metrics[key].knownSubtotal??'0'));
      const serialized=JSON.stringify(pages.map(observed=>observed.response));for(const key of ['event_payload','sourceEventId','providerRequestId','actor_reference','cursorSigningKey','sourceRevision'])assert.equal(serialized.includes(key),key==='sourceRevision'?false:false);
      await writeFile(new URL('../../artifacts/reporting/producer-v2-pagination-page.json',import.meta.url),JSON.stringify(capture,null,2)+'\n');
    });
    await run('tampered cursor, rehashed forgery, wrong filters, scope, period, page size and version are rejected',async()=>{
      const token=JSON.parse(Buffer.from(first.nextCursor,'base64url'));token.offset=4;token.contentHash=hash(Object.fromEntries(Object.entries(token).filter(([key])=>key!=='contentHash')));
      const forged=Buffer.from(canonical(token)).toString('base64url');
      for(const [name,change]of [['unsigned_cursor_forgery',{cursor:forged}],['cursor_page_size_mismatch',{pageSize:3,cursor:first.nextCursor}],['snapshot_period_mismatch',{period:{...q.period,end:'2026-10-10T13:00:00.000Z'}}],['snapshot_filter_mismatch',{filters:{...q.filters,providers:['provider-a']}}],['foreign_scope',{scope:{...s,projectId:randomUUID()}}]]){
        const request={...q,snapshotId:first.snapshotId,...change};const reads=state.readCount;const result=await root.querySummary(request,ports);retainRefusal(name,request,result,reads);
        if(name==='foreign_scope'){assert.equal(result.error.code,'FORBIDDEN_SCOPE');assert.equal(state.readCount,reads);}
      }
      const legacy={...q,schemaVersion:'1.0.0',snapshotId:first.snapshotId};delete legacy.policyVersion;delete legacy.groupings;const reads=state.readCount;retainRefusal('cross_version_snapshot',legacy,await root.querySummary(legacy,ports),reads);
    });
    await run('legacy v1 uses the real reader for representable single-currency UUID scope',async()=>{
      const legacy={...q,schemaVersion:'1.0.0',filters:{...q.filters,currency:'USD'}};delete legacy.policyVersion;delete legacy.groupings;
      const page=await checked(root.querySummary(legacy,ports));await writeFile(new URL('../../artifacts/reporting/producer-v1-page.json',import.meta.url),JSON.stringify(page,null,2)+'\n');assert.equal(page.schemaVersion,'1.0.0');assert.equal(page.summary.currency,'USD');assert.equal(page.summary.metrics.direct_costs.status,'unknown');assert.equal(page.summary.metrics.cash_receipts.value,null);assert.equal(root.validateFinancialSummaryPageBoundary(page).ok,true);
      const replay=await checked(root.querySummary({...legacy,snapshotId:page.snapshotId},ports));assert.equal(replay.summaryContentHash,page.summaryContentHash);
      const descriptor={scope:s,snapshotId:page.snapshotId,queryContentHash:page.queryContentHash,summaryContentHash:page.summaryContentHash};
      const stored=await checked(root.readVerifiedSummarySnapshot({...descriptor,schemaVersion:'1.0.0',requestId:'export-read'},ports));
      const withoutRequest=page=>{const {requestId,...content}=page;return content;};assert.deepEqual(withoutRequest(stored),withoutRequest(page));
      assert.deepEqual(withoutRequest(await root.createReportingSnapshotReader(ports).readVerifiedSnapshot(descriptor)),withoutRequest(page));
      assert.equal(await root.createReportingSnapshotReader(ports).readVerifiedSnapshot({...descriptor,summaryContentHash:'sha256:'+'0'.repeat(64)}),null);
      const v2=await checked(root.readVerifiedSummarySnapshotV2({schemaVersion:'1.0.0',requestId:'v2-export-read',scope:s,snapshotId:first.snapshotId,queryContentHash:first.queryContentHash,summaryContentHash:first.summaryContentHash},ports));assert.equal(v2.snapshotId,first.snapshotId);
      assert.equal((await root.readVerifiedSummarySnapshotV2({...descriptor,schemaVersion:'1.0.0',requestId:'cross-version'},ports)).ok,false);
    });
    await run('each dimension filter retains known values and explicit unknown buckets',async()=>{
      for(const [filter,value,count]of [['providers','provider-a',1],['models','model-a',1],['repositories','repo-a',1],['workflowIds','workflow-a',1],['featureCategories','research',1],['orderIds','order-a',3],['channels','web',3],['products','unknown',6],['customerIds','unknown',6],['workstreams','unknown',6],['jobIds','unknown',6]]){
        const page=await checked(root.querySummary({...q,filters:{...q.filters,[filter]:[value]}},ports));assert.equal(page.detailCount,count,filter);
      }
    });
    await run('snapshot and as-of reproduce the original inputs after a late estimate correction',async()=>{
      const correction=appendRequest(s,'research-confirmed',{eventType:'correction',subject:'research',revision:1,supersedes:requests.find(r=>r.eventId.endsWith('research')).eventId,amount:'1.1'});clock.value='2026-10-12T22:00:01.000Z';await checked(root.appendLedgerEvent(correction,ports));
      const old=await checked(root.querySummary({...q,snapshotId:first.snapshotId},ports));assert.equal(old.summaryContentHash,first.summaryContentHash);
      const past=await checked(root.querySummary({...q,requestedAsOf:first.asOf},ports));assert.equal(past.snapshotId,first.snapshotId);
      const latest=await checked(root.querySummary(q,ports));assert.equal(latest.summary.currencies.find(row=>row.currency==='USD').metrics.directCosts.knownSubtotal,'1.100000000000000001');assert.equal(latest.detailCount,6);
    });
    await run('repeated rebuild is deterministic and changing transport request identity does not change economics',async()=>{
      const a=await checked(root.querySummary(q,ports));const b=await checked(root.querySummary({...q,requestId:'new-request',idempotencyKey:'new-transport'},ports));assert.equal(a.snapshotId,b.snapshotId);assert.equal(a.summaryContentHash,b.summaryContentHash);
    });
    await run('denied, absent, stale and late-revoked current grants fail closed without guessed authority',async()=>{
      state.denied=true;const reads=state.readCount;const request={...q,snapshotId:first.snapshotId};const denied=await root.querySummary(request,ports);retainRefusal('current_grant_denied',request,denied,reads);assert.equal(denied.error.code,'FORBIDDEN_SCOPE');assert.equal(state.readCount,reads);state.denied=false;
      const no={...ports};delete no.financeAuthority;assert.equal((await root.querySummary(q,no)).ok,false);
      const stale={...ports,financeAuthority:{authorizeCurrent:async request=>({status:'allowed',decisionId:'old',operation:request.operation,permission:request.permission,scope:s,principal:{kind:'service',actorId:s.actorId,serviceStatus:'active',serviceGrantRevision:'old'},verifiedAt:'2026-10-10T00:00:00.000Z',expiresAt:'2026-10-10T00:01:00.000Z'})}};const staleReads=state.readCount;const staleResult=await root.querySummary(q,stale);retainRefusal('stale_current_grant',q,staleResult,staleReads);assert.equal(staleResult.error.code,'FORBIDDEN_SCOPE');assert.equal(state.readCount,staleReads);
      const revoked={...ports,reporting:{...ports.reporting,database:{connect:async()=>{const c=await pool.connect();return {query:async(sql,values)=>{const r=await c.query(sql,values);if(sql==='COMMIT')state.denied=true;return r;},release:()=>c.release()};}}}};
      const revokedReads=state.readCount;const revokedResult=await root.querySummary(request,revoked);retainRefusal('revoked_after_commit',request,revokedResult,revokedReads);assert.equal(revokedResult.error.code,'FORBIDDEN_SCOPE');state.denied=false;
      await writeFile(new URL('../../artifacts/reporting/producer-v2-refusals-page.json',import.meta.url),JSON.stringify({captureVersion:'1.0.0',status:'TESTED_SYNTHETIC_REFUSAL_CAPTURE_NOT_CURRENT_HOST_GRANT',baseRevision:'815c3f9f9a2979d2c695b687ea26863c99e01d3a',snapshotId:first.snapshotId,queryContentHash:first.queryContentHash,summaryContentHash:first.summaryContentHash,observations:refusalObservations.map(observed=>({...observed,requestRecordHash:hash(observed.request),resultRecordHash:hash(observed.result)}))},null,2)+'\n');
    });
    await run('privacy quarantine prevents replay and false-zero projections',async()=>{
      await admin.query(`INSERT INTO cost_intelligence.financial_privacy_quarantine(tenant_id,project_id,environment,billing_mode,record_kind,record_hash,reason_code) VALUES ($1,$2,$3,$4,'ledger_event','sha256:'||repeat('a',64),'legacy_sensitive_event_data')`,[s.tenantId,s.projectId,s.environment,s.billingMode]);
      const result=await root.querySummary({...q,snapshotId:first.snapshotId},ports);assert.equal(result.ok,false);assert.equal(result.error.code,'SOURCE_UNAVAILABLE');
    });
    await run('actual IANA timezone validation and exact scope/environment filters',async()=>{
      const next=scope();const {ports:p}=makePorts(pool,next,clock);
      for(const change of [{timezone:'Imaginary/Timezone'},{filters:{environments:['production'],billingModes:['live']}},{filters:{environments:['test'],billingModes:['sandbox']}},{period:{start:q.period.end,end:q.period.start}}])assert.equal((await root.querySummary({...query(next),...change},p)).ok,false);
    });
    await run('period end is exclusive and out-of-period cost only affects lifetime budget state',async()=>{
      const next=scope();const {ports:p}=makePorts(pool,next,clock);await checked(root.appendLedgerEvent(appendRequest(next,'end-boundary',{amount:'7',occurredAt:oracle.period.end}),p));const page=await checked(root.querySummary(query(next,{filters:{environments:['test'],billingModes:['live'],currency:'USD'}}),p));assert.equal(page.detailCount,0);assert.equal(page.summary.currencies[0].metrics.expense.total,null);assert.equal(page.summary.budgets[0].ledgerExpense,'7');
    });
    await run('unknown valuation is visible, missing cash and revenue remain unknown, empty source is never zero',async()=>{
      const next=scope();const {ports:p}=makePorts(pool,next,clock);await checked(root.appendLedgerEvent(appendRequest(next,'unknown',{amount:null}),p));
      const page=await checked(root.querySummary(query(next),p));const usd=page.summary.currencies[0];assert.equal(usd.metrics.directCosts.total,null);assert.equal(usd.metrics.directCosts.knownSubtotal,null);assert.equal(page.summary.coverage.unknownAmountCount,1);assert.equal(usd.metrics.grossSales.status,'unknown');
      const empty=scope();const {ports:e}=makePorts(pool,empty,clock);const zero=await checked(root.querySummary(query(empty,{filters:{environments:['test'],billingModes:['live'],currency:'USD'}}),e));assert.equal(zero.summary.currencies[0].metrics.directCosts.total,null);assert.equal(zero.summary.coverage.status,'unknown');
    });
    await run('approved denominator and explicit complete-zero source require pinned host evidence',async()=>{
      const next=scope();let evidence;
      const productEvidence={resolveSnapshot:async(q,asOf)=>{const content={version:'1.0.0',queryContentHash:reporting.reportingEvidenceQueryHash(q,asOf),scope:next,period:q.period,asOf,denominators:[{kind:'design',status:'complete',count:'0',approvalReference:{id:'synthetic-approved-designs',revision:1,contentHash:hash('no-approved-designs')}}],sourceCoverage:['expense','revenue','cash'].map(source=>({currency:'USD',source,status:'complete',expected:0}))};evidence={...content,reference:{id:'synthetic-product-source',revision:1,contentHash:hash(content)}};return evidence;}};
      const {ports:p}=makePorts(pool,next,clock,{productEvidence});const q0=query(next,{filters:{environments:['test'],billingModes:['live'],currency:'USD'}});const page=await checked(root.querySummary(q0,p));assert.equal(page.summary.currencies[0].metrics.directCosts.total,'0');assert.equal(page.summary.currencies[0].metrics.cashReceipts.total,'0');assert.equal(page.summary.unitCosts.find(row=>row.kind==='design').status,'zero_denominator');assert.equal(page.summary.unitCosts.find(row=>row.kind==='workflow').status,'unknown');
      const wrong={...p,reporting:{...p.reporting,productEvidence:{resolveSnapshot:async()=>({...evidence,scope:{...next,projectId:randomUUID()}})}}};assert.equal((await root.querySummary(q0,wrong)).ok,false);
    });
    await run('explicit proposed Product Context2 READ/EXPORT policy checks current source proof and grants no commands',async()=>{
      const next={...scope(),actorId:'account:ci08-fixture'};const {ports:p,state:ps}=makePorts(pool,next,clock);await checked(root.appendLedgerEvent(appendRequest(next,'host-policy'),p));
      const ctx={schema:'ticketstub.context/2',issuer:'getticketstub.com',audience:'ticketstub.finance',actor:{kind:'account',id:next.actorId},tenant:{id:next.actorId},project:{id:next.projectId,kind:'event',ref:`event:${next.projectId}`},role:'viewer',capabilities:['finance.read'],membershipRevision:7,revoked:false,environment:'preview',economicMode:'paid_test',evidenceMode:'synthetic',issuedAt:'2026-10-12T22:00:00.000Z',expiresAt:'2026-10-12T22:05:00.000Z'};
      const state={revoked:false,sessionLive:true,projectMember:true,revision:7,override:{},revokeDuringMapping:false};
      const config={clock:p.clock,audience:'ticketstub.finance',approval:{mode:'synthetic_fixture',fixtureId:'ci08-explicit-host-policy'},modeMappings:[{environment:'preview',economicMode:'paid_test',evidenceMode:'synthetic',financeEnvironment:'test',financeBillingMode:'live'}],
        verifier:{verifyCurrent:async()=>({context:{...structuredClone(ctx),...structuredClone(state.override)},checkedAt:clock.value,currentMembershipRevision:state.revision,sessionLive:state.sessionLive,projectMember:state.projectMember,revoked:state.revoked})},
        scopeMapping:{resolveCurrent:async()=>{if(state.revokeDuringMapping)state.revoked=true;return {mappingVersion:reporting.FINANCE_HOST_ACTION_MAPPING_VERSION,sourceTenantId:ctx.tenant.id,sourceProjectRef:ctx.project.ref,scope:next,verifiedAt:clock.value,expiresAt:new Date(Date.parse(clock.value)+60000).toISOString(),mappingReference:{id:'synthetic-independent-ledger-scope-map',revision:1,contentHash:hash({sourceTenant:ctx.tenant.id,scope:next})}};}}};
      const adapter=reporting.createFinanceReadExportAuthority(config);const host={...p,financeAuthority:adapter};const qh=query(next);assert.equal((await root.querySummary(qh,host)).ok,true);
      const ask=(operation,permission)=>adapter.authorizeCurrent({operation,permission,requestedScope:next,requestId:'host-policy-test'});
      assert.equal((await ask('integrations.exportSummary','finance.summary.export')).status,'denied');assert.equal((await ask('budgets.authorize','budget.reservation.authorize')).status,'denied');assert.equal((await ask('reporting.querySummary','finance.summary.export')).status,'denied');
      for(const override of [{audience:'wrong.host'},{actor:{kind:'account',id:'account:foreign'},tenant:{id:'account:foreign'}},{project:undefined,role:'staff',capabilities:['finance.read','finance.export']},{environment:'live',economicMode:'paid_test'},{evidenceMode:'live'},{actor:{kind:'guest',id:'guest:fixture'},tenant:{id:'guest:fixture'}}]){state.override=override;assert.equal((await root.querySummary(qh,host)).ok,false);}state.override={};
      for(const field of ['revoked','sessionLive','projectMember']){const before=state[field];state[field]=field==='revoked'?true:false;assert.equal((await root.querySummary(qh,host)).ok,false);state[field]=before;}
      state.revision=8;assert.equal((await root.querySummary(qh,host)).ok,false);state.revision=7;
      state.revokeDuringMapping=true;const reads=ps.readCount;assert.equal((await root.querySummary(qh,host)).ok,false);assert.equal(ps.readCount,reads);state.revokeDuringMapping=false;state.revoked=false;
      state.override={capabilities:['finance.export']};assert.equal((await ask('integrations.exportSummary','finance.summary.export')).status,'allowed');assert.equal((await root.querySummary(qh,host)).ok,false);state.override={};
      assert.equal((await root.querySummary({...qh,scope:{...next,projectId:randomUUID()}},host)).ok,false);assert.equal((await root.querySummary({...qh,scope:{...next,billingMode:'sandbox'},filters:{environments:['test'],billingModes:['sandbox']}},host)).ok,false);
    });
    await run('budget limits, atomic competing holds and ambiguous dispatched expense stay separate from ledger cost',async()=>{
      const next=scope();await setBudgetLimit(pool,next,'1');const reserve=await loadReserveFixture();const bp=budgetPorts(pool,next);
      const results=await Promise.all([root.authorizeReservation(reservationRequest(next,reserve,{amount:'0.75'}),bp),root.authorizeReservation(reservationRequest(next,reserve,{amount:'0.75'}),bp)]);assert.equal(results.filter(result=>result.ok&&result.value.status==='authorized').length,1);assert.equal(results.filter(result=>result.ok&&result.value.status==='denied').length,1);
      const authorized=results.find(result=>result.ok&&result.value.status==='authorized').value;
      await checked(root.markReservationDispatched(markDispatchedCommand(next,authorized.reservationId,1,{attemptBinding:authorized.attemptBinding}),bp));
      const {ports:p}=makePorts(pool,next,clock);const page=await checked(root.querySummary(query(next,{filters:{environments:['test'],billingModes:['live'],currency:'USD'}}),p));await writeFile(new URL('../../artifacts/reporting/producer-budget-v2-page.json',import.meta.url),JSON.stringify(page,null,2)+'\n');const budget=page.summary.budgets[0];assert.equal(budget.limit,'1');assert.equal(budget.held,'0.75');assert.equal(budget.lifecycleConsumed,'0');assert.equal(budget.ledgerExpense,'0');assert.equal(budget.remainingAuthorizedCapacity,'0.25');assert.equal(page.summary.currencies[0].metrics.expense.total,null);assert.equal(page.detailCount,0);
      const capacity=await checked(root.readCapacity(next,'USD','synthetic-capacity-read',bp));assert.equal(capacity.outstandingHolds,budget.held);assert.equal(capacity.availableCapacity,budget.remainingAuthorizedCapacity);
    });
    await run('accepted unposted unknown usage and duplicate observations remain visible without manufactured charges',async()=>{
      const next=scope();const {ports:p}=makePorts(pool,next,clock);const observation=JSON.parse(await readFile(new URL('../../fixtures/metering/usage-observation.request.json',import.meta.url),'utf8'));
      observation.scope=next;observation.requestId='ci08-intake-unknown';observation.idempotencyKey='ci08-intake-unknown';
      observation.usageEvent.tenant_id=next.tenantId;observation.usageEvent.project_id=next.projectId;observation.usageEvent.environment=next.environment;observation.usageEvent.billing_mode=next.billingMode;
      observation.usageEvent.event_id=randomUUID();observation.usageEvent.source_observation_id=randomUUID();observation.usageEvent.completeness='unknown';observation.usageEvent.usage_units=null;observation.usageEvent.missing_fields=['all'];observation.usageEvent.valuation={basis:'unknown',money:null,rate_card_ref:null};
      const receipt=await checked(root.ingestUsage(observation,p));assert.equal(receipt.outboxStatus,'awaiting_evidence');assert.equal((await checked(root.ingestUsage(observation,p))).status,'duplicate');
      const page=await checked(root.querySummary(query(next,{filters:{environments:['test'],billingModes:['live'],currency:'USD'}}),p));assert.equal(page.detailCount,0);assert.equal(page.summary.coverage.unpostedAttemptCount,1);assert.equal(page.summary.coverage.awaitingEvidenceAttemptCount,1);assert.equal(page.summary.currencies[0].metrics.directCosts.total,null);
    });
    await run('exact cost per approved design preserves rational numerator and denominator without division rounding',async()=>{
      const next=scope();const productEvidence={resolveSnapshot:async(q,asOf)=>{const content={version:'1.0.0',queryContentHash:reporting.reportingEvidenceQueryHash(q,asOf),scope:next,period:q.period,asOf,denominators:[{kind:'design',status:'complete',count:'3',approvalReference:{id:'synthetic-three-approvals',revision:1,contentHash:hash('three-approved-designs')}}],sourceCoverage:[{currency:'USD',source:'expense',status:'complete',expected:1}]};return {...content,reference:{id:'synthetic-product-snapshot',revision:1,contentHash:hash(content)}};}};
      const {ports:p}=makePorts(pool,next,clock,{productEvidence});await checked(root.appendLedgerEvent(appendRequest(next,'approved-research',{amount:'1.000000000000000001'}),p));const page=await checked(root.querySummary(query(next),p));const ratio=page.summary.unitCosts.find(row=>row.kind==='design');assert.equal(ratio.status,'known');assert.equal(ratio.numerator,'1.000000000000000001');assert.equal(ratio.denominator,'3');assert.equal(page.summary.currencies[0].metrics.cashReceipts.status,'unknown');
    });
    await run('shared research is posted once and analytical allocation conserves an explicit residual',async()=>{
      const next=scope();const {ports:p}=makePorts(pool,next,clock);const request=appendRequest(next,'shared');await checked(root.appendLedgerEvent(request,p));const allocation=allocateSharedExpense('1','USD',2,[{key:'design-a',weight:1},{key:'design-b',weight:1},{key:'design-c',weight:1}]);
      const c=await pool.connect();try{await c.query('BEGIN');await c.query(`SELECT set_config('cost_intelligence.tenant_id',$1,true),set_config('cost_intelligence.project_id',$2,true),set_config('cost_intelligence.environment',$3,true),set_config('cost_intelligence.billing_mode',$4,true)`,[next.tenantId,next.projectId,next.environment,next.billingMode]);await c.query(`INSERT INTO cost_intelligence.accounting_allocation_policies(allocation_id,tenant_id,project_id,environment,billing_mode,policy_version,source_event_id,currency,amount_scale,source_amount,allocated_total,residual,allocations,content_hash,recorded_at) VALUES ($1,$2,$3,$4,$5,$6,$7,'USD',2,'1','0.99','0.01',$8,$9,$10)`,['synthetic-allocation-'+randomUUID(),next.tenantId,next.projectId,next.environment,next.billingMode,ACCOUNTING_ALLOCATION_POLICY_VERSION,request.eventId,JSON.stringify(allocation.allocations),hash(allocation),clock.value]);await c.query('COMMIT');}finally{c.release();}
      const page=await checked(root.querySummary(query(next),p));assert.equal(page.detailCount,1);assert.equal(page.summary.currencies[0].metrics.directCosts.knownSubtotal,'1');assert.equal(page.summary.allocations.length,1);assert.equal(page.summary.allocations[0].residual,'0.01');assert.deepEqual(page.summary.allocations[0].allocations.map(row=>row.amount),['0.33','0.33','0.33']);
    });
    await run('Integration Evals exact CI06 economic inputs project through immutable ledger and public query',async()=>{
      const golden=JSON.parse(await readFile(new URL('../../fixtures/accounting/ci06-golden-events.json',import.meta.url),'utf8'));const next=scope();const simulated={...scope(),billingMode:'simulated'};const {ports:p}=makePorts(pool,next,clock);const {ports:sp}=makePorts(pool,simulated,clock);
      const map={sale:['revenue','sale'],discount:['discount','discount'],refund:['refund','sale_refund'],tax:['tax','pass_through_tax'],fee:['fee','direct_cost'],credit:['credit','supplier_credit'],direct_cost:['expense','direct_cost'],reimbursement:['reimbursement','reimbursement'],payout:['cash_movement','payout_transfer'],cash_movement:['cash_movement','operating_revenue']};
      for(const event of golden.events){const [eventType,classification]=map[event.classification];const target=event.recognition==='simulated'?simulated:next;const ports=event.recognition==='simulated'?sp:p;await checked(root.appendLedgerEvent(appendRequest(target,event.eventId,{eventType,classification,amount:event.amount,currency:event.currency,dimensions:event.dimensions??{}}),ports));}
      const page=await checked(root.querySummary(query(next),p));const metrics=page.summary.currencies[0].metrics;for(const key of ['grossSales','netSales','directCosts','contribution'])assert.equal(parse(metrics[key].knownSubtotal),parse(golden.expected[key]),key);assert.equal(parse(metrics.cashReceipts.knownSubtotal),parse(golden.expected.cash.receipts));assert.equal(parse(metrics.cashPayouts.knownSubtotal),parse(golden.expected.cash.payouts));
      const sim=await checked(root.querySummary(query(simulated),sp));assert.equal(parse(sim.summary.currencies[0].simulated.grossSales.knownSubtotal),parse(golden.expected.simulated.grossSales));
      await writeFile(new URL('../../artifacts/reporting/ie-ci06-pg-page.json',import.meta.url),JSON.stringify(page,null,2)+'\n');
    });
    await run('total expense and attributed direct cost use separate explicit definitions',async()=>{
      const next=scope();const {ports:p}=makePorts(pool,next,clock);await checked(root.appendLedgerEvent(appendRequest(next,'attributed',{amount:'1'}),p));await checked(root.appendLedgerEvent(appendRequest(next,'operating',{amount:'5',classification:'operating_expense'}),p));const page=await checked(root.querySummary(query(next),p));const usd=page.summary.currencies[0];assert.equal(usd.metrics.expense.knownSubtotal,'6');assert.equal(usd.metrics.directCosts.knownSubtotal,'1');assert.equal(usd.metrics.contribution.knownSubtotal,'-1');assert.equal(page.canonicalSummaries[0].metrics.expense.status,'unknown');
    });
    await run('cash operating settlement and payout transfers exclude recognized expense and capacity cost',async()=>{
      for(const cash of [{classification:'operating_expense',amount:'-5'},{classification:'payout_transfer',amount:'5'}]){
        const next=scope();const {ports:p}=makePorts(pool,next,clock);await setBudgetLimit(pool,next,'10');
        await checked(root.appendLedgerEvent(appendRequest(next,'recognized',{amount:'1'}),p));await checked(root.appendLedgerEvent(appendRequest(next,'cash-payment',{eventType:'cash_movement',...cash}),p));
        const page=await checked(root.querySummaryV2(query(next),p));const row=page.summary.currencies[0];assert.equal(row.metrics.expense.knownSubtotal,'1');assert.equal(row.metrics.directCosts.knownSubtotal,'1');assert.equal(row.metrics.cashPayouts.knownSubtotal,'5');assert.equal(page.summary.budgets[0].ledgerExpense,'1');assert.equal(page.summary.budgets[0].remainingAuthorizedCapacity,'9');
        const details=await allDetails(page,query(next),p);assert.equal(details.find(row=>row.eventType==='cash_movement').metrics.expense,'0');
      }
    });
    await run('simulated unknown cost retains unknown totals and separates known subtotals from complete zero',async()=>{
      const next={...scope(),billingMode:'simulated'};const {ports:p}=makePorts(pool,next,clock);const qs=query(next);
      await checked(root.appendLedgerEvent(appendRequest(next,'unknown-sim',{amount:null}),p));let page=await checked(root.querySummaryV2(qs,p));let sim=page.summary.currencies[0].simulated;
      assert.deepEqual(sim.expense,{status:'unknown',knownSubtotal:null,total:null,unknownCount:1});assert.equal(page.summary.currencies[0].metrics.expense.total,null);
      await checked(root.appendLedgerEvent(appendRequest(next,'known-sim',{amount:'5'}),p));page=await checked(root.querySummaryV2(qs,p));sim=page.summary.currencies[0].simulated;
      assert.deepEqual(sim.expense,{status:'partial',knownSubtotal:'5',total:null,unknownCount:1});assert.equal(page.summary.budgets[0].ledgerExpense,'0');
      await writeFile(new URL('../../artifacts/reporting/producer-unknown-simulated-v2-page.json',import.meta.url),JSON.stringify(page,null,2)+'\n');
      const empty={...scope(),billingMode:'simulated'};const productEvidence={resolveSnapshot:async(q,asOf)=>{const content={version:'1.0.0',queryContentHash:reporting.reportingEvidenceQueryHash(q,asOf),scope:empty,period:q.period,asOf,denominators:[],sourceCoverage:['expense','revenue','cash'].map(source=>({currency:'USD',source,status:'complete',expected:0}))};return {...content,reference:{id:'synthetic-complete-zero-simulation',revision:1,contentHash:hash(content)}};}};
      const {ports:z}=makePorts(pool,empty,clock,{productEvidence});const zero=await checked(root.querySummaryV2(query(empty,{filters:{environments:['test'],billingModes:['simulated'],currency:'USD'}}),z));assert.deepEqual(zero.summary.currencies[0].simulated.expense,{status:'known',knownSubtotal:'0',total:'0',unknownCount:0});assert.equal(zero.summary.currencies[0].metrics.expense.total,null);
    });
    await run('cash receipt correction inherits database economic type and preserves original as-of snapshot',async()=>{
      const next=scope();const localClock={value:clock.value};const {ports:p}=makePorts(pool,next,localClock);const qs=query(next);
      const original=appendRequest(next,'cash-original',{eventType:'cash_movement',classification:'operating_revenue',amount:'5'});await checked(root.appendLedgerEvent(original,p));const before=await checked(root.querySummaryV2(qs,p));assert.equal(before.summary.currencies[0].metrics.cashReceipts.knownSubtotal,'5');
      localClock.value='2026-10-12T22:01:00.000Z';await checked(root.appendLedgerEvent(appendRequest(next,'cash-corrected',{eventType:'correction',classification:'operating_revenue',amount:'7',subject:'cash-original',supersedes:original.eventId,revision:1}),p));
      const latest=await checked(root.querySummaryV2(qs,p));assert.equal(latest.detailCount,1);assert.equal(latest.summary.currencies[0].metrics.cashReceipts.knownSubtotal,'7');assert.equal(latest.summary.coverage.unsupportedEventCount,0);assert.equal(latest.details[0].eventType,'cash_movement');assert.equal(latest.summary.budgets[0].ledgerExpense,'0');
      const frozen=await checked(root.querySummaryV2({...qs,snapshotId:before.snapshotId},p));assert.equal(frozen.summary.currencies[0].metrics.cashReceipts.knownSubtotal,'5');
      const historic=await checked(root.querySummaryV2({...qs,requestedAsOf:before.asOf},p));assert.equal(historic.summaryContentHash,before.summaryContentHash);
      const broken={...p,reporting:{...p.reporting,database:{connect:async()=>{const c=await pool.connect();return {release:()=>c.release(),query:async(sql,values)=>{const result=await c.query(sql,values);if(sql.includes('AS lineage_valid'))result.rows=result.rows.map(row=>({...row,lineage_valid:false}));return result;}};}}}};
      assert.equal((await root.querySummaryV2(qs,broken)).ok,false);
    });
    await run('cash receipt and payout correction reversal and reversal-of-reversal retain original signed axis',async()=>{
      for(const [classification,initial,corrected,reverse,restore,axis,expected] of [['operating_revenue','5','7','-2','1','cashReceipts','6'],['operating_expense','-5','-7','2','-1','cashPayouts','6'],['payout_transfer','5','7','-2','1','cashPayouts','6']]){
        const next=scope();const {ports:p}=makePorts(pool,next,clock);const qs=query(next);const original=appendRequest(next,'cash',{eventType:'cash_movement',classification,amount:initial});await checked(root.appendLedgerEvent(original,p));
        const correction=appendRequest(next,'corrected',{eventType:'correction',classification,amount:corrected,subject:'cash',supersedes:original.eventId,revision:1});await checked(root.appendLedgerEvent(correction,p));
        const reversal=appendRequest(next,'reversal',{eventType:'reversal',classification,amount:reverse,subject:'cash',reverses:correction.eventId});reversal.sourceIdentity.sourceObjectId+='-reverse';reversal.sourceIdentity.revisionSubjectId+='-reverse';reversal.postingMapping.sourceLineId=reversal.sourceIdentity.revisionSubjectId;assert.equal(root.validateLedgerAppendRequestBoundary(reversal).ok,true);await checked(root.appendLedgerEvent(reversal,p));
        const second=appendRequest(next,'restored',{eventType:'reversal',classification,amount:restore,subject:'cash',reverses:reversal.eventId});second.sourceIdentity.sourceObjectId+='-restore';second.sourceIdentity.revisionSubjectId+='-restore';second.postingMapping.sourceLineId=second.sourceIdentity.revisionSubjectId;assert.equal(root.validateLedgerAppendRequestBoundary(second).ok,true);await checked(root.appendLedgerEvent(second,p));
        const page=await checked(root.querySummaryV2(qs,p));assert.equal(page.detailCount,3);assert.equal(page.summary.currencies[0].metrics[axis].knownSubtotal,expected);assert.equal(page.summary.currencies[0].metrics[axis==='cashReceipts'?'cashPayouts':'cashReceipts'].knownSubtotal,'0');assert.equal(page.summary.budgets[0].ledgerExpense,'0');assert.equal(page.summary.coverage.unsupportedEventCount,0);
        const details=await allDetails(page,qs,p);assert.equal(details.reduce((n,row)=>n+parse(row.metrics[axis]),0n),parse(expected));assert.equal(details.every(row=>row.eventType==='cash_movement'),true);
        for(const mutate of [chain=>{chain[chain.length-1].scope.projectId=randomUUID();},chain=>{chain.pop();},chain=>{chain[0].cycle=true;},chain=>{chain[0].depth=33;}]){
          const malformed={...p,reporting:{...p.reporting,database:{connect:async()=>{const c=await pool.connect();return {release:()=>c.release(),query:async(sql,values)=>{const result=await c.query(sql,values);if(sql.includes('AS lineage_valid')){for(const row of result.rows)if(row.economic_lineage.length>1)mutate(row.economic_lineage);}return result;}};}}}};assert.equal((await root.querySummaryV2(qs,malformed)).ok,false);
        }
      }
    });
    await run('returned definition and policy references cannot mutate independent registry or later query results',async()=>{
      const registry=structuredClone(reporting.REPORTING_CANONICAL_REFERENCE_REGISTRY);const beforeHash=hash(registry);const next=scope();const {ports:p}=makePorts(pool,next,clock);await checked(root.appendLedgerEvent(appendRequest(next,'registry-control'),p));const qs=query(next);const firstPage=await checked(root.querySummaryV2(qs,p));
      assert.notEqual(firstPage.canonicalSummaries[0].metrics.expense.definition_ref,reporting.REPORTING_CANONICAL_REFERENCE_REGISTRY.metrics.expense.reference);
      firstPage.canonicalSummaries[0].metrics.expense.definition_ref.content_hash='sha256:'+'f'.repeat(64);firstPage.canonicalSummaries[0].policy_ref.id=randomUUID();
      assert.throws(()=>{reporting.REPORTING_CANONICAL_REFERENCE_REGISTRY.metrics.expense.reference.content_hash='sha256:'+'e'.repeat(64);},TypeError);assert.throws(()=>{reporting.REPORTING_METRIC_DICTIONARY.expense.formula='poisoned';},TypeError);
      assert.equal(hash(reporting.REPORTING_CANONICAL_REFERENCE_REGISTRY),beforeHash);const again=await checked(root.querySummaryV2(qs,p));assert.deepEqual(again.canonicalSummaries[0].metrics.expense.definition_ref,registry.metrics.expense.reference);assert.deepEqual(again.canonicalSummaries[0].policy_ref,registry.policy.reference);
    });
    await run('simulated sales stay isolated while paid-test live-mode expense remains actual',async()=>{
      const next={...scope(),billingMode:'simulated'};const {ports:p}=makePorts(pool,next,clock);await checked(root.appendLedgerEvent(appendRequest(next,'sandbox-sale',{eventType:'revenue',classification:'sale',amount:'20'}),p));const page=await checked(root.querySummary(query(next),p));assert.equal(page.summary.currencies[0].simulated.grossSales.knownSubtotal,'20');assert.equal(page.summary.currencies[0].metrics.grossSales.total,null);assert.equal(page.details[0].metrics.grossSales,'0');
    });
  }catch(error){failures.push({name:'fixture-setup',message:error.message,stack:error.stack});throw error;}finally{await mkdir(new URL('../../artifacts/reporting/',import.meta.url),{recursive:true});await writeFile(new URL(`../../artifacts/reporting/failures-${process.pid}.json`,import.meta.url),JSON.stringify(failures,null,2));await pool.end();await admin.end();}
});
