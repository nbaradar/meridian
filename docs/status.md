---
summary: Current state, agreed priorities, and which implementation plan is active or next
read_when: Starting any task, deciding what to build next, or finishing a unit of work
---

# Status

Replace, don't append; finished detail goes to [history.md](history.md) as a short dated entry.

## Current state (2026-09-25)

- **Usable:** net worth at `/` with each account's current balance, date, source, and age, plus manual record, correct, and retract; manual account/category creation at `/setup`; YNAB export analysis, saving YNAB account decisions (create, link, renamed, exclude), and saving YNAB export balances at `/ynab`.
- **Retiring:** Plan 0001's transaction-authority windows and reconciliation checks (core and schema only, unused). RFC 0008 superseded their design; its first plan drops them.
- **Schema:** 14 migrations; 18 append-only `ledger.*` tables and 7 current views; 6 `ops.*` tables.
- **Last verified:** 197 unit tests, 128 PostgreSQL integration tests.
- **Repository:** public; owner-specific facts live in the gitignored `local/` directory ([security and keys](architecture/security-and-keys.md#where-secrets-and-personal-data-live)).
- **Not built:** transaction import or any transaction write, cross-source matching, the Inbox, reviewed provider balance policies, live connectors, institution grouping, backups.
- **Known problem:** saving a new YNAB account can fail when the host clock is ahead of the Docker database clock ([README troubleshooting](../README.md#troubleshooting)); a follow-up from Plan 0002.

## Agreed priority (2026-09-27)

**Direction:** transactions are imported from YNAB and live connectors at any time, in any order, with cross-source duplicates resolved by conservative matching and review ([RFC 0008](decisions/0008-cross-source-transaction-matching.md), accepted 2026-09-27, superseding RFC 0004). Judgment calls on individual cases go to an Inbox, a running task list the system adds to and the owner can add their own tasks to. Providers are free-first ([RFC 0007](decisions/0007-free-first-provider-selection.md)): Teller, then Plaid Trial for gaps, official institution APIs, and manual file import, with SimpleFIN as the paid backstop.

1. ~~RFC 0005: YNAB account persistence~~ — done 2026-09-25.
2. ~~RFC 0006 balance observations and the net-worth dashboard~~ — done 2026-09-25 ([Plan 0002](plans/0002-balance-observations-and-net-worth.md)).
3. ~~RFC 0004 rollout unit two~~ — done 2026-09-25 ([Plan 0001](plans/0001-rfc-0004-authority-and-reconciliation.md)); its tables are to be retired under RFC 0008.
4. ~~RFC 0008: cross-source transaction matching~~ — accepted 2026-09-27 ([RFC 0008](decisions/0008-cross-source-transaction-matching.md)): D = 5 days with a 10-day review band, pending rows not counted, reclassification for category changes, connector date wins.
5. **RFC 0009: the Inbox** (to draft). System-computed and stored tasks, owner-created tasks, how modules contribute tasks, and where its tables live (not `ledger.*`).
6. **Plans, each after its RFC is accepted:** Inbox v1 (owner tasks and balance-related system tasks); observations schema and matching engine (retiring the authority and reconciliation-check tables); YNAB transaction import through the matching engine. Then the live connector feed, then the account details store ([expansion](future/expansion.md#deferred-feature-user-entered-account-details)).

## Plans ([index](plans/README.md))

- **In progress:** none.
- **Next to implement:** none approved. Draft RFC 0009, the Inbox (step 5), then plan Inbox v1 with `/plan-unit`.
- **Last done:** [Plan 0001](plans/0001-rfc-0004-authority-and-reconciliation.md), RFC 0004 authority windows and reconciliation checks; before it, [Plan 0002](plans/0002-balance-observations-and-net-worth.md).
