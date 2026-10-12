import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import {
  TrustedScopeSchema,
  authorizeFinanceOperation,
  errorEnvelope,
  failure,
  type ApiResult,
  type Clock,
  type FinanceAuthorizationPort,
  type FinanceAuthorizationResult,
  type TrustedScope,
  type Validation,
} from '../shared/contracts.js';

/**
 * CI-10 operational evidence references (local slice: CI-10.1 and the local part of CI-10.2).
 *
 * References are links, never payloads: this module stores and returns no trace
 * bodies, prompts or URLs. Only a `resolved` reference carries an id, and ids are
 * taken from existing ledger facts, never generated here. The namespace registry
 * below is a LOCAL policy; it is not an accepted shared-contracts vocabulary.
 * See docs/api/evidence.md.
 */

export const EVIDENCE_REFERENCE_SCHEMA_VERSION = '1.0.0' as const;

/** Kinds of operational evidence (CI-10.1). */
export const EVIDENCE_KINDS = Object.freeze([
  'trace', 'correlation', 'workflow', 'run', 'job',
  'logical_operation', 'billable_attempt', 'transport_attempt', 'provider_attempt', 'provider_request',
  'source_observation', 'reservation',
  'design', 'design_version', 'artifact', 'artifact_hash',
  'repo_commit', 'build', 'dev_session', 'checkpoint',
] as const);
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

/**
 * What a reference may be used for. Nothing here is ever billing authority:
 * provider request ids and trace/session systems are correlation or evidence only.
 */
export type EvidenceAuthority = 'ledger_identity' | 'correlation_only' | 'evidence_only';

const LEDGER_NAMESPACE = 'cost-intelligence';
const PROVIDER_NAMESPACE = /^provider:[a-z0-9][a-z0-9_-]{0,63}$/;
const KIND_POLICY: Readonly<Record<EvidenceKind, { authority: EvidenceAuthority; namespaces: readonly (string | RegExp)[]; hash?: true; commit?: true }>> = Object.freeze({
  trace: { authority: 'evidence_only', namespaces: ['neatlogs', 'entire'] },
  correlation: { authority: 'correlation_only', namespaces: [LEDGER_NAMESPACE, 'neatlogs', 'entire'] },
  workflow: { authority: 'correlation_only', namespaces: [LEDGER_NAMESPACE, 'neatlogs', 'entire'] },
  run: { authority: 'correlation_only', namespaces: [LEDGER_NAMESPACE, 'neatlogs', 'entire'] },
  job: { authority: 'correlation_only', namespaces: [LEDGER_NAMESPACE, 'neatlogs', 'entire'] },
  logical_operation: { authority: 'ledger_identity', namespaces: [LEDGER_NAMESPACE] },
  billable_attempt: { authority: 'ledger_identity', namespaces: [LEDGER_NAMESPACE] },
  transport_attempt: { authority: 'ledger_identity', namespaces: [LEDGER_NAMESPACE] },
  provider_attempt: { authority: 'ledger_identity', namespaces: [LEDGER_NAMESPACE] },
  provider_request: { authority: 'correlation_only', namespaces: [PROVIDER_NAMESPACE] },
  source_observation: { authority: 'ledger_identity', namespaces: [LEDGER_NAMESPACE] },
  reservation: { authority: 'ledger_identity', namespaces: [LEDGER_NAMESPACE] },
  design: { authority: 'evidence_only', namespaces: ['design-system'] },
  design_version: { authority: 'evidence_only', namespaces: ['design-system'] },
  artifact: { authority: 'evidence_only', namespaces: ['design-system', 'creative-engine'] },
  artifact_hash: { authority: 'evidence_only', namespaces: ['design-system', 'creative-engine'], hash: true },
  repo_commit: { authority: 'evidence_only', namespaces: ['git'], commit: true },
  build: { authority: 'evidence_only', namespaces: ['git', 'ci'] },
  dev_session: { authority: 'evidence_only', namespaces: ['entire'] },
  checkpoint: { authority: 'evidence_only', namespaces: ['entire'] },
});

export function evidenceAuthority(kind: EvidenceKind): EvidenceAuthority {
  return KIND_POLICY[kind].authority;
}

