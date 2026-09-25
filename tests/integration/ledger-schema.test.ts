import { randomUUID } from "node:crypto";

import Decimal from "decimal.js";
import fc from "fast-check";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  databaseEnvironment,
  migrationEnvironment,
} from "../../src/infrastructure/database/environment";

const runtime = databaseEnvironment();
const migration = migrationEnvironment();
const app = postgres(runtime.DATABASE_URL, { max: 1 });
const owner = postgres(migration.DATABASE_OWNER_URL, { max: 1 });

const baseline = {
  accountId: randomUUID(),
  accountRevisionId: randomUUID(),
  accountSourceId: randomUUID(),
  accountSourceLinkRevisionId: randomUUID(),
  categoryId: randomUUID(),
  categoryRevisionId: randomUUID(),
  rawPayloadId: randomUUID(),
  importId: randomUUID(),
  sourceRecordId: randomUUID(),
  transactionId: randomUUID(),
  accountEntryId: randomUUID(),
  categoryEntryId: randomUUID(),
};

const digest = (character: string) => character.repeat(64);

async function insertRawPayload(
  sql: postgres.TransactionSql,
  options: {
    id?: string;
    source?: string;
    contentDigest?: string;
  } = {},
) {
  const id = options.id ?? randomUUID();
  await sql`
    insert into ledger.raw_payloads (
      id, source, content_digest, encryption_algorithm, encryption_key_id,
      nonce, ciphertext, fetched_at, ingested_at
    ) values (
      ${id}, ${options.source ?? "integration"}, ${options.contentDigest ?? digest("a")},
      'test-aead', 'test-key', 'redacted-nonce', 'encrypted-fixture',
      '2026-08-02T00:00:00Z', '2026-08-02T00:00:01Z'
    )
  `;
  return id;
}

async function insertDestinations(sql: postgres.TransactionSql) {
  const accountId = randomUUID();
  const categoryId = randomUUID();
  await sql`
    insert into ledger.accounts (id, kind, type, currency)
    values (${accountId}, 'asset', 'checking', 'USD')
  `;
  await sql`
    insert into ledger.categories (id, kind)
    values (${categoryId}, 'expense')
  `;
  return { accountId, categoryId };
}

async function insertBalancedTransaction(
  sql: postgres.TransactionSql,
  destinations: { accountId: string; categoryId: string },
  options: {
    id?: string;
    amount?: string;
    sourceRecordId?: string;
    correctsTransactionId?: string;
    occurredOn?: string;
    occurredAt?: string | null;
  } = {},
) {
  const id = options.id ?? randomUUID();
  const amount = options.amount ?? "10.00";
  const categoryAmount = new Decimal(amount).negated().toFixed();
  const occurredOn = options.occurredOn ?? "2026-08-02";
  const occurredAt =
    options.occurredAt === undefined
      ? "2026-08-02T00:00:00Z"
      : options.occurredAt;
  const origin = options.sourceRecordId
    ? "external"
    : options.correctsTransactionId
      ? "system"
      : "manual";
  await sql`
    insert into ledger.transactions (
      id, occurred_on, occurred_at, description, currency, origin, source_record_id,
      corrects_transaction_id
    ) values (
      ${id}, ${occurredOn}, ${occurredAt}, 'Integration transaction', 'USD', ${origin},
      ${options.sourceRecordId ?? null}, ${options.correctsTransactionId ?? null}
    )
  `;
  await sql`
    insert into ledger.entries (id, transaction_id, account_id, amount)
    values (${randomUUID()}, ${id}, ${destinations.accountId}, ${amount})
  `;
  await sql`
    insert into ledger.entries (id, transaction_id, category_id, amount)
    values (${randomUUID()}, ${id}, ${destinations.categoryId}, ${categoryAmount})
  `;
  return id;
}

