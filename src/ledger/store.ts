import { Type, type Static, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import {
  authorizeFinanceOperation,
  CurrencySchema,
  DecimalAmountSchema,
  NonNegativeDecimalAmountSchema,
  TrustedScopeSchema,
  errorEnvelope,
  failure,
  sameScope,
  validateRequest,
  type ApiResult,
  type Clock,
  type ErrorEnvelope,
  type FinanceAuthorizationDecision,
  type FinanceAuthorizationPort,
  type FinanceOperation,
  type TrustedContextPort,
  type TrustedScope,
  type Validation,
} from '../shared/contracts.js';
import { bindFinancialDatabaseScope } from '../shared/database-scope.js';

const LocalVersion = Type.Literal('1.0.0');
const UtcTimestamp = Type.String({ format: 'date-time' });
const ProjectionAsOfTimestamp = Type.String({
  format: 'date-time',
  pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,6})?Z$',
});
const Sha256Reference = Type.String({ pattern: '^sha256:[a-f0-9]{64}$' });
const RevisionHash = Type.String({ pattern: '^[a-f0-9]{40}$' });
const Identifier = Type.String({ minLength: 1, maxLength: 256 });
const UpstreamIdentitySchema = Type.Union([
  Type.Object({ status: Type.Literal('known'), id: Identifier }, { additionalProperties: false }),
  Type.Object({ status: Type.Literal('unknown') }, { additionalProperties: false }),
  Type.Object({ status: Type.Literal('not_applicable') }, { additionalProperties: false }),
]);
type UpstreamIdentity = Static<typeof UpstreamIdentitySchema>;
const VersionedEvidenceRefSchema = Type.Object({
  contract: Type.String({ minLength: 1, maxLength: 128 }),
  schema_version: Type.String({ minLength: 1, maxLength: 32 }),
  id: Identifier,
  revision: Type.Integer({ minimum: 0 }),
  content_hash: Sha256Reference,
}, { additionalProperties: false });

export const LedgerEventTypeSchema = Type.Union([
  Type.Literal('usage_observation'), Type.Literal('reservation_authorized'), Type.Literal('dispatch'),
  Type.Literal('charge'), Type.Literal('consumption'), Type.Literal('reservation_release'), Type.Literal('expense'),
  Type.Literal('revenue'), Type.Literal('refund'), Type.Literal('credit'), Type.Literal('discount'), Type.Literal('fee'),
  Type.Literal('tax'), Type.Literal('reimbursement'), Type.Literal('cash_movement'), Type.Literal('reversal'),
  Type.Literal('adjustment'), Type.Literal('correction'),
]);
export type LedgerEventType = Static<typeof LedgerEventTypeSchema>;

export const LedgerClassificationSchema = Type.Union([
  Type.Literal('sale'), Type.Literal('discount'), Type.Literal('sale_refund'), Type.Literal('pass_through_tax'),
  Type.Literal('supplier_credit'), Type.Literal('supplier_expense'), Type.Literal('reimbursement'),
  Type.Literal('payout_transfer'), Type.Literal('direct_cost'), Type.Literal('operating_expense'),
  Type.Literal('operating_revenue'), Type.Literal('award_grant'), Type.Literal('capital_funding'),
  Type.Literal('sponsorship'), Type.Literal('in_kind_support'), Type.Literal('payable_labor'),
  Type.Literal('reservation_memo'), Type.Literal('usage_memo'),
]);
export type LedgerClassification = Static<typeof LedgerClassificationSchema>;

const LedgerAppendRequestBaseSchema = Type.Object({
  schemaVersion: LocalVersion,
  requestId: Type.String({ minLength: 1, maxLength: 128 }),
  idempotencyKey: Type.String({ minLength: 1, maxLength: 200 }),
  scope: TrustedScopeSchema,
  eventId: Identifier,
  correlationId: Identifier,
  producer: Type.Object({
    module: Type.String({ minLength: 1, maxLength: 128 }),
    sourceRevision: RevisionHash,
    buildRevision: Type.String({ minLength: 1, maxLength: 128 }),
  }, { additionalProperties: false }),
  occurredAt: UtcTimestamp,
  observedAt: UtcTimestamp,
  evidenceMode: Type.Union([Type.Literal('mocked'), Type.Literal('sandbox'), Type.Literal('live')]),
  verificationStatus: Type.Union([Type.Literal('verified'), Type.Literal('unverified'), Type.Literal('unknown')]),
  eventType: LedgerEventTypeSchema,
  classification: LedgerClassificationSchema,
  valuation: Type.Union([Type.Literal('unknown'), Type.Literal('estimated'), Type.Literal('provider_confirmed'), Type.Literal('provider_reported_unsettled')]),
  settlementStatus: Type.Union([Type.Literal('unpaid'), Type.Literal('partly_paid'), Type.Literal('paid')]),
  reconciliationStatus: Type.Union([Type.Literal('unmatched'), Type.Literal('matched'), Type.Literal('exception')]),
  reservationLifecycle: Type.Union([
    Type.Literal('held'), Type.Literal('dispatched'), Type.Literal('outcome_unknown'), Type.Literal('partially_settled'),
    Type.Literal('settled'), Type.Literal('released'), Type.Literal('expired'), Type.Literal('held_for_reconciliation'),
    Type.Null(),
  ]),
  identities: Type.Object({
    logicalOperationId: Identifier,
    sourceObservationId: Identifier,
    reservationId: Type.Union([Identifier, Type.Null()]),
  }, { additionalProperties: false }),
  postingMapping: Type.Object({
    schemaVersion: LocalVersion,
    sourceLineId: Identifier,
    transportAttemptId: UpstreamIdentitySchema,
    providerAttemptId: UpstreamIdentitySchema,
    providerRequestId: UpstreamIdentitySchema,
    billableAttemptId: UpstreamIdentitySchema,
  }, { additionalProperties: false }),
  sourceIdentity: Type.Object({
    source: Type.String({ minLength: 1, maxLength: 120 }),
    sourceEventId: Identifier,
    sourceObjectId: Identifier,
    revisionSubjectId: Identifier,
    sourceRevision: Type.String({ minLength: 1, maxLength: 128 }),
    revisionSequence: Type.Integer({ minimum: 0, maximum: 2147483647 }),
    contentHash: Sha256Reference,
  }, { additionalProperties: false }),
  usage: Type.Object({
    completeness: Type.Union([Type.Literal('unknown'), Type.Literal('incomplete'), Type.Literal('complete')]),
    missingFields: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 100 }),
    units: Type.Array(Type.Object({
      name: Type.String({ minLength: 1, maxLength: 128 }),
      quantity: Type.Union([NonNegativeDecimalAmountSchema, Type.Null()]),
      scale: Type.Integer({ minimum: 0, maximum: 18 }),
      relation: Type.Union([Type.Literal('standalone'), Type.Literal('included_subset'), Type.Literal('unknown_relation')]),
      includedIn: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    }, { additionalProperties: false }), { maxItems: 100 }),
  }, { additionalProperties: false }),
  money: Type.Object({
    amount: Type.Union([DecimalAmountSchema, Type.Null()]),
    currency: CurrencySchema,
    scale: Type.Integer({ minimum: 0, maximum: 18 }),
  }, { additionalProperties: false }),
  sourceRefs: Type.Array(VersionedEvidenceRefSchema, { maxItems: 100 }),
  dimensions: Type.Object({
    repo: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    feature: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    category: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    provider: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    model: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    workflowId: Type.Optional(Identifier),
    jobId: Type.Optional(Identifier),
    orderId: Type.Optional(Identifier),
    channel: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  }, { additionalProperties: false }),
  pricing: Type.Union([Type.Object({
    policyVersion: Type.String({ minLength: 1, maxLength: 64 }),
    ruleVersion: Type.String({ minLength: 1, maxLength: 64 }),
    rateCardRef: Type.Union([VersionedEvidenceRefSchema, Type.Null()]),
  }, { additionalProperties: false }), Type.Null()]),
  fxEvidence: Type.Union([Type.Object({
    sourceRef: VersionedEvidenceRefSchema,
    sourceCurrency: CurrencySchema,
    targetCurrency: CurrencySchema,
    rate: NonNegativeDecimalAmountSchema,
    effectiveAt: UtcTimestamp,
  }, { additionalProperties: false }), Type.Null()]),
  financialEffect: Type.Boolean(),
  reservationAuthorizationEventId: Type.Union([Identifier, Type.Null()]),
  supersedesEventId: Type.Union([Identifier, Type.Null()]),
  reversesEventId: Type.Union([Identifier, Type.Null()]),
}, { additionalProperties: false });

function eventVariant<const EventType extends LedgerEventType, const Effect extends boolean>(
  eventType: EventType,
  financialEffect: Effect,
  reservationLifecycle?: TSchema,
) {
  return Type.Object({
    ...LedgerAppendRequestBaseSchema.properties,
    eventType: Type.Literal(eventType),
    financialEffect: Type.Literal(financialEffect),
    ...(reservationLifecycle ? { reservationLifecycle } : {}),
  }, { additionalProperties: false });
}

/** Versioned discriminated event union. Observation/reservation facts cannot post recognized money. */
export const LedgerAppendRequestSchema = Type.Union([
  eventVariant('usage_observation', false, Type.Null()),
  eventVariant('reservation_authorized', false, Type.Literal('held')),
  eventVariant('dispatch', false, Type.Literal('dispatched')),
  eventVariant('reservation_release', false, Type.Union([
    Type.Literal('released'), Type.Literal('expired'),
  ])),
  eventVariant('charge', true),
  eventVariant('consumption', true),
  eventVariant('expense', true),
  eventVariant('revenue', true),
  eventVariant('refund', true),
  eventVariant('credit', true),
  eventVariant('discount', true),
  eventVariant('fee', true),
  eventVariant('tax', true),
  eventVariant('reimbursement', true),
  eventVariant('cash_movement', true),
  eventVariant('reversal', true),
  eventVariant('adjustment', true),
  eventVariant('correction', true),
]);
export type LedgerAppendRequest = Static<typeof LedgerAppendRequestSchema>;

export const LedgerAppendReceiptSchema = Type.Object({
  schemaVersion: LocalVersion,
  requestId: Type.String({ minLength: 1, maxLength: 128 }),
  status: Type.Union([Type.Literal('accepted'), Type.Literal('duplicate'), Type.Literal('conflict'), Type.Literal('stale_revision')]),
  eventId: Identifier,
  existingEventId: Type.Union([Identifier, Type.Null()]),
  durableCommit: Type.Boolean(),
  ingestedAt: Type.Union([UtcTimestamp, Type.Null()]),
}, { additionalProperties: false });
export type LedgerAppendReceipt = Static<typeof LedgerAppendReceiptSchema>;

export const LedgerProjectionRequestSchema = Type.Object({
  schemaVersion: LocalVersion,
  requestId: Type.String({ minLength: 1, maxLength: 128 }),
  scope: TrustedScopeSchema,
  asOf: ProjectionAsOfTimestamp,
}, { additionalProperties: false });
export type LedgerProjectionRequest = Static<typeof LedgerProjectionRequestSchema>;

const ProjectionAmountSchema = Type.Object({
  eventType: LedgerEventTypeSchema,
  classification: LedgerClassificationSchema,
  currency: CurrencySchema,
  eventCount: Type.Integer({ minimum: 1 }),
  knownAmountCount: Type.Integer({ minimum: 0 }),
  unknownAmountCount: Type.Integer({ minimum: 0 }),
  knownSubtotal: Type.Union([DecimalAmountSchema, Type.Null()]),
  totalAmount: Type.Union([DecimalAmountSchema, Type.Null()]),
  completeness: Type.Union([Type.Literal('unknown'), Type.Literal('partial'), Type.Literal('complete')]),
}, { additionalProperties: false });
const ProjectionQuantitySchema = Type.Object({
  eventType: LedgerEventTypeSchema,
  classification: LedgerClassificationSchema,
  currency: CurrencySchema,
  unitName: Type.Union([Type.String({ minLength: 1, maxLength: 128 }), Type.Null()]),
  relation: Type.Union([Type.Literal('standalone'), Type.Literal('included_subset'), Type.Literal('unknown_relation'), Type.Null()]),
  includedIn: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  observationCount: Type.Integer({ minimum: 1 }),
  knownQuantityCount: Type.Integer({ minimum: 0 }),
  unknownQuantityCount: Type.Integer({ minimum: 0 }),
  incompleteObservationCount: Type.Integer({ minimum: 0 }),
  knownSubtotal: Type.Union([NonNegativeDecimalAmountSchema, Type.Null()]),
  totalQuantity: Type.Union([NonNegativeDecimalAmountSchema, Type.Null()]),
  completeness: Type.Union([Type.Literal('unknown'), Type.Literal('incomplete'), Type.Literal('complete')]),
}, { additionalProperties: false });
const ProjectionUnresolvedIntakeSchema = Type.Object({
  unknownEconomicExposureCount: Type.Integer({ minimum: 0 }),
  quarantinedObservationCount: Type.Integer({ minimum: 0 }),
  awaitingEvidenceAttemptCount: Type.Integer({ minimum: 0 }),
  unpostedAttemptCount: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false });

export const LedgerProjectionSchema = Type.Object({
  schemaVersion: LocalVersion,
  snapshotId: Sha256Reference,
  projectionHash: Sha256Reference,
  scope: TrustedScopeSchema,
  asOf: UtcTimestamp,
  eventCount: Type.Integer({ minimum: 0 }),
  amounts: Type.Array(ProjectionAmountSchema),
  quantities: Type.Array(ProjectionQuantitySchema),
  unresolvedIntake: Type.Optional(ProjectionUnresolvedIntakeSchema),
}, { additionalProperties: false });
export type LedgerProjection = Static<typeof LedgerProjectionSchema>;

export interface LedgerQueryResult {
  readonly rows: readonly Record<string, unknown>[];
  readonly rowCount: number | null;
}

/** Structural subset implemented by a node-postgres PoolClient. */
export interface LedgerTransactionPort {
  query(text: string, values?: readonly unknown[]): Promise<LedgerQueryResult>;
  release(): void;
}

/** Inject an existing host-managed pool; this module never creates a hidden connection. */
export interface LedgerDatabasePort {
  connect(): Promise<LedgerTransactionPort>;
}

export interface LedgerRuntimePorts {
  readonly database: LedgerDatabasePort;
  readonly trustedContext: TrustedContextPort;
  readonly clock: Clock;
  /** Current operation-scoped host authority; missing configuration denies writes and reads. */
  readonly financeAuthority?: FinanceAuthorizationPort;
  readonly sourceCollector?:import('../budgets/evidence.js').BudgetCollectorBackend;
  readonly reportedCostContractMode?:'development_0_10_1'|'finance_collector_v1';
}

type LedgerScope = Pick<TrustedScope, 'tenantId' | 'projectId' | 'environment' | 'billingMode'>;
type BindingKind = 'logical_operation' | 'transport_attempt' | 'provider_attempt' | 'provider_request' | 'billable_attempt' | 'source_observation' | 'reservation';
type Binding = { kind: BindingKind; value: string };

function makeError(module: string, operation: string, code: ErrorEnvelope['code'], requestId: string, message: string): ErrorEnvelope {
  return errorEnvelope(module, operation, code, requestId, message);
}

