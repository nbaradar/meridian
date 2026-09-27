---
summary: RFC 0009 (Proposed): the Inbox, a running task list combining system items computed from current state with owner-created tasks, how core and modules contribute items, and where its mutable state lives
read_when: Adding something the owner must review or act on, building the Inbox page or its badge, contributing Inbox items from a module, or storing owner tasks
---

# RFC 0009: Inbox

- Status: Proposed
- Date: 2026-09-27
- Decision owners: project owner and implementer
- Depends on: RFC 0006 (balance observations), RFC 0008 (review state)
- Relates to: [module contract](../architecture/modules.md), [UI direction](../architecture/ui.md), [overview](../architecture/overview.md#the-two-data-planes)

## Context

Several features already produce things the owner should act on: an active account with no balance, a stale balance, a closed account that still shows money. RFC 0008 adds more that cannot be resolved without the owner: ambiguous matches, near misses, balance discrepancies, old uncleared YNAB rows. The owner also wants to keep their own tasks alongside. Scattering these across pages hides them; notifying on each one creates noise.

## Goals

- One place that lists everything needing the owner's attention, most important first.
- Items the system raises disappear on their own once the underlying condition is fixed.
- The owner can add, complete, and remove their own tasks.
- Features and modules contribute items without importing each other.
- An Inbox item never is, and never replaces, a financial decision.

## Non-goals

- Push, email, or other notifications. A count in the navigation is the only signal for now.
- Recurring tasks, reminders, priorities set by the owner, tags, or sharing.
- Resolving review items inside the Inbox itself. The Inbox links to the page that owns the decision.
- The application shell ([UI direction](../architecture/ui.md)). A plain link with a count is enough until the shell is designed.

## Design

### Two kinds of item

**System items** are computed, not stored. An **attention provider** is a read-only function over current state that returns the items that apply right now. Each item has:

| Field      | Meaning                                                                                         |
| ---------- | ----------------------------------------------------------------------------------------------- |
| `key`      | Stable identity, `<provider>:<kind>:<subject>`, for example `balances:stale:<account id>`       |
| `version`  | Fingerprint of the condition's current evidence, for example the current balance observation ID |
| `kind`     | Checked code owned by the provider                                                              |
| `severity` | `review` (money is uncertain until acted on), `action` (routine upkeep), or `info`              |
| `title`    | Short text; no account numbers or raw provider data                                             |
| `subject`  | Optional canonical references: account ID, observation ID, and so on                            |
| `href`     | The page where the owner resolves it                                                            |
| `since`    | When the condition began, if known, for ordering                                                |

Because items are computed each time the Inbox or its count is shown, fixing the condition removes the item. Nothing needs closing.

**Owner tasks** are stored: title, optional note, optional account, optional due date, open or done, and created and completed timestamps. The owner may edit or delete them.

### Snooze and dismiss

The owner may **snooze** a system item until a date, or **dismiss** it. Both are stored against the item's `key` and `version`. A dismissal lasts only while the evidence is unchanged: if the version changes, for example because a newer balance becomes stale again, the item returns. `review` items can be snoozed but not dismissed, because money stays uncertain until the owner decides.

### Contributing items

- Core features contribute providers from `src/core/`. Balance observations, for example, provide the balance items.
- Modules contribute through a new `ModuleDefinition` extension point, `attention?: AttentionProvider[]`, so the Inbox aggregates without importing any module.
- The attention types, the aggregation, ordering, snooze and dismiss logic, and the owner-task service live in `src/core/inbox/`. Next.js renders them and calls actions; it contains no rules.
- Providers must be cheap, read-only, and side-effect free, since they run on every Inbox view and badge count. A provider that fails yields a single `info` item naming the provider, never a broken Inbox.

### Ordering

`review` before `action` before `info`. Within a severity: overdue owner tasks first, then oldest `since`, then title. Owner tasks without a due date sort as `action`.

### Where the state lives

Owner tasks and snooze/dismiss records are mutable, authored by the owner, and not financial facts. They fit neither plane:

- `ledger.*` is append-only and holds money facts only;
- `world.*` is refetchable and unbacked.

This RFC adds a third schema, **`app.*`**: owner workspace state. It is mutable and backed up with the ledger, but never holds or derives financial facts. Ledger and world code never read it, and strategies and execution never import it. The runtime role gets `SELECT`, `INSERT`, `UPDATE`, and `DELETE` on its tables only. The Inbox tables are `app.inbox_tasks` and `app.inbox_item_states`. Later owner preferences may also live in `app.*`.

### First system items

| Provider | Kind                  | Severity | Condition                                                                      |
| -------- | --------------------- | -------- | ------------------------------------------------------------------------------ |
| balances | `no_balance`          | action   | Active account with no current balance                                         |
| balances | `stale_balance`       | action   | Current balance older than 30 days                                             |
| balances | `closed_with_balance` | review   | Closed account whose current balance is not zero                               |
| matching | `needs_review`        | review   | Observation whose processing tip is `needs_review` (RFC 0008; when built)      |
| matching | `balance_discrepancy` | review   | Summed entries differ from the account's balance observation (RFC 0008)        |
| ynab     | `stale_uncleared`     | action   | YNAB row uncleared for more than 30 days (RFC 0008; when YNAB import is built) |

The 30-day thresholds are provider constants, not schema.

### Presentation

- `/inbox` lists items grouped by severity, with owner tasks inline, and a form to add a task.
- Every page's links show `Inbox (N)`, where N counts unsnoozed `review` and `action` items plus open owner tasks.
- Accounts with `review` items also show the count on the dashboard, as RFC 0008 requires.

## Consequences

- The system can raise new kinds of attention without new pages or notification plumbing.
- A third schema adds one more backup target and a grant set. The ledger's backup story is unchanged: `app.*` is small and backed up with `ledger.*`.
- Computing items on each view costs a few cheap queries; if that ever becomes slow, caching is an implementation detail, not a model change.

## Open questions

None. Resolved by the owner on 2026-09-27:

1. **State location:** a new mutable `app.*` schema.
2. **Stale-balance threshold:** 30 days for every account.
3. **Dismissal:** `review` items can only be snoozed; `action` and `info` items can be dismissed until their evidence changes.
