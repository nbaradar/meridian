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

4. **Check.** Run `pnpm format:check` and `pnpm test`, which includes the documentation checks.
5. **Approval.** The plan stays **Draft** until the owner explicitly approves it; never mark it Approved on your own judgment.
   - If Open questions is not empty, list the questions, keep it Draft, and stop here.
   - Otherwise, give a short review summary: goal, scope, non-goals, the key decisions already made, acceptance criteria, and any "Stop and ask if" conditions. Then ask the owner to choose (use AskUserQuestion when available): **Approve**, **Revise** (say what to change), or **Keep as Draft**.
   - **Approve:** set `Status: Approved` and the `Approved:` date in the plan, update its row in `docs/plans/README.md` and the Plans section of `docs/status.md`, and run `pnpm test` again.
   - **Revise:** make the changes, then ask again.
6. **Report.** Give the plan path and its status. If Approved, tell the owner the next step: `/implement-plan NNNN`, ideally in a fresh session so the plan alone carries the context. Offer to commit the plan.
