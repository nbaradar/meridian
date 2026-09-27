import { z } from "zod";

import {
  accountIdSchema,
  balanceObservationIdSchema,
  calendarDateSchema,
  utcTimestampSchema,
  type CalendarDate,
  type UtcTimestamp,
} from "../ledger";

/**
 * RFC 0009 severities, most important first. `review` and `decision` items
 * stay until the owner decides in the owning feature; `action` and `info`
 * items are routine and may be dismissed.
 */
export const attentionSeveritySchema = z.enum([
  "review",
  "decision",
  "action",
  "info",
]);
export type AttentionSeverity = z.infer<typeof attentionSeveritySchema>;
export const attentionSeverities = attentionSeveritySchema.options;

/** A provider id: lowercase, and never one of the Inbox's own prefixes. */
export const attentionProviderIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]*$/u)
  .refine((id) => id !== "inbox" && id !== "task", {
    message: "The provider id is reserved by the Inbox",
  });

export const attentionItemKeySchema = z.string().min(1).max(500);
export const attentionItemVersionSchema = z.string().min(1).max(500);

/** Canonical references to what the item is about. */
export const attentionSubjectSchema = z.strictObject({
  accountId: accountIdSchema.optional(),
  observationId: balanceObservationIdSchema.optional(),
});

/**
 * A computed system item. Nothing here is stored: it is recomputed on every
 * Inbox view and count, so fixing the condition removes it.
 */
export const attentionItemSchema = z.strictObject({
  /** `<provider>:<kind>:<subject>`, stable across views. */
  key: attentionItemKeySchema,
  /** Fingerprint of the current evidence; a change re-activates the item. */
  version: attentionItemVersionSchema,
  kind: z.string().regex(/^[a-z][a-z0-9_]*$/u),
  severity: attentionSeveritySchema,
  /** No account numbers, amounts, or raw provider data. */
  title: z.string().trim().min(1).max(300),
  subject: attentionSubjectSchema.optional(),
  /** The in-app page that owns the resolution. */
  href: z.string().regex(/^\/(?:[^/\\]|$)/u),
  /** When the condition began, if known; used only for ordering. */
  since: utcTimestampSchema.nullable(),
  /** For `decision` items: the choices, shown as labels. */
  options: z.array(z.string().min(1)).readonly().optional(),
  /** In-app link to the evaluation or records the item is based on. */
  evidence: z
    .string()
    .regex(/^\/(?:[^/\\]|$)/u)
    .optional(),
});
export type AttentionSubject = z.infer<typeof attentionSubjectSchema>;
export type AttentionItem = z.infer<typeof attentionItemSchema>;

export interface AttentionContext {
  now: UtcTimestamp;
  /** `utcDate(now)`: every date comparison uses it. */
  today: CalendarDate;
}

/**
 * RFC 0009: a cheap, read-only, side-effect-free source of Inbox items. Keys
 * must start with `<id>:`. It never records a decision or acts on money.
 */
export interface AttentionProvider {
  readonly id: string;
  items(context: AttentionContext): Promise<readonly AttentionItem[]>;
}

const providerFailurePrefix = "inbox:provider_failed:";

/** The single `info` item that stands in for a provider that failed. */
export function providerFailureItem(providerId: string): AttentionItem {
  return {
    key: `${providerFailurePrefix}${providerId}`,
    version: "failed",
    kind: "provider_failed",
    severity: "info",
    title: `Inbox items from "${providerId}" could not be loaded`,
    href: "/inbox",
    since: null,
  };
}

export function isProviderFailureItem(item: Pick<AttentionItem, "key">) {
  return item.key.startsWith(providerFailurePrefix);
}

/** Every system item except a provider failure can be snoozed. */
export function canSnooze(item: AttentionItem): boolean {
  return !isProviderFailureItem(item);
}

/** Only routine items can be dismissed; decisions stay until decided. */
export function canDismiss(item: AttentionItem): boolean {
  return (
    canSnooze(item) && (item.severity === "action" || item.severity === "info")
  );
}

/** Midnight UTC of a calendar date, for `since` values known only by date. */
export function startOfDay(date: CalendarDate): UtcTimestamp {
  return utcTimestampSchema.parse(`${date}T00:00:00.000Z`);
}

/** Calendar arithmetic on UTC dates; `days` may be negative. */
export function addDays(date: CalendarDate, days: number): CalendarDate {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return calendarDateSchema.parse(value.toISOString().slice(0, 10));
}

/** The same day next month, clamped to that month's last day. */
export function addOneMonth(date: CalendarDate): CalendarDate {
  const [year, month, day] = date.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const value = new Date(Date.UTC(year, month, Math.min(day, lastDay)));
  return calendarDateSchema.parse(value.toISOString().slice(0, 10));
}
