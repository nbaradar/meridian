import { z } from "zod";

import { type AccountSourceId } from "../ledger/identifiers";
import {
  accountSourceNameSchema,
  type AccountSourceName,
} from "../ledger/account-sources";
import { utcTimestampSchema, type UtcTimestamp } from "../ledger/timestamps";

export const connectionIdSchema = z.uuid().brand<"ConnectionId">();
export const connectionOperationIdSchema = z
  .uuid()
  .brand<"ConnectionOperationId">();
export const discoveredAccountIdSchema = z
  .uuid()
  .brand<"DiscoveredAccountId">();
export const leaseOwnerIdSchema = z.uuid().brand<"LeaseOwnerId">();

export type ConnectionId = z.infer<typeof connectionIdSchema>;
export type ConnectionOperationId = z.infer<typeof connectionOperationIdSchema>;
export type DiscoveredAccountId = z.infer<typeof discoveredAccountIdSchema>;
export type LeaseOwnerId = z.infer<typeof leaseOwnerIdSchema>;

const connectorSources = [
  "simplefin",
  "teller",
  "schwab",
  "snaptrade",
] as const satisfies readonly AccountSourceName[];

export const connectorSourceSchema = z.enum(connectorSources);
export type ConnectorSource = z.infer<typeof connectorSourceSchema>;

export const authorizationClassSchema = z.literal("read_only");
export const connectionStatusSchema = z.enum([
  "pending",
  "active",
  "reauthorization_required",
  "disabled",
  "revoked",
]);
export const connectionReasonCodeSchema = z.enum([
  "pending_authorization",
  "authorization_installed",
  "credential_refreshed",
  "provider_authentication_failed",
  "credential_expired",
  "credential_key_unavailable",
  "restore_validation_required",
  "user_disabled",
  "credential_revalidated",
  "user_revoked",
  "provider_revoked",
]);
export const reauthorizationReasonCodeSchema = z.enum([
  "provider_authentication_failed",
  "credential_expired",
  "credential_key_unavailable",
  "restore_validation_required",
]);
export const revocationReasonCodeSchema = z.enum([
  "user_revoked",
  "provider_revoked",
]);
export const connectionEventTypeSchema = z.enum([
  "connection_created",
  "authorization_installed",
  "credential_refreshed",
  "reauthorization_required",
  "connection_disabled",
  "connection_reenabled",
  "connection_revoked",
]);
export const connectionActorClassSchema = z.enum([
  "owner",
  "read_worker",
  "system",
]);

export type ConnectionStatus = z.infer<typeof connectionStatusSchema>;
export type ConnectionReasonCode = z.infer<typeof connectionReasonCodeSchema>;
export type ConnectionEventType = z.infer<typeof connectionEventTypeSchema>;
export type ConnectionActorClass = z.infer<typeof connectionActorClassSchema>;

export const credentialGenerationSchema = z.bigint().nonnegative();
export const fenceTokenSchema = z.bigint().positive();

const opaqueBase64Schema = z.base64().min(1);
const protectedEnvelopeFields = {
  encryptionAlgorithm: z.literal("xchacha20-poly1305-ietf"),
  encryptionKeyId: z.string().trim().min(1).max(128),
  keyStatus: z.literal("active"),
  nonce: opaqueBase64Schema,
  ciphertext: opaqueBase64Schema,
};

export const credentialEnvelopeSchema = z.strictObject({
  source: connectorSourceSchema,
  connectionId: connectionIdSchema,
  credentialGeneration: credentialGenerationSchema,
  authorizationClass: authorizationClassSchema,
  ...protectedEnvelopeFields,
});

export const providerIdentityDigestSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/u)
  .brand<"ProviderIdentityDigest">();

export const protectedProviderIdentitySchema = z.strictObject({
  source: connectorSourceSchema,
  connectionId: connectionIdSchema,
  discoveredAccountId: discoveredAccountIdSchema,
  lookupDigest: providerIdentityDigestSchema,
  digestKeyId: z.string().trim().min(1).max(128),
  ...protectedEnvelopeFields,
});

export const protectedCheckpointCursorSchema = z.strictObject({
  connectionId: connectionIdSchema,
  feed: z.literal("discovery"),
  ...protectedEnvelopeFields,
});

export type CredentialEnvelope = z.infer<typeof credentialEnvelopeSchema>;
export type ProtectedProviderIdentity = z.infer<
  typeof protectedProviderIdentitySchema
