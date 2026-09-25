---
summary: RFC 0002 (Accepted): Meridian-local account sources and append-only link, unlink, and relink history to canonical accounts
read_when: Linking imports or connectors to accounts, or changing account-source identity
---

# RFC 0002: Canonical account source linkage

- Status: Accepted
- Date: 2026-08-03
- Accepted: 2026-08-03
- Implemented: 2026-08-03
- Decision owners: project owner and implementer
- Depends on: RFC 0001
- Followed by: RFC 0003 and RFC 0004
- Amended by: RFC 0005 (keyed-digest recognition of previously saved YNAB accounts)

## Context

Meridian accounts are provider-independent financial identities. An account created manually or from a YNAB migration must later receive data from an approved live connector without becoming a second canonical account.

At proposal time, the schema had canonical accounts and versioned external records, but no durable representation of the reviewed decision that an import or connector account represented a canonical account. The YNAB review validated create-or-link choices without persisting them. Live connection identity, credentials, capabilities, source-record association, and transaction cutover were not implemented.

The accepted implementation added the core `ledger.*` boundary described below. It did not add live connection identity, source-record association, transaction authority, or transaction writes.

## Goals

- Preserve one canonical account across manual setup, imports, and live connectors.
- Allow many import or connector identities to describe one canonical account.
- Resolve one account-source identity to at most one current canonical account.
- Record link, unlink, and relink decisions without mutation.
- Derive offline, import-only, and live-linked UI states.
- Keep provider-native identifiers, credentials, capabilities, and connection health outside canonical accounts and linkage tables.
- Ensure linkage cannot by itself enable transaction ingestion or trading.

## Non-goals

- Provider OAuth, credentials, connection persistence, or sync scheduling.
- Mapping provider-native account identifiers to Meridian-local source IDs.
- Associating source records or transactions with account-source identities.
- Correcting transactions created under a mistaken historical link.
- Transaction-source authority, YNAB-to-live cutover, or cross-provider deduplication.
- Balance and position snapshots, capabilities, or trade eligibility.

## Implemented Scope

Add two append-only Plane A tables and one current view:

| Object                                 | Responsibility                                                   |
| -------------------------------------- | ---------------------------------------------------------------- |
| `ledger.account_sources`               | Stable Meridian-local import or connector account identity       |
| `ledger.account_source_link_revisions` | Reviewed append-only link, unlink, and relink decisions          |
| `ledger.current_account_source_links`  | Current linked source identities and their canonical account IDs |

No existing table changes in this unit. In particular, `ledger.accounts`, `ledger.source_records`, and `ledger.transactions` gain no source-link columns.

## Account Sources

`ledger.account_sources` contains only a Meridian-local identity:

```sql
ledger.account_sources (
  id            uuid primary key,
  source        text not null,
  source_kind   text not null,
  ingested_at   timestamptz not null,
  recorded_at   timestamptz not null default now()
)
```

Semantics:

- `id` is a random Meridian UUID and is the only account-source reference used by core.
- `source` is checked against the reviewed registry: `ynab`, `manual_csv`, `simplefin`, `teller`, `schwab`, or `snaptrade`. It is not a display label or implementation version. Adding a source is an ordinary reviewed core constraint migration so arbitrary provider-native values cannot enter this field.
- `source_kind` is checked text: `import` or `connector`.
- `ingested_at` is when Meridian first observed the source account.
- `recorded_at` is when the identity was durably recorded.
- Replaying registration with the same caller-provided ID and identical values is a no-op; conflicting values for an existing ID fail closed.

Provider account IDs, account numbers, masks, labels, connection IDs, credentials, and tokens do not enter this table. A future operational connection boundary must map encrypted or otherwise protected provider-native identity to `account_source_id`. YNAB receives a local source ID when its reviewed mapping is first persisted; later exports resolve it only through the explicit change-review and mapping workflow, never by assuming the account name is a stable identifier.

This separation means RFC 0002 can establish canonical linkage before choosing provider credential and native-identity storage. It also means RFC 0002 alone is insufficient to run a live connector.

## Link Revisions

`ledger.account_source_link_revisions` records reviewed mapping decisions:

```sql
ledger.account_source_link_revisions (
  id                           uuid primary key,
  account_source_id            uuid not null references ledger.account_sources(id),
  account_id                   uuid not null references ledger.accounts(id),
  status                       text not null,
  supersedes_link_revision_id  uuid null references ledger.account_source_link_revisions(id),
  reason_code                  text not null,
  recorded_at                  timestamptz not null default now()
)
```

Semantics:

