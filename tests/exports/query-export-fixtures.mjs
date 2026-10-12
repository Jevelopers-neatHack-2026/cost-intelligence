import { createSyntheticDisclosureHost } from './synthetic-disclosure-host.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as finance from '../../dist/index.js';

export const FIXTURE_TIME = '2026-10-12T22:00:00.000Z';
export const hash = finance.hashExportCanonical;
export function fixtureScope(extra = {}) { return { tenantId: randomUUID(), projectId: randomUUID(), actorId: 'synthetic-export-service', environment: 'test', billingMode: 'live', ...extra }; }
export function posting(scope, id, options = {}) {
  const subject = options.subject ?? id;
  const identitySubject = subject + (options.lineageSuffix ?? '');
  const prefix = scope.projectId.slice(0, 8);
  const amount = Object.hasOwn(options, 'amount') ? options.amount : '1';
  const payload = {
    schemaVersion: '1.0.0', requestId: `request-${prefix}-${id}`, idempotencyKey: `posting-${prefix}-${id}`, scope,
    eventId: `event-${prefix}-${id}`, correlationId: `correlation-${prefix}-${id}`,
    producer: { module: 'ci08.export.synthetic.fixture', sourceRevision: 'a'.repeat(40), buildRevision: 'synthetic-only' },
    occurredAt: options.occurredAt ?? '2026-10-10T12:00:00.000Z', observedAt: '2026-10-10T12:01:00.000Z',
    evidenceMode: 'mocked', verificationStatus: 'verified', eventType: options.eventType ?? 'expense', classification: options.classification ?? 'direct_cost',
    valuation: options.valuation ?? (amount === null ? 'unknown' : 'provider_confirmed'), settlementStatus: 'unpaid', reconciliationStatus: 'unmatched', reservationLifecycle: null,
    identities: { logicalOperationId: `operation-${prefix}-${subject}`, sourceObservationId: `observation-${prefix}-${id}`, reservationId: null },
    postingMapping: { schemaVersion: '1.0.0', sourceLineId: `line-${prefix}-${identitySubject}`, transportAttemptId: { status: 'known', id: `transport-${prefix}-${subject}` }, providerAttemptId: { status: 'known', id: `provider-${prefix}-${subject}` }, providerRequestId: { status: 'not_applicable' }, billableAttemptId: { status: 'known', id: `billable-${prefix}-${subject}` } },
    sourceIdentity: { source: 'ci08-export-synthetic', sourceEventId: `source-${prefix}-${id}`, sourceObjectId: `object-${prefix}-${identitySubject}`, revisionSubjectId: `line-${prefix}-${identitySubject}`, sourceRevision: `fixture-${options.revision ?? 0}`, revisionSequence: options.revision ?? 0, contentHash: hash({ prefix, id, options }) },
    usage: { completeness: amount === null ? 'unknown' : 'complete', missingFields: amount === null ? ['tokens'] : [], units: amount === null ? [] : [{ name: 'tokens', quantity: '1', scale: 0, relation: 'standalone' }] },
    money: { amount, currency: options.currency ?? 'USD', scale: amount?.split('.')[1]?.length ?? 0 },
    sourceRefs: ['correction', 'reversal'].includes(options.eventType) ? [{ contract: 'ci08.export.synthetic.evidence', schema_version: '1.0.0', id: 'synthetic-adjustment-evidence', revision: 1, content_hash: hash({ id, amount }) }] : [],
    dimensions: options.dimensions ?? {}, pricing: options.valuation === 'estimated' ? { policyVersion: 'synthetic-1', ruleVersion: 'synthetic-1', rateCardRef: null } : null,
    fxEvidence: null, financialEffect: true, reservationAuthorizationEventId: null, supersedesEventId: options.supersedes ?? null, reversesEventId: options.reverses ?? null,
  };
  assert.equal(finance.validateLedgerAppendRequestBoundary(payload).ok, true, 'the FINAL fixture payload must pass the real public posting boundary');
  return payload;
}
export function query(scope, extra = {}) { return { schemaVersion: '2.0.0', requestId: 'synthetic-query-export', idempotencyKey: 'synthetic-query-export', scope,
  period: { start: '2026-10-10T00:00:00.000Z', end: '2026-10-11T00:00:00.000Z' }, timezone: 'UTC', policyVersion: finance.REPORTING_POLICY_VERSION,
  pageSize: 1, filters: { environments: [scope.environment], billingModes: [scope.billingMode] }, groupings: [...finance.REPORTING_DIMENSIONS], ...extra }; }
