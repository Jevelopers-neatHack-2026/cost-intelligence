# Authoritative summary queries (CI-08)

`@jevelopers/cost-intelligence` and its `/reporting` subpath expose the same
`querySummary` function. A host injects a restricted PostgreSQL transaction
port, trusted clock/context, current operation-specific Finance authority,
pinned producer revision, and private cursor signing material. No provider API,
pricing estimation, financial posting, reservation settlement, or export side
effect occurs during a query. Only an immutable reporting snapshot is appended.

The existing exact `FinancialSummaryQuery` / `FinancialSummaryPage` 1.0.0
encoding is retained. It now executes for an authorized UUID tenant/project and
exactly one observed currency, selecting a currency filter when necessary.
The nested `summary` remains the unchanged shared `FinancialSummary@1.0.0` from
the installed, proposal-only 0.3.0 archive. Empty, budget-only, opaque-scope, or
multi-currency results that cannot supply that encoding return a typed
`SOURCE_UNAVAILABLE` rather than invent an authority ID or financial zero.

The additive Finance-owned `FinancialSummaryQueryV2` / `FinancialSummaryPageV2`
2.0.0 encoding adds authorized breakdown and detail facts. `querySummaryV2` is an
explicit alias for the same versioned public implementation. Its
`canonicalSummaries` contain one unchanged shared summary per representable
observed currency. `summary` is supplemental Finance projection data, not a
replacement shared canonical contract. `canonicalMappingStatus` identifies
proposal-only mapping or unsupported opaque scope. Producer/consumer owner
acknowledgement and production issuer mapping remain pending.

## Request and response

```ts
const result = await querySummary({
  schemaVersion: '2.0.0', requestId: 'request-1', idempotencyKey: 'transport-1',
  scope: hostVerifiedScope,
  period: { start: '2026-10-10T00:00:00.000Z', end: '2026-10-11T00:00:00.000Z' },
  timezone: 'America/New_York', policyVersion: REPORTING_POLICY_VERSION,
  pageSize: 100,
  filters: { environments: ['test'], billingModes: ['live'], currency: 'USD' },
  groupings: ['provider', 'model', 'feature', 'repo', 'workflowId', 'productId', 'orderId', 'channel'],
}, {
  ...hostRuntimePorts,
  reporting: {
    database: hostRestrictedPool,
    producer: hostVerifiedFinanceBuild,
    cursorSigningKey: hostPrivatePaginationKey,
    // Optional independently resolved product approvals and source coverage:
    productEvidence: hostAcceptedEvidenceResolver,
  },
});
```

Success contains full-scope/period/timezone/filter/query identity, effective
`asOf`, immutable watermark, canonical summaries where representable, currency
projections, stable hashed detail references, and `hasMore`/`nextCursor`.
Continue by submitting the **same** query, page size and `snapshotId`, with
`cursor: nextCursor`. Request IDs and transport idempotency keys do not change
economic or snapshot identity. Array filters/groupings are normalized into
stable sorted order. Schema encoding, policy, actor, all financial scope fields,
period, timezone, filters, groupings, page size and as-of remain bound. Cross-
version replay, tampered or rehashed unsigned cursors, different page sizes,
and mismatched snapshot/filter/period hashes are rejected.

Period instants are normalized to UTC, with an exclusive end. Query instants
support at most millisecond precision; finer requests are rejected rather than
silently truncated. The timezone must
be an actual supported IANA timezone (checked by `Intl.DateTimeFormat`), not a
pattern-shaped arbitrary string. The host supplies the correct UTC boundaries
for its desired local calendar period; the API does not guess a calendar period
from a timezone label. Recognition uses the economic root's occurrence time;
source eligibility and revision replacement use ingestion time through as-of.
Late corrections do not rewrite a prior snapshot. A new current query includes
them; requerying the prior as-of reconstructs the prior inputs.

Supported filters preserve repository, provider, model, workflow, job, feature,
order, product and channel where the source supplies them. Current ledger 1.0.0
has no product dimension; product groups remain `null`/unknown. Workstream and
customer dimensions likewise stay unknown until a reviewed producer supplies
them. A filter literal `unknown` includes a missing dimension. No attribution
is guessed. Group values `null` have bucket `unknown_unallocated`; unmatched
spend remains in these buckets. Groups never pool currencies and no FX rate is
invented.

## Metric and approval dictionary — owner sign-off pending

