import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  char,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const ledger = pgSchema("ledger");
const ops = pgSchema("ops");
const recordedAt = () =>
  timestamp("recorded_at", { withTimezone: true, mode: "string" })
    .notNull()
    .defaultNow();

export const accounts = ledger.table(
  "accounts",
  {
    id: uuid("id").primaryKey(),
    // The physical `kind` name is retained for migration compatibility; in the
    // domain this is the derived accounting class, not the user-facing type.
    accountClass: text("kind").notNull(),
    accountType: text("type").notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    openedOn: date("opened_on", { mode: "string" }),
    recordedAt: recordedAt(),
  },
  (table) => [
    check(
      "accounts_class_check",
      sql`${table.accountClass} in ('asset', 'liability')`,
    ),
    check(
      "accounts_type_check",
      sql`${table.accountType} in ('checking', 'savings', 'cash', 'credit_card', 'loan', 'mortgage', 'brokerage', 'retirement', 'crypto', 'other')`,
    ),
    check(
      "accounts_type_class_check",
      sql`(
        (${table.accountType} in ('checking', 'savings', 'cash', 'brokerage', 'retirement', 'crypto') and ${table.accountClass} = 'asset')
        or (${table.accountType} in ('credit_card', 'loan', 'mortgage') and ${table.accountClass} = 'liability')
        or ${table.accountType} = 'other'
      )`,
    ),
    check("accounts_currency_check", sql`${table.currency} = 'USD'`),
  ],
);

export const accountRevisions = ledger.table(
  "account_revisions",
  {
    id: uuid("id").primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id),
    name: text("name").notNull(),
    status: text("status").notNull(),
    displayMetadata: jsonb("display_metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    effectiveAt: timestamp("effective_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    recordedAt: recordedAt(),
  },
  (table) => [
    check(
      "account_revisions_name_check",
      sql`length(btrim(${table.name})) > 0`,
    ),
    check(
      "account_revisions_status_check",
      sql`${table.status} in ('active', 'closed')`,
    ),
    index("account_revisions_current_idx").on(
      table.accountId,
      table.effectiveAt,
      table.recordedAt,
    ),
  ],
);

