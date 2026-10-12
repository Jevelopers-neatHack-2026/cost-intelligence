import assert from 'node:assert/strict';
import test from 'node:test';
import * as finance from '../../dist/index.js';
import { fixtureScope, posting, query, exportRequest, checked, hostPorts, syntheticSqlPort, hash } from './query-export-fixtures.mjs';

function store() {
  const records = new Map(); const seals = new Map();
  const calls = { lookup: 0, commitImmutable: 0, verifyOriginal: 0 };
  return {
    calls,
    async lookup(key) { calls.lookup++; return records.get(key) ?? null; },
    async commitImmutable(key, value) { calls.commitImmutable++; if (!records.has(key)) { records.set(key, structuredClone(value)); seals.set(key, hash(value)); } return records.get(key); },
    async verifyOriginal(key, value) { calls.verifyOriginal++; return seals.get(key) === hash(value); },
  };
}
async function setup(version, replay) {
  const scope = fixtureScope(); const sql = syntheticSqlPort(scope, [posting(scope, 'expense')]); const host = hostPorts(scope, sql);
  const legacy = store(); const rich = store(); const ports = finance.createReportingExportRuntimePorts(host.ports, legacy, rich, host.fence);
  let q = query(scope);
  if (version === '1.0.0') { q = { ...q, schemaVersion: version, filters: { ...q.filters, currency: 'USD' } }; delete q.policyVersion; delete q.groupings; }
  const page = await checked((version === '1.0.0' ? finance.querySummary : finance.querySummaryV2)(q, host.ports));
  const request = exportRequest(page, scope); const selected = version === '1.0.0' ? legacy : rich;
  const first = replay ? await checked(finance.exportSummaryV2(request, ports)) : null;
  return { host, ports, request, selected, first, call: replay ? finance.getPreparedExportArtifacts : finance.exportSummaryV2 };
}

for (const version of ['1.0.0', '2.0.0']) for (const replay of [false, true]) {
  const path = `${version} ${replay ? 'retrieval' : 'creation'}`;
  for (const gate of replay ? ['lookup', 'verifyOriginal'] : ['lookup', 'commitImmutable', 'verifyOriginal']) {
    test(`${path}: read revoked during ${gate} refuses financial disclosure`, async () => {
      const x = await setup(version, replay); const action = x.selected[gate]; let triggered = false;
      const reads = x.host.state.reads;
      x.selected[gate] = async (...args) => {
        const original = await action(...args);
        if (gate === 'verifyOriginal') assert.equal(original, true, 'the original receipt was genuinely authenticated before revocation');
        x.host.state.denyRead = true; triggered = true; return original;
      };
      const result = await x.call(x.request, x.ports);
      assert.equal(triggered, true); assert.equal(result.ok, false); assert.equal(result.error.code, 'FORBIDDEN_SCOPE');
      assert.equal(Object.hasOwn(result, 'value'), false);
      if (gate === 'lookup') assert.equal(x.host.state.reads, reads, 'revoked read never reaches the query database after artifact lookup');
    });
  }
  test(`${path}: export revoked during original verification still refuses disclosure`, async () => {
    const x = await setup(version, replay); const verify = x.selected.verifyOriginal; let triggered = false;
    x.selected.verifyOriginal = async (...args) => { const original = await verify(...args); assert.equal(original, true); x.host.state.denyExport = true; triggered = true; return original; };
    const result = await x.call(x.request, x.ports); assert.equal(triggered, true); assert.equal(result.ok, false); assert.equal(result.error.code, 'FORBIDDEN_SCOPE');
  });
  test(`${path}: unchanged read and export grants preserve authenticated original bytes`, async () => {
    const x = await setup(version, replay); const before = x.host.state.calls;
    const result = await checked(x.call(x.request, x.ports));
    assert.ok(x.host.state.calls > before); assert.equal(x.selected.calls.verifyOriginal, replay ? 2 : 1);
    if (replay) assert.deepEqual(result, x.first);
    else assert.deepEqual(await finance.getPreparedExportArtifacts(x.request, x.ports), { ok: true, value: result });
  });
}

test('both permission decisions remain unexpired after the slower authority await completes', async () => {
  const x = await setup('2.0.0', false);
  x.host.controller.onBoundary('authority.read', async controller => { await Promise.resolve(); controller.advanceTime('2026-10-12T22:01:01.000Z'); });
  const result = await x.call(x.request, x.ports);
  assert.equal(result.ok, false); assert.equal(result.error.code, 'FORBIDDEN_SCOPE'); assert.equal(x.selected.calls.lookup, 0);
});