const EvidenceKindSchema = Type.Union(EVIDENCE_KINDS.map(kind => Type.Literal(kind)));
/** No whitespace, control characters, slashes, query/fragment delimiters or credential separators: an id can never be a URL, URL path or query string. */
const EVIDENCE_ID_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._:=+-]{0,255}$';
const EvidenceIdSchema = Type.String({ pattern: EVIDENCE_ID_PATTERN, maxLength: 256 });
const NamespaceSchema = Type.String({ pattern: '^[a-z0-9][a-z0-9:_-]{0,63}$', maxLength: 64 });
export const UnavailableReasonSchema = Type.Union([
  Type.Literal('source_not_integrated'), Type.Literal('source_unreachable'), Type.Literal('access_denied'),
  Type.Literal('deleted'), Type.Literal('broken_link'),
]);
export const NotApplicableReasonSchema = Type.Union([
  Type.Literal('not_part_of_operation'), Type.Literal('not_generated_by_source'),
]);

/**
 * Explicit four-way distinction. Only `resolved` has an id; the other variants
 * reject any id or namespace, so a missing value can never be fabricated.
 */
export const EvidenceReferenceSchema = Type.Union([
  Type.Object({ status: Type.Literal('resolved'), kind: EvidenceKindSchema, namespace: NamespaceSchema, id: EvidenceIdSchema }, { additionalProperties: false }),
  Type.Object({ status: Type.Literal('unknown'), kind: EvidenceKindSchema }, { additionalProperties: false }),
  Type.Object({ status: Type.Literal('unavailable'), kind: EvidenceKindSchema, reason: UnavailableReasonSchema }, { additionalProperties: false }),
  Type.Object({ status: Type.Literal('not_applicable'), kind: EvidenceKindSchema, reason: NotApplicableReasonSchema }, { additionalProperties: false }),
]);
export type EvidenceReference = Static<typeof EvidenceReferenceSchema>;
export type ResolvedEvidenceReference = Extract<EvidenceReference, { status: 'resolved' }>;

function namespaceAllowed(kind: EvidenceKind, namespace: string): boolean {
  return KIND_POLICY[kind].namespaces.some(allowed => typeof allowed === 'string' ? allowed === namespace : allowed.test(namespace));
}

function idShapeAllowed(kind: EvidenceKind, id: string): boolean {
  const policy = KIND_POLICY[kind];
  if (policy.hash) return /^sha256:[a-f0-9]{64}$/.test(id);
  if (policy.commit) return /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(id);
  return true;
}

export function validateEvidenceReference(value: unknown): Validation<EvidenceReference> {
  const invalid = (): Validation<EvidenceReference> => ({
    ok: false,
    error: errorEnvelope('evidence', 'validateEvidenceReference', 'VALIDATION_ERROR', 'evidence-reference', 'Evidence reference failed validation.'),
  });
  if (!Value.Check(EvidenceReferenceSchema, value)) return invalid();
  const reference = value as EvidenceReference;
  if (reference.status === 'resolved'
      && (!namespaceAllowed(reference.kind, reference.namespace) || !idShapeAllowed(reference.kind, reference.id))) return invalid();
  return { ok: true, value: reference };
}

// ----- lookup ports (injected; this module opens no connection and persists nothing) -----

type IdentityFact =
  | { readonly status: 'known'; readonly id: string }
  | { readonly status: 'unknown' }
  | { readonly status: 'not_applicable' };

/** Minimal projection of an existing ledger row. Deliberately excludes event_payload and amounts. */
export interface EvidenceLedgerRecord {
  readonly scope: Pick<TrustedScope, 'tenantId' | 'projectId' | 'environment' | 'billingMode'>;
  readonly eventId: string;
  readonly eventType: string;
  readonly classification: string;
  readonly financialEffect: boolean;
  readonly correlationId: string;
  readonly logicalOperationId: string;
  readonly sourceObservationId: string;
  readonly reservationId: string | null;
  readonly transportAttempt: IdentityFact;
  readonly providerAttempt: IdentityFact;
  readonly providerRequest: IdentityFact;
  readonly billableAttempt: IdentityFact;
  /** Ledger `dimensions.provider`, used only to namespace a provider request id. */
  readonly provider: string | null;
  readonly workflowId: string | null;
  readonly jobId: string | null;
  readonly pricing: { readonly policyVersion: string; readonly ruleVersion: string; readonly rateCardRef: { readonly contract: string; readonly id: string; readonly revision: number; readonly content_hash: string } | null } | null;
  readonly supersedesEventId: string | null;
  readonly reversesEventId: string | null;
}

