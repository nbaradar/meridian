---
summary: RFC 0003 (Accepted, foundation implemented): protected ops.* control plane for live connections, credentials, provider identity, discovery, and checkpoints
read_when: Building a live connector, handling provider credentials or identity, or changing sync checkpoints
---

# RFC 0003: Operational live connections

- Status: Accepted, foundation implemented 2026-08-03
- Date: 2026-08-03
- Decision owners: project owner and implementer
- Depends on: RFC 0002
- Related: accepted RFC 0004

## Context

RFC 0002 gives Meridian a provider-independent identity for an imported or
connector account and an append-only decision linking that identity to a
canonical account. It deliberately excludes every mutable operational concern:
provider-native IDs, authorization, credentials, connection lifecycle,
discovery, health, and capabilities.

Those concerns cannot safely be placed on `ledger.accounts`. They change
frequently, include revocable secrets, and do not describe financial facts.
They also do not belong in `world.*`, which is disposable and intended for
refetchable external market and news observations. Losing the provider mapping
or refresh credential would break account recovery and unattended sync.

This RFC defines a third PostgreSQL persistence class named `ops.*`. It is a
mutable, backed-up control plane, not a third financial data plane. The two
financial data planes and their rules remain unchanged:

- `ledger.*` remains append-only, irreplaceable financial history;
- `world.*` remains refetchable external data;
- `ops.*` would contain only operational connection state and protected
  provider lookup material.

Adding this schema changed the prior two-schema database convention and was
explicitly accepted on August 3, 2026. The implemented foundation remains
provider-neutral and does not authorize live provider calls or transaction
writes.

## Goals

- Connect an approved read-only provider without changing canonical account
  identity.
- Map protected provider-native account identity to an RFC 0002
  `account_source_id`.
- Keep credentials, identifiers, health, and capabilities out of `ledger.*`.
- Separate read authorization from all execution credentials and processes.
- Make authorization refresh, reconnect, disconnect, and rediscovery explicit.
- Fail closed when identity, authorization, or capability is ambiguous.
- Supply observations to a later authority gate without writing transactions.

## Non-goals

- Transaction normalization or ledger writes.
- Source-record/account-source association or source authority.
- Cross-provider deduplication or YNAB cutover.
- Trade authorization, order placement, or execution credentials.
- Balance, position, transaction, or raw-payload persistence.
- Choosing SimpleFIN over Teller before an actual coverage check.

## Proposed Scope

Add a protected operational schema with six logical stores:

| Object                    | Responsibility                                                     |
| ------------------------- | ------------------------------------------------------------------ |
| `ops.connections`         | Current provider authorization and lifecycle state                 |
| `ops.connection_secrets`  | Current encrypted read credential envelope                         |
| `ops.discovered_accounts` | Protected provider account lookup mapped to a local account source |
| `ops.sync_checkpoints`    | Fenced lease, cursor, and monotonic sync generation                |
| `ops.sync_runs`           | Bounded operational run status with no financial payload           |
| `ops.connection_events`   | Immutable sanitized security lifecycle audit                       |

Exact columns, indexes, grants, and retention must be reviewed with the
migration if this RFC is accepted. The intended minimum shape is described
below so the security boundary is decided before code is written.

## Connections

`ops.connections` owns one provider authorization container:

```sql
ops.connections (
  id                    uuid primary key,
  source                text not null,
  authorization_class   text not null,
  status                text not null,
  status_reason         text null,
  credential_generation bigint not null,
  authorized_at         timestamptz null,
  expires_at            timestamptz null,
  last_attempted_at     timestamptz null,
  last_succeeded_at     timestamptz null,
  created_at            timestamptz not null,
  updated_at            timestamptz not null
)
```

- `source` uses the same reviewed registry as RFC 0002 and must be a
  `connector` source.
- `authorization_class` is initially `read_only`. A trade credential is never
  a wider value in this table; it belongs to the execution worker boundary.
- `status` is checked text: `pending`, `active`, `reauthorization_required`,
  `disabled`, or `revoked`.
- `status_reason` uses checked operational reason codes, not raw provider error
  bodies.
- Current lifecycle fields are mutable because they are control state, not
  financial history. Security-relevant changes produce sanitized audit events.
- A disconnected connection does not unlink or close a canonical account.

Legal transitions are explicit:

- a new connection starts `pending` with no credential and null
  `authorized_at`;
