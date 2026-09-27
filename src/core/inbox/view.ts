import type { CalendarDate, UtcTimestamp } from "../ledger";
import {
  attentionSeverities,
  type AttentionItem,
  type AttentionSeverity,
} from "./attention";
import type { PartitionedItems, SnoozedItem } from "./item-states";
import { isTaskOverdue, type OwnerTask } from "./tasks";

/** One row of an active Inbox group: a system item or an open owner task. */
export type InboxEntry =
  | { type: "item"; key: string; item: AttentionItem }
  | { type: "task"; key: string; task: OwnerTask; overdue: boolean };

export interface InboxGroup {
  severity: AttentionSeverity;
  entries: readonly InboxEntry[];
}

export interface InboxView {
  today: CalendarDate;
  /** Non-empty severity groups, most important first. */
  groups: readonly InboxGroup[];
  snoozed: readonly SnoozedItem[];
  dismissed: readonly AttentionItem[];
  /** Done tasks, newest completed first. */
  done: readonly OwnerTask[];
  /** The `Inbox (N)` count; see `inboxCount`. */
  count: number;
}

const severityRank: Readonly<Record<AttentionSeverity, number>> = {
  review: 0,
  decision: 1,
  action: 2,
  info: 3,
};

interface SortFields {
  severity: AttentionSeverity;
  overdue: boolean;
  since: UtcTimestamp | null;
  title: string;
  key: string;
}

function sortFields(entry: InboxEntry): SortFields {
  if (entry.type === "item") {
    const { severity, since, title } = entry.item;
    return { severity, overdue: false, since, title, key: entry.key };
  }
  // RFC 0009: owner tasks sort as `action` items that began when created.
  return {
    severity: "action",
    overdue: entry.overdue,
    since: entry.task.createdAt,
    title: entry.task.title,
    key: entry.key,
  };
}

/**
 * RFC 0009 order: severity; then overdue owner tasks; then oldest `since`,
 * with no `since` last; then title; then key. Input order never matters.
 */
export function compareInboxEntries(
  left: InboxEntry,
  right: InboxEntry,
): number {
  const a = sortFields(left);
  const b = sortFields(right);
  const bySeverity = severityRank[a.severity] - severityRank[b.severity];
  if (bySeverity !== 0) return bySeverity;
  if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
  if (a.since !== b.since) {
    if (a.since === null) return 1;
    if (b.since === null) return -1;
    const bySince = Date.parse(a.since) - Date.parse(b.since);
    if (bySince !== 0) return bySince;
  }
  const byTitle = a.title.localeCompare(b.title);
  if (byTitle !== 0) return byTitle;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

export function itemEntry(item: AttentionItem): InboxEntry {
  return { type: "item", key: item.key, item };
}

export function taskEntry(task: OwnerTask, today: CalendarDate): InboxEntry {
  return {
    type: "task",
    key: `task:${task.id}`,
    task,
    overdue: isTaskOverdue(task, today),
  };
}

/**
 * The `Inbox (N)` count: active `review`, `decision`, and `action` items plus
 * open owner tasks. `info`, snoozed, dismissed, and done never count.
 */
export function inboxCount(
  activeItems: readonly AttentionItem[],
  tasks: readonly OwnerTask[],
): number {
  return (
    activeItems.filter((item) => item.severity !== "info").length +
    tasks.filter((task) => task.status === "open").length
  );
}

export function buildInboxView(
  partitioned: PartitionedItems,
  tasks: readonly OwnerTask[],
  today: CalendarDate,
): InboxView {
  const entries = [
    ...partitioned.active.map(itemEntry),
    ...tasks
      .filter((task) => task.status === "open")
      .map((task) => taskEntry(task, today)),
  ].sort(compareInboxEntries);
  const groups = attentionSeverities.flatMap((severity) => {
    const members = entries.filter(
      (entry) => sortFields(entry).severity === severity,
    );
    return members.length === 0 ? [] : [{ severity, entries: members }];
  });
  const byItem = (left: AttentionItem, right: AttentionItem) =>
    compareInboxEntries(itemEntry(left), itemEntry(right));
  const done = tasks
    .filter((task) => task.status === "done")
    .sort(
      (left, right) =>
        Date.parse(right.completedAt ?? right.updatedAt) -
          Date.parse(left.completedAt ?? left.updatedAt) ||
        (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
    );
  return {
    today,
    groups,
    snoozed: [...partitioned.snoozed].sort(
      (left, right) =>
        (left.snoozedUntil < right.snoozedUntil
          ? -1
          : left.snoozedUntil > right.snoozedUntil
            ? 1
            : 0) || byItem(left.item, right.item),
    ),
    dismissed: [...partitioned.dismissed].sort(byItem),
    done,
    count: inboxCount(partitioned.active, tasks),
  };
}
