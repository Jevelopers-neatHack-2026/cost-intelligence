import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import {
  authorizeFinanceOperation,
  errorEnvelope,
  failure,
  TrustedScopeSchema,
  validateRequest,
  type ApiResult,
  type FinanceAuthorizationDecision,
  type PricingAuthorizationCompatibilityDecision,
  type RuntimePorts,
  type Validation,
} from '../shared/contracts.js';
import { validateCanonical, type SharedUsageEvent } from '../shared/canonical.js';
import { bindFinancialDatabaseScope } from '../shared/database-scope.js';
import {
  appendUsageLedgerEventInTransaction,
  type LedgerDatabasePort,
  type LedgerRuntimePorts,
  type LedgerTransactionPort,
} from '../ledger/store.js';

const OpaqueIdentifier = Type.String({ minLength: 1, maxLength: 256, pattern: '^[A-Za-z0-9][A-Za-z0-9._:/-]*$' });
const IdentityReferenceSchema = Type.Union([
  Type.Object({ status: Type.Literal('known'), id: OpaqueIdentifier }, { additionalProperties: false }),
  Type.Object({ status: Type.Literal('unknown') }, { additionalProperties: false }),
]);
const LocalVersion = Type.Literal('1.0.0');
const UtcTimestamp = Type.String({ format: 'date-time' });