/** Expense axis follows authenticated ledger lineage; cash and payout movements never offset expense. */
export function budgetExpenseAxisSql(alias: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(alias)) throw new Error('Invalid internal ledger alias.');
  return `(WITH RECURSIVE axis AS (
    SELECT ${alias}.economic_event_type AS kind, ${alias}.economic_reverses_event_id AS target, ARRAY[${alias}.event_id]::text[] AS path
    UNION ALL SELECT root.economic_event_type,root.economic_reverses_event_id,axis.path||root.event_id
    FROM axis JOIN cost_intelligence.financial_ledger_events root ON root.event_id=axis.target
      AND root.tenant_id=${alias}.tenant_id AND root.project_id=${alias}.project_id
      AND root.environment=${alias}.environment AND root.billing_mode=${alias}.billing_mode AND root.currency=${alias}.currency
      AND root.classification=${alias}.classification AND root.financial_effect
    WHERE axis.kind='reversal' AND cardinality(axis.path)<33 AND NOT root.event_id=ANY(axis.path)
  ) SELECT kind FROM axis WHERE kind<>'reversal' LIMIT 1)`;
}
export function budgetExpenseSql(alias: string): string {
  return `${alias}.financial_effect AND ${alias}.classification IN ('direct_cost','supplier_expense','operating_expense','payable_labor')
    AND ${budgetExpenseAxisSql(alias)} IN ('consumption','charge','expense','fee','tax','refund','credit','discount','reimbursement')`;
}
export function budgetCurrentLedgerHeadSql(alias: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(alias)) throw new Error('Invalid internal ledger alias.');
  return `EXISTS (SELECT 1 FROM cost_intelligence.financial_source_revision_heads h WHERE h.current_event_id=${alias}.event_id
    AND h.tenant_id=${alias}.tenant_id AND h.project_id=${alias}.project_id AND h.environment=${alias}.environment
    AND h.billing_mode=${alias}.billing_mode AND h.source_name=${alias}.source_name AND h.source_object_id=${alias}.source_object_id
    AND h.source_revision_subject_id=${alias}.source_revision_subject_id)
    AND NOT EXISTS (SELECT 1 FROM cost_intelligence.financial_ledger_events n WHERE n.supersedes_event_id=${alias}.event_id
      AND n.tenant_id=${alias}.tenant_id AND n.project_id=${alias}.project_id AND n.environment=${alias}.environment
      AND n.billing_mode=${alias}.billing_mode AND n.currency=${alias}.currency AND n.classification=${alias}.classification
      AND n.economic_root_event_id=${alias}.economic_root_event_id AND n.source_name=${alias}.source_name
      AND n.source_object_id=${alias}.source_object_id AND n.source_revision_subject_id=${alias}.source_revision_subject_id)`;
}

async function legacyFinancialScopeError(
  client: LedgerTransactionPort,
  scope: TrustedScope,
  operation: string,
  requestId: string,
): Promise<ErrorEnvelope | null> {
  const quarantined = await client.query(
    `SELECT 1 AS restricted
     FROM cost_intelligence.financial_privacy_quarantine
     WHERE tenant_id = $1 AND project_id = $2 AND environment = $3 AND billing_mode = $4
     LIMIT 1`,
    [scope.tenantId, scope.projectId, scope.environment, scope.billingMode],
  );
  if (quarantined.rows.length === 0) return null;
  return makeError(
    'ledger', operation, 'SOURCE_UNAVAILABLE', requestId,
    'Ledger history in this scope is restricted pending financial review.',
  );
}

function validationFailure(module: string, operation: string, requestId: string, message: string): Validation<never> {
  return { ok: false, error: makeError(module, operation, 'VALIDATION_ERROR', requestId, message) };
}

// These are finance-measure identifiers, not free-form source labels. New
// producer units are added only after their meaning and display safety are reviewed.
const SAFE_LEDGER_UNITS = new Set([
  'token', 'tokens', 'input', 'output', 'reasoning', 'input_tokens', 'output_tokens', 'cached_tokens',
  'uncached_tokens', 'reasoning_tokens', 'cache_read_tokens', 'cache_write_tokens',
  'request', 'requests', 'call', 'calls', 'job', 'jobs', 'task', 'tasks', 'invocation', 'invocations',
  'image', 'images', 'byte', 'bytes', 'kilobytes', 'megabytes', 'gigabytes', 'millisecond', 'milliseconds',
  'second', 'seconds', 'minute', 'minutes', 'hour', 'hours', 'day', 'days', 'count', 'item', 'items',
  'unit', 'units', 'page', 'pages', 'row', 'rows', 'record', 'records', 'character', 'characters', 'credit', 'credits',
]);

const SAFE_LEDGER_MISSING_FIELDS = new Set([
  ...SAFE_LEDGER_UNITS, 'amount', 'currency', 'source_reference', 'provider_reference', 'pricing_reference',
  'all', 'usage', 'providerAttemptId', 'billableAttemptId', 'image_count', 'request_count', 'duration',
]);

