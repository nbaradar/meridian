import { z } from "zod";

import type { AccountSourceKind, AccountSourceName } from "./account-sources";
import {
  accountIdSchema,
  accountSourceIdSchema,
  authorityRevisionIdSchema,
  authorityWindowIdSchema,
  reconciliationCheckIdSchema,
  type AccountId,
  type AccountSourceId,
  type AuthorityRevisionId,
  type AuthorityWindowId,
  type ReconciliationCheckId,
} from "./identifiers";
import type { DecimalAmount } from "./money";
import {
  deriveReconciliationResult,
  reconciliationDifference,
  recordReconciliationCheckCommandSchema,
  reviewedBalancePolicies,
  reviewedTolerance,
  type NewReconciliationCheck,
  type ReconciliationCheck,
  type ReviewedBalancePolicy,
} from "./reconciliation";
import {
  calendarDateSchema,
  type CalendarDate,
  type UtcTimestamp,
} from "./timestamps";

/**
 * Superseded by RFC 0008 (any-order import with cross-source matching); this
 * module is retired, with its tables, by RFC 0008's first plan. Do not build on it.
 *
 * RFC 0004 rollout unit two: which linked account source is authoritative for
 * a canonical account's `transactions` feed over half-open `[startsOn, endsOn)`
 * `occurred_on` windows. Nothing here records a transaction.
 */
export const authorityStatusSchema = z.enum(["proposed", "active", "revoked"]);
export const authorityReasonCodeSchema = z.enum([
  "window_proposed",
  "window_activated",
  "owner_revoked",
  "schedule_replaced",
]);
export const revocationReasonCodeSchema = authorityReasonCodeSchema.extract([
  "owner_revoked",
  "schedule_replaced",
]);

export type AuthorityStatus = z.infer<typeof authorityStatusSchema>;
export type AuthorityReasonCode = z.infer<typeof authorityReasonCodeSchema>;

export const proposeAuthorityWindowCommandSchema = z
  .strictObject({
    revisionId: authorityRevisionIdSchema,
    authorityWindowId: authorityWindowIdSchema,
    accountId: accountIdSchema,
    accountSourceId: accountSourceIdSchema,
    startsOn: calendarDateSchema,
    endsOn: calendarDateSchema.nullable(),
  })
  .refine(({ startsOn, endsOn }) => endsOn === null || endsOn > startsOn, {
    message: "An authority window must end after it starts",
    path: ["endsOn"],
  });

export const activateAuthorityWindowCommandSchema = z.strictObject({
  revisionId: authorityRevisionIdSchema,
  supersedesRevisionId: authorityRevisionIdSchema,
  /** Required for a connector source; optional evidence for an import source. */
  reconciliationCheckId: reconciliationCheckIdSchema.nullable(),
});

export const revokeAuthorityWindowCommandSchema = z.strictObject({
  revisionId: authorityRevisionIdSchema,
  supersedesRevisionId: authorityRevisionIdSchema,
  reasonCode: revocationReasonCodeSchema,
});

export const evaluateTransactionAuthorityQuerySchema = z.strictObject({
  accountId: accountIdSchema,
  accountSourceId: accountSourceIdSchema,
  occurredOn: calendarDateSchema,
});

export type ProposeAuthorityWindowCommand = z.infer<
  typeof proposeAuthorityWindowCommandSchema
>;
export type ActivateAuthorityWindowCommand = z.infer<
  typeof activateAuthorityWindowCommandSchema
>;
export type RevokeAuthorityWindowCommand = z.infer<
  typeof revokeAuthorityWindowCommandSchema
>;
export type EvaluateTransactionAuthorityQuery = z.infer<
  typeof evaluateTransactionAuthorityQuerySchema
>;

