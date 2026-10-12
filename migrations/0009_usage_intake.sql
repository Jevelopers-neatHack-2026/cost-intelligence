CREATE TABLE cost_intelligence.usage_intake_inbox (
  tenant_id text NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 128),
  project_id text NOT NULL CHECK (length(project_id) BETWEEN 1 AND 128),
  environment text NOT NULL CHECK (environment IN ('development', 'test', 'production')),
  billing_mode text NOT NULL CHECK (billing_mode IN ('live', 'sandbox', 'simulated')),
  source_observation_id text NOT NULL CHECK (length(source_observation_id) BETWEEN 1 AND 256),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  request_id text NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
  event_id text NOT NULL CHECK (length(event_id) BETWEEN 1 AND 256),
  logical_operation_id text NOT NULL CHECK (length(logical_operation_id) BETWEEN 1 AND 256),
  provider_attempt_id text NOT NULL CHECK (length(provider_attempt_id) BETWEEN 1 AND 256),
  billable_attempt_id text NOT NULL CHECK (length(billable_attempt_id) BETWEEN 1 AND 256),
  transport_attempt_id text NOT NULL CHECK (length(transport_attempt_id) BETWEEN 1 AND 256),
  provider_request_id text CHECK (provider_request_id IS NULL OR length(provider_request_id) BETWEEN 1 AND 256),
  source_name text NOT NULL CHECK (source_name IN ('provider_response', 'provider_usage_api', 'trace', 'billing_export', 'other')),
  occurred_at timestamptz NOT NULL,
  observed_at timestamptz NOT NULL,
  completeness text NOT NULL CHECK (completeness IN ('unknown', 'incomplete', 'complete')),
  valuation_basis text NOT NULL CHECK (valuation_basis IN ('unknown', 'estimated', 'provider_confirmed')),
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^sha256:[a-f0-9]{64}$'),
  idempotency_sha256 text NOT NULL CHECK (idempotency_sha256 ~ '^sha256:[a-f0-9]{64}$'),
  provenance_sha256 text NOT NULL CHECK (provenance_sha256 ~ '^sha256:[a-f0-9]{64}$'),
  event_facts jsonb NOT NULL CHECK (jsonb_typeof(event_facts) = 'object'),
  attempt_revision_accepted boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, project_id, environment, billing_mode, source_observation_id),
  UNIQUE (tenant_id, project_id, environment, billing_mode, idempotency_key)
);

CREATE INDEX usage_intake_inbox_attempt_idx
  ON cost_intelligence.usage_intake_inbox
    (tenant_id, project_id, environment, billing_mode, billable_attempt_id, observed_at);

