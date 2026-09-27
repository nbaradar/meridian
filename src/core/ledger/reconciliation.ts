import { z } from "zod";

import {
  accountSourceNameSchema,
  type AccountSourceName,
} from "./account-sources";
import {
  accountIdSchema,
  accountSourceIdSchema,
  rawPayloadIdSchema,
  reconciliationCheckIdSchema,
  type AccountId,
  type AccountSourceId,
  type RawPayloadId,
  type ReconciliationCheckId,
} from "./identifiers";
import {
  compareAbsoluteAmounts,
  decimalAmountSchema,
  subtractAmounts,
  type DecimalAmount,
  type UsdCurrency,
} from "./money";
import {
  calendarDateSchema,
  type CalendarDate,
  type UtcTimestamp,
} from "./timestamps";

/**
 * Superseded by RFC 0008 (any-order import with cross-source matching); this
 * module is retired, with its tables, by RFC 0008's first plan. Do not build on it.
 *
 * RFC 0004 reconciliation gate: what a provider-reported balance means. A
 * semantic is only comparable once a reviewed policy, proven by a redacted
 * provider fixture, names it with a tolerance.
 */
export const providerBalanceSemanticSchema = z.enum([
  "current",
  "available",
  "posted_only",
  "includes_pending",
  "unknown",
]);
export type ProviderBalanceSemantic = z.infer<
  typeof providerBalanceSemanticSchema
>;

export const reconciliationResultSchema = z.enum([
  "passed",
  "failed",
  "not_comparable",
]);
export type ReconciliationResult = z.infer<typeof reconciliationResultSchema>;

export const reviewedBalancePolicySchema = z
  .strictObject({
    provider: accountSourceNameSchema,
    semantic: providerBalanceSemanticSchema.exclude(["unknown"]),
    tolerance: decimalAmountSchema.refine(
      (tolerance) => !tolerance.startsWith("-"),
      { message: "A tolerance cannot be negative" },
    ),
  })
  .readonly();
export type ReviewedBalancePolicy = z.infer<typeof reviewedBalancePolicySchema>;

/**
 * Reviewed `(provider, semantic, tolerance)` policies. Empty until a provider
 * fixture is reviewed in its own unit, so every real check is
 * `not_comparable` and no connector window can activate.
 */
export const reviewedBalancePolicies: readonly ReviewedBalancePolicy[] =
  Object.freeze([]);

export function reviewedTolerance(
  policies: readonly ReviewedBalancePolicy[],
  provider: AccountSourceName,
  semantic: ProviderBalanceSemantic,
): DecimalAmount | null {
  if (semantic === "unknown") return null;
  const matches = policies.filter(
    (policy) => policy.provider === provider && policy.semantic === semantic,
  );
  if (matches.length > 1) {
    throw new Error(
      `Reviewed balance policy is ambiguous for provider ${provider}, semantic ${semantic}`,
    );
  }
  return matches[0]?.tolerance ?? null;
}

/**
 * `passed` needs a reviewed tolerance and `|difference| <= tolerance`;
 * `failed` needs a reviewed tolerance and a larger difference; anything
 * without a reviewed tolerance is `not_comparable`.
 */
export function deriveReconciliationResult(
  difference: DecimalAmount,
  tolerance: DecimalAmount | null,
): ReconciliationResult {
  if (tolerance === null) return "not_comparable";
  return compareAbsoluteAmounts(difference, tolerance) <= 0
    ? "passed"
    : "failed";
}

/** Provider balance minus ledger balance, both in the owner's sign. */
export function reconciliationDifference(
  providerBalance: DecimalAmount,
  ledgerBalance: DecimalAmount,
): DecimalAmount {
  return subtractAmounts(providerBalance, ledgerBalance);
}

export const recordReconciliationCheckCommandSchema = z
  .strictObject({
    checkId: reconciliationCheckIdSchema,
    accountId: accountIdSchema,
    accountSourceId: accountSourceIdSchema,
    /** The proposed first date of live authority. */
    cutoffOn: calendarDateSchema,
    /** Half-open `[starts, ends)` dates the provider observation covered. */
    observationStartsOn: calendarDateSchema,
    observationEndsOn: calendarDateSchema,
    providerBalance: decimalAmountSchema,
    balanceSemantic: providerBalanceSemanticSchema,
    rawPayloadId: rawPayloadIdSchema.nullable(),
  })
  .refine(
    ({ observationStartsOn, observationEndsOn }) =>
      observationEndsOn > observationStartsOn,
    {
      message: "The observation interval must end after it starts",
      path: ["observationEndsOn"],
    },
  );
export type RecordReconciliationCheckCommand = z.infer<
  typeof recordReconciliationCheckCommandSchema
>;

export interface NewReconciliationCheck {
  id: ReconciliationCheckId;
  accountId: AccountId;
  accountSourceId: AccountSourceId;
  cutoffOn: CalendarDate;
  observationStartsOn: CalendarDate;
  observationEndsOn: CalendarDate;
  providerBalance: DecimalAmount;
  currency: UsdCurrency;
  balanceSemantic: ProviderBalanceSemantic;
  tolerance: DecimalAmount | null;
  /** Derived in core from the database-computed difference; re-checked by SQL. */
  result: ReconciliationResult;
  rawPayloadId: RawPayloadId | null;
}

export interface ReconciliationCheck extends NewReconciliationCheck {
  /** Computed by PostgreSQL from `ledger.entries` before the cutoff. */
  ledgerBalance: DecimalAmount;
  /** Computed by PostgreSQL: provider balance minus ledger balance. */
  difference: DecimalAmount;
  recordedAt: UtcTimestamp;
}
