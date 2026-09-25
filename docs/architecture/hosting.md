---
summary: Deferred hosting decision, host options by phase and credential risk, and what is decided regardless of host
read_when: Deploying, running jobs unattended, or choosing where Meridian runs
---

# Hosting

Formerly `PLAN.md` §8.

**Defer the decision. Phases 0–2 run locally under Docker Compose.** There is nothing to decide while building, and deciding early only constrains.

The decision becomes real at phase 3, when jobs must run unattended. The right answer changes with the threat model:

| Phase | Credentials at risk                             | Reasonable host                                                                                                                                                                                  |
| ----- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0     | none                                            | laptop / desktop, Docker Compose                                                                                                                                                                 |
| 1–2   | read-only aggregator/broker tokens (local only) | laptop / desktop, Docker Compose                                                                                                                                                                 |
| 3     | read-only aggregator/broker tokens, unattended  | small VPS (Hetzner ~€5/mo) + Tailscale, or home server                                                                                                                                           |
| 4     | paper-trading keys                              | same                                                                                                                                                                                             |
| 5+    | **live broker write keys**                      | reconsider — a VPS provider controls the hypervisor, so encryption at rest does not protect against them. Consider splitting the execution worker onto owned hardware while the UI stays hosted. |

Home server trades uptime and maintenance burden for full data custody. A VPS trades custody for reliability and trivial off-site backups. For read-only phases the VPS is the pragmatic pick; the calculus genuinely changes when write credentials enter.

**Decided now regardless of host:**

- Backups begin at phase 0.
- Everything stays in Docker Compose with no cloud-specific services, keeping the deferred decision cheap.
