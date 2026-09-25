---
summary: RFC 0004 (Accepted, staged): which source is authoritative for an account's transactions, reconciliation gates, and the YNAB-to-live cutover
read_when: Importing or normalizing transactions, reconciliation, authority windows, or the YNAB cutover
---

# RFC 0004: Transaction source authority and cutover

- Status: Accepted, association stage implemented 2026-08-03
- Date: 2026-08-03
- Decision owners: project owner and implementer
- Depends on: RFC 0001 and RFC 0002
- Related: accepted RFC 0003

## Context

RFC 0001 records versioned external observations and permits each source-record
version to normalize to at most one external transaction. RFC 0002 links a
Meridian-local account-source identity to a canonical account. Neither boundary
proves which account source may provide transaction facts for an account and
period, whether a source record actually belongs to that identity, or how YNAB
history yields to a live connector without double counting.

Linkage is identity, not authority. A YNAB import source and a live bank source
may both correctly identify the same canonical account while reporting
overlapping transactions. Amount/date/payee similarity cannot prove that two
records are the same observation. Automatically accepting both can duplicate
money; automatically merging them can discard real money.

This RFC defines a core `ledger.*` authority boundary. The design was accepted
on August 3, 2026 for the staged rollout below. Acceptance does not implicitly
enable a later stage or authorize a transaction write.

## Goals

- Associate every external source record with all directly observed
  account-source identities before normalization.
- Define one authoritative transaction feed for an account and occurrence
  period.
- Represent YNAB-to-live cutover explicitly and append-only.
- Quarantine overlaps and authority gaps instead of guessing.
- Record a permanent processing decision for every external observation.
- Preserve correction provenance when normalization or mapping is wrong.
- Require reconciliation evidence before activating a live cutover.
- Make transaction authority enforceable in PostgreSQL, not only application
  code.

## Non-goals

- Provider authorization, credentials, discovery, or sync scheduling.
- Cross-provider fuzzy deduplication.
- Automatic transfer pairing by amount and date.
- Inventing balance-adjustment transactions to make reconciliation pass.
- Position, lot, or execution authority.
- Defining provider-specific balance semantics before fixtures are available.

## Authority Unit

Authority is defined per canonical account and feed kind. This RFC initially
supports only `transactions`; balances and positions remain observations used
for reconciliation and receive separate later authority rules.

Transaction authority uses `occurred_on date`, because every transaction has a
calendar date while many sources do not provide a real instant. Windows are
half-open date ranges `[starts_on, ends_on)`. A source-provided `occurred_at`
remains provenance and may improve review, but it cannot be required for
cutover.

A source record may directly observe more than one account only when the same
provider payload identifies those accounts under that source. Every directly
observed canonical account must authorize its associated account source for the
record's occurrence date. A transfer record from one bank does not prove the
counterparty account at another provider: it posts only the observed account
side against Transfer Clearing. Later transfer pairing may reclassify reviewed
facts but cannot invent cross-source identity. Partial authority for a genuinely
multi-account observation quarantines the whole record; Meridian never posts
half an observation.

## Proposed Scope

The minimum boundary adds append-only association, authority, processing,
exception, and reconciliation records. Exact names and columns remain part of
acceptance review.

| Object                                      | Responsibility                                                  |
| ------------------------------------------- | --------------------------------------------------------------- |
| `ledger.source_record_account_sets`         | Append-only association revisions for one source-record version |
| `ledger.source_record_accounts`             | Participating account-source identities and roles               |
| `ledger.transaction_authority_revisions`    | Append-only authority windows and supersession                  |
| `ledger.source_record_processing_revisions` | One linear decision history per external source identity        |
| `ledger.processing_authority_evidence`      | Immutable authority revisions used by one processing decision   |
| `ledger.source_authority_exceptions`        | Permanent quarantine/review evidence                            |
| `ledger.reconciliation_checks`              | Immutable cutover evidence and result                           |

