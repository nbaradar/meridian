import { randomUUID } from "node:crypto";

import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { ZodError } from "zod";

import {
  addOneMonth,
  applyItemStates,
  balanceAttentionItems,
  buildInboxView,
  collectAttentionItems,
  compareInboxEntries,
  createBalanceAttentionProvider,
  createInboxService,
  InboxConflictError,
  InboxReferenceError,
  InboxValidationError,
  inboxCount,
  inboxTaskIdSchema,
  isTaskOverdue,
  itemEntry,
  snoozeUntil,
  taskEntry,
  taskLinkSchema,
  taskTitleSchema,
  type AttentionItem,
  type AttentionProvider,
  type InboxItemState,
  type InboxItemStateStore,
  type InboxTaskStore,
  type OwnerTask,
} from "../src/core/inbox";
import {
  accountIdSchema,
  balanceObservationIdSchema,
  calendarDateSchema,
  decimalAmountSchema,
  utcTimestampSchema,
  type AccountType,
  type BalanceObservationStore,
  type CalendarDate,
  type CurrentAccount,
  type CurrentBalance,
  type UtcTimestamp,
} from "../src/core/ledger";

const date = (value: string) => calendarDateSchema.parse(value);
const timestamp = (value: string) => utcTimestampSchema.parse(value);
const today = date("2026-09-27");
const now = timestamp("2026-09-27T15:00:00.000Z");

function account(
  name: string,
  status: CurrentAccount["status"] = "active",
  accountType: AccountType = "checking",
): CurrentAccount {
  return {
    id: accountIdSchema.parse(randomUUID()),
    name,
    accountType,
    accountClass: accountType === "credit_card" ? "liability" : "asset",
    currency: "USD",
    openedOn: null,
    status,
  };
}

function balance(
  of: CurrentAccount,
  value: string,
  observedOn: string,
): CurrentBalance {
  return {
    observationId: balanceObservationIdSchema.parse(randomUUID()),
    accountId: of.id,
    observedOn: date(observedOn),
    amount: decimalAmountSchema.parse(value),
    currency: "USD",
    source: "manual",
    recordedAt: now,
  };
}

function item(overrides: Partial<AttentionItem> & { key: string }) {
  return {
    version: "v1",
    kind: "test_kind",
    severity: "action",
    title: overrides.key,
    href: "/",
    since: null,
    ...overrides,
  } satisfies AttentionItem;
}

function task(overrides: Partial<OwnerTask> = {}): OwnerTask {
  return {
    id: inboxTaskIdSchema.parse(randomUUID()),
    title: "A task",
    note: null,
    accountId: null,
    link: null,
    dueOn: null,
    status: "open",
    createdAt: timestamp("2026-09-01T00:00:00.000Z"),
    updatedAt: timestamp("2026-09-01T00:00:00.000Z"),
    completedAt: null,
    ...overrides,
  };
}

