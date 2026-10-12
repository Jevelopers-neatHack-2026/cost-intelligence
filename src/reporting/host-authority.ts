import { FINANCE_OPERATION_POLICY, sameScope, type Clock, type FinanceAuthorizationPort, type FinanceAuthorizationRequest, type TrustedScope } from '../shared/contracts.js';
import { canonicalJson, hash } from './projection.js';
export const FINANCE_HOST_ACTION_MAPPING_VERSION = 'ci-finance-host-action-mapping-1.0.0' as const;
export const FINANCE_HOST_ACTION_MAPPING_STATUS = 'PROPOSED_OWNER_REVIEW_PENDING' as const;
export interface VerifiedProductContext {
  schema: 'ticketstub.context/2'; issuer: 'getticketstub.com'; audience: string;
  actor: { kind: 'account' | 'guest' | 'anonymous'; id: string }; tenant: { id: string };
  project?: { id: string; kind: 'stub' | 'event'; ref: string };
  role: string; capabilities: readonly string[]; membershipRevision: number; revoked: boolean;
  environment: 'development' | 'preview' | 'live'; economicMode: 'none' | 'sandbox' | 'paid_test' | 'live'; evidenceMode: 'fixture' | 'synthetic' | 'live';
  issuedAt: string; expiresAt: string;
}
export interface CurrentProductVerification {
  context: VerifiedProductContext; checkedAt: string; currentMembershipRevision: number;
  sessionLive: boolean; projectMember: boolean; revoked: boolean;
}
export interface FinanceScopeMapping {
  mappingVersion: typeof FINANCE_HOST_ACTION_MAPPING_VERSION;
  sourceTenantId: string; sourceProjectRef: string;
  scope: TrustedScope; verifiedAt: string; expiresAt: string;
  mappingReference: { id: string; revision: number; contentHash: string };
}
export interface FinanceHostModeMapping {
  environment: VerifiedProductContext['environment']; economicMode: VerifiedProductContext['economicMode']; evidenceMode: VerifiedProductContext['evidenceMode'];
  financeEnvironment: TrustedScope['environment']; financeBillingMode: TrustedScope['billingMode'];
}
export interface FinanceReadExportHostConfiguration {
  clock: Clock; audience: string;
  /** Server-held credential verifier. It must use the actual current issuer session/membership/project source, not caller context JSON. */
  verifier: { verifyCurrent(): Promise<CurrentProductVerification | null> };
  /** Independently maintained ledger scope mapping. Never derive a tenant from an account ID or echo incoming requestedScope. */
  scopeMapping: { resolveCurrent(context: VerifiedProductContext): Promise<FinanceScopeMapping | null> };
  modeMappings: readonly FinanceHostModeMapping[];
  approval: { mode: 'synthetic_fixture'; fixtureId: string } | { mode: 'owner_approved'; reference: { id: string; revision: number; contentHash: string } };
}
const operations = {
  'reporting.querySummary': { action: 'finance.read', permission: 'finance.summary.read' },
  'integrations.exportSummary': { action: 'finance.export', permission: 'finance.summary.export' },
} as const;
function currentProof(verifiedAt: string, expiresAt: string, clock: Clock, maxAge=60_000): boolean {
  try { const now=clock.now();const verified=Date.parse(verifiedAt);const expiry=Date.parse(expiresAt);
    return now instanceof Date && Number.isFinite(now.valueOf()) && Number.isFinite(verified) && Number.isFinite(expiry) && verified<=now.valueOf() && now.valueOf()-verified<=maxAge && expiry>now.valueOf() && expiry-verified<=300_000;
  } catch { return false; }
}
function shapedCurrent(value: CurrentProductVerification, config: FinanceReadExportHostConfiguration): boolean {
  try {
    const c=value.context;const now=config.clock.now().valueOf();const issued=Date.parse(c.issuedAt);const expires=Date.parse(c.expiresAt);const checked=Date.parse(value.checkedAt);
    return ['development','preview','live'].includes(c.environment) && ['none','sandbox','paid_test','live'].includes(c.economicMode) && ['fixture','synthetic','live'].includes(c.evidenceMode)
      && (c.environment==='live'?c.economicMode!=='paid_test':c.economicMode!=='live')
      && c.schema==='ticketstub.context/2' && c.issuer==='getticketstub.com' && c.audience===config.audience && config.audience.length>0 && c.actor.kind==='account'
      && c.actor.id.startsWith('account:') && c.actor.id.length>8 && c.tenant.id===c.actor.id
      && !!c.project && c.project.kind==='event' && c.project.id.length>0 && c.project.ref===`${c.project.kind}:${c.project.id}`
      && Array.isArray(c.capabilities) && c.capabilities.every(cap=>typeof cap==='string') && c.capabilities.length<=100
      && Number.isSafeInteger(c.membershipRevision) && c.membershipRevision>=0 && value.currentMembershipRevision===c.membershipRevision
      && value.sessionLive===true && value.projectMember===true && value.revoked===false && c.revoked===false
      && Number.isFinite(now) && Number.isFinite(issued) && Number.isFinite(expires) && issued<=now && checked>=issued && checked<=now && now-checked<=60_000 && expires>now && expires-issued<=300_000;
  } catch { return false; }
}
/** Explicit optional host adapter. Never automatically mounted, never aliases unrelated permissions, never grants financial commands. */
export function createFinanceReadExportAuthority(configuration: FinanceReadExportHostConfiguration): FinanceAuthorizationPort {
  // Copy finite policy configuration before asynchronous verifier calls; retain private server ports by reference.
  const config={...configuration,modeMappings:configuration.modeMappings.map(mapping=>({...mapping})),approval:structuredClone(configuration.approval)};
  return { authorizeCurrent: async (request: FinanceAuthorizationRequest) => {
    const denied=()=>({status:'denied' as const,operation:request.operation,permission:request.permission});
    const policy=operations[request.operation as keyof typeof operations];
    if(!policy || request.permission!==policy.permission || FINANCE_OPERATION_POLICY[request.operation]?.permission!==request.permission)return denied();
    if(!config.approval || (config.approval.mode==='synthetic_fixture' ? !config.approval.fixtureId : config.approval.mode!=='owner_approved' || !/^sha256:[a-f0-9]{64}$/.test(config.approval.reference.contentHash) || !config.approval.reference.id || !Number.isSafeInteger(config.approval.reference.revision) || config.approval.reference.revision<1))return denied();
    let first: CurrentProductVerification|null;
    try { first=structuredClone(await config.verifier.verifyCurrent()); }catch{return null;}
    if(!first)return null;
    if(!shapedCurrent(first,config)||!first.context.capabilities.includes(policy.action))return denied();
    const matches=config.modeMappings.filter(mapping=>mapping.environment===first!.context.environment&&mapping.economicMode===first!.context.economicMode&&mapping.evidenceMode===first!.context.evidenceMode);
    if(matches.length!==1 || matches[0]!.financeEnvironment!==request.requestedScope.environment || matches[0]!.financeBillingMode!==request.requestedScope.billingMode)return denied();
    let mapping: FinanceScopeMapping|null;
    try { mapping=structuredClone(await config.scopeMapping.resolveCurrent(structuredClone(first.context))); }catch{return null;}
    if(!mapping)return null;
    if(mapping.mappingVersion!==FINANCE_HOST_ACTION_MAPPING_VERSION || mapping.sourceTenantId!==first.context.tenant.id || mapping.sourceProjectRef!==first.context.project!.ref
      || !sameScope(mapping.scope,request.requestedScope) || mapping.scope.actorId!==first.context.actor.id || !currentProof(mapping.verifiedAt,mapping.expiresAt,config.clock)
      || !mapping.mappingReference.id || !Number.isSafeInteger(mapping.mappingReference.revision) || mapping.mappingReference.revision<1 || !/^sha256:[a-f0-9]{64}$/.test(mapping.mappingReference.contentHash))return denied();
    let current: CurrentProductVerification|null;
    try { current=structuredClone(await config.verifier.verifyCurrent()); }catch{return null;}
    if(!current)return null;
    if(!shapedCurrent(current,config)||canonicalJson(current.context)!==canonicalJson(first.context)||!current.context.capabilities.includes(policy.action)||!currentProof(mapping.verifiedAt,mapping.expiresAt,config.clock))return denied();
    const expiresAt=new Date(Math.min(Date.parse(current.context.expiresAt),Date.parse(mapping.expiresAt),Date.parse(current.checkedAt)+60_000)).toISOString();
    return {status:'allowed',decisionId:hash({version:FINANCE_HOST_ACTION_MAPPING_VERSION,scope:request.requestedScope,operation:request.operation,revision:current.currentMembershipRevision,checkedAt:current.checkedAt,mappingReference:mapping.mappingReference}),operation:request.operation,permission:request.permission,scope:structuredClone(mapping.scope),
      principal:{kind:'user',actorId:mapping.scope.actorId,membershipStatus:'active',membershipRevision:String(current.currentMembershipRevision)},verifiedAt:current.checkedAt,expiresAt};
  } };
}