export interface NewAuthorityRevision {
  id: AuthorityRevisionId;
  authorityWindowId: AuthorityWindowId;
  accountId: AccountId;
  accountSourceId: AccountSourceId;
  startsOn: CalendarDate;
  endsOn: CalendarDate | null;
  status: AuthorityStatus;
  supersedesRevisionId: AuthorityRevisionId | null;
  reasonCode: AuthorityReasonCode;
  reconciliationCheckId: ReconciliationCheckId | null;
}

export interface AuthorityRevision extends NewAuthorityRevision {
  recordedAt: UtcTimestamp;
}

/** The tip of one authority window's revision chain. */
export type CurrentAuthorityWindow = AuthorityRevision;

export interface AuthorityAccountSource {
  id: AccountSourceId;
  source: AccountSourceName;
  sourceKind: AccountSourceKind;
}

export type AppendOutcome = "recorded" | "replayed";

export interface TransactionAuthorityStore {
  findAccountSource(
    accountSourceId: AccountSourceId,
  ): Promise<AuthorityAccountSource | null>;
  findRevision(id: AuthorityRevisionId): Promise<AuthorityRevision | null>;
  /** Appends a revision; an exact replay of the same ID is a no-op. */
  appendRevision(revision: NewAuthorityRevision): Promise<AppendOutcome>;
  listCurrentWindows(
    accountId: AccountId,
  ): Promise<readonly CurrentAuthorityWindow[]>;
  /** Sum of the account's entries dated before the cutoff, from PostgreSQL. */
  ledgerBalanceBefore(
    accountId: AccountId,
    cutoffOn: CalendarDate,
  ): Promise<DecimalAmount>;
  /** Records a check; an exact replay of the same ID is a no-op. */
  recordReconciliationCheck(
    check: NewReconciliationCheck,
  ): Promise<AppendOutcome>;
  findReconciliationCheck(
    id: ReconciliationCheckId,
  ): Promise<ReconciliationCheck | null>;
}

/** Identifies a failed authority decision without naming the account. */
export interface TransactionAuthorityErrorContext {
  accountId?: AccountId | null;
  accountSourceId?: AccountSourceId | null;
  authorityWindowId?: AuthorityWindowId | null;
  revisionId?: AuthorityRevisionId | null;
  reconciliationCheckId?: ReconciliationCheckId | null;
}

function describeContext(context: TransactionAuthorityErrorContext): string {
  const parts = Object.entries(context)
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([key, value]) => `${key} ${String(value)}`);
  return parts.length === 0 ? "" : ` (${parts.join(", ")})`;
}

abstract class TransactionAuthorityError extends Error {
  readonly context: TransactionAuthorityErrorContext;

  constructor(
    message: string,
    context: TransactionAuthorityErrorContext,
    options?: ErrorOptions,
  ) {
    super(`${message}${describeContext(context)}`, options);
    this.context = context;
  }
}

/** The decision conflicts with a current tip, link, window, or check. */
export class TransactionAuthorityConflictError extends TransactionAuthorityError {
  constructor(
    message: string,
    context: TransactionAuthorityErrorContext,
    options?: ErrorOptions,
  ) {
    super(message, context, options);
    this.name = "TransactionAuthorityConflictError";
  }
}

export class TransactionAuthorityReferenceError extends TransactionAuthorityError {
  constructor(
    message: string,
    context: TransactionAuthorityErrorContext,
    options?: ErrorOptions,
  ) {
    super(message, context, options);
    this.name = "TransactionAuthorityReferenceError";
  }
}

export class TransactionAuthorityPersistenceError extends TransactionAuthorityError {
  constructor(
    operation: string,
    context: TransactionAuthorityErrorContext,
    options?: ErrorOptions,
  ) {
    super(
      `Transaction authority operation failed: ${operation}`,
      context,
      options,
    );
    this.name = "TransactionAuthorityPersistenceError";
  }
}

/** True when `occurredOn` falls in the half-open `[startsOn, endsOn)` window. */
export function windowCovers(
  window: Pick<CurrentAuthorityWindow, "startsOn" | "endsOn">,
  occurredOn: CalendarDate,
): boolean {
  return (
    window.startsOn <= occurredOn &&
    (window.endsOn === null || occurredOn < window.endsOn)
  );
}

