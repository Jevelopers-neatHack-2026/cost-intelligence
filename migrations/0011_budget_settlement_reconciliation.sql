-- CI05B: immutable settlement provenance and durable reconciliation.
-- Only these exact enum constraints are replaced. Existing rows are validated.
ALTER TABLE cost_intelligence.financial_ledger_events DROP CONSTRAINT financial_ledger_events_valuation_check;
ALTER TABLE cost_intelligence.financial_ledger_events ADD CONSTRAINT financial_ledger_events_valuation_check CHECK (valuation IN ('unknown', 'estimated', 'provider_confirmed', 'provider_reported_unsettled'));
ALTER TABLE cost_intelligence.usage_intake_inbox DROP CONSTRAINT usage_intake_inbox_valuation_basis_check;
ALTER TABLE cost_intelligence.usage_intake_inbox ADD CONSTRAINT usage_intake_inbox_valuation_basis_check CHECK (valuation_basis IN ('unknown', 'estimated', 'provider_confirmed', 'provider_reported_unsettled'));
ALTER TABLE cost_intelligence.usage_intake_attempts DROP CONSTRAINT usage_intake_attempts_valuation_basis_check;
ALTER TABLE cost_intelligence.usage_intake_attempts ADD CONSTRAINT usage_intake_attempts_valuation_basis_check CHECK (valuation_basis IN ('unknown', 'estimated', 'provider_confirmed', 'provider_reported_unsettled'));

CREATE TABLE cost_intelligence.budget_source_observations (observation_id text PRIMARY KEY, tenant_id text NOT NULL, project_id text NOT NULL, environment text NOT NULL, billing_mode text NOT NULL,
 record_id text NOT NULL, record_revision integer NOT NULL CHECK(record_revision>=1), record_hash char(71) NOT NULL,
 predecessor_hash char(71), source_bytes_hash char(71) NOT NULL, source_reference jsonb NOT NULL,
 collector_record jsonb NOT NULL, current_evidence jsonb NOT NULL, authentication_evidence jsonb NOT NULL, original_source_bytes text NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,project_id,environment,billing_mode,record_id,record_revision));
ALTER TABLE cost_intelligence.budget_source_observations OWNER TO ci_finance_owner;
REVOKE ALL ON cost_intelligence.budget_source_observations FROM PUBLIC;
GRANT SELECT, INSERT ON cost_intelligence.budget_source_observations TO ci_finance_runtime;
CREATE TRIGGER budget_source_observations_append_only BEFORE UPDATE OR DELETE ON cost_intelligence.budget_source_observations
 FOR EACH ROW EXECUTE FUNCTION cost_intelligence.reject_ledger_projection_mutation();
CREATE TRIGGER budget_source_observations_no_truncate BEFORE TRUNCATE ON cost_intelligence.budget_source_observations
 FOR EACH STATEMENT EXECUTE FUNCTION cost_intelligence.reject_ledger_projection_mutation();
CREATE POLICY budget_source_observations_rls ON cost_intelligence.budget_source_observations FOR ALL TO ci_finance_runtime
 USING(cost_intelligence.finance_scope_matches(tenant_id,project_id,environment,billing_mode))
 WITH CHECK(cost_intelligence.finance_scope_matches(tenant_id,project_id,environment,billing_mode));
ALTER TABLE cost_intelligence.budget_source_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE cost_intelligence.budget_source_observations FORCE ROW LEVEL SECURITY;

CREATE TABLE cost_intelligence.budget_lifecycle_observations (observation_id text PRIMARY KEY, tenant_id text NOT NULL, project_id text NOT NULL, environment text NOT NULL, billing_mode text NOT NULL, currency char(3) NOT NULL,
 reservation_id text NOT NULL, event_sequence integer NOT NULL CHECK(event_sequence>=2),
 expected_revision integer NOT NULL CHECK(expected_revision>=1), idempotency_key text NOT NULL,
 event_type text NOT NULL CHECK(event_type IN ('outcome_unknown','expense_corrected','held_for_reconciliation')),
 consumed_amount numeric NOT NULL CHECK(consumed_amount>=0), released_amount numeric NOT NULL CHECK(released_amount>=0),
 usage_finality text NOT NULL CHECK(usage_finality IN ('unknown','partial','final')),
 actor_reference text NOT NULL, source_authority_ref jsonb NOT NULL, attempt_binding jsonb NOT NULL,
 command_request jsonb NOT NULL, command_evidence jsonb NOT NULL, content_hash char(71) NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,project_id,environment,billing_mode,reservation_id,event_sequence),
 UNIQUE(tenant_id,project_id,environment,billing_mode,idempotency_key));