export type EvidenceStoreRead<T> = { readonly status: 'ok'; readonly value: T } | { readonly status: 'unavailable' };

/** Every method must filter by the supplied scope; callers additionally re-verify returned scopes. */
export interface EvidenceLinkStorePort {
  getPosting(scope: TrustedScope, eventId: string): Promise<EvidenceStoreRead<EvidenceLedgerRecord | null>>;
  listByLogicalOperation(scope: TrustedScope, logicalOperationId: string, limit: number): Promise<EvidenceStoreRead<{ readonly records: readonly EvidenceLedgerRecord[]; readonly truncated: boolean }>>;
  findByReference(scope: TrustedScope, reference: ResolvedEvidenceReference & { readonly kind: ReverseLookupKind }, limit: number): Promise<EvidenceStoreRead<{ readonly records: readonly EvidenceLedgerRecord[]; readonly truncated: boolean }>>;
}

export interface EvidenceRuntimePorts {
  readonly store: EvidenceLinkStorePort;
  readonly clock: Clock;
  /** Missing configuration denies every lookup. */
  readonly financeAuthority?: FinanceAuthorizationPort;
}

const MAX_RESULTS = 50;

/** Reference kinds that can be looked up in the existing ledger identity model. */
export const REVERSE_LOOKUP_KINDS = Object.freeze([
  'logical_operation', 'billable_attempt', 'transport_attempt', 'provider_attempt', 'provider_request',
  'source_observation', 'reservation', 'correlation', 'workflow', 'job',
] as const);
export type ReverseLookupKind = (typeof REVERSE_LOOKUP_KINDS)[number];

export const EvidenceGapCodeSchema = Type.Union([
  Type.Literal('source_observations_unavailable'),
  Type.Literal('result_limit_reached'),
  Type.Literal('reconciliation_lineage_not_linked'),
  Type.Literal('adjustment_lineage_not_linked'),
  Type.Literal('export_lineage_not_linked'),
  Type.Literal('rate_card_not_recorded'),
  Type.Literal('pricing_not_recorded'),
  Type.Literal('reference_kinds_not_indexed'),
  Type.Literal('no_match_is_not_proof_of_zero_usage'),
  Type.Literal('correlation_only_match'),
  Type.Literal('malformed_source_field'),
  Type.Literal('store_unavailable'),
]);
export type EvidenceGapCode = Static<typeof EvidenceGapCodeSchema>;

const LookupBaseProperties = {
  schemaVersion: Type.Literal(EVIDENCE_REFERENCE_SCHEMA_VERSION),
  requestId: Type.String({ minLength: 1, maxLength: 128 }),
  scope: TrustedScopeSchema,
};
export const PostingEvidenceRequestSchema = Type.Object({
  ...LookupBaseProperties, eventId: EvidenceIdSchema,
}, { additionalProperties: false });
export type PostingEvidenceRequest = Static<typeof PostingEvidenceRequestSchema>;
export const ReverseEvidenceRequestSchema = Type.Object({
  ...LookupBaseProperties, reference: EvidenceReferenceSchema,
}, { additionalProperties: false });
export type ReverseEvidenceRequest = Static<typeof ReverseEvidenceRequestSchema>;

export interface LinkedRecordSummary {
  readonly eventId: string;
  readonly eventType: string | null;
  readonly classification: string | null;
  readonly financialEffect: boolean | null;
  readonly sourceObservationId: string | null;
}
export interface RateCardReference {
  readonly contract: string;
  readonly id: string;
  readonly revision: number;
  readonly content_hash: string;
}
export interface RateRuleEvidence {
  readonly policyVersion: string | null;
  readonly ruleVersion: string | null;
  readonly rateCardRef: RateCardReference | null;
}
export interface PostingEvidence {
  readonly schemaVersion: typeof EVIDENCE_REFERENCE_SCHEMA_VERSION;
  readonly status: 'found' | 'not_found';
  /** `not_found` covers both absent and not visible in this scope; the two are indistinguishable by design. */
  readonly posting: LinkedRecordSummary | null;
  readonly sourceObservations: readonly LinkedRecordSummary[];
  readonly reservation: EvidenceReference | null;
  readonly rateRule: RateRuleEvidence | null;
  readonly operationalReferences: readonly EvidenceReference[];
  readonly relatedEventIds: { readonly supersedes: string | null; readonly reverses: string | null };
  readonly gaps: readonly EvidenceGapCode[];
  /** Constant: no reference returned here confers billing or charge authority. */
  readonly billingAuthority: false;
}
export interface ReverseEvidence {
  readonly schemaVersion: typeof EVIDENCE_REFERENCE_SCHEMA_VERSION;
  readonly matchBasis: EvidenceAuthority;
  readonly matches: readonly LinkedRecordSummary[];
  readonly gaps: readonly EvidenceGapCode[];
  readonly billingAuthority: false;
}

