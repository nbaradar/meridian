---
summary: Current state, agreed priorities, and which implementation plan is active or next
read_when: Starting any task, deciding what to build next, or finishing a unit of work
---

# Status

Replace, don't append; finished detail goes to [history.md](history.md) as a short dated entry.

## Current state (2026-09-25)

- **Usable:** net worth at `/` with each account's current balance, date, source, and age, plus manual record, correct, and retract; manual account/category creation at `/setup`; YNAB export analysis, saving YNAB account decisions (create, link, renamed, exclude), and saving YNAB export balances at `/ynab`.
- **Schema:** 13 migrations; 16 append-only `ledger.*` tables and 6 current views; 6 `ops.*` tables.
- **Last verified:** 182 unit tests, 118 PostgreSQL integration tests.
- **Repository:** public; owner-specific facts live in the gitignored `local/` directory ([security and keys](architecture/security-and-keys.md#where-secrets-and-personal-data-live)).
- **Not built:** transaction import or any transaction write, reconciliation, live connectors, institution grouping, backups.
- **Known problem:** saving a new YNAB account can fail when the host clock is ahead of the Docker database clock ([README troubleshooting](../README.md#troubleshooting)); a follow-up from Plan 0002.

## Agreed priority (2026-09-25)

1. ~~RFC 0005: YNAB account persistence~~ — done 2026-09-25.
2. ~~RFC 0006 balance observations and the net-worth dashboard~~ — done 2026-09-25 ([Plan 0002](plans/0002-balance-observations-and-net-worth.md)).
3. **RFC 0004 rollout unit two**, [Plan 0001](plans/0001-rfc-0004-authority-and-reconciliation.md). Later RFC 0004 units follow the account details store.
4. **Account details store** ([expansion](future/expansion.md#deferred-feature-user-entered-account-details)): institution name (plaintext, for grouping) and encrypted account/routing numbers. Until then the dashboard groups by account type.

## Plans ([index](plans/README.md))

- **In progress:** none.
- **Next to implement:** [Plan 0001](plans/0001-rfc-0004-authority-and-reconciliation.md), RFC 0004 unit two (step 3). Approved 2026-09-25.
- **Last done:** [Plan 0002](plans/0002-balance-observations-and-net-worth.md), balance observations and the net-worth dashboard.
