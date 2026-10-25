import assert from 'node:assert/strict';
import test from 'node:test';
import * as finance from '../../dist/index.js';
import { fixtureScope, query, hostPorts, syntheticSqlPort, hash, exportRequest, checked } from '../exports/query-export-fixtures.mjs';

// Deterministic synthetic authority and SQL ports. The reporting suite separately
// exercises the unfiltered zero-source case against disposable PostgreSQL.
function fixture(coverage, { billingMode = 'live', currency, mutateEvidence } = {}) {
  const scope = fixtureScope({ billingMode });
  const host = hostPorts(scope, syntheticSqlPort(scope, []));
  const request = query(scope);
  if (currency) request.filters.currency = currency;
  if (coverage !== null) host.ports.reporting.productEvidence = { async resolveSnapshot(q, asOf) {
    const content = { version: '1.0.0', queryContentHash: finance.reportingEvidenceQueryHash(q, asOf), scope, period: q.period,
      asOf, denominators: [], sourceCoverage: coverage };
    const evidence = { ...content, reference: { id: 'synthetic-explicit-zero', revision: 1, contentHash: hash(content) } };
    return mutateEvidence ? mutateEvidence(evidence) : evidence;
  } };
  return { scope, host, request };
}
const coverageFor = (currency, status = 'complete', expected = 0) =>
  ['expense', 'revenue', 'cash'].map(source => ({ currency, source, status, expected }));
const zero = { status: 'known', knownSubtotal: '0', total: '0', unknownCount: 0 };

test('unfiltered reporting preserves all explicit-zero source currencies in rich summaries and exports', async () => {
  const { scope, host, request } = fixture([...coverageFor('USD'), ...coverageFor('EUR')]);
  const page = await checked(finance.querySummaryV2(request, host.ports));
  assert.deepEqual(page.summary.currencies.map(row => row.currency), ['EUR', 'USD']);
  assert.equal(page.summary.coverage.status, 'complete');
  assert.equal(page.summary.coverage.expected, 0);
  for (const row of page.summary.currencies) for (const value of Object.values(row.metrics)) assert.deepEqual(value, zero);
  // The legacy canonical proposal requires ledger records; do not invent settlement evidence.
  assert.deepEqual(page.canonicalSummaries, []);
  const storage = () => {
    const values = new Map();
    return { async lookup(key) { return values.get(key) ?? null; },
      async commitImmutable(key, value) { if (!values.has(key)) values.set(key, structuredClone(value)); return values.get(key); },
      async verifyOriginal(key, value) { return hash(values.get(key)) === hash(value); } };
  };
  const exportPorts = finance.createReportingExportRuntimePorts(host.ports, storage(), storage(), host.fence);
  const receipt = await checked(finance.exportSummaryV2(exportRequest(page, scope), exportPorts));
  const document = JSON.parse(receipt.artifacts.find(item => item.fileName === 'summary.json').content);
  assert.deepEqual(document.currencies.map(row => row.currency), ['EUR', 'USD']);
  for (const row of document.currencies) {
    const expense = row.metrics.find(item => item.metric === 'expense');
    assert.equal(expense.status, 'known');
    assert.equal(expense.knownSubtotal, '0');
    assert.equal(expense.total, '0');
    assert.equal(expense.unknownCount, 0);
  }
});

test('a currency filter excludes other evidence currencies and their expected counts', async () => {
  const { host, request } = fixture([...coverageFor('USD'), ...coverageFor('EUR', 'partial', 5)], { currency: 'USD' });
  const page = await checked(finance.querySummaryV2(request, host.ports));
  assert.deepEqual(page.summary.currencies.map(row => row.currency), ['USD']);
  assert.equal(page.summary.coverage.expected, 0);
  assert.equal(page.summary.coverage.status, 'complete');
  assert.deepEqual(page.summary.currencies[0].metrics.expense, zero);
});

for (const status of ['partial', 'unknown']) test(`${status} zero-count evidence retains its currency without claiming zero`, async () => {
  const { host, request } = fixture(coverageFor('USD', status));
  const page = await checked(finance.querySummaryV2(request, host.ports));
  assert.deepEqual(page.summary.currencies.map(row => row.currency), ['USD']);
  assert.equal(page.summary.coverage.status, 'unknown');
  assert.deepEqual(page.summary.currencies[0].metrics.expense, { status: 'unknown', knownSubtotal: null, total: null, unknownCount: 0 });
});

test('an absent source does not invent a currency or zero total', async () => {
  const { host, request } = fixture(null);
  const page = await checked(finance.querySummaryV2(request, host.ports));
  assert.deepEqual(page.summary.currencies, []);
  assert.equal(page.summary.coverage.status, 'unknown');
  assert.equal(page.summary.coverage.expected, null);
});

test('incomplete source coverage cannot fill unrelated metrics with zero', async () => {
  const { host, request } = fixture([{ currency: 'USD', source: 'expense', status: 'complete', expected: 0 }]);
  const page = await checked(finance.querySummaryV2(request, host.ports));
  assert.deepEqual(page.summary.currencies[0].metrics.expense, zero);
  assert.equal(page.summary.currencies[0].metrics.grossSales.total, null);
  assert.equal(page.summary.currencies[0].metrics.cashReceipts.total, null);
  assert.equal(page.summary.coverage.status, 'unknown');
});

test('explicit-zero simulation remains separate from actual financial metrics', async () => {
  const { host, request } = fixture(coverageFor('USD'), { billingMode: 'simulated' });
  const page = await checked(finance.querySummaryV2(request, host.ports));
  assert.deepEqual(page.summary.currencies[0].simulated.expense, zero);
  assert.equal(page.summary.currencies[0].metrics.expense.total, null);
});

test('foreign or corrupted evidence cannot introduce output currencies', async () => {
  for (const mutateEvidence of [
    evidence => ({ ...evidence, scope: fixtureScope() }),
    evidence => ({ ...evidence, reference: { ...evidence.reference, contentHash: 'sha256:' + 'f'.repeat(64) } }),
  ]) {
    const { host, request } = fixture(coverageFor('EUR'), { mutateEvidence });
    const result = await finance.querySummaryV2(request, host.ports);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'SOURCE_UNAVAILABLE');
  }
});
