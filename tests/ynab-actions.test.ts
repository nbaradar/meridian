import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";

import { beforeEach, describe, expect, test, vi } from "vitest";

import type {
  CurrentYnabAccountDecision,
  YnabAccountDecisionStore,
} from "../src/modules/ynab";

const storeMocks = vi.hoisted(() => ({
  close: vi.fn(async () => undefined),
  createAccount: vi.fn(async () => undefined),
  createCategory: vi.fn(async () => undefined),
  listAccounts: vi.fn(async () => []),
  listCategories: vi.fn(async () => []),
  decisions: [] as CurrentYnabAccountDecision[],
}));

vi.mock("@/infrastructure/database/client", () => ({
  createDatabase: () => ({ database: {}, close: storeMocks.close }),
}));

vi.mock("@/infrastructure/database/postgres-ledger-destinations", () => ({
  createPostgresLedgerDestinationStore: () => ({
    createAccount: storeMocks.createAccount,
    createCategory: storeMocks.createCategory,
    listAccounts: storeMocks.listAccounts,
    listCategories: storeMocks.listCategories,
  }),
}));

// An in-memory stand-in for the PostgreSQL decision store. Atomicity,
// concurrency, and SQL enforcement are covered by the integration suite.
vi.mock("@/infrastructure/database/postgres-ynab-account-decisions", () => ({
  createPostgresYnabAccountDecisionStore: (): YnabAccountDecisionStore => ({
    async findCurrentDecisions(digests) {
      const keys = new Set(
        digests.map((digest) => `${digest.digestKeyId}:${digest.labelDigest}`),
      );
      return storeMocks.decisions.filter((decision) =>
        keys.has(`${decision.digestKeyId}:${decision.labelDigest}`),
      );
    },
    async listTrackedDecisions() {
      return storeMocks.decisions.filter(
        (decision) => decision.decision === "tracked",
      );
    },
    async saveDecision(write) {
      const { decision } = write;
      storeMocks.decisions = storeMocks.decisions.filter(
        (existing) => existing.id !== decision.supersedesDecisionId,
      );
      storeMocks.decisions.push(
        decision.decision === "excluded"
          ? {
              ...decision,
              decision: "excluded",
              accountSourceId: null,
              account: null,
              recordedAt: "2026-09-25T00:00:00.000Z" as never,
            }
          : {
              ...decision,
              decision: "tracked",
              accountSourceId: decision.accountSourceId!,
              account:
                write.kind === "create_account"
                  ? {
                      id: write.account.id,
                      name: write.account.revision.name,
                      accountType: write.account.accountType,
                    }
                  : null,
              recordedAt: "2026-09-25T00:00:00.000Z" as never,
            },
      );
    },
  }),
}));

import {
  analyzeYnabExportAction,
  saveYnabAccountsAction,
  type YnabAnalysisActionState,
  type YnabSaveActionState,
} from "../src/app/ynab/actions";

const idleAnalysis: YnabAnalysisActionState = {
  status: "idle",
  message: "",
  analysis: null,
};
const idleSave: YnabSaveActionState = {
  status: "idle",
  message: "",
  results: {},
  review: null,
};

async function analyzeFixture() {
  const [planCsv, registerCsv] = await Promise.all([
    readFile(new URL("./fixtures/ynab/plan.csv", import.meta.url), "utf8"),
    readFile(new URL("./fixtures/ynab/register.csv", import.meta.url), "utf8"),
  ]);
  const formData = new FormData();
  formData.set("plan", new File([planCsv], "plan.csv", { type: "text/csv" }));
  formData.set(
    "register",
    new File([registerCsv], "register.csv", { type: "text/csv" }),
  );
  const analyzed = await analyzeYnabExportAction(idleAnalysis, formData);
  expect(analyzed.status).toBe("success");
  return analyzed.analysis!;
}

