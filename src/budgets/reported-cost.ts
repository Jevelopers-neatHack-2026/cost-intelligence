import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { checkProviderReportedCostEvidence, checkReportedUnsettledUsageEvent, compareReportedUnsettledUsageIdentity } from '@jevelopers/shared-contracts-reported-development/usage-reported-unsettled';
import type { UsageEvent_2_0_0, ProviderReportedCostEvidence_1_0_0 } from '@jevelopers/shared-contracts-reported-development';
import type { Clock } from '../shared/contracts.js';
import { BudgetReferenceSchema, budgetDigest, canonicalBudgetJson } from './authority.js';
import { createAuthenticatedBudgetSourceResolver, type AuthenticatedBudgetSource, type BudgetCollectorBackend, type BudgetSourceQuery } from './evidence.js';

const Ref=Type.String({minLength:1,maxLength:256});
const Amount=Type.String({pattern:'^(?:0|[1-9][0-9]*)(?:\\.[0-9]{1,18})?$',maxLength:40});
/** Explicit Finance proposal: completeness of an estimate does not establish its pricing unit. */
export const BudgetPricingProfileSchema=Type.Object({
  schemaVersion:Type.Literal('ci-budget-pricing-1.0.0'),
  pricingUnit:Type.Union([Type.Literal('fixed_per_attempt'),Type.Literal('per_token'),Type.Literal('unknown')]),
  currency:Type.String({pattern:'^[A-Z]{3}$'}), economicRequestDigest:Type.String({pattern:'^sha256:[a-f0-9]{64}$'}),
  fixedAttemptAmount:Type.Union([Amount,Type.Null()]),
  maximumPolicyRef:Type.Union([BudgetReferenceSchema,Type.Null()]),
},{additionalProperties:false});
export type BudgetPricingProfile=Static<typeof BudgetPricingProfileSchema>;
export const BudgetMaximumPolicySchema=Type.Object({
  schemaVersion:Type.Literal('ci-budget-maximum-1.0.0'),currency:Type.String({pattern:'^[A-Z]{3}$'}),
  policyRef:BudgetReferenceSchema,authorizedMaximum:Amount,economicRequestDigest:Type.String({pattern:'^sha256:[a-f0-9]{64}$'}),
},{additionalProperties:false});
/** Finality is independently collected evidence, never implied by a cost, timeout or HTTP label. */
export const BudgetExecutionFinalitySchema=Type.Object({
  schemaVersion:Type.Literal('ci-budget-finality-1.0.0'),
  state:Type.Union([Type.Literal('partial'),Type.Literal('final_billed'),Type.Literal('final_no_bill'),Type.Literal('fenced_not_dispatched')]),
  dispatchIntentRef:Type.Union([BudgetReferenceSchema,Type.Null()]),
  cumulativeCostRef:Type.Union([BudgetReferenceSchema,Type.Null()]),
  fenceReference:Type.Union([Ref,Type.Null()]),
},{additionalProperties:false});
export type BudgetExecutionFinality=Static<typeof BudgetExecutionFinalitySchema>;

