---
summary: RFC 0008 (Proposed): any-order transaction import from any source, with processing revisions, conservative cross-source matching, one observation per source per transaction, review instead of guessing, and continuous balance checks
read_when: Importing or normalizing transactions from any source, matching or deduplicating transactions, reviewing ambiguous observations, or retiring RFC 0004 authority windows
---

# RFC 0008: Cross-source transaction matching

- Status: Proposed
- Date: 2026-09-27
- Decision owners: project owner and implementer
- Depends on: RFC 0001, RFC 0002, RFC 0004 (rollout unit one, source-record association), RFC 0006, RFC 0007
- Supersedes in part: RFC 0004 (see "Relationship to RFC 0004")
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
- **Processing revision:** the decision recorded for an observation identity `(source, source_ref)`, in a linear append-only chain (RFC 0004 "Processing Revisions", adopted with the changes below).

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

Other rules carry over from RFC 0004: exact command replays are no-ops, conflicting replays fail, one predecessor has one successor, changed source versions append a successor rather than editing, and a replaced or retracted transaction is exactly reversed by a system correction.

### Matching rules

Matching is a pure, deterministic core function. It is given one incoming observation and the candidate transactions for its account, and it returns `create`, `match`, or `needs_review` with its evidence.

A **candidate** is a counted effective transaction that:

1. posts to the same canonical account as the observation (through its current account association);
2. has the same amount on that account, exactly;
3. has an `occurred_on` within **D days** of the observation's date (D is open question 1; proposed 5);
4. has no current observation from the incoming observation's source.

Decision:

- **No candidate:** `create` a new transaction.
- **Exactly one candidate, and the observation is the only one from its source in this import that could take it:** `match`.
- **Otherwise:** `needs_review`, recording every candidate.

Identical groups are paired **one to one by nearest date**. They are auto-matched only when that pairing is the only valid assignment inside the window. If YNAB has two identical coffees on a day and the bank reports two, they pair. If the bank reports three, the unpaired one goes to review instead of being created or dropped.

A **near miss** goes to review with the candidate attached. That means same account, same payee after normalization, date inside the window, and amount different, for example a tip added when a pending charge posts. Payee text can raise something for review; it never auto-matches on its own.

Provider-supplied identity links, such as a posted transaction naming the pending one it replaces, are version links within one source identity, not cross-source matches.

### Field precedence

A matched transaction keeps one set of ledger values.

- **Amount:** must be equal for an automatic match. If the owner matches differing amounts during review, the connector's amount wins. The transaction is replaced through an exact reversal and a new transaction, and every linked observation's chain moves to the replacement in one atomic operation.
- **Date:** the transaction keeps the `occurred_on` it was created with. A date difference inside the window does not trigger a replacement. See open question 5.
- **Category:** the owner's own categorization, or YNAB's, wins over an uncategorized connector row. How a change of category is recorded is open question 3.
- **Description and memo:** kept on each observation as provenance; the transaction's description comes from the introducing observation.

### Review

`needs_review` tips are not counted. An account with any `needs_review` observation is marked on the dashboard as having items to review, so an uncertain balance is never shown as certain. Review resolves an item by appending a successor revision: `created`, `matched` to a chosen candidate, or `ignored`. The Inbox (RFC 0009) lists these items; resolving them is a ledger decision recorded here, not a task state.

### Continuous balance checks

For each account with a current RFC 0006 balance observation, core compares the sum of counted account entries dated on or before the observation's `observed_on` with the observed amount. Both use the net-worth sign (ledger model, "Entry sign convention"). A difference becomes a review item for that account; it is never corrected automatically. This keeps RFC 0004's decision against automatic Balance Adjustments.

For connector-sourced balances, the comparison is informational until the provider's balance semantics are reviewed from a fixture. That keeps RFC 0004 decision 12.

This replaces the `ledger.reconciliation_checks` gate. Checks are computed on demand, not stored as evidence.

### Retiring Plan 0001's objects

