import { z } from "zod";

import {
  accountCreationDetailsSchema,
  accountIdSchema,
  accountSourceIdSchema,
  type AccountClass,
  type AccountSourceId,
  type AccountType,
  type CurrentAccount,
} from "../../core/ledger";
import type { YnabAccountCandidate } from "./import-plan";

const linkDecisionSchema = z.strictObject({
  sourceName: z.string().min(1),
  action: z.literal("link"),
  accountId: accountIdSchema,
});

const createDecisionSchema = accountCreationDetailsSchema.safeExtend({
  sourceName: z.string().min(1),
  action: z.literal("create"),
});

/**
 * Leaves a YNAB source account and its register rows out of the migration,
 * for example a duplicate account YNAB created during a bank re-link.
 */
const excludeDecisionSchema = z.strictObject({
  sourceName: z.string().min(1),
  action: z.literal("exclude"),
});

/**
 * Declares that this YNAB account is an already-saved YNAB account under a new
 * name, reusing that account's existing YNAB source (RFC 0005).
 */
const renamedDecisionSchema = z.strictObject({
  sourceName: z.string().min(1),
  action: z.literal("renamed"),
  accountSourceId: accountSourceIdSchema,
});

export const ynabAccountMappingDecisionSchema = z.discriminatedUnion("action", [
  linkDecisionSchema,
  createDecisionSchema,
  excludeDecisionSchema,
  renamedDecisionSchema,
]);

export type YnabAccountMappingDecision = z.infer<
  typeof ynabAccountMappingDecisionSchema
>;

export type YnabResolvedAccountMapping =
  | {
      sourceName: string;
      action: "link";
      accountId: CurrentAccount["id"];
    }
  | {
      sourceName: string;
      action: "create";
      name: string;
      accountType: AccountType;
      accountClass: AccountClass | null;
      openedOn: CurrentAccount["openedOn"];
    }
  | {
      sourceName: string;
      action: "exclude";
    }
  | {
      sourceName: string;
      action: "renamed";
      accountSourceId: AccountSourceId;
    };

export class YnabAccountMappingError extends Error {
  constructor(
    message: string,
    /** The source account whose decision failed, when one is identifiable. */
    readonly sourceName: string | null = null,
  ) {
    super(message);
    this.name = "YnabAccountMappingError";
  }
}

export interface YnabAccountDecisionContext {
  currentAccounts: readonly CurrentAccount[];
  /** YNAB sources already tracked in Meridian that a rename may reuse. */
  renameableSourceIds: ReadonlySet<string>;
  /** Source accounts excluded, whether saved or decided in the same review. */
  excludedSourceNames: ReadonlySet<string>;
}

function rowCount(count: number): string {
  return `${count} transfer ${count === 1 ? "row" : "rows"}`;
}

function requireCandidate(
  candidates: readonly YnabAccountCandidate[],
  sourceName: string,
): YnabAccountCandidate {
  const candidate = candidates.find(
    (candidate) => candidate.sourceName === sourceName,
  );
  if (!candidate) {
    throw new YnabAccountMappingError(
      `Mapping references an unknown YNAB account: ${sourceName}`,
      sourceName,
    );
  }
  return candidate;
}

/**
 * Validates one account decision against the whole export. Transfer rows must
 * never reach Transfer Clearing without their counterpart, so an excluded
 * account may not be referenced by an included one, in either direction.
 */
