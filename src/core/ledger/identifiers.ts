import { z } from "zod";

export const accountIdSchema = z.uuid().brand<"AccountId">();
export const accountRevisionIdSchema = z.uuid().brand<"AccountRevisionId">();
export const categoryIdSchema = z.uuid().brand<"CategoryId">();
export const categoryRevisionIdSchema = z.uuid().brand<"CategoryRevisionId">();
export const transactionIdSchema = z.uuid().brand<"TransactionId">();
export const sourceRecordIdSchema = z.uuid().brand<"SourceRecordId">();
export const rawPayloadIdSchema = z.uuid().brand<"RawPayloadId">();
export const importIdSchema = z.uuid().brand<"ImportId">();
export const accountSourceIdSchema = z.uuid().brand<"AccountSourceId">();
export const accountSourceLinkRevisionIdSchema = z
  .uuid()
  .brand<"AccountSourceLinkRevisionId">();
export const accountSetRevisionIdSchema = z
  .uuid()
  .brand<"AccountSetRevisionId">();

export type AccountId = z.infer<typeof accountIdSchema>;
export type AccountRevisionId = z.infer<typeof accountRevisionIdSchema>;
export type CategoryId = z.infer<typeof categoryIdSchema>;
export type CategoryRevisionId = z.infer<typeof categoryRevisionIdSchema>;
export type TransactionId = z.infer<typeof transactionIdSchema>;
export type SourceRecordId = z.infer<typeof sourceRecordIdSchema>;
export type RawPayloadId = z.infer<typeof rawPayloadIdSchema>;
export type ImportId = z.infer<typeof importIdSchema>;
export type AccountSourceId = z.infer<typeof accountSourceIdSchema>;
export type AccountSourceLinkRevisionId = z.infer<
  typeof accountSourceLinkRevisionIdSchema
>;
export type AccountSetRevisionId = z.infer<typeof accountSetRevisionIdSchema>;
