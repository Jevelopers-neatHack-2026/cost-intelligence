import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import * as finance from '../../dist/index.js';
import { suitePlan } from '../../scripts/suite-policy.mjs';
import { fixtureScope, posting, query, exportRequest, checked, hostPorts, syntheticSqlPort, hash } from './query-export-fixtures.mjs';

function memoryStore() {
  const records = new Map(); const originals = new Map(); const state = { reads: 0, writes: 0 };
  return { state, records, async lookup(key) { state.reads++; return records.get(key) ?? null; },
    async commitImmutable(key, record) { state.writes++; if (!records.has(key)) { records.set(key, structuredClone(record)); originals.set(key, hash(record)); } return records.get(key); },
    async verifyOriginal(key, record) { return originals.get(key) === hash(record); } };
}
async function setup(scope = fixtureScope(), options = {}) {
  const payloads = options.payloads ?? [posting(scope, 'expense', { amount: '1', valuation: 'estimated', dimensions: { provider: 'provider-canary-identifier' } }), posting(scope, 'operating', { amount: '5', classification: 'operating_expense' })];
  const sql = syntheticSqlPort(scope, payloads); const host = hostPorts(scope, sql);
  const legacyStore = memoryStore(); const store = memoryStore();
  const ports = finance.createReportingExportRuntimePorts(host.ports, legacyStore, store, host.fence);
  const q = query(scope); const page = await checked(finance.querySummaryV2(q, host.ports));
  return { scope, payloads, sql, host, legacyStore, store, ports, q, page, request: exportRequest(page, scope) };
}
function document(receipt) { return JSON.parse(receipt.artifacts.find(artifact => artifact.fileName === 'summary.json').content); }
function metric(doc, name, currency = 'USD', recognition = 'actual') { return doc.currencies.find(row => row.currency === currency)[recognition === 'actual' ? 'metrics' : 'simulated'].find(row => row.metric === name); }
const digest = content => 'sha256:' + createHash('sha256').update(content).digest('hex');

test('pinned definition artifact bodies are independently verified, private and unchanged by query responses', async () => {
  const bytes = await readFile(new URL('../../fixtures/reporting/definition-registry.json', import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), '577ce8801855db08ba393f115c00ac670df3a47a5cc9e9a5a78f8b0132cb34e1');
  assert.equal(hash(JSON.parse(bytes)), finance.REPORTING_EXPORT_REGISTRY_PIN);
  const x = await setup();
  try { x.page.canonicalSummaries[0].metrics.expense.definition_ref.content_hash = digest('foreign-reference'); } catch {}
  assert.equal(hash(finance.REPORTING_CANONICAL_REFERENCE_REGISTRY), finance.REPORTING_EXPORT_REGISTRY_PIN);
});

