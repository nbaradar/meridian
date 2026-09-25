---
name: project-status
description: Give the owner a short status report on Meridian — last thing built, what is in progress, proposed plans, and what is next. Use when the owner asks for project status, "where are we", or what to work on.
---

# Project status

Report briefly. Read only what is listed here; do not explore the codebase.

## Read

1. `docs/status.md` — current state, agreed priority, plans.
2. The table in `docs/plans/README.md` — plan statuses.
3. The last two entries of `docs/history.md` (use `tail`, not the whole file).
4. `git log --oneline -5` and `git status --short` — recent commits and uncommitted work.

Open a plan file only if it is In progress, to report which acceptance criteria remain.

## Report

At most about 12 lines, in this shape. Omit any line with nothing to say.

```
**Last built:** <one line, with date>
**In progress:** <plan and what remains, or "nothing">
**Plans:** <each non-Done plan: number, title, status; flag open questions>
**Next up:** <the next item from the agreed priority>
**Needs you:** <decisions or approvals blocking progress>
**Repo:** <branch; uncommitted changes, if any>
```

No preamble, no restating the project's purpose, no recommendations unless something is blocked.
