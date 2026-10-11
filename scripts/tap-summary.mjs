function count(report, key) {
  const match = new RegExp(`^# ${key} (\\d+)$`, 'm').exec(report);
  return Number(match?.[1] ?? 0);
}

export function summarizeTap(report, processExitCode) {
  const tests = count(report, 'tests');
  const passed = count(report, 'pass');
  const failed = count(report, 'fail');
  const skipped = count(report, 'skipped');
  const todo = count(report, 'todo');
  const cancelled = count(report, 'cancelled');
  const executed = Math.max(0, tests - skipped - todo - cancelled);
  const meaningfulPass = processExitCode === 0 && tests > 0 && executed > 0
    && passed === tests && failed === 0 && skipped === 0 && todo === 0 && cancelled === 0;
  return { tests, passed, failed, skipped, todo, cancelled, executed, meaningfulPass };
}
