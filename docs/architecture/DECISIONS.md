# Foundation decisions and unresolved handoffs

These decisions describe the foundation boundary and test policy. They do not claim that a financial domain leaf has shipped.

## Typed boundary policy

- **API schema:** finance-owned requests use exact `1.0.0`, reject unknown fields and enums, and return bounded safe errors with opaque diagnostic references.
- **Economics:** decimal strings support up to 18 fractional digits. `billingMode` means economic execution (`live`, `sandbox`, `simulated`); funding state is modeled separately.
- **Unknown usage:** unknown completeness uses explicit `null` measurements and missing-field evidence. Unknown is not numeric zero.
- **Authorization:** partial grants require explicit caller consent and a caller replan before dispatch. Uncertain outcomes retain the hold until fenced non-dispatch proof or final usage evidence resolves it.
- **Budget limit changes:** reject decreases below effective consumed spend plus active unconsumed commitments and preserve the previous effective limit on denial. Mark the near-limit condition at 80% committed.
- **Corrections:** expense adjustments link to the original posting and a content-hashed source; existing postings are not overwritten.
- **Reproducible queries:** a finance-owned snapshot wrapper records filters, timezone, as-of time, snapshot identity, query and summary hashes, and per-source watermarks. The shared proposal summary remains unchanged.

## External contract handoff

The pinned shared-contract package is a proposal test dependency, not an accepted release. Its FC-001 through FC-004 blockers and pending finance acknowledgement are recorded in [`contracts.lock.json`](../../contracts.lock.json) and [compatibility notes](../api/compatibility.md). Finance wrappers are local, versioned API proposals and must be reviewed with the producer and consuming applications before adoption.

The public query filters for repository, workstream, provider, model, workflow, job, feature category, and permitted order/customer IDs require the #2 capability contract and consumer handoff. Query math, filtering, exports, and access policy are not implemented. Current scope binds each request to one authenticated environment and billing mode.

## Delivery gates

The foundation package, local schemas, migration tracking, and offline boundary checks are present. All financial domain operations still return typed unavailable results. Integration and release runners require nonempty tests for the accounting, adapters, budgets, ledger, metering, pricing, reconciliation, reporting, and recovery leaves; until those tests and leaves land, their negative manifests must report `blocked` and the commands must exit nonzero.
