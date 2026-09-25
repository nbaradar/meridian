import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { beforeAll, describe, expect, test } from "vitest";

import {
  finalizeYnabChangeReview,
  finalizeYnabAccountMappings,
  parseYnabPlanCsv,
  parseYnabRegisterCsv,
  planYnabImport,
  reviewYnabRegisterChanges,
  YnabAccountMappingError,
  type YnabAccountCandidate,
  type YnabPlanRow,
  type YnabRegisterRow,
} from "../src/modules/ynab";
import { accountIdSchema, type CurrentAccount } from "../src/core/ledger";

function utf8Bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function suggestions(accounts: readonly YnabAccountCandidate[]) {
  return accounts.map(({ sourceName, suggestedType, suggestionReason }) => ({
    sourceName,
    suggestedType,
    suggestionReason,
  }));
}

let planRows: YnabPlanRow[];
let registerRows: YnabRegisterRow[];

beforeAll(async () => {
  const [plan, register] = await Promise.all([
    readFile(new URL("./fixtures/ynab/plan.csv", import.meta.url)),
    readFile(new URL("./fixtures/ynab/register.csv", import.meta.url)),
  ]);
  planRows = parseYnabPlanCsv(plan);
  registerRows = parseYnabRegisterCsv(register);
});

describe("YNAB CSV parsing", () => {
  test("parses exact plan headers and decimal amounts", () => {
    expect(planRows).toHaveLength(3);
    expect(planRows[0]).toMatchObject({
      month: "Jul 2026",
      categoryGroup: "Credit Card Payments",
      category: "Example Card",
      assigned: "0",
      activity: "-125",
      available: "-125",
    });
  });

  test("parses register dates, currency, and clearing state without floats", () => {
    expect(registerRows[0]).toMatchObject({
      account: "Example Checking",
      occurredOn: "2026-07-28",
      outflow: "125",
      inflow: "0",
      cleared: "Cleared",
    });
    expect(registerRows[6]?.outflow).toBe("1234.56");
  });

  test("rejects unexpected headers", () => {
    const csv = new TextEncoder().encode('"Wrong","Headers"\n"a","b"\n');
    expect(() => parseYnabPlanCsv(csv)).toThrow("Unexpected YNAB CSV headers");
  });

  test("rejects missing headers and invalid UTF-8", () => {
    expect(() => parseYnabPlanCsv(new Uint8Array())).toThrow(
      "header row is missing",
    );
    expect(() => parseYnabPlanCsv(Uint8Array.of(0xff))).toThrow();
  });

  test("repairs CESU-8 surrogate pairs from broken YNAB exports", () => {
    // YNAB sometimes exports astral characters (e.g. an emoji in a renamed
    // category) as two independently UTF-8-encoded UTF-16 surrogate halves
    // instead of one 4-byte UTF-8 sequence for the combined code point.
    // These are the real bytes YNAB produced for a takeout-box emoji
    // (U+1F961) inside a category name.
    const takeoutEmojiCesu8 = Uint8Array.of(
      0xed,
      0xa0,
      0xbe, // high surrogate D83E, encoded as a lone 3-byte sequence
      0xed,
      0xb5,
      0xa1, // low surrogate DD61, encoded as a lone 3-byte sequence
    );
    const header = utf8Bytes(
      '"Account","Flag","Date","Payee","Category Group/Category","Category Group","Category","Memo","Outflow","Inflow","Cleared"\n',
    );
    const row = concatBytes(
      utf8Bytes('"Account","","08/02/2026","Uber Eats","Wants: '),
      takeoutEmojiCesu8,
      utf8Bytes(' Delivery","Wants","'),
      takeoutEmojiCesu8,
      utf8Bytes(' Delivery","",$0.00,$5.05,"Reconciled"\n'),
    );
    const rows = parseYnabRegisterCsv(concatBytes(header, row));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.category).toBe("🥡 Delivery");
  });

  test("still rejects an unpaired surrogate that is not a repairable CESU-8 pair", () => {
    const header = utf8Bytes(
      '"Account","Flag","Date","Payee","Category Group/Category","Category Group","Category","Memo","Outflow","Inflow","Cleared"\n',
    );
    const row = concatBytes(
      utf8Bytes('"Account","","08/02/2026","Pay'),
      Uint8Array.of(0xed, 0xa0, 0xbe), // lone high surrogate, no matching low
      utf8Bytes('ee","","","","",$0.00,$1.00,"Cleared"\n'),
    );
    expect(() => parseYnabRegisterCsv(concatBytes(header, row))).toThrow();
  });

  test("accepts the UTF-8 byte-order mark emitted by YNAB", () => {
    const csv = new TextEncoder().encode(
      '\uFEFF"Month","Category Group/Category","Category Group","Category","Assigned","Activity","Available"\n"Jul 2026","Needs: Groceries","Needs","Groceries",$0.00,-$1.00,-$1.00\n',
    );
    expect(parseYnabPlanCsv(csv)).toHaveLength(1);
  });

  test("rejects invalid dates and simultaneous inflow/outflow", () => {
    const header =
      '"Account","Flag","Date","Payee","Category Group/Category","Category Group","Category","Memo","Outflow","Inflow","Cleared"\n';
    expect(() =>
      parseYnabRegisterCsv(
        new TextEncoder().encode(
          `${header}"Account","","13/40/2026","Payee","","","","",$1.00,$0.00,"Cleared"\n`,
        ),
      ),
    ).toThrow();
    expect(() =>
      parseYnabRegisterCsv(
        new TextEncoder().encode(
          `${header}"Account","","08/02/2026","Payee","","","","",$1.00,$1.00,"Cleared"\n`,
        ),
      ),
    ).toThrow("cannot contain both inflow and outflow");
  });

  test("rejects inconsistent category columns", () => {
    const header =
      '"Account","Flag","Date","Payee","Category Group/Category","Category Group","Category","Memo","Outflow","Inflow","Cleared"\n';
    expect(() =>
      parseYnabRegisterCsv(
        new TextEncoder().encode(
          `${header}"Account","","08/02/2026","Payee","Needs: Rent","Needs","Groceries","",$1.00,$0.00,"Cleared"\n`,
        ),
      ),
    ).toThrow("category columns are inconsistent");
  });
});

