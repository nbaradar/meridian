import { randomUUID } from "node:crypto";

import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { ZodError } from "zod";

import {
  accountIdSchema,
  accountSourceIdSchema,
  authorityRevisionIdSchema,
  authorityWindowIdSchema,
  calendarDateSchema,
  createTransactionAuthorityService,
  decimalAmountSchema,
  deriveReconciliationResult,
  evaluateTransactionAuthority,
  reconciliationDifference,
  reviewedBalancePolicies,
  reviewedBalancePolicySchema,
  reviewedTolerance,
  TransactionAuthorityConflictError,
  utcTimestampSchema,
  type AuthorityRevision,
  type AuthorityStatus,
  type NewAuthorityRevision,
  type NewReconciliationCheck,
  type ReconciliationCheck,
  type TransactionAuthorityStore,
} from "../src/core/ledger";

const amount = (value: string) => decimalAmountSchema.parse(value);
const date = (value: string) => calendarDateSchema.parse(value);
const now = utcTimestampSchema.parse("2026-09-25T00:00:00Z");
const accountId = accountIdSchema.parse(randomUUID());
const ynabSource = accountSourceIdSchema.parse(randomUUID());
const liveSource = accountSourceIdSchema.parse(randomUUID());

function window(
  accountSourceId: typeof ynabSource,
  startsOn: string,
  endsOn: string | null,
  status: AuthorityStatus = "active",
): AuthorityRevision {
  return {
    id: authorityRevisionIdSchema.parse(randomUUID()),
    authorityWindowId: authorityWindowIdSchema.parse(randomUUID()),
    accountId,
    accountSourceId,
    startsOn: date(startsOn),
    endsOn: endsOn === null ? null : date(endsOn),
    status,
    supersedesRevisionId: null,
    reasonCode: status === "active" ? "window_activated" : "window_proposed",
    reconciliationCheckId: null,
    recordedAt: now,
  };
}

describe("authority evaluation", () => {
  const ynab = window(ynabSource, "2020-01-01", "2026-09-01");
  const live = window(liveSource, "2026-09-01", null);
  const evaluate = (
    windows: readonly AuthorityRevision[],
    accountSourceId: typeof ynabSource,
    occurredOn: string,
  ) =>
    evaluateTransactionAuthority(windows, {
      accountId,
      accountSourceId,
      occurredOn: date(occurredOn),
    });

  test("half-open windows select exactly one source at the cutoff", () => {
    expect(evaluate([ynab, live], ynabSource, "2026-08-31")).toEqual({
      status: "authorized",
      window: ynab,
    });
    expect(evaluate([ynab, live], liveSource, "2026-09-01")).toEqual({
      status: "authorized",
      window: live,
    });
    expect(evaluate([ynab, live], ynabSource, "2026-09-01")).toEqual({
      status: "wrong_source",
      window: live,
    });
    expect(evaluate([ynab, live], liveSource, "2026-08-31")).toEqual({
      status: "wrong_source",
      window: ynab,
    });
    expect(evaluate([ynab, live], ynabSource, "2020-01-01").status).toBe(
      "authorized",
    );
  });

  test("gaps, proposed, revoked, and other accounts' windows never authorize", () => {
    expect(evaluate([ynab], ynabSource, "2019-12-31")).toEqual({
      status: "no_window",
    });
    expect(evaluate([ynab], liveSource, "2026-10-01")).toEqual({
      status: "no_window",
    });
    for (const status of ["proposed", "revoked"] as const) {
      expect(
        evaluate(
          [window(ynabSource, "2020-01-01", null, status)],
          ynabSource,
          "2024-01-01",
        ),
      ).toEqual({ status: "no_window" });
    }
    const otherAccount = {
      ...ynab,
      accountId: accountIdSchema.parse(randomUUID()),
    };
    expect(evaluate([otherAccount], ynabSource, "2024-01-01")).toEqual({
      status: "no_window",
    });
  });

  test("overlapping active windows fail closed", () => {
    const overlapping = window(liveSource, "2026-08-01", null);
    expect(evaluate([ynab, overlapping], ynabSource, "2026-08-15")).toEqual({
      status: "conflicting_windows",
      windows: [ynab, overlapping],
    });
  });

  test("every date selects at most one window from an adjacent schedule", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 3650 }),
        fc.integer({ min: 0, max: 7300 }),
        (cutoffOffset, dateOffset) => {
          const day = (offset: number) =>
            new Date(Date.UTC(2015, 0, 1 + offset)).toISOString().slice(0, 10);
          const cutoff = day(cutoffOffset);
          const windows = [
            window(ynabSource, "2015-01-01", cutoff),
            window(liveSource, cutoff, null),
          ];
          const occurredOn = day(dateOffset);
          const result = evaluate(windows, liveSource, occurredOn);
          expect(result.status).toBe(
            occurredOn >= cutoff ? "authorized" : "wrong_source",
          );
        },
      ),
    );
  });
});