The proposal also changes the current transaction/source-record cardinality.
The existing `transactions.source_record_id` uniqueness supports only one
transaction for each source-record version. A corrected normalization of an
unchanged external observation needs the original, a system reversal, and an
external replacement with the same provenance. The accepted migration would
replace that simple uniqueness rule with the processing chain described below.

## Source-Record Account Association

A source-record version may involve one or more account sources. Association is
modeled as a sealed set rather than a nullable column so transfers and aggregate
payloads are representable:

```sql
ledger.source_record_account_sets (
  id                         uuid primary key,
  source_record_id           uuid not null references ledger.source_records(id),
  supersedes_account_set_id  uuid null references ledger.source_record_account_sets(id),
  member_count               integer not null,
  recorded_at                timestamptz not null default now()
)

ledger.source_record_accounts (
  set_id             uuid not null references ledger.source_record_account_sets(id),
  account_source_id  uuid not null references ledger.account_sources(id),
  link_revision_id   uuid not null references ledger.account_source_link_revisions(id),
  role                text not null,
  primary key (set_id, account_source_id)
)
```

- `role` is initially the checked value `observed_account`. A later aggregate
  provider design must review any additional role.
- `member_count` is positive and must match the committed member rows through a
  deferred trigger. This proves the declared set is sealed, not that a parser
  discovered every semantic participant; provider parsing and review own that
  evidence.
- Every account source must be currently linked when association is recorded.
  `link_revision_id` captures that exact linked chain tip and PostgreSQL verifies
  that it belongs to the account source and selected canonical account.
- A later unlink or relink does not rewrite the historical association proof.
- Each source-record version has one root and one non-branching account-set
  revision chain. A mistaken mapping with unchanged source bytes appends a new
  set with corrected link proof; it does not invent a duplicate source record or
  mutate the old set.
- A processing revision references one complete account-set revision. Its
  deferred constraints require the members to be complete at the shared commit
  boundary; association and processing may be inserted atomically in the same
  database transaction.
- Provider-native identity never enters these tables.

The external source record and associated account source must use the same
registered `source`. Application checks provide context; PostgreSQL is the
authority.

Every account posting in a normalized external transaction must resolve through
one of these directly observed members. Categories, including Transfer
Clearing, do not require account-source authority. An inferred account at a
different provider cannot be smuggled into the posting set.

## Authority Windows

Authority revisions define which linked account source may provide transaction
facts:

```sql
ledger.transaction_authority_revisions (
  id                         uuid primary key,
  authority_window_id        uuid not null,
  account_id                 uuid not null references ledger.accounts(id),
  account_source_id          uuid not null references ledger.account_sources(id),
  starts_on                  date not null,
  ends_on                    date null,
  status                     text not null,
  supersedes_revision_id     uuid null references ledger.transaction_authority_revisions(id),
  reason_code                text not null,
  reconciliation_check_id    uuid null references ledger.reconciliation_checks(id),
  recorded_at                timestamptz not null default now()
)
```

- `status` is `proposed`, `active`, or `revoked`.
- Only current chain tips whose status is `active` authorize transaction
  processing.
- Current active windows for one canonical account cannot overlap.
- `account_source_id` must link to `account_id` at activation time.
- A live connector window cannot activate without a passing reconciliation
  check for the proposed boundary.
- Each `authority_window_id` has one non-branching revision chain. Separate
  window identities allow the non-overlapping YNAB and live windows to coexist.
  Revisions never update or delete a prior decision.
- A window root is `proposed`; activation appends an `active` successor with the
  same account, source, and range. Revocation appends a `revoked` successor and
  stops all new processing against that window while preserving the evidence
  used by already accepted facts.
- Revocation is a processing-time stop, not an occurrence-date edit. Shortening
  a date range requires a new reviewed window schedule; any already accepted
  fact outside the replacement range must be corrected or explicitly retained
  before the old window is revoked.
- A gap is allowed but fail-closed: observations in the gap are quarantined.

For a YNAB migration, the intended cutover is:

```text
YNAB authority: [history start, cutoff)
live authority: [cutoff, open ended)
```

