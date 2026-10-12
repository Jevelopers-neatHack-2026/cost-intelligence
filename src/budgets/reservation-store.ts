import { Type, type Static } from '@sinclair/typebox';
import {
  authorizeFinanceOperation,
  errorEnvelope,
  failure,
  type ApiResult,
  type Clock,
  type ErrorEnvelope,
  type FinanceAuthorizationPort,
  type FinanceOperation,
  type TrustedContextPort,
  type TrustedScope,
  type Validation,
} from '../shared/contracts.js';
import { bindFinancialDatabaseScope } from '../shared/database-scope.js';
import {
  validateReleaseReservationCommandBoundary,
  validateReservationRequestBoundary,
  validateSettleReservationCommandBoundary,
  type AuthorizationDecision,
  type MarkDispatchedCommand,
  type ReleaseReservationCommand,
  type ReservationRequest,
  type SettleReservationCommand,
} from './index.js';

/* ------------------------------------------------------------------ *
 * CI-05A: atomic project budget reservations and bounded authorization.
 *
 * The authoritative budget state is an append-only event log
 * (`budget_reservation_events`) governed by a versioned, append-only
 * budget policy (`budget_scope_policies`). Capacity is a projection over
 * those events — never a mutable counter — so a rebuild from the log is
 * always equal to the enforced number. Concurrency is serialized per
 * (tenant, project, environment, billing_mode, currency) partition with a
 * transaction-scoped PostgreSQL advisory lock under READ COMMITTED plus a
 * bounded `lock_timeout`; a unique idempotency binding makes retries reuse
 * the single existing hold. Replaying a key is honored only for the identical
 * normalized original request; anything else is a typed IDEMPOTENCY_CONFLICT.
 * Every operation shares one finite end-to-end deadline (authority, connection
 * and statements). Work that has not reached its COMMIT when the deadline passes
 * is abandoned and rolled back. A timeout while awaiting COMMIT acknowledgement
 * returns the retryable unavailable result, but the transaction outcome is
 * ambiguous: the hold or lifecycle event may have persisted, so the caller must
 * retry with the same idempotency key (which replays it or reports a conflict).
 * Budget authority is NOT product-purchase
 * authority: these records only ration spend against a project limit.
 * ------------------------------------------------------------------ */

/** The reviewed budget decision policy version pinned by this leaf. */
export const BUDGET_DECISION_POLICY_VERSION = 'ci-budget-policy-1.0.0' as const;

/** Bounded wait, in milliseconds, for the per-partition authority lock before returning `unavailable`. */
export const DEFAULT_AUTHORITY_WAIT_MS = 2_000;
/** Upper bound for a configured end-to-end authority wait; zero, infinite and larger values are rejected. */
export const MAX_AUTHORITY_WAIT_MS = 60_000;
/** Retry guidance returned to callers when authorization is temporarily unavailable. */
export const DEFAULT_RETRY_AFTER_MS = 1_000;

export interface BudgetQueryResult {
  readonly rows: readonly Record<string, unknown>[];
  readonly rowCount: number | null;
}

/** Structural subset implemented by a node-postgres PoolClient. */
export interface BudgetTransactionPort {
  query(text: string, values?: readonly unknown[]): Promise<BudgetQueryResult>;
  release(): void;
}

/** Inject an existing host-managed pool; this module never opens a hidden connection. */
export interface BudgetDatabasePort {
  connect(): Promise<BudgetTransactionPort>;
}

export interface BudgetRuntimePorts {
  readonly database: BudgetDatabasePort;
  readonly trustedContext: TrustedContextPort;
  readonly clock: Clock;
  /** Current operation-scoped host authority; missing configuration denies writes and reads. */
  readonly financeAuthority?: FinanceAuthorizationPort;
  /** Bounded wait for the partition authority lock before returning unavailable. */
  readonly authorityWaitMs?: number;
  /**
   * CI-05B: optional financial expiry window, in milliseconds, stamped on a hold
   * at authorization. This is the hold's FINANCIAL expiry (authoritative budget
   * state), independent of any worker lease TTL. A never-dispatched hold whose
   * financial expiry has matured may be released only through an authoritative,
   * fenced `expireReservation`. Omitted means the hold never auto-expires.
   */
  readonly financialExpiryMs?: number;
}

const VersionedReferenceSchema = Type.Object({
  contract: Type.String({ minLength: 1 }), schema_version: Type.Literal('1.0.0'), id: Type.String({ minLength: 1 }),
  revision: Type.Integer({ minimum: 0 }), content_hash: Type.String({ pattern: '^sha256:[a-f0-9]{64}$' }),
}, { additionalProperties: false });
type VersionedReference = Static<typeof VersionedReferenceSchema>;

export const BudgetPolicyChangeRequestSchema = Type.Object({
  schemaVersion: Type.Literal('1.0.0'), requestId: Type.String({ minLength: 1, maxLength: 128 }),
  idempotencyKey: Type.String({ minLength: 1, maxLength: 200 }),
  scope: Type.Object({
    tenantId: Type.String({ minLength: 1, maxLength: 128 }), projectId: Type.String({ minLength: 1, maxLength: 128 }),
    environment: Type.Union([Type.Literal('development'), Type.Literal('test'), Type.Literal('production')]),
    billingMode: Type.Union([Type.Literal('live'), Type.Literal('sandbox'), Type.Literal('simulated')]),
    actorId: Type.String({ minLength: 1, maxLength: 128 }),
  }, { additionalProperties: false }),
  currency: Type.String({ pattern: '^[A-Z]{3}$' }),
  limitAmount: Type.String({ pattern: '^(?:0|[1-9][0-9]*)(?:\\.[0-9]{1,18})?$', maxLength: 40 }),
  expectedPolicyRevision: Type.Integer({ minimum: 0 }),
  actorReference: Type.String({ minLength: 1, maxLength: 200 }),
  reasonReference: Type.String({ minLength: 1, maxLength: 200 }),
  sourceAuthorityRef: VersionedReferenceSchema,
}, { additionalProperties: false });
export type BudgetPolicyChangeRequest = Static<typeof BudgetPolicyChangeRequestSchema>;

export interface BudgetPolicyReceipt {
  readonly schemaVersion: '1.0.0';
  readonly requestId: string;
  readonly status: 'applied' | 'replay' | 'stale' | 'conflict';
  readonly policyVersionId: string;
  readonly policyRevision: number;
  readonly currency: string;
  readonly effectiveLimit: string;
  readonly previousLimit: string;
  readonly decisionPolicyVersion: typeof BUDGET_DECISION_POLICY_VERSION;
  readonly policyRef: VersionedReference;
}

export type ReservationLifecycleState = 'held' | 'dispatched' | 'partially_settled' | 'settled' | 'released' | 'expired';

export interface ReservationCommandOutcome {
  readonly schemaVersion: '1.0.0';
  readonly requestId: string;
  readonly status: 'applied' | 'replay' | 'conflict' | 'stale_revision';
  readonly reservationId: string;
  readonly state: ReservationLifecycleState;
  readonly heldAmount: string;
  readonly consumedAmount: string;
  readonly releasedAmount: string;
  readonly outstandingHold: string;
  /** Observed consumption above the hold (variance); real spend is recorded in full, never clamped to the hold. */
  readonly overrunAmount: string;
  readonly currency: string;
  readonly revision: number;
  readonly usageFinality: 'unknown' | 'partial' | 'final';
}

export interface CapacitySnapshot {
  readonly schemaVersion: '1.0.0';
  readonly requestId: string;
  readonly scope: TrustedScope;
  readonly currency: string;
  readonly limitAmount: string;
  readonly effectiveConsumedSpend: string;
  readonly outstandingHolds: string;
  readonly usedCapacity: string;
  readonly availableCapacity: string;
  readonly reservationCount: number;
  /** Advisory read only; it never creates a reservation or authorizes dispatch. */
  readonly advisoryOnly: true;
}

/* -------------------------------- exact decimal helpers -------------------------------- */

const SCALE = 1_000_000_000_000_000_000n;

function parseScaledDecimal(value: string): bigint {
  const match = /^(-?)(0|[1-9][0-9]*)(?:\.([0-9]{1,18}))?$/.exec(value);
  if (!match) throw new Error('Decimal failed validation before exact parsing.');
  const sign = match[1] === '-' ? -1n : 1n;
  const whole = BigInt(match[2] ?? '0');
  const fraction = BigInt((match[3] ?? '').padEnd(18, '0') || '0');
  return sign * (whole * SCALE + fraction);
}

function formatScaledDecimal(value: bigint): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / SCALE;
  const fraction = (absolute % SCALE).toString().padStart(18, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole.toString()}${fraction ? `.${fraction}` : ''}`;
}

/* -------------------------------- misc helpers -------------------------------- */

function makeError(operation: string, code: ErrorEnvelope['code'], requestId: string, message: string, retryable = false): ErrorEnvelope {
  return errorEnvelope('budgets', operation, code, requestId, message, retryable);
}

/**
 * A PostgreSQL unique-violation (SQLSTATE 23505). This is a lost-update race on
 * one of the budget idempotency/uniqueness bindings (the idempotency key, the
 * monotonic sequence, or the CI-05B partial unique on the first event's
 * billable attempt). It is a deterministic, typed conflict — not a transient
 * outage — so it must surface as IDEMPOTENCY_CONFLICT and never be masked as
 * a retryable "unavailable".
 */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23505';
}

function uniqueViolationConstraint(error: unknown): string {
  return typeof error === 'object' && error !== null && typeof (error as { constraint?: unknown }).constraint === 'string'
    ? (error as { constraint: string }).constraint : 'unknown';
}

function asString(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Database returned an unexpected budget value.');
  return value;
}

function fromRow(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  return typeof value === 'number' ? String(value) : asString(value);
}

function canonicalJson(value: unknown): string {
  return JSON.stringify((function canon(input: unknown): unknown {
    if (Array.isArray(input)) return input.map(canon);
    if (typeof input === 'object' && input !== null) {
      const object = input as Record<string, unknown>;
      return Object.fromEntries(Object.keys(object).sort().map(key => [key, canon(object[key])]));
    }
    return input;
  })(value));
}

/** Compare two JSON-shaped values (objects or their serialized text) by canonical content. */
function sameJson(left: unknown, right: unknown): boolean {
  const normalize = (input: unknown): unknown => {
    if (typeof input !== 'string') return input ?? null;
    try { return JSON.parse(input); } catch { return input; }
  };
  return canonicalJson(normalize(left)) === canonicalJson(normalize(right));
}

async function hashValue(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return `sha256:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

/** Resolve the configured end-to-end wait; only a finite positive bounded integer is accepted. */
function resolveWaitMs(ports: BudgetRuntimePorts): number | null {
  const configured: unknown = ports.authorityWaitMs;
  if (configured === undefined) return DEFAULT_AUTHORITY_WAIT_MS;
  return typeof configured === 'number' && Number.isInteger(configured) && configured > 0 && configured <= MAX_AUTHORITY_WAIT_MS
    ? configured : null;
}

function invalidWaitFailure(operation: string, requestId: string): ApiResult<never> {
  return failure(makeError(operation, 'VALIDATION_ERROR', requestId,
    'The budget authority wait must be a finite positive integer number of milliseconds within the supported bound.'));
}

class DeadlineExceeded extends Error {}

/**
 * Shared end-to-end deadline for one operation. Once the deadline fires before
 * the commit statement is issued, every later checkpoint throws so late work
 * can never persist a hold after `unavailable` was reported.
 */
class DeadlineGate {
  expired = false;
  committing = false;
  private readonly deadlineAt: number;
  constructor(waitMs: number) { this.deadlineAt = Date.now() + waitMs; }
  remainingMs(): number { return Math.max(1, Math.ceil(this.deadlineAt - Date.now())); }
  checkpoint(): void { if (this.expired) throw new DeadlineExceeded('budget deadline exceeded'); }
  /** The commit is the point of no return: its outcome is unknown until acknowledged, and the deadline still applies. */
  beginCommit(): void { this.checkpoint(); this.committing = true; }
}

