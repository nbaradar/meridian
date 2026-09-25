import { randomUUID } from "node:crypto";

import Decimal from "decimal.js";
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { ZodError } from "zod";

import {
  accountIdSchema,
  balanceAgeDays,
  balanceAmountFromEntry,
  BalanceObservationDateError,
  BalanceObservationReferenceError,
  balanceObservationIdSchema,
  buildBalanceDashboard,
  calendarDateSchema,
  computeNetWorth,
  createBalanceObservationService,
  decimalAmountSchema,
  entryAmountFromBalance,
  latestAllowedObservationDate,
  utcTimestampSchema,
  type AccountClass,
  type AccountType,
  type BalanceObservationStore,
  type CurrentAccount,
  type CurrentBalance,
  type NewBalanceObservation,
  type NewBalanceObservationRetraction,
} from "../src/core/ledger";

const amount = (value: string) => decimalAmountSchema.parse(value);
const date = (value: string) => calendarDateSchema.parse(value);
const now = utcTimestampSchema.parse("2026-09-25T23:30:00Z");

function account(
  name: string,
  accountType: AccountType,
  accountClass: AccountClass,
  status: CurrentAccount["status"] = "active",
): CurrentAccount {
  return {
    id: accountIdSchema.parse(randomUUID()),
    name,
    accountType,
    accountClass,
    currency: "USD",
    openedOn: null,
    status,
  };
}

function balance(
  of: CurrentAccount,
  value: string,
  observedOn = "2026-09-20",
): CurrentBalance {
  return {
    observationId: balanceObservationIdSchema.parse(randomUUID()),
    accountId: of.id,
    observedOn: date(observedOn),
    amount: amount(value),
    currency: "USD",
    source: "manual",
    recordedAt: now,
  };
}

function memoryStore(accounts: readonly CurrentAccount[]) {
  const recorded: NewBalanceObservation[] = [];
  const retracted: NewBalanceObservationRetraction[] = [];
  const store: BalanceObservationStore = {
    findAccount: async (id) => accounts.find((item) => item.id === id) ?? null,
    listAccounts: async () => accounts,
    listCurrentBalances: async () => [],
    recordObservation: async (observation) => {
      recorded.push(observation);
    },
    recordYnabObservation: async (observation) => {
      recorded.push(observation);
      return "recorded";
    },
    retractObservation: async (retraction) => {
      retracted.push(retraction);
    },
  };
  return { store, recorded, retracted };
}

describe("amount-owed conversion", () => {
  test.each([
    ["250.1", "-250.1"],
    ["0", "0"],
    ["-12.5", "12.5"],
  ])("a liability owing %s stores %s", (owed, stored) => {
    expect(balanceAmountFromEntry("liability", amount(owed))).toBe(stored);
    expect(entryAmountFromBalance("liability", amount(stored))).toBe(owed);
  });

  test("an asset stores the entered balance unchanged", () => {
    expect(balanceAmountFromEntry("asset", amount("-3.2"))).toBe("-3.2");
    expect(balanceAmountFromEntry("asset", amount("100"))).toBe("100");
  });
});

describe("latest allowed date", () => {
  test("is the server UTC date plus one day", () => {
    expect(latestAllowedObservationDate(now)).toBe("2026-09-26");
    expect(
      latestAllowedObservationDate(
        utcTimestampSchema.parse("2026-12-31T00:00:00Z"),
      ),
    ).toBe("2027-01-01");
  });

  test("accepts the latest allowed date and rejects the day after", async () => {
    const checking = account("Checking", "checking", "asset");
    const { store, recorded } = memoryStore([checking]);
    const service = createBalanceObservationService(store, () => now);
    await service.recordManualBalance({
      observationId: randomUUID(),
      accountId: checking.id,
      observedOn: "2026-09-26",
      enteredAmount: "10",
    });
    expect(recorded).toHaveLength(1);

    const rejected = service.recordManualBalance({
      observationId: randomUUID(),
      accountId: checking.id,
      observedOn: "2026-09-27",
      enteredAmount: "10",
    });
    await expect(rejected).rejects.toBeInstanceOf(BalanceObservationDateError);
    await expect(rejected).rejects.toThrow(/after 2026-09-26/u);
    await expect(
      service.recordYnabBalance({
        observationId: randomUUID(),
        accountId: checking.id,
        accountSourceId: randomUUID(),
        exportDigest: "a".repeat(64),
        observedOn: "2026-09-27",
        amount: "1",
      }),
    ).rejects.toBeInstanceOf(BalanceObservationDateError);
    expect(recorded).toHaveLength(1);
  });

  test("age counts whole days back from today", () => {
    expect(balanceAgeDays(date("2026-09-20"), date("2026-09-25"))).toBe(5);
    expect(balanceAgeDays(date("2026-09-26"), date("2026-09-25"))).toBe(-1);
    expect(balanceAgeDays(date("2026-02-28"), date("2026-03-01"))).toBe(1);
  });
});

