import { Type, type Static } from '@sinclair/typebox';
import { blockedBoundary, CurrencySchema, NonNegativeDecimalAmountSchema, errorEnvelope, failure, TrustedScopeSchema, validateRequest, type RuntimePorts } from '../shared/contracts.js';
import { validateCanonical, type SharedBudgetReservation, type SharedReleaseRequest, type SharedReserveRequest, type SharedSettleRequest } from '../shared/canonical.js';

const VersionedReferenceSchema = Type.Object({
  contract: Type.String({ minLength: 1 }), schema_version: Type.Literal('1.0.0'), id: Type.String({ minLength: 1 }),
  revision: Type.Integer({ minimum: 0 }), content_hash: Type.String({ pattern: '^sha256:[a-f0-9]{64}$' }),
}, { additionalProperties: false });
const AttemptBindingSchema = Type.Object({
  logicalOperationId: Type.String({ minLength: 1 }), transportAttemptId: Type.String({ minLength: 1 }),
  providerRequestId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]), providerAttemptId: Type.String({ minLength: 1 }),
  billableAttemptId: Type.String({ minLength: 1 }),
}, { additionalProperties: false });
const EstimateEvidenceSchema = Type.Object({
  completeness: Type.Union([Type.Literal('unknown'), Type.Literal('incomplete'), Type.Literal('complete')]),
  knownSubtotal: NonNegativeDecimalAmountSchema, currency: CurrencySchema, rateCardRef: Type.Union([VersionedReferenceSchema, Type.Null()]),
  missingDimensions: Type.Array(Type.String({ minLength: 1 }), { maxItems: 100 }),
  boundedConservativeMaximum: Type.Optional(NonNegativeDecimalAmountSchema),
  maximumPolicyRef: Type.Optional(VersionedReferenceSchema),
}, { additionalProperties: false });

/** Finance-owned envelope around the pinned proposal's ReserveRequest; it adds the explicit partial-consent and estimate evidence needed by this boundary. */
export const ReservationRequestSchema = Type.Object({
  schemaVersion: Type.Literal('1.0.0'), requestId: Type.String({ minLength: 1 }), idempotencyKey: Type.String({ minLength: 1 }),
  scope: TrustedScopeSchema, canonicalRequest: Type.Unknown(), estimate: EstimateEvidenceSchema,
  allowPartialAuthorization: Type.Boolean(), attemptBinding: AttemptBindingSchema,
}, { additionalProperties: false });
export type ReservationRequest = Omit<Static<typeof ReservationRequestSchema>, 'canonicalRequest'> & { readonly canonicalRequest: SharedReserveRequest };

export const AuthorizationDecisionSchema = Type.Object({
  schemaVersion: Type.Literal('1.0.0'), requestId: Type.String({ minLength: 1 }), decidedAt: Type.String({ format: 'date-time' }),
  status: Type.Union([Type.Literal('authorized'), Type.Literal('denied'), Type.Literal('partial'), Type.Literal('unavailable')]),
  reservationId: Type.String({ minLength: 1 }), heldAmount: NonNegativeDecimalAmountSchema, availableAmount: NonNegativeDecimalAmountSchema,
  currency: CurrencySchema, estimateCompleteness: Type.Union([Type.Literal('unknown'), Type.Literal('incomplete'), Type.Literal('complete')]),
  knownSubtotal: NonNegativeDecimalAmountSchema, boundedConservativeMaximum: Type.Union([NonNegativeDecimalAmountSchema, Type.Null()]),
  rateCardRef: Type.Union([VersionedReferenceSchema, Type.Null()]), policyRef: VersionedReferenceSchema,
  expiryEligibility: Type.Union([Type.Literal('eligible_if_never_dispatched'), Type.Literal('not_expired'), Type.Literal('held_for_reconciliation')]),
  attemptBinding: AttemptBindingSchema,
  partialAuthorization: Type.Union([Type.Null(), Type.Object({
    allowedAmount: NonNegativeDecimalAmountSchema, allowedWorkUnits: Type.Union([NonNegativeDecimalAmountSchema, Type.Null()]),
    unit: Type.Union([Type.String({ minLength: 1 }), Type.Null()]), callerAcknowledgementRequired: Type.Literal(true),
    replanBeforeDispatch: Type.Literal(true),
  }, { additionalProperties: false })]),
  retryAfterMs: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
}, { additionalProperties: false });
export type AuthorizationDecision = Static<typeof AuthorizationDecisionSchema>;