beforeAll(async () => {
  await app.begin(async (sql) => {
    await sql`
      insert into ledger.accounts (id, kind, type, currency)
      values (${baseline.accountId}, 'asset', 'checking', 'USD')
    `;
    await sql`
      insert into ledger.account_revisions (
        id, account_id, name, status, effective_at
      ) values (
        ${baseline.accountRevisionId}, ${baseline.accountId}, 'Checking', 'active',
        '2026-08-02T00:00:00Z'
      )
    `;
    await sql`
      insert into ledger.account_sources (
        id, source, source_kind, ingested_at
      ) values (
        ${baseline.accountSourceId}, 'manual_csv', 'import', '2026-08-02T00:00:00Z'
      )
    `;
    await sql`
      insert into ledger.account_source_link_revisions (
        id, account_source_id, account_id, status, reason_code
      ) values (
        ${baseline.accountSourceLinkRevisionId}, ${baseline.accountSourceId},
        ${baseline.accountId}, 'linked', 'initial_mapping'
      )
    `;
    await sql`
      insert into ledger.categories (id, kind)
      values (${baseline.categoryId}, 'expense')
    `;
    await sql`
      insert into ledger.category_revisions (
        id, category_id, name, effective_at
      ) values (
        ${baseline.categoryRevisionId}, ${baseline.categoryId}, 'Groceries',
        '2026-08-02T00:00:00Z'
      )
    `;
    await insertRawPayload(sql, {
      id: baseline.rawPayloadId,
      contentDigest: digest("b"),
    });
    await sql`
      insert into ledger.imports (
        id, importer_id, importer_version, content_digest, raw_payload_id
      ) values (
        ${baseline.importId}, ${`integration-${baseline.importId}`}, '1', ${digest("b")},
        ${baseline.rawPayloadId}
      )
    `;
    await sql`
      insert into ledger.source_records (
        id, source, source_ref, content_digest, raw_payload_id, ingested_at
      ) values (
        ${baseline.sourceRecordId}, 'integration', ${randomUUID()}, ${digest("c")},
        ${baseline.rawPayloadId}, '2026-08-02T00:00:01Z'
      )
    `;
    await sql`
      insert into ledger.transactions (
        id, occurred_on, occurred_at, description, currency, origin, source_record_id
      ) values (
        ${baseline.transactionId}, '2026-08-02', '2026-08-02T00:00:00Z', 'Baseline', 'USD', 'external',
        ${baseline.sourceRecordId}
      )
    `;
    await sql`
      insert into ledger.entries (id, transaction_id, account_id, amount)
      values (
        ${baseline.accountEntryId}, ${baseline.transactionId}, ${baseline.accountId},
        '25.00'
      )
    `;
    await sql`
      insert into ledger.entries (id, transaction_id, category_id, amount)
      values (
        ${baseline.categoryEntryId}, ${baseline.transactionId}, ${baseline.categoryId},
        '-25.00'
      )
    `;
  });
});

afterAll(async () => {
  await Promise.all([app.end(), owner.end()]);
});