async function runBounded<T>(waitMs: number, onTimeout: () => T, body: (gate: DeadlineGate) => Promise<T>): Promise<T> {
  const gate = new DeadlineGate(waitMs);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>(resolve => {
    // The deadline also applies while a COMMIT is unacknowledged. The commit may still land, so the
    // caller gets the retryable unavailable result; a retry with the same idempotency key replays
    // (or conflicts with) whatever persisted and never frees or double-books the exposure.
    timer = setTimeout(() => { gate.expired = true; resolve(onTimeout()); }, waitMs);
  });
  const work = body(gate);
  work.catch(() => undefined);
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** The financial expiry timestamp to stamp on a new hold, or null when no window is configured. */
function financialExpiresAt(ports: BudgetRuntimePorts, now: Date): string | null {
  const ms = ports.financialExpiryMs;
  if (ms === undefined) return null;
  if (!(typeof ms === 'number' && Number.isInteger(ms) && ms > 0)) return null;
  return new Date(now.getTime() + ms).toISOString();
}

function trustedNow(ports: BudgetRuntimePorts): Date | null {
  try {
    const now = ports.clock.now();
    return now instanceof Date && Number.isFinite(now.getTime()) ? now : null;
  } catch {
    return null;
  }
}

async function authorizeScope(
  scope: TrustedScope,
  requestId: string,
  ports: BudgetRuntimePorts,
  requestOperation: string,
  operation: FinanceOperation,
): Promise<ErrorEnvelope | null> {
  const authorization = await authorizeFinanceOperation({
    module: 'budgets', requestOperation, operation, scope, requestId, clock: ports.clock,
    financeAuthority: ports.financeAuthority,
  });
  if (authorization.ok) return null;
  // A temporarily unavailable authority maps to a retryable budget-unavailable envelope.
  if (authorization.error.code === 'SOURCE_UNAVAILABLE') {
    return makeError(requestOperation, 'BUDGET_UNAVAILABLE', requestId,
      'Budget authorization is temporarily unavailable; retry the identical idempotent request.', true);
  }
  return authorization.error;
}

async function rollback(client: BudgetTransactionPort): Promise<void> {
  await client.query('ROLLBACK').catch(() => undefined);
}

function partitionLockKey(scope: TrustedScope, currency: string): string {
  return `ci05a-budget:${scope.tenantId}:${scope.projectId}:${scope.environment}:${scope.billingMode}:${currency}`;
}

/** Bind the remaining end-to-end budget to every statement of the open transaction. */
async function bindDeadline(client: BudgetTransactionPort, gate: DeadlineGate): Promise<void> {
  gate.checkpoint();
  const remaining = gate.remainingMs();
  await client.query(`SET LOCAL statement_timeout = '${remaining}ms'`);
  await client.query(`SET LOCAL lock_timeout = '${remaining}ms'`);
}

/** Acquire the per-partition authority lock within the transaction's bounded deadline. */
async function acquirePartitionLock(
  client: BudgetTransactionPort,
  scope: TrustedScope,
  currency: string,
  gate: DeadlineGate,
): Promise<boolean> {
  gate.checkpoint();
  try {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [partitionLockKey(scope, currency)]);
  } catch {
    return false;
  }
  gate.checkpoint();
  return true;
}

interface PartitionCapacity {
  readonly limit: bigint;
  readonly consumed: bigint;
  readonly outstandingHolds: bigint;
  readonly used: bigint;
  readonly available: bigint;
  readonly reservationCount: number;
  readonly policy: { id: string; revision: number; contentHash: string } | null;
}

async function currentPolicy(
  client: BudgetTransactionPort,
  scope: TrustedScope,
  currency: string,
): Promise<{ id: string; revision: number; limit: bigint; contentHash: string } | null> {
  const result = await client.query(
    `SELECT policy_version_id, policy_revision, limit_amount::text AS limit_amount, content_hash
     FROM cost_intelligence.budget_scope_policies
     WHERE tenant_id = $1 AND project_id = $2 AND environment = $3 AND billing_mode = $4 AND currency = $5
     ORDER BY policy_revision DESC LIMIT 1`,
    [scope.tenantId, scope.projectId, scope.environment, scope.billingMode, currency],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: asString(row.policy_version_id),
    revision: Number(row.policy_revision),
    limit: parseScaledDecimal(asString(row.limit_amount)),
    contentHash: asString(row.content_hash),
  };
}

/** Project enforced capacity from the event log; this equals a full rebuild of the partition. */
async function projectCapacity(
  client: BudgetTransactionPort,
  scope: TrustedScope,
  currency: string,
): Promise<PartitionCapacity> {
  const policy = await currentPolicy(client, scope, currency);
  const aggregate = await client.query(
    `WITH per_reservation AS (
       SELECT reservation_id,
              sum(held_amount) AS hold,
              sum(released_amount) AS released,
              max(consumed_amount) AS consumed
       FROM cost_intelligence.budget_reservation_events
       WHERE tenant_id = $1 AND project_id = $2 AND environment = $3 AND billing_mode = $4 AND currency = $5
       GROUP BY reservation_id
     )
     SELECT count(*)::int AS reservation_count,
            coalesce(sum(consumed), 0)::text AS consumed,
            coalesce(sum(greatest(hold - released - consumed, 0)), 0)::text AS outstanding_holds,
            coalesce(sum(greatest(hold - released, consumed)), 0)::text AS used
     FROM per_reservation`,
    [scope.tenantId, scope.projectId, scope.environment, scope.billingMode, currency],
  );
  const row = aggregate.rows[0] ?? {};
  const consumed = parseScaledDecimal(fromRow(row, 'consumed') ?? '0');
  const outstandingHolds = parseScaledDecimal(fromRow(row, 'outstanding_holds') ?? '0');
  const used = parseScaledDecimal(fromRow(row, 'used') ?? '0');
  const limit = policy ? policy.limit : 0n;
  const available = limit - used > 0n ? limit - used : 0n;
  return {
    limit, consumed, outstandingHolds, used, available,
    reservationCount: Number(row.reservation_count ?? 0),
    policy: policy ? { id: policy.id, revision: policy.revision, contentHash: policy.contentHash } : null,
  };
}

/* -------------------------------- change budget policy -------------------------------- */

/** Append a new, versioned budget policy limit. Future versions never reinterpret existing reservations. */
export async function changeBudgetPolicy(
  value: unknown,
  ports: BudgetRuntimePorts,
): Promise<ApiResult<BudgetPolicyReceipt>> {
  const outer = ((): Validation<BudgetPolicyChangeRequest> => {
    const requestId = requestIdOf(value);
    if (typeof value === 'object' && value !== null && 'schemaVersion' in value && (value as Record<string, unknown>).schemaVersion !== '1.0.0') {
      return { ok: false, error: makeError('changeBudget', 'UNSUPPORTED_VERSION', requestId, 'The budget policy change schema version is not supported.') };
    }
    const { Value } = requireValue();
    if (!Value.Check(BudgetPolicyChangeRequestSchema, value)) {
      return { ok: false, error: makeError('changeBudget', 'VALIDATION_ERROR', requestId, 'The budget policy change does not match the published schema.') };
    }
    return { ok: true, value: value as BudgetPolicyChangeRequest };
  })();
  if (!outer.ok) return failure(outer.error);
  const request = outer.value;
  const scope = request.scope as TrustedScope;

  const waitMs = resolveWaitMs(ports);
  if (waitMs === null) return invalidWaitFailure('changeBudget', request.requestId);
  const unavailable = (): ApiResult<BudgetPolicyReceipt> => failure(makeError('changeBudget', 'BUDGET_UNAVAILABLE', request.requestId,
    'Budget policy persistence is temporarily unavailable; retry the identical idempotent request.', true));

  return runBounded(waitMs, unavailable, async gate => {
    let client: BudgetTransactionPort | undefined;
    let inTransaction = false;
    try {
      const authorizationError = await authorizeScope(scope, request.requestId, ports, 'changeBudget', 'budgets.changeBudget');
      gate.checkpoint();
      if (authorizationError) return failure(authorizationError);
      if (!trustedNow(ports)) return failure(makeError('changeBudget', 'BUDGET_UNAVAILABLE', request.requestId, 'The trusted budget clock is unavailable.', true));

      client = await ports.database.connect();
      gate.checkpoint();
      await client.query('BEGIN');
      inTransaction = true;
      await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
      await bindFinancialDatabaseScope(client, scope);
      await bindDeadline(client, gate);
      if (!(await acquirePartitionLock(client, scope, request.currency, gate))) {
        await rollback(client); inTransaction = false;
        return failure(makeError('changeBudget', 'BUDGET_UNAVAILABLE', request.requestId, 'The budget partition is busy; retry the identical idempotent request.', true));
      }

      const replay = await client.query(
        `SELECT policy_version_id, policy_revision, currency, limit_amount::text AS limit_amount, content_hash,
                actor_reference, reason_reference, source_authority_ref
         FROM cost_intelligence.budget_scope_policies
         WHERE tenant_id = $1 AND project_id = $2 AND environment = $3 AND billing_mode = $4 AND idempotency_key = $5`,
        [scope.tenantId, scope.projectId, scope.environment, scope.billingMode, request.idempotencyKey],
      );
      const existing = await currentPolicy(client, scope, request.currency);
      if (replay.rows.length) {
        const row = replay.rows[0] as Record<string, unknown>;
        // A replay must match the normalized original change; otherwise it is a typed conflict.
        const identical = fromRow(row, 'currency') === request.currency
          && fromRow(row, 'limit_amount') !== null
          && parseScaledDecimal(asString(row.limit_amount)) === parseScaledDecimal(request.limitAmount)
          && Number(row.policy_revision) - 1 === request.expectedPolicyRevision
          && fromRow(row, 'actor_reference') === request.actorReference
          && fromRow(row, 'reason_reference') === request.reasonReference
          && sameJson(row.source_authority_ref, request.sourceAuthorityRef);
        if (!identical) {
          await rollback(client); inTransaction = false;
          return failure(makeError('changeBudget', 'IDEMPOTENCY_CONFLICT', request.requestId,
            'The idempotency key was already used for a different budget policy change.'));
        }
        gate.beginCommit();
        await client.query('COMMIT'); inTransaction = false;
        return {
          ok: true,
          value: {
            schemaVersion: '1.0.0', requestId: request.requestId, status: 'replay',
            policyVersionId: asString(row.policy_version_id), policyRevision: Number(row.policy_revision), currency: request.currency,
            effectiveLimit: formatScaledDecimal(parseScaledDecimal(asString(row.limit_amount))),
            previousLimit: existing ? formatScaledDecimal(existing.limit) : '0',
            decisionPolicyVersion: BUDGET_DECISION_POLICY_VERSION,
            policyRef: { contract: 'cost-intelligence.budget-policy', schema_version: '1.0.0', id: asString(row.policy_version_id), revision: Number(row.policy_revision), content_hash: asString(row.content_hash) },
          },
        };
      }

      const currentRevision = existing?.revision ?? 0;
      if (request.expectedPolicyRevision !== currentRevision) {
        await rollback(client); inTransaction = false;
        return {
          ok: true,
          value: {
            schemaVersion: '1.0.0', requestId: request.requestId, status: 'stale',
            policyVersionId: existing?.id ?? 'none', policyRevision: currentRevision, currency: request.currency,
            effectiveLimit: existing ? formatScaledDecimal(existing.limit) : '0',
            previousLimit: existing ? formatScaledDecimal(existing.limit) : '0',
            decisionPolicyVersion: BUDGET_DECISION_POLICY_VERSION,
            policyRef: { contract: 'cost-intelligence.budget-policy', schema_version: '1.0.0', id: existing?.id ?? 'none', revision: currentRevision, content_hash: `sha256:${'0'.repeat(64)}` },
          },
        };
      }

      const nextRevision = currentRevision + 1;
      const policyVersionId = globalThis.crypto.randomUUID();
      const contentHash = await hashValue({
        tenant: scope.tenantId, project: scope.projectId, environment: scope.environment, billingMode: scope.billingMode,
        currency: request.currency, limit: request.limitAmount, revision: nextRevision, policy: BUDGET_DECISION_POLICY_VERSION,
      });
      gate.checkpoint();
      await client.query(
        `INSERT INTO cost_intelligence.budget_scope_policies
          (policy_version_id, tenant_id, project_id, environment, billing_mode, currency, policy_revision,
           limit_amount, alert_threshold_percent, decision_policy_version, idempotency_key, actor_reference,
           reason_reference, source_authority_ref, supersedes_policy_version_id, content_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::numeric,80,$9,$10,$11,$12,$13::jsonb,$14,$15)`,
        [policyVersionId, scope.tenantId, scope.projectId, scope.environment, scope.billingMode, request.currency, nextRevision,
          request.limitAmount, BUDGET_DECISION_POLICY_VERSION, request.idempotencyKey, request.actorReference,
          request.reasonReference, JSON.stringify(request.sourceAuthorityRef), existing?.id ?? null, contentHash],
      );
      gate.beginCommit();
      await client.query('COMMIT'); inTransaction = false;
      return {
        ok: true,
        value: {
          schemaVersion: '1.0.0', requestId: request.requestId, status: 'applied',
          policyVersionId, policyRevision: nextRevision, currency: request.currency,
          effectiveLimit: formatScaledDecimal(parseScaledDecimal(request.limitAmount)),
          previousLimit: existing ? formatScaledDecimal(existing.limit) : '0',
          decisionPolicyVersion: BUDGET_DECISION_POLICY_VERSION,
          policyRef: { contract: 'cost-intelligence.budget-policy', schema_version: '1.0.0', id: policyVersionId, revision: nextRevision, content_hash: contentHash },
        },
      };
    } catch {
      if (client && inTransaction) await rollback(client);
      return unavailable();
    } finally {
      client?.release();
    }
  });
}

