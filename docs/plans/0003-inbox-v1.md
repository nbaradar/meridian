---
summary: Plan 0003 (Done): Inbox v1, owner tasks, computed balance items, snooze and dismiss, the /inbox page, and the Inbox count, per RFC 0009
read_when: Designing, resuming, or implementing the first Inbox unit
---

# Plan 0003: Inbox v1

- Status: Done
- Completed: 2026-09-27
- Date: 2026-09-27
- Approved: 2026-09-27
- Related RFCs: [RFC 0009](../decisions/0009-inbox.md) (the Inbox, primary); [RFC 0006](../decisions/0006-balance-observations.md) (the balance data the first items read)
- Depends on: none. RFC 0009 was accepted 2026-09-27.

## Goal

The owner opens `/inbox` and sees, most important first, every balance that needs attention along with their own tasks. They can add, edit, complete, and delete tasks, snooze or dismiss items and restore them, and see an `Inbox (N)` count from every page.

## Scope

- The `app` schema, with `app.inbox_tasks` and `app.inbox_item_states` and runtime grants, in migration `0015`.
- Core Inbox in `src/core/inbox/`: attention item and provider types, aggregation and ordering, snooze and dismiss rules, the count, and the owner-task service.
- The balance attention provider in `src/core/inbox/`: `no_balance`, `stale_balance`, and `closed_with_balance`.
- PostgreSQL adapters for owner tasks and item states in `src/infrastructure/database/`.
- The `/inbox` page and its server actions, a shared `InboxLink` showing `Inbox (N)` on `/`, `/setup`, `/ynab`, and `/inbox`, and per-account anchors on the dashboard for item links to target.
- Documentation of the Inbox and the `app` schema in the owning docs.

## Non-goals

- Anything from RFC 0009's non-goals: push or email notifications, recurring tasks, owner-set priorities, tags, sharing, or the application shell.
- Matching, review, `decision`, or YNAB items. Their providers arrive in [Plan 0006](0006-review-queue-and-inbox-items-after-0003-0005.md); this unit only makes the types ready for them.
- The `ModuleDefinition` type and registry. Plan 0006 builds them (see Decisions).
- The dashboard's per-account review counts (RFC 0008). They come in Plan 0006; the dashboard already flags closed accounts with a balance.
- Snoozing or dismissing owner tasks. Only system items can be hidden.
- Backing up `app.*`, which is [Plan 0012](0012-encrypted-backups.md)'s job.
- Any write to `ledger.*`, any change to a `ledger.*` table, view, or function, and any AI explanation.
- Pruning old item-state rows. Rows that no longer match a current item are ignored, not deleted.

## Required reading

- [RFC 0009](../decisions/0009-inbox.md): the whole RFC; it is the contract.
- `AGENTS.md` "The two data planes": the `app.*` rule.
- [Module contract](../architecture/modules.md): the `attention` extension point this unit defines the types for but does not register through.
- `src/core/ledger/balance-observations.ts`: `CurrentBalance`, `computeNetWorth`, `utcDate`, `balanceAgeDays`, `BalanceObservationStore.listAccounts`/`listCurrentBalances`, and the injected-clock pattern.
- `src/infrastructure/database/schema.ts` and `postgres-balance-observations.ts`: Drizzle schema and adapter patterns.
- `drizzle/0008_salty_ikaris.sql` (new schema, `REVOKE ... FROM PUBLIC`, grants) and `drizzle/0012_hesitant_johnny_blaze.sql`: hand-appended grant blocks.
- `scripts/provision-database-roles.mjs` and `.env.example`: the three runtime roles (`meridian_app`, `meridian_ops_control`, `meridian_read_worker`).
- `src/app/page.tsx`, `src/app/balances/`, `src/app/setup/page.tsx`, `src/app/ynab/page.tsx`: the `page-links` nav and the server-action pattern.
- `tests/architecture.test.mjs` and `tests/integration/`: where the new boundary and grant tests go.

## Decisions already made

- From RFC 0009, resolved 2026-09-27:
  - owner workspace state lives in a new mutable `app.*` schema;
  - a balance is stale after 30 days, for every account;
  - `review` and `decision` items can only be snoozed; `action` and `info` items can also be dismissed until their evidence changes.
