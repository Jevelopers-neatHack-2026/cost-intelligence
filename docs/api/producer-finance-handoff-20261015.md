# Finance owner handoff for the older-issue campaign

This is a source/interface decision for review, not consumer acceptance or a
release trigger. References: Finance #6–#18, event-intelligence #4/#13,
agent-harness #5/#14, creative-engine #37. Baseline Finance source:
`2d8ab3aa787a34e1005a6e2398ddbbcdd905c2e4`.

## Implemented callback boundary

Use the public package root or `/budgets`, `/metering`, `/pricing` subpaths.
The source contracts and exact request/result validators are exported; a host
must not import private modules or translate names by guesswork.

| Consumer action | Finance operation / contract | Required mapping |
| --- | --- | --- |
| Acquire monetary capacity before dispatch | `authorize`, ReservationRequest/1.0.0, `ci-reservation-authority-1.0.0` | Genuine logical/billable/transport/provider attempt identities; independently authenticated five-field scope, target, grant, source maximum and policy. |
| Prepare dispatch / acknowledge transport | `revalidateAuthorization`, CurrentReservationRequest/1.0.0 | Original reservation and exact attempt; explicit preparation/post_transport_ack phase and genuine durable transport acknowledgement. Current permission and issuer are rechecked. |
| Accept smaller plan | `acknowledgePartial`, PartialAcknowledgementRequest/1.0.0 | Source-authenticated revised plan/digest; never dispatch the original larger plan after a partial hold. |
| Record dispatch intent | `markDispatched`, MarkDispatchedCommand/1.0.0 | Original attempt, durable dispatch intent and worker lease; call before paid work. Lease expiry is not financial finality. |
| Deliver observation | `ingestUsage`, UsageObservation/1.0.0 → IngestionReceipt/1.0.0 | Nested exact UsageEvent/1.0.0; evidence/verification modes separate. Stable observation identity on redelivery; separate identity for genuine new billed execution. |
| Recover Finance posting | `replayUsageOutbox`, UsageOutboxReplayRequest/1.0.0 | Bounded rerunnable Finance outbox recovery; does not redispatch provider work. Producer outbox/trace transport remains producer/Harness-owned. |
| Price observed usage | `estimateV2`, EstimateRequest/2.0.0 | Exact scoped versioned rate/rule source, units/model/provider and effective time; incomplete usage retains partial/unknown. An estimate grants no spending authority. |

See [budget authority](budget-authority.md), [usage intake](usage-intake.md) and
[pricing](pricing.md) for full fields and host ports. Unavailable, denied, stale,
partial and ambiguous commit results do not authorize dispatch. Retry an ambiguous
reservation with the same economic idempotency key, never a fresh spending key.

## Exact shared interface election

Finance currently elects UsageEvent/1.0.0 from shared-contracts/0.3.0,
source `24eae28e3ae646c10bf26e483d9009e00381e6ec`, archive SHA-256
`29032c3caae8f5d45a9665ef2263e7014e429b94d4b4267d36826c0790de88f2`.
It remains proposal-only. Shared 0.10.1 archive
`7ba851fb9498ee0bf92c41307a5bc9651c70a4d2917556ff4648676350d60a15`
has separately recorded compatibility-only receipts in shared-contracts #12;
those receipts do not adopt its decoder in Finance. The later 0.10.2 diagnostic
source `cd961246234f8666303f306ac349c69b8b3236cd` is also not adopted.

Agent-harness's actual caller at
`0cddf81923ef80f4231023f9b0a973bcf540e2b3` declares protocol `1.0`, and
`creative.metering.proposal/v1` has no canonical MeteredAttempt mapping in the
inspected SDK (Harness #5 comment6132549113). Do not relabel it UsageEvent or
silently rewrite the protocol version. Harness and Finance must review an
explicit callback adapter against the schemas above and exact caller fixtures.

Finance's consumer decision for proposed local execution is: retain genuine
source/logical/local-execution identities and semantic observation timestamps;
transport attempts belong to a separate delivery envelope; no absent
provider/billable/model/retry identity or ingestion timestamp is fabricated.
Historical private scope hashes and local/unclassified modes remain unresolved.
New observations need independently resolved host scope and explicit financial
modes. This agrees with shared-contracts #11's proposed v2 separation, **not**
with representing those rows through today's v1 decoder. Shared-contracts owns
the versioned event/delivery schema; Finance still needs an explicit decoder,
receipt/persistence migration and conformance before accepting local rows.

## Held settlement and reported cost

The native USD18 settlement proposal is in Finance #13 comment6123342871.
The Finance collector extension is `finance_collector_v1`,
`ci-budget-reported-cost-1.0.0`, source proposal at
`085e45f4405167bb4a5dda0dff66bd75d0f23c85` (comment6126611139).
It uses independently authenticated attempt-specific cumulative cost and separate
execution finality; aggregate key totals never manufacture per-attempt cost.
PR59 head `50e81e43518ca095c7657e334fa983869320b892` composes the held proposal.
It is not approved/released: expiry/final-await repair, complete money review,
reported-cost PostgreSQL query/export chain and strict consumer ACK remain.
Main public settle/release are unavailable. Consumers must retain unknown holds.

[Reported-unsettled reporting](reported-unsettled-reporting.md) implements the
separately named projection proposal for review. No hold is released by that
projection. No numeric provider tariff or live entitlement is approved here.

## Required owner returns

- Event-intelligence #4/#13 and Harness #5/#14: exact caller source/tree,
  sanitized actual observation and delivery records, field-ownership table,
  authentic identity/scope resolver and direct/trace retry equivalence. Execute
  full/partial/denied/unavailable/stale, distinct-billed-retry, post-dispatch
  timeout and durable duplicate-delivery fixtures against the exact Finance pin.
- Shared-contracts #11/#12/#13: immutable reviewed event/delivery/receipt and
  financial interfaces, explicit version election and consumer upgrade rows.
- Product/runtime and Finance: accepted current issuer/grant/source adapters,
  exact tenant/project/actor/environment/billing bindings and permission policy.
- Creative-engine #37: preserve real null generation IDs and unknown outcome;
  review native USD18 and collector proposals without treating them as shipped.
- Dashboard: strict adaptation and exact ACK for the reported-unsettled native
  detail/bucket/export proposal; historical packet ACKs remain scoped.

No foreign source, contract, issue state or acceptance was changed. No live
provider request or spending occurred. Integration-evals owns master acceptance.
