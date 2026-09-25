import { describe, expect, test } from "vitest";

import {
  ProtectedDataError,
  credentialContextSchema,
  createCredentialEnvelopeProtector,
  createProviderIdentityEnvelopeProtector,
  createProviderIdentityLookup,
  createProviderIdentityLookupKeyring,
  createXChaCha20Poly1305Keyring,
  providerIdentityContextSchema,
} from "../src/infrastructure/protected-data";
import {
  credentialEnvelopeSchema as coreCredentialEnvelopeSchema,
  protectedProviderIdentitySchema,
} from "../src/core/connections";

const oldKey = Buffer.alloc(32, 11).toString("base64");
const currentKey = Buffer.alloc(32, 22).toString("base64");
const wrongKey = Buffer.alloc(32, 33).toString("base64");
const lookupKey = Buffer.alloc(32, 44).toString("base64");
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const credentialContext = credentialContextSchema.parse({
  source: "simplefin",
  connectionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  credentialGeneration: 7n,
  authorizationClass: "read_only",
  keyStatus: "active",
});

const identityContext = providerIdentityContextSchema.parse({
  source: "simplefin",
  connectionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  discoveredAccountId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  keyStatus: "active",
});

function keyring(currentKeyId = "enc-v2") {
  return createXChaCha20Poly1305Keyring({
    currentKeyId,
    keys: { "enc-v1": oldKey, "enc-v2": currentKey },
  });
}

describe("protected-data XChaCha20-Poly1305 keyring", () => {
  test("round-trips bytes and uses a fresh nonce", async () => {
    const plaintext = encoder.encode("credential-secret-value");
    const first = await keyring().seal(
      "test.domain",
      { record: "one" },
      plaintext,
    );
    const second = await keyring().seal(
      "test.domain",
      { record: "one" },
      plaintext,
    );

    expect(first.encryptionKeyId).toBe("enc-v2");
    expect(first.nonce).not.toBe(second.nonce);
    expect(first.ciphertext).not.toBe(second.ciphertext);
    expect(JSON.stringify(first)).not.toContain("credential-secret-value");
    await expect(
      keyring().open("test.domain", { record: "one" }, first),
    ).resolves.toEqual(plaintext);
  });

  test("opens historical keys while sealing only with the current key", async () => {
    const historical = await keyring("enc-v1").seal(
      "test.domain",
      { record: "one" },
      encoder.encode("old secret"),
    );
    const rotated = keyring("enc-v2");

    await expect(
      rotated.open("test.domain", { record: "one" }, historical),
    ).resolves.toEqual(encoder.encode("old secret"));
    await expect(
      rotated.seal(
        "test.domain",
        { record: "one" },
        encoder.encode("new secret"),
      ),
    ).resolves.toMatchObject({ encryptionKeyId: "enc-v2" });
  });

  test("fails closed for metadata, ciphertext, domain, unavailable, and wrong keys", async () => {
    const envelope = await keyring().seal(
      "test.domain",
      { record: "one" },
      encoder.encode("never disclose this"),
    );
    const unavailable = createXChaCha20Poly1305Keyring({
      currentKeyId: "enc-v1",
      keys: { "enc-v1": oldKey },
    });
    const wrong = createXChaCha20Poly1305Keyring({
      currentKeyId: "enc-v2",
      keys: { "enc-v2": wrongKey },
    });

    await expect(
      keyring().open("test.domain", { record: "two" }, envelope),
    ).rejects.toMatchObject({
      code: "authentication_failed",
    });
    await expect(
      keyring().open("other.domain", { record: "one" }, envelope),
    ).rejects.toMatchObject({
      code: "authentication_failed",
    });
    await expect(
      keyring().open(
        "test.domain",
        { record: "one" },
        (() => {
          const ciphertext = Buffer.from(envelope.ciphertext, "base64");
          ciphertext[0] = (ciphertext[0] ?? 0) ^ 1;
          return { ...envelope, ciphertext: ciphertext.toString("base64") };
        })(),
      ),
    ).rejects.toBeInstanceOf(ProtectedDataError);
    await expect(
      unavailable.open("test.domain", { record: "one" }, envelope),
    ).rejects.toMatchObject({
      code: "key_unavailable",
    });
    await expect(
      wrong.open("test.domain", { record: "one" }, envelope),
    ).rejects.toMatchObject({
      code: "authentication_failed",
    });
  });

  test.each([
    "",
    "not-base64",
    Buffer.alloc(31).toString("base64"),
    `${currentKey.slice(0, -1)}A`,
  ])("strictly rejects malformed key material", (invalidKey) => {
    expect(() =>
      createXChaCha20Poly1305Keyring({
        currentKeyId: "enc-v1",
        keys: { "enc-v1": invalidKey },
      }),
    ).toThrow("Protected data keyring configuration is invalid");
  });
});

