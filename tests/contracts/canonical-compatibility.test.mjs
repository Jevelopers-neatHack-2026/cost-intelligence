import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { validateContract } from '@jevelopers/shared-contracts';
import * as direct from '../../dist/shared/canonical.js';
import * as publicContracts from '../../dist/shared/index.js';

const names = ['UsageEvent', 'BudgetReservation', 'ReserveRequest', 'ReserveResult', 'SettleRequest', 'SettleResult', 'ReleaseRequest', 'ReleaseResult', 'QueryRequest', 'QueryResult', 'FinancialSummary', 'ErrorEnvelope'];
const args = (contract, value) => ({ contract, value, module: 'compatibility', operation: 'legacy', requestId: 'PRIVATE_REQUEST_CANARY' });
const fixture = async contract => JSON.parse(await readFile(new URL(`../../node_modules/@jevelopers/shared-contracts/fixtures/${contract}.json`, import.meta.url), 'utf8'));
function refusal(result, code) {
  assert.equal(result.ok, false);
  const { diagnostic_ref, ...stable } = result.error;
  assert.deepEqual(stable, { schemaVersion: '1.0.0', module: 'compatibility', operation: 'legacy', code, retryable: false,
    safe_message: code === 'UNSUPPORTED_VERSION' ? 'The shared contract version is not supported.' : 'The shared contract payload does not match its pinned schema.' });
  assert.match(diagnostic_ref, /^ci1:[0-9a-f-]{36}$/);
  assert.ok(!JSON.stringify(result).includes('PRIVATE_REQUEST_CANARY'));
}

test('public contracts barrel shares the immutable twelve-alias legacy election', () => {
  assert.equal(publicContracts.validateCanonical, direct.validateCanonical);
  assert.equal(publicContracts.LEGACY_CANONICAL_VERSIONS, direct.LEGACY_CANONICAL_VERSIONS);
  assert.deepEqual(Object.keys(direct.LEGACY_CANONICAL_VERSIONS), names);
  assert.ok(Object.isFrozen(direct.LEGACY_CANONICAL_VERSIONS));
  for (const name of names) assert.equal(direct.LEGACY_CANONICAL_VERSIONS[name], '1.0.0');
  assert.throws(() => { direct.LEGACY_CANONICAL_VERSIONS.ReserveRequest = '2.0.0'; }, TypeError);
});

test('unchanged structural payload/error oracles retain translations with elected snapshot success semantics', async () => {
  let count = 0;
  for (const name of names) {
    const f = await fixture(name);
    const positive = publicContracts.validateCanonical(args(name, f.valid));
    assert.equal(positive.ok, true, name);
    assert.deepEqual(positive.value, f.valid, `${name}: preserve original structural value`);
    assert.notEqual(positive.value, f.valid, `${name}: private snapshot identity`);
    assert.ok(Object.isFrozen(positive.value));
    for (const c of f.cases) {
      if (c.mode && c.mode !== 'structural') continue;
      const value = structuredClone(f.valid);
      for (const key of c.remove ?? []) delete value[key];
      Object.assign(value, c.set ?? {});
      const result = publicContracts.validateCanonical(args(name, value));
      assert.equal(result.ok, c.expected.ok, `${name}/${c.id}`);
      if (!result.ok) refusal(result, c.expected.code === 'UNSUPPORTED_VERSION' ? 'UNSUPPORTED_VERSION' : 'VALIDATION_ERROR');
      count++;
    }
  }
  assert.equal(count, 100, 'unchanged baseline structural case count');
});

for (const name of names) test(`${name}: foreign well-formed version is unsupported before schema dispatch`, async () => {
  const f = await fixture(name);
  for (const version of ['2.0.0', '1.0.1', '99.0.0', '']) {
    refusal(publicContracts.validateCanonical(args(name, { ...f.valid, schema_version: version })), 'UNSUPPORTED_VERSION');
    refusal(publicContracts.validateCanonical(args(name, { schema_version: version })), 'UNSUPPORTED_VERSION');
  }
});