test('public query-to-verified-reader-to-export composition preserves rich amounts and aggregate first page using a synthetic SQL port', async () => {
  const x = await setup(); assert.equal(x.page.hasMore, true);
  const result = await checked(finance.exportSummaryV2(x.request, x.ports)); const doc = document(result);
  assert.equal(metric(doc, 'expense').knownSubtotal, '6');
  assert.equal(metric(doc, 'direct_costs').knownSubtotal, '1', 'expense does not get relabelled as direct cost');
  assert.equal(metric(doc, 'expense').total, null);
  assert.equal(metric(doc, 'cash_receipts').knownSubtotal, null); assert.equal(metric(doc, 'cash_receipts').total, null);
  assert.equal(doc.sourceEvidenceStatus, 'not_exposed_by_query');
  assert.equal(result.manifest.projectionContentHash, x.page.summaryContentHash);
  assert.equal(result.manifest.snapshotId, x.page.snapshotId);
  assert.equal(doc.provenance.queryContentHash, x.page.queryContentHash);
  assert.equal(JSON.stringify(result).includes('provider-canary-identifier'), false);
  assert.equal(JSON.stringify(result).includes(x.scope.tenantId), false);
  assert.equal(JSON.stringify(result).includes('PRIVATE_NOT_AUTHORITY'), false);
  for (const artifact of result.artifacts) assert.equal(artifact.contentHash, digest(artifact.content));
  const continuation = await checked(finance.querySummaryV2({ ...x.q, snapshotId: x.page.snapshotId, cursor: x.page.nextCursor }, x.host.ports));
  assert.equal((await finance.exportSummaryV2(exportRequest(continuation, x.scope, { idempotencyKey: 'continuation' }), x.ports)).error.code, 'IDEMPOTENCY_CONFLICT');
  const retry = structuredClone(x.request); retry.requestId = 'changed-transport'; retry.requestedBy = 'changed-label'; retry.summarySnapshot.requestId = 'changed-query-transport';
  assert.deepEqual(await finance.getPreparedExportArtifacts(retry, x.ports), { ok: true, value: result });
  x.host.state.clock = '2026-10-12T22:01:00.000Z';
  const another = await checked(finance.exportSummaryV2({ ...x.request, idempotencyKey: 'another-preparation' }, x.ports));
  assert.deepEqual(another.artifacts, result.artifacts); assert.notEqual(another.manifest.createdAt, result.manifest.createdAt);
  assert.equal(another.manifest.artifactSetHash, result.manifest.artifactSetHash);
  const changed = { ...x.request, format: 'csv' };
  assert.equal((await finance.exportSummaryV2(changed, x.ports)).error.code, 'IDEMPOTENCY_CONFLICT');
  await mkdir(new URL('../../artifacts/exports/', import.meta.url), { recursive: true });
  await writeFile(new URL('../../artifacts/exports/synthetic-sql-composition.json', import.meta.url), JSON.stringify({ fixtureMode: 'synthetic_sql_port_only_NOT_POSTGRESQL', producer: '22a3237dd44f376017969ac881586ff396f19cf8', query: { snapshotId: x.page.snapshotId, queryContentHash: x.page.queryContentHash, summaryContentHash: x.page.summaryContentHash }, receipt: result }, null, 2));
});

test('legacy canonical export uses the genuine composed reader and supports aggregate first pages with hasMore', async () => {
  const x = await setup(); const legacyQuery = { ...x.q, schemaVersion: '1.0.0', filters: { ...x.q.filters, currency: 'USD' } }; delete legacyQuery.policyVersion; delete legacyQuery.groupings;
  const page = await checked(finance.querySummary(legacyQuery, x.host.ports)); assert.equal(page.hasMore, true);
  const prepared = await checked(finance.exportSummaryV2(exportRequest(page, x.scope), x.ports));
  assert.equal(prepared.manifest.summaryContentHash, page.summaryContentHash);
  assert.equal(prepared.artifactManifest.compatibility.adoption, 'proposal_only');
  assert.equal(JSON.parse(prepared.artifacts[0].content).metrics.find(row => row.metric === 'expense').definition, finance.REPORTING_CANONICAL_REFERENCE_REGISTRY.metrics.expense.definition.formula);
  const continuation = await checked(finance.querySummary({ ...legacyQuery, snapshotId: page.snapshotId, cursor: page.nextCursor }, x.host.ports));
  assert.equal((await finance.exportSummary(exportRequest(continuation, x.scope, { idempotencyKey: 'legacy-continuation' }), x.ports)).error.code, 'IDEMPOTENCY_CONFLICT');
});

