import { randomUUID } from "node:crypto";

interface SnapshotEntry<T> {
  snapshot: T;
  expiresAt: number;
  expirationTimer: ReturnType<typeof setTimeout>;
}

/** Bounded, expiring in-memory storage for one review's private data. */
export class YnabReviewSnapshotStore<T> {
  readonly #entries = new Map<string, SnapshotEntry<T>>();

  constructor(
    readonly lifetimeMilliseconds: number,
    readonly maximumEntries: number,
    readonly now: () => number = Date.now,
  ) {}

  create(snapshot: T): string {
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
      snapshot,
      expiresAt: this.now() + this.lifetimeMilliseconds,
      expirationTimer,
    });
    return token;
  }

  get(token: string): T | null {
    this.#removeExpired();
    return this.#entries.get(token)?.snapshot ?? null;
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