const NOT_INTEGRATED: readonly EvidenceKind[] = ['trace', 'run', 'design', 'design_version', 'artifact', 'artifact_hash', 'repo_commit', 'build', 'dev_session', 'checkpoint'];

const ID_RE = new RegExp(EVIDENCE_ID_PATTERN);
const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const HASH_RE = /^sha256:[a-f0-9]{64}$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function safeString(value: unknown, pattern: RegExp): string | null {
  return typeof value === 'string' && value.length <= 256 && pattern.test(value) ? value : null;
}
function safeId(value: unknown): string | null { return safeString(value, ID_RE); }

/** Explicit allowlist projection. Returns null when the eventId itself is unsafe; other malformed fields become null and set `malformed`. */
function summarize(record: unknown, malformed: { value: boolean }): LinkedRecordSummary | null {
  if (!isObject(record)) return null;
  const eventId = safeId(record.eventId);
  if (eventId === null) return null;
  const pick = <T>(value: T | null, present: unknown): T | null => { if (value === null && present !== null) malformed.value = true; return value; };
  return {
    eventId,
    eventType: pick(safeString(record.eventType, LABEL_RE), record.eventType),
    classification: pick(safeString(record.classification, LABEL_RE), record.classification),
    financialEffect: typeof record.financialEffect === 'boolean' ? record.financialEffect : null,
    sourceObservationId: pick(safeId(record.sourceObservationId), record.sourceObservationId),
  };
}

function projectRateRule(pricing: unknown, malformed: { value: boolean }): RateRuleEvidence | null {
  if (!isObject(pricing)) { if (pricing !== null) malformed.value = true; return null; }
  const policyVersion = safeString(pricing.policyVersion, VERSION_RE);
  const ruleVersion = safeString(pricing.ruleVersion, VERSION_RE);
  if (policyVersion === null || ruleVersion === null) malformed.value = true;
  let rateCardRef: RateCardReference | null = null;
  const raw = pricing.rateCardRef;
  if (raw !== null && raw !== undefined) {
    const contract = isObject(raw) ? safeString(raw.contract, LABEL_RE) : null;
    const id = isObject(raw) ? safeId(raw.id) : null;
    const hash = isObject(raw) ? safeString(raw.content_hash, HASH_RE) : null;
    const revision = isObject(raw) && Number.isInteger(raw.revision) && (raw.revision as number) >= 0 ? raw.revision as number : null;
    if (contract !== null && id !== null && hash !== null && revision !== null) rateCardRef = { contract, id, revision, content_hash: hash };
    else malformed.value = true;
  }
  return { policyVersion, ruleVersion, rateCardRef };
}

function fromIdentity(kind: EvidenceKind, fact: IdentityFact, namespace: string): EvidenceReference {
  if (!isObject(fact)) return { status: 'unavailable', kind, reason: 'broken_link' };
  if (fact.status === 'known') {
    const candidate = { status: 'resolved', kind, namespace, id: fact.id };
    const checked = validateEvidenceReference(candidate);
    // An existing fact that no longer satisfies the reference policy is a broken link, not a value to repair.
    return checked.ok ? checked.value : { status: 'unavailable', kind, reason: 'broken_link' };
  }
  if (fact.status === 'unknown') return { status: 'unknown', kind };
  if (fact.status === 'not_applicable') return { status: 'not_applicable', kind, reason: 'not_part_of_operation' };
  return { status: 'unavailable', kind, reason: 'broken_link' };
}

