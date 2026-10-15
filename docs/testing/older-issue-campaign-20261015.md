# Older Finance issue campaign: implementation and dependency handoff

Frozen queue: 17 open issues, inclusive creation cutoff 2026-10-13T05:38:56Z.
Start/default baseline `2d8ab3aa787a34e1005a6e2398ddbbcdd905c2e4`; clean tracked
checkout. Refs refreshed using configured Git credentials. No owner branch,
foreign repository, issue state or master acceptance was modified.

## Implementation candidates

1. Reporting prerequisite, commit `c81a8c0`, draft PR64: native reported-unsettled
   detail and expense bucket, conservative canonical mapping, immutable old
   snapshot compatibility and explicit not-supplied JSON export handling. Exact
   source contract is [documented here](../api/reported-unsettled-reporting.md).
2. Settlement integration starts with that commit and preserves PR59 head
   `50e81e43518ca095c7657e334fa983869320b892` through a normal local merge.
   The repair retains the persisted financial lifetime through dispatch mutation
   proof checks, checks it after final current-authority awaits, and takes the
   minimum when returning a fresh Finance envelope. Existing expired-reservation
   denial semantics remain. Holds are not released by expiry.
3. New actual PostgreSQL regressions cover expiry widening, crossing expiry in
   the final authorization callback, and signed synthetic reported cost through
   settlement, ledger, query and file export with unresolved hold retained.
   Host grants, source keys/business observations remain synthetic. This is not
   live provider execution, actual host adoption, CFO delivery or consumer ACK.

[Producer handoff](../api/producer-finance-handoff-20261015.md) records current
Finance callbacks, precise shared-artifact elections, proposed local-execution
mapping and unresolved caller-version differences. Consumer owners must return
exact producer rows/revisions and acceptance; this agent cannot fabricate ACKs.

## Queue disposition and next owner

| Issue | Delivered/current local work | Precise remaining requirement |
| --- | --- | --- |
| #1 epic | Dependency order inspected; retained all children | Supervisor reviews/merges qualified children; Integration-evals owns complete financial/product acceptance. |
| #3 export | PR64 preserves the reported expense partition; composed PG chain added | Product/runtime + Finance accepted issuer/principal/grants, trusted five-field scope, read source, final disclosure fence and recovery protocol; Dashboard strict new-field ACK; CompleteDotTech's actual authorized CFO delivery/import and acceptance. See issue3 comment6132284704. |
| #5 release gate | Existing gate remains fail closed | Accepted child implementations and exact consumer/host evidence; real adapters/full reconciliation suites still missing. Only Integration-evals owns master acceptance. |
| #6 runtime | Foundation merged PR19; local pin/tooling preserved | shared-contracts #1/#11/#12/#13 accepted immutable contract election, producer/consumer reviews and owner checkbox/evidence disposition. |
| #7 ledger | PR20 immutable ledger present; held reported-cost extension preserved | Accepted shared usage/reservation interfaces and actual producer/host conformance; whole held financial extension independent review/merge and post-merge evidence. |
| #8 isolation | PR22 plus subsequent current-authority/read guards present | getticketstub.com #9 trusted context/issuer mapping and actual current/foreign/revoked/expired grants with Finance operation permissions; accepted current source/disclosure/recovery composition. |
| #9 pricing | PR21 exact v2 catalogs/estimates present | Real owner-issued tariff/rule/source/issuer and consumer mapping; numeric fixture rates are not approved provider tariffs. No live provider call authorized here. |
| #10 intake | PR36 durable v1 intake/replay present | Producer-owned operation/attempt/direct-vs-trace mapping, shared-contracts #11 v2/local execution election, authentic source/transport mapping and real producer conformance. No implicit upgrade from 1.0 or creative.metering.proposal/v1. |
| #11 evidence | PR34/46/51/54 reader/lineage slices present | Producer-owned complete evidence mappings and authentic scoped source/custody; accepted adjustment/reconciliation/export lineage across the full journey. |
| #12 reservations | PR39 admission present; expiry repair supplied on composed branch | Exact-candidate independent money review/merge/post-merge evidence; current host/source/maximum and callback consumer ACK (EI #4/#13, Harness #5/#14, Creative #37). |
| #13 settlement | Existing PR37/43/53/59 history preserved; expiry repair and PG reporting/export composition supplied | Whole settlement independent review, required checks and supervisor merge; strict reported-field consumer ACK and genuine issuer/source/finality adoption. No go-live trigger or closure. |
| #14 accounting | Merged PR31 pure helper retained | Finance owner must return retrievable R4 source7210be783bf8694b1cde6bb07866d5250fd6aca8 plus ancestry from83092f1e91ca0d6b5c58fa09e12084a93a9a037c, separately hashed uncommitted repairs and review packet; current issue14 source-recovery handoff remains unresolved. Operational durable intake and R4-001/002 cannot be represented as completed by the materially different helper. |
| #15 adapters | Exact version/mapping handoff supplied | Six producer source classes need accepted actual row/transport/identity/currency/mode mappings and shared event/delivery/receipt election. Finance current v1 cannot truthfully represent print local unavailable-provider rows. Shared-contracts #11 and each producer own those source facts. Then implement the coordinated adapters; no substitute canonical contract invented. |
| #16 reconciliation | PR54 durable coverage-only API retained | Local prerequisites #13 settlement and #14 operational accounting: independently reviewed settlement candidate plus the missing owner R4 accounting source/repairs. This issue lists no separate external interface prerequisite beyond the reviewed architecture/catalog. Full matching/variance/review-apply remains local unfinished work after those prerequisites; coverage is not financial reconciliation. |
| #17 nested P1 | Existing explicit non-v1 deferral preserved | Reviewed/merged #12/#13 lifecycle and shared-contracts #12 accepted nested-scope membership/policy/migration interface; Product supplies authentic customer/order mapping. Atomic nested implementation remains unfinished; no uncoordinated scope contract invented. |
| #18 regression | Three PG regressions and proposal tests added; fail-closed inventory retained | Accepted adapter/reconciliation/consumer fixtures and exact owner oracles; full nonempty required suites, independent review and post-merge qualification. |
| #27 Entire | PR38/62 defaults and trust fallback retained | ECIR-001/002/003 independently reviewed compatible plugin/source/release/digest/generated contract plus explicitly authorized isolated upload destination/redaction/retention evidence. This campaign authorizes neither Entire execution nor checkpoint upload, so no probe/install/upload was attempted. |

