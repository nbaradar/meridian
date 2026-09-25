---
summary: Index of architecture decision records (RFCs) with status and conventions for writing new ones
read_when: Looking for the reasoning behind an implemented boundary, or writing a new RFC
---

# Decisions

Architecture decision records, written as RFCs. Each records the context, the decision, and its consequences at the time it was accepted.

| RFC                                              | Status                                        | Decides                                        |
| ------------------------------------------------ | --------------------------------------------- | ---------------------------------------------- |
| [0001](0001-phase-0-ledger-schema.md)            | Accepted, implemented                         | Minimum ledger schema and accounting semantics |
| [0002](0002-canonical-account-source-linkage.md) | Accepted, implemented; amended by 0005        | Account sources and link history               |
| [0003](0003-operational-live-connections.md)     | Accepted, foundation implemented              | Operational control plane for live connections |
| [0004](0004-transaction-source-authority.md)     | Accepted, rollout unit one of six implemented | Transaction source authority and YNAB cutover  |
| [0005](0005-ynab-account-persistence.md)         | Accepted, implemented                         | Saving and recognizing YNAB account decisions  |
| [0006](0006-balance-observations.md)             | Accepted                                      | Balance observations and net worth             |

## Conventions

- Number sequentially: `NNNN-short-title.md`. Start with `summary`/`read_when` front matter and add a row above.
- Header fields: Status (Proposed, Accepted, Superseded), dates, decision owners, and dependencies.
- An RFC marked Proposed needs the owner's acceptance before implementation.
- Once accepted, do not rewrite the decision. Record implementation status in the RFC, and put a changed decision in a new RFC that amends or supersedes the old one, noting that in both headers.
- A core `ledger.*` schema change always needs an accepted RFC.