const unsafeFinanceText = /(?:https?:\/\/|\b[a-z][a-z0-9+.-]*:\/\/|[\u0000-\u001f]|(?:^|[^a-z0-9])(?:prompt|password|passwd|secret|bearer|private|address|email)(?:$|[^a-z0-9])|(?:^|[^a-z0-9])token(?:$|[^a-z0-9])|(?:^|[^a-z0-9])(?:\d{1,3}\.){3}\d{1,3}(?:$|[^a-z0-9])|[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/i;
const unsafeReferenceCharacters = /[?#@]/;

function safeOpaqueMetadata(value: string): boolean {
  return value.length <= 256 && /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value)
    && !unsafeReferenceCharacters.test(value) && !unsafeFinanceText.test(value);
}

function privacySafeLedgerRequest(request: LedgerAppendRequest): boolean {
  if (request.usage.units.some(unit => !SAFE_LEDGER_UNITS.has(unit.name)
      || (unit.includedIn !== undefined && !SAFE_LEDGER_UNITS.has(unit.includedIn)))) return false;
  if (request.usage.missingFields.some(field => !SAFE_LEDGER_MISSING_FIELDS.has(field))) return false;

  const references = [
    ...request.sourceRefs,
    ...(request.pricing?.rateCardRef ? [request.pricing.rateCardRef] : []),
    ...(request.fxEvidence ? [request.fxEvidence.sourceRef] : []),
  ];
  const opaqueMetadata = [
    request.requestId, request.idempotencyKey, request.scope.tenantId, request.scope.projectId, request.scope.actorId,
    request.eventId, request.correlationId, request.producer.module, request.producer.buildRevision,
    request.identities.logicalOperationId, request.identities.sourceObservationId,
    ...(request.identities.reservationId ? [request.identities.reservationId] : []),
    request.postingMapping.sourceLineId,
    ...[request.postingMapping.transportAttemptId, request.postingMapping.providerAttemptId,
      request.postingMapping.providerRequestId, request.postingMapping.billableAttemptId]
      .flatMap(identity => identity.status === 'known' ? [identity.id] : []),
    request.sourceIdentity.source, request.sourceIdentity.sourceEventId, request.sourceIdentity.sourceObjectId,
    request.sourceIdentity.revisionSubjectId, request.sourceIdentity.sourceRevision,
    ...(request.reservationAuthorizationEventId ? [request.reservationAuthorizationEventId] : []),
    ...(request.supersedesEventId ? [request.supersedesEventId] : []),
    ...(request.reversesEventId ? [request.reversesEventId] : []),
    ...(request.pricing ? [request.pricing.policyVersion, request.pricing.ruleVersion] : []),
    ...references.flatMap(reference => [reference.contract, reference.schema_version, reference.id]),
  ];
  if (!opaqueMetadata.every(safeOpaqueMetadata)) return false;

  // Dimensions are reviewed keys in the v1 schema. Preserve legitimate labels
  // with ordinary spaces while rejecting source prose that contains private data.
  return Object.values(request.dimensions).every(value => typeof value !== 'string' || !unsafeFinanceText.test(value));
}

function hasUtcZ(value: string): boolean {
  return value.endsWith('Z') && Number.isFinite(Date.parse(value));
}

function canonicalProjectionInstant(value: string): string | null {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$/.exec(value);
  if (!match) return null;
  const instant = Date.parse(`${match[1]}Z`);
  if (!Number.isFinite(instant) || new Date(instant).toISOString().slice(0, 19) !== match[1]) return null;
  const micros = (match[2] ?? '').padEnd(6, '0');
  const milliseconds = micros.slice(0, 3);
  const subMillisecond = micros.slice(3);
  return subMillisecond === '000'
    ? `${match[1]}.${milliseconds}Z`
    : `${match[1]}.${milliseconds}${subMillisecond}Z`;
}

function decimalScale(value: string): number {
  return value.split('.')[1]?.length ?? 0;
}

function parseScaledDecimal(value: string): bigint {
  const match = /^(-?)(0|[1-9][0-9]*)(?:\.([0-9]{1,18}))?$/.exec(value);
  if (!match) throw new Error('Decimal failed validation before exact parsing.');
  const sign = match[1] === '-' ? -1n : 1n;
  const whole = BigInt(match[2] ?? '0');
  const fraction = BigInt((match[3] ?? '').padEnd(18, '0') || '0');
  return sign * (whole * 1_000_000_000_000_000_000n + fraction);
}

function formatScaledDecimal(value: bigint): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / 1_000_000_000_000_000_000n;
  const fraction = (absolute % 1_000_000_000_000_000_000n).toString().padStart(18, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole.toString()}${fraction ? `.${fraction}` : ''}`;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === 'object' && value !== null) {
    const object = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(object).sort().map(key => [key, canonicalize(object[key])]));
  }
  return value;
}
function sameJson(left:unknown,right:unknown):boolean{return JSON.stringify(canonicalize(left))===JSON.stringify(canonicalize(right));}

async function hashValue(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(canonicalize(value)));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return `sha256:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

function getRequestId(value: unknown): string {
  return typeof value === 'object' && value !== null && 'requestId' in value && typeof value.requestId === 'string'
    ? value.requestId : 'unavailable';
}

export function validateLedgerAppendRequestBoundary(value: unknown): Validation<LedgerAppendRequest> {
  const requestId = getRequestId(value);
  const parsed = validateRequest(LedgerAppendRequestSchema, value, 'ledger', 'appendLedgerEvent');
  if (!parsed.ok) return parsed;
  const request = parsed.value;
  if (!privacySafeLedgerRequest(request)) {
    return validationFailure('ledger', 'appendLedgerEvent', requestId,
      'Ledger evidence and financial metadata must use reviewed opaque references and allowlisted measure names.');
  }
  if (request.postingMapping.sourceLineId !== request.sourceIdentity.revisionSubjectId) {
    return validationFailure('ledger', 'appendLedgerEvent', requestId, 'The versioned posting mapping must identify its source revision subject.');
  }
  if (!hasUtcZ(request.occurredAt) || !hasUtcZ(request.observedAt)) {
    return validationFailure('ledger', 'appendLedgerEvent', requestId, 'Event timestamps must be UTC instants ending in Z.');
  }
  if ((request.valuation === 'unknown') !== (request.money.amount === null)) {
    return validationFailure('ledger', 'appendLedgerEvent', requestId, 'Unknown valuation requires a null amount; valued money requires an exact amount.');
  }
  if (request.money.amount !== null && decimalScale(request.money.amount) > request.money.scale) {
    return validationFailure('ledger', 'appendLedgerEvent', requestId, 'The money scale cannot be smaller than the serialized exact amount.');
  }
  if (request.valuation === 'estimated' && request.pricing === null) {
    return validationFailure('ledger', 'appendLedgerEvent', requestId, 'Estimated money requires an explicit pricing policy and rule version.');
  }
  if(request.valuation==='provider_reported_unsettled'&&(request.money.currency!=='USD'
    ||request.pricing?.rateCardRef!==undefined&&request.pricing.rateCardRef!==null
    ||!request.sourceRefs.some(ref=>['ProviderReportedCostEvidence','FinanceReportedCostEvidence'].includes(ref.contract))
    ||!request.sourceRefs.some(ref=>ref.contract==='ci-budget-source')
    ||request.settlementStatus!=='unpaid')){
    return validationFailure('ledger','appendLedgerEvent',requestId,
      'Reported unsettled USD requires original collector and provider cost evidence, a null RateCard, and unpaid status.');
  }
  if (request.fxEvidence !== null) {
    if (request.fxEvidence.sourceCurrency !== request.money.currency || request.fxEvidence.targetCurrency === request.money.currency
      || !hasUtcZ(request.fxEvidence.effectiveAt) || parseScaledDecimal(request.fxEvidence.rate) <= 0n) {
      return validationFailure('ledger', 'appendLedgerEvent', requestId, 'FX evidence must identify a distinct target currency, positive exact rate, source reference, and UTC effective time.');
    }
  }
  if (request.usage.completeness === 'complete' && (request.usage.units.length === 0 || request.usage.units.some(unit => unit.quantity === null) || request.usage.missingFields.length > 0)) {
    return validationFailure('ledger', 'appendLedgerEvent', requestId, 'Complete usage requires at least one known quantity and no missing fields.');
  }
  if (request.usage.completeness === 'unknown' && request.usage.units.some(unit => unit.quantity !== null)) {
    return validationFailure('ledger', 'appendLedgerEvent', requestId, 'Unknown usage cannot contain a known quantity.');
  }
  for (const unit of request.usage.units) {
    if (unit.quantity !== null && decimalScale(unit.quantity) > unit.scale) {
      return validationFailure('ledger', 'appendLedgerEvent', requestId, 'Usage scale cannot be smaller than its exact quantity.');
    }
    if (unit.relation === 'included_subset' && !unit.includedIn) {
      return validationFailure('ledger', 'appendLedgerEvent', requestId, 'Included usage subsets must identify their parent measure.');
    }
  }
  const memoEvent = ['usage_observation', 'reservation_authorized', 'dispatch', 'reservation_release'].includes(request.eventType);
  if (memoEvent && request.financialEffect) {
    return validationFailure('ledger', 'appendLedgerEvent', requestId, 'Observation and reservation lifecycle records cannot post recognized financial effects.');
  }
  if (request.eventType === 'correction' && request.supersedesEventId === null
    || !['correction', 'consumption', 'usage_observation'].includes(request.eventType) && request.supersedesEventId !== null) {
    return validationFailure('ledger', 'appendLedgerEvent', requestId, 'Only a correction, cumulative consumption revision, or usage observation revision may supersede a prior event; every correction must name it.');
  }
  if (request.eventType === 'reversal' ? request.reversesEventId === null : request.reversesEventId !== null) {
    return validationFailure('ledger', 'appendLedgerEvent', requestId, 'Every reversal must name its original event; other event types cannot use reversal lineage.');
  }
  if (request.eventType === 'reversal' && (!request.financialEffect || request.money.amount === null)) {
    return validationFailure('ledger', 'appendLedgerEvent', requestId, 'A reversal must carry a known signed financial effect.');
  }
  if (request.eventType === 'correction' && !request.financialEffect) {
    return validationFailure('ledger', 'appendLedgerEvent', requestId, 'A financial correction must participate in the effective projection.');
  }
  if (request.eventType === 'usage_observation' && request.supersedesEventId !== null && request.financialEffect) {
    return validationFailure('ledger', 'appendLedgerEvent', requestId, 'A usage evidence revision cannot post a financial effect.');
  }
  if (['correction', 'adjustment', 'reversal'].includes(request.eventType) && request.sourceRefs.length === 0) {
    return validationFailure('ledger', 'appendLedgerEvent', requestId, 'Corrections, reversals, and adjustments require content-addressed source evidence.');
  }
  if (request.eventType === 'reservation_authorized' && request.classification !== 'reservation_memo'
    || request.eventType === 'dispatch' && request.classification !== 'reservation_memo'
    || request.eventType === 'reservation_release' && request.classification !== 'reservation_memo'
    || request.eventType === 'usage_observation' && request.classification !== 'usage_memo') {
    return validationFailure('ledger', 'appendLedgerEvent', requestId, 'Observation and reservation events must use their memo classification.');
  }
  const reservationId = request.identities.reservationId;
  const reservationEventId = request.reservationAuthorizationEventId;
  if (request.eventType === 'reservation_authorized') {
    if (reservationId === null || reservationEventId !== null) {
      return validationFailure('ledger', 'appendLedgerEvent', requestId, 'A reservation authorization needs its reservation identity and cannot point to another authorization.');
    }
  } else if (['dispatch', 'reservation_release'].includes(request.eventType) && reservationId === null) {
    return validationFailure('ledger', 'appendLedgerEvent', requestId, 'Reservation dispatch and release events require a reservation identity.');
  }
  if (request.eventType !== 'reservation_authorized' && (reservationId === null) !== (reservationEventId === null)) {
    return validationFailure('ledger', 'appendLedgerEvent', requestId, 'Reservation activity must retain both the reservation identity and its authorization event link.');
  }
  if (request.eventType === 'consumption' && request.money.amount !== null && parseScaledDecimal(request.money.amount) < 0n) {
    return validationFailure('ledger', 'appendLedgerEvent', requestId, 'Cumulative consumption cannot be negative; append a linked reversal or correction instead.');
  }
  if (request.eventType === 'consumption' && !new Set<string>(['partially_settled', 'settled', 'outcome_unknown', 'held_for_reconciliation']).has(request.reservationLifecycle as string)) {
    return validationFailure('ledger', 'appendLedgerEvent', requestId, 'Consumption must preserve its partial, final, or unresolved reservation lifecycle.');
  }
  if (request.fxEvidence !== null && request.fxEvidence.sourceRef.content_hash.length !== 71) {
    return validationFailure('ledger', 'appendLedgerEvent', requestId, 'FX evidence needs a content-addressed source reference.');
  }
  return parsed;
}

export function validateLedgerProjectionRequestBoundary(value: unknown): Validation<LedgerProjectionRequest> {
  const parsed = validateRequest(LedgerProjectionRequestSchema, value, 'ledger', 'rebuildLedgerProjection');
  if (!parsed.ok) return parsed;
  const asOf = canonicalProjectionInstant(parsed.value.asOf);
  if (!asOf || !hasUtcZ(asOf)) {
    return validationFailure('ledger', 'rebuildLedgerProjection', parsed.value.requestId,
      'Projection as-of time must be a valid UTC instant ending in Z with at most six fractional digits.');
  }
  return { ok: true, value: { ...parsed.value, asOf } };
}

function bindingsFor(request: LedgerAppendRequest): Binding[] {
  const identities = request.identities;
  const mapping = request.postingMapping;
  const bindings: Binding[] = [
    { kind: 'logical_operation', value: identities.logicalOperationId },
    { kind: 'source_observation', value: identities.sourceObservationId },
  ];
  const upstream: Array<[BindingKind, UpstreamIdentity]> = [
    ['transport_attempt', mapping.transportAttemptId],
    ['provider_attempt', mapping.providerAttemptId],
    ['provider_request', mapping.providerRequestId],
    ['billable_attempt', mapping.billableAttemptId],
  ];
  for (const [kind, identity] of upstream) {
    if (identity.status === 'known') bindings.push({ kind, value: identity.id });
  }
  if (identities.reservationId !== null) bindings.push({ kind: 'reservation', value: identities.reservationId });
  return bindings.sort((left, right) => `${left.kind}\0${left.value}`.localeCompare(`${right.kind}\0${right.value}`));
}

function identityId(identity: UpstreamIdentity): string | null {
  return identity.status === 'known' ? identity.id : null;
}

function identityStatus(identity: UpstreamIdentity): UpstreamIdentity['status'] {
  return identity.status;
}

function identityMatchesStored(row: Record<string, unknown>, field: string, identity: UpstreamIdentity, allowResolution: boolean): boolean {
  const statusField = field.endsWith('_id') ? `${field.slice(0, -3)}_status` : `${field}_status`;
  const status = fromRow(row, statusField);
  const value = fromRow(row, field);
  if (status === 'unknown' && allowResolution) return true;
  return status === identityStatus(identity) && value === identityId(identity);
}

function receipt(request: LedgerAppendRequest, status: LedgerAppendReceipt['status'], existingEventId: string | null, ingestedAt: string | null): LedgerAppendReceipt {
  return {
    schemaVersion: '1.0.0', requestId: request.requestId, status,
    eventId: request.eventId, existingEventId, durableCommit: status === 'accepted', ingestedAt,
  };
}

function asString(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Database returned an unexpected ledger value.');
  return value;
}

function fromRow(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  return value === null || value === undefined ? null : asString(value);
}

async function trustedScope(
  request: { requestId: string; scope: TrustedScope },
  ports: LedgerRuntimePorts,
  operation: string,
  authorityOperation: FinanceOperation,
): Promise<ErrorEnvelope | null> {
  const authorization = await authorizeFinanceOperation({
    module: 'ledger', requestOperation: operation, operation: authorityOperation,
    scope: request.scope, requestId: request.requestId, clock: ports.clock,
    financeAuthority: ports.financeAuthority,
  });
  return authorization.ok ? null : authorization.error;
}

function conflictResult(request: LedgerAppendRequest, status: 'conflict' | 'stale_revision', existingId: string | null = null): ApiResult<LedgerAppendReceipt> {
  return { ok: true, value: receipt(request, status, existingId, null) };
}

type EconomicTreeRow = { event_id: string; economic_root_event_id: string; economic_reverses_event_id: string | null; amount: string | null };

async function currentEconomicTree(
  client: LedgerTransactionPort,
  scope: LedgerScope,
  rootEventId: string,
): Promise<EconomicTreeRow[]> {
  const result = await client.query(
    `WITH RECURSIVE roots(root_event_id) AS (
       SELECT $5::text
       UNION
       SELECT child.economic_root_event_id
       FROM roots parent
       JOIN cost_intelligence.financial_ledger_events child
         ON child.economic_reverses_event_id = parent.root_event_id AND child.financial_effect
       JOIN cost_intelligence.financial_source_revision_heads child_head
         ON child_head.current_event_id = child.event_id
       WHERE child.tenant_id = $1 AND child.project_id = $2 AND child.environment = $3 AND child.billing_mode = $4
     )
     SELECT event.event_id, event.economic_root_event_id, event.economic_reverses_event_id,
            event.amount::text AS amount
     FROM roots
     JOIN cost_intelligence.financial_source_revision_heads head
       ON head.tenant_id = $1 AND head.project_id = $2 AND head.environment = $3 AND head.billing_mode = $4
     JOIN cost_intelligence.financial_ledger_events event
       ON event.event_id = head.current_event_id AND event.economic_root_event_id = roots.root_event_id AND event.financial_effect
     ORDER BY event.economic_root_event_id, event.event_id`,
    [scope.tenantId, scope.projectId, scope.environment, scope.billingMode, rootEventId],
  );
  return result.rows.map(row => ({
    event_id: asString(row.event_id),
    economic_root_event_id: asString(row.economic_root_event_id),
    economic_reverses_event_id: fromRow(row, 'economic_reverses_event_id'),
    amount: fromRow(row, 'amount'),
  }));
}

type EconomicAncestryTree = { rootId: string; tree: EconomicTreeRow[]; rootRow: EconomicTreeRow };

async function currentEconomicAncestry(
  client: LedgerTransactionPort,
  scope: LedgerScope,
  rootEventId: string,
): Promise<EconomicAncestryTree[] | null> {
  const ancestry: EconomicAncestryTree[] = [];
  const visited = new Set<string>();
  let nextRootId: string | null = rootEventId;
  while (nextRootId !== null) {
    if (visited.has(nextRootId)) return null;
    visited.add(nextRootId);
    const tree = await currentEconomicTree(client, scope, nextRootId);
    const rootRow = tree.find(row => row.economic_root_event_id === nextRootId);
    if (!rootRow) return null;
    ancestry.push({ rootId: nextRootId, tree, rootRow });
    nextRootId = rootRow.economic_reverses_event_id;
  }
  return ancestry;
}

function sumEconomicTree(tree: readonly EconomicTreeRow[]): bigint | null {
  return tree.reduce<bigint | null>((sum, row) => {
    const amount = exactAmount(row.amount);
    return sum === null || amount === null ? null : sum + amount;
  }, 0n);
}

function exactAmount(value: string | null): bigint | null {
  return value === null ? null : parseScaledDecimal(value);
}

function validEconomicNet(rootAmount: bigint | null, netAmount: bigint | null): boolean {
  if (rootAmount === null || netAmount === null) return false;
  if (rootAmount === 0n) return netAmount === 0n;
  return (netAmount === 0n || (netAmount > 0n) === (rootAmount > 0n))
    && (netAmount >= 0n ? netAmount : -netAmount) <= (rootAmount >= 0n ? rootAmount : -rootAmount);
}

async function quarantineUnsupportedPayload(value: unknown, ports: LedgerRuntimePorts): Promise<ApiResult<LedgerAppendReceipt> | null> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const unsupportedVersion = typeof candidate.schemaVersion === 'string' && candidate.schemaVersion !== '1.0.0';
  const unsupportedType = candidate.schemaVersion === '1.0.0' && typeof candidate.eventType === 'string'
    && !Value.Check(LedgerEventTypeSchema, candidate.eventType);
  if (!unsupportedVersion && !unsupportedType) return null;
  if (!Value.Check(TrustedScopeSchema, candidate.scope)) {
    return failure(makeError('ledger', 'appendLedgerEvent', 'VALIDATION_ERROR', 'unsupported', 'The unsupported record has no valid trusted scope for quarantine.'));
  }
  const scope = candidate.scope as TrustedScope;
  const authorizationError = await trustedScope({
    requestId: getRequestId(value), scope,
  }, ports, 'appendLedgerEvent', 'ledger.appendLedgerEvent');
  if (authorizationError) return failure(authorizationError);
  let payloadHash: string;
  try {
    payloadHash = await hashValue(value);
  } catch {
    return failure(makeError('ledger', 'appendLedgerEvent', 'VALIDATION_ERROR', 'unsupported', 'The unsupported record cannot be safely fingerprinted.'));
  }
  const reason = unsupportedVersion ? 'unsupported_schema_version' : 'unsupported_event_type';
  const safeVersion = unsupportedVersion && typeof candidate.schemaVersion === 'string'
    && candidate.schemaVersion.length <= 32 && /^[0-9]+\.[0-9]+\.[0-9]+$/.test(candidate.schemaVersion)
    ? candidate.schemaVersion : null;
  const referenceHash = await hashValue({
    tenantId: scope.tenantId, projectId: scope.projectId, environment: scope.environment,
    billingMode: scope.billingMode, reason, payloadHash,
  });
  const diagnosticRef = `ci02q:${referenceHash.slice('sha256:'.length)}`;
  let client: LedgerTransactionPort | undefined;
  let inTransaction = false;
  try {
    client = await ports.database.connect();
    await client.query('BEGIN');
    inTransaction = true;
    await bindFinancialDatabaseScope(client, scope);
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`ci02-ledger:${scope.tenantId}:${scope.projectId}:${scope.environment}:${scope.billingMode}`],
    );
    const legacyHistoryError = await legacyFinancialScopeError(
      client, scope, 'appendLedgerEvent', getRequestId(value),
    );
    if (legacyHistoryError) {
      await rollback(client);
      inTransaction = false;
      return failure(legacyHistoryError);
    }
    await client.query(
      `INSERT INTO cost_intelligence.financial_ledger_quarantine
        (diagnostic_ref, tenant_id, project_id, environment, billing_mode, unsupported_schema_version, reason_code, payload_sha256)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (tenant_id, project_id, environment, billing_mode, reason_code, payload_sha256) DO NOTHING`,
      [diagnosticRef, scope.tenantId, scope.projectId, scope.environment, scope.billingMode, safeVersion, reason, payloadHash],
    );
    const row = await client.query(
      `SELECT diagnostic_ref FROM cost_intelligence.financial_ledger_quarantine
       WHERE tenant_id = $1 AND project_id = $2 AND environment = $3 AND billing_mode = $4
         AND reason_code = $5 AND payload_sha256 = $6`,
      [scope.tenantId, scope.projectId, scope.environment, scope.billingMode, reason, payloadHash],
    );
    await client.query('COMMIT');
    inTransaction = false;
    const code = unsupportedVersion ? 'UNSUPPORTED_VERSION' : 'VALIDATION_ERROR';
    const message = unsupportedVersion ? 'The request schema version is quarantined for later review.' : 'The request event type is quarantined for later review.';
    const durableRef = fromRow(row.rows[0] ?? {}, 'diagnostic_ref');
    if (durableRef === null) return failure(makeError('ledger', 'appendLedgerEvent', 'SOURCE_UNAVAILABLE', 'unsupported', 'Ledger quarantine persistence is temporarily unavailable.'));
    return failure({ ...makeError('ledger', 'appendLedgerEvent', code, 'unsupported', message), diagnostic_ref: durableRef });
  } catch {
    if (client && inTransaction) await rollback(client);
    return failure(makeError('ledger', 'appendLedgerEvent', 'SOURCE_UNAVAILABLE', 'unsupported', 'Ledger quarantine persistence is temporarily unavailable.'));
  } finally {
    client?.release();
  }
}

async function rollback(client: LedgerTransactionPort): Promise<void> {
  await client.query('ROLLBACK').catch(() => undefined);
}

async function rollbackLedgerSavepoint(client: LedgerTransactionPort): Promise<void> {
  await client.query('ROLLBACK TO SAVEPOINT ci04a_ledger_append').catch(() => undefined);
  await client.query('RELEASE SAVEPOINT ci04a_ledger_append').catch(() => undefined);
}

function usageDecisionIsCurrent(
  decision: FinanceAuthorizationDecision,
  request: LedgerAppendRequest,
  ports: LedgerRuntimePorts,
): boolean {
  if (decision.status !== 'allowed' || decision.operation !== 'metering.ingestUsage'
      || decision.permission !== 'usage.ingest' || !sameScope(decision.scope, request.scope)
      || decision.principal.kind !== 'service' || decision.principal.actorId !== request.scope.actorId
      || decision.principal.serviceStatus !== 'active' || decision.principal.serviceGrantRevision.length === 0) return false;
  const now = ports.clock.now();
  const verified = Date.parse(decision.verifiedAt);
  const expires = Date.parse(decision.expiresAt);
  return now instanceof Date && Number.isFinite(now.getTime()) && Number.isFinite(verified) && Number.isFinite(expires)
    && verified <= now.getTime() && now.getTime() - verified <= 60_000
    && expires > now.getTime() && expires > verified && expires - verified <= 300_000;
}

/** Transactionally append an immutable event. Status outcomes never rewrite prior postings. */
export async function appendLedgerEvent(
  value: unknown,
  ports: LedgerRuntimePorts,
): Promise<ApiResult<LedgerAppendReceipt>> {
  return appendLedgerEventInternal(value, ports);
}

/** Narrow internal bridge for an already-authorized metering transaction. */
export async function appendUsageLedgerEventInTransaction(
  value: unknown,
  client: LedgerTransactionPort,
  ports: LedgerRuntimePorts,
  decision: FinanceAuthorizationDecision,
): Promise<ApiResult<LedgerAppendReceipt>> {
  return appendLedgerEventInternal(value, ports, { client, decision });
}

