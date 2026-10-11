import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { foundationTestFiles, databaseTestFiles, deferredDomainSuites, requiredDomainSuites, suitePlan } from '../../scripts/suite-policy.mjs';
import { sanitizeOutput } from '../../scripts/sanitize.mjs';
import { summarizeTap } from '../../scripts/tap-summary.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

async function testFilesBelow(directory) {
  const result = new Set();
  async function walk(parent) {
    let entries;
    try { entries = await readdir(join(root, parent), { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const relative = join(parent, entry.name);
      if (entry.isDirectory()) await walk(relative);
      else if (entry.name.endsWith('.test.mjs')) result.add(relative);
    }
  }
  await walk(directory);
  return result;
}

test('foundation suites name nonempty real evidence and integration/release fail closed on missing leaves', async () => {
  const existing = await testFilesBelow('tests');
  for (const file of foundationTestFiles) assert.ok(existing.has(file), `missing foundation test ${file}`);
  for (const file of databaseTestFiles) assert.ok(existing.has(file), `missing database test ${file}`);
  const unit = suitePlan('unit', existing);
  assert.equal(unit.missingFiles.length, 0);
  assert.ok(unit.selectedFiles.length >= 5);
  const integration = suitePlan('integration', existing);
  const release = suitePlan('release', existing);
  assert.deepEqual(integration.requiredDomainSuites, requiredDomainSuites);
  assert.deepEqual(integration.deferredDomainSuites, deferredDomainSuites);
  assert.deepEqual(integration.deferredDomainSuites, [{ suite: 'budgets', selector: 'nested-scopes', issue: 17, priority: 'P1', status: 'assigned_not_v1' }]);
  assert.ok(integration.missingFiles.some(file => file.startsWith('tests/accounting/')));
  assert.ok(release.missingFiles.some(file => file.startsWith('tests/recovery/')));
  assert.equal(suitePlan('release', new Set()).selectedFiles.length, 0);
  assert.ok(suitePlan('release', new Set()).missingFiles.length > 0);

  const authorization = suitePlan('budgets', existing, 'authorization');
  assert.deepEqual(authorization.requiredFiles, ['tests/budgets/authorization.test.mjs']);
  assert.deepEqual(authorization.selectedFiles, []);
  assert.deepEqual(authorization.missingFiles, ['tests/budgets/authorization.test.mjs']);
  assert.deepEqual(suitePlan('budgets', existing, 'authorization,contention').requiredFiles, [
    'tests/budgets/authorization.test.mjs', 'tests/budgets/contention.test.mjs',
  ]);
  const invalid = suitePlan('budgets', existing, 'authorization,not-a-suite');
  assert.ok(invalid.selectorErrors.length > 0);
  assert.deepEqual(invalid.selectedFiles, []);
  assert.deepEqual(suitePlan('budgets', existing, '').selectedFiles, []);
});

test('release suite requires domain leaves and never treats an empty test set as passing', async () => {
  const runner = await readFile(join(root, 'scripts/run-suite.mjs'), 'utf8');
  assert.match(runner, /summary\.meaningfulPass/);
  assert.match(runner, /plan\.missingFiles\.length === 0/);
  assert.match(runner, /empty_test_suite/);
  assert.match(runner, /required_test_files_missing/);
  assert.match(runner, /invalid_suite_selector/);
  assert.match(runner, /adoptionAccepted: false/);
});

test('runner rejects invalid and empty selectors without falling back to the full suite', async () => {
  for (const selector of ['not-a-suite', '']) {
    const result = spawnSync(process.execPath, ['scripts/run-suite.mjs', 'budgets', `--suite=${selector}`], {
      cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', CI: '1' },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /invalid_suite_selector/);
    assert.doesNotMatch(result.stdout, /TAP version/);
    const manifestPath = result.stdout.match(/evidence manifest: (.+)$/m)?.[1];
    assert.ok(manifestPath);
    const evidence = JSON.parse(await readFile(join(root, manifestPath), 'utf8'));
    assert.equal(evidence.status, 'failed');
    assert.deepEqual(evidence.selectedTestFiles, []);
    assert.ok(evidence.selectorErrors.length > 0);
  }
});

test('TAP evidence rejects empty, skipped, todo, cancelled, and failed suites', () => {
  const successful = '1..2\n# tests 2\n# pass 2\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n';
  assert.equal(summarizeTap(successful, 0).meaningfulPass, true);
  assert.equal(summarizeTap('# tests 0\n# pass 0\n# fail 0\n', 0).meaningfulPass, false);
  assert.equal(summarizeTap('# tests 2\n# pass 1\n# fail 0\n# skipped 1\n# todo 0\n# cancelled 0\n', 0).meaningfulPass, false);
  assert.equal(summarizeTap('# tests 2\n# pass 1\n# fail 0\n# skipped 0\n# todo 1\n# cancelled 0\n', 0).meaningfulPass, false);
  assert.equal(summarizeTap('# tests 1\n# pass 0\n# fail 0\n# skipped 0\n# todo 0\n# cancelled 1\n', 0).meaningfulPass, false);
  assert.equal(summarizeTap('# tests 1\n# pass 0\n# fail 1\n# skipped 0\n# todo 0\n# cancelled 0\n', 1).meaningfulPass, false);
});

test('child output redacts database URLs, bearer tokens, password fields, and canaries', () => {
  const output = sanitizeOutput('db=postgresql://worker:pw@host/ci token=abc Authorization: Bearer abc PRIVATE_REQUEST_ID_CANARY', ['worker', 'pw', 'abc']);
  assert.doesNotMatch(output, /postgresql:\/\/worker|token=abc|Bearer abc|PRIVATE_REQUEST_ID_CANARY/);
  assert.match(output, /REDACTED_DATABASE_URL/);
  assert.match(output, /REDACTED_CANARY/);
});