ALTER TABLE cost_intelligence.budget_lifecycle_observations OWNER TO ci_finance_owner;
REVOKE ALL ON cost_intelligence.budget_lifecycle_observations FROM PUBLIC;
GRANT SELECT, INSERT ON cost_intelligence.budget_lifecycle_observations TO ci_finance_runtime;
CREATE TRIGGER budget_lifecycle_observations_append_only BEFORE UPDATE OR DELETE ON cost_intelligence.budget_lifecycle_observations
 FOR EACH ROW EXECUTE FUNCTION cost_intelligence.reject_ledger_projection_mutation();
CREATE TRIGGER budget_lifecycle_observations_no_truncate BEFORE TRUNCATE ON cost_intelligence.budget_lifecycle_observations
 FOR EACH STATEMENT EXECUTE FUNCTION cost_intelligence.reject_ledger_projection_mutation();
CREATE POLICY budget_lifecycle_observations_rls ON cost_intelligence.budget_lifecycle_observations FOR ALL TO ci_finance_runtime
 USING(cost_intelligence.finance_scope_matches(tenant_id,project_id,environment,billing_mode))
 WITH CHECK(cost_intelligence.finance_scope_matches(tenant_id,project_id,environment,billing_mode));
ALTER TABLE cost_intelligence.budget_lifecycle_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE cost_intelligence.budget_lifecycle_observations FORCE ROW LEVEL SECURITY;

CREATE TABLE cost_intelligence.budget_command_receipts (receipt_id text PRIMARY KEY, tenant_id text NOT NULL, project_id text NOT NULL, environment text NOT NULL, billing_mode text NOT NULL, idempotency_key text NOT NULL,
 reservation_id text NOT NULL, command_request jsonb NOT NULL, command_receipt jsonb NOT NULL,
 command_evidence jsonb NOT NULL, content_hash char(71) NOT NULL, recorded_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,project_id,environment,billing_mode,idempotency_key));
ALTER TABLE cost_intelligence.budget_command_receipts OWNER TO ci_finance_owner;
REVOKE ALL ON cost_intelligence.budget_command_receipts FROM PUBLIC;
GRANT SELECT, INSERT ON cost_intelligence.budget_command_receipts TO ci_finance_runtime;
CREATE TRIGGER budget_command_receipts_append_only BEFORE UPDATE OR DELETE ON cost_intelligence.budget_command_receipts
 FOR EACH ROW EXECUTE FUNCTION cost_intelligence.reject_ledger_projection_mutation();
CREATE TRIGGER budget_command_receipts_no_truncate BEFORE TRUNCATE ON cost_intelligence.budget_command_receipts
 FOR EACH STATEMENT EXECUTE FUNCTION cost_intelligence.reject_ledger_projection_mutation();
CREATE POLICY budget_command_receipts_rls ON cost_intelligence.budget_command_receipts FOR ALL TO ci_finance_runtime
 USING(cost_intelligence.finance_scope_matches(tenant_id,project_id,environment,billing_mode))
 WITH CHECK(cost_intelligence.finance_scope_matches(tenant_id,project_id,environment,billing_mode));
ALTER TABLE cost_intelligence.budget_command_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE cost_intelligence.budget_command_receipts FORCE ROW LEVEL SECURITY;

CREATE TABLE cost_intelligence.budget_settlement_postings (posting_id text PRIMARY KEY, tenant_id text NOT NULL, project_id text NOT NULL, environment text NOT NULL, billing_mode text NOT NULL, currency char(3) NOT NULL,
 reservation_id text NOT NULL, reservation_revision integer NOT NULL CHECK(reservation_revision>=1),
 observation_id text NOT NULL REFERENCES cost_intelligence.budget_source_observations(observation_id),
 ledger_event_id text NOT NULL REFERENCES cost_intelligence.financial_ledger_events(event_id),
 amount_semantics text NOT NULL CHECK(amount_semantics IN ('cumulative_attempt_total','distinct_charge')),
 cumulative_amount numeric NOT NULL CHECK(cumulative_amount>=0),
 intake_observation_ids jsonb NOT NULL CHECK(jsonb_typeof(intake_observation_ids)='array'),
 recorded_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,project_id,environment,billing_mode,reservation_id,reservation_revision));