describe("YNAB import planning", () => {
  test("suggests account types but leaves unknown accounts unclassified", () => {
    const plan = planYnabImport(planRows, registerRows);
    expect(suggestions(plan.accounts)).toContainEqual({
      sourceName: "Example Card",
      suggestedType: "credit_card",
      suggestionReason: "YNAB Credit Card Payments category",
    });
    expect(suggestions(plan.accounts)).toContainEqual({
      sourceName: "Example Checking",
      suggestedType: "checking",
      suggestionReason: "account name",
    });
    expect(suggestions(plan.accounts)).toContainEqual({
      sourceName: "Wallet",
      suggestedType: null,
      suggestionReason: null,
    });

    const namedAccounts = suggestions(
      planYnabImport(
        [],
        [
          { ...registerRows[0]!, account: "Cash/Paper Bills" },
          { ...registerRows[0]!, account: "Example Brokerage" },
          { ...registerRows[0]!, account: "Employer Retirement Plan" },
          { ...registerRows[0]!, account: "Employer Savings Retirement Plan" },
          { ...registerRows[0]!, account: "Roth IRA" },
          { ...registerRows[0]!, account: "SIMPLE IRA" },
          { ...registerRows[0]!, account: "Employer 401(k)" },
          { ...registerRows[0]!, account: "Work RSU" },
          { ...registerRows[0]!, account: "Cold Crypto Wallet" },
        ],
      ).accounts,
    );
    expect(namedAccounts).toEqual([
      {
        sourceName: "Cash/Paper Bills",
        suggestedType: "cash",
        suggestionReason: "account name",
      },
      {
        sourceName: "Cold Crypto Wallet",
        suggestedType: "crypto",
        suggestionReason: "account name",
      },
      {
        sourceName: "Employer 401(k)",
        suggestedType: "retirement",
        suggestionReason: "account name",
      },
      {
        sourceName: "Employer Retirement Plan",
        suggestedType: "retirement",
        suggestionReason: "account name",
      },
      {
        sourceName: "Employer Savings Retirement Plan",
        suggestedType: "retirement",
        suggestionReason: "account name",
      },
      {
        sourceName: "Example Brokerage",
        suggestedType: "brokerage",
        suggestionReason: "account name",
      },
      {
        sourceName: "Roth IRA",
        suggestedType: "retirement",
        suggestionReason: "account name",
      },
      {
        sourceName: "SIMPLE IRA",
        suggestedType: "retirement",
        suggestionReason: "account name",
      },
      {
        sourceName: "Work RSU",
        suggestedType: "brokerage",
        suggestionReason: "RSU account name; confirm vested assets only",
      },
    ]);

    const planOnlyCard = planYnabImport(
      [
        {
          ...planRows[0]!,
          categoryGroupAndCategory: "Credit Card Payments: Dormant Card",
          category: "Dormant Card",
        },
      ],
      [],
    );
    expect(suggestions(planOnlyCard.accounts)).toContainEqual({
      sourceName: "Dormant Card",
      suggestedType: "credit_card",
      suggestionReason: "YNAB Credit Card Payments category",
    });
  });

  test("classifies category groups without importing envelope values", () => {
    const plan = planYnabImport(planRows, registerRows);
    expect(plan.categories).toContainEqual({
      sourceGroup: "Credit Card Payments",
      sourceCategory: "Example Card",
      kind: "transfer",
    });
    expect(plan.categories).toContainEqual({
      sourceGroup: "Inflow",
      sourceCategory: "Ready to Assign",
      kind: "income",
    });
    expect(plan.categories).toContainEqual({
      sourceGroup: "Needs",
      sourceCategory: "Groceries",
      kind: "expense",
    });
  });

  test("uses transfer clearing only for explicit YNAB transfers", () => {
    const plan = planYnabImport(planRows, registerRows);
    expect(plan.transactions[0]?.destination).toEqual({
      kind: "system",
      category: "Transfer Clearing",
    });
    expect(plan.transactions[6]?.destination).toEqual({
      kind: "category",
      group: "Needs",
      category: "Groceries",
    });
  });

  test("separates uncategorized expense and income destinations", () => {
    const plan = planYnabImport(planRows, registerRows);
    expect(plan.transactions[4]?.destination).toEqual({
      kind: "system",
      category: "Uncategorized Expense",
    });
    expect(plan.transactions[5]?.destination).toEqual({
      kind: "system",
      category: "Uncategorized Income",
    });
  });

  test("creates stable distinct source references for identical real rows", () => {
    const first = planYnabImport(planRows, registerRows);
    const replay = planYnabImport(planRows, registerRows);
    const firstDuplicate = first.transactions[7];
    const secondDuplicate = first.transactions[8];

    expect(firstDuplicate?.sourceRef).not.toBe(secondDuplicate?.sourceRef);
    expect(firstDuplicate?.contentDigest).toBe(secondDuplicate?.contentDigest);
    expect(replay.transactions[7]?.sourceRef).toBe(firstDuplicate?.sourceRef);
    expect(replay.transactions[8]?.sourceRef).toBe(secondDuplicate?.sourceRef);
  });

  test("preserves date precision and signed account amounts", () => {
    const plan = planYnabImport(planRows, registerRows);
    expect(plan.transactions[2]).toMatchObject({
      occurredOn: "2026-07-29",
      occurredAt: null,
      amount: "0.25",
    });
    expect(plan.transactions[3]?.amount).toBe("-42.1");
  });

  test("preserves amounts beyond Decimal.js default precision", () => {
    const header =
      '"Account","Flag","Date","Payee","Category Group/Category","Category Group","Category","Memo","Outflow","Inflow","Cleared"\n';
    const rows = parseYnabRegisterCsv(
      new TextEncoder().encode(
        `${header}"Account","","08/02/2026","Payee","Needs: Groceries","Needs","Groceries","","$123,456,789,012,345,678,901.23",$0.00,"Cleared"\n`,
      ),
    );

    expect(planYnabImport([], rows).transactions[0]?.amount).toBe(
      "-123456789012345678901.23",
    );
  });

  test("separates opening balances and balance adjustments from income", () => {
    const source = registerRows[2]!;
    const plan = planYnabImport(
      [],
      [
        { ...source, payee: "Starting Balance" },
        { ...source, payee: "Manual Balance Adjustment" },
        { ...source, payee: "Reconciliation Balance Adjustment" },
        {
          ...source,
          payee: "Starting Balance",
          outflow: registerRows[1]!.outflow,
          inflow: registerRows[0]!.inflow,
        },
      ],
    );

    expect(plan.transactions[0]).toMatchObject({
      importKind: "opening_balance",
      destination: { kind: "system", category: "Opening Balance Equity" },
    });
    expect(plan.transactions[1]).toMatchObject({
      importKind: "balance_adjustment",
      destination: { kind: "system", category: "Balance Adjustment" },
    });
    expect(plan.transactions[2]?.importKind).toBe("balance_adjustment");
    expect(plan.ignoredRecords[0]).toMatchObject({
      importKind: "opening_balance",
      ignoredReason: "zero_amount",
    });
  });

  test("summarizes per-account activity as review evidence", () => {
    const accounts = new Map(
      planYnabImport(planRows, registerRows).accounts.map((account) => [
        account.sourceName,
        account.activity,
      ]),
    );

    expect(accounts.get("Example Checking")).toEqual({
      registerRowCount: 5,
      firstOccurredOn: "2026-07-28",
      lastOccurredOn: "2026-08-01",
      workingBalance: "-1349.31",
      transferReferences: [{ sourceName: "Example Card", rowCount: 1 }],
      sharedSuffixWith: [],
    });
    expect(accounts.get("Example Card")).toMatchObject({
      workingBalance: "82.9",
      transferReferences: [{ sourceName: "Example Checking", rowCount: 1 }],
    });
    expect(accounts.get("Wallet")).toMatchObject({
      registerRowCount: 2,
      workingBalance: "-10",
      transferReferences: [],
    });

    const offsetting = planYnabImport(
      [],
      [
        { ...registerRows[0]!, account: "Checking – 1234" },
        {
          ...registerRows[0]!,
          account: "Checking – 1234",
          outflow: registerRows[1]!.outflow,
          inflow: registerRows[1]!.inflow,
        },
        { ...registerRows[0]!, account: "Bank Checking – 1234" },
        { ...registerRows[0]!, account: "Card – 9999" },
        { ...registerRows[0]!, account: "Roth IRA 2024" },
      ],
    ).accounts;
    expect(
      offsetting.map(({ sourceName, activity }) => ({
        sourceName,
        workingBalance: activity.workingBalance,
        sharedSuffixWith: activity.sharedSuffixWith,
      })),
    ).toEqual([
      {
        sourceName: "Bank Checking – 1234",
        workingBalance: "-125",
        sharedSuffixWith: ["Checking – 1234"],
      },
      {
        sourceName: "Card – 9999",
        workingBalance: "-125",
        sharedSuffixWith: [],
      },
      {
        sourceName: "Checking – 1234",
        workingBalance: "0",
        sharedSuffixWith: ["Bank Checking – 1234"],
      },
      {
        sourceName: "Roth IRA 2024",
        workingBalance: "-125",
        sharedSuffixWith: [],
      },
    ]);
  });
});

