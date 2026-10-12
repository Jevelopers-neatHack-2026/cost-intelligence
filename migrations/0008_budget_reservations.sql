-- CI-05A atomic project budget reservations and bounded authorization.
--
-- Additive, append-only persistence for the authoritative project budget.
-- Two surfaces are introduced, both prefixed `budget_` so they are scoped
-- independently of the CI-02/CI-09 `financial_%`, CI-03 `pricing_%`, and
-- CI-06 `accounting_%` surfaces, and both reuse the CI-09 security
-- primitives (ci_finance_owner, ci_finance_runtime, finance_scope_matches,
-- reject_ledger_projection_mutation) without editing any prior migration:
--
--   * budget_scope_policies      -- versioned, append-only budget limit per
--                                   (tenant, project, environment, billing
--                                   mode, currency) partition. A new limit is
--                                   a new revision; existing reservations are
--                                   never reinterpreted by a later version.
--   * budget_reservation_events  -- append-only lifecycle log (authorized /
--                                   partially_authorized / dispatched /
--                                   settled / released / expired). Capacity is
--                                   a projection over this log, never a mutable
--                                   counter, so a rebuild equals the enforced
--                                   number. A unique idempotency binding makes
--                                   a retry reuse its single existing hold.
--
-- The restricted runtime role may only SELECT and INSERT (append-only); it can
-- never UPDATE, DELETE, or TRUNCATE financial state. Row-level security is
-- forced and scoped to the authority-bound transaction settings. No destructive
-- operation touches financial state, and budget authority is not product
-- checkout or purchase authority.

CREATE TABLE cost_intelligence.budget_scope_policies (
  policy_version_id text PRIMARY KEY,
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  environment text NOT NULL,
  billing_mode text NOT NULL,
  currency char(3) NOT NULL,
  policy_revision integer NOT NULL CHECK (policy_revision >= 1),
  limit_amount numeric NOT NULL CHECK (limit_amount >= 0),
  alert_threshold_percent integer NOT NULL DEFAULT 80 CHECK (alert_threshold_percent >= 0 AND alert_threshold_percent <= 100),
  decision_policy_version text NOT NULL,
  idempotency_key text NOT NULL,
  actor_reference text NOT NULL,
  reason_reference text NOT NULL,
  source_authority_ref jsonb NOT NULL,
  supersedes_policy_version_id text,
  content_hash char(71) NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  -- One monotonic revision chain per partition, and one row per idempotent change.
  CONSTRAINT budget_scope_policies_partition_revision_unique
    UNIQUE (tenant_id, project_id, environment, billing_mode, currency, policy_revision),
  CONSTRAINT budget_scope_policies_idempotency_unique
    UNIQUE (tenant_id, project_id, environment, billing_mode, idempotency_key)
);

CREATE INDEX budget_scope_policies_partition_current
  ON cost_intelligence.budget_scope_policies (tenant_id, project_id, environment, billing_mode, currency, policy_revision DESC);

CREATE TRIGGER budget_scope_policies_append_only
  BEFORE UPDATE OR DELETE ON cost_intelligence.budget_scope_policies
  FOR EACH ROW EXECUTE FUNCTION cost_intelligence.reject_ledger_projection_mutation();
CREATE TRIGGER budget_scope_policies_no_truncate
  BEFORE TRUNCATE ON cost_intelligence.budget_scope_policies
  FOR EACH STATEMENT EXECUTE FUNCTION cost_intelligence.reject_ledger_projection_mutation();

CREATE TABLE cost_intelligence.budget_reservation_events (
  reservation_event_id text PRIMARY KEY,
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  environment text NOT NULL,
  billing_mode text NOT NULL,
  currency char(3) NOT NULL,
  reservation_id text NOT NULL,
  event_sequence integer NOT NULL CHECK (event_sequence >= 1),
  event_type text NOT NULL CHECK (event_type IN (
    'authorized', 'partially_authorized', 'dispatched', 'settled', 'released', 'expired'
  )),
  decision_status text CHECK (decision_status IS NULL OR decision_status IN ('authorized', 'partial')),
  held_amount numeric NOT NULL DEFAULT 0 CHECK (held_amount >= 0),
  consumed_amount numeric NOT NULL DEFAULT 0 CHECK (consumed_amount >= 0),
  released_amount numeric NOT NULL DEFAULT 0 CHECK (released_amount >= 0),
  estimate_completeness text CHECK (estimate_completeness IS NULL OR estimate_completeness IN ('unknown', 'incomplete', 'complete')),
  known_subtotal numeric CHECK (known_subtotal IS NULL OR known_subtotal >= 0),
  bounded_maximum numeric CHECK (bounded_maximum IS NULL OR bounded_maximum >= 0),
  allow_partial boolean NOT NULL DEFAULT false,
  partial_allowed_amount numeric CHECK (partial_allowed_amount IS NULL OR partial_allowed_amount >= 0),
  usage_finality text NOT NULL DEFAULT 'unknown' CHECK (usage_finality IN ('unknown', 'partial', 'final')),
  settlement_sequence integer CHECK (settlement_sequence IS NULL OR settlement_sequence >= 1),
  policy_version_id text NOT NULL,
  rate_card_ref jsonb,
  policy_ref jsonb NOT NULL,
  idempotency_key text NOT NULL,
  expected_revision integer CHECK (expected_revision IS NULL OR expected_revision >= 0),
  actor_reference text NOT NULL,
  source_authority_ref jsonb NOT NULL,
  attempt_binding jsonb NOT NULL,
  logical_operation_id text NOT NULL,
  billable_attempt_id text NOT NULL,
  content_hash char(71) NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  -- A retry of any operation reuses its single idempotency key per partition,
  -- so authorization never creates a second hold.
  CONSTRAINT budget_reservation_events_idempotency_unique
    UNIQUE (tenant_id, project_id, environment, billing_mode, idempotency_key),
  -- Each reservation has one monotonic lifecycle sequence.
  CONSTRAINT budget_reservation_events_sequence_unique
    UNIQUE (tenant_id, project_id, environment, billing_mode, reservation_id, event_sequence)
);

