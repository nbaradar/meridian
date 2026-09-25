import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { afterAll, describe, expect, test } from "vitest";

import {
  AccountSourceConflictError,
  AccountSourceReferenceError,
  createAccountSourceLinkService,
  createLedgerDestinationService,
  utcTimestampSchema,
} from "../../src/core/ledger";
import { createPostgresAccountSourceLinkStore } from "../../src/infrastructure/database/postgres-account-sources";
import { createDatabase } from "../../src/infrastructure/database/client";
import { createPostgresLedgerDestinationStore } from "../../src/infrastructure/database/postgres-ledger-destinations";

const connection = createDatabase();
const now = utcTimestampSchema.parse("2026-08-03T12:00:00Z");
const sourceStore = createPostgresAccountSourceLinkStore(connection.database);
const sourceService = createAccountSourceLinkService(sourceStore, () => now);
const destinationService = createLedgerDestinationService(
  createPostgresLedgerDestinationStore(connection.database),
  () => now,
);

afterAll(async () => {
  await connection.close();
});

async function createAccount(name: string) {
  const accountId = randomUUID();
  await destinationService.createAccount({
    accountId,
    revisionId: randomUUID(),
    name,
    accountType: "checking",
    accountClass: null,
    openedOn: null,
  });
  return accountId;
}