const CommandBase = {
  schemaVersion: Type.Literal('1.0.0'), requestId: Type.String({ minLength: 1 }), idempotencyKey: Type.String({ minLength: 1 }),
  scope: TrustedScopeSchema, reservationId: Type.String({ minLength: 1 }), expectedRevision: Type.Integer({ minimum: 0 }),
  actorReference: Type.String({ minLength: 1, maxLength: 200 }), sourceAuthorityRef: VersionedReferenceSchema,
  attemptBinding: AttemptBindingSchema,
};
const EvidenceReferenceArray = Type.Array(VersionedReferenceSchema, { minItems: 1, maxItems: 100 });
export const MarkDispatchedCommandSchema = Type.Object({
  ...CommandBase, action: Type.Literal('mark_dispatched'), dispatchIntentRef: VersionedReferenceSchema,
  workerLeaseId: Type.String({ minLength: 1 }), workerLeaseExpiresAt: Type.String({ format: 'date-time' }),
}, { additionalProperties: false });
export const SettleReservationCommandSchema = Type.Object({
  ...CommandBase, action: Type.Literal('settle'), canonicalCommand: Type.Unknown(),
  settlement: Type.Object({
    measure: Type.Literal('cumulative'), finality: Type.Union([Type.Literal('partial'), Type.Literal('final')]),
    sequence: Type.Integer({ minimum: 1 }), cumulativeAmount: NonNegativeDecimalAmountSchema, currency: CurrencySchema,
    usageCompleteness: Type.Union([Type.Literal('unknown'), Type.Literal('incomplete'), Type.Literal('complete')]),
    sourceObservationRefs: EvidenceReferenceArray, allowObservedOverrun: Type.Literal(true),
  }, { additionalProperties: false }),
}, { additionalProperties: false });
export const ReleaseReservationCommandSchema = Type.Object({
  ...CommandBase, action: Type.Literal('release'), canonicalCommand: Type.Unknown(),
  release: Type.Object({
    amount: NonNegativeDecimalAmountSchema, currency: CurrencySchema, reason: Type.String({ minLength: 1, maxLength: 240 }),
    proof: Type.Union([Type.Literal('never_dispatched_fenced'), Type.Literal('final_usage_known')]), evidenceRefs: EvidenceReferenceArray,
  }, { additionalProperties: false }),
}, { additionalProperties: false });
export const ReservationCommandSchema = Type.Union([MarkDispatchedCommandSchema, SettleReservationCommandSchema, ReleaseReservationCommandSchema]);
export type MarkDispatchedCommand = Static<typeof MarkDispatchedCommandSchema>;
export type SettleReservationCommand = Omit<Static<typeof SettleReservationCommandSchema>, 'canonicalCommand'> & { readonly canonicalCommand: SharedSettleRequest };
export type ReleaseReservationCommand = Omit<Static<typeof ReleaseReservationCommandSchema>, 'canonicalCommand'> & { readonly canonicalCommand: SharedReleaseRequest };
export type ReservationCommand = MarkDispatchedCommand | SettleReservationCommand | ReleaseReservationCommand;

export const ReservationSnapshotSchema = Type.Object({
  schemaVersion: Type.Literal('1.0.0'), requestId: Type.String({ minLength: 1 }), asOf: Type.String({ format: 'date-time' }),
  reservation: Type.Unknown(), state: Type.Union([
    Type.Literal('held'), Type.Literal('dispatched'), Type.Literal('outcome_unknown'), Type.Literal('partially_settled'),
    Type.Literal('settled'), Type.Literal('released'), Type.Literal('expired'), Type.Literal('held_for_reconciliation'),
  ]),
  heldAmount: NonNegativeDecimalAmountSchema, effectiveConsumedAmount: NonNegativeDecimalAmountSchema, releasedAmount: NonNegativeDecimalAmountSchema,
  latestCumulativeSettlement: NonNegativeDecimalAmountSchema, overrunAmount: NonNegativeDecimalAmountSchema, usageFinality: Type.Union([Type.Literal('unknown'), Type.Literal('partial'), Type.Literal('final')]),
  expectedRevision: Type.Integer({ minimum: 0 }), attemptBinding: AttemptBindingSchema,
}, { additionalProperties: false });
export type ReservationSnapshot = Omit<Static<typeof ReservationSnapshotSchema>, 'reservation'> & { readonly reservation: SharedBudgetReservation };

