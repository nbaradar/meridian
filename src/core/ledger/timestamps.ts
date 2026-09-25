import { z } from "zod";

export const calendarDateSchema = z.iso.date().brand<"CalendarDate">();
export const utcTimestampSchema = z.iso.datetime().brand<"UtcTimestamp">();
export type CalendarDate = z.infer<typeof calendarDateSchema>;
export type UtcTimestamp = z.infer<typeof utcTimestampSchema>;
