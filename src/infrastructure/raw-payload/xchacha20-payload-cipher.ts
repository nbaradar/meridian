import { createHash } from "node:crypto";

import sodium from "libsodium-wrappers";

import {
  rawPayloadEnvelopeSchema,
  sha256DigestSchema,
  sourceNameSchema,
  type RawPayloadCipher,
  type RawPayloadEnvelope,
} from "../../core/ledger";
import type { RawPayloadEncryptionEnvironment } from "../database/environment";

const algorithm = "xchacha20-poly1305-ietf" as const;
const textEncoder = new TextEncoder();

function associatedData(
  source: string,
  contentDigest: string,
  encryptionKeyId: string,
): Uint8Array {
  return textEncoder.encode(
    JSON.stringify({
      algorithm,
      contentDigest,
      encryptionKeyId,
      source,
    }),
  );
}

export function createXChaCha20PayloadCipher(
  environment: RawPayloadEncryptionEnvironment,
): RawPayloadCipher {
  const key = Buffer.from(environment.RAW_PAYLOAD_ENCRYPTION_KEY, "base64");

  return {
    async seal(sourceInput, plaintext) {
      await sodium.ready;
      const source = sourceNameSchema.parse(sourceInput);
      const contentDigest = sha256DigestSchema.parse(
        createHash("sha256").update(plaintext).digest("hex"),
      );
      const nonce = sodium.randombytes_buf(
        sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES,
      );
      const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
        plaintext,
        associatedData(source, contentDigest, environment.RAW_PAYLOAD_KEY_ID),
        null,
        nonce,
        key,
      );

      return rawPayloadEnvelopeSchema.parse({
        source,
        contentDigest,
        encryptionAlgorithm: algorithm,
        encryptionKeyId: environment.RAW_PAYLOAD_KEY_ID,
        nonce: sodium.to_base64(nonce, sodium.base64_variants.ORIGINAL),
        ciphertext: sodium.to_base64(
          ciphertext,
          sodium.base64_variants.ORIGINAL,
        ),
      });
    },

    async open(envelopeInput: RawPayloadEnvelope) {
      await sodium.ready;
      const envelope = rawPayloadEnvelopeSchema.parse(envelopeInput);
      if (envelope.encryptionKeyId !== environment.RAW_PAYLOAD_KEY_ID) {
        throw new Error(
          `Raw payload key ${envelope.encryptionKeyId} is not available`,
        );
      }

      const plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
        null,
        sodium.from_base64(
          envelope.ciphertext,
          sodium.base64_variants.ORIGINAL,
        ),
        associatedData(
          envelope.source,
          envelope.contentDigest,
          envelope.encryptionKeyId,
        ),
        sodium.from_base64(envelope.nonce, sodium.base64_variants.ORIGINAL),
        key,
      );
      const digest = createHash("sha256").update(plaintext).digest("hex");
      if (digest !== envelope.contentDigest) {
        throw new Error("Raw payload digest does not match decrypted content");
      }
      return plaintext;
    },
  };
}
