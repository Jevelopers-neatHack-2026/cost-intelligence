import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const api = await import(pathToFileURL(join(root, 'dist/integrations/index.js')).href);
const fixture = JSON.parse(await readFile(join(root, 'fixtures/exports/synthetic-snapshot-summary.json'), 'utf8'));
assert.equal(fixture.fixtureMode, 'synthetic_only');
const digest = content => 'sha256:' + createHash('sha256').update(content).digest('hex');

function setup(overrides = {}) {
  const summary = structuredClone(fixture.summary);
  const scope = { tenantId: summary.tenant_id, projectId: summary.project_id, environment: summary.environment, billingMode: summary.billing_mode, actorId: 'synthetic-exporter' };
  const summaryContentHash = api.hashExportCanonical(summary);
  const page = {
    schemaVersion: '1.0.0', requestId: 'query-transport-metadata', snapshotId: 'PRIVATE_SNAPSHOT_CANARY',
    queryContentHash: api.hashExportCanonical({ syntheticQuery: true, scope }), asOf: '2026-10-10T12:00:00Z', timezone: 'UTC',
    watermark: { watermarkId: 'PRIVATE_WATERMARK_CANARY', capturedAt: '2026-10-10T12:00:00Z', sources: [{ source: 'ledger', revision: 'PRIVATE_REVISION_CANARY', observedThrough: '2026-10-10T12:00:00Z', contentHash: digest('synthetic-ledger'), completeness: 'partial' }] },
    filters: { environments: ['test'], billingModes: ['simulated'], currency: 'USD' }, summaryContentHash, summary, hasMore: false, nextCursor: null,
  };
  const request = { schemaVersion: '1.0.0', requestId: 'PRIVATE_REQUEST_CANARY', idempotencyKey: 'synthetic-export-1', scope, summarySnapshot: structuredClone(page), summaryContentHash, destination: 'cfo.ai', format: 'json', requestedAt: '2026-10-10T12:00:01Z', evidenceMode: 'mocked', requestedBy: 'PRIVATE_ACTOR_LABEL_CANARY' };
  const calls = { lookup: 0, source: 0, store: 0, verify: 0, auth: 0 };
  let stored = null;
  let originalStoreHash = null;
  let now = new Date('2026-10-10T13:00:00Z');
  const clock = { now: () => new Date(now) };
  const ports = {
    clock, storage: { isAvailable: async () => true }, providerSource: { isAvailable: async () => true }, trustedContext: { resolve: async () => scope },
    financeAuthority: { authorizeCurrent: async input => {
      calls.auth++;
      return { status: 'allowed', decisionId: 'synthetic-decision', operation: input.operation, permission: input.permission, scope: input.requestedScope, principal: { kind: 'user', actorId: input.requestedScope.actorId, membershipStatus: 'active', membershipRevision: 'synthetic-r1' }, verifiedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 60_000).toISOString() };
    } },
    exports: {
      syntheticFixtureRegistry: {
        mode: 'synthetic_only', summaryContentHash, policyRef: structuredClone(summary.policy_ref),
        metricDefinitionRefs: Object.fromEntries(Object.entries(summary.metrics).map(([key, value]) => [key, structuredClone(value.definition_ref)])),
        references: Object.fromEntries([
          ['policy_ref', structuredClone(summary.policy_ref)],
          ...Object.entries(summary.metrics).flatMap(([key, value]) => [[`metrics/${key}/definition_ref`, structuredClone(value.definition_ref)], ...value.source_refs.map((ref, index) => [`metrics/${key}/source_refs/${index}`, structuredClone(ref)])]),
          ...summary.rate_card_refs.map((ref, index) => [`rate_card_refs/${index}`, structuredClone(ref)]),
          ...summary.financial_event_refs.map((ref, index) => [`financial_event_refs/${index}/reference`, structuredClone(ref.reference)]),
        ]),
      },
      snapshotReader: { readVerifiedSnapshot: async input => { calls.source++; assert.deepEqual(input.scope, scope); return structuredClone(page); } },
      artifactStore: {
        lookup: async () => { calls.lookup++; return structuredClone(stored); },
        commitImmutable: async (_key, value) => { calls.store++; if (stored === null) { stored = structuredClone(value); originalStoreHash = api.hashExportCanonical(stored); } return structuredClone(stored); },
        verifyOriginal: async (_key, value) => { calls.verify++; return api.hashExportCanonical(value) === originalStoreHash; },
      },
    },
    ...overrides,
  };
  return { page, request, ports, calls, advance: ms => { now = new Date(now.getTime() + ms); }, stored: () => stored, tamperStored: f => f(stored) };
}

