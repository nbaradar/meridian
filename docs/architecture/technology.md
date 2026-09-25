---
summary: Technology choices with rationale, the framework rule's purpose, and rejected alternatives
read_when: Adding a dependency, library, or service, or reconsidering a technology choice
---

# Technology decisions

Formerly `PLAN.md` §5.

| Layer      | Choice                                            | Rationale                                                                                                                                                                                     |
| ---------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Language   | TypeScript, end to end                            | One language across web, worker, UI, and the eventual MCP server. Plaid/SnapTrade/Teller/Alpaca all ship first-class TS SDKs.                                                                 |
| Shape      | Modular monolith, two processes (`web`, `worker`) | One repo, one database. Boundaries remain explicit in code and are mechanically checked where implemented, without a network hop. At one user, microservices cost everything and buy nothing. |
| Database   | PostgreSQL 16 + pgvector                          | `NUMERIC` for money, real date/time types, `JSONB` for raw payloads, full-text search and vector similarity for news — one engine for all of it.                                              |
| ORM        | Drizzle                                           | SQL-first with real TS types. Time-weighted return, lot matching, and spending rollups are queries you want to write in SQL.                                                                  |
| Web        | Next.js (App Router)                              | Server components suit a read-heavy dashboard. **Constrained by the rule below.**                                                                                                             |
| UI         | Tailwind + shadcn/ui + Recharts                   | Fast to build, easy to extend per module.                                                                                                                                                     |
| Jobs       | **pg-boss**                                       | Postgres-backed: durable retries, backoff, history, cron scheduling — without running Redis. Price polling, news polling, sync, and strategy evaluation are all scheduled jobs.               |
| Validation | Zod                                               | Shared schemas across API boundaries, strategy configs, and connector normalization.                                                                                                          |
| Money      | `decimal.js` + Postgres `NUMERIC`                 | Float money is a defect, not a tradeoff.                                                                                                                                                      |
| Embeddings | pgvector + an LLM API                             | No new service. News tagging by semantic similarity beats keyword rules.                                                                                                                      |
| Deploy     | Docker Compose                                    | Host-agnostic by design. See [hosting](hosting.md).                                                                                                                                           |
| Access     | **Tailscale only. No public ingress.**            | See [safety](safety.md).                                                                                                                                                                      |

## The framework rule

`src/core/` and `src/modules/` import nothing from Next.js. Route handlers and server components are thin adapters over a service layer that the MCP server and any CLI import directly.

This is the part that matters. The framework choice becomes reversible in a weekend, which is the actual goal.

## Rejected, with reasons

- **node-cron** — no durability, no retry, no history. Unacceptable for anything that places orders.
- **BullMQ** — good, but requires Redis. Revisit only if pg-boss throughput becomes a real constraint, which at one user it will not.
- **Temporal** — the right tool for long-running `submit → poll → partial fill → reconcile → compensate` workflows, and the correct upgrade path if execution gets complex. Ops burden too high to start with.
- **TimescaleDB** — premature. Daily bars for 100 instruments over 20 years is ~500k rows, which plain Postgres finds boring. Revisit only if intraday data enters scope, which `PLAN.md` §1 says it will not.
- **Prisma** — weaker story for hand-written analytical SQL.
- **Microservices** — no.
- **Python backend** — better backtesting ecosystem, worse everything else for a solo full-stack build. Mitigated by I3: the strategy engine is a pure function with a serializable interface and can be extracted into a Python service without touching any other module.