test('opaque Finance scope and mixed currencies remain explicit v2 blocks with exact source amounts', async () => {
  const s = fixtureScope({ tenantId: 'opaque-tenant-fixture', projectId: 'opaque-project-fixture' });
  const x = await setup(s, { payloads: [posting(s, 'tiny', { amount: '0.000000000000000001' }), posting(s, 'eur', { amount: '2', currency: 'EUR' })] });
  assert.deepEqual(x.page.canonicalSummaries, []);
  const result = await checked(finance.exportSummaryV2(x.request, x.ports)); const doc = document(result);
  assert.equal(metric(doc, 'expense', 'USD').knownSubtotal, '0.000000000000000001'); assert.equal(metric(doc, 'expense', 'EUR').knownSubtotal, '2');
  assert.deepEqual(new Set(result.manifest.currencies), new Set(['USD', 'EUR']));
  assert.equal(doc.provenance.canonicalMappingStatus, 'unsupported_opaque_scope');
  assert.equal(Object.hasOwn(result.manifest, 'summaryId'), false, 'opaque authority IDs never become fake canonical UUIDs');
});

test('cash movement, corrected cash and unknown simulation export source truth with separate axes', async () => {
  const s = fixtureScope(); const x = await setup(s, { payloads: [posting(s, 'actual', { amount: '1' }), posting(s, 'cash', { eventType: 'cash_movement', classification: 'operating_expense', amount: '-5' })] });
  const doc = document(await checked(finance.exportSummaryV2(x.request, x.ports)));
  assert.equal(metric(doc, 'expense').knownSubtotal, '1'); assert.equal(metric(doc, 'cash_payouts').knownSubtotal, '5'); assert.equal(doc.budgets[0].ledgerExpense, '1');
  const receipt = posting(s, 'receipt', { eventType: 'cash_movement', classification: 'operating_revenue', amount: '5' });
  const corrected = posting(s, 'corrected', { eventType: 'correction', classification: 'operating_revenue', amount: '7', subject: 'receipt', supersedes: receipt.eventId, revision: 1 });
  const y = await setup(s, { payloads: [receipt, corrected] });
  assert.equal(metric(document(await checked(finance.exportSummaryV2(y.request, y.ports))), 'cash_receipts').knownSubtotal, '7');
  const simulated = fixtureScope({ billingMode: 'simulated' }); const z = await setup(simulated, { payloads: [posting(simulated, 'unknown', { amount: null })] });
  const exportUnknown = await checked(finance.exportSummaryV2(z.request, z.ports)); const unknown = metric(document(exportUnknown), 'expense', 'USD', 'simulated');
  assert.deepEqual({ status: unknown.status, knownSubtotal: unknown.knownSubtotal, total: unknown.total, unknownCount: unknown.unknownCount }, { status: 'unknown', knownSubtotal: null, total: null, unknownCount: 1 });
  assert.match(exportUnknown.artifacts[1].content, /expense,simulated,[^\r\n]*,unknown,,,1,/);
});

test('both current read and export permissions are required and rechecked before returning source artifacts', async () => {
  for (const permission of ['denyRead', 'denyExport']) {
    const x = await setup(); x.host.state[permission] = true;
    const previousWrites = x.store.state.writes;
    const result = await finance.exportSummaryV2(x.request, x.ports); assert.equal(result.ok, false);
    assert.equal(x.store.state.writes, previousWrites);
  }
  const x = await setup(); const original = x.store.commitImmutable;
  x.store.commitImmutable = async (...args) => { const stored = await original(...args); x.host.state.denied = true; return stored; };
  assert.equal((await finance.exportSummaryV2(x.request, x.ports)).error.code, 'FORBIDDEN_SCOPE');
  const foreign = await setup(); const changed = structuredClone(foreign.request); changed.scope.projectId = 'foreign-project';
  const reads = foreign.host.state.reads; assert.equal((await finance.exportSummaryV2(changed, foreign.ports)).error.code, 'SOURCE_UNAVAILABLE'); assert.equal(foreign.host.state.reads, reads);
});

