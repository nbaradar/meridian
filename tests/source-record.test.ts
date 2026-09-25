import { randomUUID } from "node:crypto";

import { describe, expect, test } from "vitest";

import { sha256DigestSchema, sourceRecordSchema } from "../src/core/ledger";

describe("source records", () => {
  test("accepts an immutable external-record version", () => {
    const record = {
      id: randomUUID(),
      source: "ynab-csv",
      sourceRef: "row-42",
      contentDigest: "a".repeat(64),
      rawPayloadId: randomUUID(),
      supersedesSourceRecordId: null,
      ingestedAt: "2026-08-02T00:00:00Z",
    };

    expect(sourceRecordSchema.parse(record)).toMatchObject(record);
  });

  test.each(["", "a".repeat(63), "A".repeat(64), "g".repeat(64)])(
    "rejects invalid SHA-256 digest %s",
    (digest) => {
      expect(sha256DigestSchema.safeParse(digest).success).toBe(false);
    },
  );

  test("rejects a source-record version that supersedes itself", () => {
    const id = randomUUID();
    expect(
      sourceRecordSchema.safeParse({
        id,
        source: "ynab-csv",
        sourceRef: "row-42",
        contentDigest: "a".repeat(64),
        rawPayloadId: randomUUID(),
        supersedesSourceRecordId: id,
        ingestedAt: "2026-08-02T00:00:00Z",
      }).success,
    ).toBe(false);
  });
});
