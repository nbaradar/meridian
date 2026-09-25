---
summary: Conceptual Plane A and Plane B tables, data conventions for dates, sources, and currency, the account type versus class model, and the category policy
read_when: Adding or changing tables, ingesting external data, modeling accounts or categories, or handling dates and amounts
---

# Ledger and domain model

Formerly `PLAN.md` §3, plus standing rules moved from `AGENTS.md`. Accepted RFCs in [decisions](../decisions/README.md) define the implemented schema.

## Plane A — `ledger.*`

This is a conceptual inventory, not a migration contract. RFC 0001 defines the
implemented transaction foundation and RFC 0002 adds canonical account-source
linkage. In particular, canonical accounts do not store institution identity or
capabilities; those facts belong to source linkage and a separately reviewed
operational connection boundary.

```sql
accounts            (id, kind, class, currency, opened_on, ...)
account_revisions   (id, account_id, name, status, effective_at, recorded_at, ...)
account_sources     (id, source, source_kind, ingested_at, recorded_at)
account_source_link_revisions
                    (id, account_source_id, account_id, status, supersedes_id, ...)
source_records      (id, source, source_ref, content_digest, supersedes_id, ...)
instruments         (id, symbol, kind, name, ...)          -- equities, funds, crypto, cash
transactions        (id, occurred_on, occurred_at, description, origin,
                     source_record_id, corrects_transaction_id, ...)
entries             (id, transaction_id, account_id, instrument_id,
                     amount NUMERIC, quantity NUMERIC, category_id, ...)
position_snapshots  (id, account_id, instrument_id, quantity, value, observed_at, source)
tax_lots            (id, account_id, instrument_id, opened_at, quantity, cost_basis, closed_at)
categories          (id, parent_id, name, kind)            -- expense / income / transfer
raw_payloads        (id, source, ingested_at, algorithm, key_id, nonce, ciphertext, digest)

strategies          (id, kind, name, config JSONB, status, created_at)
strategy_runs       (id, strategy_id, ran_at, input_digest, outcome, notes)
intents             (id, strategy_run_id, account_id, instrument_id,
                     side, quantity, limit_price, rationale, status)
orders              (id, intent_id, executor_id, idempotency_key UNIQUE,
                     broker_order_id, status, submitted_at, ...)
goals               (id, name, target_amount, target_date, funding_account_ids[],
                     priority, notes)
```

## Plane B — `world.*`

```sql
prices              (instrument_id, price_date, close NUMERIC, provider,
                     ingested_at, PRIMARY KEY (instrument_id, price_date, provider, ingested_at))
corporate_actions   (id, instrument_id, kind, ex_date, ratio, amount, provider)
fundamentals        (instrument_id, as_of, metrics JSONB, provider)

news_articles       (id, url_hash UNIQUE, url, title, summary, published_at,
                     source, provider, ingested_at)
news_embeddings     (article_id, embedding vector(1536))
news_instruments    (article_id, instrument_id, confidence)   -- join to Plane A
interest_tags       (id, label, description, embedding vector(1536))
```

`url_hash` gives idempotent re-ingestion. `news_instruments` is what makes the feed useful: articles about instruments actually held, weighted by position size — a join no generic news reader can perform.

## Conventions

- **Money is `NUMERIC`.** Never float. Never JS `number` for an amount — `decimal.js` or decimal strings at the boundary.
- **Every externally-sourced row carries `source` and `ingested_at`.** Multiple providers describe the same account; precedence must be resolvable.
- **Real instants are `timestamptz`, stored UTC; calendar dates are `date`.** A source date or trade date is not an instant.
- **Every external record keeps its `source_ref`** so identical re-syncs are no-ops and changed observations append explicit versions rather than mutating or blind-inserting.

## Data conventions (from `AGENTS.md`)

- **Dates and timestamps:** source calendar dates are `date`; real instants are `timestamptz` stored UTC. Transactions require `occurred_on` and use nullable `occurred_at` only when the source supplies an instant. Trade and settlement dates remain separate dates. Never invent midnight UTC for date-only data.
- **Every externally-sourced row** carries `source` and `ingested_at`. Multiple providers describe the same account; precedence must always be resolvable.
- **Every external record** keeps its `source_ref`. Replaying identical content is a no-op. If the same source record changes, append an explicit correction and replacement referencing the prior record; never mutate the original and never blind-insert a duplicate.
- **Raw provider payloads** persist to `raw_payloads` before normalization. Never discard what the API actually returned; it is the only way to debug a normalization bug after the fact.
- **Currency** is explicit on every amount. Do not assume USD.
- **News dedup** is by `url_hash`, unique-constrained. Re-ingesting the same article is a no-op.

## Account type and accounting class

The account model distinguishes user-facing provider-independent type (`checking`, `savings`, `cash`, `credit_card`, `loan`, `mortgage`, `brokerage`, `retirement`, `crypto`, or `other`) from accounting class (`asset|liability`). Core derives class for every known type — checking, savings, cash, brokerage, retirement, and crypto are `asset`; credit card, loan, and mortgage are `liability` — while `other` requires an explicit class; PostgreSQL enforces valid combinations. Account opening is `opened_on date`, never an artificial midnight UTC instant. A negative checking balance does not reclassify the account. Live connectors in Phase 1 will discover or link these same canonical account identities; manual creation is for imports, offline accounts, and unsupported institutions.

## Category migration policy

**Phase 0 category migration policy accepted (August 2, 2026):** YNAB category groups and categories seed Meridian's initial category hierarchy, and imported transactions retain their historical assignments. This is migration continuity, not a YNAB-shaped domain model. Core categories remain provider-independent journal destinations; YNAB envelope balances, targets, availability, and budgeting behavior do not enter the schema. Original YNAB labels remain in import provenance, and later taxonomy changes or reclassification remain explicit and append-only.
