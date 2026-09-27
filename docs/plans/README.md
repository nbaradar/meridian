---
summary: Index of implementation plans with status, plus the plan lifecycle and conventions
read_when: Designing the next unit of work, starting an approved plan, or checking what is in progress
---

# Implementation plans

A plan is one unit of work an agent can carry out without further guidance. RFCs ([decisions](../decisions/README.md)) record _why_ a boundary exists; plans record _how_ a unit is built and proven done.

| Plan                                                         | Status | Unit                                                                                  |
| ------------------------------------------------------------ | ------ | ------------------------------------------------------------------------------------- |
| [0001](0001-rfc-0004-authority-and-reconciliation.md)        | Done   | RFC 0004 rollout unit two: authority windows and reconciliation checks, no processing |
| [0002](0002-balance-observations-and-net-worth.md)           | Done   | RFC 0006 balance observations, manual and YNAB balance entry, net-worth home page     |
| [0003](0003-inbox-v1.md)                                     | Draft  | RFC 0009 Inbox v1: owner tasks, balance items, snooze and dismiss, `/inbox`           |
| [0004](0004-processing-and-matching-engine.md)               | Draft  | Processing revisions and matching engine                                              |
| [0005](0005-ynab-transaction-import-after-0004.md)           | Draft  | YNAB transaction import (after 0004)                                                  |
| [0006](0006-review-queue-and-inbox-items-after-0003-0005.md) | Draft  | Review queue and Inbox items (after 0003 and 0005)                                    |
| [0007](0007-sync-worker-and-ingestion-after-0004.md)         | Draft  | Sync worker and ingestion orchestrator (after 0004)                                   |
| [0008](0008-teller-connector-after-0007.md)                  | Draft  | Teller connector (after 0007)                                                         |
| [0009](0009-plaid-gap-connector-after-0007.md)               | Draft  | Plaid gap connector (after 0007)                                                      |
| [0010](0010-file-import-csv-ofx-after-0004.md)               | Draft  | Manual file import, CSV and OFX (after 0004)                                          |
| [0011](0011-account-details-store.md)                        | Draft  | Account details store                                                                 |
| [0012](0012-encrypted-backups.md)                            | Draft  | Encrypted backups and a tested restore                                                |

## Lifecycle

- **Draft:** designing with the owner; open questions allowed.
- **Approved:** owner accepted and **Open questions** is empty. Only Approved plans are implemented.
- **In progress:** being implemented. At most one at a time, linked from [status.md](../status.md).
- **Done:** acceptance criteria checked, the `AGENTS.md` Definition of Done complete, Completion record filled in. Never rewritten afterward; follow-ups get a new plan.
- **Superseded:** replaced by the plan named in its header.

## Conventions

- Copy [TEMPLATE.md](TEMPLATE.md) to `NNNN-short-title.md` (next number) and add a row above.
- Changing a core `ledger.*` boundary needs an accepted RFC first, listed under Related RFCs.
- One cohesive, reviewable unit per plan: split work spanning more than one migration concern or user-visible feature.