The full immutable definition bodies and references are exported as
`REPORTING_METRIC_DICTIONARY`, `REPORTING_DEFINITION_POLICY`,
`REPORTING_DEFINITION_POLICY_HASH` and
`REPORTING_CANONICAL_REFERENCE_REGISTRY`. They are also included in
`fixtures/reporting/definition-registry.json`. IDs for these **Finance-owned**
artifacts are deterministically generated from immutable definition bytes in
the `cost-intelligence/metric-definition/1` and
`cost-intelligence/reporting-policy/1` namespaces. This does not convert or issue
external tenant, project, source-event, membership, grant, or approval IDs.

| Metric | Recognition policy |
| --- | --- |
| `expense` | Actual direct/supplier/operating/payable-labor expense and fees, less supplier credits/reimbursements; separate from tax, financing and cash. |
| `gross_sales` | Actual recognized sale lines before discounts/refunds, excluding pass-through tax. |
| `net_sales` | Gross sales less discounts and sale refunds. |
| `direct_costs` | Attributed AI/supplier direct expense and fees, less supplier credits/reimbursements. Separately classified operating expense/payable labor remains in total expense. |
| `contribution` | Net sales less attributed direct costs; no claim of net profit or available cash. |
| `cash_receipts`, `cash_payouts` | Observed actual cash movements; a payout is not another sale or expense. Missing observation/coverage is unknown. |

Accounting contributions reuse `projectAccounting` and its existing sign
matrix. Every monetary addition uses integers at scale 18; amounts and known
subtotals remain exact decimal strings. No binary floating point, display
rounding, implicit conversion, or estimate-plus-confirmation addition occurs.
Corrections replace superseded valuation rows as of the snapshot; reversals and
adjustments preserve signed ledger effects. Unsupported economic categories
remain counted as unsupported coverage rather than silently recognized as sales
or hidden from details.

`status: partial` retains `knownSubtotal` while `total` is null; missing source
coverage and unknown amounts do not become zero. An explicit complete-zero
requires independently resolved scoped coverage with expected zero observed
postings. Coverage counting units are financial postings per currency/source;
source count mismatches retain a missing-coverage marker. Accepted but unposted
usage, incomplete attempts, and quarantine counts are visible and cannot be
booked as observed expense. Their scope-wide counts are conservative; without
source-supported currency/dimension allocation they may affect multiple
currency totals and must not be summed as independent charge counts.

Canonical known metrics contain a full exact total only when coverage permits
it; partial subtotals remain in the richer wrapper. Canonical valuation,
settlement and reconciliation axes describe the included posted records, not
unobserved provider outcomes. Missing complete coverage remains unknown or
incomplete. Canonical `summaryContentHash` for 1.0.0 is the SHA-256 of the exact
inner shared summary; it is not the page or supplemental projection digest.

Live-mode expense in a test environment stays actual. Sandbox/simulated sales
and costs remain in a separate `simulated` block. All committed fixtures are
synthetic/mock observations; none prove real purchases or provider billing.

`unitCosts` supply an exact **ratio**, never a rounded division: numerator is
all scoped project expense (including unallocated spend), denominator is the
count of source-approved designs/workflows/orders in the selected query.
The optional host evidence resolver must return a scoped, period/as-of-bound,
content-hashed approval/source snapshot whose `queryContentHash` equals
`reportingEvidenceQueryHash(query, asOf)`. Each denominator carries its actual
approval reference and complete/partial/unknown state. Missing or partial
approvals return unknown; a complete count of zero is `zero_denominator`.
Finance's read grant does not establish Product approval authority. No accepted
Product source is currently claimed by the synthetic tests.

Shared research is posted once. Existing
`accounting_allocation_policies` are read as analytical allocation evidence,
with conservation checked against the selected source amount, currency,
policy version, allocated sum and residual. Allocation rows never increase
project expense. `1.00` over three equal targets has `0.33` each and an explicit
`0.01` residual under the existing floor policy. No allocation policy is
created or modified by the query.

## Budget state and unresolved lifecycle

Budget rows use the existing immutable policy/reservation log and ledger
semantics, in a separate `project_lifetime` window. `limit` is null without an
observed policy. `ledgerExpense` is a known subtotal of ledger expense;
`lifecycleConsumed` is separately labelled lifecycle evidence and never becomes
a fabricated ledger expense. Outstanding `held` remains conservative after
ambiguous dispatch, incomplete usage or stale worker leases. Remaining capacity
uses policy minus effective lifecycle/ledger consumption and outstanding holds,
with the same supported expense classifications as the existing budget reader.
It is advisory and becomes null when unresolved intake/unknown ledger expense
or unposted lifecycle consumption prevents a reliable capacity statement.

