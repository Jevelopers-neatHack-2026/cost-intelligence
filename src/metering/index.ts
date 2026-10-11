import { Type, type Static } from '@sinclair/typebox';
import { errorEnvelope, failure, TrustedScopeSchema, validateRequest, type ApiResult, type RuntimePorts, type Validation } from '../shared/contracts.js';
import { validateCanonical, type SharedUsageEvent } from '../shared/canonical.js';

export const UsageObservationSchema = Type.Object({
  schemaVersion: Type.Literal('1.0.0'),
  requestId: Type.String({ minLength: 1 }),
  idempotencyKey: Type.String({ minLength: 1 }),
  scope: TrustedScopeSchema,
  usageEvent: Type.Unknown(),
  evidenceMode: Type.Union([Type.Literal('mocked'), Type.Literal('sandbox'), Type.Literal('live')]),
  verificationStatus: Type.Union([Type.Literal('verified'), Type.Literal('unverified'), Type.Literal('unknown')]),
  evidenceProvenanceRef: Type.String({ minLength: 1, maxLength: 240 }),
}, { additionalProperties: false });
export type UsageObservation = Omit<Static<typeof UsageObservationSchema>, 'usageEvent'> & { readonly usageEvent: SharedUsageEvent };

/** Validate the finance wrapper and its nested pinned UsageEvent as one public boundary. */
export function validateUsageObservationBoundary(value: unknown): Validation<UsageObservation> {
  const outer = validateRequest(UsageObservationSchema, value, 'metering', 'ingestUsage');
  if (!outer.ok) return outer;
  const canonical = validateCanonical({ contract: 'UsageEvent', value: outer.value.usageEvent, module: 'metering', operation: 'ingestUsage', requestId: outer.value.requestId });
  if (!canonical.ok) return canonical;
  return { ok: true, value: { ...outer.value, usageEvent: canonical.value } as UsageObservation };
}

export const IngestionReceiptSchema = Type.Object({
  schemaVersion: Type.Literal('1.0.0'),
  requestId: Type.String({ minLength: 1 }),
  asOf: Type.String({ format: 'date-time' }),
  status: Type.Union([Type.Literal('accepted'), Type.Literal('duplicate'), Type.Literal('quarantined'), Type.Literal('conflict')]),
  eventId: Type.String({ minLength: 1 }),
  sourceObservationId: Type.String({ minLength: 1 }),
  logicalOperationId: Type.String({ minLength: 1 }),
  providerAttemptId: Type.String({ minLength: 1 }),
  billableAttemptId: Type.String({ minLength: 1 }),
  transportAttemptId: Type.String({ minLength: 1 }),
  completeness: Type.Union([Type.Literal('unknown'), Type.Literal('incomplete'), Type.Literal('complete')]),
  valuation: Type.Union([Type.Literal('unknown'), Type.Literal('estimated'), Type.Literal('provider_confirmed')]),
  durableCommit: Type.Boolean(),
  existingEventId: Type.Optional(Type.String({ minLength: 1 })),
  quarantineCode: Type.Optional(Type.String({ minLength: 1 })),
}, { additionalProperties: false });
export type IngestionReceipt = Static<typeof IngestionReceiptSchema>;

export async function ingestUsage(request: UsageObservation, ports: RuntimePorts): Promise<ApiResult<IngestionReceipt>> {
  const validation = validateUsageObservationBoundary(request);
  if (!validation.ok) return failure(validation.error);
  const observation = validation.value as UsageObservation;
  const event = observation.usageEvent;
  const requested = observation.scope;
  if (event.tenant_id !== requested.tenantId || event.project_id !== requested.projectId || event.environment !== requested.environment || event.billing_mode !== requested.billingMode) {
    return failure(errorEnvelope('metering', 'ingestUsage', 'FORBIDDEN_SCOPE', observation.requestId, 'The usage event does not match the authenticated financial scope.'));
  }
  try {
    const trusted = await ports.trustedContext.resolve(requested);
    if (!trusted || trusted.tenantId !== requested.tenantId || trusted.projectId !== requested.projectId || trusted.environment !== requested.environment || trusted.billingMode !== requested.billingMode || trusted.actorId !== requested.actorId) {
      return failure(errorEnvelope('metering', 'ingestUsage', 'FORBIDDEN_SCOPE', observation.requestId, 'The requested financial scope is not authorized.'));
    }
  } catch {
    return failure(errorEnvelope('metering', 'ingestUsage', 'SOURCE_UNAVAILABLE', observation.requestId, 'Trusted authorization context is temporarily unavailable.', true));
  }
  return failure(errorEnvelope('metering', 'ingestUsage', 'SOURCE_UNAVAILABLE', observation.requestId, 'Usage ingestion is not available until the metering implementation is delivered.', true));
}
