---
summary: RFC 0001 (Accepted): minimum Phase 0 ledger schema, accounting semantics, source-record versions, corrections, and raw payloads
read_when: Changing ledger tables, transactions, entries, corrections, source records, or raw-payload storage
---

# RFC 0001: Minimum Phase 0 ledger schema

- Status: Accepted, amended through 2026-08-03
- Date: 2026-08-02
- Accepted: 2026-08-02
- Decision owners: project owner and implementer
- Followed by: RFC 0002, RFC 0003, and RFC 0004

## Context

Phase 0 needs enough Plane A structure to import a YNAB export, enter accounts manually, derive balances, and prove backup and restore. It does not yet need investments, tax lots, provider connections, strategies, execution, goals, or Plane B data.

The schema must enforce Meridian's invariants without creating a second model that later phases have to work around. The domain listing in `PLAN.md` (now [ledger model](../architecture/ledger-model.md)) is conceptual; this RFC defines the first implemented slice. RFC 0002 later added canonical account-source linkage without placing institution identity or capabilities on canonical accounts.

## Proposed scope

The minimum schema contains these append-only tables:

| Table                       | Responsibility                                                                               |
| --------------------------- | -------------------------------------------------------------------------------------------- |
| `ledger.accounts`           | Stable identity, financial type/class, and immutable account-opening facts                   |
| `ledger.account_revisions`  | Append-only name, status, and display metadata changes                                       |
| `ledger.categories`         | Stable category identity and kind                                                            |
| `ledger.category_revisions` | Append-only category name and hierarchy changes                                              |
| `ledger.source_records`     | Immutable versions of externally observed records and their revision chain                   |
| `ledger.transactions`       | Transaction identity, occurrence date/optional instant, currency, provenance, and correction |
| `ledger.entries`            | Monetary postings to accounts or categories; all postings in a transaction use its currency  |
| `ledger.raw_payloads`       | Encrypted import/provider payload plus digest, source, and ingestion metadata                |
| `ledger.imports`            | One immutable import attempt and its content digest                                          |

Phase 0 deliberately excludes `institutions`, `instruments`, quantities, position snapshots, tax lots, goals, strategies, intents, orders, fills, and all `world.*` tables. Those enter only with the phase that can define and test their behavior.

## Proposed ledger model

### Stable identities and revisions

An append-only ledger cannot update an account name, close an account in place, or rearrange a category tree. Stable identity tables therefore contain only facts that do not change. Revision tables record later metadata with `effective_at` and `recorded_at`; a view selects the latest effective revision as of the current time, using recording order and identity as deterministic tie-breakers.

This pattern is proposed once for mutable-looking ledger metadata rather than allowing ad hoc update exceptions per table.

### Transactions and entries

Each transaction has one ISO 4217 currency. Phase 0 accepts USD only and does not perform foreign-exchange accounting. Every entry has a signed `NUMERIC` amount in the transaction currency. The sum of its entries must equal exactly zero before the transaction can commit.

An entry posts to exactly one of:

- an account, representing an asset or liability balance; or
- a category, representing income, expense, or a transfer-clearing classification.

Categories are lightweight journal destinations, not dedicated accounts the user has to administer. Automatic categorization and transaction understanding will later select or propose these same category destinations; they will not introduce a second transaction or accounting model. Reclassification remains append-only.

This keeps Phase 0 focused on USD-denominated personal-finance transactions. A foreign purchase already finalized by a provider in USD is an ordinary USD transaction; Meridian does not calculate the conversion. Instrument quantities and cost basis are intentionally absent until the investments phase defines their accounting semantics.

PostgreSQL cannot enforce a cross-row sum with a `CHECK` constraint. The implementation should use a deferred constraint trigger so a multi-entry transaction may be assembled within one database transaction but cannot commit unbalanced. Application validation provides earlier feedback but is not the authority.

### Corrections

Rows are never updated or deleted. A correction creates a new transaction that references the transaction it corrects and contains compensating entries. Reversal and replacement are separate new transactions so the audit history remains explicit.

### Imports and source records

Every import has a SHA-256 content digest. Replaying identical input is a no-op enforced by a unique constraint on the importer id, importer version, and digest.

Externally sourced records live in `ledger.source_records`, which retains `source`, `source_ref`, a normalized-record SHA-256 digest, `ingested_at`, the raw payload, and an optional predecessor version. Re-observing identical content is a no-op through uniqueness on `(source, source_ref, content_digest)`. A changed record creates a new version referencing the prior version; updates in place and branching revision chains are forbidden.

Each source-record version may normalize to at most one transaction. The initial version links to the original transaction. For a changed version, an internally generated correction transaction exactly reverses the prior transaction and the new source-record version links to the replacement transaction. The correction is not itself an external observation; provenance remains recoverable through the version chain and correction reference. Uniqueness on the source-record transaction link and correction target makes replay unable to create duplicate ledger facts.

Raw payloads are written before normalization and linked to the import. The payload body is encrypted at the application boundary, and its SHA-256 digest supports idempotency and integrity checks. Import orchestration must invoke the structured-payload policy, which rejects credential, password, authorization, secret, and token fields before sealing; it does not silently remove them. Source and source-reference metadata needed for provenance remain in dedicated plaintext columns, while the retained provider body remains encrypted for diagnosis.

## Required database enforcement

The first migration and integration tests must demonstrate:

