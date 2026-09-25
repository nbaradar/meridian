import { createHash } from "node:crypto";

import { z } from "zod";

import {
  accountTypeSchema,
  calendarDateSchema,
  decimalAmountSchema,
  sumAmounts,
  type CategoryKind,
  type DecimalAmount,
  type Sha256Digest,
} from "../../core/ledger";
import type { YnabPlanRow, YnabRegisterRow } from "./csv";

/**
 * Review evidence for one YNAB source account. It helps a person recognize
 * duplicate or abandoned YNAB accounts; it never decides a mapping.
 */
export const ynabAccountActivitySchema = z.strictObject({
  registerRowCount: z.number().int().nonnegative(),
  firstOccurredOn: calendarDateSchema.nullable(),
  lastOccurredOn: calendarDateSchema.nullable(),
  /** Exact sum of every register row, cleared or not, as of the export. */
  workingBalance: decimalAmountSchema,
  /** Rows in other source accounts that transfer to or pay this account. */
  transferReferences: z.array(
    z.strictObject({
      sourceName: z.string().min(1),
      rowCount: z.number().int().positive(),
    }),
  ),
  /** Other source accounts whose names end in the same account-number suffix. */
  sharedSuffixWith: z.array(z.string().min(1)),
});

export type YnabAccountActivity = z.infer<typeof ynabAccountActivitySchema>;

export const ynabAccountCandidateSchema = z.strictObject({
  sourceName: z.string().min(1),
  suggestedType: accountTypeSchema.nullable(),
  suggestionReason: z.string().min(1).nullable(),
  activity: ynabAccountActivitySchema,
});

export type YnabAccountCandidate = z.infer<typeof ynabAccountCandidateSchema>;

export interface YnabCategoryCandidate {
  sourceGroup: string;
  sourceCategory: string;
  kind: CategoryKind;
}

export type YnabPostingDestination =
  | { kind: "category"; group: string; category: string }
  | {
      kind: "system";
      category:
        | "Transfer Clearing"
        | "Opening Balance Equity"
        | "Balance Adjustment"
        | "Uncategorized Expense"
        | "Uncategorized Income";
    };

export type YnabTransactionKind =
  "standard" | "transfer" | "opening_balance" | "balance_adjustment";

export interface YnabTransactionCandidate {
  sourceRef: string;
  contentDigest: Sha256Digest;
  sourceAccount: string;
  occurredOn: YnabRegisterRow["occurredOn"];
  occurredAt: null;
  description: string;
  memo: string;
  amount: DecimalAmount;
  importKind: YnabTransactionKind;
  destination: YnabPostingDestination;
  cleared: YnabRegisterRow["cleared"];
}

export interface YnabIgnoredRecord extends YnabTransactionCandidate {
  ignoredReason: "zero_amount";
}

export interface YnabImportPlan {
  accounts: readonly YnabAccountCandidate[];
  categories: readonly YnabCategoryCandidate[];
  transactions: readonly YnabTransactionCandidate[];
  ignoredRecords: readonly YnabIgnoredRecord[];
}

function sha256(value: string): Sha256Digest {
  return createHash("sha256").update(value).digest("hex") as Sha256Digest;
}

function categoryKind(group: string): CategoryKind {
  if (group === "Inflow") return "income";
  if (group === "Credit Card Payments") return "transfer";
  return "expense";
}

function accountSuggestion(
  account: string,
  creditCardAccounts: ReadonlySet<string>,
): Pick<YnabAccountCandidate, "suggestedType" | "suggestionReason"> {
  const normalized = account.toLowerCase();
  if (creditCardAccounts.has(account)) {
    return {
      suggestedType: "credit_card",
      suggestionReason: "YNAB Credit Card Payments category",
    };
  }
  if (
    /\b(?:retirement|ira|401k|403b|457b)\b/u.test(normalized) ||
    normalized.includes("401(k)") ||
    normalized.includes("403(b)") ||
    normalized.includes("457(b)")
  ) {
    return { suggestedType: "retirement", suggestionReason: "account name" };
  }
  if (/\bchecking\b/u.test(normalized)) {
    return { suggestedType: "checking", suggestionReason: "account name" };
  }
  if (/\bsavings\b/u.test(normalized)) {
    return { suggestedType: "savings", suggestionReason: "account name" };
  }
  if (/\bbrokerage\b/u.test(normalized)) {
    return { suggestedType: "brokerage", suggestionReason: "account name" };
  }
  if (/\brsu\b/u.test(normalized)) {
    return {
      suggestedType: "brokerage",
      suggestionReason: "RSU account name; confirm vested assets only",
    };
  }
  if (/\bcrypto\b/u.test(normalized)) {
    return { suggestedType: "crypto", suggestionReason: "account name" };
  }
  if (/\bcash\b(?!\s*back)/u.test(normalized)) {
    return { suggestedType: "cash", suggestionReason: "account name" };
  }
  return { suggestedType: null, suggestionReason: null };
}

function accountNumberSuffix(account: string): string | null {
  return /[–—*-]\s*\**(\d{3,4})\s*$/u.exec(account)?.[1] ?? null;
}