This issue does not repair or wire settlement/release. The base low-level final
release, partial-release terminal state and missing lifecycle-to-expense bridge
remain separate CI-05B obligations. A passing query test does not declare those
lifecycle semantics or the global financial gate complete.

## Authority, redaction and error behavior

Every read, including snapshot replay and exported snapshot re-resolution,
requires current `reporting.querySummary` / `finance.summary.read`, the exact
actor, active membership/service revision and all tenant/project/environment/
billing fields. Authority is refreshed after database/evidence waits, before
lookups, before/after commit and before disclosure. Privacy quarantine is
checked before any financial lookup and again in a fresh database snapshot
before returning a result. Database RLS is bound within the scoped transaction.

Dashboard host spellings `finance.read`/`finance.export` are **not implicitly
accepted aliases** for Finance's `finance.summary.read`/`finance.summary.export`.
A reviewed Product issuer adapter must supply that explicit operation/permission
mapping. Read-only authorization cannot grant export, budget mutation, purchases,
or wider scope. Genuine production host mapping/acceptance remains pending.

Safe details contain hashed opaque references, economic classification,
occurrence time, independent valuation/settlement/reconciliation state,
currency/amount, dimensions, and exact metric contributions. Internal source,
provider-request, actor-reference and raw intake payload fields are excluded.
Snapshot internals retain source IDs/hashes for Finance audit behind RLS; those
internals are never returned as dashboard detail payloads.

Errors use the existing bounded safe envelope: `VALIDATION_ERROR` for malformed
periods/timezones/cursors, `UNSUPPORTED_VERSION` for unknown exact encodings,
`FORBIDDEN_SCOPE` for denied/stale/forged authority,
`IDEMPOTENCY_CONFLICT` for a different normalized query against a snapshot, and
`SOURCE_UNAVAILABLE` for unwired, absent, partial, privacy-restricted, corrupt,
over-bound or unrepresentable sources. No partial database read is returned as
a successful zero report. Provider-source availability is not used to invent a
local observation.

## Persistence, bounds, freshness and rebuild

Migration `0012_reporting_snapshots` adds only append-only reporting snapshots,
a scoped lookup index, forced RLS and restricted SELECT/INSERT grants. Update,
delete and truncate are rejected. A dedicated `reporting_health` capability
checks this leaf; the existing core `foundation_health` and migrations
0001–0010 are unchanged. Standalone tests run base a08760e plus additive 0012;
final whole-schema integration with the separately owned budget 0011 remains a
supervisor merge-order/verification obligation.

The reader uses repeatable-read transactions, PostgreSQL statement timeout 5s
and lock timeout 2s, scoped source predicates and an input bound of 50,000 rows
per source (one extra row detects overflow). Currency partitions are bounded at
100, detail pages at 500, and groups at the bounded input × selected dimensions.
The host must bound connection acquisition and authority/evidence adapter waits;
SQL timeouts cannot cancel a hung host adapter. Large scopes fail closed rather
than truncate input and understate spend.

Existing ledger projection/supersession indexes, budget scope/current-policy and
reservation-partition indexes, intake attempt indexes, allocation scope/source
indexes and the new reporting scope/lookup index bound retrieval by the trusted
partition. A tiny fixture may legitimately choose a sequential plan; no
production-scale index-plan benchmark is claimed. Finance should monitor scoped
row counts, latency, input watermarks and unknown counts before increasing
bounds or introducing a separately reviewed projection version.

Rebuild is a fresh deterministic query over the same immutable inputs and
as-of. Snapshot identity binds normalized query, producer revision, input
hashes, coverage, policy, safe complete details, canonical summaries and source
watermark. Identical reordered transport/filter requests reproduce it. New
inputs create a new snapshot. Old snapshots never follow the mutable latest
source head. Freshness is the captured as-of/watermark, not a promise that all
provider statements have arrived. Policy/schema upgrades require a new exact
version, parallel rebuild, conserved totals/unknown coverage comparison and
consumer acknowledgement before switching readers.

Cursors use HMAC-SHA256 over snapshot/query/offset/page size with host-injected
private signing material of at least 32 bytes. The material is never persisted,
returned, logged, read from environment/key files by this module, or used as a
financial grant. Key rotation invalidates cursor bytes; the snapshot remains
available from its first page with refreshed cursors.