export function exportRequest(page, scope, extra = {}) { return { schemaVersion: page.schemaVersion, requestId: 'PRIVATE_TRANSPORT_REQUEST', idempotencyKey: 'synthetic-export', scope,
  summarySnapshot: page, summaryContentHash: page.summaryContentHash, destination: 'cfo.ai', format: 'json', requestedAt: FIXTURE_TIME, evidenceMode: 'mocked', requestedBy: 'PRIVATE_NOT_AUTHORITY', ...extra }; }
export async function checked(result) { const actual = await result; assert.equal(actual.ok, true, JSON.stringify(actual)); return actual.value; }

export function hostPorts(scope, database) {
  const host = createSyntheticDisclosureHost(scope, FIXTURE_TIME);
  const state = host.state;
  const ports = {
    clock: host.clock, storage: { isAvailable: async () => true }, providerSource: { isAvailable: async () => false },
    trustedContext: host.trustedContext, financeAuthority: host.financeAuthority,
    reporting: { database: { connect: async () => { const client = await database.connect(); return { release: () => client.release(), query: async (...args) => { state.reads++; return client.query(...args); } }; } },
      producer: { sourceRevision: '22a3237dd44f376017969ac881586ff396f19cf8', buildRevision: 'export-synthetic-fixture' }, cursorSigningKey: 'synthetic-only-pagination-key-0000000000000000000' },
    database,
  };
  host.controller.bindPorts(ports);
  return { ports, state, fence: host.fence, controller: host.controller, counters: host.counters };
}
/** A read-only SQL fixture port for pure composition probes; NEVER a PostgreSQL receipt or independent ledger. */
export function syntheticSqlPort(scope, payloads) {
  const records = new Map();
  const originals = new Map(payloads.map(payload => [payload.eventId, payload]));
  const rows = payloads.filter(payload => !payloads.some(other => other.supersedesEventId === payload.eventId)).map(payload => {
    const original = payload.supersedesEventId ? originals.get(payload.supersedesEventId) : payload;
    const root = original ?? payload;
    return { event_id: payload.eventId, event_hash: hash(payload), economic_root_event_id: root.eventId, economic_event_type: root.eventType,
      event_payload: structuredClone(payload), lineage_valid: true, root_occurred_at: root.occurredAt,
      economic_lineage: [{ eventId: root.eventId, eventType: root.eventType, reversesId: null, scope, ingestedAt: FIXTURE_TIME, financialEffect: true, payload: structuredClone(root), depth: 0, cycle: false }] };
  });
  return {
    records,
    async connect() { return { release() {}, async query(sql, values = []) {
      if (sql.includes('reporting_health')) return { rows: [{ migrations_ready: true }] };
      if (sql.includes('financial_privacy_quarantine')) return { rows: [] };
      if (sql.startsWith('INSERT INTO cost_intelligence.reporting_snapshots')) { records.set(values[0], JSON.parse(values[7])); return { rows: [] }; }
      if (sql.includes('SELECT snapshot_content')) return { rows: records.has(values[4]) ? [{ snapshot_content: structuredClone(records.get(values[4])) }] : [] };
      if (sql.includes('FROM cost_intelligence.financial_ledger_events e JOIN')) return { rows: structuredClone(rows) };
      if (sql.includes(' AS count')) return { rows: [{ count: '0' }] };
      return { rows: [] };
    } }; },
  };
}
