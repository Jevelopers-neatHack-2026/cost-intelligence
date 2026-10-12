import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
// Keep the configured-export regression cases in the existing required exports suite.
import './prepared-exports.test.mjs';
import './query-export-composition.test.mjs';
import './read-renewal.test.mjs';
import './context-renewal.test.mjs';
import './disclosure-fence.test.mjs';
import './public-release.test.mjs';
import '../contracts/canonical-compatibility.test.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const integrationApi = await import('../../dist/integrations/index.js');

test('package root and every declared subpath resolve to ESM modules and declarations', async () => {
  const modules = [
    ['@jevelopers/cost-intelligence', ['FINANCE_OPERATION_POLICY', 'authorizeFinanceOperation', 'ingestUsage', 'estimate', 'estimateV2', 'registerPricingRuleV2', 'registerRateCardV2', 'registerFxRateV2', 'EstimateRequestSchema', 'EstimateResultSchema', 'EstimateRequestV2Schema', 'EstimateResultV2Schema', 'RateCardSchema', 'RateCardV2Schema', 'PricingRuleV2Schema', 'validateUsageObservationBoundary', 'validateEstimateRequestBoundary', 'validateEstimateRequestV2Boundary', 'validatePricingRuleV2Boundary', 'validateRateCardV2Boundary', 'validateFxRateV2Boundary', 'authorize', 'markDispatched', 'settle', 'release', 'changeBudget', 'recordExpenseAdjustment', 'ingestFinancial', 'appendLedgerEvent', 'rebuildLedgerProjection', 'querySummary', 'startReconciliation', 'getReconciliation', 'exportSummary', 'releaseExportDisclosure', 'projectSafeFinancialSummary', 'safeCsvCell', 'serializeSafeFinancialSummaryCsv', 'validateReservationRequestBoundary', 'validateSettleReservationCommandBoundary', 'validateReleaseReservationCommandBoundary', 'validateReservationCommandBoundary', 'validateReservationSnapshotBoundary', 'validateFinancialSummaryPageBoundary', 'validateLedgerAppendRequestBoundary', 'validateLedgerProjectionRequestBoundary', 'validateExportRequestBoundary']],
    ['@jevelopers/cost-intelligence/contracts', ['ErrorEnvelopeSchema', 'TrustedScopeSchema', 'FINANCE_OPERATION_POLICY', 'authorizeFinanceOperation']],
    ['@jevelopers/cost-intelligence/metering', ['ingestUsage', 'UsageObservationSchema', 'validateUsageObservationBoundary']],
    ['@jevelopers/cost-intelligence/pricing', ['estimate', 'estimateV2', 'registerPricingRuleV2', 'registerRateCardV2', 'registerFxRateV2', 'RateCardSchema', 'RateCardV2Schema', 'PricingRuleV2Schema', 'FxRateV2Schema', 'EstimateRequestSchema', 'EstimateRequestV2Schema', 'EstimateResultSchema', 'EstimateResultV2Schema', 'validateEstimateRequestBoundary', 'validateEstimateRequestV2Boundary', 'validatePricingRuleV2Boundary', 'validateRateCardV2Boundary', 'validateFxRateV2Boundary']],
    ['@jevelopers/cost-intelligence/budgets', ['getReservationSnapshot', 'revalidateAuthorization', 'acknowledgePartial', 'ReservationAuthorityBindingSchema', 'FinanceReservationAuthoritySchema', 'CurrentReservationRequestSchema', 'PartialAcknowledgementRequestSchema', 'authorize', 'markDispatched', 'settle', 'BudgetChangeRequestSchema', 'validateReservationRequestBoundary', 'validateSettleReservationCommandBoundary', 'validateReleaseReservationCommandBoundary', 'validateReservationCommandBoundary', 'validateReservationSnapshotBoundary']],
    ['@jevelopers/cost-intelligence/ledger', ['ingestFinancial', 'FinancialEventSchema', 'appendLedgerEvent', 'rebuildLedgerProjection', 'LedgerEventTypeSchema', 'LedgerClassificationSchema', 'LedgerAppendRequestSchema', 'LedgerAppendReceiptSchema', 'LedgerProjectionRequestSchema', 'LedgerProjectionSchema', 'validateLedgerAppendRequestBoundary', 'validateLedgerProjectionRequestBoundary']],
    ['@jevelopers/cost-intelligence/reporting', ['querySummary', 'FinancialSummaryPageSchema', 'validateFinancialSummaryPageBoundary']],
    ['@jevelopers/cost-intelligence/evidence', ['lookupPostingEvidence', 'lookupByOperationalReference', 'validateEvidenceReference', 'EvidenceReferenceSchema']],
    ['@jevelopers/cost-intelligence/reconciliation', ['startReconciliation', 'getReconciliation']],
    ['@jevelopers/cost-intelligence/integrations', ['exportSummary', 'releaseExportDisclosure', 'projectSafeFinancialSummary', 'safeCsvCell', 'serializeSafeFinancialSummaryCsv', 'ExportManifestSchema', 'validateExportRequestBoundary']],
  ];
  for (const [specifier, names] of modules) {
    const imported = await import(specifier);
    for (const name of names) assert.ok(name in imported, `${specifier} missing ${name}`);
    if (specifier === '@jevelopers/cost-intelligence' || specifier === '@jevelopers/cost-intelligence/pricing') {
      assert.equal('VersionedReferenceSchema' in imported, false, `${specifier} must preserve the reviewed 1.0.0 public exports`);
      assert.equal('VersionedReference' in imported, false, `${specifier} must not add a 1.0.0 type export`);
    }
  }
  await access(join(root, 'dist/index.d.ts'));
  const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  for (const specifier of Object.keys(packageJson.exports).filter(name => name !== '.')) {
    const target = packageJson.exports[specifier];
    await access(join(root, target.types));
    await access(join(root, target.import));
  }
});

