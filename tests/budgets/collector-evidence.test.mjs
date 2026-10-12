import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createAuthenticatedBudgetSourceResolver,budgetCollectorSigningBytes,budgetSourceBytesHash,budgetDigest} from '../../dist/budgets/index.js';
import * as publicBudget from '../../dist/budgets/index.js';

async function fixture(){
  let now=Date.parse('2026-10-12T12:00:00Z');const clock={now:()=>new Date(now)};
  const keys=await crypto.subtle.generateKey('Ed25519',true,['sign','verify']);
  const key={publicKeySpkiBase64:Buffer.from(await crypto.subtle.exportKey('spki',keys.publicKey)).toString('base64'),revoked:false,allowedKinds:['reported_cost','execution_finality','pricing_profile','maximum_policy','aggregate_usage'],validFrom:'2026-10-12T11:00:00Z',validUntil:'2026-10-12T13:00:00Z'};
  const scope={tenantId:randomUUID(),projectId:randomUUID(),environment:'test',billingMode:'simulated',actorId:'synthetic-collector'};
  const attempt={logicalOperationId:randomUUID(),providerAttemptId:randomUUID(),billableAttemptId:randomUUID(),transportAttemptId:randomUUID(),providerRequestId:null};
  const sourceBytes='{"usage":{"cost":"0.25"},"fixture":"synthetic-only"}';
  const record={version:'ci-budget-source-1.0.0',issuerKeyId:'fixture-collector',id:randomUUID(),revision:1,predecessorHash:null,scope,authorityBinding:null,evidenceMode:'mocked',provider:'openrouter',model:'synthetic-model',operation:'generate',targetBindingSha256:`sha256:${'a'.repeat(64)}`,attempt,kind:'reported_cost',sourceFormat:'synthetic_fixture',sourceBytesSha256:await budgetSourceBytesHash(sourceBytes),observedAt:clock.now().toISOString(),payload:{money:{amount:'0.25',currency:'USD',scale:2}}};
  const recordHash=await budgetDigest(record);const {actorId,...financialScope}=scope;
  const current={version:record.version,issuerKeyId:record.issuerKeyId,recordId:record.id,revision:1,recordHash,scopeHash:await budgetDigest(financialScope),verifiedAt:clock.now().toISOString(),expiresAt:new Date(now+30000).toISOString(),revoked:false};
  const sign=async(kind,value)=>Buffer.from(await crypto.subtle.sign('Ed25519',keys.privateKey,budgetCollectorSigningBytes(kind,value))).toString('base64');
  let envelope={record,current,sourceBytes,recordSignature:await sign('record',record),currentSignature:await sign('current',current)};
  const ref={contract:'ci-budget-source',schema_version:'1.0.0',id:record.id,revision:1,content_hash:recordHash};
  const query={scope,reference:ref,kind:'reported_cost',provider:record.provider,model:record.model,operation:record.operation,targetBindingSha256:record.targetBindingSha256,attempt};
  const backend={loadCurrent:async()=>structuredClone(envelope),loadCurrentIssuerKey:async id=>id==='fixture-collector'?structuredClone(key):null};
  return {clock,key,query,backend,sign,setTime:v=>{now=v;},get envelope(){return envelope;},set envelope(v){envelope=v;},resolver:createAuthenticatedBudgetSourceResolver(backend,clock)};
}
test('owner collector signatures authenticate current original bytes and exact financial scope/attempt without caller keys',async()=>{
  const f=await fixture();const result=await f.resolver.resolveCurrent(f.query);assert.equal(result.record.payload.money.amount,'0.25');assert.equal(result.record.attempt.providerRequestId,null);assert.equal(result.sourceBytes,f.envelope.sourceBytes);
  for(const field of ['tenantId','projectId','environment','billingMode']){const scope={...f.query.scope,[field]:field==='environment'?'production':field==='billingMode'?'live':randomUUID()};assert.equal(await f.resolver.resolveCurrent({...f.query,scope}),null);}
  for(const field of ['logicalOperationId','providerAttemptId','billableAttemptId','transportAttemptId','providerRequestId'])assert.equal(await f.resolver.resolveCurrent({...f.query,attempt:{...f.query.attempt,[field]:randomUUID()}}),null);
  for(const field of ['provider','model','operation','targetBindingSha256'])assert.equal(await f.resolver.resolveCurrent({...f.query,[field]:'foreign'}),null);
});
test('coordinated caller forgery cannot replace signed amount/ref/current context or original bytes',async()=>{
  const f=await fixture();const original=structuredClone(f.envelope);
  const forged=structuredClone(original);forged.record.payload.money.amount='0';forged.current.recordHash=await budgetDigest(forged.record);f.envelope=forged;
  assert.equal(await f.resolver.resolveCurrent({...f.query,reference:{...f.query.reference,content_hash:forged.current.recordHash}}),null);
  f.envelope={...original,sourceBytes:'{"usage":{"cost":"0"}}'};assert.equal(await f.resolver.resolveCurrent(f.query),null);
  f.envelope={...original,record:{...original.record,issuerKeyId:'caller-key'}};assert.equal(await f.resolver.resolveCurrent(f.query),null);
  f.envelope=original;f.key.revoked=true;assert.equal(await f.resolver.resolveCurrent(f.query),null);
});
test('current record revocation and expiry after issuer awaits refuse without turning unknown into zero',async()=>{
  const f=await fixture();f.envelope.current.revoked=true;f.envelope.currentSignature=await f.sign('current',f.envelope.current);assert.equal(await f.resolver.resolveCurrent(f.query),null);
  f.envelope.current.revoked=false;f.envelope.currentSignature=await f.sign('current',f.envelope.current);
  const original=f.backend.loadCurrentIssuerKey;f.backend.loadCurrentIssuerKey=async id=>{const key=await original(id);f.setTime(Date.parse(f.envelope.current.expiresAt)+1);return key;};assert.equal(await f.resolver.resolveCurrent(f.query),null);
});
test('owner revocation during key resolution invalidates the earlier signed current head',async()=>{
  const f=await fixture();const original=f.backend.loadCurrentIssuerKey;let calls=0;
  f.backend.loadCurrentIssuerKey=async id=>{const key=await original(id);if(++calls===1){f.envelope.current.revoked=true;f.envelope.currentSignature=await f.sign('current',f.envelope.current);}return key;};
  assert.equal(await f.resolver.resolveCurrent(f.query),null);
});
test('public recovery/reconciliation boundaries deny current Finance permission before unconfigured domain and validate malformed requests first',async()=>{
 const scope={tenantId:randomUUID(),projectId:randomUUID(),environment:'test',billingMode:'simulated',actorId:'synthetic-recovery-owner'};
 const ref={contract:'ci-budget-source',schema_version:'1.0.0',id:randomUUID(),revision:1,content_hash:`sha256:${'a'.repeat(64)}`};
 const attemptBinding={logicalOperationId:randomUUID(),transportAttemptId:randomUUID(),providerAttemptId:randomUUID(),billableAttemptId:randomUUID(),providerRequestId:null};
 const base={schemaVersion:'1.0.0',requestId:randomUUID(),idempotencyKey:randomUUID(),scope};
 const expiry={...base,reservationId:randomUUID(),expectedRevision:2,actorReference:scope.actorId,sourceAuthorityRef:ref,attemptBinding,reasonReference:'review-expired-unresolved'};
 const cases=[
  [publicBudget.expireAuthorization,expiry,'budgets.release'],
  [publicBudget.recoverReservations,{...base,currency:'USD',jobReference:'recovery-fixture',expectedCursorRevision:0,pageSize:1,ownerReference:scope.actorId,actionReference:'inspect-current-evidence'},'reconciliation.startReconciliation'],
  [publicBudget.acknowledgeException,{...base,currency:'USD',exceptionId:'synthetic-exception',expectedRevision:1,action:'hold',ownerReference:scope.actorId,actionReference:'inspect-current-evidence',evidenceReference:null},'reconciliation.startReconciliation'],
  [publicBudget.getExceptions,{schemaVersion:'1.0.0',requestId:randomUUID(),scope,currency:'USD',pageSize:1,afterExceptionId:null,includeResolved:false},'reconciliation.getReconciliation'],
  [publicBudget.reconcileEvidence,{...base,reservationId:expiry.reservationId,expectedRevision:2,actorReference:scope.actorId,sourceAuthorityRef:ref,attemptBinding,ownerReference:scope.actorId,actionReference:'inspect-current-evidence',finalityReference:null},'reconciliation.startReconciliation'],
 ];
 for(const [operation,request,expectedOperation] of cases){
  let authorizations=0;const ports={clock:{now:()=>new Date('2026-10-12T12:00:00Z')},trustedContext:{resolve:async()=>scope},financeAuthority:{authorizeCurrent:async query=>{
   authorizations++;assert.equal(query.operation,expectedOperation);return {status:'denied',decisionId:'synthetic-current-denial',operation:query.operation,permission:query.permission};
  }}};
  const denied=await operation(request,ports);assert.equal(denied.ok,false);assert.equal(denied.error.code,'FORBIDDEN_SCOPE');assert.equal(authorizations,1);
  const invalid=await operation({...request,schemaVersion:'invalid'},ports);assert.equal(invalid.ok,false);assert.equal(invalid.error.code,'UNSUPPORTED_VERSION');assert.equal(authorizations,1);
 }
});
test('root and reconciliation subpath version2 require current exact grants and refuse caller snapshot authority before discovery',async()=>{
 const root=await import('../../dist/index.js'),module=await import('../../dist/reconciliation/index.js');
 assert.equal(root.BudgetReconciliationRequestSchema,module.BudgetReconciliationRequestSchema);assert.equal(root.BudgetReconciliationQuerySchema,module.BudgetReconciliationQuerySchema);
 const scope={tenantId:randomUUID(),projectId:randomUUID(),environment:'production',billingMode:'simulated',actorId:'synthetic-reconciliation-owner'};
 const start={schemaVersion:'2.0.0',requestId:randomUUID(),idempotencyKey:randomUUID(),scope,currency:'USD',jobReference:'synthetic-run',expectedCursorRevision:0,pageSize:1,ownerReference:scope.actorId,actionReference:'collect-independent-source'};
 const query={schemaVersion:'2.0.0',requestId:randomUUID(),scope,runId:`sha256:${'a'.repeat(64)}`};
 let calls=0,connects=0;const ports={clock:{now:()=>new Date('2026-10-12T12:00:00Z')},trustedContext:{resolve:async()=>scope},
  budgets:{database:{connect:async()=>{connects++;throw new Error('domain should not open');}}},financeAuthority:{authorizeCurrent:async request=>{
   calls++;return {status:'denied',decisionId:'synthetic-current-denial',operation:request.operation,permission:request.permission};
  }}};
 for(const [operation,request] of [[root.startReconciliation,start],[root.getReconciliation,query]]){
  const refused=await operation(request,ports);assert.equal(refused.ok,false);assert.equal(refused.error.code,'FORBIDDEN_SCOPE');
 }
 assert.equal(calls,2);assert.equal(connects,0);
 const fakeSnapshots=await root.startReconciliation({...start,sourceSnapshots:[{name:'caller-final-cost',revision:'1',contentHash:`sha256:${'0'.repeat(64)}`,evidenceMode:'live',verificationStatus:'verified'}]},ports);
 assert.equal(fakeSnapshots.ok,false);assert.equal(fakeSnapshots.error.code,'VALIDATION_ERROR');assert.equal(calls,2);assert.equal(connects,0);
 ports.financeAuthority.authorizeCurrent=async request=>({status:'allowed',decisionId:'synthetic-current-grant',operation:request.operation,permission:request.permission,scope,
  principal:{kind:'service',actorId:scope.actorId,serviceStatus:'active',serviceGrantRevision:'synthetic-1'},verifiedAt:'2026-10-12T12:00:00Z',expiresAt:'2026-10-12T12:01:00Z'});
 const unavailable=await root.startReconciliation(start,ports);assert.equal(unavailable.ok,false);assert.equal(unavailable.error.code,'RECONCILIATION_PENDING');assert.equal(connects,0);
});
