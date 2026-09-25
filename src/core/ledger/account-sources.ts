import { z } from "zod";

import {
  accountSourceIdSchema,
  accountSourceLinkRevisionIdSchema,
  accountIdSchema,
  type AccountId,
  type AccountSourceId,
  type AccountSourceLinkRevisionId,
} from "./identifiers";
import {
  createAccountCommandSchema,
  prepareNewAccount,
  type NewAccount,
} from "./destinations";
import { utcTimestampSchema, type UtcTimestamp } from "./timestamps";

export const accountSourceNameSchema = z.enum([
  "ynab",
  "manual_csv",
  "simplefin",
  "teller",
  "schwab",
  "snaptrade",
]);
export const accountSourceKindSchema = z.enum(["import", "connector"]);
export const accountSourceLinkStatusSchema = z.enum(["linked", "unlinked"]);
export const accountSourceLinkReasonSchema = z.enum([
  "initial_mapping",
  "user_unlinked",
  "mapping_correction_unlinked",
  "mapping_correction_linked",
  "source_reassociated",
]);

const registerAccountSourceFields = {
  accountSourceId: accountSourceIdSchema,
  source: accountSourceNameSchema,
  sourceKind: accountSourceKindSchema,
  ingestedAt: utcTimestampSchema,
};

export const registerAccountSourceCommandSchema = z.strictObject(
  registerAccountSourceFields,
);

const initialLinkFields = {
  linkRevisionId: accountSourceLinkRevisionIdSchema,
  accountId: accountIdSchema,
};

export const registerAndLinkAccountSourceCommandSchema = z.strictObject({
  ...registerAccountSourceFields,
  ...initialLinkFields,
});

export const createAccountAndLinkSourceCommandSchema = z.strictObject({
  account: createAccountCommandSchema,
  source: registerAccountSourceCommandSchema,
  linkRevisionId: accountSourceLinkRevisionIdSchema,
});

export const unlinkAccountSourceCommandSchema = z.strictObject({
  linkRevisionId: accountSourceLinkRevisionIdSchema,
  accountSourceId: accountSourceIdSchema,
  accountId: accountIdSchema,
  supersedesLinkRevisionId: accountSourceLinkRevisionIdSchema,
  reasonCode: z.enum(["user_unlinked", "mapping_correction_unlinked"]),
});

export const linkUnlinkedAccountSourceCommandSchema = z.strictObject({
  linkRevisionId: accountSourceLinkRevisionIdSchema,
  accountSourceId: accountSourceIdSchema,
  accountId: accountIdSchema,
  supersedesLinkRevisionId: accountSourceLinkRevisionIdSchema,
  reasonCode: z.enum(["mapping_correction_linked", "source_reassociated"]),
});

export const relinkAccountSourceCommandSchema = z.strictObject({
  unlinkRevisionId: accountSourceLinkRevisionIdSchema,
  linkRevisionId: accountSourceLinkRevisionIdSchema,
  accountSourceId: accountSourceIdSchema,
  previousAccountId: accountIdSchema,
  accountId: accountIdSchema,
  supersedesLinkRevisionId: accountSourceLinkRevisionIdSchema,
  unlinkReasonCode: z.literal("mapping_correction_unlinked"),
  linkReasonCode: z.enum(["mapping_correction_linked", "source_reassociated"]),
});

export type AccountSourceKind = z.infer<typeof accountSourceKindSchema>;
export type AccountSourceName = z.infer<typeof accountSourceNameSchema>;
export type AccountSourceLinkStatus = z.infer<
  typeof accountSourceLinkStatusSchema
>;
export type AccountSourceLinkReason = z.infer<
  typeof accountSourceLinkReasonSchema
>;
export type RegisterAccountSourceCommand = z.infer<
  typeof registerAccountSourceCommandSchema
>;

