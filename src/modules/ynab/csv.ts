import { parse } from "csv-parse/sync";
import { z } from "zod";

import {
  calendarDateSchema,
  decimalAmountSchema,
  type CalendarDate,
  type DecimalAmount,
} from "../../core/ledger";

export const planHeaders = [
  "Month",
  "Category Group/Category",
  "Category Group",
  "Category",
  "Assigned",
  "Activity",
  "Available",
] as const;

export const registerHeaders = [
  "Account",
  "Flag",
  "Date",
  "Payee",
  "Category Group/Category",
  "Category Group",
  "Category",
  "Memo",
  "Outflow",
  "Inflow",
  "Cleared",
] as const;

const currencyPattern = /^-?\$(?:0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)\.\d{2}$/u;
const monthPattern =
  /^(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4}$/u;

function parseCurrency(value: string): DecimalAmount {
  if (!currencyPattern.test(value)) {
    throw new Error(`Invalid YNAB currency value: ${value}`);
  }
  const unformatted = value.replaceAll("$", "").replaceAll(",", "");
  const negative = unformatted.startsWith("-");
  const unsigned = negative ? unformatted.slice(1) : unformatted;
  const [integer, fraction] = unsigned.split(".") as [string, string];
  const significantFraction = fraction.replace(/0+$/u, "");
  const magnitude = significantFraction
    ? `${integer}.${significantFraction}`
    : integer;
  return decimalAmountSchema.parse(
    negative && magnitude !== "0" ? `-${magnitude}` : magnitude,
  );
}

function parseRegisterDate(value: string): CalendarDate {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/u.exec(value);
  if (!match) throw new Error(`Invalid YNAB register date: ${value}`);
  return calendarDateSchema.parse(`${match[3]}-${match[1]}-${match[2]}`);
}

/**
 * Decodes one CESU-8 surrogate half at `offset`, i.e. a 3-byte UTF-8
 * sequence encoding a lone UTF-16 surrogate (0xD800-0xDFFF). Real UTF-8
 * forbids encoding surrogates at all, so this pattern never appears in
 * valid input; it only exists in exports produced by Java-family tooling
 * that encodes each UTF-16 code unit independently (Java "Modified UTF-8",
 * `DataOutputStream.writeUTF`, MySQL's legacy 3-byte-max `utf8` charset)
 * instead of combining surrogate pairs into one 4-byte UTF-8 sequence.
 */
function decodeCesu8SurrogateHalf(
  bytes: Uint8Array,
  offset: number,
): number | null {
  const b0 = bytes[offset];
  const b1 = bytes[offset + 1];
  const b2 = bytes[offset + 2];
  if (b0 !== 0xed || b1 === undefined || b2 === undefined) return null;
  if ((b1 & 0xc0) !== 0x80 || (b2 & 0xc0) !== 0x80) return null;
  const unit = ((b0 & 0x0f) << 12) | ((b1 & 0x3f) << 6) | (b2 & 0x3f);
  return unit >= 0xd800 && unit <= 0xdfff ? unit : null;
}

function encodeCodePointAsUtf8(codePoint: number): readonly number[] {
  return [
    0xf0 | (codePoint >> 18),
    0x80 | ((codePoint >> 12) & 0x3f),
    0x80 | ((codePoint >> 6) & 0x3f),
    0x80 | (codePoint & 0x3f),
  ];
}

/**
 * Repairs YNAB exports that mis-encode astral characters (for example an
 * emoji in a renamed category) as CESU-8 surrogate pairs instead of proper
 * UTF-8. Every other byte, including any genuinely unpaired surrogate or
 * unrelated invalid sequence, passes through untouched so the caller's
 * strict re-decode still fails closed on data this cannot explain.
 */
function repairCesu8SurrogatePairs(csv: Uint8Array): Uint8Array {
  const repaired: number[] = [];
  let offset = 0;
  while (offset < csv.length) {
    const high = decodeCesu8SurrogateHalf(csv, offset);
    if (high !== null && high >= 0xd800 && high <= 0xdbff) {
      const low = decodeCesu8SurrogateHalf(csv, offset + 3);
      if (low !== null && low >= 0xdc00 && low <= 0xdfff) {
        const codePoint = 0x10000 + (high - 0xd800) * 0x400 + (low - 0xdc00);
        repaired.push(...encodeCodePointAsUtf8(codePoint));
        offset += 6;
        continue;
      }
    }
    repaired.push(csv[offset] as number);
    offset += 1;
  }
  return Uint8Array.from(repaired);
}