export function resolveYnabAccountDecision(
  candidates: readonly YnabAccountCandidate[],
  context: YnabAccountDecisionContext,
  input: unknown,
): YnabResolvedAccountMapping {
  const decision = ynabAccountMappingDecisionSchema.parse(input);
  const candidate = requireCandidate(candidates, decision.sourceName);

  if (decision.action === "exclude") {
    const includedReferences = candidate.activity.transferReferences.filter(
      (reference) => !context.excludedSourceNames.has(reference.sourceName),
    );
    if (includedReferences.length > 0) {
      const count = includedReferences.reduce(
        (sum, reference) => sum + reference.rowCount,
        0,
      );
      throw new YnabAccountMappingError(
        `Cannot exclude YNAB account ${candidate.sourceName}: ${rowCount(count)} in included accounts (${includedReferences.map((reference) => reference.sourceName).join(", ")}) reference it. Link it to the account it duplicates instead, or exclude those accounts too.`,
        candidate.sourceName,
      );
    }
    return { sourceName: candidate.sourceName, action: "exclude" };
  }

  const excludedTargets = candidates.filter(
    (other) =>
      other.sourceName !== candidate.sourceName &&
      context.excludedSourceNames.has(other.sourceName) &&
      other.activity.transferReferences.some(
        (reference) => reference.sourceName === candidate.sourceName,
      ),
  );
  if (excludedTargets.length > 0) {
    throw new YnabAccountMappingError(
      `Cannot include YNAB account ${candidate.sourceName}: it has transfers to excluded accounts (${excludedTargets.map((other) => other.sourceName).join(", ")}). Include those accounts too.`,
      candidate.sourceName,
    );
  }

  if (decision.action === "renamed") {
    if (!context.renameableSourceIds.has(decision.accountSourceId)) {
      throw new YnabAccountMappingError(
        `Renamed YNAB account must match a saved YNAB account: ${candidate.sourceName}`,
        candidate.sourceName,
      );
    }
    return {
      sourceName: candidate.sourceName,
      action: "renamed",
      accountSourceId: decision.accountSourceId,
    };
  }

  if (decision.action === "link") {
    if (
      !context.currentAccounts.some(
        (account) => account.id === decision.accountId,
      )
    ) {
      throw new YnabAccountMappingError(
        `Linked Meridian account does not exist for YNAB account: ${candidate.sourceName}`,
        candidate.sourceName,
      );
    }
    return {
      sourceName: candidate.sourceName,
      action: "link",
      accountId: decision.accountId,
    };
  }

  return {
    sourceName: candidate.sourceName,
    action: "create",
    name: decision.name,
    accountType: decision.accountType,
    accountClass: decision.accountClass,
    openedOn: decision.openedOn,
  };
}

/** Validates one explicit decision for every candidate in the export. */
export function finalizeYnabAccountMappings(
  candidates: readonly YnabAccountCandidate[],
  currentAccounts: readonly CurrentAccount[],
  input: unknown,
  renameableSourceIds: ReadonlySet<string> = new Set(),
): readonly YnabResolvedAccountMapping[] {
  const decisions = z.array(ynabAccountMappingDecisionSchema).parse(input);
  const candidateNames = new Set<string>();
  for (const candidate of candidates) {
    if (candidateNames.has(candidate.sourceName)) {
      throw new YnabAccountMappingError(
        `Duplicate YNAB account candidate: ${candidate.sourceName}`,
      );
    }
    candidateNames.add(candidate.sourceName);
  }

  const decisionsBySource = new Map<string, YnabAccountMappingDecision>();
  for (const decision of decisions) {
    if (!candidateNames.has(decision.sourceName)) {
      throw new YnabAccountMappingError(
        `Mapping references an unknown YNAB account: ${decision.sourceName}`,
        decision.sourceName,
      );
    }
    if (decisionsBySource.has(decision.sourceName)) {
      throw new YnabAccountMappingError(
        `YNAB account is mapped more than once: ${decision.sourceName}`,
        decision.sourceName,
      );
    }
    decisionsBySource.set(decision.sourceName, decision);
  }

  const context: YnabAccountDecisionContext = {
    currentAccounts,
    renameableSourceIds,
    excludedSourceNames: new Set(
      decisions
        .filter((decision) => decision.action === "exclude")
        .map((decision) => decision.sourceName),
    ),
  };
  return candidates.map((candidate) => {
    const decision = decisionsBySource.get(candidate.sourceName);
    if (!decision) {
      throw new YnabAccountMappingError(
        `YNAB account requires an explicit mapping: ${candidate.sourceName}`,
        candidate.sourceName,
      );
    }
    return resolveYnabAccountDecision(candidates, context, decision);
  });
}
