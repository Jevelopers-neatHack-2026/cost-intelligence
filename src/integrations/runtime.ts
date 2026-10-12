import { acquireDisclosure, validateDisclosure, bindDisclosure, sealDisclosureSuccess, releaseDisclosure } from './disclosure-fence.js';
import { createHash } from 'node:crypto';
import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { checkFinancialSummary, type VersionedReference } from '@jevelopers/shared-contracts';
import { errorEnvelope, failure, validateRequest, TrustedScopeSchema, type ApiResult, type ErrorCode, type RuntimePorts, type TrustedScope } from '../shared/contracts.js';
import { validateFinancialSummaryPageBoundary, type FinancialSummaryPage } from '../reporting/index.js';
import { ExportManifestSchema, validateExportRequestBoundary, type ExportManifest, type ExportRequest } from './index.js';
import { encodeCsv, encodeMoneyCell, encodeTextCell, type CsvCell } from './csv.js';
import { reportingExportBridge, authorizeExportAccess, checkRegisteredCanonicalSummary, type ReportingExportBridge } from './reporting-bridge.js';
import { prepareReportingExport, type ReportingExportRequest, type ReportingPreparedExportArtifacts } from './reporting-export.js';

const MAX_BYTES = 1_048_576;
const MAX_METRICS = 100;
const HashSchema = Type.String({ pattern: '^sha256:[a-f0-9]{64}$' });
const ArtifactReceiptSchema = Type.Object({
  fileName: Type.Union([Type.Literal('summary.json'), Type.Literal('metrics.csv')]),
  mediaType: Type.Union([Type.Literal('application/json'), Type.Literal('text/csv')]),
  contentHash: HashSchema, byteLength: Type.Integer({ minimum: 1, maximum: MAX_BYTES }),
}, { additionalProperties: false });

/** Finance-owned export proposal, separate from the unchanged canonical FinancialSummary. */
export const ExportArtifactManifestV2Schema = Type.Object({
  schemaVersion: Type.Literal('2.0.0'), status: Type.Literal('prepared'), destination: Type.Literal('cfo.ai'),
  exportId: Type.String({ minLength: 1, maxLength: 200 }),
  createdAt: Type.String({ format: 'date-time' }),
  requestedFormat: Type.Union([Type.Literal('json'), Type.Literal('csv')]),
  evidenceMode: Type.Union([Type.Literal('mocked'), Type.Literal('sandbox'), Type.Literal('live')]),
  snapshotId: Type.String({ minLength: 1, maxLength: 200 }),
  summaryContentHash: HashSchema, queryContentHash: HashSchema, snapshotEnvelopeHash: HashSchema,
  artifactSetHash: HashSchema,
  artifacts: Type.Array(ArtifactReceiptSchema, { minItems: 2, maxItems: 2 }),
  compatibility: Type.Object({
    financialSummarySchema: Type.Literal('1.0.0'), financeExportSchema: Type.Literal('2.0.0'),
    sharedContractsPackage: Type.Literal('0.3.0'), adoption: Type.Literal('proposal_only'),
    financeDefinitions: Type.Literal('pending_owner_review'), dashboardSdkMapping: Type.Literal('pending_consumer_ack'),
  }, { additionalProperties: false }),
  delivery: Type.Literal('manual_prepared'),
}, { additionalProperties: false });
export type ExportArtifactManifestV2 = Static<typeof ExportArtifactManifestV2Schema>;

