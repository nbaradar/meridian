---
summary: RFC 0005 (Accepted, implemented): saving YNAB account decisions and recognizing them later through keyed digests of account names
read_when: Changing YNAB account saving, recognition, renamed or excluded accounts, or the YNAB label digest key
---

# RFC 0005: YNAB account persistence and remembered source decisions

- Status: Accepted
- Date: 2026-09-25
- Accepted: 2026-09-25
- Implemented: 2026-09-25 (migration `0011_solid_tinkerer.sql`)
- Decision owners: project owner and implementer
- Depends on: RFC 0001, RFC 0002, RFC 0004 (YNAB cutover workflow steps 1–2)
- Amends: RFC 0002, "Account Sources" (how a later YNAB export finds a previously persisted source)

## Context

The `/ynab` review validates a create, link, or exclude decision for every YNAB source account, but saves nothing. The owner needs to:

- save accounts one at a time, or save every remaining validated account at once;
- see, when re-importing an export, which YNAB accounts are already tracked, rendered as saved, while newly found accounts show a fresh save action;
- record an exclusion (for example, a duplicate account YNAB created during a bank re-link) so it does not reappear as a new decision on every import.

A later export can recognize an account only if Meridian remembers something about the YNAB account. YNAB exports carry no stable account ID. The only handle is the account name, which often contains the last digits of an account number. RFC 0002 keeps provider labels out of `ledger.account_sources`. It also says a later export must not _assume_ the name is a stable identifier. This RFC adds the smallest protected record that lets a name be _recognized_, while every consequential decision stays explicit.

## Goals

- Persist reviewed YNAB account decisions through the existing RFC 0002 create/link commands.
- Recognize previously decided YNAB accounts in later exports without storing their names in plaintext.
- Support per-account save and save-all with per-account atomicity.
- Record exclusions as explicit, auditable decisions.
- Remain replay-safe and fail closed under concurrent or repeated saves.

## Non-goals

- Categories, transactions, raw payload retention, source records, or any monetary write (later RFC 0004 units).
- Balances (next RFC) and user-entered account details such as account and routing numbers ([future expansion](../future/expansion.md), planned after balances).
- Changing a saved link from this screen. RFC 0002 unlink/relink already exists; UI for it is a follow-up.
- Multiple YNAB plans. The owner has one plan; see Open Questions.

## Design

### Recognition by keyed digest

A new append-only module table, `ledger.ynab_account_decisions`, stores one revision per decision:

| Column                   | Meaning                                                                                       |
| ------------------------ | --------------------------------------------------------------------------------------------- |
| `id`                     | Meridian-local UUID                                                                           |
| `label_digest`           | HMAC-SHA-256 of the NFC-normalized YNAB account name, hex                                     |
| `digest_key_id`          | Keyring version used for the digest                                                           |
| `decision`               | `tracked` or `excluded`                                                                       |
| `account_source_id`      | RFC 0002 source registered for this YNAB account; required for `tracked`, null for `excluded` |
| `supersedes_decision_id` | Previous revision for the same digest, forming one linear chain                               |
| `recorded_at`            | Server-owned                                                                                  |

A security-invoker view, `ledger.current_ynab_account_decisions`, exposes the tip for each `(digest_key_id, label_digest)`.

The name itself is never stored. The digest uses a new, independent environment keyring (`YNAB_LABEL_DIGEST_KEYRING` with `YNAB_LABEL_DIGEST_CURRENT_KEY_ID`), following the RFC 0003 pattern of one keyring per purpose. Without the key, the digest cannot be tested against guessed names. Lookup computes the digest under every available key version. After rotation, a name that matches only under a retired version is still recognized. Re-deciding it extends that retired-key chain, and no automatic re-keying happens.

Why `ledger.*` and not `ops.*`: a decision, especially an exclusion, is part of the migration's audit history and must be backed up with the ledger forever. The web application's `meridian_app` role already has ledger `SELECT`/`INSERT` and no `ops.*` access. The table follows module naming (`ynab_` prefix) and core ledger rules: append-only, with `UPDATE`, `DELETE`, and `TRUNCATE` rejected for every role.

