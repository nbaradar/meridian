import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import {
  AccountSourceConflictError,
  AccountSourcePersistenceError,
  AccountSourceReferenceError,
  accountSourceKindSchema,
  accountSourceLinkReasonSchema,
  accountSourceLinkStatusSchema,
  accountSourceNameSchema,
  type AccountSourceLinkStore,
  type NewAccountSource,
  type NewAccountSourceLinkRevision,
} from "../../core/ledger/account-sources";
import {
  accountIdSchema,
  accountSourceIdSchema,
  accountSourceLinkRevisionIdSchema,
} from "../../core/ledger/identifiers";
import type { NewAccount } from "../../core/ledger/destinations";
import { utcTimestampSchema } from "../../core/ledger/timestamps";
import type { MeridianDatabase } from "./client";

export interface SqlExecutor {
  execute(query: SQL): PromiseLike<unknown>;
}

export async function executeRows<TResult>(
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

const currentLinkRowSchema = z.object({
  account_source_id: accountSourceIdSchema,
  source: accountSourceNameSchema,
  source_kind: accountSourceKindSchema,
  account_id: accountIdSchema,
  link_revision_id: accountSourceLinkRevisionIdSchema,
  reason_code: accountSourceLinkReasonSchema,
  recorded_at: timestampResultSchema,
});

const historyRowSchema = z.object({
  id: accountSourceLinkRevisionIdSchema,
  account_source_id: accountSourceIdSchema,
  account_id: accountIdSchema,
  status: accountSourceLinkStatusSchema,
  supersedes_link_revision_id: accountSourceLinkRevisionIdSchema.nullable(),
  reason_code: accountSourceLinkReasonSchema,
  recorded_at: timestampResultSchema,
});

export function postgresErrorCode(error: unknown): string | undefined {
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

export async function insertAccountSource(
  executor: SqlExecutor,
  source: NewAccountSource,
): Promise<void> {
  await executor.execute(sql`
    insert into ledger.account_sources (id, source, source_kind, ingested_at)
    values (${source.id}, ${source.source}, ${source.sourceKind}, ${source.ingestedAt})
    on conflict (id) do nothing
  `);
  const rows = await executeRows<{ matches: boolean }>(
    executor,
    sql`
    select (
      source = ${source.source}
      and source_kind = ${source.sourceKind}
      and ingested_at = ${source.ingestedAt}::timestamptz
    ) as matches
    from ledger.account_sources
    where id = ${source.id}
  `,
  );
  if (rows[0]?.matches !== true) {
    throw new AccountSourceConflictError(
      "Account-source identity replay conflicts with the recorded identity",
    );
  }
}

export async function insertLinkRevision(
  executor: SqlExecutor,
  revision: NewAccountSourceLinkRevision,
): Promise<void> {
  const existing = await executeRows<{ matches: boolean }>(
    executor,
    sql`
    select (
      account_source_id = ${revision.accountSourceId}
      and account_id = ${revision.accountId}
      and status = ${revision.status}
      and supersedes_link_revision_id is not distinct from ${revision.supersedesLinkRevisionId}::uuid
      and reason_code = ${revision.reasonCode}
    ) as matches
    from ledger.account_source_link_revisions
    where id = ${revision.id}
  `,
  );
  if (existing[0]) {
    if (existing[0].matches !== true) {
      throw new AccountSourceConflictError(
        "Account-source link command replay conflicts with the recorded decision",
      );
    }
    return;
  }

  await executor.execute(sql`
    insert into ledger.account_source_link_revisions (
      id, account_source_id, account_id, status,
      supersedes_link_revision_id, reason_code
    ) values (
      ${revision.id}, ${revision.accountSourceId}, ${revision.accountId},
      ${revision.status}, ${revision.supersedesLinkRevisionId}, ${revision.reasonCode}
    )
    on conflict do nothing
  `);
  const inserted = await executeRows<{ matches: boolean }>(
    executor,
    sql`
    select (
      account_source_id = ${revision.accountSourceId}
      and account_id = ${revision.accountId}
      and status = ${revision.status}
      and supersedes_link_revision_id is not distinct from ${revision.supersedesLinkRevisionId}::uuid
      and reason_code = ${revision.reasonCode}
    ) as matches
    from ledger.account_source_link_revisions
    where id = ${revision.id}
  `,
  );
  if (inserted[0]?.matches !== true) {
    throw new AccountSourceConflictError(
      "Account-source link decision conflicts with current link history",
    );
  }
}

export async function insertAccount(
  executor: SqlExecutor,
  account: NewAccount,
): Promise<boolean> {
  const created = await executeRows<{ id: string }>(
    executor,
    sql`
    insert into ledger.accounts (id, kind, type, currency, opened_on)
    values (
      ${account.id}, ${account.accountClass}, ${account.accountType},
      ${account.currency}, ${account.openedOn}
    )
    on conflict (id) do nothing
    returning id
  `,
  );
  const accounts = await executeRows<{ matches: boolean }>(
    executor,
    sql`
    select (
      kind = ${account.accountClass}
      and type = ${account.accountType}
      and currency = ${account.currency}
      and opened_on is not distinct from ${account.openedOn}::date
    ) as matches
    from ledger.accounts
    where id = ${account.id}
  `,
  );
  if (accounts[0]?.matches !== true) {
    throw new AccountSourceConflictError(
      "Canonical account replay conflicts with the recorded identity",
    );
  }

  const existingRevisions = await executeRows<{ matches: boolean }>(
    executor,
    sql`
      select (
        account_id = ${account.id}
        and name = ${account.revision.name}
        and status = ${account.revision.status}
        and display_metadata = ${JSON.stringify(account.revision.displayMetadata)}::jsonb
      ) as matches
      from ledger.account_revisions
      where id = ${account.revision.id}
    `,
  );
  if (created.length === 0) {
    if (existingRevisions[0]?.matches !== true) {
      throw new AccountSourceConflictError(
        "Create-and-link cannot add a new revision to an existing canonical account",
      );
    }
    return false;
  }
  if (existingRevisions[0]) {
    throw new AccountSourceConflictError(
      "Canonical account revision ID already belongs to recorded metadata",
    );
  }

  await executor.execute(sql`
    insert into ledger.account_revisions (
      id, account_id, name, status, display_metadata, effective_at
    ) values (
      ${account.revision.id}, ${account.id}, ${account.revision.name},
      ${account.revision.status}, ${JSON.stringify(account.revision.displayMetadata)}::jsonb,
      ${account.revision.effectiveAt}
    )
  `);
  return true;
}

async function verifyCreateAndLinkReplay(
  executor: SqlExecutor,
  source: NewAccountSource,
  link: NewAccountSourceLinkRevision,
): Promise<void> {
  const sources = await executeRows<{ matches: boolean }>(
    executor,
    sql`
    select (
      source = ${source.source}
      and source_kind = ${source.sourceKind}
      and ingested_at = ${source.ingestedAt}::timestamptz
    ) as matches
    from ledger.account_sources
    where id = ${source.id}
  `,
  );
  const links = await executeRows<{ matches: boolean }>(
    executor,
    sql`
    select (
      account_source_id = ${link.accountSourceId}
      and account_id = ${link.accountId}
      and status = ${link.status}
      and supersedes_link_revision_id is not distinct from ${link.supersedesLinkRevisionId}::uuid
      and reason_code = ${link.reasonCode}
    ) as matches
    from ledger.account_source_link_revisions
    where id = ${link.id}
  `,
  );
  if (sources[0]?.matches !== true || links[0]?.matches !== true) {
    throw new AccountSourceConflictError(
      "Existing canonical account requires the explicit link-existing flow",
    );
  }
}

function mapPersistenceError(operation: string, error: unknown): never {
  if (error instanceof AccountSourceConflictError) throw error;
  const code = postgresErrorCode(error);
  if (code === "23503") {
    throw new AccountSourceReferenceError(
      `Account-source ${operation} references a missing ledger identity`,
      { cause: error },
    );
  }
  if (code === "23505" || code === "23514") {
    throw new AccountSourceConflictError(
      `Account-source ${operation} conflicts with recorded ledger state`,
      { cause: error },
    );
  }
  throw new AccountSourcePersistenceError(operation, { cause: error });
}

export function createPostgresAccountSourceLinkStore(
  database: MeridianDatabase,
): AccountSourceLinkStore {
  return {
    async registerAccountSource(source) {
      try {
        await database.transaction((transaction) =>
          insertAccountSource(transaction, source),
        );
      } catch (error) {
        mapPersistenceError("register source", error);
      }
    },

    async registerAndLinkAccountSource(source, link) {
      try {
        await database.transaction(async (transaction) => {
          await insertAccountSource(transaction, source);
          await insertLinkRevision(transaction, link);
        });
      } catch (error) {
        mapPersistenceError("register and link source", error);
      }
    },

    async createAccountAndLinkSource(account, source, link) {
      try {
        await database.transaction(async (transaction) => {
          const created = await insertAccount(transaction, account);
          if (!created) {
            await verifyCreateAndLinkReplay(transaction, source, link);
            return;
          }
          await insertAccountSource(transaction, source);
          await insertLinkRevision(transaction, link);
        });
      } catch (error) {
        mapPersistenceError("create account and link source", error);
      }
    },

    async appendLinkRevision(revision) {
      try {
        await database.transaction((transaction) =>
          insertLinkRevision(transaction, revision),
        );
      } catch (error) {
        mapPersistenceError("append link revision", error);
      }
    },

    async appendRelinkRevisions(unlink, link) {
      try {
        await database.transaction(async (transaction) => {
          await insertLinkRevision(transaction, unlink);
          await insertLinkRevision(transaction, link);
        });
      } catch (error) {
        mapPersistenceError("relink source", error);
      }
    },

    async resolveCurrentAccount(accountSourceId) {
      try {
        const rows = await executeRows<Record<string, unknown>>(
          database,
          sql`
          select account_source_id, source, source_kind, account_id,
            link_revision_id, reason_code, recorded_at
          from ledger.current_account_source_links
          where account_source_id = ${accountSourceId}
        `,
        );
        if (!rows[0]) return null;
        const row = currentLinkRowSchema.parse(rows[0]);
        return {
          accountSourceId: row.account_source_id,
          source: row.source,
          sourceKind: row.source_kind,
          accountId: row.account_id,
          linkRevisionId: row.link_revision_id,
          reasonCode: row.reason_code,
          recordedAt: row.recorded_at,
        };
      } catch (error) {
        mapPersistenceError("resolve current account", error);
      }
    },

    async listCurrentSources(accountId) {
      try {
        const rows = await executeRows<Record<string, unknown>>(
          database,
          sql`
          select account_source_id, source, source_kind, account_id,
            link_revision_id, reason_code, recorded_at
          from ledger.current_account_source_links
          where account_id = ${accountId}
          order by source_kind, source, account_source_id
        `,
        );
        return rows.map((input) => {
          const row = currentLinkRowSchema.parse(input);
          return {
            accountSourceId: row.account_source_id,
            source: row.source,
            sourceKind: row.source_kind,
            accountId: row.account_id,
            linkRevisionId: row.link_revision_id,
            reasonCode: row.reason_code,
            recordedAt: row.recorded_at,
          };
        });
      } catch (error) {
        mapPersistenceError("list current sources", error);
      }
    },

    async listLinkHistory(accountSourceId) {
      try {
        const rows = await executeRows<Record<string, unknown>>(
          database,
          sql`
            with recursive link_history as (
              select revision.*, 0 as depth
              from ledger.account_source_link_revisions revision
              where revision.account_source_id = ${accountSourceId}
                and revision.supersedes_link_revision_id is null

              union all

              select successor.*, predecessor.depth + 1
              from ledger.account_source_link_revisions successor
              join link_history predecessor
                on successor.supersedes_link_revision_id = predecessor.id
            )
            select id, account_source_id, account_id, status,
              supersedes_link_revision_id, reason_code, recorded_at
            from link_history
            order by depth
          `,
        );
        return rows.map((input) => {
          const row = historyRowSchema.parse(input);
          return {
            id: row.id,
            accountSourceId: row.account_source_id,
            accountId: row.account_id,
            status: row.status,
            supersedesLinkRevisionId: row.supersedes_link_revision_id,
            reasonCode: row.reason_code,
            recordedAt: row.recorded_at,
          };
        });
      } catch (error) {
        mapPersistenceError("list link history", error);
      }
    },
  };
}