export type ExportArtifact = {
  readonly fileName: 'summary.json' | 'metrics.csv';
  readonly mediaType: 'application/json' | 'text/csv';
  readonly contentHash: string;
  readonly byteLength: number;
  readonly content: string;
};
export type PreparedExportArtifacts = {
  readonly manifest: ExportManifest;
  readonly artifactManifest: ExportArtifactManifestV2;
  readonly artifacts: readonly ExportArtifact[];
};
export type StoredExportArtifacts = {
  readonly requestHash: string;
  /** Restricted server-side association; never returned by the public artifact API. */
  readonly sourceBinding: { readonly snapshotId: string; readonly watermarkId: string; readonly summaryContentHash: string; readonly queryContentHash: string };
  readonly prepared: PreparedExportArtifacts;
};
/** Trusted host must retrieve an immutable, scope-bound stored CI-08 snapshot, never echo caller input. */
export type ExportSnapshotReaderPort = {
  readVerifiedSnapshot(request: {
    readonly scope: TrustedScope;
    readonly snapshotId: string;
    readonly summaryContentHash: string;
    readonly queryContentHash: string;
  }): Promise<FinancialSummaryPage | null>;
};
/** Host persistence stores artifacts only. No financial events or balances belong here. */
export type ExportArtifactStorePort = {
  lookup(keyHash: string): Promise<StoredExportArtifacts | null>;
  commitImmutable(keyHash: string, value: StoredExportArtifacts): Promise<StoredExportArtifacts>;
  /** Verify the original authenticated immutable storage claim, including first preparation time. */
  verifyOriginal(keyHash: string, value: StoredExportArtifacts): Promise<boolean>;
};
export type ExportRuntimePorts = RuntimePorts & {
  exports?: {
    readonly snapshotReader: ExportSnapshotReaderPort;
    readonly artifactStore: ExportArtifactStorePort;
    /** Explicit isolated fixture registration. Real Finance registry/producer agreement is still pending. */
    readonly syntheticFixtureRegistry?: {
      readonly mode: 'synthetic_only';
      readonly summaryContentHash: string;
      readonly policyRef: FinancialSummaryPage['summary']['policy_ref'];
      readonly metricDefinitionRefs: Readonly<Record<string, FinancialSummaryPage['summary']['policy_ref']>>;
      readonly references: Readonly<Record<string, VersionedReference>>;
    };
  };
};

export function hashExportCanonical(value: unknown): string {
  return hashBytes(canonicalJson(value));
}
function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + Array.from(value, canonicalJson).join(',') + ']';
  if (typeof value === 'object' && value !== null) {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalJson((value as Record<string, unknown>)[key])).join(',') + '}';
  }
  throw new Error('Invalid canonical export content.');
}
function hashBytes(content: string): string {
  return 'sha256:' + createHash('sha256').update(content, 'utf8').digest('hex');
}
function freezeCopy<T>(value: T): T {
  const copy = structuredClone(value);
  const freeze = (item: unknown) => {
    if (typeof item === 'object' && item !== null) {
      for (const child of Object.values(item)) freeze(child);
      Object.freeze(item);
    }
  };
  freeze(copy);
  return copy;
}
function opaqueReference(kind: string, value: string): string {
  return kind + ':' + hashExportCanonical(value).slice(7);
}
function contentBound(value: unknown): boolean {
  try { return new TextEncoder().encode(canonicalJson(value)).length <= MAX_BYTES; } catch { return false; }
}
function boundedInput(value: unknown): boolean {
  let bytes = 0;
  let nodes = 0;
  const seen = new WeakSet<object>();
  const visit = (item: unknown, depth: number): boolean => {
    if (++nodes > 20_000 || depth > 32) return false;
    if (typeof item === 'string') bytes += new TextEncoder().encode(item).length;
    else if (typeof item === 'object' && item !== null) {
      if (seen.has(item)) return false;
      seen.add(item);
      for (const [key, child] of Object.entries(item)) {
        bytes += new TextEncoder().encode(key).length;
        if (bytes > MAX_BYTES || !visit(child, depth + 1)) return false;
      }
      // Repeated immutable subobjects are valid JSON; only an ancestor cycle is rejected.
      seen.delete(item);
    }
    return bytes <= MAX_BYTES;
  };
  try { return visit(value, 0); } catch { return false; }
}

