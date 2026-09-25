import { z } from "zod";

import { accountSourceIdSchema } from "../ledger/identifiers";
import { utcTimestampSchema, type UtcTimestamp } from "../ledger/timestamps";
import {
  connectionIdSchema,
  connectionOperationIdSchema,
  connectorSourceSchema,
  connectionReasonCodeSchema,
  credentialEnvelopeSchema,
  credentialGenerationSchema,
  discoveredAccountIdSchema,
  discoveryLeaseSchema,
  fenceTokenSchema,
  leaseOwnerIdSchema,
  protectedCheckpointCursorSchema,
  protectedProviderIdentitySchema,
  reauthorizationReasonCodeSchema,
  revocationReasonCodeSchema,
  type ConnectionActorClass,
  type ConnectionEvent,
  type ConnectionEventType,
  type ConnectionReasonCode,
  type ConnectionStatus,
  type ConnectionStore,
} from "./domain";

const createPendingCommandSchema = z.strictObject({
  operationId: connectionOperationIdSchema,
  connectionId: connectionIdSchema,
  source: connectorSourceSchema,
});

const authorizationCommandSchema = z
  .strictObject({
    operationId: connectionOperationIdSchema,
    connectionId: connectionIdSchema,
    expectedGeneration: credentialGenerationSchema,
    envelope: credentialEnvelopeSchema,
    expiresAt: utcTimestampSchema.nullable(),
  })
  .superRefine((command, context) => {
    const resultingGeneration = command.expectedGeneration + 1n;
    if (command.envelope.connectionId !== command.connectionId) {
      context.addIssue({
        code: "custom",
        path: ["envelope", "connectionId"],
        message: "Credential envelope belongs to another connection",
      });
    }
    if (command.envelope.credentialGeneration !== resultingGeneration) {
      context.addIssue({
        code: "custom",
        path: ["envelope", "credentialGeneration"],
        message: "Credential envelope must bind the next generation",
      });
    }
  });

const generationCommandSchema = z.strictObject({
  operationId: connectionOperationIdSchema,
  connectionId: connectionIdSchema,
  expectedGeneration: credentialGenerationSchema,
});

const markReauthorizationCommandSchema = generationCommandSchema.extend({
  reasonCode: reauthorizationReasonCodeSchema,
});

const revokeCommandSchema = generationCommandSchema.extend({
  reasonCode: revocationReasonCodeSchema,
});

const registerReviewedDiscoveryCommandSchema = z
  .strictObject({
    discoveredAccountId: discoveredAccountIdSchema,
    connectionId: connectionIdSchema,
    accountSourceId: accountSourceIdSchema,
    source: connectorSourceSchema,
    expectedCredentialGeneration: credentialGenerationSchema,
    leaseOwnerId: leaseOwnerIdSchema,
    fencingToken: fenceTokenSchema,
    protectedIdentity: protectedProviderIdentitySchema,
  })
  .superRefine((command, context) => {
    if (
      command.protectedIdentity.discoveredAccountId !==
      command.discoveredAccountId
    ) {
      context.addIssue({
        code: "custom",
        path: ["protectedIdentity", "discoveredAccountId"],
        message: "Protected identity belongs to another discovered account",
      });
    }
    if (command.protectedIdentity.connectionId !== command.connectionId) {
      context.addIssue({
        code: "custom",
        path: ["protectedIdentity", "connectionId"],
        message: "Protected identity belongs to another connection",
      });
    }
    if (command.protectedIdentity.source !== command.source) {
      context.addIssue({
        code: "custom",
        path: ["protectedIdentity", "source"],
        message: "Protected identity source does not match reviewed source",
      });
    }
  });

const acquireLeaseCommandSchema = z.strictObject({
  connectionId: connectionIdSchema,
  feed: z.literal("discovery"),
  leaseOwnerId: leaseOwnerIdSchema,
  expectedGeneration: credentialGenerationSchema,
  leaseDurationSeconds: z.number().int().min(1).max(900),
});

const advanceDiscoveryCheckpointCommandSchema = z
  .strictObject({
    connectionId: connectionIdSchema,
    feed: z.literal("discovery"),
    leaseOwnerId: leaseOwnerIdSchema,
    expectedGeneration: credentialGenerationSchema,
    fencingToken: fenceTokenSchema,
    cursor: protectedCheckpointCursorSchema.nullable(),
  })
  .superRefine((command, context) => {
    if (
      command.cursor !== null &&
      command.cursor.connectionId !== command.connectionId
    ) {
      context.addIssue({
        code: "custom",
        path: ["cursor", "connectionId"],
        message: "Checkpoint cursor belongs to another connection",
      });
    }
  });

