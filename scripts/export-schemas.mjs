import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as api from '../dist/index.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const version = '1.0.0';
const pricingV2Version = '2.0.0';
const combinedValidators = Object.freeze({
  UsageObservationSchema: 'validateUsageObservationBoundary',
  EstimateRequestSchema: 'validateEstimateRequestBoundary',
  EstimateRequestV2Schema: 'validateEstimateRequestV2Boundary',
  RegisterPricingRuleRequestV2Schema: 'validatePricingRuleV2Boundary',
  RegisterRateCardRequestV2Schema: 'validateRateCardV2Boundary',
  RegisterFxRateRequestV2Schema: 'validateFxRateV2Boundary',
  ReservationRequestSchema: 'validateReservationRequestBoundary',
  SettleReservationCommandSchema: 'validateSettleReservationCommandBoundary',
  ReleaseReservationCommandSchema: 'validateReleaseReservationCommandBoundary',
  ReservationCommandSchema: 'validateReservationCommandBoundary',
  ReservationSnapshotSchema: 'validateReservationSnapshotBoundary',
  FinancialSummaryPageSchema: 'validateFinancialSummaryPageBoundary',
  FinancialSummaryPageV2Schema: 'validateFinancialSummaryPageV2Boundary',
  LedgerAppendRequestSchema: 'validateLedgerAppendRequestBoundary',
  LedgerProjectionRequestSchema: 'validateLedgerProjectionRequestBoundary',
  ExportRequestSchema: 'validateExportRequestBoundary',
  ReportingExportRequestSchema: 'validateReportingExportRequestBoundary',
});
const entries = [
  ['shared', 'ErrorEnvelopeSchema'], ['shared', 'TrustedScopeSchema'],
  ['metering', 'UsageObservationSchema'], ['metering', 'IngestionReceiptSchema'],
  ['metering', 'UsageOutboxReplayRequestSchema'], ['metering', 'UsageOutboxReplayReceiptSchema'],
  ['pricing', 'RateCardSchema'], ['pricing', 'EstimateRequestSchema'], ['pricing', 'EstimateResultSchema'],
  ['budgets', 'ReservationAuthorityBindingSchema'], ['budgets', 'ReservationWorkPlanSchema'], ['budgets', 'FinanceReservationAuthoritySchema'], ['budgets', 'CurrentReservationRequestSchema'], ['budgets', 'PartialAcknowledgementRequestSchema'], ['budgets', 'ReservationRequestSchema'], ['budgets', 'AuthorizationDecisionSchema'],
  ['budgets', 'MarkDispatchedCommandSchema'], ['budgets', 'SettleReservationCommandSchema'],
  ['budgets', 'ReleaseReservationCommandSchema'], ['budgets', 'ReservationCommandSchema'],
  ['budgets', 'ReservationSnapshotSchema'], ['budgets', 'BudgetChangeRequestSchema'],
  ['budgets', 'BudgetChangeReceiptSchema'], ['budgets', 'ExpenseAdjustmentRequestSchema'], ['budgets', 'PostingReceiptSchema'],
  ['ledger', 'FinancialEventSchema'], ['ledger', 'LedgerEventTypeSchema'], ['ledger', 'LedgerClassificationSchema'],
  ['ledger', 'LedgerAppendRequestSchema'], ['ledger', 'LedgerAppendReceiptSchema'], ['ledger', 'LedgerProjectionRequestSchema'],
  ['ledger', 'LedgerProjectionSchema'], ['reporting', 'FinancialSummaryFiltersSchema'], ['reporting', 'FinancialSummaryQuerySchema'],
  ['reporting', 'ReportingMetricDefinitionSchema'], ['reporting', 'ReportingPolicyDefinitionSchema'], ['reporting', 'ReportingSnapshotReadRequestSchema'], ['reporting', 'SummarySourceWatermarkSchema'], ['reporting', 'FinancialSummaryPageSchema'],
  ['reconciliation', 'ReconciliationRequestSchema'], ['reconciliation', 'ReconciliationRunSchema'], ['reconciliation', 'ReconciliationResultSchema'],
  ['integrations', 'ExportRequestSchema'], ['integrations', 'ExportManifestSchema'],
].map(([module, name]) => ({ module, name, exportName: name, schema: api[name], version }));