export type TransactionAuthorityEvaluation =
  | { status: "authorized"; window: CurrentAuthorityWindow }
  | { status: "no_window" }
  | { status: "wrong_source"; window: CurrentAuthorityWindow }
  | {
      status: "conflicting_windows";
      windows: readonly CurrentAuthorityWindow[];
    };

/**
 * Read-only RFC 0004 evaluation: only a current `active` tip for the account
 * whose window covers the date authorizes, and only for its own source. A gap
 * or a conflict fails closed. This never records anything.
 */
export function evaluateTransactionAuthority(
  currentWindows: readonly CurrentAuthorityWindow[],
  query: EvaluateTransactionAuthorityQuery,
): TransactionAuthorityEvaluation {
  const covering = currentWindows.filter(
    (window) =>
      window.accountId === query.accountId &&
      window.status === "active" &&
      windowCovers(window, query.occurredOn),
  );
  if (covering.length === 0) return { status: "no_window" };
  if (covering.length > 1) {
    return { status: "conflicting_windows", windows: covering };
  }
  const window = covering[0]!;
  return window.accountSourceId === query.accountSourceId
    ? { status: "authorized", window }
    : { status: "wrong_source", window };
}

const allowedTransitions: Readonly<
  Record<AuthorityStatus, readonly AuthorityStatus[]>
> = {
  proposed: ["active", "revoked"],
  active: ["revoked"],
  revoked: [],
};

