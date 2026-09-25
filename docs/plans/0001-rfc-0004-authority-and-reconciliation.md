---
summary: Plan 0001 (Draft): RFC 0004 rollout unit two, transaction-authority windows and immutable reconciliation checks with read-only evaluation and no processing or monetary writes
read_when: Resuming the RFC 0004 rollout, or working on authority windows, reconciliation checks, or the YNAB-to-live cutover
---

# Plan 0001: RFC 0004 authority windows and reconciliation checks

- Status: Draft
- Date: 2026-09-25
- Approved: not yet
- Related RFCs: [RFC 0004](../decisions/0004-transaction-source-authority.md) (primary), [RFC 0002](../decisions/0002-canonical-account-source-linkage.md), [RFC 0003](../decisions/0003-operational-live-connections.md)
- Depends on: RFC 0004 rollout unit one (done). Scheduled after the balance observations work and account details store; see [status.md](../status.md).

## Goal

Meridian can record, per canonical account, which source is authoritative for its `transactions` feed over explicit date windows, and can record immutable reconciliation evidence that gates live activation. Nothing is processed or written as money.

## Scope

- A new migration adding append-only `ledger.transaction_authority_revisions` and `ledger.reconciliation_checks`, with current read models.
- Core commands and services for proposing, activating, revoking, and resolving authority, and for recording reconciliation checks.
- A PostgreSQL adapter for those commands, plus provider-independent, read-only authority evaluation.
- Database enforcement of every rule listed under Acceptance criteria.

## Non-goals

- Processing revisions, processing-authority evidence, and authority exceptions (`source_record_processing_revisions`, `processing_authority_evidence`, `source_authority_exceptions`).
- Changing `transactions.source_record_id` cardinality or normalizing any source record.
- Importing YNAB transactions or any other monetary write.
- Enabling `transactions`, `balances`, or `positions` checkpoints, or calling any provider.
- Guessing provider balance semantics or tolerances.

## Required reading

- [RFC 0004](../decisions/0004-transaction-source-authority.md): Authority Windows, Authority Evaluation, Reconciliation Gate, Concurrency And Locking, Database Enforcement, Required Tests, and Migration And Rollout.
- [RFC 0002](../decisions/0002-canonical-account-source-linkage.md): link revisions and the current-link view that activation must prove against.
- `drizzle/0009_jittery_thunderbird.sql` and `drizzle/0010_modern_nehzno.sql`: the advisory-lock functions and append-only/`TRUNCATE` patterns to reuse.
- `src/infrastructure/database/postgres-source-record-associations.ts` and its integration tests: the closest existing adapter and test style.
- [Ledger model](../architecture/ledger-model.md): data conventions for dates and amounts.

## Decisions already made

- Authority is per canonical account and per `transactions` feed.
- Windows are explicit half-open `[starts_on, ends_on)` ranges over `occurred_on` calendar dates.
- All records are append-only; proposal, activation, and revocation are explicit and replay-safe.
- Activation proves the account source's exact current RFC 0002 link and serializes with relinks and competing authority decisions using RFC 0004's global advisory-lock order.
- Live activation requires immutable, passing reconciliation evidence.
- Reconciliation amounts, differences, and tolerances are canonical decimal strings at boundaries and `NUMERIC` in PostgreSQL. No JavaScript `number` is involved.
- A provider balance semantic or tolerance not proven by a redacted fixture produces `not_comparable`, which cannot activate a live window.
- Accepted migrations are never edited; this unit adds a new one.

## Open questions

- **Starting migration.** The source handoff says to start after `0010_modern_nehzno.sql`, but `0011_solid_tinkerer.sql` (RFC 0005) now exists. Confirm the new migration simply follows `0011`.
- **"Persist YNAB" non-goal.** RFC 0005 now persists YNAB _account decisions_. Confirm this unit's non-goal means YNAB transaction and source-record persistence only.
- **Scheduling.** The owner placed this unit after the balance observations work and the account details store. Confirm the order before approval, since balance observations may inform reconciliation inputs.

## Steps

1. Re-read the RFC 0004 sections under Required reading and resolve the open questions with the owner.
2. Add the Drizzle table definitions and generate the migration; append hand-written SQL for transition validation, overlap rejection, locks, append-only and `TRUNCATE` rejection, current views, and grants.
3. Add core commands, types, errors, and services in `src/core/ledger/`.
4. Add the PostgreSQL adapter with replay handling and error mapping.
5. Add read-only authority evaluation that cannot reach transaction recording.
6. Write the tests listed below, then run Verification.
7. Complete the Definition of Done in `AGENTS.md` and fill in the Completion record.

## Acceptance criteria

- [ ] PostgreSQL, not only TypeScript, prevents branching authority chains.
- [ ] PostgreSQL prevents overlapping current active windows, including under concurrency.
- [ ] PostgreSQL rejects invalid status transitions.
- [ ] Activation against a stale or relinked account source is rejected.
- [ ] Failed or `not_comparable` reconciliation blocks live activation.
- [ ] Reconciliation checks are immutable once recorded.
- [ ] Owner and runtime roles cannot mutate or `TRUNCATE` the new tables; runtime grants are minimal.
- [ ] Exact replays are no-ops; conflicting replays fail.
- [ ] An architecture test proves read-only evaluation cannot record a transaction.

