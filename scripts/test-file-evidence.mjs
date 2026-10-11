import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const reporterPath = resolve(scriptDirectory, 'test-event-reporter.mjs');

export function assessTestFileEvidence(summary, exitCode) {
  if (!summary || typeof summary !== 'object') return { passed: false, reason: 'structured_file_summary_missing' };
  if (!summary.fileSummary) return { passed: false, reason: exitCode === 0 && summary.registeredTestCaseCount === 0 ? 'required_test_file_empty' : 'structured_file_summary_missing' };
  const counts = summary.fileSummary.counts;
  if (summary.registeredTestCaseCount === 0) return { passed: false, reason: 'required_test_file_empty' };
  if (summary.completedTestCaseCount !== summary.registeredTestCaseCount
      || counts.tests !== summary.registeredTestCaseCount) {
    return { passed: false, reason: 'registered_and_completed_test_counts_differ' };
  }
  if (summary.skippedTestCaseCount > 0 || counts.skipped !== 0) return { passed: false, reason: 'skipped_test_case_present' };
  if (summary.todoTestCaseCount > 0 || counts.todo !== 0) return { passed: false, reason: 'todo_test_case_present' };
  if (counts.cancelled !== 0) return { passed: false, reason: 'cancelled_test_case_present' };
  if (summary.failedTestCaseCount > 0 || counts.failed !== 0 || exitCode !== 0 || !summary.fileSummary.success) {
    return { passed: false, reason: 'test_case_failed' };
  }
  if (summary.passedTestCaseCount !== summary.registeredTestCaseCount || counts.passed !== summary.registeredTestCaseCount) {
    return { passed: false, reason: 'not_all_registered_test_cases_executed' };
  }
  return { passed: true, reason: null };
}

export function requiredFilesHavePassingEvidence(requiredFiles, fileEvidence) {
  if (requiredFiles.length === 0 || fileEvidence.length !== requiredFiles.length) return false;
  const evidenceByPath = new Map(fileEvidence.map(entry => [entry.path, entry]));
  return requiredFiles.every(path => evidenceByPath.get(path)?.passed === true);
}

export function runTestFile(file, options = {}) {
  const absoluteFile = resolve(file);
  const env = { ...(options.env ?? process.env) };
  delete env.NODE_TEST_CONTEXT;
  const child = spawnSync(process.execPath, ['--test', `--test-reporter=${reporterPath}`, absoluteFile], {
    cwd: options.cwd ?? process.cwd(),
    env,
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 120_000,
    windowsHide: true,
  });

  let summary = null;
  const output = (child.stdout ?? '').trim();
  if (output) {
    try { summary = JSON.parse(output); } catch {}
  }
  const exitCode = Number.isInteger(child.status) ? child.status : 1;
  const assessment = assessTestFileEvidence(summary, exitCode);
  return {
    ...assessment,
    exitCode,
    ...summary,
    registeredTestCaseCount: summary?.registeredTestCaseCount ?? 0,
    completedTestCaseCount: summary?.completedTestCaseCount ?? 0,
    passedTestCaseCount: summary?.passedTestCaseCount ?? 0,
    failedTestCaseCount: summary?.failedTestCaseCount ?? 0,
    skippedTestCaseCount: summary?.skippedTestCaseCount ?? 0,
    todoTestCaseCount: summary?.todoTestCaseCount ?? 0,
    fileSummary: summary?.fileSummary ?? null,
  };
}