test('JSON safety and malformed version errors retain precedence without invoking getters', async () => {
  const f = await fixture('ReserveRequest');
  for (const value of [null, [], {}, { schema_version: null }, { schema_version: 2 }, { ...f.valid, schema_version: '2.0.0', extra: undefined },
    { ...f.valid, schema_version: '2.0.0', extra: '\ud800' }, { ...f.valid, schema_version: '2.0.0', extra: NaN },
    Object.assign(Object.create({}), f.valid, { schema_version: '2.0.0' })]) {
    refusal(publicContracts.validateCanonical(args('ReserveRequest', value)), 'VALIDATION_ERROR');
  }
  const cyclic = { ...f.valid, schema_version: '2.0.0' }; cyclic.extra = cyclic;
  refusal(publicContracts.validateCanonical(args('ReserveRequest', cyclic)), 'VALIDATION_ERROR');
  const symbol = { ...f.valid, schema_version: '2.0.0', [Symbol('private')]: 'hidden' };
  refusal(publicContracts.validateCanonical(args('ReserveRequest', symbol)), 'VALIDATION_ERROR');
  let reads = 0;
  const accessor = { ...f.valid }; Object.defineProperty(accessor, 'schema_version', { enumerable: true, get() { reads++; return '2.0.0'; } });
  refusal(publicContracts.validateCanonical(args('ReserveRequest', accessor)), 'VALIDATION_ERROR');
  assert.equal(reads, 0);
  const original = new Error('original-proxy-exception');
  const throwing = new Proxy({}, { getPrototypeOf() { throw original; } });
  assert.throws(() => publicContracts.validateCanonical(args('ReserveRequest', throwing)), error => error === original);
});

test('unmapped SDK names and unknown contracts retain original dispatch', async () => {
  const f = await fixture('Cancellation');
  const expected = validateContract('Cancellation', f.valid);
  const actual = publicContracts.validateCanonical(args('Cancellation', f.valid));
  assert.equal(expected.ok, true); assert.equal(actual.ok, true); assert.equal(actual.value, f.valid);
  refusal(publicContracts.validateCanonical(args('not-a-contract', { schema_version: '2.0.0' })), 'VALIDATION_ERROR');
});