export function createTransactionAuthorityService(
  store: TransactionAuthorityStore,
  options: { policies?: readonly ReviewedBalancePolicy[] } = {},
) {
  // Production passes nothing and gets the empty reviewed registry.
  const policies = options.policies ?? reviewedBalancePolicies;

  /**
   * The predecessor a successor copies. The transition is checked here for an
   * early error; PostgreSQL enforces it. A replay skips the check and the
   * store verifies it matches exactly.
   */
  async function predecessorFor(
    revisionId: AuthorityRevisionId,
    supersedesRevisionId: AuthorityRevisionId,
    status: AuthorityStatus,
  ): Promise<AuthorityRevision> {
    const predecessor = await store.findRevision(supersedesRevisionId);
    if (!predecessor) {
      throw new TransactionAuthorityReferenceError(
        "The superseded authority revision does not exist",
        { revisionId },
      );
    }
    const isReplay = (await store.findRevision(revisionId)) !== null;
    if (!isReplay && !allowedTransitions[predecessor.status].includes(status)) {
      throw new TransactionAuthorityConflictError(
        `An authority window cannot go from ${predecessor.status} to ${status}`,
        {
          revisionId,
          authorityWindowId: predecessor.authorityWindowId,
          accountId: predecessor.accountId,
        },
      );
    }
    return predecessor;
  }

  return {
    async proposeWindow(input: unknown) {
      const command = proposeAuthorityWindowCommandSchema.parse(input);
      const outcome = await store.appendRevision({
        id: command.revisionId,
        authorityWindowId: command.authorityWindowId,
        accountId: command.accountId,
        accountSourceId: command.accountSourceId,
        startsOn: command.startsOn,
        endsOn: command.endsOn,
        status: "proposed",
        supersedesRevisionId: null,
        reasonCode: "window_proposed",
        reconciliationCheckId: null,
      });
      return { id: command.revisionId, outcome };
    },

    /**
     * Activates a proposed window. PostgreSQL proves the source's current
     * link, rejects overlap, and, for a connector source, requires a passed
     * check for the same account, source, and cutoff (`startsOn`).
     */
    async activateWindow(input: unknown) {
      const command = activateAuthorityWindowCommandSchema.parse(input);
      const predecessor = await predecessorFor(
        command.revisionId,
        command.supersedesRevisionId,
        "active",
      );
      const outcome = await store.appendRevision({
        ...predecessor,
        id: command.revisionId,
        status: "active",
        supersedesRevisionId: command.supersedesRevisionId,
        reasonCode: "window_activated",
        reconciliationCheckId: command.reconciliationCheckId,
      });
      return { id: command.revisionId, outcome };
    },

    async revokeWindow(input: unknown) {
      const command = revokeAuthorityWindowCommandSchema.parse(input);
      const predecessor = await predecessorFor(
        command.revisionId,
        command.supersedesRevisionId,
        "revoked",
      );
      const outcome = await store.appendRevision({
        ...predecessor,
        id: command.revisionId,
        status: "revoked",
        supersedesRevisionId: command.supersedesRevisionId,
        reasonCode: command.reasonCode,
        reconciliationCheckId: null,
      });
      return { id: command.revisionId, outcome };
    },

    listCurrentWindows(input: unknown) {
      return store.listCurrentWindows(accountIdSchema.parse(input));
    },

    /** Read-only: resolves current windows and evaluates; never writes. */
    async evaluate(input: unknown): Promise<TransactionAuthorityEvaluation> {
      const query = evaluateTransactionAuthorityQuerySchema.parse(input);
      return evaluateTransactionAuthority(
        await store.listCurrentWindows(query.accountId),
        query,
      );
    },

    /**
     * Records immutable reconciliation evidence. The ledger balance and the
     * difference come from PostgreSQL; the tolerance comes only from a
     * reviewed policy; the result is derived, and SQL re-checks it.
     */
    async recordReconciliationCheck(input: unknown) {
      const command = recordReconciliationCheckCommandSchema.parse(input);
      const context = {
        accountId: command.accountId,
        accountSourceId: command.accountSourceId,
        reconciliationCheckId: command.checkId,
      };
      const existing = await store.findReconciliationCheck(command.checkId);
      if (existing) {
        const same =
          existing.accountId === command.accountId &&
          existing.accountSourceId === command.accountSourceId &&
          existing.cutoffOn === command.cutoffOn &&
          existing.observationStartsOn === command.observationStartsOn &&
          existing.observationEndsOn === command.observationEndsOn &&
          existing.providerBalance === command.providerBalance &&
          existing.balanceSemantic === command.balanceSemantic &&
          existing.rawPayloadId === command.rawPayloadId;
        if (!same) {
          throw new TransactionAuthorityConflictError(
            "Reconciliation check replay conflicts with the recorded check",
            context,
          );
        }
        return { check: existing, outcome: "replayed" as const };
      }

      const source = await store.findAccountSource(command.accountSourceId);
      if (!source) {
        throw new TransactionAuthorityReferenceError(
          "The account source does not exist",
          context,
        );
      }
      const tolerance = reviewedTolerance(
        policies,
        source.source,
        command.balanceSemantic,
      );
      const ledgerBalance = await store.ledgerBalanceBefore(
        command.accountId,
        command.cutoffOn,
      );
      const outcome = await store.recordReconciliationCheck({
        id: command.checkId,
        accountId: command.accountId,
        accountSourceId: command.accountSourceId,
        cutoffOn: command.cutoffOn,
        observationStartsOn: command.observationStartsOn,
        observationEndsOn: command.observationEndsOn,
        providerBalance: command.providerBalance,
        currency: "USD",
        balanceSemantic: command.balanceSemantic,
        tolerance,
        result: deriveReconciliationResult(
          reconciliationDifference(command.providerBalance, ledgerBalance),
          tolerance,
        ),
        rawPayloadId: command.rawPayloadId,
      });
      const check = await store.findReconciliationCheck(command.checkId);
      if (!check) {
        throw new TransactionAuthorityPersistenceError(
          "read recorded reconciliation check",
          context,
        );
      }
      return { check, outcome };
    },
  };
}

export type TransactionAuthorityService = ReturnType<
  typeof createTransactionAuthorityService
>;