ALTER TABLE cost_intelligence.budget_settlement_postings OWNER TO ci_finance_owner;
REVOKE ALL ON cost_intelligence.budget_settlement_postings FROM PUBLIC;
GRANT SELECT, INSERT ON cost_intelligence.budget_settlement_postings TO ci_finance_runtime;
CREATE TRIGGER budget_settlement_postings_append_only BEFORE UPDATE OR DELETE ON cost_intelligence.budget_settlement_postings
 FOR EACH ROW EXECUTE FUNCTION cost_intelligence.reject_ledger_projection_mutation();
CREATE TRIGGER budget_settlement_postings_no_truncate BEFORE TRUNCATE ON cost_intelligence.budget_settlement_postings
 FOR EACH STATEMENT EXECUTE FUNCTION cost_intelligence.reject_ledger_projection_mutation();
CREATE POLICY budget_settlement_postings_rls ON cost_intelligence.budget_settlement_postings FOR ALL TO ci_finance_runtime
 USING(cost_intelligence.finance_scope_matches(tenant_id,project_id,environment,billing_mode))
 WITH CHECK(cost_intelligence.finance_scope_matches(tenant_id,project_id,environment,billing_mode));
ALTER TABLE cost_intelligence.budget_settlement_postings ENABLE ROW LEVEL SECURITY;
ALTER TABLE cost_intelligence.budget_settlement_postings FORCE ROW LEVEL SECURITY;

CREATE TABLE cost_intelligence.budget_reconciliation_exceptions (exception_revision_id text PRIMARY KEY, tenant_id text NOT NULL, project_id text NOT NULL, environment text NOT NULL, billing_mode text NOT NULL, currency char(3) NOT NULL,
 exception_id text NOT NULL, revision integer NOT NULL CHECK(revision>=1), reservation_id text NOT NULL,
 reservation_revision integer NOT NULL CHECK(reservation_revision>=1), idempotency_key text NOT NULL,
 state text NOT NULL CHECK(state IN ('unresolved','held_for_reconciliation','resolved','reopened')),
 reason text NOT NULL CHECK(reason IN ('outcome_unknown','expired_unresolved','over_cap','unallocated_aggregate','evidence_conflict')),
 owner_reference text NOT NULL, action_reference text NOT NULL, evidence_reference jsonb,
 command_request jsonb NOT NULL, variance_amount numeric NOT NULL CHECK(variance_amount>=0),
 content_hash char(71) NOT NULL, recorded_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,project_id,environment,billing_mode,exception_id,revision),
 UNIQUE(tenant_id,project_id,environment,billing_mode,exception_id,idempotency_key));
ALTER TABLE cost_intelligence.budget_reconciliation_exceptions OWNER TO ci_finance_owner;
REVOKE ALL ON cost_intelligence.budget_reconciliation_exceptions FROM PUBLIC;
GRANT SELECT, INSERT ON cost_intelligence.budget_reconciliation_exceptions TO ci_finance_runtime;
CREATE TRIGGER budget_reconciliation_exceptions_append_only BEFORE UPDATE OR DELETE ON cost_intelligence.budget_reconciliation_exceptions
 FOR EACH ROW EXECUTE FUNCTION cost_intelligence.reject_ledger_projection_mutation();
CREATE TRIGGER budget_reconciliation_exceptions_no_truncate BEFORE TRUNCATE ON cost_intelligence.budget_reconciliation_exceptions
 FOR EACH STATEMENT EXECUTE FUNCTION cost_intelligence.reject_ledger_projection_mutation();
CREATE POLICY budget_reconciliation_exceptions_rls ON cost_intelligence.budget_reconciliation_exceptions FOR ALL TO ci_finance_runtime
 USING(cost_intelligence.finance_scope_matches(tenant_id,project_id,environment,billing_mode))
 WITH CHECK(cost_intelligence.finance_scope_matches(tenant_id,project_id,environment,billing_mode));
ALTER TABLE cost_intelligence.budget_reconciliation_exceptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE cost_intelligence.budget_reconciliation_exceptions FORCE ROW LEVEL SECURITY;