describe("balance attention items", () => {
  test("an active account without a balance needs one", () => {
    const checking = account("Everyday Checking");
    const items = balanceAttentionItems([checking], [], today);
    expect(items).toEqual([
      {
        key: `balances:no_balance:${checking.id}`,
        version: "none",
        kind: "no_balance",
        severity: "action",
        title: "Record a balance for Everyday Checking",
        subject: { accountId: checking.id },
        href: `/#account-${checking.id}`,
        since: null,
      },
    ]);
  });

  test("a balance is stale only when older than 30 days", () => {
    const checking = account("Checking");
    const kinds = (observedOn: string) =>
      balanceAttentionItems(
        [checking],
        [balance(checking, "10", observedOn)],
        today,
      ).map((entry) => entry.kind);
    expect(kinds("2026-08-29")).toEqual([]); // 29 days
    expect(kinds("2026-08-28")).toEqual([]); // 30 days
    expect(kinds("2026-08-27")).toEqual(["stale_balance"]); // 31 days
    expect(kinds("2026-09-28")).toEqual([]); // future-dated
  });

  test("a stale item is versioned by its observation and began on day 31", () => {
    const savings = account("Savings", "active", "savings");
    const current = balance(savings, "1234.56", "2026-08-01");
    const [stale] = balanceAttentionItems([savings], [current], today);
    expect(stale).toEqual({
      key: `balances:stale_balance:${savings.id}`,
      version: current.observationId,
      kind: "stale_balance",
      severity: "action",
      title: "Update the balance for Savings, last recorded 2026-08-01",
      subject: { accountId: savings.id, observationId: current.observationId },
      href: `/#account-${savings.id}`,
      since: "2026-09-01T00:00:00.000Z",
    });
    expect(stale?.title).not.toContain("1234");
  });

  test("closed accounts only ever raise closed_with_balance", () => {
    const closedNonzero = account("Old card", "closed", "credit_card");
    const closedZero = account("Old savings", "closed", "savings");
    const closedEmpty = account("Old cash", "closed", "cash");
    const owed = balance(closedNonzero, "-45.1", "2025-01-01");
    const items = balanceAttentionItems(
      [closedNonzero, closedZero, closedEmpty],
      [owed, balance(closedZero, "0", "2025-01-01")],
      today,
    );
    expect(items).toEqual([
      {
        key: `balances:closed_with_balance:${closedNonzero.id}`,
        version: owed.observationId,
        kind: "closed_with_balance",
        severity: "review",
        title: "Closed account Old card still shows a balance",
        subject: {
          accountId: closedNonzero.id,
          observationId: owed.observationId,
        },
        href: `/#account-${closedNonzero.id}`,
        since: null,
      },
    ]);
    expect(items[0]?.title).not.toContain("45");
  });

  test("the provider only reads accounts and current balances", async () => {
    const checking = account("Checking");
    const reads: string[] = [];
    const store: Pick<
      BalanceObservationStore,
      "listAccounts" | "listCurrentBalances"
    > = {
      listAccounts: async () => {
        reads.push("accounts");
        return [checking];
      },
      listCurrentBalances: async () => {
        reads.push("balances");
        return [];
      },
    };
    const provider = createBalanceAttentionProvider(store);
    const items = await provider.items({ now, today });
    expect(provider.id).toBe("balances");
    expect(items.map((entry) => entry.kind)).toEqual(["no_balance"]);
    expect(reads.sort()).toEqual(["accounts", "balances"]);
  });
});

describe("ordering", () => {
  const entries = () => [
    itemEntry(item({ key: "p:info", severity: "info" })),
    itemEntry(item({ key: "p:action-nosince", title: "A" })),
    itemEntry(
      item({
        key: "p:action-old",
        since: timestamp("2026-01-01T00:00:00.000Z"),
        title: "Z",
      }),
    ),
    itemEntry(
      item({
        key: "p:action-new",
        since: timestamp("2026-06-01T00:00:00.000Z"),
        title: "A",
      }),
    ),
    itemEntry(item({ key: "p:review", severity: "review" })),
    itemEntry(item({ key: "p:decision", severity: "decision" })),
    taskEntry(
      task({
        id: inboxTaskIdSchema.parse("00000000-0000-4000-8000-000000000001"),
        title: "Overdue",
        dueOn: date("2026-09-26"),
        createdAt: timestamp("2026-09-20T00:00:00.000Z"),
      }),
      today,
    ),
    taskEntry(
      task({
        id: inboxTaskIdSchema.parse("00000000-0000-4000-8000-000000000002"),
        title: "Due today",
        dueOn: today,
        createdAt: timestamp("2026-03-01T00:00:00.000Z"),
      }),
      today,
    ),
    itemEntry(item({ key: "p:tie-b", title: "Same" })),
    itemEntry(item({ key: "p:tie-a", title: "Same" })),
  ];

  const expected = [
    "p:review",
    "p:decision",
    "task:00000000-0000-4000-8000-000000000001",
    "p:action-old",
    "task:00000000-0000-4000-8000-000000000002",
    "p:action-new",
    "p:action-nosince",
    "p:tie-a",
    "p:tie-b",
    "p:info",
  ];

  test("severity, overdue tasks, oldest since, missing since last, title, key", () => {
    expect(
      entries()
        .sort(compareInboxEntries)
        .map((entry) => entry.key),
    ).toEqual(expected);
  });

  test("input order never changes the output", () => {
    fc.assert(
      fc.property(fc.shuffledSubarray(entries(), { minLength: 10 }), (list) => {
        expect(
          [...list].sort(compareInboxEntries).map((entry) => entry.key),
        ).toEqual(expected);
      }),
    );
  });
});

