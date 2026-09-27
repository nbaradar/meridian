import { sql } from "drizzle-orm";
import { z } from "zod";

import {
  InboxConflictError,
  InboxPersistenceError,
  InboxReferenceError,
  inboxTaskIdSchema,
  inboxTaskStatusSchema,
  type InboxErrorContext,
  type InboxTaskStore,
  type OwnerTask,
} from "../../core/inbox";
import {
  accountIdSchema,
  calendarDateSchema,
  utcTimestampSchema,
} from "../../core/ledger";
import type { MeridianDatabase } from "./client";
import {
  constraintName,
  executeRows,
  postgresErrorCode,
} from "./postgres-account-sources";

const timestampSchema = z
  .union([z.string(), z.date()])
  .transform((value) =>
    utcTimestampSchema.parse(new Date(value).toISOString()),
  );

const taskRowSchema = z.object({
  id: inboxTaskIdSchema,
  title: z.string(),
  note: z.string().nullable(),
  account_id: accountIdSchema.nullable(),
  link: z.string().nullable(),
  due_on: calendarDateSchema.nullable(),
  status: inboxTaskStatusSchema,
  created_at: timestampSchema,
  updated_at: timestampSchema,
  completed_at: timestampSchema.nullable(),
});

function taskFromRow(input: unknown): OwnerTask {
  const row = taskRowSchema.parse(input);
  return {
    id: row.id,
    title: row.title,
    note: row.note,
    accountId: row.account_id,
    link: row.link,
    dueOn: row.due_on,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

// Owner-facing explanations for the database rules in migration 0015.
const conflictMessages: Readonly<Record<string, string>> = {
  inbox_tasks_pkey: "A task with this id already exists",
  inbox_tasks_title_check: "A title must be 1 to 200 characters",
  inbox_tasks_note_check: "A note can be at most 2000 characters",
  inbox_tasks_link_check:
    "A link must be an in-app path starting with a single / or an http:// or https:// address",
  inbox_tasks_status_check: "A task must be open or done",
  inbox_tasks_completed_check:
    "A task has a completion time exactly when it is done",
  inbox_tasks_time_check: "A task cannot change before it was created",
};

function mapPersistenceError(
  operation: string,
  context: InboxErrorContext,
  error: unknown,
): never {
  const code = postgresErrorCode(error);
  const constraint = constraintName(error);
  if (code === "23503") {
    throw new InboxReferenceError(
      "The task's account does not exist",
      context,
      {
        cause: error,
      },
    );
  }
  if (code === "23514" || code === "23505") {
    throw new InboxConflictError(
      (constraint && conflictMessages[constraint]) ??
        "The task conflicts with saved Inbox state",
      context,
      { cause: error },
    );
  }
  throw new InboxPersistenceError(operation, context, { cause: error });
}

function taskContext(task: Pick<OwnerTask, "id" | "accountId">) {
  return { taskId: task.id, accountId: task.accountId };
}

const selectTasks = sql`
  select id, title, note, account_id, link, due_on::text as due_on, status,
    created_at, updated_at, completed_at
  from app.inbox_tasks
`;

/** Owner tasks in `app.inbox_tasks`; reads and writes nothing else. */
export function createPostgresInboxTaskStore(
  database: MeridianDatabase,
): InboxTaskStore {
  return {
    async listTasks() {
      try {
        const rows = await executeRows<unknown>(
          database,
          sql`${selectTasks} order by created_at, id`,
        );
        return rows.map(taskFromRow);
      } catch (error) {
        throw new InboxPersistenceError("list tasks", {}, { cause: error });
      }
    },

    async findTask(taskId) {
      try {
        const rows = await executeRows<unknown>(
          database,
          sql`${selectTasks} where id = ${taskId}`,
        );
        return rows.length === 0 ? null : taskFromRow(rows[0]);
      } catch (error) {
        throw new InboxPersistenceError(
          "find task",
          { taskId },
          { cause: error },
        );
      }
    },

    async insertTask(task) {
      try {
        await database.execute(sql`
          insert into app.inbox_tasks (
            id, title, note, account_id, link, due_on, status,
            created_at, updated_at, completed_at
          ) values (
            ${task.id}, ${task.title}, ${task.note}, ${task.accountId},
            ${task.link}, ${task.dueOn}, ${task.status}, ${task.createdAt},
            ${task.updatedAt}, ${task.completedAt}
          )
        `);
      } catch (error) {
        mapPersistenceError("add task", taskContext(task), error);
      }
    },

    async updateTask(task) {
      let updated: unknown[];
      try {
        updated = await executeRows<unknown>(
          database,
          sql`
            update app.inbox_tasks set
              title = ${task.title}, note = ${task.note},
              account_id = ${task.accountId}, link = ${task.link},
              due_on = ${task.dueOn}, status = ${task.status},
              updated_at = ${task.updatedAt}, completed_at = ${task.completedAt}
            where id = ${task.id}
            returning id
          `,
        );
      } catch (error) {
        mapPersistenceError("update task", taskContext(task), error);
      }
      if (updated.length === 0) {
        throw new InboxReferenceError(
          "The task does not exist",
          taskContext(task),
        );
      }
    },

    async deleteTask(taskId) {
      let deleted: unknown[];
      try {
        deleted = await executeRows<unknown>(
          database,
          sql`delete from app.inbox_tasks where id = ${taskId} returning id`,
        );
      } catch (error) {
        mapPersistenceError("delete task", { taskId }, error);
      }
      if (deleted.length === 0) {
        throw new InboxReferenceError("The task does not exist", { taskId });
      }
    },
  };
}
