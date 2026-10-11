export const DISPOSABLE_MARKER = 'cost-intelligence-disposable-v1';

export function assertDisposableMarker(rows) {
  if (!Array.isArray(rows) || !rows.some(row => row?.marker === DISPOSABLE_MARKER)) {
    throw new Error('CI_TEST_DATABASE_URL target is not marked as a disposable cost-intelligence test database; refusing to migrate it.');
  }
  return true;
}

export function databaseConfigFromEnvironment(prefix = 'CI_TEST_DB') {
  const host = process.env[`${prefix}_HOST`];
  const port = Number(process.env[`${prefix}_PORT`]);
  const user = process.env[`${prefix}_USER`];
  const password = process.env[`${prefix}_PASSWORD`];
  const database = process.env[`${prefix}_NAME`];
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535 || !user || !password || !database) {
    throw new Error(`${prefix} connection fields are incomplete; run database tests through the disposable lifecycle wrapper.`);
  }
  return { host, port, user, password, database, connectionTimeoutMillis: 5000 };
}
