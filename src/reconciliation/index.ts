import { Type, type Static } from '@sinclair/typebox';
import { blockedBoundary, CurrencySchema, DecimalAmountSchema, TrustedScopeSchema, type ApiResult, type RuntimePorts } from '../shared/contracts.js';

const SourceSnapshotSchema = Type.Object({
  name: Type.String({ minLength: 1 }), revision: Type.String({ minLength: 1 }), contentHash: Type.String({ pattern: '^sha256:[a-f0-9]{64}$' }),
  evidenceMode: Type.Union([Type.Literal('mocked'), Type.Literal('sandbox'), Type.Literal('live')]),
  verificationStatus: Type.Union([Type.Literal('verified'), Type.Literal('unverified'), Type.Literal('unknown')]),
}, { additionalProperties: false });

export const ReconciliationRequestSchema = Type.Object({
  schemaVersion: Type.Literal('1.0.0'), requestId: Type.String({ minLength: 1 }), idempotencyKey: Type.String({ minLength: 1 }),
  scope: TrustedScopeSchema, sourceSnapshots: Type.Array(SourceSnapshotSchema, { minItems: 1, maxItems: 100 }),
  windowStart: Type.String({ format: 'date-time' }), windowEnd: Type.String({ format: 'date-time' }),
  runId: Type.Optional(Type.String({ minLength: 1 })), cursor: Type.Optional(Type.String({ minLength: 1 })), pageSize: Type.Integer({ minimum: 1, maximum: 500 }),
  requestedBy: Type.String({ minLength: 1, maxLength: 200 }),
}, { additionalProperties: false });
export type ReconciliationRequest = Static<typeof ReconciliationRequestSchema>;

export const ReconciliationRunSchema = Type.Object({
  schemaVersion: Type.Literal('1.0.0'), requestId: Type.String({ minLength: 1 }), runId: Type.String({ minLength: 1 }),
  status: Type.Union([Type.Literal('pending'), Type.Literal('running'), Type.Literal('complete'), Type.Literal('needs_review'), Type.Literal('failed')]),
  startedAt: Type.String({ format: 'date-time' }), finishedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  sourceSnapshots: Type.Array(SourceSnapshotSchema, { minItems: 1 }), scannedCount: Type.Integer({ minimum: 0 }),
  matchedCount: Type.Integer({ minimum: 0 }), unmatchedCount: Type.Integer({ minimum: 0 }), exceptionCount: Type.Integer({ minimum: 0 }),
  ownerReference: Type.String({ minLength: 1 }), nextAction: Type.String({ minLength: 1 }),
}, { additionalProperties: false });
export type ReconciliationRun = Static<typeof ReconciliationRunSchema>;

export const ReconciliationResultSchema = Type.Object({
  schemaVersion: Type.Literal('1.0.0'), requestId: Type.String({ minLength: 1 }), runId: Type.String({ minLength: 1 }),
  status: Type.Union([Type.Literal('pending'), Type.Literal('running'), Type.Literal('complete'), Type.Literal('needs_review'), Type.Literal('failed')]),
  asOf: Type.String({ format: 'date-time' }), currency: CurrencySchema,
  matchedCount: Type.Integer({ minimum: 0 }), unmatchedCount: Type.Integer({ minimum: 0 }), exceptionCount: Type.Integer({ minimum: 0 }),
  knownVariance: DecimalAmountSchema, unknownVarianceCount: Type.Integer({ minimum: 0 }),
  missingSources: Type.Array(Type.String({ minLength: 1 }), { maxItems: 100 }), sourceSnapshots: Type.Array(SourceSnapshotSchema, { minItems: 1 }),
  ownerReference: Type.String({ minLength: 1 }), nextAction: Type.String({ minLength: 1 }),
}, { additionalProperties: false });
export type ReconciliationResult = Static<typeof ReconciliationResultSchema>;

export async function startReconciliation(request: ReconciliationRequest, ports: RuntimePorts): Promise<ApiResult<ReconciliationRun>> {
  return blockedBoundary<ReconciliationRequest, ReconciliationRun>({ module: 'reconciliation', operation: 'startReconciliation', schema: ReconciliationRequestSchema, request, ports, unavailableCode: 'RECONCILIATION_PENDING', safeMessage: 'Reconciliation cannot start until its source adapters and matching rules are delivered.', retryable: true });
}
export async function getReconciliation(request: ReconciliationRequest, ports: RuntimePorts): Promise<ApiResult<ReconciliationResult>> {
  return blockedBoundary<ReconciliationRequest, ReconciliationResult>({ module: 'reconciliation', operation: 'getReconciliation', schema: ReconciliationRequestSchema, request, ports, unavailableCode: 'RECONCILIATION_PENDING', safeMessage: 'Reconciliation results are unavailable until its source adapters and matching rules are delivered.', retryable: true });
}
