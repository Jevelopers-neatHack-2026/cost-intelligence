# `cost-intelligence`

**Repository status:** Verified existing on GitHub, public, October 10, 2026.
**Proposed owner:** Finance and reliability.
**Delivery state:** Foundation implementation candidate is under review; financial domain acceptance remains planned until evidence is recorded.

## Responsibility

Own the authoritative financial ledger, usage costing, metered client, budget protocol, reconciliation, and CFO.ai financial export. Distinguish revenue, expenses, cash movements, budget reservations, promotional credits, and forecast assumptions.

Retain immutable records with correction or adjustment entries. Preserve source currency and pricing assumptions. Unknown usage is a data-quality condition, never an automatic zero. Attribute development and customer operations separately while reconciling them to provider totals.

## Planned internal modules

- `src/metering/`: Provider-neutral client and usage observations.
- `src/pricing/`: Versioned rate cards and estimation rules.
- `src/budgets/`: Atomic reservations, settlement, release, and enforcement.
- `src/ledger/`: Revenue, expenses, cash movements, and adjustments.
- `src/integrations/`: Model billing, available Entire development usage, Neatlogs evidence links, payment records, and supplier inputs.
- `src/reconciliation/`: Matching, variance review, and source status.
- `src/reporting/`: Financial summaries and CFO.ai export packages.

## Dependencies and handoff

Consume shared contracts and usage from specialist modules. Deduplicate repeated observations of an attempt while retaining separately billed retry attempts. Reconcile request estimates with provider charges without counting both as independent expenses. Supply authoritative summaries to `team-dashboard` and permission-checked financial commands through the application boundary.

## P0 demo slice

Meter one design journey, enforce concurrent-safe reservations, record labeled sandbox commerce, and produce a reconcilable summary. Export documented CFO.ai inputs; a direct connector is optional.

## Acceptance boundary

- [ ] Billable attempts have stable identities and visible usage completeness.
- [ ] Concurrent reservations respect the applicable budget limit.
- [ ] Estimates, confirmed charges, credits, and cash remain distinguishable.
- [ ] Duplicate observations do not inflate spending.
- [ ] Adjustments preserve audit history and source references.
- [ ] Summary totals trace to ledger entries and reconciliation status.

[Architecture](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/blob/main/docs/architecture-kit/v1.0/docs/architecture.md) · [Acceptance checklist](https://github.com/Jevelopers-neatHack-2026/integration-evals/blob/main/planning/acceptance-checklist.md).

## Acceptance and contributor handoff

Use the [repository acceptance view](ACCEPTANCE.md) and [central implementation plan](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/blob/main/docs/planning/implementation-plan.md). Interfaces are specified in the [maintained contract catalog](https://github.com/Jevelopers-neatHack-2026/shared-contracts/blob/main/docs/contract-catalog.md). Preserve local contributor and agent instructions; follow the [organization contribution guidance](https://github.com/Jevelopers-neatHack-2026/.github/blob/main/CONTRIBUTING.md). Named owner and reviewer assignments remain kickoff decisions.