The cutoff is the first date for which the live source is intended to be
authoritative. It is not inferred from the first returned transaction, an
account balance, or a matching row.

## Authority Evaluation

For each source-record version, the processing service evaluates:

1. the complete associated account-source set;
2. each account source's historical canonical link evidence;
3. the source record's proposed transaction `occurred_on`;
4. the active authority window for every directly observed canonical account;
5. whether the same external source identity already has a processing tip;
6. whether unresolved exceptions or failed reconciliation block acceptance.

The evaluation result and the exact authority revision IDs are stored with the
processing decision. Later authority changes do not retroactively change why a
record was accepted or quarantined.

`ledger.processing_authority_evidence` is the many-to-many proof:

```sql
ledger.processing_authority_evidence (
  processing_revision_id  uuid not null references ledger.source_record_processing_revisions(id),
  authority_revision_id   uuid not null references ledger.transaction_authority_revisions(id),
  account_source_id       uuid not null references ledger.account_sources(id),
  primary key (processing_revision_id, account_source_id)
)
```

A deferred trigger requires exactly one qualifying active authority revision
for every directly observed account-source member on an `accepted` processing
revision. The referenced authority revision must have been the current active
tip when the decision was recorded, cover the transaction date, and map the
same account-source/canonical-account pair captured by the association's link
revision. Quarantined decisions may record the candidate revisions they
evaluated but cannot use them to authorize a transaction.

No caller may insert an external transaction directly. A deferrable database
constraint must require every external transaction to be introduced by a valid
processing revision whose recorded authority evidence covers the occurrence
date and every account posting.

## Processing Revisions

Processing is a linear append-only chain per external identity
`(source, source_ref)`, spanning source-record versions. The repeated source
identity must exactly match the referenced source record. A partial unique root
index on `(source, source_ref)` plus unique predecessors prevents concurrent
roots and branches even when workers hold different source-record versions:

```sql
ledger.source_record_processing_revisions (
  id                         uuid primary key,
  source_record_id           uuid not null references ledger.source_records(id),
  account_set_id             uuid not null references ledger.source_record_account_sets(id),
  source                     text not null,
  source_ref                 text not null,
  status                     text not null,
  result_transaction_id      uuid null references ledger.transactions(id),
  correction_transaction_id  uuid null references ledger.transactions(id),
  effective_transaction_id   uuid null references ledger.transactions(id),
  supersedes_revision_id     uuid null references ledger.source_record_processing_revisions(id),
  reason_code                text not null,
  recorded_at                timestamptz not null default now()
)
```

Checked statuses are:

- `accepted`: this revision introduced `result_transaction_id`, which becomes
  the current `effective_transaction_id`;
- `quarantined`: this observation wrote no monetary transaction and carries
  forward the predecessor's effective transaction, if any;
- `ignored`: a reviewed non-monetary observation such as a zero-dollar setup
  row and has no effective transaction;
- `retracted`: an exact system reversal removed the prior effective transaction
  without a replacement.

Legal transitions are deliberately narrow:

- a root may be accepted, quarantined, or ignored;
- any changed source-record version may append a quarantined successor. If a
  prior effective transaction exists, it remains effective until review decides
  to replace or retract it;
- a quarantined tip may become accepted through a reviewed successor, using an
  exact reversal first if it carries a prior effective transaction;
- an accepted observation may advance to another accepted tip only when an
  exact system reversal and valid external replacement commit atomically;
- an accepted observation may become retracted only with an exact system
  reversal;
- ignored observations can become monetary only through explicit review;
- one predecessor has at most one successor and one external identity has one
  current tip.

PostgreSQL validates all three transaction references against status and the
predecessor. A quarantined successor cannot silently change
`effective_transaction_id`; an accepted replacement must set its result and
effective IDs to the same new transaction; a retraction requires the exact
correction and null effective result.

Command UUIDs make exact retries no-ops. A conflicting replay fails closed.

## Corrections And Replacements

Two cases must remain distinguishable:

