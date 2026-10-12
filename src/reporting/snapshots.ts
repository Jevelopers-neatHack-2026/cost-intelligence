import { Type, type Static } from '@sinclair/typebox';
import { TrustedScopeSchema, errorEnvelope, failure, validateRequest, type ApiResult, type TrustedScope } from '../shared/contracts.js';
import { bindFinancialDatabaseScope } from '../shared/database-scope.js';
import type { FinancialSummaryPage } from './schema-v1.js';
import type { ReportingPorts, ReportingTransactionPort } from './runtime.js';
import { REPORTING_POLICY_VERSION, REPORTING_DIMENSIONS, type FinancialSummaryQueryV2, type FinancialSummaryPageV2 } from './schema-v2.js';
import { authorizeReportingRead, executeSummary } from './reader.js';
import { hash } from './projection.js';
import { validateFinancialSummaryPageBoundary } from './index.js';
const Hash = Type.String({ pattern: '^sha256:[a-f0-9]{64}$' });
export const ReportingSnapshotReadRequestSchema = Type.Object({ schemaVersion: Type.Literal('1.0.0'), requestId: Type.String({minLength:1,maxLength:128}), scope: TrustedScopeSchema,
  snapshotId: Hash, queryContentHash: Hash, summaryContentHash: Hash }, {additionalProperties:false});
export type ReportingSnapshotReadRequest = Static<typeof ReportingSnapshotReadRequestSchema>;
/** Re-resolve a complete legacy first page from Finance's persisted snapshot, never from caller economic values. */
async function readSnapshot(value: ReportingSnapshotReadRequest, ports: ReportingPorts, encoding: '1.0.0' | '2.0.0'): Promise<ApiResult<FinancialSummaryPage | FinancialSummaryPageV2>> {
  const validation=validateRequest(ReportingSnapshotReadRequestSchema,value,'reporting','querySummary');if(!validation.ok)return failure(validation.error);
  const request=JSON.parse(JSON.stringify(validation.value)) as ReportingSnapshotReadRequest;
  let client: ReportingTransactionPort|undefined;let inTransaction=false;
  try {
    const auth: FinancialSummaryQueryV2={schemaVersion:'2.0.0',requestId:request.requestId,idempotencyKey:'snapshot-read',scope:request.scope,period:{start:'2026-01-01T00:00:00.000Z',end:'2026-01-02T00:00:00.000Z'},timezone:'UTC',policyVersion:REPORTING_POLICY_VERSION,pageSize:1,filters:{environments:[request.scope.environment],billingModes:[request.scope.billingMode]},groupings:[...REPORTING_DIMENSIONS]};
    await authorizeReportingRead(auth,ports);
    if(!ports.reporting)throw new Error();
    client=await ports.reporting.database.connect();await authorizeReportingRead(auth,ports);
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');inTransaction=true;
    await client.query("SET LOCAL statement_timeout='5000ms'");await client.query("SET LOCAL lock_timeout='2000ms'");await bindFinancialDatabaseScope(client,request.scope);
    const values=[request.scope.tenantId,request.scope.projectId,request.scope.environment,request.scope.billingMode];
    await authorizeReportingRead(auth,ports);
    const health=await client.query('SELECT migrations_ready FROM cost_intelligence.reporting_health');if(health.rows[0]?.migrations_ready!==true)throw new Error();
    await authorizeReportingRead(auth,ports);
    const privacy=await client.query('SELECT 1 FROM cost_intelligence.financial_privacy_quarantine WHERE tenant_id=$1 AND project_id=$2 AND environment=$3 AND billing_mode=$4 LIMIT 1',values);if(privacy.rows.length)throw new Error();
    await authorizeReportingRead(auth,ports);
    const row=await client.query('SELECT snapshot_content FROM cost_intelligence.reporting_snapshots WHERE tenant_id=$1 AND project_id=$2 AND environment=$3 AND billing_mode=$4 AND snapshot_id=$5',[...values,request.snapshotId]);
    const frozen=row.rows[0]?.snapshot_content;
    if(!frozen||hash(frozen)!==request.snapshotId||frozen.queryContentHash!==request.queryContentHash||frozen.encoding!==encoding||(encoding==='1.0.0'?(frozen.canonicalSummaries.length!==1||hash(frozen.canonicalSummaries[0])!==request.summaryContentHash):frozen.summaryContentHash!==request.summaryContentHash))throw new Error();
    await authorizeReportingRead(auth,ports);await client.query('COMMIT');inTransaction=false;await authorizeReportingRead(auth,ports);client.release();client=undefined;
    const { encoding:_encoding,asOf:_asOf,...identity }=frozen.normalizedQuery;
    const original={...identity,schemaVersion:'2.0.0',scope:request.scope,requestId:request.requestId,idempotencyKey:'verified-snapshot',snapshotId:request.snapshotId,requestedAsOf:frozen.asOf} as FinancialSummaryQueryV2;
    const projection=await executeSummary(original,ports,encoding);if(!projection.ok)return projection;
    const page=projection.value;
    if(encoding==='2.0.0') return page.summaryContentHash===request.summaryContentHash?projection:failure(errorEnvelope('reporting','querySummary','SOURCE_UNAVAILABLE',request.requestId,'The scoped snapshot hash does not match.'));
    const canonical=page.canonicalSummaries[0];if(!canonical||hash(canonical)!==request.summaryContentHash)throw new Error();
    const legacy={schemaVersion:'1.0.0' as const,requestId:request.requestId,snapshotId:page.snapshotId,queryContentHash:page.queryContentHash,summaryContentHash:request.summaryContentHash,
      asOf:page.asOf,timezone:page.timezone,watermark:page.watermark,filters:page.filters,summary:canonical,hasMore:page.hasMore,nextCursor:page.nextCursor};
    const result=validateFinancialSummaryPageBoundary(legacy);return result.ok?{ok:true,value:result.value}:failure(result.error);
  }catch{
    if(client&&inTransaction)await client.query('ROLLBACK').catch(()=>{});
    return failure(errorEnvelope('reporting','querySummary','SOURCE_UNAVAILABLE',request.requestId,'The verified scoped financial snapshot is unavailable.',true));
  }finally{client?.release();}
}
export async function readVerifiedSummarySnapshot(value: ReportingSnapshotReadRequest, ports: ReportingPorts): Promise<ApiResult<FinancialSummaryPage>> {
  return readSnapshot(value, ports, '1.0.0') as Promise<ApiResult<FinancialSummaryPage>>;
}
export async function readVerifiedSummarySnapshotV2(value: ReportingSnapshotReadRequest, ports: ReportingPorts): Promise<ApiResult<FinancialSummaryPageV2>> {
  return readSnapshot(value, ports, '2.0.0') as Promise<ApiResult<FinancialSummaryPageV2>>;
}
export function createReportingSnapshotReader(ports: ReportingPorts): {
  readVerifiedSnapshot(request: Pick<ReportingSnapshotReadRequest,'scope'|'snapshotId'|'queryContentHash'|'summaryContentHash'>): Promise<FinancialSummaryPage|null>;
} {
  return { readVerifiedSnapshot: async request=>{const result=await readVerifiedSummarySnapshot({...request,schemaVersion:'1.0.0',requestId:'reporting-export-snapshot-reader'},ports);return result.ok?result.value:null;} };
}
