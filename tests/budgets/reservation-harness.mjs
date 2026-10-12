// Shared helpers for the CI-05A budget reservation acceptance suites.
// Not a *.test.mjs file, so the suite runner never executes it directly.
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { databaseConfigFromEnvironment, runtimeDatabaseConfigFromEnvironment } from '../../scripts/test-db-lifecycle.mjs';

const { Pool } = pg;
const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
export const FIXED_TIME = '2026-10-12T04:00:00.000Z';

async function loadFixtureValid(contract) {
  const path = join(root, `node_modules/@jevelopers/shared-contracts/fixtures/${contract}.json`);
  return JSON.parse(await readFile(path, 'utf8')).valid;
}

export async function loadReserveFixture() { return loadFixtureValid('ReserveRequest'); }

// Canonical command fixtures, cached once so the sync builders can clone them.
const SETTLE_FIXTURE = await loadFixtureValid('SettleRequest');
const RELEASE_FIXTURE = await loadFixtureValid('ReleaseRequest');

/**
 * An injectable pool pair: a direct observer connection (for test assertions)
 * and the restricted ci_finance_runtime login used by the store under test.
 */
export function reservationPool(max = 12) {
  const observer = new Pool({ ...databaseConfigFromEnvironment('CI_TEST_DB'), max: Math.min(max, 6) });
  const runtime = new Pool({ ...runtimeDatabaseConfigFromEnvironment(), max });
  return {
    query: (...args) => observer.query(...args),
    connect: () => runtime.connect(),
    end: async () => { await Promise.all([observer.end(), runtime.end()]); },
  };
}

export function makeScope(label = 'ci05a') {
  // The pinned canonical ReserveRequest requires UUID-format tenant and project
  // ids, and the boundary requires the trusted scope to match them exactly.
  return {
    tenantId: randomUUID(),
    projectId: randomUUID(),
    environment: 'test',
    billingMode: 'simulated',
    actorId: `ci05a-actor-${label}`,
  };
}

function ref(contract, id) {
  return { contract, schema_version: '1.0.0', id, revision: 1, content_hash: `sha256:${createHash('sha256').update(`ci05a:${id}`).digest('hex')}` };
}

/**
 * Build ports for the store. The synthetic finance authority grants only the
 * exact bound scope; a foreign or revoked scope is denied, and the authority
 * can be made slow or throwing to exercise the bounded-wait / unavailable path.
 */
export function makePorts(pool, scope, options = {}) {
  const clock = options.clock ?? { now: () => new Date(FIXED_TIME) };
  return {
    database: {
      connect: async () => {
        if (options.databaseError) throw new Error('synthetic unavailable budget database');
        return pool.connect();
      },
    },
    trustedContext: { resolve: async requested => ({ ...requested }) },
    clock,
    authorityWaitMs: options.authorityWaitMs,
    financeAuthority: options.financeAuthority ?? {
      authorizeCurrent: async request => {
        if (options.authorityThrows) throw new Error('synthetic authority outage');
        if (options.authorityNull) return null;
        if (options.authoritySlowMs) await new Promise(resolve => setTimeout(resolve, options.authoritySlowMs));
        if (JSON.stringify(request.requestedScope) !== JSON.stringify(scope)) {
          return { status: 'denied', decisionId: 'ci05a-foreign-scope', operation: request.operation, permission: request.permission };
        }
        const verifiedAt = new Date(clock.now()).toISOString();
        return {
          status: 'allowed', decisionId: `ci05a-grant:${request.operation}`,
          operation: request.operation, permission: request.permission, scope: request.requestedScope,
          principal: { kind: 'service', actorId: request.requestedScope.actorId, serviceStatus: 'active', serviceGrantRevision: 'ci05a-fixture-1' },
          verifiedAt,
          expiresAt: new Date(new Date(clock.now()).getTime() + 60_000).toISOString(),
        };
      },
    },
  };
}

/** A versioned source-authority reference for a policy change or lifecycle command. */
export function authorityRef(id = randomUUID()) {
  return ref('cost-intelligence.authority', id);
}

// Applicable stored policy references, keyed by tenant+currency, so request builders
// bind the canonical policy_ref to the real stored policy the way a producer must.
const policyRefs = new Map();

