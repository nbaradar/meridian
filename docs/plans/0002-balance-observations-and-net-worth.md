---
summary: Plan 0002 (Approved): implement RFC 0006 balance observations, manual and YNAB balance entry, corrections, and a net-worth home page
read_when: Implementing or reviewing balance observations or the net-worth dashboard
---

# Plan 0002: Balance observations and net-worth dashboard

- Status: Approved
- Date: 2026-09-25
- Approved: 2026-09-25
- Related RFCs: [RFC 0006](../decisions/0006-balance-observations.md) (the design this plan implements); [RFC 0005](../decisions/0005-ynab-account-persistence.md) and [RFC 0002](../decisions/0002-canonical-account-source-linkage.md) (how a YNAB account resolves to a canonical account)
- Depends on: none (RFC 0006 accepted 2026-09-25)

## Goal

The home page shows the owner's net worth, with assets and liabilities subtotals and every account's current balance, date, source, and age. The owner can record balances by hand, save them from a YNAB export for accounts already saved, and correct or retract a mistaken one.

## Scope

- Migration `0012`: `ledger.balance_observations`, `ledger.balance_observation_retractions`, the `ledger.current_balances` view, and their triggers, locks, and grants, exactly as RFC 0006 specifies.
- Core balance-observation service in `src/core/ledger/`: record manual, record YNAB, correct, retract, list current balances, compute net worth.
- PostgreSQL adapter in `src/infrastructure/database/`.
- YNAB module: a per-account balance claim for each export (amount, date, count of future rows left out) and the register file's SHA-256.
- `/ynab`: a "Save balances" action for accounts in the export that are already saved as tracked, with a result per account.
- `/`: the net-worth dashboard, with manual entry, correct, and retract.
- `/setup`: the existing account and category creation forms and list, moved unchanged from `/`.

## Non-goals

- Anything RFC 0006 lists as a non-goal: positions, prices, reconciliation, live connectors, history charts, non-USD currencies, or grouping by institution.
- Changing any existing `ledger.*` table, view, trigger, or grant. The migration only adds objects.
- Importing transactions, categories, or raw payloads, or writing `ledger.imports`.
- An application shell, persistent navigation, or visual redesign ([UI direction](../architecture/ui.md)). Plain links between `/`, `/setup`, and `/ynab` are enough.
- Changing YNAB account saving, recognition, or the mapping review, beyond adding the balance claim and the new action.
- Editing or retracting any observation other than an account's current one from the UI. The service supports any valid target, but the UI acts only on the current balance.

## Required reading

- [RFC 0006](../decisions/0006-balance-observations.md): the whole thing. It is the contract, and its column names, rules, and messages are binding.
- [RFC 0005](../decisions/0005-ynab-account-persistence.md) and `drizzle/0011_solid_tinkerer.sql`: the pattern to copy for append-only and truncate triggers, the validation trigger with an advisory lock, the security-invoker view, column-scoped `INSERT` grants, and server-owned `recorded_at`.
- `src/infrastructure/database/schema.ts` and `drizzle/meta/`: how Drizzle definitions and hand-written SQL coexist in a migration.
- `src/core/ledger/money.ts` (`decimalAmountSchema`, `sumAmounts`), `timestamps.ts`, and `identifiers.ts`: reuse these for amounts, dates, and IDs. Don't add parallel ones.
- `src/core/ledger/destinations.ts`: account class and status, `listAccounts`, and the service/store/injected-clock pattern to follow.
- `src/core/ledger/account-sources.ts`: how to find the canonical account currently linked to a YNAB `account_source_id`.
- `src/modules/ynab/import-plan.ts` (`accountActivity`, `signedAmount`, `workingBalance`) and `src/modules/ynab/account-decisions.ts`: where the balance claim comes from, and how a tracked decision gives the `account_source_id`.
- `src/app/ynab/actions.ts`, `review-snapshots.ts`, and `ynab-mapping-review.tsx`: the analyze and save flow, the 30-minute snapshot, and per-row results with a manual transition.
- `src/app/page.tsx` and `src/app/manual/`: the current home page, which moves to `/setup`.
- `tests/integration/ynab-account-decisions.test.ts`: the model for integration tests of triggers, grants, and role behavior.

