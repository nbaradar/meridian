---
summary: RFC 0007 (Accepted): free-first data provider order (Teller, then Plaid Trial for gaps, official institution APIs, manual file import), SimpleFIN as the paid backstop, and no stored bank login credentials or scraping
read_when: Choosing or building a bank, brokerage, or crypto connector, adding a provider to the source registry, or considering scraping or browser automation
---

# RFC 0007: Free-first provider selection

- Status: Accepted
- Date: 2026-09-27
- Accepted: 2026-09-27
- Decision owners: project owner and implementer
- Amends: RFC 0003 acceptance decision 9 ("SimpleFIN-first coverage testing and Teller fallback") and its "SimpleFIN and Teller" provider-safety section
- Related: RFC 0002 (source registry), [institutions](../institutions.md)

## Context

RFC 0003 chose to evaluate SimpleFIN first for bank coverage, with Teller as the fallback. The owner prefers free services when they are adequate. Two now are:

- **Teller** offers a free development environment with real bank data and 100 enrollments. An enrollment is one bank login, which may cover several accounts. Teller describes the environment as a way to validate an integration before going live. Deleting an enrollment does not restore the count. It covers US banks and credit cards, not brokerages.
- **Plaid** offers a free Trial plan to teams created on or after April 15, 2026. It includes production data, 10 Items (one Item is one institution login), and Transactions, Balance, Investments, and Liabilities. Plaid's documentation states no expiry. Removing an Item does not free a slot. Pricing beyond the trial is sales-led.

Both free tiers can change terms, so the design must not depend on either one.

## Decision

1. **Provider order per institution:**
   1. an official institution API when one exists and is free (for example the Schwab Trader API under RFC 0003's authorization gate, or an exchange's official read API);
   2. **Teller** for banks and credit cards;
   3. **Plaid Trial** only for institutions Teller cannot reach. Slots are not spent on experiments; development uses Plaid Sandbox and recorded fixtures;
   4. **manual file import** (CSV, OFX/QFX) for anything else. This includes Fidelity, which blocks Plaid and needs Fidelity Access. One importer per file format, not per institution.
2. **SimpleFIN is the paid backstop.** It is adopted if a free tier is withdrawn or cannot cover a needed institution. That covers institutions Teller and Plaid Trial miss, and Plaid Trial's 10 slots running out.
3. **No stored bank login credentials, and no scraping.** Meridian never stores an institution username or password. It never uses unofficial or reverse-engineered APIs and never runs headless browser automation against an institution. If manual export becomes burdensome, the only permitted automation runs in the owner's own browser session, after the owner has logged in. It only downloads statement files the institution offers, and it holds no credentials.
4. **Provider choice stays configuration.** Each provider is a connector module behind `ReadConnector`, and matching and the ledger are provider-neutral. Changing one institution's provider must not change core semantics.
5. **Registry changes wait for their connector plan.** `plaid` and any new file-import source are added to the checked source registry (RFC 0002) and `ops.connections` sources (RFC 0003) by the plan that builds that connector. That plan's migration is what changes the registry, not this RFC.

## Consequences

- The expected steady-state cost is zero. The worst case is SimpleFIN's small annual fee.
- Teller and Plaid each need a browser authorization step (Teller Connect, Plaid Link) in the connector's setup flow. SimpleFIN needs only a setup token. Both browser flows still store only revocable, read-only tokens, encrypted under RFC 0003.
- Plaid's `pending_transaction_id` and stable transaction IDs are useful evidence for cross-source matching. Matching must still work without them.
- Coverage of each of the owner's institutions is checked per provider before connecting. The owner's inventory and results stay in the private `local/` directory.

## Implementation Status

Documentation only. No connector, registry change, or migration yet.