const pricingV2Names = [
  ['RateCardSchema', 'RateCardV2Schema'], ['PricingRuleSchema', 'PricingRuleV2Schema'],
  ['FxRateSchema', 'FxRateV2Schema'], ['RegisterPricingRuleRequestSchema', 'RegisterPricingRuleRequestV2Schema'],
  ['RegisterRateCardRequestSchema', 'RegisterRateCardRequestV2Schema'], ['RegisterFxRateRequestSchema', 'RegisterFxRateRequestV2Schema'],
  ['CatalogWriteReceiptSchema', 'CatalogWriteReceiptV2Schema'], ['EstimateRequestSchema', 'EstimateRequestV2Schema'],
  ['EstimateResultSchema', 'EstimateResultV2Schema'], ['EstimateStatusSchema', 'EstimateStatusV2Schema'],
  ['ExactRatioSchema', 'ExactRatioV2Schema'], ['VersionedReferenceSchema', 'VersionedReferenceV2Schema'],
  ['SourceReferenceSchema', 'SourceReferenceSchema'], ['PricingPartitionGroupSchema', 'PricingPartitionGroupSchema'],
].map(([name, exportName]) => ({ module: 'pricing', name, exportName, schema: api[exportName], version: pricingV2Version }));
entries.push(...pricingV2Names);
for (const name of ['ReportingExportRequestSchema', 'ReportingExportManifestSchema', 'ReportingExportReceiptSchema']) {
  entries.push({ module: 'integrations', name, exportName: name, schema: api[name], version: '2.0.0' });
}
for (const exportName of ['FinancialSummaryFiltersV2Schema', 'FinancialSummaryQueryV2Schema', 'ReportingDimensionSchema', 'ReportingAmountSchema', 'ReportingDetailSchema', 'ReportingCurrencySummarySchema', 'ReportingProductEvidenceSchema', 'ReportingProjectionSchema', 'FinancialSummaryPageV2Schema']) {
  entries.push({ module: 'reporting', name: exportName.replace('V2Schema', 'Schema'), exportName, schema: api[exportName], version: '2.0.0' });
}

const outputs = [];
for (const entry of entries) {
  if (!entry.schema || typeof entry.schema !== 'object') throw new Error(`Missing schema export: ${entry.module}.${entry.name}`);
  const combinedValidator = combinedValidators[entry.exportName];
  const completeness = combinedValidator ? 'partial_wrapper_requires_combined_validation' : 'complete';
  const schema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `https://schemas.jevelopers.org/cost-intelligence/${entry.module}/${entry.name}/${entry.version}`,
    'x-schema-completeness': completeness,
    ...(combinedValidator ? { 'x-combined-validator': combinedValidator } : {}),
    ...entry.schema,
  };
  const relative = `schemas/cost-intelligence/${entry.version}/${entry.module}/${entry.name}.json`;
  const absolute = join(root, relative);
  const bytes = `${JSON.stringify(schema, null, 2)}\n`;
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, bytes);
  outputs.push({ module: entry.module, name: entry.name, schema_version: entry.version, export_name: entry.exportName, path: relative, completeness, ...(combinedValidator ? { combined_validator: combinedValidator } : {}), sha256: createHash('sha256').update(bytes).digest('hex') });
}

const contractLock = JSON.parse(await readFile(join(root, 'contracts.lock.json'), 'utf8'));
const manifest = {
  schema_version: version,
  schema_versions: { pricing: [version, pricingV2Version], reporting: [version, '2.0.0'], integrations: [version, '2.0.0'] },
  package: '@jevelopers/cost-intelligence',
  shared_contracts: {
    package: contractLock.producer.package,
    source_revision: contractLock.producer.head,
    package_archive_sha256: contractLock.producer.archive_sha256,
    adoption_status: contractLock.status,
    accepted: contractLock.adoption_accepted,
    blocking_findings: contractLock.blocking_findings,
  },
  schemas: outputs,
};
const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`;
await mkdir(join(root, 'docs/api'), { recursive: true });
await writeFile(join(root, 'docs/api/schema-index.json'), manifestBytes);
console.log(`exported ${outputs.length} finance-owned schemas; shared contract adoption=${contractLock.status}`);
