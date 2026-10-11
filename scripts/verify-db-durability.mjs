import pg from 'pg';
import { assertDisposableMarker, databaseConfigFromEnvironment } from './test-db-lifecycle.mjs';

const { Client } = pg;
const [prefix, probeId] = process.argv.slice(2);
if (!['CI_TEST_DB', 'CI_TEST_PREVIOUS_DB'].includes(prefix) || !probeId) {
  throw new Error('Usage: verify-db-durability.mjs <database-prefix> <probe-id>');
}

const client = new Client(databaseConfigFromEnvironment(prefix));
try {
  await client.connect();
  const marker = await client.query('SELECT marker FROM ci_test.disposable_database_marker');
  assertDisposableMarker(marker.rows);
  const health = await client.query('SELECT migrations_ready FROM cost_intelligence.foundation_health');
  if (health.rows[0]?.migrations_ready !== true) throw new Error('Foundation health did not survive the worker restart.');
  const record = await client.query('SELECT payload FROM ci_test.foundation_durable_probe WHERE probe_id = $1', [probeId]);
  if (record.rows.length !== 1 || record.rows[0].payload !== `verified:${prefix}`) throw new Error('Durable probe record was not visible to the restarted worker.');
  process.stdout.write('durable database health and record verified\n');
} finally {
  await client.end().catch(() => {});
}
