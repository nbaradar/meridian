import { randomBytes, randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, describe, expect, test } from "vitest";

import {
  AccountSourceReferenceError,
  createAccountSourceLinkService,
  createLedgerDestinationService,
  utcTimestampSchema,
} from "../../src/core/ledger";
import { createDatabase } from "../../src/infrastructure/database/client";
import { migrationEnvironment } from "../../src/infrastructure/database/environment";
import { createPostgresAccountSourceLinkStore } from "../../src/infrastructure/database/postgres-account-sources";
import { createPostgresLedgerDestinationStore } from "../../src/infrastructure/database/postgres-ledger-destinations";
import { createPostgresYnabAccountDecisionStore } from "../../src/infrastructure/database/postgres-ynab-account-decisions";
import { createYnabLabelDigester } from "../../src/infrastructure/ynab/label-digest";
import {
  YnabAccountAlreadyDecidedError,
  createYnabAccountDecisionService,
  ynabAccountDecisionIdSchema,
} from "../../src/modules/ynab";

const connection = createDatabase();
const owner = postgres(migrationEnvironment().DATABASE_OWNER_URL, { max: 2 });
const now = utcTimestampSchema.parse("2026-09-01T12:00:00Z");
const key = () => randomBytes(32).toString("base64");
const oldKey = key();
const currentKey = key();

const oldDigester = createYnabLabelDigester({
  YNAB_LABEL_DIGEST_CURRENT_KEY_ID: "test-old",
  YNAB_LABEL_DIGEST_KEYRING: { "test-old": oldKey },
});
const digester = createYnabLabelDigester({
  YNAB_LABEL_DIGEST_CURRENT_KEY_ID: "test-current",
  YNAB_LABEL_DIGEST_KEYRING: { "test-old": oldKey, "test-current": currentKey },
});
const store = createPostgresYnabAccountDecisionStore(connection.database);
const service = createYnabAccountDecisionService(
  store,
  digester,
  () => now,
  randomUUID,
);
const destinationService = createLedgerDestinationService(
  createPostgresLedgerDestinationStore(connection.database),
  () => now,
);
const sourceService = createAccountSourceLinkService(
  createPostgresAccountSourceLinkStore(connection.database),
  () => now,
);

afterAll(async () => {
  await Promise.all([connection.close(), owner.end()]);
});

function uniqueName(label: string): string {
  return `${label} ${randomUUID()}`;
}

async function accountCount(name: string): Promise<number> {
  const rows = await connection.database.execute<{ count: string }>(sql`
    select count(*)::text as count from ledger.account_revisions where name = ${name}
  `);
  return Number(rows[0]!.count);
}

function createMapping(sourceName: string, name = sourceName) {
  return {
    sourceName,
    action: "create" as const,
    name,
    accountType: "checking" as const,
    accountClass: null,
    openedOn: null,
  };
}

