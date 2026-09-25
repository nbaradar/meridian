import { z } from "zod";

import {
  accountTypeSchema,
  type AccountClass,
  type AccountType,
  type CurrentAccount,
} from "./destinations";
import {
  accountIdSchema,
  accountSourceIdSchema,
  balanceObservationIdSchema,
  balanceObservationRetractionIdSchema,
  type AccountId,
  type AccountSourceId,
  type BalanceObservationId,
  type BalanceObservationRetractionId,
} from "./identifiers";
import {
  decimalAmountSchema,
  enteredDecimalAmountSchema,
  negateAmount,
  sumAmounts,
  type DecimalAmount,
  type UsdCurrency,
} from "./money";
import { sha256DigestSchema, type Sha256Digest } from "./source-record";
import {
  calendarDateSchema,
  utcTimestampSchema,
  type CalendarDate,
  type UtcTimestamp,
} from "./timestamps";

/**
 * RFC 0006: an account-level balance claim. `amount` is the account's
 * contribution to net worth, so an owed liability is negative.
 */
export const balanceObservationSourceSchema = z.enum(["manual", "ynab_export"]);
export type BalanceObservationSource = z.infer<
  typeof balanceObservationSourceSchema
>;

const manualEntryFields = {
  observationId: balanceObservationIdSchema,
  accountId: accountIdSchema,
  observedOn: calendarDateSchema,
  /**
   * What the owner typed: the balance for an asset, or the amount owed for a
   * liability. Converted by `balanceAmountFromEntry`.
   */
  enteredAmount: enteredDecimalAmountSchema,
};

export const recordManualBalanceCommandSchema =
  z.strictObject(manualEntryFields);

export const correctBalanceCommandSchema = z.strictObject({
  ...manualEntryFields,
  supersedesObservationId: balanceObservationIdSchema,
});

export const retractBalanceCommandSchema = z.strictObject({
  retractionId: balanceObservationRetractionIdSchema,
  observationId: balanceObservationIdSchema,
});

export const recordYnabBalanceCommandSchema = z.strictObject({
  observationId: balanceObservationIdSchema,
  accountId: accountIdSchema,
  accountSourceId: accountSourceIdSchema,
  exportDigest: sha256DigestSchema,
  observedOn: calendarDateSchema,
  /** YNAB's working-balance sign already matches the net-worth sign. */
  amount: decimalAmountSchema,
});

export type RecordManualBalanceCommand = z.infer<
  typeof recordManualBalanceCommandSchema
>;
export type CorrectBalanceCommand = z.infer<typeof correctBalanceCommandSchema>;
export type RetractBalanceCommand = z.infer<typeof retractBalanceCommandSchema>;
export type RecordYnabBalanceCommand = z.infer<
  typeof recordYnabBalanceCommandSchema
>;

export type NewBalanceObservation = {
  id: BalanceObservationId;
  accountId: AccountId;
  observedOn: CalendarDate;
  amount: DecimalAmount;
  currency: UsdCurrency;
  supersedesObservationId: BalanceObservationId | null;
} & (
  | { source: "manual"; accountSourceId: null; exportDigest: null }
  | {
      source: "ynab_export";
      accountSourceId: AccountSourceId;
      exportDigest: Sha256Digest;
    }
);

export interface NewBalanceObservationRetraction {
  id: BalanceObservationRetractionId;
  observationId: BalanceObservationId;
}

/** A row of `ledger.current_balances`: the account's winning observation. */
export interface CurrentBalance {
  observationId: BalanceObservationId;
  accountId: AccountId;
  observedOn: CalendarDate;
  amount: DecimalAmount;
  currency: UsdCurrency;
  source: BalanceObservationSource;
  recordedAt: UtcTimestamp;
}

export type YnabBalanceRecordOutcome = "recorded" | "already_saved";

