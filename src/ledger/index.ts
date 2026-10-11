import { Type, type Static } from '@sinclair/typebox';
import { blockedBoundary, CurrencySchema, DecimalAmountSchema, TrustedScopeSchema, type ApiResult, type RuntimePorts } from '../shared/contracts.js';
import { PostingReceiptSchema, type PostingReceipt } from '../budgets/index.js';

const VersionedReferenceSchema = Type.Object({
  contract: Type.String({ minLength: 1 }), schema_version: Type.Literal('1.0.0'), id: Type.String({ minLength: 1 }),
  revision: Type.Integer({ minimum: 0 }), content_hash: Type.String({ pattern: '^sha256:[a-f0-9]{64}$' }),
}, { additionalProperties: false });
const SourceIdentitySchema = Type.Object({
  source: Type.String({ minLength: 1, maxLength: 120 }), sourceEventId: Type.String({ minLength: 1, maxLength: 256 }),
  sourceObjectId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })), sourceRevision: Type.String({ minLength: 1, maxLength: 128 }),
  contentHash: Type.String({ pattern: '^sha256:[a-f0-9]{64}$' }),
}, { additionalProperties: false });
const FinancialDimensionsSchema = Type.Object({
  repo: Type.Optional(Type.String({ minLength: 1 })), feature: Type.Optional(Type.String({ minLength: 1 })),
  provider: Type.Optional(Type.String({ minLength: 1 })), model: Type.Optional(Type.String({ minLength: 1 })),
  workflowId: Type.Optional(Type.String({ minLength: 1 })), productId: Type.Optional(Type.String({ minLength: 1 })),
  orderId: Type.Optional(Type.String({ minLength: 1 })), channel: Type.Optional(Type.String({ minLength: 1 })),
}, { additionalProperties: false });

const FinancialEventCommonProperties = {
  schemaVersion: Type.Literal('1.0.0'), requestId: Type.String({ minLength: 1 }), idempotencyKey: Type.String({ minLength: 1 }),
  eventId: Type.String({ minLength: 1 }), scope: TrustedScopeSchema, sourceIdentity: SourceIdentitySchema,
  correlationId: Type.String({ minLength: 1 }), occurredAt: Type.String({ format: 'date-time' }), observedAt: Type.String({ format: 'date-time' }),
  ingestedAt: Type.String({ format: 'date-time' }), evidenceMode: Type.Union([Type.Literal('mocked'), Type.Literal('sandbox'), Type.Literal('live')]),
  verificationStatus: Type.Union([Type.Literal('verified'), Type.Literal('unverified'), Type.Literal('unknown')]),
  classification: Type.Union([
    Type.Literal('sale'), Type.Literal('discount'), Type.Literal('refund'), Type.Literal('credit'), Type.Literal('tax'),
    Type.Literal('fee'), Type.Literal('reimbursement'), Type.Literal('payout'), Type.Literal('direct_cost'),
    Type.Literal('expense'), Type.Literal('revenue'), Type.Literal('cash_movement'), Type.Literal('reversal'), Type.Literal('adjustment'),
  ]),
  currency: CurrencySchema, scale: Type.Integer({ minimum: 0, maximum: 18 }),
  settlement: Type.Union([Type.Literal('unpaid'), Type.Literal('partly_paid'), Type.Literal('paid')]),
  reconciliation: Type.Union([Type.Literal('unmatched'), Type.Literal('matched'), Type.Literal('exception')]),
  sourceRefs: Type.Array(VersionedReferenceSchema, { maxItems: 100 }),
  originalPostingRef: Type.Optional(VersionedReferenceSchema), relatedEventRef: Type.Optional(VersionedReferenceSchema),
  pricingPolicyRef: Type.Optional(VersionedReferenceSchema), fxEvidenceRef: Type.Optional(VersionedReferenceSchema),
  dimensions: FinancialDimensionsSchema,
  reasonReference: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
};
export const FinancialEventSchema = Type.Union([
  Type.Object({ ...FinancialEventCommonProperties, amount: Type.Null(), valuation: Type.Literal('unknown') }, { additionalProperties: false }),
  Type.Object({ ...FinancialEventCommonProperties, amount: DecimalAmountSchema, valuation: Type.Union([Type.Literal('estimated'), Type.Literal('provider_confirmed')]) }, { additionalProperties: false }),
]);
export type FinancialEvent = Static<typeof FinancialEventSchema>;

export async function ingestFinancial(request: FinancialEvent, ports: RuntimePorts): Promise<ApiResult<PostingReceipt>> {
  return blockedBoundary<FinancialEvent, PostingReceipt>({ module: 'ledger', operation: 'ingestFinancial', schema: FinancialEventSchema, request, ports, unavailableCode: 'SOURCE_UNAVAILABLE', safeMessage: 'Financial posting is not available until the accounting leaf is delivered.', retryable: true });
}

export { PostingReceiptSchema };
