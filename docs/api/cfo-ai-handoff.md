# CFO.ai input mapping and export handoff (CI-08X.4)

This document defines how a finance export feeds the TicketStub CFO.ai business plan. It is a **manual handoff**: no CFO.ai connector exists or is required. Configured snapshot-backed export preparation is implemented as a [Finance-owned proposal](./prepared-exports.md); passing actual PostgreSQL query-to-export evidence and consumer acceptance remain pending. Unconfigured `exportSummary` stays typed unavailable.

| Item | State, 2026-10-12 |
| --- | --- |
| CI-08X.4: manual mapping, consumer role, plan reference | **This document** |
| CI-08X.1–.3: versioned JSON/CSV export, reconciliation to CI-08, sanitizing serializer | Concrete v1/v2 public-port composition and synthetic preparation tests exist; passing actual [CI-08 #2](https://github.com/Jevelopers-neatHack-2026/cost-intelligence/issues/2) query-to-export integration, registered metric/policy domain mapping and affected consumer ACK remain pending. Canonical adoption remains separate under [SC-06C](https://github.com/Jevelopers-neatHack-2026/shared-contracts/issues/13) |
| SPN-03 (actual CFO.ai plan) | Verified separately in integration-evals, not by this issue |

## Consumer and plan reference

- **Consumer role:** the CFO.ai business-plan owner, in the Finance and reliability role. The owner is CompleteDotTech (confirmed 2026-10-11). This repository does not author or edit the plan.
- **Plan:** the TicketStub CFO.ai canvas, page `7ed03e7e-ca7d-441c-b6bb-7d4e5f7efc94`. Workspace login is required and the page is not publicly shared. The canvas access ends 2026-10-25 per the owner.
- **Sanitized plan reference** (public, immutable): [integration-evals `f375fcf`, `evidence/cfo-ai/2026-10-11-r2/`](https://github.com/Jevelopers-neatHack-2026/integration-evals/tree/f375fcf20584f5c98dbd4f3b69f884c52994224e/evidence/cfo-ai/2026-10-11-r2). It contains the reviewer workbook `cfo-native-export.xlsx`; Main-scenario inputs are entered in sheet `01 — Editable assumptions — USD`, cells `B5`, `B6`, `B7`, `B10`, `B32` and `B34`.

Replace the reference above with a newer immutable revision whenever the plan is re-exported. Never link a mutable branch.

## What may flow into the plan

Only a `FinancialSummary` from an export manifest with all of the following:

| Field | Required value | Why |
| --- | --- | --- |
| `environment` / `included_environments` | Explicit selected scope, with test/development separated from production | A genuinely paid live AI test remains actual expense; its environment does not erase the charge |
| `billing_mode` / `included_billing_modes` | `live` for actual paid observations | Sandbox/simulated sales are excluded from actual revenue. Synthetic fixture amounts are never actual bills (master FIN-09, FIN-10) |
| `valuation_basis` | `provider_confirmed`, or `estimated` labelled as an estimate | `unknown` is never entered as 0 |
| `completeness` | `complete`, or `incomplete` with `coverage.missing_sources` copied into the plan note | Partial coverage must stay visible |
| `reconciliation` | `matched` for "actual"; anything else is "unreconciled" | Matches the plan's "owner-reported, not reconciled" table |
| Manifest `summaryContentHash`, `snapshotId`, `snapshotAsOf`, `snapshotTimezone` | Recorded in the plan's source register | Reproducible provenance |

Excluded in every case: prompts, customer data, addresses, credentials, order or customer identifiers, promotional credits treated as cash, prize cash, and sandbox checkout totals.

## Mapping

Metric names below are **proposed**. CI-08 must publish each `definition_ref` before an export uses them. A metric with `status: "unknown"` leaves the plan input unchanged and adds an "unknown" note.

| Proposed `metrics` key | Plan destination | Rule |
| --- | --- | --- |
| `ai_provider_cost_actual` (per period) | "Actual expenses — owner-reported, not reconciled": one row per provider and period | Actual cost, not a forecast input. Compare with the plan's `TS Monthly AI spend` instead of overwriting it |
| `ai_provider_cost_per_studio_start` | Evidence for `TS AI cost per start` | Replaces the estimate only after a measured cohort with `completeness=complete`. Record the cohort size and period |
| `fixed_subscription_cost_actual` (per vendor) | `02 — Fixed monthly budgets` committed line, for example `Open-Meteo API Standard - committed` | Keep the source currency from `original_amounts`. A USD figure needs `conversion_ref` (dated FX) or the settled card amount |
| `payment_fees_actual`, `refunds_actual` | Evidence for `TS Payment rate` and `TS Digital refund allowance` | Not available: no payment provider is integrated, and checkout is sandbox |
| `revenue_actual` | None today | Must stay absent. TicketStub has no live payments, and sandbox orders are excluded |

Product funnel counts (visits, studio starts, paid orders) are **not** finance metrics. They come from product analytics and are out of scope here.

## Manual procedure, once `exportSummary` is available

1. Request a CSV or JSON export with `destination: "cfo.ai"`, `evidenceMode: "live"`, and the explicit live-billing scope. Keep production and test/development scope records distinguishable and retain real paid-test expense. Keep both manifests and artifact hashes. Synthetic configured fixtures use `evidenceMode: "mocked"` and never enter actual plan values.
2. Check every row against the "What may flow" table. Reject the export if any of those preconditions fails.
3. Make the edits in the CFO.ai canvas or its assistant, never in the reviewer workbook alone, then re-export the native workbook.
4. Retain a new dated evidence folder in integration-evals with the manifest hash, the new workbook, recalculation results and the changed inputs. Do not overwrite earlier snapshots.

CSV consumers must treat any text cell beginning with `=`, `+`, `-`, `@`, a tab, a carriage return or a line feed as data, including their full-width forms and when they follow leading whitespace. The internal encoder in `src/integrations/csv.ts` (CI-08X.3) prefixes such cells with `'`; rejects the byte-order mark, C1 and bidirectional control characters, and a `sep=` directive in the first header cell (upstream must strip direction marks from right-to-left names); and writes RFC 4180 CSV with CRLF records and no byte-order mark, keeps money as exact decimals at a fixed scale and rejects amounts more precise than that scale instead of rounding them, and writes unknown values as empty cells rather than `0`. The configured `exportSummary` and rich export paths use this protected encoder.

The legacy public summary serializer retains its narrow safe allowlist and hardened text-cell encoder. The configured exporter uses typed money cells and an explicit finite proposal dictionary; unsupported metrics fail visibly. Prepared local files are not delivered CFO.ai inputs or SPN-03 evidence.

## Compatibility

`ExportRequest` and `ExportManifest` 1.0.0 shapes are unchanged. New file/receipt data is a separate Finance-owned 2.0.0 proposal described in [prepared-exports.md](./prepared-exports.md). Shared FinancialSummary 1.0.0 in package 0.3.0 remains proposal-only; dashboard SDK 0.9.7 remains separate; current synthetic Dashboard revision `840231c1753157bac309cb8f8d2c4b3d26690747` has no ACK for this producer or its typed simulated amounts. Renaming a metric key after first use needs a new `definition_ref` version and an entry in [compatibility.md](./compatibility.md).


The rich `ReportingExportReceipt@2.0.0` records `projectionContentHash`,
`snapshotId`, `queryContentHash` and `snapshotEnvelopeHash`; period/timezone and
per-currency metrics stay in the document. Use these fields in the source
register instead of assuming the legacy manifest names. Do not interpret
`evidenceMode: live` as provider verification: `sourceEvidenceStatus` is
`not_exposed_by_query`. Generic expense cannot be assigned to a provider,
subscription, cohort or financial-plan input without independently reviewed
source evidence. Those specialized mapping keys above are unavailable until
such producer definitions/evidence exist. `cash_net` is explicitly unavailable
in the rich projection; no forecast, runway or cash completeness is inferred.
