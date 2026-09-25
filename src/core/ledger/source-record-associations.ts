import { z } from "zod";

import {
  accountSetRevisionIdSchema,
  accountSourceIdSchema,
  accountSourceLinkRevisionIdSchema,
  sourceRecordIdSchema,
  type AccountSetRevisionId,
  type AccountSourceId,
  type AccountSourceLinkRevisionId,
  type SourceRecordId,
} from "./identifiers";
import type { UtcTimestamp } from "./timestamps";

export const sourceRecordAccountRoleSchema = z.literal("observed_account");

const accountSetMemberCommandSchema = z.strictObject({
  accountSourceId: accountSourceIdSchema,
  linkRevisionId: accountSourceLinkRevisionIdSchema,
});

const accountSetCommandFields = {
  accountSetRevisionId: accountSetRevisionIdSchema,
  sourceRecordId: sourceRecordIdSchema,
  members: z.array(accountSetMemberCommandSchema).min(1),
};

export const sealInitialSourceRecordAccountSetCommandSchema = z.strictObject({
  ...accountSetCommandFields,
});

export const correctSourceRecordAccountSetCommandSchema = z
  .strictObject({
    ...accountSetCommandFields,
    supersedesAccountSetRevisionId: accountSetRevisionIdSchema,
  })
  .refine(
    ({ accountSetRevisionId, supersedesAccountSetRevisionId }) =>
      accountSetRevisionId !== supersedesAccountSetRevisionId,
    {
      message: "An account-set revision cannot supersede itself",
      path: ["supersedesAccountSetRevisionId"],
    },
  );

export type SourceRecordAccountRole = z.infer<
  typeof sourceRecordAccountRoleSchema
>;
export type SealInitialSourceRecordAccountSetCommand = z.infer<
  typeof sealInitialSourceRecordAccountSetCommandSchema
>;
export type CorrectSourceRecordAccountSetCommand = z.infer<
  typeof correctSourceRecordAccountSetCommandSchema
>;

export interface NewSourceRecordAccountSetRevision {
  id: AccountSetRevisionId;
  sourceRecordId: SourceRecordId;
  supersedesAccountSetRevisionId: AccountSetRevisionId | null;
  memberCount: number;
}

export interface NewSourceRecordAccountSetMember {
  accountSetRevisionId: AccountSetRevisionId;
  accountSourceId: AccountSourceId;
  linkRevisionId: AccountSourceLinkRevisionId;
  role: SourceRecordAccountRole;
}

export interface SourceRecordAccountSetRevision extends NewSourceRecordAccountSetRevision {
  members: readonly NewSourceRecordAccountSetMember[];
  recordedAt: UtcTimestamp;
}

export interface SourceRecordAssociationStore {
  appendAssociationRevision(
    revision: NewSourceRecordAccountSetRevision,
    members: readonly NewSourceRecordAccountSetMember[],
  ): Promise<void>;
  resolveCurrentSet(
    sourceRecordId: SourceRecordId,
  ): Promise<SourceRecordAccountSetRevision | null>;
  listHistory(
    sourceRecordId: SourceRecordId,
  ): Promise<readonly SourceRecordAccountSetRevision[]>;
}

export class SourceRecordAssociationConflictError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SourceRecordAssociationConflictError";
  }
}

export class SourceRecordAssociationReferenceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SourceRecordAssociationReferenceError";
  }
}

export class SourceRecordAssociationPersistenceError extends Error {
  constructor(operation: string, options?: ErrorOptions) {
    super(`Source-record association operation failed: ${operation}`, options);
    this.name = "SourceRecordAssociationPersistenceError";
  }
}

type ParsedAccountSetCommand =
  | SealInitialSourceRecordAccountSetCommand
  | CorrectSourceRecordAccountSetCommand;

function prepareAssociationRevision(
  command: ParsedAccountSetCommand,
): readonly [
  NewSourceRecordAccountSetRevision,
  readonly NewSourceRecordAccountSetMember[],
] {
  const seenAccountSources = new Set<AccountSourceId>();
  for (const member of command.members) {
    if (seenAccountSources.has(member.accountSourceId)) {
      throw new SourceRecordAssociationConflictError(
        `Source-record account set contains duplicate account source: ${member.accountSourceId}`,
      );
    }
    seenAccountSources.add(member.accountSourceId);
  }

  const revision: NewSourceRecordAccountSetRevision = {
    id: command.accountSetRevisionId,
    sourceRecordId: command.sourceRecordId,
    supersedesAccountSetRevisionId:
      "supersedesAccountSetRevisionId" in command
        ? command.supersedesAccountSetRevisionId
        : null,
    memberCount: command.members.length,
  };
  const members = command.members
    .map((member) => ({
      accountSetRevisionId: command.accountSetRevisionId,
      accountSourceId: member.accountSourceId,
      linkRevisionId: member.linkRevisionId,
      role: "observed_account" as const,
    }))
    .sort((left, right) =>
      left.accountSourceId.localeCompare(right.accountSourceId),
    );

  return [revision, members];
}

export function createSourceRecordAssociationService(
  store: SourceRecordAssociationStore,
) {
  async function append(command: ParsedAccountSetCommand) {
    const [revision, members] = prepareAssociationRevision(command);
    await store.appendAssociationRevision(revision, members);
    return { id: revision.id };
  }

  return {
    async sealInitialAccountSet(input: unknown) {
      return append(
        sealInitialSourceRecordAccountSetCommandSchema.parse(input),
      );
    },

    async correctAccountSet(input: unknown) {
      return append(correctSourceRecordAccountSetCommandSchema.parse(input));
    },

    resolveCurrentSet(input: unknown) {
      return store.resolveCurrentSet(sourceRecordIdSchema.parse(input));
    },

    listHistory(input: unknown) {
      return store.listHistory(sourceRecordIdSchema.parse(input));
    },
  };
}

export type SourceRecordAssociationService = ReturnType<
  typeof createSourceRecordAssociationService
>;
