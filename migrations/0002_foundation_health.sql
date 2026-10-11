CREATE OR REPLACE VIEW cost_intelligence.foundation_health AS
WITH required(version) AS (
  VALUES ('0001_foundation'), ('0002_foundation_health')
)
SELECT
  bool_and(m.version IS NOT NULL) AS migrations_ready,
  count(m.version)::integer AS required_migrations_present,
  max(m.applied_at) AS checked_at
FROM required r
LEFT JOIN cost_intelligence.schema_migrations m ON m.version = r.version;