describe("PostgreSQL YNAB account decisions", () => {
  test("creates an account, source, link, and tracked decision atomically", async () => {
    const sourceName = uniqueName("Synthetic Checking");
    await service.save(createMapping(sourceName));

    const state = (await service.lookup([sourceName])).get(sourceName);
    expect(state).toMatchObject({
      status: "tracked",
      account: { name: sourceName, accountType: "checking" },
    });
    if (state?.status !== "tracked") throw new Error("expected tracked");
    await expect(
      sourceService.resolveCurrentAccount(state.accountSourceId),
    ).resolves.toMatchObject({ source: "ynab", sourceKind: "import" });

    const stored = await owner`
      select label_digest from ledger.ynab_account_decisions
      where id = ${state.decisionId}
    `;
    expect(stored[0]!.label_digest).toBe(
      digester.digest(sourceName).labelDigest,
    );
    expect(JSON.stringify(stored)).not.toContain(sourceName);
  });

  test("links to an existing account and reports unsaved names", async () => {
    const accountId = randomUUID();
    const accountName = uniqueName("Existing savings");
    await destinationService.createAccount({
      accountId,
      revisionId: randomUUID(),
      name: accountName,
      accountType: "savings",
      accountClass: null,
      openedOn: null,
    });
    const sourceName = uniqueName("Synthetic Savings");
    const unsavedName = uniqueName("Never saved");
    await service.save({
      sourceName,
      action: "link",
      accountId: accountId as never,
    });

    const states = await service.lookup([sourceName, unsavedName]);
    expect(states.get(sourceName)).toMatchObject({
      status: "tracked",
      account: { id: accountId, name: accountName },
    });
    expect(states.get(unsavedName)).toEqual({ status: "unsaved" });
  });

  test("records exclusions and allows re-deciding them as tracked", async () => {
    const sourceName = uniqueName("Duplicate checking");
    await service.save({ sourceName, action: "exclude" });
    const excluded = (await service.lookup([sourceName])).get(sourceName);
    expect(excluded?.status).toBe("excluded");

    await expect(
      service.save({ sourceName, action: "exclude" }),
    ).rejects.toBeInstanceOf(YnabAccountAlreadyDecidedError);

    await service.save(createMapping(sourceName));
    const tracked = (await service.lookup([sourceName])).get(sourceName);
    expect(tracked?.status).toBe("tracked");
    if (excluded?.status !== "excluded" || tracked?.status !== "tracked") {
      throw new Error("expected excluded then tracked");
    }
    const chain = await owner`
      select supersedes_decision_id from ledger.ynab_account_decisions
      where id = ${tracked.decisionId}
    `;
    expect(chain[0]!.supersedes_decision_id).toBe(excluded.decisionId);
  });

  test("reuses a saved YNAB source for a renamed account", async () => {
    const originalName = uniqueName("Old YNAB name");
    const renamedName = uniqueName("New YNAB name");
    await service.save(createMapping(originalName));
    const original = (await service.lookup([originalName])).get(originalName);
    if (original?.status !== "tracked") throw new Error("expected tracked");

    await service.save({
      sourceName: renamedName,
      action: "renamed",
      accountSourceId: original.accountSourceId,
    });
    const renamed = (await service.lookup([renamedName])).get(renamedName);
    expect(renamed).toMatchObject({
      status: "tracked",
      accountSourceId: original.accountSourceId,
      account: { name: originalName },
    });
    const tracked = await service.listTrackedSources();
    expect(
      tracked.filter(
        (source) => source.accountSourceId === original.accountSourceId,
      ),
    ).toHaveLength(1);
  });

  test("rejects a second decision and lets exactly one concurrent save win", async () => {
    const sourceName = uniqueName("Contended account");
    const results = await Promise.allSettled([
      service.save(createMapping(sourceName)),
      service.save(createMapping(sourceName)),
      service.save(createMapping(sourceName)),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    for (const result of results) {
      if (result.status === "rejected") {
        expect(result.reason).toBeInstanceOf(YnabAccountAlreadyDecidedError);
      }
    }
    expect(await accountCount(sourceName)).toBe(1);
    await expect(
      service.save(createMapping(sourceName)),
    ).rejects.toBeInstanceOf(YnabAccountAlreadyDecidedError);
  });

  test("rolls back the source when linking to a missing account", async () => {
    const sourceName = uniqueName("Missing link target");
    await expect(
      service.save({
        sourceName,
        action: "link",
        accountId: randomUUID() as never,
      }),
    ).rejects.toBeInstanceOf(AccountSourceReferenceError);
    expect((await service.lookup([sourceName])).get(sourceName)).toEqual({
      status: "unsaved",
    });
  });

  test("replays an identical write and recognizes decisions under retired keys", async () => {
    const sourceName = uniqueName("Rotated key account");
    const decision = {
      id: ynabAccountDecisionIdSchema.parse(randomUUID()),
      ...oldDigester.digest(sourceName),
      decision: "excluded" as const,
      accountSourceId: null,
      supersedesDecisionId: null,
    };
    await store.saveDecision({ kind: "exclude", decision });
    await store.saveDecision({ kind: "exclude", decision });

    const rows = await owner`
      select count(*)::int as count from ledger.ynab_account_decisions
      where label_digest = ${decision.labelDigest}
    `;
    expect(rows[0]!.count).toBe(1);
    expect((await service.lookup([sourceName])).get(sourceName)).toEqual({
      status: "excluded",
      decisionId: decision.id,
    });

    // Re-deciding extends the retired-key chain rather than starting a new one.
    await service.save(createMapping(sourceName));
    const tracked = await owner`
      select digest_key_id from ledger.ynab_account_decisions
      where supersedes_decision_id = ${decision.id}
    `;
    expect(tracked[0]!.digest_key_id).toBe("test-old");
  });

  test("enforces source kind, transitions, append-only, and grants in SQL", async () => {
    const connectorSourceId = randomUUID();
    const accountId = randomUUID();
    await destinationService.createAccount({
      accountId,
      revisionId: randomUUID(),
      name: uniqueName("Connector account"),
      accountType: "checking",
      accountClass: null,
      openedOn: null,
    });
    await sourceService.registerAndLinkAccountSource({
      accountSourceId: connectorSourceId,
      source: "simplefin",
      sourceKind: "connector",
      ingestedAt: "2026-01-01T00:00:00Z",
      accountId,
      linkRevisionId: randomUUID(),
    });
    const digest = digester.digest(uniqueName("Direct insert"));
    await expect(
      connection.database.execute(sql`
        insert into ledger.ynab_account_decisions
          (id, label_digest, digest_key_id, decision, account_source_id)
        values (${randomUUID()}, ${digest.labelDigest}, ${digest.digestKeyId},
          'tracked', ${connectorSourceId})
      `),
    ).rejects.toMatchObject({ cause: { code: "23514" } });

    const trackedName = uniqueName("Tracked for transition");
    await service.save(createMapping(trackedName));
    const tracked = (await service.lookup([trackedName])).get(trackedName);
    if (tracked?.status !== "tracked") throw new Error("expected tracked");
    const trackedDigest = digester.digest(trackedName);
    await expect(
      connection.database.execute(sql`
        insert into ledger.ynab_account_decisions
          (id, label_digest, digest_key_id, decision, supersedes_decision_id)
        values (${randomUUID()}, ${trackedDigest.labelDigest},
          ${trackedDigest.digestKeyId}, 'excluded', ${tracked.decisionId})
      `),
    ).rejects.toMatchObject({ cause: { code: "23514" } });

    await expect(owner`
      update ledger.ynab_account_decisions set decision = 'excluded'
      where id = ${tracked.decisionId}
    `).rejects.toMatchObject({ code: "55000" });
    await expect(owner`
      delete from ledger.ynab_account_decisions where id = ${tracked.decisionId}
    `).rejects.toMatchObject({ code: "55000" });
    await expect(owner`
      truncate ledger.ynab_account_decisions
    `).rejects.toMatchObject({ code: "55000" });

    const privileges = await connection.database.execute<{
      recorded_insert: boolean;
      id_insert: boolean;
      update: boolean;
      view_security_invoker: boolean;
    }>(sql`
      select
        has_column_privilege(current_user, 'ledger.ynab_account_decisions', 'recorded_at', 'INSERT') as recorded_insert,
        has_column_privilege(current_user, 'ledger.ynab_account_decisions', 'id', 'INSERT') as id_insert,
        has_table_privilege(current_user, 'ledger.ynab_account_decisions', 'UPDATE') as update,
        coalesce((
          select 'security_invoker=true' = any(coalesce(reloptions, array[]::text[]))
          from pg_class
          where oid = 'ledger.current_ynab_account_decisions'::regclass
        ), false) as view_security_invoker
    `);
    expect(privileges[0]).toEqual({
      recorded_insert: false,
      id_insert: true,
      update: false,
      view_security_invoker: true,
    });
  });
});