### Changed external observation

A new `source_records` version references the prior version. If the prior
version produced a transaction and the replacement passes authority, one atomic
operation:

1. exactly reverses the prior transaction with a system correction;
2. records the new source-record association set;
3. proves authority for the new version and occurrence date;
4. writes the replacement external transaction;
5. advances the processing chain to the new accepted result.

If the new version fails authority or needs review, it appends a quarantined
processing revision and leaves the prior effective transaction in place. Review
must then explicitly retain it, replace it through exact reversal, or retract
it. The changed external evidence is never omitted from processing history.

### Changed normalization or mistaken mapping

The external bytes may be unchanged. A reviewed processing successor may still
reverse and replace the prior transaction while retaining the same
`source_record_id`. This is why transaction provenance can no longer rely on a
unique source-record foreign key alone. The processing chain proves that at
most one external result is currently effective while preserving every prior
fact.

For a mistaken account mapping, review first appends a corrected
`source_record_account_sets` successor with the new exact link revision proof.
The replacement processing revision references that corrected set. The old
association and transaction remain immutable and explain why the correction was
required.

A mapping correction after financial ingestion cannot be a bare RFC 0002
relink. All affected processing identities must first be enumerated, then
corrected atomically or quarantined for review. Relink remains blocked until
that operation exists and passes integration tests.

## Overlap And Quarantine

An observation is quarantined when:

- no authority window covers its date;
- its source is not the authoritative source for any directly observed account;
- directly observed accounts resolve to conflicting windows;
- the record falls within the provider observation interval on the proposed
  cutover's reconciliation check but no active authority window covers it;
- account-source association is incomplete or historically inconsistent;
- source identity or version history conflicts;
- required reconciliation has not passed;
- provider date precision cannot support the proposed authority rule.

`ledger.source_authority_exceptions` records checked reason codes, the source
record, relevant account/source identities, and review outcome. It contains no
free-form provider payload. Resolution appends a processing or authority
revision; it never updates the exception away.

Similarity candidates may be shown to a reviewer, but they do not satisfy
identity or authority constraints. Meridian does not merge records because
their amount, date, and payee happen to match.

## Reconciliation Gate

A proposed live cutover must have immutable evidence that the live account and
canonical ledger can be compared at a documented boundary. A reconciliation
check records:

- canonical account and proposed live account source;
- cutoff date and the provider observation interval;
- exact ledger-derived balance persisted as `NUMERIC`;
- exact provider-reported balance persisted as `NUMERIC`;
- currency and provider balance semantic code;
- difference and accepted tolerance persisted as `NUMERIC`;
- result: `passed`, `failed`, or `not_comparable`;
- source/raw-payload references and recording timestamp.

Commands carry canonical decimal strings, PostgreSQL persists `NUMERIC`, and no
JavaScript `number` participates. A passing tolerance is not guessed: each
provider adapter must document whether the observed balance is current,
available, posted-only, or includes pending transactions. Until that semantic
and an acceptable tolerance are reviewed from fixtures, activation fails with
`not_comparable`.

A discrepancy is a signal, not permission to invent a Balance Adjustment.
Failed reconciliation blocks activation and requires source review or explicit
ledger corrections backed by evidence.

## YNAB Cutover Workflow

The intended reviewed workflow is:

1. persist the approved YNAB account/category mapping without transactions;
2. register YNAB account sources and canonical links through RFC 0002;
3. retain and associate YNAB source-record versions;
4. connect and explicitly map live provider accounts through RFC 0003;
5. fetch a bounded live overlap as quarantined observations;
6. review coverage, date semantics, duplicates, pending behavior, and balances;
7. choose an explicit cutoff date;
8. run and pass reconciliation at the boundary;
9. activate non-overlapping YNAB-before/live-after authority windows;
10. process only records authorized by those windows;
11. retain overlap exceptions for audit rather than deleting or merging them.

The initial YNAB import and live activation do not need to happen in one
database transaction, but no monetary records may appear between intermediate
states unless an active authority window and processing proof already exist.