## Tests required

- Half-open cutoff selection.
- Overlap rejection under concurrency.
- Activation-versus-relink serialization.
- Immutable reconciliation evidence.
- Large and fractional decimal arithmetic without JavaScript numbers.
- Failed and non-comparable reconciliation blocking live activation.
- Exact replay.
- Append-only behavior and role grants.
- Confirmation that no transaction can be written through this service.

## Verification

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm db:generate   # expect no drift after committing generated metadata
pnpm build
```

## Documentation to update

- [ ] [docs/status.md](../status.md): replace the current state, including verified counts and the next remaining RFC 0004 rollout unit
- [ ] [docs/history.md](../history.md): one dated entry
- [ ] [RFC 0004](../decisions/0004-transaction-source-authority.md) Implementation Status section
- [ ] [Ledger model](../architecture/ledger-model.md), if the conceptual table list changes
- [ ] `AGENTS.md`, only if a rule or the routing table changed

## Stop and ask if

- Any RFC 0004 rule cannot be enforced in PostgreSQL as written.
- A provider balance semantic or tolerance seems to need a guess.
- The work appears to require any item under Non-goals.

## Completion record

Not started.

## Source handoff (verbatim)

Moved from [status.md](../status.md), which held the handoff before plans existed. It was originally in `AGENTS.md` and `PLAN.md` §9. The structured sections above are derived from it.

### From `AGENTS.md`

**RFC 0004 rollout unit two (agent handoff; now step 4 of the revised priority above).** There is no partially implemented runtime workflow to finish before this unit. Start from migration `0010_modern_nehzno.sql` and the accepted design in `docs/decisions/0004-transaction-source-authority.md`; add a new migration rather than editing accepted migration history. Scope this unit to append-only transaction-authority window revisions, immutable reconciliation checks, current read models, and provider-independent read-only authority evaluation. Keep proposal, activation, and revocation explicit and replay-safe; use half-open `occurred_on` date ranges, canonical decimal-string command inputs with PostgreSQL `NUMERIC`, exact current RFC 0002 link proof, passing reconciliation for live activation, and the RFC's global advisory-lock order. PostgreSQL, not only TypeScript, must prevent branching authority chains, overlapping current active windows, invalid status transitions, activation against a stale/relinked account source, and owner/runtime mutation or `TRUNCATE`.

Do not add processing revisions, processing-authority evidence, exceptions, change `transactions.source_record_id` cardinality, normalize a source record, persist YNAB, enable `transactions|balances|positions` checkpoints, call a provider, or write monetary facts in rollout unit two. A provider balance semantic or tolerance not proven by a redacted fixture must produce `not_comparable`; do not guess it or activate a live window. Required boundary tests include half-open cutoff selection, overlap rejection under concurrency, activation-versus-relink serialization, immutable reconciliation evidence, large/fractional decimal arithmetic without JavaScript numbers, failed/non-comparable reconciliation blocking live activation, exact replay, append-only/role grants, and confirmation that no transaction can be written through this service. Finish with `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:integration`, `pnpm db:generate` (expect no drift after committing generated metadata), and `pnpm build`, then update this handoff with verified counts and the next remaining rollout unit.

### From `PLAN.md` §9

**RFC 0004 rollout unit two (step 4 of the revised priority), authority and reconciliation without processing.** Begin with a new migration after `0010_modern_nehzno.sql`. Implement the accepted `ledger.transaction_authority_revisions` and `ledger.reconciliation_checks` boundary, current read models, core commands/services, and a PostgreSQL adapter for proposing, activating, revoking, resolving, and read-only evaluation. Authority is per canonical account and `transactions` feed, uses explicit half-open `[starts_on, ends_on)` calendar-date windows, and remains append-only. Activation must prove the account source's exact current canonical link, serialize with relink and competing authority decisions using the RFC 0004 lock order, reject overlapping active windows under concurrency, and require immutable passing reconciliation evidence for a live connector. Reconciliation amounts, differences, and tolerances use canonical decimal strings at boundaries and `NUMERIC` in PostgreSQL; no JavaScript `number` participates. Provider balance semantics and tolerance remain fixture-reviewed policy, so unknown semantics produce `not_comparable` and cannot activate live authority.

This unit stops before `source_record_processing_revisions`, `processing_authority_evidence`, `source_authority_exceptions`, changes to source-record/transaction cardinality, transaction normalization, YNAB persistence, connector calls, non-discovery checkpoint feeds, or any monetary write. Its done condition is fresh-schema and concurrency coverage for linear authority chains, half-open cutoff behavior, non-overlap, activation-versus-relink, replay, immutable reconciliation, failed/non-comparable activation rejection, exact decimal handling, restricted grants, append-only/`TRUNCATE` enforcement, and an architecture boundary proving read-only evaluation cannot record a transaction. Run the complete formatting, lint, typecheck, infrastructure-independent test, disposable PostgreSQL integration, schema-drift, and production-build suite before advancing to RFC 0004 rollout unit three.
