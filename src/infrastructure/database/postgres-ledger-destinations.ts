import { sql } from "drizzle-orm";
import { z } from "zod";

import {
  accountClassSchema,
  accountIdSchema,
  accountStatusSchema,
  accountTypeSchema,
  calendarDateSchema,
  categoryIdSchema,
  categoryKindSchema,
  LedgerDestinationConflictError,
  LedgerDestinationPersistenceError,
  LedgerDestinationReferenceError,
  type LedgerDestinationStore,
} from "../../core/ledger";
import type { MeridianDatabase } from "./client";
import {
  accountRevisions,
  accounts,
  categories,
  categoryRevisions,
} from "./schema";

const currentAccountRowSchema = z.object({
  id: accountIdSchema,
  name: z.string().min(1),
  account_class: accountClassSchema,
  account_type: accountTypeSchema,
  currency: z.literal("USD"),
  opened_on: calendarDateSchema.nullable(),
  status: accountStatusSchema,
});

const currentCategoryRowSchema = z.object({
  id: categoryIdSchema,
  name: z.string().min(1),
  kind: categoryKindSchema,
  parent_category_id: categoryIdSchema.nullable(),
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

export function createPostgresLedgerDestinationStore(
  database: MeridianDatabase,
): LedgerDestinationStore {
  return {
    async createAccount(account) {
      try {
        await database.transaction(async (transaction) => {
          await transaction.insert(accounts).values({
            id: account.id,
            accountClass: account.accountClass,
            accountType: account.accountType,
            currency: account.currency,
            openedOn: account.openedOn,
          });
          await transaction.insert(accountRevisions).values({
            id: account.revision.id,
            accountId: account.id,
            name: account.revision.name,
            status: account.revision.status,
            displayMetadata: account.revision.displayMetadata,
            effectiveAt: account.revision.effectiveAt,
          });
        });
      } catch (error) {
        if (postgresErrorCode(error) === "23505") {
          throw new LedgerDestinationConflictError("account", { cause: error });
        }
        throw new LedgerDestinationPersistenceError("create account", {
          cause: error,
        });
      }
    },

    async createCategory(category) {
      try {
        await database.transaction(async (transaction) => {
          await transaction.insert(categories).values({
            id: category.id,
            kind: category.kind,
          });
          await transaction.insert(categoryRevisions).values({
            id: category.revision.id,
            categoryId: category.id,
            parentCategoryId: category.revision.parentCategoryId,
            name: category.revision.name,
            effectiveAt: category.revision.effectiveAt,
          });
        });
      } catch (error) {
        if (postgresErrorCode(error) === "23503") {
          throw new LedgerDestinationReferenceError(
            "The parent category does not exist",
            { cause: error },
          );
        }
        if (postgresErrorCode(error) === "23505") {
          throw new LedgerDestinationConflictError("category", {
            cause: error,
          });
        }
        throw new LedgerDestinationPersistenceError("create category", {
          cause: error,
        });
      }
    },

    async listAccounts() {
      try {
        const result = await database.execute<{
          id: string;
          name: string;
          account_class: string;
          account_type: string;
          currency: string;
          opened_on: string | null;
          status: string;
        }>(sql`
          select
            id,
            name,
            class as account_class,
            type as account_type,
            currency,
            opened_on,
            status
          from ledger.current_accounts
          where name is not null
          order by name, id
        `);
        return result.map((row) => {
          const parsed = currentAccountRowSchema.parse(row);
          return {
            id: parsed.id,
            name: parsed.name,
            accountClass: parsed.account_class,
            accountType: parsed.account_type,
            currency: parsed.currency,
            openedOn: parsed.opened_on,
            status: parsed.status,
          };
        });
      } catch (error) {
        throw new LedgerDestinationPersistenceError("list accounts", {
          cause: error,
        });
      }
    },

    async listCategories() {
      try {
        const result = await database.execute<{
          id: string;
          name: string;
          kind: string;
          parent_category_id: string | null;
        }>(sql`
          select id, name, kind, parent_category_id
          from ledger.current_categories
          where name is not null
          order by name, id
        `);
        return result.map((row) => {
          const parsed = currentCategoryRowSchema.parse(row);
          return {
            id: parsed.id,
            name: parsed.name,
            kind: parsed.kind,
            parentCategoryId: parsed.parent_category_id,
          };
        });
      } catch (error) {
        throw new LedgerDestinationPersistenceError("list categories", {
          cause: error,
        });
      }
    },
  };
}