describe("append-only ledger roles", () => {
  const rows = [
    ["accounts", baseline.accountId],
    ["account_revisions", baseline.accountRevisionId],
    ["account_sources", baseline.accountSourceId],
    ["account_source_link_revisions", baseline.accountSourceLinkRevisionId],
    ["categories", baseline.categoryId],
    ["category_revisions", baseline.categoryRevisionId],
    ["raw_payloads", baseline.rawPayloadId],
    ["imports", baseline.importId],
    ["source_records", baseline.sourceRecordId],
    ["transactions", baseline.transactionId],
    ["entries", baseline.accountEntryId],
  ] as const;

  test.each(rows)(
    "application role cannot update ledger.%s",
    async (table, id) => {
      await expect(
        app.unsafe(`update ledger.${table} set id = id where id = $1`, [id]),
      ).rejects.toMatchObject({ code: "42501" });
    },
  );

  test.each(rows)(
    "application role cannot delete ledger.%s",
    async (table, id) => {
      await expect(
        app.unsafe(`delete from ledger.${table} where id = $1`, [id]),
      ).rejects.toMatchObject({ code: "42501" });
    },
  );

  test.each(rows)(
    "migration owner cannot update ledger.%s",
    async (table, id) => {
      await expect(
        owner.unsafe(`update ledger.${table} set id = id where id = $1`, [id]),
      ).rejects.toMatchObject({ code: "55000" });
    },
  );

  test.each(rows)(
    "migration owner cannot delete ledger.%s",
    async (table, id) => {
      await expect(
        owner.unsafe(`delete from ledger.${table} where id = $1`, [id]),
      ).rejects.toMatchObject({ code: "55000" });
    },
  );

  test("migration owner cannot truncate the ledger", async () => {
    await expect(
      owner.unsafe(`truncate
        ledger.entries,
        ledger.transactions,
        ledger.source_record_accounts,
        ledger.source_record_account_sets,
        ledger.source_records,
        ledger.imports,
        ledger.raw_payloads,
        ledger.account_source_link_revisions,
        ledger.account_sources,
        ledger.account_revisions,
        ledger.accounts,
        ledger.category_revisions,
        ledger.categories cascade`),
    ).rejects.toMatchObject({ code: "55000" });
  });
});

describe("transaction invariants", () => {
  test("preserves a date-only transaction without inventing an instant", async () => {
    const destinations = await app.begin(insertDestinations);
    const transactionId = await app.begin((sql) =>
      insertBalancedTransaction(sql, destinations, {
        occurredOn: "2026-07-28",
        occurredAt: null,
      }),
    );

    const rows = await app<
      { occurred_on: string; occurred_at: string | null }[]
    >`
      select occurred_on::text, occurred_at::text
      from ledger.transactions
      where id = ${transactionId}
    `;
    expect(rows).toEqual([{ occurred_on: "2026-07-28", occurred_at: null }]);
  });

  test("accepts a balanced transaction", async () => {
    await expect(
      app.begin(async (sql) => {
        const destinations = await insertDestinations(sql);
        await insertBalancedTransaction(sql, destinations);
      }),
    ).resolves.toBeUndefined();
  });

  test("rejects an unbalanced transaction at commit", async () => {
    await expect(
      app.begin(async (sql) => {
        const { accountId } = await insertDestinations(sql);
        const transactionId = randomUUID();
        await sql`
          insert into ledger.transactions (id, occurred_on, occurred_at, description, currency, origin)
          values (${transactionId}, '2026-08-02', '2026-08-02T00:00:00Z', 'Unbalanced', 'USD', 'manual')
        `;
        await sql`
          insert into ledger.entries (id, transaction_id, account_id, amount)
          values (${randomUUID()}, ${transactionId}, ${accountId}, '1.00')
        `;
      }),
    ).rejects.toMatchObject({
      code: "23514",
      constraint_name: "transactions_entries_balance_check",
    });
  });

  test("rejects a transaction without entries at commit", async () => {
    await expect(
      app.begin(async (sql) => {
        await sql`
          insert into ledger.transactions (id, occurred_on, occurred_at, description, currency, origin)
          values (${randomUUID()}, '2026-08-02', '2026-08-02T00:00:00Z', 'Empty', 'USD', 'manual')
        `;
      }),
    ).rejects.toMatchObject({
      code: "23514",
      constraint_name: "transactions_entries_balance_check",
    });
  });

  test("requires exactly one posting destination", async () => {
    await expect(
      app.begin(async (sql) => {
        const destinations = await insertDestinations(sql);
        const transactionId = randomUUID();
        await sql`
          insert into ledger.transactions (id, occurred_on, occurred_at, description, currency, origin)
          values (${transactionId}, '2026-08-02', '2026-08-02T00:00:00Z', 'Ambiguous', 'USD', 'manual')
        `;
        await sql`
          insert into ledger.entries (
            id, transaction_id, account_id, category_id, amount
          ) values (
            ${randomUUID()}, ${transactionId}, ${destinations.accountId},
            ${destinations.categoryId}, '0'
          )
        `;
      }),
    ).rejects.toMatchObject({
      code: "23514",
      constraint_name: "entries_destination_check",
    });
  });

  test("rejects non-USD transactions", async () => {
    await expect(app`
      insert into ledger.transactions (id, occurred_on, occurred_at, description, currency, origin)
      values (${randomUUID()}, '2026-08-02', '2026-08-02T00:00:00Z', 'Foreign', 'EUR', 'manual')
    `).rejects.toMatchObject({
      code: "23514",
      constraint_name: "transactions_currency_check",
    });
  });

  test("requires origin and source-record provenance to agree", async () => {
    const source = `integration-${randomUUID()}`;
    const rawPayloadId = await app.begin((sql) =>
      insertRawPayload(sql, { source, contentDigest: digest("f") }),
    );
    const sourceRecordId = randomUUID();
    await app`
      insert into ledger.source_records (
        id, source, source_ref, content_digest, raw_payload_id, ingested_at
      ) values (
        ${sourceRecordId}, ${source}, ${randomUUID()}, ${digest("e")}, ${rawPayloadId},
        '2026-08-02T00:00:01Z'
      )
    `;

    await expect(app`
      insert into ledger.transactions (
        id, occurred_on, occurred_at, description, currency, origin, source_record_id
      ) values (
        ${randomUUID()}, '2026-08-02', '2026-08-02T00:00:00Z', 'Invalid manual source', 'USD',
        'manual', ${sourceRecordId}
      )
    `).rejects.toMatchObject({
      code: "23514",
      constraint_name: "transactions_origin_source_check",
    });
    await expect(app`
      insert into ledger.transactions (id, occurred_on, occurred_at, description, currency, origin)
      values (
        ${randomUUID()}, '2026-08-02', '2026-08-02T00:00:00Z', 'Missing external source', 'USD',
        'external'
      )
    `).rejects.toMatchObject({
      code: "23514",
      constraint_name: "transactions_origin_source_check",
    });
  });
});