test('financial exports contain only the safe allowlist and neutralize CSV formulas', async () => {
  const fixture = JSON.parse(await readFile(join(root, 'node_modules/@jevelopers/shared-contracts/fixtures/FinancialSummary.json'), 'utf8')).valid;
  const canary = 'PRIVATE_EXPORT_CANARY_SECRET';
  const summary = structuredClone(fixture);
  summary.tenant_id = canary;
  summary.project_id = `${canary}-PROJECT`;
  summary.event_id = `${canary}-EVENT`;
  summary.prompt = canary;
  summary.address = canary;
  summary.metrics[canary] = structuredClone(summary.metrics.expense);
  summary.source_refs = [{ contract: 'Private', schema_version: '1.0.0', id: canary, revision: 1, content_hash: `sha256:${'a'.repeat(64)}` }];
  summary.financial_event_refs = [{ kind: 'private', reference: { contract: 'Private', schema_version: '1.0.0', id: canary, revision: 1, content_hash: `sha256:${'b'.repeat(64)}` } }];

  const projection = integrationApi.projectSafeFinancialSummary(summary);
  const serialized = JSON.stringify(projection);
  assert.equal(serialized.includes(canary), false, 'projection drops tenant, project, evidence, and private source fields');
  assert.equal(Object.hasOwn(projection, 'source_refs'), false);
  assert.equal(Object.hasOwn(projection, 'tenant_id'), false);
  assert.deepEqual(projection.metrics.map(metric => metric.metric), ['expense'], 'unreviewed dynamic metric labels cannot become export fields');
  const csv = integrationApi.serializeSafeFinancialSummaryCsv(summary);
  assert.equal(csv.includes(canary), false);
  assert.match(csv, /period_start,|"period_start","period_end"/);

  for (const value of ['=1+1', '+1', '-1', '@SUM(A1:A2)', '\t=1+1', '\r=1+1']) {
    assert.equal(integrationApi.safeCsvCell(value).startsWith('"\''), true, `formula-like cell was not neutralized: ${JSON.stringify(value)}`);
  }
  for (const value of ['＝1+1', '  ＠SUM(A1:A2)', '\u200B＋1']) {
    assert.equal(integrationApi.safeCsvCell(value).startsWith('"\''),
      true, 'normalized formula-like cells must be neutralized');
  }
  for (const value of ['\u061C1+1', '\uFEFF=1+1', '\u0085unsafe', '\uD800']) {
    assert.throws(() => integrationApi.safeCsvCell(value), { code: 'INVALID_TEXT' });
  }
  const formulaSummary = structuredClone(fixture);
  formulaSummary.environment = '＝1+1';
  assert.ok(integrationApi.serializeSafeFinancialSummaryCsv(formulaSummary).includes('"\'＝1+1"'));
  assert.equal(integrationApi.safeCsvCell('plain,"quoted"'), '"plain,""quoted"""');
});