- `status` is checked text: `linked` or `unlinked`.
- `reason_code` is checked text: `initial_mapping`, `user_unlinked`, `mapping_correction_unlinked`, `mapping_correction_linked`, or `source_reassociated`.
- `initial_mapping` is valid only for a linked root; unlink reasons are valid only for `unlinked`; relink reasons are valid only for `linked` revisions after an unlink.
- No user-entered free text is retained in these Plane A rows.
- The first revision for a source identity must be `linked`.
- `linked -> unlinked` retains the same source identity and canonical account.
- `unlinked -> linked` may retain the account or select another canonical account.
- `linked -> linked` and `unlinked -> unlinked` are forbidden.
- Moving a source requires explicit unlink then link decisions.
- Link decisions use recording order only; no retroactive or future-effective linkage exists.

Changing a link never moves, rewrites, or deletes transactions. Before any future account-source identity is allowed to produce transactions, source-record association and correction policy must be extended so a relink can detect affected history and fail closed pending reviewed correction. Until then, RFC 0002 linkage is pre-ingestion identity resolution only.

## Linear History

Each account source has at most one root link revision and one non-branching successor chain:

- partial unique root index on `account_source_id` where `supersedes_link_revision_id is null`;
- unique index on `supersedes_link_revision_id`;
- predecessor cannot equal the new revision;
- predecessor belongs to the same account source;
- predecessor must be the chain tip;
- PostgreSQL enforces legal transitions and account retention on unlink.

Concurrency fails closed. Competing decisions against one predecessor cannot branch, and the service must not retry against a mapping the user did not review.

Command IDs provide operation idempotency. Replaying the same revision ID with identical values is a no-op; a new revision ID that attempts `linked -> linked` is a conflict rather than an implicit success.

## Cardinality

- One account source has zero or one current canonical account.
- One canonical account may have many current account sources.
- YNAB history and a live connector may both link to the same canonical account.
- Multiple identities from one provider may link to one account only through explicit decisions. The UI warns, but the database does not forbid this because provider identity replacement can be legitimate.

## Current View

`ledger.current_account_source_links` selects the chain tip for each account source and exposes only tips whose status is `linked`.

The view includes:

- account source ID;
- source and source kind;
- canonical account ID;
- current link revision ID;
- reason code and recorded timestamp.

It uses `security_invoker = true`. The restricted application role receives `SELECT` on the view and `SELECT, INSERT` on the tables, with no mutation or DDL privileges. The tables contain no provider-native identifier or free-text description.

## Derived UI States

Link state is derived rather than stored on `ledger.accounts`:

- `offline`: no current account-source links;
- `import_only`: one or more current `import` links and no `connector` link;
- `live_linked`: at least one current `connector` link;
- `multiple_sources`: more than one current source identity, displayed alongside import/live status.

Connection health such as `healthy`, `stale`, `reauthorization_required`, or `disconnected` belongs to the future operational connection service. The UI combines that state with current links. Disconnecting a provider never closes a canonical account, and closing an account never deletes source or link history.

## Core API Boundary

Core owns provider-independent identifiers, schemas, commands, services, and persistence ports. The implemented service exposes:

```ts
registerAccountSource(command);
registerAndLinkAccountSource(command);
createAccountAndLinkSource(command);
unlinkAccountSource(command);
linkUnlinkedAccountSource(command);
relinkAccountSource(command);
resolveCurrentAccount(accountSourceId);
listCurrentSources(accountId);
listLinkHistory(accountSourceId);
```

Commands receive caller-allocated UUIDs, following the existing ledger service pattern.

An approved create-and-link flow atomically:

1. creates the canonical account and initial revision;
2. registers the new local account-source identity;
3. appends the initial link revision.

An approved link-existing flow atomically registers the new local source and appends its initial link. Rediscovery of an already registered source does not append another initial link. Its current state must be loaded and any new decision must reference the reviewed chain tip. Any failure rolls back the operation.

## Ownership Boundaries

- Core owns generic account-source and link policy.
- Provider modules normalize discovery responses.
- The future accounts module owns institutions, operational connections, protected provider-native account lookup, read credentials, connection health, and sync orchestration.
- Infrastructure owns PostgreSQL adapters and credential encryption.
- Execution owns write credentials and trade eligibility.

Credentials and tokens never enter account-source or link tables. Read and write credentials remain separate. A connector link grants no capability.

## Capabilities

Capabilities stay outside canonical accounts and link revisions. Effective capability is the intersection of connector support, provider restrictions, authorization, account eligibility, credential class, process, and execution safety policy.

`live_linked` does not mean tradeable. No link bypasses stale-data, reconciliation, allowlist, notional, order-count, or kill-switch policy.

## Transaction Authority And Overlap

