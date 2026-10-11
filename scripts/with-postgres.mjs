import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { sanitizeOutput } from './sanitize.mjs';
import { assertDisposableMarker, DISPOSABLE_MARKER } from './test-db-lifecycle.mjs';

const { Client } = pg;
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const [suite, ...flags] = process.argv.slice(2);
if (!suite) {
  console.error('Usage: node scripts/with-postgres.mjs <suite> [--offline] [--suite=<selector>]');
  process.exit(2);
}
const imageConfig = JSON.parse(await readFile(join(root, 'postgres-test-image.json'), 'utf8'));
const runId = `${new Date().toISOString().replaceAll(':', '').replaceAll('.', '')}-${randomBytes(4).toString('hex')}`;
const containerName = `ci-test-${runId}`;
const password = randomBytes(32).toString('base64url');
const user = 'ci_test_user';
const database = 'ci_test';
let connectionConfig;
let originalOverrideUrl = null;
let previousDatabaseName = null;
let previousDatabaseCreated = false;
let previousDatabaseCleaned = false;
let migrations = [];
let previousMigrations = null;
let previousFixtureLoaded = false;
let dockerStarted = false;
let dbMode = 'disposable_container';
let finalStatus = 'failed';
let testExitCode = 1;
let sanitizedLogs = 'No container logs available.';
let dbClient;
let caughtSignal = null;
let markerValidated = false;
let containerCleaned = false;

