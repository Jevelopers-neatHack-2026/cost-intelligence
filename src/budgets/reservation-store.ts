import { Value } from '@sinclair/typebox/value';
import { budgetDigest, normalizedBudgetRequest, verifyBudgetSource, verifyReservationHost, CurrentReservationRequestSchema, PartialAcknowledgementRequestSchema, type BudgetEvidenceDecision, type ReservationAuthorityDecision, type BudgetEvidencePort, type BudgetReservationAuthorityPort, type BudgetReference, type CurrentReservationRequest, type PartialAcknowledgementRequest } from './authority.js';
import { Type, type Static } from '@sinclair/typebox';
import { type BudgetCollectorBackend, createAuthenticatedBudgetSourceResolver, budgetSourcePersistence, type AuthenticatedBudgetSource } from './evidence.js';
import { resolveBudgetReportedCost,compareBudgetReportedUsage, resolvePricingProfile, resolveExecutionFinality, BudgetExecutionFinalitySchema, type ResolvedBudgetReportedCost,type BudgetReportedUsage } from './reported-cost.js';
import { appendBudgetLedgerEventInTransaction,requireBudgetSettlementCapability,budgetExpenseSql,budgetExpenseAxisSql,budgetCurrentLedgerHeadSql,type LedgerAppendRequest } from '../ledger/store.js';
import {
  authorizeFinanceOperation,
  errorEnvelope,
  failure,
  type ApiResult,
  type Clock,
  type ErrorEnvelope,
  type FinanceAuthorizationPort,
  type FinanceAuthorizationDecision,
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
  type ReservationSnapshot,
  validateReservationSnapshotBoundary,VerifiedReservationReadRequestSchema,VerifiedReservationSnapshotSchema,type VerifiedReservationReadRequest,type VerifiedReservationSnapshot,
  VerifiedReleaseRequestSchema,type VerifiedReleaseRequest,
  VerifiedSettlementRequestSchema,type VerifiedSettlementRequest,VerifiedExpenseCorrectionRequestSchema,type VerifiedExpenseCorrectionRequest,
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
  readonly reservationAuthority?: BudgetReservationAuthorityPort;
  readonly budgetEvidence?: BudgetEvidencePort;
  /** Owner-mounted immutable source records and independently current collector key registry. */
  readonly sourceCollector?: BudgetCollectorBackend;
  /** Explicit Finance-native production or private development decoder mount; neither promotes canonical adoption. */
  readonly reportedCostContractMode?:'development_0_10_1'|'finance_collector_v1';
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
  expectedLedgerRevision: Type.Optional(Type.Integer({ minimum: 0 })),
}, { additionalProperties: false });
export type BudgetPolicyChangeRequest = Static<typeof BudgetPolicyChangeRequestSchema>;

export interface BudgetPolicyReceipt {
  readonly schemaVersion: '1.0.0';
  readonly requestId: string;
  readonly status: 'applied' | 'denied' | 'replay' | 'stale' | 'conflict';
  readonly policyVersionId: string;
  readonly policyRevision: number;
  readonly currency: string;
  readonly effectiveLimit: string;
  readonly previousLimit: string;
  readonly effectiveConsumedSpend: string;
  readonly activeUnconsumedCommitments: string;
  readonly replayedStatus?: 'denied' | 'stale';
  readonly decisionPolicyVersion: typeof BUDGET_DECISION_POLICY_VERSION;
  readonly policyRef: VersionedReference;
}

export type ReservationLifecycleState = 'held' | 'dispatched' | 'outcome_unknown'|'held_for_reconciliation'|'partially_settled' | 'settled' | 'released' | 'expired';

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
  readonly capacityState: 'unconfigured' | 'available' | 'near_limit' | 'exhausted' | 'over_limit';
  readonly unresolvedExposure: boolean;
  readonly policyWindow: 'project_lifetime';
  readonly policyRef: VersionedReference;
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
  async wait<T>(work: Promise<T>): Promise<T> {
    this.checkpoint();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([work, new Promise<T>((_resolve,reject) => {
        timer=setTimeout(()=>{this.expired=true;reject(new DeadlineExceeded('budget verifier deadline exceeded'));},this.remainingMs());
      })]);
    } finally { if(timer!==undefined)clearTimeout(timer); }
  }
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

function trustedNow(ports: BudgetRuntimePorts): Date | null {
  try {
    const now = ports.clock.now();
    return now instanceof Date && Number.isFinite(now.getTime()) ? now : null;
  } catch {
    return null;
  }
}

type FinanceScopeProof = Extract<FinanceAuthorizationDecision, { status: 'allowed' }>;
type TimedBudgetProof = Pick<FinanceScopeProof, 'verifiedAt' | 'expiresAt'>;
async function authorizeScopeProof(
  scope: TrustedScope, requestId: string, ports: BudgetRuntimePorts,
  requestOperation: string, operation: FinanceOperation,
): Promise<ApiResult<FinanceScopeProof>> {
  const authorization=await authorizeFinanceOperation({module:'budgets',requestOperation,operation,scope,requestId,clock:ports.clock,financeAuthority:ports.financeAuthority});
  if(authorization.ok){
    if(!('principal' in authorization.decision))return failure(makeError(requestOperation,'FORBIDDEN_SCOPE',requestId,'A current Finance permission decision is required.'));
    return {ok:true,value:structuredClone(authorization.decision) as FinanceScopeProof};
  }
  return failure(authorization.error.code==='SOURCE_UNAVAILABLE'
    ? makeError(requestOperation,'BUDGET_UNAVAILABLE',requestId,'Budget authorization is temporarily unavailable; retry the identical idempotent request.',true)
    : authorization.error);
}
async function authorizeScope(scope:TrustedScope,requestId:string,ports:BudgetRuntimePorts,requestOperation:string,operation:FinanceOperation):Promise<ErrorEnvelope|null>{
  const result=await authorizeScopeProof(scope,requestId,ports,requestOperation,operation);
  return result.ok?null:result.error;
}
/** Retain every proof consulted during a request: a later refresh cannot silently extend an expired chain. */
async function persistedBudgetProofs(proofs:readonly TimedBudgetProof[]):Promise<readonly unknown[]>{
  return Promise.all(proofs.map(async proof=>{
    if('record' in proof&&'sourceBytes' in proof){
      const source=proof as AuthenticatedBudgetSource;
      const safe=await budgetSourcePersistence(source);
      return {reference:source.reference,recordHash:source.recordHash,sourceBytesHash:source.record.sourceBytesSha256,
        financialRecord:safe.collectorRecord,current:source.current,authentication:source.authentication,
        verifiedAt:source.verifiedAt,expiresAt:source.expiresAt};
    }
    return proof;
  }));
}
function currentProofBound(ports:BudgetRuntimePorts,proofs:readonly TimedBudgetProof[],request?:ReservationRequest):{now:Date;expiresAt:string}|null{
  const now=trustedNow(ports);if(!now||proofs.length===0)return null;
  const expiries:number[]=[];
  for(const proof of proofs){
    const verified=Date.parse(proof.verifiedAt),expires=Date.parse(proof.expiresAt);
    if(!Number.isFinite(verified)||!Number.isFinite(expires)||verified>now.getTime()||expires<=now.getTime())return null;
    expiries.push(expires);
  }
  if(request){
    if(!request.authorityBinding)return null;
    for(const expiry of [request.canonicalRequest.expires_at,request.authorityBinding.leaseExpiresAt]){
      const value=Date.parse(expiry);if(!Number.isFinite(value)||value<=now.getTime())return null;expiries.push(value);
    }
  }
  return {now,expiresAt:new Date(Math.min(...expiries)).toISOString()};
}
async function refreshScopeProof(scope:TrustedScope,requestId:string,ports:BudgetRuntimePorts,operation:string,authority:FinanceOperation,gate:DeadlineGate,proofs:TimedBudgetProof[]):Promise<ApiResult<FinanceScopeProof>>{
  const result=await gate.wait(authorizeScopeProof(scope,requestId,ports,operation,authority));gate.checkpoint();
  if(!result.ok)return result;
  proofs.push(result.value);
  if(!currentProofBound(ports,proofs))return failure(makeError(operation,'FORBIDDEN_SCOPE',requestId,'The retained Finance authority chain expired during verification.'));
  return result;
}
async function verifyPricing(ports:BudgetRuntimePorts,request:ReservationRequest){
  if(!ports.sourceCollector||!request.pricingProfileRef||!request.authorityBinding)return null;
  const binding=request.authorityBinding;
  const verified=await resolvePricingProfile(ports.sourceCollector,ports.clock,{scope:request.scope,reference:request.pricingProfileRef,
    kind:'pricing_profile',provider:binding.provider,model:binding.model,operation:binding.operation,
    targetBindingSha256:binding.targetBindingSha256,authorityBinding:binding,attempt:request.attemptBinding},request as unknown as Record<string,unknown>);
  if(!verified||verified.profile.currency!==request.estimate.currency)return null;
  const amount=verified.profile.pricingUnit==='fixed_per_attempt'?verified.profile.fixedAttemptAmount:
    verified.maximum?.record.payload&&typeof verified.maximum.record.payload==='object'&&'authorizedMaximum' in verified.maximum.record.payload?
      String(verified.maximum.record.payload.authorizedMaximum):null;
  if(amount===null)return {amount:null,proofs:[verified.source]};
  if(verified.profile.pricingUnit==='fixed_per_attempt'&&request.estimate.completeness==='complete'
    &&!sameAmount(amount,request.estimate.knownSubtotal))return null;
  if(verified.profile.pricingUnit!=='fixed_per_attempt'&&(!verified.maximum
    ||!sameJson((verified.maximum.record.payload as {policyRef:BudgetReference}).policyRef,request.estimate.maximumPolicyRef)
    ||!sameAmount(amount,request.estimate.boundedConservativeMaximum??'-1')
    ||(verified.maximum.record.payload as {currency:string}).currency!==request.estimate.currency))return null;
  if(parseScaledDecimal(amount)<parseScaledDecimal(request.estimate.knownSubtotal)
    ||!sameAmount(amount,request.canonicalRequest.requested.amount))return null;
  return {amount:parseScaledDecimal(amount),proofs:[verified.source,...(verified.maximum?[verified.maximum]:[])]};
}
function maximumMatches(request:ReservationRequest,source:BudgetEvidenceDecision):boolean{
  return request.estimate.completeness==='complete'||!!source.maximum&&sameJson(source.maximum.policyRef,request.estimate.maximumPolicyRef)
    &&source.maximum.currency===request.estimate.currency&&sameAmount(source.maximum.authorizedCap,request.estimate.boundedConservativeMaximum??'0')
    &&sameAmount(source.maximum.authorizedCap,request.canonicalRequest.requested.amount)
    &&parseScaledDecimal(source.maximum.authorizedCap)>=parseScaledDecimal(request.estimate.knownSubtotal);
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
    // Existing ledger writers use this scope lock. Always lock ledger before the currency partition.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`ci02-ledger:${scope.tenantId}:${scope.projectId}:${scope.environment}:${scope.billingMode}`]);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [partitionLockKey(scope, currency)]);
  } catch {
    return false;
  }
  gate.checkpoint();
  const restricted=await client.query(`SELECT 1 FROM cost_intelligence.financial_privacy_quarantine
    WHERE tenant_id=$1 AND project_id=$2 AND environment=$3 AND billing_mode=$4 LIMIT 1`,
    [scope.tenantId,scope.projectId,scope.environment,scope.billingMode]);
  gate.checkpoint();
  if(restricted.rows.length)throw new Error('Financial history is restricted pending financial review.');
  return true;
}