describe("balance commands", () => {
  test.each([
    ["10.00", "10"],
    [" 1,234.50 ", "1234.5"],
    ["-0.000", "0"],
    ["007.10", "7.1"],
    ["0.001", "0.001"],
  ])("canonicalizes the typed amount %j to %s", async (typed, stored) => {
    const checking = account("Checking", "checking", "asset");
    const { store, recorded } = memoryStore([checking]);
    const service = createBalanceObservationService(store, () => now);
    await service.recordManualBalance({
      observationId: randomUUID(),
      accountId: checking.id,
      observedOn: "2026-09-25",
      enteredAmount: typed,
    });
    expect(recorded[0]!.amount).toBe(stored);
  });

  test("a manual liability entry of amount owed X stores -X", async () => {
    const card = account("Card", "credit_card", "liability");
    const { store, recorded } = memoryStore([card]);
    const service = createBalanceObservationService(store, () => now);
    await service.recordManualBalance({
      observationId: randomUUID(),
      accountId: card.id,
      observedOn: "2026-09-25",
      enteredAmount: "1234.56",
    });
    expect(recorded[0]).toMatchObject({
      amount: "-1234.56",
      source: "manual",
      accountSourceId: null,
      exportDigest: null,
      supersedesObservationId: null,
      currency: "USD",
    });
  });

  test("a correction is a manual observation superseding the target", async () => {
    const card = account("Card", "credit_card", "liability");
    const { store, recorded } = memoryStore([card]);
    const service = createBalanceObservationService(store, () => now);
    const supersedesObservationId = randomUUID();
    await service.correctBalance({
      observationId: randomUUID(),
      supersedesObservationId,
      accountId: card.id,
      observedOn: "2026-09-24",
      enteredAmount: "-5",
    });
    expect(recorded[0]).toMatchObject({
      amount: "5",
      source: "manual",
      supersedesObservationId,
    });
  });

  test("rejects malformed commands and unknown accounts", async () => {
    const checking = account("Checking", "checking", "asset");
    const { store, recorded } = memoryStore([checking]);
    const service = createBalanceObservationService(store, () => now);
    const valid = {
      observationId: randomUUID(),
      accountId: checking.id,
      observedOn: "2026-09-25",
      enteredAmount: "10",
    };
    for (const invalid of [
      { ...valid, enteredAmount: "1e3" },
      { ...valid, enteredAmount: "" },
      { ...valid, enteredAmount: "12,34" },
      { ...valid, enteredAmount: "$5" },
      { ...valid, observedOn: "2026-02-30" },
      { ...valid, accountId: "not-a-uuid" },
      { ...valid, source: "manual" },
    ]) {
      await expect(service.recordManualBalance(invalid)).rejects.toBeInstanceOf(
        ZodError,
      );
    }
    await expect(
      service.recordManualBalance({ ...valid, accountId: randomUUID() }),
    ).rejects.toBeInstanceOf(BalanceObservationReferenceError);
    await expect(
      service.recordYnabBalance({
        observationId: randomUUID(),
        accountId: checking.id,
        accountSourceId: randomUUID(),
        exportDigest: "not-a-digest",
        observedOn: "2026-09-25",
        amount: "1",
      }),
    ).rejects.toBeInstanceOf(ZodError);
    expect(recorded).toHaveLength(0);
  });
});