test('public declarations preserve legacy return types and separate native Finance2 types', async () => {
  const directory = new URL('../../artifacts/canonical-compatibility-types/', import.meta.url);
  await mkdir(directory, { recursive: true });
  const consumer = new URL('consumer.mts', directory);
  const aliasNames = ['UsageEvent','BudgetReservation','ReserveRequest','ReserveResult','SettleRequest','SettleResult','ReleaseRequest','ReleaseResult','QueryRequest','QueryResult','FinancialSummary','ErrorEnvelope'];
  const checks = aliasNames.map(name => `type ${name}Same = Assert<Equal<api.Shared${name}, ContractMap['${name}']>>;\ntype ${name}Version = Assert<Equal<api.Shared${name}['schema_version'], '1.0.0'>>;`).join('\n');
  await writeFile(consumer, `import * as api from '../../dist/shared/index.js';\nimport type { ContractMap } from '@jevelopers/shared-contracts';\nimport type { FinancialSummaryPageV2 } from '../../dist/reporting/index.js';\ntype Assert<T extends true> = T;\ntype Equal<A,B> = (<T>()=>T extends A?1:2) extends (<T>()=>T extends B?1:2) ? true : false;\n${checks}\ndeclare const result: ReturnType<typeof api.validateCanonical<'ReserveRequest'>>;\nif(result.ok){ const legacy: ContractMap['ReserveRequest'] = result.value; const version: '1.0.0' = result.value.schema_version; }\n// @ts-expect-error legacy election cannot widen to version 2\nconst foreign: api.SharedReserveRequest['schema_version'] = '2.0.0';\ntype NativeVersion = Assert<Equal<FinancialSummaryPageV2['schemaVersion'],'2.0.0'>>;\n`);
  const run = spawnSync(process.execPath, [fileURLToPath(new URL('../../node_modules/typescript/bin/tsc', import.meta.url)), '--noEmit', '--strict', '--skipLibCheck', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--target', 'ES2022', fileURLToPath(consumer)], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stdout + run.stderr);
});

function assertFrozen(value) {
  if (value !== null && typeof value === 'object') {
    assert.ok(Object.isFrozen(value));
    for (const child of Object.values(value)) assertFrozen(child);
  }
}

test('outer contract and value getters are observed once in original evaluation order', async () => {
  const f = await fixture('ReserveRequest');
  const sequence = [];
  const input = { ...args('ReserveRequest', null),
    get contract() { sequence.push('contract'); return sequence.length === 1 ? 'ReserveRequest' : 'Cancellation'; },
    get value() { sequence.push('value'); return sequence.length === 2 ? { ...f.valid, schema_version: '2.0.0' } : f.valid; },
  };
  refusal(publicContracts.validateCanonical(input), 'UNSUPPORTED_VERSION');
  assert.deepEqual(sequence, ['contract', 'value']);
});

test('source Proxy ordinary version and canonical descriptor cannot disagree across legacy election', async () => {
  const f = await fixture('ReserveRequest');
  let ordinaryReads = 0;
  const payload = new Proxy({ ...f.valid, schema_version: '2.0.0' }, {
    getOwnPropertyDescriptor(target, key) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
      return key === 'schema_version' ? { ...descriptor, value: '1.0.0' } : descriptor;
    },
    get(target, key, receiver) { if (key === 'schema_version') ordinaryReads++; return Reflect.get(target, key, receiver); },
  });
  refusal(publicContracts.validateCanonical(args('ReserveRequest', payload)), 'UNSUPPORTED_VERSION');
  assert.equal(ordinaryReads, 1);
});

test('alternating Proxy reads and mutation return only an independent immutable validated snapshot', async () => {
  const f = await fixture('ReserveRequest');
  let reads = 0;
  const target = structuredClone(f.valid);
  const payload = new Proxy(target, { get(target, key, receiver) {
    if (key === 'schema_version') { reads++; target.schema_version = '2.0.0'; return '1.0.0'; }
    return Reflect.get(target, key, receiver);
  } });
  const result = publicContracts.validateCanonical(args('ReserveRequest', payload));
  assert.equal(result.ok, true); assert.equal(reads, 1);
  assert.equal(target.schema_version, '2.0.0');
  assert.deepEqual(result.value, f.valid); assert.equal(result.value.schema_version, '1.0.0');
  assert.notEqual(result.value, payload); assertFrozen(result.value);
  target.producer.module = 'team-dashboard';
  assert.deepEqual(result.value, f.valid);
  assert.throws(() => { result.value.schema_version = '2.0.0'; }, TypeError);
  assert.throws(() => { result.value.producer.module = 'team-dashboard'; }, TypeError);
});

test('source version getter reentry cannot borrow or mutate another invocation snapshot', async () => {
  const f = await fixture('ReserveRequest');
  let reentered;
  let reads = 0;
  const target = structuredClone(f.valid);
  const proxy = new Proxy(target, { get(target, key, receiver) {
    if (key === 'schema_version') {
      reads++;
      reentered = publicContracts.validateCanonical(args('ReserveRequest', { ...f.valid, schema_version: '2.0.0' }));
      target.schema_version = '2.0.0';
      return '1.0.0';
    }
    return Reflect.get(target, key, receiver);
  } });
  const result = publicContracts.validateCanonical(args('ReserveRequest', proxy));
  assert.equal(reads, 1); refusal(reentered, 'UNSUPPORTED_VERSION');
  assert.equal(result.ok, true); assert.deepEqual(result.value, f.valid); assertFrozen(result.value);
});

test('error metadata hooks run only after refusal and cannot change the elected decision', async () => {
  const f = await fixture('ReserveRequest');
  const sentinel = new Error('metadata-must-not-be-read-on-success');
  const successArgs = { contract: 'ReserveRequest', value: f.valid,
    get module() { throw sentinel; }, get operation() { throw sentinel; }, get requestId() { throw sentinel; } };
  const positive = publicContracts.validateCanonical(successArgs);
  assert.equal(positive.ok, true); assert.deepEqual(positive.value, f.valid);
  const order = [];
  const target = { ...f.valid, schema_version: '2.0.0' };
  const bad = { contract: 'ReserveRequest', value: target,
    get module() { order.push('module'); target.schema_version = '1.0.0'; bad.contract = 'Cancellation'; return 'compatibility'; },
    get operation() { order.push('operation'); return 'legacy'; },
    get requestId() { order.push('requestId'); return 'PRIVATE_REQUEST_CANARY'; } };
  refusal(publicContracts.validateCanonical(bad), 'UNSUPPORTED_VERSION');
  assert.deepEqual(order, ['module', 'operation', 'requestId']);
  const proxyError = new Error('body-exception-before-metadata');
  const throwing = new Proxy({}, { getPrototypeOf() { throw proxyError; } });
  const exceptionArgs = { contract: 'ReserveRequest', value: throwing,
    get module() { throw sentinel; }, get operation() { throw sentinel; }, get requestId() { throw sentinel; } };
  assert.throws(() => publicContracts.validateCanonical(exceptionArgs), error => error === proxyError);
});

test('snapshot uses SDK canonical numeric negative-zero normalization without changing decimal strings', async () => {
  const f = await fixture('ReserveRequest');
  const value = structuredClone(f.valid);
  value.requested.scale = -0;
  assert.equal(validateContract('ReserveRequest', value).ok, true, 'structural SDK oracle');
  const result = publicContracts.validateCanonical(args('ReserveRequest', value));
  assert.equal(result.ok, true);
  assert.ok(Object.is(value.requested.scale, -0));
  assert.ok(Object.is(result.value.requested.scale, 0));
  assert.equal(result.value.requested.amount, value.requested.amount);
  assertFrozen(result.value);
});
