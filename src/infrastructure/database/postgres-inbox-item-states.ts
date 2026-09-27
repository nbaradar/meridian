import { sql } from "drizzle-orm";
import { z } from "zod";

import {
  InboxConflictError,
  InboxPersistenceError,
  type InboxItemState,
  type InboxItemStateStore,
} from "../../core/inbox";
import { calendarDateSchema, utcTimestampSchema } from "../../core/ledger";
import type { MeridianDatabase } from "./client";
import { executeRows, postgresErrorCode } from "./postgres-account-sources";

const recordedAtSchema = z
  .union([z.string(), z.date()])
  .transform((value) =>
    utcTimestampSchema.parse(new Date(value).toISOString()),
  );

const itemStateRowSchema = z.discriminatedUnion("state", [
  z.object({
    item_key: z.string(),
    item_version: z.string(),
    state: z.literal("snoozed"),
    snoozed_until: calendarDateSchema,
    recorded_at: recordedAtSchema,
  }),
  z.object({
    item_key: z.string(),
    item_version: z.string(),
    state: z.literal("dismissed"),
    snoozed_until: z.null(),
    recorded_at: recordedAtSchema,
  }),
]);

function itemStateFromRow(input: unknown): InboxItemState {
  const row = itemStateRowSchema.parse(input);
  const common = {
    itemKey: row.item_key,
    itemVersion: row.item_version,
    recordedAt: row.recorded_at,
  };
  return row.state === "snoozed"
    ? { ...common, state: "snoozed", snoozedUntil: row.snoozed_until }
    : { ...common, state: "dismissed", snoozedUntil: null };
}

/** Snooze and dismiss records in `app.inbox_item_states`; nothing else. */
export function createPostgresInboxItemStateStore(
  database: MeridianDatabase,
): InboxItemStateStore {
  return {
    async listItemStates() {
      try {
        const rows = await executeRows<unknown>(
          database,
          sql`
            select item_key, item_version, state,
              snoozed_until::text as snoozed_until, recorded_at
            from app.inbox_item_states
            order by item_key
          `,
        );
        return rows.map(itemStateFromRow);
      } catch (error) {
        throw new InboxPersistenceError(
          "list item states",
          {},
          {
            cause: error,
          },
        );
      }
    },

    async putItemState(state) {
      try {
        await database.execute(sql`
          insert into app.inbox_item_states (
            item_key, item_version, state, snoozed_until, recorded_at
          ) values (
            ${state.itemKey}, ${state.itemVersion}, ${state.state},
            ${state.snoozedUntil}, ${state.recordedAt}
          )
          on conflict (item_key) do update set
            item_version = excluded.item_version,
            state = excluded.state,
            snoozed_until = excluded.snoozed_until,
            recorded_at = excluded.recorded_at
        `);
      } catch (error) {
        const context = { itemKey: state.itemKey };
        if (postgresErrorCode(error) === "23514") {
          throw new InboxConflictError(
            "The snooze or dismissal is not valid",
            context,
            { cause: error },
          );
        }
        throw new InboxPersistenceError(`save ${state.state} item`, context, {
          cause: error,
        });
      }
    },

    async deleteItemState(itemKey) {
      try {
        await database.execute(
          sql`delete from app.inbox_item_states where item_key = ${itemKey}`,
        );
      } catch (error) {
        throw new InboxPersistenceError(
          "restore item",
          { itemKey },
          {
            cause: error,
          },
        );
      }
    },
  };
}