- successful authorization moves `pending` or `reauthorization_required` to
  `active` while atomically installing the next credential generation;
- provider authentication failure moves `active` to
  `reauthorization_required`;
- a user may move `active` to `disabled`, or `disabled` back to `active` only
  after the current credential is revalidated;
- local or provider revocation moves any non-revoked state to `revoked`, deletes
  the current secret, and is terminal for that connection identity.

Before admitting a provider call, the service rechecks in one operational
transaction that the connection is `active`, authorization is unexpired, and
the credential generation matches the secret. Discovery and observation calls
also require the current feed fencing token; authorization lifecycle calls use
the locked connection generation instead.

Disablement prevents new calls but cannot cancel an HTTP request already
admitted. An in-flight result is discarded unless generation, status, and any
required fence still match before persistence, and plaintext credentials are
disposed immediately after the call. Provider-side revocation is required for
a hard cutoff of a bearer token already released to a process.

## Credential Protection

`ops.connection_secrets` contains one current encrypted envelope and monotonic
generation per connection. It follows the raw-payload cryptographic standard:
libsodium XChaCha20-Poly1305, a fresh nonce, a base64 32-byte environment key,
an explicit key ID, and authenticated source, connection, generation,
authorization class, algorithm, and key-status metadata.

The semantics differ from raw payload retention:

- only the current usable read credential is retained;
- credential refresh uses compare-and-swap on the prior generation and replaces
  the old ciphertext atomically;
- revocation deletes the usable ciphertext rather than preserving a dangerous
  credential in append-only history;
- plaintext is held only for the provider call and is never logged;
- token response bodies must pass a dedicated allowlist parser before sealing;
- database backups are encrypted off-host and require the external keyring;
- losing the key requires reauthorization and cannot silently fall back.

Older encrypted backups can contain ciphertext that existed before revocation;
provider-side revocation is therefore mandatory. Backup access and retention
remain restricted even though the ciphertext should no longer authorize use.

Keys stay outside PostgreSQL and the repository. Rotation may decrypt with the
old key and reseal with the new key in one controlled maintenance operation.
No application endpoint returns ciphertext, nonce, or token metadata.

Credential encryption, provider-identity encryption, provider-identity lookup,
and raw-payload encryption use separate versioned keys or domain-separated
subkeys. Reusing `RAW_PAYLOAD_ENCRYPTION_KEY` directly is forbidden. Refresh,
disable, and revoke operations lock the connection row and compare the expected
generation, so a delayed refresh cannot resurrect a credential after
revocation.

## Provider-Native Account Identity

`ops.discovered_accounts` maps one discovered provider account to one Meridian
account source:

```sql
ops.discovered_accounts (
  id                           uuid primary key,
  connection_id                uuid not null references ops.connections(id),
  account_source_id            uuid not null references ledger.account_sources(id),
  provider_account_id_ciphertext text not null,
  provider_account_id_nonce    text not null,
  provider_account_id_digest   text not null,
  key_id                       text not null,
  digest_key_id                text not null,
  status                       text not null,
  first_observed_at            timestamptz not null,
  last_observed_at             timestamptz not null
)
```

- Provider account IDs and any account number or mask are protected data.
- `provider_account_id_digest` is a keyed HMAC lookup digest, not a plain hash,
  because provider identifiers may have a small or predictable value space.
- The lookup-HMAC key is separate from the encryption key, versioned by
  `digest_key_id`, and held in the external keyring. Rotation decrypts and
  re-digests protected IDs in a controlled maintenance operation.
- Associated data binds ciphertext to provider, connection, local row, and key
  ID so ciphertext cannot be moved between records.
- A uniqueness constraint on `(connection_id, provider_account_id_digest)`
  prevents duplicate discovery for the same provider authorization.
- PostgreSQL verifies that the connection and account source have the same
  reviewed `source` and that the account source has `source_kind = connector`.
- At most one `active` discovered-account row may reference an account source.
  Retired rows may retain the same account source so a reviewed replacement
  connection can preserve RFC 0002 identity without overwriting history.
- Display names and masks are not durable identity. If the UI needs them, they
  are encrypted operational metadata with minimal retention and never enter
  logs or fixtures.
- Discovery never guesses a canonical account from name, mask, or balance. A
  reviewed create-or-link decision creates or selects the RFC 0002 account
  source and link.
- Renewing authorization for the same connection reuses the discovered row.
  Replacing the connection or provider account retires the old row, creates a
  new discovered identity, and requires explicit review before it can reuse an
  account source.