const DEFINITIONS = Object.freeze({
  expense: 'Observed effective expense. Unknown observations are not zero; estimates are distinguished by valuation basis.',
  gross_sales: 'Recognized actual sale amounts before discounts and refunds, excluding pass-through taxes and simulated sales.',
  net_sales: 'Gross sales less discounts and sales refunds, excluding simulated sales.',
  direct_costs: 'Attributed actual direct expense and fees, less linked recoveries; shared expense is posted once.',
  contribution: 'Net sales less direct costs; excludes cash movements.',
  cash_receipts: 'Observed cash receipts, separate from accounting sales. Missing cash observations remain unknown.',
  cash_payouts: 'Observed cash payouts, separate from accounting expense. Payouts are not new sales.',
  cash_net: 'Observed cash receipts less payouts. Missing cash observations remain unknown.',
});
const SAFE_SOURCE_NAMES = new Set(['ledger', 'usage_intake', 'budget_holds', 'billing_export', 'provider_billing', 'cash', 'financial_events', 'accounting']);
function safeSourceName(value: string): string {
  return SAFE_SOURCE_NAMES.has(value) ? value : 'unclassified_source';
}
function scopedPage(page: FinancialSummaryPage, scope: TrustedScope): boolean {
  const summary = page.summary;
  return summary.tenant_id === scope.tenantId && summary.project_id === scope.projectId
    && summary.environment === scope.environment && summary.billing_mode === scope.billingMode
    && summary.included_environments.length === 1 && summary.included_environments[0] === scope.environment
    && summary.included_billing_modes.length === 1 && summary.included_billing_modes[0] === scope.billingMode
    && page.filters.environments.length === 1 && page.filters.environments[0] === scope.environment
    && page.filters.billingModes.length === 1 && page.filters.billingModes[0] === scope.billingMode
    && (page.filters.currency === undefined || page.filters.currency === summary.currency);
}
function snapshotEnvelope(page: FinancialSummaryPage) {
  const { requestId: _transportRequestId, ...economicSnapshot } = page;
  return economicSnapshot;
}
function requestFingerprint(request: ExportRequest): string {
  return hashExportCanonical({
    schemaVersion: request.schemaVersion, scope: request.scope,
    snapshot: snapshotEnvelope(request.summarySnapshot), summaryContentHash: request.summaryContentHash,
    destination: request.destination, format: request.format, evidenceMode: request.evidenceMode,
  });
}
function storageKey(request: ExportRequest): string {
  return hashExportCanonical({ scope: request.scope, idempotencyKey: request.idempotencyKey });
}
function storedMatchesSource(stored: StoredExportArtifacts, page: FinancialSummaryPage, request: ExportRequest, key: string): boolean {
  const manifest = stored.prepared.manifest;
  const detail = stored.prepared.artifactManifest;
  const exportId = 'export:' + key.slice(7);
  return stored.sourceBinding.snapshotId === page.snapshotId && stored.sourceBinding.watermarkId === page.watermark.watermarkId
    && stored.sourceBinding.summaryContentHash === page.summaryContentHash && stored.sourceBinding.queryContentHash === page.queryContentHash
    && manifest.exportId === exportId && manifest.requestId === exportId
    && manifest.summaryId === page.summary.summary_id && manifest.summaryRevision === page.summary.revision
    && manifest.summaryContentHash === page.summaryContentHash && manifest.snapshotId === opaqueReference('snapshot', page.snapshotId)
    && manifest.snapshotAsOf === page.asOf && manifest.snapshotTimezone === page.timezone
    && manifest.watermarkId === opaqueReference('watermark', page.watermark.watermarkId) && manifest.queryContentHash === page.queryContentHash
    && manifest.itemCount === Object.keys(page.summary.metrics).length && manifest.evidenceMode === request.evidenceMode
    && detail.requestedFormat === request.format && detail.evidenceMode === request.evidenceMode
    && detail.snapshotId === opaqueReference('snapshot', page.snapshotId) && detail.summaryContentHash === page.summaryContentHash
    && detail.queryContentHash === page.queryContentHash
    && detail.snapshotEnvelopeHash === hashExportCanonical(snapshotEnvelope(page));
}

