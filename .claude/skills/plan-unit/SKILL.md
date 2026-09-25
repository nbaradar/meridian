---
name: plan-unit
description: Design the next Meridian unit of work with the owner and write it up as an implementation plan in docs/plans/. Use when the owner wants to plan, scope, or design a feature or the next piece of implementation, or turn a discussion into a plan.
---

# Plan a unit of work

Design with the owner; write no application code.

1. **Context.** Read `docs/status.md`, `docs/plans/README.md`, and `docs/plans/TEMPLATE.md`. Use the `AGENTS.md` routing table to open only the relevant docs, RFCs, and code.
2. **Design.** Summarize what exists and recommend the smallest cohesive unit toward the owner's goal (one recommendation, not a survey). Ask only questions whose answers change the plan. If the unit changes a core `ledger.*` table or another architectural boundary, draft an RFC in `docs/decisions/` as Proposed and get it accepted first.
3. **Write.** Copy the template to `docs/plans/NNNN-short-title.md` (next number) and fill every section:
   - **Decisions already made:** every settled choice, so the implementer never re-asks.
   - **Non-goals:** explicit; they are the implementer's hard boundary.
   - **Acceptance criteria:** checkable.
   - **Required reading:** specific docs and code, and what to look for.
   - **Documentation to update:** the specific docs this unit changes.

   Keep the front matter accurate, add a row to `docs/plans/README.md`, and update the Plans section of `docs/status.md`.

4. **Status.** Draft while questions remain. When the owner approves and Open questions is empty, set Approved with the date.
5. **Check.** Run `pnpm format:check` and `pnpm test`, which includes the documentation checks.
6. **Report.** Give the plan path, its status, and any open questions, and offer to commit.
