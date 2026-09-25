# Meridian

A self-hosted, single-user financial dashboard: one append-only double-entry ledger with independent modules on top. Meridian consolidates bank, brokerage, and crypto accounts into a correct net worth, tracks spending by category, and will eventually define, simulate, and execute systematic investment strategies under manual approval.

It is built for one owner today and designed so it can later be shared. The full vision, phases, and non-goals are in [PLAN.md](PLAN.md).

## What works today

| Capability                                                                                                                      | Status                         |
| ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| Create accounts and categories manually (`/`)                                                                                   | ✅ Available                   |
| Analyze a YNAB export: account suggestions, row counts, date ranges, balances, transfer references, likely duplicates (`/ynab`) | ✅ Available                   |
| Save YNAB accounts: create, link to an existing account, mark as renamed, or exclude; recognized again on the next import       | ✅ Available                   |
| Net-worth dashboard with account balances                                                                                       | 🚧 Next: balance design (RFC)  |
| Account details: institution name, encrypted account and routing numbers                                                        | 📋 Planned after the dashboard |
| Import YNAB transactions and categories                                                                                         | 📋 Planned                     |
| Live bank sync (SimpleFIN first)                                                                                                | 📋 Planned                     |
| Spending by category                                                                                                            | 📋 Planned                     |
| Investments, market data, performance                                                                                           | 📋 Planned                     |
| Strategies, approval queue, execution                                                                                           | 📋 Planned                     |

Current engineering status is in [docs/status.md](docs/status.md).

### Using the current screens

The root page creates manual/offline accounts and categories through thin server actions backed by the framework-independent ledger service. Account types use familiar financial labels such as checking, savings, credit card, loan, brokerage, and retirement; accounting class is derived for known types, while `other` requires an explicit asset/liability choice. Account creation does not invent an opening balance, and future institution connectors will discover or link the same canonical accounts. Balances enter only through later balanced transactions.

Open `/ynab` to review and save accounts from a YNAB plan and register export. Each file is limited to 2 MB and is parsed in memory; the review stays open for 30 minutes and does not survive a server restart, so analyze again if it expires. Each account shows advisory evidence and needs an explicit decision: create a Meridian account, link to an existing one, mark it as a renamed version of an account you already saved, or exclude it. Save rows one at a time or use "Save all remaining". Saved and excluded accounts are recognized on the next import. Suggestions for retirement, brokerage, RSU, and crypto accounts remain advisory and must be explicitly accepted or overridden. Transactions, categories, and balances are not imported yet.

## How it's built

- **One ledger, two data planes.** `ledger.*` holds your financial history: append-only, double-entry, backed up forever. `world.*` will hold refetchable market data and news.
- **Modular monolith.** TypeScript end to end: Next.js for the UI, PostgreSQL 16 with Drizzle, Zod at every boundary, and `decimal.js` for money (never floats).
- **Framework-independent core.** Business logic lives outside Next.js, so the web app, a future CLI, and a future MCP server share one service layer.
- **Self-hosted.** Docker Compose, no public internet exposure.

### Source layout

- `src/app` is the thin Next.js presentation layer.
- `src/core` holds framework-independent shared domain and service code, including canonical ledger values and validation.
- `src/infrastructure` holds adapters such as the PostgreSQL/Drizzle clients, protected-data keyrings, ledger stores, and operational connection store.
- `src/modules` holds isolated feature modules, currently including YNAB parsing and import review. Modules may use core, but may not import from one another.

Design documentation starts at [docs/README.md](docs/README.md); coding agents start at [AGENTS.md](AGENTS.md).

## Requirements

