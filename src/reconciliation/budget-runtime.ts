import {Type,type Static} from '@sinclair/typebox';
import {Value} from '@sinclair/typebox/value';
import {authorizeFinanceOperation,errorEnvelope,failure,TrustedScopeSchema,type ApiResult,type RuntimePorts,type FinanceOperation} from '../shared/contracts.js';
import {bindFinancialDatabaseScope} from '../shared/database-scope.js';
import {budgetDigest,normalizedBudgetRequest,BudgetReferenceSchema} from '../budgets/authority.js';
import {BudgetRecoveryRequestSchema,recoverReservationBatch,reconcileReservationEvidence,releaseReservation,expireReservation,readCapacity,
 type BudgetRuntimePorts,type BudgetTransactionPort,type BudgetRecoveryBatch,type ReservationCommandOutcome} from '../budgets/reservation-store.js';
import {resolveExecutionFinality,BudgetExecutionFinalitySchema} from '../budgets/reported-cost.js';
import {requireBudgetSettlementCapability} from '../ledger/store.js';

/** Finance run journal, not a replacement ledger or evidence provided by a caller. */
export const BudgetReconciliationRequestSchema=Type.Object({...BudgetRecoveryRequestSchema.properties,schemaVersion:Type.Literal('2.0.0')},{additionalProperties:false});
export type BudgetReconciliationRequest=Static<typeof BudgetReconciliationRequestSchema>;
export const BudgetReconciliationQuerySchema=Type.Object({schemaVersion:Type.Literal('2.0.0'),requestId:Type.String({minLength:1}),scope:TrustedScopeSchema,
 runId:Type.String({pattern:'^sha256:[a-f0-9]{64}$'})},{additionalProperties:false});
export type BudgetReconciliationQuery=Static<typeof BudgetReconciliationQuerySchema>;
export interface BudgetReconciliationReceipt{
 readonly schemaVersion:'2.0.0';readonly requestId:string;readonly runId:string;readonly status:'running'|'complete'|'needs_review';readonly replay:boolean;
 readonly cursorRevision:number;readonly completedCycle:boolean;readonly scannedCount:number;readonly matchedCount:number;readonly unresolvedCount:number;
 readonly ownerReference:string;readonly actionReference:string;readonly asOf:string;
 readonly unknownExposure:boolean;readonly dispatchEligible:false;
 readonly actions:readonly {reservationId:string;status:'posted'|'released'|'retained_unknown'|'unresolved';revision:number;errorCode:string|null}[];
}
class CycleGate{
 readonly until:number;expired=false;
 constructor(milliseconds:number){this.until=Date.now()+milliseconds;}
 checkpoint(){if(this.expired||Date.now()>=this.until){this.expired=true;throw new Error('reconciliation deadline');}}
 remaining(){this.checkpoint();return Math.max(1,this.until-Date.now());}
 async wait<T>(promise:Promise<T>):Promise<T>{this.checkpoint();let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([promise,new Promise<T>((_,reject)=>{timer=setTimeout(()=>{this.expired=true;reject(new Error('reconciliation deadline'));},this.remaining());})]);}
  finally{if(timer!==undefined)clearTimeout(timer);}
 }
}
/** The caller deadline is independent of pending query/cleanup promises. Cleanup owns its connection until every in-flight query finishes. */
async function runCycle<T>(milliseconds:number,requestId:string,work:(gate:CycleGate)=>Promise<ApiResult<T>>):Promise<ApiResult<T>>{
 const gate=new CycleGate(milliseconds);let timer:ReturnType<typeof setTimeout>|undefined;
 const pending=Promise.resolve().then(()=>work(gate)).catch(()=>unavailable(requestId));
 try{return await Promise.race([pending,new Promise<ApiResult<T>>(resolve=>{
  timer=setTimeout(()=>{gate.expired=true;resolve(unavailable(requestId));},milliseconds);
 })]);}finally{if(timer!==undefined)clearTimeout(timer);}
}
function guardedDatabase(ports:BudgetRuntimePorts,gate:CycleGate):BudgetRuntimePorts['database']{
 return {connect:async()=>{
  const pending=ports.database.connect().then(client=>{if(gate.expired||Date.now()>=gate.until){client.release();throw new Error('late reconciliation connection');}return client;});
  const client=await gate.wait(pending);
  return {release:()=>client.release(),query:async(text,values)=>{
   // Cleanup must remain possible after cancellation. In-flight COMMIT stays an uncertain durable outcome.
   const cleanup=text.trim().toUpperCase()==='ROLLBACK';
   if(!cleanup)gate.checkpoint();const result=await client.query(text,values);if(!cleanup)gate.checkpoint();return result;
  }};
 }};
}
function runtime(ports:RuntimePorts):BudgetRuntimePorts|null{return ports.budgets?{...ports.budgets,clock:ports.clock,trustedContext:ports.trustedContext,
 ...(ports.financeAuthority?{financeAuthority:ports.financeAuthority}:{})}:null;}
