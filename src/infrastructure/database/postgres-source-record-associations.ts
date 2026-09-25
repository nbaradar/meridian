import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import {
  SourceRecordAssociationConflictError,
  SourceRecordAssociationPersistenceError,
  SourceRecordAssociationReferenceError,
  sourceRecordAccountRoleSchema,
  type NewSourceRecordAccountSetMember,
  type NewSourceRecordAccountSetRevision,
  type SourceRecordAccountSetRevision,
  type SourceRecordAssociationStore,
} from "../../core/ledger/source-record-associations";
import {
  accountSetRevisionIdSchema,
  accountSourceIdSchema,
  accountSourceLinkRevisionIdSchema,
  sourceRecordIdSchema,
  type SourceRecordId,
} from "../../core/ledger/identifiers";
import { utcTimestampSchema } from "../../core/ledger/timestamps";
import type { MeridianDatabase } from "./client";

interface SqlExecutor {
  execute(query: SQL): PromiseLike<unknown>;
}

async function executeRows<TResult>(
  executor: SqlExecutor,
  query: SQL,
): Promise<TResult[]> {
  return (await executor.execute(query)) as TResult[];
}

const timestampResultSchema = z
  .union([z.string(), z.date()])
  .transform((value) =>
    utcTimestampSchema.parse(new Date(value).toISOString()),
  );

const associationRowSchema = z.object({
  id: accountSetRevisionIdSchema,
  source_record_id: sourceRecordIdSchema,
  supersedes_account_set_revision_id: accountSetRevisionIdSchema.nullable(),
  member_count: z.number().int().positive(),
  recorded_at: timestampResultSchema,
  account_source_id: accountSourceIdSchema,
  link_revision_id: accountSourceLinkRevisionIdSchema,
  role: sourceRecordAccountRoleSchema,
  depth: z.number().int().nonnegative().optional(),
});

function postgresErrorCode(error: unknown): string | undefined {
  let current = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (typeof current !== "object" || current === null) return undefined;
    if ("code" in current && typeof current.code === "string") {
      return current.code;
    }
    if (!("cause" in current)) return undefined;
    current = current.cause;
  }
  return undefined;
}

function mapPersistenceError(operation: string, error: unknown): never {
  if (
    error instanceof SourceRecordAssociationConflictError ||
    error instanceof SourceRecordAssociationReferenceError
  ) {
    throw error;
  }
  const code = postgresErrorCode(error);
  if (code === "23503") {
    throw new SourceRecordAssociationReferenceError(
      `Source-record association ${operation} references a missing ledger identity`,
      { cause: error },
    );
  }
  if (
    code === "23505" ||
    code === "23514" ||
    code === "40001" ||
    code === "40P01"
  ) {
    throw new SourceRecordAssociationConflictError(
      `Source-record association ${operation} conflicts with recorded ledger state`,
      { cause: error },
    );
  }
  throw new SourceRecordAssociationPersistenceError(operation, {
    cause: error,
  });
}

function memberIdentity(member: NewSourceRecordAccountSetMember): string {
  return `${member.accountSourceId}:${member.linkRevisionId}:${member.role}`;
}

async function verifyReplay(
  executor: SqlExecutor,
  revision: NewSourceRecordAccountSetRevision,
  members: readonly NewSourceRecordAccountSetMember[],
): Promise<void> {
  const rows = await executeRows<Record<string, unknown>>(
    executor,
    sql`
      select account_set.id, account_set.source_record_id,
        account_set.supersedes_account_set_revision_id, account_set.member_count,
        account_set.recorded_at, member.account_source_id,
        member.link_revision_id, member.role
      from ledger.source_record_account_sets account_set
      join ledger.source_record_accounts member
        on member.account_set_revision_id = account_set.id
      where account_set.id = ${revision.id}
      order by member.account_source_id
    `,
  );
  const parsed = rows.map((row) => associationRowSchema.parse(row));
  const first = parsed[0];
  const expectedMembers = members.map(memberIdentity).sort();
  const recordedMembers = parsed
    .map((row) =>
      memberIdentity({
        accountSetRevisionId: row.id,
        accountSourceId: row.account_source_id,
        linkRevisionId: row.link_revision_id,
        role: row.role,
      }),
    )
    .sort();
  if (
    !first ||
    first.source_record_id !== revision.sourceRecordId ||
    first.supersedes_account_set_revision_id !==
      revision.supersedesAccountSetRevisionId ||
    first.member_count !== revision.memberCount ||
    revision.memberCount !== members.length ||
    expectedMembers.length !== recordedMembers.length ||
    expectedMembers.some((member, index) => member !== recordedMembers[index])
  ) {
    throw new SourceRecordAssociationConflictError(
      "Source-record association replay conflicts with the recorded account set",
    );
  }
}

