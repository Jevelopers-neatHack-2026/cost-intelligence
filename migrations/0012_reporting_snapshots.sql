-- CI-08 read projection. No balance, hold, posting, intake, or core-health changes.
CREATE TABLE cost_intelligence.reporting_snapshots (
  snapshot_id text PRIMARY KEY CHECK (snapshot_id ~ '^sha256:[a-f0-9]{64}$'),
  tenant_id text NOT NULL, project_id text NOT NULL,
  environment text NOT NULL CHECK (environment IN ('development','test','production')),
  billing_mode text NOT NULL CHECK (billing_mode IN ('live','sandbox','simulated')),
  query_content_hash text NOT NULL CHECK (query_content_hash ~ '^sha256:[a-f0-9]{64}$'),
  as_of timestamptz NOT NULL,
  snapshot_content jsonb NOT NULL CHECK (jsonb_typeof(snapshot_content) = 'object'),
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reporting_snapshots_scope_lookup ON cost_intelligence.reporting_snapshots
  (tenant_id,project_id,environment,billing_mode,snapshot_id);
CREATE TRIGGER reporting_snapshots_append_only BEFORE UPDATE OR DELETE ON cost_intelligence.reporting_snapshots
  FOR EACH ROW EXECUTE FUNCTION cost_intelligence.reject_ledger_projection_mutation();
CREATE TRIGGER reporting_snapshots_no_truncate BEFORE TRUNCATE ON cost_intelligence.reporting_snapshots
  FOR EACH STATEMENT EXECUTE FUNCTION cost_intelligence.reject_ledger_projection_mutation();
ALTER TABLE cost_intelligence.reporting_snapshots OWNER TO ci_finance_owner;
REVOKE ALL ON cost_intelligence.reporting_snapshots FROM PUBLIC;
GRANT SELECT, INSERT ON cost_intelligence.reporting_snapshots TO ci_finance_runtime;
CREATE POLICY reporting_snapshots_scope_policy ON cost_intelligence.reporting_snapshots
  FOR ALL TO ci_finance_runtime
  USING (cost_intelligence.finance_scope_matches(tenant_id,project_id,environment,billing_mode)
    AND NOT EXISTS (SELECT 1 FROM cost_intelligence.financial_privacy_quarantine q
      WHERE q.tenant_id=reporting_snapshots.tenant_id AND q.project_id=reporting_snapshots.project_id
        AND q.environment=reporting_snapshots.environment AND q.billing_mode=reporting_snapshots.billing_mode))
  WITH CHECK (cost_intelligence.finance_scope_matches(tenant_id,project_id,environment,billing_mode)
    AND NOT EXISTS (SELECT 1 FROM cost_intelligence.financial_privacy_quarantine q
      WHERE q.tenant_id=reporting_snapshots.tenant_id AND q.project_id=reporting_snapshots.project_id
        AND q.environment=reporting_snapshots.environment AND q.billing_mode=reporting_snapshots.billing_mode));
ALTER TABLE cost_intelligence.reporting_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE cost_intelligence.reporting_snapshots FORCE ROW LEVEL SECURITY;
-- Dedicated feature capability; core foundation_health remains unchanged at 0010.
CREATE VIEW cost_intelligence.reporting_health AS
  SELECT EXISTS (SELECT 1 FROM cost_intelligence.schema_migrations WHERE version='0012_reporting_snapshots') AS migrations_ready;
REVOKE ALL ON cost_intelligence.reporting_health FROM PUBLIC;
GRANT SELECT ON cost_intelligence.reporting_health TO ci_finance_runtime;
