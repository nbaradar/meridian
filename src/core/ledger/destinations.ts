import { z } from "zod";

import {
  accountIdSchema,
  accountRevisionIdSchema,
  categoryIdSchema,
  categoryRevisionIdSchema,
} from "./identifiers";
import {
  calendarDateSchema,
  utcTimestampSchema,
  type UtcTimestamp,
} from "./timestamps";

export const accountClassSchema = z.enum(["asset", "liability"]);
export const accountTypeSchema = z.enum([
  "checking",
  "savings",
  "cash",
  "credit_card",
  "loan",
  "mortgage",
  "brokerage",
  "retirement",
  "crypto",
  "other",
]);
export const accountStatusSchema = z.enum(["active", "closed"]);
export const categoryKindSchema = z.enum(["expense", "income", "transfer"]);
export const openedOnSchema = calendarDateSchema;

const accountCreationDetailsFields = {
  name: z.string().trim().min(1),
  accountType: accountTypeSchema,
  accountClass: accountClassSchema.nullable(),
  openedOn: openedOnSchema.nullable(),
};

function refineAccountClassification(
  command: { accountType: AccountType; accountClass: AccountClass | null },
  context: z.RefinementCtx,
) {
  if (command.accountType === "other" && command.accountClass === null) {
    context.addIssue({
      code: "custom",
      message: "Other accounts require an accounting class",
      path: ["accountClass"],
    });
  }
  if (command.accountType !== "other" && command.accountClass !== null) {
    context.addIssue({
      code: "custom",
      message: "Accounting class is derived from account type",
      path: ["accountClass"],
    });
  }
}

export const accountCreationDetailsSchema = z
  .strictObject(accountCreationDetailsFields)
  .superRefine(refineAccountClassification);

export const createAccountCommandSchema = z
  .strictObject({
    accountId: accountIdSchema,
    revisionId: accountRevisionIdSchema,
    ...accountCreationDetailsFields,
  })
  .superRefine(refineAccountClassification);

export const createCategoryCommandSchema = z.strictObject({
  categoryId: categoryIdSchema,
  revisionId: categoryRevisionIdSchema,
  name: z.string().trim().min(1),
  kind: categoryKindSchema,
  parentCategoryId: categoryIdSchema.nullable(),
});

export type AccountClass = z.infer<typeof accountClassSchema>;
export type AccountType = z.infer<typeof accountTypeSchema>;
export type AccountStatus = z.infer<typeof accountStatusSchema>;
export type CategoryKind = z.infer<typeof categoryKindSchema>;
export type OpenedOn = z.infer<typeof openedOnSchema>;
export type CreateAccountCommand = z.infer<typeof createAccountCommandSchema>;
export type CreateCategoryCommand = z.infer<typeof createCategoryCommandSchema>;

export interface NewAccount {
  id: CreateAccountCommand["accountId"];
  accountType: AccountType;
  accountClass: AccountClass;
  currency: "USD";
  openedOn: OpenedOn | null;
  revision: {
    id: CreateAccountCommand["revisionId"];
    name: string;
    status: "active";
    displayMetadata: Record<string, never>;
    effectiveAt: UtcTimestamp;
  };
}

export interface NewCategory {
  id: CreateCategoryCommand["categoryId"];
  kind: CategoryKind;
  revision: {
    id: CreateCategoryCommand["revisionId"];
    name: string;
    parentCategoryId: CreateCategoryCommand["parentCategoryId"];
    effectiveAt: UtcTimestamp;
  };
}

export interface CurrentCategory {
  id: CreateCategoryCommand["categoryId"];
  name: string;
  kind: CategoryKind;
  parentCategoryId: CreateCategoryCommand["parentCategoryId"];
}

export interface CurrentAccount {
  id: CreateAccountCommand["accountId"];
  name: string;
  accountType: AccountType;
  accountClass: AccountClass;
  currency: "USD";
  openedOn: OpenedOn | null;
  status: AccountStatus;
}

export interface LedgerDestinationStore {
  createAccount(account: NewAccount): Promise<void>;
  createCategory(category: NewCategory): Promise<void>;
  listAccounts(): Promise<readonly CurrentAccount[]>;
  listCategories(): Promise<readonly CurrentCategory[]>;
}

export function prepareNewAccount(
  command: CreateAccountCommand,
  effectiveAt: UtcTimestamp,
): NewAccount {
  return {
    id: command.accountId,
    accountType: command.accountType,
    accountClass: deriveAccountClass(command.accountType, command.accountClass),
    currency: "USD",
    openedOn: command.openedOn,
    revision: {
      id: command.revisionId,
      name: command.name,
      status: "active",
      displayMetadata: {},
      effectiveAt,
    },
  };
}

export class LedgerDestinationConflictError extends Error {
  constructor(destination: "account" | "category", options?: ErrorOptions) {
    super(`The ${destination} already exists`, options);
    this.name = "LedgerDestinationConflictError";
  }
}

export class LedgerDestinationReferenceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LedgerDestinationReferenceError";
  }
}

export class LedgerDestinationPersistenceError extends Error {
  constructor(operation: string, options?: ErrorOptions) {
    super(`Ledger destination operation failed: ${operation}`, options);
    this.name = "LedgerDestinationPersistenceError";
  }
}

export function deriveAccountClass(
  accountType: AccountType,
  otherClass: AccountClass | null,
): AccountClass {
  if (accountType === "other") {
    if (otherClass === null) {
      throw new Error("Other accounts require an accounting class");
    }
    return otherClass;
  }
  if (
    accountType === "credit_card" ||
    accountType === "loan" ||
    accountType === "mortgage"
  ) {
    return "liability";
  }
  return "asset";
}

export function createLedgerDestinationService(
  store: LedgerDestinationStore,
  clock: () => UtcTimestamp,
) {
  return {
    async createAccount(input: unknown) {
      const command = createAccountCommandSchema.parse(input);
      const effectiveAt = utcTimestampSchema.parse(clock());
      const account = prepareNewAccount(command, effectiveAt);
      await store.createAccount(account);
      return { id: account.id };
    },

    async createCategory(input: unknown) {
      const command = createCategoryCommandSchema.parse(input);
      const effectiveAt = utcTimestampSchema.parse(clock());
      const category: NewCategory = {
        id: command.categoryId,
        kind: command.kind,
        revision: {
          id: command.revisionId,
          name: command.name,
          parentCategoryId: command.parentCategoryId,
          effectiveAt,
        },
      };
      await store.createCategory(category);
      return { id: category.id };
    },

    listAccounts: () => store.listAccounts(),
    listCategories: () => store.listCategories(),
  };
}

export type LedgerDestinationService = ReturnType<
  typeof createLedgerDestinationService
>;