test('configured v1 facade prepares v2 JSON/CSV and exact decimals while unconfigured stays unavailable', async () => {
  const x = setup();
  const result = await api.exportSummaryV2(x.request, x.ports);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.value.manifest.status, 'prepared');
  assert.equal(result.value.manifest.createdAt, '2026-10-10T13:00:00.000Z');
  assert.notEqual(result.value.manifest.createdAt, x.page.asOf, 'export time is not relabelled query as-of');
  assert.equal(result.value.manifest.deliveryReference, null);
  const doc = JSON.parse(result.value.artifacts[0].content);
  assert.equal(doc.schemaVersion, '2.0.0');
  assert.equal(doc.evidenceMode, 'mocked');
  assert.equal(doc.coverage.expected, null);
  assert.deepEqual(doc.coverage.missingSources, ['cash', 'unclassified_source']);
  assert.equal(doc.metrics.find(row => row.metric === 'expense').amount, '1.234567');
  assert.equal(doc.metrics.find(row => row.metric === 'cash_net').amount, null);
  assert.equal(doc.metrics.find(row => row.metric === 'contribution').amount, '-0.250000');
  assert.match(result.value.artifacts[1].content, /,USD,6,-0\.250000,/);
  assert.match(result.value.artifacts[1].content, /cash_net,[^\r\n]*,unknown,USD,6,,/);
  assert.ok(result.value.artifacts[1].content.endsWith('\r\n'));
  const bytes = JSON.stringify(result.value);
  for (const canary of ['123e4567-e89b-42d3-a456-000000000999', 'PRIVATE_SNAPSHOT_CANARY', 'PRIVATE_WATERMARK_CANARY', 'PRIVATE_PROVIDER_CANARY', 'PRIVATE_REVISION_CANARY', 'PRIVATE_REQUEST_CANARY', 'PRIVATE_ACTOR_LABEL_CANARY', x.request.scope.tenantId]) assert.equal(bytes.includes(canary), false, canary);
  for (const artifact of result.value.artifacts) {
    assert.equal(artifact.contentHash, digest(artifact.content));
    assert.equal(artifact.byteLength, Buffer.byteLength(artifact.content));
  }
  const sampleDirectory = join(root, 'artifacts/export-samples');
  await mkdir(sampleDirectory, { recursive: true });
  for (const artifact of result.value.artifacts) await writeFile(join(sampleDirectory, artifact.fileName), artifact.content);
  const manifestBytes = JSON.stringify({ fixtureMode: 'synthetic_only', producerIntegration: 'pending_query_snapshot_handshake', manifest: result.value.manifest, artifactManifest: result.value.artifactManifest }, null, 2) + '\n';
  await writeFile(join(sampleDirectory, 'manifest.json'), manifestBytes);
  await writeFile(join(sampleDirectory, 'hashes.json'), JSON.stringify({ schemaVersion: '1.0.0', fixtureMode: 'synthetic_only', files: [...result.value.artifacts.map(({ content: _content, ...receipt }) => receipt), { fileName: 'manifest.json', contentHash: digest(manifestBytes), byteLength: Buffer.byteLength(manifestBytes), mediaType: 'application/json' }] }, null, 2) + '\n');
  const legacy = await api.exportSummary(x.request, x.ports);
  assert.deepEqual(legacy, { ok: true, value: result.value.manifest });
  const unconfigured = { ...x.ports }; delete unconfigured.exports;
  assert.equal((await api.exportSummary(x.request, unconfigured)).error.code, 'SOURCE_UNAVAILABLE');
});

