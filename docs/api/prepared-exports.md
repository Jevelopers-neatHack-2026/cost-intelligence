# Prepared financial exports — Finance proposal 2.0.0

The configured public exporter prepares immutable JSON/CSV files from the same
verified stored query snapshot. An unconfigured call returns typed
`SOURCE_UNAVAILABLE`. Caller summaries, hashes, `requestedBy` and evidence-mode
labels establish no source or accounting authority.

| Input | Public result | Compatibility |
| --- | --- | --- |
| `ExportRequest@1.0.0` through `exportSummary` | Unchanged `ExportManifest@1.0.0` | Existing legacy shape retained |
| `ExportRequest@1.0.0` through `exportSummaryV2` or `getPreparedExportArtifacts` | Legacy manifest plus `ExportArtifactManifestV2@2.0.0` and bytes | Registered UUID, single-currency canonical mapping |
| `ReportingExportRequest@2.0.0` through `exportSummaryV2` or `getPreparedExportArtifacts` | `ReportingExportReceipt@2.0.0`: `ReportingExportManifest@2.0.0` and bytes | Finance-owned rich projection proposal; opaque scopes and separate currency blocks supported |

These wrappers do not replace shared `FinancialSummary@1.0.0` in package
shared-contracts 0.3.0. Dashboard SDK 0.9.7 at `d432ad5c` remains a distinct
version. Dashboard's synthetic consumer revision
`840231c1753157bac309cb8f8d2c4b3d26690747` has not acknowledged this producer
or the four structured simulated `ReportingAmount` fields. Canonical adoption,
mounted host acceptance, consumer ACK and CFO import remain pending.

## Concrete host composition

`createReportingExportRuntimePorts(reportingPorts, legacyStore, reportingStore, disclosureFence)`
composes the existing public Finance PostgreSQL snapshot readers. The stores
are reviewed host artifact storage, never financial balances. Shared
`RuntimePorts` is unchanged; integrations defines its optional local extension.

```ts
const ports = createReportingExportRuntimePorts(
  reportingPorts,
  createFileExportArtifactStore({ directory, receiptKey }),
  createFileReportingExportArtifactStore({ directory, receiptKey }),
  disclosureFence, // reviewed coherent current host capability
);
const result = await exportSummaryV2(request, ports);
```

The reader retrieves the scoped immutable stored original first page and
checks current authority, reporting health, privacy quarantine, normalized
query/source/projection hashes and producer provenance. Export checks the
complete expected envelope excluding only `requestId`, the exact scope and
all registered canonical economics. `hasMore: true` is supported because the
first page contains the full aggregate. A submitted continuation page differs
from the original first page and returns `IDEMPOTENCY_CONFLICT`.

The exact selected query source is `22a3237dd44f376017969ac881586ff396f19cf8`
with the reporting migration compatibility prerequisite
`3920a4689b076fd9bdf5ed3aa71764016c1da33d`. Its immutable definition-registry
fixture SHA-256 is
`577ce8801855db08ba393f115c00ac670df3a47a5cc9e9a5a78f8b0132cb34e1`;
canonical registry hash is
`sha256:827ac8d4e37adc354dc8721d4f34c4c3bfb0039b318ae769ed8fec3e249055c2`.
Exporter privately deep-copies/freezes the pinned registry before any await,
checks definition bodies, UUID references and policy hashes, and applies shared
`checkFinancialSummary` with independently resolved references. Definitions
remain Finance-owned proposals pending supervisor adjudication, not caller
same-name aliases. `ReportingExportRequestSchema` is explicitly marked partial:
use `validateReportingExportRequestBoundary` for nested canonical semantics.

Every public operation requires current `integrations.exportSummary` /
`finance.summary.export` before snapshot/artifact lookup, serialization or
storage. The composed source and every later artifact/disclosure gate also require current `finance.summary.read`.
Scope includes tenant, project, actor, environment and billing mode. Grants,
revocation and expiry are freshly checked after async source/storage waits and
before response. Both grants are renewed independently through the bound Finance issuer; neither initial source authorization nor receipt authentication replaces current read access. Both returned decisions are privately copied. The separately bound `trustedContext.resolve` must then return the same complete tenant/project/actor/environment/billing scope; null, foreign or unavailable context vetoes disclosure even when both grants remain allowed. Grant expiry is checked again after this context await. Generic issuer contracts do not waive this independently required producer veto. Request/scope are privately copied and frozen before the first
await. Dashboard `finance.read` / `finance.export` actions are not these Finance
permissions; reviewed Product adapter and mounted issuer acceptance remain
external prerequisites. A low-level store is a trusted host port, not a public
authorized endpoint.