describe("net worth", () => {
  test("sums mixed assets and liabilities with fractional cents exactly", () => {
    const checking = account("Checking", "checking", "asset");
    const brokerage = account("Brokerage", "brokerage", "asset");
    const card = account("Card", "credit_card", "liability");
    const result = computeNetWorth(
      [checking, brokerage, card],
      [
        balance(checking, "1000.1"),
        balance(brokerage, "0.005"),
        balance(card, "-200.2"),
      ],
    );
    expect(result.assets).toBe("1000.105");
    expect(result.liabilities).toBe("-200.2");
    expect(result.netWorth).toBe("799.905");
    expect(result.included).toHaveLength(3);
  });

  test("lists active accounts without a balance separately", () => {
    const checking = account("Checking", "checking", "asset");
    const savings = account("Savings", "savings", "asset");
    const result = computeNetWorth(
      [checking, savings],
      [balance(checking, "5")],
    );
    expect(result.netWorth).toBe("5");
    expect(result.withoutBalance.map((item) => item.id)).toEqual([savings.id]);
  });

  test("flags a closed account with a nonzero balance and ignores a zero one", () => {
    const openChecking = account("Open", "checking", "asset");
    const closedNonzero = account(
      "Closed card",
      "credit_card",
      "liability",
      "closed",
    );
    const closedZero = account("Closed savings", "savings", "asset", "closed");
    const closedEmpty = account("Closed empty", "cash", "asset", "closed");
    const result = computeNetWorth(
      [openChecking, closedNonzero, closedZero, closedEmpty],
      [
        balance(openChecking, "10"),
        balance(closedNonzero, "-3"),
        balance(closedZero, "0"),
      ],
    );
    expect(result.netWorth).toBe("10");
    expect(result.liabilities).toBe("0");
    expect(
      result.closedWithBalance.map(({ account: item }) => item.id),
    ).toEqual([closedNonzero.id]);
    expect(result.withoutBalance).toEqual([]);
  });

  test("subtotals an other-type account by its explicit class", () => {
    const otherLiability = account("Family loan", "other", "liability");
    const otherAsset = account("Deposit", "other", "asset");
    const result = computeNetWorth(
      [otherLiability, otherAsset],
      [balance(otherLiability, "-400"), balance(otherAsset, "150")],
    );
    expect(result.assets).toBe("150");
    expect(result.liabilities).toBe("-400");
    expect(result.netWorth).toBe("-250");
  });

  test("equals the sum of included amounts regardless of input order", () => {
    const cents = fc.bigInt({ min: -10_000_000_00n, max: 10_000_000_00n });
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            cents,
            liability: fc.boolean(),
            closed: fc.boolean(),
            hasBalance: fc.boolean(),
          }),
          { maxLength: 20 },
        ),
        fc.integer(),
        (specs, seed) => {
          const accounts = specs.map((spec, index) =>
            account(
              `Account ${index}`,
              spec.liability ? "loan" : "savings",
              spec.liability ? "liability" : "asset",
              spec.closed ? "closed" : "active",
            ),
          );
          const balances = specs.flatMap((spec, index) =>
            spec.hasBalance
              ? [
                  balance(
                    accounts[index]!,
                    new Decimal(spec.cents.toString()).div(100).toFixed(),
                  ),
                ]
              : [],
          );
          const expected = specs
            .filter((spec) => spec.hasBalance && !spec.closed)
            .reduce(
              (sum, spec) => sum.plus(new Decimal(spec.cents.toString())),
              new Decimal(0),
            )
            .div(100);
          const result = computeNetWorth(accounts, balances);
          expect(new Decimal(result.netWorth).equals(expected)).toBe(true);
          expect(
            new Decimal(result.assets)
              .plus(result.liabilities)
              .equals(result.netWorth),
          ).toBe(true);

          const shuffle = <T>(items: readonly T[]): T[] =>
            [...items]
              .map((item, index) => ({
                item,
                key: (index * 7919 + seed) % 104729,
              }))
              .sort((left, right) => left.key - right.key)
              .map(({ item }) => item);
          const reordered = computeNetWorth(
            shuffle(accounts),
            shuffle(balances),
          );
          expect(reordered.netWorth).toBe(result.netWorth);
          expect(reordered.assets).toBe(result.assets);
          expect(reordered.liabilities).toBe(result.liabilities);
        },
      ),
    );
  });
});

describe("dashboard", () => {
  test("groups by account type order and sorts by name, with ages", () => {
    const zSavings = account("Zeta savings", "savings", "asset");
    const aSavings = account("Alpha savings", "savings", "asset");
    const checking = account("Main checking", "checking", "asset");
    const card = account("Card", "credit_card", "liability");
    const dashboard = buildBalanceDashboard(
      [card, zSavings, aSavings, checking],
      [balance(checking, "1", "2026-09-20"), balance(card, "-2", "2026-09-25")],
      now,
    );
    expect(dashboard.today).toBe("2026-09-25");
    expect(dashboard.latestAllowedDate).toBe("2026-09-26");
    expect(
      dashboard.groups.map((group) => [
        group.accountType,
        group.accounts.map((item) => item.account.name),
      ]),
    ).toEqual([
      ["checking", ["Main checking"]],
      ["savings", ["Alpha savings", "Zeta savings"]],
      ["credit_card", ["Card"]],
    ]);
    expect(dashboard.groups[0]!.accounts[0]!.ageDays).toBe(5);
    expect(dashboard.groups[1]!.accounts[0]!.balance).toBeNull();
    expect(dashboard.groups[2]!.accounts[0]!.ageDays).toBe(0);
  });
});
