import { Type, type Static } from '@sinclair/typebox';
import { CurrencySchema, TrustedScopeSchema } from '../shared/contracts.js';
import type { SharedFinancialSummary } from '../shared/canonical.js';

const EnvironmentFilterSchema = Type.Array(Type.Union([
  Type.Literal('development'), Type.Literal('test'), Type.Literal('production'),
]), { minItems: 1, maxItems: 3, uniqueItems: true });
const BillingModeFilterSchema = Type.Array(Type.Union([
  Type.Literal('live'), Type.Literal('sandbox'), Type.Literal('simulated'),
]), { minItems: 1, maxItems: 3, uniqueItems: true });
const StringFilterSchema = Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { minItems: 1, maxItems: 100, uniqueItems: true });

/**
 * Finance-owned query wrapper. The pinned shared FinancialSummary is the
 * canonical economic payload; this wrapper carries reproducible query identity
 * that the current proposal does not model.
 */
export const FinancialSummaryFiltersSchema = Type.Object({
  environments: EnvironmentFilterSchema,
  billingModes: BillingModeFilterSchema,
  currency: Type.Optional(CurrencySchema),
  repositories: Type.Optional(StringFilterSchema),
  workstreams: Type.Optional(StringFilterSchema),
  providers: Type.Optional(StringFilterSchema),
  models: Type.Optional(StringFilterSchema),
  workflowIds: Type.Optional(StringFilterSchema),
  jobIds: Type.Optional(StringFilterSchema),
  featureCategories: Type.Optional(StringFilterSchema),
  orderIds: Type.Optional(StringFilterSchema),
  customerIds: Type.Optional(StringFilterSchema),
}, { additionalProperties: false });
export type FinancialSummaryFilters = Static<typeof FinancialSummaryFiltersSchema>;

export const FinancialSummaryQuerySchema = Type.Object({
  schemaVersion: Type.Literal('1.0.0'),
  requestId: Type.String({ minLength: 1, maxLength: 128 }),
  idempotencyKey: Type.String({ minLength: 1, maxLength: 200 }),
  scope: TrustedScopeSchema,
  period: Type.Object({
    start: Type.String({ format: 'date-time' }),
    end: Type.String({ format: 'date-time' }),
  }, { additionalProperties: false }),
  timezone: Type.String({ minLength: 1, maxLength: 64, pattern: '^[A-Za-z_+-]+(?:/[A-Za-z0-9_+.-]+)*$' }),
  requestedAsOf: Type.Optional(Type.String({ format: 'date-time' })),
  snapshotId: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
  pageSize: Type.Integer({ minimum: 1, maximum: 500 }),
  filters: FinancialSummaryFiltersSchema,
}, { additionalProperties: false });
export type FinancialSummaryQuery = Static<typeof FinancialSummaryQuerySchema>;

export const SummarySourceWatermarkSchema = Type.Object({
  source: Type.String({ minLength: 1, maxLength: 120 }),
  revision: Type.String({ minLength: 1, maxLength: 128 }),
  observedThrough: Type.String({ format: 'date-time' }),
  contentHash: Type.String({ pattern: '^sha256:[a-f0-9]{64}$' }),
  completeness: Type.Union([Type.Literal('complete'), Type.Literal('partial'), Type.Literal('unknown')]),
}, { additionalProperties: false });

export const FinancialSummaryPageSchema = Type.Object({
  schemaVersion: Type.Literal('1.0.0'),
  requestId: Type.String({ minLength: 1 }),
  snapshotId: Type.String({ minLength: 1, maxLength: 200 }),
  queryContentHash: Type.String({ pattern: '^sha256:[a-f0-9]{64}$' }),
  asOf: Type.String({ format: 'date-time' }),
  timezone: Type.String({ minLength: 1, maxLength: 64, pattern: '^[A-Za-z_+-]+(?:/[A-Za-z0-9_+.-]+)*$' }),
  watermark: Type.Object({
    watermarkId: Type.String({ minLength: 1, maxLength: 200 }),
    capturedAt: Type.String({ format: 'date-time' }),
    sources: Type.Array(SummarySourceWatermarkSchema, { minItems: 1, maxItems: 500 }),
  }, { additionalProperties: false }),
  filters: FinancialSummaryFiltersSchema,
  summaryContentHash: Type.String({ pattern: '^sha256:[a-f0-9]{64}$' }),
  summary: Type.Unknown(),
  hasMore: Type.Boolean(),
  nextCursor: Type.Union([Type.String({ minLength: 1, maxLength: 2048 }), Type.Null()]),
}, { additionalProperties: false });
export type FinancialSummaryPage = Omit<Static<typeof FinancialSummaryPageSchema>, 'summary'> & { readonly summary: SharedFinancialSummary };

