import { z } from "zod";

import {
  accountIdSchema,
  calendarDateSchema,
  type AccountId,
  type CalendarDate,
  type UtcTimestamp,
} from "../ledger";

export const inboxTaskIdSchema = z.uuid().brand<"InboxTaskId">();
export type InboxTaskId = z.infer<typeof inboxTaskIdSchema>;

export const inboxTaskStatusSchema = z.enum(["open", "done"]);
export type InboxTaskStatus = z.infer<typeof inboxTaskStatusSchema>;

export const taskTitleMaxLength = 200;
export const taskNoteMaxLength = 2000;
export const taskLinkMaxLength = 2048;

/** Form fields arrive as strings; an empty optional field means "none". */
function optional<T extends z.ZodType>(schema: T) {
  return z.preprocess(
    (value) =>
      value === undefined || (typeof value === "string" && value.trim() === "")
        ? null
        : value,
    schema.nullable(),
  );
}

const linkMessage =
  "A link must be an in-app path starting with a single / or an http:// or https:// address";

function isAllowedLink(link: string): boolean {
  // Browsers rewrite whitespace, control characters, and backslashes into
  // protocol-relative or scheme-changing links, so none are allowed.
  if (/[\s\p{Cc}\\]/u.test(link)) return false;
  if (/^\/(?:[^/]|$)/u.test(link)) return true;
  if (!/^https?:\/\/[^/]/iu.test(link)) return false;
  try {
    const url = new URL(link);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * The one rule for task links, mirrored by `inbox_tasks_link_check`: an
 * in-app path or an absolute http(s) URL. `javascript:`, `//host`, other
 * schemes, and relative paths are refused.
 */
export const taskLinkSchema = z
  .string()
  .trim()
  .max(
    taskLinkMaxLength,
    `A link can be at most ${taskLinkMaxLength} characters`,
  )
  .refine(isAllowedLink, linkMessage);

export const taskTitleSchema = z
  .string({ error: "Enter a title" })
  .trim()
  .min(1, "Enter a title")
  .max(
    taskTitleMaxLength,
    `A title can be at most ${taskTitleMaxLength} characters`,
  );

export const taskNoteSchema = z
  .string()
  .trim()
  .max(
    taskNoteMaxLength,
    `A note can be at most ${taskNoteMaxLength} characters`,
  );

const taskFields = {
  taskId: inboxTaskIdSchema,
  title: taskTitleSchema,
  note: optional(taskNoteSchema),
  accountId: optional(accountIdSchema),
  link: optional(taskLinkSchema),
  dueOn: optional(calendarDateSchema),
};

export const addTaskCommandSchema = z.strictObject(taskFields);
/** Replaces every editable field; status and timestamps are kept. */
export const editTaskCommandSchema = z.strictObject(taskFields);
export const taskReferenceCommandSchema = z.strictObject({
  taskId: inboxTaskIdSchema,
});

export type AddTaskCommand = z.infer<typeof addTaskCommandSchema>;
export type EditTaskCommand = z.infer<typeof editTaskCommandSchema>;

/** A row of `app.inbox_tasks`. */
export interface OwnerTask {
  id: InboxTaskId;
  title: string;
  note: string | null;
  accountId: AccountId | null;
  link: string | null;
  dueOn: CalendarDate | null;
  status: InboxTaskStatus;
  createdAt: UtcTimestamp;
  updatedAt: UtcTimestamp;
  /** Set exactly when `status` is `done`. */
  completedAt: UtcTimestamp | null;
}

/** Overdue only once the due date has passed; due today is not overdue. */
export function isTaskOverdue(task: OwnerTask, today: CalendarDate): boolean {
  return task.status === "open" && task.dueOn !== null && task.dueOn < today;
}

/** Whether a link leaves the app, so it renders with `rel="noopener noreferrer"`. */
export function isExternalLink(link: string): boolean {
  return !link.startsWith("/");
}

export interface InboxTaskStore {
  listTasks(): Promise<readonly OwnerTask[]>;
  findTask(taskId: InboxTaskId): Promise<OwnerTask | null>;
  insertTask(task: OwnerTask): Promise<void>;
  /** Replaces the stored row; throws when the task does not exist. */
  updateTask(task: OwnerTask): Promise<void>;
  /** Throws when the task does not exist. */
  deleteTask(taskId: InboxTaskId): Promise<void>;
}
