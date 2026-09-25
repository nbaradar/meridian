import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { afterAll, describe, expect, test } from "vitest";

import {
  createLedgerDestinationService,
  LedgerDestinationConflictError,
  LedgerDestinationReferenceError,
  utcTimestampSchema,
} from "../../src/core/ledger";
import { createDatabase } from "../../src/infrastructure/database/client";
import { createPostgresLedgerDestinationStore } from "../../src/infrastructure/database/postgres-ledger-destinations";

const connection = createDatabase();
const store = createPostgresLedgerDestinationStore(connection.database);
const now = utcTimestampSchema.parse("2026-08-02T18:00:00Z");
const service = createLedgerDestinationService(store, () => now);

afterAll(async () => {
  await connection.close();
});

describe("PostgreSQL ledger destination adapter", () => {
  test("atomically creates and reads an account with a date-only opening", async () => {
    const accountId = randomUUID();
    await service.createAccount({
      accountId,
      revisionId: randomUUID(),
      name: "Integration savings",
      accountType: "savings",
      accountClass: null,
      openedOn: "2023-11-04",
    });

    const accounts = await service.listAccounts();
    expect(accounts).toContainEqual({
      id: accountId,
      name: "Integration savings",
      accountType: "savings",
      accountClass: "asset",
      currency: "USD",
      openedOn: "2023-11-04",
      status: "active",
    });
  });

  test("creates and reads a category hierarchy", async () => {
    const parentCategoryId = randomUUID();
    const childCategoryId = randomUUID();
    await service.createCategory({
      categoryId: parentCategoryId,
      revisionId: randomUUID(),
      name: "Integration household",
      kind: "expense",
      parentCategoryId: null,
    });
    await service.createCategory({
      categoryId: childCategoryId,
      revisionId: randomUUID(),
      name: "Integration groceries",
      kind: "expense",
      parentCategoryId,
    });

    const categories = await service.listCategories();
    expect(categories).toContainEqual({
      id: childCategoryId,
      name: "Integration groceries",
      kind: "expense",
      parentCategoryId,
    });
  });

  test("rolls back category identity when its parent is missing", async () => {
    const categoryId = randomUUID();
    await expect(
      service.createCategory({
        categoryId,
        revisionId: randomUUID(),
        name: "Invalid child",
        kind: "expense",
        parentCategoryId: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(LedgerDestinationReferenceError);

    const rows = await connection.database.execute<{ count: string }>(sql`
      select count(*)::text as count
      from ledger.categories
      where id = ${categoryId}
    `);
    expect(rows[0]?.count).toBe("0");
  });

  test("returns a domain conflict for duplicate destination identity", async () => {
    const command = {
      accountId: randomUUID(),
      revisionId: randomUUID(),
      name: "Duplicate integration account",
      accountType: "credit_card",
      accountClass: null,
      openedOn: null,
    } as const;
    await service.createAccount(command);

    await expect(service.createAccount(command)).rejects.toBeInstanceOf(
      LedgerDestinationConflictError,
    );
  });
});