interface PartitionCapacity {
  readonly limit: bigint;
  readonly consumed: bigint;
  readonly outstandingHolds: bigint;
  readonly used: bigint;
  readonly available: bigint;
  readonly reservationCount: number;
  readonly unresolvedExposure: boolean;
  readonly ledgerRevision: number;
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
  await requireBudgetSettlementCapability(client);
  const policy = await currentPolicy(client, scope, currency);
  const aggregate = await client.query(
    `WITH effective_spend AS (
       SELECT e.* FROM cost_intelligence.financial_ledger_events e
       WHERE e.tenant_id=$1 AND e.project_id=$2 AND e.environment=$3 AND e.billing_mode=$4 AND e.currency=$5
         AND ${budgetExpenseSql('e')}
         AND ${budgetCurrentLedgerHeadSql('e')}
     ), attempt_spend AS (
       SELECT billable_attempt_id, greatest(coalesce(sum(amount),0),0) AS amount, bool_or(amount IS NULL) AS unknown
       FROM effective_spend WHERE billable_attempt_id IS NOT NULL GROUP BY billable_attempt_id
     ), event_totals AS (
       SELECT reservation_id, (array_agg(billable_attempt_id ORDER BY event_sequence))[1] AS attempt_id,
              sum(held_amount) AS hold, sum(released_amount) AS released
       FROM cost_intelligence.budget_reservation_events
       WHERE tenant_id=$1 AND project_id=$2 AND environment=$3 AND billing_mode=$4 AND currency=$5 GROUP BY reservation_id
     ), financial_revisions AS (
       SELECT reservation_id,event_sequence,consumed_amount,usage_finality FROM cost_intelligence.budget_reservation_events
       WHERE tenant_id=$1 AND project_id=$2 AND environment=$3 AND billing_mode=$4 AND currency=$5 AND event_type='settled'
       UNION ALL
       SELECT reservation_id,event_sequence,consumed_amount,usage_finality FROM cost_intelligence.budget_lifecycle_observations
       WHERE tenant_id=$1 AND project_id=$2 AND environment=$3 AND billing_mode=$4 AND currency=$5
     ), latest_financial AS (
       SELECT DISTINCT ON(reservation_id) reservation_id,consumed_amount,usage_finality FROM financial_revisions ORDER BY reservation_id,event_sequence DESC
     ), lifecycle_releases AS (
       SELECT reservation_id,sum(released_amount) AS released FROM cost_intelligence.budget_lifecycle_observations
       WHERE tenant_id=$1 AND project_id=$2 AND environment=$3 AND billing_mode=$4 AND currency=$5 GROUP BY reservation_id
     ), per_reservation AS (
       SELECT e.reservation_id,e.attempt_id,e.hold,e.released+coalesce(r.released,0) AS released,
         coalesce(f.consumed_amount,0) AS consumed,coalesce(f.usage_finality,'unknown') AS finality
       FROM event_totals e LEFT JOIN latest_financial f USING(reservation_id) LEFT JOIN lifecycle_releases r USING(reservation_id)
     ), joined AS (
       SELECT r.*, greatest(r.consumed,coalesce(l.amount,0)) AS effective_consumed,
              greatest(r.hold-r.released-greatest(r.consumed,coalesce(l.amount,0)),0) AS outstanding,
              coalesce(l.unknown,false) OR (r.finality='unknown' AND r.consumed>0) AS unknown
       FROM per_reservation r LEFT JOIN attempt_spend l ON l.billable_attempt_id=r.attempt_id
     ), unmatched AS (
       SELECT coalesce(sum(e.amount),0) AS amount, coalesce(bool_or(e.amount IS NULL),false) AS unknown
       FROM effective_spend e WHERE e.billable_attempt_id IS NULL OR NOT EXISTS (SELECT 1 FROM per_reservation r WHERE r.attempt_id=e.billable_attempt_id)
     )
     SELECT (SELECT count(*) FROM per_reservation)::int AS reservation_count,
       (coalesce(sum(effective_consumed),0)+greatest((SELECT amount FROM unmatched),0))::text AS consumed,
       coalesce(sum(outstanding),0)::text AS outstanding_holds,
       (coalesce(sum(effective_consumed+outstanding),0)+greatest((SELECT amount FROM unmatched),0))::text AS used,
       (coalesce(bool_or(unknown),false) OR (SELECT unknown FROM unmatched) OR EXISTS (
         SELECT 1 FROM cost_intelligence.financial_ledger_events e WHERE e.tenant_id=$1 AND e.project_id=$2
         AND e.environment=$3 AND e.billing_mode=$4 AND e.currency=$5 AND e.financial_effect
         AND e.classification IN ('direct_cost','supplier_expense','operating_expense','payable_labor')
         AND ${budgetCurrentLedgerHeadSql('e')}
         AND coalesce(${budgetExpenseAxisSql('e')},'unresolved') NOT IN
           ('consumption','charge','expense','fee','tax','refund','credit','discount','reimbursement','cash_movement','revenue')
       )) AS unresolved_exposure,
       (SELECT count(*) FROM cost_intelligence.financial_ledger_events WHERE tenant_id=$1 AND project_id=$2 AND environment=$3 AND billing_mode=$4)::int AS ledger_revision
     FROM joined`,
    [scope.tenantId, scope.projectId, scope.environment, scope.billingMode, currency],
  );
  const row = aggregate.rows[0] ?? {};
  // Intake and reservation writers hold the same scoped ledger lock. Read the
  // current accepted head, not a historical projection or a guessed zero cost.
  // Unpriced currency is unknown and therefore cannot be assigned to a pool.
  const intake = await client.query(
    `SELECT EXISTS (
       SELECT 1 FROM cost_intelligence.usage_intake_attempts a
       JOIN cost_intelligence.usage_intake_inbox i
         ON i.tenant_id=a.tenant_id AND i.project_id=a.project_id AND i.environment=a.environment
         AND i.billing_mode=a.billing_mode AND i.source_observation_id=a.current_observation_id
       WHERE a.tenant_id=$1 AND a.project_id=$2 AND a.environment=$3 AND a.billing_mode=$4
         AND i.attempt_revision_accepted
         AND NOT EXISTS (SELECT 1 FROM cost_intelligence.financial_ledger_events e WHERE e.event_id=i.event_id)
         AND NOT EXISTS (SELECT 1 FROM cost_intelligence.budget_settlement_postings p
           WHERE p.tenant_id=a.tenant_id AND p.project_id=a.project_id AND p.environment=a.environment AND p.billing_mode=a.billing_mode
             AND p.amount_semantics='cumulative_attempt_total' AND p.intake_observation_ids ? i.source_observation_id)
         AND (i.event_facts #>> '{valuation,money,currency}' IS NULL
           OR i.event_facts #>> '{valuation,money,currency}'=$5)
         AND NOT EXISTS (
           SELECT 1 FROM cost_intelligence.budget_reservation_events r
           WHERE r.tenant_id=a.tenant_id AND r.project_id=a.project_id AND r.environment=a.environment
             AND r.billing_mode=a.billing_mode AND r.billable_attempt_id=a.billable_attempt_id
             AND r.logical_operation_id=a.logical_operation_id
             AND r.attempt_binding->>'providerAttemptId'=a.provider_attempt_id
             AND (i.event_facts #>> '{valuation,money,currency}' IS NULL
               OR i.event_facts #>> '{valuation,money,currency}'=r.currency)
           GROUP BY r.reservation_id,r.currency
           HAVING sum(r.held_amount)-sum(r.released_amount) > greatest(max(r.consumed_amount),
             coalesce((SELECT greatest(sum(e.amount),0) FROM cost_intelligence.financial_ledger_events e
               WHERE e.tenant_id=$1 AND e.project_id=$2 AND e.environment=$3 AND e.billing_mode=$4
                 AND e.billable_attempt_id=a.billable_attempt_id AND e.currency=r.currency
                 AND ${budgetExpenseSql('e')}
                 AND ${budgetCurrentLedgerHeadSql('e')}),0))
             AND sum(r.held_amount)-sum(r.released_amount) >=
               coalesce((i.event_facts #>> '{valuation,money,amount}')::numeric,0)
         )
     ) AS unresolved_intake`,
    [scope.tenantId, scope.projectId, scope.environment, scope.billingMode, currency],
  );
  const consumed = parseScaledDecimal(fromRow(row, 'consumed') ?? '0');
  const outstandingHolds = parseScaledDecimal(fromRow(row, 'outstanding_holds') ?? '0');
  const used = parseScaledDecimal(fromRow(row, 'used') ?? '0');
  const limit = policy ? policy.limit : 0n;
  const available = limit - used > 0n ? limit - used : 0n;
  return {
    limit, consumed, outstandingHolds, used, available,
    reservationCount: Number(row.reservation_count ?? 0),
    unresolvedExposure: row.unresolved_exposure === true || intake.rows[0]?.unresolved_intake === true, ledgerRevision: Number(row.ledger_revision ?? 0),
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
  const request = structuredClone(outer.value);
  const scope = request.scope as TrustedScope;

  const waitMs = resolveWaitMs(ports);
  if (waitMs === null) return invalidWaitFailure('changeBudget', request.requestId);
  const unavailable = (): ApiResult<BudgetPolicyReceipt> => failure(makeError('changeBudget', 'BUDGET_UNAVAILABLE', request.requestId,
    'Budget policy persistence is temporarily unavailable; retry the identical idempotent request.', true));

  return runBounded(waitMs, unavailable, async gate => {
    let client: BudgetTransactionPort | undefined;
    let inTransaction = false;
    try {
      const initialScope=await authorizeScopeProof(scope,request.requestId,ports,'changeBudget','budgets.changeBudget');
      gate.checkpoint();if(!initialScope.ok)return initialScope;
      const proofs:TimedBudgetProof[]=[initialScope.value];
      if (!trustedNow(ports)) return failure(makeError('changeBudget', 'BUDGET_UNAVAILABLE', request.requestId, 'The trusted budget clock is unavailable.', true));
      if (!ports.budgetEvidence) return unavailable();
      const source=await verifySource(ports,request as unknown as Record<string,unknown>,'changeBudget',request.sourceAuthorityRef);
      if(!source) return failure(makeError('changeBudget', 'FORBIDDEN_SCOPE', request.requestId, 'Current authenticated budget policy source evidence is missing.'));

      proofs.push(source);
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

      const currentSource=await gate.wait(verifySource(ports,request as unknown as Record<string,unknown>,'changeBudget',request.sourceAuthorityRef));
      if(!currentSource)return failure(makeError('changeBudget','FORBIDDEN_SCOPE',request.requestId,'The current policy source authority is unavailable.'));
      proofs.push(currentSource);
      const currentScope=await refreshScopeProof(scope,request.requestId,ports,'changeBudget','budgets.changeBudget',gate,proofs);if(!currentScope.ok)return currentScope;
      const finishPolicy=async (receipt:BudgetPolicyReceipt):Promise<ApiResult<BudgetPolicyReceipt>>=>{
        const finalScope=await refreshScopeProof(scope,request.requestId,ports,'changeBudget','budgets.changeBudget',gate,proofs);if(!finalScope.ok)return finalScope;
        if(!currentProofBound(ports,proofs))return unavailable();
        gate.beginCommit();await client!.query('COMMIT');inTransaction=false;
        const acknowledgedScope=await refreshScopeProof(scope,request.requestId,ports,'changeBudget','budgets.changeBudget',gate,proofs);if(!acknowledgedScope.ok)return unavailable();
        if(!currentProofBound(ports,proofs))return unavailable();
        return {ok:true,value:receipt};
      };

      const replay = await client.query(
        `SELECT policy_version_id, policy_revision, currency, limit_amount::text AS limit_amount, content_hash,
                actor_reference, reason_reference, source_authority_ref, change_request,
                (SELECT limit_amount::text FROM cost_intelligence.budget_scope_policies previous WHERE previous.policy_version_id=budget_scope_policies.supersedes_policy_version_id) AS prior_limit
         FROM cost_intelligence.budget_scope_policies
         WHERE tenant_id = $1 AND project_id = $2 AND environment = $3 AND billing_mode = $4 AND idempotency_key = $5`,
        [scope.tenantId, scope.projectId, scope.environment, scope.billingMode, request.idempotencyKey],
      );
      const existing = await currentPolicy(client, scope, request.currency);
      const capacity = await projectCapacity(client, scope, request.currency);
      if (replay.rows.length) {
        const row = replay.rows[0] as Record<string, unknown>;
        // A replay must match the normalized original change; otherwise it is a typed conflict.
        const identical = sameJson(row.change_request, normalizedBudgetRequest(request as unknown as Record<string, unknown>)) && fromRow(row, 'currency') === request.currency
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
        return await finishPolicy({
            schemaVersion: '1.0.0', requestId: request.requestId, status: 'replay',
            policyVersionId: asString(row.policy_version_id), policyRevision: Number(row.policy_revision), currency: request.currency,
            effectiveLimit: formatScaledDecimal(parseScaledDecimal(asString(row.limit_amount))),
            previousLimit: formatScaledDecimal(parseScaledDecimal(fromRow(row,'prior_limit') ?? '0')),
            decisionPolicyVersion: BUDGET_DECISION_POLICY_VERSION,
            effectiveConsumedSpend: formatScaledDecimal(capacity.consumed), activeUnconsumedCommitments: formatScaledDecimal(capacity.outstandingHolds),
            policyRef: { contract: 'cost-intelligence.budget-policy', schema_version: '1.0.0', id: asString(row.policy_version_id), revision: Number(row.policy_revision), content_hash: asString(row.content_hash) },
        });
      }

      const priorDecision=await client.query(`SELECT command_request,command_receipt FROM cost_intelligence.budget_policy_decisions WHERE tenant_id=$1 AND project_id=$2 AND environment=$3 AND billing_mode=$4 AND idempotency_key=$5`,[scope.tenantId,scope.projectId,scope.environment,scope.billingMode,request.idempotencyKey]);
      if(priorDecision.rows[0]){
        const prior=priorDecision.rows[0];if(!sameJson(prior.command_request,normalizedBudgetRequest(request as unknown as Record<string,unknown>))){await rollback(client);inTransaction=false;return failure(makeError('changeBudget','IDEMPOTENCY_CONFLICT',request.requestId,'This policy command key already binds another request.'));}
        const receipt=prior.command_receipt as BudgetPolicyReceipt;
        return await finishPolicy({...receipt,requestId:request.requestId,status:'replay',...(receipt.status==='denied'||receipt.status==='stale'?{replayedStatus:receipt.status}:{})});
      }
      const currentRevision = existing?.revision ?? 0;
      if (request.expectedPolicyRevision !== currentRevision || (request.expectedLedgerRevision !== undefined && request.expectedLedgerRevision !== capacity.ledgerRevision)) {
        const receipt: BudgetPolicyReceipt = {
            schemaVersion: '1.0.0', requestId: request.requestId, status: 'stale',
            policyVersionId: existing?.id ?? 'none', policyRevision: currentRevision, currency: request.currency,
            effectiveLimit: existing ? formatScaledDecimal(existing.limit) : '0',
            previousLimit: existing ? formatScaledDecimal(existing.limit) : '0',
            decisionPolicyVersion: BUDGET_DECISION_POLICY_VERSION,
            effectiveConsumedSpend: formatScaledDecimal(capacity.consumed), activeUnconsumedCommitments: formatScaledDecimal(capacity.outstandingHolds),
            policyRef: decisionReference(existing),
          };
        await persistPolicyDecision(client,request,receipt);
        return await finishPolicy(receipt);
      }

      if (parseScaledDecimal(request.limitAmount) < capacity.used || capacity.unresolvedExposure && existing !== null && parseScaledDecimal(request.limitAmount) < existing.limit) {
        const receipt: BudgetPolicyReceipt = { schemaVersion: '1.0.0', requestId: request.requestId, status: 'denied', policyVersionId: existing?.id ?? 'none', policyRevision: currentRevision, currency: request.currency,
          effectiveLimit: formatScaledDecimal(existing?.limit ?? 0n), previousLimit: formatScaledDecimal(existing?.limit ?? 0n),
          effectiveConsumedSpend: formatScaledDecimal(capacity.consumed), activeUnconsumedCommitments: formatScaledDecimal(capacity.outstandingHolds),
          decisionPolicyVersion: BUDGET_DECISION_POLICY_VERSION, policyRef: decisionReference(existing) };
        await persistPolicyDecision(client,request,receipt);
        return await finishPolicy(receipt);
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
           reason_reference, source_authority_ref, supersedes_policy_version_id, content_hash, change_request)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::numeric,80,$9,$10,$11,$12,$13::jsonb,$14,$15,$16::jsonb)`,
        [policyVersionId, scope.tenantId, scope.projectId, scope.environment, scope.billingMode, request.currency, nextRevision,
          request.limitAmount, BUDGET_DECISION_POLICY_VERSION, request.idempotencyKey, request.actorReference,
          request.reasonReference, JSON.stringify(request.sourceAuthorityRef), existing?.id ?? null, contentHash, JSON.stringify(normalizedBudgetRequest(request as unknown as Record<string,unknown>))],
      );
      return await finishPolicy({
          schemaVersion: '1.0.0', requestId: request.requestId, status: 'applied',
          policyVersionId, policyRevision: nextRevision, currency: request.currency,
          effectiveLimit: formatScaledDecimal(parseScaledDecimal(request.limitAmount)),
          previousLimit: existing ? formatScaledDecimal(existing.limit) : '0',
          decisionPolicyVersion: BUDGET_DECISION_POLICY_VERSION,
          effectiveConsumedSpend: formatScaledDecimal(capacity.consumed), activeUnconsumedCommitments: formatScaledDecimal(capacity.outstandingHolds),
          policyRef: { contract: 'cost-intelligence.budget-policy', schema_version: '1.0.0', id: policyVersionId, revision: nextRevision, content_hash: contentHash },
      });
    } catch {
      if (client && inTransaction) await rollback(client);
      return unavailable();
    } finally {
      if(client&&inTransaction)await rollback(client);
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
 * A complete estimate uses its authenticated subtotal. Unknown/incomplete estimates
 * use the separately resolved current maximum path in admission; an incoming
 * maximum reference by itself never grants authority.
 */
function requiredHold(request: ReservationRequest): bigint | null {
  const estimate = request.estimate;
  return estimate.completeness === 'complete' ? parseScaledDecimal(estimate.knownSubtotal) : null;
}

function sameAmount(left: string, right: string): boolean {
  return parseScaledDecimal(left) === parseScaledDecimal(right);
}

/** Contradictory financial fields between the canonical request and the estimate. */
function financialBindingError(request: ReservationRequest,approvedAmount?:bigint): string | null {
  const canonical = request.canonicalRequest;
  const requested = canonical.requested;
  if (request.estimate.currency !== canonical.currency || requested.currency !== canonical.currency) {
    return 'The estimate and requested amount currency must match the reservation request currency.';
  }
  if(approvedAmount!==undefined){
    if(parseScaledDecimal(requested.amount)!==approvedAmount||parseScaledDecimal(request.estimate.knownSubtotal)>approvedAmount)
      return 'The exact requested hold must equal the independently approved fixed price or attempt maximum.';
    return null;
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
  const request = structuredClone(validated.value) as ReservationRequest;
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
      const initialScope=await authorizeScopeProof(scope,requestId,ports,'authorize','budgets.authorize');
      gate.checkpoint();if(!initialScope.ok)return initialScope;
      const proofs:TimedBudgetProof[]=[initialScope.value];
      const now = trustedNow(ports);
      if (!now) return failure(makeError('authorize', 'BUDGET_UNAVAILABLE', requestId, 'The trusted budget clock is unavailable.', true));

      if (!request.authorityBinding || !request.sourceAuthorityRef || !request.pricingProfileRef || !ports.sourceCollector || !ports.reservationAuthority || !ports.budgetEvidence) return unavailable();
      if (Date.parse(request.canonicalRequest.expires_at) <= now.getTime()) return failure(makeError('authorize', 'VALIDATION_ERROR', requestId, 'The financial reservation expiry is not current.'));
      if (request.authorityBinding.budgetScopeId !== request.canonicalRequest.budget_scope_id || request.idempotencyKey !== request.canonicalRequest.idempotency_key
        || request.attemptBinding.billableAttemptId !== request.canonicalRequest.billable_attempt_id || request.attemptBinding.logicalOperationId !== request.canonicalRequest.logical_operation_id) return failure(makeError('authorize', 'VALIDATION_ERROR', requestId, 'Canonical and Finance economic identity must match exactly.'));
      if (request.authorityBinding.provider === 'openrouter' && currency !== 'USD') return failure(makeError('authorize', 'VALIDATION_ERROR', requestId, 'The OpenRouter authority mapping requires an exact USD partition.'));
      const source = await verifySource(ports, request as unknown as Record<string, unknown>, 'authorize', request.sourceAuthorityRef);
      if (!source) return failure(makeError('authorize', 'FORBIDDEN_SCOPE', requestId, 'Current authenticated estimate source evidence is missing.'));
      const host = await verifyReservationHost(ports.reservationAuthority, { scope, billableAttemptId: request.attemptBinding.billableAttemptId, binding: request.authorityBinding, sourceAuthorityRef: request.sourceAuthorityRef, phase: 'admission' }, ports.clock);
      gate.checkpoint();
      if (!host) return failure(makeError('authorize', 'FORBIDDEN_SCOPE', requestId, 'The current host target grant or lease is unavailable or revoked.'));
      proofs.push(host,source);
      if(!currentProofBound(ports,proofs,request))return failure(makeError('authorize','FORBIDDEN_SCOPE',requestId,'The admission proof chain is no longer current.'));

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
                attempt_binding, policy_version_id, policy_ref, rate_card_ref, authorization_request, reservation_event_id, content_hash, authorized_cap::text AS authorized_cap
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
        const identical = sameJson(row.authorization_request, normalizedBudgetRequest(request as unknown as Record<string, unknown>))
          && (eventType === 'authorized' || eventType === 'partially_authorized')
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
        const replayScope=await refreshScopeProof(scope,requestId,ports,'authorize','budgets.authorize',gate,proofs);if(!replayScope.ok)return replayScope;
        if(!currentProofBound(ports,proofs,request))return unavailable();
        gate.beginCommit();
        await client.query('COMMIT'); inTransaction = false;
        const returnedScope=await refreshScopeProof(scope,requestId,ports,'authorize','budgets.authorize',gate,proofs);if(!returnedScope.ok)return unavailable();
        const replayBound=currentProofBound(ports,proofs,request);if(!replayBound)return unavailable();
        return {
          ok: true,
          value: { ...buildDecision({
            requestId, request, currency, now, status,
            reservationId: asString(row.reservation_id), held, available: capacity.available,
            partialAllowed: partial === null ? null : parseScaledDecimal(partial),
            policyRef: storedPolicyRef!,
            rateCardRef: parseRef(row.rate_card_ref),
          }), historicalReplay:true },
        };
      }

      const acknowledgementKey=await client.query(`SELECT acknowledgement_id FROM cost_intelligence.budget_reservation_acknowledgements WHERE tenant_id=$1 AND project_id=$2 AND environment=$3 AND billing_mode=$4 AND idempotency_key=$5`,[scope.tenantId,scope.projectId,scope.environment,scope.billingMode,request.idempotencyKey]);
      if(acknowledgementKey.rows.length){await rollback(client);inTransaction=false;return failure(makeError('authorize','IDEMPOTENCY_CONFLICT',requestId,'The key already identifies a partial acknowledgement.'));}
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

      const duplicateAttempt = await client.query(`SELECT reservation_id FROM cost_intelligence.budget_reservation_events WHERE tenant_id=$1 AND project_id=$2 AND environment=$3 AND billing_mode=$4 AND billable_attempt_id=$5 AND event_sequence=1`, [scope.tenantId,scope.projectId,scope.environment,scope.billingMode,request.attemptBinding.billableAttemptId]);
      if (duplicateAttempt.rows.length) { await rollback(client); inTransaction=false; return failure(makeError('authorize', 'IDEMPOTENCY_CONFLICT', requestId, 'This economic billable attempt already has a reservation; reuse its original key.')); }
      const pricing=await gate.wait(verifyPricing(ports,request));gate.checkpoint();
      if(!pricing)return failure(makeError('authorize','FORBIDDEN_SCOPE',requestId,'A current authenticated pricing profile and per-attempt maximum policy are required.'));
      proofs.push(...pricing.proofs);
      const approvedMaximum=pricing.amount;
      const bindingError=approvedMaximum===null?null:financialBindingError(request,approvedMaximum);
      if(bindingError)return failure(makeError('authorize','VALIDATION_ERROR',requestId,bindingError));

      const need = approvedMaximum;
      if (capacity.unresolvedExposure) { await rollback(client);inTransaction=false;return unavailable(); }
      if (need === null) {
        // Unknown / unbounded pricing cannot auto-authorize.
        await rollback(client); inTransaction = false;
        return { ok: true, value: buildDecision({ requestId, request, currency, now, status: 'denied', reservationId: 'none', held: 0n, available: capacity.available, partialAllowed: null, policyRef: decisionReference(capacity.policy), rateCardRef: request.estimate.rateCardRef }) };
      }

      if(request.workPlan && (parseScaledDecimal(request.workPlan.unitMaximumAmount)<=0n || parseScaledDecimal(request.workPlan.unitMaximumAmount)*BigInt(request.workPlan.requestedUnits)!==need))return failure(makeError('authorize','VALIDATION_ERROR',requestId,'The source-authenticated work plan must equal the requested conservative cap.'));
      const reservationId = globalThis.crypto.randomUUID();
      let status: AuthorizationDecision['status'];
      let hold: bigint;
      let partialAllowed: bigint | null = null;
      if (need <= capacity.available) {
        status = 'authorized'; hold = need;
      } else if (request.allowPartialAuthorization && capacity.available > 0n) {
        status = 'partial'; hold = capacity.available;
        if (request.workPlan) { const unit = parseScaledDecimal(request.workPlan.unitMaximumAmount); if (unit <= 0n) return failure(makeError('authorize','VALIDATION_ERROR',requestId,'Partial work needs a positive conservative unit bound.')); hold = (hold / unit) * unit; }
        if (hold <= 0n) status = 'denied';
        partialAllowed = hold;
      } else {
        status = 'denied'; hold = 0n;
      }

      if (status === 'denied') {
        await rollback(client); inTransaction = false;
        return { ok: true, value: buildDecision({ requestId, request, currency, now, status, reservationId: 'none', held: 0n, available: capacity.available, partialAllowed: null, policyRef: decisionReference(capacity.policy), rateCardRef: request.estimate.rateCardRef }) };
      }

      const currentNow=trustedNow(ports);if(!currentNow)return unavailable();
      const lockedScope=await refreshScopeProof(scope,requestId,ports,'authorize','budgets.authorize',gate,proofs);if(!lockedScope.ok)return lockedScope;
      const finalHost=await gate.wait(verifyReservationHost(ports.reservationAuthority,{scope,billableAttemptId:request.attemptBinding.billableAttemptId,binding:request.authorityBinding,sourceAuthorityRef:request.sourceAuthorityRef,phase:'admission'},ports.clock));gate.checkpoint();
      const finalSource=await gate.wait(verifySource(ports,request as unknown as Record<string,unknown>,'authorize',request.sourceAuthorityRef));gate.checkpoint();
      const finalPricing=await gate.wait(verifyPricing(ports,request));gate.checkpoint();
      if(!finalHost||!finalSource||!finalPricing||finalPricing.amount!==approvedMaximum)return failure(makeError('authorize','FORBIDDEN_SCOPE',requestId,'Current host or source authority changed during admission.'));
      proofs.push(finalHost,finalSource,...finalPricing.proofs);
      const finalScope=await refreshScopeProof(scope,requestId,ports,'authorize','budgets.authorize',gate,proofs);if(!finalScope.ok)return finalScope;
      const admissionBound=currentProofBound(ports,proofs,request);if(!admissionBound)return failure(makeError('authorize','FORBIDDEN_SCOPE',requestId,'Admission authority expired before the financial effect.'));
      const authorityEvidence={finance:finalScope.value,host:finalHost,source:finalSource,initial:{finance:initialScope.value,host,source},expiresAt:admissionBound.expiresAt};
      const policyRef = decisionReference(capacity.policy);
      const eventId = globalThis.crypto.randomUUID();
      const contentHash = await hashValue({ reservationId, request: normalizedBudgetRequest(request as unknown as Record<string, unknown>), hold: formatScaledDecimal(hold), authorizedCap: formatScaledDecimal(need), status, currency, authorityEvidence });
      gate.checkpoint();
      await client.query(
        `INSERT INTO cost_intelligence.budget_reservation_events
          (reservation_event_id, tenant_id, project_id, environment, billing_mode, currency, reservation_id, event_sequence,
           event_type, decision_status, held_amount, consumed_amount, released_amount, estimate_completeness, known_subtotal,
           bounded_maximum, allow_partial, partial_allowed_amount, usage_finality, settlement_sequence, policy_version_id,
           rate_card_ref, policy_ref, idempotency_key, expected_revision, actor_reference, source_authority_ref,
           attempt_binding, logical_operation_id, billable_attempt_id, content_hash, authorization_request, authority_binding, financial_expires_at, authorized_cap, authority_evidence)
         VALUES ($1,$2,$3,$4,$5,$6,$7,1,$8,$9,$10::numeric,0,0,$11,$12::numeric,$13::numeric,$14,$15,'unknown',NULL,$16,
           $17::jsonb,$18::jsonb,$19,NULL,$20,$21::jsonb,$22::jsonb,$23,$24,$25,$26::jsonb,$27::jsonb,$28::timestamptz,$29::numeric,$30::jsonb)`,
        [eventId, scope.tenantId, scope.projectId, scope.environment, scope.billingMode, currency, reservationId,
          status === 'authorized' ? 'authorized' : 'partially_authorized', status,
          formatScaledDecimal(hold), request.estimate.completeness, request.estimate.knownSubtotal,
          request.estimate.boundedConservativeMaximum === undefined ? null : formatScaledDecimal(parseScaledDecimal(request.estimate.boundedConservativeMaximum)),
          request.allowPartialAuthorization,
          partialAllowed === null ? null : formatScaledDecimal(partialAllowed), capacity.policy.id,
          request.estimate.rateCardRef === null ? null : JSON.stringify(request.estimate.rateCardRef),
          JSON.stringify(policyRef), request.idempotencyKey, scope.actorId,
          JSON.stringify(request.sourceAuthorityRef),
          JSON.stringify(request.attemptBinding), request.attemptBinding.logicalOperationId, request.attemptBinding.billableAttemptId, contentHash, JSON.stringify(normalizedBudgetRequest(request as unknown as Record<string, unknown>)), JSON.stringify(request.authorityBinding), request.canonicalRequest.expires_at, formatScaledDecimal(need), JSON.stringify(authorityEvidence)],
      );
      const beforeCommit=await refreshScopeProof(scope,requestId,ports,'authorize','budgets.authorize',gate,proofs);if(!beforeCommit.ok)return beforeCommit;
      if(!currentProofBound(ports,proofs,request)){await rollback(client);inTransaction=false;return unavailable();}
      gate.beginCommit();
      await client.query('COMMIT'); inTransaction = false;
      const acknowledgedHost=await gate.wait(verifyReservationHost(ports.reservationAuthority,{scope,billableAttemptId:request.attemptBinding.billableAttemptId,
        binding:request.authorityBinding,sourceAuthorityRef:request.sourceAuthorityRef,phase:'admission'},ports.clock));gate.checkpoint();
      const acknowledgedSource=await gate.wait(verifySource(ports,request as unknown as Record<string,unknown>,'authorize',request.sourceAuthorityRef));gate.checkpoint();
      const acknowledgedPricing=await gate.wait(verifyPricing(ports,request));gate.checkpoint();
      if(!acknowledgedHost||!acknowledgedSource||!acknowledgedPricing||acknowledgedPricing.amount!==approvedMaximum)return unavailable();
      proofs.push(acknowledgedHost,acknowledgedSource,...acknowledgedPricing.proofs);
      const acknowledgedScope=await refreshScopeProof(scope,requestId,ports,'authorize','budgets.authorize',gate,proofs);if(!acknowledgedScope.ok)return unavailable();
      const returnedBound=currentProofBound(ports,proofs,request);if(!returnedBound)return unavailable();
      const availableAfter = capacity.available - hold > 0n ? capacity.available - hold : 0n;
      return {
        ok: true,
        value: buildDecision({ requestId, request, currency, now, status, reservationId, held: hold, available: availableAfter, partialAllowed, policyRef, rateCardRef: request.estimate.rateCardRef, evidenceRef: `ci05a:${eventId}`, evidenceHash: contentHash, authorizedCap: need, authorityExpiresAt:returnedBound.expiresAt }),
      };
    } catch {
      if (client && inTransaction) await rollback(client);
      return unavailable();
    } finally {
      if(client&&inTransaction)await rollback(client);
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
  evidenceRef?: string; evidenceHash?: string; authorizedCap?: bigint; authorityExpiresAt?:string;
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
      ? { allowedAmount: formatScaledDecimal(args.partialAllowed), allowedWorkUnits: request.workPlan ? (args.partialAllowed / parseScaledDecimal(request.workPlan.unitMaximumAmount)).toString() : null, unit: request.workPlan?.unit ?? null, callerAcknowledgementRequired: true, replanBeforeDispatch: true }
      : null,
    retryAfterMs: args.status === 'unavailable' ? DEFAULT_RETRY_AFTER_MS : null,
    ...(request.authorityBinding && args.evidenceRef && args.evidenceHash && args.authorizedCap !== undefined ? { finance: financeEnvelope(request, args.reservationId, args.held, args.authorizedCap, args.evidenceRef, args.evidenceHash, args.authorityExpiresAt) } : {}),
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
  readonly authorizationRequest: ReservationRequest | null;
  readonly financialExpiresAt: string | null;
  readonly acknowledged: boolean;
  readonly acknowledgementEvidence: unknown;
  readonly dispatchEvidence: unknown;
  readonly settlementSourceRef:unknown;
  readonly latestReportedUsage:BudgetReportedUsage|null;
}

async function loadReservation(client: BudgetTransactionPort, scope: TrustedScope, reservationId: string): Promise<ReservationState | null> {
  const result = await client.query(
    `SELECT currency, policy_version_id,
            sum(held_amount)::text AS held, sum(released_amount)::text AS released,
            coalesce((array_agg(consumed_amount ORDER BY event_sequence DESC) FILTER(WHERE event_type='settled'))[1],0)::text AS consumed,
            coalesce(max(event_sequence) FILTER(WHERE event_type='settled'),0) AS settlement_revision,
            max(event_sequence)::int AS revision,
            (array_agg(event_type ORDER BY event_sequence DESC))[1] AS last_type,
            (array_agg(usage_finality ORDER BY event_sequence DESC))[1] AS last_finality,
            bool_or(event_type = 'dispatched') AS ever_dispatched,
            (array_agg(event_type ORDER BY event_sequence ASC))[1] AS first_type,
            (array_agg(attempt_binding ORDER BY event_sequence ASC))[1] AS original_binding,
            (array_agg(authorization_request ORDER BY event_sequence ASC))[1] AS authorization_request,
            (array_agg(financial_expires_at::text ORDER BY event_sequence ASC))[1] AS financial_expires_at,
            bool_or(event_type = 'partial_acknowledged') AS acknowledged,
            (array_agg(command_evidence ORDER BY event_sequence DESC) FILTER (WHERE event_type='partial_acknowledged'))[1] AS acknowledgement_evidence,
            (array_agg(command_evidence ORDER BY event_sequence DESC) FILTER (WHERE event_type='dispatched'))[1] AS dispatch_evidence
     FROM cost_intelligence.budget_reservation_events
     WHERE tenant_id = $1 AND project_id = $2 AND environment = $3 AND billing_mode = $4 AND reservation_id = $5
     GROUP BY currency, policy_version_id`,
    [scope.tenantId, scope.projectId, scope.environment, scope.billingMode, reservationId],
  );
  const row = result.rows[0];
  if (!row) return null;
  const acknowledgements=await client.query(`SELECT event_sequence,command_request FROM cost_intelligence.budget_reservation_acknowledgements WHERE tenant_id=$1 AND project_id=$2 AND environment=$3 AND billing_mode=$4 AND reservation_id=$5 ORDER BY event_sequence DESC LIMIT 1`,[scope.tenantId,scope.projectId,scope.environment,scope.billingMode,reservationId]);
  const acknowledgement=acknowledgements.rows[0];const ackRevision=Number(acknowledgement?.event_sequence??0);
  const observations=await client.query(`SELECT event_sequence,event_type,consumed_amount::text,released_amount::text,usage_finality,sum(released_amount) OVER()::text AS lifecycle_released FROM cost_intelligence.budget_lifecycle_observations
    WHERE tenant_id=$1 AND project_id=$2 AND environment=$3 AND billing_mode=$4 AND reservation_id=$5 ORDER BY event_sequence DESC LIMIT 1`,
    [scope.tenantId,scope.projectId,scope.environment,scope.billingMode,reservationId]);
  const observation=observations.rows[0],observationRevision=Number(observation?.event_sequence??0);
  const sourcePosting=await client.query(`SELECT s.source_reference FROM cost_intelligence.budget_settlement_postings p
    JOIN cost_intelligence.budget_source_observations s ON s.observation_id=p.observation_id
    WHERE p.tenant_id=$1 AND p.project_id=$2 AND p.environment=$3 AND p.billing_mode=$4 AND p.reservation_id=$5 ORDER BY p.reservation_revision DESC LIMIT 1`,
    [scope.tenantId,scope.projectId,scope.environment,scope.billingMode,reservationId]);
  const reported=await client.query(`SELECT usage_event FROM cost_intelligence.budget_reported_observations
    WHERE tenant_id=$1 AND project_id=$2 AND environment=$3 AND billing_mode=$4 AND reservation_id=$5 ORDER BY reservation_revision DESC LIMIT 1`,
    [scope.tenantId,scope.projectId,scope.environment,scope.billingMode,reservationId]);
  const lifecycleNewest=observationRevision>Number(row.revision)&&observationRevision>ackRevision;
  const finalityRaw = fromRow(row, 'last_finality');
  return {
    exists: true, currency: asString(row.currency), policyVersionId: asString(row.policy_version_id),
    held: parseScaledDecimal(fromRow(row, 'held') ?? '0'), consumed: observationRevision>Number(row.settlement_revision)?parseScaledDecimal(fromRow(observation!, 'consumed_amount')??'0'):parseScaledDecimal(fromRow(row, 'consumed') ?? '0'),
    released: parseScaledDecimal(fromRow(row, 'released') ?? '0')+parseScaledDecimal(observation?fromRow(observation,'lifecycle_released')??'0':'0'), revision: Math.max(Number(row.revision),ackRevision,observationRevision),
    lastType: lifecycleNewest?asString(observation!.event_type):ackRevision>Number(row.revision)?'partial_acknowledged':asString(row.last_type),
    usageFinality: observationRevision>Number(row.revision)?observation?.usage_finality as 'unknown'|'partial'|'final':finalityRaw === 'partial' || finalityRaw === 'final' ? finalityRaw : 'unknown',
    everDispatched: row.ever_dispatched === true,
    firstType: fromRow(row, 'first_type') ?? '',
    originalBinding: row.original_binding ?? null,
    settlementSourceRef:sourcePosting.rows[0]?.source_reference??null,
    latestReportedUsage:reported.rows[0]?.usage_event as BudgetReportedUsage??null,
    authorizationRequest: row.authorization_request as ReservationRequest ?? null, financialExpiresAt: fromRow(row, 'financial_expires_at'), acknowledged: !!acknowledgement, acknowledgementEvidence: acknowledgement?.command_request ?? null, dispatchEvidence: row.dispatch_evidence ?? null,
  };
}

function stateFor(lastType: string, usageFinality: 'unknown' | 'partial' | 'final'): ReservationLifecycleState {
  switch (lastType) {
    case 'authorized': case 'partially_authorized': case 'partial_acknowledged': return 'held';
    case 'dispatched': return 'dispatched';
    case 'outcome_unknown':return 'outcome_unknown';
    case 'held_for_reconciliation':return 'held_for_reconciliation';
    case 'expense_corrected':return usageFinality==='final'?'settled':'partially_settled';
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

type CommandKind = 'mark_dispatched' | 'settle' | 'release' | 'acknowledge_partial'|'retain_unknown'|'expense_correction'|'expire_unresolved';

/** The normalized identity of a lifecycle command, compared against the stored event on replay. */
interface CommandIdentity {
  readonly eventType: 'dispatched' | 'settled' | 'released' | 'partial_acknowledged'|'outcome_unknown'|'expense_corrected'|'held_for_reconciliation';
  readonly consumed: bigint;
  readonly released: bigint;
  readonly usageFinality: 'unknown' | 'partial' | 'final' | null;
  readonly settlementSequence: number | null;
}

async function applyCommand(args: {
  requestId: string; idempotencyKey: string; scope: TrustedScope; reservationId: string; expectedRevision: number;
  currency: string; actorReference: string; sourceAuthorityRef: VersionedReference; attemptBinding: Record<string, unknown>;
  logicalOperationId: string; billableAttemptId: string; kind: CommandKind; identity: CommandIdentity;
  ports: BudgetRuntimePorts; operation: string; authority: FinanceOperation;
  command?: Record<string, unknown>;
  validateCurrent?(state: ReservationState): Promise<ApiResult<readonly TimedBudgetProof[]>>;
  appendFinancial?(state: ReservationState,client:BudgetTransactionPort,revision:number,retainProof:(proof:TimedBudgetProof)=>void):Promise<ApiResult<unknown>>;
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
      const initialScope=await authorizeScopeProof(scope,requestId,ports,args.operation,args.authority);
      gate.checkpoint();if(!initialScope.ok)return initialScope;
      const proofs:TimedBudgetProof[]=[initialScope.value];
      if (!trustedNow(ports)) return failure(makeError(args.operation, 'BUDGET_UNAVAILABLE', requestId, 'The trusted budget clock is unavailable.', true));

      client = await ports.database.connect();
      gate.checkpoint();
      await client.query('BEGIN');
      inTransaction = true;
      await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
      await bindFinancialDatabaseScope(client, scope);
      await bindDeadline(client, gate);
      // mark_dispatched carries no currency of its own; resolve it from the
      await requireBudgetSettlementCapability(client);gate.checkpoint();
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

      const storedReceipt=await client.query(`SELECT command_request,command_receipt FROM cost_intelligence.budget_command_receipts
        WHERE tenant_id=$1 AND project_id=$2 AND environment=$3 AND billing_mode=$4 AND idempotency_key=$5`,
        [scope.tenantId,scope.projectId,scope.environment,scope.billingMode,args.idempotencyKey]);
      if(storedReceipt.rows[0]){
        if(!args.command||!sameJson(storedReceipt.rows[0].command_request,normalizedBudgetRequest(args.command)))
          return failure(makeError(args.operation,'IDEMPOTENCY_CONFLICT',requestId,'The complete lifecycle request differs from its durable original receipt.'));
        const refreshed=await refreshScopeProof(scope,requestId,ports,args.operation,args.authority,gate,proofs);if(!refreshed.ok)return refreshed;
        if(!currentProofBound(ports,proofs))return unavailable();
        const original=structuredClone(storedReceipt.rows[0].command_receipt) as ReservationCommandOutcome;
        await rollback(client);inTransaction=false;
        return {ok:true,value:{...original,requestId,status:'replay'}};
      }

      const replay = await client.query(
        `SELECT reservation_id, event_type, event_sequence, currency, consumed_amount::text AS consumed_amount,
                released_amount::text AS released_amount, usage_finality, settlement_sequence, expected_revision, attempt_binding, actor_reference, source_authority_ref, command_evidence
         FROM cost_intelligence.budget_reservation_events
         WHERE tenant_id = $1 AND project_id = $2 AND environment = $3 AND billing_mode = $4 AND idempotency_key = $5
         UNION ALL
         SELECT reservation_id,'partial_acknowledged' AS event_type,event_sequence,currency,'0' AS consumed_amount,'0' AS released_amount,'unknown' AS usage_finality,NULL AS settlement_sequence,expected_revision,attempt_binding,actor_reference,source_authority_ref,command_request AS command_evidence
         FROM cost_intelligence.budget_reservation_acknowledgements
         WHERE tenant_id=$1 AND project_id=$2 AND environment=$3 AND billing_mode=$4 AND idempotency_key=$5
         ORDER BY event_sequence ASC LIMIT 1`,
        [scope.tenantId, scope.projectId, scope.environment, scope.billingMode, args.idempotencyKey],
      );
      if (replay.rows.length) {
        const row = replay.rows[0] as Record<string, unknown>;
        const identity = args.identity;
        const identical = fromRow(row,'actor_reference') === args.actorReference && sameJson(row.source_authority_ref,args.sourceAuthorityRef)
          && (!args.command || sameJson(row.command_evidence, normalizedBudgetRequest(args.command)))
          && fromRow(row, 'reservation_id') === args.reservationId
          && fromRow(row, 'event_type') === identity.eventType
          && fromRow(row, 'currency') === effectiveCurrency
          && Number(row.expected_revision) === args.expectedRevision
          && sameJson(row.attempt_binding, args.attemptBinding)
          && parseScaledDecimal(fromRow(row, 'consumed_amount') ?? '-1') === identity.consumed
          && parseScaledDecimal(fromRow(row, 'released_amount') ?? '-1') === identity.released
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
        const replayScope=await refreshScopeProof(scope,requestId,ports,args.operation,args.authority,gate,proofs);if(!replayScope.ok)return replayScope;
        gate.beginCommit();
        await client.query('COMMIT'); inTransaction = false;
        const acknowledgedScope=await refreshScopeProof(scope,requestId,ports,args.operation,args.authority,gate,proofs);if(!acknowledgedScope.ok)return unavailable();
        if(!currentProofBound(ports,proofs))return unavailable();
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

      const preliminary=args.compute(state);
      if('reject' in preliminary)return failure(preliminary.reject);
      if(args.validateCurrent){const verified=await gate.wait(args.validateCurrent(state));gate.checkpoint();if(!verified.ok){await rollback(client);inTransaction=false;return verified;}proofs.push(...verified.value);}
      const computed = args.compute(state);
      if ('reject' in computed) {
        await rollback(client); inTransaction = false;
        return failure(computed.reject);
      }

      const finalScope=await refreshScopeProof(scope,requestId,ports,args.operation,args.authority,gate,proofs);if(!finalScope.ok)return finalScope;
      const lifetimeRequest=args.kind==='mark_dispatched'||args.kind==='acknowledge_partial'?state.authorizationRequest??undefined:undefined;
      if(!currentProofBound(ports,proofs,lifetimeRequest))return failure(makeError(args.operation,'FORBIDDEN_SCOPE',requestId,'The mutation authority chain is no longer current.'));
      const nextSequence = state.revision + 1;
      if(args.appendFinancial){
        const transactionClient=client;
        const guardedClient:BudgetTransactionPort={release(){},async query(text,values){
          gate.checkpoint();const result=await transactionClient.query(text,values);gate.checkpoint();return result;
        }};
        const posting=await gate.wait(args.appendFinancial(state,guardedClient,nextSequence,proof=>proofs.push(structuredClone(proof))));gate.checkpoint();if(!posting.ok)return posting;
      }
      const eventId = globalThis.crypto.randomUUID();
      const contentHash = await hashValue({ reservationId: args.reservationId, sequence: nextSequence, type: computed.eventType, idempotencyKey: args.idempotencyKey });
      gate.checkpoint();
      if(args.kind==='retain_unknown'||args.kind==='expense_correction'||args.kind==='expire_unresolved'){
        await client.query(`INSERT INTO cost_intelligence.budget_lifecycle_observations
          (observation_id,tenant_id,project_id,environment,billing_mode,currency,reservation_id,event_sequence,expected_revision,idempotency_key,event_type,
            consumed_amount,released_amount,usage_finality,actor_reference,source_authority_ref,attempt_binding,command_request,command_evidence,content_hash)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::numeric,$13::numeric,$14,$15,$16::jsonb,$17::jsonb,$18::jsonb,$19::jsonb,$20)`,
          [eventId,scope.tenantId,scope.projectId,scope.environment,scope.billingMode,effectiveCurrency,args.reservationId,nextSequence,args.expectedRevision,
            args.idempotencyKey,computed.eventType,formatScaledDecimal(computed.consumed),formatScaledDecimal(computed.released),computed.usageFinality,
            args.actorReference,JSON.stringify(args.sourceAuthorityRef),JSON.stringify(args.attemptBinding),JSON.stringify(normalizedBudgetRequest(args.command!)),JSON.stringify(await persistedBudgetProofs(proofs)),contentHash]);
      }else if(args.kind==='acknowledge_partial'){
        await client.query(`INSERT INTO cost_intelligence.budget_reservation_acknowledgements (acknowledgement_id,tenant_id,project_id,environment,billing_mode,currency,reservation_id,event_sequence,expected_revision,idempotency_key,actor_reference,source_authority_ref,attempt_binding,command_request,content_hash) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14::jsonb,$15)`,[eventId,scope.tenantId,scope.projectId,scope.environment,scope.billingMode,effectiveCurrency,args.reservationId,nextSequence,args.expectedRevision,args.idempotencyKey,args.actorReference,JSON.stringify(args.sourceAuthorityRef),JSON.stringify(args.attemptBinding),JSON.stringify(normalizedBudgetRequest(args.command!)),contentHash]);
      } else {
      await client.query(
        `INSERT INTO cost_intelligence.budget_reservation_events
          (reservation_event_id, tenant_id, project_id, environment, billing_mode, currency, reservation_id, event_sequence,
           event_type, decision_status, held_amount, consumed_amount, released_amount, estimate_completeness, known_subtotal,
           bounded_maximum, allow_partial, partial_allowed_amount, usage_finality, settlement_sequence, policy_version_id,
           rate_card_ref, policy_ref, idempotency_key, expected_revision, actor_reference, source_authority_ref,
           attempt_binding, logical_operation_id, billable_attempt_id, content_hash, command_evidence)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NULL,0,$10::numeric,$11::numeric,NULL,NULL,NULL,false,NULL,$12,$13,$14,
           NULL,$15::jsonb,$16,$17,$18,$19::jsonb,$20::jsonb,$21,$22,$23,$24::jsonb)`,
        [eventId, scope.tenantId, scope.projectId, scope.environment, scope.billingMode, effectiveCurrency, args.reservationId, nextSequence,
          computed.eventType, formatScaledDecimal(computed.consumed), formatScaledDecimal(computed.released), computed.usageFinality,
          computed.settlementSequence, state.policyVersionId, JSON.stringify(args.sourceAuthorityRef), args.idempotencyKey,
          args.expectedRevision, args.actorReference, JSON.stringify(args.sourceAuthorityRef), JSON.stringify(args.attemptBinding),
          args.logicalOperationId, args.billableAttemptId, contentHash, args.command ? JSON.stringify(normalizedBudgetRequest(args.command)) : null],
      );
      }
      const refreshed = await loadReservation(client, scope, args.reservationId);
      if(args.validateCurrent){const source=await gate.wait(args.validateCurrent(state));gate.checkpoint();if(!source.ok)return source;proofs.push(...source.value);}
      const beforeCommit=await refreshScopeProof(scope,requestId,ports,args.operation,args.authority,gate,proofs);if(!beforeCommit.ok)return beforeCommit;
      if(!currentProofBound(ports,proofs,lifetimeRequest))return unavailable();
      if(args.command&&refreshed){
        const receipt=outcomeFrom(requestId,'applied',args.reservationId,refreshed),safeProofs=await persistedBudgetProofs(proofs);
        await client.query(`INSERT INTO cost_intelligence.budget_command_receipts
          (receipt_id,tenant_id,project_id,environment,billing_mode,idempotency_key,reservation_id,command_request,command_receipt,command_evidence,content_hash)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11)`,
          [crypto.randomUUID(),scope.tenantId,scope.projectId,scope.environment,scope.billingMode,args.idempotencyKey,args.reservationId,
            JSON.stringify(normalizedBudgetRequest(args.command)),JSON.stringify(receipt),JSON.stringify(safeProofs),await budgetDigest({command:normalizedBudgetRequest(args.command),receipt,proofs:safeProofs})]);
      }
      gate.checkpoint();if(!currentProofBound(ports,proofs,lifetimeRequest))return unavailable();
      gate.beginCommit();
      await client.query('COMMIT'); inTransaction = false;
      if(args.validateCurrent){const source=await gate.wait(args.validateCurrent(state));gate.checkpoint();if(!source.ok)return unavailable();proofs.push(...source.value);}
      const acknowledgedScope=await refreshScopeProof(scope,requestId,ports,args.operation,args.authority,gate,proofs);if(!acknowledgedScope.ok)return unavailable();
      if(!currentProofBound(ports,proofs,lifetimeRequest))return unavailable();
      return { ok: true, value: outcomeFrom(requestId, 'applied', args.reservationId, refreshed ?? state) };
    } catch {
      if (client && inTransaction) await rollback(client);
      return unavailable();
    } finally {
      if(client&&inTransaction)await rollback(client);
      client?.release();
    }
  });
}

export async function markReservationDispatched(value: unknown, ports: BudgetRuntimePorts): Promise<ApiResult<ReservationCommandOutcome>> {
  const { Value } = requireValue();
  if (!Value.Check(markSchema(), value)) return failure(makeError('markDispatched', 'VALIDATION_ERROR', requestIdOf(value), 'The mark-dispatched command does not match the published schema.'));
  const request = structuredClone(value) as MarkDispatchedCommand;
  return applyCommand({
    requestId: request.requestId, idempotencyKey: request.idempotencyKey, scope: request.scope as TrustedScope,
    reservationId: request.reservationId, expectedRevision: request.expectedRevision, currency: '',
    actorReference: request.actorReference, sourceAuthorityRef: request.sourceAuthorityRef as VersionedReference,
    attemptBinding: request.attemptBinding as unknown as Record<string, unknown>,
    logicalOperationId: request.attemptBinding.logicalOperationId, billableAttemptId: request.attemptBinding.billableAttemptId,
    command: request as unknown as Record<string, unknown>,
    validateCurrent: async state => validateDispatchEvidence(state, request, ports),
    kind: 'mark_dispatched', ports, operation: 'markDispatched', authority: 'budgets.markDispatched',
    identity: { eventType: 'dispatched', consumed: 0n, released: 0n, usageFinality: 'unknown', settlementSequence: null },
    compute(state) {
      if (state.lastType !== 'authorized' && state.lastType !== 'partially_authorized' && state.lastType !== 'partial_acknowledged') {
        return { reject: makeError('markDispatched', 'VALIDATION_ERROR', request.requestId, 'Only a held reservation can be dispatched.') };
      }
      // A partial authorization needs validated caller acknowledgement/replan evidence. The
      // pinned MarkDispatched contract carries none, so dispatch stays unavailable (hold preserved).
      if (state.firstType === 'partially_authorized' && !state.acknowledged) {
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
  return verifiedSettlement(value,ports,false);
}
export async function correctReservationExpense(value:unknown,ports:BudgetRuntimePorts):Promise<ApiResult<ReservationCommandOutcome>>{
  return verifiedSettlement(value,ports,true);
}
async function verifiedSettlement(value:unknown,ports:BudgetRuntimePorts,correction:boolean):Promise<ApiResult<ReservationCommandOutcome>>{
  const native=typeof value==='object'&&value!==null&&'schemaVersion' in value&&value.schemaVersion==='2.0.0';
  const validated:Validation<SettleReservationCommand|VerifiedSettlementRequest|VerifiedExpenseCorrectionRequest>=native?
    (correction?Value.Check(VerifiedExpenseCorrectionRequestSchema,value):Value.Check(VerifiedSettlementRequestSchema,value))?{ok:true,value:structuredClone(value) as VerifiedSettlementRequest|VerifiedExpenseCorrectionRequest}:
      {ok:false,error:makeError('settle','VALIDATION_ERROR',requestIdOf(value),'The Finance USD18 settlement request does not match its versioned schema.')}:
    validateSettleReservationCommandBoundary(value);
  if (!validated.ok) return failure(validated.error);
  const request = structuredClone(validated.value);
  const currency = request.settlement.currency;
  const cumulative = parseScaledDecimal(request.settlement.cumulativeAmount);
  const consumed = 'canonicalCommand' in request?request.canonicalCommand.consumed:null;
  if (consumed&&'canonicalCommand' in request&&(consumed.currency !== currency || request.canonicalCommand.currency !== currency
      || parseScaledDecimal(consumed.amount) !== cumulative)) {
    return failure(makeError('settle', 'VALIDATION_ERROR', request.requestId, 'The canonical settlement amount and currency contradict the settlement.'));
  }
  if(currency!=='USD')return failure(makeError('settle','VALIDATION_ERROR',request.requestId,'Provider reported settlement is scoped to USD.'));
  let accepted:ResolvedBudgetReportedCost|null=null;
  let finalSource:AuthenticatedBudgetSource|null=null;
  let finality:'partial'|'final'='partial';
  const sourceQuery=(state:ReservationState)=>({scope:request.scope as TrustedScope,reference:request.sourceAuthorityRef,
    kind:'reported_cost' as const,...(state.authorizationRequest?.authorityBinding?{
      provider:state.authorizationRequest.authorityBinding.provider,model:state.authorizationRequest.authorityBinding.model,
      operation:state.authorizationRequest.authorityBinding.operation,targetBindingSha256:state.authorizationRequest.authorityBinding.targetBindingSha256,
      authorityBinding:state.authorizationRequest.authorityBinding}:{}),attempt:request.attemptBinding});
  async function verify(state:ReservationState):Promise<ApiResult<readonly TimedBudgetProof[]>>{
    if(!ports.reportedCostContractMode||(ports.reportedCostContractMode==='development_0_10_1'&&request.scope.environment==='production'))
      return failure(makeError('settle','SOURCE_UNAVAILABLE',request.requestId,'The reported-cost contract requires an explicit private development mount.'));
    if(!ports.sourceCollector)return failure(makeError('settle','SOURCE_UNAVAILABLE',request.requestId,'The authenticated collector source is not configured.'));
    accepted=await resolveBudgetReportedCost(ports.sourceCollector,ports.clock,sourceQuery(state),ports.reportedCostContractMode,state.latestReportedUsage??undefined);
    if(!accepted||parseScaledDecimal(accepted.evidence.reported_cost.state==='known'?accepted.evidence.reported_cost.money.amount:'-1')!==cumulative
      ||accepted.amountSemantics!=='cumulative_attempt_total')return failure(makeError('settle','VALIDATION_ERROR',request.requestId,'The settlement must match current authenticated cumulative attempt cost.'));
    const proofs:TimedBudgetProof[]=[accepted.source];
    finality='partial';
    if(request.settlement.finality==='final'){
      if(!request.settlement.finalityEvidenceRef)return failure(makeError('settle','SOURCE_UNAVAILABLE',request.requestId,'Complete billing finality is required independently of reported cost.'));
      finalSource=await resolveExecutionFinality(ports.sourceCollector,ports.clock,{...sourceQuery(state),kind:'execution_finality',reference:request.settlement.finalityEvidenceRef});
      if(!finalSource||!Value.Check(BudgetExecutionFinalitySchema,finalSource.record.payload)
        ||finalSource.record.payload.state!=='final_billed'||!sameJson(finalSource.record.payload.cumulativeCostRef,request.sourceAuthorityRef))
        return failure(makeError('settle','VALIDATION_ERROR',request.requestId,'Current final billing evidence must bind this exact cumulative source.'));
      proofs.push(finalSource);finality='final';
    }
    if(!currentProofBound(ports,proofs))return failure(makeError('settle','SOURCE_UNAVAILABLE',request.requestId,'Current source evidence expired while verifying finality.'));
    return {ok:true,value:proofs};
  }
  return applyCommand({
    requestId: request.requestId, idempotencyKey: request.idempotencyKey, scope: request.scope as TrustedScope,
    reservationId: request.reservationId, expectedRevision: request.expectedRevision, currency,
    actorReference: request.actorReference, sourceAuthorityRef: request.sourceAuthorityRef as VersionedReference,
    attemptBinding: request.attemptBinding as unknown as Record<string, unknown>,
    logicalOperationId: request.attemptBinding.logicalOperationId, billableAttemptId: request.attemptBinding.billableAttemptId,
    command: request as unknown as Record<string,unknown>,
    kind:correction?'expense_correction':'settle', ports, operation:correction?'recordExpenseAdjustment':'settle', authority:correction?'budgets.recordExpenseAdjustment':'budgets.settle',
    identity: { eventType: 'settled', consumed: cumulative, released: 0n, usageFinality: null, settlementSequence: request.settlement.sequence },
    validateCurrent:verify,
    async appendFinancial(state,client,revision,retainProof){
      if(!accepted)return failure(makeError('settle','SOURCE_UNAVAILABLE',request.requestId,'Verified original reported cost is required.'));
      const posted=await postAuthenticatedSettlement(client,ports,request,state,revision,accepted,correction?'budgets.recordExpenseAdjustment':'budgets.settle',retainProof);
      if(!posted.ok)return posted;
      // Refresh original source/finality after the ledger append's asynchronous authorization and DB work.
      const refreshed=await verify(state);if(!refreshed.ok)return refreshed;
      if(cumulative>state.held)await appendBudgetException(client,request.scope,currency,request.reservationId,revision,'over_cap','unresolved',cumulative-state.held,
        request.idempotencyKey,request as unknown as Record<string,unknown>,request.sourceAuthorityRef);
      if(finality==='final'){
        const unknown=await client.query(`SELECT exception_id FROM cost_intelligence.budget_reconciliation_exceptions
          WHERE tenant_id=$1 AND project_id=$2 AND environment=$3 AND billing_mode=$4 AND reservation_id=$5 AND reason='outcome_unknown' LIMIT 1`,
          [request.scope.tenantId,request.scope.projectId,request.scope.environment,request.scope.billingMode,request.reservationId]);
        if(unknown.rows.length)await appendBudgetException(client,request.scope,currency,request.reservationId,revision,'outcome_unknown','resolved',0n,request.idempotencyKey,
          request as unknown as Record<string,unknown>,request.settlement.finalityEvidenceRef!);
        if(finalSource)await persistBudgetSource(client,finalSource);
      }
      return posted;
    },
    compute(state) {
      if (!sameJson(state.originalBinding, request.attemptBinding)) return attemptMismatch('settle', request.requestId);
      if(correction){
        if(!('correction' in request)||request.correction.originalSourceObservationId!==state.latestReportedUsage?.source_observation_id||cumulative>=state.consumed)
          return {reject:makeError('recordExpenseAdjustment','VALIDATION_ERROR',request.requestId,'A decrease requires its current immutable observation predecessor and a genuinely lower verified actual.')};
      }else if (cumulative < state.consumed) return { reject: makeError('settle', 'VALIDATION_ERROR', request.requestId,
        'Cumulative settlement cannot decrease consumption without separately authorized correction evidence.') };
      const unused=state.held-state.released-cumulative;
      return {eventType:correction?'expense_corrected':'settled',consumed:cumulative,released:finality==='final'&&unused>0n?unused:0n,
        usageFinality:finality,settlementSequence:request.settlement.sequence};
    },
  });
}

async function persistBudgetSource(client:BudgetTransactionPort,source:AuthenticatedBudgetSource):Promise<string>{
  const scope=source.record.scope,safe=await budgetSourcePersistence(source);
  const prior=await client.query(`SELECT observation_id,record_hash,financial_source_facts,collector_record FROM cost_intelligence.budget_source_observations
    WHERE tenant_id=$1 AND project_id=$2 AND environment=$3 AND billing_mode=$4 AND record_id=$5 AND record_revision=$6`,
    [scope.tenantId,scope.projectId,scope.environment,scope.billingMode,source.record.id,source.record.revision]);
  if(prior.rows[0]){
    if(prior.rows[0].record_hash!==source.recordHash||!sameJson(prior.rows[0].financial_source_facts,safe.financialFacts)||!sameJson(prior.rows[0].collector_record,safe.collectorRecord))throw new Error('Conflicting source revision');
    return asString(prior.rows[0].observation_id);
  }
  const id=crypto.randomUUID();
  await client.query(`INSERT INTO cost_intelligence.budget_source_observations
    (observation_id,tenant_id,project_id,environment,billing_mode,record_id,record_revision,record_hash,predecessor_hash,source_bytes_hash,source_reference,collector_record,current_evidence,authentication_evidence,financial_source_facts)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13::jsonb,$14::jsonb,$15::jsonb)`,
    [id,scope.tenantId,scope.projectId,scope.environment,scope.billingMode,source.record.id,source.record.revision,source.recordHash,source.record.predecessorHash,
      source.record.sourceBytesSha256,JSON.stringify(source.reference),JSON.stringify(safe.collectorRecord),JSON.stringify(source.current),JSON.stringify(source.authentication),JSON.stringify(safe.financialFacts)]);
  return id;
}
async function postAuthenticatedSettlement(client:BudgetTransactionPort,ports:BudgetRuntimePorts,request:SettleReservationCommand|VerifiedSettlementRequest|VerifiedExpenseCorrectionRequest,
  state:ReservationState,revision:number,accepted:ResolvedBudgetReportedCost,authority:'budgets.settle'|'budgets.recordExpenseAdjustment',retainProof:(proof:TimedBudgetProof)=>void):Promise<ApiResult<unknown>>{
  const scope=request.scope as TrustedScope,usage=accepted.usage;
  const observationId=await persistBudgetSource(client,accepted.source);
  const previousObservation=await client.query(`SELECT reservation_id,usage_event,provider_evidence,ledger_event_id
    FROM cost_intelligence.budget_reported_observations
    WHERE tenant_id=$1 AND project_id=$2 AND environment=$3 AND billing_mode=$4 AND source_observation_id=$5`,
    [scope.tenantId,scope.projectId,scope.environment,scope.billingMode,usage.source_observation_id]);
  const duplicate=previousObservation.rows[0];
  if(duplicate){
    const relationship=compareBudgetReportedUsage(duplicate.usage_event as BudgetReportedUsage,usage);
    if(duplicate.reservation_id!==request.reservationId||!relationship.ok||relationship.value!=='duplicate_observation'
      ||!sameJson(duplicate.provider_evidence,accepted.evidence))
      return failure(makeError('settle','IDEMPOTENCY_CONFLICT',request.requestId,'The durable reported observation has different economic facts or ownership.'));
    await linkSettlementPosting(client,request,revision,observationId,asString(duplicate.ledger_event_id),accepted);
    return {ok:true,value:null};
  }
  const evidenceRevision=await client.query(`SELECT source_observation_id,provider_evidence_hash FROM cost_intelligence.budget_reported_observations
    WHERE tenant_id=$1 AND project_id=$2 AND environment=$3 AND billing_mode=$4 AND provider_evidence_id=$5 AND provider_evidence_revision=$6`,
    [scope.tenantId,scope.projectId,scope.environment,scope.billingMode,accepted.evidence.evidence_id,accepted.evidence.revision]);
  if(evidenceRevision.rows.length)return failure(makeError('settle','IDEMPOTENCY_CONFLICT',request.requestId,'The provider evidence revision already belongs to another immutable observation.'));
  if(state.latestReportedUsage){
    const relationship=compareBudgetReportedUsage(state.latestReportedUsage,usage);
    if(!relationship.ok||relationship.value!=='superseding_observation')return failure(makeError('settle','IDEMPOTENCY_CONFLICT',request.requestId,
      'A changed cumulative total must supersede the current durable observation of this exact attempt.'));
  }else if(usage.supersedes_observation_id!==null){
    return failure(makeError('settle','IDEMPOTENCY_CONFLICT',request.requestId,'The observation predecessor is not present in this reservation.'));
  }
  // Reuse the existing attempt's economic source lineage: an intake estimate is replaced, never added again.
  const existing=await client.query(`SELECT e.* FROM cost_intelligence.financial_ledger_events e
    JOIN cost_intelligence.financial_source_revision_heads h ON h.current_event_id=e.event_id
    WHERE e.tenant_id=$1 AND e.project_id=$2 AND e.environment=$3 AND e.billing_mode=$4
      AND e.billable_attempt_id=$5 AND e.currency='USD' AND e.financial_effect=true
      AND e.classification='supplier_expense' AND e.logical_operation_id=$6
      AND e.provider_attempt_id=$7 AND e.provider_request_id IS NOT DISTINCT FROM $8::text
      AND e.event_payload#>>'{dimensions,provider}'=$9 AND e.event_payload#>>'{dimensions,model}'=$10
      AND e.source_name IN ('ci04a-usage-intake','ci05b-reported-cost')`,
    [scope.tenantId,scope.projectId,scope.environment,scope.billingMode,request.attemptBinding.billableAttemptId,request.attemptBinding.logicalOperationId,
      request.attemptBinding.providerAttemptId,request.attemptBinding.providerRequestId,accepted.usage.provider,accepted.usage.model]);
  if(existing.rows.length>1)return failure(makeError('settle','VALIDATION_ERROR',request.requestId,
    'Multiple distinct economic expenses cannot be collapsed into an unattributed cumulative attempt total.'));
  const predecessor=existing.rows[0];
  const prior=predecessor?.event_payload as LedgerAppendRequest|undefined;
  const amount=request.settlement.cumulativeAmount,eventId=crypto.randomUUID();
  const known=(id:string|null)=>id===null?{status:'unknown' as const}:{status:'known' as const,id};
  const ledgerRequest:LedgerAppendRequest={schemaVersion:'1.0.0',requestId:request.requestId,idempotencyKey:`ci05b:${request.idempotencyKey}`,
    scope,eventId,correlationId:usage.correlation_id,producer:{module:usage.producer.module,sourceRevision:usage.producer.source_revision,buildRevision:usage.producer.build_revision},
    occurredAt:usage.occurred_at,observedAt:usage.observed_at,evidenceMode:accepted.source.record.evidenceMode,
    verificationStatus:'verified',eventType:predecessor?'correction':'consumption',classification:prior?.classification??'supplier_expense',
    valuation:'provider_reported_unsettled',settlementStatus:'unpaid',reconciliationStatus:'unmatched',reservationLifecycle:null,
    identities:{logicalOperationId:request.attemptBinding.logicalOperationId,sourceObservationId:usage.source_observation_id,reservationId:prior?.identities.reservationId??null},
    postingMapping:prior?.postingMapping??{schemaVersion:'1.0.0',sourceLineId:request.attemptBinding.billableAttemptId,
      transportAttemptId:known(request.attemptBinding.transportAttemptId),providerAttemptId:known(request.attemptBinding.providerAttemptId),
      providerRequestId:known(request.attemptBinding.providerRequestId),billableAttemptId:known(request.attemptBinding.billableAttemptId)},
    sourceIdentity:{source:prior?.sourceIdentity.source??'ci05b-reported-cost',sourceEventId:usage.source_observation_id,
      sourceObjectId:prior?.sourceIdentity.sourceObjectId??request.attemptBinding.billableAttemptId,
      revisionSubjectId:prior?.sourceIdentity.revisionSubjectId??request.attemptBinding.billableAttemptId,
      sourceRevision:`collector:${accepted.source.record.id}:${accepted.source.record.revision}`,
      revisionSequence:predecessor?Number(predecessor.source_revision_sequence)+1:1,contentHash:accepted.source.recordHash},
    usage:{completeness:usage.completeness,missingFields:[...usage.missing_fields],units:(usage.usage_units??[]).map(unit=>({
      name:unit.name,quantity:unit.quantity,scale:unit.scale,relation:unit.relation,...(unit.included_in!==undefined?{includedIn:unit.included_in}:{})}))},
    money:{amount,currency:'USD',scale:amount.split('.')[1]?.length??0},sourceRefs:[accepted.source.reference,usage.valuation.basis==='provider_reported_unsettled'?usage.valuation.provider_evidence_ref:accepted.source.reference],
    dimensions:{provider:usage.provider,model:usage.model},pricing:null,fxEvidence:null,financialEffect:true,
    reservationAuthorizationEventId:prior?.reservationAuthorizationEventId??null,supersedesEventId:predecessor?asString(predecessor.event_id):null,reversesEventId:null};
  const appended=await appendBudgetLedgerEventInTransaction(ledgerRequest,client,ports,authority,retainProof);
  if(!appended.ok)return appended;
  if(appended.value.status!=='accepted'&&appended.value.status!=='duplicate')return failure(makeError('settle','IDEMPOTENCY_CONFLICT',request.requestId,'Ledger settlement conflicts with the durable economic source.'));
  const postedId=appended.value.status==='duplicate'?appended.value.existingEventId:appended.value.eventId;
  if(!postedId)return failure(makeError('settle','SOURCE_UNAVAILABLE',request.requestId,'The ledger did not identify its durable expense.'));
  await client.query(`INSERT INTO cost_intelligence.budget_reported_observations
    (tenant_id,project_id,environment,billing_mode,source_observation_id,reservation_id,reservation_revision,
     usage_event,provider_evidence,provider_evidence_id,provider_evidence_revision,provider_evidence_hash,
     supersedes_observation_id,observation_digest,collector_observation_id,ledger_event_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12,$13,$14,$15,$16)`,
    [scope.tenantId,scope.projectId,scope.environment,scope.billingMode,usage.source_observation_id,request.reservationId,revision,
      JSON.stringify(usage),JSON.stringify(accepted.evidence),accepted.evidence.evidence_id,accepted.evidence.revision,
      accepted.evidence.content_hash,usage.supersedes_observation_id,await budgetDigest(usage),observationId,postedId]);
  await linkSettlementPosting(client,request,revision,observationId,postedId,accepted);
  return appended;
}
async function linkSettlementPosting(client:BudgetTransactionPort,request:SettleReservationCommand|VerifiedSettlementRequest|VerifiedExpenseCorrectionRequest,
  revision:number,observationId:string,postedId:string,accepted:ResolvedBudgetReportedCost):Promise<void>{
  const scope=request.scope;
  // Explicit economic coverage is derived from authenticated cumulative attempt
  // identity and observation time, never from coincident amounts or API-key totals.
  const covered=await client.query(`SELECT source_observation_id FROM cost_intelligence.usage_intake_inbox
    WHERE tenant_id=$1 AND project_id=$2 AND environment=$3 AND billing_mode=$4 AND attempt_revision_accepted
      AND billable_attempt_id=$5 AND logical_operation_id=$6 AND provider_attempt_id=$7
      AND provider_request_id IS NOT DISTINCT FROM $8::text AND observed_at<=$9::timestamptz
      AND (event_facts#>>'{valuation,money,currency}' IS NULL OR event_facts#>>'{valuation,money,currency}'='USD')
      AND event_facts->>'provider'=$10 AND event_facts->>'model'=$11 ORDER BY source_observation_id`,
    [scope.tenantId,scope.projectId,scope.environment,scope.billingMode,accepted.usage.billable_attempt_id,accepted.usage.logical_operation_id,
      accepted.usage.provider_attempt_id,accepted.usage.provider_request_id,accepted.usage.observed_at,accepted.usage.provider,accepted.usage.model]);
  await client.query(`INSERT INTO cost_intelligence.budget_settlement_postings
    (posting_id,tenant_id,project_id,environment,billing_mode,currency,reservation_id,reservation_revision,observation_id,ledger_event_id,amount_semantics,cumulative_amount,intake_observation_ids)
    VALUES($1,$2,$3,$4,$5,'USD',$6,$7,$8,$9,'cumulative_attempt_total',$10::numeric,$11::jsonb)`,
    [crypto.randomUUID(),scope.tenantId,scope.projectId,scope.environment,scope.billingMode,request.reservationId,revision,observationId,postedId,request.settlement.cumulativeAmount,
      JSON.stringify(covered.rows.map(row=>asString(row.source_observation_id)))]);
}

export async function releaseReservation(value: unknown, ports: BudgetRuntimePorts): Promise<ApiResult<ReservationCommandOutcome>> {
  const native=typeof value==='object'&&value!==null&&'schemaVersion' in value&&value.schemaVersion==='2.0.0';
  const validated:Validation<ReleaseReservationCommand|VerifiedReleaseRequest>=native?
    Value.Check(VerifiedReleaseRequestSchema,value)?{ok:true,value:structuredClone(value)}:
      {ok:false,error:makeError('release','VALIDATION_ERROR',requestIdOf(value),'The Finance release request is invalid.')}:
    validateReleaseReservationCommandBoundary(value);
  if (!validated.ok) return failure(validated.error);
  const request = structuredClone(validated.value);
  const currency = request.release.currency;
  const releaseAmount = parseScaledDecimal(request.release.amount);
  let proof:AuthenticatedBudgetSource|null=null;
  // The pinned ReleaseRequest carries an economic currency but no amount; that currency must agree with the wrapper.
  if ('canonicalCommand' in request&&request.canonicalCommand.currency !== currency) {
    return failure(makeError('release', 'VALIDATION_ERROR', request.requestId, 'The canonical release currency contradicts the release.'));
  }
  return applyCommand({
    requestId: request.requestId, idempotencyKey: request.idempotencyKey, scope: request.scope as TrustedScope,
    reservationId: request.reservationId, expectedRevision: request.expectedRevision, currency,
    actorReference: request.actorReference, sourceAuthorityRef: request.sourceAuthorityRef as VersionedReference,
    attemptBinding: request.attemptBinding as unknown as Record<string, unknown>,
    logicalOperationId: request.attemptBinding.logicalOperationId, billableAttemptId: request.attemptBinding.billableAttemptId,
    command: request as unknown as Record<string,unknown>,
    kind: 'release', ports, operation: 'release', authority: 'budgets.release',
    identity: { eventType: 'released', consumed: 0n, released: releaseAmount, usageFinality: null, settlementSequence: null },
    async validateCurrent(state){
      if(!ports.sourceCollector)return failure(makeError('release','SOURCE_UNAVAILABLE',request.requestId,'Current independently collected release finality is required. The hold is preserved.'));
      const binding=state.authorizationRequest?.authorityBinding;
      proof=await resolveExecutionFinality(ports.sourceCollector,ports.clock,{scope:request.scope,
        reference:request.sourceAuthorityRef,kind:'execution_finality',attempt:request.attemptBinding,
        ...(binding?{provider:binding.provider,model:binding.model,operation:binding.operation,targetBindingSha256:binding.targetBindingSha256,authorityBinding:binding}:{})});
      if(!proof||!Value.Check(BudgetExecutionFinalitySchema,proof.record.payload))return failure(makeError('release','SOURCE_UNAVAILABLE',request.requestId,'No current authenticated release finality was resolved. The hold is preserved.'));
      const evidence=proof.record.payload;
      if(request.release.proof==='never_dispatched_fenced'){
        if(evidence.state!=='fenced_not_dispatched'||evidence.fenceReference===null||evidence.dispatchIntentRef!==null||state.everDispatched)
          return failure(makeError('release','VALIDATION_ERROR',request.requestId,'A current fence must prove no dispatch in the exact attempt.'));
      }else if(evidence.state==='final_no_bill'){
        if(state.consumed!==0n||evidence.dispatchIntentRef===null||!sameJson(evidence.dispatchIntentRef,(state.dispatchEvidence as MarkDispatchedCommand|null)?.dispatchIntentRef))
          return failure(makeError('release','VALIDATION_ERROR',request.requestId,'No-bill finality cannot erase known spend and must bind durable dispatch intent.'));
      }else if(evidence.state!=='final_billed'||state.usageFinality!=='final'||evidence.cumulativeCostRef===null
        ||!sameJson(evidence.cumulativeCostRef,state.settlementSourceRef)){
        return failure(makeError('release','VALIDATION_ERROR',request.requestId,'Final release requires posted complete actual expense or authenticated no-bill finality.'));
      }
      return {ok:true,value:[proof]};
    },
    async appendFinancial(state,client){
      if(!proof)return failure(makeError('release','SOURCE_UNAVAILABLE',request.requestId,'Release proof is unavailable.'));
      if(Value.Check(BudgetExecutionFinalitySchema,proof.record.payload)&&proof.record.payload.state==='final_no_bill'){
        const expense=await client.query(`SELECT e.amount FROM cost_intelligence.financial_ledger_events e
          JOIN cost_intelligence.financial_source_revision_heads h ON h.current_event_id=e.event_id
          WHERE e.tenant_id=$1 AND e.project_id=$2 AND e.environment=$3 AND e.billing_mode=$4 AND e.billable_attempt_id=$5
            AND e.financial_effect AND e.classification IN ('direct_cost','supplier_expense','operating_expense','payable_labor')
            AND coalesce(${budgetExpenseAxisSql('e')},'unresolved') NOT IN ('cash_movement','revenue')
            AND ${budgetCurrentLedgerHeadSql('e')}
            AND (e.amount IS NULL OR e.amount<>0) LIMIT 1`,
          [request.scope.tenantId,request.scope.projectId,request.scope.environment,request.scope.billingMode,request.attemptBinding.billableAttemptId]);
        if(expense.rows.length)return failure(makeError('release','VALIDATION_ERROR',request.requestId,'No-bill finality cannot replace a known or unresolved expense; record genuine zero/correction evidence first.'));
      }
      await persistBudgetSource(client,proof);return {ok:true,value:null};
    },
    compute(state) {
      if (!sameJson(state.originalBinding, request.attemptBinding)) return attemptMismatch('release', request.requestId);
      const remaining = state.held - state.released - state.consumed;
      const floorRemaining = remaining > 0n ? remaining : 0n;
      if (state.lastType === 'released' || state.lastType === 'expired') {
        return { reject: makeError('release', 'VALIDATION_ERROR', request.requestId, 'A released or expired reservation has no outstanding hold to release.') };
      }
      if (releaseAmount !== floorRemaining) {
        return { reject: makeError('release', 'VALIDATION_ERROR', request.requestId, 'A terminal release must release exactly the unused hold; partial release cannot strand commitments.') };
      }
      // Capacity is released only on authoritative durable evidence; caller-supplied
      // refs are not evidence. Otherwise the hold is preserved and the failure is typed.
      const preserved = (message: string) => ({ reject: makeError('release', 'BUDGET_UNAVAILABLE', request.requestId, `${message} The hold is preserved.`) });
      if (request.release.proof === 'never_dispatched_fenced') {
        const held = state.lastType === 'authorized' || state.lastType === 'partially_authorized'||state.lastType==='partial_acknowledged'||state.lastType==='held_for_reconciliation';
        if (state.everDispatched || !held) {
          return preserved('Never-dispatched release is refused: the durable state shows dispatch or an unresolved lifecycle.');
        }
        // Releasing the entire hold moves the reservation to `released`, which fences any later dispatch.
        if (releaseAmount !== floorRemaining) {
          return preserved('Never-dispatched release must release the whole hold so that a late worker is fenced.');
        }
      } else if (proof?.record.payload&&Value.Check(BudgetExecutionFinalitySchema,proof.record.payload)&&proof.record.payload.state!=='final_no_bill'
        &&(state.lastType !== 'settled' || state.usageFinality !== 'final')) {
        return preserved('Final-usage release is refused: the reservation has no final settlement.');
      }
      return { eventType: 'released', consumed: 0n, released: releaseAmount, usageFinality: proof?.record.payload&&Value.Check(BudgetExecutionFinalitySchema,proof.record.payload)
        && ['final_no_bill','fenced_not_dispatched'].includes(proof.record.payload.state)?'final':state.usageFinality, settlementSequence: null };
    },
  });
}

export const RetainUnknownOutcomeRequestSchema=Type.Object({
  schemaVersion:Type.Literal('1.0.0'),requestId:Type.String({minLength:1}),idempotencyKey:Type.String({minLength:1}),
  scope:Type.Object({tenantId:Type.String({minLength:1}),projectId:Type.String({minLength:1}),environment:Type.Union([Type.Literal('development'),Type.Literal('test'),Type.Literal('production')]),
    billingMode:Type.Union([Type.Literal('live'),Type.Literal('sandbox'),Type.Literal('simulated')]),actorId:Type.String({minLength:1})},{additionalProperties:false}),
  reservationId:Type.String({minLength:1}),expectedRevision:Type.Integer({minimum:1}),actorReference:Type.String({minLength:1}),
  sourceAuthorityRef:VersionedReferenceSchema,
  attemptBinding:Type.Object({logicalOperationId:Type.String({minLength:1}),providerAttemptId:Type.String({minLength:1}),billableAttemptId:Type.String({minLength:1}),
    transportAttemptId:Type.String({minLength:1}),providerRequestId:Type.Union([Type.String({minLength:1}),Type.Null()])},{additionalProperties:false}),
  outcome:Type.Union([Type.Literal('timeout'),Type.Literal('aborted_after_send'),Type.Literal('network_error_after_send'),Type.Literal('http_error'),Type.Literal('unobserved_transport_outcome')]),
  httpStatus:Type.Union([Type.Integer({minimum:100,maximum:599}),Type.Null()]),dispatchIntentRef:VersionedReferenceSchema,
},{additionalProperties:false});
export type RetainUnknownOutcomeRequest=Static<typeof RetainUnknownOutcomeRequestSchema>;
/** An outcome statement can only preserve commitments and queue investigation; it never proves no billing. */
export async function retainReservationUnknown(value:unknown,ports:BudgetRuntimePorts):Promise<ApiResult<ReservationCommandOutcome>>{
  if(!Value.Check(RetainUnknownOutcomeRequestSchema,value))return failure(makeError('retainUnknown','VALIDATION_ERROR',requestIdOf(value),'The unknown outcome request is malformed.'));
  const request=structuredClone(value);
  return applyCommand({requestId:request.requestId,idempotencyKey:request.idempotencyKey,scope:request.scope,reservationId:request.reservationId,
    expectedRevision:request.expectedRevision,currency:'',actorReference:request.actorReference,sourceAuthorityRef:request.sourceAuthorityRef,
    attemptBinding:request.attemptBinding,logicalOperationId:request.attemptBinding.logicalOperationId,billableAttemptId:request.attemptBinding.billableAttemptId,
    kind:'retain_unknown',identity:{eventType:'outcome_unknown',consumed:0n,released:0n,usageFinality:'unknown',settlementSequence:null},
    command:request,ports,operation:'retainUnknown',authority:'budgets.markDispatched',
    compute(state){
      if(!sameJson(state.originalBinding,request.attemptBinding))return attemptMismatch('retainUnknown',request.requestId);
      if(!state.everDispatched||!sameJson((state.dispatchEvidence as MarkDispatchedCommand|null)?.dispatchIntentRef,request.dispatchIntentRef))
        return {reject:makeError('retainUnknown','VALIDATION_ERROR',request.requestId,'The exact financial intent must already be durable before a transport outcome can be recorded.')};
      if(state.usageFinality==='final')return {reject:makeError('retainUnknown','VALIDATION_ERROR',request.requestId,'An unverified transport statement cannot overturn final billing evidence.')};
      return {eventType:'outcome_unknown',consumed:state.consumed,released:0n,usageFinality:'unknown',settlementSequence:null};
    },
    async appendFinancial(state,client,revision){
      await appendBudgetException(client,request.scope,state.currency,request.reservationId,revision,'outcome_unknown','unresolved',0n,request.idempotencyKey,
        request as unknown as Record<string,unknown>,request.sourceAuthorityRef);
      return {ok:true,value:null};
    },
  });
}
const ExpiryBase=Type.Omit(RetainUnknownOutcomeRequestSchema,['outcome','httpStatus','dispatchIntentRef']);
export const ExpireReservationRequestSchema=Type.Object({...ExpiryBase.properties,reasonReference:Type.String({minLength:1,maxLength:240})},{additionalProperties:false});
export type ExpireReservationRequest=Static<typeof ExpireReservationRequestSchema>;
/** Expiry records an unresolved commitment. Only independently authenticated finality can release it. */
export async function expireReservation(value:unknown,ports:BudgetRuntimePorts):Promise<ApiResult<ReservationCommandOutcome>>{
  if(!Value.Check(ExpireReservationRequestSchema,value))return failure(makeError('expireReservation','VALIDATION_ERROR',requestIdOf(value),'The expiry request is invalid.'));
  const request=structuredClone(value);
  return applyCommand({requestId:request.requestId,idempotencyKey:request.idempotencyKey,scope:request.scope,reservationId:request.reservationId,
    expectedRevision:request.expectedRevision,currency:'',actorReference:request.actorReference,sourceAuthorityRef:request.sourceAuthorityRef,
    attemptBinding:request.attemptBinding,logicalOperationId:request.attemptBinding.logicalOperationId,billableAttemptId:request.attemptBinding.billableAttemptId,
    kind:'expire_unresolved',identity:{eventType:'held_for_reconciliation',consumed:0n,released:0n,usageFinality:null,settlementSequence:null},
    command:request,ports,operation:'expireReservation',authority:'budgets.release',
    compute(state){
      if(!sameJson(state.originalBinding,request.attemptBinding))return attemptMismatch('expireReservation',request.requestId);
      const expiry=state.financialExpiresAt??state.authorizationRequest?.canonicalRequest.expires_at;
      if(!expiry||Date.parse(expiry)>ports.clock.now().getTime()||state.usageFinality==='final'||state.held<=state.consumed+state.released)
        return {reject:makeError('expireReservation','VALIDATION_ERROR',request.requestId,'Only an expired unresolved commitment is eligible; expiry never proves no billing.')};
      return {eventType:'held_for_reconciliation',consumed:state.consumed,released:0n,usageFinality:state.usageFinality,settlementSequence:null};
    },
    async appendFinancial(state,client,revision){
      await appendBudgetException(client,request.scope,state.currency,request.reservationId,revision,'expired_unresolved','unresolved',0n,request.idempotencyKey,request,request.sourceAuthorityRef);
      return {ok:true,value:null};
    },
  });
}
export const BudgetRecoveryRequestSchema=Type.Object({schemaVersion:Type.Literal('1.0.0'),requestId:Type.String({minLength:1}),idempotencyKey:Type.String({minLength:1}),
  scope:ExpiryBase.properties.scope,currency:Type.Literal('USD'),jobReference:Type.String({minLength:1,maxLength:240}),expectedCursorRevision:Type.Integer({minimum:0}),
  pageSize:Type.Integer({minimum:1,maximum:100}),ownerReference:Type.String({minLength:1,maxLength:200}),actionReference:Type.String({minLength:1,maxLength:240}),
},{additionalProperties:false});
export type BudgetRecoveryRequest=Static<typeof BudgetRecoveryRequestSchema>;
export const ReconcileReservationEvidenceRequestSchema=Type.Object({...ExpiryBase.properties,ownerReference:Type.String({minLength:1,maxLength:200}),
  actionReference:Type.String({minLength:1,maxLength:240}),finalityReference:Type.Union([VersionedReferenceSchema,Type.Null()])},{additionalProperties:false});
export type ReconcileReservationEvidenceRequest=Static<typeof ReconcileReservationEvidenceRequestSchema>;
/** Resolve one authentic source into a versioned financial command; an observed decrease uses its separate permission. */
export async function reconcileReservationEvidence(value:unknown,ports:BudgetRuntimePorts):Promise<ApiResult<ReservationCommandOutcome>>{
  if(!Value.Check(ReconcileReservationEvidenceRequestSchema,value))return failure(makeError('reconcileEvidence','VALIDATION_ERROR',requestIdOf(value),'The source reconciliation request is invalid.'));
  const request=structuredClone(value),scope=request.scope,requestDigest=await budgetDigest(normalizedBudgetRequest(request));
  const wait=resolveWaitMs(ports);if(wait===null)return invalidWaitFailure('reconcileEvidence',request.requestId);
  const unavailable=()=>failure(makeError('reconcileEvidence','RECONCILIATION_PENDING',request.requestId,'The current original source is unresolved; financial commitments remain.',true));
  const prepared=await runBounded<ApiResult<VerifiedSettlementRequest|VerifiedExpenseCorrectionRequest|ReservationCommandOutcome>>(wait,unavailable,async gate=>{
    let client:BudgetTransactionPort|undefined,transaction=false;
    try{
      const initial=await authorizeScopeProof(scope,request.requestId,ports,'reconcileEvidence','reconciliation.startReconciliation');gate.checkpoint();if(!initial.ok)return initial;
      const proofs:TimedBudgetProof[]=[initial.value];
      client=await ports.database.connect();gate.checkpoint();await client.query('BEGIN');transaction=true;
      await bindFinancialDatabaseScope(client,scope);await bindDeadline(client,gate);await requireBudgetSettlementCapability(client);gate.checkpoint();
      const replay=await client.query(`SELECT command_request,command_receipt FROM cost_intelligence.budget_command_receipts
        WHERE tenant_id=$1 AND project_id=$2 AND environment=$3 AND billing_mode=$4 AND idempotency_key=$5`,
        [scope.tenantId,scope.projectId,scope.environment,scope.billingMode,request.idempotencyKey]);
      if(replay.rows[0]){
        const command=replay.rows[0].command_request as VerifiedSettlementRequest|VerifiedExpenseCorrectionRequest;
        if(command.reconciliationContext?.requestDigest!==requestDigest)return failure(makeError('reconcileEvidence','IDEMPOTENCY_CONFLICT',request.requestId,'The original reconciliation owner/action/evidence request differs.'));
        const current=await refreshScopeProof(scope,request.requestId,ports,'reconcileEvidence',command.action==='record_expense_adjustment'?'budgets.recordExpenseAdjustment':'budgets.settle',gate,proofs);
        if(!current.ok)return current;
        return currentProofBound(ports,proofs)?{ok:true,value:{...structuredClone(replay.rows[0].command_receipt) as ReservationCommandOutcome,requestId:request.requestId,status:'replay'}}:unavailable();
      }
      const state=await loadReservation(client,scope,request.reservationId);
      if(!state?.authorizationRequest?.authorityBinding||state.currency!=='USD'||!sameJson(state.originalBinding,request.attemptBinding))
        return failure(makeError('reconcileEvidence','FORBIDDEN_SCOPE',request.requestId,'The source does not correspond to this durable financial attempt.'));
      if(!ports.sourceCollector||!ports.reportedCostContractMode)return unavailable();
      const binding=state.authorizationRequest.authorityBinding;
      const source=await gate.wait(resolveBudgetReportedCost(ports.sourceCollector,ports.clock,{scope,reference:request.sourceAuthorityRef,kind:'reported_cost',attempt:request.attemptBinding,
        authorityBinding:binding,provider:binding.provider,model:binding.model,operation:binding.operation,targetBindingSha256:binding.targetBindingSha256},ports.reportedCostContractMode,state.latestReportedUsage??undefined));gate.checkpoint();
      if(!source||source.amountSemantics!=='cumulative_attempt_total'||source.evidence.reported_cost.state!=='known')return unavailable();
      proofs.push(source.source);
      const correction=parseScaledDecimal(source.evidence.reported_cost.money.amount)<state.consumed;
      if(correction&&!state.latestReportedUsage)return unavailable();
      const command:VerifiedSettlementRequest={schemaVersion:'2.0.0',requestId:request.requestId,idempotencyKey:request.idempotencyKey,scope,
        reservationId:request.reservationId,expectedRevision:request.expectedRevision,actorReference:request.actorReference,sourceAuthorityRef:request.sourceAuthorityRef,
        attemptBinding:request.attemptBinding,action:'settle',reconciliationContext:{requestDigest,ownerReference:request.ownerReference,actionReference:request.actionReference},
        settlement:{measure:'cumulative',finality:request.finalityReference?'final':'partial',sequence:request.expectedRevision+1,
          cumulativeAmount:source.evidence.reported_cost.money.amount,currency:'USD',usageCompleteness:source.usage.completeness,
          sourceObservationRefs:[request.sourceAuthorityRef],allowObservedOverrun:true,...(request.finalityReference?{finalityEvidenceRef:request.finalityReference}:{})}};
      const current=await refreshScopeProof(scope,request.requestId,ports,'reconcileEvidence','reconciliation.startReconciliation',gate,proofs);if(!current.ok)return current;
      if(!currentProofBound(ports,proofs))return unavailable();
      return {ok:true,value:correction?{...command,action:'record_expense_adjustment',correction:{originalSourceObservationId:state.latestReportedUsage!.source_observation_id,reasonReference:request.actionReference}}:command};
    }catch{return unavailable();}finally{if(client&&transaction)await rollback(client);client?.release();}
  });
  if(!prepared.ok)return prepared;
  if('status' in prepared.value)return {ok:true,value:prepared.value};
  return prepared.value.action==='record_expense_adjustment'?correctReservationExpense(prepared.value,ports):settleReservation(prepared.value,ports);
}
export interface BudgetRecoveryBatch {
  readonly schemaVersion:'1.0.0';readonly requestId:string;readonly status:'applied'|'replay'|'stale_revision';readonly cursorRevision:number;
  readonly completedCycle:boolean;readonly candidates:readonly {reservationId:string;revision:number;state:ReservationLifecycleState;
    attemptBinding:ReservationRequest['attemptBinding'];sourceAuthorityRef:VersionedReference;expiresAt:string;outstandingHold:string}[];
}
/** Durable keyset progress visits every row, including timestamp ties, rather than repeatedly selecting the oldest hold. */
export async function recoverReservationBatch(value:unknown,ports:BudgetRuntimePorts):Promise<ApiResult<BudgetRecoveryBatch>>{
  if(!Value.Check(BudgetRecoveryRequestSchema,value))return failure(makeError('recoverReservations','VALIDATION_ERROR',requestIdOf(value),'The recovery request is invalid.'));
  const request=structuredClone(value),scope=request.scope;
  const wait=resolveWaitMs(ports);if(wait===null)return invalidWaitFailure('recoverReservations',request.requestId);
  const unavailable=()=>failure(makeError('recoverReservations','BUDGET_UNAVAILABLE',request.requestId,'Durable recovery progress is unavailable; retry the identical request.',true));
  return runBounded<ApiResult<BudgetRecoveryBatch>>(wait,unavailable,async gate=>{
    let client:BudgetTransactionPort|undefined,transaction=false;
    try{
      const initial=await authorizeScopeProof(scope,request.requestId,ports,'recoverReservations','reconciliation.startReconciliation');gate.checkpoint();if(!initial.ok)return initial;
      const proofs:TimedBudgetProof[]=[initial.value];
      client=await ports.database.connect();gate.checkpoint();await client.query('BEGIN');transaction=true;
      await bindFinancialDatabaseScope(client,scope);await bindDeadline(client,gate);
      if(!(await acquirePartitionLock(client,scope,request.currency,gate)))return unavailable();
      const replay=await client.query(`SELECT command_request,command_receipt FROM cost_intelligence.budget_recovery_cursors
        WHERE tenant_id=$1 AND project_id=$2 AND environment=$3 AND billing_mode=$4 AND idempotency_key=$5`,
        [scope.tenantId,scope.projectId,scope.environment,scope.billingMode,request.idempotencyKey]);
      if(replay.rows[0]){
        if(!sameJson(replay.rows[0].command_request,normalizedBudgetRequest(request)))return failure(makeError('recoverReservations','IDEMPOTENCY_CONFLICT',request.requestId,'The recovery key has different complete owner/action/cursor fields.'));
        const fresh=await refreshScopeProof(scope,request.requestId,ports,'recoverReservations','reconciliation.startReconciliation',gate,proofs);if(!fresh.ok)return fresh;
        if(!currentProofBound(ports,proofs))return unavailable();
        return {ok:true,value:{...structuredClone(replay.rows[0].command_receipt) as BudgetRecoveryBatch,requestId:request.requestId,status:'replay'}};
      }
      const cursor=await client.query(`SELECT revision,after_recorded_at::text,after_reservation_id FROM cost_intelligence.budget_recovery_cursors
        WHERE tenant_id=$1 AND project_id=$2 AND environment=$3 AND billing_mode=$4 AND currency=$5 AND job_reference=$6 ORDER BY revision DESC LIMIT 1`,
        [scope.tenantId,scope.projectId,scope.environment,scope.billingMode,request.currency,request.jobReference]);
      const previous=cursor.rows[0],revision=Number(previous?.revision??0);
      if(revision!==request.expectedCursorRevision)return {ok:true,value:{schemaVersion:'1.0.0',requestId:request.requestId,status:'stale_revision',cursorRevision:revision,completedCycle:false,candidates:[]}};
      const rows=await client.query(`SELECT reservation_id,recorded_at::text FROM cost_intelligence.budget_reservation_events
        WHERE tenant_id=$1 AND project_id=$2 AND environment=$3 AND billing_mode=$4 AND currency=$5 AND event_sequence=1
          AND ($6::timestamptz IS NULL OR (recorded_at,reservation_id)>($6::timestamptz,$7::text))
        ORDER BY recorded_at,reservation_id LIMIT $8`,
        [scope.tenantId,scope.projectId,scope.environment,scope.billingMode,request.currency,previous?.after_recorded_at??null,previous?.after_reservation_id??null,request.pageSize+1]);
      const visited=rows.rows.slice(0,request.pageSize),completedCycle=rows.rows.length<=request.pageSize;
      const candidates:BudgetRecoveryBatch['candidates'][number][]=[];
      for(const row of visited){
        gate.checkpoint();const state=await loadReservation(client,scope,asString(row.reservation_id));
        if(!state?.authorizationRequest?.sourceAuthorityRef||state.usageFinality==='final'||state.held<=state.released+state.consumed)continue;
        candidates.push({reservationId:asString(row.reservation_id),revision:state.revision,state:stateFor(state.lastType,state.usageFinality),
          attemptBinding:state.authorizationRequest.attemptBinding,sourceAuthorityRef:state.authorizationRequest.sourceAuthorityRef,
          expiresAt:state.financialExpiresAt??state.authorizationRequest.canonicalRequest.expires_at,outstandingHold:formatScaledDecimal(state.held-state.released-state.consumed)});
      }
      const receipt:BudgetRecoveryBatch={schemaVersion:'1.0.0',requestId:request.requestId,status:'applied',cursorRevision:revision+1,completedCycle,candidates};
      const last=visited.at(-1);
      const fresh=await refreshScopeProof(scope,request.requestId,ports,'recoverReservations','reconciliation.startReconciliation',gate,proofs);if(!fresh.ok)return fresh;
      if(!currentProofBound(ports,proofs))return unavailable();
      await client.query(`INSERT INTO cost_intelligence.budget_recovery_cursors
        (cursor_id,tenant_id,project_id,environment,billing_mode,currency,job_reference,revision,after_recorded_at,after_reservation_id,completed_cycle,command_request,command_receipt,idempotency_key)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::timestamptz,$10,$11,$12::jsonb,$13::jsonb,$14)`,
        [crypto.randomUUID(),scope.tenantId,scope.projectId,scope.environment,scope.billingMode,request.currency,request.jobReference,revision+1,
          completedCycle?null:last?.recorded_at??null,completedCycle?null:last?.reservation_id??null,completedCycle,
          JSON.stringify(normalizedBudgetRequest(request)),JSON.stringify(receipt),request.idempotencyKey]);
      gate.checkpoint();if(!currentProofBound(ports,proofs))return unavailable();
      gate.beginCommit();await client.query('COMMIT');transaction=false;
      const acknowledged=await refreshScopeProof(scope,request.requestId,ports,'recoverReservations','reconciliation.startReconciliation',gate,proofs);if(!acknowledged.ok)return unavailable();
      return currentProofBound(ports,proofs)?{ok:true,value:receipt}:unavailable();
    }catch{return unavailable();}finally{if(client&&transaction)await rollback(client);client?.release();}
  });
}
export const BudgetExceptionActionRequestSchema=Type.Object({schemaVersion:Type.Literal('1.0.0'),requestId:Type.String({minLength:1}),idempotencyKey:Type.String({minLength:1}),
  scope:ExpiryBase.properties.scope,currency:Type.Literal('USD'),exceptionId:Type.String({minLength:1}),expectedRevision:Type.Integer({minimum:1}),
  action:Type.Union([Type.Literal('hold'),Type.Literal('resolve'),Type.Literal('reopen')]),ownerReference:Type.String({minLength:1,maxLength:200}),
  actionReference:Type.String({minLength:1,maxLength:240}),evidenceReference:Type.Union([VersionedReferenceSchema,Type.Null()]),
},{additionalProperties:false});
export type BudgetExceptionActionRequest=Static<typeof BudgetExceptionActionRequestSchema>;
export interface BudgetExceptionReceipt {
  readonly schemaVersion:'1.0.0';readonly requestId:string;readonly status:'applied'|'replay'|'stale_revision';readonly exceptionId:string;
  readonly revision:number;readonly reservationId:string;readonly reservationRevision:number;readonly state:'unresolved'|'held_for_reconciliation'|'resolved'|'reopened';
  readonly reason:string;readonly varianceAmount:string;readonly currency:'USD';readonly ownerReference:string;readonly actionReference:string;
  readonly evidenceReference:VersionedReference|null;
}
function exceptionReceipt(requestId:string,status:BudgetExceptionReceipt['status'],row:Record<string,unknown>):BudgetExceptionReceipt{
  return {schemaVersion:'1.0.0',requestId,status,exceptionId:asString(row.exception_id),revision:Number(row.revision),reservationId:asString(row.reservation_id),
    reservationRevision:Number(row.reservation_revision),state:row.state as BudgetExceptionReceipt['state'],reason:asString(row.reason),varianceAmount:asString(row.variance_amount),
    currency:'USD',ownerReference:asString(row.owner_reference),actionReference:asString(row.action_reference),evidenceReference:row.evidence_reference as VersionedReference|null};
}
/** Acknowledging investigation preserves unresolved financial capacity. Resolution requires already-accounted authenticated finality. */
export async function actOnBudgetException(value:unknown,ports:BudgetRuntimePorts):Promise<ApiResult<BudgetExceptionReceipt>>{
  if(!Value.Check(BudgetExceptionActionRequestSchema,value))return failure(makeError('actOnException','VALIDATION_ERROR',requestIdOf(value),'The exception action is invalid.'));
  const request=structuredClone(value),scope=request.scope;
  const wait=resolveWaitMs(ports);if(wait===null)return invalidWaitFailure('actOnException',request.requestId);
  const unavailable=()=>failure(makeError('actOnException','RECONCILIATION_PENDING',request.requestId,'Current exception authority is unavailable; all commitments remain.',true));
  return runBounded<ApiResult<BudgetExceptionReceipt>>(wait,unavailable,async gate=>{
    let client:BudgetTransactionPort|undefined,transaction=false;
    try{
      const initial=await authorizeScopeProof(scope,request.requestId,ports,'actOnException','reconciliation.startReconciliation');gate.checkpoint();if(!initial.ok)return initial;
      const proofs:TimedBudgetProof[]=[initial.value];
      client=await ports.database.connect();gate.checkpoint();await client.query('BEGIN');transaction=true;
      await bindFinancialDatabaseScope(client,scope);await bindDeadline(client,gate);if(!(await acquirePartitionLock(client,scope,'USD',gate)))return unavailable();
      const replay=await client.query(`SELECT *,variance_amount::text FROM cost_intelligence.budget_reconciliation_exceptions
        WHERE tenant_id=$1 AND project_id=$2 AND environment=$3 AND billing_mode=$4 AND exception_id=$5 AND idempotency_key=$6`,
        [scope.tenantId,scope.projectId,scope.environment,scope.billingMode,request.exceptionId,request.idempotencyKey]);
      if(replay.rows[0]){
        if(!sameJson(replay.rows[0].command_request,normalizedBudgetRequest(request)))return failure(makeError('actOnException','IDEMPOTENCY_CONFLICT',request.requestId,'The exception key differs in owner, action, evidence, scope or expected revision.'));
        const fresh=await refreshScopeProof(scope,request.requestId,ports,'actOnException','reconciliation.startReconciliation',gate,proofs);if(!fresh.ok)return fresh;
        return currentProofBound(ports,proofs)?{ok:true,value:exceptionReceipt(request.requestId,'replay',replay.rows[0])}:unavailable();
      }
      const current=await client.query(`SELECT *,variance_amount::text FROM cost_intelligence.budget_reconciliation_exceptions
        WHERE tenant_id=$1 AND project_id=$2 AND environment=$3 AND billing_mode=$4 AND exception_id=$5 AND currency='USD' ORDER BY revision DESC LIMIT 1`,
        [scope.tenantId,scope.projectId,scope.environment,scope.billingMode,request.exceptionId]);
      const row=current.rows[0];if(!row)return failure(makeError('actOnException','FORBIDDEN_SCOPE',request.requestId,'The exception is not available in this current scope.'));
      if(Number(row.revision)!==request.expectedRevision)return {ok:true,value:exceptionReceipt(request.requestId,'stale_revision',row)};
      const state=await loadReservation(client,scope,asString(row.reservation_id));if(!state)return unavailable();
      if(request.action==='hold'&&row.state==='resolved'||request.action==='reopen'&&row.state!=='resolved')
        return failure(makeError('actOnException','VALIDATION_ERROR',request.requestId,'The action does not match the current exception state.'));
      const nextState=request.action==='hold'?'held_for_reconciliation':request.action==='reopen'?'reopened':'resolved';
      async function refreshFinality():Promise<ApiResult<readonly TimedBudgetProof[]>>{
        if(request.action!=='resolve')return {ok:true,value:[]};
        if(!ports.sourceCollector||request.evidenceReference===null||!state?.authorizationRequest?.authorityBinding)return failure(makeError('actOnException','SOURCE_UNAVAILABLE',request.requestId,'Resolution requires current authenticated finality, not an acknowledgement or caller reference.'));
        const binding=state.authorizationRequest.authorityBinding;
        const source=await gate.wait(resolveExecutionFinality(ports.sourceCollector,ports.clock,{scope,reference:request.evidenceReference,kind:'execution_finality',
          provider:binding.provider,model:binding.model,operation:binding.operation,authorityBinding:binding,targetBindingSha256:binding.targetBindingSha256,
          attempt:state.authorizationRequest.attemptBinding}));gate.checkpoint();
        if(!source||!Value.Check(BudgetExecutionFinalitySchema,source.record.payload))return failure(makeError('actOnException','SOURCE_UNAVAILABLE',request.requestId,'The current finality record is unavailable.'));
        const finality=source.record.payload,accounted=state.usageFinality==='final'&&sameJson(finality.cumulativeCostRef,state.settlementSourceRef)
          &&finality.state==='final_billed'&&state.latestReportedUsage!==null;
        const fenced=state.lastType==='released'&&state.consumed===0n&&(finality.state==='final_no_bill'||finality.state==='fenced_not_dispatched');
        if(!accounted&&!fenced)return failure(makeError('actOnException','VALIDATION_ERROR',request.requestId,'Expense must be posted or a proven unused hold released before resolving its financial exception.'));
        return {ok:true,value:[source]};
      }
      const source=await refreshFinality();if(!source.ok)return source;proofs.push(...source.value);
      const nextRevision=request.expectedRevision+1;
      const normalized=normalizedBudgetRequest(request);
      await client.query(`INSERT INTO cost_intelligence.budget_reconciliation_exceptions
        (exception_revision_id,tenant_id,project_id,environment,billing_mode,currency,exception_id,revision,reservation_id,reservation_revision,idempotency_key,
        state,reason,owner_reference,action_reference,evidence_reference,command_request,variance_amount,content_hash)
        VALUES($1,$2,$3,$4,$5,'USD',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16::jsonb,$17::numeric,$18)`,
        [crypto.randomUUID(),scope.tenantId,scope.projectId,scope.environment,scope.billingMode,request.exceptionId,nextRevision,row.reservation_id,
          state.revision,request.idempotencyKey,nextState,row.reason,request.ownerReference,request.actionReference,request.evidenceReference===null?null:JSON.stringify(request.evidenceReference),
          JSON.stringify(normalized),asString(row.variance_amount),await budgetDigest({command:normalized,revision:nextRevision,state:nextState,reservationRevision:state.revision,variance:row.variance_amount})]);
      const finalSource=await refreshFinality();if(!finalSource.ok)return finalSource;proofs.push(...finalSource.value);
      const fresh=await refreshScopeProof(scope,request.requestId,ports,'actOnException','reconciliation.startReconciliation',gate,proofs);if(!fresh.ok)return fresh;
      if(!currentProofBound(ports,proofs))return unavailable();
      gate.beginCommit();await client.query('COMMIT');transaction=false;
      const ackSource=await refreshFinality();if(!ackSource.ok)return unavailable();proofs.push(...ackSource.value);
      const acknowledged=await refreshScopeProof(scope,request.requestId,ports,'actOnException','reconciliation.startReconciliation',gate,proofs);if(!acknowledged.ok)return unavailable();
      const receipt=exceptionReceipt(request.requestId,'applied',{...row,revision:nextRevision,reservation_revision:state.revision,state:nextState,
        owner_reference:request.ownerReference,action_reference:request.actionReference,evidence_reference:request.evidenceReference});
      return currentProofBound(ports,proofs)?{ok:true,value:receipt}:unavailable();
    }catch{return unavailable();}finally{if(client&&transaction)await rollback(client);client?.release();}
  });
}
export const BudgetExceptionQuerySchema=Type.Object({schemaVersion:Type.Literal('1.0.0'),requestId:Type.String({minLength:1}),scope:ExpiryBase.properties.scope,
  currency:Type.Literal('USD'),pageSize:Type.Integer({minimum:1,maximum:100}),afterExceptionId:Type.Union([Type.String({minLength:1}),Type.Null()]),includeResolved:Type.Boolean(),
},{additionalProperties:false});
export type BudgetExceptionQuery=Static<typeof BudgetExceptionQuerySchema>;
export interface BudgetExceptionPage {readonly schemaVersion:'1.0.0';readonly requestId:string;readonly asOf:string;
  readonly exceptions:readonly BudgetExceptionReceipt[];readonly nextExceptionId:string|null;}
export async function readBudgetExceptions(value:unknown,ports:BudgetRuntimePorts):Promise<ApiResult<BudgetExceptionPage>>{
  if(!Value.Check(BudgetExceptionQuerySchema,value))return failure(makeError('getExceptions','VALIDATION_ERROR',requestIdOf(value),'The exception query is invalid.'));
  const request=structuredClone(value),scope=request.scope;
  const wait=resolveWaitMs(ports);if(wait===null)return invalidWaitFailure('getExceptions',request.requestId);
  const unavailable=()=>failure(makeError('getExceptions','RECONCILIATION_PENDING',request.requestId,'Current exception state is unavailable.',true));
  return runBounded<ApiResult<BudgetExceptionPage>>(wait,unavailable,async gate=>{
    let client:BudgetTransactionPort|undefined,transaction=false;
    try{
      const initial=await authorizeScopeProof(scope,request.requestId,ports,'getExceptions','reconciliation.getReconciliation');gate.checkpoint();if(!initial.ok)return initial;
      const proofs:TimedBudgetProof[]=[initial.value];
      client=await ports.database.connect();gate.checkpoint();await client.query('BEGIN');transaction=true;
      await bindFinancialDatabaseScope(client,scope);await bindDeadline(client,gate);
      const rows=await client.query(`SELECT *,variance_amount::text FROM (
        SELECT DISTINCT ON(exception_id) * FROM cost_intelligence.budget_reconciliation_exceptions
        WHERE tenant_id=$1 AND project_id=$2 AND environment=$3 AND billing_mode=$4 AND currency='USD'
        ORDER BY exception_id,revision DESC) current_exceptions
        WHERE ($5::text IS NULL OR exception_id>$5) AND ($6::boolean OR state<>'resolved') ORDER BY exception_id LIMIT $7`,
        [scope.tenantId,scope.projectId,scope.environment,scope.billingMode,request.afterExceptionId,request.includeResolved,request.pageSize+1]);
      const fresh=await refreshScopeProof(scope,request.requestId,ports,'getExceptions','reconciliation.getReconciliation',gate,proofs);if(!fresh.ok)return fresh;
      if(!currentProofBound(ports,proofs))return unavailable();
      gate.beginCommit();await client.query('COMMIT');transaction=false;
      const acknowledged=await refreshScopeProof(scope,request.requestId,ports,'getExceptions','reconciliation.getReconciliation',gate,proofs);if(!acknowledged.ok)return acknowledged;
      if(!currentProofBound(ports,proofs))return unavailable();
      const page=rows.rows.slice(0,request.pageSize);
      return {ok:true,value:{schemaVersion:'1.0.0',requestId:request.requestId,asOf:ports.clock.now().toISOString(),
        exceptions:page.map(row=>exceptionReceipt(request.requestId,'applied',row)),nextExceptionId:rows.rows.length>request.pageSize?asString(page.at(-1)!.exception_id):null}};
    }catch{return unavailable();}finally{if(client&&transaction)await rollback(client);client?.release();}
  });
}
async function appendBudgetException(client:BudgetTransactionPort,scope:TrustedScope,currency:string,reservationId:string,reservationRevision:number,
  reason:'outcome_unknown'|'expired_unresolved'|'over_cap'|'unallocated_aggregate'|'evidence_conflict',state:'unresolved'|'held_for_reconciliation'|'resolved'|'reopened',variance:bigint,
  idempotencyKey:string,command:Record<string,unknown>,evidence:VersionedReference|null):Promise<void>{
  const exceptionId=`ci05b:${reservationId}:${reason}`;
  const prior=await client.query(`SELECT revision,state FROM cost_intelligence.budget_reconciliation_exceptions
    WHERE tenant_id=$1 AND project_id=$2 AND environment=$3 AND billing_mode=$4 AND exception_id=$5 ORDER BY revision DESC LIMIT 1`,
    [scope.tenantId,scope.projectId,scope.environment,scope.billingMode,exceptionId]);
  const revision=Number(prior.rows[0]?.revision??0)+1;
  if(prior.rows[0]?.state==='resolved'&&state==='unresolved')state='reopened';
  const normalized=normalizedBudgetRequest(command);
  await client.query(`INSERT INTO cost_intelligence.budget_reconciliation_exceptions
    (exception_revision_id,tenant_id,project_id,environment,billing_mode,currency,exception_id,revision,reservation_id,reservation_revision,idempotency_key,
      state,reason,owner_reference,action_reference,evidence_reference,command_request,variance_amount,content_hash)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17::jsonb,$18::numeric,$19)`,
    [crypto.randomUUID(),scope.tenantId,scope.projectId,scope.environment,scope.billingMode,currency,exceptionId,revision,reservationId,reservationRevision,
      `${idempotencyKey}:${reason}:${state}`,state,reason,scope.actorId,idempotencyKey,evidence===null?null:JSON.stringify(evidence),JSON.stringify(normalized),
      formatScaledDecimal(variance),await budgetDigest({exceptionId,revision,reservationRevision,command:normalized,state,reason,evidence,variance:formatScaledDecimal(variance)})]);
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
      if(!(await acquirePartitionLock(client,scope,currency,gate)))return unavailable();
      const capacity = await projectCapacity(client, scope, currency);
      gate.beginCommit();
      await client.query('COMMIT'); inTransaction = false;
      return {
        ok: true,
        value: {
          schemaVersion: '1.0.0', requestId, scope, currency,
          limitAmount: formatScaledDecimal(capacity.limit), effectiveConsumedSpend: formatScaledDecimal(capacity.consumed),
          outstandingHolds: formatScaledDecimal(capacity.outstandingHolds), usedCapacity: formatScaledDecimal(capacity.used),
          availableCapacity: formatScaledDecimal(capacity.available), reservationCount: capacity.reservationCount, advisoryOnly: true, capacityState: capacityState(capacity), unresolvedExposure: capacity.unresolvedExposure, policyWindow: 'project_lifetime', policyRef: decisionReference(capacity.policy),
        },
      };
    } catch {
      if (client && inTransaction) await rollback(client);
      return unavailable();
    } finally {
      if(client&&inTransaction)await rollback(client);
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

async function verifySource(ports: BudgetRuntimePorts, request: Record<string, unknown>, operation: string, sourceAuthorityRef: BudgetReference) {
  const now = trustedNow(ports);
  if (!now) return null;
  const scope = request.scope as TrustedScope;
  return verifyBudgetSource(ports.budgetEvidence, { operation, scope, actorId: scope.actorId, sourceAuthorityRef,
    requestDigest: await budgetDigest(normalizedBudgetRequest(request)) }, ports.clock);
}
function capacityState(capacity: PartitionCapacity): CapacitySnapshot['capacityState'] {
  if (!capacity.policy) return 'unconfigured';
  if (capacity.used > capacity.limit) return 'over_limit';
  if (capacity.used === capacity.limit) return 'exhausted';
  return capacity.used * 100n >= capacity.limit * 80n ? 'near_limit' : 'available';
}
function financeEnvelope(request: ReservationRequest, reservationId: string, held: bigint, cap: bigint, evidenceRef: string, evidenceHash: string,authorityExpiresAt?:string) {
  const binding = request.authorityBinding!;
  return { status: 'held' as const, revoked: false as const, reservation_ref: reservationId,
    billable_attempt_id: request.attemptBinding.billableAttemptId, budget_scope_id: binding.budgetScopeId,
    lease_ref: binding.leaseRef, grant_ref: binding.grantRef, tenant_id: request.scope.tenantId, project_id: request.scope.projectId,
    account_ref: binding.accountRef, project_ref: binding.projectRef, provider: binding.provider, model: binding.model,
    operation: binding.operation, target_binding_sha256: binding.targetBindingSha256,
    held_amount: { amount: formatScaledDecimal(held), currency: request.estimate.currency },
    authorized_cap: { amount: formatScaledDecimal(cap), currency: request.estimate.currency },
    expires_at: new Date(Math.min(Date.parse(request.canonicalRequest.expires_at),Date.parse(binding.leaseExpiresAt),authorityExpiresAt?Date.parse(authorityExpiresAt):Infinity)).toISOString(), evidence_ref: evidenceRef, evidence_sha256: evidenceHash };
}
export interface ReservationSnapshotRequest {
  readonly schemaVersion: '1.0.0'; readonly requestId: string; readonly scope: TrustedScope; readonly reservationId: string;
}
const SnapshotRequestSchema = Type.Object({ schemaVersion: Type.Literal('1.0.0'), requestId: Type.String({ minLength: 1 }),
  scope: BudgetPolicyChangeRequestSchema.properties.scope, reservationId: Type.String({ minLength: 1 }) }, { additionalProperties: false });
async function snapshotFrom(client: BudgetTransactionPort, request: ReservationSnapshotRequest, state: ReservationState, now: Date): Promise<ReservationSnapshot | null> {
  const original = state.authorizationRequest;
  if (!original?.sourceAuthorityRef || !original.authorityBinding) return null;
  const first = await client.query(`SELECT reservation_event_id, content_hash, authorized_cap::text AS cap FROM cost_intelligence.budget_reservation_events WHERE tenant_id=$1 AND project_id=$2 AND environment=$3 AND billing_mode=$4 AND reservation_id=$5 AND event_sequence=1`, [request.scope.tenantId,request.scope.projectId,request.scope.environment,request.scope.billingMode,request.reservationId]);
  const row=first.rows[0]; if (!row) return null;
  const expired = Date.parse(original.canonicalRequest.expires_at) <= now.getTime();
  const lifecycle = stateFor(state.lastType,state.usageFinality);
  const eligible = !expired && Date.parse(original.authorityBinding.leaseExpiresAt)>now.getTime() && (lifecycle==='held' || lifecycle==='dispatched') && (state.firstType!=='partially_authorized' || state.acknowledged);
  const c=original.canonicalRequest;
  const money = (amount: bigint) => { const value=formatScaledDecimal(amount); return {amount:value,currency:state.currency,scale:value.includes('.')?value.split('.')[1]!.length:0}; };
  // Explicit projection of the pinned v1 representation. Local state retains richer lifecycle/partial semantics.
  const canonical = { contract:'BudgetReservation', schema_version:'1.0.0', policy_version:c.policy_version,
    event_id:request.reservationId, tenant_id:c.tenant_id,project_id:c.project_id,correlation_id:c.correlation_id,producer:c.producer,
    occurred_at:c.occurred_at,observed_at:c.observed_at,ingested_at:c.ingested_at,environment:c.environment,billing_mode:c.billing_mode,source_refs:c.source_refs,
    reservation_id:request.reservationId,budget_scope_id:c.budget_scope_id,logical_operation_id:c.logical_operation_id,billable_attempt_id:c.billable_attempt_id,
    decision:'granted',lifecycle: lifecycle==='released'?'released':lifecycle==='settled'?'consumed':state.everDispatched?'uncertain_in_flight':expired?'expired':'held',
    held:money(state.held),consumed:money(state.consumed),expires_at:c.expires_at,revision:state.revision,
    execution_state:state.usageFinality==='final'?'finished':state.everDispatched?'in_flight':'not_dispatched',usage_completeness:state.latestReportedUsage?.completeness??'unknown',
    idempotency_key:original.idempotencyKey,authority_ref:original.sourceAuthorityRef,settlement_ref:null };
  const snapshot={schemaVersion:'1.0.0',requestId:request.requestId,asOf:now.toISOString(),reservation:canonical,
    state:expired && !state.everDispatched && lifecycle==='held'?'expired':lifecycle, heldAmount:formatScaledDecimal(state.held),effectiveConsumedAmount:formatScaledDecimal(state.consumed),releasedAmount:formatScaledDecimal(state.released),latestCumulativeSettlement:formatScaledDecimal(state.consumed),overrunAmount:formatScaledDecimal(state.consumed>state.held?state.consumed-state.held:0n),usageFinality:state.usageFinality,expectedRevision:state.revision,attemptBinding:original.attemptBinding,
    dispatchEligible:eligible, ...(eligible ? {finance:financeEnvelope(original,request.reservationId,state.held-state.released-state.consumed>0n?state.held-state.released-state.consumed:0n,parseScaledDecimal(fromRow(row,'cap')??'0'),`ci05a:${asString(row.reservation_event_id)}`,asString(row.content_hash))}: {})};
  const validated=validateReservationSnapshotBoundary(snapshot);return validated.ok?validated.value:null;
}
/** Finance USD18 read preserves financial facts without synthesizing a legacy canonical envelope. */
export async function readVerifiedReservationSnapshot(value:unknown,ports:BudgetRuntimePorts):Promise<ApiResult<VerifiedReservationSnapshot>>{
  if(!Value.Check(VerifiedReservationReadRequestSchema,value))return failure(makeError('getReservationSnapshot','VALIDATION_ERROR',requestIdOf(value),'The Finance USD18 read request is invalid.'));
  const request=structuredClone(value) as VerifiedReservationReadRequest;
  const wait=resolveWaitMs(ports);if(wait===null)return invalidWaitFailure('getReservationSnapshot',request.requestId);
  const unavailable=()=>failure(makeError('getReservationSnapshot','BUDGET_UNAVAILABLE',request.requestId,'Current reservation facts are unavailable.',true));
  return runBounded<ApiResult<VerifiedReservationSnapshot>>(wait,unavailable,async gate=>{
    let client:BudgetTransactionPort|undefined,transaction=false;
    try{
      const initial=await authorizeScopeProof(request.scope,request.requestId,ports,'getReservationSnapshot','budgets.readReservation');gate.checkpoint();if(!initial.ok)return initial;
      const proofs:TimedBudgetProof[]=[initial.value];
      client=await ports.database.connect();gate.checkpoint();await client.query('BEGIN');transaction=true;
      await bindFinancialDatabaseScope(client,request.scope);await bindDeadline(client,gate);
      if(!(await acquirePartitionLock(client,request.scope,'USD',gate)))return unavailable();
      const state=await loadReservation(client,request.scope,request.reservationId);
      if(!state||state.currency!=='USD'||!state.authorizationRequest)return failure(makeError('getReservationSnapshot','FORBIDDEN_SCOPE',request.requestId,'The USD reservation is unavailable in this current scope.'));
      const fresh=await refreshScopeProof(request.scope,request.requestId,ports,'getReservationSnapshot','budgets.readReservation',gate,proofs);if(!fresh.ok)return fresh;
      if(!currentProofBound(ports,proofs))return unavailable();
      const {status,schemaVersion,...facts}=outcomeFrom(request.requestId,'applied',request.reservationId,state);
      gate.beginCommit();await client.query('COMMIT');transaction=false;
      const acknowledged=await refreshScopeProof(request.scope,request.requestId,ports,'getReservationSnapshot','budgets.readReservation',gate,proofs);if(!acknowledged.ok)return acknowledged;
      if(!currentProofBound(ports,proofs))return unavailable();
      const snapshot={...facts,schemaVersion:'2.0.0',asOf:ports.clock.now().toISOString(),attemptBinding:state.authorizationRequest.attemptBinding,dispatchEligible:false};
      return Value.Check(VerifiedReservationSnapshotSchema,snapshot)?{ok:true,value:snapshot}:unavailable();
    }catch{return unavailable();}finally{if(client&&transaction)await rollback(client);client?.release();}
  });
}
/** Current scope-authorized read; historical authorization replay must never substitute for this operation. */
export async function readReservationSnapshot(value: unknown, ports: BudgetRuntimePorts): Promise<ApiResult<ReservationSnapshot>> {
  if (!Value.Check(SnapshotRequestSchema,value)) return failure(makeError('getReservationSnapshot','VALIDATION_ERROR',requestIdOf(value),'The current reservation request is invalid.'));
  const request=structuredClone(value) as ReservationSnapshotRequest;
  const wait=resolveWaitMs(ports);if(wait===null)return invalidWaitFailure('getReservationSnapshot',request.requestId);
  const unavailable=()=>failure(makeError('getReservationSnapshot','BUDGET_UNAVAILABLE',request.requestId,'Current reservation state is unavailable.',true));
  return runBounded<ApiResult<ReservationSnapshot>>(wait,unavailable,async gate=>{
    let client:BudgetTransactionPort|undefined;let transaction=false;
    try {
      const denied=await authorizeScope(request.scope,request.requestId,ports,'getReservationSnapshot','budgets.readReservation');gate.checkpoint();if(denied)return failure(denied);
      const now=trustedNow(ports);if(!now)return unavailable();
      client=await ports.database.connect();gate.checkpoint();await client.query('BEGIN');transaction=true;await bindFinancialDatabaseScope(client,request.scope);await bindDeadline(client,gate);if(!(await acquirePartitionLock(client,request.scope,'budget-read',gate)))return unavailable();
      const state=await loadReservation(client,request.scope,request.reservationId);if(!state){await rollback(client);transaction=false;return failure(makeError('getReservationSnapshot','FORBIDDEN_SCOPE',request.requestId,'The reservation is unavailable in this authorized scope.'));}
      const snapshot=await snapshotFrom(client,request,state,now);gate.beginCommit();await client.query('COMMIT');transaction=false;
      if(!snapshot)return unavailable();
      const {finance, ...facts}=snapshot;
      return {ok:true,value:{...facts,dispatchEligible:false}};
    }catch{if(client&&transaction)await rollback(client);return unavailable();}finally{if(client&&transaction)await rollback(client);client?.release();}
  });
}
export interface CurrentReservationAuthorization {
  readonly schemaVersion:'1.0.0';readonly requestId:string;readonly status:'authorized'|'denied';readonly revoked:boolean;
  readonly snapshot:ReservationSnapshot;readonly finance?:import('./authority.js').FinanceReservationAuthority;
}
/** Both consumer phases re-read durable state and independently resolve the current host/source/maximum/plan. */
export async function revalidateReservation(value: unknown, ports: BudgetRuntimePorts): Promise<ApiResult<CurrentReservationAuthorization>> {
  if(!Value.Check(CurrentReservationRequestSchema,value))return failure(makeError('revalidateReservation','VALIDATION_ERROR',requestIdOf(value),'The current authority query is invalid.'));
  const request=structuredClone(value) as CurrentReservationRequest;
  const wait=resolveWaitMs(ports);if(wait===null)return invalidWaitFailure('revalidateReservation',request.requestId);
  const unavailable=()=>failure(makeError('revalidateReservation','BUDGET_UNAVAILABLE',request.requestId,'Current host or source verification is unavailable.',true));
  return runBounded<ApiResult<CurrentReservationAuthorization>>(wait,unavailable,async gate=>{
    let client:BudgetTransactionPort|undefined;let transaction=false;
    try{
      const initialScope=await authorizeScopeProof(request.scope,request.requestId,ports,'revalidateReservation','budgets.readReservation');
      gate.checkpoint();if(!initialScope.ok)return initialScope;
      const proofs:TimedBudgetProof[]=[initialScope.value];
      if(!ports.reservationAuthority||!ports.budgetEvidence)return unavailable();
      client=await ports.database.connect();gate.checkpoint();await client.query('BEGIN');transaction=true;
      await bindFinancialDatabaseScope(client,request.scope);await bindDeadline(client,gate);
      let state=await loadReservation(client,request.scope,request.reservationId);
      if(!state){await rollback(client);transaction=false;return failure(makeError('revalidateReservation','FORBIDDEN_SCOPE',request.requestId,'The reservation is unavailable in this authorized scope.'));}
      if(!(await acquirePartitionLock(client,request.scope,state.currency,gate))){await rollback(client);transaction=false;return unavailable();}
      state=(await loadReservation(client,request.scope,request.reservationId))!;
      const now=trustedNow(ports);if(!now)return unavailable();const original=state.authorizationRequest;
      const snapshot=await snapshotFrom(client,request,state,now);
      if(!snapshot||!original?.sourceAuthorityRef||!original.authorityBinding)return unavailable();
      let allowed=snapshot.dispatchEligible===true && sameJson(request.attemptBinding,original.attemptBinding)
        && sameJson(request.authorityBinding,original.authorityBinding) && (request.expectedRevision===undefined||request.expectedRevision===state.revision);
      if(request.phase==='post_transport_ack'&&(!request.dispatchIntentRef||request.transportAttemptId!==original.attemptBinding.transportAttemptId
        ||!state.everDispatched||!sameJson((state.dispatchEvidence as MarkDispatchedCommand|null)?.dispatchIntentRef,request.dispatchIntentRef)))allowed=false;
      const host=await gate.wait(verifyReservationHost(ports.reservationAuthority,{scope:request.scope,billableAttemptId:original.attemptBinding.billableAttemptId,
        binding:original.authorityBinding,sourceAuthorityRef:original.sourceAuthorityRef,phase:request.phase,reservationId:request.reservationId,
        ...(request.dispatchIntentRef?{dispatchIntentRef:request.dispatchIntentRef}:{}),...(request.transportAttemptId?{transportAttemptId:request.transportAttemptId}:{})},ports.clock));
      gate.checkpoint();if(host)proofs.push(host);else allowed=false;
      const source=await gate.wait(verifySource(ports,original as unknown as Record<string,unknown>,'authorize',original.sourceAuthorityRef));
      gate.checkpoint();if(source){proofs.push(source);}else allowed=false;
      const pricing=await gate.wait(verifyPricing(ports,original));gate.checkpoint();if(pricing?.amount!==null&&pricing)proofs.push(...pricing.proofs);else allowed=false;
      if(state.firstType==='partially_authorized'){
        const ack=state.acknowledgementEvidence as PartialAcknowledgementRequest|null;
        const plan=ack?await gate.wait(verifySource(ports,ack as unknown as Record<string,unknown>,'acknowledgePartial',ack.sourceAuthorityRef)):null;
        gate.checkpoint();if(plan)proofs.push(plan);else allowed=false;
      }
      // Scope permission is distinct from host/source evidence and must be refreshed after those waits.
      const finalScope=await refreshScopeProof(request.scope,request.requestId,ports,'revalidateReservation','budgets.readReservation',gate,proofs);
      if(!finalScope.ok)return finalScope;
      allowed=allowed&&!!currentProofBound(ports,proofs,original);
      gate.beginCommit();await client.query('COMMIT');transaction=false;
      const acknowledgedScope=await refreshScopeProof(request.scope,request.requestId,ports,'revalidateReservation','budgets.readReservation',gate,proofs);
      if(!acknowledgedScope.ok)return acknowledgedScope;
      const returnedBound=currentProofBound(ports,proofs,original);allowed=allowed&&!!returnedBound;
      const {finance,...facts}=snapshot;
      if(allowed&&finance&&returnedBound)finance.expires_at=returnedBound.expiresAt;
      return {ok:true,value:{schemaVersion:'1.0.0',requestId:request.requestId,status:allowed?'authorized':'denied',revoked:!allowed,
        snapshot:{...facts,dispatchEligible:allowed,...(allowed&&finance?{finance}:{})},...(allowed&&finance?{finance}:{})}};
    }catch{if(client&&transaction)await rollback(client);return unavailable();}
    finally{if(client&&transaction)await rollback(client);client?.release();}
  });
}

async function validateDispatchEvidence(state:ReservationState,request:MarkDispatchedCommand,ports:BudgetRuntimePorts):Promise<ApiResult<readonly TimedBudgetProof[]>>{
  const original=state.authorizationRequest;const now=trustedNow(ports);
  const refuse=()=>failure(makeError('markDispatched','FORBIDDEN_SCOPE',request.requestId,'Current dispatch target, source, expiry, lease or revised plan evidence is missing.'));
  if(!original?.authorityBinding||!original.sourceAuthorityRef||!now||Date.parse(original.canonicalRequest.expires_at)<=now.getTime()
    ||request.workerLeaseId!==original.authorityBinding.leaseRef||request.workerLeaseExpiresAt!==original.authorityBinding.leaseExpiresAt)return refuse();
  if(!ports.reservationAuthority||!ports.budgetEvidence)return failure(makeError('markDispatched','BUDGET_UNAVAILABLE',request.requestId,'Current host and source verification is not configured.',true));
  const host=await verifyReservationHost(ports.reservationAuthority,{scope:request.scope,billableAttemptId:original.attemptBinding.billableAttemptId,
    binding:original.authorityBinding,sourceAuthorityRef:original.sourceAuthorityRef,phase:'dispatch',reservationId:request.reservationId,
    dispatchIntentRef:request.dispatchIntentRef,transportAttemptId:request.attemptBinding.transportAttemptId},ports.clock);
  const source=await verifySource(ports,request as unknown as Record<string,unknown>,'markDispatched',request.sourceAuthorityRef);
  const estimate=await verifySource(ports,original as unknown as Record<string,unknown>,'authorize',original.sourceAuthorityRef);
  const pricing=await verifyPricing(ports,original);
  if(!host||!source||!estimate||!pricing||pricing.amount===null)return refuse();
  const proofs:TimedBudgetProof[]=[host,source,estimate,...pricing.proofs];
  if(state.firstType==='partially_authorized'){
    const ack=state.acknowledgementEvidence as PartialAcknowledgementRequest|null;
    const plan=ack?await verifySource(ports,ack as unknown as Record<string,unknown>,'acknowledgePartial',ack.sourceAuthorityRef):null;
    if(!plan)return refuse();proofs.push(plan);
  }
  return currentProofBound(ports,proofs,original)?{ok:true,value:proofs}:refuse();
}
/** Finance-local partial protocol, pending canonical GAP002 acceptance. No acknowledgement is inferred from opt-in. */
export async function acknowledgePartialReservation(value:unknown,ports:BudgetRuntimePorts):Promise<ApiResult<ReservationCommandOutcome>>{
  if(!Value.Check(PartialAcknowledgementRequestSchema,value))return failure(makeError('acknowledgePartial','VALIDATION_ERROR',requestIdOf(value),'The partial acknowledgement is invalid.'));
  const request=structuredClone(value) as PartialAcknowledgementRequest;
  return applyCommand({requestId:request.requestId,idempotencyKey:request.idempotencyKey,scope:request.scope,reservationId:request.reservationId,expectedRevision:request.expectedRevision,currency:'',actorReference:request.actorReference,sourceAuthorityRef:request.sourceAuthorityRef,attemptBinding:request.attemptBinding as Record<string,unknown>,logicalOperationId:(request.attemptBinding as MarkDispatchedCommand['attemptBinding']).logicalOperationId,billableAttemptId:(request.attemptBinding as MarkDispatchedCommand['attemptBinding']).billableAttemptId,kind:'acknowledge_partial',command:request as unknown as Record<string,unknown>,ports,operation:'acknowledgePartial',authority:'budgets.markDispatched',identity:{eventType:'partial_acknowledged',consumed:0n,released:0n,usageFinality:'unknown',settlementSequence:null},
    validateCurrent:async state=>{
      const original=state.authorizationRequest;
      const refuse=()=>failure(makeError('acknowledgePartial','FORBIDDEN_SCOPE',request.requestId,'Current authenticated replan evidence is unavailable.'));
      if(!original||request.revisedPlanHash!==await budgetDigest(request.revisedPlan))return refuse();
      const plan=await verifySource(ports,request as unknown as Record<string,unknown>,'acknowledgePartial',request.sourceAuthorityRef);
      if(!plan||!currentProofBound(ports,[plan],original))return refuse();
      return {ok:true,value:[plan]};
    },
    compute(state){
      if(state.firstType!=='partially_authorized'||state.lastType!=='partially_authorized'||!sameJson(state.originalBinding,request.attemptBinding))return{reject:makeError('acknowledgePartial','VALIDATION_ERROR',request.requestId,'Only the original held partial attempt can acknowledge a replan.')};
      const original=state.authorizationRequest!;const plan=request.revisedPlan;const cap=state.held-state.released-state.consumed;
      if(!original.workPlan||request.allowedWorkUnits!==plan.requestedUnits||request.unit!==plan.unit||request.unit!==original.workPlan.unit||request.allowedWorkUnits>original.workPlan.requestedUnits||parseScaledDecimal(plan.unitMaximumAmount)*BigInt(plan.requestedUnits)>cap||!sameAmount(request.allowedAmount,formatScaledDecimal(cap)))return{reject:makeError('acknowledgePartial','VALIDATION_ERROR',request.requestId,'The acknowledged work must fit the exact granted cap and original work bounds.')};
      return{eventType:'partial_acknowledged',consumed:0n,released:0n,usageFinality:'unknown',settlementSequence:null};
    }});
}

async function persistPolicyDecision(client:BudgetTransactionPort,request:BudgetPolicyChangeRequest,receipt:BudgetPolicyReceipt):Promise<void>{
  const scope=request.scope;const normalized=normalizedBudgetRequest(request as unknown as Record<string,unknown>);
  await client.query(`INSERT INTO cost_intelligence.budget_policy_decisions (decision_id,tenant_id,project_id,environment,billing_mode,currency,idempotency_key,actor_reference,source_authority_ref,command_request,command_receipt,content_hash) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12)`,[crypto.randomUUID(),scope.tenantId,scope.projectId,scope.environment,scope.billingMode,request.currency,request.idempotencyKey,request.actorReference,JSON.stringify(request.sourceAuthorityRef),JSON.stringify(normalized),JSON.stringify(receipt),await budgetDigest({request:normalized,receipt})]);
}
