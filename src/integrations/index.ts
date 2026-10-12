import { releaseDisclosure, sealDisclosureSuccess, bindManifestDisclosure } from './disclosure-fence.js';
import { reportingExportBridge } from './reporting-bridge.js';
import { Type, type Static } from '@sinclair/typebox';
import { TrustedScopeSchema, validateRequest, type ApiResult, type Validation } from '../shared/contracts.js';
import { validateFinancialSummaryPageBoundary, FinancialSummaryPageSchema, type FinancialSummaryPage } from '../reporting/index.js';
import type { SharedFinancialSummary } from '../shared/canonical.js';
import { encodeTextCell } from './csv.js';
import { prepareExport, type ExportRuntimePorts } from './runtime.js';

export const ExportRequestSchema = Type.Object({
  schemaVersion: Type.Literal('1.0.0'), requestId: Type.String({ minLength: 1 }), idempotencyKey: Type.String({ minLength: 1 }),
  scope: TrustedScopeSchema, summarySnapshot: FinancialSummaryPageSchema, summaryContentHash: Type.String({ pattern: '^sha256:[a-f0-9]{64}$' }),
  destination: Type.Literal('cfo.ai'), format: Type.Union([Type.Literal('json'), Type.Literal('csv')]),
  requestedAt: Type.String({ format: 'date-time' }), evidenceMode: Type.Union([Type.Literal('mocked'), Type.Literal('sandbox'), Type.Literal('live')]),
  requestedBy: Type.String({ minLength: 1, maxLength: 200 }),
}, { additionalProperties: false });
export type ExportRequest = Omit<Static<typeof ExportRequestSchema>, 'summarySnapshot'> & { readonly summarySnapshot: FinancialSummaryPage };

/** Validate both finance wrappers and the nested pinned FinancialSummary as one public boundary. */
export function validateExportRequestBoundary(value: unknown): Validation<ExportRequest> {
  const outer = validateRequest(ExportRequestSchema, value, 'integrations', 'exportSummary');
  if (!outer.ok) return outer;
  const snapshot = validateFinancialSummaryPageBoundary(outer.value.summarySnapshot, { module: 'integrations', operation: 'exportSummary' });
  if (!snapshot.ok) return snapshot;
  return { ok: true, value: { ...outer.value, summarySnapshot: snapshot.value } as ExportRequest };
}

export const ExportManifestSchema = Type.Object({
  schemaVersion: Type.Literal('1.0.0'), requestId: Type.String({ minLength: 1 }), exportId: Type.String({ minLength: 1 }),
  status: Type.Union([Type.Literal('prepared'), Type.Literal('delivered'), Type.Literal('failed')]), destination: Type.Literal('cfo.ai'),
  summaryId: Type.String({ minLength: 1 }), summaryRevision: Type.Integer({ minimum: 0 }), summaryContentHash: Type.String({ pattern: '^sha256:[a-f0-9]{64}$' }),
  snapshotId: Type.String({ minLength: 1 }), snapshotAsOf: Type.String({ format: 'date-time' }), snapshotTimezone: Type.String({ minLength: 1 }),
  watermarkId: Type.String({ minLength: 1 }), queryContentHash: Type.String({ pattern: '^sha256:[a-f0-9]{64}$' }),
  createdAt: Type.String({ format: 'date-time' }), itemCount: Type.Integer({ minimum: 0 }), evidenceMode: Type.Union([Type.Literal('mocked'), Type.Literal('sandbox'), Type.Literal('live')]),
  deliveryReference: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
}, { additionalProperties: false });
export type ExportManifest = Static<typeof ExportManifestSchema>;

export type SafeFinancialMetricRow = {
  readonly metric: string;
  readonly status: 'known' | 'unknown';
  readonly amount: string | null;
  readonly amountCurrency: string | null;
  readonly amountScale: number | null;
};

/** The export allowlist intentionally excludes tenant/project IDs, event IDs, source refs, and customer/provider identifiers. */
export type SafeFinancialSummaryProjection = {
  readonly period: { readonly start: string; readonly end: string };
  readonly environment: string;
  readonly billingMode: string;
  readonly currency: string;
  readonly valuationBasis: string;
  readonly completeness: string;
  readonly settlement: string;
  readonly reconciliation: string;
  readonly metrics: readonly SafeFinancialMetricRow[];
};

