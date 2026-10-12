import { Type, type Static } from '@sinclair/typebox';
import { CurrencySchema, DecimalAmountSchema, TrustedScopeSchema } from '../shared/contracts.js';
import type { SharedFinancialSummary } from '../shared/canonical.js';
import { FinancialSummaryFiltersSchema, SummarySourceWatermarkSchema } from './schema-v1.js';

export const REPORTING_POLICY_VERSION = 'ci08-reporting-policy-2.0.0' as const;
export const REPORTING_DIMENSIONS = ['provider', 'model', 'feature', 'repo', 'workflowId', 'productId', 'orderId', 'channel'] as const;
export const ReportingDimensionSchema = Type.Union(REPORTING_DIMENSIONS.map(value => Type.Literal(value)));
export type ReportingDimension = Static<typeof ReportingDimensionSchema>;
const Identifier = Type.String({ minLength: 1, maxLength: 256 });
const Hash = Type.String({ pattern: '^sha256:[a-f0-9]{64}$' });
const Instant = Type.String({ format: 'date-time' });
const Period = Type.Object({ start: Instant, end: Instant }, { additionalProperties: false });
const StringFilter = Type.Array(Identifier, { minItems: 1, maxItems: 100, uniqueItems: true });
export const FinancialSummaryFiltersV2Schema = Type.Object({
  ...FinancialSummaryFiltersSchema.properties,
  products: Type.Optional(StringFilter), channels: Type.Optional(StringFilter),
}, { additionalProperties: false });
export const FinancialSummaryQueryV2Schema = Type.Object({
  schemaVersion: Type.Literal('2.0.0'), requestId: Type.String({ minLength: 1, maxLength: 128 }),
  idempotencyKey: Type.String({ minLength: 1, maxLength: 200 }), scope: TrustedScopeSchema,
  period: Period, timezone: Type.String({ minLength: 1, maxLength: 64 }),
  policyVersion: Type.Literal(REPORTING_POLICY_VERSION),
  requestedAsOf: Type.Optional(Instant), snapshotId: Type.Optional(Hash), cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
  pageSize: Type.Integer({ minimum: 1, maximum: 500 }), filters: FinancialSummaryFiltersV2Schema,
  groupings: Type.Array(ReportingDimensionSchema, { minItems: 1, maxItems: 8, uniqueItems: true }),
}, { additionalProperties: false });
export type FinancialSummaryQueryV2 = Static<typeof FinancialSummaryQueryV2Schema>;
export const ReportingAmountSchema = Type.Object({
  status: Type.Union([Type.Literal('known'), Type.Literal('partial'), Type.Literal('unknown')]),
  knownSubtotal: Type.Union([DecimalAmountSchema, Type.Null()]), total: Type.Union([DecimalAmountSchema, Type.Null()]),
  unknownCount: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false });
const Dimensions = Type.Object(Object.fromEntries(REPORTING_DIMENSIONS.map(key => [key, Type.Union([Identifier, Type.Null()])])), { additionalProperties: false });
export const ReportingDetailSchema = Type.Object({
  detailId: Hash, currency: CurrencySchema, eventType: Identifier, classification: Identifier,
  occurredAt: Instant, valuation: Type.Union([Type.Literal('estimated'), Type.Literal('provider_confirmed'), Type.Literal('unknown')]),
  reconciliation: Type.Union([Type.Literal('unmatched'), Type.Literal('matched'), Type.Literal('exception')]),
  settlement: Type.Union([Type.Literal('unpaid'), Type.Literal('partly_paid'), Type.Literal('paid')]),
  dimensions: Dimensions,
  amount: Type.Union([DecimalAmountSchema, Type.Null()]),
  metrics: Type.Object({ expense: DecimalAmountSchema, grossSales: DecimalAmountSchema, netSales: DecimalAmountSchema, directCosts: DecimalAmountSchema, contribution: DecimalAmountSchema,
    cashReceipts: DecimalAmountSchema, cashPayouts: DecimalAmountSchema, simulatedGrossSales: DecimalAmountSchema, simulatedNetSales: DecimalAmountSchema,
    simulatedDirectCosts: DecimalAmountSchema, simulatedExpense: DecimalAmountSchema }, { additionalProperties: false }),
  status: Type.Union([Type.Literal('recognized'), Type.Literal('unknown'), Type.Literal('unsupported')]),
}, { additionalProperties: false });
export type ReportingDetail = Static<typeof ReportingDetailSchema>;
const Metrics = Type.Object({ expense: ReportingAmountSchema, grossSales: ReportingAmountSchema, netSales: ReportingAmountSchema, directCosts: ReportingAmountSchema,
  contribution: ReportingAmountSchema, cashReceipts: ReportingAmountSchema, cashPayouts: ReportingAmountSchema }, { additionalProperties: false });
