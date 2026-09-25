import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { beforeAll, describe, expect, test } from "vitest";

import { createYnabLabelDigester } from "../src/infrastructure/ynab/label-digest";
import {
  parseYnabPlanCsv,
  parseYnabRegisterCsv,
  planYnabImport,
  resolveYnabAccountDecision,
  YnabAccountMappingError,
  type YnabAccountCandidate,
} from "../src/modules/ynab";

const oldKey = randomBytes(32).toString("base64");
const currentKey = randomBytes(32).toString("base64");
const digester = createYnabLabelDigester({
  YNAB_LABEL_DIGEST_CURRENT_KEY_ID: "current",
  YNAB_LABEL_DIGEST_KEYRING: { old: oldKey, current: currentKey },
});

describe("YNAB label digests", () => {
  test("are keyed, deterministic, NFC-normalized, and never echo the name", () => {
    const name = "Café Checking – 1234";
    const digest = digester.digest(name);
    expect(digest.digestKeyId).toBe("current");
    expect(digest.labelDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(digester.digest(name)).toEqual(digest);
    expect(digester.digest(name.normalize("NFD"))).toEqual(digest);
    expect(digester.digest(name, "old").labelDigest).not.toBe(
      digest.labelDigest,
    );
    expect(JSON.stringify(digest)).not.toContain("1234");

    const otherInstallation = createYnabLabelDigester({
      YNAB_LABEL_DIGEST_CURRENT_KEY_ID: "current",
      YNAB_LABEL_DIGEST_KEYRING: {
        current: randomBytes(32).toString("base64"),
      },
    });
    expect(otherInstallation.digest(name).labelDigest).not.toBe(
      digest.labelDigest,
    );
  });

  test("lists the current key first and fails closed for unknown keys", () => {
    expect(digester.keyIds()).toEqual(["current", "old"]);
    expect(() => digester.digest("Account", "missing")).toThrow(
      "YNAB label digest key is unavailable: missing",
    );
    expect(() => digester.digest("")).toThrow("must not be empty");
  });
});

describe("single YNAB account decisions", () => {
  let candidates: readonly YnabAccountCandidate[];
  beforeAll(async () => {
    const [plan, register] = await Promise.all([
      readFile(new URL("./fixtures/ynab/plan.csv", import.meta.url)),
      readFile(new URL("./fixtures/ynab/register.csv", import.meta.url)),
    ]);
    candidates = planYnabImport(
      parseYnabPlanCsv(plan),
      parseYnabRegisterCsv(register),
    ).accounts;
  });

  const context = (excluded: string[], renameable: string[] = []) => ({
    currentAccounts: [],
    renameableSourceIds: new Set(renameable),
    excludedSourceNames: new Set(excluded),
  });

  test("rejects including an account that transfers to an excluded one", () => {
    expect(() =>
      resolveYnabAccountDecision(candidates, context(["Example Card"]), {
        sourceName: "Example Checking",
        action: "create",
        name: "Checking",
        accountType: "checking",
        accountClass: null,
        openedOn: null,
      }),
    ).toThrow(
      "Cannot include YNAB account Example Checking: it has transfers to excluded accounts (Example Card). Include those accounts too.",
    );
    expect(
      resolveYnabAccountDecision(
        candidates,
        context(["Example Card", "Example Checking"]),
        { sourceName: "Example Checking", action: "exclude" },
      ),
    ).toEqual({ sourceName: "Example Checking", action: "exclude" });
  });

  test("accepts a rename only onto a saved YNAB source", () => {
    const accountSourceId = randomUUID();
    expect(
      resolveYnabAccountDecision(candidates, context([], [accountSourceId]), {
        sourceName: "Wallet",
        action: "renamed",
        accountSourceId,
      }),
    ).toEqual({ sourceName: "Wallet", action: "renamed", accountSourceId });

    let rejection: unknown;
    try {
      resolveYnabAccountDecision(candidates, context([]), {
        sourceName: "Wallet",
        action: "renamed",
        accountSourceId,
      });
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBeInstanceOf(YnabAccountMappingError);
    expect((rejection as YnabAccountMappingError).sourceName).toBe("Wallet");
  });
});