## Coherent final disclosure capability

The optional fourth port is `ExportDisclosureFencePort`, local to integrations.
For both query-backed versions, its absence fails all creation and retrieval
paths with `SOURCE_UNAVAILABLE` before snapshot/artifact I/O. Three-argument
compositions cannot disclose bytes. The standalone mocked legacy fixture
remains separately qualified; it does not establish query-backed authority.

`acquire` issues a private, immutable, owner-bound permit for the complete scope
and exact read/export tuple. `validateCurrent` is synchronous: it returns one
immutable current snapshot of context, principal revision and both grants from
the same authoritative state. It must reject an expired permit, foreign scope,
revocation, source replacement, and any intervening revision (including a
revoke/restore sequence). Independent remote async checks cannot implement this
contract. The exporter checks after each source/storage/authority wait and again
in the resumed public wrapper immediately before handing off immutable bytes.
The trusted clock is read before that final synchronous validation. Private
per-invocation bindings prevent concurrent calls exchanging permits.

The test adapter owns one private synthetic record and monotonic generation.
Closed transitions update context, principal, scope, grants and expiry; private
WeakMap permits bind the entire record generation. Unsupported callback/object/
accessor replacement fails closed. Await hooks only drive these transitions;
they do not supply arbitrary authorization responses. This adapter is a
synthetic conformance fixture, with no mounted session or actual host adoption.
A real host must independently provide the reviewed coherent capability.

## Amounts, tables and privacy

Every preparation produces both `summary.json` and `metrics.csv`, regardless
of selected manual representation. JSON is recursively key-sorted UTF-8,
without BOM, final LF. CSV uses the existing protected encoder, UTF-8, no BOM,
CRLF records. Money retains exact signed decimals at declared scale; nonzero
excess precision fails instead of rounding. Text uses the existing normalized
formula/control/malformed-text policy. Unknown totals are JSON null and empty
CSV cells, with status and unknown count. No missing bill becomes zero.

Legacy CSV columns remain documented by its existing artifact schema. Rich
2.0.0 CSV columns are `currency`, `scale`, `metric`, `recognition`, `definition`,
`status`, `known_subtotal`, `total`, `unknown_count`, `period_start`, `period_end`,
`timezone`, `environment`, `billing_mode`, `projection_content_hash`,
`query_content_hash`. Each currency has seven actual rows and four simulated
rows. JSON retains groups, coverage, reconciliation counts, expense valuation,
advisory lifetime budgets, allocations and approved-denominator unit costs.

Actual metrics are `expense`, `gross_sales`, `net_sales`, `direct_costs`,
`contribution`, `cash_receipts`, `cash_payouts`. The query applies their pinned
policy; exporter copies amounts without a second accounting calculation.
Expense and direct costs are different definitions. `cash_net` is explicitly
`not_supplied_by_query` in `unavailableMetrics`, with null amounts, and has no
invented CSV row. Simulated expense/gross/net/direct amounts retain
`{ status, knownSubtotal, total, unknownCount }` independently and never enter
actual recognition. Known subtotals stay separate from partial/unknown totals.
Expense estimated/confirmed axes are currency aggregates; per-metric valuation
is `not_supplied_by_query`. Currency blocks are never combined without sourced
conversion. Forecast and business-plan assumptions are empty and `not_supplied`.

Public artifacts contain static approved labels, dates, enum states, amounts,
registered definition references and necessary opaque SHA-256 associations.
Tenant/project/actor, raw financial-event/provider/customer identifiers,
prompts, addresses, credentials and caller labels are omitted. Group values,
source revisions, allocation targets and private evidence-reference IDs are
hashed; unapproved source names become `unclassified_source`. The restricted
original snapshot/envelope association remains bound through request hash and
trusted reader. Artifacts never copy raw internal detail rows. Evidence mode is
a requested label: `sourceEvidenceStatus: not_exposed_by_query` explicitly
states that query data supplies no provider activity or rate-evidence attestation.

The legacy standalone fixture configuration still requires an explicit
`synthetic_only` registry and mocked evidence. It does not establish actual
accounting authority. The concrete producer bridge uses the pinned Finance
registry for both supported query versions.

