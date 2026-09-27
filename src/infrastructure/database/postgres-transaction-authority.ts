// Superseded by RFC 0008; retired with its tables by RFC 0008's first plan.
// Do not build on it.
import { sql } from "drizzle-orm";
import { z } from "zod";

import {
  accountIdSchema,
  accountSourceIdSchema,
  accountSourceKindSchema,
  accountSourceNameSchema,
  authorityReasonCodeSchema,
  authorityRevisionIdSchema,
  authorityStatusSchema,
  authorityWindowIdSchema,
  calendarDateSchema,
  enteredDecimalAmountSchema,
  providerBalanceSemanticSchema,
  rawPayloadIdSchema,
  reconciliationCheckIdSchema,
  reconciliationResultSchema,
  TransactionAuthorityConflictError,
  TransactionAuthorityPersistenceError,
  TransactionAuthorityReferenceError,
  usdCurrencySchema,
  utcTimestampSchema,
  type AuthorityRevision,
  type NewAuthorityRevision,
  type NewReconciliationCheck,
  type ReconciliationCheck,
  type TransactionAuthorityErrorContext,
  type TransactionAuthorityStore,
} from "../../core/ledger";
import type { MeridianDatabase } from "./client";
import {
  executeRows,
  postgresErrorCode,
  type SqlExecutor,
} from "./postgres-account-sources";

// PostgreSQL renders NUMERIC in plain notation; canonicalize exactly.
const numericSchema = z.string().pipe(enteredDecimalAmountSchema);
const timestampSchema = z
  .union([z.string(), z.date()])
  .transform((value) =>
    utcTimestampSchema.parse(new Date(value).toISOString()),
  );

const revisionRowSchema = z.object({
  id: authorityRevisionIdSchema,
  authority_window_id: authorityWindowIdSchema,
  account_id: accountIdSchema,
  account_source_id: accountSourceIdSchema,
  starts_on: calendarDateSchema,
  ends_on: calendarDateSchema.nullable(),
  status: authorityStatusSchema,
  supersedes_revision_id: authorityRevisionIdSchema.nullable(),
  reason_code: authorityReasonCodeSchema,
  reconciliation_check_id: reconciliationCheckIdSchema.nullable(),
  recorded_at: timestampSchema,
});

const checkRowSchema = z.object({
  id: reconciliationCheckIdSchema,
  account_id: accountIdSchema,
  account_source_id: accountSourceIdSchema,
  cutoff_on: calendarDateSchema,
  observation_starts_on: calendarDateSchema,
  observation_ends_on: calendarDateSchema,
  ledger_balance: numericSchema,
  provider_balance: numericSchema,
  currency: usdCurrencySchema,
  balance_semantic: providerBalanceSemanticSchema,
  difference: numericSchema,
  tolerance: numericSchema.nullable(),
  result: reconciliationResultSchema,
  raw_payload_id: rawPayloadIdSchema.nullable(),
  recorded_at: timestampSchema,
});

const revisionColumns = sql`
  id, authority_window_id, account_id, account_source_id,
  starts_on::text as starts_on, ends_on::text as ends_on, status,
  supersedes_revision_id, reason_code, reconciliation_check_id, recorded_at
`;

const checkColumns = sql`
  id, account_id, account_source_id, cutoff_on::text as cutoff_on,
  observation_starts_on::text as observation_starts_on,
  observation_ends_on::text as observation_ends_on,
  ledger_balance::text as ledger_balance,
  provider_balance::text as provider_balance, currency, balance_semantic,
  difference::text as difference, tolerance::text as tolerance, result,
  raw_payload_id, recorded_at
`;

function toRevision(input: unknown): AuthorityRevision {
  const row = revisionRowSchema.parse(input);
  return {
    id: row.id,
    authorityWindowId: row.authority_window_id,
    accountId: row.account_id,
    accountSourceId: row.account_source_id,
    startsOn: row.starts_on,
    endsOn: row.ends_on,
    status: row.status,
    supersedesRevisionId: row.supersedes_revision_id,
    reasonCode: row.reason_code,
    reconciliationCheckId: row.reconciliation_check_id,
    recordedAt: row.recorded_at,
  };
}

