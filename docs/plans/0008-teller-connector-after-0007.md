---
summary: Plan 0008 (Draft): First live connector per RFC 0007: Teller Connect setup, discovery and mapping, and transaction and balance feeds through the ingestion orchestrator
read_when: Building the Teller connector or the first live-connection setup flow
---

# Plan 0008: Teller connector (after 0007)

- Status: Draft
- Date: 2026-09-27
- Approved: (date, once the owner approves)
- Related RFCs: [RFC 0007](../decisions/0007-free-first-provider-selection.md), [RFC 0003](../decisions/0003-operational-live-connections.md), [RFC 0008](../decisions/0008-cross-source-transaction-matching.md), [RFC 0006](../decisions/0006-balance-observations.md)
- Depends on: [Plan 0007](0007-sync-worker-and-ingestion-after-0004.md) must be Done. **Also needs an RFC to draft first:** connector balance sources, amending RFC 0006 (new `source` values, `source_ref`, raw-payload link).

Sparse draft for tracking. Resume with `/plan-unit 0008` to design it fully.

## Goal

The owner connects a bank through Teller, maps its accounts to canonical accounts, and its transactions and balances flow in and match against YNAB history.

## Scope

- Teller module behind `ReadConnector` with recorded, redacted fixtures.
- Web connection workflow: Teller Connect enrollment and mapping, with credentials encrypted under RFC 0003.
- Transactions and balances feeds, with pending rows handled per RFC 0008.
- Provider balance semantics reviewed from a fixture before any comparison is trusted.

## Non-goals

- Plaid or any other provider.
- Brokerage accounts (Teller does not cover them).

## Required reading

- RFC 0007, RFC 0003 provider safety, and Teller's documentation.
- Owner's coverage checks in `local/institutions.md`.

## Decisions already made

- Teller first for banks and cards; development environment (free, 100 enrollments); never store bank logins.

## Open questions

- Coverage of each of the owner's banks (to check before planning).
- The connector-balance RFC's details.
- How Teller's mTLS client certificate is stored (a new key class?).

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
