import { canonicalJson, ContractError, validateContract, type ContractMap, type ContractName } from '@jevelopers/shared-contracts';
import { errorEnvelope, type ErrorEnvelope, type Validation } from './contracts.js';

/** Finance's legacy aliases elect this version independently of the SDK registry. */
export const LEGACY_CANONICAL_VERSIONS = Object.freeze({
  UsageEvent: '1.0.0', BudgetReservation: '1.0.0', ReserveRequest: '1.0.0',
  ReserveResult: '1.0.0', SettleRequest: '1.0.0', SettleResult: '1.0.0',
  ReleaseRequest: '1.0.0', ReleaseResult: '1.0.0', QueryRequest: '1.0.0',
  QueryResult: '1.0.0', FinancialSummary: '1.0.0', ErrorEnvelope: '1.0.0',
} as const);

export type LegacyCanonicalName = keyof typeof LEGACY_CANONICAL_VERSIONS;
export type CanonicalValue<K extends ContractName> = K extends LegacyCanonicalName
  ? Extract<ContractMap[K], { schema_version: '1.0.0' }>
  : ContractMap[K];

export type SharedUsageEvent = CanonicalValue<'UsageEvent'>;
export type SharedBudgetReservation = CanonicalValue<'BudgetReservation'>;
export type SharedReserveRequest = CanonicalValue<'ReserveRequest'>;
export type SharedReserveResult = CanonicalValue<'ReserveResult'>;
export type SharedSettleRequest = CanonicalValue<'SettleRequest'>;
export type SharedSettleResult = CanonicalValue<'SettleResult'>;
export type SharedReleaseRequest = CanonicalValue<'ReleaseRequest'>;
export type SharedReleaseResult = CanonicalValue<'ReleaseResult'>;
export type SharedQueryRequest = CanonicalValue<'QueryRequest'>;
export type SharedQueryResult = CanonicalValue<'QueryResult'>;
export type SharedFinancialSummary = CanonicalValue<'FinancialSummary'>;
export type SharedErrorEnvelope = CanonicalValue<'ErrorEnvelope'>;

function freezeSnapshot(value: unknown): void {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeSnapshot(child);
    Object.freeze(value);
  }
}

export function validateCanonical<K extends ContractName>(args: {
  contract: K;
  value: unknown;
  module: string;
  operation: string;
  requestId: string;
}): Validation<CanonicalValue<K>> {
  // Preserve original argument evaluation order and never reread caller bindings.
  const contract = args.contract;
  const input = args.value;
  const mapped = typeof contract === 'string' && Object.hasOwn(LEGACY_CANONICAL_VERSIONS, contract);
  const refuse = (code: 'UNSUPPORTED_VERSION' | 'VALIDATION_ERROR'): Validation<CanonicalValue<K>> => {
    // Success never reads error metadata; a refused decision is already fixed.
    const module = args.module;
    const operation = args.operation;
    const requestId = args.requestId;
    const error: ErrorEnvelope = errorEnvelope(module, operation, code, requestId,
      code === 'UNSUPPORTED_VERSION' ? 'The shared contract version is not supported.'
        : 'The shared contract payload does not match its pinned schema.');
    return { ok: false, error };
  };
  let payload = input;
  if (mapped) {
    let serialized: string;
    try { serialized = canonicalJson(input); } catch (error) {
      if (error instanceof ContractError) return refuse('VALIDATION_ERROR');
      throw error;
    }
    payload = JSON.parse(serialized) as unknown;
    freezeSnapshot(payload);
    // The SDK originally dispatches using an ordinary read after JSON safety.
    // Refuse inconsistent source/snapshot views; validate and return only private data.
    const sourceVersion = input !== null && typeof input === 'object' && !Array.isArray(input)
      ? (input as { schema_version?: unknown }).schema_version : undefined;
    const snapshotVersion = payload !== null && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as { schema_version?: unknown }).schema_version : undefined;
    const expected = LEGACY_CANONICAL_VERSIONS[contract as LegacyCanonicalName];
    if ((typeof sourceVersion === 'string' && sourceVersion !== expected)
        || (typeof snapshotVersion === 'string' && snapshotVersion !== expected)) return refuse('UNSUPPORTED_VERSION');
    if (sourceVersion !== expected || snapshotVersion !== expected) return refuse('VALIDATION_ERROR');
  }
  const result = validateContract(contract, payload);
  // All subsequent success operations use only this invocation's stable validated value.
  if (result.ok) return { ok: true, value: result.value as CanonicalValue<K> };
  return refuse(result.errors.some(issue => issue.code === 'UNSUPPORTED_VERSION') ? 'UNSUPPORTED_VERSION' : 'VALIDATION_ERROR');
}