/* -------------------------------- authorize reservation -------------------------------- */

function requireValue(): { Value: { Check(schema: unknown, value: unknown): boolean } } {
  // Deferred import avoids a hard dependency cycle at module init.
  return { Value: valueModule };
}

function decisionReference(policy: { id: string; revision: number; contentHash: string } | null): VersionedReference {
  return policy
    ? { contract: 'cost-intelligence.budget-policy', schema_version: '1.0.0', id: policy.id, revision: policy.revision, content_hash: policy.contentHash }
    : { contract: 'cost-intelligence.budget-policy', schema_version: '1.0.0', id: 'unconfigured', revision: 0, content_hash: `sha256:${'0'.repeat(64)}` };
}

/**
 * The hold a request needs. Only a complete estimate is bounded. An
 * incomplete/unknown estimate would need an authorized explicit maximum policy,
 * but no trusted resolver for `maximumPolicyRef` exists at the approved
 * boundary (the finance authority port receives only scope/operation/permission),
 * so a caller-supplied reference is never treated as authority: unbounded.
 */
function requiredHold(request: ReservationRequest): bigint | null {
  const estimate = request.estimate;
  return estimate.completeness === 'complete' ? parseScaledDecimal(estimate.knownSubtotal) : null;
}

function sameAmount(left: string, right: string): boolean {
  return parseScaledDecimal(left) === parseScaledDecimal(right);
}

/** Contradictory financial fields between the canonical request and the estimate. */
function financialBindingError(request: ReservationRequest): string | null {
  const canonical = request.canonicalRequest;
  const requested = canonical.requested;
  if (request.estimate.currency !== canonical.currency || requested.currency !== canonical.currency) {
    return 'The estimate and requested amount currency must match the reservation request currency.';
  }
  if (request.estimate.completeness === 'complete' && !sameAmount(requested.amount, request.estimate.knownSubtotal)) {
    return 'The canonical requested amount contradicts the complete estimate.';
  }
  const maximum = request.estimate.boundedConservativeMaximum;
  if (request.estimate.completeness === 'complete') {
    // A reference to a maximum policy has no persisted, replay-bound home and is never authority; refuse it rather than ignore it.
    if (request.estimate.maximumPolicyRef !== undefined) {
      return 'A maximum policy reference is not supported on a complete estimate; omit it.';
    }
    if (maximum !== undefined && parseScaledDecimal(maximum) < parseScaledDecimal(request.estimate.knownSubtotal)) {
      return 'The bounded conservative maximum cannot be below the known subtotal.';
    }
  }
  return null;
}

function policyRefMatches(canonicalRef: { id: string; revision: number; content_hash: string }, policy: { id: string; revision: number; contentHash: string }): boolean {
  return canonicalRef.id === policy.id && canonicalRef.revision === policy.revision && canonicalRef.content_hash === policy.contentHash;
}

/**
 * Atomically check applicable project capacity and create an idempotent
 * reservation hold before billable dispatch. The whole call, including the
 * host authority, the connection and every database statement, shares one
 * finite deadline. Work not yet at COMMIT when the deadline passes is rolled
 * back and cannot create a hold. A timeout while awaiting COMMIT acknowledgement
 * returns the retryable `unavailable` decision, but the transaction outcome is
 * ambiguous and the hold may have persisted: the caller must not dispatch and
 * must retry with the same idempotency key, which replays the hold if it
 * persisted (or reports a conflict for a different request).
 */
export async function authorizeReservation(
  value: unknown,
  ports: BudgetRuntimePorts,
): Promise<ApiResult<AuthorizationDecision>> {
  const validated = validateReservationRequestBoundary(value);
  if (!validated.ok) return failure(validated.error);
  const request = validated.value as ReservationRequest;
  const scope = request.scope as TrustedScope;
  const requestId = request.requestId;
  const waitMs = resolveWaitMs(ports);
  if (waitMs === null) return invalidWaitFailure('authorize', requestId);
  const currency = request.estimate.currency;
  const unavailable = (): ApiResult<AuthorizationDecision> => ({ ok: true, value: unavailableDecision(requestId, request, currency, trustedNow(ports)) });

  return runBounded(waitMs, unavailable, async gate => {
    let client: BudgetTransactionPort | undefined;
    let inTransaction = false;
    try {
      const authorizationError = await authorizeScope(scope, requestId, ports, 'authorize', 'budgets.authorize');
      gate.checkpoint();
      if (authorizationError) return failure(authorizationError);
      const now = trustedNow(ports);
      if (!now) return failure(makeError('authorize', 'BUDGET_UNAVAILABLE', requestId, 'The trusted budget clock is unavailable.', true));

      // Cross-currency pooling is forbidden without explicit policy, and the
      // canonical requested amount may not contradict the estimate.
      const bindingError = financialBindingError(request);
      if (bindingError) return failure(makeError('authorize', 'VALIDATION_ERROR', requestId, bindingError));

      client = await ports.database.connect();
      gate.checkpoint();
      await client.query('BEGIN');
      inTransaction = true;
      await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
      await bindFinancialDatabaseScope(client, scope);
      await bindDeadline(client, gate);
      if (!(await acquirePartitionLock(client, scope, currency, gate))) {
        await rollback(client); inTransaction = false;
        return unavailable();
      }

      // Idempotent retry: the key returns the single existing hold only when the
      // normalized original request matches; otherwise it is a typed conflict.
      const replay = await client.query(
        `SELECT reservation_id, event_type, event_sequence, currency, held_amount::text AS held_amount,
                partial_allowed_amount::text AS partial_allowed_amount, estimate_completeness,
                known_subtotal::text AS known_subtotal, bounded_maximum::text AS bounded_maximum, allow_partial,
                attempt_binding, policy_version_id, policy_ref, rate_card_ref
         FROM cost_intelligence.budget_reservation_events
         WHERE tenant_id = $1 AND project_id = $2 AND environment = $3 AND billing_mode = $4 AND idempotency_key = $5
         ORDER BY event_sequence ASC LIMIT 1`,
        [scope.tenantId, scope.projectId, scope.environment, scope.billingMode, request.idempotencyKey],
      );
      const capacity = await projectCapacity(client, scope, currency);
      if (replay.rows.length) {
        const row = replay.rows[0] as Record<string, unknown>;
        const eventType = fromRow(row, 'event_type');
        const storedPolicyRef = parseRef(row.policy_ref);
        const storedKnown = fromRow(row, 'known_subtotal');
        const storedMaximum = fromRow(row, 'bounded_maximum');
        const incomingMaximum = request.estimate.boundedConservativeMaximum;
        const identical = (eventType === 'authorized' || eventType === 'partially_authorized')
          && Number(row.event_sequence) === 1
          && fromRow(row, 'currency') === currency
          && fromRow(row, 'estimate_completeness') === request.estimate.completeness
          && storedKnown !== null && sameAmount(storedKnown, request.estimate.knownSubtotal)
          && (storedMaximum === null ? incomingMaximum === undefined : incomingMaximum !== undefined && sameAmount(storedMaximum, incomingMaximum))
          && row.allow_partial === request.allowPartialAuthorization
          && sameJson(row.attempt_binding, request.attemptBinding)
          && sameJson(row.rate_card_ref, request.estimate.rateCardRef)
          && storedPolicyRef !== null
          && policyRefMatches(request.canonicalRequest.policy_ref, { id: storedPolicyRef.id, revision: storedPolicyRef.revision, contentHash: storedPolicyRef.content_hash });
        if (!identical) {
          await rollback(client); inTransaction = false;
          return failure(makeError('authorize', 'IDEMPOTENCY_CONFLICT', requestId,
            'The idempotency key was already used for a different reservation request.'));
        }
        const held = parseScaledDecimal(fromRow(row, 'held_amount') ?? '0');
        const partial = fromRow(row, 'partial_allowed_amount');
        const status: AuthorizationDecision['status'] = eventType === 'authorized' ? 'authorized' : 'partial';
        gate.beginCommit();
        await client.query('COMMIT'); inTransaction = false;
        return {
          ok: true,
          value: buildDecision({
            requestId, request, currency, now, status,
            reservationId: asString(row.reservation_id), held, available: capacity.available,
            partialAllowed: partial === null ? null : parseScaledDecimal(partial),
            policyRef: storedPolicyRef!,
            rateCardRef: parseRef(row.rate_card_ref),
          }),
        };
      }

      // No applicable budget policy means no configured authority: deny by default.
      if (!capacity.policy) {
        await rollback(client); inTransaction = false;
        return { ok: true, value: buildDecision({ requestId, request, currency, now, status: 'denied', reservationId: 'none', held: 0n, available: capacity.available, partialAllowed: null, policyRef: decisionReference(null), rateCardRef: request.estimate.rateCardRef }) };
      }

      // The canonical policy reference must name the applicable stored policy
      // revision exactly; a stale or foreign reference never authorizes.
      if (!policyRefMatches(request.canonicalRequest.policy_ref, capacity.policy)) {
        await rollback(client); inTransaction = false;
        return failure(makeError('authorize', 'VALIDATION_ERROR', requestId,
          'The reservation policy reference is not the currently applicable budget policy; re-read the policy and resubmit.'));
      }

      const need = requiredHold(request);
      if (need === null) {
        // Unknown / unbounded pricing cannot auto-authorize.
        await rollback(client); inTransaction = false;
        return { ok: true, value: buildDecision({ requestId, request, currency, now, status: 'denied', reservationId: 'none', held: 0n, available: capacity.available, partialAllowed: null, policyRef: decisionReference(capacity.policy), rateCardRef: request.estimate.rateCardRef }) };
      }

      const reservationId = globalThis.crypto.randomUUID();
      let status: AuthorizationDecision['status'];
      let hold: bigint;
      let partialAllowed: bigint | null = null;
      if (need <= capacity.available) {
        status = 'authorized'; hold = need;
      } else if (request.allowPartialAuthorization && capacity.available > 0n) {
        status = 'partial'; hold = capacity.available; partialAllowed = capacity.available;
      } else {
        status = 'denied'; hold = 0n;
      }

      if (status === 'denied') {
        await rollback(client); inTransaction = false;
        return { ok: true, value: buildDecision({ requestId, request, currency, now, status, reservationId: 'none', held: 0n, available: capacity.available, partialAllowed: null, policyRef: decisionReference(capacity.policy), rateCardRef: request.estimate.rateCardRef }) };
      }

      const policyRef = decisionReference(capacity.policy);
      const eventId = globalThis.crypto.randomUUID();
      const contentHash = await hashValue({ reservationId, idempotencyKey: request.idempotencyKey, hold: formatScaledDecimal(hold), status, currency });
      gate.checkpoint();
      await client.query(
        `INSERT INTO cost_intelligence.budget_reservation_events
          (reservation_event_id, tenant_id, project_id, environment, billing_mode, currency, reservation_id, event_sequence,
           event_type, decision_status, held_amount, consumed_amount, released_amount, estimate_completeness, known_subtotal,
           bounded_maximum, allow_partial, partial_allowed_amount, usage_finality, settlement_sequence, policy_version_id,
           rate_card_ref, policy_ref, idempotency_key, expected_revision, actor_reference, source_authority_ref,
           attempt_binding, logical_operation_id, billable_attempt_id, content_hash, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,1,$8,$9,$10::numeric,0,0,$11,$12::numeric,$13::numeric,$14,$15,'unknown',NULL,$16,
           $17::jsonb,$18::jsonb,$19,NULL,$20,$21::jsonb,$22::jsonb,$23,$24,$25,$26::timestamptz)`,
        [eventId, scope.tenantId, scope.projectId, scope.environment, scope.billingMode, currency, reservationId,
          status === 'authorized' ? 'authorized' : 'partially_authorized', status,
          formatScaledDecimal(hold), request.estimate.completeness, request.estimate.knownSubtotal,
          request.estimate.boundedConservativeMaximum === undefined ? null : formatScaledDecimal(parseScaledDecimal(request.estimate.boundedConservativeMaximum)),
          request.allowPartialAuthorization,
          partialAllowed === null ? null : formatScaledDecimal(partialAllowed), capacity.policy.id,
          request.estimate.rateCardRef === null ? null : JSON.stringify(request.estimate.rateCardRef),
          JSON.stringify(policyRef), request.idempotencyKey, scope.actorId,
          JSON.stringify({ actorId: scope.actorId, authority: 'budget.reservation.authorize', policyVersionId: capacity.policy.id }),
          JSON.stringify(request.attemptBinding), request.attemptBinding.logicalOperationId, request.attemptBinding.billableAttemptId, contentHash,
          financialExpiresAt(ports, now)],
      );
      gate.beginCommit();
      await client.query('COMMIT'); inTransaction = false;
      const availableAfter = capacity.available - hold > 0n ? capacity.available - hold : 0n;
      return {
        ok: true,
        value: buildDecision({ requestId, request, currency, now, status, reservationId, held: hold, available: availableAfter, partialAllowed, policyRef, rateCardRef: request.estimate.rateCardRef }),
      };
    } catch (error) {
      if (client && inTransaction) await rollback(client);
      // A unique-violation on the first-event billable attempt binding (or the
      // idempotency key) is a typed conflict, never a transient outage: a second
      // authorization can never reuse one billable attempt for a different hold.
      if (isUniqueViolation(error)) {
        return failure(makeError('authorize', 'IDEMPOTENCY_CONFLICT', requestId,
          `This billable attempt or idempotency key is already bound to a reservation (${uniqueViolationConstraint(error)}); retry the identical request to replay the existing hold.`));
      }
      return unavailable();
    } finally {
      client?.release();
    }
  });
}