test('v2 filesystem artifact receipt persists exact bytes and preparation time across adapter restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ci08x-v2-artifacts-'));
  try {
    const x = await setup(); const options = { directory, receiptKey: new Uint8Array(32).fill(63) };
    const ports = finance.createReportingExportRuntimePorts(x.host.ports, x.legacyStore, finance.createFileReportingExportArtifactStore(options), x.host.fence);
    const first = await checked(finance.exportSummaryV2(x.request, ports));
    x.host.state.clock = '2026-10-12T22:01:00.000Z';
    const restarted = finance.createReportingExportRuntimePorts(x.host.ports, x.legacyStore, finance.createFileReportingExportArtifactStore(options), x.host.fence);
    assert.deepEqual(await finance.getPreparedExportArtifacts(x.request, restarted), { ok: true, value: first });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('PostgreSQL export selector is explicit and fails closed without weakening existing suites', () => {
  const existing = new Set(['tests/exports/public-exports.test.mjs', 'tests/exports/csv-encoding.test.mjs', 'tests/exports/query-export-pg.test.mjs']);
  assert.deepEqual(suitePlan('exports', existing).selectedFiles, ['tests/exports/public-exports.test.mjs', 'tests/exports/csv-encoding.test.mjs']);
  assert.deepEqual(suitePlan('exports', existing, 'postgres').selectedFiles, ['tests/exports/query-export-pg.test.mjs']);
  assert.deepEqual(suitePlan('exports', existing, 'postgres,unknown').selectedFiles, []);
  assert.ok(suitePlan('exports', existing, 'postgres,unknown').selectorErrors.length);
  assert.deepEqual(suitePlan('exports', existing, '').selectedFiles, []);
  assert.deepEqual(suitePlan('exports', new Set(), 'postgres').missingFiles, ['tests/exports/query-export-pg.test.mjs']);
});

test('v2 shared adapter mutation after authentication cannot change creation or replay bytes', async () => {
  for (const replay of [false, true]) {
    const x = await setup(); let first;
    if (replay) first = await checked(finance.exportSummaryV2(x.request, x.ports));
    let verified = false; let shared;
    const verify = x.store.verifyOriginal;
    x.store.verifyOriginal = async (key, value) => { const valid = await verify(key, value); shared = x.store.records.get(key); verified = true; x.host.controller.onBoundary('authority.export', () => {
      if (verified) {
        shared.prepared.artifacts[0].content += 'PRIVATE_MUTATION_CANARY';
        shared.prepared.manifest.createdAt = '2030-01-01T00:00:00.000Z';
      }
    }); return valid; };
    const result = await checked(finance.exportSummaryV2(x.request, x.ports));
    assert.equal(JSON.stringify(result).includes('PRIVATE_MUTATION_CANARY'), false);
    assert.equal(result.manifest.createdAt, '2026-10-12T22:00:00.000Z');
    assert.notEqual(result.artifacts[0].content, shared.prepared.artifacts[0].content);
    for (const artifact of result.artifacts) assert.equal(artifact.contentHash, digest(artifact.content));
    if (replay) assert.deepEqual(result, first);
  }
  const control = await setup(); const positive = await checked(finance.exportSummaryV2(control.request, control.ports));
  assert.deepEqual(await finance.getPreparedExportArtifacts(control.request, control.ports), { ok: true, value: positive });
});

test('v2 uncertain commit acknowledgement retries exact original; substituted receipts fail closed', async () => {
  const x = await setup(); const commit = x.store.commitImmutable; let uncertain = true;
  x.store.commitImmutable = async (...args) => { const original = await commit(...args); if (uncertain) { uncertain = false; throw new Error('PRIVATE_ACK_FAILURE'); } return original; };
  const failed = await finance.exportSummaryV2(x.request, x.ports); assert.equal(failed.error.code, 'SOURCE_UNAVAILABLE'); assert.equal(JSON.stringify(failed).includes('PRIVATE_ACK_FAILURE'), false);
  const original = structuredClone([...x.store.records.values()][0].prepared);
  x.host.state.clock = '2026-10-12T22:01:00.000Z';
  assert.deepEqual(await finance.exportSummaryV2(x.request, x.ports), { ok: true, value: original });
  assert.equal(x.store.state.writes, 1);
  const y = await setup(); const realCommit = y.store.commitImmutable;
  y.store.commitImmutable = async (...args) => {
    const record = structuredClone(await realCommit(...args)); record.prepared.manifest.projectionContentHash = digest('other-source'); return record;
  };
  assert.equal((await finance.exportSummaryV2(y.request, y.ports)).error.code, 'SOURCE_UNAVAILABLE');
});

test('v2 combined schema boundary rejects nested canonical semantic corruption and identifies partial schema', async () => {
  const x = await setup(); assert.equal(finance.validateReportingExportRequestBoundary(x.request).ok, true);
  const invalid = structuredClone(x.request); invalid.summarySnapshot.canonicalSummaries[0].completeness = 'complete';
  assert.equal(finance.validateReportingExportRequestBoundary(invalid).ok, false);
  const schema = JSON.parse(await readFile(new URL('../../schemas/cost-intelligence/2.0.0/integrations/ReportingExportRequestSchema.json', import.meta.url)));
  assert.equal(schema['x-schema-completeness'], 'partial_wrapper_requires_combined_validation');
  assert.equal(schema['x-combined-validator'], 'validateReportingExportRequestBoundary');
  const huge = structuredClone(x.request); huge.requestedBy = 'PRIVATE_TOO_LARGE'.repeat(100000);
  assert.equal((await finance.exportSummaryV2(huge, x.ports)).error.code, 'VALIDATION_ERROR');
  assert.equal(x.store.state.reads, 0);
});

test('cash lineage fixtures validate the final source posting identity and reject the original invalid mutation', async () => {
  const s = fixtureScope();
  const original = posting(s, 'cash', { eventType: 'cash_movement', classification: 'operating_revenue', amount: '5' });
  const reversal = posting(s, 'reverse', { eventType: 'reversal', classification: 'operating_revenue', amount: '-2', subject: 'cash', lineageSuffix: '-reverse', reverses: original.eventId });
  assert.equal(finance.validateLedgerAppendRequestBoundary(reversal).ok, true);
  const invalid = structuredClone(reversal); invalid.sourceIdentity.revisionSubjectId += '-invalid';
  assert.equal(finance.validateLedgerAppendRequestBoundary(invalid).ok, false, 'postingMapping.sourceLineId must match final revisionSubjectId');
});

test('v2 racing immutable commit returns authenticated first preparation time with unchanged deterministic bytes', async () => {
  const x = await setup(); const first = await checked(finance.exportSummaryV2(x.request, x.ports));
  x.host.state.clock = '2026-10-12T22:01:00.000Z';
  // Emulate a lookup completed before another preparation won the atomic commit.
  x.store.lookup = async () => null;
  const second = await checked(finance.exportSummaryV2(x.request, x.ports));
  assert.deepEqual(second, first);
  assert.equal(x.store.state.writes, 2);
  assert.equal(second.manifest.createdAt, '2026-10-12T22:00:00.000Z');
});

test('v2 request scope is immutable before asynchronous adapter and authority callbacks', async () => {
  const x = await setup(); const lookup = x.store.lookup;
  x.store.lookup = async (...args) => { const found = await lookup(...args); x.request.scope.projectId = 'mutated-project'; x.host.state.denied = true; return found; };
  assert.equal((await finance.exportSummaryV2(x.request, x.ports)).error.code, 'FORBIDDEN_SCOPE'); assert.equal(x.store.state.writes, 0);
  const y = await setup(); const authorize = y.host.ports.financeAuthority.authorizeCurrent;
  y.host.ports.financeAuthority.authorizeCurrent = async request => { request.requestedScope.projectId = 'mutated-authority'; return authorize(request); };
  assert.equal((await finance.exportSummaryV2(y.request, y.ports)).error.code, 'SOURCE_UNAVAILABLE'); assert.equal(y.store.state.reads, 0);
});
