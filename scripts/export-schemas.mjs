import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as api from '../dist/index.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const version = '1.0.0';
const combinedValidators = Object.freeze({
  UsageObservationSchema: 'validateUsageObservationBoundary',
  EstimateRequestSchema: 'validateEstimateRequestBoundary',
  ReservationRequestSchema: 'validateReservationRequestBoundary',
  SettleReservationCommandSchema: 'validateSettleReservationCommandBoundary',
  ReleaseReservationCommandSchema: 'validateReleaseReservationCommandBoundary',
  ReservationCommandSchema: 'validateReservationCommandBoundary',
  ReservationSnapshotSchema: 'validateReservationSnapshotBoundary',
  FinancialSummaryPageSchema: 'validateFinancialSummaryPageBoundary',
  ExportRequestSchema: 'validateExportRequestBoundary',
});
const entries = [
  ['shared', 'ErrorEnvelopeSchema'], ['shared', 'TrustedScopeSchema'],
  ['metering', 'UsageObservationSchema'], ['metering', 'IngestionReceiptSchema'],
  ['pricing', 'RateCardSchema'], ['pricing', 'EstimateRequestSchema'], ['pricing', 'EstimateResultSchema'],
  ['budgets', 'ReservationRequestSchema'], ['budgets', 'AuthorizationDecisionSchema'],
  ['budgets', 'MarkDispatchedCommandSchema'], ['budgets', 'SettleReservationCommandSchema'],
  ['budgets', 'ReleaseReservationCommandSchema'], ['budgets', 'ReservationCommandSchema'],
  ['budgets', 'ReservationSnapshotSchema'], ['budgets', 'BudgetChangeRequestSchema'],
  ['budgets', 'BudgetChangeReceiptSchema'], ['budgets', 'ExpenseAdjustmentRequestSchema'], ['budgets', 'PostingReceiptSchema'],
  ['ledger', 'FinancialEventSchema'], ['reporting', 'FinancialSummaryFiltersSchema'], ['reporting', 'FinancialSummaryQuerySchema'],
  ['reporting', 'SummarySourceWatermarkSchema'], ['reporting', 'FinancialSummaryPageSchema'],
  ['reconciliation', 'ReconciliationRequestSchema'], ['reconciliation', 'ReconciliationRunSchema'], ['reconciliation', 'ReconciliationResultSchema'],
  ['integrations', 'ExportRequestSchema'], ['integrations', 'ExportManifestSchema'],
].map(([module, name]) => ({ module, name, schema: api[name] }));

const outputs = [];
for (const entry of entries) {
  if (!entry.schema || typeof entry.schema !== 'object') throw new Error(`Missing schema export: ${entry.module}.${entry.name}`);
  const combinedValidator = combinedValidators[entry.name];
  const completeness = combinedValidator ? 'partial_wrapper_requires_combined_validation' : 'complete';
  const schema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `https://schemas.jevelopers.org/cost-intelligence/${entry.module}/${entry.name}/${version}`,
    'x-schema-completeness': completeness,
    ...(combinedValidator ? { 'x-combined-validator': combinedValidator } : {}),
    ...entry.schema,
  };
  const relative = `schemas/cost-intelligence/${version}/${entry.module}/${entry.name}.json`;
  const absolute = join(root, relative);
  const bytes = `${JSON.stringify(schema, null, 2)}\n`;
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, bytes);
  outputs.push({ module: entry.module, name: entry.name, path: relative, completeness, ...(combinedValidator ? { combined_validator: combinedValidator } : {}), sha256: createHash('sha256').update(bytes).digest('hex') });
}

const contractLock = JSON.parse(await readFile(join(root, 'contracts.lock.json'), 'utf8'));
const manifest = {
  schema_version: version,
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
