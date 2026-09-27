---
summary: RFC 0008 (Accepted): the current transaction-import design. Any-order import from any source, source-record association, processing revisions, conservative cross-source matching with one observation per source per transaction, review instead of guessing, reclassification, ingestion and checkpoints, and continuous balance checks. Supersedes RFC 0004
read_when: Importing or normalizing transactions from any source, associating source records with accounts, matching or deduplicating transactions, reviewing ambiguous observations, changing categories, connector ingestion and checkpoints, or retiring Plan 0001's authority objects
---

# RFC 0008: Cross-source transaction matching

- Status: Accepted
- Date: 2026-09-27
- Accepted: 2026-09-27
- Decision owners: project owner and implementer
- Depends on: RFC 0001, RFC 0002, RFC 0006, RFC 0007
- Supersedes: RFC 0004, entirely. The parts still in force are restated under "Carried forward from RFC 0004", so this RFC is the only current source; RFC 0004 is history.
- Amends: RFC 0001 (see "Amendments to RFC 0001")

## Context

RFC 0004 prevents double counting by giving each account one authoritative source per date window, with a reconciled cutover from YNAB to a live connector. The owner wants something else: import a YNAB export or sync a connector at any time, in any order, and have duplicates resolved while genuinely new transactions from either source are added. RFC 0004's rollout unit one (source-record association) and unit two (authority windows and reconciliation checks, [Plan 0001](../plans/0001-rfc-0004-authority-and-reconciliation.md)) are built. Units three to six are not.

Duplicates arise only across sources. Within one source, `(source, source_ref)` identity already makes a re-import a no-op, and two genuine identical purchases are two records. A cross-source duplicate is one real event reported by two sources, for example a YNAB register row and the bank's row for the same purchase.

## Goals

- Import from any source, at any time and in any order, without double counting.
- Add genuinely new transactions from whichever source reports them first.
- Resolve clear cross-source duplicates automatically; send anything ambiguous to the owner, never guess.
- Keep every observation and every decision, append-only and reversible.
- Detect a missed duplicate or a wrong match through balances, not only through matching.

## Non-goals

- Fuzzy matching on payee text as sufficient evidence, or learning match rules from data.
- Transfer pairing across accounts. Each account side is matched on its own and posts against Transfer Clearing; pairing stays later work.
- The Inbox itself (RFC 0009). This RFC defines the review state that the Inbox surfaces.
- Any provider connector, or reviewed provider balance policies.
- Investment positions and lots.

## Terms

- **Observation:** one version of one external record, stored as a `ledger.source_records` version with its raw payload and its account association (RFC 0004 unit one). YNAB register rows, bank transactions, and file-import rows are all observations.
- **Transaction:** a `ledger.transactions` row and its entries. It is the one ledger fact for one real-world event.
- **Processing revision:** the decision recorded for an observation identity `(source, source_ref)`, in a linear append-only chain spanning that identity's source-record versions.

## Design

### Processing revisions, extended for matching

Each observation identity has one linear chain of processing revisions. The current tip has one status:

| Status         | Meaning                                                                                                       | Counted   |
| -------------- | ------------------------------------------------------------------------------------------------------------- | --------- |
| `created`      | This observation introduced its effective transaction                                                         | yes       |
| `matched`      | This observation is linked to an existing effective transaction introduced by another source                  | yes       |
| `needs_review` | No safe decision; candidate transactions are recorded for review; any prior effective transaction stays as is | as before |
| `ignored`      | Reviewed or rule-based non-monetary row (for example a zero-amount row)                                       | no        |
| `retracted`    | The prior effective transaction was exactly reversed with no replacement                                      | no        |

`effective_transaction_id` names the transaction the observation currently stands behind. Several observations from different sources may share one effective transaction.

**The core invariant:** among current tips, each effective transaction has **at most one observation per source**. PostgreSQL enforces this under an advisory lock on the transaction ID, following the RFC 0004 lock order. As a result a match only ever pairs observations from different sources. Two identical rows from one source can never collapse into one transaction.

Exact command replays are no-ops and conflicting replays fail. A partial unique root index on `(source, source_ref)` plus unique predecessors prevents concurrent roots and branches. Changed source versions append a successor rather than editing, and a replaced or retracted transaction is exactly reversed by a system correction (see "Corrections and replacements").

### Matching rules

Matching is a pure, deterministic core function. It is given one incoming observation and the candidate transactions for its account, and it returns `create`, `match`, or `needs_review` with its evidence.

A **candidate** is a counted effective transaction that:

