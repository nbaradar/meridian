import { randomUUID } from "node:crypto";

import { describe, expect, test } from "vitest";

import {
  createConnectionService,
  type ConnectionEvent,
  type ConnectionStore,
  type CredentialCas,
  type DiscoveryCheckpointAdvance,
  type DiscoveryLease,
  type DiscoveryLeaseRequest,
  type PendingConnection,
  type ReviewedDiscoveredAccount,
  type StatusCas,
} from "../src/core/connections";
import { utcTimestampSchema } from "../src/core/ledger/timestamps";

class FakeConnectionStore implements ConnectionStore {
  pending: Array<{ connection: PendingConnection; event: ConnectionEvent }> =
    [];
  credentials: Array<{ change: CredentialCas; event: ConnectionEvent }> = [];
  statuses: Array<{ change: StatusCas; event: ConnectionEvent }> = [];
  discoveries: ReviewedDiscoveredAccount[] = [];
  leaseRequests: DiscoveryLeaseRequest[] = [];
  checkpointAdvances: DiscoveryCheckpointAdvance[] = [];
  leaseResult: DiscoveryLease | null = null;

  async createPending(connection: PendingConnection, event: ConnectionEvent) {
    this.pending.push({ connection, event });
  }

  async compareAndSwapCredential(
    change: CredentialCas,
    event: ConnectionEvent,
  ) {
    this.credentials.push({ change, event });
  }

  async compareAndSwapStatus(change: StatusCas, event: ConnectionEvent) {
    this.statuses.push({ change, event });
  }

  async registerReviewedDiscovery(discovery: ReviewedDiscoveredAccount) {
    this.discoveries.push(discovery);
  }

  async acquireDiscoveryLease(request: DiscoveryLeaseRequest) {
    this.leaseRequests.push(request);
    if (this.leaseResult === null) throw new Error("Missing fake lease result");
    return this.leaseResult;
  }

  async advanceDiscoveryCheckpoint(change: DiscoveryCheckpointAdvance) {
    this.checkpointAdvances.push(change);
  }

  get callCount() {
    return (
      this.pending.length +
      this.credentials.length +
      this.statuses.length +
      this.discoveries.length +
      this.leaseRequests.length +
      this.checkpointAdvances.length
    );
  }
}

const now = utcTimestampSchema.parse("2026-08-03T12:00:00Z");
const later = utcTimestampSchema.parse("2026-08-03T12:05:00Z");
const base64 = Buffer.from("opaque protected bytes").toString("base64");

function credentialEnvelope(
  connectionId: string,
  credentialGeneration: bigint,
) {
  return {
    source: "simplefin",
    connectionId,
    credentialGeneration,
    authorizationClass: "read_only",
    encryptionAlgorithm: "xchacha20-poly1305-ietf",
    encryptionKeyId: "credential-key-1",
    keyStatus: "active",
    nonce: base64,
    ciphertext: base64,
  };
}