describe("corrections", () => {
  test("preserves history with an exact compensating transaction", async () => {
    const destinations = await app.begin(insertDestinations);
    const originalId = await app.begin((sql) =>
      insertBalancedTransaction(sql, destinations, { amount: "40.00" }),
    );
    const correctionId = await app.begin(async (sql) => {
      const id = randomUUID();
      await sql`
        insert into ledger.transactions (
          id, occurred_on, occurred_at, description, currency, origin, corrects_transaction_id
        ) values (
          ${id}, '2026-08-02', '2026-08-02T00:01:00Z', 'Correction', 'USD', 'system', ${originalId}
        )
      `;
      await sql`
        insert into ledger.entries (id, transaction_id, account_id, amount)
        values (${randomUUID()}, ${id}, ${destinations.accountId}, '-40.00')
      `;
      await sql`
        insert into ledger.entries (id, transaction_id, category_id, amount)
        values (${randomUUID()}, ${id}, ${destinations.categoryId}, '40.00')
      `;
      return id;
    });

    const rows = await app<{ id: string }[]>`
      select id from ledger.transactions where id in (${originalId}, ${correctionId})
    `;
    expect(rows).toHaveLength(2);
  });

  test("rejects a balanced correction that does not reverse destinations", async () => {
    const originalDestinations = await app.begin(insertDestinations);
    const otherDestinations = await app.begin(insertDestinations);
    const originalId = await app.begin((sql) =>
      insertBalancedTransaction(sql, originalDestinations, { amount: "15.00" }),
    );

    await expect(
      app.begin((sql) =>
        insertBalancedTransaction(sql, otherDestinations, {
          amount: "-15.00",
          correctsTransactionId: originalId,
        }),
      ),
    ).rejects.toMatchObject({
      code: "23514",
      constraint_name: "transactions_correction_postings_check",
    });
  });

  test("prevents more than one correction of the same transaction", async () => {
    const destinations = await app.begin(insertDestinations);
    const originalId = await app.begin((sql) =>
      insertBalancedTransaction(sql, destinations),
    );
    await app.begin((sql) =>
      insertBalancedTransaction(sql, destinations, {
        amount: "-10.00",
        correctsTransactionId: originalId,
      }),
    );

    await expect(
      app.begin((sql) =>
        insertBalancedTransaction(sql, destinations, {
          amount: "-10.00",
          correctsTransactionId: originalId,
        }),
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });

  test("requires correction transactions to be system-originated", async () => {
    const destinations = await app.begin(insertDestinations);
    const originalId = await app.begin((sql) =>
      insertBalancedTransaction(sql, destinations),
    );

    await expect(app`
      insert into ledger.transactions (
        id, occurred_on, occurred_at, description, currency, origin, corrects_transaction_id
      ) values (
        ${randomUUID()}, '2026-08-02', '2026-08-02T00:01:00Z', 'Manual correction', 'USD',
        'manual', ${originalId}
      )
    `).rejects.toMatchObject({
      code: "23514",
      constraint_name: "transactions_correction_origin_check",
    });
  });

  test("property: replaying a correction cannot create another reversal", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.bigInt({ min: 1n, max: 100_000_000n }),
        async (cents) => {
          const amount = new Decimal(cents.toString()).div(100).toFixed(2);
          const destinations = await app.begin(insertDestinations);
          const originalId = await app.begin((sql) =>
            insertBalancedTransaction(sql, destinations, { amount }),
          );
          await app.begin((sql) =>
            insertBalancedTransaction(sql, destinations, {
              amount: `-${amount}`,
              correctsTransactionId: originalId,
            }),
          );

          await expect(
            app.begin((sql) =>
              insertBalancedTransaction(sql, destinations, {
                amount: `-${amount}`,
                correctsTransactionId: originalId,
              }),
            ),
          ).rejects.toMatchObject({ code: "23505" });
        },
      ),
      { numRuns: 10 },
    );
  });
});

