import { createHash } from 'node:crypto';
import { projectAccounting, ACCOUNTING_POLICY_VERSION, ACCOUNTING_DEFINITIONS_STATUS, ACCOUNTING_ALLOCATION_POLICY_VERSION, type AccountingEvent } from '../accounting/index.js';
import { REPORTING_DIMENSIONS, REPORTING_POLICY_VERSION, type FinancialSummaryQueryV2, type ReportingDetail, type ReportingProjection, type ReportingProductEvidence, type ReportingDimension } from './schema-v2.js';

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const record = value as Record<string, unknown>;
  return '{' + Object.keys(record).sort().map(key => JSON.stringify(key) + ':' + canonicalJson(record[key])).join(',') + '}';
}
export function safeReportingReference(value: string): boolean { return value.length > 0 && value.length <= 256 && !/(?:[\u0000-\u001f]|https?:\/\/|[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}|(?:^|[^a-z0-9])(?:prompt|password|secret|bearer|address|email)(?:$|[^a-z0-9]))/i.test(value); }
export function hash(value: unknown): string { return 'sha256:' + createHash('sha256').update(canonicalJson(value)).digest('hex'); }
export function decimal(value: string): bigint {
  if (!/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]{1,18})?$/.test(value)) throw new Error('Invalid exact amount');
  const negative = value.startsWith('-'); const [whole, fraction = ''] = (negative ? value.slice(1) : value).split('.');
  return BigInt(whole! + fraction.padEnd(18, '0')) * (negative ? -1n : 1n);
}
export function amount(value: bigint): string {
  const sign = value < 0n ? '-' : ''; const digits = (value < 0n ? -value : value).toString().padStart(19, '0');
  const fraction = digits.slice(-18).replace(/0+$/, ''); return sign + digits.slice(0, -18) + (fraction ? '.' + fraction : '');
}
export interface SourceEvent { eventId: string; eventHash: string; rootId: string; economicEventType: string; economicAxisType?: string; cashDirection?: 'receipt'|'payout'; cashPolarity?: 1|-1; payload: Record<string, any>; }
export interface UnresolvedIntake { unposted: number; awaiting: number; quarantine: number; }
export interface BudgetSource { currency: string; policy: { id: string; revision: number; contentHash: string; limit: string } | null;
  reservations: readonly { reservationId: string; billableAttemptId: string; held: string; released: string; consumed: string; finality: string }[]; }
export interface AllocationSource { allocationId: string; policyVersion: string; sourceEventId: string; currency: string; scale: number; sourceAmount: string;
  allocatedTotal: string; residual: string; allocations: { key: string; amount: string }[]; contentHash: string; }
