# Usage intake

`ingestUsage` is the finance-owned entry point for one validated, version-pinned `UsageEvent`. It retains a normalized observation in PostgreSQL, links it to the stated billable attempt, creates a durable posting intent, and uses the existing immutable ledger append path for valued charges and corrections. It does not call a provider or take ownership of producer execution.

This implementation is local synthetic development. The installed `@jevelopers/shared-contracts@0.3.0` pin remains `proposal_only`; this document and the finance wrapper do not create a canonical shared schema, prove issuer identity, or claim producer adoption. No authentic issuer or provider integration is enabled.

## Boundary and identities

The request wrapper contains `schemaVersion`, `requestId`, `idempotencyKey`, the five-part trusted scope, the pinned canonical `UsageEvent`, evidence mode, verification status, and a provenance reference. The complete wrapper and nested contract are validated before storage. A canonical tenant, project, environment, or billing-mode mismatch returns `FORBIDDEN_SCOPE`. The injected current Finance authority must grant `metering.ingestUsage` / `usage.ingest` to an active service principal before a connection is opened; PostgreSQL then binds tenant, project, environment, and billing mode transaction-locally and applies row-level security.

The inbox stores source-observation ID, logical-operation ID, provider-attempt ID, billable-attempt ID, transport-attempt ID, and optional provider-request ID as separate fields. A new transport or source observation is retained as evidence; neither model nor timestamp can merge two billable attempts. A missing required attempt identity fails pinned contract validation and goes to hash-only quarantine with unknown identity values in the receipt. The intake never invents provider, billable, transport, event, or charge IDs.

The inbox persists selected normalized source facts and SHA-256 hashes for the canonical payload and provenance reference. It does not store the raw provenance reference or unvalidated source payload. Identifiers, dimensions, and measure names use restricted character and allowlists; unsafe candidates are retained only as a scope, reason code, payload hash, and diagnostic reference. The payload limit is 64 KiB. There is no batch endpoint. At most 1,000 pending or retryable posting intents are admitted per scope, replay drains at most 100 rows, and each posting intent receives at most five attempts with bounded exponential delay before dead-lettering.

## Durable receipt and replay behavior

Inbox acceptance, attempt coverage, outbox intent, and any ledger append commit in one PostgreSQL transaction. The transaction uses the same scope advisory lock as financial ledger writes and the existing ledger validation, lineage, immutable-event, identity-binding, source-revision, and privacy-quarantine checks. The ledger append runs in a savepoint under the already-verified metering decision; it does not request or infer another permission. A receipt with `durableCommit: true` is returned only after the outer transaction commits.

| Receipt/outbox status | Meaning |
| --- | --- |
| `accepted` + `posted` | Observation, attempt coverage, outbox result, and effective ledger append committed. |
| `accepted` + `awaiting_evidence` | Observation and attempt are durable; no currency or usable valuation exists yet, so no numeric amount or ledger posting is invented. |
| `accepted` + `pending` or `retry` | The outbox intent is durable and awaits ordered processing or retry. `replayUsageOutbox` rechecks current Finance authority and works in bounded batches. |
| `accepted` + `suppressed` | A second source observation for an already covered billable attempt is retained, but it does not create another expense. |
| `duplicate` | Same scoped idempotency key or source-observation identity and identical content; the existing attempt/event linkage is returned. |
| `conflict` | An idempotency key or observation identity was reused with contradictory content, or a billable attempt was rebound to a different logical operation/provider attempt. No new financial effect is accepted. |
| `quarantined` + `dead_letter` | Canonical validation or safe-metadata validation failed after current scope authorization; only a stable payload hash and reason are retained. |

The database unique constraints and transaction lock are the concurrency authority. Direct and trace observations with the same explicit billable-attempt identity both remain in the inbox and map to one expense. A new billable-attempt ID under the same logical operation creates a separate expense. A repeated acknowledgement after a commit returns the original durable result. A process death before commit leaves no inbox, outbox, or ledger rows; death after commit loses only the response, and replay resolves as a duplicate.

## Incomplete usage, cumulative snapshots, and valuation

