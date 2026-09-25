# Meridian — Personal Financial Dashboard

> Working name. A self-hosted, single-user financial system: one ledger, many modules.

Meridian must remain coherent as it grows. Features are designed as parts of a single domain model, with consistent vocabulary, clear ownership, reusable boundaries, and the fewest abstractions that fully express the problem. Maintainability, correctness, and established engineering best practices are design requirements, not cleanup work deferred until after delivery.

---

## 1. Why this exists

Four needs that no single product covers:

1. **Consolidation.** All accounts — banks, brokerages, crypto, retirement, illiquid assets — in one place, with a correct net worth and a unified transaction feed.
2. **Spending visibility.** Categorized transactions and spending habits. This replaces YNAB, minus the envelope budgeting, which is not used and is explicitly out of scope.
3. **Market context.** Price data for held instruments, and news filtered by what is actually owned and cared about.
4. **Strategy automation.** Define, simulate, track, and eventually execute DCA and other systematic investment strategies with detailed attribution.

(1)–(3) are solved problems in isolation — Actual Budget, Ghostfolio, and any news reader cover them. **(4) is the reason to build**, and the ledger is what makes the others nearly free once it exists. If the automation layer is ever abandoned, the correct decision is to stop and run off-the-shelf tools instead.

### Non-goals

- Envelope/zero-based budgeting
- Multi-user or multi-tenant support (for now — see §12)
- Public internet exposure
- Native mobile apps (responsive web only)
- Intraday, tick, or order-book data
- News-driven or signal-driven trading (see §7)
- Financial advice or recommendations. Strategies are mechanical rules the user defines.
- Tax filing. Tax *lots* are tracked; tax *forms* are not.

### Scope philosophy

Meridian is a personal tool first: implementations are scoped to the owner's own institutions and needs. Canonical accounts exist independently of any connector. Accounts identified by the YNAB import or created manually are later linked to live connectors rather than recreated per provider, and every account has a manual or file-import fallback, so an unsupported institution is a known state. The architecture stays modular and provider-neutral so Meridian can later be shared; §12 collects everything deferred to that expansion.

---

## 2. Architecture

Moved to [docs/architecture/overview.md](docs/architecture/overview.md).

---

## 3. Domain model

Moved to [docs/architecture/ledger-model.md](docs/architecture/ledger-model.md).

---

## 4. Module contract

Moved to [docs/architecture/modules.md](docs/architecture/modules.md).

---

## 5. Technology decisions

Moved to [docs/architecture/technology.md](docs/architecture/technology.md).

---

## 6. Data sources

Moved to [docs/institutions.md](docs/institutions.md).

---

## 7. Safety architecture

Moved to [docs/architecture/safety.md](docs/architecture/safety.md).

---

## 8. Hosting

Moved to [docs/architecture/hosting.md](docs/architecture/hosting.md).

---

## 9. Phases

Each phase ends with something usable. No phase depends on a later one.

Current progress and the next unit are in [docs/status.md](docs/status.md); completed-unit detail is in [docs/history.md](docs/history.md).

### Foundation — application skeleton ✅