describe("PostgreSQL account-source linkage", () => {
  test("replays registration and initial linkage idempotently", async () => {
    const accountId = await createAccount("Source replay account");
    const command = {
      accountSourceId: randomUUID(),
      source: "ynab",
      sourceKind: "import",
      ingestedAt: "2020-01-01T00:00:00Z",
      accountId,
      linkRevisionId: randomUUID(),
    } as const;

    await sourceService.registerAndLinkAccountSource(command);
    await sourceService.registerAndLinkAccountSource(command);

    await expect(
      sourceService.resolveCurrentAccount(command.accountSourceId),
    ).resolves.toMatchObject({
      accountSourceId: command.accountSourceId,
      source: "ynab",
      sourceKind: "import",
      accountId,
      linkRevisionId: command.linkRevisionId,
      reasonCode: "initial_mapping",
    });
    await expect(
      sourceService.listLinkHistory(command.accountSourceId),
    ).resolves.toHaveLength(1);
  });

  test("allows import and connector identities on one canonical account", async () => {
    const accountId = await createAccount("Multiple source account");
    for (const [source, sourceKind] of [
      ["ynab", "import"],
      ["simplefin", "connector"],
    ] as const) {
      await sourceService.registerAndLinkAccountSource({
        accountSourceId: randomUUID(),
        source,
        sourceKind,
        ingestedAt: "2020-01-01T00:00:00Z",
        accountId,
        linkRevisionId: randomUUID(),
      });
    }

    const sources = await sourceService.listCurrentSources(accountId);
    expect(sources).toHaveLength(2);
    expect(sources.map((source) => source.sourceKind)).toEqual([
      "connector",
      "import",
    ]);
  });

  test("unlinks and relinks only through explicit chain revisions", async () => {
    const firstAccountId = await createAccount("First linked account");
    const secondAccountId = await createAccount("Corrected linked account");
    const accountSourceId = randomUUID();
    const rootRevisionId = randomUUID();
    await sourceService.registerAndLinkAccountSource({
      accountSourceId,
      source: "simplefin",
      sourceKind: "connector",
      ingestedAt: "2020-01-01T00:00:00Z",
      accountId: firstAccountId,
      linkRevisionId: rootRevisionId,
    });

    const unlinkRevisionId = randomUUID();
    const linkRevisionId = randomUUID();
    await sourceService.relinkAccountSource({
      accountSourceId,
      previousAccountId: firstAccountId,
      accountId: secondAccountId,
      supersedesLinkRevisionId: rootRevisionId,
      unlinkRevisionId,
      linkRevisionId,
      unlinkReasonCode: "mapping_correction_unlinked",
      linkReasonCode: "mapping_correction_linked",
    });

    await expect(
      sourceService.resolveCurrentAccount(accountSourceId),
    ).resolves.toMatchObject({
      accountId: secondAccountId,
      linkRevisionId,
      reasonCode: "mapping_correction_linked",
    });
    await expect(
      sourceService.listLinkHistory(accountSourceId),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "linked",
          accountId: firstAccountId,
        }),
        expect.objectContaining({
          status: "unlinked",
          accountId: firstAccountId,
        }),
        expect.objectContaining({
          status: "linked",
          accountId: secondAccountId,
        }),
      ]),
    );

    await sourceService.relinkAccountSource({
      accountSourceId,
      previousAccountId: firstAccountId,
      accountId: secondAccountId,
      supersedesLinkRevisionId: rootRevisionId,
      unlinkRevisionId,
      linkRevisionId,
      unlinkReasonCode: "mapping_correction_unlinked",
      linkReasonCode: "mapping_correction_linked",
    });
    await expect(
      sourceService.listLinkHistory(accountSourceId),
    ).resolves.toHaveLength(3);
  });

  test("shows no current link while unlinked and permits reassociation", async () => {
    const accountId = await createAccount("Temporarily unlinked account");
    const accountSourceId = randomUUID();
    const rootRevisionId = randomUUID();
    await sourceService.registerAndLinkAccountSource({
      accountSourceId,
      source: "teller",
      sourceKind: "connector",
      ingestedAt: "2020-01-01T00:00:00Z",
      accountId,
      linkRevisionId: rootRevisionId,
    });
    const unlinkRevisionId = randomUUID();
    await sourceService.unlinkAccountSource({
      linkRevisionId: unlinkRevisionId,
      accountSourceId,
      accountId,
      supersedesLinkRevisionId: rootRevisionId,
      reasonCode: "user_unlinked",
    });

    await expect(
      sourceService.resolveCurrentAccount(accountSourceId),
    ).resolves.toBeNull();
    await expect(
      sourceService.unlinkAccountSource({
        linkRevisionId: randomUUID(),
        accountSourceId,
        accountId,
        supersedesLinkRevisionId: unlinkRevisionId,
        reasonCode: "user_unlinked",
      }),
    ).rejects.toBeInstanceOf(AccountSourceConflictError);

    const relinkRevisionId = randomUUID();
    await sourceService.linkUnlinkedAccountSource({
      linkRevisionId: relinkRevisionId,
      accountSourceId,
      accountId,
      supersedesLinkRevisionId: unlinkRevisionId,
      reasonCode: "source_reassociated",
    });
    await expect(
      sourceService.resolveCurrentAccount(accountSourceId),
    ).resolves.toMatchObject({ linkRevisionId: relinkRevisionId, accountId });
  });

  test("rejects direct relinking and missing references", async () => {
    const accountId = await createAccount("Transition guard account");
    const accountSourceId = randomUUID();
    const rootRevisionId = randomUUID();
    await sourceService.registerAndLinkAccountSource({
      accountSourceId,
      source: "schwab",
      sourceKind: "connector",
      ingestedAt: "2020-01-01T00:00:00Z",
      accountId,
      linkRevisionId: rootRevisionId,
    });

    await expect(
      sourceService.linkUnlinkedAccountSource({
        linkRevisionId: randomUUID(),
        accountSourceId,
        accountId,
        supersedesLinkRevisionId: rootRevisionId,
        reasonCode: "source_reassociated",
      }),
    ).rejects.toBeInstanceOf(AccountSourceConflictError);
    await expect(
      sourceService.unlinkAccountSource({
        linkRevisionId: randomUUID(),
        accountSourceId,
        accountId: randomUUID(),
        supersedesLinkRevisionId: rootRevisionId,
        reasonCode: "user_unlinked",
      }),
    ).rejects.toBeInstanceOf(AccountSourceConflictError);
    await expect(
      sourceService.registerAndLinkAccountSource({
        accountSourceId,
        source: "schwab",
        sourceKind: "connector",
        ingestedAt: "2020-01-01T00:00:00Z",
        accountId,
        linkRevisionId: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(AccountSourceConflictError);
    await expect(
      sourceService.registerAndLinkAccountSource({
        accountSourceId: randomUUID(),
        source: "ynab",
        sourceKind: "import",
        ingestedAt: "2020-01-01T00:00:00Z",
        accountId: randomUUID(),
        linkRevisionId: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(AccountSourceReferenceError);
  });

  test("allows one competing successor and rolls back missing-account linkage", async () => {
    const accountId = await createAccount("Concurrent source account");
    const accountSourceId = randomUUID();
    const rootRevisionId = randomUUID();
    await sourceService.registerAndLinkAccountSource({
      accountSourceId,
      source: "simplefin",
      sourceKind: "connector",
      ingestedAt: "2020-01-01T00:00:00Z",
      accountId,
      linkRevisionId: rootRevisionId,
    });

    const results = await Promise.allSettled(
      [randomUUID(), randomUUID()].map((linkRevisionId) =>
        sourceService.unlinkAccountSource({
          linkRevisionId,
          accountSourceId,
          accountId,
          supersedesLinkRevisionId: rootRevisionId,
          reasonCode: "user_unlinked",
        }),
      ),
    );
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);

    const missingAccountSourceId = randomUUID();
    await expect(
      sourceService.registerAndLinkAccountSource({
        accountSourceId: missingAccountSourceId,
        source: "ynab",
        sourceKind: "import",
        ingestedAt: "2020-01-01T00:00:00Z",
        accountId: randomUUID(),
        linkRevisionId: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(AccountSourceReferenceError);
    const rows = await connection.database.execute<{ count: string }>(sql`
      select count(*)::text as count
      from ledger.account_sources
      where id = ${missingAccountSourceId}
    `);
    expect(rows[0]?.count).toBe("0");
  });

  test("replays create-account-and-link commands without duplicates", async () => {
    const command = {
      account: {
        accountId: randomUUID(),
        revisionId: randomUUID(),
        name: "Retryable linked account",
        accountType: "retirement",
        accountClass: null,
        openedOn: null,
      },
      source: {
        accountSourceId: randomUUID(),
        source: "ynab",
        sourceKind: "import",
        ingestedAt: "2020-01-01T00:00:00Z",
      },
      linkRevisionId: randomUUID(),
    } as const;

    await sourceService.createAccountAndLinkSource(command);
    const laterService = createAccountSourceLinkService(sourceStore, () =>
      utcTimestampSchema.parse("2026-08-03T13:00:00Z"),
    );
    await laterService.createAccountAndLinkSource(command);
    await expect(
      sourceService.listLinkHistory(command.source.accountSourceId),
    ).resolves.toHaveLength(1);
  });

  test("does not reuse an existing account through the create flow", async () => {
    const accountId = await createAccount("Existing account guard");
    await expect(
      sourceService.createAccountAndLinkSource({
        account: {
          accountId,
          revisionId: randomUUID(),
          name: "Unexpected second initial revision",
          accountType: "checking",
          accountClass: null,
          openedOn: null,
        },
        source: {
          accountSourceId: randomUUID(),
          source: "ynab",
          sourceKind: "import",
          ingestedAt: "2020-01-01T00:00:00Z",
        },
        linkRevisionId: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(AccountSourceConflictError);
  });

  test("requires full source and link identity for create-flow replay", async () => {
    const command = {
      account: {
        accountId: randomUUID(),
        revisionId: randomUUID(),
        name: "Full replay guard",
        accountType: "checking",
        accountClass: null,
        openedOn: null,
      },
      source: {
        accountSourceId: randomUUID(),
        source: "ynab",
        sourceKind: "import",
        ingestedAt: "2020-01-01T00:00:00Z",
      },
      linkRevisionId: randomUUID(),
    } as const;
    await sourceService.createAccountAndLinkSource(command);

    const secondSourceId = randomUUID();
    await expect(
      sourceService.createAccountAndLinkSource({
        ...command,
        source: { ...command.source, accountSourceId: secondSourceId },
        linkRevisionId: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(AccountSourceConflictError);
    const rows = await connection.database.execute<{ count: string }>(sql`
      select count(*)::text as count
      from ledger.account_sources
      where id = ${secondSourceId}
    `);
    expect(rows[0]?.count).toBe("0");
  });

  test("rolls back canonical account creation when source replay conflicts", async () => {
    const accountSourceId = randomUUID();
    await sourceService.registerAccountSource({
      accountSourceId,
      source: "ynab",
      sourceKind: "import",
      ingestedAt: "2020-01-01T00:00:00Z",
    });
    const accountId = randomUUID();

    await expect(
      sourceService.createAccountAndLinkSource({
        account: {
          accountId,
          revisionId: randomUUID(),
          name: "Rolled back account",
          accountType: "checking",
          accountClass: null,
          openedOn: null,
        },
        source: {
          accountSourceId,
          source: "manual_csv",
          sourceKind: "import",
          ingestedAt: "2020-01-01T00:00:00Z",
        },
        linkRevisionId: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(AccountSourceConflictError);

    const rows = await connection.database.execute<{ count: string }>(sql`
      select count(*)::text as count from ledger.accounts where id = ${accountId}
    `);
    expect(rows[0]?.count).toBe("0");
  });

  test("rejects future ingestion timestamps and invalid root states in SQL", async () => {
    await expect(
      connection.database.execute(sql`
        insert into ledger.account_sources (id, source, source_kind, ingested_at)
        values (${randomUUID()}, 'ynab', 'import', now() + interval '1 day')
      `),
    ).rejects.toMatchObject({ cause: { code: "23514" } });

    const accountId = await createAccount("Invalid root account");
    const accountSourceId = randomUUID();
    await sourceService.registerAccountSource({
      accountSourceId,
      source: "ynab",
      sourceKind: "import",
      ingestedAt: "2020-01-01T00:00:00Z",
    });
    await expect(
      connection.database.execute(sql`
        insert into ledger.account_source_link_revisions (
          id, account_source_id, account_id, status, reason_code
        ) values (
          ${randomUUID()}, ${accountSourceId}, ${accountId},
          'unlinked', 'user_unlinked'
        )
      `),
    ).rejects.toMatchObject({ cause: { code: "23514" } });
  });

  test("installs narrow grants and required handwritten schema objects", async () => {
    const privileges = await connection.database.execute<{
      source_recorded_insert: boolean;
      source_id_insert: boolean;
      link_recorded_insert: boolean;
      source_update: boolean;
    }>(sql`
      select
        has_column_privilege(current_user, 'ledger.account_sources', 'recorded_at', 'INSERT') as source_recorded_insert,
        has_column_privilege(current_user, 'ledger.account_sources', 'id', 'INSERT') as source_id_insert,
        has_column_privilege(current_user, 'ledger.account_source_link_revisions', 'recorded_at', 'INSERT') as link_recorded_insert,
        has_table_privilege(current_user, 'ledger.account_sources', 'UPDATE') as source_update
    `);
    expect(privileges[0]).toEqual({
      source_recorded_insert: false,
      source_id_insert: true,
      link_recorded_insert: false,
      source_update: false,
    });

    const objects = await connection.database.execute<{
      transition_function: boolean;
      source_trigger: string;
      link_trigger: string;
      current_view: boolean;
      view_security_invoker: boolean;
      public_function_execute: boolean;
    }>(sql`
      select
        to_regprocedure('ledger.validate_account_source_link_revision()') is not null as transition_function,
        (select tgenabled::text from pg_trigger where tgname = 'account_sources_reject_mutation') as source_trigger,
        (select tgenabled::text from pg_trigger where tgname = 'account_source_links_reject_mutation') as link_trigger,
        to_regclass('ledger.current_account_source_links') is not null as current_view,
        coalesce((
          select 'security_invoker=true' = any(coalesce(reloptions, array[]::text[]))
          from pg_class
          where oid = 'ledger.current_account_source_links'::regclass
        ), false) as view_security_invoker,
        has_function_privilege(
          'public', 'ledger.validate_account_source_link_revision()', 'EXECUTE'
        ) as public_function_execute
    `);
    expect(objects[0]).toEqual({
      transition_function: true,
      source_trigger: "A",
      link_trigger: "A",
      current_view: true,
      view_security_invoker: true,
      public_function_execute: false,
    });

    const columns = await connection.database.execute<{
      column_name: string;
    }>(sql`
      select column_name
      from information_schema.columns
      where table_schema = 'ledger' and table_name = 'account_sources'
      order by ordinal_position
    `);
    expect(columns.map((column) => column.column_name)).toEqual([
      "id",
      "source",
      "source_kind",
      "ingested_at",
      "recorded_at",
    ]);
    const viewColumns = await connection.database.execute<{
      column_name: string;
    }>(sql`
      select column_name
      from information_schema.columns
      where table_schema = 'ledger'
        and table_name = 'current_account_source_links'
      order by ordinal_position
    `);
    expect(viewColumns.map((column) => column.column_name)).toEqual([
      "account_source_id",
      "source",
      "source_kind",
      "account_id",
      "link_revision_id",
      "reason_code",
      "recorded_at",
    ]);
  });
});
