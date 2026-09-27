---
summary: Plan 0011 (Draft): User-entered account details in app.*: plaintext institution name for grouping, and encrypted, masked account and routing numbers
read_when: Building the account details store, institution grouping, or storing account and routing numbers
---

# Plan 0011: Account details store

- Status: Draft
- Date: 2026-09-27
- Approved: (date, once the owner approves)
- Related RFCs: [RFC 0009](../decisions/0009-inbox.md) (`app.*`); [future expansion](../future/expansion.md#deferred-feature-user-entered-account-details) (intended design)
- Depends on: **An RFC to draft first:** the account-details RFC that the expansion design calls for (keyring, schema, reveal rules). Scheduled after [Plan 0008](0008-teller-connector-after-0007.md), but not technically dependent on it.

Sparse draft for tracking. Resume with `/plan-unit 0011` to design it fully.

## Goal

The owner records each account's institution and its account and routing numbers; the dashboard groups by institution; numbers are masked by default and never leak.

## Scope

- `app.*` table keyed by canonical account ID, sensitive fields encrypted with a dedicated keyring.
- Edit and explicit-reveal UI; masked by default.
- Dashboard grouping by institution, composed at the presentation layer.
- Tests that plaintext never reaches logs, unencrypted columns, fixtures, or exports.

## Non-goals

- Using details for connector identity or account linking.
- Multi-user support.

## Required reading

- `docs/future/expansion.md` deferred-feature section.
- `docs/architecture/security-and-keys.md` and the existing keyrings in `src/infrastructure/protected-data/`.

## Decisions already made

- Stored in `app.*` with encrypted fields; ledger code never reads it (owner, 2026-09-27).

## Open questions

- Which fields besides institution, account number, and routing number (contact details, notes).
- Key rotation procedure.

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
