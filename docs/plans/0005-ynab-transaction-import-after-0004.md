---
summary: Plan 0005 (Draft): RFC 0008 rollout unit 2: import YNAB register transactions and categories through the processing and matching engine, with encrypted raw payloads
read_when: Importing YNAB transactions or categories, or resuming the YNAB import work
---

# Plan 0005: YNAB transaction import (after 0004)

- Status: Draft
- Date: 2026-09-27
- Approved: (date, once the owner approves)
- Related RFCs: [RFC 0008](../decisions/0008-cross-source-transaction-matching.md), [RFC 0001](../decisions/0001-phase-0-ledger-schema.md) (category migration policy, raw payloads), [RFC 0005](../decisions/0005-ynab-account-persistence.md)
- Depends on: [Plan 0004](0004-processing-and-matching-engine.md) must be Done.

Sparse draft for tracking. Resume with `/plan-unit 0005` to design it fully.

## Goal

The owner imports a YNAB export at any time; its transactions and categories are recorded once, re-imports are no-ops, and changed rows become new versions.

## Scope

- Seal and store the export as encrypted raw payloads before normalization.
- Record each register row (or split group) as a versioned source record with its account association.
- Seed categories from YNAB groups and categories, keeping historical assignments (RFC 0001 amendment 6).
- Process every row through Plan 0004's engine.
- `/ynab` import action and per-import summary: created, matched, needs review, ignored.
- Detect uncleared rows older than 30 days for the Inbox provider in Plan 0006.

## Non-goals

- YNAB budget data from the Plan CSV (Assigned, Activity, Available, targets).
- Review screens (Plan 0006).
- Changing RFC 0005 account saving.

## Required reading

- RFC 0008, including Evidence and Resolved.
- `src/modules/ynab/import-plan.ts` and `csv.ts`, which already build transaction and category candidates.
- `src/core/ledger/raw-payload.ts` and the raw-payload keyring in `docs/architecture/security-and-keys.md`.

## Decisions already made

- YNAB uncleared rows count. Split-marked rows go to review until a split fixture exists. Payee, memo, flag, and cleared status are provenance only.

## Open questions

- The source_ref for a YNAB row: the existing identity-plus-occurrence digest, or a new one.
- How Starting Balance and balance-adjustment rows post (RFC 0001's system categories).
- How transfers between two YNAB accounts post per side.
- Whether category seeding asks the owner to confirm, or runs automatically.

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
