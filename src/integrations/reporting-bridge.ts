import type { ExportDisclosureFencePort } from './disclosure-fence.js';
import { Value } from '@sinclair/typebox/value';
import { createReportingSnapshotReader, readVerifiedSummarySnapshotV2, REPORTING_CANONICAL_REFERENCE_REGISTRY, ReportingMetricDefinitionSchema, ReportingPolicyDefinitionSchema, type FinancialSummaryPageV2, type ReportingPorts } from '../reporting/index.js';
import { checkFinancialSummary, type VersionedReference } from '@jevelopers/shared-contracts';
import type { FinancialSummaryPage } from '../reporting/index.js';
import { hashExportCanonical, freezeExportValue, type ExportRuntimePorts, type ExportArtifactStorePort } from './runtime.js';
import { authorizeFinanceOperation, errorEnvelope, sameScope, type ApiResult, type FinanceAuthorizationResult, type TrustedScope } from '../shared/contracts.js';
import type { ReportingExportArtifactStorePort } from './reporting-export.js';

/** Exact immutable Finance-owned registry body; raw committed fixture SHA is independently tested. */
export const REPORTING_EXPORT_REGISTRY_PIN = 'sha256:827ac8d4e37adc354dc8721d4f34c4c3bfb0039b318ae769ed8fec3e249055c2';
type Registry = typeof REPORTING_CANONICAL_REFERENCE_REGISTRY;
function pinRegistry(value: Registry): Registry {
  const registry = freezeExportValue(value);
  if (hashExportCanonical(registry) !== REPORTING_EXPORT_REGISTRY_PIN) throw new Error('The Finance definition registry does not match the export pin.');
  for (const [name, entry] of Object.entries(registry.metrics)) {
    if (!Value.Check(ReportingMetricDefinitionSchema, entry.definition) || entry.definition.metric !== name
        || entry.reference.id !== entry.definition.definitionId || entry.reference.contract !== entry.definition.contract
        || entry.reference.revision !== entry.definition.revision || entry.reference.content_hash !== hashExportCanonical(entry.definition)) {
      throw new Error('The Finance metric definition does not match its registered artifact.');
    }
  }
  if (!Value.Check(ReportingPolicyDefinitionSchema, registry.policy.definition)
      || registry.policy.reference.id !== registry.policy.definition.definitionId
      || registry.policy.reference.content_hash !== hashExportCanonical(registry.policy.definition)) throw new Error('The Finance policy definition does not match its registered artifact.');
  return registry;
}
// Copied at module initialization, before any query response can expose a producer alias.
const PINNED_REGISTRY = pinRegistry(REPORTING_CANONICAL_REFERENCE_REGISTRY);
type SnapshotReference = { readonly scope: TrustedScope; readonly snapshotId: string; readonly queryContentHash: string; readonly summaryContentHash: string };
export type ReportingExportBridge = {
  readonly registry: Registry;
  readonly disclosureFence?: ExportDisclosureFencePort;
  readonly artifactStoreV2?: ReportingExportArtifactStorePort;
  resolveCurrentContext(request: { readonly scope: TrustedScope; readonly requestId: string }): Promise<ApiResult<TrustedScope>>;
  authorizeCurrentRead(request: { readonly scope: TrustedScope; readonly requestId: string }): Promise<FinanceAuthorizationResult>;
  readVerifiedSnapshotV2(request: SnapshotReference): Promise<FinancialSummaryPageV2 | null>;
};
const bridges = new WeakMap<object, ReportingExportBridge>();

/**
 * Concrete composition over the public Finance PostgreSQL readers. No caller
 * summary, requestedBy label, or generic "verified" flag establishes provenance.
 * Each reader freshly enforces reporting permission in addition to export permission.
 */
