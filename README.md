<a href="https://github.com/Jevelopers-neatHack-2026/cost-intelligence">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/readme/banner-night.svg">
    <img alt="cost-intelligence — Pricing, budgets and ledger. TicketStub banner showing a curling receipt tape with ruled columns and a small balance glyph." src="docs/assets/readme/banner-day.svg" width="100%">
  </picture>
</a>

# cost-intelligence

TypeScript finance package for TicketStub usage pricing, budgets, the financial ledger, reconciliation, summaries and exports.

<p>
  <a href="https://github.com/Jevelopers-neatHack-2026"><img alt="TicketStub ecosystem" src="https://img.shields.io/badge/TicketStub-ecosystem-E4572E?style=flat-square&labelColor=17140F"></a>
  <a href="#status"><img alt="Status: local financial components; host and release acceptance pending" src="https://img.shields.io/badge/status-local%20foundation-B4693E?style=flat-square&labelColor=17140F"></a>
  <a href=".node-version"><img alt="Node.js 22.23.3" src="https://img.shields.io/badge/node-22.23.3-26302A?style=flat-square&labelColor=17140F"></a>
  <a href="postgres-test-image.json"><img alt="PostgreSQL 16, pinned by digest for tests" src="https://img.shields.io/badge/postgresql-16-7CC6D2?style=flat-square&labelColor=17140F"></a>
</p>