test('current operation permission is required before snapshot/store/replay access', async () => {
  for (const decision of [null, { status: 'denied', operation: 'integrations.exportSummary', permission: 'finance.summary.export' }]) {
    const x = setup({ financeAuthority: { authorizeCurrent: async () => decision } });
    const result = await api.exportSummaryV2(x.request, x.ports);
    assert.equal(result.ok, false);
    assert.deepEqual([x.calls.lookup, x.calls.source, x.calls.store], [0, 0, 0]);
  }
  for (const mutate of [
    decision => { decision.permission = 'finance.summary.read'; },
    decision => { decision.permission = 'finance.export'; },
    decision => { decision.scope.projectId = '123e4567-e89b-42d3-a456-000000000888'; },
    decision => { decision.scope.actorId = 'foreign-actor'; },
    decision => { decision.scope.environment = 'production'; },
    decision => { decision.scope.billingMode = 'live'; },
  ]) {
    const x = setup(); const original = x.ports.financeAuthority.authorizeCurrent;
    x.ports.financeAuthority.authorizeCurrent = async input => { const decision = structuredClone(await original(input)); mutate(decision); return decision; };
    assert.equal((await api.exportSummary(x.request, x.ports)).error.code, 'FORBIDDEN_SCOPE');
    assert.deepEqual([x.calls.lookup, x.calls.source, x.calls.store], [0, 0, 0], 'read-only, foreign action/scope or actor grants never export');
  }
  const x = setup();
  await api.exportSummary(x.request, x.ports);
  const prior = { ...x.calls };
  x.ports.financeAuthority = { authorizeCurrent: async () => ({ status: 'denied', operation: 'integrations.exportSummary', permission: 'finance.summary.export' }) };
  assert.equal((await api.getPreparedExportArtifacts(x.request, x.ports)).error.code, 'FORBIDDEN_SCOPE');
  assert.deepEqual(x.calls, prior, 'revoked replay touches no store or source');
});

test('revocation after async lookup, snapshot read or commit fails closed', async () => {
  for (const stage of ['lookup', 'source', 'store', 'verify']) {
    const x = setup();
    const original = x.ports.financeAuthority.authorizeCurrent;
    x.ports.financeAuthority.authorizeCurrent = async input => {
      if (x.calls[stage] > 0) return { status: 'denied', operation: input.operation, permission: input.permission };
      return original(input);
    };
    const result = await api.exportSummaryV2(x.request, x.ports);
    assert.equal(result.error.code, 'FORBIDDEN_SCOPE', stage);
    if (stage === 'lookup') assert.equal(x.calls.source, 0);
    if (stage === 'source') assert.equal(x.calls.store, 0);
  }
});

test('delayed authorization decision expires using clock after its await', async () => {
  const x = setup();
  const original = x.ports.financeAuthority.authorizeCurrent;
  x.ports.financeAuthority.authorizeCurrent = async input => { const decision = await original(input); x.advance(61_000); return decision; };
  assert.equal((await api.exportSummary(x.request, x.ports)).error.code, 'FORBIDDEN_SCOPE');
  assert.equal(x.calls.lookup, 0);
});

test('caller scope mutation during every async boundary cannot redirect revocation checks', async () => {
  for (const stage of ['lookup', 'source', 'store']) {
    const x = setup();
    const original = x.ports.financeAuthority.authorizeCurrent;
    x.ports.financeAuthority.authorizeCurrent = async input => {
      if (x.calls[stage] > 0 && input.requestedScope.projectId === fixture.summary.project_id) return { status: 'denied', operation: input.operation, permission: input.permission };
      return original(input);
    };
    const container = stage === 'source' ? x.ports.exports.snapshotReader : x.ports.exports.artifactStore;
    const name = stage === 'source' ? 'readVerifiedSnapshot' : stage === 'store' ? 'commitImmutable' : 'lookup';
    const action = container[name];
    container[name] = async (...args) => {
      const result = await action(...args);
      x.request.scope.projectId = '123e4567-e89b-42d3-a456-000000000888';
      return result;
    };
    assert.equal((await api.exportSummary(x.request, x.ports)).error.code, 'FORBIDDEN_SCOPE', stage);
  }
  const x = setup();
  const original = x.ports.financeAuthority.authorizeCurrent;
  x.ports.financeAuthority.authorizeCurrent = async input => { input.requestedScope.projectId = 'forged-project'; return original(input); };
  assert.equal((await api.exportSummary(x.request, x.ports)).error.code, 'SOURCE_UNAVAILABLE', 'authority callback cannot mutate the frozen scope');
  assert.equal(x.calls.lookup, 0);
});