export const UsageObservationSchema = Type.Object({
  schemaVersion: LocalVersion,
  requestId: Type.String({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._:/-]*$' }),
  idempotencyKey: Type.String({ minLength: 1, maxLength: 200, pattern: '^[A-Za-z0-9][A-Za-z0-9._:/-]*$' }),
  scope: TrustedScopeSchema,
  usageEvent: Type.Unknown(),
  evidenceMode: Type.Union([Type.Literal('mocked'), Type.Literal('sandbox'), Type.Literal('live')]),
  verificationStatus: Type.Union([Type.Literal('verified'), Type.Literal('unverified'), Type.Literal('unknown')]),
  evidenceProvenanceRef: Type.String({ minLength: 1, maxLength: 240 }),
}, { additionalProperties: false });
export type UsageObservation = Omit<Static<typeof UsageObservationSchema>, 'usageEvent'> & { readonly usageEvent: SharedUsageEvent };

export const IngestionReceiptSchema = Type.Object({
  schemaVersion: LocalVersion,
  requestId: Type.String({ minLength: 1, maxLength: 128 }),
  asOf: UtcTimestamp,
  status: Type.Union([Type.Literal('accepted'), Type.Literal('duplicate'), Type.Literal('quarantined'), Type.Literal('conflict')]),
  eventId: IdentityReferenceSchema,
  sourceObservationId: IdentityReferenceSchema,
  logicalOperationId: IdentityReferenceSchema,
  providerAttemptId: IdentityReferenceSchema,
  billableAttemptId: IdentityReferenceSchema,
  transportAttemptId: IdentityReferenceSchema,
  existingEventId: Type.Optional(IdentityReferenceSchema),
  existingAttemptId: Type.Optional(IdentityReferenceSchema),
  outboxStatus: Type.Union([
    Type.Literal('awaiting_evidence'), Type.Literal('pending'), Type.Literal('retry'), Type.Literal('posted'),
    Type.Literal('duplicate'), Type.Literal('suppressed'), Type.Literal('dead_letter'),
  ]),
  completeness: Type.Union([Type.Literal('unknown'), Type.Literal('incomplete'), Type.Literal('complete')]),
  valuation: Type.Union([Type.Literal('unknown'), Type.Literal('estimated'), Type.Literal('provider_confirmed')]),
  durableCommit: Type.Boolean(),
  quarantineCode: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
}, { additionalProperties: false });
export type IngestionReceipt = Static<typeof IngestionReceiptSchema>;

export const UsageOutboxReplayRequestSchema = Type.Object({
  schemaVersion: LocalVersion,
  requestId: Type.String({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._:/-]*$' }),
  scope: TrustedScopeSchema,
  limit: Type.Integer({ minimum: 1, maximum: 100 }),
}, { additionalProperties: false });
export const UsageOutboxReplayReceiptSchema = Type.Object({
  schemaVersion: LocalVersion,
  requestId: Type.String({ minLength: 1, maxLength: 128 }),
  asOf: UtcTimestamp,
  scanned: Type.Integer({ minimum: 0, maximum: 100 }),
  posted: Type.Integer({ minimum: 0, maximum: 100 }),
  retried: Type.Integer({ minimum: 0, maximum: 100 }),
  deadLettered: Type.Integer({ minimum: 0, maximum: 100 }),
  durableCommit: Type.Boolean(),
}, { additionalProperties: false });
export type UsageOutboxReplayRequest = Static<typeof UsageOutboxReplayRequestSchema>;
export type UsageOutboxReplayReceipt = Static<typeof UsageOutboxReplayReceiptSchema>;

/** Existing host compositions remain type-compatible; intake fails closed without its database adapter. */
export type UsageIntakeRuntimePorts = Omit<RuntimePorts, 'storage'> & { readonly database?: LedgerDatabasePort };
type ConnectedUsageIntakeRuntimePorts = Omit<UsageIntakeRuntimePorts, 'database'> & { readonly database: LedgerDatabasePort };

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_PENDING_OUTBOX = 1_000;
const MAX_RETRIES = 5;
const SAFE_UNITS = new Set([
  'token', 'tokens', 'input', 'output', 'reasoning', 'input_tokens', 'output_tokens', 'cached_tokens',
  'uncached_tokens', 'reasoning_tokens', 'cache_read_tokens', 'cache_write_tokens', 'request', 'requests',
  'call', 'calls', 'job', 'jobs', 'task', 'tasks', 'invocation', 'invocations', 'image', 'images', 'byte',
  'bytes', 'kilobytes', 'megabytes', 'gigabytes', 'millisecond', 'milliseconds', 'second', 'seconds',
  'minute', 'minutes', 'hour', 'hours', 'day', 'days', 'count', 'item', 'items', 'unit', 'units', 'page',
  'pages', 'row', 'rows', 'record', 'records', 'character', 'characters', 'credit', 'credits',
]);
const SAFE_MISSING = new Set([...SAFE_UNITS, 'amount', 'currency', 'source_reference', 'provider_reference',
  'pricing_reference', 'all', 'usage', 'providerAttemptId', 'billableAttemptId', 'image_count', 'request_count', 'duration']);
const SENSITIVE_TEXT = /(?:https?:\/\/|\b[a-z][a-z0-9+.-]*:\/\/|[\u0000-\u001f]|(?:^|[^a-z0-9])(?:prompt|password|passwd|secret|authorization|bearer|private|address|email|token)(?:$|[^a-z0-9])|(?:^|[^a-z0-9])(?:\d{1,3}\.){3}\d{1,3}(?:$|[^a-z0-9])|[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/i;
const SAFE_OPAQUE = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const SAFE_LABEL = /^[A-Za-z0-9][A-Za-z0-9 .:_/-]{0,127}$/;

type IntakeRow = Record<string, unknown>;
type PreparedObservation = {
  readonly request: UsageObservation;
  readonly event: SharedUsageEvent;
  readonly payloadHash: string;
  readonly provenanceHash: string;
  readonly facts: Record<string, unknown>;
};
type IdentityReference = Static<typeof IdentityReferenceSchema>;
type AllowedUsageAuthorization = Extract<FinanceAuthorizationDecision, { readonly status: 'allowed' }>;
type WorkResult = 'posted' | 'retried' | 'deadLettered';

function asString(row: IntakeRow, key: string): string | null {
  const value = row[key];
  return value === null || value === undefined ? null : String(value);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (typeof value === 'object' && value !== null) {
    const object = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(object).sort().map(key => [key, stableValue(object[key])]));
  }
  return value;
}

function stableJson(value: unknown): string {
  const encoded = JSON.stringify(stableValue(value));
  if (encoded === undefined) throw new Error('Request cannot be serialized.');
  return encoded;
}

async function sha256(value: unknown): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(stableJson(value)));
  return `sha256:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

function typedIdentity(id: string | null | undefined): IdentityReference {
  return id ? { status: 'known', id } : { status: 'unknown' };
}

function normalizeFacts(event: SharedUsageEvent, provenanceHash: string, evidenceMode: UsageObservation['evidenceMode'], verificationStatus: UsageObservation['verificationStatus']): Record<string, unknown> {
  return {
    contract: event.contract,
    schema_version: event.schema_version,
    policy_version: event.policy_version,
    event_id: event.event_id,
    tenant_id: event.tenant_id,
    project_id: event.project_id,
    workflow_id: event.workflow_id ?? null,
    run_id: event.run_id ?? null,
    job_id: event.job_id ?? null,
    artifact_id: event.artifact_id ?? null,
    design_id: event.design_id ?? null,
    design_version_id: event.design_version_id ?? null,
    order_id: event.order_id ?? null,
    trace_id: event.trace_id ?? null,
    correlation_id: event.correlation_id,
    evidence_id: event.evidence_id ?? null,
    usage_event_id: event.usage_event_id,
    logical_operation_id: event.logical_operation_id,
    provider_attempt_id: event.provider_attempt_id,
    billable_attempt_id: event.billable_attempt_id,
    transport_attempt_id: event.transport_attempt_id,
    provider_request_id: event.provider_request_id,
    producer: event.producer,
    occurred_at: event.occurred_at,
    observed_at: event.observed_at,
    ingested_at: event.ingested_at,
    environment: event.environment,
    billing_mode: event.billing_mode,
    source_refs: event.source_refs,
    source_observation_id: event.source_observation_id,
    provider: event.provider,
    model: event.model,
    source: event.source,
    completeness: event.completeness,
    usage_units: event.usage_units,
    missing_fields: event.missing_fields,
    valuation: event.valuation,
    outcome: event.outcome,
    retry_mapping_ref: event.retry_mapping_ref,
    supersedes_observation_id: event.supersedes_observation_id,
    reconciliation_ref: event.reconciliation_ref,
    evidence_mode: evidenceMode,
    verification_status: verificationStatus,
    provenance_sha256: provenanceHash,
  };
}

function isSafeOpaque(value: string): boolean {
  return value.length <= 256 && SAFE_OPAQUE.test(value) && !/[?#@]/.test(value) && !SENSITIVE_TEXT.test(value);
}

function usageMetadataIsSafe(event: SharedUsageEvent, request: UsageObservation): boolean {
  const ids = [request.requestId, request.idempotencyKey, request.scope.tenantId, request.scope.projectId,
    request.scope.actorId, event.event_id, event.correlation_id, event.usage_event_id, event.logical_operation_id,
    event.provider_attempt_id, event.billable_attempt_id, event.transport_attempt_id,
    ...(event.provider_request_id ? [event.provider_request_id] : []), event.source_observation_id,
    event.producer.module, event.producer.source_revision, event.producer.build_revision,
    ...(event.workflow_id ? [event.workflow_id] : []), ...(event.run_id ? [event.run_id] : []),
    ...(event.job_id ? [event.job_id] : []), ...(event.artifact_id ? [event.artifact_id] : []),
    ...(event.design_id ? [event.design_id] : []), ...(event.design_version_id ? [event.design_version_id] : []),
    ...(event.order_id ? [event.order_id] : []), ...(event.trace_id ? [event.trace_id] : []),
    ...(event.evidence_id ? [event.evidence_id] : []), event.retry_mapping_ref.id,
    ...(event.supersedes_observation_id ? [event.supersedes_observation_id] : []),
    ...event.source_refs.map(ref => ref.id),
    ...(event.reconciliation_ref ? [event.reconciliation_ref.id] : []),
    ...(event.valuation.basis === 'unknown' ? (event.valuation.rate_card_ref ? [event.valuation.rate_card_ref.id] : []) : [event.valuation.rate_card_ref.id])];
  if (!ids.every(isSafeOpaque)) return false;
  if (!/^[a-f0-9]{40}$/.test(event.producer.source_revision)) return false;
  if (!SAFE_LABEL.test(event.provider) || !SAFE_LABEL.test(event.model)
      || SENSITIVE_TEXT.test(event.provider) || SENSITIVE_TEXT.test(event.model)
      || SENSITIVE_TEXT.test(event.producer.build_revision)) return false;
  if (event.usage_units?.some(unit => !SAFE_UNITS.has(unit.name)
      || (unit.included_in !== undefined && !SAFE_UNITS.has(unit.included_in)))) return false;
  if (event.missing_fields.some(field => !SAFE_MISSING.has(field))) return false;
  if (event.source_refs.some(ref => ref.content_hash !== undefined && !/^sha256:[a-f0-9]{64}$/.test(ref.content_hash))) return false;
  const references = [event.retry_mapping_ref, ...(event.reconciliation_ref ? [event.reconciliation_ref] : []),
    ...(event.valuation.rate_card_ref ? [event.valuation.rate_card_ref] : [])];
  return references.every(ref => SAFE_OPAQUE.test(ref.contract) && !SENSITIVE_TEXT.test(ref.contract)
    && /^sha256:[a-f0-9]{64}$/.test(ref.content_hash));
}

function requestSize(value: unknown): number | null {
  try { return new TextEncoder().encode(JSON.stringify(value)).byteLength; } catch { return null; }
}

function receiptFor(
  requestId: string,
  asOf: string,
  status: IngestionReceipt['status'],
  prepared: PreparedObservation | null,
  outboxStatus: IngestionReceipt['outboxStatus'],
  durableCommit: boolean,
  extra: Partial<Pick<IngestionReceipt, 'existingEventId' | 'existingAttemptId' | 'quarantineCode'>> = {},
): IngestionReceipt {
  const event = prepared?.event;
  return {
    schemaVersion: '1.0.0', requestId, asOf, status,
    eventId: typedIdentity(event?.event_id),
    sourceObservationId: typedIdentity(event?.source_observation_id),
    logicalOperationId: typedIdentity(event?.logical_operation_id),
    providerAttemptId: typedIdentity(event?.provider_attempt_id),
    billableAttemptId: typedIdentity(event?.billable_attempt_id),
    transportAttemptId: typedIdentity(event?.transport_attempt_id),
    outboxStatus, completeness: event?.completeness ?? 'unknown',
    valuation: event?.valuation.basis ?? 'unknown', durableCommit, ...extra,
  } as IngestionReceipt;
}

function getClockNow(ports: Pick<RuntimePorts, 'clock'>): Date | null {
  try {
    const now = ports.clock.now();
    return now instanceof Date && Number.isFinite(now.getTime()) ? now : null;
  } catch { return null; }
}

async function bindIntakeTransaction(client: LedgerTransactionPort, scope: UsageObservation['scope']): Promise<void> {
  await bindFinancialDatabaseScope(client, scope);
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    `ci02-ledger:${scope.tenantId}:${scope.projectId}:${scope.environment}:${scope.billingMode}`,
  ]);
}

async function privacyScopeAvailable(client: LedgerTransactionPort, scope: UsageObservation['scope']): Promise<boolean> {
  const rows = await client.query(
    `SELECT 1 FROM cost_intelligence.financial_privacy_quarantine
     WHERE tenant_id = $1 AND project_id = $2 AND environment = $3 AND billing_mode = $4 LIMIT 1`,
    [scope.tenantId, scope.projectId, scope.environment, scope.billingMode],
  );
  return rows.rows.length === 0;
}

function ledgerPorts(ports: ConnectedUsageIntakeRuntimePorts): LedgerRuntimePorts {
  const result: LedgerRuntimePorts = { database: ports.database, trustedContext: ports.trustedContext, clock: ports.clock };
  if (ports.financeAuthority !== undefined) return { ...result, financeAuthority: ports.financeAuthority };
  return result;
}

async function quarantineInvalidCanonical(
  request: UsageObservation,
  ports: ConnectedUsageIntakeRuntimePorts,
  asOf: string,
  reasonCode: 'unsupported_version' | 'invalid_usage_event' | 'unsafe_metadata',
): Promise<ApiResult<IngestionReceipt>> {
  const payloadHash = await sha256(request.usageEvent).catch(() => null);
  if (payloadHash === null) return failure(errorEnvelope('metering', 'ingestUsage', 'VALIDATION_ERROR', request.requestId, 'The source record cannot be safely fingerprinted.'));
  let client: LedgerTransactionPort | undefined;
  try {
    client = await ports.database.connect();
    await client.query('BEGIN');
    await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
    await bindIntakeTransaction(client, request.scope);
    if (!await privacyScopeAvailable(client, request.scope)) {
      await client.query('ROLLBACK');
      return failure(errorEnvelope('metering', 'ingestUsage', 'SOURCE_UNAVAILABLE', request.requestId, 'Usage history in this scope is restricted pending financial review.'));
    }
    const ref = `ci04aq:${(await sha256({ scope: request.scope, reasonCode, payloadHash })).slice('sha256:'.length)}`;
    await client.query(
      `INSERT INTO cost_intelligence.usage_intake_quarantine
         (diagnostic_ref, tenant_id, project_id, environment, billing_mode, reason_code, payload_sha256)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (tenant_id, project_id, environment, billing_mode, reason_code, payload_sha256) DO NOTHING`,
      [ref, request.scope.tenantId, request.scope.projectId, request.scope.environment, request.scope.billingMode, reasonCode, payloadHash],
    );
    await client.query('COMMIT');
    const receipt = receiptFor(request.requestId, asOf, 'quarantined', null, 'dead_letter', true, { quarantineCode: reasonCode });
    return { ok: true, value: receipt };
  } catch {
    await client?.query('ROLLBACK').catch(() => undefined);
    return failure(errorEnvelope('metering', 'ingestUsage', 'SOURCE_UNAVAILABLE', request.requestId, 'Usage quarantine persistence is temporarily unavailable.', true));
  } finally {
    client?.release();
  }
}

function toEvidenceRef(reference: { contract: string; schema_version: string; id: string; revision: number; content_hash: string }) {
  return { contract: reference.contract, schema_version: reference.schema_version, id: reference.id,
    revision: reference.revision, content_hash: reference.content_hash };
}

async function makeLedgerRequest(
  prepared: PreparedObservation,
  request: UsageObservation,
  sourceRevisionSequence: number,
  previous: IntakeRow | null,
  previousEvent: IntakeRow | null,
): Promise<Record<string, unknown> | null> {
  const { event } = prepared;
  const knownValuation = event.valuation.basis !== 'unknown';
  if (!knownValuation && previousEvent === null) return null;
  const priorCurrency = previousEvent ? asString(previousEvent, 'currency')?.trim() : null;
  const priorScale = previousEvent ? Number(previousEvent.amount_scale) : null;
  if (!knownValuation && (!priorCurrency || priorScale === null || !Number.isFinite(priorScale))) return null;
  const amount = knownValuation ? event.valuation.money.amount : null;
  const currency = knownValuation ? event.valuation.money.currency : priorCurrency;
  const scale = knownValuation ? event.valuation.money.scale : priorScale;
  if (currency === null || currency === undefined || scale === null || scale === undefined) return null;
  const currentLedgerEventId = previous ? asString(previous, 'current_ledger_event_id') : null;
  const refs = event.source_refs.flatMap(ref => ref.content_hash ? [toEvidenceRef({
    contract: ref.kind, schema_version: '1.0.0', id: ref.id, revision: 0, content_hash: ref.content_hash,
  })] : []);
  if (event.reconciliation_ref) refs.push(toEvidenceRef(event.reconciliation_ref));
  const valuationRef = knownValuation ? toEvidenceRef(event.valuation.rate_card_ref) : null;
  const revisionHash = await sha256({ billableAttemptId: event.billable_attempt_id }).then(hash => hash.slice('sha256:'.length, 'sha256:'.length + 40));
  const eventId = event.event_id;
  const sourceLineId = event.billable_attempt_id;
  const providerRequestIdentity = event.provider_request_id === null
    ? { status: 'unknown' as const } : { status: 'known' as const, id: event.provider_request_id };
  const units = (event.usage_units ?? []).map(unit => ({ name: unit.name, quantity: unit.quantity, scale: unit.scale,
    relation: unit.relation, ...(unit.included_in !== undefined ? { includedIn: unit.included_in } : {}) }));
  const missingFields = [...event.missing_fields];
  if (event.usage_units === null && !missingFields.includes('usage')) missingFields.push('usage');
  return {
    schemaVersion: '1.0.0', requestId: request.requestId,
    idempotencyKey: `ci04a:${revisionHash}:${sourceRevisionSequence}`,
    scope: request.scope,
    eventId,
    correlationId: event.correlation_id,
    producer: { module: event.producer.module, sourceRevision: event.producer.source_revision, buildRevision: event.producer.build_revision },
    occurredAt: event.occurred_at, observedAt: event.observed_at,
    evidenceMode: request.evidenceMode, verificationStatus: request.verificationStatus,
    eventType: currentLedgerEventId ? 'correction' : 'charge', classification: 'supplier_expense',
    valuation: event.valuation.basis, settlementStatus: 'unpaid', reconciliationStatus: 'unmatched', reservationLifecycle: null,
    identities: { logicalOperationId: event.logical_operation_id, sourceObservationId: event.source_observation_id, reservationId: null },
    postingMapping: { schemaVersion: '1.0.0', sourceLineId,
      transportAttemptId: { status: 'known', id: event.transport_attempt_id },
      providerAttemptId: { status: 'known', id: event.provider_attempt_id },
      providerRequestId: providerRequestIdentity,
      billableAttemptId: { status: 'known', id: event.billable_attempt_id } },
    sourceIdentity: { source: 'ci04a-usage-intake', sourceEventId: event.event_id, sourceObjectId: sourceLineId,
      revisionSubjectId: sourceLineId, sourceRevision: event.producer.source_revision,
      revisionSequence: sourceRevisionSequence, contentHash: prepared.payloadHash },
    usage: { completeness: event.completeness, missingFields, units },
    money: { amount, currency, scale }, sourceRefs: refs,
    dimensions: { provider: event.provider, model: event.model,
      ...(event.workflow_id ? { workflowId: event.workflow_id } : {}),
      ...(event.job_id ? { jobId: event.job_id } : {}), ...(event.order_id ? { orderId: event.order_id } : {}) },
    pricing: knownValuation ? { policyVersion: event.policy_version, ruleVersion: event.valuation.rate_card_ref.schema_version, rateCardRef: valuationRef } : null,
    fxEvidence: null, financialEffect: true, reservationAuthorizationEventId: null,
    supersedesEventId: currentLedgerEventId, reversesEventId: null,
  };
}

async function markOutboxResult(
  client: LedgerTransactionPort,
  scope: UsageObservation['scope'],
  observationId: string,
  status: 'posted' | 'retry' | 'dead_letter',
  now: Date,
  errorCode: 'source_unavailable' | 'ledger_conflict' | 'outbox_expired' | null,
  eventId: string | null,
): Promise<void> {
  const retryCount = status === 'retry'
    ? `(retry_count + 1)` : 'retry_count';
  const availableAt = status === 'retry'
    ? `now() + make_interval(secs => LEAST(60, power(2, retry_count + 1)::integer))` : 'available_at';
  await client.query(
    `UPDATE cost_intelligence.usage_intake_outbox
     SET status = $6, retry_count = ${retryCount}, available_at = ${availableAt}, last_error_code = $7,
         ledger_event_id = COALESCE($8, ledger_event_id), completed_at = CASE WHEN $6 = 'posted' THEN $9::timestamptz ELSE NULL END
     WHERE tenant_id=$1 AND project_id=$2 AND environment=$3 AND billing_mode=$4 AND source_observation_id=$5`,
    [scope.tenantId, scope.projectId, scope.environment, scope.billingMode, observationId, status, errorCode, eventId, now.toISOString()],
  );
  if (status !== 'posted') {
    await client.query(
      `UPDATE cost_intelligence.usage_intake_attempts
       SET status = $6, updated_at = $7
       WHERE tenant_id=$1 AND project_id=$2 AND environment=$3 AND billing_mode=$4 AND billable_attempt_id =
         (SELECT billable_attempt_id FROM cost_intelligence.usage_intake_outbox
          WHERE tenant_id=$1 AND project_id=$2 AND environment=$3 AND billing_mode=$4 AND source_observation_id=$5)`,
      [scope.tenantId, scope.projectId, scope.environment, scope.billingMode, observationId,
        status === 'retry' ? 'retry' : 'dead_letter', now.toISOString()],
    );
  }
}

async function buildOutboxPayload(
  client: LedgerTransactionPort,
  row: IntakeRow,
  authorization: AllowedUsageAuthorization,
): Promise<Record<string, unknown> | null> {
  const scope = {
    tenantId: asString(row, 'tenant_id')!, projectId: asString(row, 'project_id')!,
    environment: asString(row, 'environment') as UsageObservation['scope']['environment'],
    billingMode: asString(row, 'billing_mode') as UsageObservation['scope']['billingMode'],
    actorId: authorization.scope.actorId,
  };
  const observationId = asString(row, 'source_observation_id')!;
  const factsResult = await client.query(
    `SELECT request_id, payload_sha256, provenance_sha256, event_facts
     FROM cost_intelligence.usage_intake_inbox
     WHERE tenant_id=$1 AND project_id=$2 AND environment=$3 AND billing_mode=$4 AND source_observation_id=$5`,
    [scope.tenantId, scope.projectId, scope.environment, scope.billingMode, observationId],
  );
  const inbox = factsResult.rows[0];
  if (!inbox || typeof inbox.event_facts !== 'object' || inbox.event_facts === null) return null;
  const event = inbox.event_facts as SharedUsageEvent & Record<string, unknown>;
  const attemptResult = await client.query(
    `SELECT * FROM cost_intelligence.usage_intake_attempts
     WHERE tenant_id=$1 AND project_id=$2 AND environment=$3 AND billing_mode=$4 AND billable_attempt_id=$5 FOR UPDATE`,
    [scope.tenantId, scope.projectId, scope.environment, scope.billingMode, asString(row, 'billable_attempt_id')],
  );
  const attempt = attemptResult.rows[0] ?? null;
  if (!attempt) return null;
  const currentLedgerEventId = asString(attempt, 'current_ledger_event_id');
  let previousEvent: IntakeRow | null = null;
  if (currentLedgerEventId) {
    const result = await client.query(
      `SELECT event_id, currency, amount_scale, valuation FROM cost_intelligence.financial_ledger_events
       WHERE tenant_id=$1 AND project_id=$2 AND environment=$3 AND billing_mode=$4 AND event_id=$5`,
      [scope.tenantId, scope.projectId, scope.environment, scope.billingMode, currentLedgerEventId],
    );
    previousEvent = result.rows[0] ?? null;
  }
  const request: UsageObservation = {
    schemaVersion: '1.0.0', requestId: asString(inbox, 'request_id')!, idempotencyKey: `intake:${observationId}`,
    scope, usageEvent: event, evidenceMode: event.evidence_mode as UsageObservation['evidenceMode'],
    verificationStatus: event.verification_status as UsageObservation['verificationStatus'],
    evidenceProvenanceRef: asString(inbox, 'provenance_sha256')!,
  };
  const prepared: PreparedObservation = {
    request, event, payloadHash: asString(inbox, 'payload_sha256')!,
    provenanceHash: asString(inbox, 'provenance_sha256')!, facts: inbox.event_facts as Record<string, unknown>,
  };
  const sequence = currentLedgerEventId ? Number(attempt.revision_sequence ?? 0) + 1 : 0;
  const payload = await makeLedgerRequest(prepared, request, sequence, attempt, previousEvent);
  if (payload) {
    await client.query(
      `UPDATE cost_intelligence.usage_intake_outbox SET posting_payload=$6::jsonb
       WHERE tenant_id=$1 AND project_id=$2 AND environment=$3 AND billing_mode=$4 AND source_observation_id=$5
         AND posting_payload IS NULL`,
      [scope.tenantId, scope.projectId, scope.environment, scope.billingMode, observationId, JSON.stringify(payload)],
    );
  }
  return payload;
}

async function processOutboxRow(
  client: LedgerTransactionPort,
  row: IntakeRow,
  ports: ConnectedUsageIntakeRuntimePorts,
  authorization: AllowedUsageAuthorization,
  now: Date,
): Promise<WorkResult> {
  const scope = {
    tenantId: asString(row, 'tenant_id')!, projectId: asString(row, 'project_id')!,
    environment: asString(row, 'environment') as UsageObservation['scope']['environment'],
    billingMode: asString(row, 'billing_mode') as UsageObservation['scope']['billingMode'],
    actorId: authorization.scope.actorId,
  };
  const observationId = asString(row, 'source_observation_id')!;
  const attemptId = asString(row, 'billable_attempt_id')!;
  const count = Number(row.retry_count ?? 0);
  if (count >= MAX_RETRIES) {
    await markOutboxResult(client, scope, observationId, 'dead_letter', now, 'outbox_expired', null);
    return 'deadLettered';
  }
  const payload = row.posting_payload && typeof row.posting_payload === 'object'
    ? row.posting_payload as Record<string, unknown>
    : await buildOutboxPayload(client, row, authorization);
  if (!payload) {
    await markOutboxResult(client, scope, observationId, 'dead_letter', now, 'ledger_conflict', null);
    return 'deadLettered';
  }
  const appended = await appendUsageLedgerEventInTransaction(payload, client, ledgerPorts(ports), authorization);
  if (appended.ok && (appended.value.status === 'accepted' || appended.value.status === 'duplicate')) {
    const eventId = appended.value.existingEventId ?? appended.value.eventId;
    await markOutboxResult(client, scope, observationId, 'posted', now, null, eventId);
    const sequence = Number((payload.sourceIdentity as Record<string, unknown>).revisionSequence ?? 0);
    const remaining = await client.query(
      `SELECT 1 FROM cost_intelligence.usage_intake_outbox
       WHERE tenant_id=$1 AND project_id=$2 AND environment=$3 AND billing_mode=$4
         AND billable_attempt_id=$5 AND source_observation_id<>$6 AND status IN ('pending','retry') LIMIT 1`,
      [scope.tenantId, scope.projectId, scope.environment, scope.billingMode, attemptId, observationId],
    );
    await client.query(
      `UPDATE cost_intelligence.usage_intake_attempts
       SET current_ledger_event_id=$6, revision_sequence=GREATEST(revision_sequence, $7), status=$8, updated_at=$9
       WHERE tenant_id=$1 AND project_id=$2 AND environment=$3 AND billing_mode=$4 AND billable_attempt_id=$5`,
      [scope.tenantId, scope.projectId, scope.environment, scope.billingMode, attemptId, eventId,
        sequence, remaining.rows.length ? 'pending' : 'posted', now.toISOString()],
    );
    return 'posted';
  }
  const code = appended.ok ? 'conflict' : appended.error.code;
  if (code === 'SOURCE_UNAVAILABLE') {
    await markOutboxResult(client, scope, observationId, count + 1 >= MAX_RETRIES ? 'dead_letter' : 'retry', now,
      count + 1 >= MAX_RETRIES ? 'outbox_expired' : 'source_unavailable', null);
    return count + 1 >= MAX_RETRIES ? 'deadLettered' : 'retried';
  }
  await markOutboxResult(client, scope, observationId, 'dead_letter', now, 'ledger_conflict', null);
  return 'deadLettered';
}

async function quarantineInTransaction(
  client: LedgerTransactionPort,
  scope: UsageObservation['scope'],
  payloadHash: string,
  reasonCode: 'unsupported_version' | 'invalid_usage_event' | 'unsafe_metadata',
): Promise<void> {
  const ref = `ci04aq:${(await sha256({ scope, reasonCode, payloadHash })).slice('sha256:'.length)}`;
  await client.query(
    `INSERT INTO cost_intelligence.usage_intake_quarantine
       (diagnostic_ref, tenant_id, project_id, environment, billing_mode, reason_code, payload_sha256)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (tenant_id, project_id, environment, billing_mode, reason_code, payload_sha256) DO NOTHING`,
    [ref, scope.tenantId, scope.projectId, scope.environment, scope.billingMode, reasonCode, payloadHash],
  );
}

function validCurrentUsageAuthorization(value: FinanceAuthorizationDecision | PricingAuthorizationCompatibilityDecision): value is AllowedUsageAuthorization {
  return 'principal' in value && value.status === 'allowed' && value.operation === 'metering.ingestUsage' && value.permission === 'usage.ingest'
    && value.principal.kind === 'service';
}

/** Validate, retain, correlate and post usage evidence within one PostgreSQL transaction. */
export function ingestUsage(value: unknown, ports: RuntimePorts): Promise<ApiResult<IngestionReceipt>>;
export function ingestUsage(value: unknown, ports: UsageIntakeRuntimePorts): Promise<ApiResult<IngestionReceipt>>;
export async function ingestUsage(
  value: unknown,
  ports: RuntimePorts | UsageIntakeRuntimePorts,
): Promise<ApiResult<IngestionReceipt>> {
  const bytes = requestSize(value);
  if (bytes === null || bytes > MAX_REQUEST_BYTES) {
    return failure(errorEnvelope('metering', 'ingestUsage', 'VALIDATION_ERROR', 'unavailable', 'The usage observation exceeds the 64 KiB intake limit.'));
  }
  const outer = validateRequest(UsageObservationSchema, value, 'metering', 'ingestUsage');
  if (!outer.ok) return failure(outer.error);
  const outerRequest = outer.value as Omit<UsageObservation, 'usageEvent'> & { usageEvent: unknown };
  const outerRequestId = outerRequest.requestId;
  const canonical = validateCanonical({ contract: 'UsageEvent', value: outerRequest.usageEvent,
    module: 'metering', operation: 'ingestUsage', requestId: outerRequestId });
  const authorization = await authorizeFinanceOperation({
    module: 'metering', requestOperation: 'ingestUsage', operation: 'metering.ingestUsage',
    scope: outerRequest.scope, requestId: outerRequestId, clock: ports.clock, financeAuthority: ports.financeAuthority,
  });
  if (!authorization.ok) return failure(authorization.error);
  if (!validCurrentUsageAuthorization(authorization.decision)) {
    return failure(errorEnvelope('metering', 'ingestUsage', 'FORBIDDEN_SCOPE', outerRequestId, 'A current service authorization is required for usage ingestion.'));
  }
  const database = 'database' in ports ? ports.database : undefined;
  const intakePorts = database && typeof database.connect === 'function'
    ? { ...ports, database } as ConnectedUsageIntakeRuntimePorts : undefined;
  const asOfDate = getClockNow(ports);
  if (!asOfDate) return failure(errorEnvelope('metering', 'ingestUsage', 'SOURCE_UNAVAILABLE', outerRequestId, 'The trusted finance clock is unavailable.', true));
  const asOf = asOfDate.toISOString();
  if (!canonical.ok) {
    const candidate = outerRequest.usageEvent as Record<string, unknown> | null;
    if (candidate && typeof candidate === 'object'
        && (['tenant_id', 'project_id', 'environment', 'billing_mode'] as const).some(key =>
          candidate[key] !== undefined && candidate[key] !== outerRequest.scope[
            key === 'tenant_id' ? 'tenantId' : key === 'project_id' ? 'projectId' : key === 'environment' ? 'environment' : 'billingMode'
          ])) {
      return failure(errorEnvelope('metering', 'ingestUsage', 'FORBIDDEN_SCOPE', outerRequestId, 'The usage event does not match the authenticated financial scope.'));
    }
    const version = candidate && typeof candidate === 'object' ? candidate.schema_version : undefined;
    const reasonCode = typeof version === 'string' && version !== '1.0.0' ? 'unsupported_version' : 'invalid_usage_event';
    if (!intakePorts) {
      return failure(errorEnvelope('metering', 'ingestUsage', 'SOURCE_UNAVAILABLE', outerRequestId, 'Usage intake persistence is not configured.', true));
    }
    return quarantineInvalidCanonical(outerRequest as UsageObservation, intakePorts, asOf, reasonCode);
  }
  const event = canonical.value as SharedUsageEvent;
  const request = { ...outerRequest, usageEvent: event } as UsageObservation;
  if (event.tenant_id !== request.scope.tenantId || event.project_id !== request.scope.projectId
      || event.environment !== request.scope.environment || event.billing_mode !== request.scope.billingMode) {
    return failure(errorEnvelope('metering', 'ingestUsage', 'FORBIDDEN_SCOPE', request.requestId, 'The usage event does not match the authenticated financial scope.'));
  }
  if (!intakePorts) {
    return failure(errorEnvelope('metering', 'ingestUsage', 'SOURCE_UNAVAILABLE', request.requestId, 'Usage intake persistence is not configured.', true));
  }
  if (!usageMetadataIsSafe(event, request)) {
    const payloadHash = await sha256(event).catch(() => null);
    if (!payloadHash) return failure(errorEnvelope('metering', 'ingestUsage', 'VALIDATION_ERROR', request.requestId, 'The source record cannot be safely fingerprinted.'));
    try {
      const client = await intakePorts.database.connect();
      try {
        await client.query('BEGIN');
        await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
        await bindIntakeTransaction(client, request.scope);
        if (!await privacyScopeAvailable(client, request.scope)) {
          await client.query('ROLLBACK');
          return failure(errorEnvelope('metering', 'ingestUsage', 'SOURCE_UNAVAILABLE', request.requestId, 'Usage history in this scope is restricted pending financial review.'));
        }
        await quarantineInTransaction(client, request.scope, payloadHash, 'unsafe_metadata');
        await client.query('COMMIT');
        return { ok: true, value: receiptFor(request.requestId, asOf, 'quarantined', null, 'dead_letter', true, { quarantineCode: 'unsafe_metadata' }) };
      } catch {
        await client.query('ROLLBACK').catch(() => undefined);
        return failure(errorEnvelope('metering', 'ingestUsage', 'SOURCE_UNAVAILABLE', request.requestId, 'Usage quarantine persistence is temporarily unavailable.', true));
      } finally { client.release(); }
    } catch {
      return failure(errorEnvelope('metering', 'ingestUsage', 'SOURCE_UNAVAILABLE', request.requestId, 'Usage quarantine persistence is temporarily unavailable.', true));
    }
  }

  const provenanceHash = await sha256(request.evidenceProvenanceRef);
  const facts = normalizeFacts(event, provenanceHash, request.evidenceMode, request.verificationStatus);
  const payloadHash = await sha256({ scope: request.scope, facts });
  const prepared: PreparedObservation = { request, event, payloadHash, provenanceHash, facts };
  const idempotencyHash = await sha256({ scope: request.scope, facts, evidenceMode: request.evidenceMode,
    verificationStatus: request.verificationStatus, provenanceHash });
  let client: LedgerTransactionPort | undefined;
  let inTransaction = false;
  try {
    client = await intakePorts.database.connect();
    await client.query('BEGIN'); inTransaction = true;
    await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
    await bindIntakeTransaction(client, request.scope);
    if (!await privacyScopeAvailable(client, request.scope)) {
      await client.query('ROLLBACK'); inTransaction = false;
      return failure(errorEnvelope('metering', 'ingestUsage', 'SOURCE_UNAVAILABLE', request.requestId, 'Usage history in this scope is restricted pending financial review.'));
    }
    const existingKey = await client.query(
    `SELECT source_observation_id, billable_attempt_id, idempotency_sha256,
              COALESCE((SELECT status FROM cost_intelligence.usage_intake_outbox outbox
               WHERE outbox.tenant_id=usage_intake_inbox.tenant_id AND outbox.project_id=usage_intake_inbox.project_id
                 AND outbox.environment=usage_intake_inbox.environment AND outbox.billing_mode=usage_intake_inbox.billing_mode
                 AND outbox.source_observation_id=usage_intake_inbox.source_observation_id), 'awaiting_evidence') AS outbox_status,
              (SELECT current_ledger_event_id FROM cost_intelligence.usage_intake_attempts attempt
               WHERE attempt.tenant_id=usage_intake_inbox.tenant_id AND attempt.project_id=usage_intake_inbox.project_id
                 AND attempt.environment=usage_intake_inbox.environment AND attempt.billing_mode=usage_intake_inbox.billing_mode
                 AND attempt.billable_attempt_id=usage_intake_inbox.billable_attempt_id) AS existing_event_id
       FROM cost_intelligence.usage_intake_inbox
       WHERE tenant_id=$1 AND project_id=$2 AND environment=$3 AND billing_mode=$4 AND idempotency_key=$5`,
      [request.scope.tenantId, request.scope.projectId, request.scope.environment, request.scope.billingMode, request.idempotencyKey],
    );
    if (existingKey.rows.length) {
      const row = existingKey.rows[0] ?? {};
      const samePayload = asString(row, 'idempotency_sha256') === idempotencyHash;
      const status = samePayload ? 'duplicate' : 'conflict';
      await client.query('COMMIT'); inTransaction = false;
      return { ok: true, value: receiptFor(request.requestId, asOf, status, prepared,
        samePayload ? (asString(row, 'outbox_status') as IngestionReceipt['outboxStatus']) : 'dead_letter', true, {
          existingAttemptId: typedIdentity(asString(row, 'billable_attempt_id')),
          ...(!asString(row, 'existing_event_id') ? {} : { existingEventId: typedIdentity(asString(row, 'existing_event_id')) }),
        }) };
    }
    const existingObservation = await client.query(
      `SELECT billable_attempt_id, payload_sha256,
              COALESCE((SELECT status FROM cost_intelligence.usage_intake_outbox outbox
               WHERE outbox.tenant_id=usage_intake_inbox.tenant_id AND outbox.project_id=usage_intake_inbox.project_id
                 AND outbox.environment=usage_intake_inbox.environment AND outbox.billing_mode=usage_intake_inbox.billing_mode
                 AND outbox.source_observation_id=usage_intake_inbox.source_observation_id), 'awaiting_evidence') AS outbox_status
       FROM cost_intelligence.usage_intake_inbox
       WHERE tenant_id=$1 AND project_id=$2 AND environment=$3 AND billing_mode=$4 AND source_observation_id=$5`,
      [request.scope.tenantId, request.scope.projectId, request.scope.environment, request.scope.billingMode, event.source_observation_id],
    );
    if (existingObservation.rows.length) {
      const row = existingObservation.rows[0] ?? {};
      const samePayload = asString(row, 'payload_sha256') === payloadHash;
      await client.query('COMMIT'); inTransaction = false;
      return { ok: true, value: receiptFor(request.requestId, asOf, samePayload ? 'duplicate' : 'conflict', prepared,
        samePayload ? (asString(row, 'outbox_status') as IngestionReceipt['outboxStatus']) : 'dead_letter', true,
        { existingAttemptId: typedIdentity(asString(row, 'billable_attempt_id')) }) };
    }
    const pending = await client.query(
      `SELECT count(*)::integer AS pending_count FROM cost_intelligence.usage_intake_outbox
       WHERE tenant_id=$1 AND project_id=$2 AND environment=$3 AND billing_mode=$4 AND status IN ('pending','retry')`,
      [request.scope.tenantId, request.scope.projectId, request.scope.environment, request.scope.billingMode],
    );
    if (Number(pending.rows[0]?.pending_count ?? 0) >= MAX_PENDING_OUTBOX) {
      await client.query('ROLLBACK'); inTransaction = false;
      return failure(errorEnvelope('metering', 'ingestUsage', 'SOURCE_UNAVAILABLE', request.requestId, 'The bounded usage posting queue is full; retry after recovery.', true));
    }
    const priorAttempt = await client.query(
      `SELECT * FROM cost_intelligence.usage_intake_attempts
       WHERE tenant_id=$1 AND project_id=$2 AND environment=$3 AND billing_mode=$4 AND billable_attempt_id=$5 FOR UPDATE`,
      [request.scope.tenantId, request.scope.projectId, request.scope.environment, request.scope.billingMode, event.billable_attempt_id],
    );
    const prior = priorAttempt.rows[0] ?? null;
    if (prior && (asString(prior, 'logical_operation_id') !== event.logical_operation_id
        || asString(prior, 'provider_attempt_id') !== event.provider_attempt_id)) {
      await client.query('ROLLBACK'); inTransaction = false;
      return { ok: true, value: receiptFor(request.requestId, asOf, 'conflict', prepared, 'dead_letter', false,
        { existingAttemptId: typedIdentity(event.billable_attempt_id) }) };
    }
    const priorObservationResult = prior ? await client.query(
      `SELECT event_facts FROM cost_intelligence.usage_intake_inbox
       WHERE tenant_id=$1 AND project_id=$2 AND environment=$3 AND billing_mode=$4 AND source_observation_id=$5`,
      [request.scope.tenantId, request.scope.projectId, request.scope.environment, request.scope.billingMode, asString(prior, 'current_observation_id')],
    ) : { rows: [] as Record<string, unknown>[] };
    const priorFacts = (priorObservationResult.rows[0]?.event_facts ?? null) as Record<string, unknown> | null;
    const incomingSupersedesCurrent = prior !== null && event.supersedes_observation_id === asString(prior, 'current_observation_id');
    const currentSupersedesIncoming = priorFacts !== null && priorFacts.supersedes_observation_id === event.source_observation_id;
    const linkedRevision = prior === null || incomingSupersedesCurrent;
    const lateSuperseded = currentSupersedesIncoming;
    const attemptRevisionAccepted = prior === null || (linkedRevision && !lateSuperseded);
    const currentLedgerEventId = prior ? asString(prior, 'current_ledger_event_id') : null;
    let previousLedgerEvent: IntakeRow | null = null;
    if (currentLedgerEventId) {
      const priorEvent = await client.query(
        `SELECT event_id, currency, amount_scale, valuation FROM cost_intelligence.financial_ledger_events
         WHERE tenant_id=$1 AND project_id=$2 AND environment=$3 AND billing_mode=$4 AND event_id=$5`,
        [request.scope.tenantId, request.scope.projectId, request.scope.environment, request.scope.billingMode, currentLedgerEventId],
      );
      previousLedgerEvent = priorEvent.rows[0] ?? null;
    }
    await client.query(
      `INSERT INTO cost_intelligence.usage_intake_inbox (
        tenant_id, project_id, environment, billing_mode, source_observation_id, idempotency_key, request_id,
        event_id, logical_operation_id, provider_attempt_id, billable_attempt_id, transport_attempt_id,
        provider_request_id, source_name, occurred_at, observed_at, completeness, valuation_basis,
        payload_sha256, idempotency_sha256, provenance_sha256, event_facts, attempt_revision_accepted
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22::jsonb,$23)`,
      [request.scope.tenantId, request.scope.projectId, request.scope.environment, request.scope.billingMode,
        event.source_observation_id, request.idempotencyKey, request.requestId, event.event_id,
        event.logical_operation_id, event.provider_attempt_id, event.billable_attempt_id, event.transport_attempt_id,
        event.provider_request_id, event.source, event.occurred_at, event.observed_at, event.completeness,
        event.valuation.basis, payloadHash, idempotencyHash, provenanceHash, JSON.stringify(facts), attemptRevisionAccepted],
    );
    if (!prior) {
      await client.query(
        `INSERT INTO cost_intelligence.usage_intake_attempts (
          tenant_id, project_id, environment, billing_mode, billable_attempt_id, logical_operation_id,
          provider_attempt_id, first_observation_id, current_observation_id, current_ledger_event_id,
          revision_sequence, status, completeness, valuation_basis
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,NULL,0,$9,$10,$11)`,
        [request.scope.tenantId, request.scope.projectId, request.scope.environment, request.scope.billingMode,
          event.billable_attempt_id, event.logical_operation_id, event.provider_attempt_id, event.source_observation_id,
          linkedRevision && !lateSuperseded && event.valuation.basis === 'unknown' ? 'awaiting_evidence' : 'pending',
          event.completeness, event.valuation.basis],
      );
    } else if (linkedRevision && !lateSuperseded) {
      await client.query(
        `UPDATE cost_intelligence.usage_intake_attempts SET current_observation_id=$6,
          status=$7, completeness=$8, valuation_basis=$9, updated_at=$10
         WHERE tenant_id=$1 AND project_id=$2 AND environment=$3 AND billing_mode=$4 AND billable_attempt_id=$5`,
        [request.scope.tenantId, request.scope.projectId, request.scope.environment, request.scope.billingMode,
          event.billable_attempt_id, event.source_observation_id,
          event.valuation.basis === 'unknown' && previousLedgerEvent === null ? 'awaiting_evidence' : 'pending',
          event.completeness, event.valuation.basis, asOfDate.toISOString()],
      );
    }
    const canPost = linkedRevision && !lateSuperseded
      && (event.valuation.basis !== 'unknown' || previousLedgerEvent !== null);
    const outboxStatus = lateSuperseded || (prior !== null && !incomingSupersedesCurrent)
      ? 'suppressed' : canPost ? 'pending' : 'awaiting_evidence';
    await client.query(
      `INSERT INTO cost_intelligence.usage_intake_outbox (
        tenant_id, project_id, environment, billing_mode, source_observation_id, billable_attempt_id,
        posting_payload, status
      ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
      [request.scope.tenantId, request.scope.projectId, request.scope.environment, request.scope.billingMode,
        event.source_observation_id, event.billable_attempt_id, null, outboxStatus],
    );
    let finalStatus: IngestionReceipt['status'] = 'accepted';
    let quarantineCode: string | undefined;
    let resultingOutboxStatus: IngestionReceipt['outboxStatus'] = outboxStatus;
    if (canPost) {
      const blocked = await client.query(
        `SELECT 1 FROM cost_intelligence.usage_intake_outbox
         WHERE tenant_id=$1 AND project_id=$2 AND environment=$3 AND billing_mode=$4
           AND billable_attempt_id=$5 AND source_observation_id<>$6 AND status IN ('pending','retry') LIMIT 1`,
        [request.scope.tenantId, request.scope.projectId, request.scope.environment, request.scope.billingMode,
          event.billable_attempt_id, event.source_observation_id],
      );
      if (blocked.rows.length) resultingOutboxStatus = 'pending';
      else {
        const row = { tenant_id: request.scope.tenantId, project_id: request.scope.projectId,
          environment: request.scope.environment, billing_mode: request.scope.billingMode,
          source_observation_id: event.source_observation_id, billable_attempt_id: event.billable_attempt_id,
          posting_payload: null, status: 'pending', retry_count: 0 };
        const work = await processOutboxRow(client, row, intakePorts, authorization.decision, asOfDate);
        resultingOutboxStatus = work === 'posted' ? 'posted' : work === 'retried' ? 'retry' : 'dead_letter';
        if (work === 'deadLettered') { finalStatus = 'quarantined'; quarantineCode = 'ledger_conflict'; }
      }
    }
    await client.query('COMMIT'); inTransaction = false;
    const response = receiptFor(request.requestId, asOf, finalStatus, prepared, resultingOutboxStatus, true,
      { existingAttemptId: typedIdentity(event.billable_attempt_id), ...(quarantineCode ? { quarantineCode } : {}) });
    return { ok: true, value: response };
  } catch (error) {
    if (client && inTransaction) await client.query('ROLLBACK').catch(() => undefined);
    const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
    if (code === '23505') {
      return { ok: true, value: receiptFor(request.requestId, asOf, 'conflict', prepared, 'dead_letter', false,
        { existingAttemptId: typedIdentity(event.billable_attempt_id) }) };
    }
    return failure(errorEnvelope('metering', 'ingestUsage', 'SOURCE_UNAVAILABLE', request.requestId, 'Usage intake persistence is temporarily unavailable.', true));
  } finally {
    client?.release();
  }
}