export const ReportingCurrencySummarySchema = Type.Object({
  currency: CurrencySchema, scale: Type.Literal(18), metrics: Metrics,
  valuation: Type.Object({ estimated: ReportingAmountSchema, confirmed: ReportingAmountSchema, unknownCount: Type.Integer({ minimum: 0 }) }, { additionalProperties: false }),
  reconciliation: Type.Object({ matchedCount: Type.Integer({ minimum: 0 }), unmatchedCount: Type.Integer({ minimum: 0 }), exceptionCount: Type.Integer({ minimum: 0 }) }, { additionalProperties: false }),
  simulated: Type.Object({ expense: ReportingAmountSchema, grossSales: ReportingAmountSchema, netSales: ReportingAmountSchema, directCosts: ReportingAmountSchema }, { additionalProperties: false }),
  groups: Type.Array(Type.Object({ dimension: ReportingDimensionSchema, value: Type.Union([Identifier, Type.Null()]), bucket: Type.Union([Type.Literal('known'), Type.Literal('unknown_unallocated')]),
    eventCount: Type.Integer({ minimum: 0 }), metrics: Metrics }, { additionalProperties: false }), { maxItems: 400000 }),
}, { additionalProperties: false });
const Reference = Type.Object({ id: Identifier, revision: Type.Integer({ minimum: 1, maximum: 2147483647 }), contentHash: Hash }, { additionalProperties: false });
export const ReportingProductEvidenceSchema = Type.Object({
  version: Type.Literal('1.0.0'), queryContentHash: Hash, scope: TrustedScopeSchema, period: Period, asOf: Instant,
  denominators: Type.Array(Type.Object({ kind: Type.Union([Type.Literal('design'), Type.Literal('workflow'), Type.Literal('order')]),
    status: Type.Union([Type.Literal('complete'), Type.Literal('partial'), Type.Literal('unknown')]), count: Type.Union([Type.String({ pattern: '^(?:0|[1-9][0-9]*)$', maxLength: 30 }), Type.Null()]), approvalReference: Reference }, { additionalProperties: false }), { maxItems: 3 }),
  sourceCoverage: Type.Array(Type.Object({ currency: CurrencySchema, source: Type.Union([Type.Literal('expense'), Type.Literal('revenue'), Type.Literal('cash')]),
    status: Type.Union([Type.Literal('complete'), Type.Literal('partial'), Type.Literal('unknown')]), expected: Type.Union([Type.Integer({ minimum: 0, maximum: 1000000 }), Type.Null()]) }, { additionalProperties: false }), { maxItems: 300 }),
  reference: Reference,
}, { additionalProperties: false });
export type ReportingProductEvidence = Static<typeof ReportingProductEvidenceSchema>;
export const ReportingProjectionSchema = Type.Object({
  policyVersion: Type.Literal(REPORTING_POLICY_VERSION), accountingPolicyVersion: Identifier, definitionsStatus: Identifier,
  currencies: Type.Array(ReportingCurrencySummarySchema, { maxItems: 100 }),
  coverage: Type.Object({ status: Type.Union([Type.Literal('complete'), Type.Literal('partial'), Type.Literal('unknown')]), observed: Type.Integer({ minimum: 0 }),
    expected: Type.Union([Type.Integer({ minimum: 0, maximum: 1000000 }), Type.Null()]), unknownAmountCount: Type.Integer({ minimum: 0 }), unpostedAttemptCount: Type.Integer({ minimum: 0 }),
    awaitingEvidenceAttemptCount: Type.Integer({ minimum: 0 }), quarantinedObservationCount: Type.Integer({ minimum: 0 }), unsupportedEventCount: Type.Integer({ minimum: 0 }),
    missingSources: Type.Array(Identifier, { maxItems: 100 }) }, { additionalProperties: false }),
  budgets: Type.Array(Type.Object({ currency: CurrencySchema, window: Type.Literal('project_lifetime'), policyReference: Type.Union([Reference, Type.Null()]),
    limit: Type.Union([DecimalAmountSchema, Type.Null()]), ledgerExpense: DecimalAmountSchema, lifecycleConsumed: DecimalAmountSchema,
    held: DecimalAmountSchema, remainingAuthorizedCapacity: Type.Union([DecimalAmountSchema, Type.Null()]), unresolvedExposure: Type.Boolean(),
    advisoryOnly: Type.Literal(true) }, { additionalProperties: false }), { maxItems: 100 }),
  unitCosts: Type.Array(Type.Object({ kind: Type.Union([Type.Literal('design'), Type.Literal('workflow'), Type.Literal('order')]), currency: CurrencySchema,
    status: Type.Union([Type.Literal('known'), Type.Literal('unknown'), Type.Literal('zero_denominator')]), numerator: Type.Union([DecimalAmountSchema, Type.Null()]),
    denominator: Type.Union([Type.String({ pattern: '^(?:0|[1-9][0-9]*)$' }), Type.Null()]), approvalReference: Type.Union([Reference, Type.Null()]),
    allocationPolicyVersion: Identifier }, { additionalProperties: false }), { maxItems: 300 }),
  allocations: Type.Array(Type.Object({ sourceDetailId: Hash, policyReference: Reference, currency: CurrencySchema, sourceAmount: DecimalAmountSchema,
    allocatedTotal: DecimalAmountSchema, residual: DecimalAmountSchema, allocations: Type.Array(Type.Object({ key: Identifier, amount: DecimalAmountSchema }, { additionalProperties: false }), { maxItems: 1000 }) }, { additionalProperties: false }), { maxItems: 50000 }),
}, { additionalProperties: false });
export type ReportingProjection = Static<typeof ReportingProjectionSchema>;
export const FinancialSummaryPageV2Schema = Type.Object({
  schemaVersion: Type.Literal('2.0.0'), requestId: Identifier, snapshotId: Hash, queryContentHash: Hash, summaryContentHash: Hash,
  asOf: Instant, timezone: Type.String({ minLength: 1, maxLength: 64 }), period: Period, scope: TrustedScopeSchema,
  filters: FinancialSummaryFiltersV2Schema,
  watermark: Type.Object({ watermarkId: Hash, capturedAt: Instant, sources: Type.Array(SummarySourceWatermarkSchema, { minItems: 1, maxItems: 500 }) }, { additionalProperties: false }),
  summary: ReportingProjectionSchema, details: Type.Array(ReportingDetailSchema, { maxItems: 500 }),
  detailCount: Type.Integer({ minimum: 0 }), hasMore: Type.Boolean(), nextCursor: Type.Union([Type.String({ maxLength: 2048 }), Type.Null()]),
  canonicalSummaries: Type.Array(Type.Unknown(), { maxItems: 100 }),
  canonicalMappingStatus: Type.Union([Type.Literal('proposal_only_owner_ack_pending'), Type.Literal('unsupported_opaque_scope')]),
}, { additionalProperties: false });
export type FinancialSummaryPageV2 = Omit<Static<typeof FinancialSummaryPageV2Schema>, 'canonicalSummaries'> & { canonicalSummaries: SharedFinancialSummary[] };