test('packed tarball installs into a clean consumer, imports every subpath, and typechecks declarations', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'ci-packed-consumer-'));
  const consumer = join(temp, 'consumer');
  const tarballs = join(temp, 'tarballs');
  await mkdir(consumer, { recursive: true });
  await mkdir(tarballs, { recursive: true });

  function run(command, args, cwd, label) {
    const result = spawnSync(command, args, {
      cwd, encoding: 'utf8', timeout: 120_000,
      env: { ...process.env, CI: '1', npm_config_cache: join(temp, 'npm-cache'), npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false' },
    });
    assert.equal(result.status, 0, `${label} failed (status=${result.status ?? 'null'}, error=${result.error?.message ?? 'none'}): ${(result.stderr || result.stdout || 'no output').slice(0, 1600)}`);
    return result.stdout;
  }

  function runNpm(args, cwd, label) {
    const cli = process.env.npm_execpath;
    const command = cli ? process.execPath : (process.platform === 'win32' ? 'npm.cmd' : 'npm');
    return run(command, cli ? [cli, ...args] : args, cwd, label);
  }

  try {
    const packOutput = runNpm(['pack', '--json', '--pack-destination', tarballs], root, 'npm pack');
    const packed = JSON.parse(packOutput)[0];
    const packedPaths = packed.files.map(file => file.path);
    assert.ok(!packedPaths.some(path => path.startsWith('tests/') || path.startsWith('artifacts/')), 'test code and local evidence must stay out of the package');
    assert.ok(!packedPaths.some(path => /^node_modules\/(?:pg|typescript)(?:\/|$)/.test(path)), 'database and compiler development tools must stay out of the runtime package');
    for (const path of ['examples/worker-composition.ts', 'fixtures/api/error-envelope.response.json', 'fixtures/api/financial-event-unknown.request.json', 'fixtures/api/summary-query.request.json', 'fixtures/api/decision-results.response.json', 'fixtures/pricing/ci03-v1-compatibility.json', 'fixtures/pricing/ci03-synthetic-acceptance.json']) {
      assert.ok(packedPaths.includes(path), `sanitized consumer example is missing from package: ${path}`);
    }
    const tarball = join(tarballs, packed.filename);
    const archive = await readFile(tarball);
    const tarballSha256 = createHash('sha256').update(archive).digest('hex');

    await writeFile(join(consumer, 'package.json'), JSON.stringify({
      private: true,
      type: 'module',
    }));
    await writeFile(join(consumer, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, noEmit: true, skipLibCheck: false },
      include: ['consumer.mts', 'worker-composition.mts'],
    }));
    await writeFile(join(consumer, 'consumer.mts'), [
      "import { ingestUsage as rootIngest, estimate, estimateV2, registerPricingRuleV2, registerRateCardV2, registerFxRateV2, authorize, markDispatched, settle, release, changeBudget, recordExpenseAdjustment, ingestFinancial, appendLedgerEvent, rebuildLedgerProjection, querySummary, startReconciliation, getReconciliation, exportSummary, releaseExportDisclosure, validateUsageObservationBoundary, validateEstimateRequestBoundary, validateEstimateRequestV2Boundary, validatePricingRuleV2Boundary, validateRateCardV2Boundary, validateFxRateV2Boundary, validateReservationRequestBoundary, validateSettleReservationCommandBoundary, validateReleaseReservationCommandBoundary, validateReservationCommandBoundary, validateReservationSnapshotBoundary, validateFinancialSummaryPageBoundary, validateLedgerAppendRequestBoundary, validateLedgerProjectionRequestBoundary, validateExportRequestBoundary, RateCardSchema, RateCardV2Schema, PricingRuleV2Schema, EstimateRequestSchema, EstimateRequestV2Schema, EstimateResultSchema, EstimateResultV2Schema } from '@jevelopers/cost-intelligence';",
      "import type { ApiResult, Validation, RuntimePorts, PricingRuntimePorts, LedgerRuntimePorts, FinanceAuthorizationPort, FinanceAuthorizationDecision, FinanceOperation, FinancePermission, IngestionReceipt, EstimateResult, EstimateResultV2, CatalogWriteReceiptV2, PricingRuleV2, RateCard, RateCardV2, FxRateV2, RegisterPricingRuleRequestV2, RegisterRateCardRequestV2, RegisterFxRateRequestV2, AuthorizationDecision, ReservationSnapshot, BudgetChangeReceipt, PostingReceipt, LedgerAppendReceipt, LedgerAppendRequest, LedgerProjectionRequest, LedgerProjection, FinancialSummaryPage, ReconciliationRun, ReconciliationResult, ExportManifest, UsageObservation, EstimateRequest, EstimateRequestV2, ReservationRequest, SettleReservationCommand, ReleaseReservationCommand, ReservationCommand, ExportRequest } from '@jevelopers/cost-intelligence';",
      "type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? ((<T>() => T extends B ? 1 : 2) extends (<T>() => T extends A ? 1 : 2) ? true : false) : false;",
      'type NotAny<T> = 0 extends (1 & T) ? false : true;',
      'type Check<T extends true> = T;',
      "type ExactPricingVersions = [Check<Equal<RateCard['schemaVersion'], '1.0.0'>>, Check<Equal<RateCardV2['schemaVersion'], '2.0.0'>>, Check<Equal<PricingRuleV2['schemaVersion'], '2.0.0'>>, Check<Equal<EstimateRequest['schemaVersion'], '1.0.0'>>, Check<Equal<EstimateRequestV2['schemaVersion'], '2.0.0'>>, Check<Equal<EstimateResult['schemaVersion'], '1.0.0'>>, Check<Equal<EstimateResultV2['schemaVersion'], '2.0.0'>>];",
      'type ExactPublicResults = [',
      '  Check<Equal<Awaited<ReturnType<typeof rootIngest>>, ApiResult<IngestionReceipt>>>,',
      '  Check<Equal<Awaited<ReturnType<typeof estimate>>, ApiResult<EstimateResult>>>,',
      '  Check<Equal<Awaited<ReturnType<typeof estimateV2>>, ApiResult<EstimateResultV2>>>,',
      '  Check<Equal<Awaited<ReturnType<typeof registerPricingRuleV2>>, ApiResult<CatalogWriteReceiptV2>>>,',
      '  Check<Equal<Awaited<ReturnType<typeof registerRateCardV2>>, ApiResult<CatalogWriteReceiptV2>>>,',
      '  Check<Equal<Awaited<ReturnType<typeof registerFxRateV2>>, ApiResult<CatalogWriteReceiptV2>>>,',
      '  Check<Equal<Awaited<ReturnType<typeof authorize>>, ApiResult<AuthorizationDecision>>>,',
      '  Check<Equal<Awaited<ReturnType<typeof markDispatched>>, ApiResult<ReservationSnapshot>>>,',
      '  Check<Equal<Awaited<ReturnType<typeof settle>>, ApiResult<ReservationSnapshot>>>,',
      '  Check<Equal<Awaited<ReturnType<typeof release>>, ApiResult<ReservationSnapshot>>>,',
      '  Check<Equal<Awaited<ReturnType<typeof changeBudget>>, ApiResult<BudgetChangeReceipt>>>,',
      '  Check<Equal<Awaited<ReturnType<typeof recordExpenseAdjustment>>, ApiResult<PostingReceipt>>>,',
      '  Check<Equal<Awaited<ReturnType<typeof ingestFinancial>>, ApiResult<PostingReceipt>>>,',
      '  Check<Equal<Awaited<ReturnType<typeof appendLedgerEvent>>, ApiResult<LedgerAppendReceipt>>>,',
      '  Check<Equal<Awaited<ReturnType<typeof rebuildLedgerProjection>>, ApiResult<LedgerProjection>>>,',
      '  Check<Equal<Awaited<ReturnType<typeof querySummary>>, ApiResult<FinancialSummaryPage>>>,',
      '  Check<Equal<Awaited<ReturnType<typeof startReconciliation>>, ApiResult<ReconciliationRun>>>,',
      '  Check<Equal<Awaited<ReturnType<typeof getReconciliation>>, ApiResult<ReconciliationResult>>>,',
      '  Check<Equal<Awaited<ReturnType<typeof exportSummary>>, ApiResult<ExportManifest>>>,',
      '  Check<NotAny<Awaited<ReturnType<typeof rootIngest>>>>, Check<NotAny<Awaited<ReturnType<typeof estimate>>>>, Check<NotAny<Awaited<ReturnType<typeof estimateV2>>>>, Check<NotAny<Awaited<ReturnType<typeof registerPricingRuleV2>>>>, Check<NotAny<Awaited<ReturnType<typeof registerRateCardV2>>>>, Check<NotAny<Awaited<ReturnType<typeof registerFxRateV2>>>>,',
      '  Check<NotAny<Awaited<ReturnType<typeof authorize>>>>, Check<NotAny<Awaited<ReturnType<typeof markDispatched>>>>, Check<NotAny<Awaited<ReturnType<typeof settle>>>>, Check<NotAny<Awaited<ReturnType<typeof release>>>>,',
      '  Check<NotAny<Awaited<ReturnType<typeof changeBudget>>>>, Check<NotAny<Awaited<ReturnType<typeof recordExpenseAdjustment>>>>,',
      '  Check<NotAny<Awaited<ReturnType<typeof ingestFinancial>>>>, Check<NotAny<Awaited<ReturnType<typeof appendLedgerEvent>>>>, Check<NotAny<Awaited<ReturnType<typeof rebuildLedgerProjection>>>>, Check<NotAny<Awaited<ReturnType<typeof querySummary>>>>,',
      '  Check<NotAny<Awaited<ReturnType<typeof startReconciliation>>>>, Check<NotAny<Awaited<ReturnType<typeof getReconciliation>>>>,',
      '  Check<NotAny<Awaited<ReturnType<typeof exportSummary>>>>,',
      '];',
      'type ExactFinalRelease = [Check<Equal<ReturnType<typeof releaseExportDisclosure<ExportManifest>>, ApiResult<ExportManifest>>>, Check<NotAny<ReturnType<typeof releaseExportDisclosure<ExportManifest>>>>];',
      'type ExactCombinedValidators = [',
      '  Check<Equal<ReturnType<typeof validateUsageObservationBoundary>, Validation<UsageObservation>>>,',
      '  Check<Equal<ReturnType<typeof validateEstimateRequestBoundary>, Validation<EstimateRequest>>>,',
      '  Check<Equal<ReturnType<typeof validateReservationRequestBoundary>, Validation<ReservationRequest>>>,',
      '  Check<Equal<ReturnType<typeof validateSettleReservationCommandBoundary>, Validation<SettleReservationCommand>>>,',
      '  Check<Equal<ReturnType<typeof validateReleaseReservationCommandBoundary>, Validation<ReleaseReservationCommand>>>,',
      '  Check<Equal<ReturnType<typeof validateReservationCommandBoundary>, Validation<ReservationCommand>>>,',
      '  Check<Equal<ReturnType<typeof validateReservationSnapshotBoundary>, Validation<ReservationSnapshot>>>,',
      '  Check<Equal<ReturnType<typeof validateFinancialSummaryPageBoundary>, Validation<FinancialSummaryPage>>>,',
      '  Check<Equal<ReturnType<typeof validateLedgerAppendRequestBoundary>, Validation<LedgerAppendRequest>>>,',
      '  Check<Equal<ReturnType<typeof validateLedgerProjectionRequestBoundary>, Validation<LedgerProjectionRequest>>>,',
      '  Check<Equal<ReturnType<typeof validateExportRequestBoundary>, Validation<ExportRequest>>>,',
      '];',
      "declare const runtimePorts: RuntimePorts; declare const pricingPorts: PricingRuntimePorts; declare const ledgerPorts: LedgerRuntimePorts;",
      "const financeAuthority: FinanceAuthorizationPort | undefined = runtimePorts.financeAuthority; const financeOperation: FinanceOperation = 'ledger.appendLedgerEvent'; const financePermission: FinancePermission = 'ledger.event.append'; void [financeAuthority, financeOperation, financePermission];",
      "const originalSelection: EstimateRequest['selection'] = { policy: 'event_time', effectiveAt: '2026-10-11T03:30:00.000Z', requestedCurrency: 'USD', rateCardRef: null };",
      'async function consumeTypedResults() {',
      '  const a = await rootIngest(undefined as never, runtimePorts); const aa: ApiResult<IngestionReceipt> = a; if (aa.ok) { const v: IngestionReceipt["status"] = aa.value.status; void v; }',
      '  const b = await estimate(undefined as never, runtimePorts); const bb: ApiResult<EstimateResult> = b; if (bb.ok) { const v: EstimateResult["status"] = bb.value.status; void v; }',
      '  const b2 = await estimateV2(undefined as never, pricingPorts); const bb2: ApiResult<EstimateResultV2> = b2; if (bb2.ok) { const v: EstimateResultV2["status"] = bb2.value.status; void v; }',
      '  const rule2 = await registerPricingRuleV2(undefined as never, pricingPorts); const rr2: ApiResult<CatalogWriteReceiptV2> = rule2; void rr2;',
      '  const card2 = await registerRateCardV2(undefined as never, pricingPorts); const cr2: ApiResult<CatalogWriteReceiptV2> = card2; void cr2;',
      '  const fx2 = await registerFxRateV2(undefined as never, pricingPorts); const fr2: ApiResult<CatalogWriteReceiptV2> = fx2; void fr2;',
      '  const c = await authorize(undefined as never, runtimePorts); const cc: ApiResult<AuthorizationDecision> = c; if (cc.ok) { const v: AuthorizationDecision["status"] = cc.value.status; void v; }',
      '  const dispatch = await markDispatched(undefined as never, runtimePorts); const dispatchedResult: ApiResult<ReservationSnapshot> = dispatch; if (dispatchedResult.ok) { const state: ReservationSnapshot["state"] = dispatchedResult.value.state; void state; }',
      '  const d = await settle(undefined as never, runtimePorts); const settledResult: ApiResult<ReservationSnapshot> = d; if (settledResult.ok) { const v: ReservationSnapshot["state"] = settledResult.value.state; void v; }',
      '  const e = await release(undefined as never, runtimePorts); const ee: ApiResult<ReservationSnapshot> = e; if (ee.ok) { const v: ReservationSnapshot["state"] = ee.value.state; void v; }',
      '  const f = await changeBudget(undefined as never, runtimePorts); const ff: ApiResult<BudgetChangeReceipt> = f; if (ff.ok) { const v: BudgetChangeReceipt["status"] = ff.value.status; void v; }',
      '  const g = await recordExpenseAdjustment(undefined as never, runtimePorts); const gg: ApiResult<PostingReceipt> = g; if (gg.ok) { const v: PostingReceipt["postingId"] = gg.value.postingId; void v; }',
      '  const h = await ingestFinancial(undefined as never, runtimePorts); const hh: ApiResult<PostingReceipt> = h; if (hh.ok) { const v: PostingReceipt["postingId"] = hh.value.postingId; void v; }',
      '  const ledgerAppend = await appendLedgerEvent(undefined as never, ledgerPorts); const la: ApiResult<LedgerAppendReceipt> = ledgerAppend; if (la.ok) { const status: LedgerAppendReceipt["status"] = la.value.status; const durable: boolean = la.value.durableCommit; void [status, durable]; }',
      '  const projection = await rebuildLedgerProjection(undefined as never, ledgerPorts); const lp: ApiResult<LedgerProjection> = projection; if (lp.ok) { const count: number = lp.value.eventCount; const hash: string = lp.value.projectionHash; void [count, hash]; }',
      '  const i = await querySummary(undefined as never, runtimePorts); const ii: ApiResult<FinancialSummaryPage> = i; if (ii.ok) { const v: FinancialSummaryPage["snapshotId"] = ii.value.snapshotId; void v; }',
      '  const j = await startReconciliation(undefined as never, runtimePorts); const jj: ApiResult<ReconciliationRun> = j; if (jj.ok) { const v: ReconciliationRun["runId"] = jj.value.runId; void v; }',
      '  const k = await getReconciliation(undefined as never, runtimePorts); const kk: ApiResult<ReconciliationResult> = k; if (kk.ok) { const v: ReconciliationResult["unknownVarianceCount"] = kk.value.unknownVarianceCount; void v; }',
      '  const l = await exportSummary(undefined as never, runtimePorts); const ll: ApiResult<ExportManifest> = l; if (ll.ok) { const v: ExportManifest["exportId"] = ll.value.exportId; void v; }',
      '}',
      'void [consumeTypedResults, originalSelection, validateUsageObservationBoundary, validateEstimateRequestBoundary, validateEstimateRequestV2Boundary, validatePricingRuleV2Boundary, validateRateCardV2Boundary, validateFxRateV2Boundary, validateReservationRequestBoundary, validateSettleReservationCommandBoundary, validateReleaseReservationCommandBoundary, validateReservationCommandBoundary, validateReservationSnapshotBoundary, validateFinancialSummaryPageBoundary, validateLedgerAppendRequestBoundary, validateLedgerProjectionRequestBoundary, validateExportRequestBoundary, RateCardSchema, RateCardV2Schema, EstimateRequestSchema, EstimateRequestV2Schema, EstimateResultSchema, EstimateResultV2Schema, PricingRuleV2Schema];',
      "import * as contracts from '@jevelopers/cost-intelligence/contracts';",
      "import * as metering from '@jevelopers/cost-intelligence/metering';",
      "import * as pricing from '@jevelopers/cost-intelligence/pricing';",
      "import * as budgets from '@jevelopers/cost-intelligence/budgets';",
      "import * as ledger from '@jevelopers/cost-intelligence/ledger';",
      "import * as reporting from '@jevelopers/cost-intelligence/reporting';",
      "import * as reconciliation from '@jevelopers/cost-intelligence/reconciliation';",
      "import * as integrations from '@jevelopers/cost-intelligence/integrations';",
      'declare const legacyDisclosure: ApiResult<ExportManifest>; declare const preparedDisclosure: ApiResult<integrations.PreparedExportArtifacts>; declare const richDisclosure: ApiResult<integrations.ReportingPreparedExportArtifacts>;',
      'const publicManifestRelease: ApiResult<ExportManifest> = releaseExportDisclosure(legacyDisclosure, runtimePorts.clock); const subManifestRelease: ApiResult<ExportManifest> = integrations.releaseExportDisclosure(legacyDisclosure, runtimePorts.clock); const rootPreparedRelease: ApiResult<integrations.PreparedExportArtifacts> = releaseExportDisclosure(preparedDisclosure, runtimePorts.clock); const subRichRelease: ApiResult<integrations.ReportingPreparedExportArtifacts> = integrations.releaseExportDisclosure(richDisclosure, runtimePorts.clock); void [publicManifestRelease, subManifestRelease, rootPreparedRelease, subRichRelease];',
      '// @ts-expect-error Public release has no false requirement flag.',
      'releaseExportDisclosure(legacyDisclosure, runtimePorts.clock, false);',
      'void [rootIngest, estimate, estimateV2, registerPricingRuleV2, registerRateCardV2, registerFxRateV2, authorize, markDispatched, settle, release, changeBudget, recordExpenseAdjustment, ingestFinancial, appendLedgerEvent, rebuildLedgerProjection, querySummary, startReconciliation, getReconciliation, exportSummary, contracts.ErrorEnvelopeSchema, metering.ingestUsage, pricing.estimate, pricing.estimateV2, pricing.registerPricingRuleV2, pricing.registerRateCardV2, pricing.registerFxRateV2, budgets.authorize, ledger.ingestFinancial, ledger.appendLedgerEvent, reporting.querySummary, reconciliation.getReconciliation, integrations.exportSummary];',
    ].join('\n'));
    await writeFile(join(consumer, 'worker-composition.mts'), await readFile(join(root, 'examples/worker-composition.ts'), 'utf8'));

    runNpm(['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', tarball], consumer, 'offline packed consumer install');
    run(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--project', join(consumer, 'tsconfig.json')], root, 'packed consumer declaration compile');
    const runtime = [
      "const entries = [",
      "  ['@jevelopers/cost-intelligence', ['ingestUsage', 'estimate', 'estimateV2', 'registerPricingRuleV2', 'registerRateCardV2', 'registerFxRateV2', 'authorize', 'markDispatched', 'settle', 'release', 'changeBudget', 'recordExpenseAdjustment', 'ingestFinancial', 'appendLedgerEvent', 'rebuildLedgerProjection', 'querySummary', 'startReconciliation', 'getReconciliation', 'exportSummary', 'releaseExportDisclosure', 'validateUsageObservationBoundary', 'validateEstimateRequestBoundary', 'validateEstimateRequestV2Boundary', 'validatePricingRuleV2Boundary', 'validateRateCardV2Boundary', 'validateFxRateV2Boundary', 'validateReservationRequestBoundary', 'validateSettleReservationCommandBoundary', 'validateReleaseReservationCommandBoundary', 'validateReservationCommandBoundary', 'validateReservationSnapshotBoundary', 'validateFinancialSummaryPageBoundary', 'validateLedgerAppendRequestBoundary', 'validateLedgerProjectionRequestBoundary', 'validateExportRequestBoundary']],",
      "  ['@jevelopers/cost-intelligence/contracts', ['ErrorEnvelopeSchema']],",
      "  ['@jevelopers/cost-intelligence/metering', ['ingestUsage', 'validateUsageObservationBoundary']],",
      "  ['@jevelopers/cost-intelligence/pricing', ['estimate', 'estimateV2', 'registerPricingRuleV2', 'registerRateCardV2', 'registerFxRateV2', 'RateCardSchema', 'RateCardV2Schema', 'PricingRuleV2Schema', 'FxRateV2Schema', 'EstimateRequestSchema', 'EstimateRequestV2Schema', 'EstimateResultSchema', 'EstimateResultV2Schema', 'validateEstimateRequestBoundary', 'validateEstimateRequestV2Boundary', 'validatePricingRuleV2Boundary', 'validateRateCardV2Boundary', 'validateFxRateV2Boundary']],",
      "  ['@jevelopers/cost-intelligence/budgets', ['getReservationSnapshot', 'revalidateAuthorization', 'acknowledgePartial', 'ReservationAuthorityBindingSchema', 'FinanceReservationAuthoritySchema', 'CurrentReservationRequestSchema', 'PartialAcknowledgementRequestSchema', 'authorize', 'markDispatched', 'validateReservationRequestBoundary', 'validateSettleReservationCommandBoundary', 'validateReleaseReservationCommandBoundary', 'validateReservationCommandBoundary', 'validateReservationSnapshotBoundary']],",
      "  ['@jevelopers/cost-intelligence/ledger', ['ingestFinancial', 'appendLedgerEvent', 'rebuildLedgerProjection', 'LedgerEventTypeSchema', 'LedgerClassificationSchema', 'LedgerAppendRequestSchema', 'LedgerAppendReceiptSchema', 'LedgerProjectionRequestSchema', 'LedgerProjectionSchema', 'validateLedgerAppendRequestBoundary', 'validateLedgerProjectionRequestBoundary']],",
      "  ['@jevelopers/cost-intelligence/reporting', ['querySummary', 'validateFinancialSummaryPageBoundary']],",
      "  ['@jevelopers/cost-intelligence/reconciliation', ['getReconciliation']],",
      "  ['@jevelopers/cost-intelligence/integrations', ['exportSummary', 'releaseExportDisclosure', 'validateExportRequestBoundary']],",
      '];',
      'for (const [specifier, names] of entries) { const mod = await import(specifier); for (const name of names) if (!(name in mod)) throw new Error(`${specifier} missing ${name}`); }',
      "import assert from 'node:assert/strict';",
      "import { readFile } from 'node:fs/promises';",
      "import { createRequire } from 'node:module';",
      "import * as pricing from '@jevelopers/cost-intelligence/pricing';",
      "const packageRequire = createRequire(new URL('./node_modules/@jevelopers/cost-intelligence/package.json', import.meta.url));",
      "const { FormatRegistry } = packageRequire('@sinclair/typebox');",
      "const { Value } = packageRequire('@sinclair/typebox/value');",
      "if (!FormatRegistry.Has('date-time')) FormatRegistry.Set('date-time', value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && value.endsWith('Z'));",
      "if (!FormatRegistry.Has('uri')) FormatRegistry.Set('uri', value => { try { return new URL(value).protocol.length > 0; } catch { return false; } });",
      "const fixtureRoot = new URL('./node_modules/@jevelopers/cost-intelligence/fixtures/pricing/', import.meta.url);",
      "const legacy = JSON.parse(await readFile(new URL('ci03-v1-compatibility.json', fixtureRoot), 'utf8'));",
      "assert.equal('PricingRuleSchema' in pricing, false);",
      "assert.equal('FxRateSchema' in pricing, false);",
      "assert.equal('VersionedReferenceSchema' in pricing, false);",
      "assert.equal(Value.Check(pricing.RateCardSchema, legacy.rate_card), true);",
      "assert.equal(Value.Check(pricing.RateCardV2Schema, legacy.rate_card), false);",
      "assert.equal(Value.Check(pricing.EstimateResultSchema, legacy.estimate_result), true);",
      "const scope = { tenantId: 'tenant-a', projectId: 'project-a', environment: 'test', billingMode: 'simulated', actorId: 'actor-a' };",
      "const legacyRequest = { schemaVersion: '1.0.0', requestId: 'old', idempotencyKey: 'old-idem', scope, usageEvent: {}, selection: { policy: 'event_time', effectiveAt: '2026-10-11T03:30:00.000Z', requestedCurrency: 'USD', rateCardRef: null } };",
      "const nextRequest = { ...legacyRequest, schemaVersion: '2.0.0', selection: { ...legacyRequest.selection, product: 'responses', fxRateRef: null, contractTimeEvidenceRef: null, contextTier: null, serviceTier: null, reasoningMode: null, toolClass: null, dimensionsEvidenceRef: null } };",
      "assert.equal(Value.Check(pricing.EstimateRequestSchema, legacyRequest), true);",
      "assert.equal(Value.Check(pricing.EstimateRequestV2Schema, legacyRequest), false);",
      "assert.equal(Value.Check(pricing.EstimateRequestV2Schema, nextRequest), true);",
      "assert.equal(Value.Check(pricing.EstimateRequestSchema, nextRequest), false);",
      "const current = JSON.parse(await readFile(new URL('ci03-synthetic-acceptance.json', fixtureRoot), 'utf8'));",
      "const ruleReference = { contract: 'PricingRule', schema_version: '2.0.0', id: current.pricing_rule.id, revision: current.pricing_rule.revision, content_hash: 'sha256:' + 'b'.repeat(64) };",
      "assert.equal(Value.Check(pricing.PricingRuleV2Schema, current.pricing_rule), true);",
      "assert.equal(Value.Check(pricing.RateCardV2Schema, { ...current.rate_card, pricingRuleRef: ruleReference }), true);",
      "const estimateResultV2 = { ...legacy.estimate_result, schemaVersion: '2.0.0', selectionPolicy: 'event_time', effectiveAt: legacy.rate_card.effectiveFrom, knownSubtotalExact: { numerator: '1', denominator: '500000' }, rateCardRef: { ...legacy.versionedReference, schema_version: '2.0.0' }, pricingRuleRef: ruleReference, fxRateRef: null, fxConvertedSubtotal: null, fxConvertedSubtotalExact: null, fxTargetCurrency: 'USD', boundedConservativeAuthorizationAmountExact: null, calculation: [{ usageUnit: 'input_tokens', category: 'input', quantity: '1', unit: 'token', basisQuantity: '1000000', rate: '2', exactAmount: { numerator: '1', denominator: '500000' }, extendedAmount: '0.000002', relation: 'standalone' }] };",
      "assert.equal(Value.Check(pricing.EstimateResultV2Schema, estimateResultV2), true);",
    ].join('\n');
    await writeFile(join(consumer, 'consumer.mjs'), runtime);
    run(process.execPath, [join(consumer, 'consumer.mjs')], consumer, 'packed consumer runtime imports');

    const evidenceDir = join(root, 'artifacts', 'evidence');
    await mkdir(evidenceDir, { recursive: true });
    await writeFile(join(evidenceDir, 'packed-consumer.json'), `${JSON.stringify({
      package: packed.name, version: packed.version, tarballSha256, tarballBytes: packed.size, packedFileCount: packed.files.length,
      installation: 'offline_clean_consumer', declarations: 'strict_NodeNext_compile_passed',
      publicResultTypes: 'all_fifteen_exact_api_result_payloads_compiled_and_narrowed',
      runtimeExports: 'all_declared_subpaths_imported',
    }, null, 2)}\n`);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