1. posts to the same canonical account as the observation (through its current account association);
2. has the same amount on that account, exactly;
3. has an `occurred_on` within **D = 5 calendar days** of the observation's date (owner decision, 2026-09-27). A window constant, not schema, so it can be tuned later with data;
4. has no current observation from the incoming observation's source.

Decision:

- **No candidate:** `create` a new transaction.
- **Exactly one candidate, and the observation is the only one from its source in this import that could take it:** `match`.
- **Otherwise:** `needs_review`, recording every candidate.

Identical groups are paired **one to one by nearest date**. They are auto-matched only when that pairing is the only valid assignment inside the window. If YNAB has two identical coffees on a day and the bank reports two, they pair. If the bank reports three, the unpaired one goes to review instead of being created or dropped.

A **late candidate** also goes to review: same account and exact amount, but dated more than D and at most 2×D (10) days away. A posting slower than the window then becomes a review item instead of a silent duplicate.

A **near miss** goes to review with the candidate attached. That means same account, same payee after normalization, date inside the window, and amount different, for example a tip added when a pending charge posts. Payee text can raise something for review; it never auto-matches on its own.

Provider-supplied identity links, such as a posted transaction naming the pending one it replaces, are version links within one source identity, not cross-source matches.

### Pending connector rows

A connector row the provider marks as pending is stored as an observation but is never counted and never matched. Its processing tip is `ignored` with reason `pending`. When the provider reports it posted, whether as a new version of the same identity or as a new identity that names the pending one, the posted observation is processed normally. A pending hold or a pre-tip amount therefore never creates a transaction. YNAB rows are counted whether or not they are cleared, because the owner entered them deliberately (owner decision, 2026-09-27).

### Field precedence

A matched transaction keeps one set of ledger values.

- **Amount:** must be equal for an automatic match. If the owner matches differing amounts during review, the connector's amount wins. The transaction is replaced through an exact reversal and a new transaction, and every linked observation's chain moves to the replacement in one atomic operation.
- **Date:** a connector's posted date wins (owner decision, 2026-09-27). When a connector observation matches a transaction introduced with a different date, the transaction is replaced through an exact reversal and a new transaction dated at the connector's date. Its category postings carry over, and every linked observation's chain moves to the replacement in one atomic operation. Between two non-connector sources, such as YNAB and a manual file import, the introducing observation's date is kept.
- **Category:** the owner's own categorization, or YNAB's, wins over an uncategorized connector row. A change of category is recorded as a reclassification (see below), never by replacing the transaction.

### Reclassification

A category change appends a **reclassification**: a system-originated transaction that references the transaction it reclassifies, posts only to categories, and sums to zero. For example, it posts `+12` to Uncategorized and `−12` to Groceries for a $12 expense. It never posts to an account, so no account balance or match changes. A transaction's current categorization is its own category entries plus those of its reclassifications. A replacement carries the current categorization over, and its reclassifications then start fresh (owner decision, 2026-09-27).

- **Description and memo:** kept on each observation as provenance; the transaction's description comes from the introducing observation.

### Review

`needs_review` tips are not counted. An account with any `needs_review` observation is marked on the dashboard as having items to review, so an uncertain balance is never shown as certain. Review resolves an item by appending a successor revision: `created`, `matched` to a chosen candidate, or `ignored`. The Inbox (RFC 0009) lists these items; resolving them is a ledger decision recorded here, not a task state.

### Continuous balance checks

For each account with a current RFC 0006 balance observation, core compares the sum of counted account entries dated on or before the observation's `observed_on` with the observed amount. Both use the net-worth sign (ledger model, "Entry sign convention"). A difference becomes a review item for that account; it is never corrected automatically. This keeps RFC 0004's decision against automatic Balance Adjustments.

For connector-sourced balances, the comparison is informational until the provider's balance semantics are reviewed from a fixture. That keeps RFC 0004 decision 12.

This replaces the `ledger.reconciliation_checks` gate. Checks are computed on demand, not stored as evidence.

### Retiring Plan 0001's objects

`ledger.transaction_authority_revisions`, `ledger.current_transaction_authority_windows`, `ledger.reconciliation_checks`, and their functions and triggers were dropped on 2026-09-27 by migration `0014_concerned_nextwave.sql`, which first asserts both tables are empty and aborts otherwise, so no ledger row was deleted. Migration `0013` stays in history unedited.

## Carried forward from RFC 0004

These rules were accepted in RFC 0004 and remain in force. They are restated here so this RFC is the single current source.

### Source-record account association (implemented)

Implemented by migrations `0009_jittery_thunderbird.sql` and `0010_modern_nehzno.sql`: `ledger.source_record_account_sets`, `ledger.source_record_accounts`, and the view `ledger.current_source_record_account_sets`.

