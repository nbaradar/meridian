---
summary: Index of implementation plans with status, plus the plan lifecycle and conventions
read_when: Designing the next unit of work, starting an approved plan, or checking what is in progress
---

# Implementation plans

A plan is one unit of work an agent can carry out without further guidance. RFCs ([decisions](../decisions/README.md)) record _why_ a boundary exists; plans record _how_ a unit is built and proven done.

| Plan                                                  | Status   | Unit                                                                                  |
| ----------------------------------------------------- | -------- | ------------------------------------------------------------------------------------- |
| [0001](0001-rfc-0004-authority-and-reconciliation.md) | Approved | RFC 0004 rollout unit two: authority windows and reconciliation checks, no processing |
| [0002](0002-balance-observations-and-net-worth.md)    | Approved | RFC 0006 balance observations, manual and YNAB balance entry, net-worth home page     |

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
