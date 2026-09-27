import { z } from "zod";

import {
  calendarDateSchema,
  type CalendarDate,
  type UtcTimestamp,
} from "../ledger";
import {
  addDays,
  addOneMonth,
  attentionItemKeySchema,
  attentionItemVersionSchema,
  isProviderFailureItem,
  type AttentionItem,
} from "./attention";
import { InboxValidationError } from "./errors";

/**
 * A row of `app.inbox_item_states`: one snooze or dismissal per item key. It
 * applies only while `itemVersion` equals the item's current version.
 */
export type InboxItemState = {
  itemKey: string;
  itemVersion: string;
  recordedAt: UtcTimestamp;
} & (
  | { state: "snoozed"; snoozedUntil: CalendarDate }
  | { state: "dismissed"; snoozedUntil: null }
);

export interface InboxItemStateStore {
  listItemStates(): Promise<readonly InboxItemState[]>;
  /** Inserts, or replaces the row for the same key. */
  putItemState(state: InboxItemState): Promise<void>;
  /** Removes the row for the key, if any. */
  deleteItemState(itemKey: string): Promise<void>;
}

export const snoozeChoiceSchema = z.enum(["day", "week", "month", "date"]);
export type SnoozeChoice = z.infer<typeof snoozeChoiceSchema>;

/** Furthest a chosen snooze date may be from today. */
export const maxSnoozeDays = 365;

const itemReferenceFields = {
  itemKey: attentionItemKeySchema,
  itemVersion: attentionItemVersionSchema,
};

export const snoozeCommandSchema = z.strictObject({
  ...itemReferenceFields,
  choice: snoozeChoiceSchema,
  /** Required for `date`; ignored otherwise. Empty means none. */
  until: z.preprocess(
    (value) => (value === "" || value === undefined ? null : value),
    calendarDateSchema.nullable(),
  ),
});
export const dismissCommandSchema = z.strictObject(itemReferenceFields);
export const restoreCommandSchema = z.strictObject({
  itemKey: attentionItemKeySchema,
});

export type SnoozeCommand = z.infer<typeof snoozeCommandSchema>;

/**
 * The date a snooze ends; the item returns on it. Fixed choices count from
 * `today`, and a chosen date must be after today and at most 365 days away.
 */
export function snoozeUntil(
  choice: SnoozeChoice,
  chosenDate: CalendarDate | null,
  today: CalendarDate,
): CalendarDate {
  switch (choice) {
    case "day":
      return addDays(today, 1);
    case "week":
      return addDays(today, 7);
    case "month":
      return addOneMonth(today);
    case "date": {
      if (chosenDate === null) {
        throw new InboxValidationError("Choose a date to snooze until");
      }
      if (chosenDate <= today) {
        throw new InboxValidationError("A snooze date must be after today");
      }
      if (chosenDate > addDays(today, maxSnoozeDays)) {
        throw new InboxValidationError(
          `A snooze date can be at most ${maxSnoozeDays} days away`,
        );
      }
      return chosenDate;
    }
  }
}

export interface SnoozedItem {
  item: AttentionItem;
  snoozedUntil: CalendarDate;
}

export interface PartitionedItems {
  active: readonly AttentionItem[];
  snoozed: readonly SnoozedItem[];
  dismissed: readonly AttentionItem[];
}

/**
 * Splits current items by their stored state. A state for another version, an
 * expired snooze, or a state on a provider failure leaves the item active.
 * States for keys no longer computed are ignored, never deleted.
 */
export function applyItemStates(
  items: readonly AttentionItem[],
  states: readonly InboxItemState[],
  today: CalendarDate,
): PartitionedItems {
  const stateByKey = new Map(states.map((state) => [state.itemKey, state]));
  const active: AttentionItem[] = [];
  const snoozed: SnoozedItem[] = [];
  const dismissed: AttentionItem[] = [];
  for (const item of items) {
    const state = stateByKey.get(item.key);
    if (
      !state ||
      state.itemVersion !== item.version ||
      isProviderFailureItem(item)
    ) {
      active.push(item);
    } else if (state.state === "dismissed") {
      dismissed.push(item);
    } else if (today < state.snoozedUntil) {
      snoozed.push({ item, snoozedUntil: state.snoozedUntil });
    } else {
      active.push(item);
    }
  }
  return { active, snoozed, dismissed };
}