const metricKeys = ['expense', 'grossSales', 'netSales', 'directCosts', 'contribution', 'cashReceipts', 'cashPayouts'] as const;
const filterDimension: Record<string, string> = { repositories: 'repo', providers: 'provider', models: 'model', workflowIds: 'workflowId', jobIds: 'jobId', featureCategories: 'feature', orderIds: 'orderId', products: 'productId', channels: 'channel', workstreams: 'workstream', customerIds: 'customerId' };
export function matchesFilters(payload: Record<string, any>, query: FinancialSummaryQueryV2): boolean {
  if (query.filters.currency && payload.money.currency !== query.filters.currency) return false;
  for (const [filter, key] of Object.entries(filterDimension)) {
    const selected = (query.filters as Record<string, unknown>)[filter] as string[] | undefined;
    if (selected && !selected.includes(payload.dimensions?.[key] ?? 'unknown')) return false;
  }
  return true;
}
function eventDetail(event: SourceEvent, asOf: string): ReportingDetail {
  const p = event.payload; const raw = p.money.amount as string | null;
  const negative = raw !== null && decimal(raw) < 0n;
  const magnitude = raw === null ? null : amount(negative ? -decimal(raw) : decimal(raw));
  const classification = ({ sale: 'sale', discount: 'discount', sale_refund: 'refund', pass_through_tax: 'tax', supplier_credit: 'credit',
    supplier_expense: 'direct_cost', direct_cost: 'direct_cost', operating_expense: 'tax', payable_labor: 'tax', reimbursement: 'reimbursement',
    payout_transfer: 'payout' } as Record<string, AccountingEvent['classification']>)[p.classification];
  const economicType = event.economicAxisType ?? event.economicEventType;
  const cash = economicType === 'cash_movement';
  const supported = classification !== undefined || cash || economicType === 'fee';
  const mapped: AccountingEvent = { schemaVersion: '1.0.0', eventId: event.eventId, classification: cash ? 'cash_movement' : economicType === 'fee' ? 'fee' : classification ?? 'tax',
    amount: magnitude, currency: p.money.currency, scale: 18, recognition: p.scope.billingMode === 'live' ? 'actual' : 'simulated', evidenceMode: p.evidenceMode,
    occurredAt: p.occurredAt, source: { name: 'ci08-ledger', sourceEventId: event.eventId, revision: 0, contentHash: event.eventHash, authenticated: true },
    ...(cash ? { cashDirection: event.cashDirection ?? (p.classification === 'payout_transfer' || negative ? 'payout' : 'receipt') } : {}),
    ...(classification === 'refund' ? { links: { refundKind: 'sale' } } : {}),
  };
  const accounting = projectAccounting([mapped], { asOf });
  const cashPolarity = event.cashPolarity ?? (p.classification === 'payout_transfer' ? 1 : negative ? -1 : 1);
  const sign = cash ? (negative ? -1n : 1n) * BigInt(cashPolarity) : negative ? -1n : 1n;
  const known = raw !== null && supported;
  const isExpense = !cash && p.classification !== 'payout_transfer' && (['direct_cost','supplier_expense','operating_expense','payable_labor','supplier_credit','reimbursement'].includes(p.classification) || economicType === 'fee');
  const expenseSign = ['supplier_credit','reimbursement'].includes(p.classification) ? -1n : 1n;
  const expense = known && isExpense ? decimal(raw!) * expenseSign : 0n;
  const output = (value: string) => known ? amount(decimal(value) * sign) : '0';
  const dimensions = Object.fromEntries(REPORTING_DIMENSIONS.map(key => [key, p.dimensions?.[key] ?? null]));
  return { detailId: hash({ eventId: event.eventId, eventHash: event.eventHash }), currency: p.money.currency, eventType: economicType,
    classification: p.classification, occurredAt: p.occurredAt, valuation: p.valuation, reconciliation: p.reconciliationStatus, settlement: p.settlementStatus, dimensions,
    amount: raw, status: !supported ? 'unsupported' : raw === null ? 'unknown' : 'recognized',
    metrics: { expense: p.scope.billingMode === 'live' ? amount(expense) : '0', simulatedExpense: p.scope.billingMode === 'live' ? '0' : amount(expense), grossSales: output(accounting.grossSales), netSales: output(accounting.netSales), directCosts: output(accounting.directCosts), contribution: output(accounting.contribution),
      cashReceipts: output(accounting.cash.receipts), cashPayouts: output(accounting.cash.payouts), simulatedGrossSales: output(accounting.simulated.grossSales),
      simulatedNetSales: output(accounting.simulated.netSales), simulatedDirectCosts: output(accounting.simulated.directCosts) } };
}
function affects(detail: ReportingDetail, source: 'expense' | 'revenue' | 'cash'): boolean {
  const cash=detail.eventType === 'cash_movement' || detail.classification === 'payout_transfer';
  if (source === 'cash') return cash;
  if(cash)return false;
  if (source === 'revenue') return ['sale', 'discount', 'sale_refund'].includes(detail.classification);
  return ['direct_cost', 'supplier_expense', 'operating_expense', 'payable_labor', 'supplier_credit', 'reimbursement'].includes(detail.classification) || detail.eventType === 'fee';
}
function sourceForMetric(key: typeof metricKeys[number]): 'expense' | 'revenue' | 'cash' { return key.startsWith('cash') ? 'cash' : key === 'directCosts' || key === 'expense' ? 'expense' : 'revenue'; }
export function projectReporting(args: { query: FinancialSummaryQueryV2; asOf: string; events: readonly SourceEvent[]; lifetimeEvents: readonly SourceEvent[]; intake: UnresolvedIntake;
  budgetSources: readonly BudgetSource[]; allocations: readonly AllocationSource[]; productEvidence: ReportingProductEvidence | null }): { summary: ReportingProjection; details: ReportingDetail[] } {
  const { query, asOf, intake, productEvidence } = args;
  const events = args.events.filter(event => matchesFilters(event.payload, query));
  const details = events.map(event => eventDetail(event, asOf)).sort((a, b) => a.detailId.localeCompare(b.detailId));
  const currencies = [...new Set([...details.map(detail => detail.currency), ...args.budgetSources.map(row => row.currency), ...(query.filters.currency ? [query.filters.currency] : [])])].filter(value => !query.filters.currency || value === query.filters.currency).sort();
  const complete = (currency: string, source: 'expense' | 'revenue' | 'cash') => {
    const record = productEvidence?.sourceCoverage.find(row => row.currency === currency && row.source === source);
    const observed = details.filter(row => row.currency === currency && affects(row,source) ).length;
    return record?.status === 'complete' && record.expected !== null && record.expected === observed;
  };
  const summarizeMetrics = (rows: readonly ReportingDetail[], currency: string) => Object.fromEntries(metricKeys.map(key => {
    const relevant = rows.filter(row => row.status === 'unsupported' || (query.scope.billingMode === 'live' && (affects(row,sourceForMetric(key)) || (key === 'contribution' && affects(row,'expense')))));
    const unknown = relevant.filter(row => row.status !== 'recognized').length + (key === 'expense' || key === 'directCosts' || key === 'contribution' ? intake.unposted + intake.quarantine : 0);
    const sum = amount(rows.reduce((total, row) => total + decimal(row.metrics[key]), 0n));
    const covered = query.scope.billingMode === 'live' && complete(currency, sourceForMetric(key)) && (key !== 'contribution' || complete(currency, 'expense'));
    const known = relevant.some(row => row.status === 'recognized');
    return [key, { status: unknown > 0 || !covered ? known ? 'partial' : 'unknown' : 'known', knownSubtotal: known || covered ? sum : null,
      total: covered && unknown === 0 ? sum : null, unknownCount: unknown }];
  })) as ReportingProjection['currencies'][number]['metrics'];
  const currencyRows = currencies.map(currency => {
    const rows = details.filter(row => row.currency === currency);
    const groups = query.groupings.flatMap(dimension => [...new Set(rows.map(row => row.dimensions[dimension] ?? null))].sort((a,b) => (a ?? '').localeCompare(b ?? '')).map(value => {
      const group = rows.filter(row => row.dimensions[dimension] === value);
      return { dimension, value, bucket: value === null ? 'unknown_unallocated' as const : 'known' as const, eventCount: group.length, metrics: summarizeMetrics(group, currency) };
    }));
    const valuation = (basis: 'estimated' | 'provider_confirmed') => { const subset = rows.filter(row => row.valuation === basis && row.status === 'recognized');
      return { status: subset.length ? 'known' as const : 'unknown' as const, knownSubtotal: subset.length ? amount(subset.reduce((n,row) => n + decimal(row.metrics.expense), 0n)) : null,
        total: subset.length ? amount(subset.reduce((n,row) => n + decimal(row.metrics.expense), 0n)) : null, unknownCount: 0 }; };
    const simulatedAmount = (key: 'simulatedGrossSales' | 'simulatedNetSales' | 'simulatedDirectCosts' | 'simulatedExpense') => {
      const source = key === 'simulatedExpense' || key === 'simulatedDirectCosts' ? 'expense' : 'revenue';
      const relevant = query.scope.billingMode === 'live' ? [] : rows.filter(row => row.status === 'unsupported' || affects(row, source));
      const unknown = relevant.filter(row => row.status !== 'recognized').length + (query.scope.billingMode !== 'live' && source === 'expense' ? intake.unposted + intake.quarantine : 0);
      const known = relevant.some(row => row.status === 'recognized');
      const covered = query.scope.billingMode !== 'live' && complete(currency, source);
      const subtotal = amount(rows.reduce((n,row) => n + decimal(row.metrics[key]), 0n));
      return { status: unknown || !covered ? known ? 'partial' as const : 'unknown' as const : 'known' as const,
        knownSubtotal: known || covered ? subtotal : null, total: covered && !unknown ? subtotal : null, unknownCount: unknown };
    };
    return { currency, scale: 18 as const, metrics: summarizeMetrics(rows, currency), valuation: { estimated: valuation('estimated'), confirmed: valuation('provider_confirmed'), unknownCount: rows.filter(row => row.valuation === 'unknown').length },
      reconciliation: { matchedCount: rows.filter(row => row.reconciliation === 'matched').length, unmatchedCount: rows.filter(row => row.reconciliation === 'unmatched').length, exceptionCount: rows.filter(row => row.reconciliation === 'exception').length },
      simulated: { expense: simulatedAmount('simulatedExpense'), grossSales: simulatedAmount('simulatedGrossSales'), netSales: simulatedAmount('simulatedNetSales'), directCosts: simulatedAmount('simulatedDirectCosts') }, groups };
  });
  const budgets = args.budgetSources.filter(source => currencies.includes(source.currency)).map(source => {
    const lifetime = args.lifetimeEvents.filter(event => event.payload.money.currency === source.currency);
    const ledgerExpense = lifetime.reduce((n,event) => n + decimal(eventDetail(event, asOf).metrics.expense), 0n);
    const lifecycleConsumed = source.reservations.reduce((n,row) => n + decimal(row.consumed), 0n);
    let held = 0n; let capacityConsumed = 0n; let unknown = intake.unposted + intake.quarantine > 0;
    const capacityEvents = lifetime.filter(event => (event.economicAxisType ?? event.economicEventType) !== 'cash_movement' && ['direct_cost','supplier_expense','operating_expense','payable_labor'].includes(event.payload.classification));
    const boundAttempts = new Set(source.reservations.map(row => row.billableAttemptId));
    for (const row of source.reservations) {
      const attempt = capacityEvents.filter(event => event.payload.postingMapping.billableAttemptId.id === row.billableAttemptId);
      const ledger = attempt.reduce((n,event) => n + (event.payload.money.amount === null ? 0n : decimal(event.payload.money.amount)), 0n);
      const consumed = ledger > decimal(row.consumed) ? ledger : decimal(row.consumed);
      const outstanding = decimal(row.held) - decimal(row.released) - consumed;
      held += outstanding > 0n ? outstanding : 0n; capacityConsumed += consumed;
      if (attempt.some(event => event.payload.money.amount === null) || (decimal(row.consumed) > ledger)) unknown = true;
    }
    const unmatchedCapacity = capacityEvents.filter(event => !boundAttempts.has(event.payload.postingMapping.billableAttemptId.id)).reduce((n,event) => n + (event.payload.money.amount === null ? 0n : decimal(event.payload.money.amount)), 0n);
    capacityConsumed += unmatchedCapacity > 0n ? unmatchedCapacity : 0n;
    unknown ||= lifetime.some(event => event.payload.money.amount === null);
    const available = source.policy ? decimal(source.policy.limit) - capacityConsumed - held : null;
    return { currency: source.currency, window: 'project_lifetime' as const, policyReference: source.policy ? { id: source.policy.id, revision: source.policy.revision, contentHash: source.policy.contentHash } : null,
      limit: source.policy?.limit ?? null, ledgerExpense: amount(ledgerExpense), lifecycleConsumed: amount(lifecycleConsumed), held: amount(held), remainingAuthorizedCapacity: unknown || available === null ? null : amount(available > 0n ? available : 0n), unresolvedExposure: unknown, advisoryOnly: true as const };
  });
  const unitCosts = currencyRows.flatMap(row => (['design','workflow','order'] as const).map(kind => {
    const denominator = productEvidence?.denominators.find(item => item.kind === kind);
    const count = denominator?.status === 'complete' ? denominator.count : null;
    const numerator = row.metrics.expense.total;
    return { kind, currency: row.currency, status: count === '0' ? 'zero_denominator' as const : count !== null && numerator !== null ? 'known' as const : 'unknown' as const,
      numerator, denominator: count, approvalReference: denominator?.approvalReference ?? null, allocationPolicyVersion: ACCOUNTING_ALLOCATION_POLICY_VERSION };
  }));
  const allocations = args.allocations.filter(policy => events.some(event => event.eventId === policy.sourceEventId)).map(policy => {
    const source = events.find(event => event.eventId === policy.sourceEventId)!;
    const detail = details.find(row => row.detailId === hash({eventId: source.eventId, eventHash: source.eventHash}))!;
    if (!safeReportingReference(policy.allocationId) || policy.allocations.some(row => !safeReportingReference(row.key)) || policy.currency !== detail.currency || policy.policyVersion !== ACCOUNTING_ALLOCATION_POLICY_VERSION || detail.amount === null || decimal(detail.amount) !== decimal(policy.sourceAmount)
      || decimal(policy.allocatedTotal) + decimal(policy.residual) !== decimal(policy.sourceAmount)
      || policy.allocations.reduce((n,row) => n + decimal(row.amount), 0n) !== decimal(policy.allocatedTotal)
      || policy.allocations.some(row => decimal(row.amount) < 0n) || decimal(policy.residual) < 0n) throw new Error('Allocation does not conserve source');
    return { sourceDetailId: detail.detailId, policyReference: { id: policy.allocationId, revision: 1, contentHash: policy.contentHash }, currency: policy.currency,
      sourceAmount: policy.sourceAmount, allocatedTotal: policy.allocatedTotal, residual: policy.residual, allocations: policy.allocations };
  });
  const missingSources = ['expense','revenue','cash'].filter(source => !currencies.length || currencies.some(currency => !complete(currency, source as 'expense' | 'revenue' | 'cash')));
  if (!productEvidence) missingSources.push('approved_product_denominators');
  const unknownAmountCount = details.filter(row => row.amount === null).length;
  const unsupportedEventCount = details.filter(row => row.status === 'unsupported').length;
  const expectedRows = productEvidence?.sourceCoverage.map(row => row.expected) ?? [];
  const expected = expectedRows.length && expectedRows.every(value => value !== null) ? expectedRows.reduce<number>((n,value) => n + (value ?? 0), 0) : null;
  if(expected !== null && expected !== details.length)missingSources.push('source_count_mismatch');
  return { details, summary: { policyVersion: REPORTING_POLICY_VERSION, accountingPolicyVersion: ACCOUNTING_POLICY_VERSION, definitionsStatus: ACCOUNTING_DEFINITIONS_STATUS,
    currencies: currencyRows, coverage: { status: missingSources.length || unknownAmountCount || unsupportedEventCount || intake.unposted || intake.quarantine ? details.length ? 'partial' : 'unknown' : 'complete', observed: details.length, expected,
      unknownAmountCount, unpostedAttemptCount: intake.unposted, awaitingEvidenceAttemptCount: intake.awaiting, quarantinedObservationCount: intake.quarantine, unsupportedEventCount, missingSources }, budgets, unitCosts, allocations } };
}