const accountSourceTimeSchema = z
  .strictObject({
    ingestedAt: utcTimestampSchema,
    recordedAt: utcTimestampSchema,
  })
  .refine(
    ({ ingestedAt, recordedAt }) =>
      new Date(ingestedAt).getTime() <= new Date(recordedAt).getTime(),
    { message: "Account source cannot be ingested after it is recorded" },
  );

export interface NewAccountSource {
  id: AccountSourceId;
  source: AccountSourceName;
  sourceKind: AccountSourceKind;
  ingestedAt: UtcTimestamp;
}

export interface NewAccountSourceLinkRevision {
  id: AccountSourceLinkRevisionId;
  accountSourceId: AccountSourceId;
  accountId: AccountId;
  status: AccountSourceLinkStatus;
  supersedesLinkRevisionId: AccountSourceLinkRevisionId | null;
  reasonCode: AccountSourceLinkReason;
}

export interface CurrentAccountSourceLink {
  accountSourceId: AccountSourceId;
  source: AccountSourceName;
  sourceKind: AccountSourceKind;
  accountId: AccountId;
  linkRevisionId: AccountSourceLinkRevisionId;
  reasonCode: AccountSourceLinkReason;
  recordedAt: UtcTimestamp;
}

export interface AccountSourceLinkRevision {
  id: AccountSourceLinkRevisionId;
  accountSourceId: AccountSourceId;
  accountId: AccountId;
  status: AccountSourceLinkStatus;
  supersedesLinkRevisionId: AccountSourceLinkRevisionId | null;
  reasonCode: AccountSourceLinkReason;
  recordedAt: UtcTimestamp;
}

export interface AccountLinkState {
  linkage: "offline" | "import_only" | "live_linked";
  multipleSources: boolean;
}

export function deriveAccountLinkState(
  sources: readonly Pick<CurrentAccountSourceLink, "sourceKind">[],
): AccountLinkState {
  return {
    linkage:
      sources.length === 0
        ? "offline"
        : sources.some((source) => source.sourceKind === "connector")
          ? "live_linked"
          : "import_only",
    multipleSources: sources.length > 1,
  };
}

export interface AccountSourceLinkStore {
  registerAccountSource(source: NewAccountSource): Promise<void>;
  registerAndLinkAccountSource(
    source: NewAccountSource,
    link: NewAccountSourceLinkRevision,
  ): Promise<void>;
  createAccountAndLinkSource(
    account: NewAccount,
    source: NewAccountSource,
    link: NewAccountSourceLinkRevision,
  ): Promise<void>;
  appendLinkRevision(revision: NewAccountSourceLinkRevision): Promise<void>;
  appendRelinkRevisions(
    unlink: NewAccountSourceLinkRevision,
    link: NewAccountSourceLinkRevision,
  ): Promise<void>;
  resolveCurrentAccount(
    accountSourceId: AccountSourceId,
  ): Promise<CurrentAccountSourceLink | null>;
  listCurrentSources(
    accountId: AccountId,
  ): Promise<readonly CurrentAccountSourceLink[]>;
  listLinkHistory(
    accountSourceId: AccountSourceId,
  ): Promise<readonly AccountSourceLinkRevision[]>;
}

export class AccountSourceConflictError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AccountSourceConflictError";
  }
}

export class AccountSourceReferenceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AccountSourceReferenceError";
  }
}

export class AccountSourcePersistenceError extends Error {
  constructor(operation: string, options?: ErrorOptions) {
    super(`Account-source operation failed: ${operation}`, options);
    this.name = "AccountSourcePersistenceError";
  }
}

function newAccountSource(
  command: RegisterAccountSourceCommand,
  recordedAt: UtcTimestamp,
): NewAccountSource {
  accountSourceTimeSchema.parse({ ingestedAt: command.ingestedAt, recordedAt });
  return {
    id: command.accountSourceId,
    source: command.source,
    sourceKind: command.sourceKind,
    ingestedAt: command.ingestedAt,
  };
}

