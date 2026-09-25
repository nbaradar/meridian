import { z } from "zod";

import { sourceNameSchema } from "../../core/ledger";
import {
  protectedDataEnvelopeSchema,
  ProtectedDataError,
  type ProtectedDataKeyring,
} from "./xchacha20-keyring";

const credentialDomain = "meridian.credential.v1";
const identifierSchema = z.string().uuid();
const keyStatusSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,63}$/u)
  .brand<"CredentialKeyStatus">();

export const credentialContextSchema = z.strictObject({
  source: sourceNameSchema,
  connectionId: identifierSchema,
  credentialGeneration: z.bigint().nonnegative(),
  authorizationClass: z.literal("read_only"),
  keyStatus: keyStatusSchema,
});

export const credentialEnvelopeSchema = credentialContextSchema.extend(
  protectedDataEnvelopeSchema.shape,
);

export type CredentialContext = z.infer<typeof credentialContextSchema>;
export type CredentialEnvelope = z.infer<typeof credentialEnvelopeSchema>;

function contextMetadata(context: CredentialContext): Record<string, string> {
  return {
    authorizationClass: context.authorizationClass,
    connectionId: context.connectionId,
    credentialGeneration: context.credentialGeneration.toString(),
    keyStatus: context.keyStatus,
    source: context.source,
  };
}

function parseContext(input: unknown): CredentialContext {
  const result = credentialContextSchema.safeParse(input);
  if (!result.success) {
    throw new ProtectedDataError(
      "Credential protection context is invalid",
      "invalid_input",
    );
  }
  return result.data;
}

function parseEnvelope(input: unknown): CredentialEnvelope {
  const result = credentialEnvelopeSchema.safeParse(input);
  if (!result.success) {
    throw new ProtectedDataError(
      "Credential envelope is invalid",
      "invalid_input",
    );
  }
  return result.data;
}

export function createCredentialEnvelopeProtector(
  keyring: ProtectedDataKeyring,
) {
  return {
    async seal(
      contextInput: CredentialContext,
      plaintext: Uint8Array,
    ): Promise<CredentialEnvelope> {
      const context = parseContext(contextInput);
      const envelope = await keyring.seal(
        credentialDomain,
        contextMetadata(context),
        plaintext,
      );
      return { ...context, ...envelope };
    },

    async open(envelopeInput: unknown): Promise<Uint8Array> {
      const envelope = parseEnvelope(envelopeInput);
      return keyring.open(credentialDomain, contextMetadata(envelope), {
        encryptionAlgorithm: envelope.encryptionAlgorithm,
        encryptionKeyId: envelope.encryptionKeyId,
        nonce: envelope.nonce,
        ciphertext: envelope.ciphertext,
      });
    },
  };
}