type Proof={verifiedAt:string;expiresAt:string};
function current(ports:RuntimePorts,proofs:readonly Proof[]){const now=ports.clock.now().getTime();return Number.isFinite(now)&&proofs.every(proof=>
 Number.isFinite(Date.parse(proof.verifiedAt))&&Date.parse(proof.verifiedAt)<=now&&Number.isFinite(Date.parse(proof.expiresAt))&&Date.parse(proof.expiresAt)>now);}
async function permission(ports:RuntimePorts,request:{scope:BudgetReconciliationRequest['scope'];requestId:string},operation:FinanceOperation,proofs:Proof[],gate:CycleGate){
 const result=await gate.wait(authorizeFinanceOperation({module:'reconciliation',requestOperation:operation==='reconciliation.getReconciliation'?'getReconciliation':'startReconciliation',operation,
  scope:request.scope,requestId:request.requestId,clock:ports.clock,...(ports.financeAuthority?{financeAuthority:ports.financeAuthority}:{})}));gate.checkpoint();
 if(!result.ok)return result;
 if(result.decision.status!=='allowed'||!('principal' in result.decision))throw new Error('missing current reconciliation principal');
 proofs.push(structuredClone(result.decision));if(!current(ports,proofs))throw new Error('expired reconciliation permission');return result;
}
function unavailable(requestId:string){return failure(errorEnvelope('reconciliation','startReconciliation','RECONCILIATION_PENDING',requestId,
 'Current source reconciliation is incomplete; retry the identical request. Every committed financial effect remains durable.',true));}
async function journal(client:BudgetTransactionPort,scope:BudgetReconciliationRequest['scope'],key:string){return client.query(`SELECT command_request,command_receipt FROM cost_intelligence.budget_recovery_cursors
 WHERE tenant_id=$1 AND project_id=$2 AND environment=$3 AND billing_mode=$4 AND idempotency_key=$5`,[scope.tenantId,scope.projectId,scope.environment,scope.billingMode,key]);}
