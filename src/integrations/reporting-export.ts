import { acquireDisclosure, validateDisclosure, bindDisclosure, sealDisclosureSuccess } from './disclosure-fence.js';
import { Type, type Static } from '@sinclair/typebox';
import { createHash } from 'node:crypto';
import { Value } from '@sinclair/typebox/value';
import { errorEnvelope, failure, TrustedScopeSchema, type Validation, type ApiResult, type ErrorCode } from '../shared/contracts.js';
import { FinancialSummaryPageV2Schema, validateFinancialSummaryPageV2Boundary, type FinancialSummaryPageV2 } from '../reporting/index.js';
import { encodeCsv, encodeMoneyCell, type CsvCell } from './csv.js';
import { canonicalExportJson, freezeExportValue, hashExportCanonical, type ExportArtifact, type ExportRuntimePorts } from './runtime.js';
import { reportingExportBridge, authorizeExportAccess, checkRegisteredCanonicalSummary, REPORTING_EXPORT_REGISTRY_PIN, type ReportingExportBridge } from './reporting-bridge.js';

const MAX_BYTES = 1_048_576;
const Hash = Type.String({ pattern: '^sha256:[a-f0-9]{64}$' });
const Instant = Type.String({ format: 'date-time' });
const ArtifactReceipt = Type.Object({ fileName: Type.Union([Type.Literal('summary.json'), Type.Literal('metrics.csv')]), mediaType: Type.Union([Type.Literal('application/json'), Type.Literal('text/csv')]), contentHash: Hash, byteLength: Type.Integer({ minimum: 1, maximum: MAX_BYTES }) }, { additionalProperties: false });
export const ReportingExportRequestSchema = Type.Object({
  schemaVersion: Type.Literal('2.0.0'), requestId: Type.String({ minLength: 1, maxLength: 128 }), idempotencyKey: Type.String({ minLength: 1, maxLength: 200 }), scope: TrustedScopeSchema,
  summarySnapshot: FinancialSummaryPageV2Schema, summaryContentHash: Hash,
  destination: Type.Literal('cfo.ai'), format: Type.Union([Type.Literal('json'), Type.Literal('csv')]), requestedAt: Instant,
  evidenceMode: Type.Union([Type.Literal('mocked'), Type.Literal('sandbox'), Type.Literal('live')]), requestedBy: Type.String({ minLength: 1, maxLength: 200 }),
}, { additionalProperties: false });
export type ReportingExportRequest = Omit<Static<typeof ReportingExportRequestSchema>, 'summarySnapshot'> & { readonly summarySnapshot: FinancialSummaryPageV2 };
/** Structural wrappers require the producer's complete canonical boundary as well. */
export function validateReportingExportRequestBoundary(value: unknown): Validation<ReportingExportRequest> {
  if (!Value.Check(ReportingExportRequestSchema, value)) return failure(errorEnvelope('integrations', 'exportSummary', 'VALIDATION_ERROR', 'unavailable', 'The reporting export request does not match its exact version.'));
  const outer = value as ReportingExportRequest;
  const snapshot = validateFinancialSummaryPageV2Boundary(outer.summarySnapshot);
  if (!snapshot.ok) return snapshot;
  if (snapshot.value.canonicalSummaries.some(summary => !checkRegisteredCanonicalSummary({ summary }, outer.scope, snapshot.value.asOf))) return failure(errorEnvelope('integrations', 'exportSummary', 'VALIDATION_ERROR', 'unavailable', 'The registered canonical mapping fails complete financial validation.'));
  return { ok: true, value: { ...outer, summarySnapshot: snapshot.value } as ReportingExportRequest };
}