describe("import and source idempotency", () => {
  test("makes duplicate import content a no-op", async () => {
    const rawPayloadId = await app.begin((sql) =>
      insertRawPayload(sql, { contentDigest: digest("d") }),
    );
    const importerId = `integration-${randomUUID()}`;

    const first = await app<{ id: string }[]>`
      insert into ledger.imports (
        id, importer_id, importer_version, content_digest, raw_payload_id
      ) values (
        ${randomUUID()}, ${importerId}, '1', ${digest("d")}, ${rawPayloadId}
      )
      on conflict (importer_id, importer_version, content_digest) do nothing
      returning id
    `;
    const replay = await app<{ id: string }[]>`
      insert into ledger.imports (
        id, importer_id, importer_version, content_digest, raw_payload_id
      ) values (
        ${randomUUID()}, ${importerId}, '1', ${digest("d")}, ${rawPayloadId}
      )
      on conflict (importer_id, importer_version, content_digest) do nothing
      returning id
    `;

    expect(first).toHaveLength(1);
    expect(replay).toHaveLength(0);
  });

  test("property: replaying import content remains idempotent", async () => {
    await fc.assert(
      fc.asyncProperty(fc.uuid(), async (importerId) => {
        const rawPayloadId = await app.begin((sql) =>
          insertRawPayload(sql, { contentDigest: digest("d") }),
        );
        const insertImport = () => app<{ id: string }[]>`
          insert into ledger.imports (
            id, importer_id, importer_version, content_digest, raw_payload_id
          ) values (
            ${randomUUID()}, ${importerId}, 'property-v1', ${digest("d")},
            ${rawPayloadId}
          )
          on conflict (importer_id, importer_version, content_digest) do nothing
          returning id
        `;

        expect(await insertImport()).toHaveLength(1);
        expect(await insertImport()).toHaveLength(0);
      }),
      { numRuns: 10 },
    );
  });

  test("rejects an import whose digest does not match its raw payload", async () => {
    const rawPayloadId = await app.begin((sql) =>
      insertRawPayload(sql, { contentDigest: digest("e") }),
    );

    await expect(
      app.begin(async (sql) => {
        await sql`
          insert into ledger.imports (
            id, importer_id, importer_version, content_digest, raw_payload_id
          ) values (
            ${randomUUID()}, ${randomUUID()}, '1', ${digest("f")}, ${rawPayloadId}
          )
        `;
      }),
    ).rejects.toMatchObject({
      code: "23514",
      constraint_name: "imports_payload_digest_check",
    });
  });

  test("makes an identical source-record version a no-op", async () => {
    const source = `integration-${randomUUID()}`;
    const sourceRef = randomUUID();
    const rawPayloadId = await app.begin((sql) =>
      insertRawPayload(sql, { source, contentDigest: digest("1") }),
    );

    const insertVersion = () => app<{ id: string }[]>`
      insert into ledger.source_records (
        id, source, source_ref, content_digest, raw_payload_id, ingested_at
      ) values (
        ${randomUUID()}, ${source}, ${sourceRef}, ${digest("2")}, ${rawPayloadId},
        '2026-08-02T00:00:01Z'
      )
      on conflict (source, source_ref, content_digest) do nothing
      returning id
    `;

    expect(await insertVersion()).toHaveLength(1);
    expect(await insertVersion()).toHaveLength(0);
  });

  test("accepts one linear changed source-record version", async () => {
    const source = `integration-${randomUUID()}`;
    const sourceRef = randomUUID();
    const rawPayloadId = await app.begin((sql) =>
      insertRawPayload(sql, { source, contentDigest: digest("3") }),
    );
    const originalId = randomUUID();
    await app`
      insert into ledger.source_records (
        id, source, source_ref, content_digest, raw_payload_id, ingested_at
      ) values (
        ${originalId}, ${source}, ${sourceRef}, ${digest("4")}, ${rawPayloadId},
        '2026-08-02T00:00:01Z'
      )
    `;

    await expect(
      app.begin(async (sql) => {
        await sql`
        insert into ledger.source_records (
          id, source, source_ref, content_digest, raw_payload_id,
          supersedes_source_record_id, ingested_at
        ) values (
          ${randomUUID()}, ${source}, ${sourceRef}, ${digest("5")}, ${rawPayloadId},
          ${originalId}, '2026-08-02T00:00:02Z'
        )
      `;
      }),
    ).resolves.toBeUndefined();
  });

  test("rejects competing roots and branches for one source identity", async () => {
    const source = `integration-${randomUUID()}`;
    const sourceRef = randomUUID();
    const rawPayloadId = await app.begin((sql) =>
      insertRawPayload(sql, { source, contentDigest: digest("a") }),
    );
    const rootId = randomUUID();
    await app`
      insert into ledger.source_records (
        id, source, source_ref, content_digest, raw_payload_id, ingested_at
      ) values (
        ${rootId}, ${source}, ${sourceRef}, ${digest("b")}, ${rawPayloadId},
        '2026-08-02T00:00:01Z'
      )
    `;

    await expect(app`
      insert into ledger.source_records (
        id, source, source_ref, content_digest, raw_payload_id, ingested_at
      ) values (
        ${randomUUID()}, ${source}, ${sourceRef}, ${digest("c")}, ${rawPayloadId},
        '2026-08-02T00:00:02Z'
      )
    `).rejects.toMatchObject({ code: "23505" });

    await app.begin(async (sql) => {
      await sql`
        insert into ledger.source_records (
          id, source, source_ref, content_digest, raw_payload_id,
          supersedes_source_record_id, ingested_at
        ) values (
          ${randomUUID()}, ${source}, ${sourceRef}, ${digest("d")}, ${rawPayloadId},
          ${rootId}, '2026-08-02T00:00:02Z'
        )
      `;
    });

    await expect(app`
      insert into ledger.source_records (
        id, source, source_ref, content_digest, raw_payload_id,
        supersedes_source_record_id, ingested_at
      ) values (
        ${randomUUID()}, ${source}, ${sourceRef}, ${digest("e")}, ${rawPayloadId},
        ${rootId}, '2026-08-02T00:00:03Z'
      )
    `).rejects.toMatchObject({ code: "23505" });
  });

  test("rejects a revised version with a different source identity", async () => {
    const source = `integration-${randomUUID()}`;
    const rawPayloadId = await app.begin((sql) =>
      insertRawPayload(sql, { source, contentDigest: digest("6") }),
    );
    const originalId = randomUUID();
    await app`
      insert into ledger.source_records (
        id, source, source_ref, content_digest, raw_payload_id, ingested_at
      ) values (
        ${originalId}, ${source}, ${randomUUID()}, ${digest("7")}, ${rawPayloadId},
        '2026-08-02T00:00:01Z'
      )
    `;

    await expect(
      app.begin(async (sql) => {
        await sql`
          insert into ledger.source_records (
            id, source, source_ref, content_digest, raw_payload_id,
            supersedes_source_record_id, ingested_at
          ) values (
            ${randomUUID()}, ${source}, ${randomUUID()}, ${digest("8")},
            ${rawPayloadId}, ${originalId}, '2026-08-02T00:00:02Z'
          )
        `;
      }),
    ).rejects.toMatchObject({
      code: "23514",
      constraint_name: "source_records_identity_check",
    });
  });

  test("allows each source-record version to normalize only once", async () => {
    const source = `integration-${randomUUID()}`;
    const rawPayloadId = await app.begin((sql) =>
      insertRawPayload(sql, { source, contentDigest: digest("9") }),
    );
    const sourceRecordId = randomUUID();
    await app`
      insert into ledger.source_records (
        id, source, source_ref, content_digest, raw_payload_id, ingested_at
      ) values (
        ${sourceRecordId}, ${source}, ${randomUUID()}, ${digest("0")}, ${rawPayloadId},
        '2026-08-02T00:00:01Z'
      )
    `;
    const destinations = await app.begin(insertDestinations);
    await app.begin((sql) =>
      insertBalancedTransaction(sql, destinations, { sourceRecordId }),
    );

    await expect(
      app.begin((sql) =>
        insertBalancedTransaction(sql, destinations, { sourceRecordId }),
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });
});

describe("current metadata views", () => {
  test("selects the latest effective account revision", async () => {
    await app`
      insert into ledger.account_revisions (
        id, account_id, name, status, effective_at
      ) values (
        ${randomUUID()}, ${baseline.accountId}, 'Primary checking', 'active',
        '2026-08-02T01:00:00Z'
      )
    `;

    const rows = await app<{ name: string }[]>`
      select name from ledger.current_accounts where id = ${baseline.accountId}
    `;
    expect(rows[0]?.name).toBe("Primary checking");
  });
});

describe("schema representation", () => {
  test("enforces account type and derived accounting class combinations", async () => {
    await expect(app`
      insert into ledger.accounts (id, kind, type, currency)
      values (${randomUUID()}, 'liability', 'checking', 'USD')
    `).rejects.toMatchObject({
      code: "23514",
      constraint_name: "accounts_type_class_check",
    });
    await expect(app`
      insert into ledger.accounts (id, kind, type, currency)
      values (${randomUUID()}, 'asset', 'credit_card', 'USD')
    `).rejects.toMatchObject({
      code: "23514",
      constraint_name: "accounts_type_class_check",
    });
  });

  test("stores entry amounts as unconstrained-precision NUMERIC", async () => {
    const rows = await app<
      { data_type: string; numeric_precision: number | null }[]
    >`
      select data_type, numeric_precision
      from information_schema.columns
      where table_schema = 'ledger'
        and table_name = 'entries'
        and column_name = 'amount'
    `;

    expect(rows).toEqual([{ data_type: "numeric", numeric_precision: null }]);
  });
});
