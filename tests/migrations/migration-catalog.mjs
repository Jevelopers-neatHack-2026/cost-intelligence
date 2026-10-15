// Feature migrations remain separate from the eleven-migration Finance core capability.
export const FINANCE_CORE_MIGRATIONS = Object.freeze([
  '0001_foundation.sql', '0002_foundation_health.sql', '0003_financial_ledger.sql',
  '0004_pricing_catalog.sql', '0005_pricing_valuation_history.sql',
  '0006_finance_security_roles.sql', '0007_accounting_projection_snapshots.sql',
  '0008_budget_reservations.sql', '0009_usage_intake.sql', '0010_budget_authority_bindings.sql',
  '0011_budget_settlement_reconciliation.sql',
]);
export const EXPECTED_MIGRATIONS = Object.freeze([...FINANCE_CORE_MIGRATIONS, '0012_reporting_snapshots.sql', '0013_reconciliation_coverage_runs.sql', '0014_evidence_reader_indexes.sql', '0015_stored_lineage_reader.sql']);