[Status](#status) · [Architecture](#architecture-and-responsibilities) · [Quickstart](#quickstart) · [Configuration](#configuration) · [Checks](#checks) · [Docs](#docs) · [Related](#related-repositories)

## Status

`@jevelopers/cost-intelligence` is a private, unpublished ESM package at version `0.1.0`. The default branch implements the following components, with synthetic fixtures and PostgreSQL-backed checks where applicable:

| Component | Implemented behavior | Detail |
| --- | --- | --- |
| Pricing v2 | Immutable scoped rate/rule/FX catalogs and exact, non-posting estimates through injected authority, clock and database ports | [Pricing](docs/api/pricing.md) |
| Financial ledger and accounting | Append-only events, deterministic as-of projections, and separate commerce, expense and cash semantics | [Ledger](docs/api/ledger.md) · [Accounting](docs/api/accounting.md) |
| Usage intake | `ingestUsage` and `replayUsageOutbox`: durable observations, attempt correlation, bounded posting recovery and explicit unknown usage | [Usage intake](docs/api/usage-intake.md) |
| Project budgets | `authorize`, `markDispatched`, `changeBudget`, current lookup/revalidation and partial acknowledgement with configured host/source ports | [Finance authority mapping](docs/api/budget-authority.md) |
| Reporting | `querySummary` / `querySummaryV2`: scoped immutable PostgreSQL snapshots, exact money and bounded pagination | [Reporting](docs/api/reporting.md) |
| Prepared exports | Versioned JSON/CSV artifacts from verified stored snapshots, with current disclosure checks | [Prepared exports](docs/api/prepared-exports.md) |

These interfaces require their documented trusted host and persistence ports. An unconfigured call returns a typed unavailable result rather than assuming authority or inventing a financial zero.

The retained pricing 1.0.0 `estimate`, public budget `settle`/`release`, `recordExpenseAdjustment`, ledger `ingestFinancial`, and `startReconciliation`/`getReconciliation` remain unavailable facades after validation and authorization checks. Their error codes are documented in the [API status table](docs/api/README.md#implemented-and-unavailable-operations). In particular, low-level lifecycle helpers do not establish accepted public settlement semantics; [CI-05B #13](https://github.com/Jevelopers-neatHack-2026/cost-intelligence/issues/13) remains open.

Pending, and not claimed here:

- **Financial release.** The [Financial Intelligence release gate #5](https://github.com/Jevelopers-neatHack-2026/cost-intelligence/issues/5) remains open. Integration/release suites require every nonempty domain suite; missing adapters or reconciliation tests keep them blocked. Historical scoped sponsor evidence does not satisfy the complete financial or product release.
- **Host integration.** Real current-authority issuers, mounted application composition and exact consumer acknowledgements remain separate gates. Local SQL tests and prepared export files do not prove a provider charge, a deployed host or a CFO.ai import.
- **Shared contracts.** `@jevelopers/shared-contracts@0.3.0` is pinned as a **proposal-only** dependency with unresolved finance findings FC-001 to FC-004 and no accepted consumer handoff. Local use proves the pinned artifact is consumed and checked; it does not make it canonical or release-ready. See [`contracts.lock.json`](contracts.lock.json) and [compatibility](docs/api/compatibility.md).

> [!WARNING]
> This repository is public. Commit only sanitized fixtures and reports; do not add credentials, production records, connection strings, private customer data, or local absolute paths.

## Architecture and responsibilities

Finance owns usage correlation, pricing, reservation decisions, ledger semantics and reproducible financial reads/exports. Producers supply execution facts; the application supplies authenticated scope and independently verified current authority. Dashboard consumers render the resulting projections. This package is composed in-process and does not start an HTTP service.

Public subpaths include `/contracts`, `/metering`, `/pricing`, `/budgets`, `/ledger`, `/accounting`, `/evidence`, `/reconciliation`, `/reporting` and `/integrations` under `@jevelopers/cost-intelligence`. See the exact export map in [`package.json`](package.json) and the [API guide](docs/api/README.md).

## Requirements

Use Node.js **22.23.3** and npm **10.9.9**. [`.node-version`](.node-version), the package engine range `>=22.23.3 <23`, and [`.npmrc`](.npmrc) `engine-strict=true` define the toolchain. TypeScript **5.9.3** is locked locally. Database suites need Docker with a running daemon for the digest-pinned PostgreSQL 16 test image, or an explicitly marked disposable database as described below.

## Quickstart

From a checkout of this repository:

```sh
npm ci
npm run typecheck
npm run build
npm run test:smoke -- --offline
```

`npm run build` compiles to `dist/` and regenerates the versioned JSON Schemas under [`schemas/`](schemas/) and [`docs/api/schema-index.json`](docs/api/schema-index.json).

## Configuration

The package receives runtime dependencies through typed ports; it does not discover production credentials or database settings from a `.env` file. Supply only the ports needed by the selected API:

| Configuration boundary | Host responsibility |
| --- | --- |
| Trusted context, clock and Finance authority | Authenticate tenant/project/actor/environment/billing scope and current permission for the exact operation |
| Pricing, ledger, usage and reporting database ports | Provide appropriately scoped PostgreSQL transactions and apply the checksummed migrations |
| Budget authority and evidence ports | Independently verify current grants, target bindings, source records and conservative spending caps |
| Reporting/export ports | Supply pinned producer identity, private cursor/receipt material, reviewed artifact storage and a coherent current disclosure fence |
| `CI_TEST_DATABASE_URL` (tests only) | Optional database override; the target must carry the `cost-intelligence-disposable-v1` marker. The test wrapper does not reset or delete that target |

See [security](docs/api/security.md), [budget authority](docs/api/budget-authority.md), [prepared exports](docs/api/prepared-exports.md) and [database lifecycle](docs/development.md#postgresql-lifecycle). A source hash or `evidenceMode` label is not an authorization grant.

## Checks

```sh
npm run test:contracts
npm run test:exports
npm run test:smoke -- --offline
npm run test:traceability
npm run test:metering                 # local intake boundary fixtures
npm run test:pricing -- --offline      # Docker: PostgreSQL 16
npm run test:ledger -- --offline       # Docker: PostgreSQL 16
npm run test:recovery -- --offline     # Docker: intake crash/replay fixtures
npm run test:reporting -- --offline    # Docker: scoped query fixtures
npm run test:budgets -- --offline --suite=authorization
npm run test:migrations -- --offline   # Docker: PostgreSQL 16
```

`--offline` means no provider or external accounting calls; Docker may pull the digest-pinned image. Each `test:*` script builds first. [`scripts/suite-policy.mjs`](scripts/suite-policy.mjs) defines the current suite inventory and rejects missing, empty, skipped or failed required tests; [`foundation` CI](.github/workflows/ci.yml) records the executed checks. There is no separate package lint script.

Budget selectors also include `contention` and `lifecycle`. Nested scopes remain explicitly deferred from the v1 release gate under issues [#17](https://github.com/Jevelopers-neatHack-2026/cost-intelligence/issues/17) and [#18](https://github.com/Jevelopers-neatHack-2026/cost-intelligence/issues/18). The [development guide](docs/development.md) provides the PostgreSQL lifecycle and packed-consumer procedure; use the current package scripts and suite policy for the executable inventory.

## Repository structure

| Path | Contents |
| --- | --- |
| [`src/`](src/) | Typed financial APIs, authority boundaries and persistence implementations |
| [`migrations/`](migrations/) | Checksummed PostgreSQL schema and role migrations |
| [`schemas/`](schemas/), [`docs/api/schema-index.json`](docs/api/schema-index.json) | Generated versioned API schemas and digest index |
| [`tests/`](tests/), [`fixtures/`](fixtures/) | Synthetic checks, contract fixtures and recovery cases |
| [`scripts/`](scripts/) | Build/schema export, suite selection and disposable database lifecycle |
| [`examples/`](examples/), [`docs/`](docs/) | Host composition examples and detailed API references |
| [`contracts.lock.json`](contracts.lock.json), [`vendor/`](vendor/) | Exact proposal artifact provenance and bundled dependency |

## Docs

| Document | Covers |
| --- | --- |
| [Development and verification](docs/development.md) | Toolchain pins, commands, suites, database lifecycle |
| [API notes](docs/api/README.md) | Versions, errors, money, scope, schema artifacts |
| [Pricing](docs/api/pricing.md) · [Ledger](docs/api/ledger.md) | Implemented v2 pricing and ledger behavior |
| [Usage intake](docs/api/usage-intake.md) · [Budget authority](docs/api/budget-authority.md) | Durable usage recovery and current project reservation boundaries |
| [Reporting](docs/api/reporting.md) · [Prepared exports](docs/api/prepared-exports.md) | Scoped query snapshots, JSON/CSV artifacts and disclosure fencing |
| [Accounting](docs/api/accounting.md) · [Evidence](docs/api/evidence.md) | Metric policy and auditable operational references |
| [Compatibility](docs/api/compatibility.md) | Shared-contract pin, FC-001 to FC-004, upgrade gate |
| [Ownership](docs/architecture/OWNERSHIP.md) · [Decisions](docs/architecture/DECISIONS.md) · [Acceptance](docs/architecture/ACCEPTANCE.md) | Responsibilities, decisions, acceptance IDs |

## Related repositories

- [shared-contracts](https://github.com/Jevelopers-neatHack-2026/shared-contracts): producer of the pinned proposal schemas
- [team-dashboard](https://github.com/Jevelopers-neatHack-2026/team-dashboard): consumer of versioned finance projections and exports; mounted host authority is a separate integration gate
- [integration-evals](https://github.com/Jevelopers-neatHack-2026/integration-evals): authoritative acceptance checklist and evidence
- [getticketstub.com](https://github.com/Jevelopers-neatHack-2026/getticketstub.com): host application and [central implementation plan](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/blob/main/docs/planning/implementation-plan.md)
- [agent-harness](https://github.com/Jevelopers-neatHack-2026/agent-harness), [event-intelligence](https://github.com/Jevelopers-neatHack-2026/event-intelligence) and [creative-engine](https://github.com/Jevelopers-neatHack-2026/creative-engine): execution/usage producers and intended budget consumers; their evidence does not replace Finance authority

## Contributing

Read [AGENTS.md](AGENTS.md) and follow the organization [contributor guidance](https://github.com/Jevelopers-neatHack-2026/.github/blob/main/CONTRIBUTING.md). Record the exact tested revision and distinguish fixture evidence, accepted consumer mappings and live integrations in PRs. The [integration-evals master checklist](https://github.com/Jevelopers-neatHack-2026/integration-evals/blob/main/planning/acceptance-checklist.md) remains the product acceptance authority.

## License

Original project code and technical documentation are licensed under the [MIT License](LICENSE). See [COPYRIGHT.md](COPYRIGHT.md) for team attribution, scope and preserved third-party rights.