## Ingestion And Checkpoints

Live ingestion uses the fenced checkpoint proposed by RFC 0003 and two explicit
commit boundaries:

1. a provider-neutral orchestrator seals and commits the raw response to
   `ledger.raw_payloads` before normalization;
2. it parses the retained payload, then atomically records source versions,
   association, processing/evidence, any authorized transaction, and the
   matching `ops.sync_checkpoints` cursor update.

The connector module itself receives no persistence port. The orchestrator has
narrow raw-payload and authority-service ports but no executor or broker-write
API. Every checkpoint update includes the current fencing token.

If raw retention fails, normalization does not run. If the second transaction
fails, the cursor does not advance and refetch is idempotent by raw/source
digests. A durably quarantined or ignored observation may advance the cursor
because its evidence and decision are retained; an unrecorded failure may not.
Position and balance observations need their own accepted persistence boundary
before their feed checkpoints can advance.

## Core Boundary

Core owns provider-independent commands for:

- associating a complete source-record account set;
- proposing, activating, and revoking authority;
- evaluating and recording processing decisions;
- atomically accepting, correcting, and replacing transactions;
- recording reconciliation checks and authority exceptions;
- resolving current authority and current effective processing state.

Provider modules may parse observations and propose associations. They cannot
decide authority, open transactions directly, or import another module. Next.js
adapters display and submit reviewed commands only.

## Concurrency And Locking

Current-tip checks are safe only if decisions that can invalidate one another
serialize. Database functions and constraint triggers acquire transaction-level
advisory locks from stable identities before checking absence of a successor:

- account-source ID for link, unlink, association, and relink decisions;
- authority-window ID, canonical account ID, and every referenced
  account-source ID for activation, revocation, and processing evidence;
- source-record ID for account-set revisions;
- a domain-separated digest of `(source, source_ref)` for processing roots and
  successors.

When an operation needs several locks, it sorts UUIDs and lock domains by the
documented global order before acquisition. Hash collisions may serialize
unrelated work but cannot permit invalid work. The owner and runtime roles
cannot bypass these trigger paths. Unique root/successor indexes remain the
final branch-prevention backstop.

This protocol makes association versus unlink, activation versus relink, and
acceptance versus revocation deterministic. A loser re-evaluates the new tip and
fails closed; it never retries against a decision the caller did not review.

## Database Enforcement

PostgreSQL must enforce:

1. append-only behavior on every new `ledger.*` table for owner and runtime
   roles;
2. positive, sealed association sets, one linear set-revision chain, and exact
   historical link-revision proof;
3. source compatibility between source records and directly observed account
   sources;
4. one non-branching chain per authority window and external processing
   identity;
5. non-overlapping active transaction authority per canonical account;
6. linked account/source consistency at authority activation;
7. checked statuses, transitions, reason codes, and timestamp ordering;
8. passing reconciliation evidence before live activation;
9. one immutable authority-evidence row for every directly observed account;
10. no account posting without matching association and no external transaction
    without valid processing and authority evidence;
11. exact reversal and atomic replacement for changed observations or
    normalization;
12. at most one root, current processing tip, and current effective transaction
    per external source identity under concurrency;
13. status-consistent result, correction, and effective transaction references;
14. serialized anti-successor checks under the documented lock order;
15. restricted grants and server-owned recording timestamps.

If these properties cannot be enforced without an unsafe circular dependency,
the migration must stop for redesign rather than weakening the authority gate.

## Required Tests

- source records cannot process without complete account-source association;
- same-source multi-account records require authority on every directly
  observed account;
- a one-bank transfer cannot claim an unobserved account at another source and
  instead uses Transfer Clearing;
- half-open date boundaries select exactly one source at cutoff;
- overlapping active windows fail under concurrency;
- authority gaps and wrong-source observations quarantine;
- direct external transaction inserts fail;
- exact replay creates no duplicate processing or monetary facts;
- changed source versions reverse and replace atomically;
- unauthorized changed versions quarantine while retaining the prior effective
  transaction for explicit review;