describe("reconciliation arithmetic", () => {
  test("derives results from a reviewed tolerance only", () => {
    expect(deriveReconciliationResult(amount("0"), null)).toBe(
      "not_comparable",
    );
    expect(deriveReconciliationResult(amount("0.004"), amount("0.005"))).toBe(
      "passed",
    );
    expect(deriveReconciliationResult(amount("-0.005"), amount("0.005"))).toBe(
      "passed",
    );
    expect(deriveReconciliationResult(amount("0.0051"), amount("0.005"))).toBe(
      "failed",
    );
    expect(deriveReconciliationResult(amount("-1"), amount("0"))).toBe(
      "failed",
    );
  });

  test("is exact for very large and fractional values", () => {
    const provider = amount(
      "123456789012345678901234567890.000000000000000001",
    );
    const ledger = amount("123456789012345678901234567890");
    const difference = reconciliationDifference(provider, ledger);
    expect(difference).toBe("0.000000000000000001");
    expect(
      deriveReconciliationResult(difference, amount("0.000000000000000001")),
    ).toBe("passed");
    expect(
      deriveReconciliationResult(difference, amount("0.0000000000000000009")),
    ).toBe("failed");
    expect(
      reconciliationDifference(
        amount("-99999999999999999999999.99"),
        amount("0.01"),
      ),
    ).toBe("-100000000000000000000000");
  });

  test("matches exact decimal arithmetic for arbitrary amounts", () => {
    const big = fc.bigInt({ min: -(10n ** 40n), max: 10n ** 40n });
    fc.assert(
      fc.property(
        big,
        big,
        big,
        (providerUnits, ledgerUnits, toleranceUnits) => {
          // Exact fixed-point rendering with 12 fraction digits; no rounding.
          const scaled = (units: bigint) => {
            const negative = units < 0n;
            const digits = (negative ? -units : units)
              .toString()
              .padStart(13, "0");
            const fraction = digits.slice(-12).replace(/0+$/u, "");
            const text = `${negative ? "-" : ""}${digits.slice(0, -12)}${fraction ? `.${fraction}` : ""}`;
            return amount(text === "-0" ? "0" : text);
          };
          const tolerance = scaled(
            toleranceUnits < 0n ? -toleranceUnits : toleranceUnits,
          );
          const difference = reconciliationDifference(
            scaled(providerUnits),
            scaled(ledgerUnits),
          );
          const expectedUnits = providerUnits - ledgerUnits;
          expect(difference).toBe(scaled(expectedUnits));
          const absolute = expectedUnits < 0n ? -expectedUnits : expectedUnits;
          const toleranceAbsolute =
            toleranceUnits < 0n ? -toleranceUnits : toleranceUnits;
          expect(deriveReconciliationResult(difference, tolerance)).toBe(
            absolute <= toleranceAbsolute ? "passed" : "failed",
          );
        },
      ),
    );
  });
});

describe("reviewed balance policies", () => {
  test("the production registry is empty and frozen", () => {
    expect(reviewedBalancePolicies).toEqual([]);
    expect(Object.isFrozen(reviewedBalancePolicies)).toBe(true);
    expect(
      reviewedTolerance(reviewedBalancePolicies, "simplefin", "current"),
    ).toBe(null);
  });

  test("never makes an unknown semantic comparable", () => {
    expect(() =>
      reviewedBalancePolicySchema.parse({
        provider: "simplefin",
        semantic: "unknown",
        tolerance: "0",
      }),
    ).toThrow(ZodError);
    expect(() =>
      reviewedBalancePolicySchema.parse({
        provider: "simplefin",
        semantic: "current",
        tolerance: "-0.01",
      }),
    ).toThrow(ZodError);
    const policy = reviewedBalancePolicySchema.parse({
      provider: "simplefin",
      semantic: "current",
      tolerance: "0.01",
    });
    expect(reviewedTolerance([policy], "simplefin", "unknown")).toBeNull();
    expect(reviewedTolerance([policy], "simplefin", "available")).toBeNull();
    expect(reviewedTolerance([policy], "teller", "current")).toBeNull();
    expect(reviewedTolerance([policy], "simplefin", "current")).toBe("0.01");
    expect(() =>
      reviewedTolerance([policy, policy], "simplefin", "current"),
    ).toThrow(/ambiguous/u);
  });
});

function memoryStore() {
  const revisions: AuthorityRevision[] = [];
  const checks: ReconciliationCheck[] = [];
  const store: TransactionAuthorityStore = {
    findAccountSource: async (id) => ({
      id,
      source: id === liveSource ? "simplefin" : "ynab",
      sourceKind: id === liveSource ? "connector" : "import",
    }),
    findRevision: async (id) =>
      revisions.find((item) => item.id === id) ?? null,
    appendRevision: async (revision: NewAuthorityRevision) => {
      if (revisions.some((item) => item.id === revision.id)) return "replayed";
      revisions.push({ ...revision, recordedAt: now });
      return "recorded";
    },
    listCurrentWindows: async () =>
      revisions.filter(
        (item) =>
          !revisions.some(
            (successor) => successor.supersedesRevisionId === item.id,
          ),
      ),
    ledgerBalanceBefore: async () => amount("1000.5"),
    recordReconciliationCheck: async (check: NewReconciliationCheck) => {
      checks.push({
        ...check,
        ledgerBalance: amount("1000.5"),
        difference: reconciliationDifference(
          check.providerBalance,
          amount("1000.5"),
        ),
        recordedAt: now,
      });
      return "recorded";
    },
    findReconciliationCheck: async (id) =>
      checks.find((item) => item.id === id) ?? null,
  };
  return { store, revisions, checks };
}

