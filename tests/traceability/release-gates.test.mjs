import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import test, { after } from 'node:test';
import { foundationTestFiles, databaseTestFiles, deferredDomainSuites, requiredDomainSuites, suitePlan } from '../../scripts/suite-policy.mjs';
import { sanitizeOutput } from '../../scripts/sanitize.mjs';
import { requiredFilesHavePassingEvidence, runTestFile } from '../../scripts/test-file-evidence.mjs';
import testEventReporter from '../../scripts/test-event-reporter.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const evidenceFixtureDirectory = await mkdtemp(join(tmpdir(), 'ci01-test-evidence-'));
after(async () => rm(evidenceFixtureDirectory, { recursive: true, force: true }));

test('Entire graph checkpoint and workflow permissions fail closed', async () => {
  const settings = JSON.parse(await readFile(join(root, '.entire/settings.json'), 'utf8'));
  assert.equal(settings.strategy_options.push_sessions, false);
  const workflow = await readFile(join(root, '.github/workflows/entire-graph.yml'), 'utf8');
  assert.match(workflow, /type: boolean\s+default: false/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /contents: write/);
  assert.match(workflow, /github\.event_name == 'workflow_dispatch'.*inputs\.push_branch == true.*refs\/heads\/main/);
  assert.match(workflow, /Gate graph execution until plugin is pinned/);
  assert.match(workflow, /plugin_ready=false/);
  assert.match(workflow, /needs\.graph\.outputs\.plugin_ready == 'true'/);
  assert.doesNotMatch(workflow, /entire plugin install graph/);
  assert.match(workflow, /git add -- \.entire\/graph-agent\.md AGENTS\.md CLAUDE\.md/);
  const writer = workflow.slice(workflow.indexOf('  publish:'));
  assert.match(writer, /persist-credentials: true/);
  assert.doesNotMatch(writer, /github-token:|secrets\.GITHUB_TOKEN/);
  for (const name of ['AGENTS.md', 'CLAUDE.md']) {
    const instructions = await readFile(join(root, name), 'utf8');
    const generatedEnd = instructions.indexOf('<!-- entire-graph:end -->');
    const fallback = instructions.indexOf('Repository-owned fallback when Entire graph is unavailable');
    assert.ok(generatedEnd >= 0 && fallback > generatedEnd, name + ' fallback must live outside the generated block');
  }
});

test('generated graph artifact validator rejects extra files and symbolic links', async () => {
  const artifact = join(evidenceFixtureDirectory, 'graph-artifact');
  const hidden = join(artifact, '.entire');
  await mkdir(hidden, { recursive: true });
  const fallback = await readFile(join(root, 'docs/api/entire-graph-agent-fallback.md'));
  await writeFile(join(hidden, 'graph-agent.md'), 'synthetic graph instructions\n');
  const generatedBlock = Buffer.from('<!-- entire-graph:begin -->\nmanaged\n<!-- entire-graph:end -->');
  for (const name of ['AGENTS.md', 'CLAUDE.md']) {
    await writeFile(join(artifact, name), Buffer.concat([generatedBlock, fallback]));
  }
  const runValidator = () => spawnSync(process.execPath, ['scripts/validate-entire-graph-artifact.mjs', artifact], {
    cwd: root, encoding: 'utf8',
  });
  const accepted = runValidator();
  assert.equal(accepted.status, 0, accepted.stderr);

  await writeFile(join(artifact, 'unexpected.txt'), 'not allowlisted');
  const extraFile = runValidator();
  assert.equal(extraFile.status, 1);
  assert.match(extraFile.stderr, /Unexpected artifact file/);
  await unlink(join(artifact, 'unexpected.txt'));

  await unlink(join(hidden, 'graph-agent.md'));
  await symlink(join(artifact, 'AGENTS.md'), join(hidden, 'graph-agent.md'));
  const linkedFile = runValidator();
  assert.equal(linkedFile.status, 1);
  assert.match(linkedFile.stderr, /symlink/);
});