function providerNamespace(provider: string | null): string {
  // An unusable provider name yields a namespace the policy rejects, which surfaces as a broken link rather than a guess.
  return typeof provider === 'string' ? `provider:${provider.toLowerCase()}` : 'provider:';
}

function optionalId(kind: EvidenceKind, id: string | null, namespace: string): EvidenceReference {
  return id === null || id === undefined ? { status: 'unknown', kind } : fromIdentity(kind, { status: 'known', id }, namespace);
}

/** Build the typed reference set for one ledger record. Nothing is invented: absent facts become unknown, integrated-nowhere kinds unavailable. */
export function operationalReferencesFor(record: EvidenceLedgerRecord): EvidenceReference[] {
  const refs: EvidenceReference[] = [
    fromIdentity('correlation', { status: 'known', id: record.correlationId }, LEDGER_NAMESPACE),
    fromIdentity('logical_operation', { status: 'known', id: record.logicalOperationId }, LEDGER_NAMESPACE),
    fromIdentity('source_observation', { status: 'known', id: record.sourceObservationId }, LEDGER_NAMESPACE),
    fromIdentity('transport_attempt', record.transportAttempt, LEDGER_NAMESPACE),
    fromIdentity('provider_attempt', record.providerAttempt, LEDGER_NAMESPACE),
    fromIdentity('billable_attempt', record.billableAttempt, LEDGER_NAMESPACE),
    fromIdentity('provider_request', record.providerRequest, providerNamespace(record.provider)),
    record.reservationId === null || record.reservationId === undefined
      ? { status: 'not_applicable', kind: 'reservation', reason: 'not_part_of_operation' }
      : fromIdentity('reservation', { status: 'known', id: record.reservationId }, LEDGER_NAMESPACE),
    optionalId('workflow', record.workflowId, LEDGER_NAMESPACE),
    optionalId('job', record.jobId, LEDGER_NAMESPACE),
    ...NOT_INTEGRATED.map((kind): EvidenceReference => ({ status: 'unavailable', kind, reason: 'source_not_integrated' })),
  ];
  return refs;
}

function recordInScope(record: EvidenceLedgerRecord, scope: TrustedScope): boolean {
  return isObject(record) && isObject(record.scope) && record.scope.tenantId === scope.tenantId && record.scope.projectId === scope.projectId
    && record.scope.environment === scope.environment && record.scope.billingMode === scope.billingMode;
}

/** A returned row matches only if one of its own resolved references equals the requested kind, namespace and id exactly. */
function recordHasReference(record: EvidenceLedgerRecord, wanted: ResolvedEvidenceReference): boolean {
  return operationalReferencesFor(record).some(ref => ref.status === 'resolved'
    && ref.kind === wanted.kind && ref.namespace === wanted.namespace && ref.id === wanted.id);
}

async function authorize(request: { requestId: string; scope: TrustedScope }, ports: EvidenceRuntimePorts) {
  // Reads reuse the existing ledger snapshot read grant; no new permission is introduced by this slice.
  return authorizeFinanceOperation({
    module: 'ledger', requestOperation: 'authorizeFinanceOperation', operation: 'ledger.readSnapshot',
    scope: request.scope, requestId: request.requestId, clock: ports.clock, financeAuthority: ports.financeAuthority,
  });
}

/** A membership/service revision change invalidates a multi-read lookup, even if access was restored. */
function principalRevision(authorization: FinanceAuthorizationResult): string | null {
  if (!authorization.ok || authorization.decision.status !== 'allowed' || !('principal' in authorization.decision)) return null;
  const principal = authorization.decision.principal;
  return JSON.stringify(principal.kind === 'user'
    ? [principal.kind, principal.actorId, principal.membershipRevision]
    : [principal.kind, principal.actorId, principal.serviceGrantRevision]);
}

async function reauthorize(request: { requestId: string; scope: TrustedScope }, ports: EvidenceRuntimePorts, revision: string | null) {
  const current = await authorize(request, ports);
  if (!current.ok) return current;
  if (revision === null || principalRevision(current) !== revision) return {
    ok: false as const,
    error: errorEnvelope('evidence', 'authorizeFinanceOperation', 'FORBIDDEN_SCOPE', request.requestId, 'Current financial authorization changed during the evidence lookup.'),
  };
  return current;
}