### Recognition is a suggestion, not proof

When an export is analyzed, each source account is looked up:

- **Tracked**: rendered as saved, showing the current Meridian account name and type. No new decision is required.
- **Excluded**: rendered as saved-excluded. The owner may re-decide it; see below.
- **Unknown**: a fresh row with a save action.

A renamed YNAB account is unknown. The owner then links it to the existing Meridian account. Open Question 1 decides whether it reuses the old YNAB source.

### Saving

Each save is one database transaction:

- **create**: RFC 0002 `createAccountAndLinkSource` (source `ynab`, kind `import`) plus a `tracked` decision.
- **link**: RFC 0002 `registerAndLinkAccountSource` to the chosen current account plus a `tracked` decision.
- **exclude**: an `excluded` decision only; no account source is registered.

**Save all** attempts every unsaved row that has a decision, plus any excluded row the person reopened, in export order. Each save is atomic on its own. Undecided rows are skipped and counted. Each row is validated against the whole export (saved exclusions plus exclusions decided in the same review), and results are reported per row, so one invalid row does not block or undo the others.

The exclusion rule from the dry run still applies. An account cannot be excluded while any included account (saved or in the current draft) has transfer rows referencing it.

### Re-deciding

- `excluded → tracked`: append a revision that supersedes the exclusion and registers the source.
- `tracked → excluded` or `tracked → different account`: not in this unit. A tracked source may already be referenced by later source records, so changing it goes through RFC 0002 unlink/relink and the RFC 0004 correction policy.

### Concurrency and replay

- A unique partial index on `(digest_key_id, label_digest)` for chain roots, plus a unique `supersedes_decision_id`, prevents two concurrent first decisions or a branching chain. The losing transaction rolls back its account/source inserts and reports the account as already saved.
- The decision `id` is the replay key. Re-submitting an identical decision row is a no-op, and the same `id` with a different payload is a conflict. The web flow generates IDs on the server; a double submit therefore surfaces as "already saved" rather than a replay.
- Decision and source insertion share the RFC 0002 lock order.

## Database enforcement

- Append-only triggers on the table and `TRUNCATE` rejection.
- `decision` checked. `account_source_id` is non-null exactly when `tracked`, and the referenced source has `source = 'ynab'`.
- Digest is 64 lowercase hex characters, and the key ID is non-empty.
- A linear chain per digest, and a supersession stays within one digest.
- The runtime role has `SELECT, INSERT` with server-owned `recorded_at` through column grants.

## Required tests

- Keyed digest: stable for the same key, different across keys, never stores or logs the name; NFC normalization.
- Lookup classifies tracked, excluded, and unknown; retired-key matches are recognized.
- Create/link/exclude atomicity, including rollback of account and source when the decision insert fails.
- Concurrent first saves of the same name: exactly one succeeds.
- Exact replay no-op; conflicting replay rejected.
- Save-all partial failure leaves earlier rows saved and reports per-row status.
- Exclusion transfer-reference rule, including saved decisions.
- Append-only, `TRUNCATE`, grants, and check constraints for both roles.
- Architecture: this service cannot record source records or transactions.

## Resolved questions

1. **Renamed YNAB accounts (resolved 2026-09-25).** The UI offers an explicit "Renamed saved account" decision listing tracked YNAB sources whose names did not match anything in the current export. Choosing one appends a `tracked` decision for the new name that points at the existing YNAB source; no second source is registered. Only a currently linked source can be reused, and SQL enforces this.
2. **Multiple YNAB plans.** Still deferred. Digests are not scoped per plan.

## Consequences

Re-importing a YNAB export shows exactly which accounts are already tracked or excluded. Saving can be incremental, and nothing about YNAB account names is stored in recoverable form. The canonical account model is unchanged. Institution name and user-entered account details come later in a separate, mutable, encrypted store ([future expansion](../future/expansion.md)), and balances come in the following RFC.