const safeEnv = { PATH: process.env.PATH ?? '', POSTGRES_PASSWORD: password };
const exec = (command, args, options = {}) => spawnSync(command, args, {
  cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH ?? '' }, ...options,
});
function checked(command, args, options = {}) {
  const result = exec(command, args, options);
  if (result.status !== 0) throw new Error(`${command} exited ${result.status ?? 'without status'}: ${(result.stderr || result.stdout || '').slice(0, 1000)}`);
  return result.stdout.trim();
}
function sanitize(value) {
  const secrets = [password, connectionConfig?.password];
  if (originalOverrideUrl) {
    try {
      const parsed = new URL(originalOverrideUrl);
      secrets.push(originalOverrideUrl, decodeURIComponent(parsed.username), decodeURIComponent(parsed.password));
    } catch {}
  }
  return sanitizeOutput(value, secrets);
}
function environmentConfig(prefix, config) {
  return {
    [`${prefix}_HOST`]: config.host,
    [`${prefix}_PORT`]: String(config.port),
    [`${prefix}_USER`]: config.user,
    [`${prefix}_PASSWORD`]: config.password,
    [`${prefix}_NAME`]: config.database,
  };
}
function namedDatabaseConfig(name) {
  return { ...connectionConfig, database: name, connectionString: undefined };
}
async function createPreviousFixtureDatabase() {
  previousDatabaseName = `ci_previous_${randomBytes(5).toString('hex')}`;
  const admin = await connectWithRetry(namedDatabaseConfig('postgres'));
  try {
    await admin.query(`CREATE DATABASE "${previousDatabaseName}"`);
    previousDatabaseCreated = true;
  } finally {
    await admin.end();
  }
  let client;
  try {
    client = await connectWithRetry(namedDatabaseConfig(previousDatabaseName));
    const firstMigration = await readFile(join(root, 'migrations/0001_foundation.sql'));
    const firstChecksum = createHash('sha256').update(firstMigration).digest('hex');
    const fixture = await readFile(join(root, 'tests/fixtures/db/previous-foundation.sql'), 'utf8');
    if (!fixture.includes('__MIGRATION_0001_SHA256__')) throw new Error('Previous-database fixture has no checked migration checksum placeholder.');
    await client.query(fixture.replaceAll('__MIGRATION_0001_SHA256__', firstChecksum));
    previousFixtureLoaded = true;
    previousMigrations = await applyMigrations(client);
  } finally {
    if (client) await client.end().catch(() => {});
  }
  return namedDatabaseConfig(previousDatabaseName);
}
async function dropPreviousFixtureDatabase() {
  if (!previousDatabaseCreated || !previousDatabaseName || !connectionConfig) return;
  const admin = await connectWithRetry(namedDatabaseConfig('postgres'));
  try {
    await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', [previousDatabaseName]);
    await admin.query(`DROP DATABASE IF EXISTS "${previousDatabaseName}"`);
  } finally {
    await admin.end();
  }
}
async function connectWithRetry(config) {
  let lastError;
  for (let attempt = 1; attempt <= 45; attempt++) {
    if (caughtSignal) throw new Error(`Interrupted by ${caughtSignal}`);
    const client = new Client(config);
    try {
      await client.connect();
      return client;
    } catch (error) {
      lastError = error;
      await client.end().catch(() => {});
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  throw new Error(`PostgreSQL did not become ready: ${lastError?.message ?? 'timeout'}`);
}
async function applyMigrations(client) {
  const migrationDir = join(root, 'migrations');
  const names = (await readdir(migrationDir)).filter(name => name.endsWith('.sql')).sort();
  if (names.length === 0) throw new Error('No migration files found; database-backed suite cannot pass empty migrations.');
  await client.query('CREATE SCHEMA IF NOT EXISTS cost_intelligence');
  await client.query(`CREATE TABLE IF NOT EXISTS cost_intelligence.schema_migrations (
    version text PRIMARY KEY,
    checksum_sha256 char(64) NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const applied = [];
  for (const name of names) {
    const sql = await readFile(join(migrationDir, name), 'utf8');
    const version = name.replace(/\.sql$/, '');
    const checksum = createHash('sha256').update(sql).digest('hex');
    const existing = await client.query('SELECT checksum_sha256 FROM cost_intelligence.schema_migrations WHERE version = $1', [version]);
    if (existing.rowCount) {
      if (existing.rows[0].checksum_sha256.trim() !== checksum) throw new Error(`Migration checksum changed for ${version}; refusing to mutate applied history.`);
      applied.push({ version, checksum, status: 'already_applied' });
      continue;
    }
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('INSERT INTO cost_intelligence.schema_migrations(version, checksum_sha256) VALUES ($1, $2)', [version, checksum]);
      await client.query('COMMIT');
      applied.push({ version, checksum, status: 'applied' });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    }
  }
  return applied;
}
async function ensureTestMarker(client) {
  await client.query('CREATE SCHEMA IF NOT EXISTS ci_test');
  await client.query('CREATE TABLE IF NOT EXISTS ci_test.disposable_database_marker (marker text PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now())');
  await client.query('INSERT INTO ci_test.disposable_database_marker(marker) VALUES ($1) ON CONFLICT (marker) DO NOTHING', [DISPOSABLE_MARKER]);
}

process.on('SIGINT', () => { caughtSignal = 'SIGINT'; });
process.on('SIGTERM', () => { caughtSignal = 'SIGTERM'; });

try {
  if (process.env.CI_TEST_DATABASE_URL) {
    dbMode = 'validated_override';
    originalOverrideUrl = process.env.CI_TEST_DATABASE_URL;
    const parsed = new URL(originalOverrideUrl);
    if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) throw new Error('CI_TEST_DATABASE_URL must use the PostgreSQL URL scheme.');
    connectionConfig = {
      host: parsed.hostname, port: parsed.port ? Number(parsed.port) : 5432,
      user: decodeURIComponent(parsed.username), password: decodeURIComponent(parsed.password),
      connectionTimeoutMillis: 5000,
      database: decodeURIComponent(parsed.pathname.slice(1)),
    };
    if (!connectionConfig.host || !connectionConfig.user || !connectionConfig.password || !connectionConfig.database) throw new Error('CI_TEST_DATABASE_URL must include host, user, password, and database.');
    dbClient = await connectWithRetry(connectionConfig);
    const markerRows = await dbClient.query('SELECT marker FROM ci_test.disposable_database_marker');
    assertDisposableMarker(markerRows.rows);
    markerValidated = true;
  } else {
    checked('docker', ['info']);
    const run = exec('docker', ['run', '--detach', '--name', containerName, '--publish', '127.0.0.1::5432', '--env', `POSTGRES_USER=${user}`, '--env', `POSTGRES_DB=${database}`, '--env', 'POSTGRES_PASSWORD', imageConfig.image], { env: safeEnv });
    if (run.status !== 0) throw new Error(`docker run failed: ${sanitize(run.stderr || run.stdout).slice(0, 1000)}`);
    dockerStarted = true;
    const portText = checked('docker', ['port', containerName, '5432/tcp']);
    const portMatch = portText.match(/127\.0\.0\.1:(\d+)/);
    if (!portMatch) throw new Error('Docker did not provide a loopback-only mapped PostgreSQL port.');
    connectionConfig = { host: '127.0.0.1', port: Number(portMatch[1]), user, password, database, connectionTimeoutMillis: 5000 };
    dbClient = await connectWithRetry(connectionConfig);
    await ensureTestMarker(dbClient);
    markerValidated = true;
  }

  migrations = await applyMigrations(dbClient);
  await dbClient.end();
  dbClient = undefined;
  const previousConfig = ['migrations', 'integration', 'release'].includes(suite) ? await createPreviousFixtureDatabase() : null;
  const childEnv = {
    PATH: process.env.PATH ?? '', CI: '1', NODE_ENV: 'test',
    ...environmentConfig('CI_TEST_DB', connectionConfig),
    ...(previousConfig ? environmentConfig('CI_TEST_PREVIOUS_DB', previousConfig) : {}),
    CI_TEST_MIGRATIONS: JSON.stringify(migrations),
    ...(previousMigrations ? { CI_TEST_PREVIOUS_MIGRATIONS: JSON.stringify(previousMigrations) } : {}),
    ...(previousFixtureLoaded ? { CI_TEST_PREVIOUS_FIXTURE_LOADED: '1' } : {}),
  };
  const test = exec(process.execPath, ['scripts/run-suite.mjs', suite, ...flags], {
    env: childEnv,
  });
  if (test.stdout) process.stdout.write(sanitize(test.stdout));
  if (test.stderr) process.stderr.write(sanitize(test.stderr));
  testExitCode = test.status ?? 1;
  finalStatus = testExitCode === 0 ? 'passed' : (suite === 'integration' || suite === 'release') ? 'blocked' : 'failed';
} catch (error) {
  console.error(sanitize(error?.message ?? error));
} finally {
  if (dbClient) await dbClient.end().catch(() => {});
  if (previousDatabaseCreated) {
    try {
      await dropPreviousFixtureDatabase();
      previousDatabaseCreated = false;
      previousDatabaseCleaned = true;
    } catch (error) {
      finalStatus = 'failed';
      console.error(`Previous-fixture database cleanup failed: ${sanitize(error?.message ?? error)}`);
    }
  }
  if (dockerStarted) {
    const logs = exec('docker', ['logs', containerName]);
    sanitizedLogs = sanitize(logs.stdout || logs.stderr || 'Container produced no logs.');
    const logDir = join(root, 'artifacts', 'test-database');
    await mkdir(logDir, { recursive: true });
    await writeFile(join(logDir, `${suite}-${runId}.log`), sanitizedLogs);
    const removal = exec('docker', ['rm', '--force', containerName]);
    if (removal.status !== 0) {
      finalStatus = 'failed';
      console.error('Disposable PostgreSQL cleanup failed; manual removal is required.');
    } else containerCleaned = true;
  }
  const migrationsDir = join(root, 'migrations');
  const migrationNames = (await readdir(migrationsDir)).filter(name => name.endsWith('.sql')).sort();
  const migrationHashes = [];
  for (const name of migrationNames) migrationHashes.push({ name, sha256: createHash('sha256').update(await readFile(join(migrationsDir, name))).digest('hex') });
  const evidence = {
    manifestVersion: '1.0.0', runId, suite, status: finalStatus, exitCode: finalStatus === 'passed' ? 0 : 1,
    databaseMode: dbMode, postgresImage: dbMode === 'disposable_container' ? imageConfig.image : 'validated override',
    migrations: migrationHashes, freshMigrationResults: migrations, previousMigrationResults: previousMigrations,
    previousFixtureLoaded, previousDatabaseCreated: previousDatabaseName !== null,
    previousDatabaseCleaned,
    markerValidated,
    containerStarted: dockerStarted, containerCleaned, sanitizedLog: dockerStarted ? `artifacts/test-database/${suite}-${runId}.log` : null,
    testExitCode, offline: flags.includes('--offline'), externalCalls: 0, recordedAt: new Date().toISOString(),
  };
  const manifestDir = join(root, 'artifacts', 'test-manifests');
  await mkdir(manifestDir, { recursive: true });
  await writeFile(join(manifestDir, `${suite}-db-${runId}.json`), `${JSON.stringify(evidence, null, 2)}\n`);
}

if (finalStatus !== 'passed') process.exitCode = 1;
