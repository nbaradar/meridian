import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, describe, expect, test } from "vitest";

import {
  BalanceObservationConflictError,
  createAccountSourceLinkService,
  createBalanceObservationService,
  createLedgerDestinationService,
  utcTimestampSchema,
  type AccountType,
} from "../../src/core/ledger";
import { createDatabase } from "../../src/infrastructure/database/client";
import { migrationEnvironment } from "../../src/infrastructure/database/environment";
import { createPostgresAccountSourceLinkStore } from "../../src/infrastructure/database/postgres-account-sources";
import { createPostgresBalanceObservationStore } from "../../src/infrastructure/database/postgres-balance-observations";
import { createPostgresLedgerDestinationStore } from "../../src/infrastructure/database/postgres-ledger-destinations";

const connection = createDatabase();
const owner = postgres(migrationEnvironment().DATABASE_OWNER_URL, { max: 4 });
const now = utcTimestampSchema.parse(new Date().toISOString());
const today = now.slice(0, 10);

const destinations = createLedgerDestinationService(
  createPostgresLedgerDestinationStore(connection.database),
  () => now,
);
const sources = createAccountSourceLinkService(
  createPostgresAccountSourceLinkStore(connection.database),
  () => now,
);
const balances = createBalanceObservationService(
  createPostgresBalanceObservationStore(connection.database),
  () => now,
);

afterAll(async () => {
  await Promise.all([connection.close(), owner.end()]);
});

const digest = () => randomUUID().replaceAll("-", "").repeat(2);

async function createAccount(accountType: AccountType = "checking") {
  const accountId = randomUUID();
  await destinations.createAccount({
    accountId,
    revisionId: randomUUID(),
    name: `Balance test ${randomUUID()}`,
    accountType,
    accountClass: null,
    openedOn: null,
  });
  return accountId;
}

async function linkSource(
  accountId: string,
  source: "ynab" | "simplefin" = "ynab",
) {
  const accountSourceId = randomUUID();
  const linkRevisionId = randomUUID();
  await sources.registerAndLinkAccountSource({
    accountSourceId,
    source,
    sourceKind: source === "ynab" ? "import" : "connector",
    ingestedAt: now,
    accountId,
    linkRevisionId,
  });
  return { accountSourceId, linkRevisionId };
}

async function recordManual(
  accountId: string,
  enteredAmount: string,
  observedOn = today,
) {
  const observationId = randomUUID();
  await balances.recordManualBalance({
    observationId,
    accountId,
    observedOn,
    enteredAmount,
  });
  return observationId;
}

async function currentBalance(accountId: string) {
  const rows = await owner`
    select observation_id, amount::text as amount, observed_on::text as observed_on, source
    from ledger.current_balances where account_id = ${accountId}
  `;
  expect(rows.length).toBeLessThanOrEqual(1);
  return rows[0] ?? null;
}

/** Inserts as the app role, bypassing the service, to exercise SQL rules. */
function insertDirect(values: {
  accountId: string;
  currency?: string;
  source?: string;
  accountSourceId?: string | null;
  exportDigest?: string | null;
  supersedes?: string | null;
  observedOn?: string;
}) {
  return connection.database.execute(sql`
    insert into ledger.balance_observations (
      id, account_id, observed_on, amount, currency, source,
      account_source_id, export_digest, supersedes_observation_id
    ) values (
      ${randomUUID()}, ${values.accountId}, ${values.observedOn ?? today},
      ${"1"}::numeric, ${values.currency ?? "USD"}, ${values.source ?? "manual"},
      ${values.accountSourceId ?? null}, ${values.exportDigest ?? null},
      ${values.supersedes ?? null}
    )
  `);
}

function retractDirect(observationId: string) {
  return connection.database.execute(sql`
    insert into ledger.balance_observation_retractions (id, observation_id)
    values (${randomUUID()}, ${observationId})
  `);
}

const rejectsWith = (code: string) => ({ cause: { code } });

