# AGENTS.md

Working contract for coding agents on Meridian, a self-hosted single-user financial dashboard. Loaded on every task: it holds the rules that always apply and a map to everything else. Open mapped documents only when the task needs them.

## Where to look

Paths are relative to the repository root.

| Working on… | Read first |
|---|---|
| What to build next | `docs/status.md`, then the plan it names |
| Designing a unit of work | `docs/plans/README.md`, `docs/plans/TEMPLATE.md` |
| Implementing an approved plan | the plan and its Required reading, then Workflow below |
| YNAB import, account mapping, saved YNAB accounts | `docs/decisions/0002-canonical-account-source-linkage.md`, `docs/decisions/0005-ynab-account-persistence.md`, `docs/architecture/ledger-model.md` |
| Ledger schema, money, transactions, categories, ingesting external data | `docs/architecture/ledger-model.md` (includes data conventions), `docs/decisions/0001-phase-0-ledger-schema.md`, `docs/architecture/overview.md` |
| Connectors, sync, discovery, provider credentials, anything institution-specific | `docs/institutions.md` (which can trade, which APIs are forbidden), `docs/decisions/0003-operational-live-connections.md`, `docs/decisions/0004-transaction-source-authority.md` |
| Balances, reconciliation, transaction authority, YNAB cutover | `docs/decisions/0004-transaction-source-authority.md`, `docs/architecture/overview.md` |
| Modules, interfaces, where code belongs | `docs/architecture/modules.md` |
| Keys, secrets, encryption | `docs/architecture/security-and-keys.md` |
| Execution, orders, strategies, broker credentials, backups, exposure | `docs/architecture/safety.md`, required before touching `src/modules/execution/` |
| Dependencies and technology choices | `docs/architecture/technology.md` |
| Pages, navigation, UI | `docs/architecture/ui.md` |
| Deployment and hosting | `docs/architecture/hosting.md` |
| Other users, authentication, sharing, account/routing numbers | `docs/future/expansion.md`, whose rules apply to that work |
| Vision, phases, open decisions | `PLAN.md` |
| Local setup, migration, or `.env` failures | `README.md`, Troubleshooting section only |
| Why or when something was built | `docs/history.md`, then `git log` |
| The owner's actual institutions, accounts, goals, notes | `local/` if present: a private, gitignored companion repository; absent on other clones |
| Anything else | `docs/README.md`, the full index |

`README.md` is written for the owner, not agents. Read it only for the troubleshooting row above, or when asked to update it or the Definition of Done requires it.

## What this system is

One append-only double-entry ledger with independent modules on top. It consolidates bank, brokerage, and crypto accounts; tracks spending by category; ingests market data and news; and defines, simulates, and eventually executes systematic investment strategies.

**It moves real money.** Correctness beats velocity. When in doubt, do the safe thing and leave a `TODO` with a question rather than guessing.

### Product scope: personal now, extensible by design

Built for the owner today: scope implementations to their actual institutions, accounts, and workflows, and build nothing nobody needs yet. The owner may later share it, so the *architecture* must not assume one person's setup.

- **Canonical accounts come first; connectors attach later.** Accounts from YNAB import or manual creation are the canonical identities that live connectors later link to (RFC 0002 linkage, RFC 0003 discovery). Never create a parallel account identity per connector.
- **Every institution has a fallback.** A missing connector never blocks an account from the dashboard; manual entry and file import stay first-class, and the UI shows each account's source (offline, import-only, live-linked) and freshness.
- **Connectors are plug-ins.** Provider behavior stays in its module behind `ReadConnector` and the checked source registry; a new institution must not require changing core ledger semantics. An unsupported institution is a known state, not an error.
- **No personal specifics in the repository, which is public.** The owner's institution names, account names, amounts, and goals belong in data and the gitignored `local/` directory, never in source, docs, fixtures, or defaults. Provider names a connector targets (Schwab, SimpleFIN) are fine; which accounts the owner holds is not.

## The two data planes

Two Postgres schemas, different rules; confusing them is a defect.

- **`ledger.*` (Plane A):** your money — transactions, entries, positions, lots, intents, orders, goals. Append-only, irreplaceable, backed up.
- **`world.*` (Plane B):** the outside world — prices, corporate actions, fundamentals, news. Refetchable, disposable, not backed up.

Rules:

- Never write financial facts to `world.*` or external market data to `ledger.*`. A **fill price is Plane A**; a **daily close is Plane B**.
- `world.prices` is bitemporal (`price_date` + `ingested_at`) and append-only: a revised historical close is a new row, never an update, so backtests don't silently change.
- `world.news_*` is the only mutable/prunable data.
- Anything added to `ledger.*` must be worth backing up forever; otherwise it belongs in `world.*`.