/** Finance-owned settlement bridge; it refreshes the operation grant independently of caller decision labels. */
export async function appendBudgetLedgerEventInTransaction(
  value: unknown, client: LedgerTransactionPort, ports: LedgerRuntimePorts,
  operation: 'budgets.settle' | 'budgets.recordExpenseAdjustment',
  retainDecision?: (decision:{verifiedAt:string;expiresAt:string})=>void,
): Promise<ApiResult<LedgerAppendReceipt>> {
  const validated=validateLedgerAppendRequestBoundary(value);
  if(!validated.ok)return failure(validated.error);
  const authorization=await authorizeFinanceOperation({module:'ledger',requestOperation:'budgetSettlement',operation,
    scope:validated.value.scope,requestId:validated.value.requestId,clock:ports.clock,
    ...(ports.financeAuthority?{financeAuthority:ports.financeAuthority}:{})});
  if(!authorization.ok)return failure(authorization.error);
  if(!('permission' in authorization.decision))return failure(makeError('ledger','budgetSettlement','FORBIDDEN_SCOPE',validated.value.requestId,'A current Finance settlement grant is required.'));
  if(authorization.decision.status==='allowed')retainDecision?.(structuredClone(authorization.decision) as Extract<FinanceAuthorizationDecision,{status:'allowed'}>);
  const request=validated.value;
  if(request.valuation!=='provider_reported_unsettled'||!ports.sourceCollector||!ports.reportedCostContractMode)
    return failure(makeError('ledger','budgetSettlement','SOURCE_UNAVAILABLE',request.requestId,'An independently authenticated reported-cost source is required.'));
  const reference=request.sourceRefs.find(ref=>ref.contract==='ci-budget-source');
  const reservation=await client.query(`SELECT reservation_id,authorization_request FROM cost_intelligence.budget_reservation_events
    WHERE tenant_id=$1 AND project_id=$2 AND environment=$3 AND billing_mode=$4 AND event_sequence=1 AND billable_attempt_id=$5 AND logical_operation_id=$6`,
    [request.scope.tenantId,request.scope.projectId,request.scope.environment,request.scope.billingMode,
      request.postingMapping.billableAttemptId.status==='known'?request.postingMapping.billableAttemptId.id:null,request.identities.logicalOperationId]);
  const original=reservation.rows[0]?.authorization_request as import('../budgets/index.js').ReservationRequest|undefined;
  if(!reference||!original?.authorityBinding)return failure(makeError('ledger','budgetSettlement','SOURCE_UNAVAILABLE',request.requestId,'The durable original financial attempt binding is unavailable.'));
  const history=await client.query(`SELECT usage_event FROM cost_intelligence.budget_reported_observations
    WHERE tenant_id=$1 AND project_id=$2 AND environment=$3 AND billing_mode=$4 AND reservation_id=$5 ORDER BY reservation_revision DESC LIMIT 1`,
    [request.scope.tenantId,request.scope.projectId,request.scope.environment,request.scope.billingMode,
      // The reservation identifier is generated by Finance, not the canonical reserve request.
      reservation.rows[0]?.reservation_id]);
  const {resolveBudgetReportedCost}=await import('../budgets/reported-cost.js');
  const source=await resolveBudgetReportedCost(ports.sourceCollector,ports.clock,{scope:request.scope,reference:reference as import('../budgets/authority.js').BudgetReference,
    kind:'reported_cost',attempt:original.attemptBinding,authorityBinding:original.authorityBinding,provider:original.authorityBinding.provider,
    model:original.authorityBinding.model,operation:original.authorityBinding.operation,targetBindingSha256:original.authorityBinding.targetBindingSha256},
    ports.reportedCostContractMode,history.rows[0]?.usage_event as import('../budgets/reported-cost.js').BudgetReportedUsage|undefined);
  if(!source||source.evidence.reported_cost.state!=='known'||request.money.amount===null
    ||parseScaledDecimal(source.evidence.reported_cost.money.amount)!==parseScaledDecimal(request.money.amount)
    ||source.usage.source_observation_id!==request.identities.sourceObservationId||source.source.record.evidenceMode!==request.evidenceMode
    ||!sameJson(source.usage.producer,{module:request.producer.module,source_revision:request.producer.sourceRevision,build_revision:request.producer.buildRevision})
    ||!request.sourceRefs.some(ref=>source.usage.valuation.basis==='provider_reported_unsettled'&&sameJson(ref,source.usage.valuation.provider_evidence_ref)))
    return failure(makeError('ledger','budgetSettlement','SOURCE_UNAVAILABLE',request.requestId,'The expense differs from the authenticated original provider observation.'));
  retainDecision?.(structuredClone(source.source));
  return appendLedgerEventInternal(validated.value,ports,{client,decision:authorization.decision as FinanceAuthorizationDecision,budgetOperation:operation});
}

