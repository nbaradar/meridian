import { afterEach, describe, expect, test, vi } from "vitest";

import { YnabReviewSnapshotStore } from "../src/app/ynab/review-snapshots";
import { decimalAmountSchema } from "../src/core/ledger";
import type { YnabAccountCandidate } from "../src/modules/ynab";

const candidate: YnabAccountCandidate = {
  sourceName: "Synthetic account",
  suggestedType: null,
  suggestionReason: null,
  activity: {
    registerRowCount: 0,
    firstOccurredOn: null,
    lastOccurredOn: null,
    workingBalance: decimalAmountSchema.parse("0"),
    transferReferences: [],
    sharedSuffixWith: [],
  },
};

afterEach(() => vi.useRealTimers());

describe("YNAB review snapshots", () => {
  test("evicts the oldest snapshot at the configured bound", () => {
    const store = new YnabReviewSnapshotStore(60_000, 2);
    const first = store.create([candidate]);
    const second = store.create([candidate]);
    const third = store.create([candidate]);

    expect(store.get(first)).toBeNull();
    expect(store.get(second)).toEqual([candidate]);
    expect(store.get(third)).toEqual([candidate]);
  });

  test("removes private snapshot data when its timer expires", () => {
    vi.useFakeTimers();
    const store = new YnabReviewSnapshotStore(1_000, 2);
    const token = store.create([candidate]);

    vi.advanceTimersByTime(1_000);
    expect(store.get(token)).toBeNull();
  });
});