Unknown valuation keeps `money: null`; missing usage keeps `usage_units: null` and its explicit completeness/missing-field state. When no currency can be identified, the intake holds that observation as `awaiting_evidence`; the ledger schema requires a currency and cannot represent a currencyless unknown line. The authoritative `LedgerProjectionSchema` exposes an optional `unresolvedIntake` summary with unknown economic exposure, quarantined observation, awaiting-evidence attempt, and unposted attempt counts. On a complete current 0009 schema, counts are derived from durable, scope-bound intake facts and privacy-safe quarantine hashes at the requested as-of time, then stored in the immutable projection snapshot. A genuine pre-intake ledger schema (migrations through 0008) omits this optional summary to show intake coverage is unavailable; any partial 0009 schema fails projection with `SOURCE_UNAVAILABLE`. No amount, currency, provider confirmation, or attempt ID is invented, and unresolved exposure is never represented as zero.

A later observation updates the attempt head only when it explicitly names the current source observation in `supersedes_observation_id`. The finance ledger appends a correction on the same source line and mapping; projections select the current revision, so an estimate replaced by provider-confirmed evidence is not added twice. An older observation arriving after the final observation is retained and suppressed without moving the head. Projection quantity rows carry `includedIn` and aggregate by unit, relation, and parent measure, so cache and reasoning subsets remain distinct from their containing totals. Coding-session cumulative snapshots that lack genuine attempt identity are rejected or quarantined rather than assigned a charge ID.

`evidenceMode`, `verificationStatus`, and valuation basis remain separate labels. Their presence does not independently establish a provider charge or authenticated producer. Price-bearing events preserve the pinned rate-card reference; there is no pricing lookup or provider call during intake.

## Existing 0006 migration-role handoff (to 0009)

The frozen 0006 migration leaves `schema_migrations` and `foundation_health` owned by the database installer, even though it creates `ci_finance_owner` and `ci_finance_migrator`. PostgreSQL requires ownership of the existing view to replace its definition and write access to record the new checksum. Before a dedicated migration login applies 0007 (accounting projection snapshots), 0008 (budget reservations) and 0009 (usage intake) to a database already at 0006, the database owner must perform this one-time ownership handoff:

```sql
ALTER TABLE cost_intelligence.schema_migrations OWNER TO ci_finance_owner;
ALTER VIEW cost_intelligence.foundation_health OWNER TO ci_finance_owner;
GRANT EXECUTE ON FUNCTION cost_intelligence.reject_ledger_projection_mutation() TO ci_finance_owner;
```

The `GRANT` is needed because 0007 and 0008 attach append-only triggers that use the installer-owned 0003 function, and 0006 revokes `PUBLIC` execute on it; the owner role must hold `EXECUTE` to create those triggers. The incoming 0007 and 0008 migrations are unchanged.

The separate login can then assume `ci_finance_migrator`, followed by `ci_finance_owner`, apply each of 0007, 0008 and 0009, and record each checksum in the same transaction as that migration. This keeps the runtime role without DDL, owner, or migration-history privileges. The PostgreSQL migration test exercises that exact 0006-to-0009 path and confirms the runtime grants remain restricted.

## Runtime and local evidence

`UsageObservationSchema`, `IngestionReceiptSchema`, and the bounded replay request/receipt schemas are finance-owned generated schemas. `validateUsageObservationBoundary` is the combined validator for the wrapper and the installed canonical event. The runtime uses Node 22.23.3 and the disposable PostgreSQL 16 image pinned by `postgres-test-image.json`.

`npm run test:metering` covers wrapper, identity, unknown-valuation, and bounded-command behavior. `npm run test:recovery -- --offline` exercises actual restricted-role inbox/attempt/outbox/ledger writes, concurrent duplicate deliveries, direct/trace deduplication, distinct billed retries, correction replacement, unknown exposure, retry recovery, and process death before and after commit. `npm run test:security -- --offline` covers current authorization and cross-scope behavior. `npm run test:contracts` checks generated schemas and the pinned contract boundary. The aggregate integration/release suites still report their missing assigned-domain suites; this intake implementation does not claim those domains or global acceptance as complete.