/** Append a budget policy limit and remember its reference for canonical request binding. */
export async function setBudgetLimit(pool, scope, limitAmount, currency = 'USD') {
  const { changeBudgetPolicy } = await import('../../dist/index.js');
  const receipt = await changeBudgetPolicy(policyChange(scope, { limitAmount, currency, expectedPolicyRevision: policyRefs.get(`${scope.tenantId}:${currency}`)?.revision ?? 0 }), makePorts(pool, scope));
  if (!receipt.ok) throw new Error(`policy change failed: ${receipt.error.code}: ${receipt.error.safe_message}`);
  if (receipt.value.status !== 'applied') throw new Error(`policy change was not applied: ${receipt.value.status}`);
  policyRefs.set(`${scope.tenantId}:${currency}`, receipt.value.policyRef);
  return receipt.value;
}

export function policyRefFor(scope, currency = 'USD') { return policyRefs.get(`${scope.tenantId}:${currency}`); }

/** Build a BudgetPolicyChangeRequest for changeBudgetPolicy. */
export function policyChange(scope, { limitAmount, currency = 'USD', expectedPolicyRevision = 0, idempotencyKey = `policy-${randomUUID()}`, requestId = `req-${randomUUID()}` } = {}) {
  return {
    schemaVersion: '1.0.0', requestId, idempotencyKey, scope,
    currency, limitAmount, expectedPolicyRevision,
    actorReference: 'ci05a-finance-controller', reasonReference: 'ci05a-budget-setup',
    sourceAuthorityRef: authorityRef(),
  };
}

/**
 * Build a finance ReservationRequest wrapping a canonical ReserveRequest.
 * `estimate` defaults to a complete exact estimate for `knownSubtotal`.
 */
export function reservationRequest(scope, reserveFixture, options = {}) {
  const currency = options.currency ?? 'USD';
  const amount = options.amount ?? '0.75';
  const idem = options.idempotencyKey ?? `reserve-${randomUUID()}`;
  // Canonical identity fields are UUID-format per the shared contract; the
  // finance attempt binding below uses independent readable identifiers.
  const canonicalLogicalOperationId = randomUUID();
  const canonicalBillableAttemptId = randomUUID();
  const logicalOperationId = options.logicalOperationId ?? `logical-${randomUUID()}`;
  const billableAttemptId = options.billableAttemptId ?? `billable-${randomUUID()}`;
  const canonicalRequest = {
    ...structuredClone(reserveFixture),
    tenant_id: scope.tenantId, project_id: scope.projectId, environment: scope.environment, billing_mode: scope.billingMode,
    currency, idempotency_key: idem, request_id: randomUUID(), correlation_id: randomUUID(),
    event_id: randomUUID(), budget_scope_id: randomUUID(),
    logical_operation_id: canonicalLogicalOperationId, billable_attempt_id: canonicalBillableAttemptId,
    requested: { amount: options.requestedAmount ?? amount, currency, scale: (options.requestedAmount ?? amount).includes('.') ? (options.requestedAmount ?? amount).split('.')[1].length : 0 },
    policy_ref: options.policyRef ?? policyRefs.get(`${scope.tenantId}:${currency}`) ?? reserveFixture.policy_ref,
  };
  const estimate = options.estimate ?? {
    completeness: 'complete', knownSubtotal: amount, currency, rateCardRef: null, missingDimensions: [],
  };
  return {
    schemaVersion: '1.0.0', requestId: options.requestId ?? `req-${idem}`, idempotencyKey: idem, scope,
    canonicalRequest, estimate,
    allowPartialAuthorization: options.allowPartialAuthorization ?? false,
    attemptBinding: {
      logicalOperationId, transportAttemptId: `transport-${logicalOperationId}`,
      providerRequestId: null, providerAttemptId: `provider-${logicalOperationId}`, billableAttemptId,
    },
  };
}

export function lifecycleBase(scope, reservationId, expectedRevision, { idempotencyKey = `cmd-${randomUUID()}`, requestId = `req-${randomUUID()}`, logicalOperationId = `logical-${randomUUID()}`, billableAttemptId = `billable-${randomUUID()}`, attemptBinding } = {}) {
  return {
    schemaVersion: '1.0.0', requestId, idempotencyKey, scope, reservationId, expectedRevision,
    actorReference: 'ci05a-worker', sourceAuthorityRef: authorityRef(),
    attemptBinding: attemptBinding ?? { logicalOperationId, transportAttemptId: `transport-${logicalOperationId}`, providerRequestId: null, providerAttemptId: `provider-${logicalOperationId}`, billableAttemptId },
  };
}