>;
export type ProtectedCheckpointCursor = z.infer<
  typeof protectedCheckpointCursorSchema
>;

export const connectionFeedSchema = z.enum([
  "discovery",
  "balances",
  "transactions",
  "positions",
]);
export type ConnectionFeed = z.infer<typeof connectionFeedSchema>;

export interface PendingConnection {
  id: ConnectionId;
  source: ConnectorSource;
  authorizationClass: "read_only";
  status: "pending";
  statusReason: "pending_authorization";
  credentialGeneration: 0n;
  authorizedAt: null;
  expiresAt: null;
  createdAt: UtcTimestamp;
}

export interface ConnectionEvent {
  id: ConnectionOperationId;
  connectionId: ConnectionId;
  eventType: ConnectionEventType;
  expectedCredentialGeneration: bigint | null;
  resultingCredentialGeneration: bigint;
  actorClass: ConnectionActorClass;
  reasonCode: ConnectionReasonCode;
  occurredAt: UtcTimestamp;
}

export interface CredentialCas {
  connectionId: ConnectionId;
  expectedCredentialGeneration: bigint;
  resultingCredentialGeneration: bigint;
  allowedFromStatuses: readonly ConnectionStatus[];
  resultingStatus: "active";
  statusReason: null;
  authorizedAt: UtcTimestamp;
  expiresAt: UtcTimestamp | null;
  envelope: CredentialEnvelope;
}

export interface StatusCas {
  connectionId: ConnectionId;
  expectedCredentialGeneration: bigint;
  allowedFromStatuses: readonly ConnectionStatus[];
  resultingStatus: Exclude<ConnectionStatus, "pending">;
  statusReason: ConnectionReasonCode | null;
  validatedAt: UtcTimestamp | null;
  deleteCredential: boolean;
}

export interface ReviewedDiscoveredAccount {
  id: DiscoveredAccountId;
  connectionId: ConnectionId;
  accountSourceId: AccountSourceId;
  source: ConnectorSource;
  expectedCredentialGeneration: bigint;
  leaseOwnerId: LeaseOwnerId;
  fencingToken: bigint;
  protectedIdentity: ProtectedProviderIdentity;
  status: "active";
  firstObservedAt: UtcTimestamp;
  lastObservedAt: UtcTimestamp;
}

export interface DiscoveryLeaseRequest {
  connectionId: ConnectionId;
  feed: "discovery";
  leaseOwnerId: LeaseOwnerId;
  expectedCredentialGeneration: bigint;
  requestedAt: UtcTimestamp;
  leaseDurationSeconds: number;
}

export interface DiscoveryLease {
  connectionId: ConnectionId;
  feed: "discovery";
  leaseOwnerId: LeaseOwnerId;
  credentialGeneration: bigint;
  fencingToken: bigint;
  acquiredAt: UtcTimestamp;
  expiresAt: UtcTimestamp;
}

export const discoveryLeaseSchema = z.strictObject({
  connectionId: connectionIdSchema,
  feed: z.literal("discovery"),
  leaseOwnerId: leaseOwnerIdSchema,
  credentialGeneration: credentialGenerationSchema,
  fencingToken: fenceTokenSchema,
  acquiredAt: utcTimestampSchema,
  expiresAt: utcTimestampSchema,
});

export interface DiscoveryCheckpointAdvance {
  connectionId: ConnectionId;
  feed: "discovery";
  leaseOwnerId: LeaseOwnerId;
  expectedCredentialGeneration: bigint;
  fencingToken: bigint;
  cursor: ProtectedCheckpointCursor | null;
  advancedAt: UtcTimestamp;
}

export interface ConnectionStore {
  createPending(
    connection: PendingConnection,
    event: ConnectionEvent,
  ): Promise<void>;
  compareAndSwapCredential(
    change: CredentialCas,
    event: ConnectionEvent,
  ): Promise<void>;
  compareAndSwapStatus(
    change: StatusCas,
    event: ConnectionEvent,
  ): Promise<void>;
  registerReviewedDiscovery(
    discovery: ReviewedDiscoveredAccount,
  ): Promise<void>;
  acquireDiscoveryLease(
    request: DiscoveryLeaseRequest,
  ): Promise<DiscoveryLease>;
  advanceDiscoveryCheckpoint(change: DiscoveryCheckpointAdvance): Promise<void>;
}

// Compile-time proof that this registry remains a subset of RFC 0002 sources.
accountSourceNameSchema.parse(connectorSources[0]);