/** Resume bounded pending/retry outbox work. The normal ingest permission is required for every drain. */
export async function replayUsageOutbox(value: unknown, ports: UsageIntakeRuntimePorts): Promise<ApiResult<UsageOutboxReplayReceipt>> {
  const validated = validateRequest(UsageOutboxReplayRequestSchema, value, 'metering', 'replayUsageOutbox');
  if (!validated.ok) return failure(validated.error);
  const request = validated.value;
  const authorization = await authorizeFinanceOperation({
    module: 'metering', requestOperation: 'ingestUsage', operation: 'metering.ingestUsage',
    scope: request.scope, requestId: request.requestId, clock: ports.clock, financeAuthority: ports.financeAuthority,
  });
  if (!authorization.ok) return failure(authorization.error);
  if (!validCurrentUsageAuthorization(authorization.decision)) {
    return failure(errorEnvelope('metering', 'replayUsageOutbox', 'FORBIDDEN_SCOPE', request.requestId, 'A current service authorization is required for usage retries.'));
  }
  const now = getClockNow(ports);
  if (!now) return failure(errorEnvelope('metering', 'replayUsageOutbox', 'SOURCE_UNAVAILABLE', request.requestId, 'The trusted finance clock is unavailable.', true));
  const database = ports.database;
  if (!database || typeof database.connect !== 'function') {
    return failure(errorEnvelope('metering', 'replayUsageOutbox', 'SOURCE_UNAVAILABLE', request.requestId, 'Usage intake persistence is not configured.', true));
  }
  const intakePorts: ConnectedUsageIntakeRuntimePorts = { ...ports, database };
  let client: LedgerTransactionPort | undefined;
  let inTransaction = false;
  try {
    client = await intakePorts.database.connect();
    await client.query('BEGIN'); inTransaction = true;
    await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
    await bindIntakeTransaction(client, request.scope);
    if (!await privacyScopeAvailable(client, request.scope)) {
      await client.query('ROLLBACK'); inTransaction = false;
      return failure(errorEnvelope('metering', 'replayUsageOutbox', 'SOURCE_UNAVAILABLE', request.requestId, 'Usage history in this scope is restricted pending financial review.'));
    }
    const pending = await client.query(
      `SELECT tenant_id, project_id, environment, billing_mode, source_observation_id, billable_attempt_id,
              posting_payload, status, retry_count
       FROM cost_intelligence.usage_intake_outbox
       WHERE tenant_id=$1 AND project_id=$2 AND environment=$3 AND billing_mode=$4
         AND status IN ('pending','retry') AND available_at <= $5
         AND NOT EXISTS (
           SELECT 1 FROM cost_intelligence.usage_intake_outbox earlier
           WHERE earlier.tenant_id=usage_intake_outbox.tenant_id AND earlier.project_id=usage_intake_outbox.project_id
             AND earlier.environment=usage_intake_outbox.environment AND earlier.billing_mode=usage_intake_outbox.billing_mode
             AND earlier.billable_attempt_id=usage_intake_outbox.billable_attempt_id
             AND earlier.status IN ('pending','retry')
             AND (earlier.created_at < usage_intake_outbox.created_at
               OR (earlier.created_at = usage_intake_outbox.created_at AND earlier.source_observation_id < usage_intake_outbox.source_observation_id))
         )
       ORDER BY available_at, created_at, source_observation_id LIMIT $6 FOR UPDATE SKIP LOCKED`,
      [request.scope.tenantId, request.scope.projectId, request.scope.environment, request.scope.billingMode, now.toISOString(), request.limit],
    );
    let posted = 0; let retried = 0; let deadLettered = 0;
    for (const row of pending.rows) {
      const work = await processOutboxRow(client, row, intakePorts, authorization.decision, now);
      if (work === 'posted') posted += 1;
      else if (work === 'retried') retried += 1;
      else deadLettered += 1;
    }
    await client.query('COMMIT'); inTransaction = false;
    return { ok: true, value: { schemaVersion: '1.0.0', requestId: request.requestId, asOf: now.toISOString(),
      scanned: pending.rows.length, posted, retried, deadLettered, durableCommit: true } };
  } catch {
    if (client && inTransaction) await client.query('ROLLBACK').catch(() => undefined);
    return failure(errorEnvelope('metering', 'replayUsageOutbox', 'SOURCE_UNAVAILABLE', request.requestId, 'Usage posting recovery is temporarily unavailable.', true));
  } finally { client?.release(); }
}

