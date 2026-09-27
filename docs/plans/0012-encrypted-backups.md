---
summary: Plan 0012 (Draft): Automated, age-encrypted, off-box backups of ledger and app, the separate encrypted ops backup, and an executed restore
read_when: Building backups or restore, or completing Phase 0
---

# Plan 0012: Encrypted backups and a tested restore

- Status: Draft
- Date: 2026-09-27
- Approved: (date, once the owner approves)
- Related RFCs: [safety](../architecture/safety.md) (backup rule), [RFC 0003](../decisions/0003-operational-live-connections.md) (Backup and recovery), [RFC 0009](../decisions/0009-inbox.md) (`app.*`)
- Depends on: none. The owner chose to do this later; it completes Phase 0 together with Plan 0005.

Sparse draft for tracking. Resume with `/plan-unit 0012` to design it fully.

## Goal

A scheduled job produces encrypted off-box backups, and a restore has actually been performed and verified.

## Scope

- `pnpm db:backup`: one encrypted dump of `ledger.*` and `app.*`, and a separate encrypted `ops.*` dump.
- Off-box destination and retention.
- A restore procedure and a test that performs it into a disposable database and compares contents.
- Documentation of keys needed to restore (the `.env` keyrings).

## Non-goals

- Backing up `world.*`.
- Hosting decisions beyond where backups go.

## Required reading

- `docs/architecture/safety.md`, RFC 0003 Backup and recovery, `docs/architecture/hosting.md`, and `docs/architecture/security-and-keys.md`.

## Decisions already made

- Scope: `ledger.*` plus `app.*` together, `ops.*` separately, `world.*` never (owner, 2026-09-27).

## Open questions

- Off-box destination (cloud bucket, another machine, external drive).
- Schedule and retention.
- Where the age key lives.

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
