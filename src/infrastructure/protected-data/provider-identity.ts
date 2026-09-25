import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import { sha256DigestSchema, sourceNameSchema } from "../../core/ledger";
import {
  protectedDataEnvelopeSchema,
  ProtectedDataError,
  type ProtectedDataKeyring,
} from "./xchacha20-keyring";

const providerIdentityDomain = "meridian.provider-identity.v1";
const lookupDomain = "meridian.provider-identity.lookup.v1\0";
const base64KeyPattern = /^[A-Za-z0-9+/]{43}=$/u;
const keyIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u);
const lookupConfigurationSchema = z.strictObject({
  keyId: keyIdSchema,
  key: z.string(),
});
const lookupKeyringConfigurationSchema = z.strictObject({
  currentKeyId: keyIdSchema,
  keys: z.record(keyIdSchema, z.string()),
});

export const providerIdentityContextSchema = z.strictObject({
  source: sourceNameSchema,
  connectionId: z.string().uuid(),
  discoveredAccountId: z.string().uuid(),
  keyStatus: z.literal("active"),
});

export const providerIdentityLookupSchema = z.strictObject({
  digestKeyId: keyIdSchema,
  lookupDigest: sha256DigestSchema,
});

export const providerIdentityEnvelopeSchema = providerIdentityContextSchema
  .extend(providerIdentityLookupSchema.shape)
  .extend(protectedDataEnvelopeSchema.shape);

export type ProviderIdentityContext = z.infer<
  typeof providerIdentityContextSchema
>;
export type ProviderIdentityLookup = z.infer<
  typeof providerIdentityLookupSchema
>;
export type ProviderIdentityEnvelope = z.infer<
  typeof providerIdentityEnvelopeSchema
>;

export interface ProviderIdentityLookupKeyConfiguration {
  readonly keyId: string;
  readonly key: string;
}

export interface ProviderIdentityLookupService {
  digest(nativeIdentity: string, keyId?: string): ProviderIdentityLookup;
}

function failConfiguration(): never {
  throw new ProtectedDataError(
    "Provider identity lookup configuration is invalid",
    "invalid_configuration",
  );
}

export function createProviderIdentityLookup(
  configuration: ProviderIdentityLookupKeyConfiguration,
): ProviderIdentityLookupService {
  const parsedConfiguration =
    lookupConfigurationSchema.safeParse(configuration);
  if (
    !parsedConfiguration.success ||
    !base64KeyPattern.test(parsedConfiguration.data.key)
  ) {
    failConfiguration();
  }
  const key = Buffer.from(parsedConfiguration.data.key, "base64");
  if (
    key.length !== 32 ||
    key.toString("base64") !== parsedConfiguration.data.key
  ) {
    failConfiguration();
  }

  return {
    digest(nativeIdentity) {
      if (typeof nativeIdentity !== "string" || nativeIdentity.length === 0) {
        throw new ProtectedDataError(
          "Provider identity is invalid",
          "invalid_input",
        );
      }
      return providerIdentityLookupSchema.parse({
        digestKeyId: parsedConfiguration.data.keyId,
        lookupDigest: createHmac("sha256", key)
          .update(lookupDomain, "utf8")
          .update(nativeIdentity, "utf8")
          .digest("hex"),
      });
    },
  };
}

export function createProviderIdentityLookupKeyring(configuration: {
  readonly currentKeyId: string;
  readonly keys: Readonly<Record<string, string>>;
}): ProviderIdentityLookupService {
  const parsed = lookupKeyringConfigurationSchema.safeParse(configuration);
  if (!parsed.success || !(parsed.data.currentKeyId in parsed.data.keys)) {
    failConfiguration();
  }
  const services = new Map(
    Object.entries(parsed.data.keys).map(([keyId, key]) => [
      keyId,
      createProviderIdentityLookup({ keyId, key }),
    ]),
  );
  return {
    digest(nativeIdentity, keyId = parsed.data.currentKeyId) {
      const service = services.get(keyId);
      if (!service) {
        throw new ProtectedDataError(
          "Provider identity lookup key is unavailable",
          "key_unavailable",
        );
      }
      return service.digest(nativeIdentity);
    },
  };
}

function metadata(
  context: ProviderIdentityContext,
  lookup: ProviderIdentityLookup,
): Record<string, string> {
  return {
    connectionId: context.connectionId,
    lookupDigest: lookup.lookupDigest,
    digestKeyId: lookup.digestKeyId,
    discoveredAccountId: context.discoveredAccountId,
    source: context.source,
  };
}

function parseContext(input: unknown): ProviderIdentityContext {
  const result = providerIdentityContextSchema.safeParse(input);
  if (!result.success) {
    throw new ProtectedDataError(
      "Provider identity protection context is invalid",
      "invalid_input",
    );
  }
  return result.data;
}

function parseEnvelope(input: unknown): ProviderIdentityEnvelope {
  const result = providerIdentityEnvelopeSchema.safeParse(input);
  if (!result.success) {
    throw new ProtectedDataError(
      "Provider identity envelope is invalid",
      "invalid_input",
    );
  }
  return result.data;
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftHash = createHash("sha256").update(left, "utf8").digest();
  const rightHash = createHash("sha256").update(right, "utf8").digest();
  return timingSafeEqual(leftHash, rightHash);
}

export function createProviderIdentityEnvelopeProtector(
  keyring: ProtectedDataKeyring,
  lookupService: ProviderIdentityLookupService,
) {
  return {
    async seal(
      contextInput: ProviderIdentityContext,
      nativeIdentity: string,
    ): Promise<ProviderIdentityEnvelope> {
      const context = parseContext(contextInput);
      const lookup = lookupService.digest(nativeIdentity);
      const envelope = await keyring.seal(
        providerIdentityDomain,
        metadata(context, lookup),
        new TextEncoder().encode(nativeIdentity),
      );
      return { ...context, ...lookup, ...envelope };
    },

    async open(envelopeInput: unknown): Promise<string> {
      const envelope = parseEnvelope(envelopeInput);
      const plaintext = await keyring.open(
        providerIdentityDomain,
        metadata(envelope, envelope),
        {
          encryptionAlgorithm: envelope.encryptionAlgorithm,
          encryptionKeyId: envelope.encryptionKeyId,
          nonce: envelope.nonce,
          ciphertext: envelope.ciphertext,
        },
      );
      try {
        const nativeIdentity = new TextDecoder("utf-8", { fatal: true }).decode(
          plaintext,
        );
        const expectedLookup = lookupService.digest(
          nativeIdentity,
          envelope.digestKeyId,
        );
        const keyIdMatches = constantTimeEqual(
          expectedLookup.digestKeyId,
          envelope.digestKeyId,
        );
        const digestMatches = constantTimeEqual(
          expectedLookup.lookupDigest,
          envelope.lookupDigest,
        );
        if (!keyIdMatches || !digestMatches) {
          throw new Error("provider identity lookup mismatch");
        }
        return nativeIdentity;
      } catch {
        throw new ProtectedDataError(
          "Provider identity plaintext is invalid",
          "authentication_failed",
        );
      }
    },
  };
}