async function begin(client:BudgetTransactionPort,scope:BudgetReconciliationRequest['scope'],gate:CycleGate){
 await client.query('BEGIN');await bindFinancialDatabaseScope(client,scope);
 await client.query("SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout',$1,true)",[`${gate.remaining()}ms`]);
 await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`ci02-ledger:${scope.tenantId}:${scope.projectId}:${scope.environment}:${scope.billingMode}`]);
 await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`ci05a-budget:${scope.tenantId}:${scope.projectId}:${scope.environment}:${scope.billingMode}:USD`]);
 const privacy=await client.query(`SELECT 1 FROM cost_intelligence.financial_privacy_quarantine WHERE tenant_id=$1 AND project_id=$2 AND environment=$3 AND billing_mode=$4 LIMIT 1`,[scope.tenantId,scope.projectId,scope.environment,scope.billingMode]);
 gate.checkpoint();if(privacy.rows.length)throw new Error('restricted financial source');
 await requireBudgetSettlementCapability(client);gate.checkpoint();
}
/** Durable plan precedes lookup/financial commands; completion is a later immutable cursor journal entry. */
export async function startBudgetReconciliation(value:unknown,ports:RuntimePorts):Promise<ApiResult<BudgetReconciliationReceipt>>{
 if(!Value.Check(BudgetReconciliationRequestSchema,value))return failure(errorEnvelope('reconciliation','startReconciliation','VALIDATION_ERROR',String((value as {requestId?:unknown})?.requestId??'unknown'),'The Finance reconciliation request is malformed.'));
 const request=structuredClone(value),engine=runtime(ports),milliseconds=engine?.authorityWaitMs??2000;
 if(!Number.isSafeInteger(milliseconds)||milliseconds<1||milliseconds>60000)return unavailable(request.requestId);
 return runCycle(milliseconds,request.requestId,async gate=>{
 const proofs:Proof[]=[];let client:BudgetTransactionPort|undefined,transaction=false;
 try{
  const granted=await permission(ports,request,'reconciliation.startReconciliation',proofs,gate);if(!granted.ok)return failure(granted.error);
  if(!engine||!engine.sourceCollector?.findAttemptEvidence||!engine.reportedCostContractMode)return unavailable(request.requestId);
  const bounded={...engine,database:guardedDatabase(engine,gate)};
  const {actorId,...financialScope}=request.scope;
  const runId=await budgetDigest({scope:financialScope,idempotencyKey:request.idempotencyKey}),requestDigest=await budgetDigest(normalizedBudgetRequest(request)),completionKey=`ci05b-reconciliation-complete:${runId}`,planKey=`ci05b-reconciliation-plan:${runId}`;
  client=await bounded.database.connect();transaction=true;await begin(client,request.scope,gate);
  const prior=await journal(client,request.scope,completionKey);
  if(prior.rows[0]){
   if(await budgetDigest(prior.rows[0].command_request)!==requestDigest)return failure(errorEnvelope('reconciliation','startReconciliation','IDEMPOTENCY_CONFLICT',request.requestId,'The complete reconciliation request differs.'));
   const fresh=await permission(ports,request,'reconciliation.startReconciliation',proofs,gate);if(!fresh.ok)return failure(fresh.error);
   return {ok:true,value:{...structuredClone(prior.rows[0].command_receipt) as BudgetReconciliationReceipt,requestId:request.requestId,replay:true}};
  }
  await client.query('ROLLBACK');transaction=false;client.release();client=undefined;
  const batch=await gate.wait(recoverReservationBatch({...request,schemaVersion:'1.0.0',idempotencyKey:planKey},bounded));gate.checkpoint();if(!batch.ok)return batch;
  if(batch.value.status==='stale_revision')return failure(errorEnvelope('reconciliation','startReconciliation','VALIDATION_ERROR',request.requestId,'The recovery cursor changed; read its current revision before a new request.'));
  const actions:BudgetReconciliationReceipt['actions'][number][]=(batch.value.unresolvedCandidates??[]).map(candidate=>({reservationId:candidate.reservationId,status:'unresolved',revision:candidate.revision,errorCode:'SOURCE_UNAVAILABLE'}));
  for(const candidate of batch.value.candidates){
   const fresh=await permission(ports,request,'reconciliation.startReconciliation',proofs,gate);if(!fresh.ok)return failure(fresh.error);
   const found=await gate.wait(engine.sourceCollector.findAttemptEvidence({scope:structuredClone(request.scope),attempt:structuredClone(candidate.attemptBinding),authorityBinding:structuredClone(candidate.authorityBinding)}));gate.checkpoint();
   const hints=found===null?null:structuredClone(found);
   const refreshed=await permission(ports,request,'reconciliation.startReconciliation',proofs,gate);if(!refreshed.ok)return failure(refreshed.error);
   if(!hints||!Array.isArray(hints.reportedCostRefs)||hints.reportedCostRefs.length>16||hints.reportedCostRefs.some(ref=>!Value.Check(BudgetReferenceSchema,ref))
    ||hints.finalityRef!==null&&!Value.Check(BudgetReferenceSchema,hints.finalityRef)){actions.push({reservationId:candidate.reservationId,status:'unresolved',revision:candidate.revision,errorCode:'SOURCE_UNAVAILABLE'});continue;}
   let revision=candidate.revision,result:ApiResult<ReservationCommandOutcome>|null=null;
   for(let index=0;index<hints.reportedCostRefs.length;index++){
    const reference=structuredClone(hints.reportedCostRefs[index]!);const key=await budgetDigest({runId,reservationId:candidate.reservationId,reference,kind:'reported_cost'});
    result=await gate.wait(reconcileReservationEvidence({schemaVersion:'1.0.0',requestId:request.requestId,idempotencyKey:key,scope:request.scope,reservationId:candidate.reservationId,expectedRevision:revision,
     actorReference:request.scope.actorId,sourceAuthorityRef:reference,attemptBinding:candidate.attemptBinding,ownerReference:request.ownerReference,actionReference:request.actionReference,
     finalityReference:index===hints.reportedCostRefs.length-1?hints.finalityRef:null},bounded));gate.checkpoint();
    if(!result.ok||result.value.status==='stale_revision'||result.value.status==='conflict')break;revision=result.value.revision;
   }
   if(hints.reportedCostRefs.length===0&&hints.finalityRef!==null&&candidate.outstandingHold!=='0'){
    const binding=candidate.authorityBinding,source=await gate.wait(resolveExecutionFinality(engine.sourceCollector,engine.clock,{scope:request.scope,reference:hints.finalityRef,kind:'execution_finality',
     attempt:candidate.attemptBinding,authorityBinding:binding,provider:binding.provider,model:binding.model,operation:binding.operation,targetBindingSha256:binding.targetBindingSha256}));
    gate.checkpoint();if(source&&Value.Check(BudgetExecutionFinalitySchema,source.record.payload)&&['final_no_bill','fenced_not_dispatched'].includes(source.record.payload.state)){
     const key=await budgetDigest({runId,reservationId:candidate.reservationId,reference:hints.finalityRef,kind:'unused_release'});
     result=await gate.wait(releaseReservation({schemaVersion:'2.0.0',requestId:request.requestId,idempotencyKey:key,scope:request.scope,reservationId:candidate.reservationId,expectedRevision:revision,
      actorReference:request.scope.actorId,sourceAuthorityRef:hints.finalityRef,attemptBinding:candidate.attemptBinding,action:'release',release:{amount:candidate.outstandingHold,currency:'USD',reason:request.actionReference,
       proof:source.record.payload.state==='fenced_not_dispatched'?'never_dispatched_fenced':'final_usage_known',evidenceRefs:[hints.finalityRef]}},bounded));gate.checkpoint();
    }
   }
   if(!result&&candidate.outstandingHold!=='0'&&Date.parse(candidate.expiresAt)<=engine.clock.now().getTime()&&candidate.state!=='held_for_reconciliation'){
    result=await gate.wait(expireReservation({schemaVersion:'1.0.0',requestId:request.requestId,idempotencyKey:await budgetDigest({runId,reservationId:candidate.reservationId,kind:'expired_unresolved'}),scope:request.scope,
     reservationId:candidate.reservationId,expectedRevision:revision,actorReference:request.scope.actorId,sourceAuthorityRef:candidate.sourceAuthorityRef,attemptBinding:candidate.attemptBinding,reasonReference:request.actionReference},bounded));gate.checkpoint();
   }
   const success=result?.ok&&result.value.status!=='stale_revision'&&result.value.status!=='conflict'?result.value:null;
   actions.push({reservationId:candidate.reservationId,status:success?(success.state==='released'?'released':success.state==='held_for_reconciliation'?'retained_unknown':success.usageFinality==='final'?'posted':'unresolved'):'unresolved',
    revision:success?success.revision:revision,errorCode:result&&!result.ok?result.error.code:null});
  }
  const refreshed=await permission(ports,request,'reconciliation.startReconciliation',proofs,gate);if(!refreshed.ok)return failure(refreshed.error);
  const capacity=await gate.wait(readCapacity(request.scope,'USD',request.requestId,bounded));gate.checkpoint();
  const unknownExposure=!capacity.ok||capacity.value.unresolvedExposure;
  client=await bounded.database.connect();transaction=true;await begin(client,request.scope,gate);
  const concurrent=await journal(client,request.scope,completionKey);if(concurrent.rows[0]){
   if(await budgetDigest(concurrent.rows[0].command_request)!==requestDigest)return failure(errorEnvelope('reconciliation','startReconciliation','IDEMPOTENCY_CONFLICT',request.requestId,'The complete reconciliation owner/action request differs.'));
   const fresh=await permission(ports,request,'reconciliation.startReconciliation',proofs,gate);if(!fresh.ok)return failure(fresh.error);
   return {ok:true,value:{...structuredClone(concurrent.rows[0].command_receipt) as BudgetReconciliationReceipt,requestId:request.requestId,replay:true}};
  }
  const cursor=await client.query(`SELECT revision,after_recorded_at::text,after_reservation_id,completed_cycle FROM cost_intelligence.budget_recovery_cursors WHERE tenant_id=$1 AND project_id=$2 AND environment=$3 AND billing_mode=$4 AND currency='USD' AND job_reference=$5 ORDER BY revision DESC LIMIT 1`,[request.scope.tenantId,request.scope.projectId,request.scope.environment,request.scope.billingMode,request.jobReference]);
  const latest=cursor.rows[0];if(!latest)return unavailable(request.requestId);
  const unresolved=actions.filter(action=>action.status==='unresolved'||action.status==='retained_unknown').length;
  const receipt:BudgetReconciliationReceipt={schemaVersion:'2.0.0',requestId:request.requestId,runId,status:batch.value.completedCycle&&unresolved===0&&!unknownExposure?'complete':'needs_review',replay:false,
   cursorRevision:Number(latest.revision)+1,completedCycle:batch.value.completedCycle,scannedCount:actions.length,matchedCount:actions.length-unresolved,unresolvedCount:unresolved,
   ownerReference:request.ownerReference,actionReference:request.actionReference,asOf:ports.clock.now().toISOString(),unknownExposure,dispatchEligible:false,actions};
  await client.query(`INSERT INTO cost_intelligence.budget_recovery_cursors(cursor_id,tenant_id,project_id,environment,billing_mode,currency,job_reference,revision,after_recorded_at,after_reservation_id,completed_cycle,command_request,command_receipt,idempotency_key)
   VALUES($1,$2,$3,$4,$5,'USD',$6,$7,$8::timestamptz,$9,$10,$11::jsonb,$12::jsonb,$13)`,[crypto.randomUUID(),request.scope.tenantId,request.scope.projectId,request.scope.environment,request.scope.billingMode,request.jobReference,receipt.cursorRevision,latest.after_recorded_at,latest.after_reservation_id,latest.completed_cycle,JSON.stringify(normalizedBudgetRequest(request)),JSON.stringify(receipt),completionKey]);
  const final=await permission(ports,request,'reconciliation.startReconciliation',proofs,gate);if(!final.ok)return failure(final.error);gate.checkpoint();
  await client.query('COMMIT');transaction=false;
  const acknowledged=await permission(ports,request,'reconciliation.startReconciliation',proofs,gate);if(!acknowledged.ok)return unavailable(request.requestId);
  return {ok:true,value:receipt};
 }catch{return unavailable(request.requestId);}finally{if(client&&transaction)await client.query('ROLLBACK').catch(()=>{});client?.release();}
 });
}