A link states only that a source account and canonical account represent the same financial container. RFC 0002 does not provide a transaction-ingestion API and does not prove authority in PostgreSQL.

No live connector transaction writer may be implemented until a separate accepted source-authority design defines and mechanically enforces:

- account-source association for normalized source records;
- authoritative source by canonical account and feed kind;
- date or actual-instant cutover boundary;
- overlap quarantine and review;
- correction semantics for normalization or mapping errors;
- source precedence and behavior when periods overlap.

For YNAB migration, the intended direction is YNAB authority before an approved cutoff and live connector authority on or after it. Amount/date/payee similarity is evidence for review, never proof that records are identical.

Balance or position observations may later coexist from several sources, but discrepancies are reconciliation signals and never permission to invent adjustment transactions.

The implementation of RFC 0002 must include an architecture test or equivalent mechanical boundary proving that its service and adapter have no dependency on transaction recording. When connector transaction ingestion is later introduced, that test must be replaced or extended by the accepted authority gate rather than removed silently.

## Source Records And Mapping Corrections

This unit does not modify `ledger.source_records`. PostgreSQL therefore cannot yet prove that a source record used the account selected by a source link.

A mapping correction made before transaction ingestion is an ordinary unlink/relink. Once an account source has produced financial records, relinking must fail closed until a later accepted design can:

- associate source records with account-source identity;
- identify every affected normalized transaction;
- preserve the unchanged external observation;
- append system correction and correctly provenanced replacement facts without violating source-version uniqueness.

This later design may require a source-record/account-source association table rather than a nullable column because transfers and multi-account payloads can involve more than one source account. RFC 0002 does not guess that boundary.

## Database Enforcement

PostgreSQL enforces:

1. source belongs to the reviewed registry;
2. checked `import|connector` source kind;
3. `ingested_at <= recorded_at`;
4. checked `linked|unlinked` status;
5. checked reason code and reason/status compatibility;
6. one root and one linear successor chain per account source;
7. same-source predecessor retention;
8. legal state transitions;
9. same-account retention on unlink;
10. valid account-source and canonical-account references;
11. append-only rejection for application and owner roles;
12. restricted runtime grants;
13. deterministic current-link resolution.

Both tables receive `ENABLE ALWAYS` mutation-rejection triggers. Drizzle schema, handwritten trigger SQL, metadata, and core Zod validation must remain aligned.

## Required Tests

- account-source registration replay by ID is idempotent;
- conflicting replay values fail;
- initial linking succeeds;
- duplicate roots and competing successors fail;
- illegal state transitions fail;
- unlink preserves the prior canonical account;
- explicit unlink then relink succeeds;
- repeated link command IDs are idempotent;
- many source identities may link to one account;
- unknown references fail;
- owner and application roles cannot update or delete;
- current view exposes only linked chain tips;
- create-and-link and link-existing operations are atomic;
- rediscovery does not append another root link;
- service resolution fails closed for unknown or unlinked sources;
- no schema, error, log, view, or fixture contains provider-native account identifiers;
- no linkage code imports transaction-recording services;
- UI states derive correctly as offline, import-only, and live-linked.

## Implemented Migration Impact

Migration `0007_romantic_mephisto.sql` added two core `ledger.*` tables and one view. The implementation includes aligned Drizzle metadata, append-only triggers, restricted grants, core types and services, a PostgreSQL adapter, architecture coverage, and integration tests. YNAB persistence does not yet reuse the boundary because no mapping has been persisted.

No data backfill is required because no YNAB mapping or live connector data has been persisted.

## Accepted Decisions

The owner accepted:

1. two core Plane A tables plus one current view;
2. Meridian-local UUIDs as the only core account-source identity;
3. the finite reviewed source registry and `import|connector` source-kind distinction;
4. provider-native identifiers and connection records remaining outside this unit;
5. explicit unlink before relink;
6. recording-order-only history with no retroactive effective time;
7. many account sources per canonical account;
8. YNAB and live connectors sharing the local linkage boundary;
9. checked reason codes with no user-entered Plane A note;
10. credentials, health, and capabilities remaining outside linkage;
11. linkage not enabling transaction writes;
12. mandatory source-authority and source-record-association design before live transaction ingestion;
13. relinking after financial ingestion remaining blocked until correction provenance is representable;
14. no existing table changes in this unit;
15. UI states derived from current links rather than stored on canonical accounts.

## Consequences

Imported and manually created accounts can later become live-linked without changing canonical identity. Link decisions remain append-only and auditable while avoiding permanent storage of provider account identifiers. The implemented boundary deliberately provides only the safe identity/link layer: operational provider lookup and transaction authority remain explicit future gates rather than hidden side effects of a successful connection.