## Decisions already made

- **Scope:** manual entry and YNAB balances are both in this unit. The dashboard replaces the home page, and setup moves to `/setup`.
- **Sign:** amounts are the account's contribution to net worth, so owed debt is negative. For liability-class accounts the manual form asks for "Amount owed", a non-negative number, and stores its negation; entering a credit means a negative amount owed. One core function does the conversion, and `/` shows liabilities as "owed" amounts.
- **YNAB date and amount:**
  - Count only rows dated on or before the latest allowed date (server UTC date plus one day).
  - The amount is their sum, dated at the latest of them.
  - Report later rows as "N future-dated rows not counted". They never block the save.
  - An account with no counted rows gets no observation and shows "no rows to save".
- **YNAB idempotency:** keyed by `(account_source_id, export_digest)`. The digest is the SHA-256 of the register file's bytes as uploaded, computed at analyze time and kept in the review snapshot with the per-account claims. Saving again reports "already saved"; that includes a retracted observation, which is never recreated.
- **YNAB eligibility:** only accounts whose current RFC 0005 decision is `tracked` and whose source is currently linked to a canonical account. Excluded, unsaved, and unlinked accounts are skipped with that reason. Each account saves atomically on its own, so one failure doesn't stop the others.
- **Manual date:** the form's date defaults to the browser's local today. The service rejects anything after the latest allowed date, with a message naming that date.
- **Precedence:** the current balance is the one with the latest `observed_on`, then latest `recorded_at`, then highest `id`, regardless of source. The `ledger.current_balances` view implements this and core reads it; core doesn't re-derive it.
- **Net worth:** computed in core with `decimal.js`, not SQL, so it gets unit and property tests:
  - The sum covers active accounts that have a current balance.
  - Assets and liabilities are subtotalled by account class.
  - Active accounts with no balance are listed with a count.
  - Closed accounts with a nonzero current balance are flagged, not summed.
