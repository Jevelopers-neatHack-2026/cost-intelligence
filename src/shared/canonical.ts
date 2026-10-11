import { validateContract, type ContractMap, type ContractName } from '@jevelopers/shared-contracts';
import { errorEnvelope, type ErrorEnvelope, type Validation } from './contracts.js';

export type SharedUsageEvent = ContractMap['UsageEvent'];
export type SharedBudgetReservation = ContractMap['BudgetReservation'];
export type SharedReserveRequest = ContractMap['ReserveRequest'];
export type SharedReserveResult = ContractMap['ReserveResult'];
export type SharedSettleRequest = ContractMap['SettleRequest'];
export type SharedSettleResult = ContractMap['SettleResult'];
export type SharedReleaseRequest = ContractMap['ReleaseRequest'];
export type SharedReleaseResult = ContractMap['ReleaseResult'];
export type SharedQueryRequest = ContractMap['QueryRequest'];
export type SharedQueryResult = ContractMap['QueryResult'];
export type SharedFinancialSummary = ContractMap['FinancialSummary'];
export type SharedErrorEnvelope = ContractMap['ErrorEnvelope'];

export function validateCanonical<K extends ContractName>(args: {
  contract: K;
  value: unknown;
  module: string;
  operation: string;
  requestId: string;
}): Validation<ContractMap[K]> {
  const result = validateContract(args.contract, args.value);
  if (result.ok) return { ok: true, value: result.value };
  const unsupported = result.errors.some(issue => issue.code === 'UNSUPPORTED_VERSION');
  const error: ErrorEnvelope = errorEnvelope(
    args.module,
    args.operation,
    unsupported ? 'UNSUPPORTED_VERSION' : 'VALIDATION_ERROR',
    args.requestId,
    unsupported ? 'The shared contract version is not supported.' : 'The shared contract payload does not match its pinned schema.',
  );
  return { ok: false, error };
}