- Each source-record version has one root and one non-branching chain of association sets. A set names the account sources the record directly observes, each with role `observed_account`.
- `member_count` is positive and a deferred trigger requires the committed members to match it, so a set is sealed.
- Every member is currently linked when the set is recorded. `link_revision_id` captures that exact RFC 0002 link tip, and a later unlink or relink never rewrites it.
- A source record and its member account sources use the same registered `source`. Provider-native identity never enters these tables.
- A mistaken mapping with unchanged source bytes appends a corrected set; it never invents a duplicate source record or mutates the old set.
- A processing revision references one complete association set. Both may be inserted in one database transaction.

### Observed accounts and transfers

- Every account posting of an external transaction resolves through a member of its association set. Categories, including Transfer Clearing, need no association.
- A transfer seen by one institution posts only that institution's account side, against Transfer Clearing. A record cannot claim an account at another provider. Pairing the two sides is later work.
- A record that genuinely observes several accounts is processed whole or not at all: if any account side cannot be decided, the whole record goes to review. Meridian never posts half an observation.

### Corrections and replacements

- **Changed external observation:** a new source-record version references the prior one. If its values change the effective transaction, one atomic operation reverses the prior transaction exactly, records the new association, writes the replacement, and advances every affected processing chain. If it needs review, the prior effective transaction stays in place until review retains, replaces, or retracts it.
- **Changed normalization or mistaken mapping:** with unchanged source bytes, a reviewed successor may reverse and replace the transaction while keeping the same source record. A mapping correction first appends a corrected association set.
- **Relink after ingestion:** a bare RFC 0002 relink of an account source that already has processed observations is blocked. Affected observations must be corrected or sent to review in the same operation. Until that operation exists and is tested, such relinks fail.

### Ingestion and checkpoints

- A provider-neutral orchestrator seals and commits the raw response to `ledger.raw_payloads` before normalization. If retention fails, normalization does not run.
- It then atomically records source-record versions, association, processing revisions, any transaction, and the matching `ops.sync_checkpoints` cursor update. Every checkpoint update carries the current fencing token (RFC 0003).
- If that transaction fails, the cursor does not advance, and refetching is idempotent by raw and source digests. A durably recorded `needs_review` or `ignored` observation may advance the cursor; an unrecorded failure may not.
- Connector modules receive no persistence port and cannot open transactions directly. An architecture test proves connectors cannot bypass the processing service.

### Concurrency and locking

Decisions that can invalidate each other serialize on transaction-level advisory locks taken, in this order, before any current-tip check:

1. a domain-separated digest of `(source, source_ref)`, for processing roots and successors;
2. YNAB label digest, for RFC 0005 account decisions;
3. source-record ID, for association-set revisions;
4. transaction ID, for the one-observation-per-source rule and replacements (new in this RFC);
5. canonical account ID, for RFC 0006 balance observations;
6. account-source ID, for link, unlink, relink, association, and YNAB export balances (the lock RFC 0002 link revisions take).

The implemented triggers already follow this order: association sets lock the source record before their members lock account sources, RFC 0005 locks the label before the account source, and RFC 0006 locks the account before the account source.

Several identities in one domain are locked in sorted UUID order. Hash collisions may serialize unrelated work but never permit invalid work, and the owner and runtime roles cannot bypass the trigger paths. Unique root and successor indexes remain the final branch backstop. A loser re-reads the new tip and fails closed.

### Other rules still in force

- No automatic Balance Adjustment: a discrepancy is a signal for review, never permission to invent a balancing transaction.
- A provider's balance semantics (current, available, posted-only, includes pending) and any tolerance are used only after review from a redacted fixture.
- Amounts are canonical decimal strings at boundaries and `NUMERIC` in PostgreSQL; no JavaScript `number` participates.
- Amount, date, and payee similarity alone never merges records; see "Matching rules" for what does.
- Staged rollout: no unit silently enables the next, and each requires fresh-schema migration, disposable PostgreSQL integration, schema-drift, unit and property, formatting, lint, typecheck, and build validation.

## Amendments to RFC 0001

1. **Cardinality:** a source-record version no longer normalizes to at most one transaction through a unique `transactions.source_record_id`. The processing chain proves which transaction each observation currently stands behind, and several observations may stand behind one transaction. `transactions.source_record_id` becomes the introducing observation's version and loses its uniqueness. That applies RFC 0004's planned replacement of the rule.
2. **External transactions require processing:** a deferred constraint requires every external transaction to be the effective transaction of at least one current `created` or `matched` processing revision, as RFC 0004 required.
3. **Entry sign:** an account entry is the account's change in net-worth contribution, for assets and liabilities alike. This formalizes the owner's decision of 2026-09-25, recorded in the ledger model.
4. **Reclassification transactions:** a new system-originated transaction kind that references the transaction it reclassifies. It posts only to category destinations, sums to zero, and is distinct from a correction, which must exactly negate the original. PostgreSQL enforces that it has no account entries and that its target is an existing non-reclassification transaction.