- **Dashboard grouping:** group by account type, in the order of the account type enum. Within a group, sort by current account name. Show every account: name, balance, as-of date, source (`Manual` or `YNAB export`), and age in days (from the server's UTC date to `observed_on`).
- **Correct and retract:** the dashboard's per-account "Correct" form pre-fills the current amount and date, and submits a superseding manual observation. "Retract" asks for confirmation, then retracts. Afterwards the page shows the next current balance, or "no balance yet".
- **Service boundary:** Next.js server actions parse `FormData` and call the core service; all validation lives in core and the database, not in the actions. The YNAB module builds commands but never writes to tables.
- **Errors carry context:** the account ID and source, and for YNAB the account source ID. Never an account name in a log line.

## Open questions

None.

## Steps

1. Core: add the command schemas, the amount-owed conversion, the latest-allowed-date rule (with the clock injected), the persistence port, the service, and the net-worth calculation. Add unit and property tests.
2. Schema and migration `0012`: Drizzle definitions plus hand-written SQL for triggers, lock function, view, and grants, following migration `0011`. Run `pnpm db:generate` until it reports no drift.
3. PostgreSQL adapter, plus integration tests for every database rule in RFC 0006.
4. YNAB module: build per-account balance claims (latest allowed date injected) and compute the register digest at analyze time. Store both in the review snapshot. Add unit tests.
5. `/ynab`: add the "Save balances" action and its per-account results.
6. Move the current home page to `/setup` unchanged, and build the dashboard at `/` with record, correct, and retract.
7. Update the documentation and complete the Definition of Done.

## Acceptance criteria

- [ ] Migration `0012` creates the two tables and the view with every constraint, trigger, and grant in RFC 0006, and changes nothing that already exists. `pnpm db:generate` reports no drift.
- [ ] `UPDATE`, `DELETE`, and `TRUNCATE` fail on both new tables under the app and owner roles, and the app role cannot set `recorded_at`.
- [ ] The database rejects, with integration tests for each:
  - a currency that differs from the account's;
  - inconsistent source columns (for `manual` or `ynab_export`);
  - a `ynab_export` row whose source isn't a currently linked YNAB source for that account;
  - a correction of a different account's observation, or of one already superseded or retracted;
  - a second retraction, or a retraction of a superseded observation;
  - a duplicate `(account_source_id, export_digest)`.
- [ ] `ledger.current_balances` returns the documented winner for date, `recorded_at`, and `id` ties, and excludes superseded and retracted observations.
- [ ] The service rejects dates after the latest allowed date, and a manual liability entry of amount owed `X` stores `-X`.
- [ ] Net worth, subtotals, the no-balance list, and closed-account flags match RFC 0006 for fixture portfolios, with no JS `number` anywhere in the calculation.
- [ ] Saving YNAB balances records the correct amount and date for each eligible account. Future-dated rows are left out and counted. Running it again reports "already saved" for every account. Ineligible accounts are skipped with their reason.
- [ ] `/` shows net worth, subtotals, and every account, grouped and sorted as decided, with balance, as-of date, source, and age. Recording, correcting, and retracting from `/` update the page.
- [ ] `/setup` offers the same account and category creation as the old `/`, and `/`, `/setup`, and `/ynab` link to each other.

## Tests required

- **Unit, core:**
  - the amount-owed conversion for owed, zero, and credit;
  - the date rule at the boundary: the latest allowed date is accepted, the day after is rejected;
  - command validation.
- **Unit, net worth:**
  - mixed assets and liabilities with fractional cents;
  - accounts without a balance;
  - a closed account with a nonzero balance, and one with zero;
  - an `other`-type account with an explicit class.
- **Property:** net worth equals the sum of the included amounts, and doesn't depend on input order.
- **Unit, YNAB:**
  - a balance claim that excludes future-dated rows and counts them;
  - the date is the latest counted row;
  - no claim for an account with no counted rows;
  - the register digest is stable for identical bytes.
- **Integration:** every database rule in the acceptance criteria; view precedence and exclusions; saving YNAB balances twice (the replay no-op); a retracted YNAB observation isn't recreated.
- **Architecture:** the existing checks still pass. No Next.js import in core or modules, and no module imports another module.

## Verification

```bash
pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build
pnpm test:integration
pnpm db:generate        # expect no drift
```

Then apply the migration to the local database (`pnpm db:migrate`) and check that `/`, `/setup`, and `/ynab` render. If you can't do a browser run-through of recording, correcting, and retracting a balance and of saving YNAB balances, say so in the Completion record. Don't record real balances in the owner's database.

## Documentation to update

- [ ] [docs/status.md](../status.md) (replace) and [docs/history.md](../history.md) (one entry)
- [ ] [RFC 0006](../decisions/0006-balance-observations.md): add `Implemented:` with the migration name. Update its row in [decisions/README.md](../decisions/README.md) to "Accepted, implemented".
- [ ] [ledger model](../architecture/ledger-model.md): add the two tables and the view to the Plane A inventory, and note that `position_snapshots` remain per-instrument Phase 2 work.
- [ ] [README.md](../../README.md): the net-worth row in "What works today", the move of setup to `/setup`, and a short "Using the current screens" note on recording and correcting balances.
- [ ] `AGENTS.md`: add RFC 0006 to the "Balances, reconciliation…" routing row.

## Stop and ask if

- Any RFC 0006 rule can't be enforced as written, for example a view precedence or trigger rule that PostgreSQL can't express without mutating state.
- The migration seems to need a change to an existing table, view, trigger, or grant.
- A YNAB balance computed here differs from the working balance `/ynab` already shows for the same export. The two must agree.
- Resolving a tracked YNAB source to its canonical account needs anything beyond the existing RFC 0002 link state.
- The UI work starts turning into navigation or shell design.

## Completion record

When Done: date, verified counts, deviations and why, what was not verified, follow-ups.
