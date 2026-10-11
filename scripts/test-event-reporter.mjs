/** Node 22 structured reporter. Emits counts only; test names and stdout are omitted. */
export default async function* testEventReporter(source) {
  let registeredTestCaseCount = 0;
  let completedTestCaseCount = 0;
  let passedTestCaseCount = 0;
  let failedTestCaseCount = 0;
  let skippedTestCaseCount = 0;
  let todoTestCaseCount = 0;
  let fileSummary = null;

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
      if (event.type === 'test:fail') failedTestCaseCount += 1;
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
  })}\n`;
}
