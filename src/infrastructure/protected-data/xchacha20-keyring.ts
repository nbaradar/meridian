import sodium from "libsodium-wrappers";
import { z } from "zod";

const algorithm = "xchacha20-poly1305-ietf" as const;
const keyIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u);
const domainSchema = z.string().regex(/^[a-z][a-z0-9.-]{0,127}$/u);
const metadataSchema = z.record(z.string(), z.string());
const keyringConfigurationSchema = z.strictObject({
  currentKeyId: keyIdSchema,
  keys: z.record(keyIdSchema, z.string()),
});
const base64KeyPattern = /^[A-Za-z0-9+/]{43}=$/u;
const base64ValuePattern =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const textEncoder = new TextEncoder();

export const protectedDataEnvelopeSchema = z.strictObject({
  encryptionAlgorithm: z.literal(algorithm),
  encryptionKeyId: keyIdSchema,
  nonce: z.string().regex(base64ValuePattern),
  ciphertext: z.string().regex(base64ValuePattern),
});

export type ProtectedDataEnvelope = z.infer<typeof protectedDataEnvelopeSchema>;

export interface ProtectedDataKeyring {
  seal(
    domain: string,
    metadata: Readonly<Record<string, string>>,
    plaintext: Uint8Array,
  ): Promise<ProtectedDataEnvelope>;
  open(
    domain: string,
    metadata: Readonly<Record<string, string>>,
    envelope: unknown,
  ): Promise<Uint8Array>;
}

export interface ProtectedDataKeyringConfiguration {
  readonly currentKeyId: string;
  readonly keys: Readonly<Record<string, string>>;
}

export class ProtectedDataError extends Error {
  constructor(
    message: string,
    readonly code:
      | "invalid_configuration"
      | "invalid_input"
      | "key_unavailable"
      | "authentication_failed",
  ) {
    super(message);
    this.name = "ProtectedDataError";
  }
}

function failConfiguration(): never {
  throw new ProtectedDataError(
    "Protected data keyring configuration is invalid",
    "invalid_configuration",
  );
}

function decodeKey(value: string): Uint8Array {
  if (!base64KeyPattern.test(value)) failConfiguration();
  const decoded = Buffer.from(value, "base64");
  if (decoded.length !== 32 || decoded.toString("base64") !== value) {
    failConfiguration();
  }
  return decoded;
}

function validateContext(
  domainInput: string,
  metadataInput: Readonly<Record<string, string>>,
): { domain: string; metadata: Record<string, string> } {
  const domain = domainSchema.safeParse(domainInput);
  const metadata = metadataSchema.safeParse(metadataInput);
  if (!domain.success || !metadata.success) {
    throw new ProtectedDataError(
      "Protected data context is invalid",
      "invalid_input",
    );
  }
  return { domain: domain.data, metadata: metadata.data };
}

function associatedData(
  domain: string,
  metadata: Readonly<Record<string, string>>,
  keyId: string,
): Uint8Array {
  const orderedMetadata = Object.fromEntries(
    Object.entries(metadata).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    ),
  );
  return textEncoder.encode(
    JSON.stringify({
      algorithm,
      domain,
      keyId,
      metadata: orderedMetadata,
      version: 1,
    }),
  );
}

function parseEnvelope(input: unknown): ProtectedDataEnvelope {
  const result = protectedDataEnvelopeSchema.safeParse(input);
  if (!result.success) {
    throw new ProtectedDataError(
      "Protected data envelope is invalid",
      "invalid_input",
    );
  }
  return result.data;
}

export function createXChaCha20Poly1305Keyring(
  configuration: ProtectedDataKeyringConfiguration,
): ProtectedDataKeyring {
  const parsedConfiguration =
    keyringConfigurationSchema.safeParse(configuration);
  if (!parsedConfiguration.success) failConfiguration();

  const entries = Object.entries(parsedConfiguration.data.keys);
  if (entries.length === 0) failConfiguration();
  const keys = new Map<string, Uint8Array>();
  for (const [keyId, encodedKey] of entries) {
    keys.set(keyId, decodeKey(encodedKey));
  }
  const currentKeyId = parsedConfiguration.data.currentKeyId;
  if (!keys.has(currentKeyId)) failConfiguration();

  return {
    async seal(domainInput, metadataInput, plaintext) {
      const { domain, metadata } = validateContext(domainInput, metadataInput);
      if (!(plaintext instanceof Uint8Array)) {
        throw new ProtectedDataError(
          "Protected data plaintext is invalid",
          "invalid_input",
        );
      }
      await sodium.ready;
      const nonce = sodium.randombytes_buf(
        sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES,
      );
      const key = keys.get(currentKeyId);
      if (key === undefined) failConfiguration();
      const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
        plaintext,
        associatedData(domain, metadata, currentKeyId),
        null,
        nonce,
        key,
      );
      return {
        encryptionAlgorithm: algorithm,
        encryptionKeyId: currentKeyId,
        nonce: sodium.to_base64(nonce, sodium.base64_variants.ORIGINAL),
        ciphertext: sodium.to_base64(
          ciphertext,
          sodium.base64_variants.ORIGINAL,
        ),
      };
    },

    async open(domainInput, metadataInput, envelopeInput) {
      const { domain, metadata } = validateContext(domainInput, metadataInput);
      const envelope = parseEnvelope(envelopeInput);
      const key = keys.get(envelope.encryptionKeyId);
      if (key === undefined) {
        throw new ProtectedDataError(
          "Protected data key is unavailable",
          "key_unavailable",
        );
      }

      try {
        await sodium.ready;
        const nonce = sodium.from_base64(
          envelope.nonce,
          sodium.base64_variants.ORIGINAL,
        );
        const ciphertext = sodium.from_base64(
          envelope.ciphertext,
          sodium.base64_variants.ORIGINAL,
        );
        if (
          nonce.length !==
            sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES ||
          ciphertext.length < sodium.crypto_aead_xchacha20poly1305_ietf_ABYTES
        ) {
          throw new Error("invalid envelope lengths");
        }
        return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
          null,
          ciphertext,
          associatedData(domain, metadata, envelope.encryptionKeyId),
          nonce,
          key,
        );
      } catch {
        throw new ProtectedDataError(
          "Protected data authentication failed",
          "authentication_failed",
        );
      }
    },
  };
}
