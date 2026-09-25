---
summary: System diagram, the two data planes, the seven invariants with rationale, balances versus transactions, and why the database comes first
read_when: Designing anything that stores data, choosing between ledger and world schemas, or needing the reasoning behind an invariant
---

# Architecture overview

Formerly `PLAN.md` §2. The binding rule versions of the planes and invariants are in `AGENTS.md`; this document holds the design reasoning.

```
  Aggregators     Market data     News     Manual import
       │               │            │            │
       ▼               └─────┬──────┘            ▼
┌──────────────┐             ▼            ┌──────────────┐
│              │      ┌─────────────┐     │              │
│  PLANE A     │      │  PLANE B    │     │   PLANE A    │
│  ledger.*    │      │  world.*    │     │   ledger.*   │
│              │      │             │     │              │
│  append-only │◀─────│ prices feed │     │              │
│  double-entry│ join │ valuation   │     │              │
│  irreplaceable│     │ disposable  │     │              │
└──────────────┘      └─────────────┘     └──────────────┘
       │                     │
       ├─────────┬───────────┘
       ▼         ▼
┌─────────────┐ ┌──────────────┐
│Derived views│ │Strategy engine│  ◀── reads Plane A + prices only
│ balances    │ │ emits Intents │      NEVER news
│ spending    │ │ never Orders  │
│ performance │ └──────────────┘
│ news feed   │        │
│ goals       │        ▼
└─────────────┘ ┌──────────────┐
                │ Approval +   │
  ledger ◀─fills│ Execution    │
                └──────────────┘
```

## The two data planes

Not all data deserves the same treatment. Same Postgres database, two schemas.

|            | **Plane A — `ledger.*`**                                       | **Plane B — `world.*`**                       |
| ---------- | -------------------------------------------------------------- | --------------------------------------------- |
| Contains   | transactions, entries, positions, lots, intents, orders, goals | prices, news, fundamentals, corporate actions |
| Origin     | your money                                                     | the outside world                             |
| Mutability | append-only, always                                            | append-only for prices; prunable for news     |
| If lost    | catastrophic, unrecoverable                                    | a weekend of refetching                       |
| Backup     | encrypted, off-site, tested restore                            | none required                                 |
| Retention  | forever                                                        | TTL by age                                    |
| Growth     | slow, bounded by your activity                                 | fast, unbounded                               |

`pg_dump --schema=ledger` is the backup that matters, and it stays small forever regardless of how much price history accumulates.

**Boundary cases:**

- A **fill price** is Plane A — it is part of the transaction.
- A **daily close** is Plane B.
- Prices are **bitemporal** (`price_date` + `ingested_at`). A provider revising a historical close must not silently change backtest results.

## The seven invariants

Everything else is negotiable. These are not.

**I1 — Plane A is append-only.** Nothing in `ledger.*` is ever updated or deleted. Corrections are new compensating entries. This is what makes "what was my net worth on March 1" a query rather than a feature you wish you had built.

**I2 — Entries within a transaction sum to zero.** Double-entry. A transfer between own accounts produces no expense entry and therefore can never pollute spending analytics. Enforced by a database constraint and a property test.

**I3 — Strategies are pure.** `Strategy.evaluate()` is a function of `(portfolio_state, price_data, config)` with no I/O, no clock reads, and no randomness. This gives backtesting, dry-run, and the approval queue from the same code path that runs in production.

**I4 — News never reaches the strategy engine.** Mechanically it breaks I3: unbounded, unversioned text cannot be backtested or reproduced. Substantively it changes what is being built — systematic DCA has a small understood failure surface; a news-reactive trading system is a different animal with a different risk profile, and would otherwise get built by accident one reasonable commit at a time. News is a dashboard feature for a human to read.

**I5 — Strategies emit intents; only executors place orders.** Broker write APIs are owned by the execution module. An intent describes a requested action; it is never itself an order.

**I6 — Money is never a float.** PostgreSQL uses `NUMERIC`; TypeScript uses `decimal.js` or validated decimal strings. This applies to intermediate calculations as well as persisted values.

**I7 — Every order has a deterministic, unique idempotency key.** The key is derived from `(strategy_id, period, account_id, instrument_id)` and unique-constrained so rerunning a period cannot place a duplicate order.

## Balances are observations, not state

Two independent streams with different fidelity, and both are needed:

|                      | Source of                   | Coverage                         | Used for                                         |
| -------------------- | --------------------------- | -------------------------------- | ------------------------------------------------ |
| `transactions`       | causal truth                | 12–24 months typical, often less | cost basis, tax lots, contributions, attribution |
| `position_snapshots` | institution's current claim | always available                 | display balances, net worth                      |

Neither replaces the other. Display balance = latest snapshot. Analytics = transactions + a manually-seeded opening position where history runs out.

**The reconciliation loop is the payoff.** Compute expected position from transactions, compare against the reported snapshot, treat the delta as a first-class signal:

- Small persistent drift → an uncaptured fee or dividend
- Sudden step change → corporate action, split, or a dropped transaction
- Any delta on a strategy-managed position → **halt the executor for that account**

## Why the database is not optional

Aggregators return 12–24 months of history and then it is gone. Providers rate-limit, revise, change schemas, and shut down. History not persisted is history that cannot be refetched at any price.

Every month phase 0 is not running is a month of ledger history that is permanently lost. This is the argument for building the schema before any connector works.