function event(
  id: z.infer<typeof connectionOperationIdSchema>,
  connectionId: z.infer<typeof connectionIdSchema>,
  eventType: ConnectionEventType,
  expectedCredentialGeneration: bigint | null,
  resultingCredentialGeneration: bigint,
  actorClass: ConnectionActorClass,
  reasonCode: ConnectionReasonCode,
  occurredAt: UtcTimestamp,
): ConnectionEvent {
  return {
    id,
    connectionId,
    eventType,
    expectedCredentialGeneration,
    resultingCredentialGeneration,
    actorClass,
    reasonCode,
    occurredAt,
  };
}

export function createConnectionService(
  store: ConnectionStore,
  clock: () => UtcTimestamp,
) {
  function now(): UtcTimestamp {
    return utcTimestampSchema.parse(clock());
  }

  async function changeStatus(
    input: unknown,
    options: {
      schema:
        | typeof generationCommandSchema
        | typeof markReauthorizationCommandSchema
        | typeof revokeCommandSchema;
      allowedFromStatuses: readonly ConnectionStatus[];
      resultingStatus:
        "active" | "reauthorization_required" | "disabled" | "revoked";
      reasonCode: ConnectionReasonCode | "command";
      eventType: ConnectionEventType;
      actorClass: ConnectionActorClass;
      validated: boolean;
      deleteCredential: boolean;
    },
  ) {
    const command = options.schema.parse(input);
    const occurredAt = now();
    const reasonCode =
      options.reasonCode === "command"
        ? connectionReasonCodeSchema.parse(
            "reasonCode" in command ? command.reasonCode : undefined,
          )
        : options.reasonCode;
    await store.compareAndSwapStatus(
      {
        connectionId: command.connectionId,
        expectedCredentialGeneration: command.expectedGeneration,
        allowedFromStatuses: options.allowedFromStatuses,
        resultingStatus: options.resultingStatus,
        statusReason: options.resultingStatus === "active" ? null : reasonCode,
        validatedAt: options.validated ? occurredAt : null,
        deleteCredential: options.deleteCredential,
      },
      event(
        command.operationId,
        command.connectionId,
        options.eventType,
        command.expectedGeneration,
        command.expectedGeneration,
        options.actorClass,
        reasonCode,
        occurredAt,
      ),
    );
  }

  return {
    async createPending(input: unknown) {
      const command = createPendingCommandSchema.parse(input);
      const createdAt = now();
      await store.createPending(
        {
          id: command.connectionId,
          source: command.source,
          authorizationClass: "read_only",
          status: "pending",
          statusReason: "pending_authorization",
          credentialGeneration: 0n,
          authorizedAt: null,
          expiresAt: null,
          createdAt,
        },
        event(
          command.operationId,
          command.connectionId,
          "connection_created",
          null,
          0n,
          "owner",
          "pending_authorization",
          createdAt,
        ),
      );
      return { id: command.connectionId };
    },

    async installAuthorization(input: unknown) {
      const command = authorizationCommandSchema.parse(input);
      const authorizedAt = now();
      if (
        command.expiresAt !== null &&
        new Date(command.expiresAt).getTime() <=
          new Date(authorizedAt).getTime()
      ) {
        throw new Error(
          "Installed authorization must expire after authorization",
        );
      }
      const resultingGeneration = command.expectedGeneration + 1n;
      await store.compareAndSwapCredential(
        {
          connectionId: command.connectionId,
          expectedCredentialGeneration: command.expectedGeneration,
          resultingCredentialGeneration: resultingGeneration,
          allowedFromStatuses: ["pending", "reauthorization_required"],
          resultingStatus: "active",
          statusReason: null,
          authorizedAt,
          expiresAt: command.expiresAt,
          envelope: command.envelope,
        },
        event(
          command.operationId,
          command.connectionId,
          "authorization_installed",
          command.expectedGeneration,
          resultingGeneration,
          "owner",
          "authorization_installed",
          authorizedAt,
        ),
      );
      return { credentialGeneration: resultingGeneration };
    },

    async refreshCredential(input: unknown) {
      const command = authorizationCommandSchema.parse(input);
      const authorizedAt = now();
      if (
        command.expiresAt !== null &&
        new Date(command.expiresAt).getTime() <=
          new Date(authorizedAt).getTime()
      ) {
        throw new Error("Refreshed credential must expire after refresh");
      }
      const resultingGeneration = command.expectedGeneration + 1n;
      await store.compareAndSwapCredential(
        {
          connectionId: command.connectionId,
          expectedCredentialGeneration: command.expectedGeneration,
          resultingCredentialGeneration: resultingGeneration,
          allowedFromStatuses: ["active"],
          resultingStatus: "active",
          statusReason: null,
          authorizedAt,
          expiresAt: command.expiresAt,
          envelope: command.envelope,
        },
        event(
          command.operationId,
          command.connectionId,
          "credential_refreshed",
          command.expectedGeneration,
          resultingGeneration,
          "read_worker",
          "credential_refreshed",
          authorizedAt,
        ),
      );
      return { credentialGeneration: resultingGeneration };
    },

    markReauthorizationRequired(input: unknown) {
      return changeStatus(input, {
        schema: markReauthorizationCommandSchema,
        allowedFromStatuses: ["active"],
        resultingStatus: "reauthorization_required",
        reasonCode: "command",
        eventType: "reauthorization_required",
        actorClass: "read_worker",
        validated: false,
        deleteCredential: false,
      });
    },

    disable(input: unknown) {
      return changeStatus(input, {
        schema: generationCommandSchema,
        allowedFromStatuses: ["active"],
        resultingStatus: "disabled",
        reasonCode: "user_disabled",
        eventType: "connection_disabled",
        actorClass: "owner",
        validated: false,
        deleteCredential: false,
      });
    },

    reenableAfterValidation(input: unknown) {
      return changeStatus(input, {
        schema: generationCommandSchema,
        allowedFromStatuses: ["disabled"],
        resultingStatus: "active",
        reasonCode: "credential_revalidated",
        eventType: "connection_reenabled",
        actorClass: "read_worker",
        validated: true,
        deleteCredential: false,
      });
    },

    revoke(input: unknown) {
      return changeStatus(input, {
        schema: revokeCommandSchema,
        allowedFromStatuses: [
          "pending",
          "active",
          "reauthorization_required",
          "disabled",
        ],
        resultingStatus: "revoked",
        reasonCode: "command",
        eventType: "connection_revoked",
        actorClass: "owner",
        validated: false,
        deleteCredential: true,
      });
    },

    async registerReviewedDiscovery(input: unknown) {
      const command = registerReviewedDiscoveryCommandSchema.parse(input);
      const observedAt = now();
      await store.registerReviewedDiscovery({
        id: command.discoveredAccountId,
        connectionId: command.connectionId,
        accountSourceId: command.accountSourceId,
        source: command.source,
        expectedCredentialGeneration: command.expectedCredentialGeneration,
        leaseOwnerId: command.leaseOwnerId,
        fencingToken: command.fencingToken,
        protectedIdentity: command.protectedIdentity,
        status: "active",
        firstObservedAt: observedAt,
        lastObservedAt: observedAt,
      });
      return { id: command.discoveredAccountId };
    },

    async acquireLease(input: unknown) {
      const command = acquireLeaseCommandSchema.parse(input);
      const lease = await store.acquireDiscoveryLease({
        connectionId: command.connectionId,
        feed: command.feed,
        leaseOwnerId: command.leaseOwnerId,
        expectedCredentialGeneration: command.expectedGeneration,
        requestedAt: now(),
        leaseDurationSeconds: command.leaseDurationSeconds,
      });
      return discoveryLeaseSchema.parse(lease);
    },

    async advanceDiscoveryCheckpoint(input: unknown) {
      const command = advanceDiscoveryCheckpointCommandSchema.parse(input);
      await store.advanceDiscoveryCheckpoint({
        connectionId: command.connectionId,
        feed: command.feed,
        leaseOwnerId: command.leaseOwnerId,
        expectedCredentialGeneration: command.expectedGeneration,
        fencingToken: command.fencingToken,
        cursor: command.cursor,
        advancedAt: now(),
      });
    },
  };
}

export type ConnectionService = ReturnType<typeof createConnectionService>;
