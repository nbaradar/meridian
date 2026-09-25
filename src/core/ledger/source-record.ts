import { z } from "zod";

import { rawPayloadIdSchema, sourceRecordIdSchema } from "./identifiers";
import { utcTimestampSchema } from "./timestamps";

export const sha256DigestSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/u, "Digest must be a lowercase SHA-256 hex string")
  .brand<"Sha256Digest">();
export const sourceNameSchema = z.string().trim().min(1).brand<"SourceName">();
export const sourceReferenceSchema = z
  .string()
  .trim()
  .min(1)
  .brand<"SourceReference">();

export const sourceRecordSchema = z
  .strictObject({
    id: sourceRecordIdSchema,
    source: sourceNameSchema,
    sourceRef: sourceReferenceSchema,
    contentDigest: sha256DigestSchema,
    rawPayloadId: rawPayloadIdSchema,
    supersedesSourceRecordId: sourceRecordIdSchema.nullable(),
    ingestedAt: utcTimestampSchema,
  })
  .refine((record) => record.supersedesSourceRecordId !== record.id, {
    message: "A source-record version cannot supersede itself",
    path: ["supersedesSourceRecordId"],
  });

export type Sha256Digest = z.infer<typeof sha256DigestSchema>;
export type SourceName = z.infer<typeof sourceNameSchema>;
export type SourceReference = z.infer<typeof sourceReferenceSchema>;
export type SourceRecord = z.infer<typeof sourceRecordSchema>;
