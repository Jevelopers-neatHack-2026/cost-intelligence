import { createHash } from 'node:crypto';

const reportedValuationReplacements=[
  {schema:'cost_intelligence',table:'financial_ledger_events',constraint:'financial_ledger_events_valuation_check',column:'valuation'},
  {schema:'cost_intelligence',table:'usage_intake_inbox',constraint:'usage_intake_inbox_valuation_basis_check',column:'valuation_basis'},
  {schema:'cost_intelligence',table:'usage_intake_attempts',constraint:'usage_intake_attempts_valuation_basis_check',column:'valuation_basis'},
];
export function approvedReportedValuationReplacements(filename,sql){
  if(filename!=='0011_budget_settlement_reconciliation.sql')return [];
  for(const {schema,table,constraint,column} of reportedValuationReplacements){
    const exact=`ALTER TABLE ${schema}.${table} DROP CONSTRAINT ${constraint};\nALTER TABLE ${schema}.${table} ADD CONSTRAINT ${constraint} CHECK (${column} IN ('unknown', 'estimated', 'provider_confirmed', 'provider_reported_unsettled'));`;
    if(sql.split(exact).length!==2)return [];
  }
  return reportedValuationReplacements;
}

// A whole-file fingerprint binds the paired temporary CREATE/cleanup statements,
// their transactional DO block, and any exact read-only catalog expressions.
// Drift never inherits these narrow exceptions; the generic scanner is unchanged.
const REVIEWED_TEMPORARY_POLICY_CLEANUPS = Object.freeze({
  '0015_stored_lineage_reader.sql': Object.freeze({
    sha256: 'e812fbedf7bf4edb0b0fc83efdd687949a7e36f8d2098ac8c0a9c8ff98145b29',
    statements: Object.freeze([
      "EXECUTE 'DROP POLICY ci10_lineage_expected_inbox ON cost_intelligence.usage_intake_inbox';",
      "EXECUTE 'DROP POLICY ci10_lineage_expected_attempts ON cost_intelligence.usage_intake_attempts';",
      "EXECUTE 'DROP POLICY ci10_lineage_expected_outbox ON cost_intelligence.usage_intake_outbox';",
      "EXECUTE 'DROP POLICY ci10_lineage_expected_snapshots ON cost_intelligence.reporting_snapshots';",
    ]),
  }),
  '0014_evidence_reader_indexes.sql': Object.freeze({
    sha256: '0f6892b0704bd6e99cf3c9d976e9d906649c13a0c03e1201425461d37a1cdcf8',
    statements: Object.freeze([
      "EXECUTE 'DROP POLICY ci10_expected_ledger_policy ON cost_intelligence.financial_ledger_events';",
      "EXECUTE 'DROP POLICY ci10_expected_privacy_policy ON cost_intelligence.financial_privacy_quarantine';",
    ]),
    catalogReads: Object.freeze([
      Object.freeze({ expression: "has_table_privilege('ci_finance_runtime',c.oid,'TRUNCATE')", occurrences: 2 }),
    ]),
  }),
});

export function hasUnapprovedDestructiveMigrationStatement(name, sql, allowedConstraintReplacements = []) {
  const reviewed = REVIEWED_TEMPORARY_POLICY_CLEANUPS[name];
  let scanned = sql;
  if (reviewed && createHash('sha256').update(sql).digest('hex') === reviewed.sha256
    && reviewed.statements.every(statement => sql.split(statement).length === 2)
    && (reviewed.catalogReads ?? []).every(({ expression, occurrences }) => sql.split(expression).length === occurrences + 1)) {
    for (const statement of reviewed.statements) scanned = scanned.replace(statement, '-- reviewed temporary policy cleanup');
    for (const { expression } of reviewed.catalogReads ?? []) scanned = scanned.replaceAll(expression, 'reviewed_catalog_privilege_probe');
  }
  return hasDestructiveMigrationStatement(scanned, allowedConstraintReplacements);
}

