# Compatibility and contract adoption

## Current pin

The local package consumes the exact archive for `@jevelopers/shared-contracts@0.3.0`, proposal head `24eae28e3ae646c10bf26e483d9009e00381e6ec`, schema version `1.0.0`, archive SHA-256 `29032c3caae8f5d45a9665ef2263e7014e429b94d4b4267d36826c0790de88f2`.

**Adoption status: proposal only.** The draft has four finance-blocking findings (FC-001 through FC-004), no accepted finance consumer acknowledgement, and no producer handoff. `contracts.lock.json` records the chosen immutable proposal archive and hashes of 29 selected artifacts. Tests verify those bytes against the installed dependency. Do not describe this as an accepted release or as cross-repository conformance.

## Exact-version behavior

The candidate's policy uses exact semantic schema versions, rejects unknown fields and enums, and only permits an optional-field addition under a new exact schema version. Existing version encodings and fixtures are retained for consumers during any eventual migration. This package rejects every unsupported local version rather than silently accepting unknown minor or additive values. Because no previous cost-intelligence API release is accepted, older-consumer compatibility remains unverified.

## Finance handoff blockers

The candidate cannot currently express an observed final overrun without rejecting the amount or rewriting a held amount (FC-001). Its independent reservation context and result semantics do not bind environment and billing mode consistently (FC-002). Settlement and grant result economics do not agree with commands or resolve cumulative versus delta and partial authorization semantics (FC-003). The uncertain reservation state `held_for_reconciliation` is rejected where it is required (FC-004).

The finance API therefore wraps the proposal's generated schemas/types and rejects scope mismatches before an unavailable leaf result. Its typed wrappers carry overrun evidence, cumulative/partial/final settlement, partial authorization consent, unresolved holds, query snapshot metadata, and adjustment lineage. The wrappers support foundation compilation and boundary tests only; they do not patch, fork, or relabel the producer contract.

## Upgrade gate

Upgrade only after the producer publishes an immutable corrected artifact; finance verifies its source revision, package integrity, schema and fixture digests, and package behavior; all required consumer rows have exact pins, test results, and acknowledgements; and a fresh review accepts the cross-repository mapping. Keep this proposal archive, its hash, and current fixtures available as the rollback baseline. Do not replace the lock with an unreviewed merge candidate or mutable branch/tag.
