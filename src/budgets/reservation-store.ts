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
 * the single existing hold. Budget authority is NOT product-purchase
 * authority: these records only ration spend against a project limit.
 * ------------------------------------------------------------------ */

/** The reviewed budget decision policy version pinned by this leaf. */
export const BUDGET_DECISION_POLICY_VERSION = 'ci-budget-policy-1.0.0' as const;

/** Bounded wait, in milliseconds, for the per-partition authority lock before returning `unavailable`. */
export const DEFAULT_AUTHORITY_WAIT_MS = 2_000;
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

function asString(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Database returned an unexpected budget value.');
  return value;
}

function fromRow(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  return typeof value === 'number' ? String(value) : asString(value);
}

async function hashValue(value: unknown): Promise<string> {
  const canonical = (function canon(input: unknown): unknown {
    if (Array.isArray(input)) return input.map(canon);
    if (typeof input === 'object' && input !== null) {
      const object = input as Record<string, unknown>;
      return Object.fromEntries(Object.keys(object).sort().map(key => [key, canon(object[key])]));
    }
    return input;
  })(value);
  const bytes = new TextEncoder().encode(JSON.stringify(canonical));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return `sha256:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`;
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

/** Acquire the per-partition authority lock within a bounded wait. */
async function acquirePartitionLock(
  client: BudgetTransactionPort,
  scope: TrustedScope,
  currency: string,
  waitMs: number,
): Promise<boolean> {
  const safeWait = Number.isInteger(waitMs) && waitMs >= 0 && waitMs <= 60_000 ? waitMs : DEFAULT_AUTHORITY_WAIT_MS;
  await client.query(`SET LOCAL lock_timeout = '${safeWait}ms'`);
  try {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [partitionLockKey(scope, currency)]);
    return true;
  } catch {
    return false;
  }
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

  const authorizationError = await authorizeScope(scope, request.requestId, ports, 'changeBudget', 'budgets.changeBudget');
  if (authorizationError) return failure(authorizationError);
  if (!trustedNow(ports)) return failure(makeError('changeBudget', 'BUDGET_UNAVAILABLE', request.requestId, 'The trusted budget clock is unavailable.', true));

  let client: BudgetTransactionPort | undefined;
  let inTransaction = false;
  try {
    client = await ports.database.connect();
    await client.query('BEGIN');
    inTransaction = true;
    await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
    await bindFinancialDatabaseScope(client, scope);
    if (!(await acquirePartitionLock(client, scope, request.currency, ports.authorityWaitMs ?? DEFAULT_AUTHORITY_WAIT_MS))) {
      await rollback(client); inTransaction = false;
      return failure(makeError('changeBudget', 'BUDGET_UNAVAILABLE', request.requestId, 'The budget partition is busy; retry the identical idempotent request.', true));
    }

    const replay = await client.query(
      `SELECT policy_version_id, policy_revision, limit_amount::text AS limit_amount, content_hash
       FROM cost_intelligence.budget_scope_policies
       WHERE tenant_id = $1 AND project_id = $2 AND environment = $3 AND billing_mode = $4 AND idempotency_key = $5`,
      [scope.tenantId, scope.projectId, scope.environment, scope.billingMode, request.idempotencyKey],
    );
    const existing = await currentPolicy(client, scope, request.currency);
    if (replay.rows.length) {
      const row = replay.rows[0] as Record<string, unknown>;
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
    return failure(makeError('changeBudget', 'BUDGET_UNAVAILABLE', request.requestId, 'Budget policy persistence is temporarily unavailable.', true));
  } finally {
    client?.release();
  }
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

type RequiredHold = { kind: 'bounded'; amount: bigint; bounded: bigint | null } | { kind: 'unbounded' };

function requiredHold(request: ReservationRequest): RequiredHold {
  const estimate = request.estimate;
  if (estimate.completeness === 'complete') {
    return { kind: 'bounded', amount: parseScaledDecimal(estimate.knownSubtotal), bounded: null };
  }
  // Incomplete or unknown exposure needs an explicit, authorized conservative maximum policy.
  if (estimate.boundedConservativeMaximum !== undefined && estimate.maximumPolicyRef !== undefined) {
    const bounded = parseScaledDecimal(estimate.boundedConservativeMaximum);
    const known = parseScaledDecimal(estimate.knownSubtotal);
    return { kind: 'bounded', amount: bounded > known ? bounded : known, bounded };
  }
  return { kind: 'unbounded' };
}

/**
 * Atomically check applicable project capacity and create an idempotent
 * reservation hold before billable dispatch.
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

  const authorizationError = await authorizeScope(scope, requestId, ports, 'authorize', 'budgets.authorize');
  if (authorizationError) return failure(authorizationError);
  const now = trustedNow(ports);
  if (!now) return failure(makeError('authorize', 'BUDGET_UNAVAILABLE', requestId, 'The trusted budget clock is unavailable.', true));

  // Cross-currency pooling is forbidden without explicit policy: the estimate,
  // the canonical request, and the policy partition must share one currency.
  if (request.estimate.currency !== request.canonicalRequest.currency) {
    return failure(makeError('authorize', 'VALIDATION_ERROR', requestId, 'The estimate currency must match the reservation request currency.'));
  }
  const currency = request.estimate.currency;

  let client: BudgetTransactionPort | undefined;
  let inTransaction = false;
  try {
    client = await ports.database.connect();
    await client.query('BEGIN');
    inTransaction = true;
    await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
    await bindFinancialDatabaseScope(client, scope);
    if (!(await acquirePartitionLock(client, scope, currency, ports.authorityWaitMs ?? DEFAULT_AUTHORITY_WAIT_MS))) {
      await rollback(client); inTransaction = false;
      return { ok: true, value: unavailableDecision(requestId, request, currency, now) };
    }

    // Idempotent retry: an identical key returns the single existing hold.
    const replay = await client.query(
      `SELECT reservation_id, event_type, held_amount::text AS held_amount, partial_allowed_amount::text AS partial_allowed_amount,
              policy_version_id, policy_ref, rate_card_ref
       FROM cost_intelligence.budget_reservation_events
       WHERE tenant_id = $1 AND project_id = $2 AND environment = $3 AND billing_mode = $4 AND idempotency_key = $5
       ORDER BY event_sequence ASC LIMIT 1`,
      [scope.tenantId, scope.projectId, scope.environment, scope.billingMode, request.idempotencyKey],
    );
    const capacity = await projectCapacity(client, scope, currency);
    if (replay.rows.length) {
      const row = replay.rows[0] as Record<string, unknown>;
      const eventType = asString(row.event_type);
      const held = parseScaledDecimal(fromRow(row, 'held_amount') ?? '0');
      const partial = fromRow(row, 'partial_allowed_amount');
      const status: AuthorizationDecision['status'] = eventType === 'authorized' ? 'authorized' : eventType === 'partially_authorized' ? 'partial' : 'denied';
      await client.query('COMMIT'); inTransaction = false;
      return {
        ok: true,
        value: buildDecision({
          requestId, request, currency, now, status,
          reservationId: asString(row.reservation_id), held, available: capacity.available,
          partialAllowed: partial === null ? null : parseScaledDecimal(partial),
          policyRef: parseRef(row.policy_ref) ?? decisionReference(capacity.policy),
          rateCardRef: parseRef(row.rate_card_ref),
        }),
      };
    }

    // No applicable budget policy means no configured authority: deny by default.
    if (!capacity.policy) {
      await rollback(client); inTransaction = false;
      return { ok: true, value: buildDecision({ requestId, request, currency, now, status: 'denied', reservationId: 'none', held: 0n, available: capacity.available, partialAllowed: null, policyRef: decisionReference(null), rateCardRef: request.estimate.rateCardRef }) };
    }

    const need = requiredHold(request);
    if (need.kind === 'unbounded') {
      // Unknown / unbounded pricing cannot auto-authorize.
      await rollback(client); inTransaction = false;
      return { ok: true, value: buildDecision({ requestId, request, currency, now, status: 'denied', reservationId: 'none', held: 0n, available: capacity.available, partialAllowed: null, policyRef: decisionReference(capacity.policy), rateCardRef: request.estimate.rateCardRef }) };
    }

    const reservationId = globalThis.crypto.randomUUID();
    let status: AuthorizationDecision['status'];
    let hold: bigint;
    let partialAllowed: bigint | null = null;
    if (need.amount <= capacity.available) {
      status = 'authorized'; hold = need.amount;
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
    await client.query(
      `INSERT INTO cost_intelligence.budget_reservation_events
        (reservation_event_id, tenant_id, project_id, environment, billing_mode, currency, reservation_id, event_sequence,
         event_type, decision_status, held_amount, consumed_amount, released_amount, estimate_completeness, known_subtotal,
         bounded_maximum, allow_partial, partial_allowed_amount, usage_finality, settlement_sequence, policy_version_id,
         rate_card_ref, policy_ref, idempotency_key, expected_revision, actor_reference, source_authority_ref,
         attempt_binding, logical_operation_id, billable_attempt_id, content_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,1,$8,$9,$10::numeric,0,0,$11,$12::numeric,$13,$14,$15,'unknown',NULL,$16,
         $17::jsonb,$18::jsonb,$19,NULL,$20,$21::jsonb,$22::jsonb,$23,$24,$25)`,
      [eventId, scope.tenantId, scope.projectId, scope.environment, scope.billingMode, currency, reservationId,
        status === 'authorized' ? 'authorized' : 'partially_authorized', status,
        formatScaledDecimal(hold), request.estimate.completeness, request.estimate.knownSubtotal,
        need.bounded === null ? null : formatScaledDecimal(need.bounded), request.allowPartialAuthorization,
        partialAllowed === null ? null : formatScaledDecimal(partialAllowed), capacity.policy.id,
        request.estimate.rateCardRef === null ? null : JSON.stringify(request.estimate.rateCardRef),
        JSON.stringify(policyRef), request.idempotencyKey, scope.actorId,
        JSON.stringify({ actorId: scope.actorId, authority: 'budget.reservation.authorize', policyVersionId: capacity.policy.id }),
        JSON.stringify(request.attemptBinding), request.attemptBinding.logicalOperationId, request.attemptBinding.billableAttemptId, contentHash],
    );
    await client.query('COMMIT'); inTransaction = false;
    const availableAfter = capacity.available - hold > 0n ? capacity.available - hold : 0n;
    return {
      ok: true,
      value: buildDecision({ requestId, request, currency, now, status, reservationId, held: hold, available: availableAfter, partialAllowed, policyRef, rateCardRef: request.estimate.rateCardRef }),
    };
  } catch {
    if (client && inTransaction) await rollback(client);
    return { ok: true, value: unavailableDecision(requestId, request, currency, now) };
  } finally {
    client?.release();
  }
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
}

async function loadReservation(client: BudgetTransactionPort, scope: TrustedScope, reservationId: string): Promise<ReservationState | null> {
  const result = await client.query(
    `SELECT currency, policy_version_id,
            sum(held_amount)::text AS held, sum(released_amount)::text AS released, max(consumed_amount)::text AS consumed,
            max(event_sequence)::int AS revision,
            (array_agg(event_type ORDER BY event_sequence DESC))[1] AS last_type,
            (array_agg(usage_finality ORDER BY event_sequence DESC))[1] AS last_finality
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
    currency: state.currency, revision: state.revision, usageFinality: state.usageFinality,
  };
}

type CommandKind = 'mark_dispatched' | 'settle' | 'release';

async function applyCommand(args: {
  requestId: string; idempotencyKey: string; scope: TrustedScope; reservationId: string; expectedRevision: number;
  currency: string; actorReference: string; sourceAuthorityRef: VersionedReference; attemptBinding: Record<string, unknown>;
  logicalOperationId: string; billableAttemptId: string; kind: CommandKind;
  ports: BudgetRuntimePorts; operation: string; authority: FinanceOperation;
  compute(state: ReservationState): { eventType: string; consumed: bigint; released: bigint; usageFinality: 'unknown' | 'partial' | 'final'; settlementSequence: number | null } | { reject: ErrorEnvelope };
}): Promise<ApiResult<ReservationCommandOutcome>> {
  const { ports, scope, requestId } = args;
  const authorizationError = await authorizeScope(scope, requestId, ports, args.operation, args.authority);
  if (authorizationError) return failure(authorizationError);
  if (!trustedNow(ports)) return failure(makeError(args.operation, 'BUDGET_UNAVAILABLE', requestId, 'The trusted budget clock is unavailable.', true));

  let client: BudgetTransactionPort | undefined;
  let inTransaction = false;
  try {
    client = await ports.database.connect();
    await client.query('BEGIN');
    inTransaction = true;
    await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
    await bindFinancialDatabaseScope(client, scope);
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
    if (!(await acquirePartitionLock(client, scope, effectiveCurrency, ports.authorityWaitMs ?? DEFAULT_AUTHORITY_WAIT_MS))) {
      await rollback(client); inTransaction = false;
      return failure(makeError(args.operation, 'BUDGET_UNAVAILABLE', requestId, 'The budget partition is busy; retry the identical idempotent request.', true));
    }

    const replay = await client.query(
      `SELECT reservation_id FROM cost_intelligence.budget_reservation_events
       WHERE tenant_id = $1 AND project_id = $2 AND environment = $3 AND billing_mode = $4 AND idempotency_key = $5 LIMIT 1`,
      [scope.tenantId, scope.projectId, scope.environment, scope.billingMode, args.idempotencyKey],
    );
    if (replay.rows.length) {
      const existingReservation = asString((replay.rows[0] as Record<string, unknown>).reservation_id);
      const state = await loadReservation(client, scope, existingReservation);
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
    await client.query(
      `INSERT INTO cost_intelligence.budget_reservation_events
        (reservation_event_id, tenant_id, project_id, environment, billing_mode, currency, reservation_id, event_sequence,
         event_type, decision_status, held_amount, consumed_amount, released_amount, estimate_completeness, known_subtotal,
         bounded_maximum, allow_partial, partial_allowed_amount, usage_finality, settlement_sequence, policy_version_id,
         rate_card_ref, policy_ref, idempotency_key, expected_revision, actor_reference, source_authority_ref,
         attempt_binding, logical_operation_id, billable_attempt_id, content_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NULL,0,$10::numeric,$11::numeric,NULL,NULL,NULL,false,NULL,$12,$13,$14,
         NULL,$15::jsonb,$16,$17,$18,$19::jsonb,$20::jsonb,$21,$22,$23)`,
      [eventId, scope.tenantId, scope.projectId, scope.environment, scope.billingMode, effectiveCurrency, args.reservationId, nextSequence,
        computed.eventType, formatScaledDecimal(computed.consumed), formatScaledDecimal(computed.released), computed.usageFinality,
        computed.settlementSequence, state.policyVersionId, JSON.stringify(args.sourceAuthorityRef), args.idempotencyKey,
        args.expectedRevision, args.actorReference, JSON.stringify(args.sourceAuthorityRef), JSON.stringify(args.attemptBinding),
        args.logicalOperationId, args.billableAttemptId, contentHash],
    );
    const refreshed = await loadReservation(client, scope, args.reservationId);
    await client.query('COMMIT'); inTransaction = false;
    return { ok: true, value: outcomeFrom(requestId, 'applied', args.reservationId, refreshed ?? state) };
  } catch {
    if (client && inTransaction) await rollback(client);
    return failure(makeError(args.operation, 'BUDGET_UNAVAILABLE', requestId, 'Reservation lifecycle persistence is temporarily unavailable.', true));
  } finally {
    client?.release();
  }
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
    compute(state) {
      if (state.lastType !== 'authorized' && state.lastType !== 'partially_authorized') {
        return { reject: makeError('markDispatched', 'VALIDATION_ERROR', request.requestId, 'Only a held reservation can be dispatched.') };
      }
      return { eventType: 'dispatched', consumed: 0n, released: 0n, usageFinality: 'unknown', settlementSequence: null };
    },
  });
}

export async function settleReservation(value: unknown, ports: BudgetRuntimePorts): Promise<ApiResult<ReservationCommandOutcome>> {
  const validated = validateSettleReservationCommandBoundary(value);
  if (!validated.ok) return failure(validated.error);
  const request = validated.value as SettleReservationCommand;
  const currency = request.settlement.currency;
  const cumulative = parseScaledDecimal(request.settlement.cumulativeAmount);
  return applyCommand({
    requestId: request.requestId, idempotencyKey: request.idempotencyKey, scope: request.scope as TrustedScope,
    reservationId: request.reservationId, expectedRevision: request.expectedRevision, currency,
    actorReference: request.actorReference, sourceAuthorityRef: request.sourceAuthorityRef as VersionedReference,
    attemptBinding: request.attemptBinding as unknown as Record<string, unknown>,
    logicalOperationId: request.attemptBinding.logicalOperationId, billableAttemptId: request.attemptBinding.billableAttemptId,
    kind: 'settle', ports, operation: 'settle', authority: 'budgets.settle',
    compute(state) {
      if (state.lastType === 'released' || state.lastType === 'expired') {
        return { reject: makeError('settle', 'VALIDATION_ERROR', request.requestId, 'A released or expired reservation cannot be settled.') };
      }
      if (cumulative < state.consumed) {
        return { reject: makeError('settle', 'VALIDATION_ERROR', request.requestId, 'Cumulative settlement cannot decrease a previously recorded consumption.') };
      }
      // Record the cumulative consumption; never double-count a settled portion.
      return {
        eventType: 'settled', consumed: cumulative, released: 0n,
        usageFinality: request.settlement.finality, settlementSequence: request.settlement.sequence,
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
  return applyCommand({
    requestId: request.requestId, idempotencyKey: request.idempotencyKey, scope: request.scope as TrustedScope,
    reservationId: request.reservationId, expectedRevision: request.expectedRevision, currency,
    actorReference: request.actorReference, sourceAuthorityRef: request.sourceAuthorityRef as VersionedReference,
    attemptBinding: request.attemptBinding as unknown as Record<string, unknown>,
    logicalOperationId: request.attemptBinding.logicalOperationId, billableAttemptId: request.attemptBinding.billableAttemptId,
    kind: 'release', ports, operation: 'release', authority: 'budgets.release',
    compute(state) {
      const remaining = state.held - state.released - state.consumed;
      const floorRemaining = remaining > 0n ? remaining : 0n;
      if (releaseAmount > floorRemaining) {
        return { reject: makeError('release', 'VALIDATION_ERROR', request.requestId, 'The release amount exceeds the outstanding hold.') };
      }
      return { eventType: 'released', consumed: 0n, released: releaseAmount, usageFinality: state.usageFinality, settlementSequence: null };
    },
  });
}

/** Advisory capacity read. It never authorizes dispatch or creates a reservation. */
export async function readCapacity(
  scope: TrustedScope,
  currency: string,
  requestId: string,
  ports: BudgetRuntimePorts,
): Promise<ApiResult<CapacitySnapshot>> {
  const authorizationError = await authorizeScope(scope, requestId, ports, 'authorize', 'budgets.authorize');
  if (authorizationError) return failure(authorizationError);
  let client: BudgetTransactionPort | undefined;
  let inTransaction = false;
  try {
    client = await ports.database.connect();
    await client.query('BEGIN');
    inTransaction = true;
    await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
    await bindFinancialDatabaseScope(client, scope);
    const capacity = await projectCapacity(client, scope, currency);
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
    return failure(makeError('authorize', 'BUDGET_UNAVAILABLE', requestId, 'The advisory capacity read is temporarily unavailable.', true));
  } finally {
    client?.release();
  }
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
