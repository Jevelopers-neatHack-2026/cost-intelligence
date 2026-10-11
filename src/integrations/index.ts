import { Type, type Static } from '@sinclair/typebox';
import { errorEnvelope, failure, TrustedScopeSchema, validateRequest, blockedBoundary, type RuntimePorts } from '../shared/contracts.js';
import { validateSummarySnapshot, FinancialSummaryPageSchema, type FinancialSummaryPage } from '../reporting/index.js';

export const ExportRequestSchema = Type.Object({
  schemaVersion: Type.Literal('1.0.0'), requestId: Type.String({ minLength: 1 }), idempotencyKey: Type.String({ minLength: 1 }),
  scope: TrustedScopeSchema, summarySnapshot: FinancialSummaryPageSchema, summaryContentHash: Type.String({ pattern: '^sha256:[a-f0-9]{64}$' }),
  destination: Type.Literal('cfo.ai'), format: Type.Union([Type.Literal('json'), Type.Literal('csv')]),
  requestedAt: Type.String({ format: 'date-time' }), evidenceMode: Type.Union([Type.Literal('mocked'), Type.Literal('sandbox'), Type.Literal('live')]),
  requestedBy: Type.String({ minLength: 1, maxLength: 200 }),
}, { additionalProperties: false });
export type ExportRequest = Omit<Static<typeof ExportRequestSchema>, 'summarySnapshot'> & { readonly summarySnapshot: FinancialSummaryPage };

export const ExportManifestSchema = Type.Object({
  schemaVersion: Type.Literal('1.0.0'), requestId: Type.String({ minLength: 1 }), exportId: Type.String({ minLength: 1 }),
  status: Type.Union([Type.Literal('prepared'), Type.Literal('delivered'), Type.Literal('failed')]), destination: Type.Literal('cfo.ai'),
  summaryId: Type.String({ minLength: 1 }), summaryRevision: Type.Integer({ minimum: 0 }), summaryContentHash: Type.String({ pattern: '^sha256:[a-f0-9]{64}$' }),
  snapshotId: Type.String({ minLength: 1 }), snapshotAsOf: Type.String({ format: 'date-time' }), snapshotTimezone: Type.String({ minLength: 1 }),
  watermarkId: Type.String({ minLength: 1 }), queryContentHash: Type.String({ pattern: '^sha256:[a-f0-9]{64}$' }),
  createdAt: Type.String({ format: 'date-time' }), itemCount: Type.Integer({ minimum: 0 }), evidenceMode: Type.Union([Type.Literal('mocked'), Type.Literal('sandbox'), Type.Literal('live')]),
  deliveryReference: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
}, { additionalProperties: false });
export type ExportManifest = Static<typeof ExportManifestSchema>;

export async function exportSummary(request: ExportRequest, ports: RuntimePorts) {
  const validation = validateRequest(ExportRequestSchema, request, 'integrations', 'exportSummary');
  if (!validation.ok) return failure(validation.error);
  const parsed = validation.value as ExportRequest;
  const snapshotValidation = validateRequest(FinancialSummaryPageSchema, parsed.summarySnapshot, 'integrations', 'exportSummary');
  if (!snapshotValidation.ok) return failure(snapshotValidation.error);
  const snapshot = snapshotValidation.value as FinancialSummaryPage;
  const canonical = validateSummarySnapshot({ summary: snapshot.summary, module: 'integrations', operation: 'exportSummary', requestId: parsed.requestId });
  if (!canonical.ok) return failure(canonical.error);
  const summary = canonical.value;
  if (snapshot.summaryContentHash !== parsed.summaryContentHash
      || summary.tenant_id !== parsed.scope.tenantId || summary.project_id !== parsed.scope.projectId
      || !summary.included_environments.includes(parsed.scope.environment) || !summary.included_billing_modes.includes(parsed.scope.billingMode)
      || snapshot.filters.environments.some(value => value !== parsed.scope.environment)
      || snapshot.filters.billingModes.some(value => value !== parsed.scope.billingMode)) {
    return failure(errorEnvelope('integrations', 'exportSummary', 'FORBIDDEN_SCOPE', parsed.requestId, 'The summary does not match the authenticated export scope.'));
  }
  return blockedBoundary<ExportRequest, ExportManifest>({ module: 'integrations', operation: 'exportSummary', schema: ExportRequestSchema, request: parsed, ports, unavailableCode: 'SOURCE_UNAVAILABLE', safeMessage: 'Export preparation is unavailable until a reviewed summary and export adapter are delivered.', retryable: true });
}
