---
summary: Current state, agreed priorities, and which implementation plan is active or next
read_when: Starting any task, deciding what to build next, or finishing a unit of work
---

# Status

Replace, don't append; finished detail goes to [history.md](history.md) as a short dated entry.

## Current state (2026-09-25)

- **Usable:** net worth at `/` with each account's current balance, date, source, and age, plus manual record, correct, and retract; manual account/category creation at `/setup`; YNAB export analysis, saving YNAB account decisions (create, link, renamed, exclude), and saving YNAB export balances at `/ynab`.
- **Schema:** 15 migrations; 16 append-only `ledger.*` tables and 6 current views; 6 `ops.*` tables.
- **Last verified:** 182 unit tests, 119 PostgreSQL integration tests.
- **Repository:** public; owner-specific facts live in the gitignored `local/` directory ([security and keys](architecture/security-and-keys.md#where-secrets-and-personal-data-live)).
- **Not built:** transaction import or any transaction write, cross-source matching, the Inbox (designed in RFC 0009), reviewed provider balance policies, live connectors, institution grouping, backups.

## Agreed priority (2026-09-27)

**Direction:** transactions are imported from YNAB and live connectors at any time, in any order, with cross-source duplicates resolved by conservative matching and review ([RFC 0008](decisions/0008-cross-source-transaction-matching.md), accepted 2026-09-27, superseding RFC 0004). Judgment calls on individual cases go to an Inbox, a running task list the system adds to and the owner can add their own tasks to. Providers are free-first ([RFC 0007](decisions/0007-free-first-provider-selection.md)): Teller, then Plaid Trial for gaps, official institution APIs, and manual file import, with SimpleFIN as the paid backstop.

1. ~~RFC 0005: YNAB account persistence~~ — done 2026-09-25.
2. ~~RFC 0006 balance observations and the net-worth dashboard~~ — done 2026-09-25 ([Plan 0002](plans/0002-balance-observations-and-net-worth.md)).
3. ~~RFC 0004 rollout unit two~~ — done 2026-09-25 ([Plan 0001](plans/0001-rfc-0004-authority-and-reconciliation.md)); its code and tables were removed 2026-09-27 (migration `0014`).
4. ~~RFC 0008: cross-source transaction matching~~ — accepted 2026-09-27 ([RFC 0008](decisions/0008-cross-source-transaction-matching.md)): D = 5 days with a 10-day review band, pending rows not counted, reclassification for category changes, connector date wins.
5. ~~RFC 0009: the Inbox~~ — accepted 2026-09-27 ([RFC 0009](decisions/0009-inbox.md)): computed system items with `review`, `decision`, `action`, and `info` severities, owner tasks, snooze (and dismiss for routine items), and a new mutable `app.*` workspace schema. The Inbox never decides or acts.
6. **Plans:** Inbox v1 next (owner tasks, the balance items, snooze and dismiss, `/inbox`, and the count); then the observations schema and matching engine; then YNAB transaction import through the matching engine. Then the live connector feed, then the account details store ([expansion](future/expansion.md#deferred-feature-user-entered-account-details)).
7. **Later, Phase 3:** goals as capital buckets and a deterministic policy engine whose findings reach the Inbox as decisions ([capital policies](future/capital-policies.md)); needs categorized spending and positions first.

## Plans ([index](plans/README.md))

- **In progress:** none.
- **Next to implement:** none approved. Plan Inbox v1 (step 6) with `/plan-unit`.
- **Last done:** [Plan 0001](plans/0001-rfc-0004-authority-and-reconciliation.md), RFC 0004 authority windows and reconciliation checks; before it, [Plan 0002](plans/0002-balance-observations-and-net-worth.md).
