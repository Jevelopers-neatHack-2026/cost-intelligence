import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { suitePlan } from './suite-policy.mjs';
import { requiredFilesHavePassingEvidence, runTestFile } from './test-file-evidence.mjs';

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
const fileEvidence = [];
for (const path of selectedFiles) {
  const result = runTestFile(join(root, path), { cwd: root, env: testEnvironment });
  fileEvidence.push({ path, ...result });
}
const total = field => fileEvidence.reduce((sum, entry) => sum + (entry[field] ?? 0), 0);
const summary = {
  tests: total('registeredTestCaseCount'),
  passed: total('passedTestCaseCount'),
  failed: total('failedTestCaseCount'),
  skipped: total('skippedTestCaseCount'),
  todo: total('todoTestCaseCount'),
  cancelled: fileEvidence.reduce((sum, entry) => sum + (entry.fileSummary?.counts?.cancelled ?? 0), 0),
  executed: total('passedTestCaseCount') + total('failedTestCaseCount'),
};
const fileResultsPassed = requiredFilesHavePassingEvidence(selectedFiles, fileEvidence);
const testExitCode = fileResultsPassed ? 0 : 1;
const passed = selectionErrors.length === 0 && plan.missingFiles.length === 0 && fileResultsPassed && selectedFiles.length > 0;
const blocker = selectionErrors.length ? 'invalid_suite_selector'
  : fileEvidence.some(entry => entry.reason === 'required_test_file_empty') ? 'empty_required_test_file'
    : !fileResultsPassed ? 'test_file_evidence_failed'
      : plan.missingFiles.length > 0 ? 'required_test_files_missing'
        : summary.tests === 0 ? 'empty_test_suite'
          : summary.skipped > 0 || summary.todo > 0 || summary.cancelled > 0 ? 'non_executed_tests_present' : null;
const lock = JSON.parse(await readFile(join(root, 'contracts.lock.json'), 'utf8'));
const evidence = {
  manifestVersion: '1.0.0', runId, suite, flags, status: passed ? 'passed' : (suite === 'integration' || suite === 'release') && plan.missingFiles.length > 0 && fileResultsPassed ? 'blocked' : 'failed',
  exitCode: passed ? 0 : 1, blocker, selector: selector ?? null, selectorErrors: selectionErrors, selectedTestFiles: selectedFiles, missingRequiredTestFiles: plan.missingFiles,
  requiredDomainSuites: plan.requiredDomainSuites, deferredDomainSuites: plan.deferredDomainSuites,
  testCount: summary.tests, testExitCode,
  executedTestCount: summary.executed, passedTestCount: summary.passed, skippedTestCount: summary.skipped, todoTestCount: summary.todo,
  failedTestCount: summary.failed, cancelledTestCount: summary.cancelled, testFileEvidence: fileEvidence,
  offline: flags.includes('--offline'), externalCalls: 0,
  sharedContracts: { package: lock.producer.package, revision: lock.producer.head, archiveSha256: lock.producer.archive_sha256, adoptionAccepted: false, status: lock.status, blockers: lock.producer.review_findings },
  testFileEvidenceSha256: createHash('sha256').update(JSON.stringify(fileEvidence)).digest('hex'), recordedAt: new Date().toISOString(),
};
const targetDir = join(root, 'artifacts', 'test-manifests');
await mkdir(targetDir, { recursive: true });
const manifestPath = join(targetDir, `${suite}-${runId}.json`);
await writeFile(manifestPath, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(`evidence manifest: ${manifestPath.slice(root.length + 1)}`);
for (const entry of fileEvidence) {
  console.log(`test evidence: ${entry.path}; registered=${entry.registeredTestCaseCount}; passed=${entry.passedTestCaseCount}; failed=${entry.failedTestCaseCount}; skipped=${entry.skippedTestCaseCount}; todo=${entry.todoTestCaseCount}; cancelled=${entry.fileSummary?.counts?.cancelled ?? 'unknown'}; status=${entry.passed ? 'passed' : `failed:${entry.reason}`}`);
}
if (!passed) {
  console.error(`suite ${suite} failed closed (${blocker}); tests=${summary.tests}; missing=${plan.missingFiles.length}; selectionErrors=${selectionErrors.length}`);
  process.exitCode = 1;
}
