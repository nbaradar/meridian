---
summary: Template for a new implementation plan
read_when: Writing a new plan (copy it; never edit it for a specific unit)
---

# Plan NNNN: Short title

- Status: Draft
- Date: YYYY-MM-DD
- Approved: (date, once the owner approves)
- Related RFCs: (links, or "none")
- Depends on: (plans or units that must finish first, or "none")

## Goal

What the owner can do, or what becomes true, when this is done. One or two sentences.

## Scope

- What this unit builds.

## Non-goals

- Adjacent work this unit must not do. A hard boundary for the implementer.

## Required reading

- Documents and code to read first, and what to look for in each.

## Decisions already made

- Choices settled in design; the implementer follows them without re-asking.

## Open questions

- Must be empty before Approved.

## Steps

1. Ordered steps, each small enough to verify.

## Acceptance criteria

- [ ] Observable, checkable outcomes; all checked before Done.

## Tests required

- Tests that must exist, named by the behavior they prove.

## Verification

```bash
pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build
pnpm test:integration   # when the database is touched
pnpm db:generate        # when the schema changed: expect no drift
```

Plus any unit-specific checks.

## Documentation to update

- [ ] [docs/status.md](../status.md) (replace) and [docs/history.md](../history.md) (one entry)
- [ ] Owning architecture docs or RFCs for changed concepts
- [ ] [README.md](../../README.md), if a capability, setup step, or known problem changed
- [ ] `AGENTS.md`, only if a rule or the routing table changed

## Stop and ask if

- Unit-specific halt conditions, beyond "When to stop and ask" in `AGENTS.md`.

## Completion record

When Done: date, verified counts, deviations and why, what was not verified, follow-ups.