export function hasDestructiveMigrationStatement(sql, allowedConstraintReplacements = []) {
  const tokens = [];
  let index = 0;
  let statement = 0;
  const dollarDelimiters = [];
  while (index < sql.length) {
    const rest = sql.slice(index);
    const current = sql[index];
    if (rest.startsWith('--')) {
      const newline = sql.indexOf('\n', index + 2);
      index = newline < 0 ? sql.length : newline + 1;
      continue;
    }
    if (rest.startsWith('/*')) {
      let depth = 1;
      index += 2;
      while (index < sql.length && depth > 0) {
        if (sql.startsWith('/*', index)) { depth++; index += 2; }
        else if (sql.startsWith('*/', index)) { depth--; index += 2; }
        else index++;
      }
      continue;
    }
    const activeDollarDelimiter = dollarDelimiters.at(-1);
    if (activeDollarDelimiter && rest.startsWith(activeDollarDelimiter)) {
      index += activeDollarDelimiter.length;
      dollarDelimiters.pop();
      continue;
    }
    if (current === '$') {
      const delimiter = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(rest)?.[0];
      if (delimiter) {
        // Procedural bodies can contain their own tagged strings. Track each
        // delimiter so nested tags cannot merge with or hide SQL keywords.
        dollarDelimiters.push(delimiter);
        index += delimiter.length;
        continue;
      }
    }
    if (current === "'" || current === '"') {
      const quote = current;
      index++;
      let contents = '';
      while (index < sql.length) {
        if (sql[index] === '\\' && index + 1 < sql.length) {
          contents += sql[index + 1];
          index += 2;
        } else if (sql[index] === quote && sql[index + 1] === quote) {
          contents += quote;
          index += 2;
        } else if (sql[index] === quote) {
          index++;
          break;
        } else {
          contents += sql[index++];
        }
      }
      const searchableContents = contents.replace(/\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/g, ' ');
      for (const match of searchableContents.matchAll(/[A-Za-z_][A-Za-z0-9_$]*/g)) {
        tokens.push({ kind: 'word', value: match[0].toUpperCase(), statement, quoted: true, inDollar: dollarDelimiters.length > 0 });
      }
      continue;
    }
    let word = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(rest)?.[0];
    if (word) {
      if (dollarDelimiters.length > 0) {
        const nestedDelimiter = /\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(word);
        if (nestedDelimiter) word = word.slice(0, nestedDelimiter.index);
      }
      tokens.push({ kind: 'word', value: word.toUpperCase(), statement, quoted: false, inDollar: dollarDelimiters.length > 0 });
      index += word.length;
      continue;
    }
    if (current === ';' && dollarDelimiters.length === 0) {
      statement++;
    } else if (current === ';') {
      tokens.push({ kind: 'punctuation', value: ';', statement, quoted: false, inDollar: true });
    }
    index++;
  }

  return tokens.some(token => {
    if (token.kind !== 'word') return false;
    if (token.value === 'DROP') {
      const statementTokens = tokens.filter(item => item.statement === token.statement);
      const codeWords = statementTokens.filter(item => item.kind === 'word' && !item.quoted && !item.inDollar);
      const position = codeWords.indexOf(token);
      const prefix = codeWords.slice(0, position).map(item => item.value);
      const suffix = codeWords.slice(position + 1).map(item => item.value);
      const safeReplacement = allowedConstraintReplacements.some(({ schema, table, constraint }) =>
        prefix.join(' ') === `ALTER TABLE ${schema.toUpperCase()} ${table.toUpperCase()}`
          && suffix.join(' ') === `CONSTRAINT ${constraint.toUpperCase()}`);
      return !safeReplacement;
    }
    if (token.value !== 'TRUNCATE') return false;

    // Only the SQL event name in a CREATE TRIGGER ... BEFORE TRUNCATE ON
    // declaration is safe. Quoted strings and dollar-quoted bodies stay
    // conservative: they may contain dynamic SQL that executes later.
    if (token.quoted || token.inDollar) return true;
    const statementTokens = tokens.filter(item => item.statement === token.statement);
    const codeWords = statementTokens.filter(item => item.kind === 'word' && !item.quoted && !item.inDollar);
    const position = codeWords.indexOf(token);
    const safeTriggerDeclaration = codeWords[0]?.value === 'CREATE'
      && codeWords[1]?.value === 'TRIGGER'
      && position > 1
      && codeWords[position - 1]?.value === 'BEFORE'
      && codeWords[position + 1]?.value === 'ON';
    return !safeTriggerDeclaration;
  });
}