function toCheck(input: unknown): ReconciliationCheck {
  const row = checkRowSchema.parse(input);
  return {
    id: row.id,
    accountId: row.account_id,
    accountSourceId: row.account_source_id,
    cutoffOn: row.cutoff_on,
    observationStartsOn: row.observation_starts_on,
    observationEndsOn: row.observation_ends_on,
    ledgerBalance: row.ledger_balance,
    providerBalance: row.provider_balance,
    currency: row.currency,
    balanceSemantic: row.balance_semantic,
    difference: row.difference,
    tolerance: row.tolerance,
    result: row.result,
    rawPayloadId: row.raw_payload_id,
    recordedAt: row.recorded_at,
  };
}

function errorMessage(error: unknown): string | undefined {
  let current = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (typeof current !== "object" || current === null) return undefined;
    if (
      "code" in current &&
      "message" in current &&
      typeof current.message === "string"
    ) {
      return current.message;
    }
    if (!("cause" in current)) return undefined;
    current = current.cause;
  }
  return undefined;
}

function mapPersistenceError(
  operation: string,
  context: TransactionAuthorityErrorContext,
  error: unknown,
): never {
  if (
    error instanceof TransactionAuthorityConflictError ||
    error instanceof TransactionAuthorityReferenceError
  ) {
    throw error;
  }
  const code = postgresErrorCode(error);
  // The trigger messages carry no account names, so they are safe context.
  const detail = errorMessage(error);
  if (code === "23503") {
    throw new TransactionAuthorityReferenceError(
      `${operation} references a missing ledger identity${detail ? `: ${detail}` : ""}`,
      context,
      { cause: error },
    );
  }
  if (
    code === "23505" ||
    code === "23514" ||
    code === "40001" ||
    code === "40P01"
  ) {
    throw new TransactionAuthorityConflictError(
      `${operation} conflicts with recorded ledger state${detail ? `: ${detail}` : ""}`,
      context,
      { cause: error },
    );
  }
  throw new TransactionAuthorityPersistenceError(operation, context, {
    cause: error,
  });
}

async function findRevision(
  executor: SqlExecutor,
  id: string,
): Promise<AuthorityRevision | null> {
  const rows = await executeRows<Record<string, unknown>>(
    executor,
    sql`
      select ${revisionColumns}
      from ledger.transaction_authority_revisions where id = ${id}
    `,
  );
  return rows[0] ? toRevision(rows[0]) : null;
}

async function findCheck(
  executor: SqlExecutor,
  id: string,
): Promise<ReconciliationCheck | null> {
  const rows = await executeRows<Record<string, unknown>>(
    executor,
    sql`select ${checkColumns} from ledger.reconciliation_checks where id = ${id}`,
  );
  return rows[0] ? toCheck(rows[0]) : null;
}

function sameRevision(
  recorded: AuthorityRevision,
  revision: NewAuthorityRevision,
): boolean {
  return (
    recorded.authorityWindowId === revision.authorityWindowId &&
    recorded.accountId === revision.accountId &&
    recorded.accountSourceId === revision.accountSourceId &&
    recorded.startsOn === revision.startsOn &&
    recorded.endsOn === revision.endsOn &&
    recorded.status === revision.status &&
    recorded.supersedesRevisionId === revision.supersedesRevisionId &&
    recorded.reasonCode === revision.reasonCode &&
    recorded.reconciliationCheckId === revision.reconciliationCheckId
  );
}