test('structurally valid semantic and independently registered reference violations fail closed', async () => {
  for (const mutate of [
    page => { page.summary.completeness = 'complete'; },
    page => { page.summary.period.end = page.summary.period.start; },
    page => { page.summary.metrics.expense.value.scale = 5; },
    page => { page.summary.metrics.expense.source_refs[0].content_hash = digest('foreign-evidence'); },
  ]) {
    const x = setup(); mutate(x.page);
    x.page.summaryContentHash = api.hashExportCanonical(x.page.summary);
    x.request.summarySnapshot = structuredClone(x.page); x.request.summaryContentHash = x.page.summaryContentHash;
    x.ports.exports.syntheticFixtureRegistry.summaryContentHash = x.page.summaryContentHash;
    assert.equal((await api.exportSummary(x.request, x.ports)).error.code, 'SOURCE_UNAVAILABLE');
    assert.equal(x.calls.store, 0);
  }
  const x = setup(); x.page.summary.metrics.expense.definition_ref.id = '123e4567-e89b-42d3-a456-000000000777';
  x.page.summaryContentHash = api.hashExportCanonical(x.page.summary);
  x.request.summarySnapshot = structuredClone(x.page); x.request.summaryContentHash = x.page.summaryContentHash;
  x.ports.exports.syntheticFixtureRegistry.summaryContentHash = x.page.summaryContentHash;
  assert.equal((await api.exportSummary(x.request, x.ports)).error.code, 'UNSUPPORTED_VERSION', 'same-name foreign metric definition is not relabelled');
});

test('transport metadata changes replay exact immutable original; financial changes conflict', async () => {
  const x = setup();
  const first = await api.exportSummaryV2(x.request, x.ports);
  x.advance(30_000);
  const transportRetry = structuredClone(x.request);
  transportRetry.requestId = 'another-request'; transportRetry.requestedAt = '2026-10-10T14:00:00Z'; transportRetry.requestedBy = 'not-authority'; transportRetry.summarySnapshot.requestId = 'another-query-request';
  assert.deepEqual(await api.exportSummaryV2(transportRetry, x.ports), first);
  for (const change of [r => { r.format = 'csv'; }, r => { r.evidenceMode = 'sandbox'; }, r => { r.summarySnapshot.watermark.sources[0].revision = 'changed'; }, r => { r.summarySnapshot.snapshotId = 'another-snapshot'; }]) {
    const modified = structuredClone(x.request); change(modified);
    assert.equal((await api.exportSummaryV2(modified, x.ports)).error.code, 'IDEMPOTENCY_CONFLICT');
  }
  assert.equal(x.calls.store, 1);
});

