import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { FINANCE_CORE_MIGRATIONS, EXPECTED_MIGRATIONS } from '../migrations/migration-catalog.mjs';
import { approvedReportedValuationReplacements, hasDestructiveMigrationStatement, hasUnapprovedDestructiveMigrationStatement } from '../migrations/sql-safety.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const name = '0014_evidence_reader_indexes.sql';
const sql = await readFile(join(root, 'migrations', name), 'utf8');
const cleanup = "EXECUTE 'DROP POLICY ci10_expected_ledger_policy ON cost_intelligence.financial_ledger_events';";
const catalogRead = "has_table_privilege('ci_finance_runtime',c.oid,'TRUNCATE')";

test('migration catalog includes every checked-in feature while the Finance core stays separate', async () => {
  const names = (await readdir(join(root, 'migrations'))).filter(file => file.endsWith('.sql')).sort();
  assert.deepEqual(names, EXPECTED_MIGRATIONS);
  assert.equal(FINANCE_CORE_MIGRATIONS.length, 11);
  assert.ok(EXPECTED_MIGRATIONS.includes(name));
  assert.equal(FINANCE_CORE_MIGRATIONS.includes(name), false);
});

test('all exact reviewed migrations pass the conservative safety scan before database startup', async () => {
  for (const file of EXPECTED_MIGRATIONS) {
    const source = await readFile(join(root, 'migrations', file), 'utf8');
    const replacements = file === '0009_usage_intake.sql'
      ? [{ schema: 'cost_intelligence', table: 'financial_projection_quantities', constraint: 'financial_projection_quantities_key' }]
      : approvedReportedValuationReplacements(file, source);
    assert.equal(hasUnapprovedDestructiveMigrationStatement(file, source, replacements), false, file);
  }
});

test('evidence readiness binds the actual predecessor guards instead of requiring an invented ledger trigger', async () => {
  for (const [file, table, trigger, type, events, level, fn] of [
    ['0003_financial_ledger.sql', 'financial_ledger_events', 'financial_ledger_events_append_only', 27, 'UPDATE OR DELETE', 'ROW', 'reject_ledger_audit_mutation'],
    ['0006_finance_security_roles.sql', 'financial_privacy_quarantine', 'financial_privacy_quarantine_append_only', 27, 'UPDATE OR DELETE', 'ROW', 'reject_financial_privacy_quarantine_mutation'],
    ['0006_finance_security_roles.sql', 'financial_privacy_quarantine', 'financial_privacy_quarantine_no_truncate', 34, 'TRUNCATE', 'STATEMENT', 'reject_financial_privacy_quarantine_mutation'],
  ]) {
    const predecessor = (await readFile(join(root, 'migrations', file), 'utf8')).replace(/\s+/g, ' ');
    assert.ok(predecessor.includes(`CREATE TRIGGER ${trigger} BEFORE ${events} ON cost_intelligence.${table} FOR EACH ${level} EXECUTE FUNCTION cost_intelligence.${fn}();`));
    assert.ok(sql.includes(`('${table}','${trigger}',${type},'${fn}()')`), `missing exact prerequisite for ${trigger}`);
  }
  assert.match(sql, /CASE WHEN item->>'name' = 'financial_ledger_events' THEN 1 ELSE 2 END/);
  assert.doesNotMatch(sql, /CREATE TRIGGER financial_ledger_events_no_truncate/);
});

test('evidence readiness retains exact trigger binding and effective runtime TRUNCATE refusal', async () => {
  for (const required of [
    't.tgtype IS DISTINCT FROM expected.trigger_type',
    "t.tgfoid IS DISTINCT FROM to_regprocedure('cost_intelligence.' || expected.function_identity)",
    "t.tgenabled NOT IN ('O','A')", 't.tgqual IS NOT NULL',
    "has_table_privilege('ci_finance_runtime',c.oid,'TRUNCATE')", "item->>'runtime_truncate' IS DISTINCT FROM 'false'",
  ]) assert.ok(sql.includes(required), required);
  const core = await readFile(join(root, 'migrations/0006_finance_security_roles.sql'), 'utf8');
  assert.match(core, /REVOKE ALL ON ALL TABLES IN SCHEMA cost_intelligence FROM PUBLIC;/);
  assert.match(core, /GRANT SELECT, INSERT ON cost_intelligence\.financial_ledger_events TO ci_finance_runtime;/);
  assert.match(core, /GRANT SELECT ON cost_intelligence\.financial_privacy_quarantine TO ci_finance_runtime;/);
  for (const file of EXPECTED_MIGRATIONS) {
    const source = await readFile(join(root, 'migrations', file), 'utf8');
    assert.doesNotMatch(source, /GRANT\s+(?:ALL|[^;]*\bTRUNCATE\b)[^;]*\bTO\s+(?:ci_finance_runtime|PUBLIC)\b/i, file);
  }
});

test('only the exact reviewed temporary cleanup receives an exception to the unchanged generic guard', () => {
  assert.equal(hasDestructiveMigrationStatement(sql), true, 'the generic DROP guard remains conservative');
  assert.equal(hasUnapprovedDestructiveMigrationStatement(name, sql), false);
  assert.equal(hasUnapprovedDestructiveMigrationStatement('unreviewed.sql', sql), true);
  assert.equal(hasUnapprovedDestructiveMigrationStatement(name, sql + '\n'), true, 'a changed whole-file fingerprint is not approved');
});

