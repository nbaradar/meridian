import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, describe, expect, test } from "vitest";

import {
  createAccountSourceLinkService,
  createLedgerDestinationService,
  createTransactionAuthorityService,
  reviewedBalancePolicySchema,
  TransactionAuthorityConflictError,
  utcTimestampSchema,
  type AccountSourceName,
} from "../../src/core/ledger";
import { createDatabase } from "../../src/infrastructure/database/client";
import { migrationEnvironment } from "../../src/infrastructure/database/environment";
import { createPostgresAccountSourceLinkStore } from "../../src/infrastructure/database/postgres-account-sources";
import { createPostgresLedgerDestinationStore } from "../../src/infrastructure/database/postgres-ledger-destinations";
import { createPostgresTransactionAuthorityStore } from "../../src/infrastructure/database/postgres-transaction-authority";

const connection = createDatabase();
const owner = postgres(migrationEnvironment().DATABASE_OWNER_URL, { max: 4 });
const now = utcTimestampSchema.parse("2026-09-01T00:00:00Z");

const destinations = createLedgerDestinationService(
  createPostgresLedgerDestinationStore(connection.database),
  () => now,
);
const sources = createAccountSourceLinkService(
  createPostgresAccountSourceLinkStore(connection.database),
  () => now,
);
const store = createPostgresTransactionAuthorityStore(connection.database);
// Production wiring: the empty reviewed-policy registry.
const production = createTransactionAuthorityService(store);
// Test-only policy, injected to exercise passed and failed results.
const reviewed = createTransactionAuthorityService(store, {
  policies: [
    reviewedBalancePolicySchema.parse({
      provider: "simplefin",
      semantic: "current",
      tolerance: "0.01",
    }),
  ],
});

afterAll(async () => {
  await Promise.all([connection.close(), owner.end()]);
});

const rejectsWith = (code: string) => ({ cause: { code } });
const sleep = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function createAccount(
  accountType: "checking" | "credit_card" = "checking",
) {
  const accountId = randomUUID();
  await destinations.createAccount({
    accountId,
    revisionId: randomUUID(),
    name: `Authority test ${randomUUID()}`,
    accountType,
    accountClass: null,
    openedOn: null,
  });
  return accountId;
}

async function linkSource(accountId: string, source: AccountSourceName) {
  const accountSourceId = randomUUID();
  const linkRevisionId = randomUUID();
  await sources.registerAndLinkAccountSource({
    accountSourceId,
    source,
    sourceKind: source === "simplefin" ? "connector" : "import",
    ingestedAt: now,
    accountId,
    linkRevisionId,
  });
  return { accountSourceId, linkRevisionId };
}

async function propose(
  accountId: string,
  accountSourceId: string,
  startsOn: string,
  endsOn: string | null,
) {
  const authorityWindowId = randomUUID();
  const { id } = await production.proposeWindow({
    revisionId: randomUUID(),
    authorityWindowId,
    accountId,
    accountSourceId,
    startsOn,
    endsOn,
  });
  return { revisionId: id, authorityWindowId };
}

function activate(
  supersedesRevisionId: string,
  reconciliationCheckId: string | null = null,
) {
  return production.activateWindow({
    revisionId: randomUUID(),
    supersedesRevisionId,
    reconciliationCheckId,
  });
}

async function recordCheck(
  service: typeof production,
  accountId: string,
  accountSourceId: string,
  providerBalance: string,
  cutoffOn = "2026-09-01",
  balanceSemantic = "current",
) {
  const { check } = await service.recordReconciliationCheck({
    checkId: randomUUID(),
    accountId,
    accountSourceId,
    cutoffOn,
    observationStartsOn: "2026-08-01",
    observationEndsOn: "2026-09-10",
    providerBalance,
    balanceSemantic,
    rawPayloadId: null,
  });
  return check;
}

