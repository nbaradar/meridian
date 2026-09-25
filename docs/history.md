---
summary: Dated log of completed implementation units, accepted decisions, and verification counts
read_when: Investigating when or why something was built, or recovering context a commit message references; not needed for routine work
---

# Implementation history

One entry per completed unit, oldest first. Current state is in [status.md](status.md); design rules live in the architecture docs and [RFCs](decisions/README.md), which entries link to rather than repeat. Commit messages carry further detail. Test counts are "unit" (infrastructure-independent) and "integration" (isolated PostgreSQL).

When a unit finishes, append one short dated entry at the end.

## 2026-08-02 — Foundation: application skeleton

Next.js App Router with strict TypeScript, pnpm lockfile and scripts, ESLint, Prettier, Vitest, type checking, and production build. Established the `src/app/` (thin presentation adapters), `src/core/` (framework-independent shared code), `src/modules/` (isolated feature modules), and `src/infrastructure/` (framework-independent adapters) boundaries, with an architecture test blocking Next.js imports from the latter three. Deliberately no database, schema, money model, connector, authentication, worker, or trading code.

## 2026-08-02 — RFC 0001 accepted

[RFC 0001](decisions/0001-phase-0-ledger-schema.md) defines the minimum ledger boundary and accounting semantics, turning the conceptual domain sketch into the accepted implementation boundary. Changing its tables or accounting model, or any later core `ledger.*` schema, needs another review.

## 2026-08-02 — Ledger foundation (no tables yet)

- `src/core/ledger/` owns branded identifiers (account, category, transaction, source record, raw payload, import), canonical decimal-string USD amounts, SHA-256 digests, calendar dates and UTC timestamps, manual/system/external provenance, versioned source records, account/category postings, correction references, and Zod transaction validation.
- Validation rejects floats, non-canonical decimals, ambiguous destinations, self-corrections, non-system corrections, and transactions with fewer than two entries or a nonzero sum. Transactions require `occurred_on date`; `occurred_at timestamptz` only when the source gives a real instant.
- Exact balance checks use `decimal.js` with input-derived precision; unit and property tests cover balanced/unbalanced generation, decimal encoding, destinations, corrections, timestamps, and precision beyond the library default.
- Docker Compose runs a localhost-only PostgreSQL 16 (pgvector image, named volume). Added `DATABASE_URL` validation, the Drizzle adapter and config, and `db:up`, `db:down`, `db:generate`, `db:migrate`, and `test:integration`. `pnpm test` needs no infrastructure; integration tests verify the server version and pgvector.

## 2026-08-02 — Minimum ledger schema and invariants

Before migrating, RFC 0001 was amended with: dedicated `source_records` versioned by `(source, source_ref, content_digest)` in a non-branching chain, each version normalizing to at most one transaction; explicit `manual|system|external` transaction origin (external requires a source record; corrections are system-originated); corrections that exactly negate the original postings by destination and currency; checked-text kinds instead of PostgreSQL enums; and a migration-owner login separate from the runtime `meridian_app` login.

The migration created nine append-only tables (accounts and revisions, categories and revisions, `raw_payloads`, `imports`, `source_records`, `transactions`, `entries`) and current account/category views. PostgreSQL enforces:

- `UPDATE`/`DELETE` rejection on every ledger table, for both roles
- at least two entries and a deferred exact zero sum per transaction
- one account-or-category destination per entry; unconstrained `NUMERIC` amounts
- USD-only currency and origin/provenance consistency
- exact, unique correction reversals that preserve the original
- import/raw-payload digest agreement; duplicate imports as no-ops
- unique linear source-record versions, one normalized transaction per version
- non-empty encoded nonce/ciphertext on raw payloads
- runtime privileges limited to schema usage, `SELECT`, and `INSERT`

Compose provisions the restricted logins separately from the migration owner; `DATABASE_OWNER_URL` is limited to migrations, disposable integration databases, and owner-role assertions. Verified with a clean-volume rebuild, 38 unit and 58 integration tests; integration properties cover correction replay and import idempotency.

## 2026-08-02 — Category migration policy accepted