## Non-negotiable invariants

Violating one is a defect whatever the task says. If a request appears to require it, stop and flag it.

- **I1 — `ledger.*` is append-only.** No `UPDATE` or `DELETE`. Corrections are new compensating entries referencing the original. Migrations adding a mutation path are rejected.
- **I2 — Entries within a transaction sum to zero.** Enforced by a DB constraint and a property test. No escape hatch.
- **I3 — Strategies are pure.** `Strategy.evaluate()` does no I/O, clock reads, or randomness; everything arrives in `StrategyContext`, and the scheduler passes the period in.
- **I4 — News never reaches strategies or execution.** `strategies` and `execution` may not import `news` (lint-enforced), and `StrategyContext` has no field that can carry article text, sentiment, or headlines. News-driven trading is out of scope: stop if asked.
- **I5 — Strategies emit intents; only executors place orders.** No module outside `src/modules/execution/` calls a broker write API.
- **I6 — Money is never a float.** `NUMERIC` in Postgres; `decimal.js` or decimal strings in TypeScript. Never a JS `number` or `parseFloat` for an amount or quantity, including intermediate calculations in tests.
- **I7 — Every order carries a unique idempotency key**, derived from `(strategy_id, period, account_id, instrument_id)` and unique-constrained, so a re-run cannot place a duplicate order.

## Module contract

- Modules live in `src/modules/<name>/` and register a `ModuleDefinition` (connectors, market data providers, news sources, strategies, executors, routes, jobs, widgets, tables).
- **Modules must not import from other modules.** Cross-module needs go through the ledger or `src/core/`; promote shared code to core. Raise a proposed exception as a design smell; don't resolve it unilaterally.
- Module-owned tables are prefixed with the module id. Module code never modifies core tables.
- Connectors declare `capabilities` (`balances`, `transactions`, `positions`, `trade`). **Never assume an account can trade**; check capabilities and degrade the UI gracefully.
- **Framework rule:** `src/core/` and `src/modules/` import nothing from Next.js. Route handlers and server components are thin adapters over the service layer that the CLI and MCP server also use; business logic in them is a defect. This keeps the framework choice reversible.

### Maintainability and coherence

Meridian is one system, not locally convenient features. New work fits the existing domain language, plane boundaries, module contract, and service abstractions before adding a pattern.

- Prefer a few explicit, reusable abstractions over feature-specific plumbing. Reuse a boundary that expresses the same concept; add one only for a real, documented distinction.
- One canonical representation per domain concept; no parallel money, account, instrument, provider, error, or time models.
- Shared domain policy in `src/core/`, provider details in their module, `src/app/` for presentation only. No generic helpers that erase domain meaning.
- Readable call sites: names match `PLAN.md` vocabulary, invariants show in types and constraints, exceptional behavior is explicit.
- Cohesive, reviewable units: one responsibility, tests at the changed boundary, documentation updated with architectural changes.
- Follow established TypeScript, database, and security practice unless a documented Meridian constraint says otherwise; record exceptions and their rationale.
- Remove duplication when ownership is clear, but create no speculative abstractions; a shared abstraction represents a stable domain idea.
- Optimize for the next maintainer diagnosing a financial discrepancy: straightforward control flow, determinism, contextual errors, no hidden coupling.

If a feature doesn't fit cleanly, clarify ownership and boundaries before coding. An isolated implementation that weakens the design is not progress.

## Workflow

The owner and an agent design together; an agent then implements alone because the plan holds everything it needs.

1. **Design.** If the unit changes a core `ledger.*` boundary or another architectural decision, write an RFC in `docs/decisions/` (see its `README.md`) and get it accepted first.
2. **Plan.** Write a plan from `docs/plans/TEMPLATE.md`. It is **Approved** only when the owner approves it and it has no open questions.
3. **Implement.** Only Approved plans. Set it **In progress** and link it from `docs/status.md`. Follow its Decisions already made without re-asking, treat its Non-goals as hard boundaries, and stop under its "Stop and ask if" conditions and "When to stop and ask" below. A small change may proceed without a plan, but the Definition of Done still applies.
4. **Finish.** Complete the Definition of Done before reporting done.

Skills in `.claude/skills/`: `/plan-unit` (stage 2), `/implement-plan` (stages 3–4), `/project-status` (short status report).

### Definition of Done

Report any item not completed, and why; never skip one silently.