export const ReportingExportManifestSchema = Type.Object({
  schemaVersion: Type.Literal('2.0.0'), sourceEncoding: Type.Literal('2.0.0'), exportId: Hash, status: Type.Literal('prepared'), destination: Type.Literal('cfo.ai'),
  createdAt: Instant, snapshotId: Hash, queryContentHash: Hash, projectionContentHash: Hash, snapshotEnvelopeHash: Hash,
  definitionRegistryHash: Hash, artifactSetHash: Hash, artifacts: Type.Array(ArtifactReceipt, { minItems: 2, maxItems: 2 }),
  evidenceMode: Type.Union([Type.Literal('mocked'), Type.Literal('sandbox'), Type.Literal('live')]), requestedFormat: Type.Union([Type.Literal('json'), Type.Literal('csv')]),
  period: Type.Object({ start: Instant, end: Instant }, { additionalProperties: false }), timezone: Type.String({ minLength: 1, maxLength: 64 }),
  currencies: Type.Array(Type.String({ pattern: '^[A-Z]{3}$' }), { maxItems: 100, uniqueItems: true }), itemCount: Type.Integer({ minimum: 0, maximum: 1100 }),
  delivery: Type.Literal('manual_prepared'), deliveryReference: Type.Null(), canonicalAdoption: Type.Literal('proposal_only'), definitionsStatus: Type.Literal('pending_owner_review'), consumerAcknowledgement: Type.Literal('pending'),
  sourceEvidenceStatus: Type.Literal('not_exposed_by_query'),
}, { additionalProperties: false });
export type ReportingExportManifest = Static<typeof ReportingExportManifestSchema>;
const Artifact = Type.Object({ ...ArtifactReceipt.properties, content: Type.String({ minLength: 1, maxLength: MAX_BYTES }) }, { additionalProperties: false });
export const ReportingExportReceiptSchema = Type.Object({ schemaVersion: Type.Literal('2.0.0'), manifest: ReportingExportManifestSchema, artifacts: Type.Array(Artifact, { minItems: 2, maxItems: 2 }) }, { additionalProperties: false });
export type ReportingPreparedExportArtifacts = Static<typeof ReportingExportReceiptSchema>;
export type ReportingStoredExportArtifacts = { readonly requestHash: string; readonly prepared: ReportingPreparedExportArtifacts };
export type ReportingExportArtifactStorePort = {
  lookup(keyHash: string): Promise<ReportingStoredExportArtifacts | null>;
  commitImmutable(keyHash: string, value: ReportingStoredExportArtifacts): Promise<ReportingStoredExportArtifacts>;
  verifyOriginal(keyHash: string, value: ReportingStoredExportArtifacts): Promise<boolean>;
};
const METRICS = { expense: 'expense', grossSales: 'gross_sales', netSales: 'net_sales', directCosts: 'direct_costs', contribution: 'contribution', cashReceipts: 'cash_receipts', cashPayouts: 'cash_payouts' } as const;
function withoutTransport(page: FinancialSummaryPageV2) { const { requestId: _requestId, ...frozen } = page; return frozen; }
function preparedBinding(prepared: ReportingPreparedExportArtifacts) {
  const { createdAt: _createdAt, ...manifest } = prepared.manifest;
  return { artifacts: prepared.artifacts, manifest, schemaVersion: prepared.schemaVersion };
}
function byteCount(text: string): number { return new TextEncoder().encode(text).length; }
function bounded(value: unknown): boolean {
  try {
    const ancestors = new WeakSet<object>(); let count = 0;
    const visit = (item: unknown, depth: number): boolean => {
      if (++count > 100_000 || depth > 32) return false;
      if (typeof item === 'string') return byteCount(item) <= MAX_BYTES;
      if (item === null || typeof item !== 'object') return true;
      if (ancestors.has(item) || Object.keys(item).length > 50_000) return false;
      ancestors.add(item); const valid = Object.values(item).every(child => visit(child, depth + 1)); ancestors.delete(item);
      return valid;
    };
    return visit(value, 0) && byteCount(canonicalExportJson(value)) <= MAX_BYTES;
  } catch { return false; }
}
function safeReference(reference: { id: string; revision: number; contentHash: string } | null) { return reference === null ? null : { idHash: hashExportCanonical(reference.id), revision: reference.revision, contentHash: reference.contentHash }; }
function safeSource(name: string): string { return /^(?:(?:expense|revenue|cash):[A-Z]{3}|financial_ledger|usage_intake|budget_reservations|allocation_policies|product_evidence)$/.test(name) ? name : 'unclassified_source'; }
function projectionDocument(page: FinancialSummaryPageV2, request: ReportingExportRequest, bridge: ReportingExportBridge) {
  const summary = page.summary;
  const currencies = summary.currencies.map(row => ({
    currency: row.currency, scale: row.scale,
    metrics: Object.entries(METRICS).map(([key, metric]) => {
      const value = row.metrics[key as keyof typeof METRICS];
      const registered = bridge.registry.metrics[metric]!;
      for (const amount of [value.knownSubtotal, value.total]) if (amount !== null) encodeMoneyCell(amount, row.scale);
      return { metric, recognition: 'actual', definition: registered.definition.formula, definitionReference: { id: registered.reference.id, revision: registered.reference.revision, contentHash: registered.reference.content_hash },
        status: value.status, knownSubtotal: value.knownSubtotal, total: value.total, unknownCount: value.unknownCount, perMetricValuation: 'not_supplied_by_query' };
    }),
    expenseValuation: { estimated: { ...row.valuation.estimated }, confirmed: { ...row.valuation.confirmed }, unknownCount: row.valuation.unknownCount, scope: 'currency_expense_axis_only' },
    reconciliation: { ...row.reconciliation },
    simulated: Object.entries(row.simulated).map(([key, value]) => {
      if (typeof value !== 'object' || value === null) throw new Error('The producer simulation encoding does not retain unknown amounts.');
      const amount = value as { status: string; knownSubtotal: string | null; total: string | null; unknownCount: number };
      const metric = METRICS[key as keyof typeof METRICS];
      const registered = bridge.registry.metrics[metric]!;
      return { metric, recognition: 'simulated', definition: `Parallel simulated ${metric}; excluded from actual recognition.`,
        definitionReference: { id: registered.reference.id, revision: registered.reference.revision, contentHash: registered.reference.content_hash },
        status: amount.status, knownSubtotal: amount.knownSubtotal, total: amount.total, unknownCount: amount.unknownCount, perMetricValuation: 'not_supplied_by_query' };
    }),
    groups: row.groups.map(group => ({ dimension: group.dimension, valueHash: group.value === null ? null : hashExportCanonical(group.value), bucket: group.bucket, eventCount: group.eventCount,
      metrics: Object.fromEntries(Object.entries(METRICS).map(([key, metric]) => [metric, { ...group.metrics[key as keyof typeof METRICS] }])) })),
  }));
  return {
    schemaVersion: '2.0.0', kind: 'finance_reporting_export_proposal', evidenceMode: request.evidenceMode,
    period: { ...page.period }, timezone: page.timezone, asOf: page.asOf, environment: request.scope.environment, billingMode: request.scope.billingMode,
    accounting: { reportingPolicyVersion: summary.policyVersion, accountingPolicyVersion: bridge.registry.policy.definition.accountingPolicyVersion, allocationPolicyVersion: bridge.registry.policy.definition.allocationPolicyVersion,
      definitionRegistryHash: REPORTING_EXPORT_REGISTRY_PIN, definitionsStatus: 'pending_owner_review', policyReference: { id: bridge.registry.policy.reference.id, revision: bridge.registry.policy.reference.revision, contentHash: bridge.registry.policy.reference.content_hash } },
    unavailableMetrics: [{ metric: 'cash_net', status: 'not_supplied_by_query', knownSubtotal: null, total: null }],
    currencies, coverage: { ...summary.coverage, missingSources: summary.coverage.missingSources.map(safeSource) },
    budgets: summary.budgets.map(budget => ({ ...budget, policyReference: safeReference(budget.policyReference) })),
    unitCosts: summary.unitCosts.map(cost => ({ ...cost, approvalReference: safeReference(cost.approvalReference) })),
    allocations: summary.allocations.map(allocation => ({ ...allocation, policyReference: safeReference(allocation.policyReference), allocations: allocation.allocations.map(target => ({ keyHash: hashExportCanonical(target.key), amount: target.amount })) })),
    assumptions: { forecast: [], businessPlanInputs: [], status: 'not_supplied' },
    provenance: { snapshotId: page.snapshotId, queryContentHash: page.queryContentHash, projectionContentHash: page.summaryContentHash,
      snapshotEnvelopeHash: hashExportCanonical(withoutTransport(page)), canonicalSummaryHashes: page.canonicalSummaries.map(hashExportCanonical), canonicalMappingStatus: page.canonicalMappingStatus,
      sourceWatermarks: page.watermark.sources.map(source => ({ source: safeSource(source.source), revisionHash: hashExportCanonical(source.revision), observedThrough: source.observedThrough, contentHash: source.contentHash, completeness: source.completeness })) },
    sourceEvidenceStatus: 'not_exposed_by_query',
    limitations: ['Metric and policy definitions remain proposals pending owner sign-off.', 'Observed known subtotals are separate from unknown or partial totals; absent cash never becomes zero.', 'Currency blocks are never combined without sourced conversion.', 'No provider charge, mounted host issuer, consumer ACK or CFO delivery is established by an export request label.'],
  };
}
function artifactsFor(page: FinancialSummaryPageV2, request: ReportingExportRequest, bridge: ReportingExportBridge): ExportArtifact[] {
  const document = projectionDocument(page, request, bridge);
  const text = (value: string): CsvCell => ({ kind: 'text', value });
  const amount = (value: string | null, scale: number): CsvCell => value === null ? { kind: 'empty' } : { kind: 'money', amount: value, scale };
  const rows = document.currencies.flatMap(currency => [...currency.metrics, ...currency.simulated].map(metric => [text(currency.currency), { kind: 'integer', value: currency.scale } as CsvCell,
    text(metric.metric), text(metric.recognition), text(metric.definition), text(metric.status), amount(metric.knownSubtotal, currency.scale), amount(metric.total, currency.scale), { kind: 'integer', value: metric.unknownCount } as CsvCell,
    text(document.period.start), text(document.period.end), text(document.timezone), text(document.environment), text(document.billingMode), text(page.summaryContentHash), text(page.queryContentHash)]));
  const json = canonicalExportJson(document) + '\n';
  const csv = encodeCsv(['currency', 'scale', 'metric', 'recognition', 'definition', 'status', 'known_subtotal', 'total', 'unknown_count', 'period_start', 'period_end', 'timezone', 'environment', 'billing_mode', 'projection_content_hash', 'query_content_hash'], rows);
  return ([['summary.json', 'application/json', json], ['metrics.csv', 'text/csv', csv]] as const).map(([fileName, mediaType, content]) => {
    if (byteCount(content) > MAX_BYTES) throw new Error('Export artifact size limit exceeded.');
    // hashExportCanonical over a string is not a file-byte hash; use the artifact primitive below.
    return { fileName, mediaType, content, contentHash: hashText(content), byteLength: byteCount(content) };
  });
}
function hashText(content: string): string { return 'sha256:' + createHash('sha256').update(content, 'utf8').digest('hex'); }
export function validReportingStoredExport(value: unknown): value is ReportingStoredExportArtifacts {
  if (typeof value !== 'object' || value === null || Object.keys(value).sort().join(',') !== 'prepared,requestHash') return false;
  const record = value as ReportingStoredExportArtifacts;
  if (!/^sha256:[a-f0-9]{64}$/.test(record.requestHash ?? '') || !Value.Check(ReportingExportReceiptSchema, record.prepared) || !bounded(record)) return false;
  const prepared = record.prepared;
  return prepared.artifacts.every((artifact, index) => {
    const receipt = prepared.manifest.artifacts[index];
    return artifact.contentHash === hashText(artifact.content) && artifact.byteLength === byteCount(artifact.content)
      && receipt?.fileName === artifact.fileName && receipt.mediaType === artifact.mediaType && receipt.contentHash === artifact.contentHash && receipt.byteLength === artifact.byteLength;
  }) && prepared.manifest.artifactSetHash === hashExportCanonical(prepared.manifest.artifacts);
}

