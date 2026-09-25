---
summary: Index of every document under docs/ and when to read it
read_when: The routing table in AGENTS.md does not cover the task
---

# Documentation index

Each entry is the document's `read_when`; its `summary` is in the document's own front matter. Individual plans are indexed in [plans/README.md](plans/README.md). Top level: `AGENTS.md` (agent contract and routing), `PLAN.md` (vision, phases, open decisions), `README.md` (for the owner: capabilities, setup, troubleshooting).

- [status.md](status.md): Starting any task, deciding what to build next, or finishing a unit of work
- [history.md](history.md): Investigating when or why something was built, or recovering context a commit message references; not needed for routine work
- [architecture/overview.md](architecture/overview.md): Designing anything that stores data, choosing between ledger and world schemas, or needing the reasoning behind an invariant
- [architecture/ledger-model.md](architecture/ledger-model.md): Adding or changing tables, ingesting external data, modeling accounts or categories, or handling dates and amounts
- [architecture/modules.md](architecture/modules.md): Creating or changing a module, connector, provider, strategy, or executor interface, or deciding where code belongs
- [architecture/technology.md](architecture/technology.md): Adding a dependency, library, or service, or reconsidering a technology choice
- [architecture/safety.md](architecture/safety.md): Any work on execution, orders, strategies, broker credentials, backups, or network exposure
- [architecture/security-and-keys.md](architecture/security-and-keys.md): Adding, rotating, or backing up a key, handling secrets, or storing anything sensitive
- [architecture/ui.md](architecture/ui.md): Building or restyling any page or navigation
- [architecture/hosting.md](architecture/hosting.md): Deploying, running jobs unattended, or choosing where Meridian runs
- [institutions.md](institutions.md): Building or choosing a connector, market data or news provider, or anything touching a specific institution
- [future/expansion.md](future/expansion.md): Anything involving other users, authentication, sharing, per-user keys, connector requests, or storing account and routing numbers
- [plans/README.md](plans/README.md): Designing the next unit of work, starting an approved plan, or checking what is in progress
- [decisions/README.md](decisions/README.md): Looking for the reasoning behind an implemented boundary, or writing a new RFC
- [decisions/0001-phase-0-ledger-schema.md](decisions/0001-phase-0-ledger-schema.md): Changing ledger tables, transactions, entries, corrections, source records, or raw-payload storage
- [decisions/0002-canonical-account-source-linkage.md](decisions/0002-canonical-account-source-linkage.md): Linking imports or connectors to accounts, or changing account-source identity
- [decisions/0003-operational-live-connections.md](decisions/0003-operational-live-connections.md): Building a live connector, handling provider credentials or identity, or changing sync checkpoints
- [decisions/0004-transaction-source-authority.md](decisions/0004-transaction-source-authority.md): Importing or normalizing transactions, reconciliation, authority windows, or the YNAB cutover
- [decisions/0005-ynab-account-persistence.md](decisions/0005-ynab-account-persistence.md): Changing YNAB account saving, recognition, renamed or excluded accounts, or the YNAB label digest key
- [decisions/0006-balance-observations.md](decisions/0006-balance-observations.md): Recording or displaying balances, computing net worth, correcting a balance, or adding a new balance source
