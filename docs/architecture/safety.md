---
summary: Execution-path safety rules and the full safety architecture: idempotency, kill switch, ceilings, gates, audit, news quarantine, secrets, ingress, backups
read_when: Any work on execution, orders, strategies, broker credentials, backups, or network exposure
---

# Safety

## Safety rules for the execution path (from `AGENTS.md`)

Anything under `src/modules/execution/` is held to a higher standard.

- Never disable, weaken, or add a bypass to the kill switch, notional caps, order-count limits, instrument allowlist, reconciliation gate, or stale-data gate. If a task seems to require it, stop and ask.
- Never place a live order from a test, script, migration, or seed file. Paper environments only.
- Live and paper credentials are separate. Never fall back between them on error — fail closed.
- Every intent, approval, rejection, order, fill, and error is written to the audit trail with a reason string.
- Read-only credentials are the default. Write credentials load only in the execution worker process, never in `web`.
- If a failure mode is "duplicate purchase," it needs an idempotency key. If it is "unbounded loop," it needs a hard ceiling.

## Safety architecture (formerly `PLAN.md` §7)

The highest-stakes software that will run on this host. Requirements, not suggestions.

### Execution

- **Read-only by default.** Write credentials load only in the execution worker process, never in `web`.
- **Every order carries a client-generated idempotency key**, unique-constrained in the database, derived from `(strategy_id, period, account_id, instrument_id)`. A duplicate run must be physically incapable of double-buying.
- **Kill switch.** One flag halting all execution, checked before every order, trippable from UI and CLI.
- **Hard ceilings, not config.** Max orders/day, max notional/order, max notional/week.
- **Instrument allowlist.** The executor refuses anything not explicitly enumerated.
- **Reconciliation gate.** Expected position vs. reported snapshot disagreeing beyond tolerance halts execution for that account until acknowledged.
- **Stale data gate.** Refuse to act on price data older than N minutes.
- **Full audit trail.** Every intent, approval, rejection, order, fill, and error written to Plane A with a reason.

### Separation of concerns

- **News is quarantined from `strategies` and `execution`** (I4). Enforced by lint rule: neither module may import from `news`, and `StrategyContext` has no field that could carry article data.

### Infrastructure

- **Secrets encrypted at rest.** Provider tokens sealed with a key from the environment (libsodium/age), never plaintext in the database, never in git.
- **No public ingress.** Tailscale or equivalent. Do not roll a login page for a system that can move money. Revisiting this belongs to the [expansion decision](../future/expansion.md).
- **Backups from day one.** `pg_dump --schema=ledger`, age-encrypted, pushed off-box, automated, with a restore that has actually been executed at least once.