## Query-to-export contract

`readVerifiedSummarySnapshot` takes the published 1.0.0 hash-only
`ReportingSnapshotReadRequest` and returns the authoritative first legacy page.
`createReportingSnapshotReader(ports).readVerifiedSnapshot({scope, snapshotId,
queryContentHash, summaryContentHash})` adapts that to `FinancialSummaryPage|null`
for the export owner. No submitted caller financial values are trusted. The
v2 function `readVerifiedSummarySnapshotV2` accepts the same 1.0.0 descriptor,
returns a Finance 2.0.0 first page, and only reads v2-created snapshots.

A legacy export compares the complete first page excluding requestId. A
continuation envelope differs from first-page metadata and must be resubmitted
as the first page; canonical aggregate/hash is constant across pages. Export
independently requires `integrations.exportSummary` / `finance.summary.export`
as well as the current authorized snapshot read. No export implementation,
external CFO synchronization, or production host acceptance is claimed here.
The exact handoff is `fixtures/reporting/query-export-handoff.json`.

`npm run test:reporting` runs public root/subpath APIs against disposable
PostgreSQL under the restricted runtime role. The manual financial oracle,
producer samples and independent reference registry are in `fixtures/reporting`.
Accounting, ledger, intake, ordinary budget/recovery and contracts remain
separate authoritative suites; the full release gate and required Linux-native
security validation are not replaced by these tests.

## Optional host-action adapter proposal

`createFinanceReadExportAuthority` is an explicit, unmounted proposal adapter:
`ci-finance-host-action-mapping-1.0.0`,
`PROPOSED_OWNER_REVIEW_PENDING`. It consumes a server-held credential verifier
that resolves **current** Product `ticketstub.context/2` session, project
membership, actor, issuer/audience, membership revision, revocation and TTL.
It separately requires an independently maintained Finance scope mapping and
an approved finite environment/economic/evidence-mode mapping. A Product
`tenant.id` is a kind-prefixed actor subject, not an automatically equivalent
ledger tenant. No actor-prefix stripping or manufactured ledger UUID is used.

Only `finance.read` maps to reporting/query and only `finance.export` maps to
export. Source roles do not grant permission. Guest/anonymous actors and
platform staff contexts without an explicit project are rejected for project
queries. A fresh verifier check follows asynchronous scope mapping; changed,
expired, revoked or unmapped proofs fail closed. All budget, expense, order,
reservation and reconciliation operations are denied by this adapter.
Its current tests explicitly configure a synthetic verifier/independent map;
they do not mint a token, read a key, mount Product, or constitute owner approval.
Production composition requires a recorded owner-approved mapping receipt.

No canonical shared `MetricDefinition` payload was found in either compared
package. Finance therefore publishes its own declared closed
`cost-intelligence.reporting.metric-definition` and
`cost-intelligence.reporting.policy-definition` payloads, each with a locally
owned definition ID, exact schema version, revision and content hash. It does
not label arbitrary JSON as an accepted shared MetricDefinition. Consumers
resolve these exact registry bytes independently; reading expected references
back from the supplied summary does not authenticate them.

Revision after frozen producer 54f24055 (independent Q1–Q4 findings): cash movements are excluded from recognized expense and budget capacity expense, including cash tagged operating_expense. Effective eventType comes from the immutable ledger economic_event_type and scoped root/predecessor lineage; cash corrections remain cash. Definition bodies and all nested registry references are immutable private copies; response references are detached copies.

The pending 2.0.0 wrapper proposal changes currencies[].simulated.{expense,grossSales,netSales,directCosts} from decimal strings to ReportingAmount objects {status,knownSubtotal,total,unknownCount}. Unknown simulated amounts have null subtotal/total; mixed known and unknown retain only a partial knownSubtotal. A total of zero requires independently pinned complete-zero coverage for that simulated scope. Live coverage does not grant simulation coverage. Historical frozen54 fixtures are superseded only after new PostgreSQL capture and source revision publication; consumer acceptance remains pending.

Cash reversal axis resolution reads the scoped immutable root and economic_reverses_event_id ancestry, bounded to 32 links (33 nodes). It validates scope, as-of ingestion, financial participation, classification/currency, original stored type, link continuity and cycles. Correction preserves the stored effective economic type; reversal deltas retain the original receipt or payout axis and signed amount, including reversal-of-reversal. Missing, cross-scope, cyclic or over-depth lineage returns SOURCE_UNAVAILABLE rather than an incomplete numerical total.
