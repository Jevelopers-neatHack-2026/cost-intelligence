import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { TrustedScopeSchema, type Clock, type TrustedScope } from '../shared/contracts.js';
import { BudgetReferenceSchema, ReservationAuthorityBindingSchema, canonicalBudgetJson, budgetDigest, type BudgetReference,type ReservationAuthorityBinding } from './authority.js';

/** Collector signatures authenticate Finance/host records, never provider signatures or product grants. */
export const BUDGET_SOURCE_VERSION = 'ci-budget-source-1.0.0' as const;
const Ref = Type.String({ minLength: 1, maxLength: 256 });
const Hash = Type.String({ pattern: '^sha256:[a-f0-9]{64}$' });
const Instant = Type.String({ format: 'date-time' });
const Attempt = Type.Object({ logicalOperationId: Ref, providerAttemptId: Ref, billableAttemptId: Ref,
  transportAttemptId: Ref, providerRequestId: Type.Union([Ref, Type.Null()]) }, { additionalProperties: false });
export const BudgetCollectorRecordSchema = Type.Object({
  version: Type.Literal(BUDGET_SOURCE_VERSION), issuerKeyId: Ref, id: Ref,
  revision: Type.Integer({ minimum: 1 }), predecessorHash: Type.Union([Hash, Type.Null()]),
  scope: TrustedScopeSchema, provider: Ref, model: Ref, operation: Ref,
  authorityBinding:Type.Union([ReservationAuthorityBindingSchema,Type.Null()]),
  evidenceMode:Type.Union([Type.Literal('mocked'),Type.Literal('sandbox'),Type.Literal('live')]),
  targetBindingSha256: Type.Union([Hash, Type.Null()]), attempt: Type.Union([Attempt, Type.Null()]),
  kind: Type.Union([Type.Literal('reported_cost'), Type.Literal('execution_finality'),
    Type.Literal('pricing_profile'), Type.Literal('maximum_policy'), Type.Literal('aggregate_usage')]),
  sourceFormat: Ref, sourceBytesSha256: Hash, observedAt: Instant, payload: Type.Unknown(),
}, { additionalProperties: false });
export type BudgetCollectorRecord = Static<typeof BudgetCollectorRecordSchema>;
export const BudgetCollectorCurrentSchema = Type.Object({
  version: Type.Literal(BUDGET_SOURCE_VERSION), issuerKeyId: Ref, recordId: Ref,
  revision: Type.Integer({ minimum: 1 }), recordHash: Hash, scopeHash: Hash,
  verifiedAt: Instant, expiresAt: Instant, revoked: Type.Boolean(),
}, { additionalProperties: false });
export type BudgetCollectorCurrent = Static<typeof BudgetCollectorCurrentSchema>;
export interface BudgetCollectorEnvelope {
  readonly record: BudgetCollectorRecord;
  readonly recordSignature: string;
  readonly current: BudgetCollectorCurrent;
  readonly currentSignature: string;
  /** Original bytes as received by the owner collector. Never caller-normalized JSON. */
  readonly sourceBytes: string;
}
export interface BudgetCollectorKey {
  readonly publicKeySpkiBase64: string;
  readonly revoked: boolean;
  readonly validFrom: string;
  readonly validUntil: string;
  /** Independently registered issuer purposes; a cost collector cannot mint billing finality or policy. */
  readonly allowedKinds: readonly BudgetCollectorRecord['kind'][];
}
export interface BudgetCollectorBackend {
  /** Both functions are mounted by the owner. Request payloads cannot supply records, keys or current state. */
  loadCurrent(reference: BudgetReference): Promise<BudgetCollectorEnvelope | null>;
  loadCurrentIssuerKey(keyId: string): Promise<BudgetCollectorKey | null>;
  /** Optional owner discovery. Returned references are hints; every financial record is authenticated separately. */
  findAttemptEvidence?(query:{scope:TrustedScope;attempt:NonNullable<BudgetCollectorRecord['attempt']>;authorityBinding:ReservationAuthorityBinding}):Promise<{
    readonly reportedCostRefs:readonly BudgetReference[];readonly finalityRef:BudgetReference|null;
  }|null>;
}
export interface BudgetSourceQuery {
  readonly scope: TrustedScope;
  readonly reference: BudgetReference;
  readonly kind: BudgetCollectorRecord['kind'];
  readonly provider?: string;
  readonly model?: string;
  readonly operation?: string;
  readonly targetBindingSha256?: string;
  readonly attempt?: BudgetCollectorRecord['attempt'];
  readonly authorityBinding?:ReservationAuthorityBinding|null;
}
export interface AuthenticatedBudgetSource {
  readonly reference: BudgetReference;
  readonly record: BudgetCollectorRecord;
  readonly sourceBytes: string;
  readonly recordHash: string;
  readonly current: BudgetCollectorCurrent;
  readonly verifiedAt: string;
  readonly expiresAt: string;
  readonly authentication:{readonly recordSignature:string;readonly initialCurrent:BudgetCollectorCurrent;
    readonly initialCurrentSignature:string;readonly currentSignature:string;
    readonly recordIssuerKey:BudgetCollectorKey;readonly initialCurrentIssuerKey:BudgetCollectorKey;readonly currentIssuerKey:BudgetCollectorKey};
}
export interface BudgetSourceEvidencePort {
  resolveCurrent(query: BudgetSourceQuery): Promise<AuthenticatedBudgetSource | null>;
}
export async function budgetSourceBytesHash(bytes: string): Promise<string> {
  const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(bytes));
  return `sha256:${Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,'0')).join('')}`;
}
export function budgetCollectorSigningBytes(kind: 'record'|'current', value: unknown): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`${BUDGET_SOURCE_VERSION}:${kind}\n${canonicalBudgetJson(value)}`);
}
function financialScope(scope: TrustedScope) {
  return {tenantId:scope.tenantId,projectId:scope.projectId,environment:scope.environment,billingMode:scope.billingMode};
}
function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  if(!/^[A-Za-z0-9+/]+={0,2}$/.test(value))throw new Error('invalid signature encoding');
  return Uint8Array.from(atob(value),c=>c.charCodeAt(0));
}
function currentKey(key: BudgetCollectorKey|null, now: Date): key is BudgetCollectorKey {
  return !!key&&!key.revoked&&Date.parse(key.validFrom)<=now.getTime()&&Date.parse(key.validUntil)>now.getTime();
}
async function verifies(key: BudgetCollectorKey, signature: string, kind: 'record'|'current', value: unknown) {
  const imported=await crypto.subtle.importKey('spki',decodeBase64(key.publicKeySpkiBase64),{name:'Ed25519'},false,['verify']);
  return crypto.subtle.verify({name:'Ed25519'},imported,decodeBase64(signature),budgetCollectorSigningBytes(kind,value));
}
/** Real validation implementation. The owner backend supplies authentication, source bytes and current key/record heads. */
export function createAuthenticatedBudgetSourceResolver(backend: BudgetCollectorBackend, clock: Clock): BudgetSourceEvidencePort {
  return { async resolveCurrent(input) {
    try {
      const query=structuredClone(input);
      if(!Value.Check(BudgetReferenceSchema,query.reference)||query.reference.contract!=='ci-budget-source')return null;
      const envelope=structuredClone(await backend.loadCurrent(query.reference));
      if(!envelope||!Value.Check(BudgetCollectorRecordSchema,envelope.record)||!Value.Check(BudgetCollectorCurrentSchema,envelope.current))return null;
      if(typeof envelope.sourceBytes!=='string'||typeof envelope.recordSignature!=='string'||typeof envelope.currentSignature!=='string')return null;
      const {record,current}=envelope;
      const recordKey=structuredClone(await backend.loadCurrentIssuerKey(record.issuerKeyId));
      const currentIssuer=structuredClone(await backend.loadCurrentIssuerKey(current.issuerKeyId));
      const now=clock.now();if(!(now instanceof Date)||!Number.isFinite(now.getTime()))return null;
      if(!currentKey(recordKey,now)||!currentKey(currentIssuer,now))return null;
      if(!recordKey.allowedKinds?.includes(query.kind)||!currentIssuer.allowedKinds?.includes(query.kind))return null;
      if(!await verifies(recordKey,envelope.recordSignature,'record',record)||!await verifies(currentIssuer,envelope.currentSignature,'current',current))return null;
      const recordHash=await budgetDigest(record),scopeHash=await budgetDigest(financialScope(query.scope));
      if(record.id!==query.reference.id||record.revision!==query.reference.revision||recordHash!==query.reference.content_hash
        ||current.recordId!==record.id||current.revision!==record.revision||current.recordHash!==recordHash||current.scopeHash!==scopeHash
        ||canonicalBudgetJson(financialScope(record.scope))!==canonicalBudgetJson(financialScope(query.scope))
        ||record.kind!==query.kind||current.revoked||await budgetSourceBytesHash(envelope.sourceBytes)!==record.sourceBytesSha256)return null;
      for(const field of ['provider','model','operation','targetBindingSha256','attempt','authorityBinding'] as const){
        if(query[field]!==undefined&&canonicalBudgetJson(query[field])!==canonicalBudgetJson(record[field]))return null;
      }
      // A signed head captured before the key/crypto awaits is not current authority.
      // Reload the owner head and keys; retain the earlier proof's shorter lifetime.
      const latest=structuredClone(await backend.loadCurrent(query.reference));
      if(!latest||!Value.Check(BudgetCollectorCurrentSchema,latest.current)
        ||canonicalBudgetJson(latest.record)!==canonicalBudgetJson(record)||latest.sourceBytes!==envelope.sourceBytes
        ||latest.current.recordId!==record.id||latest.current.recordHash!==recordHash||latest.current.revision!==record.revision
        ||latest.current.scopeHash!==scopeHash||latest.current.revoked)return null;
      const finalRecordKey=structuredClone(await backend.loadCurrentIssuerKey(record.issuerKeyId));
      const finalCurrentKey=structuredClone(await backend.loadCurrentIssuerKey(latest.current.issuerKeyId));
      const keyNow=clock.now();
      if(!currentKey(finalRecordKey,keyNow)||!currentKey(finalCurrentKey,keyNow)
        ||!finalRecordKey.allowedKinds?.includes(query.kind)||!finalCurrentKey.allowedKinds?.includes(query.kind)
        ||finalRecordKey.publicKeySpkiBase64!==recordKey.publicKeySpkiBase64
        ||!await verifies(finalCurrentKey,latest.currentSignature,'current',latest.current))return null;
      // Read the clock after every cryptographic/backend await. Earlier evidence cannot be extended by a later refresh.
      const finalNow=clock.now();const verified=Date.parse(current.verifiedAt),expires=Date.parse(current.expiresAt);
      const finalExpires=Date.parse(latest.current.expiresAt),finalVerified=Date.parse(latest.current.verifiedAt);
      const expiresAt=Math.min(expires,finalExpires,Date.parse(recordKey.validUntil),Date.parse(currentIssuer.validUntil),Date.parse(finalRecordKey.validUntil),Date.parse(finalCurrentKey.validUntil));
      if(!currentKey(recordKey,finalNow)||!currentKey(currentIssuer,finalNow)||!currentKey(finalRecordKey,finalNow)||!currentKey(finalCurrentKey,finalNow)||Date.parse(record.observedAt)>finalNow.getTime()
        ||!Number.isFinite(verified)||!Number.isFinite(expires)||verified>finalNow.getTime()||expires<=finalNow.getTime()
        ||!Number.isFinite(finalVerified)||!Number.isFinite(finalExpires)||finalVerified>finalNow.getTime()||expiresAt<=finalNow.getTime()
        ||Date.parse(record.observedAt)>verified||Date.parse(record.observedAt)>finalVerified)return null;
      return structuredClone({reference:query.reference,record,sourceBytes:envelope.sourceBytes,recordHash,current:latest.current,
        verifiedAt:latest.current.verifiedAt,expiresAt:new Date(expiresAt).toISOString(),authentication:{
          recordSignature:envelope.recordSignature,initialCurrent:current,initialCurrentSignature:envelope.currentSignature,
          currentSignature:latest.currentSignature,recordIssuerKey:finalRecordKey,initialCurrentIssuerKey:currentIssuer,currentIssuerKey:finalCurrentKey}});
    }catch{return null;}
  }};
}