## Capabilities

Capabilities do not live on canonical accounts. A connector adapter declares
static support, while current effective capability is derived from:

- provider and endpoint support;
- the granted read authorization;
- discovered account eligibility;
- connection status and staleness;
- process credential class;
- later reconciliation and execution safety gates.

The initial operational boundary permits only `balances`, `transactions`, and
`positions`. `trade` is never emitted by a read connector. A live link means
only that a connector identity maps to the canonical account; it does not mean
that any data feed is authoritative or that the account can trade.

## Connector Boundary

Provider modules own strict schemas and normalization of provider transport
responses into provider-neutral observations. The shared connector contract
must not emit `LedgerEvent` or invoke transaction persistence:

```ts
interface ReadConnector {
  readonly id: string;
  readonly capabilities: readonly ReadCapability[];
  discover(ctx: ConnectorContext): Promise<readonly DiscoveredAccount[]>;
  observe(ctx: SyncContext): AsyncIterable<ConnectorObservation>;
}
```

An observation retains provider source identity, provider account identity,
retrieval time, provider date/instant precision, and the sealed raw response
reference. RFC 0004, if accepted, decides whether an observation may become a
source record and transaction. The connector process has no transaction-write
port.

Acceptance of this RFC alone permits authorization, health checks, and account
discovery only. Production balance, position, and transaction observation calls
remain disabled until an accepted persistence orchestration stores the sealed
raw payload before normalization and defines checkpoint advancement. The
adapter contract may be implemented and fixture-tested before that gate, but no
job may invoke `observe` against a live provider.

## Provider Safety

### SimpleFIN and Teller

- SimpleFIN is evaluated first for the three required bank institutions;
  Teller remains the fallback.
- Setup URLs, redirects, and provider URLs are untrusted network input. The
  adapter permits only reviewed HTTPS origins, rejects embedded credentials in
  URLs, resolves and rejects private/link-local destinations, and limits
  redirects, response sizes, and timeouts.
- Tests use redacted recorded fixtures and never a live institution.

### Schwab

- Only official Schwab APIs are permitted.
- The read connector is not implemented until documentation and an actual
  authorization grant prove the web/worker credential cannot place orders.
- If Schwab offers one token whose scope also permits trading, that token cannot
  load in the read connector process. The Schwab read connector is deferred
  unless a safe separate authorization posture is documented and tested.
- No test, setup flow, or discovery call may place an order.

### SnapTrade

- SnapTrade remains optional pending Fidelity access and single-user pricing
  checks.
- It is read-only in this boundary even if its API exposes wider features.

Unofficial or reverse-engineered provider APIs are prohibited.

## Sync Lifecycle

- `ops.sync_checkpoints` owns one current cursor and lease per connection/feed.
  Lease acquisition increments a monotonic fencing token. Every cursor or run
  update requires the token, so an expired worker cannot commit after a new
  worker acquires the lease.
- One connection/feed has at most one unexpired sync lease.
- Every provider call has a timeout, bounded pagination, and a hard record
  ceiling.
- Retries are bounded and limited to explicitly retryable transport failures;
  authorization and schema failures fail closed.
- A cursor is advanced only after all observations in the page have been sealed
  to `ledger.raw_payloads` and their later persistence operation commits. A
  crash after raw-payload commit but before checkpoint advancement safely
  refetches content and relies on digest/source idempotency.
- Provider cursors are protected operational state associated with the
  connection. They contain no raw financial payloads and do not advance when
  later authority processing rolls back.
- `ops.sync_runs` records sanitized status, attempt counts, timestamps, and
  reason codes. It contains no balances, amounts, account identifiers, raw
  payloads, or provider response text.
- Retention is bounded because sync-run diagnostics are operational, not
  permanent ledger facts.

RFC 0004 proposes the first transaction-processing orchestration. Position and
balance checkpoint semantics remain disabled until their own persistence
boundaries exist. Discovery checkpoints may operate under this RFC because
discovery writes no financial observation.

## Security Audit

`ops.connection_events` is append-only even though the surrounding schema is
mutable. It records connection ID, event type, expected and resulting
credential generations, actor class, sanitized reason code, and server-owned
timestamp for authorization, refresh, disable, re-enable, reauthorization,
revocation, restore validation, and key rotation. It stores no ciphertext,
native identifier, token metadata, or provider response.