describe("PostgreSQL balance observations", () => {
  test("is append-only under the app and owner roles", async () => {
    const accountId = await createAccount();
    const observationId = await recordManual(accountId, "10");
    await balances.retractBalance({
      retractionId: randomUUID(),
      observationId,
    });

    for (const table of [
      "balance_observations",
      "balance_observation_retractions",
    ]) {
      const idColumn =
        table === "balance_observations" ? "id" : "observation_id";
      await expect(
        owner.unsafe(
          `update ledger.${table} set recorded_at = now() where ${idColumn} = $1`,
          [observationId],
        ),
      ).rejects.toMatchObject({ code: "55000" });
      await expect(
        owner.unsafe(`delete from ledger.${table} where ${idColumn} = $1`, [
          observationId,
        ]),
      ).rejects.toMatchObject({ code: "55000" });
      await expect(
        owner.unsafe(`truncate ledger.${table} cascade`),
      ).rejects.toMatchObject({ code: "55000" });

      for (const statement of [
        sql.raw(`update ledger.${table} set recorded_at = now()`),
        sql.raw(`delete from ledger.${table}`),
        sql.raw(`truncate ledger.${table}`),
      ]) {
        await expect(
          connection.database.execute(statement),
        ).rejects.toMatchObject(rejectsWith("42501"));
      }
    }
  });

  test("keeps recorded_at server-owned and the view security-invoker", async () => {
    const accountId = await createAccount();
    await expect(
      connection.database.execute(sql`
        insert into ledger.balance_observations
          (id, account_id, observed_on, amount, currency, source, recorded_at)
        values (${randomUUID()}, ${accountId}, ${today}, 1, 'USD', 'manual',
          '2000-01-01T00:00:00Z')
      `),
    ).rejects.toMatchObject(rejectsWith("42501"));

    const privileges = await connection.database.execute<{
      observation_recorded: boolean;
      retraction_recorded: boolean;
      observation_id: boolean;
      view_security_invoker: boolean;
    }>(sql`
      select
        has_column_privilege(current_user, 'ledger.balance_observations', 'recorded_at', 'INSERT') as observation_recorded,
        has_column_privilege(current_user, 'ledger.balance_observation_retractions', 'recorded_at', 'INSERT') as retraction_recorded,
        has_column_privilege(current_user, 'ledger.balance_observations', 'id', 'INSERT') as observation_id,
        coalesce((
          select 'security_invoker=true' = any(coalesce(reloptions, array[]::text[]))
          from pg_class where oid = 'ledger.current_balances'::regclass
        ), false) as view_security_invoker
    `);
    expect(privileges[0]).toEqual({
      observation_recorded: false,
      retraction_recorded: false,
      observation_id: true,
      view_security_invoker: true,
    });
  });

  test("rejects a currency that differs from the account's", async () => {
    const accountId = await createAccount();
    await expect(
      insertDirect({ accountId, currency: "EUR" }),
    ).rejects.toMatchObject(rejectsWith("23514"));
  });

  test("rejects inconsistent source columns", async () => {
    const accountId = await createAccount();
    const { accountSourceId } = await linkSource(accountId);
    for (const values of [
      { accountId, source: "manual", accountSourceId },
      { accountId, source: "manual", exportDigest: digest() },
      { accountId, source: "ynab_export", accountSourceId },
      { accountId, source: "ynab_export", exportDigest: digest() },
      {
        accountId,
        source: "ynab_export",
        accountSourceId,
        exportDigest: "ABC",
      },
      { accountId, source: "import" },
    ]) {
      await expect(insertDirect(values)).rejects.toMatchObject(
        rejectsWith("23514"),
      );
    }
  });

  test("requires a YNAB source currently linked to the observed account", async () => {
    const accountId = await createAccount();
    const otherAccountId = await createAccount();
    const linked = await linkSource(accountId);
    const connector = await linkSource(accountId, "simplefin");
    const ynab = (accountSourceId: string, target = accountId) =>
      insertDirect({
        accountId: target,
        source: "ynab_export",
        accountSourceId,
        exportDigest: digest(),
      });

    await expect(ynab(linked.accountSourceId)).resolves.toBeDefined();
    await expect(
      ynab(linked.accountSourceId, otherAccountId),
    ).rejects.toMatchObject(rejectsWith("23514"));
    await expect(ynab(connector.accountSourceId)).rejects.toMatchObject(
      rejectsWith("23514"),
    );
    await expect(ynab(randomUUID())).rejects.toMatchObject(
      rejectsWith("23503"),
    );

    await sources.unlinkAccountSource({
      linkRevisionId: randomUUID(),
      accountSourceId: linked.accountSourceId,
      accountId,
      supersedesLinkRevisionId: linked.linkRevisionId,
      reasonCode: "user_unlinked",
    });
    await expect(ynab(linked.accountSourceId)).rejects.toMatchObject(
      rejectsWith("23514"),
    );
  });

  test("rejects corrections of another account, a superseded, or a retracted observation", async () => {
    const accountId = await createAccount();
    const otherAccountId = await createAccount();
    const original = await recordManual(accountId, "100");

    await expect(
      insertDirect({ accountId: otherAccountId, supersedes: original }),
    ).rejects.toMatchObject(rejectsWith("23514"));

    const correction = randomUUID();
    await balances.correctBalance({
      observationId: correction,
      supersedesObservationId: original,
      accountId,
      observedOn: today,
      enteredAmount: "90",
    });
    await expect(
      insertDirect({ accountId, supersedes: original }),
    ).rejects.toMatchObject(rejectsWith("23514"));
    await expect(
      balances.correctBalance({
        observationId: randomUUID(),
        supersedesObservationId: original,
        accountId,
        observedOn: today,
        enteredAmount: "80",
      }),
    ).rejects.toBeInstanceOf(BalanceObservationConflictError);

    await retractDirect(correction);
    await expect(
      insertDirect({ accountId, supersedes: correction }),
    ).rejects.toMatchObject(rejectsWith("23514"));
    await expect(
      insertDirect({ accountId, supersedes: randomUUID() }),
    ).rejects.toMatchObject(rejectsWith("23503"));
  });

  test("rejects a second retraction and a retraction of a superseded observation", async () => {
    const accountId = await createAccount();
    const original = await recordManual(accountId, "5");
    const correction = randomUUID();
    await balances.correctBalance({
      observationId: correction,
      supersedesObservationId: original,
      accountId,
      observedOn: today,
      enteredAmount: "6",
    });
    await expect(retractDirect(original)).rejects.toMatchObject(
      rejectsWith("23514"),
    );

    await retractDirect(correction);
    await expect(retractDirect(correction)).rejects.toMatchObject(
      rejectsWith("23505"),
    );
    await expect(
      balances.retractBalance({
        retractionId: randomUUID(),
        observationId: correction,
      }),
    ).rejects.toBeInstanceOf(BalanceObservationConflictError);
    await expect(retractDirect(randomUUID())).rejects.toMatchObject(
      rejectsWith("23503"),
    );
  });

  test("rejects a duplicate (account_source_id, export_digest)", async () => {
    const accountId = await createAccount();
    const { accountSourceId } = await linkSource(accountId);
    const exportDigest = digest();
    const values = {
      accountId,
      source: "ynab_export",
      accountSourceId,
      exportDigest,
    };
    await insertDirect(values);
    await expect(insertDirect(values)).rejects.toMatchObject(
      rejectsWith("23505"),
    );
  });

  test("current_balances applies date, recorded_at, and id precedence", async () => {
    const accountId = await createAccount();
    const older = await recordManual(accountId, "1", "2026-01-01");
    const newerDate = await recordManual(accountId, "2", "2026-02-01");
    expect((await currentBalance(accountId))?.observation_id).toBe(newerDate);

    // A later observed_on wins even when recorded earlier.
    await recordManual(accountId, "3", "2026-01-15");
    expect((await currentBalance(accountId))?.observation_id).toBe(newerDate);

    // Same observed_on: the later recorded_at wins.
    const laterRecorded = await recordManual(accountId, "4", "2026-02-01");
    expect(await currentBalance(accountId)).toMatchObject({
      observation_id: laterRecorded,
      amount: "4",
      observed_on: "2026-02-01",
    });

    // Same observed_on and recorded_at (one transaction): the highest id wins.
    const tieAccount = await createAccount();
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    await owner.begin(async (transaction) => {
      for (const id of ids) {
        await transaction`
          insert into ledger.balance_observations
            (id, account_id, observed_on, amount, currency, source)
          values (${id}, ${tieAccount}, '2026-03-01', 7, 'USD', 'manual')
        `;
      }
    });
    expect((await currentBalance(tieAccount))?.observation_id).toBe(
      [...ids].sort().at(-1),
    );
    expect(older).not.toBe(newerDate);
  });

  test("current_balances excludes superseded and retracted observations", async () => {
    const accountId = await createAccount("credit_card");
    const first = await recordManual(accountId, "250.5", "2026-04-01");
    expect(await currentBalance(accountId)).toMatchObject({
      observation_id: first,
      amount: "-250.5",
    });

    // A correction dated earlier still replaces the observation it supersedes.
    const background = await recordManual(accountId, "10", "2026-03-01");
    const correction = randomUUID();
    await balances.correctBalance({
      observationId: correction,
      supersedesObservationId: first,
      accountId,
      observedOn: "2026-03-15",
      enteredAmount: "240",
    });
    expect(await currentBalance(accountId)).toMatchObject({
      observation_id: correction,
      amount: "-240",
    });

    await balances.retractBalance({
      retractionId: randomUUID(),
      observationId: correction,
    });
    expect((await currentBalance(accountId))?.observation_id).toBe(background);

    await balances.retractBalance({
      retractionId: randomUUID(),
      observationId: background,
    });
    expect(await currentBalance(accountId)).toBeNull();
    const listed = await balances.listCurrentBalances();
    expect(listed.some((balance) => balance.accountId === accountId)).toBe(
      false,
    );
  });

  test("saving a YNAB balance twice is a no-op, and a retracted one is not recreated", async () => {
    const accountId = await createAccount();
    const { accountSourceId } = await linkSource(accountId);
    const command = () => ({
      observationId: randomUUID(),
      accountId,
      accountSourceId,
      exportDigest: "b".repeat(64),
      observedOn: "2026-05-01",
      amount: "-12.34",
    });
    await expect(balances.recordYnabBalance(command())).resolves.toBe(
      "recorded",
    );
    await expect(balances.recordYnabBalance(command())).resolves.toBe(
      "already_saved",
    );
    const current = await currentBalance(accountId);
    expect(current).toMatchObject({ amount: "-12.34", source: "ynab_export" });

    await balances.retractBalance({
      retractionId: randomUUID(),
      observationId: current!.observation_id as string,
    });
    await expect(balances.recordYnabBalance(command())).resolves.toBe(
      "already_saved",
    );
    expect(await currentBalance(accountId)).toBeNull();

    // Concurrent saves of a new export record exactly one observation.
    const exportDigest = digest();
    const outcomes = await Promise.all(
      [1, 2, 3].map(() =>
        balances.recordYnabBalance({ ...command(), exportDigest }),
      ),
    );
    expect(outcomes.filter((outcome) => outcome === "recorded")).toHaveLength(
      1,
    );
    const rows = await owner`
      select count(*)::int as count from ledger.balance_observations
      where account_source_id = ${accountSourceId}
    `;
    expect(rows[0]!.count).toBe(2);
  });

  test("lets exactly one concurrent correction of the same observation win", async () => {
    const accountId = await createAccount();
    const original = await recordManual(accountId, "1");
    const results = await Promise.allSettled(
      ["2", "3", "4"].map((enteredAmount) =>
        balances.correctBalance({
          observationId: randomUUID(),
          supersedesObservationId: original,
          accountId,
          observedOn: today,
          enteredAmount,
        }),
      ),
    );
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    for (const result of results) {
      if (result.status === "rejected") {
        expect(result.reason).toBeInstanceOf(BalanceObservationConflictError);
      }
    }
  });
});