describe("item states", () => {
  const stale = item({ key: "balances:stale_balance:a", version: "obs-1" });
  const review = item({
    key: "balances:closed_with_balance:b",
    version: "obs-2",
    severity: "review",
  });
  const snoozed = (
    of: AttentionItem,
    until: string,
    version = of.version,
  ): InboxItemState => ({
    itemKey: of.key,
    itemVersion: version,
    state: "snoozed",
    snoozedUntil: date(until),
    recordedAt: now,
  });
  const dismissed = (
    of: AttentionItem,
    version = of.version,
  ): InboxItemState => ({
    itemKey: of.key,
    itemVersion: version,
    state: "dismissed",
    snoozedUntil: null,
    recordedAt: now,
  });

  test("a snooze hides the item until its date and returns on it", () => {
    const states = [snoozed(stale, "2026-09-28")];
    expect(applyItemStates([stale], states, today).snoozed).toEqual([
      { item: stale, snoozedUntil: "2026-09-28" },
    ]);
    expect(applyItemStates([stale], states, date("2026-09-28")).active).toEqual(
      [stale],
    );
  });

  test("a version change reactivates snoozed and dismissed items", () => {
    const partitioned = applyItemStates(
      [stale, review],
      [snoozed(stale, "2027-01-01", "obs-0"), dismissed(review, "obs-0")],
      today,
    );
    expect(partitioned.active).toEqual([stale, review]);
    expect(partitioned.snoozed).toEqual([]);
    expect(partitioned.dismissed).toEqual([]);
  });

  test("a matching dismissal hides the item; states for gone items are ignored", () => {
    const partitioned = applyItemStates(
      [stale],
      [dismissed(stale), dismissed(item({ key: "p:gone" }))],
      today,
    );
    expect(partitioned).toEqual({
      active: [],
      snoozed: [],
      dismissed: [stale],
    });
  });
});

describe("snooze dates", () => {
  test("fixed choices count from today", () => {
    expect(snoozeUntil("day", null, today)).toBe("2026-09-28");
    expect(snoozeUntil("week", null, today)).toBe("2026-10-04");
    expect(snoozeUntil("month", null, today)).toBe("2026-10-27");
    expect(snoozeUntil("day", null, date("2026-12-31"))).toBe("2027-01-01");
  });

  test("one month clamps to the end of a shorter month", () => {
    expect(addOneMonth(date("2026-01-31"))).toBe("2026-02-28");
    expect(addOneMonth(date("2028-01-31"))).toBe("2028-02-29");
    expect(addOneMonth(date("2026-03-31"))).toBe("2026-04-30");
    expect(addOneMonth(date("2026-12-31"))).toBe("2027-01-31");
    expect(addOneMonth(date("2026-02-28"))).toBe("2026-03-28");
  });

  test("a chosen date must be after today and within 365 days", () => {
    expect(() => snoozeUntil("date", today, today)).toThrow(
      InboxValidationError,
    );
    expect(() => snoozeUntil("date", null, today)).toThrow(
      InboxValidationError,
    );
    expect(snoozeUntil("date", date("2026-09-28"), today)).toBe("2026-09-28");
    expect(snoozeUntil("date", date("2027-09-27"), today)).toBe("2027-09-27");
    expect(() => snoozeUntil("date", date("2027-09-28"), today)).toThrow(
      InboxValidationError,
    );
  });
});

