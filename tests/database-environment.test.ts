import { describe, expect, test } from "vitest";

import {
  databaseEnvironment,
  credentialProtectionEnvironment,
  identityProtectionEnvironment,
  migrationEnvironment,
  operationalDatabaseEnvironment,
  rawPayloadEncryptionEnvironment,
} from "../src/infrastructure/database/environment";

describe("database environment", () => {
  test("accepts a PostgreSQL connection URL", () => {
    expect(
      databaseEnvironment({
        DATABASE_URL: "postgresql://meridian:meridian@localhost:5432/meridian",
      }),
    ).toEqual({
      DATABASE_URL: "postgresql://meridian:meridian@localhost:5432/meridian",
    });
  });

  test("accepts a migration owner connection URL", () => {
    expect(
      migrationEnvironment({
        DATABASE_OWNER_URL:
          "postgresql://meridian:meridian@localhost:5432/meridian",
      }),
    ).toEqual({
      DATABASE_OWNER_URL:
        "postgresql://meridian:meridian@localhost:5432/meridian",
    });
  });

  test("accepts separate operational database roles", () => {
    expect(
      operationalDatabaseEnvironment({
        OPS_CONTROL_DATABASE_URL:
          "postgresql://meridian_ops_control:test@localhost:5432/meridian",
        READ_WORKER_DATABASE_URL:
          "postgresql://meridian_read_worker:test@localhost:5432/meridian",
      }),
    ).toMatchObject({
      OPS_CONTROL_DATABASE_URL: expect.stringContaining("meridian_ops_control"),
      READ_WORKER_DATABASE_URL: expect.stringContaining("meridian_read_worker"),
    });
  });

  test("accepts separate versioned operational keyrings", () => {
    const credentialKey = Buffer.alloc(32, 1).toString("base64");
    const identityKey = Buffer.alloc(32, 2).toString("base64");
    const digestKey = Buffer.alloc(32, 3).toString("base64");
    const credential = credentialProtectionEnvironment({
      OPS_CREDENTIAL_CURRENT_KEY_ID: "credential-v1",
      OPS_CREDENTIAL_KEYRING: JSON.stringify({
        "credential-v1": credentialKey,
      }),
    });
    const identity = identityProtectionEnvironment({
      OPS_IDENTITY_CURRENT_KEY_ID: "identity-v1",
      OPS_IDENTITY_KEYRING: JSON.stringify({ "identity-v1": identityKey }),
      OPS_IDENTITY_DIGEST_CURRENT_KEY_ID: "digest-v1",
      OPS_IDENTITY_DIGEST_KEYRING: JSON.stringify({ "digest-v1": digestKey }),
    });
    expect(credential.OPS_CREDENTIAL_KEYRING["credential-v1"]).toBe(
      credentialKey,
    );
    expect(identity.OPS_IDENTITY_KEYRING["identity-v1"]).toBe(identityKey);
    expect(identity.OPS_IDENTITY_DIGEST_KEYRING["digest-v1"]).toBe(digestKey);
  });

  test("rejects missing current operational keys and malformed keyrings", () => {
    const key = Buffer.alloc(32, 4).toString("base64");
    expect(() =>
      credentialProtectionEnvironment({
        OPS_CREDENTIAL_CURRENT_KEY_ID: "missing",
        OPS_CREDENTIAL_KEYRING: JSON.stringify({ present: key }),
      }),
    ).toThrow();
    expect(() =>
      identityProtectionEnvironment({
        OPS_IDENTITY_CURRENT_KEY_ID: "identity-v1",
        OPS_IDENTITY_KEYRING: JSON.stringify({ "identity-v1": key }),
        OPS_IDENTITY_DIGEST_CURRENT_KEY_ID: "digest-v1",
        OPS_IDENTITY_DIGEST_KEYRING: "not-json",
      }),
    ).toThrow();
  });

  test.each([undefined, "", "https://localhost/meridian", "not a url"])(
    "rejects invalid DATABASE_URL %s",
    (databaseUrl) => {
      expect(() =>
        databaseEnvironment({ DATABASE_URL: databaseUrl }),
      ).toThrow();
    },
  );

  test.each([undefined, "", "https://localhost/meridian", "not a url"])(
    "rejects invalid DATABASE_OWNER_URL %s",
    (databaseOwnerUrl) => {
      expect(() =>
        migrationEnvironment({ DATABASE_OWNER_URL: databaseOwnerUrl }),
      ).toThrow();
    },
  );

  test("accepts a versioned 32-byte raw-payload key", () => {
    const key = Buffer.alloc(32, 7).toString("base64");
    expect(
      rawPayloadEncryptionEnvironment({
        RAW_PAYLOAD_KEY_ID: "local-v1",
        RAW_PAYLOAD_ENCRYPTION_KEY: key,
      }),
    ).toEqual({
      RAW_PAYLOAD_KEY_ID: "local-v1",
      RAW_PAYLOAD_ENCRYPTION_KEY: key,
    });
  });

  test.each([undefined, "", "not-base64", Buffer.alloc(31).toString("base64")])(
    "rejects invalid raw-payload encryption key %s",
    (key) => {
      expect(() =>
        rawPayloadEncryptionEnvironment({
          RAW_PAYLOAD_KEY_ID: "local-v1",
          RAW_PAYLOAD_ENCRYPTION_KEY: key,
        }),
      ).toThrow();
    },
  );
});