export function createPostgresTransactionAuthorityStore(
  database: MeridianDatabase,
): TransactionAuthorityStore {
  return {
    async findAccountSource(accountSourceId) {
      const rows = await executeRows<Record<string, unknown>>(
        database,
        sql`
          select id, source, source_kind from ledger.account_sources
          where id = ${accountSourceId}
        `,
      );
      if (!rows[0]) return null;
      const row = z
        .object({
          id: accountSourceIdSchema,
          source: accountSourceNameSchema,
          source_kind: accountSourceKindSchema,
        })
        .parse(rows[0]);
      return { id: row.id, source: row.source, sourceKind: row.source_kind };
    },

    findRevision: (id) => findRevision(database, id),

    async appendRevision(revision) {
      const context = {
        accountId: revision.accountId,
        accountSourceId: revision.accountSourceId,
        authorityWindowId: revision.authorityWindowId,
        revisionId: revision.id,
      };
      try {
        return await database.transaction(async (transaction) => {
          const recorded = await findRevision(transaction, revision.id);
          if (recorded) {
            if (!sameRevision(recorded, revision)) {
              throw new TransactionAuthorityConflictError(
                "Authority revision replay conflicts with the recorded revision",
                context,
              );
            }
            return "replayed" as const;
          }
          await transaction.execute(sql`
            insert into ledger.transaction_authority_revisions (
              id, authority_window_id, account_id, account_source_id,
              starts_on, ends_on, status, supersedes_revision_id, reason_code,
              reconciliation_check_id
            ) values (
              ${revision.id}, ${revision.authorityWindowId},
              ${revision.accountId}, ${revision.accountSourceId},
              ${revision.startsOn}, ${revision.endsOn}, ${revision.status},
              ${revision.supersedesRevisionId}, ${revision.reasonCode},
              ${revision.reconciliationCheckId}
            )
          `);
          return "recorded" as const;
        });
      } catch (error) {
        mapPersistenceError(
          `Authority ${revision.status} revision`,
          context,
          error,
        );
      }
    },

    async listCurrentWindows(accountId) {
      const rows = await executeRows<Record<string, unknown>>(
        database,
        sql`
          select revision_id as id, authority_window_id, account_id,
            account_source_id, starts_on::text as starts_on,
            ends_on::text as ends_on, status, supersedes_revision_id,
            reason_code, reconciliation_check_id, recorded_at
          from ledger.current_transaction_authority_windows
          where account_id = ${accountId}
          order by starts_on, authority_window_id
        `,
      );
      return rows.map(toRevision);
    },

    async ledgerBalanceBefore(accountId, cutoffOn) {
      const rows = await executeRows<{ balance: string }>(
        database,
        sql`
          select coalesce(sum(entry.amount), 0)::text as balance
          from ledger.entries entry
          join ledger.transactions txn on txn.id = entry.transaction_id
          where entry.account_id = ${accountId}
            and txn.occurred_on < ${cutoffOn}
        `,
      );
      return numericSchema.parse(rows[0]?.balance);
    },

    async recordReconciliationCheck(check: NewReconciliationCheck) {
      const context = {
        accountId: check.accountId,
        accountSourceId: check.accountSourceId,
        reconciliationCheckId: check.id,
      };
      try {
        return await database.transaction(async (transaction) => {
          if (await findCheck(transaction, check.id)) {
            return "replayed" as const;
          }
          // ledger_balance and difference are set by the insert trigger.
          await transaction.execute(sql`
            insert into ledger.reconciliation_checks (
              id, account_id, account_source_id, cutoff_on,
              observation_starts_on, observation_ends_on, provider_balance,
              currency, balance_semantic, tolerance, result, raw_payload_id
            ) values (
              ${check.id}, ${check.accountId}, ${check.accountSourceId},
              ${check.cutoffOn}, ${check.observationStartsOn},
              ${check.observationEndsOn}, ${check.providerBalance}::numeric,
              ${check.currency}, ${check.balanceSemantic},
              ${check.tolerance}::numeric, ${check.result},
              ${check.rawPayloadId}
            )
          `);
          return "recorded" as const;
        });
      } catch (error) {
        mapPersistenceError("Reconciliation check", context, error);
      }
    },

    findReconciliationCheck: (id) => findCheck(database, id),
  };
}