function parseRef(value: unknown): VersionedReference | null {
  if (value === null || value === undefined) return null;
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    const { Value } = requireValue();
    return Value.Check(VersionedReferenceSchema, parsed) ? parsed as VersionedReference : null;
  } catch {
    return null;
  }
}

function unavailableDecision(requestId: string, request: ReservationRequest, currency: string, now: Date | null): AuthorizationDecision {
  return buildDecision({
    requestId, request, currency, now: now ?? new Date(0), status: 'unavailable',
    reservationId: 'none', held: 0n, available: 0n, partialAllowed: null,
    policyRef: decisionReference(null), rateCardRef: request.estimate.rateCardRef,
  });
}

function buildDecision(args: {
  requestId: string; request: ReservationRequest; currency: string; now: Date;
  status: AuthorizationDecision['status']; reservationId: string; held: bigint; available: bigint;
  partialAllowed: bigint | null; policyRef: VersionedReference; rateCardRef: VersionedReference | null;
}): AuthorizationDecision {
  const { request } = args;
  return {
    schemaVersion: '1.0.0', requestId: args.requestId, decidedAt: args.now.toISOString(), status: args.status,
    reservationId: args.reservationId, heldAmount: formatScaledDecimal(args.held), availableAmount: formatScaledDecimal(args.available),
    currency: args.currency, estimateCompleteness: request.estimate.completeness, knownSubtotal: request.estimate.knownSubtotal,
    boundedConservativeMaximum: request.estimate.boundedConservativeMaximum ?? null,
    rateCardRef: args.rateCardRef, policyRef: args.policyRef,
    expiryEligibility: args.status === 'authorized' || args.status === 'partial' ? 'eligible_if_never_dispatched' : 'not_expired',
    attemptBinding: request.attemptBinding,
    partialAuthorization: args.status === 'partial' && args.partialAllowed !== null
      ? { allowedAmount: formatScaledDecimal(args.partialAllowed), allowedWorkUnits: null, unit: null, callerAcknowledgementRequired: true, replanBeforeDispatch: true }
      : null,
    retryAfterMs: args.status === 'unavailable' ? DEFAULT_RETRY_AFTER_MS : null,
  };
}

/* -------------------------------- lifecycle commands -------------------------------- */

interface ReservationState {
  readonly exists: boolean;
  readonly currency: string;
  readonly policyVersionId: string;
  readonly held: bigint;
  readonly consumed: bigint;
  readonly released: bigint;
  readonly revision: number;
  readonly lastType: string;
  readonly usageFinality: 'unknown' | 'partial' | 'final';
  /** Durable dispatch state: true once any `dispatched` event was appended. */
  readonly everDispatched: boolean;
  /** The first event of the reservation; a partial authorization is never dispatchable without acknowledgement evidence. */
  readonly firstType: string;
  /** The attempt binding persisted with the authorization. */
  readonly originalBinding: unknown;
  /** CI-05B: financial expiry of the hold (NULL = never auto-expires). Separate from the worker lease. */
  readonly expiresAt: Date | null;
  /** CI-05B: the latest worker lease id bound at dispatch; operational, never a financial release trigger. */
  readonly workerLeaseId: string | null;
  /** CI-05B: the latest worker lease expiry; a lapse here never releases the hold. */
  readonly workerLeaseExpiresAt: Date | null;
  /** CI-05B: the most recent activity timestamp, used for bounded recovery aging. */
  readonly lastRecordedAt: Date | null;
}

function toDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(date.getTime()) ? date : null;
}

async function loadReservation(client: BudgetTransactionPort, scope: TrustedScope, reservationId: string): Promise<ReservationState | null> {
  const result = await client.query(
    `SELECT currency, policy_version_id,
            sum(held_amount)::text AS held, sum(released_amount)::text AS released, max(consumed_amount)::text AS consumed,
            max(event_sequence)::int AS revision,
            (array_agg(event_type ORDER BY event_sequence DESC))[1] AS last_type,
            (array_agg(usage_finality ORDER BY event_sequence DESC))[1] AS last_finality,
            bool_or(event_type = 'dispatched') AS ever_dispatched,
            (array_agg(event_type ORDER BY event_sequence ASC))[1] AS first_type,
            (array_agg(attempt_binding ORDER BY event_sequence ASC))[1] AS original_binding,
            max(expires_at) AS expires_at,
            (array_agg(worker_lease_id ORDER BY event_sequence DESC) FILTER (WHERE worker_lease_id IS NOT NULL))[1] AS worker_lease_id,
            (array_agg(worker_lease_expires_at ORDER BY event_sequence DESC) FILTER (WHERE worker_lease_expires_at IS NOT NULL))[1] AS worker_lease_expires_at,
            max(recorded_at) AS last_recorded_at
     FROM cost_intelligence.budget_reservation_events
     WHERE tenant_id = $1 AND project_id = $2 AND environment = $3 AND billing_mode = $4 AND reservation_id = $5
     GROUP BY currency, policy_version_id`,
    [scope.tenantId, scope.projectId, scope.environment, scope.billingMode, reservationId],
  );
  const row = result.rows[0];
  if (!row) return null;
  const finalityRaw = fromRow(row, 'last_finality');
  return {
    exists: true, currency: asString(row.currency), policyVersionId: asString(row.policy_version_id),
    held: parseScaledDecimal(fromRow(row, 'held') ?? '0'), consumed: parseScaledDecimal(fromRow(row, 'consumed') ?? '0'),
    released: parseScaledDecimal(fromRow(row, 'released') ?? '0'), revision: Number(row.revision),
    lastType: asString(row.last_type),
    usageFinality: finalityRaw === 'partial' || finalityRaw === 'final' ? finalityRaw : 'unknown',
    everDispatched: row.ever_dispatched === true,
    firstType: fromRow(row, 'first_type') ?? '',
    originalBinding: row.original_binding ?? null,
    expiresAt: toDate(row.expires_at),
    workerLeaseId: row.worker_lease_id === null || row.worker_lease_id === undefined ? null : asString(row.worker_lease_id),
    workerLeaseExpiresAt: toDate(row.worker_lease_expires_at),
    lastRecordedAt: toDate(row.last_recorded_at),
  };
}

function stateFor(lastType: string, usageFinality: 'unknown' | 'partial' | 'final'): ReservationLifecycleState {
  switch (lastType) {
    case 'authorized': case 'partially_authorized': return 'held';
    case 'dispatched': return 'dispatched';
    case 'settled': return usageFinality === 'final' ? 'settled' : 'partially_settled';
    case 'released': return 'released';
    case 'expired': return 'expired';
    default: return 'held';
  }
}

function outcomeFrom(requestId: string, status: ReservationCommandOutcome['status'], reservationId: string, state: ReservationState): ReservationCommandOutcome {
  const outstanding = state.held - state.released - state.consumed;
  return {
    schemaVersion: '1.0.0', requestId, status, reservationId,
    state: stateFor(state.lastType, state.usageFinality),
    heldAmount: formatScaledDecimal(state.held), consumedAmount: formatScaledDecimal(state.consumed),
    releasedAmount: formatScaledDecimal(state.released),
    outstandingHold: formatScaledDecimal(outstanding > 0n ? outstanding : 0n),
    overrunAmount: formatScaledDecimal(state.consumed > state.held ? state.consumed - state.held : 0n),
    currency: state.currency, revision: state.revision, usageFinality: state.usageFinality,
  };
}

type CommandKind = 'mark_dispatched' | 'settle' | 'release' | 'expire';

/** The normalized identity of a lifecycle command, compared against the stored event on replay. */
interface CommandIdentity {
  readonly eventType: 'dispatched' | 'settled' | 'released' | 'expired';
  readonly consumed: bigint | null;
  /** Null means the released amount is derived at apply time (e.g. expiry of the whole remaining hold) and is not compared on replay. */
  readonly released: bigint | null;
  readonly usageFinality: 'unknown' | 'partial' | 'final' | null;
  readonly settlementSequence: number | null;
}