YNAB categories seed Meridian's hierarchy without YNAB's envelope model; see [ledger model](architecture/ledger-model.md#category-migration-policy).

## 2026-08-02 — Manual accounts and categories

Scope was ledger destinations only; balances, opening-balance postings, and manual monetary transactions remain separate accounting decisions.

- Core owns strict creation commands, controlled initial metadata (active status, USD, empty display metadata, server-set effective time), a domain-specific destination store, contextual errors, and a service shared by all adapters.
- Each identity and its initial revision insert atomically through the restricted role. Missing parents and duplicates become domain errors without leaking Drizzle into core.
- The root page became the first functional UI: responsive server-action forms plus current account/category indexes, with no business logic. Users set account name, type, class (only for `other`), optional opening date, and category name, kind, and optional parent.
- Corrected before use: the opening value became `opened_on date` instead of a false `timestamptz` instant. The account type/class model is in the [ledger model](architecture/ledger-model.md#account-type-and-accounting-class).

Verified: six migrations on a fresh database, 52 unit and 63 integration tests, including rollback, date preservation, hierarchy reads, and error mapping.

## 2026-08-03 — Integration isolation

`pnpm test:integration` uses the owner login to create and drop a uniquely named disposable database, applies every migration, exercises behavior through the restricted role, asserts owner-role protections separately, and cleans up in `finally`, even on failure. Verified that primary-ledger counts were unchanged and no test database remained. The fixture-polluted local volume was reset with approval, rebuilt, and stayed empty after a later run.

## 2026-08-03 — Raw-payload encryption boundary

libsodium XChaCha20-Poly1305 with a fresh random 24-byte nonce per payload and a versioned, base64 32-byte environment key. Source, SHA-256 plaintext digest, algorithm, and key ID are authenticated as additional data. Core recursively rejects structured payloads with credential, password, authorization, secret, or token fields before sealing; decryption fails closed on tampering, unknown key IDs, or digest mismatch. Tests cover byte-exact round trips, nonce randomness, plaintext non-retention, and each failure mode. Importers must apply this boundary before writing raw payloads. Verified with 67 unit and 63 integration tests.

## 2026-08-03 — YNAB parsing and import planning

`src/modules/ynab/` validates the observed BOM-prefixed `plan.csv` and `register.csv` contracts and builds a deterministic, non-persisting plan:

- `plan.csv` supplies category groups/categories and credit-card evidence; Assigned, Activity, and Available are envelope data and never enter the domain.
- `register.csv` dates parse as MM/DD/YYYY calendar dates; dollar strings canonicalize directly, with no JavaScript number or limited-precision arithmetic.
- Account-type suggestions are advisory: explicit checking, savings, cash, brokerage, IRA/401(k)/403(b)/457(b)/retirement, crypto, RSU (confirm vested only), and bare Robinhood names, plus Credit Card Payments evidence. Ambiguous containers stay unclassified.
- Explicit `Transfer :` payees and Credit Card Payments use Transfer Clearing with no amount/date pairing heuristics, so every source record stays auditable. Starting balances go to Opening Balance Equity; manual and reconciliation adjustments to Balance Adjustment; blank categories to Uncategorized Expense or Income by amount side; zero-dollar rows become ignored provenance, never transaction candidates.
- The CSV boundary rejects invalid UTF-8, missing or changed headers, inconsistent category columns, negative register sides, and simultaneous inflow and outflow.
- Replay identity is account/date/amount plus a duplicate ordinal; full-row SHA-256 digests catch other changes. Since YNAB has no stable transaction ID, later exports go through a change review: reordered exact rows are unchanged; one-to-one metadata changes or a single account/date/amount change are suggested corrections; ambiguous matches stay available for manual pairing; every changed row needs an explicit add, remove, or correct-and-replace decision. Nothing writes automatically.
- Golden fixtures are synthetic and redacted; the private export directory is gitignored.

The owner's real export validated fail-closed with no split marker. Verified with 86 unit and 64 integration tests.

## 2026-08-03 — YNAB account mapping validation and dry-run review

- Every source account needs exactly one explicit link-or-create decision. Links must target a current account; creations reuse core account-details validation (null class for known types so core derives it, explicit class for `other`). Missing, duplicate, unknown, and nonexistent-link decisions fail closed. No IDs are allocated and nothing is written.
- `/ynab` accepts both CSVs (2 MB each), parses in memory, and shows structural counts and suggestions. Review snapshots are opaque, process-local, at most ten per process, and deleted after 30 minutes; a restart or missing snapshot fails closed and needs re-analysis. Validation reloads current accounts.

Verified with 95 unit and 64 integration tests across seven migrations.

## 2026-08-03 — Canonical account-source linkage (RFC 0002)

[RFC 0002](decisions/0002-canonical-account-source-linkage.md) implemented: append-only `ledger.account_sources`, `account_source_link_revisions`, and the security-invoker view `current_account_source_links`. Meridian-local source IDs with a checked source registry and no provider-native identifiers; replay-safe create/link/unlink/relink, including atomic account creation plus linking (exact retries require the full command identity); current resolution, history, and offline/import-only/live-linked derivation. PostgreSQL enforces checked values, server-owned recording time through column grants, one non-branching chain, explicit unlink before relink, and same-account unlink. Architecture tests keep linkage independent of source-record and transaction recording, so linking cannot authorize ingestion. At this point: eight migrations, eleven tables, three views, 103 unit and 84 integration tests.

## 2026-08-03 — Operational connection foundation and source-record association (RFC 0003, RFC 0004 unit one)

[RFC 0003](decisions/0003-operational-live-connections.md) and [RFC 0004](decisions/0004-transaction-source-authority.md) accepted for staged implementation.

- **RFC 0003 foundation:** a protected, mutable, backed-up `ops.*` control plane of six tables: connection lifecycle, replaceable credential envelopes, protected provider-native identity, reviewed discovery, discovery-only fenced checkpoints, bounded run metadata, and immutable sanitized security events. Credential encryption, identity encryption, and identity lookup use three independent versioned keyrings. Separate `meridian_ops_control` and `meridian_read_worker` roles cannot write the ledger, and `meridian_app` has no `ops.*` access. Enforced: role separation, operation-ID replay, credential-generation compare-and-set, immutable checkpoint identity, and fenced discovery commits. No provider calls.
- **RFC 0004 unit one:** append-only `ledger.source_record_account_sets`, `source_record_accounts`, and `current_source_record_account_sets` record which directly observed account sources a source record belongs to, proven against exact historical link revisions, without authorizing normalization. Enforced: non-branching positive sealed sets, source compatibility, deterministic locking, append-only behavior including `TRUNCATE` rejection.

At this point: eleven migrations, thirteen ledger tables, four views, six `ops.*` tables, 135 unit and 98 integration tests. Still disabled: provider calls, non-discovery feeds, authority windows, processing evidence, reconciliation activation, and every monetary write. Schwab stays gated on proving its read credential cannot place orders.

## 2026-09-25 — YNAB CESU-8 export repair

YNAB's register export can encode astral characters (for example an emoji in a renamed category) as CESU-8: two separately UTF-8-encoded UTF-16 surrogate halves, the "Modified UTF-8" bug of Java-family tooling. `src/modules/ynab/csv.ts` retries strict decoding once after rewriting only that 6-byte pattern to correct 4-byte UTF-8; any other invalid sequence, including an unpaired surrogate, still fails with the original error. Verified against the real corrupted export (emoji preserved) and by unit tests for both the repair and continued rejection; 137 unit tests.

## 2026-09-25 — Role-provisioning fix

`pnpm db:provision-roles` (`scripts/provision-database-roles.mjs`) had omitted `meridian_app`. On any volume where the Compose init script never ran, `pnpm db:migrate` failed on migration `0000`'s role assertion, and `drizzle-kit migrate` printed nothing useful because it exits before flushing the error. The script now provisions all three roles from `DATABASE_URL`, `OPS_CONTROL_DATABASE_URL`, and `READ_WORKER_DATABASE_URL`, and must run before `pnpm db:migrate` on any pre-existing volume.

## 2026-09-25 — YNAB mapping review usability

- The `/ynab` form keeps every choice after a failed validation: rows are controlled React state submitted through a manual transition, because the `<form action>` prop's React 19 auto-reset discarded them. The failing row (returned as `sourceName`) is outlined and scrolled into view; rows show only the fields their decision needs.
- New `exclude` decision. Validation fails closed while any included account's transfer or card-payment rows reference an excluded one, since those rows would reach Transfer Clearing without a counterpart.
- Each candidate carries advisory `activity` evidence for spotting the duplicate accounts YNAB creates when a bank is re-linked as a new account: row count, first and last date, exact working balance (new core `sumAmounts`), transfer references, and accounts sharing its account-number suffix.

Verified with 140 unit tests; no schema change, so integration tests were not rerun, and the UI was not tried in a browser.

## 2026-09-25 — YNAB account persistence (RFC 0005)

[RFC 0005](decisions/0005-ynab-account-persistence.md) accepted and implemented by migration `0011_solid_tinkerer.sql`: append-only `ledger.ynab_account_decisions` and view `current_ynab_account_decisions`. A decision is `tracked` (an RFC 0002 YNAB source) or `excluded`, keyed by an HMAC-SHA-256 digest of the NFC-normalized account name under an independent keyring (`src/infrastructure/ynab/label-digest.ts`); the name is never stored.

- `src/modules/ynab/account-decisions.ts` handles lookup, rename targets, and saving. Create, link, renamed (reuse a tracked source), and exclude each run in one transaction with the RFC 0002 inserts, taking the label advisory lock first.
- SQL enforces: only currently linked YNAB sources, one linear chain per digest, `excluded → tracked` as the only re-decision, append-only and `TRUNCATE` rejection, server-owned `recorded_at`.
- `/ynab` shows saved and excluded rows (with "Change decision"), a Save button per new row, and "Save all remaining", each row atomic with its own result. It replaced the dry-run validate action; `finalizeYnabAccountMappings` remains for whole-export validation.

Verified: 146 unit and 106 integration tests across twelve migrations, no schema drift, and the migration applied to the local database with `/ynab` rendering. The save flow was tested only, not tried in a browser, and no real accounts were saved by the implementer.

## 2026-09-25 — Documentation restructure and workflow

- Documentation split into `AGENTS.md` (contract and routing), `PLAN.md` (vision and roadmap), and indexed topic docs under `docs/`, moved verbatim with exact duplicates removed; a later pass condensed the always-loaded files and merged this log.
- Added the design → plan → implement → finish workflow: `docs/plans/` with a template and lifecycle, the Definition of Done in `AGENTS.md`, the `/plan-unit`, `/implement-plan`, and `/project-status` skills, a PR template, and documentation tests for front matter, indexes, links, `AGENTS.md` paths, and plan statuses. The RFC 0004 unit-two handoff became Draft [Plan 0001](plans/0001-rfc-0004-authority-and-reconciliation.md).
- Superseded rule, kept for the record: agents previously had to update both `AGENTS.md` and `PLAN.md` after every change, capturing status, architecture, commands, dependencies, verification results, limitations, and roadmap progress, and describing completed behavior only.

## 2026-09-25 — Public repository preparation

The repository became public as a fresh single-commit history; the earlier private repository is kept as the owner's archive.

- Owner-specific facts left the repository: the institution inventory and related open questions moved to the gitignored `local/` directory (a separate private repository), public docs describe provider paths generically, `PLAN.md` goals are illustrative, and the YNAB account-type suggestion no longer special-cases a bare "Robinhood" account name.
- `.gitignore` covers `local/`, exports, database dumps, key files, and machine files. `.env` custody moved to a password manager, identical on every machine ([security and keys](architecture/security-and-keys.md)).
- `.githooks/pre-commit`, enabled by `pnpm install`, runs gitleaks (`.gitleaks.toml`) and the optional private `local/denylist.txt` on staged changes. A gitleaks scan of the full previous history found no secrets.

## 2026-09-25 — Workflow skills moved to per-user installs

`/project-status`, `/plan-unit`, and `/implement-plan` were removed from `.claude/skills/`. They now live, generic, in the `doc-routed-agentic-coding` repository and are installed once per user, symlinked into `~/.claude/skills/`, so one copy serves every project. The workflow's rules stay in `AGENTS.md`, which now describes the skills as optional and states that a plan is Approved only with the owner's explicit approval.