async function appendLedgerEventInternal(
  value: unknown,
  ports: LedgerRuntimePorts,
  bridge?: { readonly client: LedgerTransactionPort; readonly decision: FinanceAuthorizationDecision; readonly budgetOperation?: 'budgets.settle'|'budgets.recordExpenseAdjustment' },
): Promise<ApiResult<LedgerAppendReceipt>> {
  const quarantined = bridge ? null : await quarantineUnsupportedPayload(value, ports);
  if (quarantined !== null) return quarantined;
  const validated = validateLedgerAppendRequestBoundary(value);
  if (!validated.ok) return failure(validated.error);
  const request = validated.value;
  if (bridge) {
    const budgetCurrent=bridge.budgetOperation!==undefined&&bridge.decision.status==='allowed'
      &&bridge.decision.operation===bridge.budgetOperation&&sameScope(bridge.decision.scope,request.scope)
      &&bridge.decision.principal.actorId===request.scope.actorId
      &&(bridge.decision.principal.kind==='service'?bridge.decision.principal.serviceStatus==='active'&&bridge.decision.principal.serviceGrantRevision.length>0:
        bridge.decision.principal.membershipStatus==='active'&&bridge.decision.principal.membershipRevision.length>0)
      &&Date.parse(bridge.decision.verifiedAt)<=ports.clock.now().getTime()
      &&Date.parse(bridge.decision.expiresAt)>ports.clock.now().getTime();
    if (!(bridge.budgetOperation?budgetCurrent:usageDecisionIsCurrent(bridge.decision, request, ports))) {
      return failure(makeError('ledger', 'appendLedgerEvent', 'FORBIDDEN_SCOPE', request.requestId,
        'The current metering authorization does not permit this ledger append.'));
    }
  } else {
    const authorizationError = await trustedScope(request, ports, 'appendLedgerEvent', 'ledger.appendLedgerEvent');
    if (authorizationError) return failure(authorizationError);
  }
  if(request.valuation==='provider_reported_unsettled'&&!bridge?.budgetOperation)
    return failure(makeError('ledger','appendLedgerEvent','SOURCE_UNAVAILABLE',request.requestId,'Reported-cost expense requires the independently authenticated Finance source bridge.'));
  let now: Date;
  try {
    now = ports.clock.now();
  } catch {
    return failure(makeError('ledger', 'appendLedgerEvent', 'SOURCE_UNAVAILABLE', request.requestId, 'Trusted ledger clock is unavailable.'));
  }
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    return failure(makeError('ledger', 'appendLedgerEvent', 'SOURCE_UNAVAILABLE', request.requestId, 'Trusted ledger clock is unavailable.'));
  }
  const ingestedAt = now.toISOString();
  const eventHash = await hashValue(request);
  const scope = request.scope;
  const bindings = bindingsFor(request);
  let client: LedgerTransactionPort | undefined;
  let inTransaction = false;
  try {
    client = bridge ? bridge.client : await ports.database.connect();
    if (bridge) await client.query('SAVEPOINT ci04a_ledger_append');
    else await client.query('BEGIN');
    inTransaction = true;
    if (!bridge) await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
    await bindFinancialDatabaseScope(client, scope);
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`ci02-ledger:${scope.tenantId}:${scope.projectId}:${scope.environment}:${scope.billingMode}`],
    );

    const legacyHistoryError = await legacyFinancialScopeError(client, scope, 'appendLedgerEvent', request.requestId);
    if (legacyHistoryError) {
      if (bridge) await rollbackLedgerSavepoint(client); else await rollback(client);
      inTransaction = false;
      return failure(legacyHistoryError);
    }

    const idempotency = await client.query(
      `SELECT event_id, event_hash FROM cost_intelligence.financial_ledger_events
       WHERE tenant_id = $1 AND project_id = $2 AND environment = $3 AND billing_mode = $4 AND idempotency_key = $5`,
      [scope.tenantId, scope.projectId, scope.environment, scope.billingMode, request.idempotencyKey],
    );
    if (idempotency.rows.length) {
      if (bridge) await rollbackLedgerSavepoint(client); else await rollback(client);
      inTransaction = false;
      const row = idempotency.rows[0] ?? {};
      const existingId = fromRow(row, 'event_id');
      const status = fromRow(row, 'event_hash') === eventHash ? 'duplicate' : 'conflict';
      return { ok: true, value: receipt(request, status, existingId, null) };
    }

    for (const binding of bindings) {
      await client.query(
        `INSERT INTO cost_intelligence.financial_ledger_identity_bindings
          (tenant_id, project_id, environment, billing_mode, identity_kind, identity_value, logical_operation_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`,
        [scope.tenantId, scope.projectId, scope.environment, scope.billingMode, binding.kind, binding.value, request.identities.logicalOperationId],
      );
    }
    const lockedBindings = await client.query(
      `SELECT identity_kind, identity_value, logical_operation_id, first_event_id
       FROM cost_intelligence.financial_ledger_identity_bindings
       WHERE tenant_id = $1 AND project_id = $2 AND environment = $3 AND billing_mode = $4 AND (identity_kind, identity_value) IN (
         SELECT * FROM unnest($5::text[], $6::text[])
       ) ORDER BY identity_kind, identity_value`,
      [scope.tenantId, scope.projectId, scope.environment, scope.billingMode, bindings.map(item => item.kind), bindings.map(item => item.value)],
    );
    for (const row of lockedBindings.rows) {
      if (fromRow(row, 'logical_operation_id') !== request.identities.logicalOperationId) {
        if (bridge) await rollbackLedgerSavepoint(client); else await rollback(client);
        inTransaction = false;
        return conflictResult(request, 'conflict');
      }
      if (fromRow(row, 'identity_kind') === 'source_observation' && fromRow(row, 'first_event_id') !== null) {
        const existing = await client.query(
          `SELECT event_id, event_hash, source_content_hash, source_revision_sequence
           FROM cost_intelligence.financial_ledger_events WHERE event_id = $1`,
          [fromRow(row, 'first_event_id')],
        );
        const prior = existing.rows[0] ?? {};
        const duplicate = fromRow(prior, 'event_hash') === eventHash
          && fromRow(prior, 'source_content_hash') === request.sourceIdentity.contentHash
          && Number(prior.source_revision_sequence) === request.sourceIdentity.revisionSequence;
        if (bridge) await rollbackLedgerSavepoint(client); else await rollback(client);
        inTransaction = false;
        return { ok: true, value: receipt(request, duplicate ? 'duplicate' : 'conflict', fromRow(prior, 'event_id'), null) };
      }
      if (fromRow(row, 'identity_kind') === 'reservation' && fromRow(row, 'first_event_id') !== null
        && request.eventType === 'reservation_authorized') {
        const existing = await client.query(
          `SELECT event_id, event_hash FROM cost_intelligence.financial_ledger_events WHERE event_id = $1`,
          [fromRow(row, 'first_event_id')],
        );
        const prior = existing.rows[0] ?? {};
        const duplicate = fromRow(prior, 'event_hash') === eventHash;
        if (bridge) await rollbackLedgerSavepoint(client); else await rollback(client);
        inTransaction = false;
        return { ok: true, value: receipt(request, duplicate ? 'duplicate' : 'conflict', fromRow(prior, 'event_id'), null) };
      }
    }

    if (request.reservationAuthorizationEventId !== null) {
      const authorization = await client.query(
        `SELECT tenant_id, project_id, environment, billing_mode, event_type, reservation_id, logical_operation_id, currency
         FROM cost_intelligence.financial_ledger_events WHERE event_id = $1`,
        [request.reservationAuthorizationEventId],
      );
      const authorizationRow = authorization.rows[0] ?? {};
      if (fromRow(authorizationRow, 'tenant_id') !== scope.tenantId
        || fromRow(authorizationRow, 'project_id') !== scope.projectId
        || fromRow(authorizationRow, 'environment') !== scope.environment
        || fromRow(authorizationRow, 'billing_mode') !== scope.billingMode
        || fromRow(authorizationRow, 'event_type') !== 'reservation_authorized'
        || fromRow(authorizationRow, 'reservation_id') !== request.identities.reservationId
        || fromRow(authorizationRow, 'logical_operation_id') !== request.identities.logicalOperationId
        || fromRow(authorizationRow, 'currency')?.trim() !== request.money.currency) {
        if (bridge) await rollbackLedgerSavepoint(client); else await rollback(client);
        inTransaction = false;
        return conflictResult(request, 'conflict', request.reservationAuthorizationEventId);
      }
    }

    await client.query(
      `INSERT INTO cost_intelligence.financial_source_revision_heads
          (tenant_id, project_id, environment, billing_mode, source_name, source_object_id, source_revision_subject_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`,
      [scope.tenantId, scope.projectId, scope.environment, scope.billingMode, request.sourceIdentity.source,
        request.sourceIdentity.sourceObjectId, request.sourceIdentity.revisionSubjectId],
    );
    const sourceHead = await client.query(
      `SELECT current_revision_sequence, current_event_id FROM cost_intelligence.financial_source_revision_heads
       WHERE tenant_id = $1 AND project_id = $2 AND environment = $3 AND billing_mode = $4
         AND source_name = $5 AND source_object_id = $6 AND source_revision_subject_id = $7 FOR UPDATE`,
      [scope.tenantId, scope.projectId, scope.environment, scope.billingMode, request.sourceIdentity.source,
        request.sourceIdentity.sourceObjectId, request.sourceIdentity.revisionSubjectId],
    );
    const currentSource = sourceHead.rows[0] ?? {};
    const currentSourceEventId = fromRow(currentSource, 'current_event_id');
    const currentSourceRevision = currentSource.current_revision_sequence === null || currentSource.current_revision_sequence === undefined
      ? null : Number(currentSource.current_revision_sequence);
    if (currentSourceRevision !== null) {
      if (request.sourceIdentity.revisionSequence <= currentSourceRevision || request.supersedesEventId !== currentSourceEventId) {
        if (bridge) await rollbackLedgerSavepoint(client); else await rollback(client);
        inTransaction = false;
        return conflictResult(request, 'stale_revision', currentSourceEventId);
      }
    } else if (request.supersedesEventId !== null) {
      if (bridge) await rollbackLedgerSavepoint(client); else await rollback(client);
      inTransaction = false;
      return conflictResult(request, 'stale_revision');
    }

    let predecessor: Record<string, unknown> | null = null;
    let economicRootEventId = request.eventId;
    let economicEventType: LedgerEventType = request.eventType;
    let economicReversesEventId: string | null = null;
    if (currentSourceEventId !== null) {
      const existing = await client.query(
        `SELECT * FROM cost_intelligence.financial_ledger_events WHERE event_id = $1`,
        [currentSourceEventId],
      );
      predecessor = existing.rows[0] ?? null;
      if (!predecessor) {
        if (bridge) await rollbackLedgerSavepoint(client); else await rollback(client);
        inTransaction = false;
        return conflictResult(request, 'stale_revision', currentSourceEventId);
      }
      const usageRevision = request.eventType === 'usage_observation'
        && fromRow(predecessor, 'event_type') === 'usage_observation'
        && predecessor.financial_effect === false && !request.financialEffect;
      const financialCorrection = request.eventType === 'correction'
        && predecessor.financial_effect === true && request.financialEffect;
      const cumulativeConsumption = request.eventType === 'consumption'
        && fromRow(predecessor, 'economic_event_type') === 'consumption'
        && predecessor.financial_effect === true && request.financialEffect;
      const allowMappingResolution = usageRevision || financialCorrection;
      const mappingChecks = {
        sourceLine: fromRow(predecessor, 'source_line_id') === request.postingMapping.sourceLineId,
        logicalOperation: fromRow(predecessor, 'logical_operation_id') === request.identities.logicalOperationId,
        transport: identityMatchesStored(predecessor, 'transport_attempt_id', request.postingMapping.transportAttemptId, allowMappingResolution),
        provider: identityMatchesStored(predecessor, 'provider_attempt_id', request.postingMapping.providerAttemptId, allowMappingResolution),
        providerRequest: identityMatchesStored(predecessor, 'provider_request_id', request.postingMapping.providerRequestId, allowMappingResolution),
        billable: identityMatchesStored(predecessor, 'billable_attempt_id', request.postingMapping.billableAttemptId, allowMappingResolution),
      };
      const lineageChecks = {
        classification: fromRow(predecessor, 'classification') === request.classification,
        currency: fromRow(predecessor, 'currency')?.trim() === request.money.currency,
        logicalOperation: fromRow(predecessor, 'logical_operation_id') === request.identities.logicalOperationId,
        reservation: fromRow(predecessor, 'reservation_id') === request.identities.reservationId,
        authorization: fromRow(predecessor, 'reservation_authorization_event_id') === request.reservationAuthorizationEventId,
        postingMapping: Object.values(mappingChecks).every(Boolean),
      };
      const sameLineage = Object.values(lineageChecks).every(Boolean);
      const priorAmount = fromRow(predecessor, 'amount');
      const nextAmount = request.money.amount;
      const consumptionDoesNotDecrease = !cumulativeConsumption || priorAmount === null || nextAmount === null
        || parseScaledDecimal(nextAmount) >= parseScaledDecimal(priorAmount);
      if (!(usageRevision || financialCorrection || cumulativeConsumption) || !sameLineage || !consumptionDoesNotDecrease) {
        if (bridge) await rollbackLedgerSavepoint(client); else await rollback(client);
        inTransaction = false;
        return conflictResult(request, 'conflict', currentSourceEventId);
      }
      economicRootEventId = asString(predecessor.economic_root_event_id);
      economicEventType = asString(predecessor.economic_event_type) as LedgerEventType;
      economicReversesEventId = fromRow(predecessor, 'economic_reverses_event_id');
    }

    if (request.eventType === 'reversal' && request.reversesEventId !== null) {
      const targetResult = await client.query(
        `SELECT target.*, head.current_event_id AS source_head_event_id
         FROM cost_intelligence.financial_ledger_events target
         JOIN cost_intelligence.financial_source_revision_heads head
           ON head.tenant_id = target.tenant_id AND head.project_id = target.project_id
          AND head.environment = target.environment AND head.billing_mode = target.billing_mode
          AND head.source_name = target.source_name AND head.source_object_id = target.source_object_id
          AND head.source_revision_subject_id = target.source_revision_subject_id
         WHERE target.event_id = $5 AND target.tenant_id = $1 AND target.project_id = $2
           AND target.environment = $3 AND target.billing_mode = $4
         FOR UPDATE OF head`,
        [scope.tenantId, scope.projectId, scope.environment, scope.billingMode, request.reversesEventId],
      );
      const target = targetResult.rows[0] ?? null;
      const targetAmount = target ? fromRow(target, 'amount') : null;
      const reversalAmount = request.money.amount;
      if (!target || fromRow(target, 'source_head_event_id') !== request.reversesEventId
        || target.financial_effect !== true || targetAmount === null || reversalAmount === null
        || fromRow(target, 'classification') !== request.classification
        || fromRow(target, 'currency')?.trim() !== request.money.currency
        || fromRow(target, 'logical_operation_id') !== request.identities.logicalOperationId
        || fromRow(target, 'reservation_id') !== request.identities.reservationId
        || fromRow(target, 'reservation_authorization_event_id') !== request.reservationAuthorizationEventId) {
        if (bridge) await rollbackLedgerSavepoint(client); else await rollback(client);
        inTransaction = false;
        return conflictResult(request, 'conflict', request.reversesEventId);
      }
      const targetValue = parseScaledDecimal(targetAmount);
      const reversalValue = parseScaledDecimal(reversalAmount);
      economicReversesEventId = asString(target.economic_root_event_id);
      const ancestry = await currentEconomicAncestry(client, scope, economicReversesEventId);
      const ancestorsRemainWithinReversalCeiling = ancestry !== null && ancestry.every(({ tree, rootRow }) => {
        const currentNet = sumEconomicTree(tree);
        const nextNet = currentNet === null ? null : currentNet + reversalValue;
        return validEconomicNet(exactAmount(rootRow.amount), nextNet);
      });
      if (targetValue === 0n || (targetValue > 0n) === (reversalValue > 0n)
        || !ancestorsRemainWithinReversalCeiling) {
        if (bridge) await rollbackLedgerSavepoint(client); else await rollback(client);
        inTransaction = false;
        return conflictResult(request, 'conflict', request.reversesEventId);
      }
    }

    if (predecessor?.financial_effect === true && request.financialEffect) {
      const priorAmount = fromRow(predecessor, 'amount');
      const nextAmount = request.money.amount;
      const rootId = asString(predecessor.economic_root_event_id);
      const ancestry = await currentEconomicAncestry(client, scope, rootId);
      const oldValue = exactAmount(priorAmount);
      const newValue = exactAmount(nextAmount);
      const allAncestorsRemainWithinReversalCeiling = ancestry !== null && ancestry.every(({ tree, rootRow }) => {
        if (tree.length <= 1) return true;
        const currentNet = sumEconomicTree(tree);
        const nextNet = currentNet === null || oldValue === null || newValue === null
          ? null : currentNet - oldValue + newValue;
        const rootValue = rootRow.event_id === predecessor?.event_id ? newValue : exactAmount(rootRow.amount);
        return validEconomicNet(rootValue, nextNet);
      });
      if (!allAncestorsRemainWithinReversalCeiling) {
        if (bridge) await rollbackLedgerSavepoint(client); else await rollback(client);
        inTransaction = false;
        return conflictResult(request, 'conflict', currentSourceEventId);
      }
    }

    const persistedPayload = { ...request, ingestedAt };
    const eventValues: unknown[] = [
      request.eventId, request.schemaVersion, scope.tenantId, scope.projectId, request.correlationId,
      request.producer.module, request.producer.sourceRevision, request.producer.buildRevision,
      request.occurredAt, request.observedAt, ingestedAt, scope.environment, scope.billingMode,
      request.evidenceMode, request.verificationStatus, request.eventType, request.classification,
      request.valuation, request.settlementStatus, request.reconciliationStatus, request.reservationLifecycle,
      request.identities.reservationId, request.reservationAuthorizationEventId, request.identities.logicalOperationId,
      request.postingMapping.schemaVersion, request.postingMapping.sourceLineId,
      identityId(request.postingMapping.transportAttemptId), identityStatus(request.postingMapping.transportAttemptId),
      identityId(request.postingMapping.providerAttemptId), identityStatus(request.postingMapping.providerAttemptId),
      identityId(request.postingMapping.providerRequestId), identityStatus(request.postingMapping.providerRequestId),
      identityId(request.postingMapping.billableAttemptId), identityStatus(request.postingMapping.billableAttemptId),
      request.identities.sourceObservationId, request.sourceIdentity.source, request.sourceIdentity.sourceEventId,
      request.sourceIdentity.sourceObjectId, request.sourceIdentity.revisionSubjectId,
      request.sourceIdentity.sourceRevision, request.sourceIdentity.revisionSequence, request.sourceIdentity.contentHash,
      request.usage.completeness, JSON.stringify(request.usage.units), request.money.amount, request.money.currency,
      request.money.scale, JSON.stringify(request.sourceRefs), JSON.stringify(request.dimensions),
      request.pricing === null ? null : JSON.stringify(request.pricing),
      request.fxEvidence === null ? null : JSON.stringify(request.fxEvidence), request.financialEffect,
      economicRootEventId, economicEventType, economicReversesEventId, request.idempotencyKey,
      request.supersedesEventId, request.reversesEventId, eventHash, JSON.stringify(persistedPayload),
    ];
    const jsonValueIndexes = new Set([44, 48, 49, 50, 51, 60]);
    const eventPlaceholders = eventValues.map((_, index) => `$${index + 1}${jsonValueIndexes.has(index + 1) ? '::jsonb' : ''}`).join(', ');
    await client.query(
      `INSERT INTO cost_intelligence.financial_ledger_events (
        event_id, ledger_schema_version, tenant_id, project_id, correlation_id, producer_module,
        producer_source_revision, producer_build_revision, occurred_at, observed_at, ingested_at,
        environment, billing_mode, evidence_mode, verification_status, event_type, classification,
        valuation, settlement_status, reconciliation_status, reservation_lifecycle, reservation_id,
        reservation_authorization_event_id, logical_operation_id, posting_mapping_version, source_line_id,
        transport_attempt_id, transport_attempt_status, provider_attempt_id, provider_attempt_status,
        provider_request_id, provider_request_status, billable_attempt_id, billable_attempt_status,
        source_observation_id, source_name, source_event_id, source_object_id, source_revision_subject_id,
        source_revision, source_revision_sequence, source_content_hash, quantity_completeness, quantity_units,
        amount, currency, amount_scale, source_refs, dimensions, pricing, fx_evidence, financial_effect,
        economic_root_event_id, economic_event_type, economic_reverses_event_id,
        idempotency_key, supersedes_event_id, reverses_event_id, event_hash, event_payload
      ) VALUES (${eventPlaceholders})`,
      eventValues,
    );

    await client.query(
      `INSERT INTO cost_intelligence.financial_posting_attempt_mappings (
        tenant_id, project_id, environment, billing_mode, source_name, source_object_id, source_line_id,
        source_revision_sequence, mapping_version, logical_operation_id,
        transport_attempt_id, transport_attempt_status, provider_attempt_id, provider_attempt_status,
        provider_request_id, provider_request_status, billable_attempt_id, billable_attempt_status, event_id
      ) VALUES (${Array.from({ length: 19 }, (_, index) => `$${index + 1}`).join(', ')})`,
      [scope.tenantId, scope.projectId, scope.environment, scope.billingMode, request.sourceIdentity.source,
        request.sourceIdentity.sourceObjectId, request.postingMapping.sourceLineId, request.sourceIdentity.revisionSequence,
        request.postingMapping.schemaVersion, request.identities.logicalOperationId,
        identityId(request.postingMapping.transportAttemptId), identityStatus(request.postingMapping.transportAttemptId),
        identityId(request.postingMapping.providerAttemptId), identityStatus(request.postingMapping.providerAttemptId),
        identityId(request.postingMapping.providerRequestId), identityStatus(request.postingMapping.providerRequestId),
        identityId(request.postingMapping.billableAttemptId), identityStatus(request.postingMapping.billableAttemptId), request.eventId],
    );

    for (const binding of bindings) {
      await client.query(
        `UPDATE cost_intelligence.financial_ledger_identity_bindings SET first_event_id = $7
         WHERE tenant_id = $1 AND project_id = $2 AND environment = $3 AND billing_mode = $4
           AND identity_kind = $5 AND identity_value = $6 AND first_event_id IS NULL`,
        [scope.tenantId, scope.projectId, scope.environment, scope.billingMode, binding.kind, binding.value, request.eventId],
      );
    }
    await client.query(
      `UPDATE cost_intelligence.financial_source_revision_heads
       SET current_revision_sequence = $8, current_event_id = $9
       WHERE tenant_id = $1 AND project_id = $2 AND environment = $3 AND billing_mode = $4
         AND source_name = $5 AND source_object_id = $6 AND source_revision_subject_id = $7`,
      [scope.tenantId, scope.projectId, scope.environment, scope.billingMode, request.sourceIdentity.source,
        request.sourceIdentity.sourceObjectId, request.sourceIdentity.revisionSubjectId, request.sourceIdentity.revisionSequence, request.eventId],
    );
    if (bridge) await client.query('RELEASE SAVEPOINT ci04a_ledger_append'); else await client.query('COMMIT');
    inTransaction = false;
    return { ok: true, value: receipt(request, 'accepted', null, ingestedAt) };
  } catch (error) {
    if (client && inTransaction) if (bridge) await rollbackLedgerSavepoint(client); else await rollback(client);
    const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
    if (code === '23505' && client) {
      try {
        const existing = await client.query(
          `SELECT event_id, event_hash FROM cost_intelligence.financial_ledger_events
           WHERE tenant_id = $1 AND project_id = $2 AND environment = $3 AND billing_mode = $4
             AND (idempotency_key = $5 OR event_id = $6 OR source_observation_id = $7
               OR (source_name = $8 AND source_object_id = $9 AND source_event_id = $10
                 AND source_revision_subject_id = $11 AND source_revision_sequence = $12))
           ORDER BY CASE WHEN idempotency_key = $5 THEN 0 WHEN event_id = $6 THEN 1
             WHEN source_observation_id = $7 THEN 2 ELSE 3 END LIMIT 1`,
          [scope.tenantId, scope.projectId, scope.environment, scope.billingMode, request.idempotencyKey,
            request.eventId, request.identities.sourceObservationId, request.sourceIdentity.source,
            request.sourceIdentity.sourceObjectId, request.sourceIdentity.sourceEventId,
            request.sourceIdentity.revisionSubjectId, request.sourceIdentity.revisionSequence],
        );
        const row = existing.rows[0];
        if (row) {
          const existingId = fromRow(row, 'event_id');
          return { ok: true, value: receipt(request, fromRow(row, 'event_hash') === eventHash ? 'duplicate' : 'conflict', existingId, null) };
        }
      } catch {
        return conflictResult(request, 'conflict');
      }
      return conflictResult(request, 'conflict');
    }
    if (code === '23503' || code === '23514') {
      return conflictResult(request, 'conflict');
    }
    return failure(makeError('ledger', 'appendLedgerEvent', 'SOURCE_UNAVAILABLE', request.requestId, 'Ledger persistence is temporarily unavailable.'));
  } finally {
    if (!bridge) client?.release();
  }
}

type AmountAccumulator = {
  eventType: LedgerEventType;
  classification: LedgerClassification;
  currency: string;
  eventCount: number;
  knownAmountCount: number;
  unknownAmountCount: number;
  knownAmount: bigint;
};
type QuantityAccumulator = {
  eventType: LedgerEventType;
  classification: LedgerClassification;
  currency: string;
  unitName: string | null;
  relation: 'standalone' | 'included_subset' | 'unknown_relation' | null;
  includedIn: string | null;
  observationCount: number;
  knownQuantityCount: number;
  unknownQuantityCount: number;
  incompleteObservationCount: number;
  knownQuantity: bigint;
};

function keyFor(...parts: (string | null)[]): string {
  return JSON.stringify(parts);
}

