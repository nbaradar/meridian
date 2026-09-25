import { z } from "zod";

import { sha256DigestSchema, sourceNameSchema } from "./source-record";

export const rawPayloadAlgorithmSchema = z.literal("xchacha20-poly1305-ietf");

export const rawPayloadEnvelopeSchema = z.strictObject({
  source: sourceNameSchema,
  contentDigest: sha256DigestSchema,
  encryptionAlgorithm: rawPayloadAlgorithmSchema,
  encryptionKeyId: z.string().trim().min(1),
  nonce: z.string().min(1),
  ciphertext: z.string().min(1),
});

export type RawPayloadEnvelope = z.infer<typeof rawPayloadEnvelopeSchema>;

export interface RawPayloadCipher {
  seal(source: string, plaintext: Uint8Array): Promise<RawPayloadEnvelope>;
  open(envelope: RawPayloadEnvelope): Promise<Uint8Array>;
}

const forbiddenSecretFields = new Set([
  "access_token",
  "authorization",
  "client_secret",
  "credential",
  "credentials",
  "password",
  "refresh_token",
  "secret",
  "token",
]);

function normalizedFieldName(field: string): string {
  return field.replaceAll(/([a-z])([A-Z])/gu, "$1_$2").toLowerCase();
}

export function assertNoSecretFields(value: unknown, path = "payload"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      assertNoSecretFields(item, `${path}[${index}]`),
    );
    return;
  }
  if (typeof value !== "object" || value === null) return;

  for (const [field, fieldValue] of Object.entries(value)) {
    const fieldPath = `${path}.${field}`;
    if (forbiddenSecretFields.has(normalizedFieldName(field))) {
      throw new Error(
        `Raw payload contains forbidden secret field: ${fieldPath}`,
      );
    }
    assertNoSecretFields(fieldValue, fieldPath);
  }
}
