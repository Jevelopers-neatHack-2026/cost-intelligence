import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {providerReportedCostEvidenceContentHash} from '@jevelopers/shared-contracts-reported-development/usage-reported-unsettled';
import {budgetDigest,budgetSourceBytesHash,budgetCollectorSigningBytes} from '../../dist/budgets/index.js';
export async function signedSourceHarness(scope,binding,attempt,clock){
 const keys=await crypto.subtle.generateKey('Ed25519',true,['sign','verify']),records=new Map();
 const key={publicKeySpkiBase64:Buffer.from(await crypto.subtle.exportKey('spki',keys.publicKey)).toString('base64'),revoked:false,allowedKinds:['reported_cost','execution_finality','pricing_profile','maximum_policy','aggregate_usage'],validFrom:'2026-10-11T00:00:00Z',validUntil:'2026-10-13T00:00:00Z'};
 const sign=async(kind,value)=>Buffer.from(await crypto.subtle.sign('Ed25519',keys.privateKey,budgetCollectorSigningBytes(kind,value))).toString('base64');
 const publish=async(kind,payload,sourceBytes)=>{
  const record={version:'ci-budget-source-1.0.0',issuerKeyId:'synthetic-finance-collector',id:randomUUID(),revision:1,predecessorHash:null,scope,
   authorityBinding:binding,evidenceMode:'mocked',provider:binding.provider,model:binding.model,operation:binding.operation,targetBindingSha256:binding.targetBindingSha256,attempt,kind,
   sourceFormat:kind==='reported_cost'?'finance_synthetic_provider_response_v1':kind==='pricing_profile'?'finance_pricing_policy_v1':kind==='maximum_policy'?'finance_maximum_policy_v1':'finance_execution_finality_v1',sourceBytesSha256:await budgetSourceBytesHash(sourceBytes),observedAt:clock.now().toISOString(),payload};
  const hash=await budgetDigest(record),{actorId,...financialScope}=scope;
  const current={version:record.version,issuerKeyId:record.issuerKeyId,recordId:record.id,revision:1,recordHash:hash,scopeHash:await budgetDigest(financialScope),verifiedAt:clock.now().toISOString(),expiresAt:new Date(clock.now().getTime()+30000).toISOString(),revoked:false};
  records.set(record.id,{record,current,sourceBytes,recordSignature:await sign('record',record),currentSignature:await sign('current',current)});
  return {contract:'ci-budget-source',schema_version:'1.0.0',id:record.id,revision:1,content_hash:hash};
 };
 let priorUsage=null;
 const cost=async (amount,options={})=>{
  const fixture=JSON.parse(await readFile(new URL('../../node_modules/@jevelopers/shared-contracts-reported-development/fixtures/UsageEvent.2_0_0.json',import.meta.url),'utf8'));
  const usage=structuredClone(fixture.valid),evidence=structuredClone(fixture.context.evidence_lookup.record),sourceBytes=options.sourceExtra?`{"usage":{"cost":${amount}},"unreviewed_provider_extra":${JSON.stringify(options.sourceExtra)}}`:`{"usage":{"cost":${amount}}}`;
  Object.assign(usage,{tenant_id:scope.tenantId,project_id:scope.projectId,environment:scope.environment,billing_mode:scope.billingMode,
   event_id:randomUUID(),usage_event_id:priorUsage?.usage_event_id??randomUUID(),source_observation_id:randomUUID(),supersedes_observation_id:priorUsage?.source_observation_id??null,correlation_id:randomUUID(),occurred_at:clock.now().toISOString(),observed_at:clock.now().toISOString(),ingested_at:clock.now().toISOString(),
   logical_operation_id:attempt.logicalOperationId,provider_attempt_id:attempt.providerAttemptId,billable_attempt_id:attempt.billableAttemptId,transport_attempt_id:attempt.transportAttemptId,provider_request_id:attempt.providerRequestId,provider:binding.provider,model:binding.model});
  Object.assign(evidence,{tenant_id:scope.tenantId,project_id:scope.projectId,environment:scope.environment,billing_mode:scope.billingMode,
   evidence_id:randomUUID(),source_observation_id:usage.source_observation_id,provider:binding.provider,model:binding.model,source_observed_at:clock.now().toISOString(),source_bytes_hash:await budgetSourceBytesHash(sourceBytes),
   source_scope:{kind:'per_billable_attempt',logical_operation_id:attempt.logicalOperationId,provider_attempt_id:attempt.providerAttemptId,billable_attempt_id:attempt.billableAttemptId,provider_request_id:attempt.providerRequestId},
   reported_cost:{state:'known',money:{amount,currency:'USD',scale:amount.split('.')[1]?.length??0}}});
  evidence.content_hash=providerReportedCostEvidenceContentHash(evidence);usage.valuation.money=structuredClone(evidence.reported_cost.money);
  usage.valuation.provider_evidence_ref={contract:'ProviderReportedCostEvidence',schema_version:'1.0.0',id:evidence.evidence_id,revision:1,content_hash:evidence.content_hash};
  const ref=await publish('reported_cost',{usageEvent:usage,providerEvidence:evidence,references:fixture.context.references,amountSemantics:'cumulative_attempt_total',...(options.payloadExtra?{unreviewedCollectorExtra:options.payloadExtra}:{})},sourceBytes);
  priorUsage=structuredClone(usage);return ref;
 };
 const finality=async payload=>publish('execution_finality',payload,JSON.stringify({financial_finality:payload}));
 return {records,key,publish,cost,finality,backend:{loadCurrent:async ref=>structuredClone(records.get(ref.id)??null),loadCurrentIssuerKey:async id=>id==='synthetic-finance-collector'?structuredClone(key):null}};
}