function decodeYnabCsv(csv: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(csv);
  } catch (error) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(
        repairCesu8SurrogatePairs(csv),
      );
    } catch {
      throw error;
    }
  }
}

function parseRows(
  csv: Uint8Array,
  expectedHeaders: readonly string[],
): Record<string, string>[] {
  const decoded = decodeYnabCsv(csv);
  let headersValidated = false;
  const rows: unknown = parse(decoded, {
    bom: true,
    columns(headers: string[]) {
      if (
        headers.length !== expectedHeaders.length ||
        headers.some((header, index) => header !== expectedHeaders[index])
      ) {
        throw new Error(
          `Unexpected YNAB CSV headers: ${JSON.stringify(headers)}`,
        );
      }
      headersValidated = true;
      return headers;
    },
    relax_column_count: false,
    skip_empty_lines: true,
  });
  if (!headersValidated) {
    throw new Error("Unexpected YNAB CSV headers: header row is missing");
  }
  return z.array(z.record(z.string(), z.string())).parse(rows);
}

function validateCategoryColumns(
  combined: string,
  group: string,
  category: string,
): void {
  if (combined === "" && group === "" && category === "") return;
  if (
    combined !== "" &&
    group !== "" &&
    category !== "" &&
    combined === `${group}: ${category}`
  ) {
    return;
  }
  throw new Error("YNAB category columns are inconsistent");
}

const rawPlanRowSchema = z.strictObject({
  Month: z.string().regex(monthPattern),
  "Category Group/Category": z.string().min(1),
  "Category Group": z.string().min(1),
  Category: z.string().min(1),
  Assigned: z.string(),
  Activity: z.string(),
  Available: z.string(),
});

const rawRegisterRowSchema = z.strictObject({
  Account: z.string().min(1),
  Flag: z.string(),
  Date: z.string(),
  Payee: z.string(),
  "Category Group/Category": z.string(),
  "Category Group": z.string(),
  Category: z.string(),
  Memo: z.string(),
  Outflow: z.string(),
  Inflow: z.string(),
  Cleared: z.enum(["Cleared", "Uncleared", "Reconciled"]),
});

export interface YnabPlanRow {
  month: string;
  categoryGroupAndCategory: string;
  categoryGroup: string;
  category: string;
  assigned: DecimalAmount;
  activity: DecimalAmount;
  available: DecimalAmount;
}

export interface YnabRegisterRow {
  account: string;
  flag: string;
  occurredOn: CalendarDate;
  payee: string;
  categoryGroupAndCategory: string;
  categoryGroup: string;
  category: string;
  memo: string;
  outflow: DecimalAmount;
  inflow: DecimalAmount;
  cleared: "Cleared" | "Uncleared" | "Reconciled";
}

export function parseYnabPlanCsv(csv: Uint8Array): YnabPlanRow[] {
  return parseRows(csv, planHeaders).map((input) => {
    const row = rawPlanRowSchema.parse(input);
    validateCategoryColumns(
      row["Category Group/Category"],
      row["Category Group"],
      row.Category,
    );
    return {
      month: row.Month,
      categoryGroupAndCategory: row["Category Group/Category"],
      categoryGroup: row["Category Group"],
      category: row.Category,
      assigned: parseCurrency(row.Assigned),
      activity: parseCurrency(row.Activity),
      available: parseCurrency(row.Available),
    };
  });
}

export function parseYnabRegisterCsv(csv: Uint8Array): YnabRegisterRow[] {
  return parseRows(csv, registerHeaders).map((input) => {
    const row = rawRegisterRowSchema.parse(input);
    const outflow = parseCurrency(row.Outflow);
    const inflow = parseCurrency(row.Inflow);
    if (outflow.startsWith("-") || inflow.startsWith("-")) {
      throw new Error("YNAB register inflow and outflow must be non-negative");
    }
    if (outflow !== "0" && inflow !== "0") {
      throw new Error(
        "YNAB register row cannot contain both inflow and outflow",
      );
    }
    validateCategoryColumns(
      row["Category Group/Category"],
      row["Category Group"],
      row.Category,
    );
    return {
      account: row.Account,
      flag: row.Flag,
      occurredOn: parseRegisterDate(row.Date),
      payee: row.Payee,
      categoryGroupAndCategory: row["Category Group/Category"],
      categoryGroup: row["Category Group"],
      category: row.Category,
      memo: row.Memo,
      outflow,
      inflow,
      cleared: row.Cleared,
    };
  });
}