1. `UPDATE` and `DELETE` fail for every `ledger.*` table under both application and migration roles, except for the narrowly privileged migration operation needed to install schema objects.
2. A transaction whose entries do not sum to zero cannot commit.
3. An entry targets exactly one valid posting destination.
4. Monetary values use `NUMERIC`; application boundaries use validated decimal strings and never JavaScript `number`.
5. Duplicate import content and duplicate external source records cannot create duplicate ledger facts.
6. Corrections retain a reference to the original transaction and cannot form self-references.
7. Currency is explicit and consistent across a transaction and its entries.
8. Identical source-record versions are unique, revised versions retain one linear predecessor chain, and each version normalizes at most once.

Property tests must cover balanced-entry generation, rejection of unbalanced sets, correction replay, and import idempotency. Backup and restore must be exercised against the resulting schema before Phase 0 is considered complete.

## Coherence rules for implementation

- Define canonical identifiers, decimal-string schemas, currency codes, provenance, and timestamps once in `src/core`; do not recreate them in the importer or UI.
- Keep persistence ports in core and the PostgreSQL/Drizzle adapter at the infrastructure edge. Next.js code calls a service and does not import schema definitions directly.
- Keep SQL constraints and TypeScript validation aligned and test both. Neither layer silently accepts states rejected by the other.
- Use domain-specific names such as `recordTransaction` and `reverseTransaction`; avoid a generic repository abstraction that hides append-only behavior.
- Document any change to this model as a new decision or an explicit amendment to this RFC.

## Accepted decisions

1. **Balancing unit:** Phase 0 transactions are single-currency and USD-only. Foreign-exchange accounting is out of scope.
2. **Category postings:** Categories are journal destinations, not user-managed income and expense accounts. Future automatic categorization uses the same model.
3. **Source revisions:** Identical replays are no-ops. A changed record with the same source identity produces an append-only correction and replacement; the original is never updated.
4. **Raw import retention:** Plane A stores an application-encrypted raw payload and its digest. Credentials and access tokens are never retained.

## Amendments

### Source versions and database roles

Accepted August 2, 2026 before the first schema migration:

1. **Source-record versions:** Source identity and content versioning belong in the dedicated `ledger.source_records` table described above rather than being flattened into transactions. This intentionally expands the original minimum table boundary by one table so connectors can distinguish identical replay from changed content without weakening append-only history.
2. **Correction enforcement:** PostgreSQL must defer validation until commit and require a correction to use the original currency and exactly negate the original postings by destination. A valid reference alone is insufficient.
3. **Database roles:** Schema migration uses an owner login. Runtime access uses a separate login granted only schema usage plus `SELECT` and `INSERT`; it receives no `UPDATE`, `DELETE`, DDL, or trigger-management privileges. Integration tests exercise append-only rejection through both roles.
4. **Kind representation:** Account types/classes and category kinds use checked text rather than PostgreSQL enum types so extending an accepted value set remains an ordinary constraint migration.
5. **Transaction origin:** Every transaction persists an explicit `manual`, `system`, or `external` origin. External transactions must reference one source-record version; non-external transactions cannot. Compensating correction transactions are system-originated so generated ledger facts remain distinguishable from manual entry.

### Account and category semantics

Accepted August 2, 2026 before the affected manual workflows and migrations:

6. **Category migration policy:** YNAB groups and categories seed Meridian's initial provider-independent category hierarchy, and imported transactions preserve their historical assignments. YNAB-specific labels remain in provenance, but envelope balances, budget targets, availability, and other YNAB budgeting behavior are not part of the ledger model.
7. **Account opening date:** The optional account-opening value is a calendar `date` named `opened_on`, not an instant. The initial unshipped `opened_at timestamptz` representation is corrected before manual account creation so local timezone conversion cannot change the stated opening date.
8. **Account type and accounting class:** Canonical accounts persist a provider-independent financial type separately from accounting class. Checking, savings, cash, brokerage, retirement, and crypto derive `asset`; credit card, loan, and mortgage derive `liability`; `other` requires an explicit class. Balance sign does not change class. Manual creation supports imports/offline accounts, while connectors later discover or link the same identities.

### Import security and normalization

Accepted August 3, 2026 before importer persistence:

9. **Raw-payload encryption:** Application-level raw payload encryption uses libsodium XChaCha20-Poly1305, a fresh random nonce, and a versioned base64 32-byte environment key. Source, plaintext SHA-256 digest, algorithm, and key ID are authenticated metadata. Structured payloads containing credentials, passwords, authorization values, secrets, or tokens are rejected before sealing.
10. **Transaction date precision:** Every transaction stores an `occurred_on date`. `occurred_at timestamptz` is nullable and present only when a source supplies a real instant. Date-only CSV records must not be converted to an artificial midnight timestamp.
11. **YNAB normalization and review policy:** Plan rows seed taxonomy but not envelope values. Account-type suggestions require confirmation. Explicit transfers use a transfer-clearing destination without heuristic row pairing, starting balances use Opening Balance Equity, and manual/reconciliation adjustments use a separate Balance Adjustment destination. Zero-dollar rows are provenance-only and do not create transactions. Blank categories use separate uncategorized expense/income destinations according to the nonzero amount side. Exact replay uses account/date/amount plus duplicate ordinal and a full-row digest. Later non-identical exports are review-only: deterministic candidates may be suggested, ambiguous rows permit manual pairing, and every changed row requires an explicit decision before any append-only correction or replacement is persisted.

## Consequences

This decision provides a small schema that can prove the ledger invariants and support YNAB import without forcing users to manage accounting-style expense accounts or prematurely deciding investment accounting. It commits the project to append-only revision records for ledger metadata and requires explicit later designs for instruments and lots. Foreign-exchange accounting is not planned.
