import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, describe, expect, test } from "vitest";

import {
  SourceRecordAssociationConflictError,
  SourceRecordAssociationReferenceError,
  createAccountSourceLinkService,
  createLedgerDestinationService,
  createSourceRecordAssociationService,
  utcTimestampSchema,
} from "../../src/core/ledger";
import { createPostgresAccountSourceLinkStore } from "../../src/infrastructure/database/postgres-account-sources";
import { createDatabase } from "../../src/infrastructure/database/client";
import { migrationEnvironment } from "../../src/infrastructure/database/environment";
import { createPostgresLedgerDestinationStore } from "../../src/infrastructure/database/postgres-ledger-destinations";
import { createPostgresSourceRecordAssociationStore } from "../../src/infrastructure/database/postgres-source-record-associations";

const connection = createDatabase();
const owner = postgres(migrationEnvironment().DATABASE_OWNER_URL, { max: 2 });
const now = utcTimestampSchema.parse("2026-08-03T12:00:00Z");
const sourceService = createAccountSourceLinkService(
  createPostgresAccountSourceLinkStore(connection.database),
  () => now,
);
const destinationService = createLedgerDestinationService(
  createPostgresLedgerDestinationStore(connection.database),
  () => now,
);
const associationStore = createPostgresSourceRecordAssociationStore(
  connection.database,
);
const associationService =
  createSourceRecordAssociationService(associationStore);

afterAll(async () => {
  await Promise.all([connection.close(), owner.end()]);
});

function digest(): string {
  return randomUUID().replaceAll("-", "").repeat(2);
}

async function createSourceRecord(source = "ynab") {
  const rawPayloadId = randomUUID();
  const sourceRecordId = randomUUID();
  await connection.database.transaction(async (transaction) => {
    await transaction.execute(sql`
      insert into ledger.raw_payloads (
        id, source, content_digest, encryption_algorithm, encryption_key_id,
        nonce, ciphertext, fetched_at, ingested_at
      ) values (
        ${rawPayloadId}, ${source}, ${digest()}, 'test-aead', 'test-key',
        'redacted-nonce', 'encrypted-fixture',
        '2026-08-03T11:59:00Z', '2026-08-03T12:00:00Z'
      )
    `);
    await transaction.execute(sql`
      insert into ledger.source_records (
        id, source, source_ref, content_digest, raw_payload_id, ingested_at
      ) values (
        ${sourceRecordId}, ${source}, ${randomUUID()}, ${digest()},
        ${rawPayloadId}, '2026-08-03T12:00:00Z'
      )
    `);
  });
  return sourceRecordId;
}

async function createLinkedSource(source: "ynab" | "simplefin" = "ynab") {
  const accountId = randomUUID();
  await destinationService.createAccount({
    accountId,
    revisionId: randomUUID(),
    name: `Association account ${accountId}`,
    accountType: "checking",
    accountClass: null,
    openedOn: null,
  });
  const accountSourceId = randomUUID();
  const linkRevisionId = randomUUID();
  await sourceService.registerAndLinkAccountSource({
    accountSourceId,
    source,
    sourceKind: source === "ynab" ? "import" : "connector",
    ingestedAt: "2026-08-03T00:00:00Z",
    accountId,
    linkRevisionId,
  });
  return { accountId, accountSourceId, linkRevisionId };
}