/** JSON numbers are retained as decimal text, never rounded through binary floating point. */
export function parseFinancialSourceJson(bytes:string):unknown {
  let result='',quoted=false,escaped=false;
  for(let i=0;i<bytes.length;){
    const char=bytes[i]!;
    if(quoted){result+=char;i++;if(escaped)escaped=false;else if(char==='\\')escaped=true;else if(char==='"')quoted=false;continue;}
    if(char==='"'){quoted=true;result+=char;i++;continue;}
    if(char==='-'||/\d/.test(char)){
      const token=/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(bytes.slice(i));
      if(!token)throw new Error('Invalid source JSON number');
      result+=JSON.stringify(token[0]);i+=token[0].length;continue;
    }
    result+=char;i++;
  }
  return JSON.parse(result);
}
/** Exact nonnegative USD representation, rejecting unsupported fractional precision instead of truncating it. */
export function exactSourceDecimal(input:unknown):string|null {
  if(typeof input!=='string')return null;
  const match=/^(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(input);
  if(!match)return null;
  const exponent=Number(match[3]??0);if(!Number.isSafeInteger(exponent)||Math.abs(exponent)>100)return null;
  let digits=match[1]!+(match[2]??''),point=match[1]!.length+exponent;
  if(point<0){digits='0'.repeat(-point)+digits;point=0;}
  if(point>digits.length)digits+='0'.repeat(point-digits.length);
  const whole=(digits.slice(0,point)||'0').replace(/^0+(?=\d)/,''),fraction=digits.slice(point).replace(/0+$/,'');
  if(fraction.length>18||whole.length>22)return null;
  return whole+(fraction?'.'+fraction:'');
}
function sourceCost(source:AuthenticatedBudgetSource):string|null {
  if(!['openrouter_images_response_v1','finance_synthetic_provider_response_v1'].includes(source.record.sourceFormat))return null;
  const value=parseFinancialSourceJson(source.sourceBytes) as {usage?:{cost?:unknown}};
  return exactSourceDecimal(value?.usage?.cost);
}
export interface AuthenticatedReportedCost {
  readonly source:AuthenticatedBudgetSource;
  readonly usage:UsageEvent_2_0_0;
  readonly evidence:ProviderReportedCostEvidence_1_0_0;
  /** Finance collector must explicitly attest whether the source amount is cumulative. */
  readonly amountSemantics:'cumulative_attempt_total'|'distinct_charge';
}
/** Private DEVELOPMENT decoder. The SDK helper runs only after owner signature/current-source authentication. */
export async function resolveReportedCost(backend:BudgetCollectorBackend,clock:Clock,query:BudgetSourceQuery,prior?:UsageEvent_2_0_0):Promise<AuthenticatedReportedCost|null>{
  try {
    if(query.kind!=='reported_cost'||!query.attempt||query.scope.environment==='production')return null;
    const source=await createAuthenticatedBudgetSourceResolver(backend,clock).resolveCurrent(query);if(!source)return null;
    const payload=source.record.payload as {usageEvent?:unknown;providerEvidence?:unknown;references?:unknown;amountSemantics?:unknown};
    if(payload.amountSemantics!=='cumulative_attempt_total'&&payload.amountSemantics!=='distinct_charge')return null;
    const checked=checkProviderReportedCostEvidence(payload.providerEvidence);if(!checked.ok)return null;
    const evidence=checked.value;
    if(evidence.source_bytes_hash!==source.record.sourceBytesSha256||evidence.source_scope.kind!=='per_billable_attempt')return null;
    const attempt=query.attempt,scope=query.scope;
    if(evidence.tenant_id!==scope.tenantId||evidence.project_id!==scope.projectId||evidence.environment!==scope.environment||evidence.billing_mode!==scope.billingMode
      ||evidence.provider!==source.record.provider||evidence.model!==source.record.model
      ||evidence.source_scope.logical_operation_id!==attempt.logicalOperationId||evidence.source_scope.provider_attempt_id!==attempt.providerAttemptId
      ||evidence.source_scope.billable_attempt_id!==attempt.billableAttemptId||evidence.source_scope.provider_request_id!==attempt.providerRequestId)return null;
    if(evidence.reported_cost.state!=='known'||evidence.reported_cost.money.currency!=='USD')return null;
    const originalAmount=sourceCost(source),reportedAmount=exactSourceDecimal(evidence.reported_cost.money.amount);
    if(originalAmount===null||reportedAmount===null||originalAmount!==reportedAmount)return null;
    const event=payload.usageEvent as UsageEvent_2_0_0;
    if(!event?.valuation||event.valuation.basis!=='provider_reported_unsettled')return null;
    // Explicit versioned mapping: the owner-authenticated Finance scope supplies the SDK brands.
    const context={
      scope:{tenant_id:scope.tenantId,project_id:scope.projectId},now:clock.now().toISOString(),policy_version:'1.0.0',
      environment:scope.environment,billing_mode:scope.billingMode,
      references:payload.references as Parameters<typeof checkReportedUnsettledUsageEvent>[1]['references'],
      ...(prior?{prior}:{}),
      evidence_lookup:{status:'resolved',expected_reference:event.valuation.provider_evidence_ref,record:evidence,
        source_bytes_hash:source.record.sourceBytesSha256,resolved_at:source.verifiedAt},
    } as Parameters<typeof checkReportedUnsettledUsageEvent>[1];
    const result=checkReportedUnsettledUsageEvent(event,context);
    if(!result.ok)return null;
    if(result.value.transport_attempt_id!==attempt.transportAttemptId){
      // A different delivery identifier is not another billable attempt. Only a
      // duplicate of an already persisted, authenticated observation may vary it.
      const relationship=prior?compareReportedUnsettledUsageIdentity(prior,result.value):null;
      if(!relationship?.ok||relationship.value!=='duplicate_observation')return null;
    }
    if(Date.parse(source.expiresAt)<=clock.now().getTime())return null;
    return structuredClone({source,usage:result.value,evidence,amountSemantics:payload.amountSemantics});
  }catch{return null;}
}
/** Domain-separated binding avoids a self-referential collector content hash while retaining all economic fields. */
export async function pricingEconomicRequestDigest(request:Record<string,unknown>):Promise<string>{
  const value=structuredClone(request);delete value.requestId;delete value.pricingProfileRef;
  return budgetDigest({domain:'ci-budget-pricing-1.0.0',request:value});
}
export async function resolvePricingProfile(backend:BudgetCollectorBackend,clock:Clock,query:BudgetSourceQuery,request:Record<string,unknown>){
  try{
  if(query.kind!=='pricing_profile')return null;
  const resolver=createAuthenticatedBudgetSourceResolver(backend,clock),source=await resolver.resolveCurrent(query);
  if(!source||!Value.Check(BudgetPricingProfileSchema,source.record.payload))return null;
  const profile=source.record.payload,digest=await pricingEconomicRequestDigest(request);
  if(source.record.sourceFormat!=='finance_pricing_policy_v1'
    ||canonicalBudgetJson((JSON.parse(source.sourceBytes) as {financial_pricing_policy?:unknown}).financial_pricing_policy)!==canonicalBudgetJson(profile))return null;
  if(profile.economicRequestDigest!==digest)return null;
  if(profile.pricingUnit==='fixed_per_attempt'){
    if(profile.fixedAttemptAmount===null||profile.maximumPolicyRef!==null)return null;
    return {source,profile,maximum:null};
  }
  if(profile.fixedAttemptAmount!==null)return null;
  if(profile.maximumPolicyRef===null)return {source,profile,maximum:null};
  const maximum=await resolver.resolveCurrent({...query,kind:'maximum_policy',reference:profile.maximumPolicyRef});
  if(!maximum)return {source,profile,maximum:null};
  if(!Value.Check(BudgetMaximumPolicySchema,maximum.record.payload)||maximum.record.payload.economicRequestDigest!==digest
    ||Date.parse(source.expiresAt)<=clock.now().getTime())return null;
  if(maximum.record.sourceFormat!=='finance_maximum_policy_v1'
    ||canonicalBudgetJson((JSON.parse(maximum.sourceBytes) as {financial_maximum_policy?:unknown}).financial_maximum_policy)!==canonicalBudgetJson(maximum.record.payload))return null;
  return {source,profile,maximum};
  }catch{return null;}
}
export async function resolveExecutionFinality(backend:BudgetCollectorBackend,clock:Clock,query:BudgetSourceQuery){
  try{
    if(query.kind!=='execution_finality')return null;
    const source=await createAuthenticatedBudgetSourceResolver(backend,clock).resolveCurrent(query);
    if(!source||!Value.Check(BudgetExecutionFinalitySchema,source.record.payload)||source.record.sourceFormat!=='finance_execution_finality_v1'
      ||canonicalBudgetJson((JSON.parse(source.sourceBytes) as {financial_finality?:unknown}).financial_finality)!==canonicalBudgetJson(source.record.payload))return null;
    if(Date.parse(source.expiresAt)<=clock.now().getTime())return null;
    return source;
  }catch{return null;}
}
export function finalityAllowsRelease(value:BudgetExecutionFinality):boolean {
  return value.state==='final_billed'?value.cumulativeCostRef!==null:
    value.state==='final_no_bill'?value.dispatchIntentRef!==null:
    value.state==='fenced_not_dispatched'?value.fenceReference!==null:false;
}