export function createReportingExportRuntimePorts(ports: ReportingPorts, artifactStore: ExportArtifactStorePort, artifactStoreV2?: ReportingExportArtifactStorePort, disclosureFence?: ExportDisclosureFencePort): ExportRuntimePorts {
  const configured = Object.freeze({ snapshotReader: Object.freeze(createReportingSnapshotReader(ports)), artifactStore });
  bridges.set(configured, Object.freeze({
    registry: PINNED_REGISTRY,
    ...(disclosureFence ? { disclosureFence } : {}),
    ...(artifactStoreV2 ? { artifactStoreV2 } : {}),
    async resolveCurrentContext(request: { readonly scope: TrustedScope; readonly requestId: string }): Promise<ApiResult<TrustedScope>> {
      try {
        const frozen = freezeExportValue(request);
        const received = await ports.trustedContext.resolve(frozen.scope);
        const current = received === null ? null : freezeExportValue(received);
        if (!current || !sameScope(current, frozen.scope)) return { ok: false, error: errorEnvelope('integrations', 'exportSummary', 'FORBIDDEN_SCOPE', 'unavailable', 'The requested financial scope is not authorized.') };
        return { ok: true, value: current };
      } catch {
        return { ok: false, error: errorEnvelope('integrations', 'exportSummary', 'SOURCE_UNAVAILABLE', 'unavailable', 'Current financial context is temporarily unavailable.', true) };
      }
    },
    async authorizeCurrentRead(request: { readonly scope: TrustedScope; readonly requestId: string }) {
      const frozen = freezeExportValue(request);
      return authorizeFinanceOperation({ module: 'integrations', requestOperation: 'exportSummary', operation: 'reporting.querySummary',
        scope: frozen.scope, requestId: frozen.requestId, clock: ports.clock, financeAuthority: ports.financeAuthority });
    },
    async readVerifiedSnapshotV2(request: SnapshotReference) {
      const result = await readVerifiedSummarySnapshotV2({ ...freezeExportValue(request), schemaVersion: '1.0.0', requestId: 'finance-export-verified-snapshot' }, ports);
      return result.ok ? freezeExportValue(result.value) : null;
    },
  }));
  return { ...ports, exports: configured };
}
export function reportingExportBridge(ports: ExportRuntimePorts): ReportingExportBridge | undefined {
  return ports.exports ? bridges.get(ports.exports) : undefined;
}
/** Renew both independently scoped operations after every composed export await.
 * The read issuer is the captured Finance reporting host, never a caller flag.
 * Copy each decision immediately; preserve the independently bound context veto,
 * and validate grant freshness after all authority/context awaits finish.
 */
export async function authorizeExportAccess(ports: ExportRuntimePorts, request: { readonly scope: TrustedScope; readonly requestId: string }, bridge?: ReportingExportBridge): Promise<FinanceAuthorizationResult> {
  try {
    const checks = [authorizeFinanceOperation({ module: 'integrations', requestOperation: 'exportSummary', operation: 'integrations.exportSummary',
      scope: request.scope, requestId: request.requestId, clock: ports.clock, financeAuthority: ports.financeAuthority })];
    if (bridge) checks.push(bridge.authorizeCurrentRead({ scope: request.scope, requestId: request.requestId }));
    const decisions = await Promise.all(checks.map(async check => freezeExportValue(await check)));
    for (const decision of decisions) if (!decision.ok) return decision;
    // The producer requires this separate veto as well as current grants.
    // Resolve after both grant awaits, then check their expiry at this final point.
    if (bridge) {
      const current = await bridge.resolveCurrentContext({ scope: request.scope, requestId: request.requestId });
      if (!current.ok) return current;
    }
    const now = ports.clock.now().getTime();
    if (!Number.isFinite(now)) return { ok: false, error: errorEnvelope('integrations', 'exportSummary', 'SOURCE_UNAVAILABLE', 'unavailable', 'Current financial authorization is temporarily unavailable.', true) };
    for (const result of decisions) {
      if (!result.ok) return result;
      if (result.decision.status !== 'allowed') return { ok: false, error: errorEnvelope('integrations', 'exportSummary', 'FORBIDDEN_SCOPE', 'unavailable', 'Current financial authorization does not match this scope and operation.') };
      const verified = Date.parse(result.decision.verifiedAt); const expires = Date.parse(result.decision.expiresAt);
      // Each shared checker enforces these bounds at its own completion. Renew
      // that freshness at the joint disclosure gate, after the other permission wait.
      if (!Number.isFinite(verified) || !Number.isFinite(expires) || verified > now || now - verified > 60_000
          || expires <= now || expires <= verified || expires - verified > 300_000) {
        return { ok: false, error: errorEnvelope('integrations', 'exportSummary', 'FORBIDDEN_SCOPE', 'unavailable', 'Current financial authorization does not match this scope and operation.') };
      }
    }
    return decisions[0]!;
  } catch {
    return { ok: false, error: errorEnvelope('integrations', 'exportSummary', 'SOURCE_UNAVAILABLE', 'unavailable', 'Current financial authorization is temporarily unavailable.', true) };
  }
}
export function checkRegisteredCanonicalSummary(page: Pick<FinancialSummaryPage, 'summary'>, scope: TrustedScope, now: string): boolean {
  if (page.summary.tenant_id !== scope.tenantId || page.summary.project_id !== scope.projectId) return false;
  const references: Record<string, VersionedReference> = { policy_ref: PINNED_REGISTRY.policy.reference as VersionedReference };
  for (const name of Object.keys(page.summary.metrics)) {
    const registered = PINNED_REGISTRY.metrics[name];
    if (!registered) return false;
    references[`metrics/${name}/definition_ref`] = registered.reference as VersionedReference;
  }
  return checkFinancialSummary(page.summary, {
    scope: { tenant_id: page.summary.tenant_id, project_id: page.summary.project_id },
    now: now as FinancialSummaryPage['summary']['occurred_at'], policy_version: '1.0.0', references, currency: page.summary.currency,
    included_environments: [scope.environment], included_billing_modes: [scope.billingMode],
  }).ok;
}