test('untrusted caller hash/snapshot cannot override stored source; malformed and foreign scope fail', async () => {
  const x = setup();
  const forged = structuredClone(x.request);
  forged.summarySnapshot.summary.metrics.expense.value.amount = '999.000000';
  forged.summaryContentHash = forged.summarySnapshot.summaryContentHash = api.hashExportCanonical(forged.summarySnapshot.summary);
  assert.equal((await api.exportSummaryV2(forged, x.ports)).error.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal(x.calls.store, 0);
  const foreign = structuredClone(x.request); foreign.summarySnapshot.summary.project_id = '123e4567-e89b-42d3-a456-000000000999';
  assert.equal((await api.exportSummary(foreign, x.ports)).error.code, 'FORBIDDEN_SCOPE');
  const malformed = structuredClone(x.request); malformed.summarySnapshot.summary.prompt = 'SECRET_RAW_PROMPT';
  const error = await api.exportSummary(malformed, x.ports);
  assert.equal(error.error.code, 'VALIDATION_ERROR');
  assert.equal(JSON.stringify(error).includes('SECRET_RAW_PROMPT'), false);
});

test('unsupported dictionary keys are explicit errors, never silently omitted', async () => {
  const missingRegistry = setup(); delete missingRegistry.ports.exports.syntheticFixtureRegistry;
  assert.equal((await api.exportSummary(missingRegistry.request, missingRegistry.ports)).error.code, 'UNSUPPORTED_VERSION');
  const real = setup(); real.request.evidenceMode = 'live';
  assert.equal((await api.exportSummary(real.request, real.ports)).error.code, 'UNSUPPORTED_VERSION', 'synthetic registry is never actual Finance registry authority');
  const x = setup();
  x.page.summary.metrics.unknown_custom_metric = structuredClone(x.page.summary.metrics.expense);
  x.page.summaryContentHash = api.hashExportCanonical(x.page.summary);
  x.request.summarySnapshot = structuredClone(x.page); x.request.summaryContentHash = x.page.summaryContentHash;
  const result = await api.exportSummary(x.request, x.ports);
  assert.equal(result.error.code, 'UNSUPPORTED_VERSION');
  assert.equal(x.calls.store, 0);
});

test('content bounds and opaque source errors reject before storage mutation', async () => {
  const x = setup();
  const huge = structuredClone(x.request); huge.requestedBy = 'x'.repeat(1_048_577);
  assert.equal((await api.exportSummary(huge, x.ports)).error.code, 'VALIDATION_ERROR');
  assert.equal(x.calls.lookup, 0);
  x.ports.exports.snapshotReader.readVerifiedSnapshot = async () => { throw new Error('SECRET_CREDENTIAL_CANARY'); };
  const error = await api.exportSummary(x.request, x.ports);
  assert.equal(error.error.code, 'SOURCE_UNAVAILABLE');
  assert.equal(JSON.stringify(error).includes('SECRET_CREDENTIAL_CANARY'), false);
});

test('receipt tampering never reaches the caller', async () => {
  const x = setup();
  assert.equal((await api.exportSummary(x.request, x.ports)).ok, true);
  x.tamperStored(value => { value.prepared.manifest.watermarkId = 'PRIVATE_TAMPER_CANARY'; });
  const result = await api.exportSummary(x.request, x.ports);
  assert.equal(result.error.code, 'SOURCE_UNAVAILABLE');
  assert.equal(JSON.stringify(result).includes('PRIVATE_TAMPER_CANARY'), false);
  const coherent = setup(); await api.exportSummary(coherent.request, coherent.ports);
  coherent.tamperStored(value => { value.prepared.manifest.createdAt = value.prepared.artifactManifest.createdAt = '2026-10-11T13:00:00Z'; });
  assert.equal((await api.exportSummary(coherent.request, coherent.ports)).error.code, 'SOURCE_UNAVAILABLE', 'coherent timestamps cannot replace original independently authenticated preparation');
});

for (const stage of ['creation', 'replay']) {
  test(`shared ${stage} adapter records cannot mutate authenticated bytes during final authorization`, async () => {
    for (const mutateAfterVerification of [false, true]) {
      const x = setup();
      const originalCommit = x.ports.exports.artifactStore.commitImmutable;
      x.ports.exports.artifactStore.commitImmutable = async (...args) => { await originalCommit(...args); return x.stored(); };
      x.ports.exports.artifactStore.lookup = async () => { x.calls.lookup++; return x.stored(); };
      if (stage === 'replay') assert.equal((await api.exportSummaryV2(x.request, x.ports)).ok, true);
      let authenticated = false;
      const originalVerify = x.ports.exports.artifactStore.verifyOriginal;
      x.ports.exports.artifactStore.verifyOriginal = async (...args) => { const verified = await originalVerify(...args); authenticated = verified; return verified; };
      const originalAuth = x.ports.financeAuthority.authorizeCurrent;
      x.ports.financeAuthority.authorizeCurrent = async input => {
        const decision = await originalAuth(input);
        if (authenticated && mutateAfterVerification) x.tamperStored(record => {
          record.prepared.artifacts[0].content = 'CORRUPTED_AFTER_VERIFICATION';
          record.prepared.manifest.createdAt = record.prepared.artifactManifest.createdAt = '2099-01-01T00:00:00Z';
        });
        return decision;
      };
      const result = await api.exportSummaryV2(x.request, x.ports);
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.value.manifest.createdAt, '2026-10-10T13:00:00.000Z');
      for (const artifact of result.value.artifacts) assert.equal(artifact.contentHash, digest(artifact.content), 'a successful response must contain exactly the authenticated bytes');
      assert.equal(JSON.parse(result.value.artifacts[0].content).metrics.find(row => row.metric === 'expense').amount, '1.234567');
      assert.equal(JSON.stringify(result).includes('CORRUPTED_AFTER_VERIFICATION'), false);
      if (mutateAfterVerification) {
        assert.equal(x.stored().prepared.artifacts[0].content, 'CORRUPTED_AFTER_VERIFICATION', 'negative control actually changed the shared adapter alias');
        assert.equal((await api.getPreparedExportArtifacts(x.request, x.ports)).error.code, 'SOURCE_UNAVAILABLE', 'subsequent corrupted storage is not accepted');
      }
    }
  });
}