CREATE TABLE cost_intelligence.budget_recovery_cursors (cursor_id text PRIMARY KEY, tenant_id text NOT NULL, project_id text NOT NULL, environment text NOT NULL, billing_mode text NOT NULL, currency char(3) NOT NULL,
 job_reference text NOT NULL, revision integer NOT NULL CHECK(revision>=1),
 after_recorded_at timestamptz, after_reservation_id text, completed_cycle boolean NOT NULL,
 command_request jsonb NOT NULL,command_receipt jsonb NOT NULL,idempotency_key text NOT NULL,recorded_at timestamptz NOT NULL DEFAULT now(),
 CHECK((after_recorded_at IS NULL)=(after_reservation_id IS NULL)),
 UNIQUE(tenant_id,project_id,environment,billing_mode,currency,job_reference,revision),
 UNIQUE(tenant_id,project_id,environment,billing_mode,idempotency_key));
ALTER TABLE cost_intelligence.budget_recovery_cursors OWNER TO ci_finance_owner;
REVOKE ALL ON cost_intelligence.budget_recovery_cursors FROM PUBLIC;
GRANT SELECT, INSERT ON cost_intelligence.budget_recovery_cursors TO ci_finance_runtime;
CREATE TRIGGER budget_recovery_cursors_append_only BEFORE UPDATE OR DELETE ON cost_intelligence.budget_recovery_cursors
 FOR EACH ROW EXECUTE FUNCTION cost_intelligence.reject_ledger_projection_mutation();
CREATE TRIGGER budget_recovery_cursors_no_truncate BEFORE TRUNCATE ON cost_intelligence.budget_recovery_cursors
 FOR EACH STATEMENT EXECUTE FUNCTION cost_intelligence.reject_ledger_projection_mutation();
CREATE POLICY budget_recovery_cursors_rls ON cost_intelligence.budget_recovery_cursors FOR ALL TO ci_finance_runtime
 USING(cost_intelligence.finance_scope_matches(tenant_id,project_id,environment,billing_mode))
 WITH CHECK(cost_intelligence.finance_scope_matches(tenant_id,project_id,environment,billing_mode));
ALTER TABLE cost_intelligence.budget_recovery_cursors ENABLE ROW LEVEL SECURITY;
ALTER TABLE cost_intelligence.budget_recovery_cursors FORCE ROW LEVEL SECURITY;

CREATE TABLE cost_intelligence.budget_reported_observations (
 tenant_id text NOT NULL,project_id text NOT NULL,environment text NOT NULL,billing_mode text NOT NULL,
 source_observation_id text NOT NULL,reservation_id text NOT NULL,reservation_revision integer NOT NULL CHECK(reservation_revision>=1),
 usage_event jsonb NOT NULL,provider_evidence jsonb NOT NULL,provider_evidence_id text NOT NULL,provider_evidence_revision integer NOT NULL CHECK(provider_evidence_revision>=1),
 provider_evidence_hash char(71) NOT NULL,supersedes_observation_id text,observation_digest char(71) NOT NULL,
 collector_observation_id text NOT NULL REFERENCES cost_intelligence.budget_source_observations(observation_id),
 ledger_event_id text NOT NULL REFERENCES cost_intelligence.financial_ledger_events(event_id),
 recorded_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,project_id,environment,billing_mode,source_observation_id),
 UNIQUE(tenant_id,project_id,environment,billing_mode,provider_evidence_id,provider_evidence_revision)
);
ALTER TABLE cost_intelligence.budget_reported_observations OWNER TO ci_finance_owner;
REVOKE ALL ON cost_intelligence.budget_reported_observations FROM PUBLIC;
GRANT SELECT,INSERT ON cost_intelligence.budget_reported_observations TO ci_finance_runtime;
CREATE TRIGGER budget_reported_observations_append_only BEFORE UPDATE OR DELETE ON cost_intelligence.budget_reported_observations
 FOR EACH ROW EXECUTE FUNCTION cost_intelligence.reject_ledger_projection_mutation();
CREATE TRIGGER budget_reported_observations_no_truncate BEFORE TRUNCATE ON cost_intelligence.budget_reported_observations
 FOR EACH STATEMENT EXECUTE FUNCTION cost_intelligence.reject_ledger_projection_mutation();