describe("YNAB change review", () => {
  test("matches exact rows independently of export order", () => {
    const review = reviewYnabRegisterChanges(registerRows, [
      ...registerRows.slice().reverse(),
    ]);

    expect(review.exactMatches).toHaveLength(registerRows.length);
    expect(review.suggestedRevisions).toHaveLength(0);
    expect(review.possibleMatches).toHaveLength(0);
    expect(review.suggestedAdditions).toHaveLength(0);
    expect(review.suggestedRemovals).toHaveLength(0);
  });

  test("suggests one-to-one metadata and amount corrections for review", () => {
    const metadataCorrection = {
      ...registerRows[3]!,
      memo: "corrected memo",
      cleared: "Cleared" as const,
    };
    const amountCorrection = {
      ...registerRows[6]!,
      outflow: registerRows[0]!.outflow,
    };
    const review = reviewYnabRegisterChanges(
      [registerRows[3]!, registerRows[6]!],
      [metadataCorrection, amountCorrection],
    );

    expect(review.suggestedRevisions).toEqual([
      {
        previousIndex: 0,
        currentIndex: 0,
        changedFields: ["memo", "cleared"],
        suggestedAction: "correct_and_replace",
      },
      {
        previousIndex: 1,
        currentIndex: 1,
        changedFields: ["amount"],
        suggestedAction: "correct_and_replace",
      },
    ]);
  });

  test("leaves duplicate candidate matches ambiguous for manual override", () => {
    const previous = [registerRows[7]!, registerRows[8]!];
    const current = previous.map((row) => ({ ...row, memo: "changed" }));
    const review = reviewYnabRegisterChanges(previous, current);

    expect(review.suggestedRevisions).toHaveLength(0);
    expect(review.possibleMatches).toHaveLength(4);
    expect(review.suggestedAdditions).toHaveLength(0);
    expect(review.suggestedRemovals).toHaveLength(0);

    expect(
      finalizeYnabChangeReview(review, [
        {
          action: "correct_and_replace",
          previousIndex: 0,
          currentIndex: 1,
        },
        {
          action: "correct_and_replace",
          previousIndex: 1,
          currentIndex: 0,
        },
      ]),
    ).toHaveLength(2);
  });

  test("suggests unmatched rows as additions and removals", () => {
    const review = reviewYnabRegisterChanges(
      [registerRows[0]!],
      [registerRows[6]!],
    );

    expect(review.suggestedRevisions).toHaveLength(0);
    expect(review.possibleMatches).toHaveLength(0);
    expect(review.suggestedAdditions).toEqual([0]);
    expect(review.suggestedRemovals).toEqual([0]);
    expect(() => finalizeYnabChangeReview(review, [])).toThrow(
      "requires an explicit decision",
    );
    expect(
      finalizeYnabChangeReview(review, [
        { action: "remove", previousIndex: 0 },
        { action: "add", currentIndex: 0 },
      ]),
    ).toHaveLength(2);
  });
});

