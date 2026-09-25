import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { beforeAll, describe, expect, test } from "vitest";

import {
  accountIdSchema,
  accountSourceIdSchema,
  BalanceObservationConflictError,
  calendarDateSchema,
  decimalAmountSchema,
  sha256DigestSchema,
  type RecordYnabBalanceCommand,
} from "../src/core/ledger";
import {
  parseYnabPlanCsv,
  parseYnabRegisterCsv,
  planYnabBalanceClaims,
  planYnabImport,
  saveYnabBalances,
  ynabAccountDecisionIdSchema,
  ynabBalanceClaimSchema,
  ynabExportDigest,
  type YnabAccountSaveState,
  type YnabRegisterRow,
} from "../src/modules/ynab";

let registerBytes: Buffer;
let registerRows: YnabRegisterRow[];
let accountNames: string[];

beforeAll(async () => {
  const [plan, register] = await Promise.all([
    readFile(new URL("./fixtures/ynab/plan.csv", import.meta.url)),
    readFile(new URL("./fixtures/ynab/register.csv", import.meta.url)),
  ]);
  registerBytes = register;
  registerRows = parseYnabRegisterCsv(register);
  accountNames = planYnabImport(
    parseYnabPlanCsv(plan),
    registerRows,
  ).accounts.map((account) => account.sourceName);
});

const date = (value: string) => calendarDateSchema.parse(value);
const amount = (value: string) => decimalAmountSchema.parse(value);

