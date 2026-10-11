import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import pg from 'pg';
import { assertDisposableMarker, databaseConfigFromEnvironment, DISPOSABLE_MARKER } from '../../scripts/test-db-lifecycle.mjs';

const { Client } = pg;
const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

function testChildEnvironment(prefix) {
  const keys = ['HOST', 'PORT', 'USER', 'PASSWORD', 'NAME'].map(suffix => `${prefix}_${suffix}`);
  return Object.fromEntries([['PATH', process.env.PATH ?? ''], ...keys.map(key => [key, process.env[key]])]);
}

async function verifyDurability(prefix) {
  const config = databaseConfigFromEnvironment(prefix);
  const probeId = randomUUID();
  const client = new Client(config);
  await client.connect();
  try {
    const marker = await client.query('SELECT marker FROM ci_test.disposable_database_marker');
    assertDisposableMarker(marker.rows);
    const health = await client.query('SELECT migrations_ready, required_migrations_present FROM cost_intelligence.foundation_health');
    assert.equal(health.rows[0].migrations_ready, true);
    assert.equal(Number(health.rows[0].required_migrations_present), 2);
    await client.query('CREATE TABLE IF NOT EXISTS ci_test.foundation_durable_probe (probe_id uuid PRIMARY KEY, payload text NOT NULL)');
    await client.query('INSERT INTO ci_test.foundation_durable_probe(probe_id, payload) VALUES ($1, $2)', [probeId, `verified:${prefix}`]);
  } finally {
    await client.end();
  }

  const child = spawnSync(process.execPath, ['scripts/verify-db-durability.mjs', prefix, probeId], {
    cwd: root, encoding: 'utf8', timeout: 15000, env: testChildEnvironment(prefix),
  });
  assert.equal(child.status, 0, `fresh worker could not see the durable record and health view: ${(child.stderr || child.stdout || 'no output').slice(0, 1000)}`);
  assert.match(child.stdout, /durable database health and record verified/);
}

test('fresh and previous foundation schemas apply checksummed upgrades, survive reconnect, and expose health', async () => {
  assert.throws(() => assertDisposableMarker([]), /not marked as a disposable/);
  assert.throws(() => assertDisposableMarker([{ marker: 'unrelated' }]), /not marked as a disposable/);
  assert.equal(assertDisposableMarker([{ marker: DISPOSABLE_MARKER }]), true);
  assert.ok(process.env.CI_TEST_DB_HOST, 'with-postgres lifecycle must provide split connection settings for its validated disposable database');
  assert.equal(process.env.CI_TEST_PREVIOUS_FIXTURE_LOADED, '1', 'previous-version upgrade fixture must be installed before this suite starts');

  const migrations = JSON.parse(process.env.CI_TEST_MIGRATIONS ?? 'null');
  const previousMigrations = JSON.parse(process.env.CI_TEST_PREVIOUS_MIGRATIONS ?? 'null');
  assert.ok(Array.isArray(migrations) && migrations.length > 0, 'fresh database migration outcomes must be recorded');
  assert.ok(Array.isArray(previousMigrations) && previousMigrations.length > 0, 'previous database migration outcomes must be recorded');
  assert.ok(migrations.every(item => item.status === 'applied'), 'fresh database must apply each migration');
  assert.deepEqual(previousMigrations.map(({ version, status }) => ({ version, status })), [
    { version: '0001_foundation', status: 'already_applied' },
    { version: '0002_foundation_health', status: 'applied' },
  ]);

  const names = (await readdir(join(root, 'migrations'))).filter(name => name.endsWith('.sql')).sort();
  assert.equal(names.length, 2, 'foundation migration suite must exercise fresh creation and an incremental upgrade');
  for (const prefix of ['CI_TEST_DB', 'CI_TEST_PREVIOUS_DB']) {
    const client = new Client(databaseConfigFromEnvironment(prefix));
    await client.connect();
    try {
      const marker = await client.query('SELECT marker FROM ci_test.disposable_database_marker');
      assertDisposableMarker(marker.rows);
      const records = await client.query('SELECT version, checksum_sha256 FROM cost_intelligence.schema_migrations ORDER BY version');
      assert.equal(records.rowCount, names.length);
      for (let index = 0; index < names.length; index++) {
        const sql = await readFile(join(root, 'migrations', names[index]), 'utf8');
        assert.doesNotMatch(sql, /\b(?:DROP|TRUNCATE)\b/i);
        assert.equal(records.rows[index].version, names[index].replace(/\.sql$/, ''));
        assert.equal(records.rows[index].checksum_sha256.trim(), createHash('sha256').update(sql).digest('hex'));
      }
      const health = await client.query('SELECT migrations_ready, required_migrations_present FROM cost_intelligence.foundation_health');
      assert.equal(health.rows[0].migrations_ready, true);
      assert.equal(Number(health.rows[0].required_migrations_present), names.length);
    } finally {
      await client.end();
    }
    await verifyDurability(prefix);
  }
});