describe("YNAB account mapping", () => {
  const existingAccount: CurrentAccount = {
    id: accountIdSchema.parse(randomUUID()),
    name: "Existing checking",
    accountType: "checking",
    accountClass: "asset",
    currency: "USD",
    openedOn: null,
    status: "active",
  };

  test("requires explicit link or create decisions and permits type overrides", () => {
    const candidates = planYnabImport(planRows, registerRows).accounts.slice(
      0,
      2,
    );
    const mappings = finalizeYnabAccountMappings(
      candidates,
      [existingAccount],
      [
        {
          sourceName: candidates[0]!.sourceName,
          action: "link",
          accountId: existingAccount.id,
        },
        {
          sourceName: candidates[1]!.sourceName,
          action: "create",
          name: "Confirmed account",
          accountType: "other",
          accountClass: "liability",
          openedOn: "2020-01-15",
        },
      ],
    );

    expect(mappings).toEqual([
      {
        sourceName: candidates[0]!.sourceName,
        action: "link",
        accountId: existingAccount.id,
      },
      {
        sourceName: candidates[1]!.sourceName,
        action: "create",
        name: "Confirmed account",
        accountType: "other",
        accountClass: "liability",
        openedOn: "2020-01-15",
      },
    ]);

    expect(
      finalizeYnabAccountMappings(
        [candidates[0]!],
        [],
        [
          {
            sourceName: candidates[0]!.sourceName,
            action: "create",
            name: "New checking",
            accountType: "checking",
            accountClass: null,
            openedOn: null,
          },
        ],
      ),
    ).toEqual([
      {
        sourceName: candidates[0]!.sourceName,
        action: "create",
        name: "New checking",
        accountType: "checking",
        accountClass: null,
        openedOn: null,
      },
    ]);
  });

  test("rejects missing, duplicate, unknown, and nonexistent link decisions", () => {
    const candidate = planYnabImport(planRows, registerRows).accounts[0]!;
    expect(() => finalizeYnabAccountMappings([candidate], [], [])).toThrow(
      `requires an explicit mapping: ${candidate.sourceName}`,
    );
    expect(() =>
      finalizeYnabAccountMappings(
        [candidate],
        [],
        [
          {
            sourceName: candidate.sourceName,
            action: "link",
            accountId: existingAccount.id,
          },
          {
            sourceName: candidate.sourceName,
            action: "link",
            accountId: existingAccount.id,
          },
        ],
      ),
    ).toThrow("is mapped more than once");
    expect(() =>
      finalizeYnabAccountMappings(
        [candidate],
        [],
        [
          {
            sourceName: "Unknown source",
            action: "link",
            accountId: existingAccount.id,
          },
        ],
      ),
    ).toThrow("references an unknown YNAB account");
    expect(() =>
      finalizeYnabAccountMappings(
        [candidate],
        [],
        [
          {
            sourceName: candidate.sourceName,
            action: "link",
            accountId: existingAccount.id,
          },
        ],
      ),
    ).toThrow("Linked Meridian account does not exist");
  });

  test("excludes source accounts only when no included transfer references them", () => {
    const candidates = planYnabImport(planRows, registerRows).accounts;
    const create = (sourceName: string) => ({
      sourceName,
      action: "create" as const,
      name: sourceName,
      accountType: "other" as const,
      accountClass: "asset" as const,
      openedOn: null,
    });
    const exclude = (sourceName: string) => ({
      sourceName,
      action: "exclude" as const,
    });

    expect(
      finalizeYnabAccountMappings(
        candidates,
        [],
        [create("Example Card"), create("Example Checking"), exclude("Wallet")],
      ).at(-1),
    ).toEqual({ sourceName: "Wallet", action: "exclude" });

    let rejection: unknown;
    try {
      finalizeYnabAccountMappings(
        candidates,
        [],
        [exclude("Example Card"), create("Example Checking"), create("Wallet")],
      );
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBeInstanceOf(YnabAccountMappingError);
    expect((rejection as YnabAccountMappingError).message).toBe(
      "Cannot exclude YNAB account Example Card: 1 transfer row in included accounts (Example Checking) reference it. Link it to the account it duplicates instead, or exclude those accounts too.",
    );
    expect((rejection as YnabAccountMappingError).sourceName).toBe(
      "Example Card",
    );

    expect(
      finalizeYnabAccountMappings(
        candidates,
        [],
        [
          exclude("Example Card"),
          exclude("Example Checking"),
          create("Wallet"),
        ],
      ).map((mapping) => mapping.action),
    ).toEqual(["exclude", "exclude", "create"]);
  });

  test("validates accounting class rules before resolving creations", () => {
    const candidate = planYnabImport(planRows, registerRows).accounts[0]!;
    expect(() =>
      finalizeYnabAccountMappings(
        [candidate],
        [],
        [
          {
            sourceName: candidate.sourceName,
            action: "create",
            name: "Unclassified",
            accountType: "other",
            accountClass: null,
            openedOn: null,
          },
        ],
      ),
    ).toThrow("Other accounts require an accounting class");
    expect(() =>
      finalizeYnabAccountMappings(
        [candidate],
        [],
        [
          {
            sourceName: candidate.sourceName,
            action: "create",
            name: "Checking",
            accountType: "checking",
            accountClass: "liability",
            openedOn: null,
          },
        ],
      ),
    ).toThrow("Accounting class is derived from account type");
  });
});