Completed August 2, 2026. See [docs/history.md](docs/history.md#foundation--application-skeleton-).

### Phase 0 — Ledger core
`ledger.*` schema, migrations, double-entry constraint, CSV import, manual account entry. Backup job and a tested restore.
**Done when:** the YNAB export imports cleanly, net worth matches YNAB to the cent, and a restore from backup has been performed successfully.

In progress; see [docs/status.md](docs/status.md).

### Phase 1 — Aggregation + YNAB replacement
Bank connector (SimpleFIN first, Teller fallback) for bank and credit-card accounts. Evaluate an official **Schwab Trader API connector in read-only mode**, but defer it unless the actual authorization grant and process isolation prove the read worker cannot place orders. Sync scheduling via pg-boss. Transfer pairing. Categories, categorization UI, rule-based auto-categorization. Spending views.

Fidelity and Robinhood enter via CSV import at this stage; promote to live connectors only if SnapTrade pricing works for one user.

**Done when:** the YNAB subscription is cancelled.

### Phase 2 — Investments + market data
`world.prices`, sourced from Schwab's market data endpoints first. Remaining brokerage connectors. Positions, tax lots, cost basis, time-weighted and money-weighted return. Corporate actions. The reconciliation loop.

**Verify Schwab refresh-token lifetime and re-auth flow here**, while it is still cheap to redesign around. It determines whether phase 5 can run unattended.

**Done when:** portfolio performance is trustworthy enough to act on.

### Phase 3 — Goals + strategy engine, simulation only
Goal objects and progress tracking. DCA strategy definitions (fixed amount, value-averaging, volatility-scaled, dip-triggered). Backtesting against ingested history. **No execution.**
**Done when:** a strategy can be defined, backtested, and its intents inspected — and has run in shadow mode for a month logging what it *would* have done.

### Phase 4 — Approval queue + paper execution
Intents surface as a review queue with approve/reject. Full order lifecycle and reconciliation.

Schwab has **no paper sandbox**, so this phase uses two executors behind one interface:
- `AlpacaPaperExecutor` — a free, unfunded paper account used purely as a test harness for the execution machinery (idempotency, retries, partial fills, reconciliation).
- `SchwabExecutor` — written and unit-tested here, but **not enabled**.

**Done when:** a month of paper DCA runs against Alpaca with zero duplicates, zero missed runs, and clean reconciliation — and `SchwabExecutor` passes the same duplicate-submission and lifecycle suites against a mock.

### Phase 5 — Live execution
Schwab only, single account, single ETF, small notional. All safety controls active. Manual approval still required.

Schwab is the sole write-capable equities path in the inventory. Robinhood crypto is a separate, later, optional executor; every other institution is read-only forever and should use its native recurring-investment feature.

**Treat semi-automation as the terminal state, not a stepping stone.** Full autonomy buys very little — the DCA arithmetic is trivial — while the failure modes are severe. Removing the human is the highest-risk, lowest-value change available. Revisit only after a long clean track record, and only per-strategy.

### Phase 6 — News
`world.news_*`. RSS and Finnhub sources, dedup by URL hash, embedding, tagging against declared interests, instrument linkage joined to holdings. Dashboard feed ranked by position size.
Deliberately last: it is the highest-enjoyment, lowest-consequence module, and quarantined from everything that matters.

### Phase 7 — MCP layer
An MCP server over Plane A read views plus the news feed, so financial questions can be asked conversationally. **Read-only tools. Execution is never exposed over MCP.**

---

## 10. Open decisions

- [x] ~~Which institutions?~~ — decided; the owner's inventory is private (gitignored `local/`). Provider paths are in §6.
- [x] ~~Which broker for phase 4–5?~~ — **Schwab**, direct via Trader API. Alpaca paper retained solely as a test harness.
- [ ] **SimpleFIN coverage check** for each bank to be connected. Test before paying; Teller is the fallback.
- [ ] **Fidelity access path.** Confirm whether SnapTrade's Fidelity integration is Fidelity Access-based. If not, CSV import.
- [ ] **Schwab refresh-token lifetime and re-auth flow.** Blocking for phase 5 unattended operation. Resolve during phase 2.
- [ ] **SnapTrade single-user pricing.** If unworkable, Robinhood and Fidelity stay on CSV import indefinitely.
- [x] ~~Category taxonomy.~~ — YNAB labels and hierarchy seed Meridian categories and preserve historical assignments, without importing YNAB envelope-budgeting semantics or coupling the core model to YNAB.
- [ ] **Goals inventory.** The structured list phase 3 tracks against (see §11).
- [ ] **Interest tags for news.** The declared list phase 6 matches against.
- [x] ~~Hosting target~~ — deferred to phase 3 by design (§8).
- [x] ~~Backup strategy~~ — decided: encrypted `pg_dump --schema=ledger` off-box from phase 0.
- [x] ~~Minimum Phase 0 ledger schema.~~ — RFC 0001 accepted August 2, 2026: Phase 0 is USD-only, categories are journal destinations, provider revisions use append-only corrections, and encrypted raw payloads retain a digest.
- [x] ~~Operational live-connection boundary.~~ RFC 0003 accepted August 3, 2026; the protected `ops.*` foundation is implemented, but live connector calls and non-discovery feeds remain disabled.
- [x] ~~Transaction-source authority and YNAB cutover design.~~ RFC 0004 accepted August 3, 2026; only the no-write source-record association stage is implemented, and later authority/reconciliation stages remain required before normalized transaction writes.

---

## 11. Goals as structured data

Phase 3 depends on goals being machine-readable rather than prose:

```yaml
# Illustrative values only; real goals live in the gitignored local/ directory.
- id: emergency-fund
  target_amount: 10000
  target_date: 2030-01-01
  priority: 1
  funding_accounts: [example-savings]
  strategy: null                    # manual contributions

- id: taxable-brokerage
  target_amount: null               # open-ended accumulation
  target_date: null
  priority: 3
  funding_accounts: [example-brokerage]
  strategy: dca-vti-weekly
```

This is what lets the dashboard answer "am I on track" and lets strategies be attributed to the goal they serve rather than floating free.

---

## 12. Future expansion: other users

Moved to [docs/future/expansion.md](docs/future/expansion.md).

---

*Not financial advice. Every strategy in this system is a mechanical rule defined by the user; the software executes and reports, it does not recommend.*