## What happened to RFC 0004's decisions

| RFC 0004 acceptance decision                                                                   | Under this RFC                                                                                              |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 1. Seven-object boundary                                                                       | Superseded: association and processing kept; authority, evidence, exceptions, reconciliation tables dropped |
| 2. Association revision chains with exact link proof                                           | Carried forward                                                                                             |
| 3. Per-account `transactions` authority                                                        | Superseded                                                                                                  |
| 4. Half-open authority windows                                                                 | Superseded                                                                                                  |
| 5. Authority only for directly observed accounts; cross-source transfers via Transfer Clearing | Transfer rule carried forward; authority part superseded                                                    |
| 6. Explicit YNAB-before/live-after cutover                                                     | Superseded                                                                                                  |
| 7. Quarantine rather than fuzzy merge                                                          | Superseded by conservative matching plus review; payee text alone never matches                             |
| 8. Processing chains per `(source, source_ref)`                                                | Carried forward and extended with `matched`                                                                 |
| 9. Replacing one-transaction-per-source-record uniqueness                                      | Carried forward (amendment 1 above)                                                                         |
| 10. Correction/replacement for unchanged observations                                          | Carried forward                                                                                             |
| 11. Reconciliation as an activation gate                                                       | Superseded by continuous balance checks                                                                     |
| 12. Provider balance semantics blocked until fixture review                                    | Carried forward                                                                                             |
| 13. No automatic Balance Adjustment                                                            | Carried forward                                                                                             |
| 14. Decimal strings and `NUMERIC`                                                              | Carried forward                                                                                             |
| 15. Database lock order                                                                        | Carried forward, extended with the transaction-ID lock                                                      |
| 16. Staged rollout, no implicit write enablement                                               | Carried forward                                                                                             |

## Database enforcement

PostgreSQL must enforce, with integration tests for each:

1. append-only behavior and `TRUNCATE` rejection on every new table, for owner and runtime roles;
2. one linear processing chain per `(source, source_ref)` under concurrency;
3. at most one current observation per source per effective transaction, under concurrency;
4. status-consistent transaction references (`created` and `matched` require an effective transaction; `ignored` and `retracted` forbid one; `needs_review` carries forward);
5. no external transaction without a current `created` or `matched` revision;
6. exact reversal on replacement and retraction;
7. restricted grants and server-owned timestamps.

## Rollout

1. **Schema and engine:** processing revisions, the matching function, review state, and balance-check computation. No import.
2. **YNAB transaction import** through the engine.
3. **Inbox integration** (with RFC 0009): review items and balance discrepancies as tasks.
4. **First live connector** (RFC 0007 order) through the same engine.

No unit silently enables the next.

## Evidence from the owner's data

Aggregates from the owner's multi-year YNAB export (September 2026). Exact figures and the rows themselves stay in the private `local/` directory.

- Most rows are Reconciled, which suggests most YNAB accounts were bank-linked and their dates are already bank dates.
- About 3% of rows share account, date, and amount with another row, and about a quarter of those also share the payee. Identical same-day transactions are real, which is why one source's observations never collapse into one transaction.
- Share of rows with another same-account, same-amount row within D days: about 3% (D=0), 7% (3), 9% (5), 11% (7), 16% (14). This is the worst-case review rate before one-to-one date pairing.
- No rows carry YNAB's split marker.
- A small number of uncleared rows are months old and are likely stale entries.

## Open questions

None.

Resolved 2026-09-27 by the owner:

1. **Date window:** D = 5 calendar days, with a review band out to 10 days.
2. **YNAB splits:** none appear in the owner's data. Until a real split export exists as a fixture, the YNAB importer sends any split-marked row to review rather than guessing how to group it. Grouping a split into one observation is added when a fixture proves the format.
3. **Pending connector rows** are stored but not counted until posted; YNAB rows count whether or not they are cleared. Uncleared YNAB rows older than 30 days are surfaced for review (RFC 0009), not excluded.
4. **Category changes** are reclassifications.
5. **Date precedence:** a connector's posted date wins.

## Implementation status

Source-record association is implemented (migrations `0009` and `0010`). Plan 0001's authority and reconciliation objects were removed by migration `0014` on 2026-09-27, together with their core code. Processing revisions, matching, review, reclassification, and balance checks are not implemented. The first plan under this RFC covers rollout unit 1.