## Immutable persistence

Keys include wrapper version and full bound scope. Fingerprints include full
first-page economics/provenance, destination, format and evidence mode. Only
export `requestId`, `requestedAt`, `requestedBy` and snapshot `requestId` are
transport metadata excluded from the economic fingerprint. Changed snapshot,
format or evidence under the same key returns `IDEMPOTENCY_CONFLICT`.

Filesystem adapters fsync bytes/receipts and publish using an exclusive atomic
hard link; prior records are never overwritten. HMAC-SHA256 authenticates the
full original record, first trusted-clock preparation time and source binding.
The host retains its receipt key (minimum 32 bytes) across restarts. Rotation
requires a host lifecycle policy. Custom stores must provide immutable commit
and independently authenticated `verifyOriginal` semantics. Export immediately
private-copies/freezes lookup and commit returns, validates/authenticates and
returns the same frozen copy across final authority waits. A mutable shared
adapter alias cannot alter authenticated success bytes. Receipt/source/format
metadata and exact bytes are validated before replay. Lost commit acknowledgement
retries return the original result, including original `createdAt`.

Content hashes cover exact file bytes; artifact-set hash covers ordered
name/media/hash/byte-length receipts. Actual preparation time is outside the
content-hash boundary and is never relabelled query `asOf`. Same frozen snapshot
produces deterministic files under different keys. Requests, source envelopes,
individual artifacts and stored bundles are bounded to 1 MiB; rich format
supports at most 100 currency blocks/1100 CSV metric rows, bounded object count
and depth. Malformed/oversized/symlink/authentication-mismatched receipts fail
closed. Errors are opaque and contain no raw adapter exception or source data.

## Executed and pending verification

The default exports suite covers legacy preparation, CSV hardening, package
exports, schema compatibility and pure public-port composition. The latter
uses a labeled synthetic SQL port, not PostgreSQL evidence. Disposable real
PostgreSQL composition is selected explicitly:

```sh
npm run build --silent && node scripts/with-postgres.mjs exports --suite=postgres
```

It appends final-boundary-validated synthetic events through public ledger APIs,
then queries, reads the same stored snapshot and exports actual JSON/CSV bytes.
Direct oracles cover expense/cash separation, corrected cash, reversal lineage,
unknown simulation, actual test-mode cost separation, first-page pagination,
legacy/rich versions, opaque scopes, mixed currencies, exact decimals,
idempotency, restart, grants and revocation. It fails closed without the approved
disposable database configuration; no mocked fallback or skipped PG tests exist.

Local Docker is blocked by read-only daemon metadata. Historical tree `fc559295ecd827ded06c3054e51ebabb063c129a` passed hosted composed PG10/10 and had its 17 receipts independently inspected. The later independent four-path read-revocation probe failed on that tree. Its repair at `0490ed4` passed the original grant matrix and hosted PG10/10, but a subsequent independent eight-case null/foreign context matrix failed because the separate context veto was not renewed. Both historical green PG receipts are retained and do not approve the context repair. The repaired exact head requires fresh genuine hosted CI and whole-candidate review. `artifacts/exports/synthetic-sql-composition.json` is a
pure example; `artifacts/exports/postgres-composition.json` is written only by
the actual PG test and records failures/results without private store keys.
Earlier failures are retained. `prepared` / `manual_prepared` means executed
artifact preparation only; delivery reference remains null. CI-08X.1–.4,
DASH-04, live-billing completeness and external consumer acceptance are not
closed from this checkpoint. SPN-03 is established only by the external plan
owner's actual evidence, never by export creation.

The selected migration file set is 0001–0010 plus separate reporting capability
0012 (11 files); no 0011 budget migration is part of this export candidate.
Core health remains the original ten-migration check. Only a genuine database
receipt establishes which files were actually applied. The CI uploader's
`migrations-*.log` allowlist is source-verified to receive sanitized container
logs, not JavaScript TAP/assertion output. Future uploaded bytes still require
inspection; a missing per-case assertion message is not diagnostic evidence.

[The eleven-scenario coverage catalog](../../fixtures/exports/global-scenario-coverage.json)
records the authoritative domain source path and pending receipt for every
required global scenario. It distinguishes export's composed oracles from
budget/intake/recovery/accounting responsibilities and establishes no unrelated
issue or global acceptance completion.