async function writeTestFixture(name, source) {
  const path = join(evidenceFixtureDirectory, name);
  await writeFile(path, source);
  return path;
}

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
  const withoutRecovery = new Set([...existing].filter(file => !file.startsWith('tests/recovery/')));
  const releaseWithoutRecovery = suitePlan('release', withoutRecovery);
  assert.deepEqual(integration.requiredDomainSuites, requiredDomainSuites);
  assert.deepEqual(integration.deferredDomainSuites, deferredDomainSuites);
  assert.deepEqual(integration.deferredDomainSuites, [{ suite: 'budgets', selector: 'nested-scopes', issue: 17, priority: 'P1', status: 'assigned_not_v1' }]);
  assert.equal(integration.missingFiles.includes('tests/accounting/accounting.test.mjs'), false, 'the actual accounting leaf is recognized by the integration plan');
  assert.ok(integration.missingFiles.some(file => file.startsWith('tests/adapters/')), 'unimplemented assigned domains remain explicitly missing');
  assert.ok(existing.has('tests/recovery/recovery.test.mjs'), 'the implemented recovery leaf contributes real suite evidence');
  assert.equal(release.missingFiles.includes('tests/recovery/recovery.test.mjs'), false,
    'the actual recovery leaf is recognized by the release plan');
  assert.deepEqual(
    releaseWithoutRecovery.missingFiles.filter(file => file !== 'tests/recovery/recovery.test.mjs'),
    release.missingFiles,
    'omitting recovery from a controlled file set restores only its missing-file evidence and preserves every other assigned-domain gap',
  );
  assert.ok(releaseWithoutRecovery.missingFiles.includes('tests/recovery/recovery.test.mjs'));
  assert.deepEqual(release.selectedFiles.filter(file => file !== 'tests/recovery/recovery.test.mjs'), releaseWithoutRecovery.selectedFiles,
    'recovery implementation cannot change which other available release tests execute');
  assert.ok(release.missingFiles.length > 0, 'other assigned domains remain explicitly missing');
  assert.equal(suitePlan('release', new Set()).selectedFiles.length, 0);
  assert.ok(suitePlan('release', new Set()).missingFiles.length > 0);

  const authorization = suitePlan('budgets', existing, 'authorization');
  assert.deepEqual(authorization.requiredFiles, ['tests/budgets/authorization.test.mjs']);
  // CI-05A delivers the budget reservation leaves, so the authorization
  // sub-suite now resolves to a present, selected test file.
  assert.deepEqual(authorization.selectedFiles, ['tests/budgets/authorization.test.mjs']);
  assert.deepEqual(authorization.missingFiles, []);
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
  assert.match(runner, /fileResultsPassed/);
  assert.match(runner, /plan\.missingFiles\.length === 0/);
  assert.match(runner, /empty_required_test_file/);
  assert.match(runner, /required_test_files_missing/);
  assert.match(runner, /invalid_suite_selector/);
  assert.match(runner, /adoptionAccepted: false/);
  assert.match(runner, /testFileEvidence/);
  assert.match(await readFile(join(root, 'scripts/run-suite.mjs'), 'utf8'), /runTestFile/);
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

test('Node 22 structured evidence rejects empty files and empty describe suites', async () => {
  const commentOnly = await writeTestFixture('comment-only.test.mjs', '// deliberately contains no tests\n');
  const emptyDescribe = await writeTestFixture('empty-describe.test.mjs', "import { describe } from 'node:test'; describe('empty suite', () => {});\n");
  const commentEvidence = runTestFile(commentOnly, { cwd: evidenceFixtureDirectory });
  const describeEvidence = runTestFile(emptyDescribe, { cwd: evidenceFixtureDirectory });
  assert.equal(commentEvidence.passed, false);
  assert.equal(commentEvidence.reason, 'required_test_file_empty');
  assert.equal(commentEvidence.registeredTestCaseCount, 0);
  assert.equal(describeEvidence.passed, false);
  assert.equal(describeEvidence.reason, 'required_test_file_empty');
  assert.equal(describeEvidence.registeredTestCaseCount, 0);
});