Security events are backed up and retained for the life of the connection plus
the reviewed backup-retention period. Runtime roles may insert through the
connection service and read only the events needed by the owner UI; they cannot
update, delete, or prune them.

## Roles And Processes

- The web process may initiate reviewed connection and mapping flows but cannot
  decrypt credentials during ordinary page rendering.
- A dedicated read connector worker may decrypt read credentials and access
  operational connection rows.
- The worker receives no execution credential and no broker write API adapter.
- The restricted ledger runtime role retains its existing grants; cross-schema
  references do not grant `ops.*` access.
- Migration ownership, application control-plane access, read-worker access,
  and future execution-worker access are separate roles.

## Backup And Recovery

`ops.*` is backed up because provider mappings and authorization state are not
reliably refetchable. Backups are encrypted and retained separately from the
append-only ledger backup policy. Recovery without the environment key restores
metadata but cannot decrypt credentials or provider identity; Meridian must
show `reauthorization_required` rather than guessing.

After any restore, all restored connections are forced to
`reauthorization_required` before a worker can load credentials. Each provider
must validate or renew the current generation before the connection can return
to `active`; stale backup metadata never silently resumes sync.

Backup and restore tests must prove that no plaintext secret or provider-native
identifier appears in SQL dumps, logs, errors, or test artifacts.

## Required Tests

- connection lifecycle allows only reviewed transitions;
- read credential seal/open, tamper, wrong-key, rotation, generation conflict,
  delayed-refresh, and revocation paths;
- provider ID lookup uses keyed HMAC and authenticated encryption;
- discovered account, connection, and account-source identities must share the
  same connector source;
- duplicate discovery resolves to one operational account identity;
- discovery never auto-links by display metadata;
- provider schemas reject unknown or malformed security-sensitive responses;
- redirects, private destinations, pagination, sizes, retries, and timeouts are
  bounded;
- fenced lease takeover rejects stale-worker cursor and run updates;
- raw-payload failure or processing rollback cannot advance a cursor;
- no logs, errors, snapshots, or fixtures contain tokens or native IDs;
- read worker cannot import an executor or access trade credentials;
- connector modules cannot import transaction-recording services;
- database role tests prove `ledger.*`, `world.*`, and `ops.*` grants remain
  separated;
- security events are append-only, sanitized, and retained independently from
  bounded sync diagnostics;
- encrypted backup/restore preserves mappings and fails closed without keys.

## Acceptance Decisions

Accepted August 3, 2026 with these decisions:

1. a mutable, backed-up `ops.*` control plane outside the two financial data
   planes;
2. the six-object minimum boundary and its distinct retention rules;
3. application encryption plus separately keyed, versioned lookup digests for
   provider account IDs;
4. replacement, rather than append-only retention, of usable credentials;
5. separate web, read-worker, ledger, migration, and execution privileges;
6. read-only connector observations that cannot write transactions;
7. reviewed mapping rather than account-name, mask, or balance matching;
8. capability derivation outside canonical accounts;
9. SimpleFIN-first coverage testing and Teller fallback;
10. the Schwab authorization gate described above;
11. encrypted operational backup and recovery requirements;
12. RFC 0004 acceptance as a separate prerequisite for transaction writes.

## Implementation Status

Accepted August 3, 2026. Migrations `0008_salty_ikaris.sql` and
`0010_modern_nehzno.sql` implement the six-table `ops.*` foundation, dedicated
operational-control and read-worker roles, checked lifecycle transitions,
operation-ID replay, replaceable credential generations, protected discovery,
immutable security events, immutable checkpoint identity, and discovery-only
fenced commits. Infrastructure uses independent versioned XChaCha20-Poly1305
keyrings for credentials and provider identity plus a separate HMAC-SHA256
keyring for lookup digests. Rediscovery refreshes protected observations only
when stable identity matches.

No connector, scheduler, backup automation, web connection workflow, live
observation call, or non-discovery checkpoint feed is implemented. Schwab
remains blocked pending proof that read-worker authorization cannot place
orders. RFC 0004's later authority stages remain mandatory before any observed
transaction can become a ledger fact.

## Consequences

Meridian gains a coherent place for revocable connection state without
weakening either financial data plane or polluting canonical accounts. The cost
is an explicit third persistence class with its own backup, mutation, role, and
security rules. The accepted foundation enables future account discovery and
health work only; it does not authorize transaction ingestion.
