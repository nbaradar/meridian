import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, describe, expect, test } from "vitest";

import {
  addDays,
  createBalanceAttentionProvider,
  createInboxService,
  InboxConflictError,
  InboxReferenceError,
  inboxTaskIdSchema,
  type AttentionItem,
  type InboxView,
} from "../../src/core/inbox";
import {
  createBalanceObservationService,
  createLedgerDestinationService,
  utcDate,
  utcTimestampSchema,
  type AccountType,
} from "../../src/core/ledger";
import { createDatabase } from "../../src/infrastructure/database/client";
import { migrationEnvironment } from "../../src/infrastructure/database/environment";
import { createPostgresBalanceObservationStore } from "../../src/infrastructure/database/postgres-balance-observations";
import { createPostgresInboxItemStateStore } from "../../src/infrastructure/database/postgres-inbox-item-states";
import { createPostgresInboxTaskStore } from "../../src/infrastructure/database/postgres-inbox-tasks";
import { createPostgresLedgerDestinationStore } from "../../src/infrastructure/database/postgres-ledger-destinations";

const connection = createDatabase();
const owner = postgres(migrationEnvironment().DATABASE_OWNER_URL, { max: 4 });
const application = postgres(process.env.DATABASE_URL ?? "", { max: 2 });
const now = utcTimestampSchema.parse(new Date().toISOString());
const today = utcDate(now);

const destinations = createLedgerDestinationService(
  createPostgresLedgerDestinationStore(connection.database),
  () => now,
);
const balanceStore = createPostgresBalanceObservationStore(connection.database);
const balances = createBalanceObservationService(balanceStore, () => now);
const tasks = createPostgresInboxTaskStore(connection.database);
const itemStates = createPostgresInboxItemStateStore(connection.database);
const inbox = createInboxService({
  providers: [createBalanceAttentionProvider(balanceStore)],
  taskStore: tasks,
  itemStateStore: itemStates,
  clock: () => now,
});

afterAll(async () => {
  await Promise.all([connection.close(), owner.end(), application.end()]);
});

async function createAccount(accountType: AccountType = "checking") {
  const accountId = randomUUID();
  await destinations.createAccount({
    accountId,
    revisionId: randomUUID(),
    name: `Inbox test ${randomUUID()}`,
    accountType,
    accountClass: null,
    openedOn: null,
  });
  return accountId;
}