async function applyCommand(args: {
  requestId: string; idempotencyKey: string; scope: TrustedScope; reservationId: string; expectedRevision: number;
  currency: string; actorReference: string; sourceAuthorityRef: VersionedReference; attemptBinding: Record<string, unknown>;
  logicalOperationId: string; billableAttemptId: string; kind: CommandKind; identity: CommandIdentity;
  ports: BudgetRuntimePorts; operation: string; authority: FinanceOperation;
  /** CI-05B: worker lease persisted at dispatch, kept strictly separate from the financial expiry. */
  workerLeaseId?: string | null; workerLeaseExpiresAt?: string | null;
  compute(state: ReservationState): { eventType: string; consumed: bigint; released: bigint; usageFinality: 'unknown' | 'partial' | 'final'; settlementSequence: number | null } | { reject: ErrorEnvelope };
}): Promise<ApiResult<ReservationCommandOutcome>> {
  const { ports, scope, requestId } = args;
  const waitMs = resolveWaitMs(ports);
  if (waitMs === null) return invalidWaitFailure(args.operation, requestId);
  const unavailable = (): ApiResult<ReservationCommandOutcome> => failure(makeError(args.operation, 'BUDGET_UNAVAILABLE', requestId,
    'Reservation lifecycle persistence is temporarily unavailable; retry the identical idempotent request.', true));

  return runBounded(waitMs, unavailable, async gate => {
    let client: BudgetTransactionPort | undefined;
    let inTransaction = false;
    try {
      const authorizationError = await authorizeScope(scope, requestId, ports, args.operation, args.authority);
      gate.checkpoint();
      if (authorizationError) return failure(authorizationError);
      if (!trustedNow(ports)) return failure(makeError(args.operation, 'BUDGET_UNAVAILABLE', requestId, 'The trusted budget clock is unavailable.', true));

      client = await ports.database.connect();
      gate.checkpoint();
      await client.query('BEGIN');
      inTransaction = true;
      await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
      await bindFinancialDatabaseScope(client, scope);
      await bindDeadline(client, gate);
      // mark_dispatched carries no currency of its own; resolve it from the
      // stored reservation so the partition lock and currency check are exact.
      let effectiveCurrency = args.currency;
      if (effectiveCurrency === '') {
        const preload = await loadReservation(client, scope, args.reservationId);
        if (!preload) {
          await rollback(client); inTransaction = false;
          return failure(makeError(args.operation, 'VALIDATION_ERROR', requestId, 'The reservation does not exist in this authorized scope.'));
        }
        effectiveCurrency = preload.currency;
      }
      if (!(await acquirePartitionLock(client, scope, effectiveCurrency, gate))) {
        await rollback(client); inTransaction = false;
        return failure(makeError(args.operation, 'BUDGET_UNAVAILABLE', requestId, 'The budget partition is busy; retry the identical idempotent request.', true));
      }

      const replay = await client.query(
        `SELECT reservation_id, event_type, event_sequence, currency, consumed_amount::text AS consumed_amount,
                released_amount::text AS released_amount, usage_finality, settlement_sequence, expected_revision, attempt_binding
         FROM cost_intelligence.budget_reservation_events
         WHERE tenant_id = $1 AND project_id = $2 AND environment = $3 AND billing_mode = $4 AND idempotency_key = $5
         ORDER BY event_sequence ASC LIMIT 1`,
        [scope.tenantId, scope.projectId, scope.environment, scope.billingMode, args.idempotencyKey],
      );
      if (replay.rows.length) {
        const row = replay.rows[0] as Record<string, unknown>;
        const identity = args.identity;
        const identical = fromRow(row, 'reservation_id') === args.reservationId
          && fromRow(row, 'event_type') === identity.eventType
          && fromRow(row, 'currency') === effectiveCurrency
          && Number(row.expected_revision) === args.expectedRevision
          && sameJson(row.attempt_binding, args.attemptBinding)
          && (identity.consumed === null || parseScaledDecimal(fromRow(row, 'consumed_amount') ?? '-1') === identity.consumed)
          && (identity.released === null || parseScaledDecimal(fromRow(row, 'released_amount') ?? '-1') === identity.released)
          && (identity.usageFinality === null || fromRow(row, 'usage_finality') === identity.usageFinality)
          && (identity.settlementSequence === null ? row.settlement_sequence === null || row.settlement_sequence === undefined
            : Number(row.settlement_sequence) === identity.settlementSequence);
        if (!identical) {
          await rollback(client); inTransaction = false;
          return failure(makeError(args.operation, 'IDEMPOTENCY_CONFLICT', requestId,
            'The idempotency key was already used for a different reservation command.'));
        }
        const existingReservation = asString(row.reservation_id);
        const state = await loadReservation(client, scope, existingReservation);
        gate.beginCommit();
        await client.query('COMMIT'); inTransaction = false;
        if (!state) return failure(makeError(args.operation, 'BUDGET_UNAVAILABLE', requestId, 'The reservation lifecycle state is unavailable.', true));
        return { ok: true, value: outcomeFrom(requestId, 'replay', existingReservation, state) };
      }

      const state = await loadReservation(client, scope, args.reservationId);
      if (!state) {
        await rollback(client); inTransaction = false;
        return failure(makeError(args.operation, 'VALIDATION_ERROR', requestId, 'The reservation does not exist in this authorized scope.'));
      }
      if (state.currency !== effectiveCurrency) {
        await rollback(client); inTransaction = false;
        return failure(makeError(args.operation, 'VALIDATION_ERROR', requestId, 'The command currency does not match the reservation currency.'));
      }
      if (args.expectedRevision !== state.revision) {
        await rollback(client); inTransaction = false;
        return { ok: true, value: outcomeFrom(requestId, 'stale_revision', args.reservationId, state) };
      }

      const computed = args.compute(state);
      if ('reject' in computed) {
        await rollback(client); inTransaction = false;
        return failure(computed.reject);
      }

      const nextSequence = state.revision + 1;
      const eventId = globalThis.crypto.randomUUID();
      const contentHash = await hashValue({ reservationId: args.reservationId, sequence: nextSequence, type: computed.eventType, idempotencyKey: args.idempotencyKey });
      gate.checkpoint();
      await client.query(
        `INSERT INTO cost_intelligence.budget_reservation_events
          (reservation_event_id, tenant_id, project_id, environment, billing_mode, currency, reservation_id, event_sequence,
           event_type, decision_status, held_amount, consumed_amount, released_amount, estimate_completeness, known_subtotal,
           bounded_maximum, allow_partial, partial_allowed_amount, usage_finality, settlement_sequence, policy_version_id,
           rate_card_ref, policy_ref, idempotency_key, expected_revision, actor_reference, source_authority_ref,
           attempt_binding, logical_operation_id, billable_attempt_id, content_hash,
           worker_lease_id, worker_lease_expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NULL,0,$10::numeric,$11::numeric,NULL,NULL,NULL,false,NULL,$12,$13,$14,
           NULL,$15::jsonb,$16,$17,$18,$19::jsonb,$20::jsonb,$21,$22,$23,$24,$25::timestamptz)`,
        [eventId, scope.tenantId, scope.projectId, scope.environment, scope.billingMode, effectiveCurrency, args.reservationId, nextSequence,
          computed.eventType, formatScaledDecimal(computed.consumed), formatScaledDecimal(computed.released), computed.usageFinality,
          computed.settlementSequence, state.policyVersionId, JSON.stringify(args.sourceAuthorityRef), args.idempotencyKey,
          args.expectedRevision, args.actorReference, JSON.stringify(args.sourceAuthorityRef), JSON.stringify(args.attemptBinding),
          args.logicalOperationId, args.billableAttemptId, contentHash,
          args.workerLeaseId ?? null, args.workerLeaseExpiresAt ?? null],
      );
      const refreshed = await loadReservation(client, scope, args.reservationId);
      gate.beginCommit();
      await client.query('COMMIT'); inTransaction = false;
      return { ok: true, value: outcomeFrom(requestId, 'applied', args.reservationId, refreshed ?? state) };
    } catch (error) {
      if (client && inTransaction) await rollback(client);
      if (isUniqueViolation(error)) {
        return failure(makeError(args.operation, 'IDEMPOTENCY_CONFLICT', requestId,
          `A concurrent reservation command already bound this idempotency or attempt key (${uniqueViolationConstraint(error)}); retry the identical request to replay or reconcile.`));
      }
      return unavailable();
    } finally {
      client?.release();
    }
  });
}

export async function markReservationDispatched(value: unknown, ports: BudgetRuntimePorts): Promise<ApiResult<ReservationCommandOutcome>> {
  const { Value } = requireValue();
  if (!Value.Check(markSchema(), value)) return failure(makeError('markDispatched', 'VALIDATION_ERROR', requestIdOf(value), 'The mark-dispatched command does not match the published schema.'));
  const request = value as MarkDispatchedCommand;
  return applyCommand({
    requestId: request.requestId, idempotencyKey: request.idempotencyKey, scope: request.scope as TrustedScope,
    reservationId: request.reservationId, expectedRevision: request.expectedRevision, currency: '',
    actorReference: request.actorReference, sourceAuthorityRef: request.sourceAuthorityRef as VersionedReference,
    attemptBinding: request.attemptBinding as unknown as Record<string, unknown>,
    logicalOperationId: request.attemptBinding.logicalOperationId, billableAttemptId: request.attemptBinding.billableAttemptId,
    kind: 'mark_dispatched', ports, operation: 'markDispatched', authority: 'budgets.markDispatched',
    // Persist the operational worker lease SEPARATELY from the financial expiry.
    // A lapse of this lease never releases the hold; only an authoritative
    // financial event (settle/release/expire) changes the budget disposition.
    workerLeaseId: request.workerLeaseId, workerLeaseExpiresAt: request.workerLeaseExpiresAt,
    identity: { eventType: 'dispatched', consumed: 0n, released: 0n, usageFinality: 'unknown', settlementSequence: null },
    compute(state) {
      if (state.lastType !== 'authorized' && state.lastType !== 'partially_authorized') {
        return { reject: makeError('markDispatched', 'VALIDATION_ERROR', request.requestId, 'Only a held reservation can be dispatched.') };
      }
      // A partial authorization needs validated caller acknowledgement/replan evidence. The
      // pinned MarkDispatched contract carries none, so dispatch stays unavailable (hold preserved).
      if (state.lastType === 'partially_authorized' || state.firstType === 'partially_authorized') {
        return { reject: makeError('markDispatched', 'BUDGET_UNAVAILABLE', request.requestId,
          'Dispatch of a partially authorized reservation is unavailable: no acknowledgement or replan evidence is defined at the approved boundary.') };
      }
      if (!sameJson(state.originalBinding, request.attemptBinding)) {
        return { reject: makeError('markDispatched', 'VALIDATION_ERROR', request.requestId, 'The attempt binding does not match the reservation\'s original attempt.') };
      }
      return { eventType: 'dispatched', consumed: 0n, released: 0n, usageFinality: 'unknown', settlementSequence: null };
    },
  });
}

function attemptMismatch(operation: string, requestId: string): { reject: ErrorEnvelope } {
  return { reject: makeError(operation, 'VALIDATION_ERROR', requestId, 'The attempt binding does not match the reservation\'s original attempt.') };
}

/**
 * Final usage is authoritative only when the usage is also complete. Reported usage that is
 * incomplete is a lower bound (partial) and unknown usage proves nothing (unknown), so neither can
 * make a hold releasable or present a zero as settled consumption.
 */
function effectiveFinality(finality: 'partial' | 'final', completeness: 'unknown' | 'incomplete' | 'complete'): 'unknown' | 'partial' | 'final' {
  if (completeness === 'complete') return finality;
  return completeness === 'incomplete' ? 'partial' : 'unknown';
}

/**
 * Record a cumulative settlement observation. The observed cumulative amount is recorded in full:
 * consumption above the hold is a variance (`overrunAmount`), never truncated to the reservation.
 *
 * Local mapping (FC001 proposal only): the canonical SettleRequest `consumed` amount and currency
 * must equal the wrapper's cumulative observation. This is NOT accepted FC003 producer
 * delta-vs-cumulative semantics; that broader question remains open under #13.
 */
export async function settleReservation(value: unknown, ports: BudgetRuntimePorts): Promise<ApiResult<ReservationCommandOutcome>> {
  const validated = validateSettleReservationCommandBoundary(value);
  if (!validated.ok) return failure(validated.error);
  const request = validated.value as SettleReservationCommand;
  const currency = request.settlement.currency;
  const cumulative = parseScaledDecimal(request.settlement.cumulativeAmount);
  const consumed = request.canonicalCommand.consumed;
  if (consumed.currency !== currency || request.canonicalCommand.currency !== currency
      || parseScaledDecimal(consumed.amount) !== cumulative) {
    return failure(makeError('settle', 'VALIDATION_ERROR', request.requestId, 'The canonical settlement amount and currency contradict the settlement.'));
  }
  const settledFinality = effectiveFinality(request.settlement.finality, request.settlement.usageCompleteness);
  return applyCommand({
    requestId: request.requestId, idempotencyKey: request.idempotencyKey, scope: request.scope as TrustedScope,
    reservationId: request.reservationId, expectedRevision: request.expectedRevision, currency,
    actorReference: request.actorReference, sourceAuthorityRef: request.sourceAuthorityRef as VersionedReference,
    attemptBinding: request.attemptBinding as unknown as Record<string, unknown>,
    logicalOperationId: request.attemptBinding.logicalOperationId, billableAttemptId: request.attemptBinding.billableAttemptId,
    kind: 'settle', ports, operation: 'settle', authority: 'budgets.settle',
    identity: { eventType: 'settled', consumed: cumulative, released: 0n, usageFinality: settledFinality, settlementSequence: request.settlement.sequence },
    compute(state) {
      if (!sameJson(state.originalBinding, request.attemptBinding)) return attemptMismatch('settle', request.requestId);
      if (state.lastType === 'released' || state.lastType === 'expired') {
        return { reject: makeError('settle', 'VALIDATION_ERROR', request.requestId, 'A released or expired reservation cannot be settled.') };
      }
      if (cumulative < state.consumed) {
        return { reject: makeError('settle', 'VALIDATION_ERROR', request.requestId, 'Cumulative settlement cannot decrease a previously recorded consumption.') };
      }
      // Record the cumulative consumption; never double-count a settled portion.
      return {
        eventType: 'settled', consumed: cumulative, released: 0n,
        usageFinality: settledFinality, settlementSequence: request.settlement.sequence,
      };
    },
  });
}