function projectDocument(page: FinancialSummaryPage, evidenceMode: ExportRequest['evidenceMode'], bridge?: ReportingExportBridge) {
  const summary = page.summary;
  const entries = Object.entries(summary.metrics).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  if (entries.length === 0 || entries.length > MAX_METRICS
      || entries.some(([name]) => !Object.hasOwn(DEFINITIONS, name))) throw new UnsupportedExport();
  const metrics = entries.map(([metric, value]) => {
    if (value.definition_ref.contract !== (bridge ? bridge.registry.metrics[metric]?.reference.contract : 'MetricDefinition')) throw new UnsupportedExport();
    if (value.status === 'known' && value.value.currency !== summary.currency) throw new UnsupportedExport();
    const definition = bridge ? bridge.registry.metrics[metric]!.definition.formula : DEFINITIONS[metric as keyof typeof DEFINITIONS];
    return {
      metric, definition, definitionStatus: 'pending_owner_review' as const,
      definitionHash: hashExportCanonical({ metric, definition, policy: 'ci06-accounting-policy-1.0.0' }),
      producerDefinition: { schemaVersion: value.definition_ref.schema_version, revision: value.definition_ref.revision, contentHash: value.definition_ref.content_hash },
      status: value.status,
      amount: value.status === 'known' ? encodeMoneyCell(value.value.amount, value.value.scale) : null,
      currency: summary.currency, scale: value.status === 'known' ? value.value.scale : summary.scale,
      valuationBasis: summary.valuation_basis,
      sourceHashes: value.source_refs.map(reference => reference.content_hash).sort(),
    };
  });
  // No caller text, raw refs, tenant/customer/provider IDs, prompts, addresses or credentials flow to files.
  return {
    schemaVersion: '2.0.0', kind: 'finance_export_proposal', evidenceMode,
    period: { start: summary.period.start, end: summary.period.end }, timezone: page.timezone,
    asOf: page.asOf, environment: summary.environment, billingMode: summary.billing_mode,
    currency: summary.currency, scale: summary.scale, rounding: summary.rounding, roundingBoundary: summary.rounding_boundary,
    accounting: { mappingPolicyVersion: 'ci06-accounting-policy-1.0.0', mappingAllocationVersion: 'ci06-allocation-policy-1.0.0', appliedPolicyStatus: 'pending_query_producer_verification', definitionsStatus: 'pending_owner_review', producerPolicy: { schemaVersion: summary.policy_ref.schema_version, revision: summary.policy_ref.revision, contentHash: summary.policy_ref.content_hash } },
    valuationBasis: summary.valuation_basis, settlement: summary.settlement, reconciliation: summary.reconciliation,
    completeness: summary.completeness,
    coverage: { observed: summary.coverage.observed, expected: summary.coverage.expected, missingSourceCount: summary.coverage.missing_sources.length, missingSources: summary.coverage.missing_sources.map(safeSourceName).sort() },
    metrics,
    assumptions: { forecast: [], businessPlanInputs: [], status: 'not_supplied', note: 'No forecasts or business-plan assumptions are inferred from observed financial events.' },
    provenance: {
      ...(bridge ? { sourceEvidenceStatus: 'not_exposed_by_query' } : {}),
      snapshotId: opaqueReference('snapshot', page.snapshotId), summaryContentHash: page.summaryContentHash, queryContentHash: page.queryContentHash,
      snapshotEnvelopeHash: hashExportCanonical(snapshotEnvelope(page)),
      sourceWatermarks: page.watermark.sources.map(source => ({ source: safeSourceName(source.source), revisionHash: hashExportCanonical(source.revision), observedThrough: source.observedThrough, contentHash: source.contentHash, completeness: source.completeness })).sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b))),
      policyVersion: summary.policy_version,
    },
    limitations: ['Finance metric definitions and shared FinancialSummary remain proposals pending owner review.', 'Unknown values are null; absent metrics are unavailable, never zero.', 'No provider connector, cash completeness, CFO.ai plan or dashboard consumer acknowledgement is asserted.'],
  };
}
class UnsupportedExport extends Error {}

function buildArtifacts(page: FinancialSummaryPage, request: ExportRequest, bridge?: ReportingExportBridge): readonly ExportArtifact[] {
  const document = projectDocument(page, request.evidenceMode, bridge);
  const text = (value: string): CsvCell => ({ kind: 'text', value });
  // Money uses the existing typed money encoder; negative numeric cells are not converted to formula-like text.
  const rows = document.metrics.map(metric => [
    text(metric.metric), text(metric.definition), text(metric.definitionStatus), text(metric.status),
    text(metric.currency), { kind: 'integer', value: metric.scale } as CsvCell,
    metric.amount === null ? { kind: 'empty' } as CsvCell : { kind: 'money', amount: metric.amount, scale: metric.scale } as CsvCell,
    text(metric.valuationBasis), text(document.completeness), text(document.reconciliation),
    text(document.period.start), text(document.period.end), text(document.timezone), text(document.environment), text(document.billingMode),
    text(document.provenance.summaryContentHash), text(document.provenance.queryContentHash),
  ]);
  const json = canonicalJson(document) + '\n';
  const csv = encodeCsv(['metric', 'definition', 'definition_status', 'status', 'currency', 'scale', 'amount', 'valuation_basis', 'completeness', 'reconciliation', 'period_start', 'period_end', 'timezone', 'environment', 'billing_mode', 'summary_content_hash', 'query_content_hash'], rows);
  return ([['summary.json', 'application/json', json], ['metrics.csv', 'text/csv', csv]] as const).map(([fileName, mediaType, content]) => {
    const byteLength = new TextEncoder().encode(content).length;
    if (byteLength > MAX_BYTES) throw new Error('Export size limit exceeded.');
    // Validate textual JSON too, including malformed Unicode and control-character policy.
    encodeTextCell(content.replaceAll('\n', '').replaceAll('\r', ''));
    return { fileName, mediaType, content, contentHash: hashBytes(content), byteLength };
  });
}

