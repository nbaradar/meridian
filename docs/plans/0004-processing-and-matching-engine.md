---
summary: Plan 0004 (Draft): RFC 0008 rollout unit 1: processing revisions, the pure matching engine, review state, reclassification transactions, and balance-check computation; no import
read_when: Designing or implementing processing revisions, cross-source matching, review state, reclassification, or balance checks
---

# Plan 0004: Processing revisions and matching engine

- Status: Draft
- Date: 2026-09-27
- Approved: (date, once the owner approves)
- Related RFCs: [RFC 0008](../decisions/0008-cross-source-transaction-matching.md) (primary), [RFC 0001](../decisions/0001-phase-0-ledger-schema.md) (as amended by RFC 0008), [RFC 0006](../decisions/0006-balance-observations.md)
- Depends on: none. RFC 0008 was accepted 2026-09-27. Independent of Plan 0003.

Sparse draft for tracking. Resume with `/plan-unit 0004` to design it fully.

## Goal

Meridian can decide, for any observation from any source, whether it creates a transaction, matches an existing one, or needs review, and record that decision append-only. Nothing is imported yet.

## Scope

- Migration: `ledger.source_record_processing_revisions` with statuses `created`, `matched`, `needs_review`, `ignored`, and `retracted`; drop `transactions.source_record_id` uniqueness; add the deferred rule that every external transaction has a current `created` or `matched` revision; the reclassification transaction kind (RFC 0001 amendment 4).
- PostgreSQL enforcement of RFC 0008's rules: linear chains, at most one current observation per source per transaction, status-consistent references, exact reversal, and the global lock order.
- Pure core matching function (D = 5 days, 10-day review band, one-to-one nearest-date pairing, near misses, late candidates) with property tests.
- Core balance-check computation against RFC 0006 observations.
- Processing and reclassification services with a PostgreSQL adapter.

## Non-goals

- Any importer or connector (Plans 0005, 0007).
- Any UI, including review screens (Plan 0006).
- Transfer pairing.

## Required reading

- RFC 0008 in full, especially Design, Carried forward, and Database enforcement.
- RFC 0001 amendments.
- Migrations `0009` and `0010` (association) and `0012` (balance observations): trigger, lock, and grant patterns.
- `src/core/ledger/transaction.ts` and `source-record-associations.ts`.

## Decisions already made

- Everything resolved in RFC 0008: D = 5 days with a 10-day review band, pending connector rows ignored with reason `pending`, a connector's posted date wins, category changes are reclassifications, and split-marked YNAB rows go to review.

## Open questions

- Exact table and column names for processing revisions and candidate records.
- Whether candidate sets for `needs_review` are stored as rows or computed on review.
- How the matching engine receives candidates: a query shape and its indexes.
- Whether balance checks run on demand only or also get a recorded snapshot.

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
