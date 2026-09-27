import {
  utcDate,
  utcTimestampSchema,
  type CalendarDate,
  type UtcTimestamp,
} from "../ledger";
import {
  attentionItemSchema,
  attentionProviderIdSchema,
  canDismiss,
  canSnooze,
  providerFailureItem,
  type AttentionContext,
  type AttentionItem,
  type AttentionProvider,
} from "./attention";
import { InboxConflictError, InboxReferenceError } from "./errors";
import {
  applyItemStates,
  dismissCommandSchema,
  restoreCommandSchema,
  snoozeCommandSchema,
  snoozeUntil,
  type InboxItemStateStore,
} from "./item-states";
import {
  addTaskCommandSchema,
  editTaskCommandSchema,
  taskReferenceCommandSchema,
  type InboxTaskId,
  type InboxTaskStore,
  type OwnerTask,
} from "./tasks";
import { buildInboxView, inboxCount, type InboxView } from "./view";

/**
 * Called once per failed provider. It receives the provider id and the error's
 * name and message only, never the provider's data.
 */
export type ProviderFailureReporter = (
  providerId: string,
  error: { name: string; message: string },
) => void;

const defaultFailureReporter: ProviderFailureReporter = (providerId, error) => {
  console.error(
    `Inbox provider "${providerId}" failed: ${error.name}: ${error.message}`,
  );
};

export interface InboxServiceDependencies {
  /** Composed by the app layer until Plan 0006 builds the module registry. */
  providers: readonly AttentionProvider[];
  taskStore: InboxTaskStore;
  itemStateStore: InboxItemStateStore;
  clock: () => UtcTimestamp;
  reportProviderFailure?: ProviderFailureReporter;
}

/** Validates a provider's output; anything malformed fails the provider. */
function checkedItems(
  provider: AttentionProvider,
  items: readonly unknown[],
): AttentionItem[] {
  const keys = new Set<string>();
  return items.map((input) => {
    const item = attentionItemSchema.parse(input);
    if (!item.key.startsWith(`${provider.id}:`)) {
      throw new Error(`Item key does not start with "${provider.id}:"`);
    }
    if (keys.has(item.key)) {
      throw new Error("Provider returned a duplicate item key");
    }
    keys.add(item.key);
    return item;
  });
}

/**
 * Runs every provider, isolating failures: a provider that throws or returns
 * malformed items yields one `info` item and the others still count.
 */
export async function collectAttentionItems(
  providers: readonly AttentionProvider[],
  context: AttentionContext,
  reportFailure: ProviderFailureReporter = defaultFailureReporter,
): Promise<AttentionItem[]> {
  const ids = new Set<string>();
  for (const provider of providers) {
    attentionProviderIdSchema.parse(provider.id);
    if (ids.has(provider.id)) {
      throw new Error(`Duplicate Inbox provider id "${provider.id}"`);
    }
    ids.add(provider.id);
  }
  const results = await Promise.all(
    providers.map(async (provider) => {
      try {
        return checkedItems(provider, await provider.items(context));
      } catch (error) {
        reportFailure(
          provider.id,
          error instanceof Error
            ? { name: error.name, message: error.message }
            : { name: "UnknownError", message: "non-Error thrown" },
        );
        return [providerFailureItem(provider.id)];
      }
    }),
  );
  return results.flat();
}

/**
 * RFC 0009 Inbox v1. It reads providers, owner tasks, and item states, and
 * writes only `app.*` through its two stores; it never decides or acts on
 * money.
 */