describe("provider-neutral connection service", () => {
  test("creates only a controlled pending read-only connection and event", async () => {
    const store = new FakeConnectionStore();
    const service = createConnectionService(store, () => now);
    const connectionId = randomUUID();
    const operationId = randomUUID();

    await expect(
      service.createPending({ operationId, connectionId, source: "simplefin" }),
    ).resolves.toEqual({ id: connectionId });

    expect(store.pending).toEqual([
      {
        connection: {
          id: connectionId,
          source: "simplefin",
          authorizationClass: "read_only",
          status: "pending",
          statusReason: "pending_authorization",
          credentialGeneration: 0n,
          authorizedAt: null,
          expiresAt: null,
          createdAt: now,
        },
        event: {
          id: operationId,
          connectionId,
          eventType: "connection_created",
          expectedCredentialGeneration: null,
          resultingCredentialGeneration: 0n,
          actorClass: "owner",
          reasonCode: "pending_authorization",
          occurredAt: now,
        },
      },
    ]);
  });

  test("installs and refreshes sealed credentials with atomic generations", async () => {
    const store = new FakeConnectionStore();
    const service = createConnectionService(store, () => now);
    const connectionId = randomUUID();
    const installOperationId = randomUUID();
    const refreshOperationId = randomUUID();

    await service.installAuthorization({
      operationId: installOperationId,
      connectionId,
      expectedGeneration: 0n,
      envelope: credentialEnvelope(connectionId, 1n),
      expiresAt: "2026-08-04T12:00:00Z",
    });
    await service.refreshCredential({
      operationId: refreshOperationId,
      connectionId,
      expectedGeneration: 1n,
      envelope: credentialEnvelope(connectionId, 2n),
      expiresAt: null,
    });

    expect(store.credentials[0]?.change).toMatchObject({
      expectedCredentialGeneration: 0n,
      resultingCredentialGeneration: 1n,
      allowedFromStatuses: ["pending", "reauthorization_required"],
      resultingStatus: "active",
    });
    expect(store.credentials[0]?.event.id).toBe(installOperationId);
    expect(store.credentials[1]?.change).toMatchObject({
      expectedCredentialGeneration: 1n,
      resultingCredentialGeneration: 2n,
      allowedFromStatuses: ["active"],
      resultingStatus: "active",
    });
    expect(store.credentials[1]?.event).toMatchObject({
      id: refreshOperationId,
      expectedCredentialGeneration: 1n,
      resultingCredentialGeneration: 2n,
      actorClass: "read_worker",
      reasonCode: "credential_refreshed",
    });
  });

  test("derives reviewed lifecycle transitions rather than accepting statuses", async () => {
    const store = new FakeConnectionStore();
    const service = createConnectionService(store, () => now);
    const connectionId = randomUUID();
    const operationIds = Array.from({ length: 4 }, () => randomUUID());

    await service.markReauthorizationRequired({
      operationId: operationIds[0],
      connectionId,
      expectedGeneration: 3n,
      reasonCode: "provider_authentication_failed",
    });
    await service.disable({
      operationId: operationIds[1],
      connectionId,
      expectedGeneration: 3n,
    });
    await service.reenableAfterValidation({
      operationId: operationIds[2],
      connectionId,
      expectedGeneration: 3n,
    });
    await service.revoke({
      operationId: operationIds[3],
      connectionId,
      expectedGeneration: 3n,
      reasonCode: "user_revoked",
    });

    expect(store.statuses.map(({ change }) => change)).toEqual([
      expect.objectContaining({
        allowedFromStatuses: ["active"],
        resultingStatus: "reauthorization_required",
        statusReason: "provider_authentication_failed",
        deleteCredential: false,
      }),
      expect.objectContaining({
        allowedFromStatuses: ["active"],
        resultingStatus: "disabled",
        statusReason: "user_disabled",
      }),
      expect.objectContaining({
        allowedFromStatuses: ["disabled"],
        resultingStatus: "active",
        statusReason: null,
        validatedAt: now,
      }),
      expect.objectContaining({
        allowedFromStatuses: [
          "pending",
          "active",
          "reauthorization_required",
          "disabled",
        ],
        resultingStatus: "revoked",
        statusReason: "user_revoked",
        deleteCredential: true,
      }),
    ]);
    expect(
      store.statuses.every(
        ({ change }) => change.expectedCredentialGeneration === 3n,
      ),
    ).toBe(true);
    expect(store.statuses.map(({ event }) => event.id)).toEqual(operationIds);
  });

  test("registers only reviewed protected discovery identity", async () => {
    const store = new FakeConnectionStore();
    const service = createConnectionService(store, () => now);
    const connectionId = randomUUID();
    const discoveredAccountId = randomUUID();
    const accountSourceId = randomUUID();
    const leaseOwnerId = randomUUID();

    await service.registerReviewedDiscovery({
      discoveredAccountId,
      connectionId,
      accountSourceId,
      source: "teller",
      expectedCredentialGeneration: 4n,
      leaseOwnerId,
      fencingToken: 9n,
      protectedIdentity: {
        source: "teller",
        connectionId,
        discoveredAccountId,
        lookupDigest: "a".repeat(64),
        digestKeyId: "lookup-key-1",
        encryptionAlgorithm: "xchacha20-poly1305-ietf",
        encryptionKeyId: "identity-key-1",
        keyStatus: "active",
        nonce: base64,
        ciphertext: base64,
      },
    });

    expect(store.discoveries).toEqual([
      expect.objectContaining({
        id: discoveredAccountId,
        connectionId,
        accountSourceId,
        source: "teller",
        expectedCredentialGeneration: 4n,
        leaseOwnerId,
        fencingToken: 9n,
        status: "active",
        firstObservedAt: now,
        lastObservedAt: now,
      }),
    ]);
  });

  test("propagates generation and fencing token through discovery checkpoints", async () => {
    const store = new FakeConnectionStore();
    const service = createConnectionService(store, () => now);
    const connectionId = randomUUID();
    const leaseOwnerId = randomUUID();
    store.leaseResult = {
      connectionId: connectionId as never,
      feed: "discovery",
      leaseOwnerId: leaseOwnerId as never,
      credentialGeneration: 4n,
      fencingToken: 9n,
      acquiredAt: now,
      expiresAt: later,
    };

    await service.acquireLease({
      connectionId,
      feed: "discovery",
      leaseOwnerId,
      expectedGeneration: 4n,
      leaseDurationSeconds: 300,
    });
    await service.advanceDiscoveryCheckpoint({
      connectionId,
      feed: "discovery",
      leaseOwnerId,
      expectedGeneration: 4n,
      fencingToken: 9n,
      cursor: {
        connectionId,
        feed: "discovery",
        encryptionAlgorithm: "xchacha20-poly1305-ietf",
        encryptionKeyId: "cursor-key-1",
        keyStatus: "active",
        nonce: base64,
        ciphertext: base64,
      },
    });

    expect(store.leaseRequests[0]).toMatchObject({
      expectedCredentialGeneration: 4n,
      feed: "discovery",
      leaseDurationSeconds: 300,
    });
    expect(store.checkpointAdvances[0]).toMatchObject({
      expectedCredentialGeneration: 4n,
      fencingToken: 9n,
      leaseOwnerId,
      advancedAt: now,
    });
  });

  test("strictly rejects unsafe or mismatched input before any store call", async () => {
    const store = new FakeConnectionStore();
    const service = createConnectionService(store, () => now);
    const connectionId = randomUUID();

    await expect(
      service.createPending({
        operationId: randomUUID(),
        connectionId,
        source: "ynab",
      }),
    ).rejects.toBeDefined();
    await expect(
      service.createPending({
        operationId: randomUUID(),
        connectionId,
        source: "simplefin",
        status: "active",
      }),
    ).rejects.toBeDefined();
    await expect(
      service.installAuthorization({
        operationId: randomUUID(),
        connectionId,
        expectedGeneration: 0n,
        envelope: credentialEnvelope(connectionId, 0n),
        expiresAt: null,
      }),
    ).rejects.toThrow("next generation");
    await expect(
      service.markReauthorizationRequired({
        operationId: randomUUID(),
        connectionId,
        expectedGeneration: 1n,
        reasonCode: "raw provider error body",
      }),
    ).rejects.toBeDefined();
    await expect(
      service.advanceDiscoveryCheckpoint({
        connectionId,
        feed: "transactions",
        leaseOwnerId: randomUUID(),
        expectedGeneration: 1n,
        fencingToken: 1n,
        cursor: null,
      }),
    ).rejects.toBeDefined();

    expect(store.callCount).toBe(0);
  });
});
