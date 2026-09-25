---
summary: Deferred multi-user expansion: current posture and rules, decisions to make, key custody, and the user-entered account details design
read_when: Anything involving other users, authentication, sharing, per-user keys, connector requests, or storing account and routing numbers
---

# Future expansion: other users

Not started, on purpose. Formerly `PLAN.md` §12, plus the working rules from `AGENTS.md`; this document records the rationale, the open decisions, and the working rules until then.

## Working rules until then (from `AGENTS.md`)

- **Do not build multi-user speculatively.** Add no tenant or user columns, authentication, sharing machinery, or public exposure. Multi-user support, public internet exposure, and a login page are current non-goals (`PLAN.md` §1 and §7). Access stays Tailscale-only. Revisiting any of them is an explicit, reviewed design decision, not something to drift into.
- **Keys stay out of the database they protect.** Every encryption and digest key is an environment keyring owned by the single operator today. Do not move keys into the database or add per-user keys ahead of the expansion decision; `PLAN.md` §12 lists what must be decided (ownership, secrets storage, backup, rotation).
- **Keep the later decision cheap.** Framework-independent domain logic, provider-neutral connectors, canonical accounts independent of any connector, and no hard-coded personal identifiers are what make expansion possible without a rewrite.
- **Connector requests** ("support institution X") are a future workflow. Today an unsupported institution uses manual entry or file import.
- **User-entered account details are deferred.** This covers account numbers, routing numbers, institution contact details, and notes a person adds for their own tracking. Do not add fields for them to `ledger.*` or to any existing table ahead of the accepted design. When the feature is built:
  - **Storage:** a separate, mutable, protected store keyed by canonical account ID. The ledger is append-only and backed up forever, but these details must be editable and truly erasable.
  - **Encryption:** encrypt each sensitive field with the existing XChaCha20-Poly1305 envelope under its own versioned environment keyring, authenticating the account ID and field name as associated data.
  - **Display and handling:** masked by default and revealed only on explicit request. Never logged, and never exposed through MCP, an LLM prompt, raw payloads, or fixtures.
  - **Kept apart from connector identity:** these details are separate from the RFC 0003 provider-native identity used for connector matching, and never drive account linking.
  - **Institution name** lives in the same store as a plaintext field, for dashboard grouping.
  - **Review and timing:** it needs a short RFC first. The owner scheduled it after the balance dashboard, as a single-user feature ahead of any multi-user expansion.

Meridian may eventually be shared with others who find the dashboard useful. That is not a current goal, and nothing below is implemented. This section is the single place for what is deliberately deferred until then.

## Posture until then

- Multi-user and multi-tenant support, public internet exposure, and a login page remain non-goals (`PLAN.md` §1, [safety](../architecture/safety.md)). Access is Tailscale-only.
- No tenant or user columns, authentication, or sharing machinery are added speculatively.
- What keeps expansion cheap is the existing architecture: framework-independent services ([technology](../architecture/technology.md)), provider-neutral connectors behind the module contract ([modules](../architecture/modules.md)), canonical accounts independent of any connector (RFC 0002), and no personal identifiers in code or fixtures.

## Decisions to make when expansion is taken on

- **Deployment model.** One self-hosted instance per person is the smallest change and preserves data custody. A shared, hosted multi-tenant service would need tenant isolation (for example, PostgreSQL row-level security), per-tenant encryption keys, and a real threat model.
- **Authentication and exposure.** This replaces the Tailscale-only rule and the "no login page" rule with a reviewed design, including session security and recovery.
- **Execution.** Placing orders for anyone other than the owner is a different risk and regulatory category. Execution would stay owner-only unless separately designed.
- **Connector requests.** A workflow for a person to request an unsupported institution, which falls back to manual entry or file import until a connector exists.
- **Backups and key custody** per user, including how each person restores their own ledger. Today every secret is a single-owner environment keyring: `RAW_PAYLOAD_ENCRYPTION_KEY`, the `OPS_CREDENTIAL_*`, `OPS_IDENTITY_*`, and `OPS_IDENTITY_DIGEST_*` keyrings, and `YNAB_LABEL_DIGEST_*` (RFC 0005). Expansion must decide:
  - **Who owns the keys.** One instance per person keeps this as it is. A shared deployment needs per-user or per-tenant keys, so one user's key can neither decrypt nor recognize another's data.
  - **Where they live.** A secrets manager or KMS, never the database the keys protect.
  - **How they are backed up** alongside that user's ledger, and how rotation works.

  Losing a digest key such as `YNAB_LABEL_DIGEST_*` corrupts nothing, but saved YNAB accounts are no longer recognized. Losing an encryption key makes the data it sealed unreadable.

## Deferred feature: user-entered account details

Account-level details a person wants to keep for their own reference: account and routing numbers, institution contact details, and notes. Personal use doesn't require multi-user support, so this can be built earlier if wanted. It is grouped here because it adds a new class of sensitive data, which needs careful handling.

The intended design, subject to a short RFC:

- **Not in `ledger.*`.** The ledger is append-only and backed up forever, but these details must be editable and truly erasable. They belong in a separate, mutable, protected store keyed by canonical account ID.
- **Encrypted per field.** Use the existing libsodium XChaCha20-Poly1305 envelope under a dedicated, versioned environment keyring, separate from the raw-payload, credential, and provider-identity keyrings. The account ID and field name are authenticated as associated data so ciphertext cannot be moved between accounts or fields.
- **Masked by default.** Show the last four digits or less, with an explicit reveal. Never log them, and never expose them through MCP, LLM prompts, raw payloads, exports, or fixtures.
- **Not identity.** User-entered details are separate from the protected provider-native identity used for connector matching (RFC 0003), and never drive account linking or deduplication.
- **Institution name** is a plaintext field in the same store (not sensitive), so the dashboard can group accounts by institution.
- **Timing.** The owner chose to build this after the balance dashboard (September 25, 2026), ahead of multi-user expansion.
- **Effort.** Moderate. The encryption primitives and keyring pattern already exist; the new work is the store, key rotation, the edit/reveal UI, and tests proving plaintext never reaches logs or unencrypted columns.