- System items are computed on each view, never stored. Only owner tasks and snooze/dismiss records are stored.
- The Inbox never decides or acts on money; items link to the page that owns the decision.
- **No registry yet (owner, 2026-09-27).** Aggregation takes a `readonly AttentionProvider[]`; the app layer composes the list, which for now holds only the balance provider. The `ModuleDefinition` type and registry are built by Plan 0006, when the first module contributes an item; Plan 0006 records this in its scope.
- **Where the provider lives:** `src/core/inbox/` holds the balance provider, importing from `src/core/ledger/`. `src/core/ledger/` never imports `src/core/inbox/`, and ledger, world, strategy, and execution code never read `app.*`.
- **Balance items** (all only for accounts in `ledger.current_accounts`):

  | Kind                  | Severity | Condition                                         | `version`              | `since`                 |
  | --------------------- | -------- | ------------------------------------------------- | ---------------------- | ----------------------- |
  | `no_balance`          | action   | Active account with no current balance            | `none`                 | none                    |
  | `stale_balance`       | action   | Active account whose balance age is **> 30** days | current observation ID | `observed_on` + 31 days |
  | `closed_with_balance` | review   | Closed account whose current balance is not zero  | current observation ID | none                    |

  Age is `balanceAgeDays(observedOn, utcDate(now))`; 30 days old is not stale, 31 is. A future-dated balance is never stale. A closed account never gets `no_balance` or `stale_balance`. `since` is the first day the balance counted as stale. Using no `since` for the other two avoids exposing `accounts.recorded_at`, which would change a ledger view.

- **Keys** are `balances:<kind>:<account id>`. Titles name the account but carry no amount, account number, or provider data (for example "Record a balance for Everyday Checking"). `href` is `/#account-<account id>`, and the dashboard row gets that `id`.
- **Provider failure:** aggregation catches a provider's error, logs it with the provider id (no balances or amounts), and yields one `info` item with key `inbox:provider_failed:<provider id>`. It can't be snoozed or dismissed.
- **Snooze and dismiss** are stored as one row per item key in `app.inbox_item_states` (`item_key`, `item_version`, `state` of `snoozed` or `dismissed`, `snoozed_until` date for snoozes only, `recorded_at`). A new action on the same key replaces the row, and **Restore** deletes it. A row applies only while its version equals the item's current version; otherwise it is ignored and the item is active.
  - A snooze hides the item while `utcDate(now) < snoozed_until`, so it returns on that date.
  - Snooze choices are **1 day, 1 week, 1 month, or a chosen date** (owner, 2026-09-27). The fixed choices are computed in core from `utcDate(now)`, with 1 month meaning the same day next month, clamped to the month's last day. A chosen date must be after today and at most 365 days away.
  - Core accepts snooze or dismiss only for a key present in the freshly computed items with the submitted version, refuses dismiss for `review` and `decision` items, and refuses both for provider-failure items. A stale form gets a clear "this item changed; reload" error.
- **Hidden items stay visible (owner, 2026-09-27):** `/inbox` shows active items grouped by severity, then a **Snoozed** group (with each until date) and a **Dismissed** group, each item with **Restore**. Neither group counts toward `Inbox (N)`.
- **Owner tasks** (owner, 2026-09-27), in `app.inbox_tasks`:
  - Fields: title (required, trimmed, 1–200 characters); optional note (≤ 2,000); optional account (FK to `ledger.accounts`); optional **link**; optional due date; status `open` or `done`; `created_at`, `updated_at`, and `completed_at` (set exactly when done, enforced by a check constraint).
  - The link is either an in-app path starting with a single `/`, or an absolute `http:` or `https:` URL, up to 2,048 characters. Anything else is rejected by Zod and a matching check constraint, including `javascript:` and `//host`. External links render with `rel="noopener noreferrer"`.
  - The owner can add, edit, complete, reopen, and **delete** tasks. Delete removes the row.
  - Open tasks sort as `action` with `since` = `created_at`. A task is overdue when `due_on < utcDate(now)`. Done tasks appear in a **Done** group, newest completed first.
- **Ordering:** `review`, `decision`, `action`, then `info`. Within a severity: overdue owner tasks, then oldest `since` (no `since` sorts last), then title, then key.
- **Count:** active (not snoozed, not dismissed) `review`, `decision`, and `action` items plus open owner tasks. `info` items are not counted.
- **Time:** services take an injected clock (`() => UtcTimestamp`), as the balance service does. Stored timestamps come from that clock, and every date comparison uses `utcDate` of it.
- **Grants:** `REVOKE ALL` on schema `app` and its tables from `PUBLIC`. `meridian_app` gets `USAGE` on `app` and `SELECT, INSERT, UPDATE, DELETE` on the two tables. `meridian_ops_control` and `meridian_read_worker` get nothing. The grant block is hand-appended to the generated migration, following `0008`.
- **UI:** one `InboxLink` server component in `src/app/inbox/`, added to each page's existing `page-links` nav. Actions in `src/app/inbox/actions.ts` parse nothing themselves; they call core services, which validate with Zod.