- Node.js 22 or newer
- pnpm 10
- Docker with Docker Compose
- [gitleaks](https://github.com/gitleaks/gitleaks) (`brew install gitleaks`): the pre-commit hook refuses to commit without it

## Run locally

```bash
pnpm install
cp .env.example .env
pnpm db:up
pnpm db:provision-roles
pnpm db:migrate
pnpm dev
```

Then open <http://localhost:3000>.

`pnpm db:down` stops PostgreSQL without deleting its named volume.

### Personal data and more than one machine

This repository is public and holds no personal data. Keep three things outside it:

- **`.env`** in a password manager. Copy it to each machine instead of generating new keys: every machine must use the same keys, or saved YNAB accounts stop being recognized.
- **Your own notes and institution list** in a private repository cloned into the gitignored `local/` directory (`git clone <your-private-repo> local`). Agents read it when present. An optional `local/denylist.txt` (one term per line) makes the pre-commit hook reject any commit that adds one of those terms.
- **Exports and database dumps** in no repository. Put exports in the gitignored `local/imports/` and copy them between machines by hand.

`pnpm install` enables `.githooks/pre-commit`, which scans staged changes with gitleaks.

### Keys

`.env.example` documents every key and how to generate one.

- **`YNAB_LABEL_DIGEST_KEYRING`** is needed to save YNAB accounts. Generate a real key before your first save and back it up alongside the database. If it is lost, saved YNAB accounts are no longer recognized on re-import. See [security and keys](docs/architecture/security-and-keys.md).
- Raw-payload persistence is not wired to an importer yet. Before that persistence path is enabled, replace `RAW_PAYLOAD_ENCRYPTION_KEY` in `.env` with a generated base64 32-byte key using the command documented in `.env.example`. Keep that key and its `RAW_PAYLOAD_KEY_ID` outside version control; losing the key makes retained raw payloads intentionally undecryptable.
- Operational credentials and provider identity are also not populated by the current UI or a connector. Before future operational workflows are enabled, replace every placeholder in the three independent `OPS_CREDENTIAL_*`, `OPS_IDENTITY_*`, and `OPS_IDENTITY_DIGEST_*` keyrings. The integration harness uses the dedicated `OPS_CONTROL_DATABASE_URL` and `READ_WORKER_DATABASE_URL`; neither role can substitute for the ledger application role.

## Database changes

Drizzle reads the validated migration-owner `DATABASE_OWNER_URL` from `.env`. Application runtime, operational control, and the read worker use the separately restricted `DATABASE_URL`, `OPS_CONTROL_DATABASE_URL`, and `READ_WORKER_DATABASE_URL`; the integration harness additionally uses the owner URL for disposable-database lifecycle and owner-role assertions. Generate and apply migrations with:

```bash
pnpm db:generate
pnpm db:migrate
```

Migrations create fourteen append-only ledger tables, five ledger current views, six mutable/retention-specific operational tables, role grants, and database-enforced invariants. Migrations also assert that the `meridian_app`, `meridian_ops_control`, and `meridian_read_worker` roles already exist and fail closed if they do not. A newly initialized Compose volume provisions all three logins automatically via `docker/postgres/init-app-role.sh` before migrations run, but that script only runs once, the first time the volume is created. Run `pnpm db:provision-roles` before `pnpm db:migrate` on any pre-existing volume (for example, one created before this project added a role) to create whichever of those three logins are still missing; it is idempotent and safe to re-run.

## Validate

```bash
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm test:integration
pnpm build
```

`pnpm test` runs without infrastructure. Start PostgreSQL before `pnpm test:integration`; the command creates a disposable database, applies all migrations, verifies PostgreSQL 16, pgvector, ledger/operational role separation, append-only behavior, accounting constraints, connection lifecycle, fenced discovery, source-record association, corrections, and idempotency, then drops the test database. It never writes fixtures to the primary development ledger. The test suite also prevents `src/core`, `src/modules`, and `src/infrastructure` from importing Next.js.

## Troubleshooting

- **`pnpm db:migrate` fails with no useful error.** A required database role is probably missing; `drizzle-kit migrate` exits before printing the reason. Run `pnpm db:provision-roles`, then migrate again.
- **"YNAB account recognition is not configured."** Set `YNAB_LABEL_DIGEST_CURRENT_KEY_ID` and a real `YNAB_LABEL_DIGEST_KEYRING` in `.env`, then restart the server.
- **Keys suddenly look like placeholders.** Copying `.env.example` over `.env` replaces every real key with a placeholder. Restore `.env` from your backup; if the YNAB digest key is gone, saved YNAB accounts will show as unsaved.
- **Changes to `.env` have no effect.** Next.js reads `.env` only at startup. Restart `pnpm dev`.
- **"This YNAB review expired."** Reviews last 30 minutes and are lost on server restart. Analyze the export again; saved accounts are not affected.
