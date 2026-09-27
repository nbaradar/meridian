---
summary: Deferred design direction for goals as capital buckets and a deterministic policy engine (reserve, duration matching, allocation, DCA) whose findings reach the owner as Inbox decisions and never act without approval; also the owner's ideas for DCA reminders and checks and a policy configuration page
read_when: Designing goals, strategies, policies, recommendations, emergency-reserve or duration logic, DCA reminders, a policy or settings configuration page, AI explanations of financial findings, or the Phase 3 strategy engine
---

# Future direction: goals and capital policies

Not started. This records the owner's intended direction for Phase 3 ([PLAN.md](../../PLAN.md)) so earlier work leaves room for it. The design needs its own RFC before implementation. Examples below are illustrative; the owner's real goals live in the private `local/` directory.

## The question Meridian should answer

Budgeting tools answer "where did my money go?". Meridian should also answer: **given my goals, constraints, balances, spending, time horizons, and chosen policies, is my capital deployed appropriately, and what should I consider changing?**

## Goals as capital buckets

Money is modeled by purpose as well as by account. A savings balance may be split among an emergency reserve, a car, a house down payment, and unallocated capital, each with its own:

- target amount and funded amount;
- earliest need date, target date, and latest acceptable date;
- priority;
- liquidity requirement and loss tolerance;
- linked accounts or assets;
- contribution and allocation policies.

This extends the structured goals in `PLAN.md` §11. Goals and their allocations are owner decisions about money, so they belong in `ledger.*`, append-only.

## Policies

A policy is a deterministic, inspectable rule the owner chooses, evaluated against current data:

**financial data → metrics → policy → evaluation → findings and candidate actions → explanation → owner approval**

Examples: emergency reserve, minimum cash buffer, goal funding, time-horizon/duration matching, asset allocation, rebalancing, concentration, cash drag, debt paydown, tax location, and contribution/DCA.

- **Duration matching:** compare when a goal may need money with when its assets mature. For example, a down payment possibly needed in three years should not depend on selling a longer-dated bond at an unknown price. Report the mismatch and the options.
- **Dynamic emergency reserve:** size the reserve from trailing essential spending (3, 6, or 12 months) under a policy such as "six months of essential expenses". If the requirement falls below the current reserve, identify and explain the excess and offer destinations. Never move it automatically.

## Owner ideas (2026-09-27)

Captured for the policy RFC. Not scheduled; they are implemented in whatever order fits, including inside an existing plan.

### Contribution reminders and checks (DCA)

A contribution policy such as "$500 into fund X from account Y on the 15th of each month, 5 days' grace" should:

- **remind** the owner as each date approaches, as an Inbox `action` item;
- **check** imported transactions (and later positions) for a matching contribution;
- **warn** when the grace period passes without one, as an Inbox item that clears itself once the transaction is imported;
- say nothing once a matching contribution is found.

It never places an order: reminding and checking come first, and any execution waits for the Phase 4 approval queue. The reminder alone needs only the schedule; checking needs transaction import (Plans 0004 and 0005), and share-level checks need positions (Phase 2). Each item's key would name the policy and period, and its version the matched evidence, so the Inbox behaves as it does for balance items.

### A configuration page

The owner wants one page to see and change the rules behind reminders and policies. What is configured is the **parameters of built-in rule kinds** (on or off, amounts, schedules, thresholds, tolerances), each validated by a schema, never free-form logic, so every rule stays deterministic and testable. The page can show two kinds of rule side by side, but they are stored differently:

- **Money policies** (DCA, reserve, allocation) are decisions about money: stored append-only in `ledger.*`, so the policy in force when an evaluation ran can always be shown.
- **Reminder preferences** (how the Inbox nags) are workspace state: stored mutably in `app.*`, which [RFC 0009](../decisions/0009-inbox.md) already expects to hold owner preferences.

The first reminder preference the owner wants is a **configurable stale-balance threshold**, for example per account type (a loan or CD balance may reasonably go 90 days without change) instead of RFC 0009's fixed 30 days for every account. This changes an RFC 0009 decision, so it needs a short superseding RFC. It depends on nothing else and could join [Plan 0006](../plans/0006-review-queue-and-inbox-items-after-0003-0005.md), the next Inbox unit, or be its own small plan. Related: a dormant YNAB account's stale item returns after each YNAB balance save even when dismissed, because each save records a new balance with the same last-row date. A longer threshold for such accounts, or a "still correct" confirmation on the dashboard, would reduce that noise.

## Rules that already apply

- **Evaluation is pure.** Like `Strategy.evaluate()` (invariant I3), a policy evaluation does no I/O, clock reads, or randomness. Everything arrives in its context. Investment strategies and capital policies are expected to be one engine, with DCA as one policy kind.
- **News never feeds a policy** (invariant I4).
- **Nothing acts without approval.** Findings reach the owner as Inbox `decision` items ([RFC 0009](../decisions/0009-inbox.md)). Choosing an option, including "leave it unchanged", is recorded as a ledger decision with the evaluation it answered. Orders still go only through executors and the approval queue (invariant I5).
- **AI explains; it does not decide.** An AI layer may explain findings, surface conflicts and missing assumptions, generate scenarios, and help the owner edit policies. Its output is never an input to an evaluation and never a stored financial fact. Whether financial data may be sent to an external model is a separate privacy decision for the policy RFC.

## Prerequisites

- Categorized spending history, including an essential/discretionary distinction: transaction import (RFC 0008) and categorization.
- Positions, maturities, and prices: Phase 2.
- The Inbox with `decision` items: RFC 0009.