describe("tasks", () => {
  test("titles are trimmed and 1 to 200 characters", () => {
    expect(taskTitleSchema.parse("  Call the bank  ")).toBe("Call the bank");
    expect(() => taskTitleSchema.parse("   ")).toThrow(ZodError);
    expect(taskTitleSchema.parse("x".repeat(200))).toHaveLength(200);
    expect(() => taskTitleSchema.parse("x".repeat(201))).toThrow(ZodError);
  });

  test("links are in-app paths or http(s) URLs only", () => {
    for (const link of [
      "/inbox",
      "/",
      "/#account-1",
      "https://example.com/x",
      "http://example.com",
      "HTTPS://example.com/x",
    ]) {
      expect(taskLinkSchema.parse(link), link).toBe(link);
    }
    for (const link of [
      "javascript:alert(1)",
      "//evil.example",
      "/\\evil.example",
      "/\t/evil.example",
      "ftp://x",
      "inbox",
      "https://",
      "https:///x",
      "data:text/html,hi",
      `/${"x".repeat(2048)}`,
    ]) {
      expect(() => taskLinkSchema.parse(link), link).toThrow(ZodError);
    }
  });

  test("a task is overdue only after its due date", () => {
    expect(isTaskOverdue(task({ dueOn: date("2026-09-26") }), today)).toBe(
      true,
    );
    expect(isTaskOverdue(task({ dueOn: today }), today)).toBe(false);
    expect(isTaskOverdue(task({ dueOn: null }), today)).toBe(false);
    expect(
      isTaskOverdue(
        task({
          dueOn: date("2026-01-01"),
          status: "done",
          completedAt: now,
        }),
        today,
      ),
    ).toBe(false);
  });
});

describe("count", () => {
  test("counts active review, decision, and action items plus open tasks", () => {
    const active = [
      item({ key: "p:r", severity: "review" }),
      item({ key: "p:d", severity: "decision" }),
      item({ key: "p:a", severity: "action" }),
      item({ key: "p:i", severity: "info" }),
    ];
    const tasks = [
      task(),
      task({ status: "done", completedAt: now, updatedAt: now }),
    ];
    expect(inboxCount(active, tasks)).toBe(4);
  });

  test("excludes snoozed and dismissed items", () => {
    const hidden = item({ key: "p:hidden" });
    const partitioned = applyItemStates(
      [hidden, item({ key: "p:shown" })],
      [
        {
          itemKey: hidden.key,
          itemVersion: hidden.version,
          state: "dismissed",
          snoozedUntil: null,
          recordedAt: now,
        },
      ],
      today,
    );
    expect(buildInboxView(partitioned, [], today).count).toBe(1);
  });
});

describe("provider failure", () => {
  const working: AttentionProvider = {
    id: "working",
    items: async () => [item({ key: "working:kind:1" })],
  };
  const throwing: AttentionProvider = {
    id: "throwing",
    items: async () => {
      throw new Error("database unavailable");
    },
  };

  test("a throwing provider yields one info item and others still return", async () => {
    const reported: string[] = [];
    const items = await collectAttentionItems(
      [throwing, working],
      { now, today },
      (providerId, error) => reported.push(`${providerId}: ${error.message}`),
    );
    expect(items.map((entry) => [entry.key, entry.severity])).toEqual([
      ["inbox:provider_failed:throwing", "info"],
      ["working:kind:1", "action"],
    ]);
    expect(reported).toEqual(["throwing: database unavailable"]);
  });

  test("malformed items, foreign keys, and duplicates fail only that provider", async () => {
    const providers: AttentionProvider[] = [
      {
        id: "foreign",
        items: async () => [item({ key: "working:kind:2" })],
      },
      {
        id: "duplicate",
        items: async () => [
          item({ key: "duplicate:a:1" }),
          item({ key: "duplicate:a:1" }),
        ],
      },
      {
        id: "malformed",
        items: async () =>
          [
            { ...item({ key: "malformed:a:1" }), severity: "urgent" },
          ] as unknown as AttentionItem[],
      },
      working,
    ];
    const items = await collectAttentionItems(
      providers,
      { now, today },
      () => undefined,
    );
    expect(items.map((entry) => entry.key)).toEqual([
      "inbox:provider_failed:foreign",
      "inbox:provider_failed:duplicate",
      "inbox:provider_failed:malformed",
      "working:kind:1",
    ]);
  });
});

