CREATE SCHEMA IF NOT EXISTS cost_intelligence;

CREATE TABLE IF NOT EXISTS cost_intelligence.schema_migrations (
  version text PRIMARY KEY,
  checksum_sha256 char(64) NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);