## Open questions

None.

## Steps

1. **Schema.** Add `pgSchema("app")` with `inboxTasks` and `inboxItemStates` to `src/infrastructure/database/schema.ts`, including the check constraints above. Run `pnpm db:generate` to create migration `0015`, then append the grant block. Apply it with `pnpm db:migrate`.
2. **Core types and rules** in `src/core/inbox/`: `AttentionSeverity`, `AttentionItem`, `AttentionProvider`, `OwnerTask`, and the item-state types. Add pure functions for ordering, applying item states, the count, snooze-date computation and validation, and task and link validation (Zod). Export them from `src/core/inbox/index.ts`.
3. **Balance provider:** a pure `balanceAttentionItems(accounts, balances, today)` plus a provider factory over the `BalanceObservationStore` read methods.
4. **Inbox service:** `createInboxService({ providers, taskStore, itemStateStore, clock })` exposing `view()` (active groups, Snoozed, Dismissed, Done), `count()`, `snooze`, `dismiss`, `restore`, and the task commands `add`, `edit`, `complete`, `reopen`, and `delete`. It isolates provider failures and never touches a ledger write method.
5. **PostgreSQL adapters:** `postgres-inbox-tasks.ts` and `postgres-inbox-item-states.ts`, with contextual errors, for example a missing task or an unknown account.
6. **UI:** the `/inbox` page and actions; `InboxLink` in the nav of `/`, `/setup`, `/ynab`, and `/inbox`; `id="account-<id>"` on dashboard rows.
7. **Tests**, as listed below.
8. **Browser check** against a disposable database with synthetic accounts and balances covering all three kinds, plus tasks. Then a render check against the local database.
9. **Docs and Definition of Done.**

## Acceptance criteria

- [x] Migration `0015` creates schema `app` with `app.inbox_tasks` and `app.inbox_item_states`, their constraints, and the grants above. `pnpm db:generate` then shows no drift.
- [x] `/inbox` lists balance items and open tasks grouped `review`, `decision`, `action`, `info` in the ordering above, then Snoozed, Dismissed, and Done groups.
- [x] Each balance kind appears under exactly its condition, including the 30/31-day boundary. It disappears on its own once the condition is fixed, for example by recording a new balance.
- [x] Each item links to its account's row on `/`.
- [x] The owner can add a task with every optional field, then edit, complete, reopen, and delete it. Invalid titles and links are rejected with a clear message.
- [x] The owner can snooze an item for 1 day, 1 week, 1 month, or a chosen date. It moves to Snoozed and returns on that date or when its version changes.
- [x] The owner can dismiss `action` items. `review` items offer no dismiss, and core refuses one. A dismissed item returns when its version changes.
- [x] Restore returns a snoozed or dismissed item to its active group.
- [x] `Inbox (N)` appears on `/`, `/setup`, `/ynab`, and `/inbox`, counting exactly as defined above.
- [x] A throwing provider yields one `info` item and the rest of the Inbox still renders.
- [x] No Inbox code path writes to `ledger.*`, and `src/core/ledger/` does not import `src/core/inbox/`.
- [x] All Definition of Done checks pass.

## Tests required

- **Balance provider (unit):** `no_balance` for an active account without a balance; `stale_balance` at ages 29, 30, 31, and a future date; `closed_with_balance` for closed non-zero, none for closed zero; closed accounts never get `no_balance` or `stale_balance`; keys, versions, `since`, `href`, and titles free of amounts.
- **Ordering (unit):** severity order; overdue tasks first within `action`; oldest `since`; missing `since` last; title and key tie-breaks. Input order never changes the output.
- **Item states (unit):** snooze hides until the date and returns on it; a version change reactivates both snoozed and dismissed items; dismiss is refused for `review` and `decision`; both are refused for provider-failure items and for a key or version not currently computed; restore reactivates.
- **Snooze dates (unit):** 1 day, 1 week, and 1 month, including month-end clamping (for example Jan 31 → Feb 28/29); a chosen date of today is refused, tomorrow accepted, today + 365 accepted, today + 366 refused.
- **Tasks (unit):** title trimming and length; accepted links (`/inbox`, `https://example.com/x`) and rejected ones (`javascript:alert(1)`, `//evil.example`, `ftp://x`, relative `inbox`); overdue on `due_on < today` only.
- **Count (unit):** excludes `info`, snoozed, dismissed, and done tasks; includes open tasks.
- **Provider failure (unit):** one throwing provider yields one `info` item, and the other providers' items are still returned.
- **Integration:** migration grants (`meridian_app` has exactly `SELECT`/`INSERT`/`UPDATE`/`DELETE` on both tables; the ops roles and `PUBLIC` have no privileges on schema `app`); task round trip including delete; the account FK and check constraints (link, title, `completed_at`/status, snooze columns); replacing and restoring item states; a full Inbox view and actions leave every `ledger.*` table's row count unchanged.
- **Architecture:** `src/core/ledger/` never imports `src/core/inbox/`; outside the Inbox adapters and migrations, no source file references the `app` schema tables.

