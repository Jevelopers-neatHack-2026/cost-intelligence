import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Static, TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { authorizeFinanceOperation, errorEnvelope, failure, sameScope, success, validateRequest, type ApiResult } from '../shared/contracts.js';
import { bindFinancialDatabaseScope } from '../shared/database-scope.js';
import { validateCanonical } from '../shared/canonical.js';
import { FinancialSummaryPageV2Schema, FinancialSummaryQueryV2Schema, ReportingProductEvidenceSchema, REPORTING_POLICY_VERSION, type FinancialSummaryPageV2, type FinancialSummaryQueryV2 } from './schema-v2.js';
import type { ReportingPorts, ReportingTransactionPort } from './runtime.js';
import { canonicalJson, decimal, hash, safeReportingReference, projectReporting, type SourceEvent, type BudgetSource, type AllocationSource } from './projection.js';
import { canonicalSummaries, CANONICAL_SCOPE_PATTERN } from './canonical-mapping.js';

function validateV2<T extends TSchema>(schema: T, value: unknown) {
  const requestId = typeof value === 'object' && value !== null && 'requestId' in value && typeof value.requestId === 'string' ? value.requestId : 'unavailable';
  if (typeof value === 'object' && value !== null && 'schemaVersion' in value && value.schemaVersion !== '2.0.0') return { ok: false as const, error: errorEnvelope('reporting','querySummary','UNSUPPORTED_VERSION',requestId,'The reporting schema version is not supported.') };
  if (!Value.Check(schema,value)) return { ok: false as const, error: errorEnvelope('reporting','querySummary','VALIDATION_ERROR',requestId,'The request does not match the published reporting schema.') };
  return { ok: true as const, value: value as Static<T> };
}
const MAX_ROWS = 50_000;
class QueryFailure extends Error { constructor(readonly result: ReturnType<typeof failure>) { super('Reporting query failed closed'); } }
function reject(code: 'SOURCE_UNAVAILABLE' | 'VALIDATION_ERROR' | 'FORBIDDEN_SCOPE' | 'IDEMPOTENCY_CONFLICT', requestId: string, message: string): never {
  throw new QueryFailure(failure(errorEnvelope('reporting', 'querySummary', code, requestId, message, code === 'SOURCE_UNAVAILABLE')));
}
export function normalizedQuery(request: FinancialSummaryQueryV2, asOf: string): Record<string, unknown> {
  const { requestId: _requestId, idempotencyKey: _idempotencyKey, cursor: _cursor, snapshotId: _snapshotId, requestedAsOf: _requestedAsOf, ...query } = request;
  const filters = Object.fromEntries(Object.entries(query.filters).map(([key,value]) => [key, Array.isArray(value) ? [...value].sort() : value]));
  return { ...query, groupings: [...query.groupings].sort(), filters, asOf };
}
export async function authorizeReportingRead(request: FinancialSummaryQueryV2, ports: ReportingPorts): Promise<void> {
  let scope;
  try { scope = await ports.trustedContext.resolve(request.scope); } catch { reject('SOURCE_UNAVAILABLE', request.requestId, 'Current financial context is temporarily unavailable.'); }
  if (!scope || !sameScope(scope, request.scope)) reject('FORBIDDEN_SCOPE', request.requestId, 'The requested financial scope is not authorized.');
  const decision = await authorizeFinanceOperation({ scope: request.scope, operation: 'reporting.querySummary', module: 'reporting', requestOperation: 'querySummary', requestId: request.requestId,
    clock: ports.clock, ...(ports.financeAuthority ? { financeAuthority: ports.financeAuthority } : {}) });
  if (!decision.ok) throw new QueryFailure(failure(decision.error));
}
function rowsBounded(rows: Record<string, any>[], requestId: string): Record<string, any>[] {
  if (rows.length > MAX_ROWS) reject('SOURCE_UNAVAILABLE', requestId, 'The scoped reporting input exceeds the supported bound.');
  return rows;
}
function encodeCursor(snapshotId: string, queryHash: string, offset: number, pageSize: number, signingKey: string): string {
  const content = { version: 2, snapshotId, queryHash, offset, pageSize };
  return btoa(canonicalJson({ ...content, contentHash: 'sha256:' + createHmac('sha256', signingKey).update(canonicalJson(content)).digest('hex') })).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
}
function decodeCursor(request: FinancialSummaryQueryV2, queryHash: string, signingKey: string): number {
  if (!request.cursor) return 0;
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(request.cursor)) throw new Error();
    const content = JSON.parse(atob(request.cursor.replaceAll('-','+').replaceAll('_','/')));
    const { contentHash, ...binding } = content;
    if (Object.keys(content).sort().join(',') !== 'contentHash,offset,pageSize,queryHash,snapshotId,version' || (typeof contentHash !== 'string' || contentHash.length !== 71 || !timingSafeEqual(new TextEncoder().encode(contentHash), new TextEncoder().encode('sha256:' + createHmac('sha256', signingKey).update(canonicalJson(binding)).digest('hex'))))
      || binding.version !== 2 || binding.snapshotId !== request.snapshotId || binding.queryHash !== queryHash || binding.pageSize !== request.pageSize
      || !Number.isSafeInteger(binding.offset) || binding.offset < request.pageSize || binding.offset % request.pageSize !== 0
      || encodeCursor(binding.snapshotId, binding.queryHash, binding.offset, binding.pageSize,signingKey) !== request.cursor) throw new Error();
    return binding.offset;
  } catch { reject('VALIDATION_ERROR', request.requestId, 'The continuation cursor does not match this snapshot and query.'); }
}
export function validateFinancialSummaryPageV2Boundary(value: unknown) {
  const outer = validateV2(FinancialSummaryPageV2Schema, value);
  if (!outer.ok) return outer;
  for (const summary of outer.value.canonicalSummaries) {
    const result = validateCanonical({ contract: 'FinancialSummary', value: summary, module: 'reporting', operation: 'querySummary', requestId: outer.value.requestId });
    if (!result.ok) return result;
  }
  return { ok: true as const, value: outer.value as FinancialSummaryPageV2 };
}
export async function executeSummary(value: FinancialSummaryQueryV2, ports: ReportingPorts, encoding: '1.0.0' | '2.0.0' = '2.0.0'): Promise<ApiResult<FinancialSummaryPageV2>> {
  const validated = validateV2(FinancialSummaryQueryV2Schema, value);
  if (!validated.ok) return failure(validated.error);
  const request = JSON.parse(JSON.stringify(validated.value)) as FinancialSummaryQueryV2;

  request.groupings.sort();
  for (const value of Object.values(request.filters)) if (Array.isArray(value)) value.sort();
  const identity = (asOf: string) => ({ ...normalizedQuery(request,asOf), encoding });
  const reporting = ports.reporting ? { ...ports.reporting, producer: { ...ports.reporting.producer } } : undefined;
  let client: ReportingTransactionPort | undefined; let inTransaction = false;
  try {
    if ([request.period.start,request.period.end,request.requestedAsOf].some(value => value !== undefined && /T[^Z+]*\.[0-9]{4,}/.test(value))) reject('VALIDATION_ERROR',request.requestId,'Reporting query instants support at most millisecond precision.');
    request.period = { start: new Date(request.period.start).toISOString(), end: new Date(request.period.end).toISOString() };
    const start = Date.parse(request.period.start); const end = Date.parse(request.period.end);
    if (start >= end || !request.period.start.endsWith('Z') || !request.period.end.endsWith('Z')) reject('VALIDATION_ERROR', request.requestId, 'Reporting periods are UTC instants with an exclusive end.');
    try { new Intl.DateTimeFormat('en-US', { timeZone: request.timezone }).format(); } catch { reject('VALIDATION_ERROR', request.requestId, 'The reporting timezone must be a supported IANA timezone.'); }
    if (request.filters.environments.some(item => item !== request.scope.environment) || request.filters.billingModes.some(item => item !== request.scope.billingMode)) reject('FORBIDDEN_SCOPE', request.requestId, 'The requested filters exceed the authenticated financial scope.');
    if (request.cursor && !request.snapshotId) reject('VALIDATION_ERROR', request.requestId, 'A continuation requires its original snapshot.');
    await authorizeReportingRead(request, ports);

    if (!reporting || typeof reporting.cursorSigningKey !== 'string' || (new TextEncoder().encode(reporting.cursorSigningKey).length < 32 || new TextEncoder().encode(reporting.cursorSigningKey).length > 4096) || !/^[a-f0-9]{40}$/.test(reporting.producer.sourceRevision) || !reporting.producer.buildRevision || reporting.producer.buildRevision.length > 128 || !safeReportingReference(reporting.producer.buildRevision)) reject('SOURCE_UNAVAILABLE', request.requestId, 'The scoped reporting reader is not configured.');
    client = await reporting.database.connect();
    await authorizeReportingRead(request, ports);
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ'); inTransaction = true;
    await client.query("SET LOCAL statement_timeout='5000ms'");
    await client.query("SET LOCAL lock_timeout='2000ms'");
    await bindFinancialDatabaseScope(client, request.scope);
    const read = async (sql: string, values: readonly unknown[] = []) => { await authorizeReportingRead(request, ports); return client!.query(sql, values); };
    const scopeValues = [request.scope.tenantId, request.scope.projectId, request.scope.environment, request.scope.billingMode];
    const health = await read('SELECT migrations_ready FROM cost_intelligence.reporting_health');
    if (health.rows[0]?.migrations_ready !== true) reject('SOURCE_UNAVAILABLE', request.requestId, 'The reporting storage capability is unavailable.');
    const privacy = await read('SELECT 1 FROM cost_intelligence.financial_privacy_quarantine WHERE tenant_id=$1 AND project_id=$2 AND environment=$3 AND billing_mode=$4 LIMIT 1', scopeValues);
    if (privacy.rows.length) reject('SOURCE_UNAVAILABLE', request.requestId, 'Financial history in this scope is restricted pending review.');
    let frozen: Record<string, any>;
    if (request.snapshotId) {
      const snapshot = await read('SELECT snapshot_content FROM cost_intelligence.reporting_snapshots WHERE tenant_id=$1 AND project_id=$2 AND environment=$3 AND billing_mode=$4 AND snapshot_id=$5', [...scopeValues, request.snapshotId]);
      if (!snapshot.rows[0]) reject('SOURCE_UNAVAILABLE', request.requestId, 'The scoped reporting snapshot is unavailable.');
      frozen = snapshot.rows[0].snapshot_content;
      if (hash(frozen) !== request.snapshotId) reject('SOURCE_UNAVAILABLE', request.requestId, 'The reporting snapshot integrity check failed.');
      if (request.requestedAsOf && new Date(request.requestedAsOf).toISOString() !== frozen.asOf) reject('IDEMPOTENCY_CONFLICT', request.requestId, 'The requested as-of does not match this snapshot.');
      if (hash(identity(frozen.asOf)) !== frozen.queryContentHash) reject('IDEMPOTENCY_CONFLICT', request.requestId, 'The snapshot is bound to a different query.');
    } else {
      const now = ports.clock.now(); if (!(now instanceof Date) || !Number.isFinite(now.valueOf())) reject('SOURCE_UNAVAILABLE', request.requestId, 'The reporting clock is unavailable.');
      const asOf = request.requestedAsOf ? new Date(request.requestedAsOf).toISOString() : now.toISOString();
      if (!asOf.endsWith('Z') || Date.parse(asOf) > now.valueOf()) reject('VALIDATION_ERROR', request.requestId, 'The reporting as-of must not be in the future.');
      const scopeAsOf = [...scopeValues, asOf];
      const ledger = await read(`SELECT e.event_id,e.event_hash,e.economic_root_event_id,e.economic_event_type,e.event_payload,axis.economic_lineage,
        (root.tenant_id=e.tenant_id AND root.project_id=e.project_id AND root.environment=e.environment AND root.billing_mode=e.billing_mode
          AND root.ingested_at <= $5 AND root.economic_event_type=e.economic_event_type
          AND root.event_payload->>'eventType'=root.economic_event_type
          AND (e.supersedes_event_id IS NULL OR (parent.event_id IS NOT NULL AND parent.ingested_at <= $5
            AND parent.tenant_id=e.tenant_id AND parent.project_id=e.project_id AND parent.environment=e.environment AND parent.billing_mode=e.billing_mode
            AND parent.economic_root_event_id=e.economic_root_event_id AND parent.economic_event_type=e.economic_event_type))) AS lineage_valid,
        to_char(root.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS root_occurred_at
        FROM cost_intelligence.financial_ledger_events e JOIN cost_intelligence.financial_ledger_events root ON root.event_id=e.economic_root_event_id
        LEFT JOIN cost_intelligence.financial_ledger_events parent ON parent.event_id=e.supersedes_event_id
        LEFT JOIN LATERAL (
          WITH RECURSIVE ancestry AS (
            SELECT root.event_id,root.economic_event_type,root.economic_reverses_event_id,root.tenant_id,root.project_id,root.environment,root.billing_mode,
              root.ingested_at,root.financial_effect,root.event_payload,0 AS depth,ARRAY[root.event_id] AS path,false AS cycle
            UNION ALL
            SELECT target.event_id,target.economic_event_type,target.economic_reverses_event_id,target.tenant_id,target.project_id,target.environment,target.billing_mode,
              target.ingested_at,target.financial_effect,target.event_payload,ancestry.depth+1,ancestry.path||target.event_id,target.event_id=ANY(ancestry.path)
            FROM ancestry JOIN cost_intelligence.financial_ledger_events target ON target.event_id=ancestry.economic_reverses_event_id
            WHERE ancestry.economic_event_type='reversal' AND NOT ancestry.cycle AND ancestry.depth < 32
          ) SELECT jsonb_agg(jsonb_build_object('eventId',event_id,'eventType',economic_event_type,'reversesId',economic_reverses_event_id,
            'scope',jsonb_build_object('tenantId',tenant_id,'projectId',project_id,'environment',environment,'billingMode',billing_mode),
            'ingestedAt',ingested_at,'financialEffect',financial_effect,'payload',event_payload,'depth',depth,'cycle',cycle) ORDER BY depth) AS economic_lineage FROM ancestry
        ) axis ON true
        WHERE e.tenant_id=$1 AND e.project_id=$2 AND e.environment=$3 AND e.billing_mode=$4 AND e.ingested_at <= $5 AND e.financial_effect
          AND NOT EXISTS (SELECT 1 FROM cost_intelligence.financial_ledger_events n WHERE n.supersedes_event_id=e.event_id AND n.ingested_at <= $5)
        ORDER BY e.event_id LIMIT 50001`, scopeAsOf);
      const lifetimeEvents: SourceEvent[] = rowsBounded(ledger.rows, request.requestId).map(row => {
        if (row.lineage_valid !== true || (row.event_payload.eventType !== 'correction' && row.event_payload.eventType !== row.economic_event_type)
          || (row.event_payload.eventType === 'correction' && !row.event_payload.supersedesEventId)) {
          reject('SOURCE_UNAVAILABLE', request.requestId, 'The stored economic event lineage is incomplete.');
        }
        const lineage = row.economic_lineage as Record<string, any>[];
        const invalid = () => reject('SOURCE_UNAVAILABLE',request.requestId,'The economic reversal axis lineage is incomplete.');
        if (!Array.isArray(lineage) || !lineage.length || lineage.length > 33 || lineage[0]!.eventId !== row.economic_root_event_id) invalid();
        const visited = new Set<string>();
        for (let index=0; index<lineage.length; index++) {
          const link=lineage[index]!; const next=lineage[index+1];
          if (link.depth !== index || link.cycle || visited.has(link.eventId) || link.financialEffect !== true
            || !Number.isFinite(Date.parse(link.ingestedAt)) || Date.parse(link.ingestedAt) > Date.parse(asOf)
            || link.scope.tenantId !== request.scope.tenantId || link.scope.projectId !== request.scope.projectId
            || link.scope.environment !== request.scope.environment || link.scope.billingMode !== request.scope.billingMode
            || link.payload.eventType !== link.eventType || link.payload.classification !== row.event_payload.classification
            || link.payload.money.currency !== row.event_payload.money.currency
            || (link.eventType === 'reversal' ? !next || link.reversesId !== next.eventId : next !== undefined || link.reversesId !== null)) invalid();
          visited.add(link.eventId);
        }
        const origin=lineage[lineage.length-1]!; const economicAxisType=origin.eventType as string;
        const cashDirection=economicAxisType === 'cash_movement' ? origin.payload.classification === 'payout_transfer' || (origin.payload.money.amount !== null && decimal(origin.payload.money.amount) < 0n) ? 'payout' as const : 'receipt' as const : undefined;
        const cashPolarity=origin.payload.classification === 'payout_transfer' ? 1 as const : origin.payload.money.amount !== null && decimal(origin.payload.money.amount) < 0n ? -1 as const : 1 as const;
        return { eventId: row.event_id, eventHash: row.event_hash, rootId: row.economic_root_event_id, economicEventType: row.economic_event_type,
          economicAxisType, ...(cashDirection ? {cashDirection,cashPolarity} : {}), payload: row.event_payload };
      });
      const subjects = new Map<string,string>();
      for (const event of lifetimeEvents) {
        const source = event.payload.sourceIdentity;
        const subject = canonicalJson([source.source,source.sourceObjectId,source.revisionSubjectId,event.payload.sourceIdentity.revisionSequence]);
        if (subjects.has(subject)) reject('SOURCE_UNAVAILABLE', request.requestId, 'The source revision lineage is incomplete.');
        subjects.set(subject,event.eventHash);
      }
      const events = lifetimeEvents.filter((_event,index) => { const occurred = Date.parse(ledger.rows[index]!.root_occurred_at); return occurred >= start && occurred < end; });
      const intake = await read(`SELECT i.source_observation_id,i.event_id,i.completeness,i.valuation_basis,
        NOT EXISTS (SELECT 1 FROM cost_intelligence.financial_ledger_events e WHERE e.event_id=i.event_id AND e.ingested_at <= $5) AS unposted
        FROM cost_intelligence.usage_intake_inbox i WHERE i.tenant_id=$1 AND i.project_id=$2 AND i.environment=$3 AND i.billing_mode=$4
          AND i.created_at <= $5 AND i.attempt_revision_accepted
          AND NOT EXISTS (SELECT 1 FROM cost_intelligence.usage_intake_inbox n WHERE n.tenant_id=i.tenant_id AND n.project_id=i.project_id AND n.environment=i.environment AND n.billing_mode=i.billing_mode
            AND n.billable_attempt_id=i.billable_attempt_id AND n.attempt_revision_accepted AND n.created_at <= $5 AND n.event_facts->>'supersedes_observation_id'=i.source_observation_id)
        ORDER BY i.source_observation_id LIMIT 50001`, scopeAsOf);
      rowsBounded(intake.rows, request.requestId);
      const quarantine = await read(`SELECT (SELECT count(*) FROM cost_intelligence.usage_intake_quarantine WHERE tenant_id=$1 AND project_id=$2 AND environment=$3 AND billing_mode=$4 AND created_at <= $5)
        +(SELECT count(*) FROM cost_intelligence.financial_ledger_quarantine WHERE tenant_id=$1 AND project_id=$2 AND environment=$3 AND billing_mode=$4 AND created_at <= $5) AS count`, scopeAsOf);
      const policies = await read(`SELECT DISTINCT ON (currency) currency,policy_version_id,policy_revision,limit_amount::text,content_hash FROM cost_intelligence.budget_scope_policies
        WHERE tenant_id=$1 AND project_id=$2 AND environment=$3 AND billing_mode=$4 AND recorded_at <= $5 ORDER BY currency,policy_revision DESC LIMIT 101`, scopeAsOf);
      const reservations = await read(`SELECT reservation_id,billable_attempt_id,currency,sum(held_amount)::text AS held,sum(released_amount)::text AS released,max(consumed_amount)::text AS consumed,
        (array_agg(usage_finality ORDER BY event_sequence DESC))[1] AS finality FROM cost_intelligence.budget_reservation_events
        WHERE tenant_id=$1 AND project_id=$2 AND environment=$3 AND billing_mode=$4 AND recorded_at <= $5 GROUP BY reservation_id,billable_attempt_id,currency ORDER BY reservation_id LIMIT 50001`, scopeAsOf);
      rowsBounded(reservations.rows, request.requestId);
      const budgetCurrencies = [...new Set([...policies.rows.map(row => row.currency.trim()), ...reservations.rows.map(row => row.currency.trim()), ...lifetimeEvents.map(event => event.payload.money.currency)])];
      if (budgetCurrencies.length > 100) reject('SOURCE_UNAVAILABLE', request.requestId, 'The scoped reporting currency bound was exceeded.');
      const budgetSources: BudgetSource[] = budgetCurrencies.map(currency => { const policy = policies.rows.find(row => row.currency.trim() === currency);
        return { currency, policy: policy ? { id: policy.policy_version_id, revision: policy.policy_revision, contentHash: policy.content_hash.trim(), limit: policy.limit_amount } : null,
          reservations: reservations.rows.filter(row => row.currency.trim() === currency).map(row => ({ reservationId: row.reservation_id, billableAttemptId: row.billable_attempt_id, held: row.held, released: row.released, consumed: row.consumed, finality: row.finality })) }; });
      const allocationRows = await read(`SELECT allocation_id,policy_version,source_event_id,currency,amount_scale,source_amount::text,allocated_total::text,residual::text,allocations,content_hash
        FROM cost_intelligence.accounting_allocation_policies WHERE tenant_id=$1 AND project_id=$2 AND environment=$3 AND billing_mode=$4 AND recorded_at <= $5 ORDER BY allocation_id LIMIT 50001`, scopeAsOf);
      const allocations: AllocationSource[] = rowsBounded(allocationRows.rows, request.requestId).map(row => ({ allocationId: row.allocation_id, policyVersion: row.policy_version, sourceEventId: row.source_event_id,
        currency: row.currency.trim(), scale: row.amount_scale, sourceAmount: row.source_amount, allocatedTotal: row.allocated_total, residual: row.residual, allocations: row.allocations, contentHash: row.content_hash.trim() }));
      const evidence = reporting.productEvidence ? await reporting.productEvidence.resolveSnapshot(request, asOf) : null;
      await authorizeReportingRead(request, ports);
      if (evidence) {
        const { reference, ...content } = evidence;
        if (!Value.Check(ReportingProductEvidenceSchema, evidence) || !sameScope(evidence.scope, request.scope) || canonicalJson(evidence.period) !== canonicalJson(request.period)
          || evidence.asOf !== asOf || evidence.queryContentHash !== hash(normalizedQuery(request,asOf)) || reference.contentHash !== hash(content) || new Set(evidence.denominators.map(row => row.kind)).size !== evidence.denominators.length
          || new Set(evidence.sourceCoverage.map(row => row.currency+':'+row.source)).size !== evidence.sourceCoverage.length) reject('SOURCE_UNAVAILABLE', request.requestId, 'The product evidence does not match this financial query.');
      }
      const projected = projectReporting({ query: request, asOf, events, lifetimeEvents, budgetSources, allocations, productEvidence: evidence,
        intake: { unposted: intake.rows.filter(row => row.unposted).length, awaiting: intake.rows.filter(row => row.valuation_basis === 'unknown' || row.completeness !== 'complete').length, quarantine: Number(quarantine.rows[0]?.count ?? 0) } });
      const sourceContent = { ledger: lifetimeEvents.map(event => ({ eventId: event.eventId, eventHash: event.eventHash })), intake: intake.rows,
        budgetSources, allocations, evidenceReference: evidence?.reference ?? null, quarantine: Number(quarantine.rows[0]?.count ?? 0), producer: reporting.producer };
      const sources = [{ source: 'immutable_finance_inputs', revision: REPORTING_POLICY_VERSION, observedThrough: asOf, contentHash: hash(sourceContent), completeness: projected.summary.coverage.status }];
      frozen = { encoding, normalizedQuery: identity(asOf), pageSize: request.pageSize, queryContentHash: hash(identity(asOf)), asOf, timezone: request.timezone, period: request.period, scope: request.scope, filters: request.filters,
        summary: projected.summary, summaryContentHash: hash(projected.summary), details: projected.details,
        canonicalSummaries: canonicalSummaries(request,asOf,projected.summary,reporting.producer,projected.details), canonicalMappingStatus: CANONICAL_SCOPE_PATTERN.test(request.scope.tenantId) && CANONICAL_SCOPE_PATTERN.test(request.scope.projectId) ? 'proposal_only_owner_ack_pending' : 'unsupported_opaque_scope',
        watermark: { watermarkId: hash(sources), capturedAt: asOf, sources }, inputEvidence: sourceContent };
      const snapshotId = hash(frozen);
      await authorizeReportingRead(request, ports);
      await client.query(`INSERT INTO cost_intelligence.reporting_snapshots(snapshot_id,tenant_id,project_id,environment,billing_mode,query_content_hash,as_of,snapshot_content)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb) ON CONFLICT (snapshot_id) DO NOTHING`, [snapshotId,...scopeValues,frozen.queryContentHash,asOf,JSON.stringify(frozen)]);
      const stored = await read('SELECT snapshot_content FROM cost_intelligence.reporting_snapshots WHERE tenant_id=$1 AND project_id=$2 AND environment=$3 AND billing_mode=$4 AND snapshot_id=$5', [...scopeValues,snapshotId]);
      if (!stored.rows[0] || hash(stored.rows[0].snapshot_content) !== snapshotId) reject('SOURCE_UNAVAILABLE', request.requestId, 'The persisted reporting snapshot integrity check failed.');
    }
    const snapshotId = hash(frozen);
    const offset = decodeCursor(request, frozen.queryContentHash,reporting.cursorSigningKey);
    if (offset >= frozen.details.length && offset !== 0) reject('VALIDATION_ERROR', request.requestId, 'The continuation offset exceeds this snapshot.');
    const details = frozen.details.slice(offset, offset + request.pageSize); const hasMore = offset + details.length < frozen.details.length;
    const page = { schemaVersion: '2.0.0', requestId: request.requestId, snapshotId, queryContentHash: frozen.queryContentHash, summaryContentHash: frozen.summaryContentHash,
      asOf: frozen.asOf, timezone: frozen.timezone, period: frozen.period, scope: frozen.scope, filters: frozen.filters, watermark: frozen.watermark, summary: frozen.summary,
      details, detailCount: frozen.details.length, hasMore, nextCursor: hasMore ? encodeCursor(snapshotId,frozen.queryContentHash,offset + details.length,request.pageSize,reporting.cursorSigningKey) : null,
      canonicalSummaries: frozen.canonicalSummaries, canonicalMappingStatus: frozen.canonicalMappingStatus };
    const boundary = validateFinancialSummaryPageV2Boundary(page);
    if (!boundary.ok || hash(page.summary) !== page.summaryContentHash) reject('SOURCE_UNAVAILABLE', request.requestId, 'The financial summary failed its public boundary check.');
    await authorizeReportingRead(request, ports);
    await client.query('COMMIT'); inTransaction = false;
    // A quarantine may be appended while a frozen repeatable-read query runs.
    // Recheck current visibility in a new snapshot before disclosing its result.
    await authorizeReportingRead(request, ports);
    await client.query('BEGIN READ ONLY'); inTransaction = true;
    await client.query("SET LOCAL statement_timeout='5000ms'");
    await bindFinancialDatabaseScope(client,request.scope);
    const currentPrivacy=await read('SELECT 1 FROM cost_intelligence.financial_privacy_quarantine WHERE tenant_id=$1 AND project_id=$2 AND environment=$3 AND billing_mode=$4 LIMIT 1',scopeValues);
    if(currentPrivacy.rows.length)reject('SOURCE_UNAVAILABLE',request.requestId,'Financial history in this scope is restricted pending review.');
    await client.query('COMMIT');inTransaction=false;
    await authorizeReportingRead(request, ports);
    return success(structuredClone(boundary.value));
  } catch (error) {
    if (client && inTransaction) { await client.query('ROLLBACK').catch(() => {}); inTransaction = false; }
    return error instanceof QueryFailure ? error.result : failure(errorEnvelope('reporting','querySummary','SOURCE_UNAVAILABLE',request.requestId,'The scoped financial summary is temporarily unavailable.',true));
  } finally { client?.release(); }
}

export async function querySummaryV2(value: FinancialSummaryQueryV2, ports: ReportingPorts): Promise<ApiResult<FinancialSummaryPageV2>> {
  return executeSummary(value, ports);
}

export function reportingEvidenceQueryHash(query: FinancialSummaryQueryV2, asOf: string): string { return hash(normalizedQuery(query,asOf)); }