async function insertAssociationRevision(
  executor: SqlExecutor,
  revision: NewSourceRecordAccountSetRevision,
  members: readonly NewSourceRecordAccountSetMember[],
): Promise<void> {
  const orderedMembers = [...members].sort((left, right) =>
    left.accountSourceId.localeCompare(right.accountSourceId),
  );
  if (
    revision.memberCount !== members.length ||
    members.length === 0 ||
    orderedMembers.some((member) => member.accountSetRevisionId !== revision.id)
  ) {
    throw new SourceRecordAssociationConflictError(
      "Source-record association members do not match their sealed revision",
    );
  }
  const inserted = await executeRows<{ id: string }>(
    executor,
    sql`
      insert into ledger.source_record_account_sets (
        id, source_record_id, supersedes_account_set_revision_id, member_count
      ) values (
        ${revision.id}, ${revision.sourceRecordId},
        ${revision.supersedesAccountSetRevisionId}, ${revision.memberCount}
      )
      on conflict do nothing
      returning id
    `,
  );
  if (inserted.length === 0) {
    await verifyReplay(executor, revision, orderedMembers);
    return;
  }

  await executor.execute(sql`
    insert into ledger.source_record_accounts (
      account_set_revision_id, account_source_id, link_revision_id, role
    ) values ${sql.join(
      orderedMembers.map(
        (member) =>
          sql`(${member.accountSetRevisionId}, ${member.accountSourceId}, ${member.linkRevisionId}, ${member.role})`,
      ),
      sql`, `,
    )}
  `);
}

function rowsToRevisions(
  inputs: readonly Record<string, unknown>[],
): SourceRecordAccountSetRevision[] {
  const revisions: Array<
    SourceRecordAccountSetRevision & {
      members: NewSourceRecordAccountSetMember[];
    }
  > = [];
  for (const input of inputs) {
    const row = associationRowSchema.parse(input);
    const current = revisions.at(-1);
    const member = {
      accountSetRevisionId: row.id,
      accountSourceId: row.account_source_id,
      linkRevisionId: row.link_revision_id,
      role: row.role,
    };
    if (current?.id === row.id) {
      current.members.push(member);
      continue;
    }
    revisions.push({
      id: row.id,
      sourceRecordId: row.source_record_id,
      supersedesAccountSetRevisionId: row.supersedes_account_set_revision_id,
      memberCount: row.member_count,
      recordedAt: row.recorded_at,
      members: [member],
    });
  }
  for (const revision of revisions) {
    if (revision.members.length !== revision.memberCount) {
      throw new Error(
        `Account-set revision ${revision.id} has an invalid sealed member count`,
      );
    }
  }
  return revisions;
}

const associationColumns = sql`
  account_set.id, account_set.source_record_id,
  account_set.supersedes_account_set_revision_id, account_set.member_count,
  account_set.recorded_at, member.account_source_id,
  member.link_revision_id, member.role
`;

export function createPostgresSourceRecordAssociationStore(
  database: MeridianDatabase,
): SourceRecordAssociationStore {
  return {
    async appendAssociationRevision(revision, members) {
      try {
        await database.transaction((transaction) =>
          insertAssociationRevision(transaction, revision, members),
        );
      } catch (error) {
        mapPersistenceError("append revision", error);
      }
    },

    async resolveCurrentSet(sourceRecordId) {
      try {
        const rows = await executeRows<Record<string, unknown>>(
          database,
          sql`
            select ${associationColumns}
            from ledger.current_source_record_account_sets account_set
            join ledger.source_record_accounts member
              on member.account_set_revision_id = account_set.id
            where account_set.source_record_id = ${sourceRecordId}
            order by member.account_source_id
          `,
        );
        if (rows.length === 0) return null;
        const revisions = rowsToRevisions(rows);
        if (revisions.length !== 1) {
          throw new Error(
            `Source record ${sourceRecordId} has multiple current account sets`,
          );
        }
        return revisions[0] ?? null;
      } catch (error) {
        mapPersistenceError("resolve current set", error);
      }
    },

    async listHistory(sourceRecordId: SourceRecordId) {
      try {
        const rows = await executeRows<Record<string, unknown>>(
          database,
          sql`
            with recursive account_set_history as (
              select account_set.*, 0 as depth
              from ledger.source_record_account_sets account_set
              where account_set.source_record_id = ${sourceRecordId}
                and account_set.supersedes_account_set_revision_id is null

              union all

              select successor.*, predecessor.depth + 1
              from ledger.source_record_account_sets successor
              join account_set_history predecessor
                on successor.supersedes_account_set_revision_id = predecessor.id
            )
            select ${associationColumns}, account_set.depth
            from account_set_history account_set
            join ledger.source_record_accounts member
              on member.account_set_revision_id = account_set.id
            order by account_set.depth, member.account_source_id
          `,
        );
        return rowsToRevisions(rows);
      } catch (error) {
        mapPersistenceError("list history", error);
      }
    },
  };
}
