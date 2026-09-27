import Decimal from "decimal.js";
import { z } from "zod";

const canonicalDecimalPattern = /^-?(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/u;

export const usdCurrencySchema = z.literal("USD");
export type UsdCurrency = z.infer<typeof usdCurrencySchema>;

export const decimalAmountSchema = z
  .string()
  .regex(
    canonicalDecimalPattern,
    "Amount must be a canonical plain decimal string",
  )
  .refine((amount) => amount !== "-0", {
    message: "Amount must not be negative zero",
  })
  .brand<"DecimalAmount">();

export type DecimalAmount = z.infer<typeof decimalAmountSchema>;

/**
 * An amount as a person types it: optional sign, optional thousands commas,
 * and any number of trailing fraction zeros. Parsed to the canonical form
 * without rounding.
 */
export const enteredDecimalAmountSchema = z
  .string()
  .trim()
  .regex(
    /^-?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/u,
    "Enter an amount such as 1234.56",
  )
  .transform((entered) => {
    const exact = new Decimal(entered.replaceAll(",", ""));
    return decimalAmountSchema.parse(exact.isZero() ? "0" : exact.toFixed());
  });

export function amountsBalance(amounts: readonly DecimalAmount[]): boolean {
  return exactSum(amounts).isZero();
}

/** Exact sum of canonical decimal amounts, returned as a canonical amount. */
export function sumAmounts(amounts: readonly DecimalAmount[]): DecimalAmount {
  const sum = exactSum(amounts);
  return decimalAmountSchema.parse(sum.isZero() ? "0" : sum.toFixed());
}

/** Negates a canonical amount exactly, keeping zero unsigned. */
export function negateAmount(amount: DecimalAmount): DecimalAmount {
  if (amount === "0") return amount;
  return decimalAmountSchema.parse(
    amount.startsWith("-") ? amount.slice(1) : `-${amount}`,
  );
}

function exactSum(amounts: readonly DecimalAmount[]): Decimal {
  const digits = amounts.reduce(
    (maximum, amount) => {
      const [integer, fraction = ""] = amount.replace("-", "").split(".");
      return {
        integer: Math.max(maximum.integer, integer.length),
        fraction: Math.max(maximum.fraction, fraction.length),
      };
    },
    { integer: 1, fraction: 0 },
  );
  const ExactDecimal = Decimal.clone({
    precision:
      digits.integer + digits.fraction + amounts.length.toString().length + 1,
  });

  return amounts.reduce((sum, amount) => sum.plus(amount), new ExactDecimal(0));
}
