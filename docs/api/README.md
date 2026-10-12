# API foundation

The public package exposes typed schemas and ESM functions for metering, pricing, budget authorization and lifecycle, financial ledger, reporting, reconciliation, and export. V2 pricing implements immutable catalog writes and exact non-posting estimates through injected host ports. The ledger append and projection APIs (`appendLedgerEvent`, `rebuildLedgerProjection`) are implemented as PostgreSQL-backed operations. Leaves that have not landed remain typed unavailable operations: metering `ingestUsage`, the retained pricing 1.0.0 `estimate`, all budget operations, ledger `ingestFinancial`, reporting `querySummary`, reconciliation, and `exportSummary`. Pricing estimates do not authorize budget capacity, post provider charges, or send data to external services.

## Version and error behavior

Finance-owned requests use exact schema versions. Existing non-pricing APIs remain at `1.0.0`. Pricing retains its original `1.0.0` encoding and publishes its incompatible implementation as `2.0.0` under explicit v2 function, schema, and type names. Unknown versions return `UNSUPPORTED_VERSION`; unknown properties and enum values are rejected. The shared proposal's `exact_semver` policy is also strict: unknown fields reject, and an optional-field addition requires a new exact schema version with old-version encoding and fixtures retained. Packed tests validate the pricing v1/v2 migration; older compatibility for other APIs remains unverified.

Errors use a bounded safe message and a newly generated opaque `diagnostic_ref`. Caller request IDs are not copied into diagnostic references. Codes are `VALIDATION_ERROR`, `UNSUPPORTED_VERSION`, `FORBIDDEN_SCOPE`, `IDEMPOTENCY_CONFLICT`, `PRICING_UNKNOWN`, `BUDGET_EXCEEDED`, `BUDGET_UNAVAILABLE`, `RECONCILIATION_PENDING`, and `SOURCE_UNAVAILABLE`. A retryable error does not authorize spending or dispatch; a caller must obtain a new explicit authorization decision.

Money and quantities are decimal strings. Finance-owned amount schemas permit up to 18 fractional digits and never use binary floating point. Economic `billingMode` values map to shared snake-case `billing_mode` values `live`, `sandbox`, and `simulated`; funding mechanisms such as subscription, included allowance, and credits are not billing modes. `environment` maps to the shared `environment` field and is restricted to `development`, `test`, or `production`.

Finance API request/response objects use camel case. Nested shared contracts retain their generated canonical snake-case field names and are validated using the exact installed proposal package. These wrappers are versioned finance API proposals; their existence does not resolve producer/consumer ownership or make the shared draft canonical.

## Scope and boundary coverage

`TrustedScope` binds tenant, project, environment, billing mode, and actor. The current query boundary limits environment and billing-mode filters to the exact scope authorized for the operation; callers cannot widen scope by adding filter values. `TrustedContextPort` supplies no permission by itself.

The usage observation wrapper contains the shared `UsageEvent` plus evidence mode, verification status, and source provenance. The generated event preserves logical-operation, transport-attempt, provider request/attempt, billable-attempt, and source-observation identities. Unknown completeness stays explicit, with `usage_units: null`; it is never converted to zero. An unknown financial-event valuation likewise requires `amount: null`; estimated or provider-confirmed valuation requires an exact decimal amount.

Budget wrappers express authorized, denied, partial, and unavailable outcomes, held and available amounts, estimate completeness/subtotal, a bounded conservative authorization amount, rate-card and policy references, attempt binding, expiry eligibility, and explicit partial-consent/replan requirements. Lifecycle commands distinguish dispatch, cumulative partial/final settlement, and release proof. Settlement carries observed-overrun evidence without rewriting the original hold. Expense adjustments link to an original posting and content-hashed source evidence. The budget policy decision recorded for this boundary rejects a limit reduction below effective consumed spend plus active unconsumed commitments, preserves the existing limit when denied, and emits the near-limit alert at 80% committed. Execution behavior remains unavailable.