CREATE POLICY budget_reported_observations_rls ON cost_intelligence.budget_reported_observations FOR ALL TO ci_finance_runtime
 USING(cost_intelligence.finance_scope_matches(tenant_id,project_id,environment,billing_mode))
 WITH CHECK(cost_intelligence.finance_scope_matches(tenant_id,project_id,environment,billing_mode));
ALTER TABLE cost_intelligence.budget_reported_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE cost_intelligence.budget_reported_observations FORCE ROW LEVEL SECURITY;

-- A source chain is current only when its revision and predecessor match the durable head.
CREATE FUNCTION cost_intelligence.guard_budget_source_append() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,cost_intelligence AS $$
DECLARE prior_revision integer; prior_hash text;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('ci02-ledger:'||NEW.tenant_id||':'||NEW.project_id||':'||NEW.environment||':'||NEW.billing_mode,0));
 SELECT record_revision,record_hash INTO prior_revision,prior_hash FROM cost_intelligence.budget_source_observations
 WHERE tenant_id=NEW.tenant_id AND project_id=NEW.project_id AND environment=NEW.environment AND billing_mode=NEW.billing_mode AND record_id=NEW.record_id
 ORDER BY record_revision DESC LIMIT 1;
 IF (prior_revision IS NULL AND (NEW.record_revision<>1 OR NEW.predecessor_hash IS NOT NULL))
 OR (prior_revision IS NOT NULL AND (NEW.record_revision<>prior_revision+1 OR NEW.predecessor_hash IS DISTINCT FROM prior_hash))
 THEN RAISE EXCEPTION 'budget source revision conflict' USING ERRCODE='23505'; END IF;
 RETURN NEW;
END $$;
ALTER FUNCTION cost_intelligence.guard_budget_source_append() OWNER TO ci_finance_owner;
REVOKE ALL ON FUNCTION cost_intelligence.guard_budget_source_append() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cost_intelligence.guard_budget_source_append() TO ci_finance_runtime,ci_finance_owner;
CREATE TRIGGER budget_source_observations_revision_guard BEFORE INSERT ON cost_intelligence.budget_source_observations
 FOR EACH ROW EXECUTE FUNCTION cost_intelligence.guard_budget_source_append();

