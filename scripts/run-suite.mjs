import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { suitePlan } from './suite-policy.mjs';
import { summarizeTap } from './tap-summary.mjs';
import { sanitizeOutput } from './sanitize.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const [suite, ...flags] = process.argv.slice(2);
if (!suite) {
  console.error('Usage: node scripts/run-suite.mjs <suite> [--offline] [--suite=<selector>]');
  process.exit(2);
}
const selectorFlags = flags.filter(flag => flag.startsWith('--suite='));
const selector = selectorFlags.length === 1 ? selectorFlags[0].slice('--suite='.length) : undefined;
const argumentErrors = [];
if (selectorFlags.length > 1) argumentErrors.push('only one --suite selector may be provided');
if (flags.some(flag => flag !== '--offline' && !flag.startsWith('--suite='))) argumentErrors.push('unsupported test-runner argument');
if (flags.includes('--suite')) argumentErrors.push('suite selector must use --suite=<selector>');
const runId = `${new Date().toISOString().replaceAll(':', '').replaceAll('.', '')}-${process.pid}`;
const testRoot = join(root, 'tests');
const existingFiles = new Set();
async function walk(dir) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) await walk(absolute);
    else if (entry.isFile() && entry.name.endsWith('.test.mjs')) existingFiles.add(absolute.slice(root.length + 1));
  }
}
await walk(testRoot);
const plan = suitePlan(suite, existingFiles, selector);
const selectionErrors = [...plan.selectorErrors, ...argumentErrors];
const selectedFiles = selectionErrors.length ? [] : plan.selectedFiles;
const databaseEnvironmentKeys = [
  'CI_TEST_DB_HOST', 'CI_TEST_DB_PORT', 'CI_TEST_DB_USER', 'CI_TEST_DB_PASSWORD', 'CI_TEST_DB_NAME',
  'CI_TEST_PREVIOUS_DB_HOST', 'CI_TEST_PREVIOUS_DB_PORT', 'CI_TEST_PREVIOUS_DB_USER', 'CI_TEST_PREVIOUS_DB_PASSWORD', 'CI_TEST_PREVIOUS_DB_NAME',
  'CI_TEST_MIGRATIONS', 'CI_TEST_PREVIOUS_MIGRATIONS', 'CI_TEST_PREVIOUS_FIXTURE_LOADED',
];
const testEnvironment = { PATH: process.env.PATH ?? '', CI: '1', NODE_ENV: 'test' };
for (const key of databaseEnvironmentKeys) if (process.env[key] !== undefined) testEnvironment[key] = process.env[key];
const output = selectedFiles.length > 0
  ? spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...selectedFiles.map(path => join(root, path))], {
      cwd: root, encoding: 'utf8', env: testEnvironment,
    })
  : { status: 1, stdout: '', stderr: selectionErrors.length ? `Invalid test selection: ${selectionErrors.join('; ')}` : 'No test files were selected; empty suites fail closed.' };
const sensitiveValues = [process.env.CI_TEST_DATABASE_URL, process.env.CI_TEST_DB_PASSWORD, process.env.CI_TEST_PREVIOUS_DB_PASSWORD];
try {
  if (process.env.CI_TEST_DATABASE_URL) {
    const parsed = new URL(process.env.CI_TEST_DATABASE_URL);
    sensitiveValues.push(decodeURIComponent(parsed.username), decodeURIComponent(parsed.password));
  }
} catch {}
const stdout = sanitizeOutput(output.stdout ?? '', sensitiveValues);
const stderr = sanitizeOutput(output.stderr ?? '', sensitiveValues);
if (stdout) process.stdout.write(stdout);
if (stderr) process.stderr.write(stderr);
const summary = summarizeTap(stdout, output.status ?? 1);
const testCount = summary.tests;
const passed = output.status === 0 && selectionErrors.length === 0 && plan.missingFiles.length === 0 && summary.meaningfulPass;
const blocker = selectionErrors.length ? 'invalid_suite_selector'
  : plan.missingFiles.length > 0 ? 'required_test_files_missing'
    : summary.tests === 0 ? 'empty_test_suite'
      : summary.skipped > 0 || summary.todo > 0 || summary.cancelled > 0 ? 'non_executed_tests_present'
        : output.status !== 0 || !summary.meaningfulPass ? 'test_process_failed' : null;
const lock = JSON.parse(await readFile(join(root, 'contracts.lock.json'), 'utf8'));
const evidence = {
  manifestVersion: '1.0.0', runId, suite, flags, status: passed ? 'passed' : (suite === 'integration' || suite === 'release') ? 'blocked' : 'failed',
  exitCode: passed ? 0 : 1, blocker, selector: selector ?? null, selectorErrors: selectionErrors, selectedTestFiles: selectedFiles, missingRequiredTestFiles: plan.missingFiles,
  requiredDomainSuites: plan.requiredDomainSuites, deferredDomainSuites: plan.deferredDomainSuites,
  testCount, testExitCode: output.status ?? 1,
  executedTestCount: summary.executed, passedTestCount: summary.passed, skippedTestCount: summary.skipped, todoTestCount: summary.todo,
  offline: flags.includes('--offline'), externalCalls: 0,
  sharedContracts: { package: lock.producer.package, revision: lock.producer.head, archiveSha256: lock.producer.archive_sha256, adoptionAccepted: false, status: lock.status, blockers: lock.producer.review_findings },
  outputSha256: createHash('sha256').update(stdout).digest('hex'), recordedAt: new Date().toISOString(),
};
const targetDir = join(root, 'artifacts', 'test-manifests');
await mkdir(targetDir, { recursive: true });
const manifestPath = join(targetDir, `${suite}-${runId}.json`);
await writeFile(manifestPath, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(`evidence manifest: ${manifestPath.slice(root.length + 1)}`);
if (!passed) {
  console.error(`suite ${suite} failed closed (${blocker}); tests=${testCount}; missing=${plan.missingFiles.length}; selectionErrors=${selectionErrors.length}`);
  process.exitCode = 1;
}
