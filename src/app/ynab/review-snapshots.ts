import { randomUUID } from "node:crypto";

import type { YnabAccountCandidate } from "@/modules/ynab";

interface SnapshotEntry {
  candidates: readonly YnabAccountCandidate[];
  expiresAt: number;
  expirationTimer: ReturnType<typeof setTimeout>;
}

export class YnabReviewSnapshotStore {
  readonly #entries = new Map<string, SnapshotEntry>();

  constructor(
    readonly lifetimeMilliseconds: number,
    readonly maximumEntries: number,
    readonly now: () => number = Date.now,
  ) {}

  create(candidates: readonly YnabAccountCandidate[]): string {
    this.#removeExpired();
    while (this.#entries.size >= this.maximumEntries) {
      const oldestToken = this.#entries.keys().next().value as
        string | undefined;
      if (!oldestToken) break;
      this.#remove(oldestToken);
    }

    const token = randomUUID();
    const expirationTimer = setTimeout(
      () => this.#remove(token),
      this.lifetimeMilliseconds,
    );
    expirationTimer.unref?.();
    this.#entries.set(token, {
      candidates,
      expiresAt: this.now() + this.lifetimeMilliseconds,
      expirationTimer,
    });
    return token;
  }

  get(token: string): readonly YnabAccountCandidate[] | null {
    this.#removeExpired();
    return this.#entries.get(token)?.candidates ?? null;
  }

  #removeExpired(): void {
    const now = this.now();
    for (const [token, entry] of this.#entries) {
      if (entry.expiresAt <= now) this.#remove(token);
    }
  }

  #remove(token: string): void {
    const entry = this.#entries.get(token);
    if (entry) clearTimeout(entry.expirationTimer);
    this.#entries.delete(token);
  }
}