CREATE TABLE cost_intelligence.usage_intake_attempts (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  environment text NOT NULL CHECK (environment IN ('development', 'test', 'production')),
  billing_mode text NOT NULL CHECK (billing_mode IN ('live', 'sandbox', 'simulated')),
  billable_attempt_id text NOT NULL CHECK (length(billable_attempt_id) BETWEEN 1 AND 256),
  logical_operation_id text NOT NULL CHECK (length(logical_operation_id) BETWEEN 1 AND 256),
  provider_attempt_id text NOT NULL CHECK (length(provider_attempt_id) BETWEEN 1 AND 256),
  first_observation_id text NOT NULL,
  current_observation_id text NOT NULL,
  current_ledger_event_id text REFERENCES cost_intelligence.financial_ledger_events(event_id) ON DELETE RESTRICT,
  revision_sequence integer NOT NULL DEFAULT 0 CHECK (revision_sequence >= 0),
  status text NOT NULL CHECK (status IN ('awaiting_evidence', 'pending', 'posted', 'retry', 'dead_letter')),
  completeness text NOT NULL CHECK (completeness IN ('unknown', 'incomplete', 'complete')),
  valuation_basis text NOT NULL CHECK (valuation_basis IN ('unknown', 'estimated', 'provider_confirmed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, project_id, environment, billing_mode, billable_attempt_id),
  FOREIGN KEY (tenant_id, project_id, environment, billing_mode, first_observation_id)
    REFERENCES cost_intelligence.usage_intake_inbox(tenant_id, project_id, environment, billing_mode, source_observation_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, project_id, environment, billing_mode, current_observation_id)
    REFERENCES cost_intelligence.usage_intake_inbox(tenant_id, project_id, environment, billing_mode, source_observation_id) ON DELETE RESTRICT
);

CREATE TABLE cost_intelligence.usage_intake_outbox (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  environment text NOT NULL CHECK (environment IN ('development', 'test', 'production')),
  billing_mode text NOT NULL CHECK (billing_mode IN ('live', 'sandbox', 'simulated')),
  source_observation_id text NOT NULL,
  billable_attempt_id text NOT NULL CHECK (length(billable_attempt_id) BETWEEN 1 AND 256),
  posting_payload jsonb CHECK (posting_payload IS NULL OR jsonb_typeof(posting_payload) = 'object'),
  status text NOT NULL CHECK (status IN ('awaiting_evidence', 'pending', 'retry', 'posted', 'duplicate', 'suppressed', 'dead_letter')),
  retry_count smallint NOT NULL DEFAULT 0 CHECK (retry_count BETWEEN 0 AND 5),
  available_at timestamptz NOT NULL DEFAULT now(),
  last_error_code text CHECK (last_error_code IS NULL OR last_error_code IN ('source_unavailable', 'ledger_conflict', 'outbox_expired')),
  ledger_event_id text REFERENCES cost_intelligence.financial_ledger_events(event_id) ON DELETE RESTRICT,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, project_id, environment, billing_mode, source_observation_id),
  FOREIGN KEY (tenant_id, project_id, environment, billing_mode, source_observation_id)
    REFERENCES cost_intelligence.usage_intake_inbox(tenant_id, project_id, environment, billing_mode, source_observation_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, project_id, environment, billing_mode, billable_attempt_id)
    REFERENCES cost_intelligence.usage_intake_attempts(tenant_id, project_id, environment, billing_mode, billable_attempt_id) ON DELETE RESTRICT,
  CHECK ((status = 'posted' AND ledger_event_id IS NOT NULL AND completed_at IS NOT NULL)
      OR (status <> 'posted' AND completed_at IS NULL))
);

CREATE INDEX usage_intake_outbox_retry_idx
  ON cost_intelligence.usage_intake_outbox (tenant_id, project_id, environment, billing_mode, available_at)
  WHERE status IN ('pending', 'retry');

CREATE TABLE cost_intelligence.usage_intake_quarantine (
  diagnostic_ref text PRIMARY KEY CHECK (diagnostic_ref ~ '^ci04aq:[a-f0-9]{64}$'),
  tenant_id text NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 128),
  project_id text NOT NULL CHECK (length(project_id) BETWEEN 1 AND 128),
  environment text NOT NULL CHECK (environment IN ('development', 'test', 'production')),
  billing_mode text NOT NULL CHECK (billing_mode IN ('live', 'sandbox', 'simulated')),
  reason_code text NOT NULL CHECK (reason_code IN ('unsupported_version', 'invalid_usage_event', 'unsafe_metadata')),
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^sha256:[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, project_id, environment, billing_mode, reason_code, payload_sha256)
);

ALTER TABLE cost_intelligence.financial_projection_quantities
  ADD COLUMN included_in text;
ALTER TABLE cost_intelligence.financial_projection_quantities
  DROP CONSTRAINT financial_projection_quantities_key;
ALTER TABLE cost_intelligence.financial_projection_quantities
  ADD CONSTRAINT financial_projection_quantities_key UNIQUE NULLS NOT DISTINCT
    (snapshot_id, event_type, classification, currency, unit_name, relation, included_in);

ALTER TABLE cost_intelligence.financial_projection_snapshots
  ADD COLUMN unknown_economic_exposure_count integer NOT NULL DEFAULT 0 CHECK (unknown_economic_exposure_count >= 0),
  ADD COLUMN quarantined_observation_count integer NOT NULL DEFAULT 0 CHECK (quarantined_observation_count >= 0),
  ADD COLUMN awaiting_evidence_attempt_count integer NOT NULL DEFAULT 0 CHECK (awaiting_evidence_attempt_count >= 0),
  ADD COLUMN unposted_attempt_count integer NOT NULL DEFAULT 0 CHECK (unposted_attempt_count >= 0);

CREATE FUNCTION cost_intelligence.reject_usage_intake_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'usage intake audit rows are append-only' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER usage_intake_inbox_append_only
  BEFORE UPDATE OR DELETE ON cost_intelligence.usage_intake_inbox
  FOR EACH ROW EXECUTE FUNCTION cost_intelligence.reject_usage_intake_audit_mutation();
CREATE TRIGGER usage_intake_inbox_no_truncate
  BEFORE TRUNCATE ON cost_intelligence.usage_intake_inbox
  FOR EACH STATEMENT EXECUTE FUNCTION cost_intelligence.reject_usage_intake_audit_mutation();
CREATE TRIGGER usage_intake_quarantine_append_only
  BEFORE UPDATE OR DELETE ON cost_intelligence.usage_intake_quarantine
  FOR EACH ROW EXECUTE FUNCTION cost_intelligence.reject_usage_intake_audit_mutation();