function memoryStores() {
  const tasks = new Map<string, OwnerTask>();
  const states = new Map<string, InboxItemState>();
  const taskStore: InboxTaskStore = {
    listTasks: async () => [...tasks.values()],
    findTask: async (id) => tasks.get(id) ?? null,
    insertTask: async (value) => {
      tasks.set(value.id, value);
    },
    updateTask: async (value) => {
      if (!tasks.has(value.id)) {
        throw new InboxReferenceError("The task does not exist", {});
      }
      tasks.set(value.id, value);
    },
    deleteTask: async (id) => {
      if (!tasks.delete(id)) {
        throw new InboxReferenceError("The task does not exist", {});
      }
    },
  };
  const itemStateStore: InboxItemStateStore = {
    listItemStates: async () => [...states.values()],
    putItemState: async (value) => {
      states.set(value.itemKey, value);
    },
    deleteItemState: async (key) => {
      states.delete(key);
    },
  };
  return { tasks, states, taskStore, itemStateStore };
}

describe("inbox service", () => {
  const stale = item({ key: "fixed:stale:a", version: "obs-1" });
  const review = item({
    key: "fixed:closed:b",
    version: "obs-2",
    severity: "review",
  });

  function service(
    clock: () => UtcTimestamp = () => now,
    providers: AttentionProvider[] = [
      { id: "fixed", items: async () => [stale, review] },
      {
        id: "broken",
        items: async () => {
          throw new Error("boom");
        },
      },
    ],
  ) {
    const stores = memoryStores();
    return {
      ...stores,
      inbox: createInboxService({
        providers,
        taskStore: stores.taskStore,
        itemStateStore: stores.itemStateStore,
        clock,
        reportProviderFailure: () => undefined,
      }),
    };
  }

  test("snooze, dismiss, and restore move items between groups", async () => {
    const { inbox } = service();
    expect(await inbox.count()).toBe(2);
    await expect(
      inbox.snooze({
        itemKey: review.key,
        itemVersion: review.version,
        choice: "week",
        until: "",
      }),
    ).resolves.toBe("2026-10-04");
    await inbox.dismiss({ itemKey: stale.key, itemVersion: stale.version });
    const view = await inbox.view();
    expect(view.count).toBe(0);
    expect(view.snoozed.map((entry) => entry.item.key)).toEqual([review.key]);
    expect(view.dismissed.map((entry) => entry.key)).toEqual([stale.key]);
    expect(view.groups.map((group) => group.severity)).toEqual(["info"]);

    await inbox.restore({ itemKey: review.key });
    await inbox.restore({ itemKey: stale.key });
    expect(await inbox.count()).toBe(2);
  });

  test("a chosen snooze date is validated", async () => {
    const { inbox } = service();
    const snooze = (until: string) =>
      inbox.snooze({
        itemKey: stale.key,
        itemVersion: stale.version,
        choice: "date",
        until,
      });
    await expect(snooze("2026-09-27")).rejects.toThrow(InboxValidationError);
    await expect(snooze("")).rejects.toThrow(InboxValidationError);
    await expect(snooze("2026-10-15")).resolves.toBe("2026-10-15");
  });

  test("dismiss is refused for review items", async () => {
    const { inbox, states } = service();
    await expect(
      inbox.dismiss({ itemKey: review.key, itemVersion: review.version }),
    ).rejects.toThrow(InboxConflictError);
    expect(states.size).toBe(0);
  });

  test("dismiss is refused for decision items", async () => {
    const decision = item({ key: "fixed:d:1", severity: "decision" });
    const { inbox } = service(undefined, [
      { id: "fixed", items: async () => [decision] },
    ]);
    await expect(
      inbox.dismiss({ itemKey: decision.key, itemVersion: decision.version }),
    ).rejects.toThrow(InboxConflictError);
  });

  test("provider-failure items cannot be snoozed or dismissed", async () => {
    const { inbox, states } = service();
    const failure = {
      itemKey: "inbox:provider_failed:broken",
      itemVersion: "failed",
    };
    await expect(inbox.dismiss(failure)).rejects.toThrow(InboxConflictError);
    await expect(
      inbox.snooze({ ...failure, choice: "day", until: "" }),
    ).rejects.toThrow(InboxConflictError);
    expect(states.size).toBe(0);
  });

  test("a stale key or version is refused with a reload message", async () => {
    const { inbox } = service();
    await expect(
      inbox.dismiss({ itemKey: stale.key, itemVersion: "obs-0" }),
    ).rejects.toThrow("This item changed; reload the Inbox");
    await expect(
      inbox.snooze({
        itemKey: "fixed:gone:1",
        itemVersion: "v1",
        choice: "day",
        until: "",
      }),
    ).rejects.toThrow(InboxConflictError);
  });

  test("tasks can be added, edited, completed, reopened, and deleted", async () => {
    let clock = now;
    const { inbox, tasks } = service(() => clock);
    const taskId = randomUUID();
    const accountId = randomUUID();
    const added = await inbox.addTask({
      taskId,
      title: "  Call the bank ",
      note: "  about fees ",
      accountId,
      link: "https://example.com/help",
      dueOn: "2026-10-01",
    });
    expect(added).toMatchObject({
      title: "Call the bank",
      note: "about fees",
      accountId,
      status: "open",
      createdAt: now,
      completedAt: null,
    });
    expect(await inbox.count()).toBe(3);

    clock = timestamp("2026-09-27T16:00:00.000Z");
    await inbox.editTask({
      taskId,
      title: "Call the bank",
      note: "",
      accountId: "",
      link: "/setup",
      dueOn: "",
    });
    expect(tasks.get(taskId)).toMatchObject({
      note: null,
      accountId: null,
      link: "/setup",
      dueOn: null,
      createdAt: now,
      updatedAt: clock,
    });

    await inbox.completeTask({ taskId });
    expect(tasks.get(taskId)).toMatchObject({
      status: "done",
      completedAt: clock,
    });
    const view = await inbox.view();
    expect(view.done.map((entry) => entry.id)).toEqual([taskId]);
    expect(view.count).toBe(2);

    await inbox.reopenTask({ taskId });
    expect(tasks.get(taskId)).toMatchObject({
      status: "open",
      completedAt: null,
    });

    await inbox.deleteTask({ taskId });
    expect(tasks.size).toBe(0);
    await expect(inbox.deleteTask({ taskId })).rejects.toThrow(
      InboxReferenceError,
    );
    await expect(inbox.completeTask({ taskId })).rejects.toThrow(
      InboxReferenceError,
    );
  });

  test("invalid titles and links are rejected with clear messages", async () => {
    const { inbox, tasks } = service();
    const add = (fields: Record<string, string>) =>
      inbox.addTask({
        taskId: randomUUID(),
        title: "Task",
        note: "",
        accountId: "",
        link: "",
        dueOn: "",
        ...fields,
      });
    await expect(add({ title: " " })).rejects.toThrow("Enter a title");
    await expect(add({ link: "javascript:alert(1)" })).rejects.toThrow(
      "A link must be an in-app path",
    );
    expect(tasks.size).toBe(0);
  });

  test("done tasks list newest completed first", () => {
    const early = task({
      status: "done",
      completedAt: timestamp("2026-09-01T00:00:00.000Z"),
    });
    const late = task({
      status: "done",
      completedAt: timestamp("2026-09-20T00:00:00.000Z"),
    });
    const view = buildInboxView(
      { active: [], snoozed: [], dismissed: [] },
      [early, late],
      today as CalendarDate,
    );
    expect(view.done.map((entry) => entry.id)).toEqual([late.id, early.id]);
  });
});