export const BudgetChangeRequestSchema = Type.Object({
  schemaVersion: Type.Literal('1.0.0'), requestId: Type.String({ minLength: 1 }), idempotencyKey: Type.String({ minLength: 1 }),
  scope: TrustedScopeSchema, newLimit: NonNegativeDecimalAmountSchema, currency: CurrencySchema,
  expectedPolicyRevision: Type.Integer({ minimum: 0 }), expectedLedgerRevision: Type.Integer({ minimum: 0 }),
  actorReference: Type.String({ minLength: 1, maxLength: 200 }), reasonReference: Type.String({ minLength: 1, maxLength: 200 }),
}, { additionalProperties: false });
export type BudgetChangeRequest = Static<typeof BudgetChangeRequestSchema>;

export const BudgetChangeReceiptSchema = Type.Object({
  schemaVersion: Type.Literal('1.0.0'), requestId: Type.String({ minLength: 1 }), status: Type.Union([
    Type.Literal('applied'), Type.Literal('denied'), Type.Literal('stale'), Type.Literal('replay'), Type.Literal('conflict'),
  ]), requestedLimit: NonNegativeDecimalAmountSchema, previousLimit: NonNegativeDecimalAmountSchema, effectiveLimit: NonNegativeDecimalAmountSchema,
  effectiveConsumedSpend: NonNegativeDecimalAmountSchema, activeUnconsumedCommitments: NonNegativeDecimalAmountSchema,
  expectedPolicyRevision: Type.Integer({ minimum: 0 }), resultingPolicyRevision: Type.Integer({ minimum: 0 }),
  alertThresholdPercent: Type.Literal(80), decisionPolicyVersion: Type.Literal('ci-budget-policy-1.0.0'),
  decisionReference: VersionedReferenceSchema,
}, { additionalProperties: false });
export type BudgetChangeReceipt = Static<typeof BudgetChangeReceiptSchema>;

export const ExpenseAdjustmentRequestSchema = Type.Object({
  schemaVersion: Type.Literal('1.0.0'), requestId: Type.String({ minLength: 1 }), idempotencyKey: Type.String({ minLength: 1 }),
  scope: TrustedScopeSchema, adjustmentId: Type.String({ minLength: 1 }), amount: NonNegativeDecimalAmountSchema, currency: CurrencySchema,
  direction: Type.Union([Type.Literal('increase_expense'), Type.Literal('decrease_expense')]),
  expectedLedgerRevision: Type.Integer({ minimum: 0 }), actorReference: Type.String({ minLength: 1, maxLength: 200 }),
  reasonReference: Type.String({ minLength: 1, maxLength: 200 }), originalPostingRef: VersionedReferenceSchema,
  sourceReference: Type.String({ minLength: 1, maxLength: 240 }), sourceContentHash: Type.String({ pattern: '^sha256:[a-f0-9]{64}$' }),
  evidenceMode: Type.Union([Type.Literal('mocked'), Type.Literal('sandbox'), Type.Literal('live')]),
}, { additionalProperties: false });
export type ExpenseAdjustmentRequest = Static<typeof ExpenseAdjustmentRequestSchema>;

export const PostingReceiptSchema = Type.Object({
  schemaVersion: Type.Literal('1.0.0'), requestId: Type.String({ minLength: 1 }), postingId: Type.String({ minLength: 1 }),
  status: Type.Union([Type.Literal('applied'), Type.Literal('denied'), Type.Literal('stale'), Type.Literal('replay'), Type.Literal('conflict')]),
  ledgerRevision: Type.Integer({ minimum: 0 }), originalPostingRef: VersionedReferenceSchema,
}, { additionalProperties: false });
export type PostingReceipt = Static<typeof PostingReceiptSchema>;

