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
    ['@jevelopers/cost-intelligence', ['ingestUsage', 'estimate', 'authorize', 'settle', 'release', 'changeBudget', 'recordExpenseAdjustment', 'ingestFinancial', 'querySummary', 'startReconciliation', 'getReconciliation', 'exportSummary']],
    ['@jevelopers/cost-intelligence/contracts', ['ErrorEnvelopeSchema', 'TrustedScopeSchema']],
    ['@jevelopers/cost-intelligence/metering', ['ingestUsage', 'UsageObservationSchema']],
    ['@jevelopers/cost-intelligence/pricing', ['estimate', 'EstimateRequestSchema']],
    ['@jevelopers/cost-intelligence/budgets', ['authorize', 'settle', 'BudgetChangeRequestSchema']],
    ['@jevelopers/cost-intelligence/ledger', ['ingestFinancial', 'FinancialEventSchema']],
    ['@jevelopers/cost-intelligence/reporting', ['querySummary', 'FinancialSummaryPageSchema']],
    ['@jevelopers/cost-intelligence/reconciliation', ['startReconciliation', 'getReconciliation']],
    ['@jevelopers/cost-intelligence/integrations', ['exportSummary', 'ExportManifestSchema']],
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
      "import { ingestUsage as rootIngest, estimate, authorize, settle, release, changeBudget, recordExpenseAdjustment, ingestFinancial, querySummary, startReconciliation, getReconciliation, exportSummary } from '@jevelopers/cost-intelligence';",
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
      "  ['@jevelopers/cost-intelligence', ['ingestUsage', 'estimate', 'authorize', 'settle', 'release', 'changeBudget', 'recordExpenseAdjustment', 'ingestFinancial', 'querySummary', 'startReconciliation', 'getReconciliation', 'exportSummary']],",
      "  ['@jevelopers/cost-intelligence/contracts', ['ErrorEnvelopeSchema']],",
      "  ['@jevelopers/cost-intelligence/metering', ['ingestUsage']],",
      "  ['@jevelopers/cost-intelligence/pricing', ['estimate']],",
      "  ['@jevelopers/cost-intelligence/budgets', ['authorize']],",
      "  ['@jevelopers/cost-intelligence/ledger', ['ingestFinancial']],",
      "  ['@jevelopers/cost-intelligence/reporting', ['querySummary']],",
      "  ['@jevelopers/cost-intelligence/reconciliation', ['getReconciliation']],",
      "  ['@jevelopers/cost-intelligence/integrations', ['exportSummary']],",
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
      runtimeExports: 'all_declared_subpaths_imported',
    }, null, 2)}\n`);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
