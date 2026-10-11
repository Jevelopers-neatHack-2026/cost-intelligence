import {
  authorize,
  changeBudget,
  estimate,
  exportSummary,
  getReconciliation,
  ingestFinancial,
  ingestUsage,
  markDispatched,
  querySummary,
  recordExpenseAdjustment,
  release,
  settle,
  startReconciliation,
  type BudgetChangeRequest,
  type EstimateRequest,
  type ExpenseAdjustmentRequest,
  type ExportRequest,
  type FinancialEvent,
  type FinancialSummaryQuery,
  type MarkDispatchedCommand,
  type ReconciliationRequest,
  type ReservationRequest,
  type ReleaseReservationCommand,
  type RuntimePorts,
  type SettleReservationCommand,
  type UsageObservation,
} from '@jevelopers/cost-intelligence';

/**
 * In-process composition example. The host injects its trusted identity,
 * clock, persistence, and provider-source adapters; this package does not
 * create a network service or select ambient credentials.
 *
 * Current domain leaves fail closed with typed unavailable results. Replacing
 * an adapter alone does not turn an unavailable financial operation into a
 * successful one; each domain implementation and its acceptance suite must
 * land before that behavior is available.
 */
export function createInProcessFinancialWorker(dependencies: RuntimePorts) {
  const ports: RuntimePorts = Object.freeze({
    clock: dependencies.clock,
    storage: dependencies.storage,
    providerSource: dependencies.providerSource,
    trustedContext: dependencies.trustedContext,
  });

  return Object.freeze({
    ingestUsage: (request: UsageObservation) => ingestUsage(request, ports),
    estimate: (request: EstimateRequest) => estimate(request, ports),
    authorize: (request: ReservationRequest) => authorize(request, ports),
    markDispatched: (request: MarkDispatchedCommand) => markDispatched(request, ports),
    settle: (request: SettleReservationCommand) => settle(request, ports),
    release: (request: ReleaseReservationCommand) => release(request, ports),
    changeBudget: (request: BudgetChangeRequest) => changeBudget(request, ports),
    recordExpenseAdjustment: (request: ExpenseAdjustmentRequest) => recordExpenseAdjustment(request, ports),
    ingestFinancial: (request: FinancialEvent) => ingestFinancial(request, ports),
    querySummary: (request: FinancialSummaryQuery) => querySummary(request, ports),
    startReconciliation: (request: ReconciliationRequest) => startReconciliation(request, ports),
    getReconciliation: (request: ReconciliationRequest) => getReconciliation(request, ports),
    exportSummary: (request: ExportRequest) => exportSummary(request, ports),
  });
}