export function createInboxService({
  providers,
  taskStore,
  itemStateStore,
  clock,
  reportProviderFailure = defaultFailureReporter,
}: InboxServiceDependencies) {
  function now(): { now: UtcTimestamp; today: CalendarDate } {
    const timestamp = utcTimestampSchema.parse(clock());
    return { now: timestamp, today: utcDate(timestamp) };
  }

  async function currentItems(context: AttentionContext) {
    return collectAttentionItems(providers, context, reportProviderFailure);
  }

  async function snapshot() {
    const context = now();
    const [items, states, tasks] = await Promise.all([
      currentItems(context),
      itemStateStore.listItemStates(),
      taskStore.listTasks(),
    ]);
    return {
      today: context.today,
      partitioned: applyItemStates(items, states, context.today),
      tasks,
    };
  }

  /** The item as computed now, if it still has the submitted version. */
  async function requireCurrentItem(
    itemKey: string,
    itemVersion: string,
    context: AttentionContext,
  ): Promise<AttentionItem> {
    const item = (await currentItems(context)).find(
      (candidate) => candidate.key === itemKey,
    );
    if (!item || item.version !== itemVersion) {
      throw new InboxConflictError("This item changed; reload the Inbox", {
        itemKey,
      });
    }
    return item;
  }

  async function requireTask(taskId: InboxTaskId): Promise<OwnerTask> {
    const task = await taskStore.findTask(taskId);
    if (!task) {
      throw new InboxReferenceError("The task does not exist", { taskId });
    }
    return task;
  }

  return {
    async view(): Promise<InboxView> {
      const { today, partitioned, tasks } = await snapshot();
      return buildInboxView(partitioned, tasks, today);
    },

    async count(): Promise<number> {
      const { partitioned, tasks } = await snapshot();
      return inboxCount(partitioned.active, tasks);
    },

    async snooze(input: unknown): Promise<CalendarDate> {
      const command = snoozeCommandSchema.parse(input);
      const context = now();
      const until = snoozeUntil(command.choice, command.until, context.today);
      const item = await requireCurrentItem(
        command.itemKey,
        command.itemVersion,
        context,
      );
      if (!canSnooze(item)) {
        throw new InboxConflictError("This item cannot be snoozed", {
          itemKey: item.key,
        });
      }
      await itemStateStore.putItemState({
        itemKey: item.key,
        itemVersion: item.version,
        state: "snoozed",
        snoozedUntil: until,
        recordedAt: context.now,
      });
      return until;
    },

    async dismiss(input: unknown): Promise<void> {
      const command = dismissCommandSchema.parse(input);
      const context = now();
      const item = await requireCurrentItem(
        command.itemKey,
        command.itemVersion,
        context,
      );
      if (!canDismiss(item)) {
        throw new InboxConflictError(
          "This item cannot be dismissed; resolve it or snooze it",
          { itemKey: item.key },
        );
      }
      await itemStateStore.putItemState({
        itemKey: item.key,
        itemVersion: item.version,
        state: "dismissed",
        snoozedUntil: null,
        recordedAt: context.now,
      });
    },

    /** Returns a snoozed or dismissed item to its active group. */
    async restore(input: unknown): Promise<void> {
      const command = restoreCommandSchema.parse(input);
      await itemStateStore.deleteItemState(command.itemKey);
    },

    async addTask(input: unknown): Promise<OwnerTask> {
      const command = addTaskCommandSchema.parse(input);
      const timestamp = now().now;
      const task: OwnerTask = {
        id: command.taskId,
        title: command.title,
        note: command.note,
        accountId: command.accountId,
        link: command.link,
        dueOn: command.dueOn,
        status: "open",
        createdAt: timestamp,
        updatedAt: timestamp,
        completedAt: null,
      };
      await taskStore.insertTask(task);
      return task;
    },

    async editTask(input: unknown): Promise<OwnerTask> {
      const command = editTaskCommandSchema.parse(input);
      const task = await requireTask(command.taskId);
      const edited: OwnerTask = {
        ...task,
        title: command.title,
        note: command.note,
        accountId: command.accountId,
        link: command.link,
        dueOn: command.dueOn,
        updatedAt: now().now,
      };
      await taskStore.updateTask(edited);
      return edited;
    },

    /** Marks an open task done; completing a done task changes nothing. */
    async completeTask(input: unknown): Promise<void> {
      const { taskId } = taskReferenceCommandSchema.parse(input);
      const task = await requireTask(taskId);
      if (task.status === "done") return;
      const timestamp = now().now;
      await taskStore.updateTask({
        ...task,
        status: "done",
        completedAt: timestamp,
        updatedAt: timestamp,
      });
    },

    /** Reopens a done task; reopening an open task changes nothing. */
    async reopenTask(input: unknown): Promise<void> {
      const { taskId } = taskReferenceCommandSchema.parse(input);
      const task = await requireTask(taskId);
      if (task.status === "open") return;
      await taskStore.updateTask({
        ...task,
        status: "open",
        completedAt: null,
        updatedAt: now().now,
      });
    },

    async deleteTask(input: unknown): Promise<void> {
      const { taskId } = taskReferenceCommandSchema.parse(input);
      await taskStore.deleteTask(taskId);
    },
  };
}

export type InboxService = ReturnType<typeof createInboxService>;