CREATE TRIGGER usage_intake_quarantine_no_truncate
  BEFORE TRUNCATE ON cost_intelligence.usage_intake_quarantine
  FOR EACH STATEMENT EXECUTE FUNCTION cost_intelligence.reject_usage_intake_audit_mutation();

CREATE FUNCTION cost_intelligence.guard_usage_intake_attempt_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'usage attempt coverage cannot be deleted' USING ERRCODE = '55000';
  END IF;
  IF ROW(NEW.tenant_id, NEW.project_id, NEW.environment, NEW.billing_mode, NEW.billable_attempt_id,
         NEW.logical_operation_id, NEW.provider_attempt_id, NEW.first_observation_id, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.tenant_id, OLD.project_id, OLD.environment, OLD.billing_mode, OLD.billable_attempt_id,
         OLD.logical_operation_id, OLD.provider_attempt_id, OLD.first_observation_id, OLD.created_at) THEN
    RAISE EXCEPTION 'usage attempt identity coverage is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER usage_intake_attempt_identity_immutable
  BEFORE UPDATE OR DELETE ON cost_intelligence.usage_intake_attempts
  FOR EACH ROW EXECUTE FUNCTION cost_intelligence.guard_usage_intake_attempt_update();

CREATE FUNCTION cost_intelligence.guard_usage_intake_outbox_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'usage posting outbox rows cannot be deleted' USING ERRCODE = '55000';
  END IF;
  IF ROW(NEW.tenant_id, NEW.project_id, NEW.environment, NEW.billing_mode, NEW.source_observation_id,
         NEW.billable_attempt_id, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.tenant_id, OLD.project_id, OLD.environment, OLD.billing_mode, OLD.source_observation_id,
         OLD.billable_attempt_id, OLD.created_at)
     OR NOT (OLD.posting_payload IS NULL OR NEW.posting_payload IS NOT DISTINCT FROM OLD.posting_payload) THEN
    RAISE EXCEPTION 'usage posting outbox intent is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER usage_intake_outbox_intent_immutable
  BEFORE UPDATE OR DELETE ON cost_intelligence.usage_intake_outbox
  FOR EACH ROW EXECUTE FUNCTION cost_intelligence.guard_usage_intake_outbox_update();

ALTER TABLE cost_intelligence.usage_intake_inbox OWNER TO ci_finance_owner;
ALTER TABLE cost_intelligence.usage_intake_attempts OWNER TO ci_finance_owner;
ALTER TABLE cost_intelligence.usage_intake_outbox OWNER TO ci_finance_owner;
ALTER TABLE cost_intelligence.usage_intake_quarantine OWNER TO ci_finance_owner;
ALTER FUNCTION cost_intelligence.reject_usage_intake_audit_mutation() OWNER TO ci_finance_owner;
ALTER FUNCTION cost_intelligence.guard_usage_intake_attempt_update() OWNER TO ci_finance_owner;
ALTER FUNCTION cost_intelligence.guard_usage_intake_outbox_update() OWNER TO ci_finance_owner;

GRANT SELECT, INSERT ON cost_intelligence.usage_intake_inbox TO ci_finance_runtime;
GRANT SELECT, INSERT ON cost_intelligence.usage_intake_attempts TO ci_finance_runtime;
GRANT UPDATE (current_observation_id, current_ledger_event_id, revision_sequence, status, completeness, valuation_basis, updated_at)
  ON cost_intelligence.usage_intake_attempts TO ci_finance_runtime;
GRANT SELECT, INSERT ON cost_intelligence.usage_intake_outbox TO ci_finance_runtime;
GRANT UPDATE (posting_payload, status, retry_count, available_at, last_error_code, ledger_event_id, completed_at)
  ON cost_intelligence.usage_intake_outbox TO ci_finance_runtime;
GRANT SELECT, INSERT ON cost_intelligence.usage_intake_quarantine TO ci_finance_runtime;

CREATE POLICY usage_intake_inbox_scope_policy ON cost_intelligence.usage_intake_inbox
  FOR ALL TO ci_finance_runtime
  USING (cost_intelligence.finance_scope_matches(tenant_id, project_id, environment, billing_mode)
    AND NOT EXISTS (SELECT 1 FROM cost_intelligence.financial_privacy_quarantine quarantine
      WHERE quarantine.tenant_id = usage_intake_inbox.tenant_id AND quarantine.project_id = usage_intake_inbox.project_id
        AND quarantine.environment = usage_intake_inbox.environment AND quarantine.billing_mode = usage_intake_inbox.billing_mode))
  WITH CHECK (cost_intelligence.finance_scope_matches(tenant_id, project_id, environment, billing_mode)
    AND NOT EXISTS (SELECT 1 FROM cost_intelligence.financial_privacy_quarantine quarantine
      WHERE quarantine.tenant_id = usage_intake_inbox.tenant_id AND quarantine.project_id = usage_intake_inbox.project_id
        AND quarantine.environment = usage_intake_inbox.environment AND quarantine.billing_mode = usage_intake_inbox.billing_mode));