describe("YNAB balance claims", () => {
  test("match the working balance when no row is future-dated", () => {
    const plan = planYnabImport([], registerRows);
    const claims = planYnabBalanceClaims(
      accountNames,
      registerRows,
      date("2099-12-31"),
    );
    for (const account of plan.accounts) {
      const claim = claims.find(
        (item) => item.sourceName === account.sourceName,
      );
      expect(claim?.futureRowCount).toBe(0);
      if (account.activity.registerRowCount === 0) {
        expect(claim?.balance).toBeNull();
      } else {
        expect(claim?.balance).toEqual({
          amount: account.activity.workingBalance,
          observedOn: account.activity.lastOccurredOn,
        });
      }
    }
  });

  test("exclude and count rows after the latest allowed date", () => {
    const account = registerRows[0]!.account;
    const rows = registerRows.filter((row) => row.account === account);
    const counted = [...rows].sort((left, right) =>
      left.occurredOn.localeCompare(right.occurredOn),
    );
    const cutoff = counted[0]!.occurredOn;
    const future: YnabRegisterRow[] = [
      {
        ...rows[0]!,
        occurredOn: date("2026-12-01"),
        inflow: amount("1000"),
        outflow: amount("0"),
      },
      {
        ...rows[0]!,
        occurredOn: date("2026-12-02"),
        inflow: amount("5"),
        outflow: amount("0"),
      },
    ];
    const [claim] = planYnabBalanceClaims(
      [account],
      [...registerRows, ...future],
      cutoff,
    );
    const onOrBefore = rows.filter((row) => row.occurredOn <= cutoff);
    expect(claim!.futureRowCount).toBe(
      rows.length - onOrBefore.length + future.length,
    );
    expect(claim!.balance?.observedOn).toBe(cutoff);
  });

  test("sum only counted rows exactly", () => {
    const base = registerRows[0]!;
    const rows: YnabRegisterRow[] = [
      {
        ...base,
        account: "Synthetic",
        occurredOn: date("2026-09-01"),
        inflow: amount("0.1"),
        outflow: amount("0"),
      },
      {
        ...base,
        account: "Synthetic",
        occurredOn: date("2026-09-20"),
        inflow: amount("0.2"),
        outflow: amount("0"),
      },
      {
        ...base,
        account: "Synthetic",
        occurredOn: date("2026-09-10"),
        inflow: amount("0"),
        outflow: amount("1.05"),
      },
      {
        ...base,
        account: "Synthetic",
        occurredOn: date("2026-09-27"),
        inflow: amount("99"),
        outflow: amount("0"),
      },
    ];
    expect(
      planYnabBalanceClaims(["Synthetic"], rows, date("2026-09-26")),
    ).toEqual([
      {
        sourceName: "Synthetic",
        balance: { amount: "-0.75", observedOn: "2026-09-20" },
        futureRowCount: 1,
      },
    ]);
  });

  test("give no balance for an account with no counted rows", () => {
    const base = registerRows[0]!;
    const future = {
      ...base,
      account: "Future only",
      occurredOn: date("2027-01-01"),
    };
    expect(
      planYnabBalanceClaims(
        ["Future only", "Plan only"],
        [future],
        date("2026-09-26"),
      ),
    ).toEqual([
      { sourceName: "Future only", balance: null, futureRowCount: 1 },
      { sourceName: "Plan only", balance: null, futureRowCount: 0 },
    ]);
  });

  test("digest the register bytes stably", () => {
    const digest = ynabExportDigest(new Uint8Array(registerBytes));
    expect(digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(ynabExportDigest(new Uint8Array(Buffer.from(registerBytes)))).toBe(
      digest,
    );
    const changed = new Uint8Array(registerBytes);
    changed[changed.length - 1] ^= 1;
    expect(ynabExportDigest(changed)).not.toBe(digest);
  });
});

describe("saving YNAB balances", () => {
  const tracked = (linked: boolean): YnabAccountSaveState => ({
    status: "tracked",
    decisionId: ynabAccountDecisionIdSchema.parse(randomUUID()),
    accountSourceId: accountSourceIdSchema.parse(randomUUID()),
    account: linked
      ? {
          id: accountIdSchema.parse(randomUUID()),
          name: "Synthetic",
          accountType: "checking",
        }
      : null,
  });
  const balance = { amount: "12.5", observedOn: "2026-09-01" } as const;

  test("saves eligible accounts and skips the rest with their reason", async () => {
    const recorded: RecordYnabBalanceCommand[] = [];
    const saveStates = new Map<string, YnabAccountSaveState>([
      ["Tracked", tracked(true)],
      ["Replayed", tracked(true)],
      ["Unlinked", tracked(false)],
      [
        "Excluded",
        {
          status: "excluded",
          decisionId: ynabAccountDecisionIdSchema.parse(randomUUID()),
        },
      ],
      ["No rows", tracked(true)],
      ["Failing", tracked(true)],
    ]);
    const claims = [
      ...[
        "Tracked",
        "Replayed",
        "Unlinked",
        "Excluded",
        "Unsaved",
        "Failing",
      ].map((sourceName) => ({ sourceName, balance, futureRowCount: 2 })),
      { sourceName: "No rows", balance: null, futureRowCount: 0 },
    ].map((claim) => ynabBalanceClaimSchema.parse(claim));

    const results = await saveYnabBalances({
      claims,
      exportDigest: sha256DigestSchema.parse("c".repeat(64)),
      saveStates,
      newId: randomUUID,
      async recordYnabBalance(command) {
        recorded.push(command);
        const account = [...saveStates].find(
          ([, state]) =>
            state.status === "tracked" &&
            state.account?.id === command.accountId,
        )?.[0];
        if (account === "Failing") {
          throw new BalanceObservationConflictError(
            "The YNAB source is not currently linked to this account",
            { accountId: command.accountId, source: "ynab_export" },
          );
        }
        return account === "Replayed" ? "already_saved" : "recorded";
      },
    });

    expect(Object.fromEntries(results)).toEqual({
      Tracked: { status: "saved", ...balance, futureRowCount: 2 },
      Replayed: { status: "already_saved", futureRowCount: 2 },
      Unlinked: { status: "skipped", reason: "unlinked", futureRowCount: 2 },
      Excluded: { status: "skipped", reason: "excluded", futureRowCount: 2 },
      Unsaved: { status: "skipped", reason: "unsaved", futureRowCount: 2 },
      Failing: {
        status: "error",
        message: "The YNAB source is not currently linked to this account",
        futureRowCount: 2,
      },
      "No rows": { status: "skipped", reason: "no_rows", futureRowCount: 0 },
    });
    expect(recorded).toHaveLength(3);
    const trackedState = saveStates.get("Tracked");
    if (trackedState?.status !== "tracked") throw new Error("expected tracked");
    expect(recorded[0]).toMatchObject({
      accountId: trackedState.account!.id,
      accountSourceId: trackedState.accountSourceId,
      exportDigest: "c".repeat(64),
      ...balance,
    });
  });
});
