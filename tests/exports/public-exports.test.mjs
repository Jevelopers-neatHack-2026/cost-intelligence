import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

test('package root and every declared subpath resolve to ESM modules and declarations', async () => {
  const modules = [
    ['@jevelopers/cost-intelligence', ['ingestUsage', 'estimate', 'authorize', 'settle', 'release', 'changeBudget', 'recordExpenseAdjustment', 'ingestFinancial', 'querySummary', 'startReconciliation', 'getReconciliation', 'exportSummary', 'validateUsageObservationBoundary', 'validateEstimateRequestBoundary', 'validateReservationRequestBoundary', 'validateSettleReservationCommandBoundary', 'validateReleaseReservationCommandBoundary', 'validateReservationCommandBoundary', 'validateReservationSnapshotBoundary', 'validateFinancialSummaryPageBoundary', 'validateExportRequestBoundary']],
    ['@jevelopers/cost-intelligence/contracts', ['ErrorEnvelopeSchema', 'TrustedScopeSchema']],
    ['@jevelopers/cost-intelligence/metering', ['ingestUsage', 'UsageObservationSchema', 'validateUsageObservationBoundary']],
    ['@jevelopers/cost-intelligence/pricing', ['estimate', 'EstimateRequestSchema', 'validateEstimateRequestBoundary']],
    ['@jevelopers/cost-intelligence/budgets', ['authorize', 'settle', 'BudgetChangeRequestSchema', 'validateReservationRequestBoundary', 'validateSettleReservationCommandBoundary', 'validateReleaseReservationCommandBoundary', 'validateReservationCommandBoundary', 'validateReservationSnapshotBoundary']],
    ['@jevelopers/cost-intelligence/ledger', ['ingestFinancial', 'FinancialEventSchema']],
    ['@jevelopers/cost-intelligence/reporting', ['querySummary', 'FinancialSummaryPageSchema', 'validateFinancialSummaryPageBoundary']],
    ['@jevelopers/cost-intelligence/reconciliation', ['startReconciliation', 'getReconciliation']],
    ['@jevelopers/cost-intelligence/integrations', ['exportSummary', 'ExportManifestSchema', 'validateExportRequestBoundary']],
  ];
  for (const [specifier, names] of modules) {
    const imported = await import(specifier);
    for (const name of names) assert.ok(name in imported, `${specifier} missing ${name}`);
  }
  await access(join(root, 'dist/index.d.ts'));
  const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  for (const specifier of Object.keys(packageJson.exports).filter(name => name !== '.')) {
    const target = packageJson.exports[specifier];
    await access(join(root, target.types));
    await access(join(root, target.import));
  }
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
      env: { PATH: process.env.PATH ?? '', CI: '1', npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false' },
    });
    assert.equal(result.status, 0, `${label} failed (status=${result.status ?? 'null'}, error=${result.error?.message ?? 'none'}): ${(result.stderr || result.stdout || 'no output').slice(0, 1600)}`);
    return result.stdout;
  }

  try {
    const packOutput = run('npm', ['pack', '--json', '--pack-destination', tarballs], root, 'npm pack');
    const packed = JSON.parse(packOutput)[0];
    const packedPaths = packed.files.map(file => file.path);
    assert.ok(!packedPaths.some(path => path.startsWith('tests/') || path.startsWith('artifacts/')), 'test code and local evidence must stay out of the package');
    assert.ok(!packedPaths.some(path => /^node_modules\/(?:pg|typescript)(?:\/|$)/.test(path)), 'database and compiler development tools must stay out of the runtime package');
    for (const path of ['examples/worker-composition.ts', 'fixtures/api/error-envelope.response.json', 'fixtures/api/financial-event-unknown.request.json', 'fixtures/api/summary-query.request.json', 'fixtures/api/decision-results.response.json']) {
      assert.ok(packedPaths.includes(path), `sanitized consumer example is missing from package: ${path}`);
    }
    const tarball = join(tarballs, packed.filename);
    const archive = await readFile(tarball);
    const tarballSha256 = createHash('sha256').update(archive).digest('hex');

    await writeFile(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
    await writeFile(join(consumer, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, noEmit: true, skipLibCheck: false },
      include: ['consumer.mts', 'worker-composition.mts'],
    }));
    await writeFile(join(consumer, 'consumer.mts'), [
      "import { ingestUsage as rootIngest, estimate, authorize, settle, release, changeBudget, recordExpenseAdjustment, ingestFinancial, querySummary, startReconciliation, getReconciliation, exportSummary, validateUsageObservationBoundary, validateEstimateRequestBoundary, validateReservationRequestBoundary, validateSettleReservationCommandBoundary, validateReleaseReservationCommandBoundary, validateReservationCommandBoundary, validateReservationSnapshotBoundary, validateFinancialSummaryPageBoundary, validateExportRequestBoundary } from '@jevelopers/cost-intelligence';",
      "import type { ApiResult, Validation, RuntimePorts, IngestionReceipt, EstimateResult, AuthorizationDecision, ReservationSnapshot, BudgetChangeReceipt, PostingReceipt, FinancialSummaryPage, ReconciliationRun, ReconciliationResult, ExportManifest, UsageObservation, EstimateRequest, ReservationRequest, SettleReservationCommand, ReleaseReservationCommand, ReservationCommand, ExportRequest } from '@jevelopers/cost-intelligence';",
      "type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? ((<T>() => T extends B ? 1 : 2) extends (<T>() => T extends A ? 1 : 2) ? true : false) : false;",
      'type NotAny<T> = 0 extends (1 & T) ? false : true;',
      'type Check<T extends true> = T;',
      'type ExactPublicResults = [',
      '  Check<Equal<Awaited<ReturnType<typeof rootIngest>>, ApiResult<IngestionReceipt>>>,',
      '  Check<Equal<Awaited<ReturnType<typeof estimate>>, ApiResult<EstimateResult>>>,',
      '  Check<Equal<Awaited<ReturnType<typeof authorize>>, ApiResult<AuthorizationDecision>>>,',
      '  Check<Equal<Awaited<ReturnType<typeof settle>>, ApiResult<ReservationSnapshot>>>,',
      '  Check<Equal<Awaited<ReturnType<typeof release>>, ApiResult<ReservationSnapshot>>>,',
      '  Check<Equal<Awaited<ReturnType<typeof changeBudget>>, ApiResult<BudgetChangeReceipt>>>,',
      '  Check<Equal<Awaited<ReturnType<typeof recordExpenseAdjustment>>, ApiResult<PostingReceipt>>>,',
      '  Check<Equal<Awaited<ReturnType<typeof ingestFinancial>>, ApiResult<PostingReceipt>>>,',
      '  Check<Equal<Awaited<ReturnType<typeof querySummary>>, ApiResult<FinancialSummaryPage>>>,',
      '  Check<Equal<Awaited<ReturnType<typeof startReconciliation>>, ApiResult<ReconciliationRun>>>,',
      '  Check<Equal<Awaited<ReturnType<typeof getReconciliation>>, ApiResult<ReconciliationResult>>>,',
      '  Check<Equal<Awaited<ReturnType<typeof exportSummary>>, ApiResult<ExportManifest>>>,',
      '  Check<NotAny<Awaited<ReturnType<typeof rootIngest>>>>, Check<NotAny<Awaited<ReturnType<typeof estimate>>>>,',
      '  Check<NotAny<Awaited<ReturnType<typeof authorize>>>>, Check<NotAny<Awaited<ReturnType<typeof settle>>>>, Check<NotAny<Awaited<ReturnType<typeof release>>>>,',
      '  Check<NotAny<Awaited<ReturnType<typeof changeBudget>>>>, Check<NotAny<Awaited<ReturnType<typeof recordExpenseAdjustment>>>>,',
      '  Check<NotAny<Awaited<ReturnType<typeof ingestFinancial>>>>, Check<NotAny<Awaited<ReturnType<typeof querySummary>>>>,',
      '  Check<NotAny<Awaited<ReturnType<typeof startReconciliation>>>>, Check<NotAny<Awaited<ReturnType<typeof getReconciliation>>>>,',
      '  Check<NotAny<Awaited<ReturnType<typeof exportSummary>>>>,',
      '];',
      'type ExactCombinedValidators = [',
      '  Check<Equal<ReturnType<typeof validateUsageObservationBoundary>, Validation<UsageObservation>>>,',
      '  Check<Equal<ReturnType<typeof validateEstimateRequestBoundary>, Validation<EstimateRequest>>>,',
      '  Check<Equal<ReturnType<typeof validateReservationRequestBoundary>, Validation<ReservationRequest>>>,',
      '  Check<Equal<ReturnType<typeof validateSettleReservationCommandBoundary>, Validation<SettleReservationCommand>>>,',
      '  Check<Equal<ReturnType<typeof validateReleaseReservationCommandBoundary>, Validation<ReleaseReservationCommand>>>,',
      '  Check<Equal<ReturnType<typeof validateReservationCommandBoundary>, Validation<ReservationCommand>>>,',
      '  Check<Equal<ReturnType<typeof validateReservationSnapshotBoundary>, Validation<ReservationSnapshot>>>,',
      '  Check<Equal<ReturnType<typeof validateFinancialSummaryPageBoundary>, Validation<FinancialSummaryPage>>>,',
      '  Check<Equal<ReturnType<typeof validateExportRequestBoundary>, Validation<ExportRequest>>>,',
      '];',
      'declare const runtimePorts: RuntimePorts;',
      'async function consumeTypedResults() {',
      '  const a = await rootIngest(undefined as never, runtimePorts); const aa: ApiResult<IngestionReceipt> = a; if (aa.ok) { const v: IngestionReceipt["status"] = aa.value.status; void v; }',
      '  const b = await estimate(undefined as never, runtimePorts); const bb: ApiResult<EstimateResult> = b; if (bb.ok) { const v: EstimateResult["status"] = bb.value.status; void v; }',
      '  const c = await authorize(undefined as never, runtimePorts); const cc: ApiResult<AuthorizationDecision> = c; if (cc.ok) { const v: AuthorizationDecision["status"] = cc.value.status; void v; }',
      '  const d = await settle(undefined as never, runtimePorts); const dd: ApiResult<ReservationSnapshot> = d; if (dd.ok) { const v: ReservationSnapshot["state"] = dd.value.state; void v; }',
      '  const e = await release(undefined as never, runtimePorts); const ee: ApiResult<ReservationSnapshot> = e; if (ee.ok) { const v: ReservationSnapshot["state"] = ee.value.state; void v; }',
      '  const f = await changeBudget(undefined as never, runtimePorts); const ff: ApiResult<BudgetChangeReceipt> = f; if (ff.ok) { const v: BudgetChangeReceipt["status"] = ff.value.status; void v; }',
      '  const g = await recordExpenseAdjustment(undefined as never, runtimePorts); const gg: ApiResult<PostingReceipt> = g; if (gg.ok) { const v: PostingReceipt["postingId"] = gg.value.postingId; void v; }',
      '  const h = await ingestFinancial(undefined as never, runtimePorts); const hh: ApiResult<PostingReceipt> = h; if (hh.ok) { const v: PostingReceipt["postingId"] = hh.value.postingId; void v; }',
      '  const i = await querySummary(undefined as never, runtimePorts); const ii: ApiResult<FinancialSummaryPage> = i; if (ii.ok) { const v: FinancialSummaryPage["snapshotId"] = ii.value.snapshotId; void v; }',
      '  const j = await startReconciliation(undefined as never, runtimePorts); const jj: ApiResult<ReconciliationRun> = j; if (jj.ok) { const v: ReconciliationRun["runId"] = jj.value.runId; void v; }',
      '  const k = await getReconciliation(undefined as never, runtimePorts); const kk: ApiResult<ReconciliationResult> = k; if (kk.ok) { const v: ReconciliationResult["unknownVarianceCount"] = kk.value.unknownVarianceCount; void v; }',
      '  const l = await exportSummary(undefined as never, runtimePorts); const ll: ApiResult<ExportManifest> = l; if (ll.ok) { const v: ExportManifest["exportId"] = ll.value.exportId; void v; }',
      '}',
      'void [consumeTypedResults, validateUsageObservationBoundary, validateEstimateRequestBoundary, validateReservationRequestBoundary, validateSettleReservationCommandBoundary, validateReleaseReservationCommandBoundary, validateReservationCommandBoundary, validateReservationSnapshotBoundary, validateFinancialSummaryPageBoundary, validateExportRequestBoundary];',
      "import * as contracts from '@jevelopers/cost-intelligence/contracts';",
      "import * as metering from '@jevelopers/cost-intelligence/metering';",
      "import * as pricing from '@jevelopers/cost-intelligence/pricing';",
      "import * as budgets from '@jevelopers/cost-intelligence/budgets';",
      "import * as ledger from '@jevelopers/cost-intelligence/ledger';",
      "import * as reporting from '@jevelopers/cost-intelligence/reporting';",
      "import * as reconciliation from '@jevelopers/cost-intelligence/reconciliation';",
      "import * as integrations from '@jevelopers/cost-intelligence/integrations';",
      'void [rootIngest, estimate, authorize, settle, release, changeBudget, recordExpenseAdjustment, ingestFinancial, querySummary, startReconciliation, getReconciliation, exportSummary, contracts.ErrorEnvelopeSchema, metering.ingestUsage, pricing.estimate, budgets.authorize, ledger.ingestFinancial, reporting.querySummary, reconciliation.getReconciliation, integrations.exportSummary];',
    ].join('\n'));
    await writeFile(join(consumer, 'worker-composition.mts'), await readFile(join(root, 'examples/worker-composition.ts'), 'utf8'));

    run('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', tarball], consumer, 'offline packed consumer install');
    run(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--project', join(consumer, 'tsconfig.json')], root, 'packed consumer declaration compile');
    const runtime = [
      "const entries = [",
      "  ['@jevelopers/cost-intelligence', ['ingestUsage', 'estimate', 'authorize', 'settle', 'release', 'changeBudget', 'recordExpenseAdjustment', 'ingestFinancial', 'querySummary', 'startReconciliation', 'getReconciliation', 'exportSummary', 'validateUsageObservationBoundary', 'validateEstimateRequestBoundary', 'validateReservationRequestBoundary', 'validateSettleReservationCommandBoundary', 'validateReleaseReservationCommandBoundary', 'validateReservationCommandBoundary', 'validateReservationSnapshotBoundary', 'validateFinancialSummaryPageBoundary', 'validateExportRequestBoundary']],",
      "  ['@jevelopers/cost-intelligence/contracts', ['ErrorEnvelopeSchema']],",
      "  ['@jevelopers/cost-intelligence/metering', ['ingestUsage', 'validateUsageObservationBoundary']],",
      "  ['@jevelopers/cost-intelligence/pricing', ['estimate', 'validateEstimateRequestBoundary']],",
      "  ['@jevelopers/cost-intelligence/budgets', ['authorize', 'validateReservationRequestBoundary', 'validateSettleReservationCommandBoundary', 'validateReleaseReservationCommandBoundary', 'validateReservationCommandBoundary', 'validateReservationSnapshotBoundary']],",
      "  ['@jevelopers/cost-intelligence/ledger', ['ingestFinancial']],",
      "  ['@jevelopers/cost-intelligence/reporting', ['querySummary', 'validateFinancialSummaryPageBoundary']],",
      "  ['@jevelopers/cost-intelligence/reconciliation', ['getReconciliation']],",
      "  ['@jevelopers/cost-intelligence/integrations', ['exportSummary', 'validateExportRequestBoundary']],",
      '];',
      'for (const [specifier, names] of entries) { const mod = await import(specifier); for (const name of names) if (!(name in mod)) throw new Error(`${specifier} missing ${name}`); }',
    ].join('\n');
    await writeFile(join(consumer, 'consumer.mjs'), runtime);
    run(process.execPath, [join(consumer, 'consumer.mjs')], consumer, 'packed consumer runtime imports');

    const evidenceDir = join(root, 'artifacts', 'evidence');
    await mkdir(evidenceDir, { recursive: true });
    await writeFile(join(evidenceDir, 'packed-consumer.json'), `${JSON.stringify({
      package: packed.name, version: packed.version, tarballSha256, tarballBytes: packed.size, packedFileCount: packed.files.length,
      installation: 'offline_clean_consumer', declarations: 'strict_NodeNext_compile_passed',
      publicResultTypes: 'all_thirteen_exact_api_result_payloads_compiled_and_narrowed',
      runtimeExports: 'all_declared_subpaths_imported',
    }, null, 2)}\n`);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