- [ ] Every plan acceptance criterion is met and checked off.
- [ ] `pnpm format:check`, `lint`, `typecheck`, `test`, and `build` pass; `test:integration` too when the database is touched; `db:generate` shows no drift when the schema changed.
- [ ] Every document in the plan's "Documentation to update" is updated.
- [ ] `docs/status.md` is replaced (not appended) with the new state, verified counts, and next plan.
- [ ] `docs/history.md` has one new dated entry.
- [ ] `README.md` is updated if a capability, setup step, or known problem changed.
- [ ] The plan is **Done**, with a Completion record: date, verified counts, deviations, follow-ups.
- [ ] Anything unverified (e.g. a UI flow not tried in a browser) is stated in the Completion record and the final report.

### Documentation discipline

Every fact has one owning document; update the owner and link to it instead of copying.

- **Design changes:** update the owning architecture doc or RFC. Accepted RFCs are not rewritten; a changed decision gets a new RFC that supersedes the old one.
- **This file:** change only when a rule or the routing table changes.
- **New documents:** start with `summary` and `read_when` front matter, add an entry to `docs/README.md` (plans go in `docs/plans/README.md`), and add a routing row above if it is a primary entry point. `pnpm test` enforces front matter, indexes, links (including the paths in the table above), and plan statuses.
- Describe completed behavior only; mark planned or unverified behavior clearly. Commit messages carry the detail.

## Testing

The bar is deliberately high. Any change touching the ledger, money math, or execution includes tests in the same commit.

- **Connector/provider normalization:** recorded golden fixtures — capture once, redact, commit, replay forever. Never call a live provider API in tests.
- **Ledger invariants** are property-tested: entries sum to zero; derived balances reconcile to snapshots within tolerance; replaying the event log twice is idempotent.
- **Strategies:** pure-function tests over fixture portfolios; identical `StrategyContext` gives byte-identical output.
- **Executors:** mock broker plus paper environment; duplicate-submission tests are mandatory.
- **Money math:** explicit rounding tests, especially fractional shares, partial fills, and dividend reinvestment.
- **Plane separation:** a lint or schema test asserts no `world.*` writes from Plane A code paths, and vice versa.

## Style

- TypeScript strict. No `any` in ledger, money, or execution code.
- Zod at every boundary: API inputs, connector outputs, provider responses, strategy configs.
- Drizzle for schema and simple queries; hand-written SQL for analytical queries rather than contorting the query builder.
- Explicit over clever: this code is read at 11pm while debugging a real financial discrepancy.
- Errors carry context: provider, account, and `source_ref`, never just "sync failed".

## Commands

```bash
pnpm dev                 # Next.js dev server
pnpm build / pnpm start  # production build / serve it
pnpm db:up / db:down     # start PostgreSQL (waits for ready) / stop it, keeping the volume
pnpm db:provision-roles  # idempotently create missing app/ops-control/read-worker logins
pnpm db:generate         # generate Drizzle migrations
pnpm db:migrate          # apply migrations
pnpm format / format:check
pnpm test                # unit, property, environment, architecture, documentation; no infrastructure
pnpm test:integration    # PostgreSQL 16 + pgvector, in a disposable database
pnpm typecheck
pnpm lint
```

`test:integration` needs the Compose PostgreSQL service and a `.env` from `.env.example`. It uses `DATABASE_OWNER_URL` for migrations, the disposable database, and owner-role assertions, and the restricted role URLs for everything else. It never touches the primary ledger. `pnpm worker` and `pnpm db:backup` are planned, not implemented.

## Secrets

- Never commit credentials, tokens, account numbers, or institution identifiers. Never log a token, account number, or full balance in a way that leaves the host.
- Provider tokens are encrypted at rest with a key from the environment. Key-specific rules: `docs/architecture/security-and-keys.md`.
- Test fixtures are redacted; a payload containing a real account number is never committed.
- The pre-commit hook (`.githooks/pre-commit`, enabled by `pnpm install`) runs gitleaks and the owner's private `local/denylist.txt`. Never bypass it with `--no-verify` unless the owner confirms a false positive.

## When to stop and ask

- The task appears to require breaking an invariant.
- It would place a live order or widen what can be traded.
- It would connect news, sentiment, or any external signal to a trading decision.
- It changes a core `ledger.*` table's schema.
- It moves data across the plane boundary.
- Provider API behavior contradicts these documents.
- A financial calculation's correct behavior is ambiguous (rounding, wash sales, lot selection, corporate actions).

A wrong guess costs real money; an unanswered question costs a few minutes.
