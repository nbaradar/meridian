import { randomUUID } from "node:crypto";

import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, describe, expect, test } from "vitest";

import { createConnectionService } from "../../src/core/connections";
import {
  createAccountSourceLinkService,
  utcTimestampSchema,
} from "../../src/core/ledger";
import {
  createDatabase,
  createOpsControlDatabase,
  createReadWorkerDatabase,
} from "../../src/infrastructure/database/client";
import {
  ConnectionConflictError,
  createPostgresConnectionStore,
} from "../../src/infrastructure/database/postgres-connections";
import { createPostgresAccountSourceLinkStore } from "../../src/infrastructure/database/postgres-account-sources";
import * as schema from "../../src/infrastructure/database/schema";

function operationalTestEnvironment() {
  const databasePath = new URL(process.env.DATABASE_URL!).pathname;
  const withTestDatabase = (connectionUrl: string) => {
    const url = new URL(connectionUrl);
    url.pathname = databasePath;
    return url.toString();
  };
  return {
    OPS_CONTROL_DATABASE_URL: withTestDatabase(
      process.env.OPS_CONTROL_DATABASE_URL!,
    ),
    READ_WORKER_DATABASE_URL: withTestDatabase(
      process.env.READ_WORKER_DATABASE_URL!,
    ),
  };
}

const application = createDatabase();
const operationalEnvironment = operationalTestEnvironment();
const opsControl = createOpsControlDatabase(operationalEnvironment);
const readWorker = createReadWorkerDatabase(operationalEnvironment);
const ownerClient = postgres(process.env.DATABASE_OWNER_URL!, { max: 2 });
const ownerDatabase = drizzle(ownerClient, { schema });

const opsStore = createPostgresConnectionStore(opsControl.database);
const workerStore = createPostgresConnectionStore(readWorker.database);
const sourceService = createAccountSourceLinkService(
  createPostgresAccountSourceLinkStore(application.database),
  () => utcTimestampSchema.parse("2026-08-03T10:00:00Z"),
);

const protectedNonce = Buffer.alloc(24, 1).toString("base64");
const protectedCiphertext = Buffer.alloc(32, 2).toString("base64");

function credentialEnvelope(connectionId: string, generation: bigint) {
  return {
    source: "simplefin",
    connectionId,
    credentialGeneration: generation,
    authorizationClass: "read_only",
    encryptionAlgorithm: "xchacha20-poly1305-ietf",
    encryptionKeyId: "credential-key-1",
    keyStatus: "active",
    nonce: protectedNonce,
    ciphertext: protectedCiphertext,
  } as const;
}

function cursor(connectionId: string) {
  return {
    connectionId,
    feed: "discovery",
    encryptionAlgorithm: "xchacha20-poly1305-ietf",
    encryptionKeyId: "cursor-key-1",
    keyStatus: "active",
    nonce: protectedNonce,
    ciphertext: protectedCiphertext,
  } as const;
}

async function createActiveConnection(connectionId: string) {
  let current = utcTimestampSchema.parse("2026-08-03T12:00:00Z");
  const service = createConnectionService(opsStore, () => current);
  await service.createPending({
    operationId: randomUUID(),
    connectionId,
    source: "simplefin",
  });
  current = utcTimestampSchema.parse("2026-08-03T12:01:00Z");
  await service.installAuthorization({
    connectionId,
    operationId: randomUUID(),
    expectedGeneration: 0n,
    envelope: credentialEnvelope(connectionId, 1n),
    expiresAt: null,
  });
}

afterAll(async () => {
  await Promise.all([
    application.close(),
    opsControl.close(),
    readWorker.close(),
    ownerClient.end(),
  ]);
});