export function markDispatchedCommand(scope, reservationId, expectedRevision, options = {}) {
  return {
    ...lifecycleBase(scope, reservationId, expectedRevision, options), action: 'mark_dispatched',
    workerLeaseId: 'ci05a-lease', workerLeaseExpiresAt: '2026-10-12T05:00:00.000Z', dispatchIntentRef: authorityRef(),
  };
}

export function settleCommand(scope, reservationId, expectedRevision, { cumulativeAmount, finality = 'partial', sequence = 1, currency = 'USD', ...rest } = {}) {
  const base = lifecycleBase(scope, reservationId, expectedRevision, rest);
  return {
    ...base, action: 'settle',
    canonicalCommand: canonicalCommand('SettleRequest', scope, reservationId, expectedRevision, currency, { consumed: { amount: cumulativeAmount, currency, scale: fractionScale(cumulativeAmount) } }),
    settlement: { measure: 'cumulative', finality, sequence, cumulativeAmount, currency, usageCompleteness: 'complete', sourceObservationRefs: [authorityRef()], allowObservedOverrun: true },
  };
}

export function releaseCommand(scope, reservationId, expectedRevision, { amount, currency = 'USD', proof = 'never_dispatched_fenced', ...rest } = {}) {
  const base = lifecycleBase(scope, reservationId, expectedRevision, rest);
  return {
    ...base, action: 'release',
    canonicalCommand: canonicalCommand('ReleaseRequest', scope, reservationId, expectedRevision, currency, {}),
    release: { amount, currency, reason: 'ci05a unused hold', proof, evidenceRefs: [authorityRef()] },
  };
}

function fractionScale(value) { return typeof value === 'string' && value.includes('.') ? value.split('.')[1].length : 0; }

/** Valid canonical Settle/Release payload (cloned from the shared fixture) matching the wrapper scope and revision. */
function canonicalCommand(contract, scope, reservationId, expectedRevision, currency, extra) {
  const base = structuredClone(contract === 'SettleRequest' ? SETTLE_FIXTURE : RELEASE_FIXTURE);
  base.tenant_id = scope.tenantId;
  base.project_id = scope.projectId;
  base.environment = scope.environment;
  base.billing_mode = scope.billingMode;
  base.currency = currency;
  base.reservation_id = reservationId;
  base.expected_revision = expectedRevision;
  base.idempotency_key = `${contract.toLowerCase()}-${randomUUID()}`;
  base.request_id = randomUUID();
  base.correlation_id = randomUUID();
  base.event_id = randomUUID();
  base.budget_scope_id = randomUUID();
  base.logical_operation_id = randomUUID();
  base.billable_attempt_id = randomUUID();
  if ('consumed' in extra) base.consumed = extra.consumed;
  if ('reason' in extra) base.reason = extra.reason;
  return base;
}

/**
 * A scripted PostgreSQL client for database-free regression tests. `handler(sql, values)`
 * returns rows for a statement; every statement is recorded. Nothing here claims PostgreSQL
 * validation: it exercises the engine's own control flow only.
 */
export function scriptedClient(handler = () => []) {
  const statements = [];
  const state = { released: 0 };
  const client = {
    async query(sql, values) {
      statements.push(sql.replace(/\s+/g, ' ').trim());
      const rows = await handler(sql, values);
      return { rows: rows ?? [], rowCount: (rows ?? []).length };
    },
    release() { state.released += 1; },
  };
  return {
    client, statements, state,
    wrote: () => statements.some(sql => sql.startsWith('INSERT')),
    committed: () => statements.includes('COMMIT'),
  };
}

export const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Scripted ports whose database hands out the given client (optionally late or never). */
export function scriptedPorts(scope, connect, options = {}) {
  return makePorts({ connect }, scope, options);
}

/** The policy row, aggregate row and event rows a typical scripted authorization partition returns. */
export function partitionRows(policyRef, limit = '1.00', used = '0') {
  return sql => {
    if (sql.includes('FROM cost_intelligence.budget_scope_policies')) {
      return [{ policy_version_id: policyRef.id, policy_revision: policyRef.revision, limit_amount: limit, content_hash: policyRef.content_hash }];
    }
    if (sql.includes('WITH per_reservation')) return [{ reservation_count: used === '0' ? 0 : 1, consumed: '0', outstanding_holds: used, used }];
    return null;
  };
}
