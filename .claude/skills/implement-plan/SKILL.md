---
name: implement-plan
description: Implement an Approved Meridian implementation plan from docs/plans/ end to end, then complete the Definition of Done in AGENTS.md. Use when the owner asks to implement, build, or run a plan, e.g. "/implement-plan 0002".
---

# Implement an approved plan

The argument is a plan number or path. If none is given, use the plan that `docs/status.md` names as in progress or next, and confirm it with the owner.

## 1. Check the plan is ready

- Open the plan. Proceed only if its status is **Approved** (or **In progress**, when resuming) and **Open questions** is empty. Otherwise, stop and tell the owner what is missing.
- Confirm no other plan is **In progress**, using the table in `docs/plans/README.md`.
- Set the plan's status to **In progress** in the plan and in `docs/plans/README.md`, and link it from the Plans section of `docs/status.md`.

## 2. Load context

- Read everything under **Required reading**, and the related RFCs.
- The plan's **Decisions already made** are settled: follow them without asking again.
- The plan's **Non-goals** are hard boundaries. If the work seems to need one, stop and ask.
- Stop and ask under the plan's **Stop and ask if** conditions and the "When to stop and ask" list in `AGENTS.md`. Otherwise keep going without checking in.

## 3. Implement

- Follow the plan's **Steps** in order, writing the listed tests alongside the code.
- Keep changes inside the plan's scope. Record anything worth doing that is outside scope as a follow-up for the Completion record, rather than doing it.
- If reality contradicts the plan (for example, an RFC rule cannot be enforced as written), stop and ask. Do not quietly change the design.

## 4. Verify

Run every command under the plan's **Verification** and fix failures. Check off each **Acceptance criteria** box only once it is proven by a test or a command you ran.

## 5. Finish

Complete every item of the **Definition of Done** in `AGENTS.md`:

- Update each document under **Documentation to update**.
- Replace the relevant parts of `docs/status.md`.
- Add one dated entry to `docs/history.md`.
- Update `README.md` for user-visible changes.
- Set the plan to **Done** in the plan and in `docs/plans/README.md`, and fill in the **Completion record**: date, verified counts, deviations and why, what was not verified, and follow-up work.

Run `pnpm test` again, since it also checks the documentation.

## 6. Report

Give the owner what was built, the verification results with counts, anything not verified, deviations from the plan, and follow-ups. Suggest a commit message; commit only if the owner asks.
