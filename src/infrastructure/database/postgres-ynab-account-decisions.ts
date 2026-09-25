import { sql } from "drizzle-orm";
import { z } from "zod";

import {
  AccountSourceConflictError,
  AccountSourcePersistenceError,
  AccountSourceReferenceError,
} from "../../core/ledger/account-sources";
import { accountTypeSchema } from "../../core/ledger/destinations";
import {
  accountIdSchema,
  accountSourceIdSchema,
} from "../../core/ledger/identifiers";
import { utcTimestampSchema } from "../../core/ledger/timestamps";
import {
  YnabAccountAlreadyDecidedError,
  ynabAccountDecisionIdSchema,
  ynabLabelDigestSchema,
  type CurrentYnabAccountDecision,
  type NewYnabAccountDecision,
  type YnabAccountDecisionStore,
  type YnabLabelDigest,
} from "../../modules/ynab/account-decisions";
import type { MeridianDatabase } from "./client";
import {
  executeRows,
  insertAccount,
  insertAccountSource,
  insertLinkRevision,
  postgresErrorCode,
  type SqlExecutor,
} from "./postgres-account-sources";

const decisionRowSchema = z.object({
  id: ynabAccountDecisionIdSchema,
  digest_key_id: ynabLabelDigestSchema.shape.digestKeyId,
  label_digest: ynabLabelDigestSchema.shape.labelDigest,
  decision: z.enum(["tracked", "excluded"]),
  account_source_id: accountSourceIdSchema.nullable(),
  recorded_at: z
    .union([z.string(), z.date()])
    .transform((value) =>
      utcTimestampSchema.parse(new Date(value).toISOString()),
    ),
  account_id: accountIdSchema.nullable(),
  account_name: z.string().nullable(),
  account_type: accountTypeSchema.nullable(),
});

// Current decisions with the account each tracked source links to now.
const currentDecisionsQuery = sql`
  select decision.id, decision.digest_key_id, decision.label_digest,
    decision.decision, decision.account_source_id, decision.recorded_at,
    account.id as account_id, account.name as account_name,
    account.type as account_type
  from ledger.current_ynab_account_decisions decision
  left join ledger.current_account_source_links link
    on link.account_source_id = decision.account_source_id
  left join ledger.current_accounts account on account.id = link.account_id
`;

function toCurrentDecision(input: unknown): CurrentYnabAccountDecision {
  const row = decisionRowSchema.parse(input);
  const base = {
    id: row.id,
    digestKeyId: row.digest_key_id,
    labelDigest: row.label_digest,
    recordedAt: row.recorded_at,
  };
  if (row.decision === "excluded") {
    return {
      ...base,
      decision: "excluded",
      accountSourceId: null,
      account: null,
    };
  }
  if (!row.account_source_id) {
    throw new AccountSourceConflictError(
      "Tracked YNAB decision has no account source",
    );
  }
  return {
    ...base,
    decision: "tracked",
    accountSourceId: row.account_source_id,
    account:
      row.account_id && row.account_name && row.account_type
        ? {
            id: row.account_id,
            name: row.account_name,
            accountType: row.account_type,
          }
        : null,
  };
}

async function lockLabel(
  executor: SqlExecutor,
  digest: YnabLabelDigest,
): Promise<void> {
  await executor.execute(
    sql`select ledger.lock_ynab_account_label(${digest.digestKeyId}, ${digest.labelDigest})`,
  );
}

/** True when this exact decision was already recorded (a replay). */
async function isReplay(
  executor: SqlExecutor,
  decision: NewYnabAccountDecision,
): Promise<boolean> {
  const rows = await executeRows<{ matches: boolean }>(
    executor,
    sql`
      select (
        digest_key_id = ${decision.digestKeyId}
        and label_digest = ${decision.labelDigest}
        and decision = ${decision.decision}
        and account_source_id is not distinct from ${decision.accountSourceId}::uuid
        and supersedes_decision_id is not distinct from ${decision.supersedesDecisionId}::uuid
      ) as matches
      from ledger.ynab_account_decisions
      where id = ${decision.id}
    `,
  );
  if (!rows[0]) return false;
  if (rows[0].matches !== true) {
    throw new AccountSourceConflictError(
      "YNAB decision replay conflicts with the recorded decision",
    );
  }
  return true;
}

