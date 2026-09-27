---
summary: Plan 0007 (Draft): The worker process, pg-boss scheduling, and the provider-neutral ingestion orchestrator that retains raw payloads and processes observations with fenced checkpoints
read_when: Building the worker, scheduling syncs, or the connector ingestion path
---

# Plan 0007: Sync worker and ingestion orchestrator (after 0004)

- Status: Draft
- Date: 2026-09-27
- Approved: (date, once the owner approves)
- Related RFCs: [RFC 0003](../decisions/0003-operational-live-connections.md), [RFC 0008](../decisions/0008-cross-source-transaction-matching.md) (Ingestion and checkpoints), [technology](../architecture/technology.md) (pg-boss, two processes)
- Depends on: [Plan 0004](0004-processing-and-matching-engine.md) must be Done.

Sparse draft for tracking. Resume with `/plan-unit 0007` to design it fully.

## Goal

A `worker` process runs scheduled, fenced sync jobs that turn connector observations into processed ledger records without any connector touching persistence.

## Scope

- `pnpm worker` process with pg-boss.
- Orchestrator: seal raw payload, then atomically record source records, association, processing, and the checkpoint cursor with its fencing token.
- Enable non-discovery checkpoint feeds (`transactions`, later `balances`) in `ops.*` under RFC 0003's rules.
- A fake connector with recorded fixtures to prove the path end to end.
- Architecture test that connectors cannot bypass the processing service.

## Non-goals

- Any real provider (Plans 0008, 0009).
- Web connection workflow.
- Hosting or unattended deployment.

## Required reading

- RFC 0003 in full, especially checkpoints, leases, and roles.
- RFC 0008 Ingestion and checkpoints, and Concurrency and locking.
- `src/infrastructure/database/postgres-connections.ts`.

## Decisions already made

- pg-boss and two processes (`web`, `worker`) are already chosen in `docs/architecture/technology.md`.

## Open questions

- Job schedule defaults (sync frequency).
- Whether this unit needs an RFC 0003 amendment to enable non-discovery feeds.
- How balance feeds wait for the connector-balance RFC (see Plan 0008).

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