function computeProjectionRows(rows: readonly Record<string, unknown>[], preserveIncludedIn: boolean): {
  amounts: Static<typeof ProjectionAmountSchema>[];
  quantities: Static<typeof ProjectionQuantitySchema>[];
} {
  const amounts = new Map<string, AmountAccumulator>();
  const quantities = new Map<string, QuantityAccumulator>();
  for (const row of rows) {
    const eventType = asString(row.event_type) as LedgerEventType;
    const classification = asString(row.classification) as LedgerClassification;
    const currency = asString(row.currency).trim();
    const amountKey = keyFor(eventType, classification, currency);
    let amount = amounts.get(amountKey);
    if (!amount) {
      amount = { eventType, classification, currency, eventCount: 0, knownAmountCount: 0, unknownAmountCount: 0, knownAmount: 0n };
      amounts.set(amountKey, amount);
    }
    amount.eventCount++;
    const rawAmount = fromRow(row, 'amount');
    if (rawAmount === null) amount.unknownAmountCount++;
    else {
      amount.knownAmountCount++;
      amount.knownAmount += parseScaledDecimal(rawAmount);
    }

    const completeness = asString(row.quantity_completeness) as 'unknown' | 'incomplete' | 'complete';
    const rawUnits = row.quantity_units;
    const units = typeof rawUnits === 'string' ? JSON.parse(rawUnits) as Array<Record<string, unknown>> : rawUnits as Array<Record<string, unknown>>;
    const addQuantity = (unitName: string | null, relation: QuantityAccumulator['relation'], includedIn: string | null,
      quantity: string | null, incomplete: boolean): void => {
      const quantityKey = keyFor(eventType, classification, currency, unitName, relation, includedIn);
      let accumulator = quantities.get(quantityKey);
      if (!accumulator) {
        accumulator = { eventType, classification, currency, unitName, relation, includedIn,
          observationCount: 0, knownQuantityCount: 0, unknownQuantityCount: 0, incompleteObservationCount: 0, knownQuantity: 0n };
        quantities.set(quantityKey, accumulator);
      }
      accumulator.observationCount++;
      if (incomplete) accumulator.incompleteObservationCount++;
      if (quantity === null) accumulator.unknownQuantityCount++;
      else {
        accumulator.knownQuantityCount++;
        accumulator.knownQuantity += parseScaledDecimal(quantity);
      }
    };
    if (units.length === 0) {
      if (completeness !== 'complete') addQuantity(null, null, null, null, completeness === 'incomplete');
    } else {
      for (const unit of units) {
        const unitName = typeof unit.name === 'string' ? unit.name : null;
        const relation = typeof unit.relation === 'string' ? unit.relation as QuantityAccumulator['relation'] : null;
        const includedIn = preserveIncludedIn && typeof unit.includedIn === 'string' ? unit.includedIn : null;
        const quantity = unit.quantity === null || unit.quantity === undefined ? null : asString(unit.quantity);
        addQuantity(unitName, relation, includedIn, quantity, completeness !== 'complete');
      }
    }
  }
  const amountRows = [...amounts.values()].map(item => {
    const completeness: Static<typeof ProjectionAmountSchema>['completeness'] = item.unknownAmountCount === 0
      ? 'complete' : item.knownAmountCount === 0 ? 'unknown' : 'partial';
    return {
      eventType: item.eventType, classification: item.classification, currency: item.currency,
      eventCount: item.eventCount, knownAmountCount: item.knownAmountCount, unknownAmountCount: item.unknownAmountCount,
      knownSubtotal: item.knownAmountCount === 0 ? null : formatScaledDecimal(item.knownAmount),
      totalAmount: item.unknownAmountCount > 0 ? null : formatScaledDecimal(item.knownAmount), completeness,
    };
  }).sort((left, right) => keyFor(left.eventType, left.classification, left.currency).localeCompare(keyFor(right.eventType, right.classification, right.currency)));
  const quantityRows = [...quantities.values()].map(item => {
    const completeness: Static<typeof ProjectionQuantitySchema>['completeness'] = item.unknownQuantityCount === 0 && item.incompleteObservationCount === 0
      ? 'complete' : item.knownQuantityCount === 0 && item.incompleteObservationCount === 0 ? 'unknown' : 'incomplete';
    return {
      eventType: item.eventType, classification: item.classification, currency: item.currency,
      unitName: item.unitName, relation: item.relation, ...(item.includedIn !== null ? { includedIn: item.includedIn } : {}),
      observationCount: item.observationCount,
      knownQuantityCount: item.knownQuantityCount, unknownQuantityCount: item.unknownQuantityCount,
      incompleteObservationCount: item.incompleteObservationCount,
      knownSubtotal: item.knownQuantityCount === 0 ? null : formatScaledDecimal(item.knownQuantity),
      totalQuantity: completeness === 'complete' ? formatScaledDecimal(item.knownQuantity) : null,
      completeness,
    };
  }).sort((left, right) => keyFor(left.eventType, left.classification, left.currency, left.unitName, left.relation, left.includedIn ?? null)
    .localeCompare(keyFor(right.eventType, right.classification, right.currency, right.unitName, right.relation, right.includedIn ?? null)));
  return { amounts: amountRows, quantities: quantityRows };
}

async function computeUnresolvedIntakeProjection(
  client: LedgerTransactionPort,
  scope: LedgerProjectionRequest['scope'],
  asOf: string,
): Promise<Static<typeof ProjectionUnresolvedIntakeSchema>> {
  const values = [scope.tenantId, scope.projectId, scope.environment, scope.billingMode, asOf];
  const quarantined = await client.query(
    `SELECT count(*)::integer AS count
     FROM cost_intelligence.usage_intake_quarantine
     WHERE tenant_id=$1 AND project_id=$2 AND environment=$3 AND billing_mode=$4 AND created_at <= $5`,
    values,
  );
  const heads = await client.query(
    `SELECT observation.billable_attempt_id, observation.source_observation_id,
            observation.event_id, observation.completeness, observation.valuation_basis
     FROM cost_intelligence.usage_intake_inbox observation
     WHERE observation.tenant_id=$1 AND observation.project_id=$2 AND observation.environment=$3
       AND observation.billing_mode=$4 AND observation.created_at <= $5
       AND observation.attempt_revision_accepted
       AND NOT EXISTS (
         SELECT 1 FROM cost_intelligence.usage_intake_inbox successor
         WHERE successor.tenant_id=observation.tenant_id AND successor.project_id=observation.project_id
           AND successor.environment=observation.environment AND successor.billing_mode=observation.billing_mode
           AND successor.billable_attempt_id=observation.billable_attempt_id
           AND successor.attempt_revision_accepted
           AND successor.event_facts->>'supersedes_observation_id'=observation.source_observation_id
           AND successor.created_at <= $5
       )
     ORDER BY observation.billable_attempt_id, observation.source_observation_id`,
    values,
  );
  const postedEvents = await client.query(
    `SELECT event_id FROM cost_intelligence.financial_ledger_events
     WHERE tenant_id=$1 AND project_id=$2 AND environment=$3 AND billing_mode=$4 AND ingested_at <= $5`,
    values,
  );
  const quarantinedObservationCount = Number(quarantined.rows[0]?.count ?? 0);
  const postedEventIds = new Set(postedEvents.rows.map(row => asString(row.event_id)));
  const capability=await client.query("SELECT to_regclass('cost_intelligence.budget_settlement_postings') IS NOT NULL AS reported_coverage");
  const coveredObservationIds=new Set<string>();
  if(capability.rows[0]?.reported_coverage===true){
    const coverage=await client.query(`SELECT jsonb_array_elements_text(p.intake_observation_ids) AS observation_id
      FROM cost_intelligence.budget_settlement_postings p
      JOIN cost_intelligence.financial_ledger_events e ON e.event_id=p.ledger_event_id
      WHERE p.tenant_id=$1 AND p.project_id=$2 AND p.environment=$3 AND p.billing_mode=$4
        AND e.tenant_id=p.tenant_id AND e.project_id=p.project_id AND e.environment=p.environment AND e.billing_mode=p.billing_mode
        AND p.amount_semantics='cumulative_attempt_total' AND p.recorded_at<=$5 AND e.ingested_at<=$5
        AND ${budgetExpenseSql('e')} AND e.valuation='provider_reported_unsettled' AND e.currency='USD' AND e.amount IS NOT NULL`,values);
    for(const row of coverage.rows)coveredObservationIds.add(asString(row.observation_id));
  }
  const unposted = heads.rows.filter(row => !postedEventIds.has(asString(row.event_id))&&!coveredObservationIds.has(asString(row.source_observation_id)));
  const awaitingEvidence = heads.rows.filter(row => asString(row.valuation_basis) === 'unknown'
    || asString(row.completeness) !== 'complete');
  const unknownEconomicExposureCount = quarantinedObservationCount + unposted.filter(row =>
    asString(row.valuation_basis) === 'unknown' || asString(row.completeness) !== 'complete').length;
  return {
    unknownEconomicExposureCount,
    quarantinedObservationCount,
    awaitingEvidenceAttemptCount: awaitingEvidence.length,
    unpostedAttemptCount: unposted.length,
  };
}

const CURRENT_INTAKE_REQUIRED_COLUMNS = [
  ['usage_intake_inbox', 'tenant_id'], ['usage_intake_inbox', 'project_id'],
  ['usage_intake_inbox', 'environment'], ['usage_intake_inbox', 'billing_mode'],
  ['usage_intake_inbox', 'source_observation_id'], ['usage_intake_inbox', 'idempotency_key'],
  ['usage_intake_inbox', 'request_id'], ['usage_intake_inbox', 'event_id'],
  ['usage_intake_inbox', 'logical_operation_id'], ['usage_intake_inbox', 'provider_attempt_id'],
  ['usage_intake_inbox', 'billable_attempt_id'], ['usage_intake_inbox', 'transport_attempt_id'],
  ['usage_intake_inbox', 'provider_request_id'], ['usage_intake_inbox', 'source_name'],
  ['usage_intake_inbox', 'occurred_at'], ['usage_intake_inbox', 'observed_at'],
  ['usage_intake_inbox', 'completeness'], ['usage_intake_inbox', 'valuation_basis'],
  ['usage_intake_inbox', 'payload_sha256'], ['usage_intake_inbox', 'idempotency_sha256'],
  ['usage_intake_inbox', 'provenance_sha256'], ['usage_intake_inbox', 'event_facts'],
  ['usage_intake_inbox', 'attempt_revision_accepted'], ['usage_intake_inbox', 'created_at'],
  ['usage_intake_attempts', 'tenant_id'], ['usage_intake_attempts', 'project_id'],
  ['usage_intake_attempts', 'environment'], ['usage_intake_attempts', 'billing_mode'],
  ['usage_intake_attempts', 'billable_attempt_id'], ['usage_intake_attempts', 'logical_operation_id'],
  ['usage_intake_attempts', 'provider_attempt_id'], ['usage_intake_attempts', 'first_observation_id'],
  ['usage_intake_attempts', 'current_observation_id'], ['usage_intake_attempts', 'current_ledger_event_id'],
  ['usage_intake_attempts', 'revision_sequence'], ['usage_intake_attempts', 'status'],
  ['usage_intake_attempts', 'completeness'], ['usage_intake_attempts', 'valuation_basis'],
  ['usage_intake_attempts', 'created_at'], ['usage_intake_attempts', 'updated_at'],
  ['usage_intake_outbox', 'tenant_id'], ['usage_intake_outbox', 'project_id'],
  ['usage_intake_outbox', 'environment'], ['usage_intake_outbox', 'billing_mode'],
  ['usage_intake_outbox', 'source_observation_id'], ['usage_intake_outbox', 'billable_attempt_id'],
  ['usage_intake_outbox', 'posting_payload'], ['usage_intake_outbox', 'status'],
  ['usage_intake_outbox', 'retry_count'], ['usage_intake_outbox', 'available_at'],
  ['usage_intake_outbox', 'last_error_code'], ['usage_intake_outbox', 'ledger_event_id'],
  ['usage_intake_outbox', 'completed_at'], ['usage_intake_outbox', 'created_at'],
  ['usage_intake_quarantine', 'diagnostic_ref'], ['usage_intake_quarantine', 'tenant_id'],
  ['usage_intake_quarantine', 'project_id'], ['usage_intake_quarantine', 'environment'],
  ['usage_intake_quarantine', 'billing_mode'], ['usage_intake_quarantine', 'reason_code'],
  ['usage_intake_quarantine', 'payload_sha256'], ['usage_intake_quarantine', 'created_at'],
  ['financial_projection_quantities', 'included_in'],
  ['financial_projection_snapshots', 'unknown_economic_exposure_count'],
  ['financial_projection_snapshots', 'quarantined_observation_count'],
  ['financial_projection_snapshots', 'awaiting_evidence_attempt_count'],
  ['financial_projection_snapshots', 'unposted_attempt_count'],
] as const;

const BUDGET_AUTHORITY_REQUIRED_COLUMNS = [
  ['budget_reservation_events','authorization_request'], ['budget_reservation_events','authority_binding'],
  ['budget_reservation_events','financial_expires_at'], ['budget_reservation_events','authorized_cap'],
  ['budget_reservation_events','authority_evidence'], ['budget_reservation_events','command_evidence'],
  ['budget_scope_policies','change_request'],
  ['budget_policy_decisions','decision_id'], ['budget_policy_decisions','tenant_id'], ['budget_policy_decisions','project_id'],
  ['budget_policy_decisions','environment'], ['budget_policy_decisions','billing_mode'], ['budget_policy_decisions','currency'],
  ['budget_policy_decisions','idempotency_key'], ['budget_policy_decisions','actor_reference'], ['budget_policy_decisions','source_authority_ref'],
  ['budget_policy_decisions','command_request'], ['budget_policy_decisions','command_receipt'], ['budget_policy_decisions','content_hash'],
  ['budget_reservation_acknowledgements','acknowledgement_id'], ['budget_reservation_acknowledgements','tenant_id'],
  ['budget_reservation_acknowledgements','project_id'], ['budget_reservation_acknowledgements','environment'],
  ['budget_reservation_acknowledgements','billing_mode'], ['budget_reservation_acknowledgements','currency'],
  ['budget_reservation_acknowledgements','reservation_id'], ['budget_reservation_acknowledgements','event_sequence'],
  ['budget_reservation_acknowledgements','expected_revision'], ['budget_reservation_acknowledgements','idempotency_key'],
  ['budget_reservation_acknowledgements','actor_reference'], ['budget_reservation_acknowledgements','source_authority_ref'],
  ['budget_reservation_acknowledgements','attempt_binding'], ['budget_reservation_acknowledgements','command_request'],
  ['budget_reservation_acknowledgements','content_hash'],
] as const;