describe("YNAB web actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeMocks.decisions = [];
    vi.stubEnv("YNAB_LABEL_DIGEST_CURRENT_KEY_ID", "test-v1");
    vi.stubEnv(
      "YNAB_LABEL_DIGEST_KEYRING",
      JSON.stringify({ "test-v1": randomBytes(32).toString("base64") }),
    );
  });

  test("rejects analysis without both export files before database access", async () => {
    const result = await analyzeYnabExportAction(idleAnalysis, new FormData());

    expect(result).toEqual({
      status: "error",
      message: "Select the YNAB plan CSV.",
      analysis: null,
    });
  });

  test("rejects unknown review tokens before database access", async () => {
    const formData = new FormData();
    formData.set("intent", "all");

    await expect(
      saveYnabAccountsAction(
        "00000000-0000-4000-8000-000000000000",
        idleSave,
        formData,
      ),
    ).resolves.toEqual({
      status: "error",
      message: "This YNAB review expired. Analyze the export again.",
      results: {},
      review: null,
    });
    expect(storeMocks.listAccounts).not.toHaveBeenCalled();
  });

  test("rejects an export above the per-file byte limit", async () => {
    const formData = new FormData();
    formData.set(
      "plan",
      new File(["x".repeat(2 * 1024 * 1024 + 1)], "plan.csv"),
    );

    await expect(
      analyzeYnabExportAction(idleAnalysis, formData),
    ).resolves.toEqual({
      status: "error",
      message: "Each YNAB export must be 2 MB or smaller.",
      analysis: null,
    });
    expect(storeMocks.listAccounts).not.toHaveBeenCalled();
  });

  test("explains missing recognition keys instead of failing opaquely", async () => {
    vi.stubEnv("YNAB_LABEL_DIGEST_KEYRING", "");
    const [planCsv, registerCsv] = await Promise.all([
      readFile(new URL("./fixtures/ynab/plan.csv", import.meta.url), "utf8"),
      readFile(
        new URL("./fixtures/ynab/register.csv", import.meta.url),
        "utf8",
      ),
    ]);
    const formData = new FormData();
    formData.set("plan", new File([planCsv], "plan.csv"));
    formData.set("register", new File([registerCsv], "register.csv"));

    const result = await analyzeYnabExportAction(idleAnalysis, formData);
    expect(result.message).toContain(
      "YNAB account recognition is not configured",
    );
  });

  test("saves one row, then saves all remaining rows with per-row results", async () => {
    const analysis = await analyzeFixture();
    expect(analysis).toMatchObject({
      planRowCount: 3,
      registerRowCount: 9,
      categoryCount: 3,
      transactionCount: 9,
      ignoredRecordCount: 0,
    });
    expect(Object.values(analysis.saveStates)).toEqual([
      { status: "unsaved" },
      { status: "unsaved" },
      { status: "unsaved" },
    ]);
    const index = (name: string) =>
      analysis.accountCandidates.findIndex(
        (candidate) => candidate.sourceName === name,
      );

    const single = new FormData();
    single.set("intent", `row-${index("Wallet")}`);
    single.set(`action-${index("Wallet")}`, "create");
    single.set(`name-${index("Wallet")}`, "Wallet");
    single.set(`accountType-${index("Wallet")}`, "cash");
    // Another row's draft is present but must not be saved by a row save.
    single.set(`action-${index("Example Card")}`, "exclude");
    const saved = await saveYnabAccountsAction(
      analysis.reviewToken,
      idleSave,
      single,
    );
    expect(saved.results).toEqual({
      Wallet: { status: "saved", message: "Saved" },
    });
    expect(saved.review?.saveStates.Wallet).toMatchObject({
      status: "tracked",
      account: { name: "Wallet", accountType: "cash" },
    });
    expect(saved.review?.saveStates["Example Card"]).toEqual({
      status: "unsaved",
    });

    // Excluding the card fails closed while checking transfers to it, and
    // checking cannot be included while the card is excluded.
    const all = new FormData();
    all.set("intent", "all");
    all.set(`action-${index("Example Card")}`, "exclude");
    all.set(`action-${index("Example Checking")}`, "create");
    all.set(`name-${index("Example Checking")}`, "Checking");
    all.set(`accountType-${index("Example Checking")}`, "checking");
    const failed = await saveYnabAccountsAction(
      analysis.reviewToken,
      saved,
      all,
    );
    expect(failed.status).toBe("error");
    expect(failed.results["Example Card"]?.status).toBe("error");
    expect(failed.results["Example Checking"]?.status).toBe("error");
    expect(failed.results.Wallet).toBeUndefined();

    all.set(`action-${index("Example Card")}`, "create");
    all.set(`name-${index("Example Card")}`, "Card");
    all.set(`accountType-${index("Example Card")}`, "credit_card");
    const completed = await saveYnabAccountsAction(
      analysis.reviewToken,
      failed,
      all,
    );
    expect(completed).toMatchObject({
      status: "success",
      message: "2 accounts saved.",
    });
    expect(
      Object.values(completed.review!.saveStates).map((state) => state.status),
    ).toEqual(["tracked", "tracked", "tracked"]);

    const reanalyzed = await analyzeFixture();
    expect(
      Object.values(reanalyzed.saveStates).map((state) => state.status),
    ).toEqual(["tracked", "tracked", "tracked"]);
  });
});
