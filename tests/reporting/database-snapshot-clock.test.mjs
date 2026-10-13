import assert from 'node:assert/strict';
import test from 'node:test';
import { databaseSnapshotClock, DATABASE_SNAPSHOT_TIME_SQL } from './database-snapshot-clock.mjs';

const minimum = '2026-10-12T22:00:01.000Z';
const milliseconds = value => String(Date.parse(value));
const observation = value => ({ query: async () => ({ rows: [{ epoch_ms: value }] }) });

test('database snapshot clock uses exactly one explicit rounded-up database observation', async () => {
  const calls = [];
  const later = '2026-10-13T04:48:18.384Z';
  const database = { query: async (...args) => { calls.push(args); return { rows: [{ epoch_ms: milliseconds(later) }] }; } };
  const clock = await databaseSnapshotClock(database, minimum);
  assert.deepEqual(calls, [[DATABASE_SNAPSHOT_TIME_SQL]]);
  assert.equal(DATABASE_SNAPSHOT_TIME_SQL, 'SELECT ceil(extract(epoch FROM clock_timestamp()) * 1000)::text AS epoch_ms');
  assert.deepEqual(clock, { value: later });
  assert.ok(Object.isFrozen(clock));
  assert.throws(() => { clock.value = minimum; }, TypeError);
});

test('database snapshot clock preserves a later injected fixture instant', async () => {
  assert.deepEqual(await databaseSnapshotClock(observation('0'), minimum), { value: minimum });
});

test('database snapshot clock keeps an equal instant unchanged', async () => {
  assert.deepEqual(await databaseSnapshotClock(observation(milliseconds(minimum)), minimum), { value: minimum });
});

test('database snapshot clock does not become stale on a later execution date', async () => {
  for (const later of ['2026-10-13T00:00:00.000Z', '2035-01-01T00:00:00.001Z']) {
    const clock = await databaseSnapshotClock(observation(milliseconds(later)), minimum);
    assert.equal(clock.value, later);
    assert.ok(Date.parse(clock.value) >= Date.parse(later));
    assert.ok(Date.parse(clock.value) > Date.parse(minimum));
  }
});

test('database snapshot clock accepts the inclusive maximum Date instant', async () => {
  assert.equal((await databaseSnapshotClock(observation('8640000000000000'), minimum)).value, '+275760-09-13T00:00:00.000Z');
});

for (const [label, value] of [
  ['missing', undefined], ['null', null], ['number', 1], ['empty', ''],
  ['fraction', '1791866898383.1'], ['negative', '-1'], ['leading zero', '01'],
  ['exponent', '1e12'], ['whitespace', ' 1'], ['NaN', 'NaN'],
  ['unsafe', '9007199254740992'], ['out of Date range', '8640000000000001']
]) {
  test(`database snapshot clock rejects ${label} observations`, async () => {
    await assert.rejects(databaseSnapshotClock(observation(value), minimum));
  });
}

for (const [label, result] of [
  ['missing result', undefined], ['missing rows', {}], ['empty rows', { rows: [] }],
  ['non-array rows', { rows: { 0: { epoch_ms: '1' }, length: 1 } }],
  ['multiple rows', { rows: [{ epoch_ms: '1' }, { epoch_ms: '2' }] }]
]) {
  test(`database snapshot clock rejects ${label}`, async () => {
    await assert.rejects(databaseSnapshotClock({ query: async () => result }, minimum));
  });
}

test('database snapshot clock rejects invalid minimum instants before querying', async () => {
  let calls = 0;
  const database = { query: async () => { calls++; throw new Error('must not query'); } };
  for (const value of [undefined, null, 1, '', 'invalid', '2026-10-12', '2026-10-12T22:00:01Z', '2026-10-12T22:00:01.000+00:00']) {
    await assert.rejects(databaseSnapshotClock(database, value));
  }
  assert.equal(calls, 0);
});

test('database snapshot clock requires a query port', async () => {
  for (const database of [undefined, null, {}, { query: 1 }]) {
    await assert.rejects(databaseSnapshotClock(database, minimum));
  }
});

test('database snapshot clock propagates unavailable database evidence without a wall-clock fallback', async () => {
  const failure = new Error('synthetic unavailable database');
  await assert.rejects(databaseSnapshotClock({ query: async () => { throw failure; } }, minimum), error => error === failure);
});
