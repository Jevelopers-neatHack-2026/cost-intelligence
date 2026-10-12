/** Node 22 structured reporter. Private names, assertions and stdout are omitted. */
import { createHash } from 'node:crypto';

const failureCodes = new Set(['ERR_ASSERTION', '42P01', '42703', '42883', '42501', '23505', '23514', '57014', '55P03', 'P0001']);
const positiveInteger = value => Number.isSafeInteger(value) && value > 0 ? value : null;

function boundedFailure(data) {
  let code = 'bounded_other';
  let error = data.details?.error;
  // Node wraps the assertion in a test failure. Inspect only a bounded cause
  // chain for allowlisted codes; message and stack text cannot supply locations.
  for (let depth = 0; depth < 4 && error && typeof error === 'object'; depth++, error = error.cause) {
    if (failureCodes.has(error.code)) code = error.code;
  }
  return {
    titleHash: typeof data.name === 'string' ? createHash('sha256').update(data.name).digest('hex') : null,
    registrationLine: positiveInteger(data.line), registrationColumn: positiveInteger(data.column),
    code,
  };
}

export default async function* testEventReporter(source) {
  let registeredTestCaseCount = 0;
  let completedTestCaseCount = 0;
  let passedTestCaseCount = 0;
  let failedTestCaseCount = 0;
  let skippedTestCaseCount = 0;
  let todoTestCaseCount = 0;
  let fileSummary = null;
  const failedTestCases = [];
  let omittedFailedTestCaseCount = 0;

  const isNodeFileWrapper = data => {
    const name = typeof data.name === 'string' ? data.name.replaceAll('\\', '/') : '';
    const file = typeof data.file === 'string' ? data.file.replaceAll('\\', '/') : '';
    return name.endsWith('.test.mjs') && (name === file || file.endsWith(`/${name}`));
  };

  for await (const event of source) {
    const data = event.data;
    if (!data) continue;

    if (event.type === 'test:enqueue' && data.type === 'test' && !isNodeFileWrapper(data)
        && Number.isInteger(data.line) && Number.isInteger(data.column)) {
      registeredTestCaseCount += 1;
      continue;
    }

    if ((event.type === 'test:pass' || event.type === 'test:fail') && !isNodeFileWrapper(data)
        && data.details?.type !== 'suite'
        && Number.isInteger(data.line) && Number.isInteger(data.column)) {
      completedTestCaseCount += 1;
      if (event.type === 'test:fail') {
        failedTestCaseCount += 1;
        if (failedTestCases.length < 128) failedTestCases.push(boundedFailure(data));
        else omittedFailedTestCaseCount += 1;
      }
      else if (data.skip) skippedTestCaseCount += 1;
      else if (data.todo) todoTestCaseCount += 1;
      else passedTestCaseCount += 1;
      continue;
    }

    if (event.type === 'test:summary' && typeof data.file === 'string') {
      fileSummary = {
        success: data.success === true,
        counts: {
          tests: data.counts?.tests ?? null,
          failed: data.counts?.failed ?? null,
          passed: data.counts?.passed ?? null,
          skipped: data.counts?.skipped ?? null,
          todo: data.counts?.todo ?? null,
          cancelled: data.counts?.cancelled ?? null,
        },
      };
    }
  }

  yield `${JSON.stringify({
    registeredTestCaseCount,
    completedTestCaseCount,
    passedTestCaseCount,
    failedTestCaseCount,
    skippedTestCaseCount,
    todoTestCaseCount,
    fileSummary,
    failedTestCases,
    omittedFailedTestCaseCount,
  })}\n`;
}