async function recordBalance(
  accountId: string,
  enteredAmount: string,
  observedOn: string,
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

/** Closing is not a service command yet; append a closed revision. */
async function closeAccount(accountId: string) {
  await owner`
    insert into ledger.account_revisions (id, account_id, name, status, effective_at)
    select ${randomUUID()}, id, name, 'closed', now()
    from ledger.current_accounts where id = ${accountId}
  `;
}

function activeItems(view: InboxView): AttentionItem[] {
  return view.groups.flatMap((group) =>
    group.entries.flatMap((entry) =>
      entry.type === "item" ? [entry.item] : [],
    ),
  );
}

function itemsFor(view: InboxView, accountId: string) {
  return activeItems(view).filter(
    (item) => item.subject?.accountId === accountId,
  );
}

async function ledgerRowCounts(): Promise<Record<string, string>> {
  const tables = await owner<{ table_name: string }[]>`
    select table_name from information_schema.tables
    where table_schema = 'ledger' and table_type = 'BASE TABLE'
    order by table_name
  `;
  const counts: Record<string, string> = {};
  for (const { table_name: table } of tables) {
    const rows = await owner.unsafe<{ count: string }[]>(
      `select count(*)::text as count from ledger."${table}"`,
    );
    counts[table] = rows[0]?.count ?? "missing";
  }
  return counts;
}

describe("app schema grants", () => {
  test("meridian_app has exactly SELECT, INSERT, UPDATE, DELETE on both tables", async () => {
    const privileges = [
      "SELECT",
      "INSERT",
      "UPDATE",
      "DELETE",
      "TRUNCATE",
      "REFERENCES",
      "TRIGGER",
    ];
    for (const table of ["app.inbox_tasks", "app.inbox_item_states"]) {
      const rows = await owner<{ privilege: string; granted: boolean }[]>`
        select privilege, has_table_privilege('meridian_app', ${table}, privilege) as granted
        from unnest(${privileges}::text[]) as privilege
      `;
      expect(
        rows.filter((row) => row.granted).map((row) => row.privilege),
        table,
      ).toEqual(["SELECT", "INSERT", "UPDATE", "DELETE"]);
    }
    const schema = await owner<{ usage: boolean; create: boolean }[]>`
      select has_schema_privilege('meridian_app', 'app', 'USAGE') as usage,
        has_schema_privilege('meridian_app', 'app', 'CREATE') as create
    `;
    expect(schema[0]).toEqual({ usage: true, create: false });
  });

  test("the ops roles and PUBLIC have no privileges on schema app", async () => {
    const rows = await owner<
      { role: string; usage: boolean; create: boolean; tables: boolean }[]
    >`
      select role,
        has_schema_privilege(role, 'app', 'USAGE') as usage,
        has_schema_privilege(role, 'app', 'CREATE') as create,
        exists (
          select 1 from information_schema.role_table_grants
          where table_schema = 'app' and grantee = role
        ) as tables
      from unnest(array['meridian_ops_control', 'meridian_read_worker']) as role
    `;
    for (const row of rows) {
      expect(row, row.role).toMatchObject({
        usage: false,
        create: false,
        tables: false,
      });
    }
    const publicGrants = await owner<{ grants: string }[]>`
      select (
        (select count(*) from pg_namespace n, aclexplode(n.nspacl) acl
          where n.nspname = 'app' and acl.grantee = 0)
        + (select count(*) from pg_class c
            join pg_namespace n on n.oid = c.relnamespace,
            aclexplode(c.relacl) acl
          where n.nspname = 'app' and acl.grantee = 0)
      )::text as grants
    `;
    expect(publicGrants[0]?.grants).toBe("0");
  });
});

describe("owner tasks", () => {
  test("round trip with every field, then complete, reopen, and delete", async () => {
    const accountId = await createAccount();
    const taskId = randomUUID();
    await inbox.addTask({
      taskId,
      title: " Call the bank ",
      note: "Ask about the fee",
      accountId,
      link: "https://example.com/help",
      dueOn: addDays(today, 3),
    });
    expect(await tasks.findTask(inboxTaskIdSchema.parse(taskId))).toEqual({
      id: taskId,
      title: "Call the bank",
      note: "Ask about the fee",
      accountId,
      link: "https://example.com/help",
      dueOn: addDays(today, 3),
      status: "open",
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    });

    await inbox.editTask({
      taskId,
      title: "Call the bank again",
      note: "",
      accountId: "",
      link: "/setup",
      dueOn: "",
    });
    await inbox.completeTask({ taskId });
    expect(await tasks.findTask(inboxTaskIdSchema.parse(taskId))).toMatchObject(
      {
        title: "Call the bank again",
        note: null,
        accountId: null,
        link: "/setup",
        dueOn: null,
        status: "done",
        completedAt: now,
      },
    );
    await inbox.reopenTask({ taskId });
    expect(await tasks.findTask(inboxTaskIdSchema.parse(taskId))).toMatchObject(
      {
        status: "open",
        completedAt: null,
      },
    );

    await inbox.deleteTask({ taskId });
    expect(await tasks.findTask(inboxTaskIdSchema.parse(taskId))).toBeNull();
    await expect(inbox.deleteTask({ taskId })).rejects.toThrow(
      InboxReferenceError,
    );
    await expect(
      inbox.editTask({
        taskId,
        title: "Gone",
        note: "",
        accountId: "",
        link: "",
        dueOn: "",
      }),
    ).rejects.toThrow(InboxReferenceError);
  });

  test("an unknown account is refused by the foreign key", async () => {
    await expect(
      inbox.addTask({
        taskId: randomUUID(),
        title: "Orphan",
        note: "",
        accountId: randomUUID(),
        link: "",
        dueOn: "",
      }),
    ).rejects.toThrow("The task's account does not exist");
  });

  test("check constraints guard title, note, link, and completion", async () => {
    const insert = (fields: {
      title?: string;
      note?: string | null;
      link?: string | null;
      status?: string;
      completedAt?: string | null;
    }) =>
      application`
        insert into app.inbox_tasks (
          id, title, note, link, status, created_at, updated_at, completed_at
        ) values (
          ${randomUUID()}, ${fields.title ?? "Task"}, ${fields.note ?? null},
          ${fields.link ?? null}, ${fields.status ?? "open"}, ${now}, ${now},
          ${fields.completedAt ?? null}
        )
      `;
    const violations: [string, Parameters<typeof insert>[0]][] = [
      ["inbox_tasks_title_check", { title: "" }],
      ["inbox_tasks_title_check", { title: " padded " }],
      ["inbox_tasks_title_check", { title: "x".repeat(201) }],
      ["inbox_tasks_note_check", { note: "x".repeat(2001) }],
      ["inbox_tasks_link_check", { link: "javascript:alert(1)" }],
      ["inbox_tasks_link_check", { link: "//evil.example" }],
      ["inbox_tasks_link_check", { link: "/\\evil.example" }],
      ["inbox_tasks_link_check", { link: "/a b" }],
      ["inbox_tasks_link_check", { link: "ftp://x" }],
      ["inbox_tasks_link_check", { link: "inbox" }],
      ["inbox_tasks_status_check", { status: "archived" }],
      ["inbox_tasks_completed_check", { status: "done" }],
      ["inbox_tasks_completed_check", { completedAt: now }],
    ];
    for (const [constraint, fields] of violations) {
      await expect(insert(fields), constraint).rejects.toMatchObject({
        code: "23514",
        constraint_name: constraint,
      });
    }
    await expect(
      insert({ link: "https://example.com/x" }),
    ).resolves.toBeDefined();
    await expect(insert({ link: "/inbox" })).resolves.toBeDefined();
  });
});

describe("item states", () => {
  test("snooze columns are checked", async () => {
    const insert = (state: string, snoozedUntil: string | null) =>
      application`
        insert into app.inbox_item_states (item_key, item_version, state, snoozed_until, recorded_at)
        values (${`test:check:${randomUUID()}`}, 'v1', ${state}, ${snoozedUntil}, ${now})
      `;
    await expect(insert("snoozed", null)).rejects.toMatchObject({
      constraint_name: "inbox_item_states_snooze_check",
    });
    await expect(insert("dismissed", today)).rejects.toMatchObject({
      constraint_name: "inbox_item_states_snooze_check",
    });
    await expect(insert("hidden", null)).rejects.toMatchObject({
      constraint_name: "inbox_item_states_state_check",
    });
  });

  test("a new action replaces the row and restore deletes it", async () => {
    const itemKey = `test:replace:${randomUUID()}`;
    await itemStates.putItemState({
      itemKey,
      itemVersion: "v1",
      state: "snoozed",
      snoozedUntil: addDays(today, 7),
      recordedAt: now,
    });
    await itemStates.putItemState({
      itemKey,
      itemVersion: "v2",
      state: "dismissed",
      snoozedUntil: null,
      recordedAt: now,
    });
    const stored = (await itemStates.listItemStates()).filter(
      (state) => state.itemKey === itemKey,
    );
    expect(stored).toEqual([
      {
        itemKey,
        itemVersion: "v2",
        state: "dismissed",
        snoozedUntil: null,
        recordedAt: now,
      },
    ]);
    await itemStates.deleteItemState(itemKey);
    expect(
      (await itemStates.listItemStates()).some(
        (state) => state.itemKey === itemKey,
      ),
    ).toBe(false);
  });
});

describe("the Inbox over real balances", () => {
  test("raises each balance kind, clears it when fixed, and never writes the ledger", async () => {
    const missing = await createAccount();
    const stale = await createAccount("savings");
    const fresh = await createAccount();
    const closed = await createAccount("credit_card");
    await recordBalance(stale, "100", addDays(today, -31));
    await recordBalance(fresh, "100", addDays(today, -30));
    await recordBalance(closed, "25", addDays(today, -5));
    await closeAccount(closed);

    const before = await ledgerRowCounts();
    const view = await inbox.view();
    expect(itemsFor(view, missing).map((item) => item.kind)).toEqual([
      "no_balance",
    ]);
    expect(itemsFor(view, stale).map((item) => item.kind)).toEqual([
      "stale_balance",
    ]);
    expect(itemsFor(view, fresh)).toEqual([]);
    const [closedItem] = itemsFor(view, closed);
    expect(closedItem).toMatchObject({
      kind: "closed_with_balance",
      severity: "review",
      href: `/#account-${closed}`,
    });
    expect(view.groups[0]?.severity).toBe("review");

    // Every action, then the ledger is untouched.
    const staleItem = itemsFor(view, stale)[0]!;
    const missingItem = itemsFor(view, missing)[0]!;
    await inbox.snooze({
      itemKey: staleItem.key,
      itemVersion: staleItem.version,
      choice: "month",
      until: "",
    });
    await inbox.dismiss({
      itemKey: missingItem.key,
      itemVersion: missingItem.version,
    });
    await expect(
      inbox.dismiss({
        itemKey: closedItem!.key,
        itemVersion: closedItem!.version,
      }),
    ).rejects.toThrow(InboxConflictError);
    const hidden = await inbox.view();
    expect(hidden.snoozed.map((entry) => entry.item.key)).toContain(
      staleItem.key,
    );
    expect(hidden.dismissed.map((item) => item.key)).toContain(missingItem.key);
    expect(hidden.count).toBe(view.count - 2);
    const taskId = randomUUID();
    await inbox.addTask({
      taskId,
      title: "Ledger-neutral",
      note: "",
      accountId: stale,
      link: "",
      dueOn: "",
    });
    await inbox.completeTask({ taskId });
    await inbox.deleteTask({ taskId });
    await inbox.restore({ itemKey: missingItem.key });
    expect(await ledgerRowCounts()).toEqual(before);

    // Recording a new balance changes the evidence: the stale item is gone.
    await recordBalance(stale, "120", today);
    const fixed = await inbox.view();
    expect(itemsFor(fixed, stale)).toEqual([]);
    expect(fixed.snoozed.map((entry) => entry.item.key)).not.toContain(
      staleItem.key,
    );
    expect(itemsFor(fixed, missing).map((item) => item.kind)).toEqual([
      "no_balance",
    ]);
  });
});