describe("transaction authority service", () => {
  const checkCommand = (providerBalance: string, semantic = "current") => ({
    checkId: randomUUID(),
    accountId,
    accountSourceId: liveSource,
    cutoffOn: "2026-09-01",
    observationStartsOn: "2026-08-01",
    observationEndsOn: "2026-09-01",
    providerBalance,
    balanceSemantic: semantic,
    rawPayloadId: null,
  });

  test("production wiring makes every check not comparable", async () => {
    const { store } = memoryStore();
    const service = createTransactionAuthorityService(store);
    for (const semantic of [
      "current",
      "available",
      "posted_only",
      "includes_pending",
      "unknown",
    ]) {
      const { check } = await service.recordReconciliationCheck(
        checkCommand("1000.5", semantic),
      );
      expect(check).toMatchObject({
        result: "not_comparable",
        tolerance: null,
        difference: "0",
      });
    }
  });

  test("an injected reviewed policy yields passed within and at tolerance, failed beyond", async () => {
    const { store } = memoryStore();
    const service = createTransactionAuthorityService(store, {
      policies: [
        reviewedBalancePolicySchema.parse({
          provider: "simplefin",
          semantic: "current",
          tolerance: "0.01",
        }),
      ],
    });
    const result = async (providerBalance: string) =>
      (await service.recordReconciliationCheck(checkCommand(providerBalance)))
        .check.result;
    expect(await result("1000.505")).toBe("passed");
    expect(await result("1000.49")).toBe("passed");
    expect(await result("1000.51")).toBe("passed");
    expect(await result("1000.5101")).toBe("failed");
    expect(await result("1000.4899")).toBe("failed");
    expect(
      (
        await service.recordReconciliationCheck(
          checkCommand("1000.5", "unknown"),
        )
      ).check.result,
    ).toBe("not_comparable");
  });

  test("replays a check exactly and rejects a conflicting replay", async () => {
    const { store, checks } = memoryStore();
    const service = createTransactionAuthorityService(store);
    const command = checkCommand("5");
    await service.recordReconciliationCheck(command);
    await expect(
      service.recordReconciliationCheck(command),
    ).resolves.toMatchObject({ outcome: "replayed" });
    await expect(
      service.recordReconciliationCheck({ ...command, providerBalance: "6" }),
    ).rejects.toBeInstanceOf(TransactionAuthorityConflictError);
    expect(checks).toHaveLength(1);
  });

  test("proposes, activates, and revokes by appending successors", async () => {
    const { store, revisions } = memoryStore();
    const service = createTransactionAuthorityService(store);
    const proposed = await service.proposeWindow({
      revisionId: randomUUID(),
      authorityWindowId: randomUUID(),
      accountId,
      accountSourceId: ynabSource,
      startsOn: "2020-01-01",
      endsOn: "2026-09-01",
    });
    const activated = await service.activateWindow({
      revisionId: randomUUID(),
      supersedesRevisionId: proposed.id,
      reconciliationCheckId: null,
    });
    await service.revokeWindow({
      revisionId: randomUUID(),
      supersedesRevisionId: activated.id,
      reasonCode: "owner_revoked",
    });
    expect(revisions.map((item) => [item.status, item.reasonCode])).toEqual([
      ["proposed", "window_proposed"],
      ["active", "window_activated"],
      ["revoked", "owner_revoked"],
    ]);
    expect(new Set(revisions.map((item) => item.authorityWindowId)).size).toBe(
      1,
    );
    await expect(
      service.activateWindow({
        revisionId: randomUUID(),
        supersedesRevisionId: revisions[2]!.id,
        reconciliationCheckId: null,
      }),
    ).rejects.toBeInstanceOf(TransactionAuthorityConflictError);
  });

  test("rejects malformed windows", async () => {
    const { store } = memoryStore();
    const service = createTransactionAuthorityService(store);
    const base = {
      revisionId: randomUUID(),
      authorityWindowId: randomUUID(),
      accountId,
      accountSourceId: ynabSource,
      startsOn: "2026-09-01",
      endsOn: null,
    };
    for (const invalid of [
      { ...base, endsOn: "2026-09-01" },
      { ...base, endsOn: "2026-08-31" },
      { ...base, startsOn: "2026-02-30" },
      { ...base, status: "active" },
    ]) {
      await expect(service.proposeWindow(invalid)).rejects.toBeInstanceOf(
        ZodError,
      );
    }
    await expect(
      service.revokeWindow({
        revisionId: randomUUID(),
        supersedesRevisionId: randomUUID(),
        reasonCode: "window_activated",
      }),
    ).rejects.toBeInstanceOf(ZodError);
  });
});
