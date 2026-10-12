# Development and verification

Operational reference for building and testing `@jevelopers/cost-intelligence`. The [README](../README.md#status) summarizes what is implemented; API behavior is described in [API notes](api/README.md).

## Toolchain

The package is Node.js 22.23.3, npm 10.9.9, TypeScript 5.9.3, ESM, and PostgreSQL 16 for database-backed suites. Use the checked-in [`.node-version`](../.node-version) and npm lockfile; [`.npmrc`](../.npmrc) sets `engine-strict=true`, and `package.json` declares `engines.node` `>=22.23.3 <23` and `packageManager` `npm@10.9.9`.

Hosts running Node 23 or later are outside the package engine range; install the pinned Node/npm pair with a version manager rather than changing global host configuration. When upgrading the runtime, update `.node-version`, `engines`, `packageManager`, and the lockfile together, then rerun the full command contract below and the packed-consumer check. The PostgreSQL image stays pinned by digest in [`postgres-test-image.json`](../postgres-test-image.json), independently of the host's local Docker version.

## Command contract

Offline checks that need no database:

```sh
npm ci
npm run typecheck
npm run build
npm run test:contracts
npm run test:exports
npm run test:smoke -- --offline
npm run test:traceability
```

Database-backed suites (need Docker, see below):

```sh
npm run test:pricing -- --offline
npm run test:ledger -- --offline
npm run test:migrations -- --offline
```

These are the steps run by the [`foundation` workflow](../.github/workflows/ci.yml). Every `test:*` script runs `npm run build` first.

## Suite inventory

The public script names are `test:accounting`, `test:adapters`, `test:budgets`, `test:contracts`, `test:exports`, `test:integration`, `test:ledger`, `test:metering`, `test:migrations`, `test:pricing`, `test:reconciliation`, `test:recovery`, `test:release`, `test:reporting`, `test:security`, `test:smoke`, `test:traceability`, and `test:unit`. Required files per suite are defined in [`scripts/suite-policy.mjs`](../scripts/suite-policy.mjs).

| Suite | Test files at this revision | Runner |
| --- | --- | --- |
| `contracts` | `tests/contracts/shared-contracts.test.mjs`, `tests/contracts/api-contract-shapes.test.mjs` | Node only |
| `exports` | `tests/exports/public-exports.test.mjs` (includes the `npm pack` clean-consumer check) | Node only |
| `smoke` | `tests/smoke/api-boundaries.test.mjs`, `tests/smoke/postgres-cleanup.test.mjs` | Node only |
| `traceability` | `tests/traceability/release-gates.test.mjs` | Node only |
| `unit` | the five foundation files above | Node only |
| `pricing` | `tests/pricing/pricing.test.mjs` | PostgreSQL 16 |
| `ledger` | `tests/ledger/ledger.test.mjs` | PostgreSQL 16 |
| `migrations` | `tests/migrations/migrations.test.mjs` | PostgreSQL 16 |
| `accounting` | `tests/accounting/accounting.test.mjs` | Node only |
| `adapters`, `budgets`, `metering`, `reconciliation`, `recovery`, `reporting` | none yet | fail closed |
| `integration`, `release` | require all domain leaves | fail closed (`blocked`) |

Leaf suites that are not implemented yet deliberately exit nonzero with an evidence manifest; integration and release use `blocked` status until all required leaf implementations and nonempty suites are present.

## PostgreSQL lifecycle

Docker Engine with a working local daemon is required for database-backed tests (`budgets`, `integration`, `ledger`, `migrations`, `pricing`, `recovery`, `release`, all run through [`scripts/with-postgres.mjs`](../scripts/with-postgres.mjs)). The lifecycle wrapper creates a PostgreSQL 16 container from the immutable digest in [`postgres-test-image.json`](../postgres-test-image.json), binds its random port to loopback, generates a random test-only database password in memory, waits for readiness, marks the disposable database, applies checksummed migrations, runs the selected suite, retains sanitized logs, and removes the container and its anonymous data volume in `finally` (`docker rm --force --volumes <container-name>`; named volumes are left alone). The password is not written to logs or manifests. `--offline` means tests do not call providers or external accounting services; Docker may fetch the pinned image when it is not cached.

`npm run test:migrations -- --offline` checks both an empty database and a previous-foundation fixture containing migration `0001`. It creates a uniquely named sibling database for the previous fixture, applies the pending upgrade, verifies health and durable records from a separate worker process, and drops that sibling database in cleanup.

A `CI_TEST_DATABASE_URL` override is accepted only after the named target contains `cost-intelligence-disposable-v1`; the wrapper never resets or deletes that target. The override must allow connection to the `postgres` maintenance database and `CREATEDB`/`DROP DATABASE` for the temporary previous-fixture check. Test processes receive host/user/database fields and a separate password variable, not the original connection URL. If creation or cleanup is not permitted, the migration suite fails closed and reports the safe reason.

## Suite selectors and gates

The selector contract currently defines budget leaves: `npm run test:budgets -- --suite=authorization`, `--suite=contention`, `--suite=lifecycle`, or `--suite=nested-scopes`; comma-separated distinct selectors may be combined. Nested scopes is the assigned P1 issue [#17](https://github.com/Jevelopers-neatHack-2026/cost-intelligence/issues/17) and is explicitly deferred from the default v1 integration/release gate per issue [#18](https://github.com/Jevelopers-neatHack-2026/cost-intelligence/issues/18); manifests record that deferral, while an explicit nested-scopes selector still fails until its test lands.

An empty, repeated, unknown, or unsupported selector fails without falling back to the full suite. A recognized selector whose required leaf has not landed also fails and records the missing file. The runner checks Node 22 structured test events separately for every required file, ignores the Node file wrapper, and requires each file to register and complete at least one real test case. Any skipped, todo, cancelled, failed, empty, or missing required file fails the gate; an unrelated passing file cannot satisfy it. See the [Node.js 22 test runner event API](https://nodejs.org/download/release/v22.23.3/docs/api/test.html#test-runner-events) used by the custom reporter.

`npm run test:integration -- --offline` and `npm run test:release -- --offline` currently fail closed because the required financial leaf suites are absent (adapters, budgets, metering, reconciliation, recovery, reporting; the accounting leaf is now implemented, release also requires security). Their manifests list the missing suites. They must remain blocked until real domain tests and implementations land; missing or empty suites cannot pass.

## Package checks

`npm pack` is tested in a clean temporary consumer with offline installation, runtime imports for every public subpath, and strict NodeNext declaration compilation; the shared-contract proposal and TypeBox runtime dependencies are bundled from the pinned local install.

## Package layout

All modules export typed request/result schemas and ESM entry points under `src/`. `npm run build` generates JSON Schema documents under `schemas/cost-intelligence/1.0.0/` (and pricing v2 under `schemas/cost-intelligence/2.0.0/pricing/`) with their SHA-256 index in [`docs/api/schema-index.json`](api/schema-index.json). Migrations live in [`migrations/`](../migrations/).

Sanitized finance-owned request and response proposal examples live in [`fixtures/api/`](../fixtures/api/); contract and smoke tests consume the same files. Synthetic acceptance inputs for the implemented leaves are [`fixtures/ledger/ci02-synthetic-acceptance.json`](../fixtures/ledger/ci02-synthetic-acceptance.json) and [`fixtures/pricing/ci03-synthetic-acceptance.json`](../fixtures/pricing/ci03-synthetic-acceptance.json).

[`examples/worker-composition.ts`](../examples/worker-composition.ts) shows typed in-process composition of the fail-closed boundaries (metering, legacy 1.0.0 pricing estimate, budgets, financial event ingestion, reporting, reconciliation, export) with injected trusted context, clock, storage, and provider-source ports. It does not start a service and does not compose the implemented pricing v2 or ledger operations.

The finance-owned summary wrapper carries the query timezone, as-of instant, immutable snapshot identity, query and summary hashes, and source watermarks around the shared `FinancialSummary`. It also defines proposed scoped filters for repository, workstream, provider, model, workflow, job, feature category, and permitted order/customer identifiers. Query execution and export delivery are not implemented.

## Data hygiene

The repository is public. Commit only sanitized fixtures and reports; do not add credentials, production records, connection strings, private customer data, or local absolute paths.