export async function authorize(request: ReservationRequest, ports: RuntimePorts) {
  const validation = validateRequest(ReservationRequestSchema, request, 'budgets', 'authorize');
  if (!validation.ok) return failure(validation.error);
  const parsed = validation.value as ReservationRequest;
  const canonical = validateCanonical({ contract: 'ReserveRequest', value: parsed.canonicalRequest, module: 'budgets', operation: 'authorize', requestId: parsed.requestId });
  if (!canonical.ok) return failure(canonical.error);
  if (canonical.value.tenant_id !== parsed.scope.tenantId || canonical.value.project_id !== parsed.scope.projectId || canonical.value.environment !== parsed.scope.environment || canonical.value.billing_mode !== parsed.scope.billingMode) {
    return failure(errorEnvelope('budgets', 'authorize', 'FORBIDDEN_SCOPE', parsed.requestId, 'The reservation does not match the authenticated tenant, project, environment, or billing mode.'));
  }
  try {
    const trusted = await ports.trustedContext.resolve(parsed.scope);
    if (!trusted || trusted.tenantId !== parsed.scope.tenantId || trusted.projectId !== parsed.scope.projectId || trusted.environment !== parsed.scope.environment || trusted.billingMode !== parsed.scope.billingMode || trusted.actorId !== parsed.scope.actorId) {
      return failure(errorEnvelope('budgets', 'authorize', 'FORBIDDEN_SCOPE', parsed.requestId, 'The requested financial scope is not authorized.'));
    }
  } catch {
    return failure(errorEnvelope('budgets', 'authorize', 'SOURCE_UNAVAILABLE', parsed.requestId, 'Trusted authorization context is temporarily unavailable.', true));
  }
  return failure(errorEnvelope('budgets', 'authorize', 'BUDGET_UNAVAILABLE', parsed.requestId, 'Atomic reservation is not available until the budget enforcement leaf is delivered.', true));
}

async function reservationCommand(request: ReservationCommand, ports: RuntimePorts, operation: string) {
  const validation = validateRequest(ReservationCommandSchema, request, 'budgets', operation);
  if (!validation.ok) return failure(validation.error);
  const parsed = validation.value as ReservationCommand;
  if (parsed.action !== 'mark_dispatched') {
    const contract = parsed.action === 'settle' ? 'SettleRequest' : 'ReleaseRequest';
    const canonical = validateCanonical({ contract, value: parsed.canonicalCommand, module: 'budgets', operation, requestId: parsed.requestId });
    if (!canonical.ok) return failure(canonical.error);
    const command = canonical.value as SharedSettleRequest | SharedReleaseRequest;
    if (command.tenant_id !== parsed.scope.tenantId || command.project_id !== parsed.scope.projectId || command.environment !== parsed.scope.environment || command.billing_mode !== parsed.scope.billingMode || command.reservation_id !== parsed.reservationId || command.expected_revision !== parsed.expectedRevision) {
      return failure(errorEnvelope('budgets', operation, 'FORBIDDEN_SCOPE', parsed.requestId, 'The reservation command does not match its authenticated scope or expected revision.'));
    }
  }
  return blockedBoundary<ReservationCommand, ReservationSnapshot>({ module: 'budgets', operation, schema: ReservationCommandSchema, request: parsed, ports, unavailableCode: 'BUDGET_UNAVAILABLE', safeMessage: `Reservation ${operation} is not available until the budget lifecycle leaf is delivered.`, retryable: true });
}

export async function markDispatched(request: MarkDispatchedCommand, ports: RuntimePorts) { return reservationCommand(request, ports, 'markDispatched'); }
export async function settle(request: SettleReservationCommand, ports: RuntimePorts) { return reservationCommand(request, ports, 'settle'); }
export async function release(request: ReleaseReservationCommand, ports: RuntimePorts) { return reservationCommand(request, ports, 'release'); }
export async function changeBudget(request: BudgetChangeRequest, ports: RuntimePorts) {
  return blockedBoundary<BudgetChangeRequest, BudgetChangeReceipt>({ module: 'budgets', operation: 'changeBudget', schema: BudgetChangeRequestSchema, request, ports, unavailableCode: 'BUDGET_UNAVAILABLE', safeMessage: 'Budget policy evaluation is not available until the budget enforcement leaf is delivered.', retryable: true });
}
export async function recordExpenseAdjustment(request: ExpenseAdjustmentRequest, ports: RuntimePorts) {
  return blockedBoundary<ExpenseAdjustmentRequest, PostingReceipt>({ module: 'budgets', operation: 'recordExpenseAdjustment', schema: ExpenseAdjustmentRequestSchema, request, ports, unavailableCode: 'SOURCE_UNAVAILABLE', safeMessage: 'Expense adjustment posting is not available until the accounting leaf is delivered.', retryable: true });
}