CREATE INDEX budget_reservation_events_partition_capacity
  ON cost_intelligence.budget_reservation_events (tenant_id, project_id, environment, billing_mode, currency, reservation_id, event_sequence);

CREATE TRIGGER budget_reservation_events_append_only
  BEFORE UPDATE OR DELETE ON cost_intelligence.budget_reservation_events
  FOR EACH ROW EXECUTE FUNCTION cost_intelligence.reject_ledger_projection_mutation();
CREATE TRIGGER budget_reservation_events_no_truncate
  BEFORE TRUNCATE ON cost_intelligence.budget_reservation_events
  FOR EACH STATEMENT EXECUTE FUNCTION cost_intelligence.reject_ledger_projection_mutation();

-- Match the CI-09 security posture: distinct non-login owner, no PUBLIC access,
-- scoped append/read only for the restricted runtime role, forced row-level security.
ALTER TABLE cost_intelligence.budget_scope_policies OWNER TO ci_finance_owner;
ALTER TABLE cost_intelligence.budget_reservation_events OWNER TO ci_finance_owner;

REVOKE ALL ON cost_intelligence.budget_scope_policies FROM PUBLIC;
REVOKE ALL ON cost_intelligence.budget_reservation_events FROM PUBLIC;
GRANT SELECT, INSERT ON cost_intelligence.budget_scope_policies TO ci_finance_runtime;
GRANT SELECT, INSERT ON cost_intelligence.budget_reservation_events TO ci_finance_runtime;

CREATE POLICY budget_scope_policies_rls_policy ON cost_intelligence.budget_scope_policies
  FOR ALL TO ci_finance_runtime
  USING (cost_intelligence.finance_scope_matches(tenant_id, project_id, environment, billing_mode))
  WITH CHECK (cost_intelligence.finance_scope_matches(tenant_id, project_id, environment, billing_mode));
CREATE POLICY budget_reservation_events_rls_policy ON cost_intelligence.budget_reservation_events
  FOR ALL TO ci_finance_runtime
  USING (cost_intelligence.finance_scope_matches(tenant_id, project_id, environment, billing_mode))
  WITH CHECK (cost_intelligence.finance_scope_matches(tenant_id, project_id, environment, billing_mode));

ALTER TABLE cost_intelligence.budget_scope_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE cost_intelligence.budget_scope_policies FORCE ROW LEVEL SECURITY;
ALTER TABLE cost_intelligence.budget_reservation_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE cost_intelligence.budget_reservation_events FORCE ROW LEVEL SECURITY;

-- Extend the foundation health gate to require this additive budget migration.
-- CREATE OR REPLACE preserves the view's existing grants; the explicit re-grant
-- keeps the restricted runtime's read access unambiguous.
CREATE OR REPLACE VIEW cost_intelligence.foundation_health AS
WITH required(version) AS (
  VALUES
    ('0001_foundation'), ('0002_foundation_health'), ('0003_financial_ledger'),
    ('0004_pricing_catalog'), ('0005_pricing_valuation_history'), ('0006_finance_security_roles'),
    ('0007_accounting_projection_snapshots'), ('0008_budget_reservations')
)
SELECT bool_and(m.version IS NOT NULL) AS migrations_ready,
       count(m.version)::integer AS required_migrations_present,
       max(m.applied_at) AS checked_at
FROM required r
LEFT JOIN cost_intelligence.schema_migrations m ON m.version = r.version;

GRANT SELECT ON cost_intelligence.foundation_health TO ci_finance_runtime;