/** A balanced manual transaction: `amount` to the account, its negation to a category. */
async function postEntry(
  accountId: string,
  occurredOn: string,
  amount: string,
) {
  const negated = amount.startsWith("-") ? amount.slice(1) : `-${amount}`;
  await owner.begin(async (transaction) => {
    const categoryId = randomUUID();
    const transactionId = randomUUID();
    await transaction`
      insert into ledger.categories (id, kind) values (${categoryId}, 'expense')
    `;
    await transaction`
      insert into ledger.transactions (id, occurred_on, description, currency, origin)
      values (${transactionId}, ${occurredOn}, 'Authority fixture', 'USD', 'manual')
    `;
    await transaction`
      insert into ledger.entries (id, transaction_id, account_id, amount)
      values (${randomUUID()}, ${transactionId}, ${accountId}, ${amount})
    `;
    await transaction`
      insert into ledger.entries (id, transaction_id, category_id, amount)
      values (${randomUUID()}, ${transactionId}, ${categoryId}, ${negated})
    `;
  });
}

function insertRevisionDirect(values: {
  windowId: string;
  accountId: string;
  accountSourceId: string;
  startsOn?: string;
  endsOn?: string | null;
  status: string;
  reasonCode: string;
  supersedes?: string | null;
}) {
  return connection.database.execute(sql`
    insert into ledger.transaction_authority_revisions (
      id, authority_window_id, account_id, account_source_id, starts_on,
      ends_on, status, supersedes_revision_id, reason_code
    ) values (
      ${randomUUID()}, ${values.windowId}, ${values.accountId},
      ${values.accountSourceId}, ${values.startsOn ?? "2020-01-01"},
      ${values.endsOn === undefined ? null : values.endsOn}, ${values.status},
      ${values.supersedes ?? null}, ${values.reasonCode}
    )
  `);
}