The financial ledger API is documented in [ledger.md](./ledger.md). It persists immutable versioned events, binds operational identities independently, records corrections and reversals by reference, and rebuilds deterministic as-of projections with exact decimal arithmetic. Reservation authorization remains a non-financial memo; linked cumulative consumption contributes its full effective amount, including an observed overrun.

The pricing implementation and host-authority boundary are documented in [pricing.md](./pricing.md). The shared operation matrix, least-privilege rules, safe field projection, and current host integration gaps are documented in [security.md](./security.md). The real issuer adapter remains pending; current operation decisions and evidence resolvers are host-injected ports exercised with synthetic fixtures.
The pricing implementation and host-authority boundary are documented in [pricing.md](./pricing.md). The manual CFO.ai input mapping and handoff for exports (CI-08X.4) is documented in [cfo-ai-handoff.md](./cfo-ai-handoff.md). Its real issuer adapter remains pending; current operation decisions and evidence resolvers are host-injected ports exercised with synthetic fixtures.

## Summary and export identity

The pinned shared `FinancialSummary` has no query-level as-of, watermark, timezone, or stable snapshot identity. The finance-owned `FinancialSummaryPage` wrapper adds:

- `snapshotId`, query hash, and the effective `asOf` instant;
- timezone and echoed query filters;
- a watermark identity and per-source revision, observed-through time, content hash, and completeness;
- summary content hash and the nested canonical `FinancialSummary`;
- a continuation cursor bound to the snapshot.

Filters are proposed for environments, billing modes, currency, repository, workstream, provider, model, workflow, job, feature category, and scoped order/customer references. This is a finance-owned #6.2 interface proposal pending the #2 capability handoff and consumer review. It does not redefine the shared summary. Export requests carry the same snapshot wrapper so future exports can be reproduced and audited. No CFO.ai connector is included.

## Schema artifacts and proposal pin

`npm run build` generates the local TypeBox schemas under their exact versions and records their SHA-256 digests in `docs/api/schema-index.json`. Non-pricing schemas remain under `schemas/cost-intelligence/1.0.0/`; pricing v1 and v2 are generated under their respective `1.0.0` and `2.0.0` directories. The build records shared-contract adoption state from `contracts.lock.json`. Schemas whose JSON artifact contains an unconstrained nested canonical value are marked `partial_wrapper_requires_combined_validation` in both the schema (`x-schema-completeness`) and catalog. Consumers must use the named, exported combined validator from the corresponding ESM subpath; it validates the wrapper and the exact pinned shared-contract schema together. The paired validator names are recorded in `x-combined-validator` and `combined_validator`. This applies to usage observations, pricing estimates, reservation requests and commands, reservation snapshots, summary pages, and export requests. The finance package does not copy or redefine the producer's canonical nested schemas.

The checked-in archive under `vendor/` is exactly pinned by SHA-256 and installed as a real package dependency. Tests verify the installed version, archive digest, selected schema/fixture digests, Git blob IDs, and producer fixtures. The pin remains proposal-only with unresolved finance findings:

- FC-001: final observed budget overrun cannot be represented without rejection or rewriting the hold;
- FC-002: environment and billing mode are not bound across independent context, commands, and results;
- FC-003: settlement/grant results are not bound to commands and cumulative/partial semantics remain unresolved;
- FC-004: `held_for_reconciliation` is rejected in the uncertain state it is meant to express.

Finance-owned wrappers preserve the needed boundary information while those producer fixes and consumer acknowledgements remain pending. They are not alternate canonical shared schemas.

Reporting now executes through the authoritative scoped PostgreSQL reader for
representable legacy pages and the explicit Finance-owned 2.0.0 supplemental
wrapper. See [reporting.md](./reporting.md) for source coverage, exact-money
semantics, current authority, pagination and query-to-export composition. The
production host and consumer owner acknowledgements remain pending.