export function validStoredExport(value: unknown): value is StoredExportArtifacts {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as StoredExportArtifacts;
  if (Object.keys(record).sort().join(',') !== 'prepared,requestHash,sourceBinding' || !/^sha256:[a-f0-9]{64}$/.test(record.requestHash ?? '')) return false;
  const binding = record.sourceBinding;
  if (typeof binding !== 'object' || binding === null || Object.keys(binding).sort().join(',') !== 'queryContentHash,snapshotId,summaryContentHash,watermarkId'
      || typeof binding.snapshotId !== 'string' || binding.snapshotId.length < 1 || binding.snapshotId.length > 200
      || typeof binding.watermarkId !== 'string' || binding.watermarkId.length < 1 || binding.watermarkId.length > 200
      || !/^sha256:[a-f0-9]{64}$/.test(binding.summaryContentHash ?? '') || !/^sha256:[a-f0-9]{64}$/.test(binding.queryContentHash ?? '')) return false;
  const prepared = record.prepared;
  if (typeof prepared !== 'object' || prepared === null || Object.keys(prepared).sort().join(',') !== 'artifactManifest,artifacts,manifest') return false;
  if (!validateRequest(ExportManifestSchema, prepared.manifest, 'integrations', 'exportSummary').ok
      || !Value.Check(ExportArtifactManifestV2Schema, prepared.artifactManifest)
      || !Array.isArray(prepared.artifacts) || prepared.artifacts.length !== 2) return false;
  if (prepared.manifest.status !== 'prepared' || prepared.manifest.deliveryReference !== null
      || prepared.manifest.exportId !== prepared.artifactManifest.exportId
      || prepared.manifest.createdAt !== prepared.artifactManifest.createdAt) return false;
  return prepared.artifacts.every((artifact, index) => {
    const receipt = prepared.artifactManifest.artifacts[index];
    return artifact !== null && typeof artifact === 'object'
      && Object.keys(artifact).sort().join(',') === 'byteLength,content,contentHash,fileName,mediaType'
      && typeof artifact.content === 'string' && artifact.byteLength <= MAX_BYTES
      && artifact.byteLength === new TextEncoder().encode(artifact.content).length
      && artifact.contentHash === hashBytes(artifact.content)
      && receipt?.contentHash === artifact.contentHash && receipt?.byteLength === artifact.byteLength
      && receipt?.fileName === artifact.fileName && receipt?.mediaType === artifact.mediaType;
  }) && prepared.artifactManifest.artifactSetHash === hashExportCanonical(prepared.artifactManifest.artifacts)
    && contentBound(record);
}