test('each required file needs its own nonempty executed evidence', async () => {
  const real = await writeTestFixture('one-real.test.mjs', "import test from 'node:test'; test('real assertion', () => { if (2 + 2 !== 4) throw new Error('bad arithmetic'); });\n");
  const empty = await writeTestFixture('one-empty.test.mjs', '// empty required leaf\n');
  const mixedEvidence = [
    runTestFile(real, { cwd: evidenceFixtureDirectory }),
    runTestFile(empty, { cwd: evidenceFixtureDirectory }),
  ].map((entry, index) => ({ path: index === 0 ? 'required-real.test.mjs' : 'required-empty.test.mjs', ...entry }));
  assert.equal(mixedEvidence[0].passed, true);
  assert.equal(mixedEvidence[0].registeredTestCaseCount, 1);
  assert.equal(mixedEvidence[1].passed, false);
  assert.equal(requiredFilesHavePassingEvidence(['required-real.test.mjs', 'required-empty.test.mjs'], mixedEvidence), false, 'an unrelated real file cannot satisfy an empty required file');
  assert.equal(requiredFilesHavePassingEvidence(['required-real.test.mjs'], [mixedEvidence[0]]), true);
  assert.equal(requiredFilesHavePassingEvidence(['required-real.test.mjs', 'missing.test.mjs'], [mixedEvidence[0]]), false);
});

test('Node 22 structured evidence rejects skipped, todo, cancelled, and failing cases', async () => {
  const skipped = await writeTestFixture('all-skipped.test.mjs', "import test from 'node:test'; test('skipped', { skip: true }, () => {});\n");
  const todo = await writeTestFixture('all-todo.test.mjs', "import test from 'node:test'; test('todo', { todo: true }, () => {});\n");
  const mixed = await writeTestFixture('mixed-pass-skip.test.mjs', "import test from 'node:test'; test('pass', () => {}); test('skip', { skip: true }, () => {});\n");
  const mixedTodo = await writeTestFixture('mixed-pass-todo.test.mjs', "import test from 'node:test'; test('pass', () => {}); test('todo', { todo: true }, () => {});\n");
  const cancelled = await writeTestFixture('cancelled.test.mjs', "import test from 'node:test'; test('cancelled', { signal: AbortSignal.abort() }, () => {});\n");
  const failed = await writeTestFixture('failed.test.mjs', "import test from 'node:test'; test('failure', () => { throw new Error('fixture failure'); });\n");
  const cases = [
    [runTestFile(skipped, { cwd: evidenceFixtureDirectory }), 'skipped_test_case_present'],
    [runTestFile(todo, { cwd: evidenceFixtureDirectory }), 'todo_test_case_present'],
    [runTestFile(mixed, { cwd: evidenceFixtureDirectory }), 'skipped_test_case_present'],
    [runTestFile(mixedTodo, { cwd: evidenceFixtureDirectory }), 'todo_test_case_present'],
    [runTestFile(cancelled, { cwd: evidenceFixtureDirectory }), 'cancelled_test_case_present'],
    [runTestFile(failed, { cwd: evidenceFixtureDirectory }), 'test_case_failed'],
  ];
  for (const [evidence, expectedReason] of cases) {
    assert.equal(evidence.passed, false, expectedReason);
    assert.equal(evidence.reason, expectedReason);
  }
});

test('missing required file cannot produce structured test evidence', async () => {
  const missing = join(evidenceFixtureDirectory, 'missing-required.test.mjs');
  const evidence = runTestFile(missing, { cwd: evidenceFixtureDirectory });
  assert.equal(evidence.passed, false);
  assert.equal(evidence.reason, 'structured_file_summary_missing');
  assert.equal(evidence.registeredTestCaseCount, 0);
});