describe("PostgreSQL connection store", () => {
  test("separates operational roles and requires server-owned security events", async () => {
    const tables = await ownerDatabase.execute<{ table_name: string }>(sql`
      select table_name from information_schema.tables
      where table_schema = 'ops' and table_type = 'BASE TABLE'
      order by table_name
    `);
    expect(tables.map(({ table_name }) => table_name)).toEqual([
      "connection_events",
      "connection_secrets",
      "connections",
      "discovered_accounts",
      "sync_checkpoints",
      "sync_runs",
    ]);

    await expect(
      application.database.execute(sql`select id from ops.connections`),
    ).rejects.toMatchObject({ cause: { code: "42501" } });
    await expect(
      opsControl.database.execute(
        sql`select ciphertext from ops.connection_secrets`,
      ),
    ).rejects.toMatchObject({ cause: { code: "42501" } });

    const privileges = await ownerDatabase.execute<{
      control_reads_ciphertext: boolean;
      worker_reads_ciphertext: boolean;
      control_sets_recorded_at: boolean;
    }>(sql`
      select
        has_column_privilege('meridian_ops_control', 'ops.connection_secrets', 'ciphertext', 'SELECT') as control_reads_ciphertext,
        has_column_privilege('meridian_read_worker', 'ops.connection_secrets', 'ciphertext', 'SELECT') as worker_reads_ciphertext,
        has_column_privilege('meridian_ops_control', 'ops.connection_events', 'recorded_at', 'INSERT') as control_sets_recorded_at
    `);
    expect(privileges[0]).toEqual({
      control_reads_ciphertext: false,
      worker_reads_ciphertext: true,
      control_sets_recorded_at: false,
    });

    const connectionId = randomUUID();
    const service = createConnectionService(opsStore, () =>
      utcTimestampSchema.parse("2026-08-03T00:00:00Z"),
    );
    await service.createPending({
      operationId: randomUUID(),
      connectionId,
      source: "simplefin",
    });
    await expect(
      opsControl.database.execute(sql`
        update ops.connections
        set status = 'revoked', status_reason = 'user_revoked',
          updated_at = '2026-08-03T00:01:00Z'
        where id = ${connectionId}
      `),
    ).rejects.toMatchObject({ cause: { code: "23514" } });
  });

  test("persists lifecycle transitions atomically and rejects a delayed refresh after revocation", async () => {
    const connectionId = randomUUID();
    let current = utcTimestampSchema.parse("2026-08-03T12:00:00Z");
    const ownerService = createConnectionService(opsStore, () => current);

    const createCommand = {
      operationId: randomUUID(),
      connectionId,
      source: "simplefin",
    } as const;
    await ownerService.createPending(createCommand);
    await ownerService.createPending(createCommand);
    await expect(
      ownerService.createPending({ ...createCommand, source: "teller" }),
    ).rejects.toBeInstanceOf(ConnectionConflictError);

    current = utcTimestampSchema.parse("2026-08-03T12:01:00Z");
    const installCommand = {
      connectionId,
      operationId: randomUUID(),
      expectedGeneration: 0n,
      envelope: credentialEnvelope(connectionId, 1n),
      expiresAt: null,
    } as const;
    await ownerService.installAuthorization(installCommand);
    current = utcTimestampSchema.parse("2026-08-03T12:01:30Z");
    await ownerService.installAuthorization(installCommand);
    await expect(
      ownerService.installAuthorization({
        ...installCommand,
        envelope: {
          ...installCommand.envelope,
          ciphertext: Buffer.alloc(32, 9).toString("base64"),
        },
      }),
    ).rejects.toBeInstanceOf(ConnectionConflictError);

    current = utcTimestampSchema.parse("2026-08-03T12:02:00Z");
    await ownerService.disable({
      operationId: randomUUID(),
      connectionId,
      expectedGeneration: 1n,
    });
    current = utcTimestampSchema.parse("2026-08-03T12:03:00Z");
    const workerService = createConnectionService(workerStore, () => current);
    await workerService.reenableAfterValidation({
      operationId: randomUUID(),
      connectionId,
      expectedGeneration: 1n,
    });
    current = utcTimestampSchema.parse("2026-08-03T12:04:00Z");
    const revokeCommand = {
      operationId: randomUUID(),
      connectionId,
      expectedGeneration: 1n,
      reasonCode: "user_revoked",
    } as const;
    await ownerService.revoke(revokeCommand);
    await ownerService.revoke(revokeCommand);

    const delayedWorkerService = createConnectionService(workerStore, () =>
      utcTimestampSchema.parse("2026-08-03T12:05:00Z"),
    );
    await expect(
      delayedWorkerService.refreshCredential({
        operationId: randomUUID(),
        connectionId,
        expectedGeneration: 1n,
        envelope: credentialEnvelope(connectionId, 2n),
        expiresAt: null,
      }),
    ).rejects.toBeInstanceOf(ConnectionConflictError);

    const state = await readWorker.database.execute<{
      status: string;
      credential_generation: string;
      secret_count: string;
      event_count: string;
    }>(sql`
      select c.status, c.credential_generation::text,
        (select count(*)::text from ops.connection_secrets s where s.connection_id = c.id) as secret_count,
        (select count(*)::text from ops.connection_events e where e.connection_id = c.id) as event_count
      from ops.connections c where c.id = ${connectionId}
    `);
    expect(state[0]).toEqual({
      status: "revoked",
      credential_generation: "1",
      secret_count: "0",
      event_count: "5",
    });
  });

  test("enforces complete status and generation CAS checks", async () => {
    const connectionId = randomUUID();
    await createActiveConnection(connectionId);
    const firstRefresh = createConnectionService(workerStore, () =>
      utcTimestampSchema.parse("2026-08-03T12:02:00Z"),
    );
    await firstRefresh.refreshCredential({
      operationId: randomUUID(),
      connectionId,
      expectedGeneration: 1n,
      envelope: credentialEnvelope(connectionId, 2n),
      expiresAt: null,
    });

    const delayedRefresh = createConnectionService(workerStore, () =>
      utcTimestampSchema.parse("2026-08-03T12:03:00Z"),
    );
    await expect(
      delayedRefresh.refreshCredential({
        operationId: randomUUID(),
        connectionId,
        expectedGeneration: 1n,
        envelope: credentialEnvelope(connectionId, 2n),
        expiresAt: null,
      }),
    ).rejects.toBeInstanceOf(ConnectionConflictError);

    const state = await readWorker.database.execute<{
      credential_generation: string;
      updated_at: string;
    }>(sql`
      select credential_generation::text, updated_at::text
      from ops.connection_secrets where connection_id = ${connectionId}
    `);
    expect(state[0]?.credential_generation).toBe("2");
    expect(state[0]?.updated_at).toContain("12:02:00");
  });

  test("rejects lifecycle operations performed by the wrong database role", async () => {
    const connectionId = randomUUID();
    await createActiveConnection(connectionId);
    const workerService = createConnectionService(workerStore, () =>
      utcTimestampSchema.parse("2026-08-03T12:02:00Z"),
    );
    await expect(
      workerService.disable({
        operationId: randomUUID(),
        connectionId,
        expectedGeneration: 1n,
      }),
    ).rejects.toBeInstanceOf(ConnectionConflictError);

    const controlService = createConnectionService(opsStore, () =>
      utcTimestampSchema.parse("2026-08-03T12:02:00Z"),
    );
    await expect(
      controlService.refreshCredential({
        operationId: randomUUID(),
        connectionId,
        expectedGeneration: 1n,
        envelope: credentialEnvelope(connectionId, 2n),
        expiresAt: null,
      }),
    ).rejects.toBeInstanceOf(ConnectionConflictError);

    await controlService.disable({
      operationId: randomUUID(),
      connectionId,
      expectedGeneration: 1n,
    });
    await expect(
      readWorker.database.execute(sql`
        update ops.connections set
          status = 'active', status_reason = null,
          last_operation_id = ${randomUUID()},
          expires_at = '2099-01-01T00:00:00Z',
          last_succeeded_at = clock_timestamp(),
          updated_at = clock_timestamp()
        where id = ${connectionId}
      `),
    ).rejects.toMatchObject({ cause: { code: "23514" } });
  });

  test("registers reviewed discovery replay-safely and rejects source mismatch", async () => {
    const connectionId = randomUUID();
    await createActiveConnection(connectionId);
    const accountSourceId = randomUUID();
    await sourceService.registerAccountSource({
      accountSourceId,
      source: "simplefin",
      sourceKind: "connector",
      ingestedAt: "2026-08-03T00:00:00Z",
    });
    const discoveredAccountId = randomUUID();
    const leaseOwnerId = randomUUID();
    const workerService = createConnectionService(workerStore, () =>
      utcTimestampSchema.parse("2026-08-03T12:05:00Z"),
    );
    const lease = await workerService.acquireLease({
      connectionId,
      feed: "discovery",
      leaseOwnerId,
      expectedGeneration: 1n,
      leaseDurationSeconds: 60,
    });
    const service = createConnectionService(opsStore, () =>
      utcTimestampSchema.parse("2026-08-03T12:05:00Z"),
    );
    const command = {
      discoveredAccountId,
      connectionId,
      accountSourceId,
      source: "simplefin",
      expectedCredentialGeneration: 1n,
      leaseOwnerId,
      fencingToken: lease.fencingToken,
      protectedIdentity: {
        source: "simplefin",
        connectionId,
        discoveredAccountId,
        lookupDigest: "a".repeat(64),
        digestKeyId: "digest-key-1",
        encryptionAlgorithm: "xchacha20-poly1305-ietf",
        encryptionKeyId: "identity-key-1",
        keyStatus: "active",
        nonce: protectedNonce,
        ciphertext: protectedCiphertext,
      },
    } as const;
    await service.registerReviewedDiscovery(command);
    await service.registerReviewedDiscovery(command);
    const rediscoveryService = createConnectionService(opsStore, () =>
      utcTimestampSchema.parse("2026-08-03T12:06:00Z"),
    );
    await rediscoveryService.registerReviewedDiscovery({
      ...command,
      protectedIdentity: {
        ...command.protectedIdentity,
        nonce: Buffer.alloc(24, 3).toString("base64"),
        ciphertext: Buffer.alloc(32, 4).toString("base64"),
      },
    });
    const staleDiscoveryId = randomUUID();
    await expect(
      service.registerReviewedDiscovery({
        ...command,
        discoveredAccountId: staleDiscoveryId,
        fencingToken: command.fencingToken + 1n,
        protectedIdentity: {
          ...command.protectedIdentity,
          discoveredAccountId: staleDiscoveryId,
        },
      }),
    ).rejects.toBeInstanceOf(ConnectionConflictError);

    const mismatchedSourceId = randomUUID();
    await sourceService.registerAccountSource({
      accountSourceId: mismatchedSourceId,
      source: "teller",
      sourceKind: "connector",
      ingestedAt: "2026-08-03T00:00:00Z",
    });
    const mismatchedDiscoveryId = randomUUID();
    await expect(
      service.registerReviewedDiscovery({
        ...command,
        discoveredAccountId: mismatchedDiscoveryId,
        accountSourceId: mismatchedSourceId,
        protectedIdentity: {
          ...command.protectedIdentity,
          discoveredAccountId: mismatchedDiscoveryId,
        },
      }),
    ).rejects.toBeInstanceOf(ConnectionConflictError);

    const rows = await ownerDatabase.execute<{ count: string }>(sql`
      select count(*)::text as count from ops.discovered_accounts
      where connection_id = ${connectionId}
    `);
    expect(rows[0]?.count).toBe("1");
  });

  test("keeps lifecycle events immutable with adapter-allocated UUIDs", async () => {
    const connectionId = randomUUID();
    await createActiveConnection(connectionId);
    const events = await ownerDatabase.execute<{ id: string }>(sql`
      select id from ops.connection_events where connection_id = ${connectionId}
    `);
    expect(events).toHaveLength(2);
    expect(new Set(events.map(({ id }) => id)).size).toBe(2);

    await expect(
      ownerDatabase.execute(sql`
        update ops.connection_events set reason_code = 'user_disabled'
        where id = ${events[0]!.id}
      `),
    ).rejects.toMatchObject({ cause: { code: "55000" } });
    await expect(
      ownerDatabase.execute(sql`
        delete from ops.connection_events where id = ${events[0]!.id}
      `),
    ).rejects.toMatchObject({ cause: { code: "55000" } });
  });

  test("fences discovery lease takeover and rejects the stale owner checkpoint", async () => {
    const connectionId = randomUUID();
    await createActiveConnection(connectionId);
    const firstOwner = randomUUID();
    const secondOwner = randomUUID();
    let current = utcTimestampSchema.parse("2026-08-03T12:10:00Z");
    const service = createConnectionService(workerStore, () => current);

    const firstLease = await service.acquireLease({
      connectionId,
      feed: "discovery",
      leaseOwnerId: firstOwner,
      expectedGeneration: 1n,
      leaseDurationSeconds: 1,
    });
    expect(firstLease.fencingToken).toBe(1n);

    await expect(
      readWorker.database.execute(sql`
        update ops.sync_checkpoints set feed = 'balances'
        where connection_id = ${connectionId} and feed = 'discovery'
      `),
    ).rejects.toMatchObject({ cause: { code: "23514" } });

    await expect(
      readWorker.database.execute(sql`
        update ops.sync_checkpoints
        set fencing_token = fencing_token + 1,
          lease_owner_id = ${secondOwner},
          lease_acquired_at = clock_timestamp(),
          lease_expires_at = clock_timestamp() + interval '1 minute'
        where connection_id = ${connectionId} and feed = 'discovery'
      `),
    ).rejects.toMatchObject({ cause: { code: "23514" } });

    current = utcTimestampSchema.parse("2026-08-03T12:10:30Z");
    await service.advanceDiscoveryCheckpoint({
      connectionId,
      feed: "discovery",
      leaseOwnerId: firstOwner,
      expectedGeneration: 1n,
      fencingToken: firstLease.fencingToken,
      cursor: cursor(connectionId),
    });
    await expect(
      service.acquireLease({
        connectionId,
        feed: "discovery",
        leaseOwnerId: secondOwner,
        expectedGeneration: 1n,
        leaseDurationSeconds: 60,
      }),
    ).rejects.toBeInstanceOf(ConnectionConflictError);

    await new Promise((resolve) => setTimeout(resolve, 1_100));
    current = utcTimestampSchema.parse("2026-08-03T12:11:01Z");
    const takeover = await service.acquireLease({
      connectionId,
      feed: "discovery",
      leaseOwnerId: secondOwner,
      expectedGeneration: 1n,
      leaseDurationSeconds: 60,
    });
    expect(takeover.fencingToken).toBe(2n);

    current = utcTimestampSchema.parse("2026-08-03T12:11:02Z");
    await expect(
      service.advanceDiscoveryCheckpoint({
        connectionId,
        feed: "discovery",
        leaseOwnerId: firstOwner,
        expectedGeneration: 1n,
        fencingToken: firstLease.fencingToken,
        cursor: null,
      }),
    ).rejects.toBeInstanceOf(ConnectionConflictError);
    await service.advanceDiscoveryCheckpoint({
      connectionId,
      feed: "discovery",
      leaseOwnerId: secondOwner,
      expectedGeneration: 1n,
      fencingToken: takeover.fencingToken,
      cursor: null,
    });

    const checkpoint = await readWorker.database.execute<{
      fencing_token: string;
      lease_owner_id: string;
      advanced_at: string;
    }>(sql`
      select fencing_token::text, lease_owner_id, advanced_at::text
      from ops.sync_checkpoints
      where connection_id = ${connectionId} and feed = 'discovery'
    `);
    expect(checkpoint[0]).toMatchObject({
      fencing_token: "2",
      lease_owner_id: secondOwner,
    });
    expect(Date.parse(checkpoint[0]!.advanced_at)).not.toBeNaN();
  });
});
