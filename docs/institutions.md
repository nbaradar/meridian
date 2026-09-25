---
summary: Per-institution read/write access, provider options (Schwab, SimpleFIN, Teller, Plaid, SnapTrade, Fidelity Access, Robinhood), connector build order, market data and news sources
read_when: Building or choosing a connector, market data or news provider, or anything touching a specific institution
---

# Institutions and data sources

## Institution constraints (from `AGENTS.md`)

Access rules differ by provider and are not symmetric; assuming otherwise produces broken code. This table covers the provider paths Meridian is designed around, not any particular person's accounts: the owner's own institution inventory is private and lives in the gitignored `local/` directory when present.

| Institution            | Read | Write                      | Notes                                                            |
| ---------------------- | ---- | -------------------------- | ---------------------------------------------------------------- |
| Schwab                 | ✅   | ✅ equities, ETFs, options | Direct Trader API. No paper sandbox. Short-lived refresh tokens. |
| Banks and credit cards | ✅   | ❌                         | Bank aggregator only                                             |
| Robinhood              | ✅   | ⚠️ crypto only             | SnapTrade read; official Crypto API for crypto writes            |
| Fidelity               | ⚠️   | ❌                         | Requires a Fidelity Access-based aggregator, or CSV import       |

Rules that follow:

- **Schwab is the only write-capable equities path.** Do not write an executor for any other institution without an explicit task saying so.
- **Never use unofficial or reverse-engineered broker APIs**, Robinhood's especially. They violate ToS and risk account termination. If a task implies one, stop and ask.
- **Fidelity cannot be reached through Plaid.** Do not add a Plaid-based Fidelity connector; it will be blocked.
- **Schwab has no paper environment.** Execution-machinery tests run against the `AlpacaPaperExecutor` harness. Never point a test at `SchwabExecutor` with live credentials.
- Options, futures, forex, crypto, bonds, and non-US equities are **not** tradeable via the Schwab Trader API beyond equities/ETFs/options. Reject unsupported instruments at the intent layer, not at the broker.

## Data sources (formerly `PLAN.md` §6)

Coverage and pricing change; verify before committing. Everything sits behind an interface so provider choice is config, not commitment.

### Provider paths

| Institution type       | Type               | Read           | Write                      | Path                                    |
| ---------------------- | ------------------ | -------------- | -------------------------- | --------------------------------------- |
| **Schwab**             | brokerage          | ✅             | ✅ equities, ETFs, options | **Schwab Trader API, direct**           |
| Banks and credit cards | bank / credit      | ✅             | ❌                         | bank aggregator                         |
| Robinhood              | brokerage + crypto | ✅             | ⚠️ crypto only             | SnapTrade (read) + Robinhood Crypto API |
| Fidelity               | brokerage          | ⚠️ constrained | ❌                         | Fidelity Access aggregator, or CSV      |
| Anything else          | any                | manual or CSV  | ❌                         | manual entry or file import             |

### Schwab Trader API — the primary future execution integration

Read, write, and market data in one free integration for anyone with a Schwab brokerage account. No account minimums, no monthly API fees, documentation aimed at individual developers.

The API's overall feature set does not make its credential safe for the read connector. Read integration is deferred unless the actual authorization grant and process boundary prove the read worker cannot place orders; execution remains a separate later adapter and credential path.

**Individual access is the correct path.** Registering at `developer.schwab.com` and operating against your own account requires no commercial approval; that review only applies to applications connecting _other_ Schwab clients' accounts. A single-user system never triggers it.

**Supported:** US equities, ETFs, options, index options. **Rejected:** futures, forex, crypto, bonds, non-US equities. For ETF DCA this is exactly the needed surface.

**Two constraints:**

1. **No paper-trading sandbox.** Breaks the phase 4 gate as originally written. Resolved by the `Executor` interface: validate execution _machinery_ against a free, unfunded Alpaca paper account; run the _production_ executor against Schwab. Same code path, different adapter — this is what the abstraction was for.
2. **Short-lived refresh tokens.** Verify current lifetime and re-auth flow **before committing to phase 5**. If refresh requires a browser round-trip on a weekly cadence, unattended scheduling is not viable as designed and the approval queue must absorb the manual step.

### Bank aggregation

- **SimpleFIN Bridge** — ~$15/yr, read-only, daily refresh. Purpose-built for personal finance tools. **Check coverage of each bank before paying**; it is a small network.
- **Teller** — free developer tier, limited live connections, US bank focus. Fallback if SimpleFIN misses any.
- **Plaid** — broadest coverage, but sales-led access and opaque individual pricing. **Cannot reach Fidelity** (see below).

### Fidelity — the constrained one

Fidelity does not use Plaid. All third-party apps and aggregators must adopt **Fidelity Access**, an OAuth-style flow where credentials are never shared with the third party and authorizations are revocable from a Fidelity dashboard. Aggregators without a Fidelity Access agreement are actively blocked.

Aggregators with Fidelity Access include Akoya, Finicity, Yodlee, MX, and ByAllAccounts. SnapTrade advertises Fidelity support — **verify it is Fidelity Access-based** before depending on it.

**Fallback:** Fidelity supports CSV/OFX export. Phase 0 has a YNAB-specific CSV parsing and review foundation but no general or persistent CSV importer yet; a Fidelity manual connector remains feasible future work rather than implemented fallback behavior.

**Check the account type.** Retail brokerage and employer-sponsored plans such as a 401(k) have materially different access postures; the latter are locked down considerably harder.

### Robinhood — read-only for equities

- **SnapTrade** provides read access. It does **not** support placing trades on Robinhood.
- **Robinhood Crypto Trading API** (official, launched 2024) supports programmatic crypto market data, portfolio management, and order placement for US customers. A legitimate write path for crypto only.
- **Never use unofficial/reverse-engineered Robinhood libraries.** They violate ToS and the failure mode is account termination — a self-inflicted outage on top of the obvious problem.

### Connector build order

1. **Bank aggregator** — SimpleFIN first, Teller as fallback.
2. **Schwab Trader API read adapter** — only after the non-trading authorization gate is proven; the write executor remains phase 4–5 work.
3. **SnapTrade** — Robinhood and Fidelity read, only if single-user pricing works. Otherwise CSV import for both.

### Market data

Schwab's Trader API includes market data, which may cover the requirement outright. Alternatives if a second source is wanted:

- **Alpaca** — free tier is real-time IEX plus 15-minute-delayed SIP. IEX is ~2–5% of consolidated volume: fine for end-of-day valuation, not for execution-sensitive work.
- **Tiingo** — ~$10/mo, clean EOD plus fundamentals. The pick if backtest data quality matters.
- **Finnhub** — generous free tier covering quotes, news, sentiment, and calendars in one integration.

**Explicitly out of scope:** Polygon/Massive, Databento. They solve intraday and microstructure problems this system does not have.

### News

- **Finnhub** — news plus sentiment on the free tier.
- **Plain RSS** — zero cost, no rate limits, full source control. Start here.