`ledger.transaction_authority_revisions`, `ledger.current_transaction_authority_windows`, `ledger.reconciliation_checks`, and their functions and triggers are dropped by a new migration. That migration first asserts both tables are empty and aborts otherwise, so no ledger row is ever deleted. Migration `0013` stays in history unedited.

## Amendments to RFC 0001

1. **Cardinality:** a source-record version no longer normalizes to at most one transaction through a unique `transactions.source_record_id`. The processing chain proves which transaction each observation currently stands behind, and several observations may stand behind one transaction. `transactions.source_record_id` becomes the introducing observation's version and loses its uniqueness. That applies RFC 0004's planned replacement of the rule.
2. **External transactions require processing:** a deferred constraint requires every external transaction to be the effective transaction of at least one current `created` or `matched` processing revision, as RFC 0004 required.
3. **Entry sign:** an account entry is the account's change in net-worth contribution, for assets and liabilities alike. This formalizes the owner's decision of 2026-09-25, recorded in the ledger model.

## Relationship to RFC 0004

| RFC 0004 acceptance decision                                                                   | Under this RFC                                                                                              |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 1. Seven-object boundary                                                                       | Superseded: association and processing kept; authority, evidence, exceptions, reconciliation tables dropped |
| 2. Association revision chains with exact link proof                                           | Kept                                                                                                        |
| 3. Per-account `transactions` authority                                                        | Superseded                                                                                                  |
| 4. Half-open authority windows                                                                 | Superseded                                                                                                  |
| 5. Authority only for directly observed accounts; cross-source transfers via Transfer Clearing | Transfer rule kept; authority part superseded                                                               |
| 6. Explicit YNAB-before/live-after cutover                                                     | Superseded                                                                                                  |
| 7. Quarantine rather than fuzzy merge                                                          | Superseded by conservative matching plus review; payee text alone never matches                             |
| 8. Processing chains per `(source, source_ref)`                                                | Kept and extended with `matched`                                                                            |
| 9. Replacing one-transaction-per-source-record uniqueness                                      | Kept (amendment 1 above)                                                                                    |
| 10. Correction/replacement for unchanged observations                                          | Kept                                                                                                        |
| 11. Reconciliation as an activation gate                                                       | Superseded by continuous balance checks                                                                     |
| 12. Provider balance semantics blocked until fixture review                                    | Kept                                                                                                        |
| 13. No automatic Balance Adjustment                                                            | Kept                                                                                                        |
| 14. Decimal strings and `NUMERIC`                                                              | Kept                                                                                                        |
| 15. Database lock order                                                                        | Kept, extended with the transaction-ID lock                                                                 |
| 16. Staged rollout, no implicit write enablement                                               | Kept                                                                                                        |

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

1. **Schema and engine:** processing revisions, the matching function, review state, balance-check computation, and retirement of Plan 0001's objects. No import.
2. **YNAB transaction import** through the engine.
3. **Inbox integration** (with RFC 0009): review items and balance discrepancies as tasks.
4. **First live connector** (RFC 0007 order) through the same engine.

No unit silently enables the next.

## Open questions

1. **Date window D.** Proposed 5 days. It must cover the gap between a purchase and its posting, and between the date entered in YNAB and the bank's date. To be checked against the owner's YNAB export, where rows YNAB imported from a bank carry bank dates.
2. **Pending transactions.** Proposed: connector rows marked pending are stored but never counted until posted. YNAB uncleared rows are counted, because the owner entered them deliberately. Confirm.
3. **Recording a category change.** A change of category is currently a reversal and replacement. Is that acceptable churn, or do we want a lighter "reclassification" transaction that moves the amount between categories (an RFC 0001 amendment)?
4. **YNAB split transactions.** Proposed: a YNAB split, which is several register rows, is one observation whose total is matched against the bank's single row. The YNAB importer groups the rows. Confirm with the export.
5. **Date precedence.** Proposed: keep the introducing observation's date. Alternative: prefer the connector's posted date, which means a replacement whenever a connector row matches an earlier YNAB row with a different date.
