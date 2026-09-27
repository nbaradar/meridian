import { sql } from "drizzle-orm";
import { z } from "zod";

import {
  accountIdSchema,
  BalanceObservationConflictError,
  balanceObservationIdSchema,
  BalanceObservationPersistenceError,
  BalanceObservationReferenceError,
  balanceObservationSourceSchema,
  calendarDateSchema,
  enteredDecimalAmountSchema,
  usdCurrencySchema,
  utcTimestampSchema,
  type BalanceObservationErrorContext,
  type BalanceObservationStore,
  type NewBalanceObservation,
} from "../../core/ledger";
import type { MeridianDatabase } from "./client";
import {
  constraintName,
  executeRows,
  postgresErrorCode,
  type SqlExecutor,
} from "./postgres-account-sources";
import { createPostgresLedgerDestinationStore } from "./postgres-ledger-destinations";

const currentBalanceRowSchema = z.object({
  observation_id: balanceObservationIdSchema,
  account_id: accountIdSchema,
  observed_on: calendarDateSchema,
  // PostgreSQL renders NUMERIC in plain notation; canonicalize exactly.
  amount: z.string().pipe(enteredDecimalAmountSchema),
  currency: usdCurrencySchema,
  source: balanceObservationSourceSchema,
  recorded_at: z
    .union([z.string(), z.date()])
    .transform((value) =>
      utcTimestampSchema.parse(new Date(value).toISOString()),
    ),
});

const exportUniqueConstraint = "balance_observations_export_unique";

// Owner-facing explanations for the database rules in migration 0012.
const conflictMessages: Readonly<Record<string, string>> = {
  balance_observations_account_currency_check:
    "The balance currency must match the account currency",
  balance_observations_source_kind_check:
    "A YNAB balance must come from a YNAB account source",
  balance_observations_source_linked_check:
    "The YNAB source is not currently linked to this account",
  balance_observations_same_account_check:
    "A correction must belong to the same account as the balance it corrects",
  balance_observations_superseded_check:
    "This balance was already corrected; reload to see the current one",
  balance_observations_supersedes_unique:
    "This balance was already corrected; reload to see the current one",
  balance_observations_retracted_check:
    "This balance was retracted; reload to see the current one",
  balance_observation_retractions_superseded_check:
    "This balance was already corrected; reload to see the current one",
  balance_observation_retractions_observation_unique:
    "This balance was already retracted",
};

function mapPersistenceError(
  operation: string,
  context: BalanceObservationErrorContext,
  error: unknown,
): never {
  const code = postgresErrorCode(error);
  const constraint = constraintName(error);
  if (code === "23503") {
    throw new BalanceObservationReferenceError(
      "The balance references a missing account, source, or observation",
      context,
      { cause: error },
    );
  }
  if (code === "23514" || code === "23505") {
    throw new BalanceObservationConflictError(
      (constraint && conflictMessages[constraint]) ??
        "The balance conflicts with recorded ledger state",
      context,
      { cause: error },
    );
  }
  throw new BalanceObservationPersistenceError(operation, context, {
    cause: error,
  });
}

function observationContext(
  observation: NewBalanceObservation,
): BalanceObservationErrorContext {
  return {
    accountId: observation.accountId,
    source: observation.source,
    accountSourceId: observation.accountSourceId,
    observationId: observation.id,
  };
}

async function insertObservation(
  executor: SqlExecutor,
  observation: NewBalanceObservation,
): Promise<void> {
  await executor.execute(sql`
    insert into ledger.balance_observations (
      id, account_id, observed_on, amount, currency, source,
      account_source_id, export_digest, supersedes_observation_id
    ) values (
      ${observation.id}, ${observation.accountId}, ${observation.observedOn},
      ${observation.amount}::numeric, ${observation.currency},
      ${observation.source}, ${observation.accountSourceId},
      ${observation.exportDigest}, ${observation.supersedesObservationId}
    )
  `);
}

export function createPostgresBalanceObservationStore(
  database: MeridianDatabase,
): BalanceObservationStore {
  const destinations = createPostgresLedgerDestinationStore(database);
  return {
    async findAccount(accountId) {
      const accounts = await destinations.listAccounts();
      return accounts.find((account) => account.id === accountId) ?? null;
    },

    listAccounts: () => destinations.listAccounts(),

    async listCurrentBalances() {
      try {
        const rows = await executeRows<Record<string, unknown>>(
          database,
          sql`
            select observation_id, account_id, observed_on::text as observed_on,
              amount::text as amount, currency, source, recorded_at
            from ledger.current_balances
            order by account_id
          `,
        );
        return rows.map((input) => {
          const row = currentBalanceRowSchema.parse(input);
          return {
            observationId: row.observation_id,
            accountId: row.account_id,
            observedOn: row.observed_on,
            amount: row.amount,
            currency: row.currency,
            source: row.source,
            recordedAt: row.recorded_at,
          };
        });
      } catch (error) {
        throw new BalanceObservationPersistenceError(
          "list current balances",
          { accountId: null, source: null },
          { cause: error },
        );
      }
    },

    async recordObservation(observation) {
      try {
        await insertObservation(database, observation);
      } catch (error) {
        mapPersistenceError(
          "record balance",
          observationContext(observation),
          error,
        );
      }
    },

    async recordYnabObservation(observation) {
      try {
        return await database.transaction(async (transaction) => {
          const existing = await executeRows<{ id: string }>(
            transaction,
            sql`
              select id from ledger.balance_observations
              where account_source_id = ${observation.accountSourceId}
                and export_digest = ${observation.exportDigest}
            `,
          );
          if (existing.length > 0) return "already_saved" as const;
          await insertObservation(transaction, observation);
          return "recorded" as const;
        });
      } catch (error) {
        // A concurrent save of the same export won the unique constraint.
        if (
          postgresErrorCode(error) === "23505" &&
          constraintName(error) === exportUniqueConstraint
        ) {
          return "already_saved";
        }
        mapPersistenceError(
          "record YNAB balance",
          observationContext(observation),
          error,
        );
      }
    },

    async retractObservation(retraction) {
      try {
        await database.execute(sql`
          insert into ledger.balance_observation_retractions (id, observation_id)
          values (${retraction.id}, ${retraction.observationId})
        `);
      } catch (error) {
        mapPersistenceError(
          "retract balance",
          {
            accountId: null,
            source: null,
            observationId: retraction.observationId,
          },
          error,
        );
      }
    },
  };
}
