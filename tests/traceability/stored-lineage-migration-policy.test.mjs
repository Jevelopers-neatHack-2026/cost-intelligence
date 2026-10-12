// Pure source-policy checks only; these do not execute PostgreSQL DDL.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { FINANCE_CORE_MIGRATIONS, EXPECTED_MIGRATIONS } from '../migrations/migration-catalog.mjs';
import { hasDestructiveMigrationStatement, hasUnapprovedDestructiveMigrationStatement } from '../migrations/sql-safety.mjs';
const name = '0015_stored_lineage_reader.sql';
const sql = await readFile(new URL('../../migrations/' + name, import.meta.url), 'utf8');
const cleanups = [
  ['inbox', 'usage_intake_inbox'], ['attempts', 'usage_intake_attempts'],
  ['outbox', 'usage_intake_outbox'], ['snapshots', 'reporting_snapshots'],
].map(([suffix, table]) => ({ policy: 'ci10_lineage_expected_' + suffix, table,
  cleanup: "EXECUTE 'DROP POLICY ci10_lineage_expected_" + suffix + ' ON cost_intelligence.' + table + "';" }));

test('stored lineage is enrolled as an independent feature rather than a changed Finance core', () => {
  assert.equal(FINANCE_CORE_MIGRATIONS.length, 11);
  assert.equal(FINANCE_CORE_MIGRATIONS.includes(name), false);
  assert.equal(EXPECTED_MIGRATIONS.includes(name), true);
  assert.equal(hasDestructiveMigrationStatement(sql), true, 'the generic scanner still rejects all policy removals');
  assert.equal(hasUnapprovedDestructiveMigrationStatement(name, sql), false);
  assert.equal(hasUnapprovedDestructiveMigrationStatement('unreviewed.sql', sql), true);
  assert.equal(hasUnapprovedDestructiveMigrationStatement(name, sql + '\n'), true);
});
for (const { policy, table, cleanup } of cleanups) {
  test('temporary cleanup is paired, unique and scoped to ' + policy, () => {
    const start = 'EXECUTE $policy$CREATE POLICY ' + policy + ' ON cost_intelligence.' + table;
    assert.equal(sql.split(start).length, 2);
    assert.equal(sql.split(cleanup).length, 2);
    assert.ok(sql.indexOf(start) < sql.indexOf(cleanup));
    assert.ok(sql.indexOf(cleanup) < sql.indexOf('END $lineage_policies$;'));
  });
  for (const [label, mutate] of [
    ['renamed protected policy', text => text.replaceAll(policy, 'existing_financial_policy')],
    ['missing paired creation', text => {
      const start = text.indexOf('  EXECUTE $policy$CREATE POLICY ' + policy);
      const end = text.indexOf('$policy$;', start) + '$policy$;'.length;
      return text.slice(0, start) + text.slice(end);
    }],
    ['duplicated cleanup', text => text.replace(cleanup, cleanup + '\n' + cleanup)],
    ['cleanup moved outside its transaction', text => text.replace(cleanup, '').replace('END $lineage_policies$;', 'END $lineage_policies$;\n' + cleanup)],
  ]) {
    test(policy + ' refuses ' + label, () => {
      const changed = mutate(sql);
      assert.notEqual(changed, sql, 'mutation controls must change the actual reviewed source');
      assert.equal(hasUnapprovedDestructiveMigrationStatement(name, changed), true);
    });
  }
}
test('stored lineage does not exempt any additional destructive statement', () => {
  for (const statement of [
    'DROP TABLE cost_intelligence.usage_intake_inbox;',
    'DROP POLICY reporting_snapshots_scope_policy ON cost_intelligence.reporting_snapshots;',
    "DO $$ BEGIN EXECUTE 'TRUNCATE cost_intelligence.usage_intake_attempts'; END $$;",
  ]) assert.equal(hasUnapprovedDestructiveMigrationStatement(name, sql + '\n' + statement), true);
});
test('the five pinned predecessor function bodies match immutable checked-in definitions', async () => {
  for (const [filename, functionName, identity] of [
    ['0003_financial_ledger.sql','reject_ledger_projection_mutation','reject_ledger_projection_mutation()'],
    ['0006_finance_security_roles.sql','finance_scope_matches','finance_scope_matches(text,text,text,text)'],
    ['0009_usage_intake.sql','reject_usage_intake_audit_mutation','reject_usage_intake_audit_mutation()'],
    ['0009_usage_intake.sql','guard_usage_intake_attempt_update','guard_usage_intake_attempt_update()'],
    ['0009_usage_intake.sql','guard_usage_intake_outbox_update','guard_usage_intake_outbox_update()'],
  ]) {
    const source = await readFile(new URL('../../migrations/' + filename, import.meta.url), 'utf8');
    const start = source.indexOf('FUNCTION cost_intelligence.' + functionName + '(');
    assert.ok(start >= 0);
    const bodyStart = source.indexOf('AS $', start);
    const delimiter = /^AS (\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$)/.exec(source.slice(bodyStart))?.[1];
    assert.ok(delimiter);
    const offset = bodyStart + 'AS '.length + delimiter.length;
    const end = source.indexOf(delimiter + ';', offset);
    assert.ok(end > offset);
    const digest = createHash('sha256').update(source.slice(offset, end)).digest('hex');
    assert.ok(sql.includes("('" + identity + "','" + digest + "')"), functionName);
  }
});

test('stored lineage preserves the two installer-owned predecessors with a named database-owner boundary', async () => {
  const sources = await Promise.all(EXPECTED_MIGRATIONS.filter(file => file < name)
    .map(file => readFile(new URL('../../migrations/' + file, import.meta.url), 'utf8')));
  const predecessors = sources.join('\n');
  for (const fn of ['reject_ledger_projection_mutation', 'finance_scope_matches']) {
    assert.doesNotMatch(predecessors, new RegExp('ALTER FUNCTION cost_intelligence\\.' + fn + '\\([^;]*OWNER TO'));
  }
  for (const fn of ['reject_usage_intake_audit_mutation', 'guard_usage_intake_attempt_update', 'guard_usage_intake_outbox_update']) {
    assert.ok(predecessors.includes(`ALTER FUNCTION cost_intelligence.${fn}() OWNER TO ci_finance_owner;`));
  }
  assert.match(sql, /'database_owner',\s*\(SELECT pg_get_userbyid\(datdba\) FROM pg_database WHERE datname=current_database\(\)\)/);
  assert.match(sql, /CASE WHEN item->>0 IN \('reject_ledger_projection_mutation\(\)','finance_scope_matches\(text,text,text,text\)'\)\s+THEN installed->>'database_owner' ELSE 'ci_finance_owner' END/);
  assert.match(sql, /pg_get_functiondef\(p\.oid\),owner\.rolname,p\.proacl/);
});

test('lineage predecessor owner correction retains function security and whole-file mutation refusal', () => {
  for (const required of ['p.prosecdef', 'p.proconfig IS NOT NULL', 'p.provolatile', 'p.proparallel', 'p.prolang', 'p.prorettype']) {
    assert.ok(sql.includes(required), required);
  }
  for (const mutate of [
    source => source.replace("THEN installed->>'database_owner' ELSE 'ci_finance_owner' END", "THEN item->>2 ELSE item->>2 END"),
    source => source.replace('p.prosecdef OR', 'false OR'),
    source => source.replace('owner.rolname,p.proacl', 'owner.rolname,NULL'),
  ]) {
    const changed = mutate(sql);
    assert.notEqual(changed, sql);
    assert.equal(hasUnapprovedDestructiveMigrationStatement(name, changed), true);
  }
});