export async function releaseReservation(value: unknown, ports: BudgetRuntimePorts): Promise<ApiResult<ReservationCommandOutcome>> {
  const validated = validateReleaseReservationCommandBoundary(value);
  if (!validated.ok) return failure(validated.error);
  const request = validated.value as ReleaseReservationCommand;
  const currency = request.release.currency;
  const releaseAmount = parseScaledDecimal(request.release.amount);
  // The pinned ReleaseRequest carries an economic currency but no amount; that currency must agree with the wrapper.
  if (request.canonicalCommand.currency !== currency) {
    return failure(makeError('release', 'VALIDATION_ERROR', request.requestId, 'The canonical release currency contradicts the release.'));
  }
  return applyCommand({
    requestId: request.requestId, idempotencyKey: request.idempotencyKey, scope: request.scope as TrustedScope,
    reservationId: request.reservationId, expectedRevision: request.expectedRevision, currency,
    actorReference: request.actorReference, sourceAuthorityRef: request.sourceAuthorityRef as VersionedReference,
    attemptBinding: request.attemptBinding as unknown as Record<string, unknown>,
    logicalOperationId: request.attemptBinding.logicalOperationId, billableAttemptId: request.attemptBinding.billableAttemptId,
    kind: 'release', ports, operation: 'release', authority: 'budgets.release',
    identity: { eventType: 'released', consumed: 0n, released: releaseAmount, usageFinality: null, settlementSequence: null },
    compute(state) {
      if (!sameJson(state.originalBinding, request.attemptBinding)) return attemptMismatch('release', request.requestId);
      const remaining = state.held - state.released - state.consumed;
      const floorRemaining = remaining > 0n ? remaining : 0n;
      if (state.lastType === 'released' || state.lastType === 'expired') {
        return { reject: makeError('release', 'VALIDATION_ERROR', request.requestId, 'A released or expired reservation has no outstanding hold to release.') };
      }
      if (releaseAmount > floorRemaining) {
        return { reject: makeError('release', 'VALIDATION_ERROR', request.requestId, 'The release amount exceeds the outstanding hold.') };
      }
      // Capacity is released only on authoritative durable evidence; caller-supplied
      // refs are not evidence. Otherwise the hold is preserved and the failure is typed.
      const preserved = (message: string) => ({ reject: makeError('release', 'BUDGET_UNAVAILABLE', request.requestId, `${message} The hold is preserved.`) });
      if (request.release.proof === 'never_dispatched_fenced') {
        const held = state.lastType === 'authorized' || state.lastType === 'partially_authorized';
        if (state.everDispatched || !held) {
          return preserved('Never-dispatched release is refused: the durable state shows dispatch or an unresolved lifecycle.');
        }
        // Releasing the entire hold moves the reservation to `released`, which fences any later dispatch.
        if (releaseAmount !== floorRemaining) {
          return preserved('Never-dispatched release must release the whole hold so that a late worker is fenced.');
        }
      } else if (state.lastType !== 'settled' || state.usageFinality !== 'final') {
        return preserved('Final-usage release is refused: the reservation has no final settlement.');
      }
      return { eventType: 'released', consumed: 0n, released: releaseAmount, usageFinality: state.usageFinality, settlementSequence: null };
    },
  });
}

/* ------------------------------------------------------------------ *
 * CI-05B settlement, expiry, recovery and reconciliation.
 * ------------------------------------------------------------------ */

const LifecycleScopeSchema = Type.Object({
  tenantId: Type.String({ minLength: 1, maxLength: 128 }), projectId: Type.String({ minLength: 1, maxLength: 128 }),
  environment: Type.Union([Type.Literal('development'), Type.Literal('test'), Type.Literal('production')]),
  billingMode: Type.Union([Type.Literal('live'), Type.Literal('sandbox'), Type.Literal('simulated')]),
  actorId: Type.String({ minLength: 1, maxLength: 128 }),
}, { additionalProperties: false });

const LifecycleAttemptBindingSchema = Type.Object({
  logicalOperationId: Type.String({ minLength: 1 }), transportAttemptId: Type.String({ minLength: 1 }),
  providerRequestId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]), providerAttemptId: Type.String({ minLength: 1 }),
  billableAttemptId: Type.String({ minLength: 1 }),
}, { additionalProperties: false });

/** The current lifecycle state exposed to consumers for revalidation (CI-05B consumer gap 1). */
export type ReservationViewState =
  'held' | 'dispatched' | 'outcome_unknown' | 'partially_settled' | 'settled' | 'released' | 'expired' | 'absent';

export interface ReservationStateView {
  readonly schemaVersion: '1.0.0';
  readonly requestId: string;
  readonly reservationId: string;
  readonly exists: boolean;
  /** The CURRENT state projected from the whole event log, never the first (authorization) event. */
  readonly state: ReservationViewState;
  readonly currency: string | null;
  readonly heldAmount: string;
  readonly consumedAmount: string;
  readonly releasedAmount: string;
  readonly outstandingHold: string;
  readonly overrunAmount: string;
  readonly usageFinality: 'unknown' | 'partial' | 'final';
  readonly revision: number;
  readonly everDispatched: boolean;
  readonly financialExpiresAt: string | null;
  readonly financialExpiryMatured: boolean;
  readonly workerLeaseId: string | null;
  readonly workerLeaseExpiresAt: string | null;
  /** True once the operational worker lease has lapsed; this NEVER releases the hold on its own. */
  readonly workerLeaseExpired: boolean;
}

/** The current snapshot state, deriving `outcome_unknown` for a dispatched hold whose worker lease has lapsed. */
function currentViewState(state: ReservationState, now: Date | null): ReservationViewState {
  const base = stateFor(state.lastType, state.usageFinality);
  if (base === 'dispatched' && now && state.workerLeaseExpiresAt && now.getTime() >= state.workerLeaseExpiresAt.getTime()) {
    return 'outcome_unknown';
  }
  return base;
}

/**
 * CI-05B consumer gap 1: a scoped, read-only current-state read for ONE
 * reservation. Unlike the authorization idempotency replay (which reports the
 * ORIGINAL first-event decision), this projects the whole event log, so a
 * settled or released reservation reads `settled`/`released`, never `held`.
 */
export async function readReservationState(
  scope: TrustedScope,
  reservationId: string,
  requestId: string,
  ports: BudgetRuntimePorts,
): Promise<ApiResult<ReservationStateView>> {
  const waitMs = resolveWaitMs(ports);
  if (waitMs === null) return invalidWaitFailure('readReservationState', requestId);
  const unavailable = (): ApiResult<ReservationStateView> => failure(makeError('readReservationState', 'BUDGET_UNAVAILABLE', requestId,
    'The reservation state read is temporarily unavailable; retry.', true));

  return runBounded(waitMs, unavailable, async gate => {
    let client: BudgetTransactionPort | undefined;
    let inTransaction = false;
    try {
      const authorizationError = await authorizeScope(scope, requestId, ports, 'readReservationState', 'budgets.authorize');
      gate.checkpoint();
      if (authorizationError) return failure(authorizationError);
      const now = trustedNow(ports);
      client = await ports.database.connect();
      gate.checkpoint();
      await client.query('BEGIN');
      inTransaction = true;
      await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
      await bindFinancialDatabaseScope(client, scope);
      await bindDeadline(client, gate);
      const state = await loadReservation(client, scope, reservationId);
      gate.beginCommit();
      await client.query('COMMIT'); inTransaction = false;
      if (!state) {
        return {
          ok: true,
          value: {
            schemaVersion: '1.0.0', requestId, reservationId, exists: false, state: 'absent', currency: null,
            heldAmount: '0', consumedAmount: '0', releasedAmount: '0', outstandingHold: '0', overrunAmount: '0',
            usageFinality: 'unknown', revision: 0, everDispatched: false, financialExpiresAt: null, financialExpiryMatured: false,
            workerLeaseId: null, workerLeaseExpiresAt: null, workerLeaseExpired: false,
          },
        };
      }
      const outstanding = state.held - state.released - state.consumed;
      const leaseExpired = Boolean(now && state.workerLeaseExpiresAt && now.getTime() >= state.workerLeaseExpiresAt.getTime());
      const financialMatured = Boolean(now && state.expiresAt && now.getTime() >= state.expiresAt.getTime());
      return {
        ok: true,
        value: {
          schemaVersion: '1.0.0', requestId, reservationId, exists: true, state: currentViewState(state, now),
          currency: state.currency, heldAmount: formatScaledDecimal(state.held), consumedAmount: formatScaledDecimal(state.consumed),
          releasedAmount: formatScaledDecimal(state.released),
          outstandingHold: formatScaledDecimal(outstanding > 0n ? outstanding : 0n),
          overrunAmount: formatScaledDecimal(state.consumed > state.held ? state.consumed - state.held : 0n),
          usageFinality: state.usageFinality, revision: state.revision, everDispatched: state.everDispatched,
          financialExpiresAt: state.expiresAt ? state.expiresAt.toISOString() : null, financialExpiryMatured: financialMatured,
          workerLeaseId: state.workerLeaseId, workerLeaseExpiresAt: state.workerLeaseExpiresAt ? state.workerLeaseExpiresAt.toISOString() : null,
          workerLeaseExpired: leaseExpired,
        },
      };
    } catch {
      if (client && inTransaction) await rollback(client);
      return unavailable();
    } finally {
      client?.release();
    }
  });
}

export const ExpireReservationCommandSchema = Type.Object({
  schemaVersion: Type.Literal('1.0.0'), requestId: Type.String({ minLength: 1, maxLength: 128 }),
  idempotencyKey: Type.String({ minLength: 1, maxLength: 200 }), scope: LifecycleScopeSchema,
  reservationId: Type.String({ minLength: 1 }), expectedRevision: Type.Integer({ minimum: 0 }),
  currency: Type.String({ pattern: '^[A-Z]{3}$' }),
  actorReference: Type.String({ minLength: 1, maxLength: 200 }), sourceAuthorityRef: VersionedReferenceSchema,
  attemptBinding: LifecycleAttemptBindingSchema,
  // `financial_expiry` releases only a never-dispatched hold whose financial expiry has matured;
  // `operator_revocation` cancels a never-dispatched hold under explicit authority. Neither can
  // ever touch a dispatched/unknown hold.
  reason: Type.Union([Type.Literal('financial_expiry'), Type.Literal('operator_revocation')]),
  evidenceRefs: Type.Array(VersionedReferenceSchema, { minItems: 1, maxItems: 100 }),
}, { additionalProperties: false });
export type ExpireReservationCommand = Static<typeof ExpireReservationCommandSchema>;

/**
 * CI-05B.3 / consumer gap 2: expire (or operator-revoke) a hold. This is the
 * only authoritative path that frees a never-dispatched hold, and it requires
 * no-dispatch fencing: the durable state must still be `held` with no dispatch
 * ever recorded, and the whole remaining hold is released so a late worker is
 * fenced out. A dispatched or outcome-unknown hold is NEVER expired; a lapsed
 * worker lease never reaches here. The financial expiry (`expires_at`) is honored
 * independently of any worker lease TTL.
 */
export async function expireReservation(value: unknown, ports: BudgetRuntimePorts): Promise<ApiResult<ReservationCommandOutcome>> {
  const { Value } = requireValue();
  if (!Value.Check(ExpireReservationCommandSchema, value)) {
    return failure(makeError('expire', 'VALIDATION_ERROR', requestIdOf(value), 'The expire command does not match the published schema.'));
  }
  const request = value as ExpireReservationCommand;
  const now = trustedNow(ports);
  return applyCommand({
    requestId: request.requestId, idempotencyKey: request.idempotencyKey, scope: request.scope as unknown as TrustedScope,
    reservationId: request.reservationId, expectedRevision: request.expectedRevision, currency: request.currency,
    actorReference: request.actorReference, sourceAuthorityRef: request.sourceAuthorityRef as VersionedReference,
    attemptBinding: request.attemptBinding as unknown as Record<string, unknown>,
    logicalOperationId: request.attemptBinding.logicalOperationId, billableAttemptId: request.attemptBinding.billableAttemptId,
    kind: 'expire', ports, operation: 'expire', authority: 'budgets.release',
    identity: { eventType: 'expired', consumed: 0n, released: null, usageFinality: null, settlementSequence: null },
    compute(state) {
      if (!sameJson(state.originalBinding, request.attemptBinding)) return attemptMismatch('expire', request.requestId);
      const remaining = state.held - state.released - state.consumed;
      const floorRemaining = remaining > 0n ? remaining : 0n;
      const preserved = (message: string) => ({ reject: makeError('expire', 'BUDGET_UNAVAILABLE', request.requestId, `${message} The hold is preserved.`) });
      if (state.lastType === 'released' || state.lastType === 'expired') {
        return { reject: makeError('expire', 'VALIDATION_ERROR', request.requestId, 'A released or expired reservation has no outstanding hold to expire.') };
      }
      const held = state.lastType === 'authorized' || state.lastType === 'partially_authorized';
      // No-dispatch fencing: only a never-dispatched, still-held reservation may expire.
      if (state.everDispatched || !held) {
        return preserved('Expiry is refused: the durable state shows dispatch or an unresolved outcome; an in-flight or unknown hold is never expired.');
      }
      if (request.reason === 'financial_expiry') {
        if (!state.expiresAt) return { reject: makeError('expire', 'VALIDATION_ERROR', request.requestId, 'No financial expiry is configured for this hold; financial_expiry is not applicable.') };
        if (!now || now.getTime() < state.expiresAt.getTime()) return preserved('The financial expiry has not matured.');
      }
      return { eventType: 'expired', consumed: 0n, released: floorRemaining, usageFinality: state.usageFinality, settlementSequence: null };
    },
  });
}

