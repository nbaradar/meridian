---
summary: Plan 0010 (Draft): Provider-neutral CSV and OFX/QFX statement import through the processing and matching engine, the universal fallback in RFC 0007
read_when: Importing statement files from any institution
---

# Plan 0010: Manual file import, CSV and OFX (after 0004)

- Status: Draft
- Date: 2026-09-27
- Approved: (date, once the owner approves)
- Related RFCs: [RFC 0007](../decisions/0007-free-first-provider-selection.md), [RFC 0008](../decisions/0008-cross-source-transaction-matching.md), [RFC 0002](../decisions/0002-canonical-account-source-linkage.md)
- Depends on: [Plan 0004](0004-processing-and-matching-engine.md) must be Done.

Sparse draft for tracking. Resume with `/plan-unit 0010` to design it fully.

## Goal

The owner uploads a statement file for any account whenever they like; new transactions are added and duplicates against YNAB or a live feed are matched.

## Scope

- One importer per format (OFX/QFX, CSV with a saved column mapping per account).
- Registry values for file sources (the existing `manual_csv`, plus an OFX value).
- Raw payload retention and processing through Plan 0004.

## Non-goals

- Browser automation of any kind (RFC 0007).
- Institution-specific scrapers.

## Required reading

- RFC 0007 decision 1.4 and RFC 0008 matching rules.

## Decisions already made

- One importer per format, not per institution.

## Open questions

- Which formats the owner's institutions offer (OFX, QFX, CSV).
- Stable source_ref for CSV rows without IDs.
- Whether a column-mapping per account is stored in `app.*`.

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
