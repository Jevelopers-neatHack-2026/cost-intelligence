import assert from 'node:assert/strict';
import test from 'node:test';
import { Value } from '@sinclair/typebox/value';
import * as finance from '../../dist/index.js';
import { projectReporting, hash } from '../../dist/reporting/projection.js';
import { canonicalSummaries } from '../../dist/reporting/canonical-mapping.js';
import { ReportingDetailSchema, ReportingProjectionSchema } from '../../dist/reporting/schema-v2.js';
import { fixtureScope, posting, query, exportRequest, checked, hostPorts, syntheticSqlPort } from '../exports/query-export-fixtures.mjs';

// Reporting-source fixtures, not evidence of accepted settlement or provider intake.
function payload(scope, id, options = {}) {
  const value = posting(scope, id, { ...options, valuation: options.amount === null ? 'unknown' : 'provider_confirmed' });
  value.valuation = 'provider_reported_unsettled';
  return value;
}
function project(scope, payloads) {
  const events = payloads.map(p => ({ eventId: p.eventId, eventHash: hash(p), rootId: p.eventId, economicEventType: p.eventType, payload: p }));
  return projectReporting({ query: query(scope), asOf: '2026-10-12T22:00:00.000Z', events, lifetimeEvents: events,
    intake: { unposted: 0, awaiting: 1, quarantine: 0 }, budgetSources: [], allocations: [], productEvidence: null });
}
const known = amount => ({ status: 'known', knownSubtotal: amount, total: amount, unknownCount: 0 });

test('reported expense keeps exact signed currency partitions and conservative canonical basis', () => {
  const s = fixtureScope();
  const p = project(s, [payload(s, 'a', { amount: '0.000000000000000001' }), payload(s, 'b', { amount: '-0.2' }),
    payload(s, 'eur', { currency: 'EUR', amount: '3' }), posting(s, 'confirmed', { amount: '1' })]);
  assert.equal(Value.Check(ReportingProjectionSchema, p.summary), true);
  assert.ok(p.details.every(d => Value.Check(ReportingDetailSchema, d)));
  const usd = p.summary.currencies.find(row => row.currency === 'USD');
  assert.deepEqual(usd.valuation.reportedUnsettled, known('-0.199999999999999999'));
  assert.deepEqual(usd.valuation.confirmed, known('1'));
  assert.deepEqual(p.summary.currencies.find(row => row.currency === 'EUR').valuation.reportedUnsettled, known('3'));
  const canonical = canonicalSummaries(query(s), '2026-10-12T22:00:00.000Z', p.summary, { sourceRevision: 'a'.repeat(40), buildRevision: 'synthetic' }, p.details);
  assert.ok(canonical.every(row => row.valuation_basis === 'unknown'));
  assert.ok(p.details.every(d => d.settlement === 'unpaid' && d.reconciliation === 'unmatched'));
  assert.notEqual(p.summary.coverage.status, 'complete');
});

test('reported missing money stays unknown; cash, revenue and simulated amounts cannot supply actual expense basis', () => {
  const s = fixtureScope();
  const p = project(s, [payload(s, 'null', { amount: null }), payload(s, 'cash', { amount: '7', eventType: 'cash_movement', classification: 'payout_transfer' }),
    payload(s, 'sale', { amount: '9', eventType: 'revenue', classification: 'sale' })]);
  assert.deepEqual(p.summary.currencies[0].valuation.reportedUnsettled, { status: 'unknown', knownSubtotal: null, total: null, unknownCount: 1 });
  const simulated = { ...s, billingMode: 'simulated' };
  assert.deepEqual(project(simulated, [payload(simulated, 'sim', { amount: '5' })]).summary.currencies[0].valuation.reportedUnsettled,
    { status: 'unknown', knownSubtotal: null, total: null, unknownCount: 0 });
});

function store() {
  const rows = new Map();
  return { async lookup(k) { return rows.get(k) ?? null; }, async commitImmutable(k, v) { if (!rows.has(k)) rows.set(k, structuredClone(v)); return rows.get(k); }, async verifyOriginal(k, v) { return hash(rows.get(k)) === hash(v); } };
}
test('public query and verified export preserve reported bucket through synthetic source port', async () => {
  const s = fixtureScope(); const sql = syntheticSqlPort(s, [payload(s, 'reported', { amount: '1.1' }), posting(s, 'confirmed', { amount: '2' })]);
  const host = hostPorts(s, sql);
  const page = await checked(finance.querySummaryV2(query(s), host.ports));
  assert.equal(page.canonicalSummaries[0].valuation_basis, 'unknown');
  const ports = finance.createReportingExportRuntimePorts(host.ports, store(), store(), host.fence);
  const receipt = await checked(finance.exportSummaryV2(exportRequest(page, s), ports));
  const doc = JSON.parse(receipt.artifacts.find(a => a.fileName === 'summary.json').content);
  assert.deepEqual(doc.currencies[0].expenseValuation.reportedUnsettled, known('1.1'));
  assert.equal(page.summary.currencies[0].metrics.expense.knownSubtotal, '3.1');
});

test('legacy immutable snapshots export absent reported bucket as not supplied', async () => {
  const s = fixtureScope(); const sql = syntheticSqlPort(s, [posting(s, 'old')]); const host = hostPorts(s, sql);
  const q = query(s); await checked(finance.querySummaryV2(q, host.ports));
  // Historical producer fixture: construct old envelope before content-addressed storage.
  const envelope = structuredClone([...sql.records.values()][0]);
  delete envelope.summary.currencies[0].valuation.reportedUnsettled;
  envelope.summaryContentHash = hash(envelope.summary);
  const snapshotId = hash(envelope); sql.records.set(snapshotId, envelope);
  const before = JSON.stringify(envelope);
  const page = await checked(finance.querySummaryV2({ ...q, snapshotId }, host.ports));
  assert.equal(finance.validateFinancialSummaryPageV2Boundary(page).ok, true);
  const ports = finance.createReportingExportRuntimePorts(host.ports, store(), store(), host.fence);
  const receipt = await checked(finance.exportSummaryV2(exportRequest(page, s), ports));
  const doc = JSON.parse(receipt.artifacts.find(a => a.fileName === 'summary.json').content);
  assert.deepEqual(doc.currencies[0].expenseValuation.reportedUnsettled,
    { status: 'not_supplied_by_query', knownSubtotal: null, total: null, unknownCount: null });
  assert.equal(JSON.stringify(sql.records.get(snapshotId)), before);
  assert.equal(Object.hasOwn(page.summary.currencies[0].valuation, 'reportedUnsettled'), false);
});