test('filesystem adapter persists exact original across lost acknowledgement and concurrent preparations', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ci08x-own-artifacts-'));
  try {
    const x = setup();
    const store = api.createFileExportArtifactStore({ directory, receiptKey: new Uint8Array(32).fill(7) });
    let lost = true;
    x.ports.exports.artifactStore = { lookup: store.lookup, verifyOriginal: store.verifyOriginal, commitImmutable: async (...args) => { const original = await store.commitImmutable(...args); if (lost) { lost = false; throw new Error('Lost acknowledgement'); } return original; } };
    assert.equal((await api.exportSummaryV2(x.request, x.ports)).error.code, 'SOURCE_UNAVAILABLE');
    const originalFile = (await readdir(directory))[0];
    const originalBytes = await readFile(join(directory, originalFile), 'utf8');
    x.advance(60_000);
    const replay = await api.exportSummaryV2(x.request, x.ports);
    assert.equal(replay.ok, true, JSON.stringify(replay));
    assert.equal(replay.value.manifest.createdAt, '2026-10-10T13:00:00.000Z');
    assert.equal(await readFile(join(directory, originalFile), 'utf8'), originalBytes);
    const restarted = api.createFileExportArtifactStore({ directory, receiptKey: new Uint8Array(32).fill(7) });
    x.ports.exports.artifactStore = restarted;
    assert.deepEqual(await api.getPreparedExportArtifacts(x.request, x.ports), replay, 'new adapter instance replays persisted original');
    const keyHash = 'sha256:' + originalFile.slice(0, -5);
    const childSource = `import {createFileExportArtifactStore,hashExportCanonical} from ${JSON.stringify(pathToFileURL(join(root, 'dist/integrations/index.js')).href)}; const store=createFileExportArtifactStore({directory:${JSON.stringify(directory)},receiptKey:new Uint8Array(32).fill(7)}); const original=await store.lookup(${JSON.stringify(keyHash)}); if(!original||!await store.verifyOriginal(${JSON.stringify(keyHash)},original))process.exit(2); process.stdout.write(hashExportCanonical(original.prepared));`;
    const childHash = execFileSync(process.execPath, ['--input-type=module', '-e', childSource], { encoding: 'utf8', env: { PATH: process.env.PATH, NODE_ENV: 'test' } });
    assert.equal(childHash, api.hashExportCanonical(replay.value), 'a fresh process authenticates and reproduces the original persisted bytes/time');
    const y = setup(); y.request.idempotencyKey = 'synthetic-concurrent'; y.ports.exports.artifactStore = store;
    const [a, b] = await Promise.all([api.exportSummaryV2(y.request, y.ports), api.exportSummaryV2({ ...y.request, requestId: 'another-transport-request' }, y.ports)]);
    assert.equal(a.ok, true); assert.deepEqual(a, b);
    assert.equal((await readdir(directory)).some(name => name.startsWith('.prepare-')), false);
    const coherentlyChanged = JSON.parse(originalBytes);
    coherentlyChanged.value.prepared.manifest.createdAt = coherentlyChanged.value.prepared.artifactManifest.createdAt = '2026-10-11T13:00:00Z';
    await writeFile(join(directory, originalFile), JSON.stringify(coherentlyChanged));
    assert.equal((await api.exportSummary(x.request, x.ports)).error.code, 'SOURCE_UNAVAILABLE');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
