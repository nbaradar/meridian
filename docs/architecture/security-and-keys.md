---
summary: Environment keyrings Meridian uses, what each protects, and what happens if one is lost
read_when: Adding, rotating, or backing up a key, handling secrets, or storing anything sensitive
---

# Security and keys

General secret rules are in `AGENTS.md` "Secrets". Key custody for a future multi-user deployment is in [future expansion](../future/expansion.md).

## Where secrets and personal data live

The repository is public, so nothing personal is committed:

- **`.env`** is kept in the owner's password manager and copied to each machine. Every machine that touches the same database or backups must use identical keys; a freshly generated key cannot read or recognize what another key wrote.
- **Owner-specific facts** (institutions held, account names, goals, notes) live in `local/`, a gitignored directory holding a separate private repository.
- **Financial data** (YNAB and bank exports, database dumps) enters no repository, private or public. Exports go in the gitignored `local/imports/` or `imports/`.
- **Pre-commit scanning.** `.githooks/pre-commit` runs `gitleaks` with `.gitleaks.toml` on staged changes and, when `local/denylist.txt` exists, rejects any added line containing one of its terms. `pnpm install` sets `core.hooksPath`; the hook refuses to commit if gitleaks is not installed.

## YNAB account-name digest keys

YNAB account-name digest keys (`YNAB_LABEL_DIGEST_KEYRING`) follow the same rule: 32 random bytes each, environment only, independent of every other keyring. Losing the key means saved YNAB accounts are no longer recognized on re-import. Nothing is corrupted; re-saving would create second sources, so back the key up alongside the database.

## Raw-payload encryption keys

Raw payload encryption keys are 32 random bytes supplied as base64 through `RAW_PAYLOAD_ENCRYPTION_KEY`, with an explicit rotation identifier in `RAW_PAYLOAD_KEY_ID`. Keys never enter the database or repository. XChaCha20-Poly1305 authenticates source, digest, algorithm, and key ID alongside the ciphertext.