describe("PostgreSQL source-record account associations", () => {
  test("seals initial and corrected sets and returns deterministic history", async () => {
    const sourceRecordId = await createSourceRecord();
    const first = await createLinkedSource();
    const second = await createLinkedSource();
    const initialId = randomUUID();
    await associationService.sealInitialAccountSet({
      accountSetRevisionId: initialId,
      sourceRecordId,
      members: [
        {
          accountSourceId: first.accountSourceId,
          linkRevisionId: first.linkRevisionId,
        },
      ],
    });
    const correctedId = randomUUID();
    await associationService.correctAccountSet({
      accountSetRevisionId: correctedId,
      sourceRecordId,
      supersedesAccountSetRevisionId: initialId,
      members: [
        {
          accountSourceId: second.accountSourceId,
          linkRevisionId: second.linkRevisionId,
        },
        {
          accountSourceId: first.accountSourceId,
          linkRevisionId: first.linkRevisionId,
        },
      ],
    });

    const current = await associationService.resolveCurrentSet(sourceRecordId);
    expect(current).toMatchObject({
      id: correctedId,
      sourceRecordId,
      supersedesAccountSetRevisionId: initialId,
      memberCount: 2,
    });
    expect(current?.members.map((member) => member.accountSourceId)).toEqual(
      [first.accountSourceId, second.accountSourceId].sort(),
    );
    const history = await associationService.listHistory(sourceRecordId);
    expect(history.map((revision) => revision.id)).toEqual([
      initialId,
      correctedId,
    ]);
    expect(history.map((revision) => revision.members.length)).toEqual([1, 2]);
  });

  test("accepts exact set replay in any member order and rejects conflicting ID replay", async () => {
    const sourceRecordId = await createSourceRecord();
    const first = await createLinkedSource();
    const second = await createLinkedSource();
    const accountSetRevisionId = randomUUID();
    const members = [
      {
        accountSourceId: first.accountSourceId,
        linkRevisionId: first.linkRevisionId,
      },
      {
        accountSourceId: second.accountSourceId,
        linkRevisionId: second.linkRevisionId,
      },
    ];
    await associationService.sealInitialAccountSet({
      accountSetRevisionId,
      sourceRecordId,
      members,
    });
    await associationService.sealInitialAccountSet({
      accountSetRevisionId,
      sourceRecordId,
      members: [...members].reverse(),
    });
    await expect(
      associationService.sealInitialAccountSet({
        accountSetRevisionId,
        sourceRecordId,
        members: [
          {
            accountSourceId: first.accountSourceId,
            linkRevisionId: second.linkRevisionId,
          },
          members[1],
        ],
      }),
    ).rejects.toBeInstanceOf(SourceRecordAssociationConflictError);
    await expect(
      associationService.sealInitialAccountSet({
        accountSetRevisionId,
        sourceRecordId: await createSourceRecord(),
        members,
      }),
    ).rejects.toBeInstanceOf(SourceRecordAssociationConflictError);
    await expect(
      associationService.listHistory(sourceRecordId),
    ).resolves.toHaveLength(1);
  });

  test("maps missing references, wrong sources, and historical links", async () => {
    const linked = await createLinkedSource();
    await expect(
      associationService.sealInitialAccountSet({
        accountSetRevisionId: randomUUID(),
        sourceRecordId: randomUUID(),
        members: [
          {
            accountSourceId: linked.accountSourceId,
            linkRevisionId: linked.linkRevisionId,
          },
        ],
      }),
    ).rejects.toBeInstanceOf(SourceRecordAssociationReferenceError);

    const simplefin = await createLinkedSource("simplefin");
    await expect(
      associationService.sealInitialAccountSet({
        accountSetRevisionId: randomUUID(),
        sourceRecordId: await createSourceRecord("ynab"),
        members: [
          {
            accountSourceId: simplefin.accountSourceId,
            linkRevisionId: simplefin.linkRevisionId,
          },
        ],
      }),
    ).rejects.toBeInstanceOf(SourceRecordAssociationConflictError);

    const replacementAccountId = randomUUID();
    await destinationService.createAccount({
      accountId: replacementAccountId,
      revisionId: randomUUID(),
      name: "Replacement association account",
      accountType: "checking",
      accountClass: null,
      openedOn: null,
    });
    await sourceService.relinkAccountSource({
      accountSourceId: linked.accountSourceId,
      previousAccountId: linked.accountId,
      accountId: replacementAccountId,
      supersedesLinkRevisionId: linked.linkRevisionId,
      unlinkRevisionId: randomUUID(),
      linkRevisionId: randomUUID(),
      unlinkReasonCode: "mapping_correction_unlinked",
      linkReasonCode: "mapping_correction_linked",
    });
    await expect(
      associationService.sealInitialAccountSet({
        accountSetRevisionId: randomUUID(),
        sourceRecordId: await createSourceRecord(),
        members: [
          {
            accountSourceId: linked.accountSourceId,
            linkRevisionId: linked.linkRevisionId,
          },
        ],
      }),
    ).rejects.toBeInstanceOf(SourceRecordAssociationConflictError);
  });

  test("rolls back an unsealed member count atomically", async () => {
    const sourceRecordId = await createSourceRecord();
    const linked = await createLinkedSource();
    const accountSetRevisionId = randomUUID();
    await expect(
      connection.database.transaction(async (transaction) => {
        await transaction.execute(sql`
          insert into ledger.source_record_account_sets (
            id, source_record_id, member_count
          ) values (${accountSetRevisionId}, ${sourceRecordId}, 2)
        `);
        await transaction.execute(sql`
          insert into ledger.source_record_accounts (
            account_set_revision_id, account_source_id, link_revision_id, role
          ) values (
            ${accountSetRevisionId}, ${linked.accountSourceId},
            ${linked.linkRevisionId}, 'observed_account'
          )
        `);
      }),
    ).rejects.toMatchObject({ code: "23514" });
    const rows = await connection.database.execute<{ count: string }>(sql`
      select count(*)::text as count
      from ledger.source_record_account_sets
      where id = ${accountSetRevisionId}
    `);
    expect(rows[0]?.count).toBe("0");
  });

  test("rejects mutation for both application and owner roles", async () => {
    const sourceRecordId = await createSourceRecord();
    const linked = await createLinkedSource();
    const accountSetRevisionId = randomUUID();
    await associationService.sealInitialAccountSet({
      accountSetRevisionId,
      sourceRecordId,
      members: [
        {
          accountSourceId: linked.accountSourceId,
          linkRevisionId: linked.linkRevisionId,
        },
      ],
    });

    await expect(
      connection.database.execute(sql`
        update ledger.source_record_account_sets
        set member_count = 2 where id = ${accountSetRevisionId}
      `),
    ).rejects.toBeDefined();
    await expect(
      connection.database.execute(sql`
        delete from ledger.source_record_accounts
        where account_set_revision_id = ${accountSetRevisionId}
      `),
    ).rejects.toBeDefined();
    await expect(owner`
      update ledger.source_record_account_sets
      set member_count = 2 where id = ${accountSetRevisionId}
    `).rejects.toMatchObject({ code: "55000" });
    await expect(owner`
      delete from ledger.source_record_accounts
      where account_set_revision_id = ${accountSetRevisionId}
    `).rejects.toMatchObject({ code: "55000" });
    await expect(owner`
      truncate ledger.source_record_accounts, ledger.source_record_account_sets
    `).rejects.toMatchObject({ code: "55000" });
  });

  test("allows only one competing successor", async () => {
    const sourceRecordId = await createSourceRecord();
    const linked = await createLinkedSource();
    const initialId = randomUUID();
    await associationService.sealInitialAccountSet({
      accountSetRevisionId: initialId,
      sourceRecordId,
      members: [
        {
          accountSourceId: linked.accountSourceId,
          linkRevisionId: linked.linkRevisionId,
        },
      ],
    });
    const results = await Promise.allSettled(
      [randomUUID(), randomUUID()].map((accountSetRevisionId) =>
        associationService.correctAccountSet({
          accountSetRevisionId,
          sourceRecordId,
          supersedesAccountSetRevisionId: initialId,
          members: [
            {
              accountSourceId: linked.accountSourceId,
              linkRevisionId: linked.linkRevisionId,
            },
          ],
        }),
      ),
    );
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    await expect(
      associationService.listHistory(sourceRecordId),
    ).resolves.toHaveLength(2);
  });
});