CREATE POLICY usage_intake_attempts_scope_policy ON cost_intelligence.usage_intake_attempts
  FOR ALL TO ci_finance_runtime
  USING (cost_intelligence.finance_scope_matches(tenant_id, project_id, environment, billing_mode)
    AND NOT EXISTS (SELECT 1 FROM cost_intelligence.financial_privacy_quarantine quarantine
      WHERE quarantine.tenant_id = usage_intake_attempts.tenant_id AND quarantine.project_id = usage_intake_attempts.project_id
        AND quarantine.environment = usage_intake_attempts.environment AND quarantine.billing_mode = usage_intake_attempts.billing_mode))
  WITH CHECK (cost_intelligence.finance_scope_matches(tenant_id, project_id, environment, billing_mode)
    AND NOT EXISTS (SELECT 1 FROM cost_intelligence.financial_privacy_quarantine quarantine
      WHERE quarantine.tenant_id = usage_intake_attempts.tenant_id AND quarantine.project_id = usage_intake_attempts.project_id
        AND quarantine.environment = usage_intake_attempts.environment AND quarantine.billing_mode = usage_intake_attempts.billing_mode));
CREATE POLICY usage_intake_outbox_scope_policy ON cost_intelligence.usage_intake_outbox
  FOR ALL TO ci_finance_runtime
  USING (cost_intelligence.finance_scope_matches(tenant_id, project_id, environment, billing_mode)
    AND NOT EXISTS (SELECT 1 FROM cost_intelligence.financial_privacy_quarantine quarantine
      WHERE quarantine.tenant_id = usage_intake_outbox.tenant_id AND quarantine.project_id = usage_intake_outbox.project_id
        AND quarantine.environment = usage_intake_outbox.environment AND quarantine.billing_mode = usage_intake_outbox.billing_mode))
  WITH CHECK (cost_intelligence.finance_scope_matches(tenant_id, project_id, environment, billing_mode)
    AND NOT EXISTS (SELECT 1 FROM cost_intelligence.financial_privacy_quarantine quarantine
      WHERE quarantine.tenant_id = usage_intake_outbox.tenant_id AND quarantine.project_id = usage_intake_outbox.project_id
        AND quarantine.environment = usage_intake_outbox.environment AND quarantine.billing_mode = usage_intake_outbox.billing_mode));
CREATE POLICY usage_intake_quarantine_scope_policy ON cost_intelligence.usage_intake_quarantine
  FOR ALL TO ci_finance_runtime
  USING (cost_intelligence.finance_scope_matches(tenant_id, project_id, environment, billing_mode))
  WITH CHECK (cost_intelligence.finance_scope_matches(tenant_id, project_id, environment, billing_mode));

ALTER TABLE cost_intelligence.usage_intake_inbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE cost_intelligence.usage_intake_inbox FORCE ROW LEVEL SECURITY;
ALTER TABLE cost_intelligence.usage_intake_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE cost_intelligence.usage_intake_attempts FORCE ROW LEVEL SECURITY;
ALTER TABLE cost_intelligence.usage_intake_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE cost_intelligence.usage_intake_outbox FORCE ROW LEVEL SECURITY;
ALTER TABLE cost_intelligence.usage_intake_quarantine ENABLE ROW LEVEL SECURITY;
ALTER TABLE cost_intelligence.usage_intake_quarantine FORCE ROW LEVEL SECURITY;

CREATE OR REPLACE VIEW cost_intelligence.foundation_health AS
WITH required(version) AS (
  VALUES ('0001_foundation'), ('0002_foundation_health'), ('0003_financial_ledger'),
    ('0004_pricing_catalog'), ('0005_pricing_valuation_history'),
    ('0006_finance_security_roles'), ('0007_accounting_projection_snapshots'),
    ('0008_budget_reservations'), ('0009_usage_intake')
)
SELECT bool_and(m.version IS NOT NULL) AS migrations_ready,
       count(m.version)::integer AS required_migrations_present,
       max(m.applied_at) AS checked_at
FROM required r
LEFT JOIN cost_intelligence.schema_migrations m ON m.version = r.version;
