# Compatibility and contract adoption

## Current pin

The local package consumes the exact archive for `@jevelopers/shared-contracts@0.3.0`, proposal head `24eae28e3ae646c10bf26e483d9009e00381e6ec`, schema version `1.0.0`, archive SHA-256 `29032c3caae8f5d45a9665ef2263e7014e429b94d4b4267d36826c0790de88f2`.

**Adoption status: proposal only.** The draft has four finance-blocking findings (FC-001 through FC-004), no accepted finance consumer acknowledgement, and no producer handoff. `contracts.lock.json` records the chosen immutable proposal archive and hashes of 29 selected artifacts. Tests verify those bytes against the installed dependency. Do not describe this as an accepted release or as cross-repository conformance.

## Exact-version behavior

The candidate's policy uses exact semantic schema versions, rejects unknown fields and enums, and only permits an optional-field addition under a new exact schema version. Existing version encodings and fixtures are retained for consumers during any eventual migration. This package rejects every unsupported local version rather than silently accepting unknown minor or additive values. Because no previous cost-intelligence API release is accepted, older-consumer compatibility remains unverified.

### Pricing version migration

The original base pricing 1.0.0 `RateCard`, `EstimateRequest`, and `EstimateResult` schemas and types remain available under their exact names and shapes, along with the original fail-closed `estimate` function. The base had no catalog-write API. Incompatible catalog, rule, FX, and valuation shapes are 2.0.0 and use explicit `*V2Schema`, `*V2` type, and `*V2` function names; generated v2 pricing artifacts live under `schemas/cost-intelligence/2.0.0/pricing/`. A clean packed-consumer check compiles and imports both interfaces and validates old and new wire fixtures. The 1.0.0 estimate remains fail closed because that encoding cannot carry the required operation-specific host grant. Use the v2 functions for pricing behavior.

Pricing v2 consumes the unchanged shared `UsageEvent@1.0.0` and uses finance-owned v2 references for its rules, cards, FX rates, and valuation results. No canonical contract or issuer capability was added. A real issuer adapter and its accepted decision source remain an external integration gate.

## Runtime boundary

The package targets the Node.js 22 backend line (`>=22.23.3 <23`); the current acceptance run is pinned to Node 22.23.3. The financial ledger and v2 pricing are backend specialist modules. Hosts inject existing PostgreSQL-compatible transaction ports, clocks, and an operation-scoped current finance authority. The modules open no hidden pool, and callers cannot authorize a wider tenant, project, environment, or billing-mode scope by changing request fields. Browser-safe execution is not supported or claimed, and Node 24 compatibility has not been tested or claimed.

## Finance handoff blockers

The candidate cannot currently express an observed final overrun without rejecting the amount or rewriting a held amount (FC-001). Its independent reservation context and result semantics do not bind environment and billing mode consistently (FC-002). Settlement and grant result economics do not agree with commands or resolve cumulative versus delta and partial authorization semantics (FC-003). The uncertain reservation state `held_for_reconciliation` is rejected where it is required (FC-004).

The finance API therefore wraps the proposal's generated schemas/types and rejects scope mismatches before an unavailable leaf result. Its typed wrappers carry overrun evidence, cumulative/partial/final settlement, partial authorization consent, unresolved holds, query snapshot metadata, and adjustment lineage. The wrappers support foundation compilation and boundary tests only; they do not patch, fork, or relabel the producer contract.

## Upgrade gate

Upgrade only after the producer publishes an immutable corrected artifact; finance verifies its source revision, package integrity, schema and fixture digests, and package behavior; all required consumer rows have exact pins, test results, and acknowledgements; and a fresh review accepts the cross-repository mapping. Keep this proposal archive, its hash, and current fixtures available as the rollback baseline. Do not replace the lock with an unreviewed merge candidate or mutable branch/tag.

### Reporting version migration

The exact 1.0.0 query/page encoding remains available and now executes against
scoped PostgreSQL for a representable UUID/single-observed-currency result.
The additive Finance-owned 2.0.0 wrapper carries supplemental breakdown,
coverage, exact approval ratios, budget and safe detail data; its
`canonicalSummaries` retain the unchanged installed shared FinancialSummary.
The independently compared FinancialSummary/CommonEnvelope/ErrorEnvelope
schema bytes match Dashboard's 0.9.7 pin. Package-version difference alone is
not a wire blocker; issuer mapping, independently resolved reference bodies,
selected metric names, exact semantic fixtures and owner/consumer ACK remain
pending. No dependency archive or canonical schema was changed by CI-08.

See [reporting.md](./reporting.md) for the precise version/hash/cursor/snapshot
contract, declared Finance-owned definition registry, optional proposed
READ/EXPORT action adapter and remaining owner decisions. Existing v1 export
consumers receive only a verified legacy first page; v2 supplemental facts are
not silently attached to a canonical shared object.
