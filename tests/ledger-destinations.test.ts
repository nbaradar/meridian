import { randomUUID } from "node:crypto";

import { describe, expect, test } from "vitest";

import {
  createLedgerDestinationService,
  utcTimestampSchema,
  type CurrentCategory,
  type CurrentAccount,
  type LedgerDestinationStore,
  type NewAccount,
  type NewCategory,
} from "../src/core/ledger";

class FakeDestinationStore implements LedgerDestinationStore {
  accounts: NewAccount[] = [];
  categories: NewCategory[] = [];
  currentAccounts: CurrentAccount[] = [];
  currentCategories: CurrentCategory[] = [];

  async createAccount(account: NewAccount) {
    this.accounts.push(account);
  }

  async createCategory(category: NewCategory) {
    this.categories.push(category);
  }

  async listCategories() {
    return this.currentCategories;
  }

  async listAccounts() {
    return this.currentAccounts;
  }
}

const now = utcTimestampSchema.parse("2026-08-02T12:00:00Z");

describe("ledger destination service", () => {
  test("creates an account with controlled initial metadata", async () => {
    const store = new FakeDestinationStore();
    const service = createLedgerDestinationService(store, () => now);
    const accountId = randomUUID();
    const revisionId = randomUUID();

    await expect(
      service.createAccount({
        accountId,
        revisionId,
        name: "  Primary checking  ",
        accountType: "checking",
        accountClass: null,
        openedOn: "2024-06-15",
      }),
    ).resolves.toEqual({ id: accountId });
    expect(store.accounts).toEqual([
      {
        id: accountId,
        accountType: "checking",
        accountClass: "asset",
        currency: "USD",
        openedOn: "2024-06-15",
        revision: {
          id: revisionId,
          name: "Primary checking",
          status: "active",
          displayMetadata: {},
          effectiveAt: now,
        },
      },
    ]);
  });

  test("creates a category with an optional parent", async () => {
    const store = new FakeDestinationStore();
    const service = createLedgerDestinationService(store, () => now);
    const categoryId = randomUUID();
    const revisionId = randomUUID();
    const parentCategoryId = randomUUID();

    await service.createCategory({
      categoryId,
      revisionId,
      name: "Groceries",
      kind: "expense",
      parentCategoryId,
    });

    expect(store.categories[0]).toEqual({
      id: categoryId,
      kind: "expense",
      revision: {
        id: revisionId,
        name: "Groceries",
        parentCategoryId,
        effectiveAt: now,
      },
    });
  });

  test("rejects invalid commands before persistence", async () => {
    const store = new FakeDestinationStore();
    const service = createLedgerDestinationService(store, () => now);

    await expect(
      service.createAccount({
        accountId: randomUUID(),
        revisionId: randomUUID(),
        name: "",
        accountType: "checking",
        accountClass: null,
        openedOn: null,
      }),
    ).rejects.toBeDefined();
    await expect(
      service.createCategory({
        categoryId: randomUUID(),
        revisionId: randomUUID(),
        name: "Category",
        kind: "budget-envelope",
        parentCategoryId: null,
      }),
    ).rejects.toBeDefined();
    expect(store.accounts).toHaveLength(0);
    expect(store.categories).toHaveLength(0);
  });

  test.each([
    ["checking", "asset"],
    ["savings", "asset"],
    ["cash", "asset"],
    ["brokerage", "asset"],
    ["retirement", "asset"],
    ["crypto", "asset"],
    ["credit_card", "liability"],
    ["loan", "liability"],
    ["mortgage", "liability"],
  ] as const)("derives %s as %s", async (accountType, accountClass) => {
    const store = new FakeDestinationStore();
    const service = createLedgerDestinationService(store, () => now);
    await service.createAccount({
      accountId: randomUUID(),
      revisionId: randomUUID(),
      name: "Derived account",
      accountType,
      accountClass: null,
      openedOn: null,
    });

    expect(store.accounts[0]?.accountClass).toBe(accountClass);
  });

  test("requires an explicit class only for other accounts", async () => {
    const store = new FakeDestinationStore();
    const service = createLedgerDestinationService(store, () => now);

    await expect(
      service.createAccount({
        accountId: randomUUID(),
        revisionId: randomUUID(),
        name: "Other account",
        accountType: "other",
        accountClass: null,
        openedOn: null,
      }),
    ).rejects.toBeDefined();
    await expect(
      service.createAccount({
        accountId: randomUUID(),
        revisionId: randomUUID(),
        name: "Other liability",
        accountType: "other",
        accountClass: "liability",
        openedOn: null,
      }),
    ).resolves.toBeDefined();
  });

  test("returns current categories without adding presentation policy", async () => {
    const store = new FakeDestinationStore();
    store.currentCategories = [
      {
        id: randomUUID() as CurrentCategory["id"],
        name: "Income",
        kind: "income",
        parentCategoryId: null,
      },
    ];
    const service = createLedgerDestinationService(store, () => now);

    await expect(service.listCategories()).resolves.toBe(
      store.currentCategories,
    );
  });
});