export interface BalanceObservationStore {
  findAccount(accountId: AccountId): Promise<CurrentAccount | null>;
  listAccounts(): Promise<readonly CurrentAccount[]>;
  listCurrentBalances(): Promise<readonly CurrentBalance[]>;
  recordObservation(observation: NewBalanceObservation): Promise<void>;
  /**
   * Records a YNAB export balance once per `(accountSourceId, exportDigest)`.
   * Returns "already_saved" when that pair exists, even if it was retracted.
   */
  recordYnabObservation(
    observation: NewBalanceObservation & { source: "ynab_export" },
  ): Promise<YnabBalanceRecordOutcome>;
  retractObservation(
    retraction: NewBalanceObservationRetraction,
  ): Promise<void>;
}

/** Identifies a failed balance write without naming the account. */
export interface BalanceObservationErrorContext {
  accountId: AccountId | null;
  source: BalanceObservationSource | null;
  accountSourceId?: AccountSourceId | null;
  observationId?: BalanceObservationId | null;
}

function describeContext(context: BalanceObservationErrorContext): string {
  const parts = [
    context.accountId ? `account ${context.accountId}` : null,
    context.source ? `source ${context.source}` : null,
    context.accountSourceId
      ? `account source ${context.accountSourceId}`
      : null,
    context.observationId ? `observation ${context.observationId}` : null,
  ].filter((part) => part !== null);
  return parts.length === 0 ? "" : ` (${parts.join(", ")})`;
}

abstract class BalanceObservationError extends Error {
  readonly context: BalanceObservationErrorContext;
  /** The message without identifiers, safe to show the owner. */
  readonly reason: string;

  constructor(
    message: string,
    context: BalanceObservationErrorContext,
    options?: ErrorOptions,
  ) {
    super(`${message}${describeContext(context)}`, options);
    this.context = context;
    this.reason = message;
  }
}

export function isBalanceObservationError(
  error: unknown,
): error is BalanceObservationError {
  return error instanceof BalanceObservationError;
}

/** The observation date is after the latest allowed date. */
export class BalanceObservationDateError extends BalanceObservationError {
  readonly latestAllowedDate: CalendarDate;

  constructor(
    latestAllowedDate: CalendarDate,
    context: BalanceObservationErrorContext,
  ) {
    super(`Balance date cannot be after ${latestAllowedDate}`, context);
    this.name = "BalanceObservationDateError";
    this.latestAllowedDate = latestAllowedDate;
  }
}

/** The write conflicts with recorded balances or account-source state. */
export class BalanceObservationConflictError extends BalanceObservationError {
  constructor(
    message: string,
    context: BalanceObservationErrorContext,
    options?: ErrorOptions,
  ) {
    super(message, context, options);
    this.name = "BalanceObservationConflictError";
  }
}

/** The write names an account or observation that does not exist. */
export class BalanceObservationReferenceError extends BalanceObservationError {
  constructor(
    message: string,
    context: BalanceObservationErrorContext,
    options?: ErrorOptions,
  ) {
    super(message, context, options);
    this.name = "BalanceObservationReferenceError";
  }
}

export class BalanceObservationPersistenceError extends BalanceObservationError {
  constructor(
    operation: string,
    context: BalanceObservationErrorContext,
    options?: ErrorOptions,
  ) {
    super(
      `Balance observation operation failed: ${operation}`,
      context,
      options,
    );
    this.name = "BalanceObservationPersistenceError";
  }
}

/**
 * The one conversion between what the owner types and the stored amount. A
 * liability is entered as the amount owed, so owing X stores -X and a credit
 * (a negative amount owed) stores a positive amount. Assets store as entered.
 */
export function balanceAmountFromEntry(
  accountClass: AccountClass,
  enteredAmount: DecimalAmount,
): DecimalAmount {
  return accountClass === "liability"
    ? negateAmount(enteredAmount)
    : enteredAmount;
}

/** The inverse of `balanceAmountFromEntry`, for pre-filling and display. */
export function entryAmountFromBalance(
  accountClass: AccountClass,
  amount: DecimalAmount,
): DecimalAmount {
  return accountClass === "liability" ? negateAmount(amount) : amount;
}

