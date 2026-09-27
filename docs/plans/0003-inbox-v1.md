---
summary: Plan 0003 (Draft): Inbox v1, owner tasks, computed balance items, snooze and dismiss, the /inbox page, and the Inbox count, per RFC 0009
read_when: Designing, resuming, or implementing the first Inbox unit
---

# Plan 0003: Inbox v1

- Status: Draft
- Date: 2026-09-27
- Approved: (date, once the owner approves)
- Related RFCs: [RFC 0009](../decisions/0009-inbox.md) (the Inbox, primary); [RFC 0006](../decisions/0006-balance-observations.md) (the balance data the first items read)
- Depends on: none. RFC 0009 was accepted 2026-09-27.

## Goal

The owner opens `/inbox` and sees, most important first, every balance that needs attention along with their own tasks. They can add, complete, and delete tasks, snooze or dismiss items, and see an `Inbox (N)` count from every page.

## Scope

- The `app.*` schema, with `app.inbox_tasks` and `app.inbox_item_states` and runtime grants, in a new migration.
- Core Inbox in `src/core/inbox/`: attention item types, the provider port, aggregation and ordering, snooze and dismiss rules, and the owner-task service.
- The balance attention provider in core: `no_balance`, `stale_balance` (older than 30 days), and `closed_with_balance`.
- PostgreSQL adapters for owner tasks and item states.
- `/inbox` page and actions, plus an `Inbox (N)` link on `/`, `/setup`, and `/ynab`.
- Documentation of the new `app.*` schema in the owning docs.

## Non-goals

- Anything from RFC 0009's non-goals: push or email notifications, recurring tasks, owner priorities, tags, sharing, or the application shell.
- Matching, review, `decision` items, or YNAB items. Their providers arrive with RFC 0008's plans; this unit only makes the types ready for them.
- The `ModuleDefinition` registry itself, unless the owner decides otherwise (see Open questions).
- Any write to `ledger.*`, and any AI explanation.

## Required reading

- [RFC 0009](../decisions/0009-inbox.md): the whole RFC; it is the contract.
- `AGENTS.md` "The two data planes": the `app.*` rule.
- [Module contract](../architecture/modules.md): the `attention` extension point.
- `src/core/ledger/balance-observations.ts`: `buildBalanceDashboard`, `computeNetWorth`, `utcDate`, `balanceAgeDays`, and the injected-clock pattern the provider should reuse.
- `drizzle/0012_hesitant_johnny_blaze.sql` and `scripts/provision-database-roles.mjs`: grants and role patterns for a new schema.
- `src/app/page.tsx` and `src/app/balances/`: where the item links point and the action pattern to follow.

## Decisions already made

- From RFC 0009, resolved 2026-09-27:
  - owner workspace state lives in a new mutable `app.*` schema;
  - a balance is stale after 30 days, for every account;
  - `review` and `decision` items can only be snoozed; `action` and `info` items can also be dismissed until their evidence changes.
- System items are computed on each view, never stored. Only owner tasks and snooze/dismiss records are stored.
- The Inbox never decides or acts on money; items link to the page that owns the decision.
- Item severities for this unit: `no_balance` and `stale_balance` are `action`; `closed_with_balance` is `review`.

## Open questions

- Item `version` for each balance kind: probably the current balance observation ID for `stale_balance` and `closed_with_balance`, and a constant for `no_balance`. Confirm.
- Where `since` comes from for `no_balance`: the account's creation time, or none?
- Build the `ModuleDefinition` registry now so providers register through it, or have core call the balance provider directly until the first module contributes one?
- Owner task fields beyond RFC 0009 (title, note, account, due date, done): any others, such as a link?
- Does "delete" remove a task row, or mark it deleted? RFC 0009 allows real deletion in `app.*`.
- Snooze durations offered in the UI: fixed choices (1 day, 1 week, 1 month) or any date?
- The `Inbox (N)` link: a small shared header component, or a link added to each page's existing links?
- Backups: `app.*` is meant to be backed up with the ledger, but no backup exists yet. Confirm that stays deferred.

## Steps

1. (To plan.)

## Acceptance criteria

- [ ] (To plan.)

## Tests required

- (To plan.) Likely: ordering and severity rules, snooze and dismiss by version, the balance provider's three conditions at their boundaries (29, 30, and 31 days), `review` items refusing dismissal, grants and privileges on `app.*`, and that no `ledger.*` table is written.

## Verification

```bash
pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build
pnpm test:integration   # the database is touched
pnpm db:generate        # the schema changed: expect no drift
```

Plus a browser run-through of `/inbox` against a disposable database with synthetic data, and a render check against the local database.

## Documentation to update

- [ ] [docs/status.md](../status.md) (replace) and [docs/history.md](../history.md) (one entry)
- [ ] [RFC 0009](../decisions/0009-inbox.md): Implementation status
- [ ] [Architecture overview](../architecture/overview.md) and [ledger model](../architecture/ledger-model.md), if the schema description changes
- [ ] [README.md](../../README.md): the Inbox row in "What works today" and a short "Using the current screens" note
- [ ] `AGENTS.md`, only if a rule or the routing table changed

## Stop and ask if

- (To plan.) Likely: a provider seems to need to write anything, or an item seems to need stored state beyond snooze and dismiss.

## Completion record

When Done: date, verified counts, deviations and why, what was not verified, follow-ups.
