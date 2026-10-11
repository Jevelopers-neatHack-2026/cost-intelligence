CREATE SCHEMA cost_intelligence;
CREATE TABLE cost_intelligence.schema_migrations (
  version text PRIMARY KEY,
  checksum_sha256 char(64) NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO cost_intelligence.schema_migrations(version, checksum_sha256)
VALUES ('0001_foundation', '__MIGRATION_0001_SHA256__');

CREATE SCHEMA ci_test;
CREATE TABLE ci_test.disposable_database_marker (
  marker text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO ci_test.disposable_database_marker(marker)
VALUES ('cost-intelligence-disposable-v1');
