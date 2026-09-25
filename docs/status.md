---
summary: Current state, agreed priorities, and which implementation plan is active or next
read_when: Starting any task, deciding what to build next, or finishing a unit of work
---

# Status

Replace, don't append; finished detail goes to [history.md](history.md) as a short dated entry.

## Current state (2026-09-25)

- **Usable:** manual account/category creation (`/`); YNAB export analysis with per-account evidence, and saving YNAB account decisions (create, link, renamed, exclude) at `/ynab`.
- **Schema:** 12 migrations; 14 append-only `ledger.*` tables and 5 current views; 6 `ops.*` tables.
- **Last verified:** 154 unit tests, 106 PostgreSQL integration tests.
- **Repository:** public; owner-specific facts live in the gitignored `local/` directory ([security and keys](architecture/security-and-keys.md#where-secrets-and-personal-data-live)).
- **Not built:** balances and net worth, transaction import or any monetary write, live connectors, backups.

## Agreed priority (2026-09-25)

Net worth before transaction authority: balances are observations separate from transactions ([overview](architecture/overview.md#balances-are-observations-not-state)), so the dashboard need not wait for RFC 0004.

1. ~~RFC 0005: YNAB account persistence~~ — done 2026-09-25 ([history](history.md)).
2. **Balance observations RFC, then the net-worth dashboard.** Latest balance per canonical account from manual entry, the YNAB export's working balance, and later SimpleFIN. Adds to core `ledger.*`, so needs review.
3. **Account details store** ([expansion](future/expansion.md#deferred-feature-user-entered-account-details)): institution name (plaintext, for grouping) and encrypted account/routing numbers. Until then the dashboard groups by account type.
4. **RFC 0004 rollout unit two onward**, starting with [Plan 0001](plans/0001-rfc-0004-authority-and-reconciliation.md).

## Plans ([index](plans/README.md))

- **In progress:** none.
- **Next to implement:** [Plan 0002](plans/0002-balance-observations-and-net-worth.md), balance observations and the net-worth dashboard (step 2), implementing the accepted [RFC 0006](decisions/0006-balance-observations.md). Approved 2026-09-25.
- **Draft:** [Plan 0001](plans/0001-rfc-0004-authority-and-reconciliation.md), RFC 0004 unit two (step 4), with the original handoff text.
