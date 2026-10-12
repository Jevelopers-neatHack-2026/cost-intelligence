import {  errorEnvelope, failure, validateRequest, type ApiResult, type RuntimePorts, type Validation } from '../shared/contracts.js';
import { validateCanonical } from '../shared/canonical.js';

export * from './schema-v1.js';
import { FinancialSummaryPageSchema, FinancialSummaryQuerySchema, type FinancialSummaryPage, type FinancialSummaryQuery } from './schema-v1.js';

/** Validate the page wrapper and its nested pinned FinancialSummary as one public boundary. */
export function validateFinancialSummaryPageBoundary(
  value: unknown,
  context: { module?: string; operation?: string } = {},
): Validation<FinancialSummaryPage> {
  const module = context.module ?? 'reporting';
  const operation = context.operation ?? 'financialSummaryPage';
  const outer = validateRequest(FinancialSummaryPageSchema, value, module, operation);
  if (!outer.ok) return outer;
  const canonical = validateCanonical({ contract: 'FinancialSummary', value: outer.value.summary, module, operation, requestId: outer.value.requestId });
  if (!canonical.ok) return canonical;
  return { ok: true, value: { ...outer.value, summary: canonical.value } as FinancialSummaryPage };
}

export * from './schema-v2.js';
export * from './definitions.js';
export * from './host-authority.js';
export { readVerifiedSummarySnapshot, readVerifiedSummarySnapshotV2, createReportingSnapshotReader, ReportingSnapshotReadRequestSchema } from './snapshots.js';
export type { ReportingSnapshotReadRequest } from './snapshots.js';
export { querySummaryV2, reportingEvidenceQueryHash, validateFinancialSummaryPageV2Boundary } from './reader.js';
export type { ReportingPorts, ReportingRuntimePorts, ReportingTransactionPort } from './runtime.js';
import { executeSummary, querySummaryV2 } from './reader.js';
import { REPORTING_POLICY_VERSION, REPORTING_DIMENSIONS, type FinancialSummaryQueryV2, type FinancialSummaryPageV2 } from './schema-v2.js';
import type { ReportingPorts } from './runtime.js';
import { hash } from './projection.js';

export function querySummary(request: FinancialSummaryQueryV2, ports: ReportingPorts): Promise<ApiResult<FinancialSummaryPageV2>>;
export function querySummary(request: FinancialSummaryQuery, ports: RuntimePorts): Promise<ApiResult<FinancialSummaryPage>>;
export async function querySummary(request: FinancialSummaryQuery | FinancialSummaryQueryV2, ports: ReportingPorts): Promise<ApiResult<FinancialSummaryPage | FinancialSummaryPageV2>> {
  if (request?.schemaVersion === '2.0.0') return querySummaryV2(request, ports);
  const validation = validateRequest(FinancialSummaryQuerySchema, request, 'reporting', 'querySummary');
  if (!validation.ok) return failure(validation.error);
  const parsed = validation.value as FinancialSummaryQuery;
  const requestId = parsed.requestId;
  const periodStart = Date.parse(parsed.period.start);
  const periodEnd = Date.parse(parsed.period.end);
  if (!Number.isFinite(periodStart) || !Number.isFinite(periodEnd) || periodStart >= periodEnd) {
    return failure(errorEnvelope('reporting', 'querySummary', 'VALIDATION_ERROR', requestId, 'The query period must end after it starts.'));
  }
  if (parsed.cursor && !parsed.snapshotId) {
    return failure(errorEnvelope('reporting', 'querySummary', 'VALIDATION_ERROR', requestId, 'A continuation cursor must be bound to its original snapshot.'));
  }
  if (parsed.filters.environments.some(value => value !== parsed.scope.environment)
      || parsed.filters.billingModes.some(value => value !== parsed.scope.billingMode)) {
    return failure(errorEnvelope('reporting', 'querySummary', 'FORBIDDEN_SCOPE', requestId, 'The requested filters exceed the authenticated environment or billing-mode scope.'));
  }
  const result = await executeSummary({ ...parsed, schemaVersion: '2.0.0', policyVersion: REPORTING_POLICY_VERSION, groupings: [...REPORTING_DIMENSIONS] }, ports, '1.0.0');
  if (!result.ok) return result;
  const page = result.value;
  if (page.canonicalSummaries.length !== 1) return failure(errorEnvelope('reporting', 'querySummary', 'SOURCE_UNAVAILABLE', requestId,
    'The legacy encoding requires an observed single currency and UUID scope; use the proposed reporting v2 wrapper.'));
  const legacy = { schemaVersion: '1.0.0' as const, requestId, snapshotId: page.snapshotId, queryContentHash: page.queryContentHash,
    asOf: page.asOf, timezone: page.timezone, watermark: page.watermark, filters: page.filters, summaryContentHash: hash(page.canonicalSummaries[0]),
    summary: page.canonicalSummaries[0]!, hasMore: page.hasMore, nextCursor: page.nextCursor };
  const checked = validateFinancialSummaryPageBoundary(legacy);
  return checked.ok ? { ok: true, value: checked.value } : failure(checked.error);
}

/** Validate an inner canonical summary before a wrapper is exported or archived. */
export function validateSummarySnapshot(args: {
  summary: unknown;
  module: string;
  operation: string;
  requestId: string;
}) {
  return validateCanonical({ contract: 'FinancialSummary', value: args.summary, module: args.module, operation: args.operation, requestId: args.requestId });
}