## Verification

```bash
pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build
pnpm test:integration   # the database is touched
pnpm db:generate        # the schema changed: expect no drift
```

Also run through `/inbox` in a browser against a disposable database with synthetic data: all three kinds, every task action, all four snooze choices, dismiss, restore, and the count on each page. Then check it renders against the local database.

## Documentation to update

- [x] [docs/status.md](../status.md) (replace) and [docs/history.md](../history.md) (one entry)
- [x] [RFC 0009](../decisions/0009-inbox.md): Implementation status only (Inbox v1 built; registry and further providers in Plan 0006)
- [x] [Module contract](../architecture/modules.md): note that providers are passed in until Plan 0006 builds the registry
- [x] [Architecture overview](../architecture/overview.md): confirm the `app.*` description matches what was built (tables and grants)
- [x] [README.md](../../README.md): the Inbox row in "What works today" and a short "Using the current screens" note
- [x] `AGENTS.md`, only if a rule or the routing table changed

## Stop and ask if

- A provider seems to need to write anything, or an item seems to need stored state beyond snooze and dismiss.
- Any balance kind's `version` or `since` seems to need data not already in `CurrentAccount` or `CurrentBalance`, which would mean changing a ledger view.
- The grants would need to touch the ops roles, or `app` tables would need a trigger or function with elevated rights.
- Computing the count on every page makes page loads noticeably slower.
- RFC 0009 and this plan disagree on any rule.

## Completion record

- **Date:** 2026-09-27.
- **Verified:** `pnpm format:check`, `lint`, `typecheck`, `test` (214 unit tests, 18 files; 32 new: 29 in `tests/inbox.test.ts`, 3 architecture), `build`, and `test:integration` (127 tests, 9 files; 8 new in `tests/integration/inbox.test.ts`) pass. `pnpm db:generate` shows no drift. Migration `0015_dusty_earthquake.sql` is applied to the local database.
- **Browser check:** done against a disposable database with synthetic accounts, served by a production build: all three kinds and their order; a 30-day balance absent and a 31-day balance present; a task with every field; an invalid link and a blank title rejected with messages; edit, done, reopen, and delete; all four snooze choices with their return dates; dismiss and Restore; no Dismiss on the review item; a new balance clearing a snoozed stale item; item links landing on the highlighted dashboard row; the count on `/`, `/setup`, `/ynab`, and `/inbox`. Pages rendered in about 30 ms with the count, so the count's cost is not noticeable. `/inbox` then rendered against the local database without errors.
- **Deviations:**
  - The provider interface validates each provider's items with Zod and requires keys to start with the provider id; malformed or duplicate items fail that provider only (the "Zod at every boundary" rule).
  - `since` is a UTC timestamp; a stale balance's is midnight UTC of `observed_on` + 31 days.
  - `balanceAttentionItems` reuses `computeNetWorth`'s classification, so the Inbox and the dashboard can't disagree about missing or closed balances.
  - The database link check also refuses whitespace, control characters, and backslashes, since browsers rewrite `/\host` and `/\t/host` into protocol-relative links. Zod applies the same rule.
  - `inbox_tasks_time_check` requires `updated_at` and `completed_at` to be no earlier than `created_at`.
  - `constraintName` moved next to `postgresErrorCode` in `postgres-account-sources.ts` so both Postgres adapters share it.
  - Found in the browser check: React resets a form's fields after every action, so a rejected task form lost its input. Failed add and edit submissions now remount the fields with what was typed.
  - The first generated migration had a malformed link regex (`\]` escaped the bracket). The integration tests caught it before commit. Migration `0015` was regenerated, and the local database's empty `app` schema and its one migration record were dropped and reapplied.
- **Not verified:** the provider-failure `info` item in a browser (unit-tested only); a chosen snooze date of today reaching core from the browser (the date input's `min` blocks it first; core's refusal is unit-tested).
- **Follow-ups:** the module registry, more providers, and per-account review counts on the dashboard (Plan 0006); backing up `app.*` (Plan 0012); an account-closing command, which tests currently do with SQL.
