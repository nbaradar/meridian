"use server";

import { randomUUID } from "node:crypto";

import { z } from "zod";

import {
  AccountSourceConflictError,
  AccountSourceReferenceError,
  createLedgerDestinationService,
  utcTimestampSchema,
  type CurrentAccount,
} from "@/core/ledger";
import { createDatabase } from "@/infrastructure/database/client";
import { createPostgresLedgerDestinationStore } from "@/infrastructure/database/postgres-ledger-destinations";
import { createPostgresYnabAccountDecisionStore } from "@/infrastructure/database/postgres-ynab-account-decisions";
import { createYnabLabelDigester } from "@/infrastructure/ynab/label-digest";
import {
  createYnabAccountDecisionService,
  parseYnabPlanCsv,
  parseYnabRegisterCsv,
  planYnabImport,
  resolveYnabAccountDecision,
  YnabAccountAlreadyDecidedError,
  ynabAccountCandidateSchema,
  YnabAccountMappingError,
  type TrackedAccountSummary,
  type YnabAccountCandidate,
  type YnabAccountDecisionService,
  type YnabAccountSaveState,
} from "@/modules/ynab";

import { YnabReviewSnapshotStore } from "./review-snapshots";

const maximumExportBytes = 2 * 1024 * 1024;
const reviewLifetimeMilliseconds = 30 * 60 * 1000;
const reviewTokenSchema = z.uuid();
const reviewSnapshots = new YnabReviewSnapshotStore(
  reviewLifetimeMilliseconds,
  10,
);

export interface YnabRenameTarget {
  accountSourceId: string;
  account: TrackedAccountSummary;
}

/** Saved-state view of the review, refreshed after every save. */
export interface YnabReviewStatus {
  saveStates: Readonly<Record<string, YnabAccountSaveState>>;
  currentAccounts: readonly CurrentAccount[];
  /** Saved YNAB accounts not matched by any name in this export. */
  renameTargets: readonly YnabRenameTarget[];
}

export interface YnabExportAnalysis extends YnabReviewStatus {
  reviewToken: string;
  accountCandidates: readonly YnabAccountCandidate[];
  planRowCount: number;
  registerRowCount: number;
  categoryCount: number;
  transactionCount: number;
  ignoredRecordCount: number;
}

export interface YnabAnalysisActionState {
  status: "idle" | "success" | "error";
  message: string;
  analysis: YnabExportAnalysis | null;
}

export type YnabRowSaveResult =
  { status: "saved"; message: string } | { status: "error"; message: string };

export interface YnabSaveActionState {
  status: "idle" | "success" | "error";
  message: string;
  /** Outcome per YNAB account name for the rows this save attempted. */
  results: Readonly<Record<string, YnabRowSaveResult>>;
  /** Refreshed saved state; null when the save could not run at all. */
  review: YnabReviewStatus | null;
}

function reviewSnapshot(tokenInput: unknown): readonly YnabAccountCandidate[] {
  const token = reviewTokenSchema.parse(tokenInput);
  const candidates = reviewSnapshots.get(token);
  if (!candidates) {
    throw new YnabAccountMappingError(
      "This YNAB review expired. Analyze the export again.",
    );
  }
  return z.array(ynabAccountCandidateSchema).parse(candidates);
}

function exportFile(formData: FormData, name: string): File {
  const value = formData.get(name);
  if (!(value instanceof File) || value.size === 0) {
    throw new Error(
      `Select the YNAB ${name === "plan" ? "plan" : "register"} CSV.`,
    );
  }
  if (value.size > maximumExportBytes) {
    throw new Error("Each YNAB export must be 2 MB or smaller.");
  }
  return value;
}

function now() {
  return utcTimestampSchema.parse(new Date().toISOString());
}

async function withServices<T>(
  run: (services: {
    decisions: YnabAccountDecisionService;
    listAccounts: () => Promise<readonly CurrentAccount[]>;
  }) => Promise<T>,
): Promise<T> {
  const digester = createYnabLabelDigester();
  const connection = createDatabase();
  try {
    const destinations = createLedgerDestinationService(
      createPostgresLedgerDestinationStore(connection.database),
      now,
    );
    const decisions = createYnabAccountDecisionService(
      createPostgresYnabAccountDecisionStore(connection.database),
      digester,
      now,
      randomUUID,
    );
    return await run({
      decisions,
      listAccounts: () => destinations.listAccounts(),
    });
  } finally {
    await connection.close();
  }
}