/* -------------------------------- recovery scan + reconciliation queue -------------------------------- */

export const RecoveryScanRequestSchema = Type.Object({
  schemaVersion: Type.Literal('1.0.0'), requestId: Type.String({ minLength: 1, maxLength: 128 }), scope: LifecycleScopeSchema,
  agingThresholdMs: Type.Integer({ minimum: 0, maximum: 2_147_483_647 }),
  maxReservations: Type.Integer({ minimum: 1, maximum: 10_000 }),
  ownerRole: Type.String({ minLength: 1, maxLength: 120 }), actorReference: Type.String({ minLength: 1, maxLength: 200 }),
}, { additionalProperties: false });
export type RecoveryScanRequest = Static<typeof RecoveryScanRequestSchema>;

export interface RecoveryScanEntry {
  readonly reservationId: string;
  readonly currency: string;
  readonly state: ReservationViewState;
  readonly category: string;
  readonly severity: 'review' | 'variance' | 'blocking';
  readonly disposition: 'opened' | 'already_open';
  readonly outstandingHold: string;
}

export interface RecoveryScanResult {
  readonly schemaVersion: '1.0.0';
  readonly requestId: string;
  readonly scanId: string;
  readonly scannedReservations: number;
  readonly opened: number;
  readonly alreadyOpen: number;
  readonly bounded: boolean;
  readonly entries: readonly RecoveryScanEntry[];
}

interface RecoveryCandidate {
  reservationId: string; currency: string; held: bigint; released: bigint; consumed: bigint;
  lastType: string; lastFinality: 'unknown' | 'partial' | 'final'; everDispatched: boolean;
  lastRecordedAt: Date | null; expiresAt: Date | null; workerLeaseExpiresAt: Date | null; ageMs: number;
}

/**
 * CI-05B.4: a bounded, durable, rerunnable recovery scan. It ages unresolved
 * holds (in-flight/unknown, and never-dispatched holds whose financial expiry
 * has matured) into the append-only reconciliation queue with owner, next
 * action and evidence. It NEVER releases a hold: a worker crash, cancellation,
 * lease lapse, timeout or missing usage only produces a reconciliation record.
 * Rerunning is a no-op for a reservation that already has an open exception.
 */
export async function runRecoveryScan(value: unknown, ports: BudgetRuntimePorts): Promise<ApiResult<RecoveryScanResult>> {
  const { Value } = requireValue();
  if (!Value.Check(RecoveryScanRequestSchema, value)) {
    return failure(makeError('recoveryScan', 'VALIDATION_ERROR', requestIdOf(value), 'The recovery scan request does not match the published schema.'));
  }
  const request = value as RecoveryScanRequest;
  const scope = request.scope as unknown as TrustedScope;
  const requestId = request.requestId;
  const waitMs = resolveWaitMs(ports);
  if (waitMs === null) return invalidWaitFailure('recoveryScan', requestId);
  const unavailable = (): ApiResult<RecoveryScanResult> => failure(makeError('recoveryScan', 'BUDGET_UNAVAILABLE', requestId,
    'The recovery scan is temporarily unavailable; rerun the identical bounded scan.', true));

  return runBounded(waitMs, unavailable, async gate => {
    let client: BudgetTransactionPort | undefined;
    let inTransaction = false;
    try {
      const authorizationError = await authorizeScope(scope, requestId, ports, 'recoveryScan', 'budgets.release');
      gate.checkpoint();
      if (authorizationError) return failure(authorizationError);
      const now = trustedNow(ports);
      if (!now) return failure(makeError('recoveryScan', 'BUDGET_UNAVAILABLE', requestId, 'The trusted budget clock is unavailable.', true));
      client = await ports.database.connect();
      gate.checkpoint();
      await client.query('BEGIN');
      inTransaction = true;
      await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
      await bindFinancialDatabaseScope(client, scope);
      await bindDeadline(client, gate);

      const candidates = await client.query(
        `WITH per_reservation AS (
           SELECT reservation_id, currency,
                  sum(held_amount)::text AS held, sum(released_amount)::text AS released, max(consumed_amount)::text AS consumed,
                  (array_agg(event_type ORDER BY event_sequence DESC))[1] AS last_type,
                  (array_agg(usage_finality ORDER BY event_sequence DESC))[1] AS last_finality,
                  bool_or(event_type = 'dispatched') AS ever_dispatched,
                  max(recorded_at) AS last_recorded_at,
                  max(expires_at) AS expires_at,
                  (array_agg(worker_lease_expires_at ORDER BY event_sequence DESC) FILTER (WHERE worker_lease_expires_at IS NOT NULL))[1] AS worker_lease_expires_at
           FROM cost_intelligence.budget_reservation_events
           WHERE tenant_id = $1 AND project_id = $2 AND environment = $3 AND billing_mode = $4
           GROUP BY reservation_id, currency
         )
         SELECT *, (extract(epoch FROM (now() - last_recorded_at)) * 1000)::bigint AS age_ms FROM per_reservation
         WHERE last_type = 'dispatched'
            OR (last_type IN ('authorized', 'partially_authorized') AND expires_at IS NOT NULL AND expires_at <= $5)
         ORDER BY last_recorded_at ASC NULLS FIRST
         LIMIT $6`,
        [scope.tenantId, scope.projectId, scope.environment, scope.billingMode, now.toISOString(), request.maxReservations + 1],
      );
      const rows = candidates.rows as Record<string, unknown>[];
      const bounded = rows.length > request.maxReservations;
      const considered = rows.slice(0, request.maxReservations).map((row): RecoveryCandidate => ({
        reservationId: asString(row.reservation_id), currency: asString(row.currency),
        held: parseScaledDecimal(fromRow(row, 'held') ?? '0'), released: parseScaledDecimal(fromRow(row, 'released') ?? '0'),
        consumed: parseScaledDecimal(fromRow(row, 'consumed') ?? '0'), lastType: asString(row.last_type),
        lastFinality: ((): 'unknown' | 'partial' | 'final' => { const f = fromRow(row, 'last_finality'); return f === 'partial' || f === 'final' ? f : 'unknown'; })(),
        everDispatched: row.ever_dispatched === true, lastRecordedAt: toDate(row.last_recorded_at),
        expiresAt: toDate(row.expires_at), workerLeaseExpiresAt: toDate(row.worker_lease_expires_at),
        ageMs: Number(fromRow(row, 'age_ms') ?? '0'),
      }));

      const scanId = globalThis.crypto.randomUUID();
      const entries: RecoveryScanEntry[] = [];
      let opened = 0; let alreadyOpen = 0;
      for (const candidate of considered) {
        // Aging is measured against the database clock (the same clock that
        // stamps recorded_at), so a hold must have been unresolved for at least
        // the threshold before recovery acts on it.
        const aged = candidate.ageMs >= request.agingThresholdMs;
        if (!aged) continue;
        const outstanding = candidate.held - candidate.released - candidate.consumed;
        const floorOutstanding = outstanding > 0n ? outstanding : 0n;
        const leaseLapsed = candidate.workerLeaseExpiresAt !== null && now.getTime() >= candidate.workerLeaseExpiresAt.getTime();
        const financiallyExpired = candidate.lastType !== 'dispatched';
        const state: ReservationViewState = financiallyExpired ? 'held' : (leaseLapsed ? 'outcome_unknown' : 'dispatched');
        const category = financiallyExpired ? 'never_dispatched_financial_expiry'
          : leaseLapsed ? 'outcome_unknown_in_flight' : 'dispatched_unresolved';
        const severity: 'review' | 'variance' | 'blocking' = leaseLapsed ? 'blocking' : 'review';
        const nextAction = financiallyExpired
          ? 'Fence no-dispatch and expire the never-dispatched hold, or re-authorize; never release without fencing.'
          : 'Obtain the provider outcome; settle the confirmed expense or release only on verified no-bill. Do not release an unknown hold.';
        const evidence = {
          scanId, observedAt: now.toISOString(), lastActivityAt: candidate.lastRecordedAt ? candidate.lastRecordedAt.toISOString() : null,
          lastEventType: candidate.lastType, everDispatched: candidate.everDispatched,
          financialExpiresAt: candidate.expiresAt ? candidate.expiresAt.toISOString() : null,
          workerLeaseExpiresAt: candidate.workerLeaseExpiresAt ? candidate.workerLeaseExpiresAt.toISOString() : null,
          workerLeaseLapsed: leaseLapsed, outstandingHold: formatScaledDecimal(floorOutstanding),
        };
        const exceptionId = globalThis.crypto.randomUUID();
        const contentHash = await hashValue({ reservationId: candidate.reservationId, category, scanId });
        gate.checkpoint();
        const inserted = await client.query(
          `INSERT INTO cost_intelligence.budget_reconciliation_exceptions
            (exception_id, tenant_id, project_id, environment, billing_mode, currency, reservation_id, status, category,
             severity, owner_role, next_action, evidence, hold_amount, consumed_amount, outstanding_amount, reservation_state,
             scan_id, actor_reference, content_hash)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'open',$8,$9,$10,$11,$12::jsonb,$13::numeric,$14::numeric,$15::numeric,$16,$17,$18,$19)
           ON CONFLICT (tenant_id, project_id, environment, billing_mode, reservation_id) WHERE status = 'open' DO NOTHING
           RETURNING exception_id`,
          [exceptionId, scope.tenantId, scope.projectId, scope.environment, scope.billingMode, candidate.currency,
            candidate.reservationId, category, severity, request.ownerRole, nextAction, JSON.stringify(evidence),
            formatScaledDecimal(candidate.held), formatScaledDecimal(candidate.consumed), formatScaledDecimal(floorOutstanding),
            state, scanId, request.actorReference, contentHash],
        );
        const wasOpened = (inserted.rowCount ?? 0) > 0;
        if (wasOpened) opened += 1; else alreadyOpen += 1;
        entries.push({ reservationId: candidate.reservationId, currency: candidate.currency, state, category, severity, disposition: wasOpened ? 'opened' : 'already_open', outstandingHold: formatScaledDecimal(floorOutstanding) });
      }
      gate.beginCommit();
      await client.query('COMMIT'); inTransaction = false;
      return {
        ok: true,
        value: { schemaVersion: '1.0.0', requestId, scanId, scannedReservations: considered.length, opened, alreadyOpen, bounded, entries },
      };
    } catch {
      if (client && inTransaction) await rollback(client);
      return unavailable();
    } finally {
      client?.release();
    }
  });
}

export interface ReconciliationExceptionRecord {
  readonly exceptionId: string;
  readonly reservationId: string;
  readonly currency: string;
  readonly status: 'open' | 'resolved';
  readonly category: string;
  readonly severity: string;
  readonly ownerRole: string;
  readonly nextAction: string;
  readonly reservationState: string;
  readonly outstandingHold: string;
  readonly evidence: unknown;
  readonly recordedAt: string;
}

