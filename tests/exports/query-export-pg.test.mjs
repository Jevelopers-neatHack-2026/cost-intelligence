import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import pg from 'pg';
import * as finance from '../../dist/index.js';
import { assertDisposableMarker, databaseConfigFromEnvironment, runtimeDatabaseConfigFromEnvironment } from '../../scripts/test-db-lifecycle.mjs';
import { fixtureScope, posting, query, exportRequest, checked, hostPorts, hash } from './query-export-fixtures.mjs';

const PRODUCER = '22a3237dd44f376017969ac881586ff396f19cf8';
const digest = value => 'sha256:' + createHash('sha256').update(value).digest('hex');
const document = receipt => JSON.parse(receipt.artifacts.find(row => row.fileName === 'summary.json').content);
const metric = (doc, name, currency = 'USD', recognition = 'actual') => doc.currencies.find(row => row.currency === currency)[recognition === 'actual' ? 'metrics' : 'simulated'].find(row => row.metric === name);
const economicPage = ({ requestId, ...page }) => page;

await test('real disposable PostgreSQL ledger → query → verified snapshot → export', async t => {
  // Fail closed: no fallback SQL fixture, optional environment gate, or skipped test.
  const admin = new pg.Pool({ ...databaseConfigFromEnvironment(), max: 2 });
  const pool = new pg.Pool({ ...runtimeDatabaseConfigFromEnvironment(), max: 4 });
  const directory = await mkdtemp(join(tmpdir(), 'ci08x-pg-artifacts-'));
  const receipts = []; const failures = [];
  const run = (name, fn) => t.test(name, async () => { try { await fn(); } catch (error) { failures.push({ name, message: error.message }); throw error; } });
  async function setup(scope = fixtureScope(), payloads = [posting(scope, 'direct', { amount: '1' }), posting(scope, 'operating', { amount: '5', classification: 'operating_expense' })]) {
    const host = hostPorts(scope, pool);
    for (const payload of payloads) {
      assert.equal(finance.validateLedgerAppendRequestBoundary(payload).ok, true, 'validate FINAL posting payload immediately before the real public append');
      await checked(finance.appendLedgerEvent(payload, host.ports));
    }
    const storeOptions = { directory, receiptKey: new Uint8Array(32).fill(49) };
    const ports = finance.createReportingExportRuntimePorts(host.ports, finance.createFileExportArtifactStore(storeOptions), finance.createFileReportingExportArtifactStore(storeOptions), host.fence);
    const q = query(scope); const page = await checked(finance.querySummaryV2(q, host.ports));
    const request = exportRequest(page, scope);
    return { scope, host, ports, q, page, request, storeOptions };
  }
  async function prepare(x) {
    const verified = await checked(finance.readVerifiedSummarySnapshotV2({ schemaVersion: '1.0.0', requestId: 'pg-composition-read', scope: x.scope, snapshotId: x.page.snapshotId, queryContentHash: x.page.queryContentHash, summaryContentHash: x.page.summaryContentHash }, x.host.ports));
    assert.deepEqual(economicPage(verified), economicPage(x.page));
    assert.equal(hash(verified.summary), x.page.summaryContentHash);
    const receipt = await checked(finance.exportSummaryV2(x.request, x.ports));
    assert.equal(receipt.manifest.snapshotId, x.page.snapshotId);
    assert.equal(receipt.manifest.queryContentHash, x.page.queryContentHash);
    assert.equal(receipt.manifest.projectionContentHash, x.page.summaryContentHash);
    assert.equal(receipt.manifest.snapshotEnvelopeHash, hash(economicPage(x.page)));
    for (const artifact of receipt.artifacts) { assert.equal(artifact.contentHash, digest(artifact.content)); assert.equal(artifact.byteLength, Buffer.byteLength(artifact.content)); }
    const doc = document(receipt);
    const names = { expense: 'expense', grossSales: 'gross_sales', netSales: 'net_sales', directCosts: 'direct_costs', contribution: 'contribution', cashReceipts: 'cash_receipts', cashPayouts: 'cash_payouts' };
    for (const currency of x.page.summary.currencies) for (const [key, name] of Object.entries(names)) {
      const source = currency.metrics[key]; const exported = metric(doc, name, currency.currency);
      assert.deepEqual({ status: exported.status, knownSubtotal: exported.knownSubtotal, total: exported.total, unknownCount: exported.unknownCount }, source);
    }
    assert.equal(JSON.stringify(receipt).includes(x.scope.tenantId), false);
    receipts.push({ query: { snapshotId: x.page.snapshotId, queryContentHash: x.page.queryContentHash, summaryContentHash: x.page.summaryContentHash }, receipt });
    return receipt;
  }
  try {
    assertDisposableMarker((await admin.query('SELECT marker FROM ci_test.disposable_database_marker')).rows);
    await run('v2 aggregate first page with hasMore exports every metric exactly; continuation conflicts', async () => {
      const x = await setup(); assert.equal(x.page.hasMore, true);
      const receipt = await prepare(x); const doc = document(receipt);
      assert.equal(metric(doc, 'expense').knownSubtotal, '6'); assert.equal(metric(doc, 'direct_costs').knownSubtotal, '1');
      assert.equal(metric(doc, 'cash_receipts').total, null);
      const continuation = await checked(finance.querySummaryV2({ ...x.q, snapshotId: x.page.snapshotId, cursor: x.page.nextCursor }, x.host.ports));
      assert.equal((await finance.exportSummaryV2(exportRequest(continuation, x.scope, { idempotencyKey: 'continuation' }), x.ports)).error.code, 'IDEMPOTENCY_CONFLICT');
      const replay = structuredClone(x.request); replay.requestedBy = 'untrusted changed label'; replay.requestId = 'other-transport'; replay.summarySnapshot.requestId = 'other-query-transport';
      assert.deepEqual(await finance.getPreparedExportArtifacts(replay, x.ports), { ok: true, value: receipt });
      assert.equal((await finance.exportSummaryV2({ ...x.request, format: 'csv' }, x.ports)).error.code, 'IDEMPOTENCY_CONFLICT');
      x.host.state.clock = '2026-10-12T22:01:00.000Z';
      const restarted = finance.createReportingExportRuntimePorts(x.host.ports, finance.createFileExportArtifactStore(x.storeOptions), finance.createFileReportingExportArtifactStore(x.storeOptions), x.host.fence);
      assert.deepEqual(await finance.getPreparedExportArtifacts(x.request, restarted), { ok: true, value: receipt });
      const another = await checked(finance.exportSummaryV2({ ...x.request, idempotencyKey: 'second-preparation' }, restarted));
      assert.deepEqual(another.artifacts, receipt.artifacts); assert.equal(another.manifest.artifactSetHash, receipt.manifest.artifactSetHash);
      assert.notEqual(another.manifest.createdAt, receipt.manifest.createdAt);
    });
    await run('legacy UUID single-currency first-page reader and public export preserve exact canonical hash', async () => {
      const x = await setup(); const q = { ...x.q, schemaVersion: '1.0.0', filters: { ...x.q.filters, currency: 'USD' } }; delete q.policyVersion; delete q.groupings;
      const page = await checked(finance.querySummary(q, x.host.ports)); assert.equal(page.hasMore, true);
      const verified = await finance.createReportingSnapshotReader(x.host.ports).readVerifiedSnapshot({ scope: x.scope, snapshotId: page.snapshotId, queryContentHash: page.queryContentHash, summaryContentHash: page.summaryContentHash });
      assert.deepEqual(economicPage(verified), economicPage(page));
      const receipt = await checked(finance.exportSummaryV2(exportRequest(page, x.scope), x.ports));
      assert.equal(receipt.manifest.summaryContentHash, page.summaryContentHash);
      assert.equal(receipt.artifactManifest.compatibility.adoption, 'proposal_only');
      assert.equal(JSON.parse(receipt.artifacts[0].content).metrics.find(row => row.metric === 'expense').status, 'unknown');
      const continuation = await checked(finance.querySummary({ ...q, snapshotId: page.snapshotId, cursor: page.nextCursor }, x.host.ports));
      assert.equal((await finance.exportSummary(exportRequest(continuation, x.scope, { idempotencyKey: 'legacy-continuation' }), x.ports)).error.code, 'IDEMPOTENCY_CONFLICT');
      receipts.push({ query: { snapshotId: page.snapshotId, queryContentHash: page.queryContentHash, summaryContentHash: page.summaryContentHash }, receipt });
    });
    await run('Q1 cash movement does not reduce recognized expense or budget expense', async () => {
      const s = fixtureScope(); const x = await setup(s, [posting(s, 'expense'), posting(s, 'payment', { eventType: 'cash_movement', classification: 'operating_expense', amount: '-5' })]);
      const doc = document(await prepare(x)); assert.equal(metric(doc, 'expense').knownSubtotal, '1'); assert.equal(metric(doc, 'cash_payouts').knownSubtotal, '5'); assert.equal(doc.budgets[0].ledgerExpense, '1');
    });
    await run('Q2 unknown simulation stays null and actual paid test spend is separate', async () => {
      const s = fixtureScope({ billingMode: 'simulated' }); const x = await setup(s, [posting(s, 'unknown-sim', { amount: null }), posting(s, 'sale-sim', { eventType: 'revenue', classification: 'sale', amount: '20' })]);
      const receipt = await prepare(x); const doc = document(receipt); const unknown = metric(doc, 'expense', 'USD', 'simulated');
      assert.deepEqual({ status: unknown.status, knownSubtotal: unknown.knownSubtotal, total: unknown.total, unknownCount: unknown.unknownCount }, { status: 'unknown', knownSubtotal: null, total: null, unknownCount: 1 });
      assert.equal(metric(doc, 'gross_sales', 'USD', 'simulated').knownSubtotal, '20'); assert.equal(metric(doc, 'gross_sales').total, null);
      assert.match(receipt.artifacts[1].content, /expense,simulated,[^\r\n]*,unknown,,,1,/);
      const live = { ...s, billingMode: 'live' }; const y = await setup(live, [posting(live, 'paid-test', { amount: '2' })]);
      assert.equal(metric(document(await prepare(y)), 'expense').knownSubtotal, '2');
      assert.equal(metric(document(await prepare(x)), 'expense').knownSubtotal, null);
    });
    await run('Q3 corrected cash receipt and frozen historical snapshot retain 7 and 5 respectively', async () => {
      const s = fixtureScope(); const original = posting(s, 'cash', { eventType: 'cash_movement', classification: 'operating_revenue', amount: '5' });
      const x = await setup(s, [original]); assert.equal(metric(document(await prepare(x)), 'cash_receipts').knownSubtotal, '5');
      x.host.state.clock = '2026-10-12T22:01:00.000Z';
      const correction = posting(s, 'corrected', { eventType: 'correction', classification: 'operating_revenue', amount: '7', subject: 'cash', revision: 1, supersedes: original.eventId });
      await checked(finance.appendLedgerEvent(correction, x.host.ports));
      const latest = await checked(finance.querySummaryV2(x.q, x.host.ports));
      const y = { ...x, page: latest, request: exportRequest(latest, s, { idempotencyKey: 'corrected' }) };
      assert.equal(metric(document(await prepare(y)), 'cash_receipts').knownSubtotal, '7');
      assert.equal(metric(document(await prepare(x)), 'cash_receipts').knownSubtotal, '5');
    });
    await run('estimated expense corrected by confirmed amount exports fresh and original snapshot axes exactly', async () => {
      const s = fixtureScope(); const original = posting(s, 'estimated', { amount: '1.25', valuation: 'estimated' });
      const x = await setup(s, [original]); const first = document(await prepare(x));
      assert.equal(metric(first, 'expense').knownSubtotal, '1.25'); assert.equal(first.currencies[0].expenseValuation.estimated.knownSubtotal, '1.25');
      x.host.state.clock = '2026-10-12T22:01:00.000Z';
      await checked(finance.appendLedgerEvent(posting(s, 'confirmed', { eventType: 'correction', subject: 'estimated', amount: '1.5', revision: 1, supersedes: original.eventId }), x.host.ports));
      const page = await checked(finance.querySummaryV2(x.q, x.host.ports));
      const current = document(await prepare({ ...x, page, request: exportRequest(page, s, { idempotencyKey: 'confirmed' }) }));
      assert.equal(metric(current, 'expense').knownSubtotal, '1.5'); assert.equal(current.currencies[0].expenseValuation.confirmed.knownSubtotal, '1.5');
      assert.equal(metric(document(await prepare(x)), 'expense').knownSubtotal, '1.25');
    });
    await run('cash correction reversal lineage is validated at FINAL append boundary and exports exact 6', async () => {
      for (const [classification, initial, corrected, reversal, restore, name] of [['operating_revenue', '5', '7', '-2', '1', 'cash_receipts'], ['operating_expense', '-5', '-7', '2', '-1', 'cash_payouts'], ['payout_transfer', '5', '7', '-2', '1', 'cash_payouts']]) {
        const s = fixtureScope(); const original = posting(s, 'cash', { eventType: 'cash_movement', classification, amount: initial });
        const correction = posting(s, 'corrected', { eventType: 'correction', classification, amount: corrected, subject: 'cash', supersedes: original.eventId, revision: 1 });
        const reverse = posting(s, 'reversed', { eventType: 'reversal', classification, amount: reversal, subject: 'cash', lineageSuffix: '-reverse', reverses: correction.eventId });
        const restored = posting(s, 'restored', { eventType: 'reversal', classification, amount: restore, subject: 'cash', lineageSuffix: '-restore', reverses: reverse.eventId });
        const x = await setup(s, [original, correction, reverse, restored]); const doc = document(await prepare(x));
        assert.equal(metric(doc, name).knownSubtotal, '6'); assert.equal(doc.budgets[0].ledgerExpense, '0'); assert.equal(x.page.summary.coverage.unsupportedEventCount, 0);
      }
    });
    await run('opaque scopes and tiny mixed currencies export explicit separate blocks without fabricated UUIDs', async () => {
      const s = fixtureScope({ tenantId: 'opaque-export-tenant', projectId: 'opaque-export-project' });
      const x = await setup(s, [posting(s, 'tiny', { amount: '0.000000000000000001' }), posting(s, 'eur', { amount: '2', currency: 'EUR' })]);
      const receipt = await prepare(x); const doc = document(receipt);
      assert.deepEqual(x.page.canonicalSummaries, []); assert.equal(doc.provenance.canonicalMappingStatus, 'unsupported_opaque_scope');
      assert.equal(metric(doc, 'expense', 'USD').knownSubtotal, '0.000000000000000001'); assert.equal(metric(doc, 'expense', 'EUR').knownSubtotal, '2');
    });
    await run('current grant, tenant/project/environment/billing scope and revocation precede lookup/source/replay', async () => {
      const x = await setup(); await prepare(x);
      for (const permission of ['denyRead', 'denyExport']) { x.host.state[permission] = true; assert.equal((await finance.getPreparedExportArtifacts(x.request, x.ports)).ok, false); x.host.state[permission] = false; }
      for (const [key, value] of [['tenantId', 'foreign-tenant'], ['projectId', 'foreign-project'], ['actorId', 'foreign-actor'], ['environment', 'production'], ['billingMode', 'simulated']]) {
        const reads = x.host.state.reads; const changed = structuredClone(x.request); changed.scope[key] = value;
        assert.equal((await finance.exportSummaryV2(changed, x.ports)).error.code, 'SOURCE_UNAVAILABLE'); assert.equal(x.host.state.reads, reads);
      }
      const store = finance.createFileReportingExportArtifactStore(x.storeOptions);
      const verify = store.verifyOriginal; store.verifyOriginal = async (...args) => { const valid = await verify(...args); x.host.state.denied = true; return valid; };
      const revoked = finance.createReportingExportRuntimePorts(x.host.ports, finance.createFileExportArtifactStore(x.storeOptions), store, x.host.fence);
      assert.equal((await finance.getPreparedExportArtifacts(x.request, revoked)).error.code, 'FORBIDDEN_SCOPE');
      for (const version of ['1.0.0', '2.0.0']) for (const replay of [false, true]) for (const denied of ['denyRead', 'denyExport']) {
        const current = await setup(); let page = current.page;
        if (version === '1.0.0') {
          const legacy = { ...current.q, schemaVersion: version, filters: { ...current.q.filters, currency: 'USD' } }; delete legacy.policyVersion; delete legacy.groupings;
          page = await checked(finance.querySummary(legacy, current.host.ports));
        }
        const request = exportRequest(page, current.scope);
        const legacyStore = finance.createFileExportArtifactStore(current.storeOptions);
        const richStore = finance.createFileReportingExportArtifactStore(current.storeOptions);
        const selected = version === '1.0.0' ? legacyStore : richStore;
        const ports = finance.createReportingExportRuntimePorts(current.host.ports, legacyStore, richStore, current.host.fence);
        const first = replay ? await checked(finance.exportSummaryV2(request, ports)) : null;
        const originalVerification = selected.verifyOriginal; let triggered = false;
        selected.verifyOriginal = async (...args) => {
          const original = await originalVerification(...args); assert.equal(original, true, 'real filesystem original receipt authenticated before grant revocation');
          if (!triggered) { current.host.state[denied] = true; triggered = true; }
          return original;
        };
        const response = await (replay ? finance.getPreparedExportArtifacts : finance.exportSummaryV2)(request, ports);
        assert.equal(triggered, true); assert.equal(response.ok, false); assert.equal(response.error.code, 'FORBIDDEN_SCOPE');
        current.host.state[denied] = false;
        const control = await checked(finance.getPreparedExportArtifacts(request, ports));
        if (first) assert.deepEqual(control, first);
        else assert.equal(control.manifest.createdAt, '2026-10-12T22:00:00.000Z');
      }
      for (const version of ['1.0.0', '2.0.0']) for (const replay of [false, true]) for (const context of ['null', 'foreign']) {
        const current = await setup(); let page = current.page;
        if (version === '1.0.0') {
          const legacy = { ...current.q, schemaVersion: version, filters: { ...current.q.filters, currency: 'USD' } }; delete legacy.policyVersion; delete legacy.groupings;
          page = await checked(finance.querySummary(legacy, current.host.ports));
        }
        const request = exportRequest(page, current.scope);
        const legacyStore = finance.createFileExportArtifactStore(current.storeOptions), richStore = finance.createFileReportingExportArtifactStore(current.storeOptions);
        const selected = version === '1.0.0' ? legacyStore : richStore;
        const ports = finance.createReportingExportRuntimePorts(current.host.ports, legacyStore, richStore, current.host.fence);
        const first = replay ? await checked(finance.exportSummaryV2(request, ports)) : null;
        const verify = selected.verifyOriginal; let triggered = false;
        selected.verifyOriginal = async (...args) => {
          const original = await verify(...args); assert.equal(original, true);
          if (!triggered) { current.host.controller.setContext(context === 'null' ? 'absent' : 'present', { ...current.scope, projectId: 'foreign-context-project' }); triggered = true; }
          return original;
        };
        const response = await (replay ? finance.getPreparedExportArtifacts : finance.exportSummaryV2)(request, ports);
        assert.equal(triggered, true); assert.equal(response.ok, false); assert.equal(response.error.code, 'FORBIDDEN_SCOPE');
        assert.equal(current.host.state.denyRead, false); assert.equal(current.host.state.denyExport, false);
        current.host.controller.setContext('present', current.scope);
        const control = await checked(finance.getPreparedExportArtifacts(request, ports));
        if (first) assert.deepEqual(control, first); else assert.equal(control.manifest.createdAt, '2026-10-12T22:00:00.000Z');
      }

      // F3: real stored receipt verification followed by governed context-await revocation.
      for (const version of ['1.0.0', '2.0.0']) for (const replay of [false, true]) for (const permission of ['finance.summary.read', 'finance.summary.export']) {
        const current = await setup(); let page = current.page;
        if (version === '1.0.0') { const q = { ...current.q, schemaVersion: version, filters: { ...current.q.filters, currency: 'USD' } }; delete q.policyVersion; delete q.groupings; page = await checked(finance.querySummary(q, current.host.ports)); }
        const request = exportRequest(page, current.scope);
        const legacyStore = finance.createFileExportArtifactStore(current.storeOptions), richStore = finance.createFileReportingExportArtifactStore(current.storeOptions);
        const selected = version === '1.0.0' ? legacyStore : richStore;
        const ports = finance.createReportingExportRuntimePorts(current.host.ports, legacyStore, richStore, current.host.fence);
        const first = replay ? await checked(finance.exportSummaryV2(request, ports)) : null;
        const verify = selected.verifyOriginal; let verified = false, waited = false;
        selected.verifyOriginal = async (...args) => { const original = await verify(...args); assert.equal(original, true); verified = true; current.host.controller.onBoundary('context.resolve', async controller => { await Promise.resolve(); waited = true; controller.setGrant(permission, 'denied'); }); return original; };
        const result = await (replay ? finance.getPreparedExportArtifacts : finance.exportSummaryV2)(request, ports);
        assert.equal(verified, true); assert.equal(waited, true); assert.equal(result.ok, false); assert.equal(result.error.code, 'FORBIDDEN_SCOPE'); assert.equal(Object.hasOwn(result, 'value'), false);
        selected.verifyOriginal = verify; current.host.controller.setGrant(permission, 'allowed');
        let positiveWaited = false;
        selected.verifyOriginal = async (...args) => { const original = await verify(...args); assert.equal(original, true); current.host.controller.onBoundary('context.resolve', async () => { await Promise.resolve(); positiveWaited = true; }); return original; };
        const control = await checked(finance.getPreparedExportArtifacts(request, ports)); assert.equal(positiveWaited, true); if (first) assert.deepEqual(control, first); else assert.equal(control.manifest.createdAt, '2026-10-12T22:00:00.000Z');
      }

    });
  } finally {
    await mkdir(new URL('../../artifacts/exports/', import.meta.url), { recursive: true });
    await writeFile(new URL('../../artifacts/exports/postgres-composition.json', import.meta.url), JSON.stringify({ fixtureMode: 'real_disposable_postgresql_synthetic_financial_postings', producer: PRODUCER, consumerAcknowledgement: 'pending', actualProviderCharges: 'not_tested', failures, receipts }, null, 2) + '\n');
    await pool.end(); await admin.end(); await rm(directory, { recursive: true, force: true });
  }
});