// MetricDefinition is still a shared proposal without a reviewed display-name registry.
// Until that registry exists, only the public metric name covered by the pinned fixture is exportable.
const SAFE_SUMMARY_METRIC_NAMES = new Set(['expense']);

/** Explicit field projection for downstream export adapters. It does not perform authorization. */
export function projectSafeFinancialSummary(summary: SharedFinancialSummary): SafeFinancialSummaryProjection {
  const metrics = Object.entries(summary.metrics).filter(([metric]) => SAFE_SUMMARY_METRIC_NAMES.has(metric))
    .sort(([left], [right]) => left.localeCompare(right)).map(([metric, value]) => ({
    metric,
    status: value.status,
    amount: value.status === 'known' ? value.value.amount : null,
    amountCurrency: value.status === 'known' ? value.value.currency : null,
    amountScale: value.status === 'known' ? value.value.scale : null,
  } satisfies SafeFinancialMetricRow));
  return {
    period: { start: summary.period.start, end: summary.period.end },
    environment: summary.environment,
    billingMode: summary.billing_mode,
    currency: summary.currency,
    valuationBasis: summary.valuation_basis,
    completeness: summary.completeness,
    settlement: summary.settlement,
    reconciliation: summary.reconciliation,
    metrics,
  };
}

/** Quote every cell and neutralize spreadsheet formulas before CSV escaping. */
export function safeCsvCell(value: string | number | boolean | null): string {
  const text = value === null ? '' : String(value).replace(/\r\n?/g, '\n');
  const encoded = encodeTextCell(text);
  return encoded.startsWith('"') ? encoded : '"' + encoded + '"';
}

/** Deterministic CSV serialization from the safe allowlist; raw evidence and identifiers are never copied. */
export function serializeSafeFinancialSummaryCsv(summary: SharedFinancialSummary): string {
  const projection = projectSafeFinancialSummary(summary);
  const headers = [
    'period_start', 'period_end', 'environment', 'billing_mode', 'currency', 'valuation_basis',
    'completeness', 'settlement', 'reconciliation', 'metric', 'status', 'amount', 'amount_currency', 'amount_scale',
  ];
  const rows = projection.metrics.map(metric => [
    projection.period.start, projection.period.end, projection.environment, projection.billingMode,
    projection.currency, projection.valuationBasis, projection.completeness, projection.settlement,
    projection.reconciliation, metric.metric, metric.status, metric.amount, metric.amountCurrency, metric.amountScale,
  ]);
  return [headers, ...rows].map(row => row.map(safeCsvCell).join(',')).join('\r\n') + '\r\n';
}

export async function exportSummary(request: ExportRequest, ports: ExportRuntimePorts): Promise<ApiResult<ExportManifest>> {
  const prepared = await prepareExport(request, ports, true);
  const response = prepared.ok ? sealDisclosureSuccess(prepared.value.manifest) : prepared;
  if (prepared.ok && response.ok) bindManifestDisclosure(prepared.value, response, ports.clock);
  const released = releaseDisclosure(prepared, ports.clock, !!reportingExportBridge(ports));
  return released.ok ? response : released;
}

export { exportSummaryV2, getPreparedExportArtifacts, hashExportCanonical, ExportArtifactManifestV2Schema } from './runtime.js';
export type { ExportRuntimePorts, ExportSnapshotReaderPort, ExportArtifactStorePort, ExportArtifact, ExportArtifactManifestV2, PreparedExportArtifacts, StoredExportArtifacts } from './runtime.js';
export { createFileExportArtifactStore, createFileReportingExportArtifactStore } from './artifact-store.js';
export { createReportingExportRuntimePorts, REPORTING_EXPORT_REGISTRY_PIN } from './reporting-bridge.js';
export { validateReportingExportRequestBoundary, ReportingExportRequestSchema, ReportingExportManifestSchema, ReportingExportReceiptSchema } from './reporting-export.js';
export type { ReportingExportRequest, ReportingExportManifest, ReportingPreparedExportArtifacts, ReportingStoredExportArtifacts, ReportingExportArtifactStorePort } from './reporting-export.js';

export type { ExportDisclosureFencePort, ExportDisclosureFenceRequest, ExportDisclosureFenceResult, ExportAccessPermit, CurrentExportAccessSnapshot } from './disclosure-fence.js';

export { releaseExportDisclosure } from './disclosure-fence.js';