const AuthEnvelopeSchema = Type.Object({ requestId: Type.String({ minLength: 1, maxLength: 128 }), scope: TrustedScopeSchema }, { additionalProperties: true });
export async function prepareExport(request: ExportRequest, ports: ExportRuntimePorts, allowPrepare: boolean): Promise<ApiResult<PreparedExportArtifacts>> {
  if (!boundedInput(request)) return failure(errorEnvelope('integrations', 'exportSummary', 'VALIDATION_ERROR', 'unavailable', 'The export request exceeds supported content bounds.'));
  let frozenRequest: ExportRequest;
  try { frozenRequest = freezeCopy(request); }
  catch { return failure(errorEnvelope('integrations', 'exportSummary', 'VALIDATION_ERROR', 'unavailable', 'The export request could not be validated.')); }
  const envelope = validateRequest(AuthEnvelopeSchema, frozenRequest, 'integrations', 'exportSummary');
  if (!envelope.ok) return failure(envelope.error);
  const configuredExports = ports.exports;
  const capturedBridge = reportingExportBridge(ports);
  const acquired = capturedBridge ? await acquireDisclosure(capturedBridge.disclosureFence, envelope.value.scope, envelope.value.requestId) : { ok: true as const, value: undefined };
  if (!acquired.ok) return failure(acquired.error);
  const disclosure = acquired.value;
  const entryFence = validateDisclosure(disclosure, ports.clock); if (!entryFence.ok) return entryFence;
  const frozenRegistry = configuredExports?.syntheticFixtureRegistry === undefined ? undefined : freezeCopy(configuredExports.syntheticFixtureRegistry);
  const authorize = () => authorizeExportAccess(ports, envelope.value, capturedBridge);
  const reject = (code: ErrorCode, message: string, retryable = false) => failure(errorEnvelope('integrations', 'exportSummary', code, envelope.value.requestId, message, retryable));
  const initial = await authorize();
  if (!initial.ok) return failure(initial.error);
  { const current = validateDisclosure(disclosure, ports.clock); if (!current.ok) return current; }
  if (!contentBound(frozenRequest)) return reject('VALIDATION_ERROR', 'The export request exceeds supported content bounds.');
  const validated = validateExportRequestBoundary(frozenRequest);
  if (!validated.ok) return failure(validated.error);
  const parsed = freezeCopy(validated.value);
  if (parsed.requestId.length > 128 || parsed.idempotencyKey.length > 200 || parsed.requestedBy.length > 200) return reject('VALIDATION_ERROR', 'The export request exceeds supported content bounds.');
  if (!scopedPage(parsed.summarySnapshot, parsed.scope) || parsed.summaryContentHash !== parsed.summarySnapshot.summaryContentHash) return reject('FORBIDDEN_SCOPE', 'The summary does not match the authenticated export scope.');
  if (!configuredExports) return reject('SOURCE_UNAVAILABLE', 'Export preparation requires a verified query snapshot reader and artifact store.', true);
  try {
    const key = storageKey(parsed);
    const fingerprint = requestFingerprint(parsed);
    let auth = await authorize();
    if (!auth.ok) return failure(auth.error);
    { const current = validateDisclosure(disclosure, ports.clock); if (!current.ok) return current; }
    const lookupResult = await configuredExports.artifactStore.lookup(key);
    const existing = lookupResult === null ? null : freezeCopy(lookupResult);
    { const current = validateDisclosure(disclosure, ports.clock); if (!current.ok) return current; }
    auth = await authorize();
    if (!auth.ok) return failure(auth.error);
    { const current = validateDisclosure(disclosure, ports.clock); if (!current.ok) return current; }
    if (existing !== null && !validStoredExport(existing)) return reject('SOURCE_UNAVAILABLE', 'The prepared export could not be verified.', true);
    if (existing !== null && existing.requestHash !== fingerprint) return reject('IDEMPOTENCY_CONFLICT', 'This export key is already bound to different financial content.');
    const source = await configuredExports.snapshotReader.readVerifiedSnapshot({ scope: parsed.scope, snapshotId: parsed.summarySnapshot.snapshotId, summaryContentHash: parsed.summaryContentHash, queryContentHash: parsed.summarySnapshot.queryContentHash });
    { const current = validateDisclosure(disclosure, ports.clock); if (!current.ok) return current; }
    auth = await authorize();
    if (!auth.ok) return failure(auth.error);
    { const current = validateDisclosure(disclosure, ports.clock); if (!current.ok) return current; }
    if (source === null || !contentBound(source)) return reject('SOURCE_UNAVAILABLE', 'The verified query snapshot is unavailable.', true);
    const pageValidation = validateFinancialSummaryPageBoundary(source, { module: 'integrations', operation: 'exportSummary' });
    if (!pageValidation.ok) return reject('SOURCE_UNAVAILABLE', 'The verified query snapshot could not be validated.', true);
    const page = freezeCopy(pageValidation.value);
    if (!scopedPage(page, parsed.scope)) return reject('FORBIDDEN_SCOPE', 'The summary does not match the authenticated export scope.');
    if (hashExportCanonical(page.summary) !== page.summaryContentHash
        || hashExportCanonical(snapshotEnvelope(page)) !== hashExportCanonical(snapshotEnvelope(parsed.summarySnapshot))) return reject('IDEMPOTENCY_CONFLICT', 'The expected summary differs from the verified query snapshot.');
    const bridge = capturedBridge;
    const registry = frozenRegistry;
    if (bridge) {
      if (!checkRegisteredCanonicalSummary(page, parsed.scope, ports.clock.now().toISOString())) return reject('SOURCE_UNAVAILABLE', 'The registered query summary failed financial semantic validation.', true);
    } else {
    if (parsed.evidenceMode !== 'mocked' || registry?.mode !== 'synthetic_only'
        || registry.summaryContentHash !== page.summaryContentHash
        || hashExportCanonical(registry.policyRef) !== hashExportCanonical(page.summary.policy_ref)
        || Object.entries(page.summary.metrics).some(([metric, value]) =>
          !Object.hasOwn(registry.metricDefinitionRefs, metric)
          || hashExportCanonical(registry.metricDefinitionRefs[metric]) !== hashExportCanonical(value.definition_ref))) {
      return reject('UNSUPPORTED_VERSION', 'A verified Finance metric and policy registry is required; only explicitly registered synthetic fixtures are supported.');
    }
    const semantic = checkFinancialSummary(page.summary, {
      scope: { tenant_id: page.summary.tenant_id, project_id: page.summary.project_id },
      now: ports.clock.now().toISOString() as FinancialSummaryPage['summary']['occurred_at'], policy_version: '1.0.0',
      references: registry.references, currency: page.summary.currency,
      included_environments: [parsed.scope.environment], included_billing_modes: [parsed.scope.billingMode],
    });
    if (!semantic.ok) return reject('SOURCE_UNAVAILABLE', 'The verified query snapshot failed financial semantic validation.', true);
    }
    auth = await authorize();
    if (!auth.ok) return failure(auth.error);
    { const current = validateDisclosure(disclosure, ports.clock); if (!current.ok) return current; }
    const artifacts = freezeCopy(buildArtifacts(page, parsed, bridge));
    if (existing !== null) {
      if (!storedMatchesSource(existing, page, parsed, key)
          || hashExportCanonical(artifacts) !== hashExportCanonical(existing.prepared.artifacts)) return reject('SOURCE_UNAVAILABLE', 'The prepared export does not match the verified query snapshot.', true);
      if (!await configuredExports.artifactStore.verifyOriginal(key, existing)) return reject('SOURCE_UNAVAILABLE', 'The original preparation receipt could not be authenticated.', true);
    { const current = validateDisclosure(disclosure, ports.clock); if (!current.ok) return current; }
      auth = await authorize();
      if (!auth.ok) return failure(auth.error);
    { const current = validateDisclosure(disclosure, ports.clock); if (!current.ok) return current; }
      bindDisclosure(existing.prepared, disclosure);
      const sealed = sealDisclosureSuccess(existing.prepared);
      { const current = validateDisclosure(disclosure, ports.clock); if (!current.ok) return current; }
      return sealed;
    }
    if (!allowPrepare) return reject('SOURCE_UNAVAILABLE', 'No immutable prepared export exists for this request.', true);
    const createdAt = ports.clock.now().toISOString();
    const receipts = artifacts.map(({ content: _content, ...receipt }) => receipt);
    const exportId = 'export:' + key.slice(7);
    const manifest: ExportManifest = {
      schemaVersion: '1.0.0', requestId: exportId, exportId, status: 'prepared', destination: parsed.destination,
      summaryId: page.summary.summary_id, summaryRevision: page.summary.revision, summaryContentHash: page.summaryContentHash,
      snapshotId: opaqueReference('snapshot', page.snapshotId), snapshotAsOf: page.asOf, snapshotTimezone: page.timezone,
      watermarkId: opaqueReference('watermark', page.watermark.watermarkId), queryContentHash: page.queryContentHash, createdAt,
      itemCount: Object.keys(page.summary.metrics).length, evidenceMode: parsed.evidenceMode, deliveryReference: null,
    };
    const artifactManifest: ExportArtifactManifestV2 = {
      schemaVersion: '2.0.0', status: 'prepared', destination: 'cfo.ai', exportId, createdAt,
      requestedFormat: parsed.format, evidenceMode: parsed.evidenceMode, snapshotId: opaqueReference('snapshot', page.snapshotId),
      summaryContentHash: page.summaryContentHash, queryContentHash: page.queryContentHash,
      snapshotEnvelopeHash: hashExportCanonical(snapshotEnvelope(page)), artifactSetHash: hashExportCanonical(receipts), artifacts: receipts,
      compatibility: { financialSummarySchema: '1.0.0', financeExportSchema: '2.0.0', sharedContractsPackage: '0.3.0', adoption: 'proposal_only', financeDefinitions: 'pending_owner_review', dashboardSdkMapping: 'pending_consumer_ack' },
      delivery: 'manual_prepared',
    };
    const candidate: StoredExportArtifacts = freezeCopy({ requestHash: fingerprint, sourceBinding: { snapshotId: page.snapshotId, watermarkId: page.watermark.watermarkId, summaryContentHash: page.summaryContentHash, queryContentHash: page.queryContentHash }, prepared: { manifest, artifactManifest, artifacts } });
    if (!validStoredExport(candidate)) return reject('SOURCE_UNAVAILABLE', 'The prepared export could not be verified.', true);
    auth = await authorize();
    if (!auth.ok) return failure(auth.error);
    { const current = validateDisclosure(disclosure, ports.clock); if (!current.ok) return current; }
    const stored = freezeCopy(await configuredExports.artifactStore.commitImmutable(key, candidate));
    { const current = validateDisclosure(disclosure, ports.clock); if (!current.ok) return current; }
    auth = await authorize();
    if (!auth.ok) return failure(auth.error);
    { const current = validateDisclosure(disclosure, ports.clock); if (!current.ok) return current; }
    if (!validStoredExport(stored)) return reject('SOURCE_UNAVAILABLE', 'The prepared export could not be verified.', true);
    if (stored.requestHash !== fingerprint) return reject('IDEMPOTENCY_CONFLICT', 'This export key is already bound to different financial content.');
    if (!storedMatchesSource(stored, page, parsed, key)
        || hashExportCanonical(stored.prepared.artifacts) !== hashExportCanonical(artifacts)) return reject('SOURCE_UNAVAILABLE', 'The prepared export does not match the verified query snapshot.', true);
    if (!await configuredExports.artifactStore.verifyOriginal(key, stored)) return reject('SOURCE_UNAVAILABLE', 'The original preparation receipt could not be authenticated.', true);
    { const current = validateDisclosure(disclosure, ports.clock); if (!current.ok) return current; }
    auth = await authorize();
    if (!auth.ok) return failure(auth.error);
    { const current = validateDisclosure(disclosure, ports.clock); if (!current.ok) return current; }
    bindDisclosure(stored.prepared, disclosure);
    const sealed = sealDisclosureSuccess(stored.prepared);
    { const current = validateDisclosure(disclosure, ports.clock); if (!current.ok) return current; }
    return sealed;
  } catch (error) {
    return error instanceof UnsupportedExport
      ? reject('UNSUPPORTED_VERSION', 'The summary contains an unsupported metric definition or currency.')
      : reject('SOURCE_UNAVAILABLE', 'Export preparation is temporarily unavailable.', true);
  }
}