CREATE FUNCTION cost_intelligence.guard_budget_reported_append() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,cost_intelligence AS $$
DECLARE prior_observation text; prior_evidence_revision integer;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('ci02-ledger:'||NEW.tenant_id||':'||NEW.project_id||':'||NEW.environment||':'||NEW.billing_mode,0));
 SELECT source_observation_id INTO prior_observation FROM cost_intelligence.budget_reported_observations
 WHERE tenant_id=NEW.tenant_id AND project_id=NEW.project_id AND environment=NEW.environment AND billing_mode=NEW.billing_mode AND reservation_id=NEW.reservation_id
 ORDER BY reservation_revision DESC LIMIT 1;
 IF NEW.supersedes_observation_id IS DISTINCT FROM prior_observation OR NEW.source_observation_id=NEW.supersedes_observation_id
 THEN RAISE EXCEPTION 'reported observation predecessor conflict' USING ERRCODE='23505'; END IF;
 SELECT max(provider_evidence_revision) INTO prior_evidence_revision FROM cost_intelligence.budget_reported_observations
 WHERE tenant_id=NEW.tenant_id AND project_id=NEW.project_id AND environment=NEW.environment AND billing_mode=NEW.billing_mode AND provider_evidence_id=NEW.provider_evidence_id;
 IF NEW.provider_evidence_revision<>coalesce(prior_evidence_revision,0)+1
 OR NEW.usage_event->>'source_observation_id' IS DISTINCT FROM NEW.source_observation_id
 OR NEW.usage_event->>'supersedes_observation_id' IS DISTINCT FROM NEW.supersedes_observation_id
 OR NEW.provider_evidence->>'evidence_id' IS DISTINCT FROM NEW.provider_evidence_id
 OR (NEW.provider_evidence->>'revision')::integer IS DISTINCT FROM NEW.provider_evidence_revision
 OR NEW.provider_evidence->>'content_hash' IS DISTINCT FROM NEW.provider_evidence_hash::text
 OR NOT EXISTS(SELECT 1 FROM cost_intelligence.budget_source_observations s
   WHERE s.observation_id=NEW.collector_observation_id AND s.tenant_id=NEW.tenant_id AND s.project_id=NEW.project_id AND s.environment=NEW.environment AND s.billing_mode=NEW.billing_mode
     AND s.collector_record->'payload'->'usageEvent'=NEW.usage_event AND s.collector_record->'payload'->'providerEvidence'=NEW.provider_evidence)
 OR NOT EXISTS(SELECT 1 FROM cost_intelligence.financial_ledger_events e WHERE e.event_id=NEW.ledger_event_id
   AND e.tenant_id=NEW.tenant_id AND e.project_id=NEW.project_id AND e.environment=NEW.environment AND e.billing_mode=NEW.billing_mode
   AND e.billable_attempt_id=NEW.usage_event->>'billable_attempt_id' AND e.currency='USD'
   AND e.amount=(NEW.provider_evidence#>>'{reported_cost,money,amount}')::numeric AND e.valuation='provider_reported_unsettled')
 THEN RAISE EXCEPTION 'reported observation durable binding conflict' USING ERRCODE='23505'; END IF;
 RETURN NEW;
END $$;
ALTER FUNCTION cost_intelligence.guard_budget_reported_append() OWNER TO ci_finance_owner;
REVOKE ALL ON FUNCTION cost_intelligence.guard_budget_reported_append() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cost_intelligence.guard_budget_reported_append() TO ci_finance_runtime,ci_finance_owner;
CREATE TRIGGER budget_reported_observations_revision_guard BEFORE INSERT ON cost_intelligence.budget_reported_observations
 FOR EACH ROW EXECUTE FUNCTION cost_intelligence.guard_budget_reported_append();

CREATE FUNCTION cost_intelligence.guard_budget_queue_append() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,cost_intelligence AS $$
DECLARE prior_revision integer; prior_state text; prior_currency text; prior_reservation text;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('ci02-ledger:'||NEW.tenant_id||':'||NEW.project_id||':'||NEW.environment||':'||NEW.billing_mode,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('ci05a-budget:'||NEW.tenant_id||':'||NEW.project_id||':'||NEW.environment||':'||NEW.billing_mode||':'||NEW.currency,0));
 IF TG_TABLE_NAME='budget_reconciliation_exceptions' THEN
   SELECT revision,state,currency,reservation_id INTO prior_revision,prior_state,prior_currency,prior_reservation FROM cost_intelligence.budget_reconciliation_exceptions
   WHERE tenant_id=NEW.tenant_id AND project_id=NEW.project_id AND environment=NEW.environment AND billing_mode=NEW.billing_mode AND exception_id=NEW.exception_id
   ORDER BY revision DESC LIMIT 1;
   IF (prior_revision IS NOT NULL AND (prior_currency IS DISTINCT FROM NEW.currency OR prior_reservation IS DISTINCT FROM NEW.reservation_id))
   OR (prior_state='resolved' AND NEW.state NOT IN ('reopened','resolved'))
   OR (NEW.state='reopened' AND prior_state IS DISTINCT FROM 'resolved')
   THEN RAISE EXCEPTION 'budget exception state conflict' USING ERRCODE='23505'; END IF;
 ELSE
   SELECT max(revision) INTO prior_revision FROM cost_intelligence.budget_recovery_cursors
   WHERE tenant_id=NEW.tenant_id AND project_id=NEW.project_id AND environment=NEW.environment AND billing_mode=NEW.billing_mode AND currency=NEW.currency AND job_reference=NEW.job_reference;
 END IF;
 IF NEW.revision<>coalesce(prior_revision,0)+1 THEN RAISE EXCEPTION 'budget queue revision conflict' USING ERRCODE='23505'; END IF;
 RETURN NEW;
END $$;
ALTER FUNCTION cost_intelligence.guard_budget_queue_append() OWNER TO ci_finance_owner;
REVOKE ALL ON FUNCTION cost_intelligence.guard_budget_queue_append() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cost_intelligence.guard_budget_queue_append() TO ci_finance_runtime,ci_finance_owner;
CREATE TRIGGER budget_reconciliation_exceptions_revision_guard BEFORE INSERT ON cost_intelligence.budget_reconciliation_exceptions
 FOR EACH ROW EXECUTE FUNCTION cost_intelligence.guard_budget_queue_append();
CREATE TRIGGER budget_recovery_cursors_revision_guard BEFORE INSERT ON cost_intelligence.budget_recovery_cursors
 FOR EACH ROW EXECUTE FUNCTION cost_intelligence.guard_budget_queue_append();

-- Existing events and acknowledgements retain their contracts and share a single revision with new lifecycle observations.
CREATE OR REPLACE FUNCTION cost_intelligence.guard_budget_revision_append() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,cost_intelligence AS $$
DECLARE prior_revision integer;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('ci02-ledger:'||NEW.tenant_id||':'||NEW.project_id||':'||NEW.environment||':'||NEW.billing_mode,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('ci05a-budget:'||NEW.tenant_id||':'||NEW.project_id||':'||NEW.environment||':'||NEW.billing_mode||':'||NEW.currency,0));
 SELECT coalesce(max(event_sequence),0) INTO prior_revision FROM (
   SELECT event_sequence FROM cost_intelligence.budget_reservation_events WHERE tenant_id=NEW.tenant_id AND project_id=NEW.project_id AND environment=NEW.environment AND billing_mode=NEW.billing_mode AND reservation_id=NEW.reservation_id
   UNION ALL
   SELECT event_sequence FROM cost_intelligence.budget_reservation_acknowledgements WHERE tenant_id=NEW.tenant_id AND project_id=NEW.project_id AND environment=NEW.environment AND billing_mode=NEW.billing_mode AND reservation_id=NEW.reservation_id
   UNION ALL
   SELECT event_sequence FROM cost_intelligence.budget_lifecycle_observations WHERE tenant_id=NEW.tenant_id AND project_id=NEW.project_id AND environment=NEW.environment AND billing_mode=NEW.billing_mode AND reservation_id=NEW.reservation_id
 ) revisions;
 IF NEW.event_sequence<>prior_revision+1 THEN RAISE EXCEPTION 'budget revision conflict' USING ERRCODE='23505'; END IF;
 IF EXISTS(SELECT 1 FROM cost_intelligence.budget_reservation_events WHERE tenant_id=NEW.tenant_id AND project_id=NEW.project_id AND environment=NEW.environment AND billing_mode=NEW.billing_mode AND idempotency_key=NEW.idempotency_key)
 OR EXISTS(SELECT 1 FROM cost_intelligence.budget_reservation_acknowledgements WHERE tenant_id=NEW.tenant_id AND project_id=NEW.project_id AND environment=NEW.environment AND billing_mode=NEW.billing_mode AND idempotency_key=NEW.idempotency_key)
 OR EXISTS(SELECT 1 FROM cost_intelligence.budget_lifecycle_observations WHERE tenant_id=NEW.tenant_id AND project_id=NEW.project_id AND environment=NEW.environment AND billing_mode=NEW.billing_mode AND idempotency_key=NEW.idempotency_key)
 THEN RAISE EXCEPTION 'budget command key conflict' USING ERRCODE='23505'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER budget_lifecycle_observations_revision_guard BEFORE INSERT ON cost_intelligence.budget_lifecycle_observations
 FOR EACH ROW EXECUTE FUNCTION cost_intelligence.guard_budget_revision_append();

CREATE INDEX budget_reconciliation_exceptions_current ON cost_intelligence.budget_reconciliation_exceptions
 (tenant_id,project_id,environment,billing_mode,currency,exception_id,revision DESC);
CREATE INDEX budget_lifecycle_observations_current ON cost_intelligence.budget_lifecycle_observations
 (tenant_id,project_id,environment,billing_mode,currency,reservation_id,event_sequence DESC);

CREATE OR REPLACE VIEW cost_intelligence.foundation_health AS
WITH required(version) AS (
 VALUES ('0001_foundation'), ('0002_foundation_health'), ('0003_financial_ledger'),
 ('0004_pricing_catalog'), ('0005_pricing_valuation_history'), ('0006_finance_security_roles'),
 ('0007_accounting_projection_snapshots'), ('0008_budget_reservations'), ('0009_usage_intake'),
 ('0010_budget_authority_bindings'), ('0011_budget_settlement_reconciliation')
)
SELECT bool_and(m.version IS NOT NULL) AS migrations_ready,
 count(m.version)::integer AS required_migrations_present,max(m.applied_at) AS checked_at
FROM required r LEFT JOIN cost_intelligence.schema_migrations m ON m.version=r.version;
GRANT SELECT ON cost_intelligence.foundation_health TO ci_finance_runtime;