test('failed test evidence identifies the source assertion without exposing private names, values or output', async () => {
  const privateValue = 'CI11_PRIVATE_DIAGNOSTIC_CANARY';
  const title = `synthetic failure ${privateValue}`;
  const source = [
    "import assert from 'node:assert/strict';",
    "import test from 'node:test';",
    `test(${JSON.stringify(title)}, () => {`,
    `  console.log(${JSON.stringify(privateValue)}); console.error(${JSON.stringify(privateValue)});`,
    `  assert.equal(${JSON.stringify(privateValue)}, 'private-expected-value');`,
    '});',
  ].join('\n');
  const file = await writeTestFixture('private-assertion.test.mjs', source);
  const evidence = runTestFile(file, { cwd: evidenceFixtureDirectory });
  assert.equal(evidence.passed, false);
  assert.equal(evidence.reason, 'test_case_failed');
  assert.equal(evidence.failedTestCaseCount, 1);
  assert.equal(evidence.omittedFailedTestCaseCount, 0);
  assert.deepEqual(evidence.failedTestCases, [{
    titleHash: createHash('sha256').update(title).digest('hex'),
    registrationLine: 3, registrationColumn: 1,
    failureLine: 5, failureColumn: 10, code: 'ERR_ASSERTION',
  }]);
  const serialized = JSON.stringify(evidence);
  for (const forbidden of [privateValue, title, 'private-expected-value', evidenceFixtureDirectory, 'AssertionError', 'console.log']) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test('failure diagnostics admit only known error codes and never change failing gate status', async () => {
  const privateValue = 'CI11_PRIVATE_ERROR_CODE_CANARY';
  const file = await writeTestFixture('private-error.test.mjs', [
    "import test from 'node:test';",
    "test('synthetic private error', () => {",
    `  const error = new Error(${JSON.stringify(privateValue)});`,
    `  error.code = ${JSON.stringify(privateValue)};`,
    '  throw error;',
    '});',
  ].join('\n'));
  const evidence = runTestFile(file, { cwd: evidenceFixtureDirectory });
  assert.equal(evidence.passed, false);
  assert.equal(evidence.failedTestCaseCount, 1);
  assert.equal(evidence.failedTestCases[0].code, 'bounded_other');
  assert.equal(evidence.failedTestCases[0].registrationLine, 2);
  assert.equal(JSON.stringify(evidence).includes(privateValue), false);
  assert.equal(requiredFilesHavePassingEvidence(['required.test.mjs'], [{ path: 'required.test.mjs', ...evidence }]), false);
});

test('failure diagnostics stay bounded while retaining the complete failure count', async () => {
  async function* events() {
    for (let index = 0; index < 300; index++) {
      yield { type: 'test:fail', data: {
        name: `synthetic failure ${index}`, file: '/synthetic/private.test.mjs', line: index + 1, column: 1,
        details: { type: 'test', error: new Error('CI11_PRIVATE_BOUNDED_CANARY') },
      } };
    }
  }
  let output = '';
  for await (const chunk of testEventReporter(events())) output += chunk;
  const evidence = JSON.parse(output);
  assert.equal(evidence.failedTestCaseCount, 300);
  assert.equal(evidence.failedTestCases.length, 128);
  assert.equal(evidence.omittedFailedTestCaseCount, 172);
  assert.equal(evidence.failedTestCases[0].registrationLine, 1);
  assert.equal(evidence.failedTestCases.at(-1).registrationLine, 128);
  assert.doesNotMatch(output, /CI11_PRIVATE_BOUNDED_CANARY|synthetic failure|\/synthetic\//);
});

test('child output redacts database URLs, bearer tokens, password fields, and canaries', () => {
  const output = sanitizeOutput('db=postgresql://worker:pw@host/ci token=abc Authorization: Bearer abc PRIVATE_REQUEST_ID_CANARY', ['worker', 'pw', 'abc']);
  assert.doesNotMatch(output, /postgresql:\/\/worker|token=abc|Bearer abc|PRIVATE_REQUEST_ID_CANARY/);
  assert.match(output, /REDACTED_DATABASE_URL/);
  assert.match(output, /REDACTED_CANARY/);
});