test('the privilege read exception requires the exact file pin and two exact catalog expressions', async () => {
  assert.equal(sql.split(catalogRead).length - 1, 2);
  assert.equal(hasDestructiveMigrationStatement(`SELECT ${catalogRead};`), true,
    'read-only catalog text is still refused by the unchanged conservative generic scanner');
  const scanner = await readFile(join(root, 'tests/migrations/sql-safety.mjs'), 'utf8');
  const pin = createHash('sha256').update(sql).digest('hex');
  assert.equal(scanner.split(`sha256: '${pin}'`).length, 2);
  const wrongPin = scanner.replace(`sha256: '${pin}'`, `sha256: '${'0'.repeat(64)}'`);
  const unpinned = await import(`data:text/javascript,${encodeURIComponent(wrongPin)}`);
  assert.equal(unpinned.hasUnapprovedDestructiveMigrationStatement(name, sql), true,
    'altering only the approved pin cannot grant the exception');
  for (const [label, mutate] of [
    ['one catalog read', source => source.replace(catalogRead, 'false')],
    ['three catalog reads', source => source + `\nSELECT ${catalogRead};\n`],
    ['renamed catalog function', source => source.replaceAll('has_table_privilege(', 'unreviewed_table_privilege(')],
    ['extra quoted truncate', source => source + "\nSELECT 'TRUNCATE';\n"],
    ['extra dynamic truncate', source => source + "\nDO $$ BEGIN EXECUTE 'TRUNCATE cost_intelligence.financial_ledger_events'; END $$;\n"],
  ]) {
    const changed = mutate(sql);
    assert.notEqual(changed, sql, label);
    assert.equal(hasUnapprovedDestructiveMigrationStatement(name, changed), true, label);
    // Even changing the pin alone cannot authorize a different expression count,
    // renamed function, or additional destructive quoted/dynamic SQL.
    const changedPin = createHash('sha256').update(changed).digest('hex');
    const repinned = await import(`data:text/javascript,${encodeURIComponent(scanner.replace(`sha256: '${pin}'`, `sha256: '${changedPin}'`))}`);
    assert.equal(repinned.hasUnapprovedDestructiveMigrationStatement(name, changed), true, label);
  }
});

const mutations = [
  ['renamed policy', source => source.replaceAll('ci10_expected_ledger_policy', 'existing_live_policy')],
  ['different protected table', source => source.replaceAll('cost_intelligence.financial_ledger_events', 'cost_intelligence.financial_source_revision_heads')],
  ['missing paired CREATE', source => source.replace(/  EXECUTE \$policy\$CREATE POLICY ci10_expected_ledger_policy[\s\S]+?\$policy\$;/, '')],
  ['cleanup moved outside its transaction block', source => source.replace(cleanup, '').replace('END $core_policies$;', `END $core_policies$;\n${cleanup}`)],
  ['appended live policy removal', source => source + "\nDROP POLICY financial_ledger_events_scope_policy ON cost_intelligence.financial_ledger_events;\n"],
  ['appended table removal', source => source + '\nDROP TABLE cost_intelligence.financial_ledger_events;\n'],
  ['appended dynamic truncate', source => source + "\nDO $$ BEGIN EXECUTE 'TRUNCATE cost_intelligence.financial_ledger_events'; END $$;\n"],
  ['missing required trigger binding', source => source.replace("t.tgtype IS DISTINCT FROM expected.trigger_type", 'false')],
  ['different required trigger function', source => source.replace("27,'reject_ledger_audit_mutation()'", "27,'reject_ledger_projection_mutation()'")],
  ['disabled trigger accepted', source => source.replaceAll("t.tgenabled NOT IN ('O','A')", "t.tgenabled NOT IN ('O','A','D')")],
  ['runtime truncate accepted', source => source.replace("item->>'runtime_truncate' IS DISTINCT FROM 'false'", 'false')],
];
for (const [label, mutate] of mutations) {
  test(`temporary cleanup allowance refuses ${label}`, () => {
    const changed = mutate(sql);
    assert.notEqual(changed, sql, 'the adversarial control must actually mutate the reviewed source');
    assert.equal(hasUnapprovedDestructiveMigrationStatement(name, changed), true);
  });
}

test('unrelated destructive SQL remains refused and append-only trigger declarations remain allowed', () => {
  for (const source of [
    'DROP TABLE cost_intelligence.financial_ledger_events;',
    "DO $$ BEGIN EXECUTE 'DROP POLICY other_policy ON cost_intelligence.financial_ledger_events'; END $$;",
    'TRUNCATE cost_intelligence.financial_ledger_events;',
  ]) assert.equal(hasUnapprovedDestructiveMigrationStatement(name, source), true);
  assert.equal(hasUnapprovedDestructiveMigrationStatement('other.sql',
    'CREATE TRIGGER guard BEFORE TRUNCATE ON schema.table FOR EACH STATEMENT EXECUTE FUNCTION guard_fn();'), false);
});
