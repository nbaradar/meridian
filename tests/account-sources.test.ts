import { randomUUID } from "node:crypto";

import { describe, expect, test } from "vitest";

import {
  createAccountSourceLinkService,
  deriveAccountLinkState,
  utcTimestampSchema,
  type AccountSourceLinkRevision,
  type AccountSourceLinkStore,
  type CurrentAccountSourceLink,
  type NewAccount,
  type NewAccountSource,
  type NewAccountSourceLinkRevision,
} from "../src/core/ledger";

class FakeAccountSourceStore implements AccountSourceLinkStore {
  sources: NewAccountSource[] = [];
  links: NewAccountSourceLinkRevision[] = [];
  accounts: NewAccount[] = [];
  current: CurrentAccountSourceLink[] = [];
  history: AccountSourceLinkRevision[] = [];

  async registerAccountSource(source: NewAccountSource) {
    this.sources.push(source);
  }

  async registerAndLinkAccountSource(
    source: NewAccountSource,
    link: NewAccountSourceLinkRevision,
  ) {
    this.sources.push(source);
    this.links.push(link);
  }

  async createAccountAndLinkSource(
    account: NewAccount,
    source: NewAccountSource,
    link: NewAccountSourceLinkRevision,
  ) {
    this.accounts.push(account);
    this.sources.push(source);
    this.links.push(link);
  }

  async appendLinkRevision(revision: NewAccountSourceLinkRevision) {
    this.links.push(revision);
  }

  async appendRelinkRevisions(
    unlink: NewAccountSourceLinkRevision,
    link: NewAccountSourceLinkRevision,
  ) {
    this.links.push(unlink, link);
  }

  async resolveCurrentAccount() {
    return this.current[0] ?? null;
  }

  async listCurrentSources() {
    return this.current;
  }

  async listLinkHistory() {
    return this.history;
  }
}

const now = utcTimestampSchema.parse("2026-08-03T12:00:00Z");

describe("account-source linkage service", () => {
  test("registers a provider-independent local source identity", async () => {
    const store = new FakeAccountSourceStore();
    const service = createAccountSourceLinkService(store, () => now);
    const accountSourceId = randomUUID();

    await expect(
      service.registerAccountSource({
        accountSourceId,
        source: "ynab",
        sourceKind: "import",
        ingestedAt: "2026-08-03T11:00:00Z",
      }),
    ).resolves.toEqual({ id: accountSourceId });
    expect(store.sources).toEqual([
      {
        id: accountSourceId,
        source: "ynab",
        sourceKind: "import",
        ingestedAt: "2026-08-03T11:00:00Z",
      },
    ]);
  });

  test("atomically describes an initial link to an existing account", async () => {
    const store = new FakeAccountSourceStore();
    const service = createAccountSourceLinkService(store, () => now);
    const accountSourceId = randomUUID();
    const accountId = randomUUID();
    const linkRevisionId = randomUUID();

    await service.registerAndLinkAccountSource({
      accountSourceId,
      source: "simplefin",
      sourceKind: "connector",
      ingestedAt: "2026-08-03T11:00:00Z",
      accountId,
      linkRevisionId,
    });

    expect(store.links).toEqual([
      {
        id: linkRevisionId,
        accountSourceId,
        accountId,
        status: "linked",
        supersedesLinkRevisionId: null,
        reasonCode: "initial_mapping",
      },
    ]);
  });

  test("prepares canonical account creation and linkage together", async () => {
    const store = new FakeAccountSourceStore();
    const service = createAccountSourceLinkService(store, () => now);
    const accountId = randomUUID();
    const accountSourceId = randomUUID();

    await service.createAccountAndLinkSource({
      account: {
        accountId,
        revisionId: randomUUID(),
        name: "Imported retirement",
        accountType: "retirement",
        accountClass: null,
        openedOn: null,
      },
      source: {
        accountSourceId,
        source: "ynab",
        sourceKind: "import",
        ingestedAt: "2026-08-03T11:00:00Z",
      },
      linkRevisionId: randomUUID(),
    });

    expect(store.accounts[0]).toMatchObject({
      id: accountId,
      accountType: "retirement",
      accountClass: "asset",
      revision: { name: "Imported retirement", effectiveAt: now },
    });
    expect(store.links[0]).toMatchObject({
      accountSourceId,
      accountId,
      status: "linked",
    });
  });

  test("builds explicit unlink and atomic relink chains", async () => {
    const store = new FakeAccountSourceStore();
    const service = createAccountSourceLinkService(store, () => now);
    const accountSourceId = randomUUID();
    const previousAccountId = randomUUID();
    const accountId = randomUUID();
    const currentRevisionId = randomUUID();
    const unlinkRevisionId = randomUUID();
    const linkRevisionId = randomUUID();

    await service.relinkAccountSource({
      accountSourceId,
      previousAccountId,
      accountId,
      supersedesLinkRevisionId: currentRevisionId,
      unlinkRevisionId,
      linkRevisionId,
      unlinkReasonCode: "mapping_correction_unlinked",
      linkReasonCode: "mapping_correction_linked",
    });

    expect(store.links).toEqual([
      {
        id: unlinkRevisionId,
        accountSourceId,
        accountId: previousAccountId,
        status: "unlinked",
        supersedesLinkRevisionId: currentRevisionId,
        reasonCode: "mapping_correction_unlinked",
      },
      {
        id: linkRevisionId,
        accountSourceId,
        accountId,
        status: "linked",
        supersedesLinkRevisionId: unlinkRevisionId,
        reasonCode: "mapping_correction_linked",
      },
    ]);
  });

  test("rejects invalid source and account commands before persistence", async () => {
    const store = new FakeAccountSourceStore();
    const service = createAccountSourceLinkService(store, () => now);

    await expect(
      service.registerAccountSource({
        accountSourceId: randomUUID(),
        source: "provider-account-123",
        sourceKind: "connector",
        ingestedAt: now,
      }),
    ).rejects.toBeDefined();
    await expect(
      service.registerAccountSource({
        accountSourceId: randomUUID(),
        source: "ynab",
        sourceKind: "import",
        ingestedAt: "2026-08-03T13:00:00Z",
      }),
    ).rejects.toThrow("cannot be ingested after it is recorded");
    await expect(
      service.createAccountAndLinkSource({
        account: {
          accountId: randomUUID(),
          revisionId: randomUUID(),
          name: "Invalid other",
          accountType: "other",
          accountClass: null,
          openedOn: null,
        },
        source: {
          accountSourceId: randomUUID(),
          source: "ynab",
          sourceKind: "import",
          ingestedAt: now,
        },
        linkRevisionId: randomUUID(),
      }),
    ).rejects.toBeDefined();
    expect(store.sources).toHaveLength(0);
    expect(store.links).toHaveLength(0);
    expect(store.accounts).toHaveLength(0);
  });

  test("derives offline, import-only, and live-linked display states", () => {
    expect(deriveAccountLinkState([])).toEqual({
      linkage: "offline",
      multipleSources: false,
    });
    expect(deriveAccountLinkState([{ sourceKind: "import" }])).toEqual({
      linkage: "import_only",
      multipleSources: false,
    });
    expect(
      deriveAccountLinkState([
        { sourceKind: "import" },
        { sourceKind: "connector" },
      ]),
    ).toEqual({ linkage: "live_linked", multipleSources: true });
  });
});
