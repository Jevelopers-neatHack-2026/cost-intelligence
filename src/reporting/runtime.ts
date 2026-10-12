import type { RuntimePorts } from '../shared/contracts.js';
import type { FinancialSummaryQueryV2, ReportingProductEvidence } from './schema-v2.js';
export interface ReportingTransactionPort {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: Record<string, any>[]; rowCount?: number | null }>;
  release(): void;
}
export interface ReportingRuntimePorts {
  database: { connect(): Promise<ReportingTransactionPort> };
  /** Host-injected pagination signing material; never persisted or exported. */
  cursorSigningKey: string;
  producer: { sourceRevision: string; buildRevision: string };
  /** Host-resolved immutable product approvals and source coverage. No product authority is inferred from a Finance grant. */
  productEvidence?: { resolveSnapshot(query: FinancialSummaryQueryV2, asOf: string): Promise<ReportingProductEvidence | null> };
}
/** Additive composition local to reporting; existing RuntimePorts and operations are unchanged. */
export type ReportingPorts = RuntimePorts & { reporting?: ReportingRuntimePorts };