async function requireExpectedTip(
  executor: SqlExecutor,
  decision: NewYnabAccountDecision,
): Promise<void> {
  const rows = await executeRows<{ id: string }>(
    executor,
    sql`
      select id from ledger.current_ynab_account_decisions
      where digest_key_id = ${decision.digestKeyId}
        and label_digest = ${decision.labelDigest}
    `,
  );
  if ((rows[0]?.id ?? null) !== decision.supersedesDecisionId) {
    throw new YnabAccountAlreadyDecidedError(
      "This YNAB account was already decided by another save",
    );
  }
}

async function insertDecision(
  executor: SqlExecutor,
  decision: NewYnabAccountDecision,
): Promise<void> {
  await executor.execute(sql`
    insert into ledger.ynab_account_decisions (
      id, label_digest, digest_key_id, decision, account_source_id,
      supersedes_decision_id
    ) values (
      ${decision.id}, ${decision.labelDigest}, ${decision.digestKeyId},
      ${decision.decision}, ${decision.accountSourceId},
      ${decision.supersedesDecisionId}
    )
  `);
}

function mapPersistenceError(error: unknown): never {
  if (
    error instanceof YnabAccountAlreadyDecidedError ||
    error instanceof AccountSourceConflictError
  ) {
    throw error;
  }
  const code = postgresErrorCode(error);
  if (code === "23505") {
    throw new YnabAccountAlreadyDecidedError(
      "This YNAB account was already decided by another save",
      { cause: error },
    );
  }
  if (code === "23503") {
    throw new AccountSourceReferenceError(
      "YNAB decision references a missing ledger identity",
      { cause: error },
    );
  }
  if (code === "23514") {
    throw new AccountSourceConflictError(
      "YNAB decision conflicts with recorded ledger state",
      { cause: error },
    );
  }
  throw new AccountSourcePersistenceError("save YNAB account decision", {
    cause: error,
  });
}

export function createPostgresYnabAccountDecisionStore(
  database: MeridianDatabase,
): YnabAccountDecisionStore {
  return {
    async findCurrentDecisions(digests) {
      if (digests.length === 0) return [];
      // Key IDs cannot contain ":", so the joined form is unambiguous.
      const keys = digests.map(
        (digest) => sql`${`${digest.digestKeyId}:${digest.labelDigest}`}`,
      );
      const rows = await executeRows<Record<string, unknown>>(
        database,
        sql`
          ${currentDecisionsQuery}
          where decision.digest_key_id || ':' || decision.label_digest
            in (${sql.join(keys, sql`, `)})
        `,
      );
      return rows.map(toCurrentDecision);
    },

    async listTrackedDecisions() {
      const rows = await executeRows<Record<string, unknown>>(
        database,
        sql`
          ${currentDecisionsQuery}
          where decision.decision = 'tracked'
          order by account.name, decision.account_source_id
        `,
      );
      return rows.map(toCurrentDecision);
    },

    async saveDecision(write) {
      try {
        await database.transaction(async (transaction) => {
          // Label lock first, then account-source locks via link triggers.
          await lockLabel(transaction, write.decision);
          if (await isReplay(transaction, write.decision)) return;
          await requireExpectedTip(transaction, write.decision);

          if (write.kind === "create_account") {
            const created = await insertAccount(transaction, write.account);
            if (!created) {
              throw new AccountSourceConflictError(
                "YNAB create decision cannot reuse an existing account ID",
              );
            }
          }
          if (
            write.kind === "create_account" ||
            write.kind === "link_account"
          ) {
            await insertAccountSource(transaction, write.source);
            await insertLinkRevision(transaction, write.link);
          }
          await insertDecision(transaction, write.decision);
        });
      } catch (error) {
        mapPersistenceError(error);
      }
    },
  };
}
