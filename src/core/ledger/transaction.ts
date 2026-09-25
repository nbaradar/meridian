import { z } from "zod";

import {
  accountIdSchema,
  categoryIdSchema,
  sourceRecordIdSchema,
  transactionIdSchema,
} from "./identifiers";
import {
  amountsBalance,
  decimalAmountSchema,
  usdCurrencySchema,
} from "./money";
import { calendarDateSchema, utcTimestampSchema } from "./timestamps";

export const manualProvenanceSchema = z.strictObject({
  kind: z.literal("manual"),
});

export const externalProvenanceSchema = z.strictObject({
  kind: z.literal("external"),
  sourceRecordId: sourceRecordIdSchema,
});

export const systemProvenanceSchema = z.strictObject({
  kind: z.literal("system"),
});

export const transactionProvenanceSchema = z.discriminatedUnion("kind", [
  manualProvenanceSchema,
  systemProvenanceSchema,
  externalProvenanceSchema,
]);

const entryFields = {
  amount: decimalAmountSchema,
};

export const accountEntrySchema = z.strictObject({
  ...entryFields,
  destination: z.literal("account"),
  accountId: accountIdSchema,
});

export const categoryEntrySchema = z.strictObject({
  ...entryFields,
  destination: z.literal("category"),
  categoryId: categoryIdSchema,
});

export const transactionEntrySchema = z.discriminatedUnion("destination", [
  accountEntrySchema,
  categoryEntrySchema,
]);

export const ledgerTransactionSchema = z
  .strictObject({
    id: transactionIdSchema,
    occurredOn: calendarDateSchema,
    occurredAt: utcTimestampSchema.nullable(),
    description: z.string().trim().min(1),
    currency: usdCurrencySchema,
    provenance: transactionProvenanceSchema,
    correctsTransactionId: transactionIdSchema.nullable(),
    entries: z.array(transactionEntrySchema).min(2),
  })
  .superRefine((transaction, context) => {
    if (transaction.correctsTransactionId === transaction.id) {
      context.addIssue({
        code: "custom",
        message: "A correction cannot reference itself",
        path: ["correctsTransactionId"],
      });
    }

    if (
      transaction.correctsTransactionId !== null &&
      transaction.provenance.kind !== "system"
    ) {
      context.addIssue({
        code: "custom",
        message: "A correction must be system-originated",
        path: ["provenance"],
      });
    }

    if (!amountsBalance(transaction.entries.map(({ amount }) => amount))) {
      context.addIssue({
        code: "custom",
        message: "Transaction entries must sum exactly to zero",
        path: ["entries"],
      });
    }
  });

export type ManualProvenance = z.infer<typeof manualProvenanceSchema>;
export type SystemProvenance = z.infer<typeof systemProvenanceSchema>;
export type ExternalProvenance = z.infer<typeof externalProvenanceSchema>;
export type TransactionProvenance = z.infer<typeof transactionProvenanceSchema>;
export type AccountEntry = z.infer<typeof accountEntrySchema>;
export type CategoryEntry = z.infer<typeof categoryEntrySchema>;
export type TransactionEntry = z.infer<typeof transactionEntrySchema>;
export type LedgerTransaction = z.infer<typeof ledgerTransactionSchema>;
