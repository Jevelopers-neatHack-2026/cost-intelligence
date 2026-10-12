import { Type } from '@sinclair/typebox';
import { ACCOUNTING_POLICY_VERSION, ACCOUNTING_DEFINITIONS_STATUS, ACCOUNTING_ALLOCATION_POLICY_VERSION, ACCOUNTING_SIGN_MATRIX } from '../accounting/index.js';
import { REPORTING_POLICY_VERSION } from './schema-v2.js';
import { hash } from './projection.js';
function immutable<T>(value: T): T {
  const copy = structuredClone(value);
  const freeze = (item: unknown): void => { if (item && typeof item === 'object') { for (const child of Object.values(item)) freeze(child); Object.freeze(item); } };
  freeze(copy); return copy;
}
export const REPORTING_METRIC_DICTIONARY = immutable({
  expense: { formula: 'actual direct, supplier, operating and payable-labor expense plus fees, less supplier credits and reimbursements; excludes simulation, tax, financing and cash movements', source: 'expense' },
  gross_sales: { formula: 'recognized actual sale magnitudes before discount and refund, excluding tax', source: 'revenue' },
  net_sales: { formula: 'gross_sales - actual discounts - actual sale refunds', source: 'revenue' },
  direct_costs: { formula: 'actual attributed AI and supplier direct expense plus fees, less supplier credits and reimbursements; excludes separately classified operating expense and payable labor', source: 'expense' },
  contribution: { formula: 'net_sales - direct_costs', source: 'revenue_and_expense' },
  cash_receipts: { formula: 'observed actual cash-movement receipts, separate from recognized sales', source: 'cash' },
  cash_payouts: { formula: 'observed actual cash-movement payouts and payout transfers, never new sales or expense', source: 'cash' },
});
export const REPORTING_DEFINITION_POLICY = immutable({ reportingPolicyVersion: REPORTING_POLICY_VERSION, accountingPolicyVersion: ACCOUNTING_POLICY_VERSION,
  allocationPolicyVersion: ACCOUNTING_ALLOCATION_POLICY_VERSION, definitionsStatus: ACCOUNTING_DEFINITIONS_STATUS, signMatrix: ACCOUNTING_SIGN_MATRIX,
  recognition: 'live billing is actual even in test; sandbox and simulated billing remains separate simulation',
  currency: 'no cross-currency addition or unsourced conversion', period: 'economic root occurredAt in [start,end); ingestedAt and successors <= asOf',
  coverage: 'missing source is unknown; complete-zero requires scoped pinned evidence with expected zero observations',
  denominator: 'exact numerator/count ratio; current source-approved complete approval snapshot required; zero denominator is distinct from unknown',
  allocation: 'analytical only; source expense posted once; allocatedTotal plus residual equals source amount' });
export const REPORTING_DEFINITION_POLICY_HASH = hash(REPORTING_DEFINITION_POLICY);

export function financeOwnedDefinitionId(content: unknown): string {
  const bytes=hash(content).slice(7,39).split('');bytes[12]='4';bytes[16]='8';const hex=bytes.join('');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
export const ReportingMetricDefinitionSchema = Type.Object({
  contract: Type.Literal('cost-intelligence.reporting.metric-definition'), schemaVersion: Type.Literal('1.0.0'),
  definitionId: Type.String({pattern:'^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-8[a-f0-9]{3}-[a-f0-9]{12}$'}), revision: Type.Literal(1), policyVersion: Type.Literal(ACCOUNTING_POLICY_VERSION),
  metric: Type.Union(Object.keys(REPORTING_METRIC_DICTIONARY).map(name=>Type.Literal(name))), definitionsStatus: Type.Literal(ACCOUNTING_DEFINITIONS_STATUS),
  formula: Type.String({minLength:1,maxLength:1000}), source: Type.Union([Type.Literal('expense'),Type.Literal('revenue'),Type.Literal('cash'),Type.Literal('revenue_and_expense')]),
}, {additionalProperties:false});
export const ReportingPolicyDefinitionSchema = Type.Object({
  contract: Type.Literal('cost-intelligence.reporting.policy-definition'), schemaVersion: Type.Literal('1.0.0'),
  definitionId: Type.String({pattern:'^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-8[a-f0-9]{3}-[a-f0-9]{12}$'}), revision: Type.Literal(1),
  reportingPolicyVersion: Type.Literal(REPORTING_POLICY_VERSION), accountingPolicyVersion: Type.Literal(ACCOUNTING_POLICY_VERSION), allocationPolicyVersion: Type.Literal(ACCOUNTING_ALLOCATION_POLICY_VERSION),
  definitionsStatus: Type.Literal(ACCOUNTING_DEFINITIONS_STATUS), signMatrix: Type.Record(Type.String(),Type.Object({grossSalesSign:Type.Integer({minimum:-1,maximum:1}),netSalesSign:Type.Integer({minimum:-1,maximum:1}),directCostsSign:Type.Integer({minimum:-1,maximum:1}),cash:Type.Union([Type.Literal('none'),Type.Literal('receipt'),Type.Literal('payout'),Type.Literal('directional')]),recovery:Type.Boolean(),note:Type.String()}, {additionalProperties:false})),
  recognition:Type.String(),currency:Type.String(),period:Type.String(),coverage:Type.String(),denominator:Type.String(),allocation:Type.String(),
}, {additionalProperties:false});
export const REPORTING_CANONICAL_REFERENCE_REGISTRY = immutable({
  metrics: Object.fromEntries(Object.entries(REPORTING_METRIC_DICTIONARY).map(([name,body])=>{
    const definitionBody={policyVersion:ACCOUNTING_POLICY_VERSION,metric:name,definitionsStatus:ACCOUNTING_DEFINITIONS_STATUS,...body};
    const definition={contract:'cost-intelligence.reporting.metric-definition',schemaVersion:'1.0.0',definitionId:financeOwnedDefinitionId({namespace:'cost-intelligence/metric-definition/1',...definitionBody}),revision:1,...definitionBody};
    return [name,{definition,reference:{contract:definition.contract,schema_version:'1.0.0',id:definition.definitionId,revision:1,content_hash:hash(definition)}}];
  })),
  policy:(()=>{const definition={contract:'cost-intelligence.reporting.policy-definition',schemaVersion:'1.0.0',definitionId:financeOwnedDefinitionId({namespace:'cost-intelligence/reporting-policy/1',...REPORTING_DEFINITION_POLICY}),revision:1,...REPORTING_DEFINITION_POLICY};return {definition,reference:{contract:definition.contract,schema_version:'1.0.0',id:definition.definitionId,revision:1,content_hash:hash(definition)}};})(),
});