function initialLink(
  accountSourceId: AccountSourceId,
  accountId: AccountId,
  linkRevisionId: AccountSourceLinkRevisionId,
): NewAccountSourceLinkRevision {
  return {
    id: linkRevisionId,
    accountSourceId,
    accountId,
    status: "linked",
    supersedesLinkRevisionId: null,
    reasonCode: "initial_mapping",
  };
}

export function createAccountSourceLinkService(
  store: AccountSourceLinkStore,
  clock: () => UtcTimestamp,
) {
  return {
    async registerAccountSource(input: unknown) {
      const command = registerAccountSourceCommandSchema.parse(input);
      const recordedAt = utcTimestampSchema.parse(clock());
      await store.registerAccountSource(newAccountSource(command, recordedAt));
      return { id: command.accountSourceId };
    },

    async registerAndLinkAccountSource(input: unknown) {
      const command = registerAndLinkAccountSourceCommandSchema.parse(input);
      const recordedAt = utcTimestampSchema.parse(clock());
      const source = newAccountSource(command, recordedAt);
      await store.registerAndLinkAccountSource(
        source,
        initialLink(source.id, command.accountId, command.linkRevisionId),
      );
      return { id: source.id };
    },

    async createAccountAndLinkSource(input: unknown) {
      const command = createAccountAndLinkSourceCommandSchema.parse(input);
      const effectiveAt = utcTimestampSchema.parse(clock());
      const source = newAccountSource(command.source, effectiveAt);
      await store.createAccountAndLinkSource(
        prepareNewAccount(command.account, effectiveAt),
        source,
        initialLink(
          source.id,
          command.account.accountId,
          command.linkRevisionId,
        ),
      );
      return {
        accountId: command.account.accountId,
        accountSourceId: source.id,
      };
    },

    async unlinkAccountSource(input: unknown) {
      const command = unlinkAccountSourceCommandSchema.parse(input);
      await store.appendLinkRevision({
        id: command.linkRevisionId,
        accountSourceId: command.accountSourceId,
        accountId: command.accountId,
        status: "unlinked",
        supersedesLinkRevisionId: command.supersedesLinkRevisionId,
        reasonCode: command.reasonCode,
      });
    },

    async linkUnlinkedAccountSource(input: unknown) {
      const command = linkUnlinkedAccountSourceCommandSchema.parse(input);
      await store.appendLinkRevision({
        id: command.linkRevisionId,
        accountSourceId: command.accountSourceId,
        accountId: command.accountId,
        status: "linked",
        supersedesLinkRevisionId: command.supersedesLinkRevisionId,
        reasonCode: command.reasonCode,
      });
    },

    async relinkAccountSource(input: unknown) {
      const command = relinkAccountSourceCommandSchema.parse(input);
      const unlink: NewAccountSourceLinkRevision = {
        id: command.unlinkRevisionId,
        accountSourceId: command.accountSourceId,
        accountId: command.previousAccountId,
        status: "unlinked",
        supersedesLinkRevisionId: command.supersedesLinkRevisionId,
        reasonCode: command.unlinkReasonCode,
      };
      const link: NewAccountSourceLinkRevision = {
        id: command.linkRevisionId,
        accountSourceId: command.accountSourceId,
        accountId: command.accountId,
        status: "linked",
        supersedesLinkRevisionId: command.unlinkRevisionId,
        reasonCode: command.linkReasonCode,
      };
      await store.appendRelinkRevisions(unlink, link);
    },

    resolveCurrentAccount(input: unknown) {
      return store.resolveCurrentAccount(accountSourceIdSchema.parse(input));
    },

    listCurrentSources(input: unknown) {
      return store.listCurrentSources(accountIdSchema.parse(input));
    },

    listLinkHistory(input: unknown) {
      return store.listLinkHistory(accountSourceIdSchema.parse(input));
    },
  };
}

export type AccountSourceLinkService = ReturnType<
  typeof createAccountSourceLinkService
>;