async function reviewStatus(
  candidates: readonly YnabAccountCandidate[],
  services: {
    decisions: YnabAccountDecisionService;
    listAccounts: () => Promise<readonly CurrentAccount[]>;
  },
): Promise<YnabReviewStatus> {
  const [states, currentAccounts, trackedSources] = await Promise.all([
    services.decisions.lookup(
      candidates.map((candidate) => candidate.sourceName),
    ),
    services.listAccounts(),
    services.decisions.listTrackedSources(),
  ]);
  const matchedSources = new Set(
    [...states.values()].flatMap((state) =>
      state.status === "tracked" ? [state.accountSourceId] : [],
    ),
  );
  return {
    saveStates: Object.fromEntries(states),
    currentAccounts,
    renameTargets: trackedSources.filter(
      (source) => !matchedSources.has(source.accountSourceId),
    ),
  };
}

function configurationMessage(error: unknown): string | null {
  if (
    error instanceof z.ZodError &&
    error.issues.some((issue) =>
      String(issue.path[0] ?? "").startsWith("YNAB_LABEL_DIGEST"),
    )
  ) {
    return "YNAB account recognition is not configured. Set YNAB_LABEL_DIGEST_CURRENT_KEY_ID and YNAB_LABEL_DIGEST_KEYRING (see .env.example).";
  }
  return null;
}

export async function analyzeYnabExportAction(
  _previousState: YnabAnalysisActionState,
  formData: FormData,
): Promise<YnabAnalysisActionState> {
  try {
    const planFile = exportFile(formData, "plan");
    const registerFile = exportFile(formData, "register");
    const [planBytes, registerBytes] = await Promise.all([
      planFile.arrayBuffer(),
      registerFile.arrayBuffer(),
    ]);
    const planRows = parseYnabPlanCsv(new Uint8Array(planBytes));
    const registerRows = parseYnabRegisterCsv(new Uint8Array(registerBytes));
    const plan = planYnabImport(planRows, registerRows);
    const status = await withServices((services) =>
      reviewStatus(plan.accounts, services),
    );
    const reviewToken = reviewSnapshots.create(plan.accounts);
    const savedCount = Object.values(status.saveStates).filter(
      (state) => state.status !== "unsaved",
    ).length;
    return {
      status: "success",
      message:
        savedCount > 0
          ? `Export validated. ${savedCount} of ${plan.accounts.length} accounts were already saved.`
          : "Export validated. Review and save each account below.",
      analysis: {
        reviewToken,
        accountCandidates: plan.accounts,
        ...status,
        planRowCount: planRows.length,
        registerRowCount: registerRows.length,
        categoryCount: plan.categories.length,
        transactionCount: plan.transactions.length,
        ignoredRecordCount: plan.ignoredRecords.length,
      },
    };
  } catch (error) {
    return {
      status: "error",
      message:
        configurationMessage(error) ??
        (error instanceof Error
          ? error.message
          : "The YNAB export could not be validated."),
      analysis: null,
    };
  }
}

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

/** Builds the decision input for one row; returns null when undecided. */
function decisionInput(
  formData: FormData,
  candidate: YnabAccountCandidate,
  index: number,
): Record<string, unknown> | null {
  const action = field(formData, `action-${index}`);
  const sourceName = candidate.sourceName;
  switch (action) {
    case "":
      return null;
    case "exclude":
      return { sourceName, action };
    case "link":
      return {
        sourceName,
        action,
        accountId: field(formData, `accountId-${index}`),
      };
    case "renamed":
      return {
        sourceName,
        action,
        accountSourceId: field(formData, `accountSourceId-${index}`),
      };
    case "create": {
      const accountType = field(formData, `accountType-${index}`);
      return {
        sourceName,
        action,
        name: field(formData, `name-${index}`),
        accountType,
        accountClass:
          accountType === "other"
            ? field(formData, `accountClass-${index}`) || null
            : null,
        openedOn: null,
      };
    }
    default:
      throw new YnabAccountMappingError(
        `Unknown decision for YNAB account: ${sourceName}`,
        sourceName,
      );
  }
}

function rowErrorMessage(error: unknown): string {
  if (error instanceof z.ZodError) {
    const issue = error.issues[0];
    const fieldName = issue?.path.at(-1);
    return `${typeof fieldName === "string" ? `${fieldName}: ` : ""}${issue?.message ?? "Check this decision."}`;
  }
  if (
    error instanceof YnabAccountMappingError ||
    error instanceof YnabAccountAlreadyDecidedError ||
    error instanceof AccountSourceConflictError ||
    error instanceof AccountSourceReferenceError
  ) {
    return error.message;
  }
  return "This account could not be saved.";
}