/** The server's UTC calendar date. */
export function utcDate(now: UtcTimestamp): CalendarDate {
  return calendarDateSchema.parse(new Date(now).toISOString().slice(0, 10));
}

/**
 * RFC 0006: no observation may be dated after the server's UTC date plus one
 * day, which covers an owner who is behind UTC.
 */
export function latestAllowedObservationDate(now: UtcTimestamp): CalendarDate {
  const today = new Date(`${utcDate(now)}T00:00:00Z`);
  today.setUTCDate(today.getUTCDate() + 1);
  return calendarDateSchema.parse(today.toISOString().slice(0, 10));
}

/** Whole days from `observedOn` to `today`; negative for a future date. */
export function balanceAgeDays(
  observedOn: CalendarDate,
  today: CalendarDate,
): number {
  const millisecondsPerDay = 24 * 60 * 60 * 1000;
  return Math.round(
    (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${observedOn}T00:00:00Z`)) /
      millisecondsPerDay,
  );
}

export interface AccountBalance {
  account: CurrentAccount;
  balance: CurrentBalance;
}

export interface NetWorth {
  /** Sum of `included` amounts. */
  netWorth: DecimalAmount;
  /** Sum of included asset-class amounts. */
  assets: DecimalAmount;
  /** Sum of included liability-class amounts; negative while debt is owed. */
  liabilities: DecimalAmount;
  /** Active accounts with a current balance. */
  included: readonly AccountBalance[];
  /** Active accounts with no current balance ("no balance yet"). */
  withoutBalance: readonly CurrentAccount[];
  /** Closed accounts whose current balance is not zero; never summed. */
  closedWithBalance: readonly AccountBalance[];
}

/**
 * RFC 0006 net worth, computed exactly with decimal arithmetic. Order of the
 * inputs never changes the totals.
 */
export function computeNetWorth(
  accounts: readonly CurrentAccount[],
  balances: readonly CurrentBalance[],
): NetWorth {
  const balanceByAccount = new Map(
    balances.map((balance) => [balance.accountId, balance]),
  );
  const included: AccountBalance[] = [];
  const withoutBalance: CurrentAccount[] = [];
  const closedWithBalance: AccountBalance[] = [];
  for (const account of accounts) {
    const balance = balanceByAccount.get(account.id);
    if (account.status === "closed") {
      if (balance && balance.amount !== "0") {
        closedWithBalance.push({ account, balance });
      }
      continue;
    }
    if (balance) included.push({ account, balance });
    else withoutBalance.push(account);
  }
  const amountsOf = (accountClass: AccountClass | null) =>
    included
      .filter(
        ({ account }) =>
          accountClass === null || account.accountClass === accountClass,
      )
      .map(({ balance }) => balance.amount);
  return {
    netWorth: sumAmounts(amountsOf(null)),
    assets: sumAmounts(amountsOf("asset")),
    liabilities: sumAmounts(amountsOf("liability")),
    included,
    withoutBalance,
    closedWithBalance,
  };
}

export interface DashboardAccount {
  account: CurrentAccount;
  /** Null when the account has no current balance. */
  balance: CurrentBalance | null;
  ageDays: number | null;
  /** True for a closed account whose balance is flagged, not summed. */
  flaggedClosed: boolean;
}

export interface DashboardGroup {
  accountType: AccountType;
  accounts: readonly DashboardAccount[];
}

export interface BalanceDashboard {
  today: CalendarDate;
  latestAllowedDate: CalendarDate;
  netWorth: NetWorth;
  /** Account-type groups in enum order; accounts sorted by current name. */
  groups: readonly DashboardGroup[];
}

export function buildBalanceDashboard(
  accounts: readonly CurrentAccount[],
  balances: readonly CurrentBalance[],
  now: UtcTimestamp,
): BalanceDashboard {
  const today = utcDate(now);
  const netWorth = computeNetWorth(accounts, balances);
  const balanceByAccount = new Map(
    balances.map((balance) => [balance.accountId, balance]),
  );
  const flagged = new Set(
    netWorth.closedWithBalance.map(({ account }) => account.id),
  );
  const groups = accountTypeSchema.options.flatMap((accountType) => {
    const members = accounts
      .filter((account) => account.accountType === accountType)
      .sort(
        (left, right) =>
          left.name.localeCompare(right.name) ||
          left.id.localeCompare(right.id),
      )
      .map((account): DashboardAccount => {
        const balance = balanceByAccount.get(account.id) ?? null;
        return {
          account,
          balance,
          ageDays: balance ? balanceAgeDays(balance.observedOn, today) : null,
          flaggedClosed: flagged.has(account.id),
        };
      });
    return members.length === 0 ? [] : [{ accountType, accounts: members }];
  });
  return {
    today,
    latestAllowedDate: latestAllowedObservationDate(now),
    netWorth,
    groups,
  };
}

export function createBalanceObservationService(
  store: BalanceObservationStore,
  clock: () => UtcTimestamp,
) {
  function requireAllowedDate(
    observedOn: CalendarDate,
    context: BalanceObservationErrorContext,
  ): void {
    const latest = latestAllowedObservationDate(
      utcTimestampSchema.parse(clock()),
    );
    if (observedOn > latest) {
      throw new BalanceObservationDateError(latest, context);
    }
  }

  async function manualObservation(
    command: RecordManualBalanceCommand,
    supersedesObservationId: BalanceObservationId | null,
  ): Promise<NewBalanceObservation> {
    const context = { accountId: command.accountId, source: "manual" as const };
    requireAllowedDate(command.observedOn, context);
    const account = await store.findAccount(command.accountId);
    if (!account) {
      throw new BalanceObservationReferenceError(
        "The account does not exist",
        context,
      );
    }
    return {
      id: command.observationId,
      accountId: account.id,
      observedOn: command.observedOn,
      amount: balanceAmountFromEntry(
        account.accountClass,
        command.enteredAmount,
      ),
      currency: account.currency,
      source: "manual",
      accountSourceId: null,
      exportDigest: null,
      supersedesObservationId,
    };
  }

  return {
    async recordManualBalance(input: unknown) {
      const command = recordManualBalanceCommandSchema.parse(input);
      const observation = await manualObservation(command, null);
      await store.recordObservation(observation);
      return { id: observation.id, amount: observation.amount };
    },

    /** Supersedes an account's current observation with a manual one. */
    async correctBalance(input: unknown) {
      const command = correctBalanceCommandSchema.parse(input);
      const observation = await manualObservation(
        command,
        command.supersedesObservationId,
      );
      await store.recordObservation(observation);
      return { id: observation.id, amount: observation.amount };
    },

    async retractBalance(input: unknown) {
      const command = retractBalanceCommandSchema.parse(input);
      await store.retractObservation({
        id: command.retractionId,
        observationId: command.observationId,
      });
    },

    async recordYnabBalance(input: unknown): Promise<YnabBalanceRecordOutcome> {
      const command = recordYnabBalanceCommandSchema.parse(input);
      requireAllowedDate(command.observedOn, {
        accountId: command.accountId,
        source: "ynab_export",
        accountSourceId: command.accountSourceId,
      });
      return store.recordYnabObservation({
        id: command.observationId,
        accountId: command.accountId,
        observedOn: command.observedOn,
        amount: command.amount,
        currency: "USD",
        source: "ynab_export",
        accountSourceId: command.accountSourceId,
        exportDigest: command.exportDigest,
        supersedesObservationId: null,
      });
    },

    listCurrentBalances: () => store.listCurrentBalances(),

    async dashboard(): Promise<BalanceDashboard> {
      const [accounts, balances] = await Promise.all([
        store.listAccounts(),
        store.listCurrentBalances(),
      ]);
      return buildBalanceDashboard(
        accounts,
        balances,
        utcTimestampSchema.parse(clock()),
      );
    },
  };
}

export type BalanceObservationService = ReturnType<
  typeof createBalanceObservationService
>;
