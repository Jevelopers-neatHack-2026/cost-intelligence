# Reporting fixtures with database-stamped writes

Refs #18; related diagnostic on PR #62. This is a test-fixture repair, not a
change to monetary semantics, historical reporting, authorization, or release
acceptance.

## Two clocks in the retained failure

`tests/reporting/reporting.test.mjs` intentionally uses October 12, 2026 at
22:00 UTC, later advanced to 22:00:01, for deterministic ledger events, signed
host fixtures, historical snapshots, and replay. Those fixtures remain fixed.

Budget policies and reservation events use the database `recorded_at DEFAULT
now()` from `migrations/0008_budget_reservations.sql`. Usage intake uses
`created_at DEFAULT now()` from `migrations/0009_usage_intake.sql`. The reporting
reader correctly requires these timestamps to be at or before the requested
`asOf`. Its application-clock port does not backdate these database rows.

A later-date execution can therefore write a policy, hold, or usage observation
successfully and then exclude it from a report frozen before that write. The
retained [PR62 run](https://github.com/Jevelopers-neatHack-2026/cost-intelligence/actions/runs/38348036860)
reported three failing scenarios plus their parent: absent budget row,
unposted-usage count zero instead of one, and capacity null instead of `9`.
The [original diagnostic](https://github.com/Jevelopers-neatHack-2026/cost-intelligence/pull/62#issuecomment-6138568326)
and failed artifact remain historical failed evidence, not a successful run.

## Fixture correction

Only the budget/competing-hold, unposted-usage, and cash/capacity scenarios use
`databaseSnapshotClock` after their writes have completed. They create separate
reporting ports from this sampled clock; they do not modify the shared clock,
existing authority fixtures, database rows, migrations, or production reader.

The helper reads `clock_timestamp()` from the disposable database and rounds
up to milliseconds in SQL. Truncating the returned timestamp in JavaScript
could exclude a just-completed write with sub-millisecond precision. The result
is the later of that observation and the supplied fixture instant, so existing
ledger events are not moved outside the snapshot. Rounding adds less than one
millisecond when the observation is not already millisecond-aligned; it is not
a future-year placeholder or a substitute for current production time authority.

Sampling occurs once, after the relevant writes. The returned fixture clock is
immutable and remains fixed for the report and its continuation pages. It does
not include arbitrary future or concurrent writes, change a reporting period,
remove the `asOf` predicate, or silently turn missing evidence into zero. A
missing, malformed, or unavailable database observation fails the fixture;
there is no fallback to the runner's local wall clock.

All original scenario registrations and assertion expressions remain intact.
The new helper's 25 unit cases are imported by the existing required reporting
test file, following its existing imported-test pattern. The suite-selection
policy, required-file inventory, and CI workflow are unchanged. The helper tests
can also run without PostgreSQL:

```sh
node --test tests/reporting/database-snapshot-clock.test.mjs
```

Those unit cases use synthetic query-port responses. They do not prove real SQL
execution or full reporting behavior. Native qualification remains:

```sh
npm ci
npm run test:reporting -- --offline
```

Use the existing complete foundation workflow for the current candidate and
record its exact checkout/run/attempt and retained evidence. A passing scoped
reporting run does not replace the remaining repository checks, independent
review, post-merge verification, or consumer/Finance acceptance. New run outputs
are new synthetic artifacts; no previously acknowledged packet is rewritten or
silently assigned a new hash.