/** CI-05B.4: the open reconciliation/exception queue — the latest disposition per reservation that is still open. */
export async function listReconciliationExceptions(
  scope: TrustedScope,
  requestId: string,
  ports: BudgetRuntimePorts,
): Promise<ApiResult<{ readonly schemaVersion: '1.0.0'; readonly requestId: string; readonly exceptions: readonly ReconciliationExceptionRecord[] }>> {
  const waitMs = resolveWaitMs(ports);
  if (waitMs === null) return invalidWaitFailure('listReconciliation', requestId);
  const unavailable = () => failure(makeError('listReconciliation', 'BUDGET_UNAVAILABLE', requestId, 'The reconciliation queue read is temporarily unavailable.', true));

  return runBounded(waitMs, unavailable, async gate => {
    let client: BudgetTransactionPort | undefined;
    let inTransaction = false;
    try {
      const authorizationError = await authorizeScope(scope, requestId, ports, 'listReconciliation', 'budgets.authorize');
      gate.checkpoint();
      if (authorizationError) return failure(authorizationError);
      client = await ports.database.connect();
      gate.checkpoint();
      await client.query('BEGIN');
      inTransaction = true;
      await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
      await bindFinancialDatabaseScope(client, scope);
      await bindDeadline(client, gate);
      const result = await client.query(
        `SELECT DISTINCT ON (reservation_id)
                exception_id, reservation_id, currency, status, category, severity, owner_role, next_action,
                reservation_state, outstanding_amount::text AS outstanding_amount, evidence, recorded_at
         FROM cost_intelligence.budget_reconciliation_exceptions
         WHERE tenant_id = $1 AND project_id = $2 AND environment = $3 AND billing_mode = $4
         ORDER BY reservation_id, recorded_at DESC, exception_id DESC`,
        [scope.tenantId, scope.projectId, scope.environment, scope.billingMode],
      );
      gate.beginCommit();
      await client.query('COMMIT'); inTransaction = false;
      const exceptions = (result.rows as Record<string, unknown>[])
        .filter(row => fromRow(row, 'status') === 'open')
        .map((row): ReconciliationExceptionRecord => ({
          exceptionId: asString(row.exception_id), reservationId: asString(row.reservation_id), currency: asString(row.currency),
          status: 'open', category: asString(row.category), severity: asString(row.severity), ownerRole: asString(row.owner_role),
          nextAction: asString(row.next_action), reservationState: asString(row.reservation_state),
          outstandingHold: formatScaledDecimal(parseScaledDecimal(fromRow(row, 'outstanding_amount') ?? '0')),
          evidence: typeof row.evidence === 'string' ? JSON.parse(row.evidence) : row.evidence,
          recordedAt: toDate(row.recorded_at)?.toISOString() ?? '',
        }));
      return { ok: true, value: { schemaVersion: '1.0.0', requestId, exceptions } };
    } catch {
      if (client && inTransaction) await rollback(client);
      return unavailable();
    } finally {
      client?.release();
    }
  });
}

export const ResolveReconciliationRequestSchema = Type.Object({
  schemaVersion: Type.Literal('1.0.0'), requestId: Type.String({ minLength: 1, maxLength: 128 }),
  idempotencyKey: Type.String({ minLength: 1, maxLength: 200 }), scope: LifecycleScopeSchema,
  reservationId: Type.String({ minLength: 1 }),
  disposition: Type.Union([
    Type.Literal('verified_no_bill_released'), Type.Literal('confirmed_expense_settled'),
    Type.Literal('over_cap_variance_recorded'), Type.Literal('held_for_reconciliation'),
  ]),
  resolution: Type.String({ minLength: 1, maxLength: 480 }), ownerRole: Type.String({ minLength: 1, maxLength: 120 }),
  nextAction: Type.String({ minLength: 1, maxLength: 240 }), actorReference: Type.String({ minLength: 1, maxLength: 200 }),
  evidenceRefs: Type.Array(VersionedReferenceSchema, { minItems: 1, maxItems: 100 }),
}, { additionalProperties: false });
export type ResolveReconciliationRequest = Static<typeof ResolveReconciliationRequestSchema>;

export interface ReconciliationResolutionReceipt {
  readonly schemaVersion: '1.0.0';
  readonly requestId: string;
  readonly status: 'resolved' | 'replay' | 'not_open';
  readonly reservationId: string;
  readonly disposition: ResolveReconciliationRequest['disposition'];
  readonly reservationState: string;
  readonly outstandingHold: string;
}

/**
 * CI-05B.4: record a reconciliation resolution (append-only) against an open
 * exception. The resolution links the owner's disposition and evidence; the
 * actual financial change (settle/release/expire) is performed through the
 * lifecycle commands, and the current hold+spend snapshot is captured here so
 * the queue reflects verified no-bill releases, confirmed expenses, and
 * recorded over-cap variances without ever truncating real spend.
 */
export async function resolveReconciliationException(value: unknown, ports: BudgetRuntimePorts): Promise<ApiResult<ReconciliationResolutionReceipt>> {
  const { Value } = requireValue();
  if (!Value.Check(ResolveReconciliationRequestSchema, value)) {
    return failure(makeError('resolveReconciliation', 'VALIDATION_ERROR', requestIdOf(value), 'The reconciliation resolution does not match the published schema.'));
  }
  const request = value as ResolveReconciliationRequest;
  const scope = request.scope as unknown as TrustedScope;
  const requestId = request.requestId;
  const waitMs = resolveWaitMs(ports);
  if (waitMs === null) return invalidWaitFailure('resolveReconciliation', requestId);
  const unavailable = (): ApiResult<ReconciliationResolutionReceipt> => failure(makeError('resolveReconciliation', 'BUDGET_UNAVAILABLE', requestId,
    'The reconciliation resolution is temporarily unavailable; retry the identical idempotent request.', true));

  return runBounded(waitMs, unavailable, async gate => {
    let client: BudgetTransactionPort | undefined;
    let inTransaction = false;
    try {
      const authorizationError = await authorizeScope(scope, requestId, ports, 'resolveReconciliation', 'budgets.release');
      gate.checkpoint();
      if (authorizationError) return failure(authorizationError);
      const now = trustedNow(ports);
      if (!now) return failure(makeError('resolveReconciliation', 'BUDGET_UNAVAILABLE', requestId, 'The trusted budget clock is unavailable.', true));
      client = await ports.database.connect();
      gate.checkpoint();
      await client.query('BEGIN');
      inTransaction = true;
      await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
      await bindFinancialDatabaseScope(client, scope);
      await bindDeadline(client, gate);
      if (!(await acquirePartitionLock(client, scope, '*', gate))) {
        await rollback(client); inTransaction = false;
        return failure(makeError('resolveReconciliation', 'BUDGET_UNAVAILABLE', requestId, 'The reconciliation partition is busy; retry.', true));
      }

      // Idempotent replay: the same key must re-describe the same resolution.
      const replay = await client.query(
        `SELECT reservation_id, resolution_disposition FROM cost_intelligence.budget_reconciliation_exceptions
         WHERE tenant_id = $1 AND project_id = $2 AND environment = $3 AND billing_mode = $4 AND status = 'resolved'
           AND evidence ->> 'idempotencyKey' = $5
         ORDER BY recorded_at DESC LIMIT 1`,
        [scope.tenantId, scope.projectId, scope.environment, scope.billingMode, request.idempotencyKey],
      );
      const state = await loadReservation(client, scope, request.reservationId);
      const outstanding = state ? state.held - state.released - state.consumed : 0n;
      const floorOutstanding = outstanding > 0n ? outstanding : 0n;
      const reservationState = state ? currentViewState(state, now) : 'absent';
      if (replay.rows.length) {
        const row = replay.rows[0] as Record<string, unknown>;
        if (fromRow(row, 'reservation_id') !== request.reservationId || fromRow(row, 'resolution_disposition') !== request.disposition) {
          await rollback(client); inTransaction = false;
          return failure(makeError('resolveReconciliation', 'IDEMPOTENCY_CONFLICT', requestId, 'The idempotency key was already used for a different reconciliation resolution.'));
        }
        gate.beginCommit();
        await client.query('COMMIT'); inTransaction = false;
        return { ok: true, value: { schemaVersion: '1.0.0', requestId, status: 'replay', reservationId: request.reservationId, disposition: request.disposition, reservationState, outstandingHold: formatScaledDecimal(floorOutstanding) } };
      }

      const open = await client.query(
        `SELECT DISTINCT ON (reservation_id) status
         FROM cost_intelligence.budget_reconciliation_exceptions
         WHERE tenant_id = $1 AND project_id = $2 AND environment = $3 AND billing_mode = $4 AND reservation_id = $5
         ORDER BY reservation_id, recorded_at DESC, exception_id DESC`,
        [scope.tenantId, scope.projectId, scope.environment, scope.billingMode, request.reservationId],
      );
      const latest = open.rows[0] as Record<string, unknown> | undefined;
      if (!latest || fromRow(latest, 'status') !== 'open') {
        await rollback(client); inTransaction = false;
        return { ok: true, value: { schemaVersion: '1.0.0', requestId, status: 'not_open', reservationId: request.reservationId, disposition: request.disposition, reservationState, outstandingHold: formatScaledDecimal(floorOutstanding) } };
      }

      const exceptionId = globalThis.crypto.randomUUID();
      const evidence = { idempotencyKey: request.idempotencyKey, resolvedAt: now.toISOString(), evidenceRefs: request.evidenceRefs, disposition: request.disposition };
      const contentHash = await hashValue({ reservationId: request.reservationId, disposition: request.disposition, idempotencyKey: request.idempotencyKey });
      gate.checkpoint();
      await client.query(
        `INSERT INTO cost_intelligence.budget_reconciliation_exceptions
          (exception_id, tenant_id, project_id, environment, billing_mode, currency, reservation_id, status, category,
           severity, owner_role, next_action, evidence, hold_amount, consumed_amount, outstanding_amount, reservation_state,
           resolution, resolution_disposition, actor_reference, content_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'resolved',$8,$9,$10,$11,$12::jsonb,$13::numeric,$14::numeric,$15::numeric,$16,$17,$18,$19,$20)`,
        [exceptionId, scope.tenantId, scope.projectId, scope.environment, scope.billingMode, state ? state.currency : 'USD',
          request.reservationId, `resolution:${request.disposition}`, request.disposition === 'held_for_reconciliation' ? 'review' : 'variance',
          request.ownerRole, request.nextAction, JSON.stringify(evidence),
          state ? formatScaledDecimal(state.held) : '0', state ? formatScaledDecimal(state.consumed) : '0',
          formatScaledDecimal(floorOutstanding), reservationState, request.resolution, request.disposition, request.actorReference, contentHash],
      );
      gate.beginCommit();
      await client.query('COMMIT'); inTransaction = false;
      return { ok: true, value: { schemaVersion: '1.0.0', requestId, status: 'resolved', reservationId: request.reservationId, disposition: request.disposition, reservationState, outstandingHold: formatScaledDecimal(floorOutstanding) } };
    } catch (error) {
      if (client && inTransaction) await rollback(client);
      if (isUniqueViolation(error)) {
        return failure(makeError('resolveReconciliation', 'IDEMPOTENCY_CONFLICT', requestId,
          `A concurrent reconciliation resolution already recorded this disposition (${uniqueViolationConstraint(error)}).`));
      }
      return unavailable();
    } finally {
      client?.release();
    }
  });
}

/** Advisory capacity read. It never authorizes dispatch or creates a reservation. */
export async function readCapacity(
  scope: TrustedScope,
  currency: string,
  requestId: string,
  ports: BudgetRuntimePorts,
): Promise<ApiResult<CapacitySnapshot>> {
  const waitMs = resolveWaitMs(ports);
  if (waitMs === null) return invalidWaitFailure('authorize', requestId);
  const unavailable = (): ApiResult<CapacitySnapshot> => failure(makeError('authorize', 'BUDGET_UNAVAILABLE', requestId,
    'The advisory capacity read is temporarily unavailable.', true));

  return runBounded(waitMs, unavailable, async gate => {
    let client: BudgetTransactionPort | undefined;
    let inTransaction = false;
    try {
      const authorizationError = await authorizeScope(scope, requestId, ports, 'authorize', 'budgets.authorize');
      gate.checkpoint();
      if (authorizationError) return failure(authorizationError);
      client = await ports.database.connect();
      gate.checkpoint();
      await client.query('BEGIN');
      inTransaction = true;
      await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
      await bindFinancialDatabaseScope(client, scope);
      await bindDeadline(client, gate);
      const capacity = await projectCapacity(client, scope, currency);
      gate.beginCommit();
      await client.query('COMMIT'); inTransaction = false;
      return {
        ok: true,
        value: {
          schemaVersion: '1.0.0', requestId, scope, currency,
          limitAmount: formatScaledDecimal(capacity.limit), effectiveConsumedSpend: formatScaledDecimal(capacity.consumed),
          outstandingHolds: formatScaledDecimal(capacity.outstandingHolds), usedCapacity: formatScaledDecimal(capacity.used),
          availableCapacity: formatScaledDecimal(capacity.available), reservationCount: capacity.reservationCount, advisoryOnly: true,
        },
      };
    } catch {
      if (client && inTransaction) await rollback(client);
      return unavailable();
    } finally {
      client?.release();
    }
  });
}

/* -------------------------------- small schema plumbing -------------------------------- */

import { Value as valueModule } from '@sinclair/typebox/value';
import { MarkDispatchedCommandSchema } from './index.js';

function markSchema() { return MarkDispatchedCommandSchema; }
function requestIdOf(value: unknown): string {
  if (typeof value === 'object' && value !== null && 'requestId' in value) {
    const id = (value as Record<string, unknown>).requestId;
    if (typeof id === 'string' && id.length > 0) return id;
  }
  return 'unavailable';
}
