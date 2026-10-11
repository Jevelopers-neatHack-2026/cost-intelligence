# cost-intelligence

TypeScript foundation for usage-cost, budget, ledger, reconciliation, summary, and export boundaries.

## Current delivery state

This branch contains the Node/TypeScript package, typed versioned boundaries, generated local schemas, a checksummed PostgreSQL migration foundation, and local offline verification. The financial domain operations remain unavailable: public methods return typed errors until the corresponding accounting, metering, pricing, budget, reporting, reconciliation, and adapter leaves are implemented and accepted.

The installed `@jevelopers/shared-contracts@0.3.0` artifact is pinned as a **proposal-only test dependency**. It is a draft producer candidate with unresolved finance findings FC-001 through FC-004 and no accepted consumer handoff. See [`contracts.lock.json`](contracts.lock.json) and [API compatibility](docs/api/compatibility.md). Local use proves the pinned artifact is consumed and checked; it does not make it canonical or release-ready.

The repository is public. Commit only sanitized fixtures and reports; do not add credentials, production records, connection strings, private customer data, or local absolute paths.

## Toolchain and verification

The package is Node.js 22.23.3, npm 10.9.9, TypeScript 5.9.3, ESM, and PostgreSQL 16 for database-backed suites. Use the checked-in `.node-version` and npm lockfile. Hosts running Node 23 or later are outside the package engine range; install the pinned Node/npm pair with a version manager rather than changing global host configuration. When upgrading the runtime, update `.node-version`, `engines`, `packageManager`, and the lockfile together, then rerun the full command contract below and the packed-consumer check. The PostgreSQL image stays pinned by digest independently of the host's local Docker version.

```sh
npm ci
npm run typecheck
npm run build
npm run test:contracts
npm run test:exports
npm run test:migrations -- --offline
npm run test:smoke -- --offline
npm run test:traceability
```

The public script names are `test:accounting`, `test:adapters`, `test:budgets`, `test:contracts`, `test:exports`, `test:integration`, `test:ledger`, `test:metering`, `test:migrations`, `test:pricing`, `test:reconciliation`, `test:recovery`, `test:release`, `test:reporting`, `test:security`, `test:smoke`, `test:traceability`, and `test:unit`. Leaf suites that are not implemented yet deliberately exit nonzero with an evidence manifest; integration and release use `blocked` status until all required leaf implementations and nonempty suites are present.

Docker Engine with a working local daemon is required for database-backed tests. The lifecycle wrapper creates a PostgreSQL 16 container from the immutable digest in [`postgres-test-image.json`](postgres-test-image.json), binds its random port to loopback, generates a random test-only database password in memory, waits for readiness, marks the disposable database, applies checksummed migrations, runs the selected suite, retains sanitized logs, and removes the container in `finally`. The password is not written to logs or manifests. `--offline` means tests do not call providers or external accounting services; Docker may fetch the pinned image when it is not cached.

`npm run test:migrations -- --offline` checks both an empty database and a previous-foundation fixture containing migration `0001`. It creates a uniquely named sibling database for the previous fixture, applies the pending upgrade, verifies health and durable records from a separate worker process, and drops that sibling database in cleanup. A `CI_TEST_DATABASE_URL` override is accepted only after the named target contains `cost-intelligence-disposable-v1`; the wrapper never resets or deletes that target. The override must allow connection to the `postgres` maintenance database and `CREATEDB`/`DROP DATABASE` for the temporary previous-fixture check. Test processes receive host/user/database fields and a separate password variable, not the original connection URL. If creation or cleanup is not permitted, the migration suite fails closed and reports the safe reason.

The selector contract currently defines budget leaves: `npm run test:budgets -- --suite=authorization`, `--suite=contention`, `--suite=lifecycle`, or `--suite=nested-scopes`; comma-separated distinct selectors may be combined. Nested scopes is the assigned P1 issue #17 and is explicitly deferred from the default v1 integration/release gate per issue #18; manifests record that deferral, while an explicit nested-scopes selector still fails until its test lands. An empty, repeated, unknown, or unsupported selector fails without falling back to the full suite. A recognized selector whose required leaf has not landed also fails and records the missing file. The runner checks Node 22 structured test events separately for every required file, ignores the Node file wrapper, and requires each file to register and complete at least one real test case. Any skipped, todo, cancelled, failed, empty, or missing required file fails the gate; an unrelated passing file cannot satisfy it. See the [Node.js 22 test runner event API](https://nodejs.org/download/release/v22.23.3/docs/api/test.html#test-runner-events) used by the custom reporter.

`npm run test:integration -- --offline` and `npm run test:release -- --offline` currently fail closed because the required financial leaf suites are absent. Their manifests list the missing suites. They must remain blocked until real domain tests and implementations land; missing or empty suites cannot pass. `npm pack` is also tested in a clean temporary consumer with offline installation, runtime imports for every public subpath, and strict NodeNext declaration compilation; the shared-contract proposal and TypeBox runtime dependencies are bundled from the pinned local install.

## Package and boundaries

All modules export typed request/result schemas and ESM entry points under `src/`. Their current implementation status and known proposal gaps are described in [API notes](docs/api/README.md), [compatibility](docs/api/compatibility.md), and [architecture decisions](docs/architecture/DECISIONS.md). Generated JSON Schema documents and their SHA-256 index are under `schemas/cost-intelligence/1.0.0/` and `docs/api/schema-index.json`.

Sanitized finance-owned request and response proposal examples live in [`fixtures/api/`](fixtures/api/); contract and smoke tests consume the same files. [`examples/worker-composition.ts`](examples/worker-composition.ts) shows typed in-process composition with injected trusted context, clock, storage, and provider-source ports. It does not start a service, and operations remain fail-closed until their domain leaves are implemented.

The finance-owned summary wrapper carries the query timezone, as-of instant, immutable snapshot identity, query and summary hashes, and source watermarks around the shared `FinancialSummary`. It also defines proposed scoped filters for repository, workstream, provider, model, workflow, job, feature category, and permitted order/customer identifiers. Query execution and export delivery are not implemented.

## Planning references

- [Repository responsibilities and interfaces](docs/architecture/OWNERSHIP.md)
- [Relevant acceptance criteria](docs/architecture/ACCEPTANCE.md)
- [Architecture decisions and pending handoffs](docs/architecture/DECISIONS.md)
- [Central implementation plan](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/blob/main/docs/planning/implementation-plan.md)
- [Contributor guidance](https://github.com/Jevelopers-neatHack-2026/.github/blob/main/CONTRIBUTING.md)
