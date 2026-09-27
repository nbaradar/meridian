---
summary: Plan 0009 (Draft): Plaid Trial connector only for institutions Teller cannot reach, including investment accounts if needed, per RFC 0007
read_when: Building the Plaid connector or covering an institution Teller cannot reach
---

# Plan 0009: Plaid gap connector (after 0007)

- Status: Draft
- Date: 2026-09-27
- Approved: (date, once the owner approves)
- Related RFCs: [RFC 0007](../decisions/0007-free-first-provider-selection.md), [RFC 0003](../decisions/0003-operational-live-connections.md), [RFC 0008](../decisions/0008-cross-source-transaction-matching.md)
- Depends on: [Plan 0007](0007-sync-worker-and-ingestion-after-0004.md) must be Done; needs the same connector-balance RFC as Plan 0008. Only needed if Teller coverage checks leave a gap.

Sparse draft for tracking. Resume with `/plan-unit 0009` to design it fully.

## Goal

Institutions Teller cannot reach connect through Plaid Link without spending Trial slots on experiments.

## Scope

- Add `plaid` to the source registry and `ops.connections` sources (RFC 0007 decision 5).
- Plaid module with Sandbox fixtures; Plaid Link setup flow.
- Use `pending_transaction_id` as a same-source version link.

## Non-goals

- Fidelity (blocked from Plaid; file import instead).
- Anything Teller already covers.

## Required reading

- RFC 0007 and Plaid's Trial, Link, and `/transactions/sync` documentation.

## Decisions already made

- Plaid Trial: 10 Items, never spent on experiments; develop against Sandbox.

## Open questions

- Which institutions actually need it (after Plan 0008's coverage checks).
- Whether investment holdings wait for Phase 2.

## Steps

1. (To plan.)

## Acceptance criteria

- [ ] (To plan.)

## Tests required

- (To plan.)

## Verification

```bash
pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build
pnpm test:integration   # when the database is touched
pnpm db:generate        # when the schema changed: expect no drift
```

## Documentation to update

- [ ] [docs/status.md](../status.md) (replace) and [docs/history.md](../history.md) (one entry)
- [ ] (To plan.)

## Stop and ask if

- (To plan.)

## Completion record

When Done: date, verified counts, deviations and why, what was not verified, follow-ups.
