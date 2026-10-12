import assert from 'node:assert/strict';
import test from 'node:test';
import * as finance from '../../dist/index.js';
import { fixtureScope, posting, query, exportRequest, checked, hostPorts, syntheticSqlPort, hash } from './query-export-fixtures.mjs';
function store() {
  const records = new Map(), seals = new Map();
  return { async lookup(key) { return records.get(key) ?? null; }, async commitImmutable(key, value) { if (!records.has(key)) { records.set(key, structuredClone(value)); seals.set(key, hash(value)); } return records.get(key); }, async verifyOriginal(key, value) { return seals.get(key) === hash(value); } };
}
async function setup(version, replay) {
  const scope = fixtureScope(); const host = hostPorts(scope, syntheticSqlPort(scope, [posting(scope, 'expense')]));
  const legacy = store(), rich = store(); const ports = finance.createReportingExportRuntimePorts(host.ports, legacy, rich, host.fence);
  let q = query(scope); if (version === '1.0.0') { q = { ...q, schemaVersion: version, filters: { ...q.filters, currency: 'USD' } }; delete q.policyVersion; delete q.groupings; }
  const page = await checked((version === '1.0.0' ? finance.querySummary : finance.querySummaryV2)(q, host.ports));
  const request = exportRequest(page, scope); const selected = version === '1.0.0' ? legacy : rich;
  const first = replay ? await checked(finance.exportSummaryV2(request, ports)) : null;
  return { scope, host, ports, request, selected, first, call: replay ? finance.getPreparedExportArtifacts : finance.exportSummaryV2 };
}
for (const version of ['1.0.0', '2.0.0']) for (const replay of [false, true]) {
  const path = `${version} ${replay ? 'retrieval' : 'creation'}`;
  for (const gate of replay ? ['lookup', 'verifyOriginal'] : ['lookup', 'commitImmutable', 'verifyOriginal']) for (const context of ['null', 'foreign']) {
    test(`${path}: ${context} trusted context after ${gate} vetoes disclosure despite valid read/export grants`, async () => {
      const x = await setup(version, replay); const action = x.selected[gate]; let triggered = false;
      x.selected[gate] = async (...args) => {
        const original = await action(...args); if (gate === 'verifyOriginal') assert.equal(original, true);
        x.host.controller.setContext(context === 'null' ? 'absent' : 'present', { ...x.scope, projectId: 'foreign-context-project' });
        triggered = true; return original;
      };
      const result = await x.call(x.request, x.ports);
      assert.equal(triggered, true); assert.equal(x.host.state.denyRead, false); assert.equal(x.host.state.denyExport, false);
      assert.equal(result.ok, false); assert.equal(result.error.code, 'FORBIDDEN_SCOPE'); assert.equal(Object.hasOwn(result, 'value'), false);
    });
  }
  for (const transition of ['expiry', 'foreign']) test(`${path}: delayed context resolution ${transition} fails at the final gate`, async () => {
    const x = await setup(version, replay); const verify = x.selected.verifyOriginal; let verified = false, waited = false;
    x.selected.verifyOriginal = async (...args) => { const original = await verify(...args); assert.equal(original, true); verified = true; x.host.controller.onBoundary('context.resolve', async controller => { await Promise.resolve(); waited = true; if (transition === 'expiry') controller.advanceTime('2026-10-12T22:01:01.000Z'); else controller.setContext('present', { ...x.scope, billingMode: 'simulated' }); }); return original; };
    const result = await x.call(x.request, x.ports); assert.equal(verified, true); assert.equal(waited, true);
    assert.equal(result.ok, false); assert.equal(result.error.code, 'FORBIDDEN_SCOPE');
  });
  test(`${path}: unchanged independent context veto and grants preserve original authenticated bytes`, async () => {
    const x = await setup(version, replay); let verified = false, finalContextChecked = false; const verify = x.selected.verifyOriginal;
    x.selected.verifyOriginal = async (...args) => { const original = await verify(...args); assert.equal(original, true); verified = true; x.host.controller.onBoundary('context.resolve', () => { finalContextChecked = true; }); return original; };
    const result = await checked(x.call(x.request, x.ports)); assert.equal(finalContextChecked, true);
    if (replay) assert.deepEqual(result, x.first); else assert.deepEqual(await finance.getPreparedExportArtifacts(x.request, x.ports), { ok: true, value: result });
  });
}