function isTransferReference(row: YnabRegisterRow, account: string): boolean {
  return (
    row.account !== account &&
    (row.payee === `Transfer : ${account}` ||
      (row.categoryGroup === "Credit Card Payments" &&
        row.category === account))
  );
}

function accountActivity(
  account: string,
  accountNames: readonly string[],
  registerRows: readonly YnabRegisterRow[],
): YnabAccountActivity {
  const rows = registerRows.filter((row) => row.account === account);
  const dates = rows.map((row) => row.occurredOn).sort();
  const referenceCounts = new Map<string, number>();
  for (const row of registerRows) {
    if (!isTransferReference(row, account)) continue;
    referenceCounts.set(
      row.account,
      (referenceCounts.get(row.account) ?? 0) + 1,
    );
  }
  const suffix = accountNumberSuffix(account);
  return {
    registerRowCount: rows.length,
    firstOccurredOn: dates[0] ?? null,
    lastOccurredOn: dates.at(-1) ?? null,
    workingBalance: sumAmounts(rows.map(signedAmount)),
    transferReferences: [...referenceCounts]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([sourceName, rowCount]) => ({ sourceName, rowCount })),
    sharedSuffixWith:
      suffix === null
        ? []
        : accountNames.filter(
            (other) =>
              other !== account && accountNumberSuffix(other) === suffix,
          ),
  };
}

function transactionKind(row: YnabRegisterRow): YnabTransactionKind {
  if (row.payee === "Starting Balance") return "opening_balance";
  if (
    row.payee === "Manual Balance Adjustment" ||
    row.payee === "Reconciliation Balance Adjustment"
  ) {
    return "balance_adjustment";
  }
  if (
    row.payee.startsWith("Transfer : ") ||
    row.categoryGroup === "Credit Card Payments"
  ) {
    if (row.payee === "Transfer : ") {
      throw new Error("YNAB transfer payee must identify a target account");
    }
    return "transfer";
  }
  return "standard";
}

function destination(row: YnabRegisterRow): YnabPostingDestination {
  const kind = transactionKind(row);
  if (kind === "opening_balance") {
    return { kind: "system", category: "Opening Balance Equity" };
  }
  if (kind === "balance_adjustment") {
    return { kind: "system", category: "Balance Adjustment" };
  }
  if (kind === "transfer") {
    return { kind: "system", category: "Transfer Clearing" };
  }
  if (row.category === "") {
    return row.outflow === "0"
      ? { kind: "system", category: "Uncategorized Income" }
      : { kind: "system", category: "Uncategorized Expense" };
  }
  return {
    kind: "category",
    group: row.categoryGroup,
    category: row.category,
  };
}

function signedAmount(row: YnabRegisterRow): DecimalAmount {
  return decimalAmountSchema.parse(
    row.outflow === "0" ? row.inflow : `-${row.outflow}`,
  );
}

export function planYnabImport(
  planRows: readonly YnabPlanRow[],
  registerRows: readonly YnabRegisterRow[],
): YnabImportPlan {
  const creditCardAccounts = new Set(
    planRows
      .filter((row) => row.categoryGroup === "Credit Card Payments")
      .map((row) => row.category),
  );
  const accountNames = [
    ...new Set([
      ...registerRows.map((row) => row.account),
      ...creditCardAccounts,
    ]),
  ].sort();
  const categories = new Map<string, YnabCategoryCandidate>();
  for (const row of [...planRows, ...registerRows]) {
    if (row.category === "" || row.categoryGroup === "") continue;
    const key = JSON.stringify([row.categoryGroup, row.category]);
    categories.set(key, {
      sourceGroup: row.categoryGroup,
      sourceCategory: row.category,
      kind: categoryKind(row.categoryGroup),
    });
  }

  const identityOccurrences = new Map<string, number>();
  const transactions: YnabTransactionCandidate[] = [];
  const ignoredRecords: YnabIgnoredRecord[] = [];
  for (const row of registerRows) {
    const identity = JSON.stringify([
      row.account,
      row.occurredOn,
      row.outflow,
      row.inflow,
    ]);
    const occurrence = (identityOccurrences.get(identity) ?? 0) + 1;
    identityOccurrences.set(identity, occurrence);
    const amount = signedAmount(row);
    const content = JSON.stringify(row);
    const record = {
      sourceRef: `${sha256(identity)}:${occurrence}`,
      contentDigest: sha256(content),
      sourceAccount: row.account,
      occurredOn: row.occurredOn,
      occurredAt: null,
      description: row.payee || row.memo || "YNAB import",
      memo: row.memo,
      amount,
      importKind: transactionKind(row),
      destination: destination(row),
      cleared: row.cleared,
    };
    if (amount === "0") {
      ignoredRecords.push({ ...record, ignoredReason: "zero_amount" });
    } else {
      transactions.push(record);
    }
  }

  return {
    accounts: accountNames.map((sourceName) => ({
      sourceName,
      ...accountSuggestion(sourceName, creditCardAccounts),
      activity: accountActivity(sourceName, accountNames, registerRows),
    })),
    categories: [...categories.values()].sort((left, right) =>
      `${left.sourceGroup}\0${left.sourceCategory}`.localeCompare(
        `${right.sourceGroup}\0${right.sourceCategory}`,
      ),
    ),
    transactions,
    ignoredRecords,
  };
}