export function exportSummaryV2(request: ReportingExportRequest, ports: ExportRuntimePorts): Promise<ApiResult<ReportingPreparedExportArtifacts>>;
export function exportSummaryV2(request: ExportRequest, ports: ExportRuntimePorts): Promise<ApiResult<PreparedExportArtifacts>>;
export async function exportSummaryV2(request: ExportRequest | ReportingExportRequest, ports: ExportRuntimePorts): Promise<ApiResult<PreparedExportArtifacts | ReportingPreparedExportArtifacts>> {
  const result = await (request?.schemaVersion === '2.0.0' ? prepareReportingExport(request, ports, true) : prepareExport(request as ExportRequest, ports, true));
  return releaseDisclosure<PreparedExportArtifacts | ReportingPreparedExportArtifacts>(result, ports.clock, !!reportingExportBridge(ports));
}
export function getPreparedExportArtifacts(request: ReportingExportRequest, ports: ExportRuntimePorts): Promise<ApiResult<ReportingPreparedExportArtifacts>>;
export function getPreparedExportArtifacts(request: ExportRequest, ports: ExportRuntimePorts): Promise<ApiResult<PreparedExportArtifacts>>;
export async function getPreparedExportArtifacts(request: ExportRequest | ReportingExportRequest, ports: ExportRuntimePorts): Promise<ApiResult<PreparedExportArtifacts | ReportingPreparedExportArtifacts>> {
  const result = await (request?.schemaVersion === '2.0.0' ? prepareReportingExport(request, ports, false) : prepareExport(request as ExportRequest, ports, false));
  return releaseDisclosure<PreparedExportArtifacts | ReportingPreparedExportArtifacts>(result, ports.clock, !!reportingExportBridge(ports));
}

export { canonicalJson as canonicalExportJson, freezeCopy as freezeExportValue };
