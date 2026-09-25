---
summary: RFC 0006 (Accepted): append-only account-level balance observations from manual entry and YNAB exports, their corrections, and how the current balance and net worth are derived
read_when: Recording or displaying balances, computing net worth, correcting a balance, or adding a new balance source
---

# RFC 0006: Balance observations

- Status: Accepted
- Date: 2026-09-25
- Accepted: 2026-09-25
- Decision owners: project owner and implementer
- Depends on: RFC 0001, RFC 0002, RFC 0005
- Relates to: RFC 0004 ("Position and balance observations need their own accepted persistence boundary")

## Context

The owner wants a net-worth dashboard before transaction authority (RFC 0004) is complete. The [architecture overview](../architecture/overview.md#balances-are-observations-not-state) already separates the two streams: transactions are causal truth, and a balance is an institution's (or the owner's) claim about an account at a point in time. The display balance is the latest claim, so it doesn't need a single imported transaction.

Nothing stores a balance today. `/ynab` computes each YNAB account's working balance from the register export (`src/modules/ynab/import-plan.ts`, `activity.workingBalance`) and discards it. The conceptual `position_snapshots` table in the [ledger model](../architecture/ledger-model.md) is per instrument, and instruments don't exist until Phase 2.

## Goals

- Record an account-level balance by hand, and from a YNAB export for accounts already saved under RFC 0005.
- Derive each account's current balance and a net worth from those records, deterministically and without floats.
- Correct a mistaken balance, or withdraw one recorded against the wrong account, without mutating history.
- Replaying the same YNAB export is a no-op.

## Non-goals

- Per-instrument positions, quantities, prices, and valuation (Phase 2 `position_snapshots`).
- Balances derived from transactions, and the reconciliation loop between the two streams (RFC 0004 later units).
- Live connector balances (SimpleFIN and others). A later amendment adds their source values, `source_ref`, and raw-payload linkage.
- Historical net-worth charts. The data supports them, since every observation is kept, but the UI doesn't show them yet.
- Currencies other than USD, matching `ledger.accounts`.
- Grouping by institution (needs the deferred account-details store in [future expansion](../future/expansion.md)).

## Design

### Table: `ledger.balance_observations`

A core, append-only Plane A table:

| Column                      | Meaning                                                                                                    |
| --------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `id`                        | Meridian-local UUID                                                                                        |
| `account_id`                | Canonical account the balance belongs to                                                                   |
| `observed_on`               | Calendar `date` the balance is claimed to be true at the end of; never an invented instant                 |
| `amount`                    | Signed `NUMERIC`, the same type and decimal-string schema as `ledger.entries.amount` (see Sign convention) |
| `currency`                  | ISO 4217 code; must equal the account's currency (USD only today)                                          |
| `source`                    | `manual` or `ynab_export`; checked text, extended by later amendments                                      |
| `account_source_id`         | For `ynab_export`, the RFC 0002 YNAB source whose rows produced the balance; null for `manual`             |
| `export_digest`             | For `ynab_export`, the SHA-256 of the register file's bytes, lowercase hex; null for `manual`              |
| `supersedes_observation_id` | The observation this one corrects, or null                                                                 |
| `recorded_at`               | Server-owned `timestamptz`                                                                                 |

A second append-only table, `ledger.balance_observation_retractions` (`id`, `observation_id` unique, `recorded_at`), withdraws an observation entirely.

### Sign convention

`amount` is signed from the owner's point of view: what the account contributes to net worth. An asset normally has a positive amount; a liability that is owed has a negative amount, and a credit card carrying a credit has a positive one. Sign never changes an account's class (RFC 0001 amendment 8). This is the same sign YNAB uses for working balances, so a YNAB balance is stored unchanged.

Manual entry for a liability-class account asks for the **amount owed** as a non-negative number and stores its negation. A liability with a credit is entered as a negative amount owed. The conversion lives in one core function used by every entry path.

### Dates

`observed_on` is a `date`. No observation may be dated after the **latest allowed date**: the server's current UTC date plus one day, which covers the owner being behind UTC.

A manual observation uses the date the owner enters. A `ynab_export` observation counts only the account's register rows dated on or before the latest allowed date. Its amount is the sum of those rows (the existing working-balance calculation), and it is dated at the latest of them. Rows dated later (future-dated transactions) are left out of the balance, never block the save, and are reported to the owner as a count per account. An account with no rows on or before that date produces no observation.

Using the latest row date means a YNAB balance for an account with no recent activity carries an old date even when it is still correct. The dashboard shows that date honestly. A newer manual observation, or a later export after new activity, supersedes it through the precedence rule.

### Corrections

- **Correct:** a new observation with `supersedes_observation_id` set. It must belong to the same account and supersede the account's current tip for that chain; each observation is superseded at most once (unique), so chains are linear. The replacement may change the amount, the date, or both, and its `source` is `manual`, since the owner is making the correction.
- **Retract:** a row in `balance_observation_retractions`. A retracted observation can't be superseded, a superseded one can't be retracted, and an observation is retracted at most once.
- A retracted `ynab_export` observation isn't recreated by saving the same export again (see Idempotency). The owner re-enters that balance by hand if it was retracted by mistake.

### Idempotency

A unique constraint on `(account_source_id, export_digest)` makes saving the same export's balance twice a no-op, reported as "already saved". A different export is a different digest and records a new observation, even when the amount is unchanged. Manual observations have no natural key; every submission is a new record, and the precedence rule makes a repeated identical entry harmless.

### Current balance and precedence

A security-invoker view, `ledger.current_balances`, returns at most one row per account: among observations that are neither superseded nor retracted, the one with the latest `observed_on`, then the latest `recorded_at`, then the highest `id`. Precedence is by date, not by source. A manual entry dated today beats a YNAB balance dated last week, and the reverse holds too.

### Net worth

Core computes net worth from `current_balances` and current account revisions with `decimal.js`:

- **Included:** accounts whose current status is `active` and that have a current balance. Net worth is the sum of their amounts; the asset and liability subtotals sum by account class.
- **Listed, not summed:** active accounts with no observation ("no balance yet", counted separately so a missing account is never silent) and closed accounts with a nonzero current balance (flagged, since a closed account should be zero).
- **Freshness:** each account shows its `observed_on`, its source, and its age in days. No age threshold hides or excludes a balance.

### Database enforcement

Following the RFC 0005 pattern (`drizzle/0011_solid_tinkerer.sql`):

- Mutation and `TRUNCATE` are rejected by trigger on both tables. The app role gets `SELECT` plus column-scoped `INSERT` without `recorded_at`, and the view is security-invoker.
- A validation trigger enforces the following, taking a transaction-level advisory lock on the account ID before checking tips:
  - the currency matches the account's;
  - the source-specific columns are consistent: `ynab_export` requires `account_source_id` and `export_digest`, and `manual` forbids both;
  - for `ynab_export`, the source is a `ynab` source currently linked to `account_id`;
  - a correction targets an observation of the same account that is neither superseded nor retracted;
  - a retraction targets an observation that isn't superseded.
- The date rule depends on the current time, so the service enforces it, not a `CHECK` constraint. The database enforces everything that doesn't depend on the clock.

### Placement

- **Core** (`src/core/ledger/`): command schemas, the sign conversion, the date rule (with the clock injected), the net-worth calculation, and a persistence port.
- **Infrastructure:** the PostgreSQL adapter.
- **YNAB module:** turns a reviewed export into per-account `ynab_export` commands (balance, latest row date, source, digest). It doesn't write tables itself; it calls the core service, the same way RFC 0005 saves go through RFC 0002 commands.
- **Next.js:** thin adapters only.

## Consequences

- Net worth becomes available without transaction import, and every balance keeps its provenance and date.
- Balance observations and future transactions remain independent streams. Reconciliation (RFC 0004) will compare them rather than replace one with the other.
- Future balance sources extend `source` through an amendment rather than a parallel table.
- When `position_snapshots` arrive, a brokerage account's observation remains the institution's account-level claim. A later RFC decides whether per-instrument positions also produce account totals.

## Open questions

None.
