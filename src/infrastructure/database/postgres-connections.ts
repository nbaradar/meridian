import { sql, type SQL } from "drizzle-orm";

import type {
  ConnectionEvent,
  ConnectionStatus,
  ConnectionStore,
  CredentialCas,
  DiscoveryCheckpointAdvance,
  DiscoveryLease,
  DiscoveryLeaseRequest,
  PendingConnection,
  ReviewedDiscoveredAccount,
  StatusCas,
} from "../../core/connections";
import { utcTimestampSchema } from "../../core/ledger/timestamps";
import type { MeridianDatabase } from "./client";

interface SqlExecutor {
  execute(query: SQL): PromiseLike<unknown>;
}

export class ConnectionConflictError extends Error {
  override readonly name = "ConnectionConflictError";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

export class ConnectionReferenceError extends Error {
  override readonly name = "ConnectionReferenceError";
}

export class ConnectionPersistenceError extends Error {
  override readonly name = "ConnectionPersistenceError";

  constructor(operation: string, options?: ErrorOptions) {
    super(`Connection ${operation} could not be persisted`, options);
  }
}

async function executeRows<TResult>(
  executor: SqlExecutor,
  query: SQL,
): Promise<TResult[]> {
  return (await executor.execute(query)) as TResult[];
}

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

function mapPersistenceError(operation: string, error: unknown): never {
  if (
    error instanceof ConnectionConflictError ||
    error instanceof ConnectionReferenceError
  ) {
    throw error;
  }
  const code = postgresErrorCode(error);
  if (code === "23503") {
    throw new ConnectionReferenceError(
      `Connection ${operation} references missing reviewed state`,
    );
  }
  if (
    code === "23505" ||
    code === "23514" ||
    code === "42501" ||
    code === "40001" ||
    code === "40P01" ||
    code === "55000"
  ) {
    throw new ConnectionConflictError(
      `Connection ${operation} conflicts with current operational state`,
      { cause: error },
    );
  }
  throw new ConnectionPersistenceError(operation, { cause: error });
}

function conflict(message: string): never {
  throw new ConnectionConflictError(message);
}

function statusList(statuses: readonly ConnectionStatus[]): SQL {
  if (statuses.length === 0)
    conflict("Connection transition has no eligible status");
  return sql.join(
    statuses.map((status) => sql`${status}`),
    sql`, `,
  );
}

function validateEvent(
  event: ConnectionEvent,
  connectionId: string,
  expectedGeneration: bigint | null,
  resultingGeneration: bigint,
): void {
  if (
    event.connectionId !== connectionId ||
    event.expectedCredentialGeneration !== expectedGeneration ||
    event.resultingCredentialGeneration !== resultingGeneration
  ) {
    conflict("Connection event does not match its lifecycle transition");
  }
}

async function insertEvent(
  executor: SqlExecutor,
  event: ConnectionEvent,
): Promise<void> {
  await executor.execute(sql`
    insert into ops.connection_events (
      id, connection_id, event_type, expected_credential_generation,
      resulting_credential_generation, actor_class, reason_code
    ) values (
      ${event.id}, ${event.connectionId}, ${event.eventType},
      ${event.expectedCredentialGeneration}, ${event.resultingCredentialGeneration},
      ${event.actorClass}, ${event.reasonCode}
    )
  `);
}

async function hasMatchingEvent(
  executor: SqlExecutor,
  event: ConnectionEvent,
): Promise<boolean> {
  const rows = await executeRows<{ matches: boolean }>(
    executor,
    sql`
    select exists (
      select 1 from ops.connection_events
      where id = ${event.id}
        and connection_id = ${event.connectionId}
        and event_type = ${event.eventType}
        and expected_credential_generation is not distinct from ${event.expectedCredentialGeneration}::bigint
        and resulting_credential_generation = ${event.resultingCredentialGeneration}
        and actor_class = ${event.actorClass}
        and reason_code = ${event.reasonCode}
    ) as matches
  `,
  );
  return rows[0]?.matches === true;
}

async function createPending(
  executor: SqlExecutor,
  connection: PendingConnection,
  event: ConnectionEvent,
): Promise<void> {
  validateEvent(event, connection.id, null, 0n);
  if (event.occurredAt !== connection.createdAt) {
    conflict("Connection creation event time does not match the connection");
  }
  const inserted = await executeRows<{ id: string }>(
    executor,
    sql`
    insert into ops.connections (
      id, source, authorization_class, status, status_reason,
      last_operation_id, credential_generation, authorized_at, expires_at,
      created_at, updated_at
    ) values (
      ${connection.id}, ${connection.source}, ${connection.authorizationClass},
      ${connection.status}, ${connection.statusReason},
      ${event.id}, ${connection.credentialGeneration}, ${connection.authorizedAt},
      ${connection.expiresAt}, ${connection.createdAt}, ${connection.createdAt}
    )
    on conflict (id) do nothing
    returning id
  `,
  );
  if (inserted.length > 0) {
    await insertEvent(executor, event);
    return;
  }

  const rows = await executeRows<{ matches: boolean }>(
    executor,
    sql`
    select (
      source = ${connection.source}
      and authorization_class = ${connection.authorizationClass}
      and status = ${connection.status}
      and status_reason = ${connection.statusReason}
      and last_operation_id = ${event.id}
      and credential_generation = ${connection.credentialGeneration}
      and authorized_at is null and expires_at is null
    ) as matches
    from ops.connections where id = ${connection.id}
    for update
  `,
  );
  if (rows[0]?.matches !== true || !(await hasMatchingEvent(executor, event))) {
    conflict("Connection ID conflicts with an existing connection");
  }
}

async function credentialReplayMatches(
  executor: SqlExecutor,
  change: CredentialCas,
  event: ConnectionEvent,
): Promise<boolean> {
  const envelope = change.envelope;
  const rows = await executeRows<{ matches: boolean }>(
    executor,
    sql`
    select (
      c.source = ${envelope.source}
      and c.authorization_class = ${envelope.authorizationClass}
      and c.status = ${change.resultingStatus}
      and c.status_reason is not distinct from ${change.statusReason}::text
      and c.last_operation_id = ${event.id}
      and c.credential_generation = ${change.resultingCredentialGeneration}
      and c.expires_at is not distinct from ${change.expiresAt}::timestamptz
      and ops.credential_envelope_matches(
        ${change.connectionId}, ${change.resultingCredentialGeneration},
        ${envelope.encryptionAlgorithm}, ${envelope.encryptionKeyId},
        ${envelope.keyStatus}, ${envelope.nonce}, ${envelope.ciphertext}
      )
    ) as matches
    from ops.connections c
    where c.id = ${change.connectionId}
  `,
  );
  return rows[0]?.matches === true && (await hasMatchingEvent(executor, event));
}

async function compareAndSwapCredential(
  executor: SqlExecutor,
  change: CredentialCas,
  event: ConnectionEvent,
): Promise<void> {
  validateEvent(
    event,
    change.connectionId,
    change.expectedCredentialGeneration,
    change.resultingCredentialGeneration,
  );
  if (
    change.resultingCredentialGeneration !==
      change.expectedCredentialGeneration + 1n ||
    change.envelope.connectionId !== change.connectionId ||
    change.envelope.credentialGeneration !==
      change.resultingCredentialGeneration ||
    event.occurredAt !== change.authorizedAt
  ) {
    conflict("Credential transition command is internally inconsistent");
  }

  const locked = await executeRows<{ generation: string }>(
    executor,
    sql`
    select credential_generation::text as generation
    from ops.connections where id = ${change.connectionId}
    for update
  `,
  );
  if (!locked[0]) {
    throw new ConnectionReferenceError(
      "Credential transition references an unknown connection",
    );
  }
  if (await credentialReplayMatches(executor, change, event)) return;

  const updated = await executeRows<{ id: string }>(
    executor,
    sql`
    update ops.connections set
      status = ${change.resultingStatus},
      status_reason = ${change.statusReason},
      last_operation_id = ${event.id},
      credential_generation = ${change.resultingCredentialGeneration},
      authorized_at = ${change.authorizedAt},
      expires_at = ${change.expiresAt},
      updated_at = ${event.occurredAt}
    where id = ${change.connectionId}
      and source = ${change.envelope.source}
      and authorization_class = ${change.envelope.authorizationClass}
      and credential_generation = ${change.expectedCredentialGeneration}
      and status in (${statusList(change.allowedFromStatuses)})
    returning id
  `,
  );
  if (updated.length === 0) {
    conflict("Credential transition lost its expected status or generation");
  }
  await insertEvent(executor, event);
  const envelope = change.envelope;
  const updatedSecret = await executeRows<{ connection_id: string }>(
    executor,
    sql`
    update ops.connection_secrets set
      credential_generation = ${envelope.credentialGeneration},
      encryption_algorithm = ${envelope.encryptionAlgorithm},
      encryption_key_id = ${envelope.encryptionKeyId},
      key_status = ${envelope.keyStatus},
      nonce = ${envelope.nonce},
      ciphertext = ${envelope.ciphertext},
      updated_at = ${event.occurredAt}
    where connection_id = ${change.connectionId}
    returning connection_id
  `,
  );
  if (updatedSecret.length === 0) {
    await executor.execute(sql`
      insert into ops.connection_secrets (
        connection_id, credential_generation, encryption_algorithm,
        encryption_key_id, key_status, nonce, ciphertext, updated_at
      ) values (
        ${change.connectionId}, ${envelope.credentialGeneration},
        ${envelope.encryptionAlgorithm}, ${envelope.encryptionKeyId},
        ${envelope.keyStatus}, ${envelope.nonce}, ${envelope.ciphertext},
        ${event.occurredAt}
      )
    `);
  }
}

async function statusReplayMatches(
  executor: SqlExecutor,
  change: StatusCas,
  event: ConnectionEvent,
): Promise<boolean> {
  const rows = await executeRows<{ matches: boolean }>(
    executor,
    sql`
    select (
      c.status = ${change.resultingStatus}
      and c.status_reason is not distinct from ${change.statusReason}::text
      and c.last_operation_id = ${event.id}
      and c.credential_generation = ${change.expectedCredentialGeneration}
    ) as matches
    from ops.connections c
    where c.id = ${change.connectionId}
  `,
  );
  return rows[0]?.matches === true && (await hasMatchingEvent(executor, event));
}

async function compareAndSwapStatus(
  executor: SqlExecutor,
  change: StatusCas,
  event: ConnectionEvent,
): Promise<void> {
  validateEvent(
    event,
    change.connectionId,
    change.expectedCredentialGeneration,
    change.expectedCredentialGeneration,
  );
  const locked = await executeRows<{ id: string }>(
    executor,
    sql`
    select id from ops.connections where id = ${change.connectionId} for update
  `,
  );
  if (!locked[0]) {
    throw new ConnectionReferenceError(
      "Status transition references an unknown connection",
    );
  }
  if (await statusReplayMatches(executor, change, event)) return;

  const transition = change.validatedAt
    ? sql`
        update ops.connections set
          status = ${change.resultingStatus},
          status_reason = ${change.statusReason},
          last_operation_id = ${event.id},
          last_succeeded_at = ${change.validatedAt},
          updated_at = ${event.occurredAt}
        where id = ${change.connectionId}
          and credential_generation = ${change.expectedCredentialGeneration}
          and status in (${statusList(change.allowedFromStatuses)})
        returning id
      `
    : sql`
    update ops.connections set
      status = ${change.resultingStatus},
      status_reason = ${change.statusReason},
      last_operation_id = ${event.id},
      updated_at = ${event.occurredAt}
    where id = ${change.connectionId}
      and credential_generation = ${change.expectedCredentialGeneration}
      and status in (${statusList(change.allowedFromStatuses)})
    returning id
  `;
  const updated = await executeRows<{ id: string }>(executor, transition);
  if (updated.length === 0) {
    conflict("Status transition lost its expected status or generation");
  }
  await insertEvent(executor, event);
  if (change.deleteCredential) {
    await executor.execute(sql`
      delete from ops.connection_secrets
      where connection_id = ${change.connectionId}
    `);
  }
}

async function registerReviewedDiscovery(
  executor: SqlExecutor,
  discovery: ReviewedDiscoveredAccount,
): Promise<void> {
  const identity = discovery.protectedIdentity;
  if (
    identity.connectionId !== discovery.connectionId ||
    identity.discoveredAccountId !== discovery.id ||
    identity.source !== discovery.source
  ) {
    conflict("Reviewed discovery identity does not match its command");
  }
  const inserted = await executeRows<{ id: string }>(
    executor,
    sql`
    insert into ops.discovered_accounts (
      id, connection_id, account_source_id, source,
      credential_generation, discovery_fencing_token, lease_owner_id,
      provider_account_id_ciphertext, provider_account_id_nonce,
      provider_account_id_digest, encryption_algorithm, encryption_key_id,
      digest_key_id, key_status, status, first_observed_at, last_observed_at
    ) values (
      ${discovery.id}, ${discovery.connectionId}, ${discovery.accountSourceId},
      ${discovery.source}, ${discovery.expectedCredentialGeneration},
      ${discovery.fencingToken}, ${discovery.leaseOwnerId},
      ${identity.ciphertext}, ${identity.nonce},
      ${identity.lookupDigest}, ${identity.encryptionAlgorithm},
      ${identity.encryptionKeyId}, ${identity.digestKeyId}, ${identity.keyStatus},
      ${discovery.status}, ${discovery.firstObservedAt}, ${discovery.lastObservedAt}
    )
    on conflict do nothing
    returning id
  `,
  );
  if (inserted.length > 0) return;

  const rows = await executeRows<{ id: string }>(
    executor,
    sql`
    update ops.discovered_accounts set
      credential_generation = ${discovery.expectedCredentialGeneration},
      discovery_fencing_token = ${discovery.fencingToken},
      lease_owner_id = ${discovery.leaseOwnerId},
      provider_account_id_ciphertext = ${identity.ciphertext},
      provider_account_id_nonce = ${identity.nonce},
      encryption_algorithm = ${identity.encryptionAlgorithm},
      encryption_key_id = ${identity.encryptionKeyId},
      key_status = ${identity.keyStatus},
      last_observed_at = ${discovery.lastObservedAt}
    where id = ${discovery.id}
      and connection_id = ${discovery.connectionId}
      and account_source_id = ${discovery.accountSourceId}
      and source = ${discovery.source}
      and provider_account_id_digest = ${identity.lookupDigest}
      and digest_key_id = ${identity.digestKeyId}
      and status = ${discovery.status}
    returning id
  `,
  );
  if (rows.length === 0) {
    conflict("Reviewed discovery conflicts with an existing identity");
  }
}

function leaseExpiry(
  request: DiscoveryLeaseRequest,
): DiscoveryLease["expiresAt"] {
  if (
    !Number.isInteger(request.leaseDurationSeconds) ||
    request.leaseDurationSeconds <= 0
  ) {
    conflict("Discovery lease duration must be a positive integer");
  }
  return utcTimestampSchema.parse(
    new Date(
      new Date(request.requestedAt).getTime() +
        request.leaseDurationSeconds * 1_000,
    ).toISOString(),
  );
}

async function acquireDiscoveryLease(
  executor: SqlExecutor,
  request: DiscoveryLeaseRequest,
): Promise<DiscoveryLease> {
  leaseExpiry(request);
  const connections = await executeRows<{ active: boolean }>(
    executor,
    sql`
    select (
      status = 'active'
      and credential_generation = ${request.expectedCredentialGeneration}
      and (expires_at is null or expires_at > clock_timestamp())
    ) as active
    from ops.connections where id = ${request.connectionId}
    for update
  `,
  );
  if (!connections[0]) {
    throw new ConnectionReferenceError(
      "Discovery lease references an unknown connection",
    );
  }
  if (!connections[0].active) {
    conflict(
      "Discovery lease requires an active unexpired connection generation",
    );
  }

  await executor.execute(sql`
    insert into ops.sync_checkpoints (
      connection_id, feed, credential_generation, fencing_token
    ) values (
      ${request.connectionId}, ${request.feed},
      ${request.expectedCredentialGeneration}, 0
    )
    on conflict (connection_id, feed) do nothing
  `);
  const current = await executeRows<{
    credential_generation: string;
    fencing_token: string;
    lease_owner_id: string | null;
    lease_acquired_at: string | Date | null;
    lease_expires_at: string | Date | null;
    lease_is_active: boolean;
  }>(
    executor,
    sql`
    select credential_generation::text, fencing_token::text, lease_owner_id,
      lease_acquired_at, lease_expires_at,
      lease_expires_at > clock_timestamp() as lease_is_active
    from ops.sync_checkpoints
    where connection_id = ${request.connectionId} and feed = ${request.feed}
    for update
  `,
  );
  const checkpoint = current[0];
  if (!checkpoint) conflict("Discovery checkpoint could not be locked");

  const currentExpiry = checkpoint.lease_expires_at;
  if (checkpoint.lease_is_active) {
    const exactReplay =
      checkpoint.lease_owner_id === request.leaseOwnerId &&
      BigInt(checkpoint.credential_generation) ===
        request.expectedCredentialGeneration;
    if (!exactReplay) {
      conflict("Discovery lease is already held by an unexpired worker");
    }
    return {
      connectionId: request.connectionId,
      feed: request.feed,
      leaseOwnerId: request.leaseOwnerId,
      credentialGeneration: request.expectedCredentialGeneration,
      fencingToken: BigInt(checkpoint.fencing_token),
      acquiredAt: utcTimestampSchema.parse(
        new Date(checkpoint.lease_acquired_at!).toISOString(),
      ),
      expiresAt: utcTimestampSchema.parse(
        new Date(currentExpiry!).toISOString(),
      ),
    };
  }

  const rows = await executeRows<{
    fencing_token: string;
    lease_acquired_at: string | Date;
    lease_expires_at: string | Date;
  }>(
    executor,
    sql`
    update ops.sync_checkpoints set
      credential_generation = ${request.expectedCredentialGeneration},
      fencing_token = fencing_token + 1,
      lease_owner_id = ${request.leaseOwnerId},
      lease_acquired_at = clock_timestamp(),
      lease_expires_at = clock_timestamp() + (${request.leaseDurationSeconds} * interval '1 second')
    where connection_id = ${request.connectionId} and feed = ${request.feed}
    returning fencing_token::text, lease_acquired_at, lease_expires_at
  `,
  );
  const acquired = rows[0];
  if (!acquired) conflict("Discovery lease could not be acquired");
  return {
    connectionId: request.connectionId,
    feed: request.feed,
    leaseOwnerId: request.leaseOwnerId,
    credentialGeneration: request.expectedCredentialGeneration,
    fencingToken: BigInt(acquired.fencing_token),
    acquiredAt: utcTimestampSchema.parse(
      new Date(acquired.lease_acquired_at).toISOString(),
    ),
    expiresAt: utcTimestampSchema.parse(
      new Date(acquired.lease_expires_at).toISOString(),
    ),
  };
}

async function advanceDiscoveryCheckpoint(
  executor: SqlExecutor,
  change: DiscoveryCheckpointAdvance,
): Promise<void> {
  const cursor = change.cursor;
  if (
    cursor !== null &&
    (cursor.connectionId !== change.connectionId || cursor.feed !== change.feed)
  ) {
    conflict("Discovery cursor does not match its checkpoint");
  }
  const rows = await executeRows<{ connection_id: string }>(
    executor,
    sql`
    update ops.sync_checkpoints checkpoint set
      cursor_encryption_algorithm = ${cursor?.encryptionAlgorithm ?? null},
      cursor_encryption_key_id = ${cursor?.encryptionKeyId ?? null},
      cursor_key_status = ${cursor?.keyStatus ?? null},
      cursor_nonce = ${cursor?.nonce ?? null},
      cursor_ciphertext = ${cursor?.ciphertext ?? null},
      advanced_at = clock_timestamp()
    where checkpoint.connection_id = ${change.connectionId}
      and checkpoint.feed = ${change.feed}
      and checkpoint.lease_owner_id = ${change.leaseOwnerId}
      and checkpoint.credential_generation = ${change.expectedCredentialGeneration}
      and checkpoint.fencing_token = ${change.fencingToken}
      and checkpoint.lease_expires_at > clock_timestamp()
      and exists (
        select 1 from ops.connections connection
        where connection.id = checkpoint.connection_id
          and connection.status = 'active'
          and connection.credential_generation = ${change.expectedCredentialGeneration}
          and (connection.expires_at is null or connection.expires_at > clock_timestamp())
      )
    returning checkpoint.connection_id
  `,
  );
  if (rows.length === 0) {
    conflict("Discovery checkpoint lost its active lease or fencing token");
  }
}

export function createPostgresConnectionStore(
  database: MeridianDatabase,
): ConnectionStore {
  return {
    async createPending(connection, event) {
      try {
        await database.transaction((transaction) =>
          createPending(transaction, connection, event),
        );
      } catch (error) {
        mapPersistenceError("creation", error);
      }
    },

    async compareAndSwapCredential(change, event) {
      try {
        await database.transaction((transaction) =>
          compareAndSwapCredential(transaction, change, event),
        );
      } catch (error) {
        mapPersistenceError("credential transition", error);
      }
    },

    async compareAndSwapStatus(change, event) {
      try {
        await database.transaction((transaction) =>
          compareAndSwapStatus(transaction, change, event),
        );
      } catch (error) {
        mapPersistenceError("status transition", error);
      }
    },

    async registerReviewedDiscovery(discovery) {
      try {
        await database.transaction((transaction) =>
          registerReviewedDiscovery(transaction, discovery),
        );
      } catch (error) {
        mapPersistenceError("reviewed discovery registration", error);
      }
    },

    async acquireDiscoveryLease(request) {
      try {
        return await database.transaction((transaction) =>
          acquireDiscoveryLease(transaction, request),
        );
      } catch (error) {
        mapPersistenceError("discovery lease acquisition", error);
      }
    },

    async advanceDiscoveryCheckpoint(change) {
      try {
        await database.transaction((transaction) =>
          advanceDiscoveryCheckpoint(transaction, change),
        );
      } catch (error) {
        mapPersistenceError("discovery checkpoint advance", error);
      }
    },
  };
}
