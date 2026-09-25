import { describe, expect, test } from "vitest";

import { assertNoSecretFields, sourceNameSchema } from "../src/core/ledger";
import { createXChaCha20PayloadCipher } from "../src/infrastructure/raw-payload/xchacha20-payload-cipher";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const key = Buffer.alloc(32, 11).toString("base64");

function cipher(keyId = "test-v1", encryptionKey = key) {
  return createXChaCha20PayloadCipher({
    RAW_PAYLOAD_KEY_ID: keyId,
    RAW_PAYLOAD_ENCRYPTION_KEY: encryptionKey,
  });
}

describe("raw payload encryption", () => {
  test("round-trips plaintext without retaining it in the envelope", async () => {
    const plaintext = textEncoder.encode("sensitive,ynab,csv\nrow,one,42");
    const envelope = await cipher().seal("ynab-csv", plaintext);

    expect(envelope.encryptionAlgorithm).toBe("xchacha20-poly1305-ietf");
    expect(envelope.encryptionKeyId).toBe("test-v1");
    expect(envelope.contentDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(JSON.stringify(envelope)).not.toContain("sensitive,ynab,csv");
    await expect(cipher().open(envelope)).resolves.toEqual(plaintext);
  });

  test("uses a fresh nonce for the same plaintext", async () => {
    const plaintext = textEncoder.encode("same content");
    const first = await cipher().seal("ynab-csv", plaintext);
    const second = await cipher().seal("ynab-csv", plaintext);

    expect(first.contentDigest).toBe(second.contentDigest);
    expect(first.nonce).not.toBe(second.nonce);
    expect(first.ciphertext).not.toBe(second.ciphertext);
  });

  test("rejects tampered ciphertext and authenticated metadata", async () => {
    const envelope = await cipher().seal(
      "ynab-csv",
      textEncoder.encode("original"),
    );
    const ciphertext = Buffer.from(envelope.ciphertext, "base64");
    ciphertext[0] = (ciphertext[0] ?? 0) ^ 1;

    await expect(
      cipher().open({
        ...envelope,
        ciphertext: ciphertext.toString("base64"),
      }),
    ).rejects.toBeDefined();
    await expect(
      cipher().open({
        ...envelope,
        source: sourceNameSchema.parse("different-source"),
      }),
    ).rejects.toBeDefined();
  });

  test("fails closed when the envelope key is unavailable", async () => {
    const envelope = await cipher().seal(
      "ynab-csv",
      textEncoder.encode("original"),
    );

    await expect(cipher("test-v2").open(envelope)).rejects.toThrow(
      "Raw payload key test-v1 is not available",
    );
  });

  test("returns the original bytes rather than decoded or normalized text", async () => {
    const plaintext = new Uint8Array([0, 255, 13, 10, 44, 0]);
    const envelope = await cipher().seal("binary-fixture", plaintext);
    const opened = await cipher().open(envelope);

    expect(opened).toEqual(plaintext);
    expect(() => textDecoder.decode(opened, { stream: false })).not.toThrow();
  });
});

describe("raw payload secret policy", () => {
  test.each([
    { accessToken: "secret" },
    { nested: { refresh_token: "secret" } },
    { rows: [{ password: "secret" }] },
    { Authorization: "Bearer secret" },
  ])("rejects forbidden credential fields", (payload) => {
    expect(() => assertNoSecretFields(payload)).toThrow(
      "Raw payload contains forbidden secret field",
    );
  });

  test("allows provider identifiers and ordinary transaction fields", () => {
    expect(() =>
      assertNoSecretFields({
        providerItemId: "item-redacted-1",
        sourceRef: "transaction-42",
        amount: "12.34",
      }),
    ).not.toThrow();
  });
});
