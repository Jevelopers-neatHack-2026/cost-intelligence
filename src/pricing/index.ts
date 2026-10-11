import { Type, type Static } from '@sinclair/typebox';
import { blockedBoundary, CurrencySchema, DecimalAmountSchema, errorEnvelope, failure, TrustedScopeSchema, validateRequest, type ApiResult, type RuntimePorts, type Validation } from '../shared/contracts.js';
import { validateCanonical, type SharedUsageEvent } from '../shared/canonical.js';

const VersionedReferenceSchema = Type.Object({
  contract: Type.String({ minLength: 1 }), schema_version: Type.Literal('1.0.0'), id: Type.String({ minLength: 1 }),
  revision: Type.Integer({ minimum: 0 }), content_hash: Type.String({ pattern: '^sha256:[a-f0-9]{64}$' }),
}, { additionalProperties: false });

export const RateCardSchema = Type.Object({
  schemaVersion: Type.Literal('1.0.0'), id: Type.String({ minLength: 1 }), revision: Type.Integer({ minimum: 1 }),
  provider: Type.String({ minLength: 1 }), product: Type.String({ minLength: 1 }), modelOrSku: Type.String({ minLength: 1 }),
  currency: CurrencySchema, unitRates: Type.Array(Type.Object({
    category: Type.String({ minLength: 1 }), unit: Type.String({ minLength: 1 }), rate: DecimalAmountSchema,
    relation: Type.Union([Type.Literal('standalone'), Type.Literal('included_subset'), Type.Literal('unknown_relation')]),
    includedIn: Type.Optional(Type.String({ minLength: 1 })), serviceTier: Type.Optional(Type.String({ minLength: 1 })),
    reasoningMode: Type.Optional(Type.String({ minLength: 1 })), toolClass: Type.Optional(Type.String({ minLength: 1 })),
  }, { additionalProperties: false }), { minItems: 1 }),
  effectiveFrom: Type.String({ format: 'date-time' }), effectiveTo: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  retrievedAt: Type.String({ format: 'date-time' }), sourceUrl: Type.String({ format: 'uri' }),
  sourceContentHash: Type.String({ pattern: '^sha256:[a-f0-9]{64}$' }), approvalRef: VersionedReferenceSchema,
  provenance: Type.Union([Type.Literal('synthetic_fixture'), Type.Literal('documented_tariff'), Type.Literal('owner_approved')]),
}, { additionalProperties: false });
export type RateCard = Static<typeof RateCardSchema>;

export const EstimateRequestSchema = Type.Object({
  schemaVersion: Type.Literal('1.0.0'), requestId: Type.String({ minLength: 1 }), idempotencyKey: Type.String({ minLength: 1 }),
  scope: TrustedScopeSchema, usageEvent: Type.Unknown(),
  selection: Type.Object({ policy: Type.Union([Type.Literal('event_time'), Type.Literal('contract_time')]), effectiveAt: Type.String({ format: 'date-time' }),
    requestedCurrency: CurrencySchema, rateCardRef: Type.Union([VersionedReferenceSchema, Type.Null()]) }, { additionalProperties: false }),
}, { additionalProperties: false });
export type EstimateRequest = Omit<Static<typeof EstimateRequestSchema>, 'usageEvent'> & { readonly usageEvent: SharedUsageEvent };

/** Validate the finance wrapper and its nested pinned UsageEvent as one public boundary. */
export function validateEstimateRequestBoundary(value: unknown): Validation<EstimateRequest> {
  const outer = validateRequest(EstimateRequestSchema, value, 'pricing', 'estimate');
  if (!outer.ok) return outer;
  const canonical = validateCanonical({ contract: 'UsageEvent', value: outer.value.usageEvent, module: 'pricing', operation: 'estimate', requestId: outer.value.requestId });
  if (!canonical.ok) return canonical;
  return { ok: true, value: { ...outer.value, usageEvent: canonical.value } as EstimateRequest };
}

export const EstimateResultSchema = Type.Object({
  schemaVersion: Type.Literal('1.0.0'), requestId: Type.String({ minLength: 1 }), estimatedAt: Type.String({ format: 'date-time' }),
  status: Type.Union([Type.Literal('complete'), Type.Literal('partial'), Type.Literal('unknown'), Type.Literal('stale'), Type.Literal('pricing_unknown')]),
  knownSubtotal: DecimalAmountSchema, currency: CurrencySchema, rateCardRef: Type.Union([VersionedReferenceSchema, Type.Null()]),
  missingDimensions: Type.Array(Type.String({ minLength: 1 }), { maxItems: 100 }), assumptions: Type.Array(Type.String({ minLength: 1 }), { maxItems: 100 }),
  boundedConservativeAuthorizationAmount: Type.Union([DecimalAmountSchema, Type.Null()]),
  calculation: Type.Array(Type.Object({ category: Type.String({ minLength: 1 }), quantity: DecimalAmountSchema, unit: Type.String({ minLength: 1 }),
    rate: DecimalAmountSchema, extendedAmount: DecimalAmountSchema, relation: Type.Union([Type.Literal('standalone'), Type.Literal('included_subset'), Type.Literal('unknown_relation')])
  }, { additionalProperties: false }), { maxItems: 100 }),
}, { additionalProperties: false });
export type EstimateResult = Static<typeof EstimateResultSchema>;

export async function estimate(request: EstimateRequest, ports: RuntimePorts): Promise<ApiResult<EstimateResult>> {
  const validation = validateEstimateRequestBoundary(request);
  if (!validation.ok) return failure(validation.error);
  const parsed = validation.value as EstimateRequest;
  const event = parsed.usageEvent;
  if (event.tenant_id !== parsed.scope.tenantId || event.project_id !== parsed.scope.projectId || event.environment !== parsed.scope.environment || event.billing_mode !== parsed.scope.billingMode) {
    return failure(errorEnvelope('pricing', 'estimate', 'FORBIDDEN_SCOPE', parsed.requestId, 'The usage event does not match the authenticated financial scope.'));
  }
  return blockedBoundary<EstimateRequest, EstimateResult>({ module: 'pricing', operation: 'estimate', schema: EstimateRequestSchema, request: parsed, ports, unavailableCode: 'PRICING_UNKNOWN', safeMessage: 'No reviewed rate card is available for the requested event-time selection.', retryable: false });
}
