import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { checkUsageEvent, parseContract, validateContract } from '@jevelopers/shared-contracts';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const proposalDir = join(root, 'node_modules/@jevelopers/shared-contracts');
const require = createRequire(import.meta.url);

test('the installed shared-contract proposal is pinned to exact archive and artifact bytes', async () => {
  const lock = JSON.parse(await readFile(join(root, 'contracts.lock.json'), 'utf8'));
  const archive = await readFile(join(root, 'vendor/shared-contracts-0.3.0-proposal.tgz'));
  assert.equal(createHash('sha256').update(archive).digest('hex'), lock.producer.archive_sha256);
  assert.equal(lock.status, 'proposal_only');
  assert.equal(lock.adoption_accepted, false);
  assert.deepEqual(Object.keys(lock.blocking_findings).sort(), ['FC-001', 'FC-002', 'FC-003', 'FC-004']);

  const installed = require(join(proposalDir, 'package.json'));
  assert.equal(`${installed.name}@${installed.version}`, lock.producer.package);
  assert.equal(installed.version, '0.3.0');
  assert.equal(lock.verified_artifacts.length, 29);
  for (const artifact of lock.verified_artifacts) {
    const bytes = await readFile(join(proposalDir, artifact.path));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), artifact.sha256, `sha256 ${artifact.path}`);
    if (artifact.git_blob) {
      const gitBlob = createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex');
      assert.equal(gitBlob, artifact.git_blob, `git blob ${artifact.path}`);
    }
  }
});

test('candidate fixtures exercise positive, negative, parse, and strict version boundaries', async () => {
  const files = (await readdir(join(proposalDir, 'fixtures'))).filter(name => name.endsWith('.json'));
  let fixtureCount = 0;
  let schemaCases = 0;
  let parseCases = 0;
  for (const file of files) {
    const fixture = JSON.parse(await readFile(join(proposalDir, 'fixtures', file), 'utf8'));
    if (typeof fixture.contract !== 'string' || !fixture.valid || !Array.isArray(fixture.cases)) continue;
    fixtureCount++;
    assert.equal(validateContract(fixture.contract, fixture.valid).ok, true, `${fixture.contract} valid fixture`);
    for (const candidate of fixture.cases) {
      if (candidate.mode === 'parse') {
        const input = candidate.json ?? JSON.stringify(fixture.valid);
        assert.equal(parseContract(fixture.contract, input).ok, candidate.expected.ok, `${fixture.contract}/${candidate.id}`);
        parseCases++;
        continue;
      }
      if (candidate.mode) continue;
      const value = structuredClone(fixture.valid);
      Object.assign(value, candidate.set ?? {});
      for (const key of candidate.remove ?? []) delete value[key];
      assert.equal(validateContract(fixture.contract, value).ok, candidate.expected.ok, `${fixture.contract}/${candidate.id}`);
      schemaCases++;
    }
  }
  assert.ok(fixtureCount >= 25, `only ${fixtureCount} contract fixtures found`);
  assert.ok(schemaCases >= 290, `only ${schemaCases} schema cases exercised`);
  assert.ok(parseCases >= 25, `only ${parseCases} parse cases exercised`);
});

test('UsageEvent preserves unknown usage as null and rejects unknown-as-zero', async () => {
  const fixture = JSON.parse(await readFile(join(proposalDir, 'fixtures/UsageEvent.json'), 'utf8'));
  const context = fixture.cases.find(candidate => candidate.id === 'unknown-usage').context;
  const unknown = structuredClone(fixture.valid);
  Object.assign(unknown, {
    completeness: 'unknown', usage_units: null,
    valuation: { basis: 'unknown', money: null, rate_card_ref: null },
    outcome: 'timeout', missing_fields: ['tokens'],
  });
  assert.equal(checkUsageEvent(unknown, context).ok, true);
  const falseZero = structuredClone(unknown);
  falseZero.usage_units = [{ name: 'tokens', quantity: '0', scale: 6, relation: 'standalone' }];
  const result = checkUsageEvent(falseZero, context);
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'UNKNOWN_USAGE');
});
