import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

// Fake docker (the wrapper only forwards PATH, so the log path is baked in): records every invocation and fails `docker port` so the wrapper
// stops right after the container is "started" and goes straight to cleanup.
const fakeDocker = log => `#!/bin/sh
printf '%s\\n' "$*" >> '${log}'
if [ "$1" = "port" ]; then echo "no mapping" >&2; exit 1; fi
exit 0
`;

test('disposable container cleanup removes only the allocated container and its anonymous volume', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ci-fake-docker-'));
  try {
    const log = join(dir, 'calls.log');
    await writeFile(log, '');
    await writeFile(join(dir, 'docker'), fakeDocker(log));
    await chmod(join(dir, 'docker'), 0o755);
    const env = { PATH: `${dir}:${process.env.PATH}` };
    const result = spawnSync(process.execPath, ['scripts/with-postgres.mjs', 'smoke-cleanup-probe'], { cwd: root, env, encoding: 'utf8' });
    assert.notEqual(result.status, 0, 'wrapper must fail when the fake container exposes no port');

    const calls = (await readFile(log, 'utf8')).trim().split('\n');
    const run = calls.find(call => call.startsWith('run '));
    assert.ok(run, 'wrapper must start the container through docker run');
    const name = run.match(/--name (\S+)/)?.[1];
    assert.match(name ?? '', /^ci-test-/);

    const removals = calls.filter(call => /^(rm|volume|system|container|image)\b/.test(call));
    assert.deepEqual(removals, [`rm --force --volumes ${name}`]);
    assert.ok(!calls.some(call => /prune|\bvolume\b|--filter/.test(call)), 'cleanup must never prune or filter volumes globally');
    assert.match(result.stderr, /docker exited 1: no mapping/);
    assert.doesNotMatch(result.stderr, /cleanup failed/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
