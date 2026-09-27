---
summary: Deferred design direction for goals as capital buckets and a deterministic policy engine (reserve, duration matching, allocation, DCA) whose findings reach the owner as Inbox decisions and never act without approval
read_when: Designing goals, strategies, policies, recommendations, emergency-reserve or duration logic, AI explanations of financial findings, or the Phase 3 strategy engine
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

## Rules that already apply

- **Evaluation is pure.** Like `Strategy.evaluate()` (invariant I3), a policy evaluation does no I/O, clock reads, or randomness. Everything arrives in its context. Investment strategies and capital policies are expected to be one engine, with DCA as one policy kind.
- **News never feeds a policy** (invariant I4).
- **Nothing acts without approval.** Findings reach the owner as Inbox `decision` items ([RFC 0009](../decisions/0009-inbox.md)). Choosing an option, including "leave it unchanged", is recorded as a ledger decision with the evaluation it answered. Orders still go only through executors and the approval queue (invariant I5).
- **AI explains; it does not decide.** An AI layer may explain findings, surface conflicts and missing assumptions, generate scenarios, and help the owner edit policies. Its output is never an input to an evaluation and never a stored financial fact. Whether financial data may be sent to an external model is a separate privacy decision for the policy RFC.

## Prerequisites

- Categorized spending history, including an essential/discretionary distinction: transaction import (RFC 0008) and categorization.
- Positions, maturities, and prices: Phase 2.
- The Inbox with `decision` items: RFC 0009.