/** Accept known authority health only with the actual additive artifacts, never a future numeric count. */
async function inspectBudgetAuthorityCapability(client:LedgerTransactionPort,migrationCount:number):Promise<void>{
  const artifactResult=await client.query(`SELECT
    to_regclass('cost_intelligence.budget_policy_decisions') IS NOT NULL AS has_decisions,
    to_regclass('cost_intelligence.budget_reservation_acknowledgements') IS NOT NULL AS has_acknowledgements,
    to_regclass('cost_intelligence.budget_one_reservation_per_billable_attempt') IS NOT NULL AS has_attempt_index,
    to_regprocedure('cost_intelligence.guard_budget_revision_append()') IS NOT NULL AS has_revision_function,
    (SELECT count(*) FROM information_schema.columns WHERE table_schema='cost_intelligence' AND (
      (table_name='budget_reservation_events' AND column_name IN ('authorization_request','authority_binding','financial_expires_at','authorized_cap','authority_evidence','command_evidence'))
      OR (table_name='budget_scope_policies' AND column_name='change_request')))::integer AS extension_columns`);
  const artifacts=artifactResult.rows[0];if(!artifacts)throw new Error('Budget authority capability metadata is unavailable.');
  const extensionCount=Number(artifacts.extension_columns);
  const hasAny=artifacts.has_decisions===true||artifacts.has_acknowledgements===true||artifacts.has_attempt_index===true||artifacts.has_revision_function===true||extensionCount>0;
  if(migrationCount===9){if(hasAny)throw new Error('Partial budget authority artifacts cannot be accepted as legacy intake health.');return;}
  if((migrationCount!==10&&migrationCount!==11)||artifacts.has_decisions!==true||artifacts.has_acknowledgements!==true||extensionCount!==7)throw new Error('Budget authority capability is incomplete.');
  const missing=await client.query(`SELECT required.table_name,required.column_name FROM unnest($1::text[],$2::text[]) AS required(table_name,column_name)
    WHERE NOT EXISTS(SELECT 1 FROM information_schema.columns c WHERE c.table_schema='cost_intelligence' AND c.table_name=required.table_name AND c.column_name=required.column_name)`,
    [BUDGET_AUTHORITY_REQUIRED_COLUMNS.map(([table])=>table),BUDGET_AUTHORITY_REQUIRED_COLUMNS.map(([,column])=>column)]);
  if(missing.rows.length)throw new Error('Budget authority columns are incomplete.');
  const invariants=await client.query(`SELECT
    EXISTS(SELECT 1 FROM pg_index i JOIN pg_class idx ON idx.oid=i.indexrelid JOIN pg_namespace ns ON ns.oid=idx.relnamespace
      WHERE ns.nspname='cost_intelligence' AND idx.relname='budget_one_reservation_per_billable_attempt' AND i.indisunique AND i.indisvalid
        AND i.indrelid='cost_intelligence.budget_reservation_events'::regclass
        AND pg_get_expr(i.indpred,i.indrelid)='(event_sequence = 1)'
        AND pg_get_indexdef(i.indexrelid) LIKE '%(tenant_id, project_id, environment, billing_mode, billable_attempt_id) WHERE%') AS attempt_unique,
    EXISTS(SELECT 1 FROM pg_constraint c WHERE c.conrelid='cost_intelligence.budget_reservation_acknowledgements'::regclass AND c.contype='u'
      AND pg_get_constraintdef(c.oid)='UNIQUE (tenant_id, project_id, environment, billing_mode, idempotency_key)') AS ack_key_unique,
    EXISTS(SELECT 1 FROM pg_constraint c WHERE c.conrelid='cost_intelligence.budget_reservation_acknowledgements'::regclass AND c.contype='u'
      AND pg_get_constraintdef(c.oid)='UNIQUE (tenant_id, project_id, environment, billing_mode, reservation_id, event_sequence)') AS ack_revision_unique,
    EXISTS(SELECT 1 FROM pg_constraint c WHERE c.conrelid='cost_intelligence.budget_policy_decisions'::regclass AND c.contype='u'
      AND pg_get_constraintdef(c.oid)='UNIQUE (tenant_id, project_id, environment, billing_mode, idempotency_key)') AS policy_key_unique,
    (SELECT count(*) FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
      WHERE NOT t.tgisinternal AND t.tgenabled IN ('O','A') AND t.tgtype=7 AND NOT p.prosecdef
        AND t.tgfoid='cost_intelligence.guard_budget_revision_append()'::regprocedure
        AND ((t.tgname='budget_reservation_events_revision_guard' AND t.tgrelid='cost_intelligence.budget_reservation_events'::regclass)
          OR (t.tgname='budget_reservation_acknowledgements_revision_guard' AND t.tgrelid='cost_intelligence.budget_reservation_acknowledgements'::regclass)))::integer AS revision_guards,
    (SELECT count(*) FROM pg_class c WHERE c.oid IN ('cost_intelligence.budget_policy_decisions'::regclass,'cost_intelligence.budget_reservation_acknowledgements'::regclass)
      AND c.relrowsecurity AND c.relforcerowsecurity)::integer AS forced_rls_tables`);
  const row=invariants.rows[0];if(!row||row.attempt_unique!==true||row.ack_key_unique!==true||row.ack_revision_unique!==true||row.policy_key_unique!==true
    ||Number(row.revision_guards)!==2||Number(row.forced_rls_tables)!==2)throw new Error('Budget authority constraints or revision guards are incomplete.');
}

const SETTLEMENT_TABLES=['budget_source_observations','budget_lifecycle_observations','budget_command_receipts',
  'budget_settlement_postings','budget_reconciliation_exceptions','budget_recovery_cursors','budget_reported_observations'] as const;
const SETTLEMENT_REQUIRED_COLUMNS:Readonly<Record<string,readonly string[]>>={
  budget_source_observations:['observation_id','record_id','record_revision','record_hash','predecessor_hash','source_bytes_hash','source_reference','collector_record','current_evidence','authentication_evidence','financial_source_facts'],
  budget_lifecycle_observations:['observation_id','reservation_id','event_sequence','expected_revision','idempotency_key','event_type','consumed_amount','released_amount','usage_finality','command_request','command_evidence'],
  budget_command_receipts:['receipt_id','idempotency_key','reservation_id','command_request','command_receipt','command_evidence','content_hash'],
  budget_settlement_postings:['posting_id','reservation_id','reservation_revision','observation_id','ledger_event_id','amount_semantics','cumulative_amount','intake_observation_ids'],
  budget_reconciliation_exceptions:['exception_revision_id','exception_id','revision','reservation_id','reservation_revision','idempotency_key','state','reason','owner_reference','action_reference','evidence_reference','command_request','variance_amount'],
  budget_reported_observations:['source_observation_id','reservation_id','reservation_revision','usage_event','provider_evidence','provider_evidence_id','provider_evidence_revision','provider_evidence_hash','supersedes_observation_id','observation_digest','collector_observation_id','ledger_event_id'],
  budget_recovery_cursors:['cursor_id','job_reference','revision','after_recorded_at','after_reservation_id','completed_cycle','command_request','command_receipt','idempotency_key'],
};
async function inspectBudgetSettlementCapability(client:LedgerTransactionPort,migrationCount:number):Promise<void>{
  const presence=await client.query(`SELECT required.name,to_regclass('cost_intelligence.'||required.name) IS NOT NULL AS present
    FROM unnest($1::text[]) AS required(name)`,[SETTLEMENT_TABLES]);
  const constraints=await client.query(`SELECT conname,convalidated,pg_get_constraintdef(oid) AS definition FROM pg_constraint
    WHERE connamespace='cost_intelligence'::regnamespace AND contype='c' AND
      ((conname='financial_ledger_events_valuation_check' AND conrelid=to_regclass('cost_intelligence.financial_ledger_events'))
      OR(conname='usage_intake_inbox_valuation_basis_check' AND conrelid=to_regclass('cost_intelligence.usage_intake_inbox'))
      OR(conname='usage_intake_attempts_valuation_basis_check' AND conrelid=to_regclass('cost_intelligence.usage_intake_attempts')))`);
  const privacyGuard=await client.query(`SELECT to_regprocedure('cost_intelligence.guard_financial_privacy_scope_insert()') IS NOT NULL AS present`);
  const hasAny=privacyGuard.rows[0]?.present===true||presence.rows.some(row=>row.present===true)||constraints.rows.some(row=>String(row.definition).includes('provider_reported_unsettled'));
  if(migrationCount!==11){if(hasAny)throw new Error('Settlement artifacts cannot masquerade as legacy finance health.');return;}
  if(presence.rows.length!==7||presence.rows.some(row=>row.present!==true)||constraints.rows.length!==3)throw new Error('Settlement capability is incomplete.');
  const enumColumns:Record<string,string>={financial_ledger_events_valuation_check:'valuation',
    usage_intake_inbox_valuation_basis_check:'valuation_basis',usage_intake_attempts_valuation_basis_check:'valuation_basis'};
  for(const row of constraints.rows){
    const column=enumColumns[String(row.conname)];
    const expected=`CHECK ((${column} = ANY (ARRAY['unknown'::text, 'estimated'::text, 'provider_confirmed'::text, 'provider_reported_unsettled'::text])))`;
    if(row.convalidated!==true||String(row.definition).replace(/\s+/g,' ').trim()!==expected)
      throw new Error('Reported valuation CHECK is not the exact known contract.');
  }
  const tables:string[]=[],columns:string[]=[];
  for(const table of SETTLEMENT_TABLES)for(const column of ['tenant_id','project_id','environment','billing_mode','recorded_at',...SETTLEMENT_REQUIRED_COLUMNS[table]!]){tables.push(table);columns.push(column);}
  const missing=await client.query(`SELECT required.table_name,required.column_name FROM unnest($1::text[],$2::text[]) AS required(table_name,column_name)
    WHERE NOT EXISTS(SELECT 1 FROM information_schema.columns c WHERE c.table_schema='cost_intelligence' AND c.table_name=required.table_name AND c.column_name=required.column_name)`,[tables,columns]);
  if(missing.rows.length)throw new Error('Settlement capability columns are incomplete.');
  const security=await client.query(`SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity,pg_get_userbyid(c.relowner) AS owner,
    (SELECT count(*) FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal AND t.tgenabled IN ('O','A')
      AND t.tgfoid='cost_intelligence.reject_ledger_projection_mutation()'::regprocedure
      AND NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid=t.tgfoid)
      AND ((t.tgname=c.relname||'_append_only' AND t.tgtype=27) OR (t.tgname=c.relname||'_no_truncate' AND t.tgtype=34)))::int AS append_guards
    FROM pg_class c JOIN pg_namespace ns ON ns.oid=c.relnamespace WHERE ns.nspname='cost_intelligence' AND c.relname=ANY($1::text[])`,[SETTLEMENT_TABLES]);
  if(security.rows.length!==7||security.rows.some(row=>row.owner!=='ci_finance_owner'||row.relrowsecurity!==true||row.relforcerowsecurity!==true||Number(row.append_guards)!==2))throw new Error('Settlement append-only scoped security is incomplete.');
  const policies=await client.query(`SELECT tablename,roles::text[],cmd,permissive,qual,with_check FROM pg_policies
    WHERE schemaname='cost_intelligence' AND tablename=ANY($1::text[])`,[SETTLEMENT_TABLES]);
  const policyExpression=(value:unknown)=>String(value).replace(/\s|[()]/g,'').replaceAll('cost_intelligence.','');
  const exactScope='finance_scope_matchestenant_id,project_id,environment,billing_mode';
  if(policies.rows.length!==7||policies.rows.some(row=>JSON.stringify(row.roles)!==JSON.stringify(['ci_finance_runtime'])||row.cmd!=='ALL'||row.permissive!=='PERMISSIVE'
    ||policyExpression(row.qual)!==exactScope||policyExpression(row.with_check)!==exactScope))throw new Error('Settlement row policies are not the exact financial scope.');
  const expectedGuards=[
    ['budget_lifecycle_observations','budget_lifecycle_observations_revision_guard','guard_budget_revision_append'],
    ['budget_source_observations','budget_source_observations_revision_guard','guard_budget_source_append'],
    ['budget_reported_observations','budget_reported_observations_revision_guard','guard_budget_reported_append'],
    ['budget_reconciliation_exceptions','budget_reconciliation_exceptions_revision_guard','guard_budget_queue_append'],
    ['budget_recovery_cursors','budget_recovery_cursors_revision_guard','guard_budget_queue_append'],
    ['financial_privacy_quarantine','financial_privacy_quarantine_scope_insert_guard','guard_financial_privacy_scope_insert'],
  ];
  const guards=await client.query(`SELECT c.relname,t.tgname,p.proname,t.tgtype,t.tgenabled,p.prosecdef,t.tgisinternal,p.proconfig,pg_get_userbyid(p.proowner) AS function_owner
    FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_class c ON c.oid=t.tgrelid
    JOIN pg_namespace ns ON ns.oid=c.relnamespace JOIN pg_namespace pn ON pn.oid=p.pronamespace
    WHERE ns.nspname='cost_intelligence' AND pn.nspname='cost_intelligence' AND c.relname=ANY($1::text[])
      AND p.proname=ANY($2::text[])`,[[...SETTLEMENT_TABLES,'financial_privacy_quarantine'],expectedGuards.map(([, ,fn])=>fn)]);
  if(guards.rows.length!==expectedGuards.length||expectedGuards.some(([table,name,fn])=>guards.rows.filter(row=>
    row.relname===table&&row.tgname===name&&row.proname===fn&&Number(row.tgtype)===7
    && ['O','A'].includes(String(row.tgenabled))&&row.prosecdef===false&&row.tgisinternal===false).length!==1))
    throw new Error('Settlement guards are not the exact individual table/function/event bindings.');
  const privacyInsertGuard=guards.rows.find(row=>row.proname==='guard_financial_privacy_scope_insert');
  if(privacyInsertGuard?.function_owner!=='ci_finance_owner'||JSON.stringify(privacyInsertGuard.proconfig)!==JSON.stringify(['search_path=pg_catalog, cost_intelligence']))
    throw new Error('Privacy insert serialization does not use the trusted Finance owner and fixed search path.');
  const requiredUnique:Record<string,readonly string[]>={
    budget_source_observations:['UNIQUE (tenant_id, project_id, environment, billing_mode, record_id, record_revision)'],
    budget_lifecycle_observations:['UNIQUE (tenant_id, project_id, environment, billing_mode, reservation_id, event_sequence)','UNIQUE (tenant_id, project_id, environment, billing_mode, idempotency_key)'],
    budget_command_receipts:['UNIQUE (tenant_id, project_id, environment, billing_mode, idempotency_key)'],
    budget_settlement_postings:['UNIQUE (tenant_id, project_id, environment, billing_mode, reservation_id, reservation_revision)'],
    budget_reconciliation_exceptions:['UNIQUE (tenant_id, project_id, environment, billing_mode, exception_id, revision)','UNIQUE (tenant_id, project_id, environment, billing_mode, exception_id, idempotency_key)'],
    budget_recovery_cursors:['UNIQUE (tenant_id, project_id, environment, billing_mode, currency, job_reference, revision)','UNIQUE (tenant_id, project_id, environment, billing_mode, idempotency_key)'],
    budget_reported_observations:['PRIMARY KEY (tenant_id, project_id, environment, billing_mode, source_observation_id)','UNIQUE (tenant_id, project_id, environment, billing_mode, provider_evidence_id, provider_evidence_revision)'],
  };
  const requiredForeign:Record<string,readonly string[]>={
    budget_settlement_postings:['FOREIGN KEY (observation_id) REFERENCES cost_intelligence.budget_source_observations(observation_id)','FOREIGN KEY (ledger_event_id) REFERENCES cost_intelligence.financial_ledger_events(event_id)'],
    budget_reported_observations:['FOREIGN KEY (collector_observation_id) REFERENCES cost_intelligence.budget_source_observations(observation_id)','FOREIGN KEY (ledger_event_id) REFERENCES cost_intelligence.financial_ledger_events(event_id)'],
  };
  const bindings=await client.query(`SELECT c.relname,k.convalidated,k.condeferrable,pg_get_constraintdef(k.oid) AS definition
    FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace ns ON ns.oid=c.relnamespace
    WHERE ns.nspname='cost_intelligence' AND c.relname=ANY($1::text[]) AND k.contype IN ('p','u','f')`,[SETTLEMENT_TABLES]);
  for(const table of SETTLEMENT_TABLES)for(const expected of [...(requiredUnique[table]??[]),...(requiredForeign[table]??[])])
    if(bindings.rows.filter(row=>row.relname===table&&row.convalidated===true&&row.condeferrable===false&&row.definition===expected).length!==1)
      throw new Error('Settlement immutable identity or financial-source foreign key is incomplete.');

}
/** Internal financial producer capability: schema11 requires its actual scoped artifacts, independent of reporting migration0012. */
export async function requireBudgetSettlementCapability(client:LedgerTransactionPort):Promise<void>{
  const result=await client.query('SELECT migrations_ready,required_migrations_present FROM cost_intelligence.foundation_health');
  if(result.rows[0]?.migrations_ready!==true||Number(result.rows[0]?.required_migrations_present)!==11)throw new Error('The exact Finance settlement migration is required.');
  await inspectBudgetAuthorityCapability(client,11);await inspectBudgetSettlementCapability(client,11);
}

type IntakeProjectionCapability = 'legacy' | 'available';

