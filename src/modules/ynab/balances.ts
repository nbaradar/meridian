import { createHash } from "node:crypto";

import { z } from "zod";

import {
  balanceObservationIdSchema,
  calendarDateSchema,
  decimalAmountSchema,
  isBalanceObservationError,
  sha256DigestSchema,
  sumAmounts,
  type CalendarDate,
  type DecimalAmount,
  type RecordYnabBalanceCommand,
  type Sha256Digest,
  type YnabBalanceRecordOutcome,
} from "../../core/ledger";
import type { YnabAccountSaveState } from "./account-decisions";
import type { YnabRegisterRow } from "./csv";
import { signedAmount } from "./import-plan";

/**
 * RFC 0006: the balance one YNAB export claims for one YNAB account. Only rows
 * dated on or before the latest allowed date count; later (future-dated) rows
 * are reported, never summed.
 */
export const ynabBalanceClaimSchema = z.strictObject({
  sourceName: z.string().min(1),
  /** Null when no row is dated on or before the latest allowed date. */
  balance: z
    .strictObject({
      amount: decimalAmountSchema,
      observedOn: calendarDateSchema,
    })
    .nullable(),
  futureRowCount: z.number().int().nonnegative(),
});

export type YnabBalanceClaim = z.infer<typeof ynabBalanceClaimSchema>;

/** SHA-256 of the register file's bytes as uploaded, lowercase hex. */
export function ynabExportDigest(registerBytes: Uint8Array): Sha256Digest {
  return sha256DigestSchema.parse(
    createHash("sha256").update(registerBytes).digest("hex"),
  );
}

export function planYnabBalanceClaims(
  sourceNames: readonly string[],
  registerRows: readonly YnabRegisterRow[],
  latestAllowedDate: CalendarDate,
): YnabBalanceClaim[] {
  return sourceNames.map((sourceName) => {
    const rows = registerRows.filter((row) => row.account === sourceName);
    const counted = rows.filter((row) => row.occurredOn <= latestAllowedDate);
    const observedOn = counted
      .map((row) => row.occurredOn)
      .sort()
      .at(-1);
    return {
      sourceName,
      balance:
        observedOn === undefined
          ? null
          : { amount: sumAmounts(counted.map(signedAmount)), observedOn },
      futureRowCount: rows.length - counted.length,
    };
  });
}

export type YnabBalanceSkipReason =
  "unsaved" | "excluded" | "unlinked" | "no_rows";

export type YnabBalanceSaveResult = { futureRowCount: number } & (
  | { status: "saved"; amount: DecimalAmount; observedOn: CalendarDate }
  | { status: "already_saved" }
  | { status: "skipped"; reason: YnabBalanceSkipReason }
  | { status: "error"; message: string }
);

/**
 * Saves each eligible claim through the core balance service. Only accounts
 * whose current decision is tracked and whose source is linked are eligible.
 * Each account saves on its own, so one failure never stops the others.
 */
export async function saveYnabBalances(input: {
  claims: readonly YnabBalanceClaim[];
  exportDigest: Sha256Digest;
  saveStates: ReadonlyMap<string, YnabAccountSaveState>;
  recordYnabBalance: (
    command: RecordYnabBalanceCommand,
  ) => Promise<YnabBalanceRecordOutcome>;
  newId: () => string;
}): Promise<Map<string, YnabBalanceSaveResult>> {
  const results = new Map<string, YnabBalanceSaveResult>();
  for (const claim of input.claims) {
    const { futureRowCount } = claim;
    const state = input.saveStates.get(claim.sourceName) ?? {
      status: "unsaved",
    };
    const skip = (reason: YnabBalanceSkipReason) =>
      results.set(claim.sourceName, {
        status: "skipped",
        reason,
        futureRowCount,
      });
    if (state.status !== "tracked") {
      skip(state.status);
      continue;
    }
    if (state.account === null) {
      skip("unlinked");
      continue;
    }
    if (claim.balance === null) {
      skip("no_rows");
      continue;
    }
    try {
      const outcome = await input.recordYnabBalance({
        observationId: balanceObservationIdSchema.parse(input.newId()),
        accountId: state.account.id,
        accountSourceId: state.accountSourceId,
        exportDigest: input.exportDigest,
        observedOn: claim.balance.observedOn,
        amount: claim.balance.amount,
      });
      results.set(
        claim.sourceName,
        outcome === "recorded"
          ? { status: "saved", ...claim.balance, futureRowCount }
          : { status: "already_saved", futureRowCount },
      );
    } catch (error) {
      results.set(claim.sourceName, {
        status: "error",
        message: isBalanceObservationError(error)
          ? error.reason
          : "This balance could not be saved.",
        futureRowCount,
      });
    }
  }
  return results;
}