export async function getBudgetReconciliation(value:unknown,ports:RuntimePorts):Promise<ApiResult<BudgetReconciliationReceipt>>{
 if(!Value.Check(BudgetReconciliationQuerySchema,value))return failure(errorEnvelope('reconciliation','getReconciliation','VALIDATION_ERROR',String((value as {requestId?:unknown})?.requestId??'unknown'),'The Finance reconciliation query is malformed.'));
 const request=structuredClone(value),engine=runtime(ports),milliseconds=engine?.authorityWaitMs??2000;
 if(!Number.isSafeInteger(milliseconds)||milliseconds<1||milliseconds>60000)return unavailable(request.requestId);
 return runCycle(milliseconds,request.requestId,async gate=>{
 const proofs:Proof[]=[];let client:BudgetTransactionPort|undefined,transaction=false;
 try{
  const granted=await permission(ports,request,'reconciliation.getReconciliation',proofs,gate);if(!granted.ok)return failure(granted.error);if(!engine)return unavailable(request.requestId);
  client=await guardedDatabase(engine,gate).connect();transaction=true;await begin(client,request.scope,gate);
  const result=await journal(client,request.scope,`ci05b-reconciliation-complete:${request.runId}`);
  const refreshed=await permission(ports,request,'reconciliation.getReconciliation',proofs,gate);if(!refreshed.ok)return failure(refreshed.error);
  if(!result.rows[0])return failure(errorEnvelope('reconciliation','getReconciliation','RECONCILIATION_PENDING',request.requestId,'The run has no completed immutable source reconciliation receipt.',true));
  await client.query('COMMIT');transaction=false;
  const acknowledged=await permission(ports,request,'reconciliation.getReconciliation',proofs,gate);if(!acknowledged.ok)return unavailable(request.requestId);
  return {ok:true,value:{...structuredClone(result.rows[0].command_receipt) as BudgetReconciliationReceipt,requestId:request.requestId,replay:true}};
 }catch{return unavailable(request.requestId);}finally{if(client&&transaction)await client.query('ROLLBACK').catch(()=>{});client?.release();}
 });
}