async function inspectIntakeProjectionCapability(client: LedgerTransactionPort): Promise<IntakeProjectionCapability> {
  const healthResult = await client.query(
    'SELECT migrations_ready, required_migrations_present FROM cost_intelligence.foundation_health',
  );
  const health = healthResult.rows[0];
  if (!health || health.migrations_ready !== true) throw new Error('Finance migration health is incomplete.');
  await inspectBudgetSettlementCapability(client,Number(health.required_migrations_present));

  const schemaResult = await client.query(
    `SELECT
       to_regclass('cost_intelligence.usage_intake_inbox') IS NOT NULL AS has_inbox,
       to_regclass('cost_intelligence.usage_intake_attempts') IS NOT NULL AS has_attempts,
       to_regclass('cost_intelligence.usage_intake_outbox') IS NOT NULL AS has_outbox,
       to_regclass('cost_intelligence.usage_intake_quarantine') IS NOT NULL AS has_quarantine,
       EXISTS (SELECT 1 FROM information_schema.columns
         WHERE table_schema='cost_intelligence' AND table_name='financial_projection_quantities'
           AND column_name='included_in') AS has_included_in,
       (SELECT count(*) FROM information_schema.columns
         WHERE table_schema='cost_intelligence' AND table_name='financial_projection_snapshots'
           AND column_name IN ('unknown_economic_exposure_count', 'quarantined_observation_count',
             'awaiting_evidence_attempt_count', 'unposted_attempt_count'))::integer AS unresolved_count_columns`,
  );
  const schema = schemaResult.rows[0];
  if (!schema) throw new Error('Finance projection capability metadata is unavailable.');
  const hasAnyIntakeTable = schema.has_inbox === true || schema.has_attempts === true
    || schema.has_outbox === true || schema.has_quarantine === true;
  const hasAllIntakeTables = schema.has_inbox === true && schema.has_attempts === true
    && schema.has_outbox === true && schema.has_quarantine === true;
  const hasIncludedIn = schema.has_included_in === true;
  const unresolvedCountColumnCount = Number(schema.unresolved_count_columns);
  const hasAnyProjectionExtension = hasIncludedIn || unresolvedCountColumnCount > 0;
  const migrationCount = Number(health.required_migrations_present);
  const currentCapabilityDetected = migrationCount===9 || migrationCount===10 || migrationCount===11 || hasAnyIntakeTable || hasAnyProjectionExtension;

  if (!currentCapabilityDetected && migrationCount >= 3 && migrationCount <= 8) return 'legacy';
  if ((migrationCount !== 9 && migrationCount !== 10 && migrationCount!==11) || !hasAllIntakeTables || !hasIncludedIn || unresolvedCountColumnCount !== 4) {
    throw new Error('Usage intake projection capability is incomplete.');
  }

  const columnNames = CURRENT_INTAKE_REQUIRED_COLUMNS.map(([, column]) => column);
  const tableNames = CURRENT_INTAKE_REQUIRED_COLUMNS.map(([table]) => table);
  const missingColumns = await client.query(
    `SELECT required.table_name, required.column_name
     FROM unnest($1::text[], $2::text[]) AS required(table_name, column_name)
     WHERE NOT EXISTS (
       SELECT 1 FROM information_schema.columns column_info
       WHERE column_info.table_schema='cost_intelligence'
         AND column_info.table_name=required.table_name
         AND column_info.column_name=required.column_name
     )`,
    [tableNames, columnNames],
  );
  if (missingColumns.rows.length !== 0) throw new Error('Usage intake projection columns are incomplete.');
  await inspectBudgetAuthorityCapability(client,migrationCount);
  return 'available';
}

/** Rebuild and persist an immutable as-of snapshot using exact integer decimal arithmetic. */
export async function rebuildLedgerProjection(
  value: unknown,
  ports: LedgerRuntimePorts,
): Promise<ApiResult<LedgerProjection>> {
  const validated = validateLedgerProjectionRequestBoundary(value);
  if (!validated.ok) return failure(validated.error);
  const request = validated.value;
  const authorizationError = await trustedScope(request, ports, 'rebuildLedgerProjection', 'ledger.rebuildLedgerProjection');
  if (authorizationError) return failure(authorizationError);
  let client: LedgerTransactionPort | undefined;
  let inTransaction = false;
  try {
    client = await ports.database.connect();
    await client.query('BEGIN');
    inTransaction = true;
    await bindFinancialDatabaseScope(client, request.scope);
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`ci02-ledger:${request.scope.tenantId}:${request.scope.projectId}:${request.scope.environment}:${request.scope.billingMode}`],
    );
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`ci02-projection:${request.scope.tenantId}:${request.scope.projectId}:${request.scope.environment}:${request.scope.billingMode}:${request.asOf}`],
    );
    const legacyHistoryError = await legacyFinancialScopeError(
      client, request.scope, 'rebuildLedgerProjection', request.requestId,
    );
    if (legacyHistoryError) {
      await rollback(client);
      inTransaction = false;
      return failure(legacyHistoryError);
    }
    const intakeCapability = await inspectIntakeProjectionCapability(client);
    const hasIncludedIn = intakeCapability === 'available';
    const events = await client.query(
      `SELECT e.event_id, e.event_hash, e.event_type, e.classification, e.currency, e.amount::text AS amount,
              e.quantity_completeness, e.quantity_units
       FROM cost_intelligence.financial_ledger_events e
       WHERE e.tenant_id = $1 AND e.project_id = $2 AND e.environment = $3 AND e.billing_mode = $4
         AND e.ingested_at <= $5 AND e.financial_effect
         AND NOT EXISTS (
           SELECT 1 FROM cost_intelligence.financial_ledger_events successor
           WHERE successor.supersedes_event_id = e.event_id AND successor.ingested_at <= $5
         )
       ORDER BY e.event_id`,
      [request.scope.tenantId, request.scope.projectId, request.scope.environment, request.scope.billingMode, request.asOf],
    );
    const computed = computeProjectionRows(events.rows, hasIncludedIn);
    const unresolvedIntake = intakeCapability === 'available'
      ? await computeUnresolvedIntakeProjection(client, request.scope, request.asOf)
      : undefined;
    const eventEvidence = events.rows.map(row => ({ eventId: asString(row.event_id), eventHash: asString(row.event_hash) }));
    const content = {
      schemaVersion: '1.0.0', scope: request.scope, asOf: request.asOf,
      eventEvidence, eventCount: events.rows.length, amounts: computed.amounts, quantities: computed.quantities,
      ...(unresolvedIntake ? { unresolvedIntake } : {}),
    };
    const projectionHash = await hashValue(content);
    const snapshot: LedgerProjection = {
      schemaVersion: '1.0.0', snapshotId: projectionHash, projectionHash,
      scope: request.scope, asOf: request.asOf, eventCount: events.rows.length,
      amounts: computed.amounts, quantities: computed.quantities,
      ...(unresolvedIntake ? { unresolvedIntake } : {}),
    };
    const inserted = unresolvedIntake
      ? await client.query(
        `INSERT INTO cost_intelligence.financial_projection_snapshots
          (snapshot_id, tenant_id, project_id, environment, billing_mode, as_of, event_count,
           unknown_economic_exposure_count, quarantined_observation_count,
           awaiting_evidence_attempt_count, unposted_attempt_count, projection_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (snapshot_id) DO NOTHING`,
        [projectionHash, request.scope.tenantId, request.scope.projectId, request.scope.environment, request.scope.billingMode,
          request.asOf, events.rows.length, unresolvedIntake.unknownEconomicExposureCount,
          unresolvedIntake.quarantinedObservationCount, unresolvedIntake.awaitingEvidenceAttemptCount,
          unresolvedIntake.unpostedAttemptCount, projectionHash],
      )
      : await client.query(
        `INSERT INTO cost_intelligence.financial_projection_snapshots
          (snapshot_id, tenant_id, project_id, environment, billing_mode, as_of, event_count, projection_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (snapshot_id) DO NOTHING`,
        [projectionHash, request.scope.tenantId, request.scope.projectId, request.scope.environment, request.scope.billingMode,
          request.asOf, events.rows.length, projectionHash],
      );
    if (inserted.rowCount !== 0) {
      for (const item of computed.amounts) {
        await client.query(
          `INSERT INTO cost_intelligence.financial_projection_amounts
            (snapshot_id, event_type, classification, currency, event_count, known_amount_count,
             unknown_amount_count, known_subtotal, total_amount, amount_completeness)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [projectionHash, item.eventType, item.classification, item.currency, item.eventCount, item.knownAmountCount,
            item.unknownAmountCount, item.knownSubtotal, item.totalAmount, item.completeness],
        );
      }
      for (const item of computed.quantities) {
        if (hasIncludedIn) {
          await client.query(
            `INSERT INTO cost_intelligence.financial_projection_quantities
              (snapshot_id, event_type, classification, currency, unit_name, relation, included_in, observation_count,
               known_quantity_count, unknown_quantity_count, incomplete_observation_count, known_subtotal,
               total_quantity, quantity_completeness)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
            [projectionHash, item.eventType, item.classification, item.currency, item.unitName, item.relation,
              item.includedIn ?? null, item.observationCount, item.knownQuantityCount, item.unknownQuantityCount,
              item.incompleteObservationCount, item.knownSubtotal, item.totalQuantity, item.completeness],
          );
        } else {
          await client.query(
            `INSERT INTO cost_intelligence.financial_projection_quantities
              (snapshot_id, event_type, classification, currency, unit_name, relation, observation_count,
               known_quantity_count, unknown_quantity_count, incomplete_observation_count, known_subtotal,
               total_quantity, quantity_completeness)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
            [projectionHash, item.eventType, item.classification, item.currency, item.unitName, item.relation,
              item.observationCount, item.knownQuantityCount, item.unknownQuantityCount,
              item.incompleteObservationCount, item.knownSubtotal, item.totalQuantity, item.completeness],
          );
        }
      }
    }
    const unresolvedHeaderColumns = unresolvedIntake
      ? `unknown_economic_exposure_count, quarantined_observation_count,
         awaiting_evidence_attempt_count, unposted_attempt_count`
      : `NULL::integer AS unknown_economic_exposure_count, NULL::integer AS quarantined_observation_count,
         NULL::integer AS awaiting_evidence_attempt_count, NULL::integer AS unposted_attempt_count`;
    const persistedHeader = await client.query(
      `SELECT tenant_id, project_id, environment, billing_mode,
              to_char(as_of AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS as_of_utc,
              event_count, ${unresolvedHeaderColumns}, projection_hash
       FROM cost_intelligence.financial_projection_snapshots WHERE snapshot_id = $1`,
      [projectionHash],
    );
    const header = persistedHeader.rows[0];
    const unresolvedHeaderMatches = unresolvedIntake
      ? Number(header?.unknown_economic_exposure_count) === unresolvedIntake.unknownEconomicExposureCount
        && Number(header?.quarantined_observation_count) === unresolvedIntake.quarantinedObservationCount
        && Number(header?.awaiting_evidence_attempt_count) === unresolvedIntake.awaitingEvidenceAttemptCount
        && Number(header?.unposted_attempt_count) === unresolvedIntake.unpostedAttemptCount
      : header?.unknown_economic_exposure_count === null && header?.quarantined_observation_count === null
        && header?.awaiting_evidence_attempt_count === null && header?.unposted_attempt_count === null;
    if (!header || fromRow(header, 'tenant_id') !== request.scope.tenantId
      || fromRow(header, 'project_id') !== request.scope.projectId
      || fromRow(header, 'environment') !== request.scope.environment
      || fromRow(header, 'billing_mode') !== request.scope.billingMode
      || canonicalProjectionInstant(asString(header.as_of_utc)) !== request.asOf
      || Number(header.event_count) !== events.rows.length
      || !unresolvedHeaderMatches
      || fromRow(header, 'projection_hash') !== projectionHash) {
      throw new Error('Persisted snapshot header does not match its content address.');
    }
    const persistedAmounts = await client.query(
      `SELECT event_type, classification, currency, event_count, known_amount_count, unknown_amount_count,
              known_subtotal::text AS known_subtotal, total_amount::text AS total_amount, amount_completeness
       FROM cost_intelligence.financial_projection_amounts WHERE snapshot_id = $1
       ORDER BY event_type, classification, currency`,
      [projectionHash],
    );
    const normalizedAmounts = persistedAmounts.rows.map(row => ({
      eventType: asString(row.event_type) as LedgerEventType,
      classification: asString(row.classification) as LedgerClassification,
      currency: asString(row.currency).trim(),
      eventCount: Number(row.event_count), knownAmountCount: Number(row.known_amount_count),
      unknownAmountCount: Number(row.unknown_amount_count),
      knownSubtotal: fromRow(row, 'known_subtotal') === null ? null : formatScaledDecimal(parseScaledDecimal(asString(row.known_subtotal))),
      totalAmount: fromRow(row, 'total_amount') === null ? null : formatScaledDecimal(parseScaledDecimal(asString(row.total_amount))),
      completeness: asString(row.amount_completeness) as Static<typeof ProjectionAmountSchema>['completeness'],
    }));
    if (JSON.stringify(normalizedAmounts) !== JSON.stringify(computed.amounts)) {
      throw new Error('Persisted projection amounts do not match their content address.');
    }
    const persistedQuantities = await client.query(
      `SELECT event_type, classification, currency, unit_name, relation,
              ${hasIncludedIn ? 'included_in' : 'NULL::text AS included_in'}, observation_count,
              known_quantity_count, unknown_quantity_count, incomplete_observation_count,
              known_subtotal::text AS known_subtotal, total_quantity::text AS total_quantity, quantity_completeness
       FROM cost_intelligence.financial_projection_quantities WHERE snapshot_id = $1
       ORDER BY event_type, classification, currency, unit_name NULLS FIRST, relation NULLS FIRST, included_in NULLS FIRST`,
      [projectionHash],
    );
    const normalizedQuantities = persistedQuantities.rows.map(row => ({
      eventType: asString(row.event_type) as LedgerEventType,
      classification: asString(row.classification) as LedgerClassification,
      currency: asString(row.currency).trim(),
      unitName: fromRow(row, 'unit_name'),
      relation: fromRow(row, 'relation') as QuantityAccumulator['relation'],
      ...(fromRow(row, 'included_in') !== null ? { includedIn: fromRow(row, 'included_in')! } : {}),
      observationCount: Number(row.observation_count), knownQuantityCount: Number(row.known_quantity_count),
      unknownQuantityCount: Number(row.unknown_quantity_count), incompleteObservationCount: Number(row.incomplete_observation_count),
      knownSubtotal: fromRow(row, 'known_subtotal') === null ? null : formatScaledDecimal(parseScaledDecimal(asString(row.known_subtotal))),
      totalQuantity: fromRow(row, 'total_quantity') === null ? null : formatScaledDecimal(parseScaledDecimal(asString(row.total_quantity))),
      completeness: asString(row.quantity_completeness) as Static<typeof ProjectionQuantitySchema>['completeness'],
    })).sort((left, right) => keyFor(left.eventType, left.classification, left.currency, left.unitName, left.relation, left.includedIn ?? null)
      .localeCompare(keyFor(right.eventType, right.classification, right.currency, right.unitName, right.relation, right.includedIn ?? null)));
    if (JSON.stringify(normalizedQuantities) !== JSON.stringify(computed.quantities)) {
      throw new Error('Persisted projection quantities do not match their content address.');
    }
    await client.query('COMMIT');
    inTransaction = false;
    return { ok: true, value: snapshot };
  } catch {
    if (client && inTransaction) await rollback(client);
    return failure(makeError('ledger', 'rebuildLedgerProjection', 'SOURCE_UNAVAILABLE', request.requestId, 'Ledger projection rebuild is temporarily unavailable.'));
  } finally {
    client?.release();
  }
}

export function isLedgerRequestValid(schema: TSchema, value: unknown): boolean {
  return Value.Check(schema, value);
}
