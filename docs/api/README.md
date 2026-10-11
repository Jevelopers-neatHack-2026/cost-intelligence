# API foundation

The public package exposes typed schemas and ESM functions for metering, pricing, budget authorization and lifecycle, accounting, reporting, reconciliation, and export. The current functions validate request shape and scope, then return typed unavailable errors. They do not persist transactions, authorize spend, calculate charges, or send data to external services.

## Version and error behavior

Every finance-owned request uses exact `schemaVersion: "1.0.0"`. Unknown versions return `UNSUPPORTED_VERSION`; unknown properties and enum values are rejected. The shared proposal's `exact_semver` policy is also strict: unknown fields reject, and an optional-field addition requires a new exact schema version with old-version encoding and fixtures retained. No prior accepted consumer version exists, so backward compatibility with a previously released cost-intelligence API has not been established.

Errors use a bounded safe message and a newly generated opaque `diagnostic_ref`. Caller request IDs are not copied into diagnostic references. Codes are `VALIDATION_ERROR`, `UNSUPPORTED_VERSION`, `FORBIDDEN_SCOPE`, `IDEMPOTENCY_CONFLICT`, `PRICING_UNKNOWN`, `BUDGET_EXCEEDED`, `BUDGET_UNAVAILABLE`, `RECONCILIATION_PENDING`, and `SOURCE_UNAVAILABLE`. A retryable error does not authorize spending or dispatch; a caller must obtain a new explicit authorization decision.

Money and quantities are decimal strings. Finance-owned amount schemas permit up to 18 fractional digits and never use binary floating point. Economic `billingMode` values map to shared snake-case `billing_mode` values `live`, `sandbox`, and `simulated`; funding mechanisms such as subscription, included allowance, and credits are not billing modes. `environment` maps to the shared `environment` field and is restricted to `development`, `test`, or `production`.

Finance API request/response objects use camel case. Nested shared contracts retain their generated canonical snake-case field names and are validated using the exact installed proposal package. These wrappers are versioned finance API proposals; their existence does not resolve producer/consumer ownership or make the shared draft canonical.

## Scope and boundary coverage

`TrustedScope` binds tenant, project, environment, billing mode, and actor. The current query boundary limits environment and billing-mode filters to that authenticated scope. A multi-environment or multi-mode query requires a future authorization grant model; callers cannot widen scope by adding filter values.

The usage observation wrapper contains the shared `UsageEvent` plus evidence mode, verification status, and source provenance. The generated event preserves logical-operation, transport-attempt, provider request/attempt, billable-attempt, and source-observation identities. Unknown completeness stays explicit, with `usage_units: null`; it is never converted to zero. An unknown financial-event valuation likewise requires `amount: null`; estimated or provider-confirmed valuation requires an exact decimal amount.

Budget wrappers express authorized, denied, partial, and unavailable outcomes, held and available amounts, estimate completeness/subtotal, a bounded conservative authorization amount, rate-card and policy references, attempt binding, expiry eligibility, and explicit partial-consent/replan requirements. Lifecycle commands distinguish dispatch, cumulative partial/final settlement, and release proof. Settlement carries observed-overrun evidence without rewriting the original hold. Expense adjustments link to an original posting and content-hashed source evidence. The budget policy decision recorded for this boundary rejects a limit reduction below effective consumed spend plus active unconsumed commitments, preserves the existing limit when denied, and emits the near-limit alert at 80% committed. Execution behavior remains unavailable.

## Summary and export identity

The pinned shared `FinancialSummary` has no query-level as-of, watermark, timezone, or stable snapshot identity. The finance-owned `FinancialSummaryPage` wrapper adds:

- `snapshotId`, query hash, and the effective `asOf` instant;
- timezone and echoed query filters;
- a watermark identity and per-source revision, observed-through time, content hash, and completeness;
- summary content hash and the nested canonical `FinancialSummary`;
- a continuation cursor bound to the snapshot.

Filters are proposed for environments, billing modes, currency, repository, workstream, provider, model, workflow, job, feature category, and scoped order/customer references. This is a finance-owned #6.2 interface proposal pending the #2 capability handoff and consumer review. It does not redefine the shared summary. Export requests carry the same snapshot wrapper so future exports can be reproduced and audited. No CFO.ai connector is included.

## Schema artifacts and proposal pin

`npm run build` generates the local TypeBox schemas in `schemas/cost-intelligence/1.0.0/` and their SHA-256 list in `docs/api/schema-index.json`. The build records shared-contract adoption state from `contracts.lock.json`. Schemas whose JSON artifact contains an unconstrained nested canonical value are marked `partial_wrapper_requires_combined_validation` in both the schema (`x-schema-completeness`) and catalog. Consumers must use the named, exported combined validator from the corresponding ESM subpath; it validates the wrapper and the exact pinned shared-contract schema together. The paired validator names are recorded in `x-combined-validator` and `combined_validator`. This applies to usage observations, estimates, reservation requests and commands, reservation snapshots, summary pages, and export requests. The finance package does not copy or redefine the producer's canonical nested schemas.

The checked-in archive under `vendor/` is exactly pinned by SHA-256 and installed as a real package dependency. Tests verify the installed version, archive digest, selected schema/fixture digests, Git blob IDs, and producer fixtures. The pin remains proposal-only with unresolved finance findings:

- FC-001: final observed budget overrun cannot be represented without rejection or rewriting the hold;
- FC-002: environment and billing mode are not bound across independent context, commands, and results;
- FC-003: settlement/grant results are not bound to commands and cumulative/partial semantics remain unresolved;
- FC-004: `held_for_reconciliation` is rejected in the uncertain state it is meant to express.

Finance-owned wrappers preserve the needed boundary information while those producer fixes and consumer acknowledgements remain pending. They are not alternate canonical shared schemas.
