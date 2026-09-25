import { randomUUID } from "node:crypto";

import Decimal from "decimal.js";
import fc from "fast-check";
import { describe, expect, test } from "vitest";

import {
  decimalAmountSchema,
  ledgerTransactionSchema,
  sumAmounts,
  type DecimalAmount,
} from "../src/core/ledger";

const accountIds = [randomUUID(), randomUUID(), randomUUID()];

function amountFromCents(cents: bigint): DecimalAmount {
  return decimalAmountSchema.parse(
    new Decimal(cents.toString()).div(100).toFixed(),
  );
}

function transactionWith(amounts: readonly DecimalAmount[]) {
  return {
    id: randomUUID(),
    occurredOn: "2026-08-02",
    occurredAt: null,
    description: "Balanced test transaction",
    currency: "USD",
    provenance: { kind: "manual" },
    correctsTransactionId: null,
    entries: amounts.map((amount, index) => ({
      destination: "account",
      accountId: accountIds[index % accountIds.length],
      amount,
    })),
  };
}

describe("decimal amounts", () => {
  test.each(["0", "10", "-10", "0.01", "-42.125"])(
    "accepts canonical decimal string %s",
    (amount) => {
      expect(decimalAmountSchema.parse(amount)).toBe(amount);
    },
  );

  test.each([0.1, "1e2", "+1", "01", "1.0", "-0", "NaN", "Infinity"])(
    "rejects non-canonical amount %s",
    (amount) => {
      expect(decimalAmountSchema.safeParse(amount).success).toBe(false);
    },
  );
});

describe("exact amount sums", () => {
  const amount = (value: string) => decimalAmountSchema.parse(value);

  test("returns canonical sums beyond default Decimal.js precision", () => {
    expect(sumAmounts([])).toBe("0");
    expect(sumAmounts([amount("1.25"), amount("-1.25")])).toBe("0");
    expect(sumAmounts([amount("0.1"), amount("0.2")])).toBe("0.3");
    expect(sumAmounts([amount("10.5"), amount("-0.5")])).toBe("10");
    expect(
      sumAmounts([
        amount("123456789012345678901234567890.01"),
        amount("0.000000000000000000000000000001"),
      ]),
    ).toBe("123456789012345678901234567890.010000000000000000000000000001");
  });
});

describe("ledger transactions", () => {
  test("balances exactly beyond decimal.js default precision", () => {
    const amounts = [
      "100000000000000000000",
      "0.01",
      "-100000000000000000000.01",
    ].map((amount) => decimalAmountSchema.parse(amount));

    expect(
      ledgerTransactionSchema.safeParse(transactionWith(amounts)).success,
    ).toBe(true);
  });

  test("detects small imbalances beyond decimal.js default precision", () => {
    const amounts = [
      "100000000000000000000",
      "0.01",
      "-100000000000000000000",
    ].map((amount) => decimalAmountSchema.parse(amount));

    expect(
      ledgerTransactionSchema.safeParse(transactionWith(amounts)).success,
    ).toBe(false);
  });

  test("accepts generated balanced transactions", () => {
    fc.assert(
      fc.property(
        fc.array(fc.bigInt({ min: -10_000_000_00n, max: 10_000_000_00n }), {
          minLength: 1,
          maxLength: 20,
        }),
        (cents) => {
          const balancingCents = -cents.reduce((sum, value) => sum + value, 0n);
          const amounts = [...cents, balancingCents].map(amountFromCents);

          expect(
            ledgerTransactionSchema.safeParse(transactionWith(amounts)).success,
          ).toBe(true);
        },
      ),
    );
  });

  test("rejects generated unbalanced transactions", () => {
    fc.assert(
      fc.property(
        fc.array(fc.bigInt({ min: -10_000_000_00n, max: 10_000_000_00n }), {
          minLength: 1,
          maxLength: 20,
        }),
        fc.bigInt({ min: 1n, max: 10_000n }),
        (cents, imbalance) => {
          const total = cents.reduce((sum, value) => sum + value, 0n);
          const amounts = [...cents, -total + imbalance].map(amountFromCents);

          expect(
            ledgerTransactionSchema.safeParse(transactionWith(amounts)).success,
          ).toBe(false);
        },
      ),
    );
  });

  test("requires exactly one posting destination", () => {
    const transaction = transactionWith([
      amountFromCents(100n),
      amountFromCents(-100n),
    ]);
    const invalidEntry = {
      ...transaction.entries[0],
      categoryId: randomUUID(),
    };

    expect(
      ledgerTransactionSchema.safeParse({
        ...transaction,
        entries: [invalidEntry, transaction.entries[1]],
      }).success,
    ).toBe(false);
  });

  test("rejects a correction that references itself", () => {
    const transaction = transactionWith([
      amountFromCents(100n),
      amountFromCents(-100n),
    ]);

    expect(
      ledgerTransactionSchema.safeParse({
        ...transaction,
        provenance: { kind: "system" },
        correctsTransactionId: transaction.id,
      }).success,
    ).toBe(false);
  });

  test("requires corrections to be system-originated", () => {
    const transaction = transactionWith([
      amountFromCents(100n),
      amountFromCents(-100n),
    ]);

    expect(
      ledgerTransactionSchema.safeParse({
        ...transaction,
        correctsTransactionId: randomUUID(),
      }).success,
    ).toBe(false);
    expect(
      ledgerTransactionSchema.safeParse({
        ...transaction,
        provenance: { kind: "system" },
        correctsTransactionId: randomUUID(),
      }).success,
    ).toBe(true);
  });

  test("requires canonical UTC timestamps", () => {
    const transaction = transactionWith([
      amountFromCents(100n),
      amountFromCents(-100n),
    ]);

    expect(
      ledgerTransactionSchema.safeParse({
        ...transaction,
        occurredAt: "2026-08-02T08:00:00.000-04:00",
      }).success,
    ).toBe(false);
  });
});