describe("PostgreSQL transaction authority", () => {
  test("activates an import window without a check and evaluates half-open cutoffs", async () => {
    const accountId = await createAccount();
    const ynab = await linkSource(accountId, "ynab");
    const live = await linkSource(accountId, "simplefin");

    const ynabWindow = await propose(
      accountId,
      ynab.accountSourceId,
      "2020-01-01",
      "2026-09-01",
    );
    await activate(ynabWindow.revisionId);

    await postEntry(accountId, "2026-08-31", "1000.5");
    const passed = await recordCheck(
      reviewed,
      accountId,
      live.accountSourceId,
      "1000.505",
    );
    expect(passed.result).toBe("passed");
    const liveWindow = await propose(
      accountId,
      live.accountSourceId,
      "2026-09-01",
      null,
    );
    await activate(liveWindow.revisionId, passed.id);

    const evaluate = (accountSourceId: string, occurredOn: string) =>
      production.evaluate({ accountId, accountSourceId, occurredOn });
    await expect(
      evaluate(ynab.accountSourceId, "2026-08-31"),
    ).resolves.toMatchObject({
      status: "authorized",
      window: { accountSourceId: ynab.accountSourceId },
    });
    await expect(
      evaluate(live.accountSourceId, "2026-09-01"),
    ).resolves.toMatchObject({
      status: "authorized",
      window: { accountSourceId: live.accountSourceId },
    });
    await expect(
      evaluate(ynab.accountSourceId, "2026-09-01"),
    ).resolves.toMatchObject({ status: "wrong_source" });
    await expect(evaluate(ynab.accountSourceId, "2019-12-31")).resolves.toEqual(
      {
        status: "no_window",
      },
    );
  });

  test("prevents branching chains and invalid transitions", async () => {
    const accountId = await createAccount();
    const { accountSourceId } = await linkSource(accountId, "ynab");
    const windowId = randomUUID();
    const base = { windowId, accountId, accountSourceId, endsOn: "2026-01-01" };
    await insertRevisionDirect({
      ...base,
      status: "proposed",
      reasonCode: "window_proposed",
    });
    await expect(
      insertRevisionDirect({
        ...base,
        status: "proposed",
        reasonCode: "window_proposed",
      }),
    ).rejects.toMatchObject(rejectsWith("23505"));

    const [root] = await owner`
      select id from ledger.transaction_authority_revisions
      where authority_window_id = ${windowId}
    `;
    const activated = await activate(root!.id as string);
    // A second successor of the same predecessor would branch the chain.
    await expect(
      insertRevisionDirect({
        ...base,
        status: "revoked",
        reasonCode: "owner_revoked",
        supersedes: root!.id as string,
      }),
    ).rejects.toMatchObject(rejectsWith("23514"));
    // active -> active, active -> proposed, and changing the range are invalid.
    for (const values of [
      { status: "active", reasonCode: "window_activated" },
      { status: "proposed", reasonCode: "window_proposed" },
      {
        status: "revoked",
        reasonCode: "owner_revoked",
        endsOn: "2026-02-01",
      },
      { status: "revoked", reasonCode: "window_activated" },
    ]) {
      await expect(
        insertRevisionDirect({ ...base, ...values, supersedes: activated.id }),
      ).rejects.toMatchObject(rejectsWith("23514"));
    }

    const revoked = await production.revokeWindow({
      revisionId: randomUUID(),
      supersedesRevisionId: activated.id,
      reasonCode: "owner_revoked",
    });
    // revoked is terminal.
    await expect(
      insertRevisionDirect({
        ...base,
        status: "active",
        reasonCode: "window_activated",
        supersedes: revoked.id,
      }),
    ).rejects.toMatchObject(rejectsWith("23514"));
    await expect(activate(revoked.id)).rejects.toBeInstanceOf(
      TransactionAuthorityConflictError,
    );
  });

  test("rejects overlapping active windows, including under concurrency", async () => {
    const accountId = await createAccount();
    const ynab = await linkSource(accountId, "ynab");
    const csv = await linkSource(accountId, "manual_csv");

    const first = await propose(
      accountId,
      ynab.accountSourceId,
      "2020-01-01",
      "2026-09-01",
    );
    await activate(first.revisionId);
    const overlapping = await propose(
      accountId,
      csv.accountSourceId,
      "2026-08-31",
      null,
    );
    await expect(activate(overlapping.revisionId)).rejects.toBeInstanceOf(
      TransactionAuthorityConflictError,
    );
    // Adjacent half-open windows do not overlap.
    const adjacent = await propose(
      accountId,
      csv.accountSourceId,
      "2026-09-01",
      null,
    );
    await activate(adjacent.revisionId);

    const racingAccount = await createAccount();
    const racingSource = await linkSource(racingAccount, "ynab");
    const proposals = await Promise.all(
      ["2020-01-01", "2021-01-01", "2022-01-01", "2023-01-01"].map((startsOn) =>
        propose(racingAccount, racingSource.accountSourceId, startsOn, null),
      ),
    );
    const results = await Promise.allSettled(
      proposals.map((proposal) => activate(proposal.revisionId)),
    );
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    for (const result of results) {
      if (result.status === "rejected") {
        expect(result.reason).toBeInstanceOf(TransactionAuthorityConflictError);
      }
    }
    const [active] = await owner`
      select count(*)::int as count from ledger.current_transaction_authority_windows
      where account_id = ${racingAccount} and status = 'active'
    `;
    expect(active!.count).toBe(1);
  });

  test("rejects activation against a relinked source, serializing with the relink", async () => {
    const accountId = await createAccount();
    const otherAccountId = await createAccount();
    const ynab = await linkSource(accountId, "ynab");
    const window = await propose(
      accountId,
      ynab.accountSourceId,
      "2020-01-01",
      null,
    );

    // Hold an uncommitted relink; activation must wait for it, then fail.
    let activation: Promise<unknown> | undefined;
    let settled = false;
    await owner.begin(async (transaction) => {
      const unlinkId = randomUUID();
      await transaction`
        insert into ledger.account_source_link_revisions (
          id, account_source_id, account_id, status, supersedes_link_revision_id, reason_code
        ) values (
          ${unlinkId}, ${ynab.accountSourceId}, ${accountId}, 'unlinked',
          ${ynab.linkRevisionId}, 'mapping_correction_unlinked'
        )
      `;
      await transaction`
        insert into ledger.account_source_link_revisions (
          id, account_source_id, account_id, status, supersedes_link_revision_id, reason_code
        ) values (
          ${randomUUID()}, ${ynab.accountSourceId}, ${otherAccountId}, 'linked',
          ${unlinkId}, 'mapping_correction_linked'
        )
      `;
      activation = activate(window.revisionId).finally(() => {
        settled = true;
      });
      activation.catch(() => undefined);
      await sleep(300);
      expect(settled).toBe(false);
    });
    await expect(activation).rejects.toBeInstanceOf(
      TransactionAuthorityConflictError,
    );

    // A stale proposal for the old account can never activate now.
    const stale = await propose(
      accountId,
      ynab.accountSourceId,
      "2020-01-01",
      null,
    );
    await expect(activate(stale.revisionId)).rejects.toThrow(
      /currently linked/u,
    );
  });

  test("requires a passed check for the same account, source, and cutoff to activate a connector window", async () => {
    const accountId = await createAccount();
    const live = await linkSource(accountId, "simplefin");
    const otherLive = await linkSource(accountId, "simplefin");
    await postEntry(accountId, "2026-08-15", "250");
    const window = await propose(
      accountId,
      live.accountSourceId,
      "2026-09-01",
      null,
    );

    await expect(activate(window.revisionId)).rejects.toThrow(
      /needs a passed reconciliation check/u,
    );

    const notComparable = await recordCheck(
      production,
      accountId,
      live.accountSourceId,
      "250",
    );
    expect(notComparable).toMatchObject({
      result: "not_comparable",
      tolerance: null,
      ledgerBalance: "250",
      difference: "0",
    });
    await expect(activate(window.revisionId, notComparable.id)).rejects.toThrow(
      /not_comparable reconciliation check cannot activate/u,
    );

    const failed = await recordCheck(
      reviewed,
      accountId,
      live.accountSourceId,
      "251",
    );
    expect(failed).toMatchObject({ result: "failed", difference: "1" });
    await expect(activate(window.revisionId, failed.id)).rejects.toThrow(
      /failed reconciliation check cannot activate/u,
    );

    const otherCutoff = await recordCheck(
      reviewed,
      accountId,
      live.accountSourceId,
      "250",
      "2026-08-31",
    );
    expect(otherCutoff.result).toBe("passed");
    const otherSource = await recordCheck(
      reviewed,
      accountId,
      otherLive.accountSourceId,
      "250",
    );
    for (const check of [otherCutoff, otherSource]) {
      await expect(activate(window.revisionId, check.id)).rejects.toThrow(
        /same account, source, and cutoff/u,
      );
    }

    const passed = await recordCheck(
      reviewed,
      accountId,
      live.accountSourceId,
      "250.01",
    );
    expect(passed.result).toBe("passed");
    await expect(activate(window.revisionId, passed.id)).resolves.toMatchObject(
      {
        outcome: "recorded",
      },
    );
  });

  test("computes the ledger balance before the cutoff in PostgreSQL", async () => {
    const accountId = await createAccount();
    const live = await linkSource(accountId, "simplefin");
    const empty = await recordCheck(
      production,
      accountId,
      live.accountSourceId,
      "0.1",
    );
    expect(empty).toMatchObject({ ledgerBalance: "0", difference: "0.1" });

    await postEntry(accountId, "2026-08-31", "123456789012345678901.123456789");
    await postEntry(accountId, "2020-01-01", "-0.000000001");
    await postEntry(accountId, "2026-09-01", "999");
    await postEntry(accountId, "2026-12-01", "5");
    const check = await recordCheck(
      production,
      accountId,
      live.accountSourceId,
      "123456789012345678901.123456789",
    );
    expect(check).toMatchObject({
      ledgerBalance: "123456789012345678901.123456788",
      difference: "0.000000001",
    });

    // Net-worth sign (owner decision 2026-09-25): a card purchase posts a
    // negative account entry, so owed debt compares to a negative provider
    // balance with no per-class flip.
    const card = await createAccount("credit_card");
    const cardSource = await linkSource(card, "simplefin");
    await postEntry(card, "2026-08-10", "-120.4");
    await postEntry(card, "2026-08-20", "20.4");
    expect(
      await recordCheck(production, card, cardSource.accountSourceId, "-100"),
    ).toMatchObject({ ledgerBalance: "-100", difference: "0" });

    // The app role cannot supply either computed column.
    for (const column of ["ledger_balance", "difference"]) {
      await expect(
        connection.database.execute(
          sql.raw(`
            insert into ledger.reconciliation_checks (
              id, account_id, account_source_id, cutoff_on, observation_starts_on,
              observation_ends_on, provider_balance, currency, balance_semantic,
              result, ${column}
            ) values (
              '${randomUUID()}', '${accountId}', '${live.accountSourceId}', '2026-09-01',
              '2026-08-01', '2026-09-02', 1, 'USD', 'unknown', 'not_comparable', 7
            )
          `),
        ),
      ).rejects.toMatchObject(rejectsWith("42501"));
    }
    // Even the owner's supplied values are replaced by the computed ones.
    const forcedId = randomUUID();
    await owner`
      insert into ledger.reconciliation_checks (
        id, account_id, account_source_id, cutoff_on, observation_starts_on,
        observation_ends_on, ledger_balance, provider_balance, currency,
        balance_semantic, difference, result
      ) values (
        ${forcedId}, ${accountId}, ${live.accountSourceId}, '2026-01-01',
        '2025-12-01', '2026-01-02', 42, 1, 'USD', 'unknown', -41, 'not_comparable'
      )
    `;
    const [forced] = await owner`
      select ledger_balance::text as ledger_balance, difference::text as difference
      from ledger.reconciliation_checks where id = ${forcedId}
    `;
    expect(forced).toEqual({
      ledger_balance: "-0.000000001",
      difference: "1.000000001",
    });
  });

  test("rejects a stored result inconsistent with its difference and tolerance", async () => {
    const accountId = await createAccount();
    const live = await linkSource(accountId, "simplefin");
    const insert = (
      result: string,
      tolerance: string | null,
      semantic = "current",
    ) =>
      connection.database.execute(sql`
        insert into ledger.reconciliation_checks (
          id, account_id, account_source_id, cutoff_on, observation_starts_on,
          observation_ends_on, provider_balance, currency, balance_semantic,
          tolerance, result
        ) values (
          ${randomUUID()}, ${accountId}, ${live.accountSourceId}, '2026-09-01',
          '2026-08-01', '2026-09-02', 10, 'USD', ${semantic},
          ${tolerance}::numeric, ${result}
        )
      `);
    for (const [result, tolerance, semantic] of [
      ["passed", null, "current"],
      ["passed", "9.99", "current"],
      ["failed", "10", "current"],
      ["failed", null, "current"],
      ["not_comparable", "100", "current"],
      ["passed", "100", "unknown"],
      ["passed", "-100", "current"],
    ] as const) {
      await expect(insert(result, tolerance, semantic)).rejects.toMatchObject(
        rejectsWith("23514"),
      );
    }
    await expect(insert("passed", "10")).resolves.toBeDefined();
    await expect(insert("failed", "9.99")).resolves.toBeDefined();
    await expect(insert("not_comparable", null)).resolves.toBeDefined();

    const unlinked = await linkSource(await createAccount(), "simplefin");
    await expect(
      recordCheck(production, accountId, unlinked.accountSourceId, "1"),
    ).rejects.toThrow(/currently linked/u);
  });

  test("exact replays are no-ops and conflicting replays fail", async () => {
    const accountId = await createAccount();
    const ynab = await linkSource(accountId, "ynab");
    const live = await linkSource(accountId, "simplefin");
    const command = {
      revisionId: randomUUID(),
      authorityWindowId: randomUUID(),
      accountId,
      accountSourceId: ynab.accountSourceId,
      startsOn: "2020-01-01",
      endsOn: "2026-09-01",
    };
    await expect(production.proposeWindow(command)).resolves.toMatchObject({
      outcome: "recorded",
    });
    await expect(production.proposeWindow(command)).resolves.toMatchObject({
      outcome: "replayed",
    });
    await expect(
      production.proposeWindow({ ...command, endsOn: "2026-10-01" }),
    ).rejects.toBeInstanceOf(TransactionAuthorityConflictError);

    const activation = {
      revisionId: randomUUID(),
      supersedesRevisionId: command.revisionId,
      reconciliationCheckId: null,
    };
    await production.activateWindow(activation);
    await expect(production.activateWindow(activation)).resolves.toMatchObject({
      outcome: "replayed",
    });
    await expect(
      production.revokeWindow({
        revisionId: activation.revisionId,
        supersedesRevisionId: command.revisionId,
        reasonCode: "owner_revoked",
      }),
    ).rejects.toBeInstanceOf(TransactionAuthorityConflictError);

    const checkCommand = {
      checkId: randomUUID(),
      accountId,
      accountSourceId: live.accountSourceId,
      cutoffOn: "2026-09-01",
      observationStartsOn: "2026-08-01",
      observationEndsOn: "2026-09-02",
      providerBalance: "1",
      balanceSemantic: "current",
      rawPayloadId: null,
    };
    await production.recordReconciliationCheck(checkCommand);
    await postEntry(accountId, "2026-01-01", "3");
    // A replay returns the recorded evidence, not a recomputation.
    await expect(
      production.recordReconciliationCheck(checkCommand),
    ).resolves.toMatchObject({
      outcome: "replayed",
      check: { ledgerBalance: "0" },
    });
    await expect(
      production.recordReconciliationCheck({
        ...checkCommand,
        providerBalance: "2",
      }),
    ).rejects.toBeInstanceOf(TransactionAuthorityConflictError);
    const [rows] = await owner`
      select count(*)::int as count from ledger.transaction_authority_revisions
      where authority_window_id = ${command.authorityWindowId}
    `;
    expect(rows!.count).toBe(2);
  });

  test("is append-only with minimal runtime grants", async () => {
    const accountId = await createAccount();
    const live = await linkSource(accountId, "simplefin");
    const check = await recordCheck(
      production,
      accountId,
      live.accountSourceId,
      "1",
    );
    const window = await propose(
      accountId,
      live.accountSourceId,
      "2026-09-01",
      null,
    );

    for (const [table, id] of [
      ["reconciliation_checks", check.id],
      ["transaction_authority_revisions", window.revisionId],
    ] as const) {
      await expect(
        owner.unsafe(
          `update ledger.${table} set recorded_at = now() where id = $1`,
          [id],
        ),
      ).rejects.toMatchObject({ code: "55000" });
      await expect(
        owner.unsafe(`delete from ledger.${table} where id = $1`, [id]),
      ).rejects.toMatchObject({ code: "55000" });
      await expect(
        owner.unsafe(`truncate ledger.${table} cascade`),
      ).rejects.toMatchObject({
        code: "55000",
      });
      for (const statement of [
        `update ledger.${table} set recorded_at = now()`,
        `delete from ledger.${table}`,
        `truncate ledger.${table}`,
      ]) {
        await expect(
          connection.database.execute(sql.raw(statement)),
        ).rejects.toMatchObject(rejectsWith("42501"));
      }
    }

    const [privileges] = await connection.database.execute<
      Record<string, boolean>
    >(sql`
      select
        has_column_privilege(current_user, 'ledger.reconciliation_checks', 'recorded_at', 'INSERT') as check_recorded_at,
        has_column_privilege(current_user, 'ledger.reconciliation_checks', 'ledger_balance', 'INSERT') as check_ledger_balance,
        has_column_privilege(current_user, 'ledger.reconciliation_checks', 'difference', 'INSERT') as check_difference,
        has_column_privilege(current_user, 'ledger.reconciliation_checks', 'provider_balance', 'INSERT') as check_provider_balance,
        has_column_privilege(current_user, 'ledger.transaction_authority_revisions', 'recorded_at', 'INSERT') as revision_recorded_at,
        has_column_privilege(current_user, 'ledger.transaction_authority_revisions', 'status', 'INSERT') as revision_status,
        has_table_privilege(current_user, 'ledger.transaction_authority_revisions', 'UPDATE') as revision_update,
        has_function_privilege(current_user, 'ledger.lock_authority_window(uuid)', 'EXECUTE') as lock_execute,
        coalesce((
          select 'security_invoker=true' = any(coalesce(reloptions, array[]::text[]))
          from pg_class where oid = 'ledger.current_transaction_authority_windows'::regclass
        ), false) as view_security_invoker
    `);
    expect(privileges).toEqual({
      check_recorded_at: false,
      check_ledger_balance: false,
      check_difference: false,
      check_provider_balance: true,
      revision_recorded_at: false,
      revision_status: true,
      revision_update: false,
      lock_execute: false,
      view_security_invoker: true,
    });
  });

  test("never writes a transaction", async () => {
    const [before] = await owner`
      select (select count(*) from ledger.transactions)::int as transactions,
        (select count(*) from ledger.entries)::int as entries
    `;
    const accountId = await createAccount();
    const ynab = await linkSource(accountId, "ynab");
    const window = await propose(
      accountId,
      ynab.accountSourceId,
      "2020-01-01",
      null,
    );
    await activate(window.revisionId);
    await production.evaluate({
      accountId,
      accountSourceId: ynab.accountSourceId,
      occurredOn: "2024-01-01",
    });
    const live = await linkSource(accountId, "simplefin");
    await recordCheck(production, accountId, live.accountSourceId, "1");
    const [after] = await owner`
      select (select count(*) from ledger.transactions)::int as transactions,
        (select count(*) from ledger.entries)::int as entries
    `;
    expect(after).toEqual(before);
  });
});