export async function prepareReportingExport(value: ReportingExportRequest, ports: ExportRuntimePorts, allowPrepare: boolean): Promise<ApiResult<ReportingPreparedExportArtifacts>> {
  const reject = (code: ErrorCode, message: string, retryable = false) => failure(errorEnvelope('integrations', 'exportSummary', code, 'unavailable', message, retryable));
  try {
    if (!bounded(value)) return reject('VALIDATION_ERROR', 'The export request exceeds supported content bounds.');
    const request = freezeExportValue(value);
    if (!Value.Check(ReportingExportRequestSchema, request)) return reject('VALIDATION_ERROR', 'The reporting export request does not match its exact version.');
    const bridge = reportingExportBridge(ports);
    const acquired = await acquireDisclosure(bridge?.disclosureFence, request.scope, request.requestId);
    if (!acquired.ok) return failure(acquired.error);
    const disclosure = acquired.value;
    { const current = validateDisclosure(disclosure, ports.clock); if (!current.ok) return current; }
    const authorize = () => authorizeExportAccess(ports, request, bridge);
    let auth = await authorize(); if (!auth.ok) return failure(auth.error);
    { const current = validateDisclosure(disclosure, ports.clock); if (!current.ok) return current; }
    const boundary = validateReportingExportRequestBoundary(request); if (!boundary.ok) return failure(boundary.error);
    if (!bridge?.artifactStoreV2) return reject('SOURCE_UNAVAILABLE', 'Reporting export requires the verified Finance reader, registry and artifact store.', true);
    const expected = request.summarySnapshot;
    if (hashExportCanonical(expected.summary) !== request.summaryContentHash || expected.summaryContentHash !== request.summaryContentHash) return reject('IDEMPOTENCY_CONFLICT', 'The expected reporting projection hash does not match.');
    if (canonicalExportJson(expected.scope) !== canonicalExportJson(request.scope) || expected.filters.environments.some(item => item !== request.scope.environment) || expected.filters.billingModes.some(item => item !== request.scope.billingMode)) return reject('FORBIDDEN_SCOPE', 'The reporting export exceeds the authenticated scope.');
    const key = hashExportCanonical({ encoding: 'reporting-export-2.0.0', scope: request.scope, idempotencyKey: request.idempotencyKey });
    const requestHash = hashExportCanonical({ scope: request.scope, snapshot: withoutTransport(expected), destination: request.destination, format: request.format, evidenceMode: request.evidenceMode });
    auth = await authorize(); if (!auth.ok) return failure(auth.error);
    { const current = validateDisclosure(disclosure, ports.clock); if (!current.ok) return current; }
    const lookup = await bridge.artifactStoreV2.lookup(key);
    const existing = lookup === null ? null : freezeExportValue(lookup);
    { const current = validateDisclosure(disclosure, ports.clock); if (!current.ok) return current; }
    auth = await authorize(); if (!auth.ok) return failure(auth.error);
    { const current = validateDisclosure(disclosure, ports.clock); if (!current.ok) return current; }
    if (existing && !validReportingStoredExport(existing)) return reject('SOURCE_UNAVAILABLE', 'The immutable reporting export could not be verified.', true);
    if (existing && existing.requestHash !== requestHash) return reject('IDEMPOTENCY_CONFLICT', 'This export key is already bound to different reporting content.');
    const received = await bridge.readVerifiedSnapshotV2({ scope: request.scope, snapshotId: expected.snapshotId, queryContentHash: expected.queryContentHash, summaryContentHash: expected.summaryContentHash });
    const source = received === null ? null : freezeExportValue(received);
    { const current = validateDisclosure(disclosure, ports.clock); if (!current.ok) return current; }
    auth = await authorize(); if (!auth.ok) return failure(auth.error);
    { const current = validateDisclosure(disclosure, ports.clock); if (!current.ok) return current; }
    if (source === null || !bounded(source) || !validateFinancialSummaryPageV2Boundary(source).ok) return reject('SOURCE_UNAVAILABLE', 'The verified reporting snapshot is unavailable.', true);
    if (canonicalExportJson(source.scope) !== canonicalExportJson(request.scope)) return reject('FORBIDDEN_SCOPE', 'The reporting export exceeds the authenticated scope.');
    if (hashExportCanonical(source.summary) !== source.summaryContentHash || canonicalExportJson(withoutTransport(source)) !== canonicalExportJson(withoutTransport(expected))) return reject('IDEMPOTENCY_CONFLICT', 'The submitted page differs from the verified original aggregate first page.');
    if (source.canonicalSummaries.some(summary => !checkRegisteredCanonicalSummary({ summary }, request.scope, ports.clock.now().toISOString()))) return reject('SOURCE_UNAVAILABLE', 'The registered canonical mapping failed financial semantic validation.', true);
    const artifacts = artifactsFor(source, request, bridge);
    const receipts = artifacts.map(({ content: _content, ...receipt }) => receipt);
    const original = existing ?? freezeExportValue({ requestHash, prepared: { schemaVersion: '2.0.0' as const, artifacts,
      manifest: { schemaVersion: '2.0.0' as const, sourceEncoding: '2.0.0' as const, exportId: key, status: 'prepared' as const, destination: 'cfo.ai' as const, createdAt: ports.clock.now().toISOString(),
        snapshotId: source.snapshotId, queryContentHash: source.queryContentHash, projectionContentHash: source.summaryContentHash, snapshotEnvelopeHash: hashExportCanonical(withoutTransport(source)), definitionRegistryHash: REPORTING_EXPORT_REGISTRY_PIN,
        artifactSetHash: hashExportCanonical(receipts), artifacts: receipts, evidenceMode: request.evidenceMode, requestedFormat: request.format, period: { ...source.period }, timezone: source.timezone,
        currencies: source.summary.currencies.map(row => row.currency), itemCount: source.summary.currencies.length * 11,
        delivery: 'manual_prepared' as const, deliveryReference: null, canonicalAdoption: 'proposal_only' as const, definitionsStatus: 'pending_owner_review' as const, consumerAcknowledgement: 'pending' as const, sourceEvidenceStatus: 'not_exposed_by_query' as const } } });
    if (!validReportingStoredExport(original)) return reject('SOURCE_UNAVAILABLE', 'The reporting export could not be validated.', true);
    if (hashExportCanonical(original.prepared.artifacts) !== hashExportCanonical(artifacts)
        || original.prepared.manifest.snapshotEnvelopeHash !== hashExportCanonical(withoutTransport(source)) || original.prepared.manifest.exportId !== key
        || original.prepared.manifest.snapshotId !== source.snapshotId || original.prepared.manifest.queryContentHash !== source.queryContentHash
        || original.prepared.manifest.projectionContentHash !== source.summaryContentHash || original.prepared.manifest.definitionRegistryHash !== REPORTING_EXPORT_REGISTRY_PIN
        || original.prepared.manifest.evidenceMode !== request.evidenceMode || original.prepared.manifest.requestedFormat !== request.format
        || canonicalExportJson(original.prepared.manifest.period) !== canonicalExportJson(source.period) || original.prepared.manifest.timezone !== source.timezone
        || canonicalExportJson(original.prepared.manifest.currencies) !== canonicalExportJson(source.summary.currencies.map(row => row.currency))
        || original.prepared.manifest.itemCount !== source.summary.currencies.length * 11) return reject('SOURCE_UNAVAILABLE', 'The immutable export does not match its verified reporting source.', true);
    if (!allowPrepare && !existing) return reject('SOURCE_UNAVAILABLE', 'No immutable reporting export exists for this request.', true);
    auth = await authorize(); if (!auth.ok) return failure(auth.error);
    { const current = validateDisclosure(disclosure, ports.clock); if (!current.ok) return current; }
    const stored = existing ?? freezeExportValue(await bridge.artifactStoreV2.commitImmutable(key, original));
    { const current = validateDisclosure(disclosure, ports.clock); if (!current.ok) return current; }
    auth = await authorize(); if (!auth.ok) return failure(auth.error);
    { const current = validateDisclosure(disclosure, ports.clock); if (!current.ok) return current; }
    if (!validReportingStoredExport(stored) || stored.requestHash !== requestHash || hashExportCanonical(preparedBinding(stored.prepared)) !== hashExportCanonical(preparedBinding(original.prepared))
        || (existing !== null && stored.prepared.manifest.createdAt !== existing.prepared.manifest.createdAt)) return reject('SOURCE_UNAVAILABLE', 'The immutable reporting export could not be verified.', true);
    if (!await bridge.artifactStoreV2.verifyOriginal(key, stored)) return reject('SOURCE_UNAVAILABLE', 'The original reporting preparation could not be authenticated.', true);
    { const current = validateDisclosure(disclosure, ports.clock); if (!current.ok) return current; }
    auth = await authorize(); if (!auth.ok) return failure(auth.error);
    { const current = validateDisclosure(disclosure, ports.clock); if (!current.ok) return current; }
    bindDisclosure(stored.prepared, disclosure);
    const sealed = sealDisclosureSuccess(stored.prepared);
    { const current = validateDisclosure(disclosure, ports.clock); if (!current.ok) return current; }
    return sealed;
  } catch { return reject('SOURCE_UNAVAILABLE', 'Reporting export preparation is temporarily unavailable.', true); }
}