/** Public combined validator for the finance wrapper and installed canonical contract. */
export function validateUsageObservationBoundary(value: unknown): Validation<UsageObservation> {
  const outer = validateRequest(UsageObservationSchema, value, 'metering', 'ingestUsage');
  if (!outer.ok) return outer;
  const canonical = validateCanonical({ contract: 'UsageEvent', value: outer.value.usageEvent,
    module: 'metering', operation: 'ingestUsage', requestId: outer.value.requestId });
  if (!canonical.ok) return canonical;
  const request = { ...outer.value, usageEvent: canonical.value } as UsageObservation;
  if (request.usageEvent.tenant_id !== request.scope.tenantId || request.usageEvent.project_id !== request.scope.projectId
      || request.usageEvent.environment !== request.scope.environment || request.usageEvent.billing_mode !== request.scope.billingMode) {
    return { ok: false, error: errorEnvelope('metering', 'ingestUsage', 'FORBIDDEN_SCOPE', request.requestId, 'The usage event does not match the authenticated financial scope.') };
  }
  if (!usageMetadataIsSafe(request.usageEvent, request)) {
    return { ok: false, error: errorEnvelope('metering', 'ingestUsage', 'VALIDATION_ERROR', request.requestId, 'Usage metadata must use reviewed opaque identifiers and measure categories.') };
  }
  return { ok: true, value: request };
}
