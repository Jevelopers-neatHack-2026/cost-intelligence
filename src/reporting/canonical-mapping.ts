import { validateCanonical, type SharedFinancialSummary } from '../shared/canonical.js';
import type { ReportingProjection, FinancialSummaryQueryV2, ReportingDetail } from './schema-v2.js';
import type { ReportingRuntimePorts } from './runtime.js';
import { REPORTING_CANONICAL_REFERENCE_REGISTRY } from './definitions.js';
import { hash } from './projection.js';
export const CANONICAL_SCOPE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function summaryIdentity(content: unknown): string {
  const bytes = hash(content).slice(7,39).split(''); bytes[12] = '4'; bytes[16] = '8';
  const hex = bytes.join(''); return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
/** Explicit mapping to the unchanged installed shared proposal. No authority ID conversion. */
export function canonicalSummaries(query: FinancialSummaryQueryV2, asOf: string, summary: ReportingProjection, producer: ReportingRuntimePorts['producer'], details: readonly ReportingDetail[]): SharedFinancialSummary[] {
  if (!CANONICAL_SCOPE_PATTERN.test(query.scope.tenantId) || !CANONICAL_SCOPE_PATTERN.test(query.scope.projectId)) return [];
  const names = { expense: 'expense', grossSales: 'gross_sales', netSales: 'net_sales', directCosts: 'direct_costs', contribution: 'contribution', cashReceipts: 'cash_receipts', cashPayouts: 'cash_payouts' } as const;
  return summary.currencies.filter(row => details.some(detail => detail.currency === row.currency)).map(row => {
    const records = details.filter(detail => detail.currency === row.currency);
    const metrics = Object.fromEntries(Object.entries(names).map(([key,name]) => {
      const metric = row.metrics[key as keyof typeof names];
      return [name, { status: metric.total === null ? 'unknown' : 'known', definition_ref: structuredClone(REPORTING_CANONICAL_REFERENCE_REGISTRY.metrics[name]!.reference),
        value: metric.total === null ? null : { amount: metric.total, currency: row.currency, scale: 18 }, source_refs: [] }];
    }));
    const { requestId: _requestId, idempotencyKey: _idempotencyKey, cursor: _cursor, snapshotId: _snapshotId, requestedAsOf: _requestedAsOf, ...queryIdentity } = query;
    const id = summaryIdentity({ query: queryIdentity, asOf, currency: row.currency, metrics });
    const value = { contract: 'FinancialSummary', schema_version: '1.0.0', policy_version: '1.0.0', event_id: id, tenant_id: query.scope.tenantId, project_id: query.scope.projectId,
      correlation_id: id, producer: { module: 'cost-intelligence', source_revision: producer.sourceRevision, build_revision: producer.buildRevision },
      occurred_at: asOf, observed_at: asOf, ingested_at: asOf, environment: query.scope.environment, billing_mode: query.scope.billingMode, source_refs: [], summary_id: id,
      revision: 1, period: query.period, currency: row.currency, scale: 18, rounding: 'none', rounding_boundary: 'none',
      valuation_basis: row.valuation.unknownCount ? 'unknown' : row.valuation.estimated.knownSubtotal !== null ? 'estimated' : row.valuation.confirmed.knownSubtotal !== null ? 'provider_confirmed' : 'unknown',
      settlement: records.every(record => record.settlement === 'paid') ? 'paid' : records.every(record => record.settlement === 'unpaid') ? 'unpaid' : 'partly_paid', reconciliation: row.reconciliation.exceptionCount ? 'exception' : row.reconciliation.unmatchedCount ? 'unmatched' : row.reconciliation.matchedCount ? 'matched' : 'unmatched',
      reservation_state: summary.budgets.some(budget => budget.currency === row.currency && budget.unresolvedExposure) ? 'uncertain' : summary.budgets.some(budget => budget.currency === row.currency && budget.held !== '0') ? 'held' : 'none',
      completeness: summary.coverage.status === 'complete' ? 'complete' : summary.coverage.status === 'partial' ? 'incomplete' : 'unknown',
      included_environments: query.filters.environments, included_billing_modes: query.filters.billingModes, coverage: { observed: row.groups.filter(group => group.dimension === query.groupings[0]).reduce((n,group) => n + group.eventCount,0), expected: summary.coverage.status === 'complete' ? records.length : null, missing_sources: summary.coverage.missingSources },
      metrics, original_amounts: [], conversion_ref: null, policy_ref: structuredClone(REPORTING_CANONICAL_REFERENCE_REGISTRY.policy.reference), rate_card_refs: [], financial_event_refs: [] };
    const validated = validateCanonical({ contract: 'FinancialSummary', value, module: 'reporting', operation: 'querySummary', requestId: query.requestId });
    if (!validated.ok) throw new Error('Canonical proposal mapping is unsupported');
    return validated.value;
  });
}
