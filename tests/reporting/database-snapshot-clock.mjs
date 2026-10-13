// Test-only clock for snapshots that must include completed database-stamped writes.
// The caller must await its writes before sampling. No application clock or row
// is changed, and no particular wall date is substituted for database evidence.
export const DATABASE_SNAPSHOT_TIME_SQL =
  'SELECT ceil(extract(epoch FROM clock_timestamp()) * 1000)::text AS epoch_ms';

/**
 * Return a separate immutable fixture clock at or after both the supplied
 * fixture instant and the database observation. Rounding up in PostgreSQL
 * avoids losing sub-millisecond writes when the reporting API accepts only
 * millisecond instants. This helper is not a production time authority.
 */
export async function databaseSnapshotClock(database, minimum) {
  if (typeof minimum !== 'string') {
    throw new TypeError('The minimum fixture instant must be a canonical UTC timestamp.');
  }
  const lowerBound = Date.parse(minimum);
  if (!Number.isFinite(lowerBound) || new Date(lowerBound).toISOString() !== minimum) {
    throw new TypeError('The minimum fixture instant must be a canonical UTC timestamp.');
  }
  if (database === null || typeof database?.query !== 'function') {
    throw new TypeError('A disposable database query port is required.');
  }
  const result = await database.query(DATABASE_SNAPSHOT_TIME_SQL);
  const value = result?.rows?.[0]?.epoch_ms;
  if (!Array.isArray(result?.rows) || result.rows.length !== 1 ||
      typeof value !== 'string' || !/^(0|[1-9][0-9]{0,15})$/.test(value)) {
    throw new TypeError('The database did not return one canonical millisecond observation.');
  }
  const observed = Number(value);
  if (!Number.isSafeInteger(observed) || observed > 8_640_000_000_000_000) {
    throw new RangeError('The database millisecond observation is outside the supported date range.');
  }
  return Object.freeze({ value: new Date(Math.max(lowerBound, observed)).toISOString() });
}