function validate<T extends PostingEvidenceRequest | ReverseEvidenceRequest>(schema: typeof PostingEvidenceRequestSchema | typeof ReverseEvidenceRequestSchema, value: unknown, operation: string): Validation<T> {
  if (!Value.Check(schema, value)) {
    return { ok: false, error: errorEnvelope('evidence', operation, 'VALIDATION_ERROR', 'evidence-request', 'The evidence lookup request is invalid.') };
  }
  // Detach caller-owned scope/identity fields before the first authority or store await.
  const snapshot = Value.Clone(value) as T;
  Object.freeze(snapshot.scope);
  if ('reference' in snapshot) Object.freeze(snapshot.reference);
  return { ok: true, value: Object.freeze(snapshot) };
}

async function guarded<T>(read: () => Promise<EvidenceStoreRead<T>>): Promise<EvidenceStoreRead<T>> {
  // A store may retain its returned objects. Do not let a later await substitute
  // already scope-checked ledger facts or output fields through those aliases.
  try { return Value.Clone(await read()); } catch { return { status: 'unavailable' }; }
}

/**
 * Authorized lookup from one financial posting to its source observations, reservation,
 * rate/rule versions and operational references. Absent and cross-scope postings are
 * indistinguishable (`not_found`). Reconciliation, adjustment and export lineage are
 * declared gaps in this slice, never silently empty.
 */
export async function lookupPostingEvidence(value: unknown, ports: EvidenceRuntimePorts): Promise<ApiResult<PostingEvidence>> {
  const validated = validate<PostingEvidenceRequest>(PostingEvidenceRequestSchema, value, 'lookupPostingEvidence');
  if (!validated.ok) return failure(validated.error);
  const request = validated.value;
  const authorization = await authorize(request, ports);
  if (!authorization.ok) return failure(authorization.error);
  const revision = principalRevision(authorization);

  const notFound = (gaps: EvidenceGapCode[]): ApiResult<PostingEvidence> => ({
    ok: true,
    value: { schemaVersion: EVIDENCE_REFERENCE_SCHEMA_VERSION, status: 'not_found', posting: null, sourceObservations: [], reservation: null, rateRule: null,
      operationalReferences: [], relatedEventIds: { supersedes: null, reverses: null }, gaps, billingAuthority: false },
  });
  const posting = await guarded(() => ports.store.getPosting(request.scope, request.eventId));
  // Also gate absent/unavailable results; stale access must not reveal existence
  // or trigger a second protected storage operation.
  const afterPosting = await reauthorize(request, ports, revision);
  if (!afterPosting.ok) return failure(afterPosting.error);
  if (posting.status === 'unavailable') return failure(errorEnvelope('evidence', 'lookupPostingEvidence', 'SOURCE_UNAVAILABLE', request.requestId, 'Evidence source is temporarily unavailable.', true));
  const record = posting.value;
  if (record === null || !recordInScope(record, request.scope) || record.eventId !== request.eventId) {
    return notFound(['no_match_is_not_proof_of_zero_usage']);
  }

  const gaps: EvidenceGapCode[] = ['reconciliation_lineage_not_linked', 'adjustment_lineage_not_linked', 'export_lineage_not_linked', 'reference_kinds_not_indexed'];
  const malformed = { value: false };
  const logicalOperationId = safeId(record.logicalOperationId);
  let sourceObservations: LinkedRecordSummary[] = [];
  if (logicalOperationId === null) {
    malformed.value = true;
    gaps.push('source_observations_unavailable');
  } else {
    const linked = await guarded(() => ports.store.listByLogicalOperation(request.scope, logicalOperationId, MAX_RESULTS));
    const afterLinked = await reauthorize(request, ports, revision);
    if (!afterLinked.ok) return failure(afterLinked.error);
    if (linked.status === 'unavailable' || !Array.isArray(linked.value?.records)) {
      gaps.push('source_observations_unavailable');
    } else {
      for (const item of linked.value.records) {
        if (!recordInScope(item, request.scope) || item.logicalOperationId !== logicalOperationId || item.eventType !== 'usage_observation') continue;
        const projected = summarize(item, malformed);
        if (projected === null) malformed.value = true; else sourceObservations.push(projected);
      }
      if (linked.value.truncated === true) gaps.push('result_limit_reached');
    }
  }
  const posted = summarize(record, malformed);
  if (posted === null) return notFound(['malformed_source_field']);
  const rateRule = projectRateRule(record.pricing ?? null, malformed);
  if (rateRule === null) gaps.push('pricing_not_recorded');
  else if (rateRule.rateCardRef === null) gaps.push('rate_card_not_recorded');

  const reservation: EvidenceReference = record.reservationId === null || record.reservationId === undefined
    ? { status: 'not_applicable', kind: 'reservation', reason: 'not_part_of_operation' }
    : fromIdentity('reservation', { status: 'known', id: record.reservationId }, LEDGER_NAMESPACE);
  const related = (id: unknown): string | null => {
    if (id === null || id === undefined) return null;
    const safe = safeId(id);
    if (safe === null) malformed.value = true;
    return safe;
  };
  const relatedEventIds = { supersedes: related(record.supersedesEventId), reverses: related(record.reversesEventId) };
  const operationalReferences = operationalReferencesFor(record);
  if (malformed.value || operationalReferences.some(ref => ref.status === 'unavailable' && ref.reason === 'broken_link')) gaps.push('malformed_source_field');

  return {
    ok: true,
    value: {
      schemaVersion: EVIDENCE_REFERENCE_SCHEMA_VERSION, status: 'found', posting: posted, sourceObservations, reservation,
      rateRule, operationalReferences, relatedEventIds, gaps, billingAuthority: false,
    },
  };
}