- unchanged source observations can receive reviewed normalization corrections
  without violating provenance;
- unchanged source observations can append corrected association sets for
  mistaken mappings;
- competing processing successors cannot branch;
- competing roots for different versions of one external identity cannot both
  commit;
- concurrent association/unlink, activation/relink, and acceptance/revocation
  produce one winner and one contextual conflict;
- processing authority evidence survives later window revocation;
- relink after financial ingestion fails until affected facts are corrected;
- failed or non-comparable reconciliation blocks live activation;
- reconciliation arithmetic covers very large and fractional decimal values;
- amount/date/payee similarity never auto-merges records;
- owner and runtime roles cannot update or delete authority records;
- property tests prove accepted transaction entries sum exactly to zero;
- integration tests exercise rollback at every step of correction/replacement;
- cursor advancement is fenced and atomic with durable processing, after raw
  payload retention;
- architecture tests prove connectors cannot bypass the authority service.

## Migration And Rollout

If accepted, implementation is split into reviewable units:

1. source-record/account-source association with no monetary writes;
2. authority windows, reconciliation evidence, and read-only evaluation;
3. processing revisions and replacement of source-record transaction
   uniqueness;
4. YNAB persistence through quarantined source records only;
5. reviewed YNAB transaction activation;
6. live overlap collection and cutover activation.

Each unit requires fresh-schema migration, disposable PostgreSQL integration,
schema-drift, unit/property, formatting, lint, typecheck, and build validation.
No unit silently enables the next.

## Acceptance Decisions

Accepted August 3, 2026 with these decisions:

1. the seven-object append-only Plane A boundary;
2. positive sealed source-record association revision chains with exact
   historical link revisions;
3. per-account, `transactions`-only authority as the first feed kind;
4. half-open `occurred_on` date windows;
5. authority only for accounts directly observed by the same source, with
   cross-source transfers using Transfer Clearing;
6. explicit YNAB-before/live-after cutover with no inferred boundary;
7. permanent quarantine rather than fuzzy merge or silent drop;
8. processing chains per `(source, source_ref)` across source versions;
9. replacing one-transaction-per-source-record uniqueness with processing
   proofs;
10. correction/replacement for unchanged observations when normalization or
    mapping was wrong;
11. reconciliation as a mandatory live-activation gate;
12. provider-specific balance semantics and tolerances remaining blocked until
    fixture review;
13. no automatic Balance Adjustment for reconciliation differences;
14. canonical decimal-string command inputs and `NUMERIC` reconciliation
    persistence;
15. the database lock order for current-tip decisions;
16. staged rollout with no implicit transaction-write enablement.

## Implementation Status

Rollout unit one was implemented on August 3, 2026 by migration
`0009_jittery_thunderbird.sql`, with additional hardening in
`0010_modern_nehzno.sql`. `ledger.source_record_account_sets`,
`ledger.source_record_accounts`, and
`ledger.current_source_record_account_sets` record positive sealed association
revisions with exact historical RFC 0002 link proof. Core and PostgreSQL
adapters provide replay-safe creation and correction chains. PostgreSQL enforces
source compatibility, member counts, one non-branching tip, append-only
behavior, and deterministic account-source lock order; concurrency failures map
to contextual conflicts.

Rollout units two through six are not implemented. There are no authority
windows, processing revisions, authority evidence, exceptions, reconciliation
checks, changed transaction cardinality, YNAB persistence, cutover activation,
or monetary writes. The existing architecture prohibition on linkage-driven
transaction recording remains in force.

## Consequences

Meridian can preserve one canonical account while migrating transaction
authority from YNAB to live sources without trusting heuristic deduplication.
Every accepted, ignored, retracted, or quarantined observation has durable
reasoning, and normalization mistakes remain correctable without mutating
history. The cost is a significant staged core-ledger expansion and a later
replacement for the current simple source-record transaction cardinality. The
implemented association stage deliberately incurs none of those later
accounting effects.
