# Reported but unsettled expense projection proposal

References: cost-intelligence #3, #12, #13, #18. This implements the Finance-owned
`ci-finance-reporting-reported-unsettled-1.0.0` proposal in issue #13 comment
6128331072 (design SHA-256
`d055a048e93b80825754963c576bd5f63b3b4008de1dfb412638c69a783483a6`).
It is pending independent review and consumer acknowledgement.

The native 2.0.0 detail accepts `provider_reported_unsettled`. New currency
projections emit optional `valuation.reportedUnsettled` using ReportingAmount.
The bucket includes only actual expense-axis records, retains exact signed
amounts to 18 decimal places and separates currencies. Unknown money is null;
a missing amount contributes to unknownCount, never a zero. Cash movements,
revenue and simulated charges do not establish actual reported expense.

Old immutable stored snapshots may lack the bucket. Reading does not upgrade or
rewrite their bytes/hashes. JSON exports retain `expenseValuation.reportedUnsettled`;
for an old absent bucket they explicitly emit
`{status: "not_supplied_by_query", knownSubtotal: null, total: null, unknownCount: null}`.
The existing metrics CSV remains a metrics-only projection; it does not carry
valuation partitions. The paired JSON supplies these partitions.

The installed shared FinancialSummary/1.0.0 cannot express this basis. A currency
containing a reported record maps canonical valuation_basis to `unknown`,
including mixed confirmed/reported records. Native details and amounts retain
the distinction. This changes neither the shared pin nor the canonical schema.
Reported money proves neither complete usage, paid status, reconciliation,
terminal execution nor authority to release a hold.

## Qualification boundary

`tests/reporting/reported-unsettled.test.mjs` exercises the source-port proposal,
public query/export composition and legacy snapshot readback using synthetic
sources/authority. The existing PostgreSQL reporting and query/export suites
exercise real storage for already supported ledger valuations. Main's ledger
boundary and SQL constraint still reject reported-unsettled postings. The held
settlement candidate supplies that separate prerequisite. Therefore these tests
are not a genuine reported-cost ledger→PostgreSQL→query→export acceptance chain.
That chain, exact strict Dashboard/other consumer adaptation and ACK, whole
settlement review and post-merge qualification remain required. Original
historical packets and their bounded ACKs are unchanged.