describe("credential envelopes", () => {
  test("bind all credential metadata and keep errors secret-safe", async () => {
    const protector = createCredentialEnvelopeProtector(keyring());
    const secret = "credential-secret-value";
    const envelope = await protector.seal(
      credentialContext,
      encoder.encode(secret),
    );

    expect(coreCredentialEnvelopeSchema.parse(envelope)).toEqual(envelope);

    await expect(protector.open(envelope)).resolves.toSatisfy(
      (value: Uint8Array) => decoder.decode(value) === secret,
    );

    for (const changed of [
      { ...envelope, source: "teller" },
      { ...envelope, connectionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" },
      { ...envelope, credentialGeneration: 8n },
      { ...envelope, authorizationClass: "trade" },
      { ...envelope, keyStatus: "retired" },
    ]) {
      try {
        await protector.open(changed);
        throw new Error("expected protected open to fail");
      } catch (error) {
        expect(String(error)).not.toContain(secret);
        expect(error).toBeInstanceOf(ProtectedDataError);
      }
    }
  });
});

describe("provider identity protection and lookup", () => {
  test("round-trips identity and binds source, connection, discovered account, and key ID", async () => {
    const lookup = createProviderIdentityLookup({
      keyId: "digest-v1",
      key: lookupKey,
    });
    const protector = createProviderIdentityEnvelopeProtector(
      keyring(),
      lookup,
    );
    const nativeIdentity = "provider-account-native-123";
    const envelope = await protector.seal(identityContext, nativeIdentity);

    expect(JSON.stringify(envelope)).not.toContain(nativeIdentity);
    expect(protectedProviderIdentitySchema.parse(envelope)).toEqual(envelope);
    await expect(protector.open(envelope)).resolves.toBe(nativeIdentity);

    for (const changed of [
      { ...envelope, source: "teller" },
      { ...envelope, connectionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" },
      {
        ...envelope,
        discoveredAccountId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      },
      { ...envelope, encryptionKeyId: "enc-v1" },
    ]) {
      await expect(protector.open(changed)).rejects.toBeInstanceOf(
        ProtectedDataError,
      );
    }
  });

  test("uses a stable domain-specific HMAC and varies by key and key ID", () => {
    const first = createProviderIdentityLookup({
      keyId: "digest-v1",
      key: lookupKey,
    });
    const same = createProviderIdentityLookup({
      keyId: "digest-v1",
      key: lookupKey,
    });
    const rotated = createProviderIdentityLookup({
      keyId: "digest-v2",
      key: wrongKey,
    });

    expect(first.digest("native-42")).toEqual(same.digest("native-42"));
    expect(first.digest("native-42").lookupDigest).not.toBe(
      first.digest("native-43").lookupDigest,
    );
    expect(rotated.digest("native-42")).not.toEqual(first.digest("native-42"));
    expect(first.digest("native-42").lookupDigest).toMatch(/^[0-9a-f]{64}$/u);
  });

  test("recomputes and authenticates lookup metadata after opening", async () => {
    const sealingLookup = createProviderIdentityLookup({
      keyId: "digest-v1",
      key: lookupKey,
    });
    const envelope = await createProviderIdentityEnvelopeProtector(
      keyring(),
      sealingLookup,
    ).seal(identityContext, "provider-account-native-123");
    const wrongDigestLookup = createProviderIdentityLookup({
      keyId: "digest-v1",
      key: wrongKey,
    });
    const wrongKeyIdLookup = createProviderIdentityLookup({
      keyId: "digest-v2",
      key: lookupKey,
    });

    await expect(
      createProviderIdentityEnvelopeProtector(
        keyring(),
        wrongDigestLookup,
      ).open(envelope),
    ).rejects.toMatchObject({ code: "authentication_failed" });
    await expect(
      createProviderIdentityEnvelopeProtector(keyring(), wrongKeyIdLookup).open(
        envelope,
      ),
    ).rejects.toMatchObject({ code: "authentication_failed" });
  });

  test("opens historical identity digests during lookup-key rotation", async () => {
    const historicalLookup = createProviderIdentityLookup({
      keyId: "digest-v1",
      key: lookupKey,
    });
    const envelope = await createProviderIdentityEnvelopeProtector(
      keyring(),
      historicalLookup,
    ).seal(identityContext, "provider-account-native-rotation");
    const rotatedLookup = createProviderIdentityLookupKeyring({
      currentKeyId: "digest-v2",
      keys: {
        "digest-v1": lookupKey,
        "digest-v2": wrongKey,
      },
    });
    const protector = createProviderIdentityEnvelopeProtector(
      keyring(),
      rotatedLookup,
    );
    await expect(protector.open(envelope)).resolves.toBe(
      "provider-account-native-rotation",
    );
    expect(
      rotatedLookup.digest("provider-account-native-rotation").digestKeyId,
    ).toBe("digest-v2");
  });

  test("does not disclose native identities in validation or authentication errors", async () => {
    const nativeIdentity = "do-not-leak-provider-id";
    const lookup = createProviderIdentityLookup({
      keyId: "digest-v1",
      key: lookupKey,
    });
    const protector = createProviderIdentityEnvelopeProtector(
      keyring(),
      lookup,
    );
    const envelope = await protector.seal(identityContext, nativeIdentity);

    try {
      await protector.open({ ...envelope, lookupDigest: "invalid" });
      throw new Error("expected protected open to fail");
    } catch (error) {
      expect(String(error)).not.toContain(nativeIdentity);
      expect(error).toBeInstanceOf(ProtectedDataError);
    }
  });
});