const intentSchema = z.union([
  z.literal("all"),
  z.string().regex(/^row-\d+$/u),
]);

/**
 * Saves one row (`intent=row-N`) or every unsaved row with a decision
 * (`intent=all`). Each row saves atomically on its own; one failure does not
 * undo rows already saved.
 */
export async function saveYnabAccountsAction(
  reviewToken: unknown,
  _previousState: YnabSaveActionState,
  formData: FormData,
): Promise<YnabSaveActionState> {
  let candidates: readonly YnabAccountCandidate[];
  let intent: string;
  try {
    candidates = reviewSnapshot(reviewToken);
    intent = intentSchema.parse(formData.get("intent"));
  } catch (error) {
    return {
      status: "error",
      message:
        error instanceof YnabAccountMappingError
          ? error.message
          : "The save request is invalid.",
      results: {},
      review: null,
    };
  }

  try {
    return await withServices(async (services) => {
      const before = await reviewStatus(candidates, services);
      const statusOf = (index: number) =>
        before.saveStates[candidates[index]!.sourceName]?.status;
      // Unsaved rows, plus excluded rows the person reopened to re-decide.
      const editableIndexes = candidates.flatMap((_, index) =>
        statusOf(index) === "unsaved" ||
        (statusOf(index) === "excluded" &&
          field(formData, `action-${index}`) !== "")
          ? [index]
          : [],
      );
      const targetIndexes =
        intent === "all"
          ? editableIndexes
          : editableIndexes.filter((index) => intent === `row-${index}`);

      const results: Record<string, YnabRowSaveResult> = {};
      const inputs = new Map<number, Record<string, unknown>>();
      for (const index of editableIndexes) {
        try {
          const input = decisionInput(formData, candidates[index]!, index);
          if (input) inputs.set(index, input);
        } catch (error) {
          if (targetIndexes.includes(index)) {
            results[candidates[index]!.sourceName] = {
              status: "error",
              message: rowErrorMessage(error),
            };
          }
        }
      }
      const context = {
        currentAccounts: before.currentAccounts,
        renameableSourceIds: new Set(
          before.renameTargets.map((target) => target.accountSourceId),
        ),
        // Saved exclusions not being re-decided, plus exclusions decided in
        // this review.
        excludedSourceNames: new Set([
          ...candidates.flatMap((candidate, index) =>
            statusOf(index) === "excluded" && !inputs.has(index)
              ? [candidate.sourceName]
              : [],
          ),
          ...[...inputs.values()]
            .filter((input) => input.action === "exclude")
            .map((input) => String(input.sourceName)),
        ]),
      };

      let skipped = 0;
      for (const index of targetIndexes) {
        const sourceName = candidates[index]!.sourceName;
        if (results[sourceName]) continue;
        const input = inputs.get(index);
        if (!input) {
          skipped += 1;
          if (intent !== "all") {
            results[sourceName] = {
              status: "error",
              message: "Choose a decision before saving.",
            };
          }
          continue;
        }
        try {
          const mapping = resolveYnabAccountDecision(
            candidates,
            context,
            input,
          );
          await services.decisions.save(mapping);
          results[sourceName] = {
            status: "saved",
            message: mapping.action === "exclude" ? "Excluded" : "Saved",
          };
        } catch (error) {
          results[sourceName] = {
            status: "error",
            message: rowErrorMessage(error),
          };
        }
      }

      const outcomes = Object.values(results);
      const savedCount = outcomes.filter(
        (outcome) => outcome.status === "saved",
      ).length;
      const failedCount = outcomes.length - savedCount;
      const parts = [
        `${savedCount} ${savedCount === 1 ? "account" : "accounts"} saved`,
        ...(failedCount > 0 ? [`${failedCount} need attention`] : []),
        ...(skipped > 0 && intent === "all"
          ? [`${skipped} still need a decision`]
          : []),
      ];
      return {
        status: failedCount > 0 ? "error" : "success",
        message:
          targetIndexes.length === 0
            ? intent === "all"
              ? "Every account in this export is already saved."
              : "This account is already saved."
            : `${parts.join(", ")}.`,
        results,
        review: await reviewStatus(candidates, services),
      };
    });
  } catch (error) {
    return {
      status: "error",
      message:
        configurationMessage(error) ??
        "Saving failed. Nothing further was saved.",
      results: {},
      review: null,
    };
  }
}