/**
 * Reverse lookup by a validated, resolved operational reference. Scope is applied by the store and
 * re-verified here. Matches are links only: no amounts are returned or summed, so repeated
 * observations of one reference cannot add expense. An empty result is not proof of zero usage.
 */
export async function lookupByOperationalReference(value: unknown, ports: EvidenceRuntimePorts): Promise<ApiResult<ReverseEvidence>> {
  const validated = validate<ReverseEvidenceRequest>(ReverseEvidenceRequestSchema, value, 'lookupByOperationalReference');
  if (!validated.ok) return failure(validated.error);
  const request = validated.value;
  const checked = validateEvidenceReference(request.reference);
  const reference = checked.ok ? checked.value : null;
  if (reference === null || reference.status !== 'resolved' || !(REVERSE_LOOKUP_KINDS as readonly string[]).includes(reference.kind)) {
    return failure(errorEnvelope('evidence', 'lookupByOperationalReference', 'VALIDATION_ERROR', request.requestId, 'The reference is not a resolved, indexed operational reference.'));
  }
  const authorization = await authorize(request, ports);
  if (!authorization.ok) return failure(authorization.error);
  const revision = principalRevision(authorization);

  const kind = reference.kind as ReverseLookupKind;
  const wanted = Object.freeze({ status: 'resolved', kind, namespace: reference.namespace, id: reference.id } as const);
  const found = await guarded(() => ports.store.findByReference(request.scope, wanted, MAX_RESULTS));
  const afterRead = await reauthorize(request, ports, revision);
  if (!afterRead.ok) return failure(afterRead.error);
  if (found.status === 'unavailable') return failure(errorEnvelope('evidence', 'lookupByOperationalReference', 'SOURCE_UNAVAILABLE', request.requestId, 'Evidence source is temporarily unavailable.', true));

  const gaps: EvidenceGapCode[] = ['reconciliation_lineage_not_linked', 'export_lineage_not_linked', 'reference_kinds_not_indexed'];
  const malformed = { value: false };
  const matches: LinkedRecordSummary[] = [];
  const returned: unknown = found.value?.records;
  for (const item of Array.isArray(returned) ? returned : []) {
    // Defense in depth: a permissive store cannot widen the query past scope, kind, namespace or id.
    if (!recordInScope(item, request.scope) || !recordHasReference(item, wanted)) continue;
    const projected = summarize(item, malformed);
    if (projected === null) malformed.value = true; else matches.push(projected);
  }
  if (malformed.value) gaps.push('malformed_source_field');
  if (found.value?.truncated === true) gaps.push('result_limit_reached');
  if (matches.length === 0) gaps.push('no_match_is_not_proof_of_zero_usage');
  const basis = evidenceAuthority(kind);
  if (basis === 'correlation_only') gaps.push('correlation_only_match');
  return { ok: true, value: { schemaVersion: EVIDENCE_REFERENCE_SCHEMA_VERSION, matchBasis: basis, matches, gaps, billingAuthority: false } };
}