export const accountSources = ledger.table(
  "account_sources",
  {
    id: uuid("id").primaryKey(),
    source: text("source").notNull(),
    sourceKind: text("source_kind").notNull(),
    ingestedAt: timestamp("ingested_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    recordedAt: recordedAt(),
  },
  (table) => [
    check(
      "account_sources_source_check",
      sql`${table.source} in ('ynab', 'manual_csv', 'simplefin', 'teller', 'schwab', 'snaptrade')`,
    ),
    check(
      "account_sources_kind_check",
      sql`${table.sourceKind} in ('import', 'connector')`,
    ),
    check(
      "account_sources_time_check",
      sql`${table.ingestedAt} <= ${table.recordedAt}`,
    ),
  ],
);

export const accountSourceLinkRevisions = ledger.table(
  "account_source_link_revisions",
  {
    id: uuid("id").primaryKey(),
    accountSourceId: uuid("account_source_id").notNull(),
    accountId: uuid("account_id").notNull(),
    status: text("status").notNull(),
    supersedesLinkRevisionId: uuid("supersedes_link_revision_id"),
    reasonCode: text("reason_code").notNull(),
    recordedAt: recordedAt(),
  },
  (table) => [
    foreignKey({
      name: "account_source_links_source_fk",
      columns: [table.accountSourceId],
      foreignColumns: [accountSources.id],
    }),
    foreignKey({
      name: "account_source_links_account_fk",
      columns: [table.accountId],
      foreignColumns: [accounts.id],
    }),
    foreignKey({
      name: "account_source_links_predecessor_fk",
      columns: [table.supersedesLinkRevisionId],
      foreignColumns: [table.id],
    }),
    check(
      "account_source_links_status_check",
      sql`${table.status} in ('linked', 'unlinked')`,
    ),
    check(
      "account_source_links_reason_check",
      sql`(
        (${table.status} = 'linked' and ${table.reasonCode} in ('initial_mapping', 'mapping_correction_linked', 'source_reassociated'))
        or (${table.status} = 'unlinked' and ${table.reasonCode} in ('user_unlinked', 'mapping_correction_unlinked'))
      )`,
    ),
    check(
      "account_source_links_not_self_check",
      sql`${table.supersedesLinkRevisionId} is null or ${table.supersedesLinkRevisionId} <> ${table.id}`,
    ),
    uniqueIndex("account_source_links_supersedes_unique").on(
      table.supersedesLinkRevisionId,
    ),
    uniqueIndex("account_source_links_root_unique")
      .on(table.accountSourceId)
      .where(sql`${table.supersedesLinkRevisionId} is null`),
    index("account_source_links_account_idx").on(table.accountId),
  ],
);

// RFC 0005: reviewed YNAB account decisions, recognized in later exports by a
// keyed digest of the YNAB account name. The name itself is never stored.
export const ynabAccountDecisions = ledger.table(
  "ynab_account_decisions",
  {
    id: uuid("id").primaryKey(),
    labelDigest: text("label_digest").notNull(),
    digestKeyId: text("digest_key_id").notNull(),
    decision: text("decision").notNull(),
    accountSourceId: uuid("account_source_id"),
    supersedesDecisionId: uuid("supersedes_decision_id"),
    recordedAt: recordedAt(),
  },
  (table) => [
    foreignKey({
      name: "ynab_account_decisions_source_fk",
      columns: [table.accountSourceId],
      foreignColumns: [accountSources.id],
    }),
    foreignKey({
      name: "ynab_account_decisions_predecessor_fk",
      columns: [table.supersedesDecisionId],
      foreignColumns: [table.id],
    }),
    check(
      "ynab_account_decisions_decision_check",
      sql`${table.decision} in ('tracked', 'excluded')`,
    ),
    check(
      "ynab_account_decisions_source_check",
      sql`(${table.decision} = 'tracked') = (${table.accountSourceId} is not null)`,
    ),
    check(
      "ynab_account_decisions_digest_check",
      sql`${table.labelDigest} ~ '^[0-9a-f]{64}$' and length(btrim(${table.digestKeyId})) > 0`,
    ),
    check(
      "ynab_account_decisions_not_self_check",
      sql`${table.supersedesDecisionId} is null or ${table.supersedesDecisionId} <> ${table.id}`,
    ),
    uniqueIndex("ynab_account_decisions_supersedes_unique").on(
      table.supersedesDecisionId,
    ),
    uniqueIndex("ynab_account_decisions_root_unique")
      .on(table.digestKeyId, table.labelDigest)
      .where(sql`${table.supersedesDecisionId} is null`),
    index("ynab_account_decisions_source_idx").on(table.accountSourceId),
  ],
);

export const categories = ledger.table(
  "categories",
  {
    id: uuid("id").primaryKey(),
    kind: text("kind").notNull(),
    recordedAt: recordedAt(),
  },
  (table) => [
    check(
      "categories_kind_check",
      sql`${table.kind} in ('expense', 'income', 'transfer')`,
    ),
  ],
);

export const categoryRevisions = ledger.table(
  "category_revisions",
  {
    id: uuid("id").primaryKey(),
    categoryId: uuid("category_id")
      .notNull()
      .references(() => categories.id),
    parentCategoryId: uuid("parent_category_id").references(
      (): AnyPgColumn => categories.id,
    ),
    name: text("name").notNull(),
    effectiveAt: timestamp("effective_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    recordedAt: recordedAt(),
  },
  (table) => [
    check(
      "category_revisions_name_check",
      sql`length(btrim(${table.name})) > 0`,
    ),
    check(
      "category_revisions_parent_check",
      sql`${table.parentCategoryId} is null or ${table.parentCategoryId} <> ${table.categoryId}`,
    ),
    index("category_revisions_current_idx").on(
      table.categoryId,
      table.effectiveAt,
      table.recordedAt,
    ),
  ],
);

export const rawPayloads = ledger.table(
  "raw_payloads",
  {
    id: uuid("id").primaryKey(),
    source: text("source").notNull(),
    contentDigest: char("content_digest", { length: 64 }).notNull(),
    encryptionAlgorithm: text("encryption_algorithm").notNull(),
    encryptionKeyId: text("encryption_key_id").notNull(),
    nonce: text("nonce").notNull(),
    ciphertext: text("ciphertext").notNull(),
    fetchedAt: timestamp("fetched_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    ingestedAt: timestamp("ingested_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
  },
  (table) => [
    check("raw_payloads_source_check", sql`length(btrim(${table.source})) > 0`),
    check(
      "raw_payloads_digest_check",
      sql`${table.contentDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "raw_payloads_algorithm_check",
      sql`length(btrim(${table.encryptionAlgorithm})) > 0`,
    ),
    check(
      "raw_payloads_key_id_check",
      sql`length(btrim(${table.encryptionKeyId})) > 0`,
    ),
    check("raw_payloads_nonce_check", sql`length(${table.nonce}) > 0`),
    check(
      "raw_payloads_ciphertext_check",
      sql`length(${table.ciphertext}) > 0`,
    ),
  ],
);

export const imports = ledger.table(
  "imports",
  {
    id: uuid("id").primaryKey(),
    importerId: text("importer_id").notNull(),
    importerVersion: text("importer_version").notNull(),
    contentDigest: char("content_digest", { length: 64 }).notNull(),
    rawPayloadId: uuid("raw_payload_id")
      .notNull()
      .references(() => rawPayloads.id),
    importedAt: timestamp("imported_at", {
      withTimezone: true,
      mode: "string",
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "imports_importer_id_check",
      sql`length(btrim(${table.importerId})) > 0`,
    ),
    check(
      "imports_importer_version_check",
      sql`length(btrim(${table.importerVersion})) > 0`,
    ),
    check(
      "imports_digest_check",
      sql`${table.contentDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    uniqueIndex("imports_content_unique").on(
      table.importerId,
      table.importerVersion,
      table.contentDigest,
    ),
  ],
);

export const sourceRecords = ledger.table(
  "source_records",
  {
    id: uuid("id").primaryKey(),
    source: text("source").notNull(),
    sourceRef: text("source_ref").notNull(),
    contentDigest: char("content_digest", { length: 64 }).notNull(),
    rawPayloadId: uuid("raw_payload_id")
      .notNull()
      .references(() => rawPayloads.id),
    supersedesSourceRecordId: uuid("supersedes_source_record_id").references(
      (): AnyPgColumn => sourceRecords.id,
    ),
    ingestedAt: timestamp("ingested_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
  },
  (table) => [
    check(
      "source_records_source_check",
      sql`length(btrim(${table.source})) > 0`,
    ),
    check(
      "source_records_source_ref_check",
      sql`length(btrim(${table.sourceRef})) > 0`,
    ),
    check(
      "source_records_digest_check",
      sql`${table.contentDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "source_records_not_self_check",
      sql`${table.supersedesSourceRecordId} is null or ${table.supersedesSourceRecordId} <> ${table.id}`,
    ),
    uniqueIndex("source_records_version_unique").on(
      table.source,
      table.sourceRef,
      table.contentDigest,
    ),
    uniqueIndex("source_records_supersedes_unique").on(
      table.supersedesSourceRecordId,
    ),
    uniqueIndex("source_records_root_unique")
      .on(table.source, table.sourceRef)
      .where(sql`${table.supersedesSourceRecordId} is null`),
  ],
);

export const sourceRecordAccountSets = ledger.table(
  "source_record_account_sets",
  {
    id: uuid("id").primaryKey(),
    sourceRecordId: uuid("source_record_id")
      .notNull()
      .references(() => sourceRecords.id),
    supersedesAccountSetRevisionId: uuid(
      "supersedes_account_set_revision_id",
    ).references((): AnyPgColumn => sourceRecordAccountSets.id),
    memberCount: integer("member_count").notNull(),
    recordedAt: recordedAt(),
  },
  (table) => [
    check(
      "source_record_account_sets_member_count_check",
      sql`${table.memberCount} > 0`,
    ),
    check(
      "source_record_account_sets_not_self_check",
      sql`${table.supersedesAccountSetRevisionId} is null or ${table.supersedesAccountSetRevisionId} <> ${table.id}`,
    ),
    uniqueIndex("source_record_account_sets_supersedes_unique").on(
      table.supersedesAccountSetRevisionId,
    ),
    uniqueIndex("source_record_account_sets_root_unique")
      .on(table.sourceRecordId)
      .where(sql`${table.supersedesAccountSetRevisionId} is null`),
  ],
);

export const sourceRecordAccounts = ledger.table(
  "source_record_accounts",
  {
    accountSetRevisionId: uuid("account_set_revision_id")
      .notNull()
      .references(() => sourceRecordAccountSets.id),
    accountSourceId: uuid("account_source_id")
      .notNull()
      .references(() => accountSources.id),
    linkRevisionId: uuid("link_revision_id")
      .notNull()
      .references(() => accountSourceLinkRevisions.id),
    role: text("role").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.accountSetRevisionId, table.accountSourceId],
    }),
    check(
      "source_record_accounts_role_check",
      sql`${table.role} = 'observed_account'`,
    ),
  ],
);

export const transactions = ledger.table(
  "transactions",
  {
    id: uuid("id").primaryKey(),
    occurredOn: date("occurred_on", { mode: "string" }).notNull(),
    occurredAt: timestamp("occurred_at", {
      withTimezone: true,
      mode: "string",
    }),
    description: text("description").notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    origin: text("origin").notNull(),
    sourceRecordId: uuid("source_record_id").references(() => sourceRecords.id),
    correctsTransactionId: uuid("corrects_transaction_id").references(
      (): AnyPgColumn => transactions.id,
    ),
    recordedAt: recordedAt(),
  },
  (table) => [
    check(
      "transactions_description_check",
      sql`length(btrim(${table.description})) > 0`,
    ),
    check("transactions_currency_check", sql`${table.currency} = 'USD'`),
    check(
      "transactions_origin_check",
      sql`${table.origin} in ('manual', 'system', 'external')`,
    ),
    check(
      "transactions_origin_source_check",
      sql`(${table.origin} = 'external') = (${table.sourceRecordId} is not null)`,
    ),
    check(
      "transactions_not_self_correction_check",
      sql`${table.correctsTransactionId} is null or ${table.correctsTransactionId} <> ${table.id}`,
    ),
    check(
      "transactions_correction_source_check",
      sql`${table.correctsTransactionId} is null or ${table.sourceRecordId} is null`,
    ),
    check(
      "transactions_correction_origin_check",
      sql`${table.correctsTransactionId} is null or ${table.origin} = 'system'`,
    ),
    uniqueIndex("transactions_source_record_unique").on(table.sourceRecordId),
    uniqueIndex("transactions_correction_unique").on(
      table.correctsTransactionId,
    ),
  ],
);

export const entries = ledger.table(
  "entries",
  {
    id: uuid("id").primaryKey(),
    transactionId: uuid("transaction_id")
      .notNull()
      .references(() => transactions.id),
    accountId: uuid("account_id").references(() => accounts.id),
    categoryId: uuid("category_id").references(() => categories.id),
    amount: numeric("amount").notNull(),
    recordedAt: recordedAt(),
  },
  (table) => [
    check(
      "entries_destination_check",
      sql`num_nonnulls(${table.accountId}, ${table.categoryId}) = 1`,
    ),
    index("entries_transaction_idx").on(table.transactionId),
    index("entries_account_idx").on(table.accountId),
    index("entries_category_idx").on(table.categoryId),
  ],
);

export const connections = ops.table(
  "connections",
  {
    id: uuid("id").primaryKey(),
    source: text("source").notNull(),
    authorizationClass: text("authorization_class").notNull(),
    status: text("status").notNull(),
    statusReason: text("status_reason"),
    lastOperationId: uuid("last_operation_id").notNull(),
    credentialGeneration: bigint("credential_generation", {
      mode: "bigint",
    }).notNull(),
    authorizedAt: timestamp("authorized_at", {
      withTimezone: true,
      mode: "string",
    }),
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
      mode: "string",
    }),
    lastAttemptedAt: timestamp("last_attempted_at", {
      withTimezone: true,
      mode: "string",
    }),
    lastSucceededAt: timestamp("last_succeeded_at", {
      withTimezone: true,
      mode: "string",
    }),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
  },
  (table) => [
    check(
      "connections_source_check",
      sql`${table.source} in ('simplefin', 'teller', 'schwab', 'snaptrade')`,
    ),
    check(
      "connections_authorization_class_check",
      sql`${table.authorizationClass} = 'read_only'`,
    ),
    check(
      "connections_status_check",
      sql`${table.status} in ('pending', 'active', 'reauthorization_required', 'disabled', 'revoked')`,
    ),
    check(
      "connections_generation_check",
      sql`${table.credentialGeneration} >= 0`,
    ),
    check(
      "connections_authorization_check",
      sql`(${table.status} = 'pending' and ${table.authorizedAt} is null and ${table.credentialGeneration} = 0)
        or (${table.status} = 'revoked' and ${table.credentialGeneration} >= 0)
        or (${table.status} not in ('pending', 'revoked') and ${table.credentialGeneration} > 0)`,
    ),
    check(
      "connections_expiry_check",
      sql`${table.expiresAt} is null or ${table.authorizedAt} is null or ${table.expiresAt} > ${table.authorizedAt}`,
    ),
  ],
);

export const connectionSecrets = ops.table(
  "connection_secrets",
  {
    connectionId: uuid("connection_id")
      .primaryKey()
      .references(() => connections.id),
    credentialGeneration: bigint("credential_generation", {
      mode: "bigint",
    }).notNull(),
    encryptionAlgorithm: text("encryption_algorithm").notNull(),
    encryptionKeyId: text("encryption_key_id").notNull(),
    keyStatus: text("key_status").notNull(),
    nonce: text("nonce").notNull(),
    ciphertext: text("ciphertext").notNull(),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
  },
  (table) => [
    check(
      "connection_secrets_generation_check",
      sql`${table.credentialGeneration} > 0`,
    ),
    check(
      "connection_secrets_algorithm_check",
      sql`${table.encryptionAlgorithm} = 'xchacha20-poly1305-ietf'`,
    ),
    check(
      "connection_secrets_key_status_check",
      sql`${table.keyStatus} = 'active'`,
    ),
    check(
      "connection_secrets_envelope_check",
      sql`length(btrim(${table.encryptionKeyId})) > 0
        and ${table.nonce} ~ '^[A-Za-z0-9+/]+={0,2}$'
        and octet_length(decode(${table.nonce}, 'base64')) = 24
        and ${table.ciphertext} ~ '^[A-Za-z0-9+/]+={0,2}$'
        and octet_length(decode(${table.ciphertext}, 'base64')) >= 16`,
    ),
  ],
);

export const discoveredAccounts = ops.table(
  "discovered_accounts",
  {
    id: uuid("id").primaryKey(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => connections.id),
    accountSourceId: uuid("account_source_id")
      .notNull()
      .references(() => accountSources.id),
    source: text("source").notNull(),
    credentialGeneration: bigint("credential_generation", {
      mode: "bigint",
    }).notNull(),
    discoveryFencingToken: bigint("discovery_fencing_token", {
      mode: "bigint",
    }).notNull(),
    leaseOwnerId: uuid("lease_owner_id").notNull(),
    providerAccountIdCiphertext: text(
      "provider_account_id_ciphertext",
    ).notNull(),
    providerAccountIdNonce: text("provider_account_id_nonce").notNull(),
    providerAccountIdDigest: text("provider_account_id_digest").notNull(),
    encryptionAlgorithm: text("encryption_algorithm").notNull(),
    encryptionKeyId: text("encryption_key_id").notNull(),
    digestKeyId: text("digest_key_id").notNull(),
    keyStatus: text("key_status").notNull(),
    status: text("status").notNull(),
    firstObservedAt: timestamp("first_observed_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    lastObservedAt: timestamp("last_observed_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
  },
  (table) => [
    check(
      "discovered_accounts_source_check",
      sql`${table.source} in ('simplefin', 'teller', 'schwab', 'snaptrade')`,
    ),
    check(
      "discovered_accounts_algorithm_check",
      sql`${table.encryptionAlgorithm} = 'xchacha20-poly1305-ietf'`,
    ),
    check(
      "discovered_accounts_key_status_check",
      sql`${table.keyStatus} = 'active'`,
    ),
    check(
      "discovered_accounts_status_check",
      sql`${table.status} in ('active', 'retired')`,
    ),
    check(
      "discovered_accounts_envelope_check",
      sql`${table.providerAccountIdNonce} ~ '^[A-Za-z0-9+/]+={0,2}$'
        and octet_length(decode(${table.providerAccountIdNonce}, 'base64')) = 24
        and ${table.providerAccountIdCiphertext} ~ '^[A-Za-z0-9+/]+={0,2}$'
        and octet_length(decode(${table.providerAccountIdCiphertext}, 'base64')) >= 16
        and ${table.providerAccountIdDigest} ~ '^[0-9a-f]{64}$'
        and length(btrim(${table.encryptionKeyId})) > 0
        and length(btrim(${table.digestKeyId})) > 0`,
    ),
    check(
      "discovered_accounts_generation_check",
      sql`${table.credentialGeneration} > 0 and ${table.discoveryFencingToken} > 0`,
    ),
    check(
      "discovered_accounts_time_check",
      sql`${table.firstObservedAt} <= ${table.lastObservedAt}`,
    ),
    uniqueIndex("discovered_accounts_provider_unique").on(
      table.connectionId,
      table.digestKeyId,
      table.providerAccountIdDigest,
    ),
    uniqueIndex("discovered_accounts_active_source_unique")
      .on(table.accountSourceId)
      .where(sql`${table.status} = 'active'`),
  ],
);

export const syncCheckpoints = ops.table(
  "sync_checkpoints",
  {
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => connections.id),
    feed: text("feed").notNull(),
    credentialGeneration: bigint("credential_generation", {
      mode: "bigint",
    }).notNull(),
    fencingToken: bigint("fencing_token", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    leaseOwnerId: uuid("lease_owner_id"),
    leaseAcquiredAt: timestamp("lease_acquired_at", {
      withTimezone: true,
      mode: "string",
    }),
    leaseExpiresAt: timestamp("lease_expires_at", {
      withTimezone: true,
      mode: "string",
    }),
    cursorEncryptionAlgorithm: text("cursor_encryption_algorithm"),
    cursorEncryptionKeyId: text("cursor_encryption_key_id"),
    cursorKeyStatus: text("cursor_key_status"),
    cursorNonce: text("cursor_nonce"),
    cursorCiphertext: text("cursor_ciphertext"),
    advancedAt: timestamp("advanced_at", {
      withTimezone: true,
      mode: "string",
    }),
  },
  (table) => [
    primaryKey({ columns: [table.connectionId, table.feed] }),
    check(
      "sync_checkpoints_feed_check",
      sql`${table.feed} in ('discovery', 'balances', 'transactions', 'positions')`,
    ),
    check(
      "sync_checkpoints_generation_check",
      sql`${table.credentialGeneration} >= 0 and ${table.fencingToken} >= 0`,
    ),
    check(
      "sync_checkpoints_lease_check",
      sql`num_nonnulls(${table.leaseOwnerId}, ${table.leaseAcquiredAt}, ${table.leaseExpiresAt}) in (0, 3)
        and (${table.leaseExpiresAt} is null or ${table.leaseExpiresAt} > ${table.leaseAcquiredAt})`,
    ),
    check(
      "sync_checkpoints_cursor_check",
      sql`num_nonnulls(${table.cursorEncryptionAlgorithm}, ${table.cursorEncryptionKeyId}, ${table.cursorKeyStatus}, ${table.cursorNonce}, ${table.cursorCiphertext}) in (0, 5)
        and (${table.cursorEncryptionAlgorithm} is null or (
          ${table.cursorEncryptionAlgorithm} = 'xchacha20-poly1305-ietf'
          and ${table.cursorKeyStatus} = 'active'
          and ${table.cursorNonce} ~ '^[A-Za-z0-9+/]+={0,2}$'
          and octet_length(decode(${table.cursorNonce}, 'base64')) = 24
          and ${table.cursorCiphertext} ~ '^[A-Za-z0-9+/]+={0,2}$'
          and octet_length(decode(${table.cursorCiphertext}, 'base64')) >= 16
        ))`,
    ),
  ],
);

export const syncRuns = ops.table(
  "sync_runs",
  {
    id: uuid("id").primaryKey(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => connections.id),
    feed: text("feed").notNull(),
    fencingToken: bigint("fencing_token", { mode: "bigint" }).notNull(),
    status: text("status").notNull(),
    reasonCode: text("reason_code").notNull(),
    attemptCount: integer("attempt_count").notNull(),
    startedAt: timestamp("started_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    completedAt: timestamp("completed_at", {
      withTimezone: true,
      mode: "string",
    }),
  },
  (table) => [
    check(
      "sync_runs_feed_check",
      sql`${table.feed} in ('discovery', 'balances', 'transactions', 'positions')`,
    ),
    check(
      "sync_runs_status_check",
      sql`${table.status} in ('running', 'succeeded', 'failed')`,
    ),
    check(
      "sync_runs_reason_check",
      sql`length(btrim(${table.reasonCode})) > 0`,
    ),
    check(
      "sync_runs_attempt_check",
      sql`${table.attemptCount} > 0 and ${table.fencingToken} > 0`,
    ),
    check(
      "sync_runs_time_check",
      sql`${table.completedAt} is null or ${table.completedAt} >= ${table.startedAt}`,
    ),
  ],
);

export const connectionEvents = ops.table(
  "connection_events",
  {
    id: uuid("id").primaryKey(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => connections.id),
    eventType: text("event_type").notNull(),
    expectedCredentialGeneration: bigint("expected_credential_generation", {
      mode: "bigint",
    }),
    resultingCredentialGeneration: bigint("resulting_credential_generation", {
      mode: "bigint",
    }).notNull(),
    actorClass: text("actor_class").notNull(),
    reasonCode: text("reason_code").notNull(),
    recordedAt: recordedAt(),
  },
  (table) => [
    check(
      "connection_events_type_check",
      sql`${table.eventType} in ('connection_created', 'authorization_installed', 'credential_refreshed', 'reauthorization_required', 'connection_disabled', 'connection_reenabled', 'connection_revoked')`,
    ),
    check(
      "connection_events_generation_check",
      sql`${table.resultingCredentialGeneration} >= 0 and (${table.expectedCredentialGeneration} is null or ${table.expectedCredentialGeneration} >= 0)`,
    ),
    check(
      "connection_events_actor_check",
      sql`${table.actorClass} in ('owner', 'read_worker', 'system')`,
    ),
    check(
      "connection_events_reason_check",
      sql`${table.reasonCode} in ('pending_authorization', 'authorization_installed', 'credential_refreshed', 'provider_authentication_failed', 'credential_expired', 'credential_key_unavailable', 'restore_validation_required', 'user_disabled', 'credential_revalidated', 'user_revoked', 'provider_revoked')`,
    ),
    index("connection_events_connection_idx").on(
      table.connectionId,
      table.recordedAt,
    ),
  ],
);
