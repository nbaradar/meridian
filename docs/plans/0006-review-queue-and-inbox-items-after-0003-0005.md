---
summary: Plan 0006 (Draft): RFC 0008 rollout unit 3 with RFC 0009: review screens that resolve matches, the ModuleDefinition registry, and the matching and YNAB Inbox providers
read_when: Building the review screens or the matching and YNAB Inbox items
---

# Plan 0006: Review queue and Inbox items (after 0003 and 0005)

- Status: Draft
- Date: 2026-09-27
- Approved: (date, once the owner approves)
- Related RFCs: [RFC 0008](../decisions/0008-cross-source-transaction-matching.md), [RFC 0009](../decisions/0009-inbox.md)
- Depends on: [Plan 0003](0003-inbox-v1.md) and [Plan 0005](0005-ynab-transaction-import-after-0004.md) must be Done (Plan 0005 implies Plan 0004).

Sparse draft for tracking. Resume with `/plan-unit 0006` to design it fully.

## Goal

Every `needs_review` observation, balance discrepancy, and stale uncleared YNAB row appears in the Inbox, and the owner resolves each on a review screen that records the decision.

## Scope

- The `ModuleDefinition` type and module registry, with the `attention?: AttentionProvider[]` extension point ([module contract](../architecture/modules.md)). Plan 0003 deliberately passes providers to the Inbox as a plain list, because its only provider (balances) is core. `stale_uncleared` comes from the YNAB module, which may not be imported by core or the app's Inbox wiring, so it must register through the registry. Design how modules register at boot and how the Inbox gets core and module providers together.
- Attention providers for `needs_review`, `balance_discrepancy`, and `stale_uncleared`.
- Review screens: match to a candidate, create, or ignore, recorded as processing successors.
- Reclassification from the review or transaction view.
- The dashboard's per-account review counts (RFC 0008).

## Non-goals

- A general transaction browser or spending views.
- Transfer pairing.
- Notifications beyond the Inbox count.

## Required reading

- RFC 0008 Review and Database enforcement.
- RFC 0009 severities and the no-action rule.
- Plans 0003 and 0004 Completion records.

## Decisions already made

- `review` items can only be snoozed. The Inbox links to the review screen; it never records the decision itself.

## Open questions

- How the registry is populated at boot (static list of module definitions vs. discovery), and whether core providers join it or stay a separate list.

- Review screen layout and what evidence to show (candidates, date and amount deltas, payee).
- Whether to allow bulk actions.

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