## Runtime and evidence limits

Implementation runtime self-identifies as Codex/GPT-6. Exact provider model ID,
native effort/priority and billable usage are not exposed; no model settings were
changed. Shared guidance is not silently adopted as local routing policy.

Existing test executable verified `v22.23.3`; package checks use npm10.9.9.
The generic shell defaults to Node24.15.0/npm11.12.1 and was not used for package
acceptance. Disposable Docker PostgreSQL is used; no provider calls occur.
Entire execution was not attempted: approval/compatibility prerequisites remain
unsatisfied. Fallback: focused rg/source reads and real behavior verification.

Initial failures are retained as failures: missing dependencies before install;
one malformed source-port fixture; two deliberate unpatched expiry regressions;
a numeric serialization assertion; a mistakenly edited quarantine SQL alias
(restored); and initial expired-reservation response-shape regressions. Passing
reruns do not erase those results. Test manifests retain each aggregate run.
No required independent approval, historical ACK or human gate was supplied by
these self-authored tests. No issues were closed and no PR was merged or deployed.


## Aggregate fixture corrections

The full selection exposed a PostgreSQL23505 collision at the foreign-quarantine
fixture: its fixed record hash had already been inserted by an earlier selected
suite. The record now receives a unique synthetic hash; the actual quarantined
ledger hash, foreign-scope positive, release refusal and hold-conservation
assertions are unchanged. This resolves the observed isolated/aggregate outcome
difference without changing runtime quarantine logic.

The retry-backoff regression samples the actual failed posting transaction's
PostgreSQL `now()` and compares the persisted schedule to the independent
2/4/8/16-second policy oracle. It no longer compares database time to host wall
time or test elapsed time. Five attempts, exact retry counts, dead-letter state,
retained evidence and zero partial charges remain enforced.

## Final executed qualification

Implementation revision `306a0289ae62e58bdc4a565c727fa8ce29ec9083`:
`npm run test:release -- --offline` executed all1,006 selected registrations,
1,006 passed, zero failed/skipped/TODO/cancelled. The command exits1 with
`required_test_files_missing` for exactly `tests/adapters/adapters.test.mjs` and
`tests/reconciliation/reconciliation.test.mjs`; status is blocked, never passed.
This superset includes authorization76, contention5, lifecycle38 (including the
three new real-PG regressions), recovery12, reporting96+4, ledger8, migrations35,
security6, actual PostgreSQL audit/coverage readers and the packed package tests.
Counts include nested/repeated registrations and are not unique scenarios.

The [structured results](older-issue-campaign-20261015-results.json) preserve
actual aggregate outcomes and SHA-256 references for earlier failures and the
final run. PR64 is the focused main-based projection candidate; PR65 composes
its source with the preserved held settlement candidate and repair. Required
review is independent and supervisor-owned; neither PR is merged. No issue is
reported wholly complete or eligible for closure before merge and required
post-merge/owner evidence.

Current #14 source availability was rechecked: local `git cat-file -t` cannot
resolve7210be783bf8694b1cde6bb07866d5250fd6aca8, and the configured GitHub commit
API returns404. This is a concrete source/access handoff gap, not proof that the
owner's preserved repairs have been lost.
