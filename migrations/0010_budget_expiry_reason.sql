-- CI-05B remediation: persist the reason an expiry/revocation event was recorded.
--
-- Additive, non-destructive extension on top of 0009. It only ADDs one nullable
-- column and refreshes the foundation health view. Nothing in 0001-0009 is edited
-- or renumbered, and no DROP/TRUNCATE/destructive operation touches financial
-- state. Every existing row keeps its meaning (the column is NULL for events that
-- predate it and for every non-expiry event).
--
-- Review defect (e): expireReservation previously recorded event_type='expired'
-- for BOTH a matured financial expiry and an operator revocation, so the two
-- causes were indistinguishable in the durable log. This column records which
-- authoritative cause produced the expiry event, keeping them auditable and
-- distinct without changing the event_type vocabulary.
ALTER TABLE cost_intelligence.budget_reservation_events
  ADD COLUMN expiry_reason text
    CHECK (expiry_reason IS NULL OR expiry_reason IN ('financial_expiry', 'operator_revocation'));

-- Extend the foundation health gate to require this additive migration.
CREATE OR REPLACE VIEW cost_intelligence.foundation_health AS
WITH required(version) AS (
  VALUES
    ('0001_foundation'), ('0002_foundation_health'), ('0003_financial_ledger'),
    ('0004_pricing_catalog'), ('0005_pricing_valuation_history'), ('0006_finance_security_roles'),
    ('0007_accounting_projection_snapshots'), ('0008_budget_reservations'),
    ('0009_budget_reservation_settlement'), ('0010_budget_expiry_reason')
)
SELECT bool_and(m.version IS NOT NULL) AS migrations_ready,
       count(m.version)::integer AS required_migrations_present,
       max(m.applied_at) AS checked_at
FROM required r
LEFT JOIN cost_intelligence.schema_migrations m ON m.version = r.version;

GRANT SELECT ON cost_intelligence.foundation_health TO ci_finance_runtime;
