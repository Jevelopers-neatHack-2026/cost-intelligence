-- CI-05B settle reservations safely across crashes and unknown provider outcomes.
--
-- Additive lifecycle/outbox extensions on top of the CI-05A append-only budget
-- surfaces. Nothing in 0001-0008 is edited or renumbered, and this migration
-- performs no destructive operation: it only ADDs nullable columns, new indexes,
-- a new append-only table, and refreshes the health view. Every existing row
-- keeps its meaning. The new reconciliation surface carries the identical CI-09
-- security posture (distinct non-login owner, forced row-level security scoped
-- to the authority-bound transaction, restricted runtime limited to append/read).
--
-- Three concerns are addressed:
--
--   1. Separate financial expiry from the worker lease. `expires_at` is the
--      financial expiry of a hold (authoritative budget state); the worker
--      lease (`worker_lease_id`, `worker_lease_expires_at`) is the harness's
--      operational lease. A lease lapse is NOT a financial release: only an
--      authoritative `expired` event frees a never-dispatched, fenced hold. An
--      in-flight hold whose provider outcome is unknown is a dispatched hold
--      surfaced through the reconciliation queue, never a released one.
--
--   2. A partial unique index makes the first lifecycle event's
--      `billable_attempt_id` unique per partition, so two authorizations can
--      never bind the same billable attempt to two different holds. The
--      violation surfaces as a typed idempotency conflict at the application
--      boundary, never masked as "unavailable".
--
--   3. A bounded, rerunnable recovery scan ages unresolved holds into this
--      append-only reconciliation/exception queue with owner, next action and
--      evidence. Releases happen only on verified no-bill (expired) or confirmed
--      expense (settled) evidence; actual over-cap cost is recorded in full.

-- 1. Separate financial expiry and worker lease. Both are nullable and additive;
-- a held reservation with a null financial expiry simply never auto-expires.
ALTER TABLE cost_intelligence.budget_reservation_events
  ADD COLUMN expires_at timestamptz,
  ADD COLUMN worker_lease_id text,
  ADD COLUMN worker_lease_expires_at timestamptz;

-- 2. One authorization per billable attempt per partition. The first event of a
-- reservation (its authorization) owns the billable attempt id exclusively;
-- later lifecycle events carry the same id at higher sequences and are excluded.
CREATE UNIQUE INDEX budget_reservation_events_billable_attempt_unique
  ON cost_intelligence.budget_reservation_events
     (tenant_id, project_id, environment, billing_mode, billable_attempt_id)
  WHERE event_sequence = 1;

-- A dispatched/unknown hold, and a financially-expired one, are found cheaply by
-- the bounded recovery scan.
CREATE INDEX budget_reservation_events_recovery_scan
  ON cost_intelligence.budget_reservation_events
     (tenant_id, project_id, environment, billing_mode, currency, recorded_at);

-- 3. Append-only reconciliation / exception queue. A recovery scan inserts an
-- `open` row per unresolved reservation; a reconciliation resolution inserts a
-- `resolved` row for the same reservation. The latest row per reservation is the
-- current disposition. Append-only: no UPDATE/DELETE/TRUNCATE of financial state.
CREATE TABLE cost_intelligence.budget_reconciliation_exceptions (
  exception_id text PRIMARY KEY,
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  environment text NOT NULL,
  billing_mode text NOT NULL,
  currency char(3) NOT NULL,
  reservation_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('open', 'resolved')),
  category text NOT NULL,
  severity text NOT NULL DEFAULT 'review' CHECK (severity IN ('review', 'variance', 'blocking')),
  owner_role text NOT NULL,
  next_action text NOT NULL,
  evidence jsonb NOT NULL,
  hold_amount numeric NOT NULL DEFAULT 0 CHECK (hold_amount >= 0),
  consumed_amount numeric NOT NULL DEFAULT 0 CHECK (consumed_amount >= 0),
  outstanding_amount numeric NOT NULL DEFAULT 0 CHECK (outstanding_amount >= 0),
  reservation_state text NOT NULL,
  scan_id text,
  resolution text,
  resolution_disposition text CHECK (resolution_disposition IS NULL OR resolution_disposition IN (
    'verified_no_bill_released', 'confirmed_expense_settled', 'over_cap_variance_recorded', 'held_for_reconciliation'
  )),
  actor_reference text NOT NULL,
  content_hash char(71) NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);

-- At most one open exception per reservation at a time, so a bounded recovery
-- scan is rerunnable: a second pass over the same unresolved hold is a no-op.
CREATE UNIQUE INDEX budget_reconciliation_exceptions_one_open
  ON cost_intelligence.budget_reconciliation_exceptions
     (tenant_id, project_id, environment, billing_mode, reservation_id)
  WHERE status = 'open';

CREATE INDEX budget_reconciliation_exceptions_queue
  ON cost_intelligence.budget_reconciliation_exceptions
     (tenant_id, project_id, environment, billing_mode, reservation_id, recorded_at DESC);

CREATE TRIGGER budget_reconciliation_exceptions_append_only
  BEFORE UPDATE OR DELETE ON cost_intelligence.budget_reconciliation_exceptions
  FOR EACH ROW EXECUTE FUNCTION cost_intelligence.reject_ledger_projection_mutation();
CREATE TRIGGER budget_reconciliation_exceptions_no_truncate
  BEFORE TRUNCATE ON cost_intelligence.budget_reconciliation_exceptions
  FOR EACH STATEMENT EXECUTE FUNCTION cost_intelligence.reject_ledger_projection_mutation();

ALTER TABLE cost_intelligence.budget_reconciliation_exceptions OWNER TO ci_finance_owner;
REVOKE ALL ON cost_intelligence.budget_reconciliation_exceptions FROM PUBLIC;
GRANT SELECT, INSERT ON cost_intelligence.budget_reconciliation_exceptions TO ci_finance_runtime;

CREATE POLICY budget_reconciliation_exceptions_rls_policy ON cost_intelligence.budget_reconciliation_exceptions
  FOR ALL TO ci_finance_runtime
  USING (cost_intelligence.finance_scope_matches(tenant_id, project_id, environment, billing_mode))
  WITH CHECK (cost_intelligence.finance_scope_matches(tenant_id, project_id, environment, billing_mode));

ALTER TABLE cost_intelligence.budget_reconciliation_exceptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE cost_intelligence.budget_reconciliation_exceptions FORCE ROW LEVEL SECURITY;

-- Extend the foundation health gate to require this additive migration.
CREATE OR REPLACE VIEW cost_intelligence.foundation_health AS
WITH required(version) AS (
  VALUES
    ('0001_foundation'), ('0002_foundation_health'), ('0003_financial_ledger'),
    ('0004_pricing_catalog'), ('0005_pricing_valuation_history'), ('0006_finance_security_roles'),
    ('0007_accounting_projection_snapshots'), ('0008_budget_reservations'),
    ('0009_usage_intake'), ('0010_budget_reservation_settlement')
)
SELECT bool_and(m.version IS NOT NULL) AS migrations_ready,
       count(m.version)::integer AS required_migrations_present,
       max(m.applied_at) AS checked_at
FROM required r
LEFT JOIN cost_intelligence.schema_migrations m ON m.version = r.version;

GRANT SELECT ON cost_intelligence.foundation_health TO ci_finance_runtime;
