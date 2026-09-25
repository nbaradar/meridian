import { randomUUID } from "node:crypto";

import { describe, expect, test } from "vitest";

import {
  createSourceRecordAssociationService,
  type NewSourceRecordAccountSetMember,
  type NewSourceRecordAccountSetRevision,
  type SourceRecordAccountSetRevision,
  type SourceRecordAssociationStore,
} from "../src/core/ledger";

class FakeSourceRecordAssociationStore implements SourceRecordAssociationStore {
  appends: Array<{
    revision: NewSourceRecordAccountSetRevision;
    members: readonly NewSourceRecordAccountSetMember[];
  }> = [];

  async appendAssociationRevision(
    revision: NewSourceRecordAccountSetRevision,
    members: readonly NewSourceRecordAccountSetMember[],
  ) {
    this.appends.push({ revision, members });
  }

  async resolveCurrentSet(): Promise<SourceRecordAccountSetRevision | null> {
    return null;
  }

  async listHistory(): Promise<readonly SourceRecordAccountSetRevision[]> {
    return [];
  }
}

describe("source-record account association service", () => {
  test("prepares an initial sealed directly-observed account set", async () => {
    const store = new FakeSourceRecordAssociationStore();
    const service = createSourceRecordAssociationService(store);
    const accountSetRevisionId = randomUUID();
    const sourceRecordId = randomUUID();
    const members = [
      {
        accountSourceId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        linkRevisionId: randomUUID(),
      },
      {
        accountSourceId: "11111111-1111-4111-8111-111111111111",
        linkRevisionId: randomUUID(),
      },
    ];

    await expect(
      service.sealInitialAccountSet({
        accountSetRevisionId,
        sourceRecordId,
        members,
      }),
    ).resolves.toEqual({ id: accountSetRevisionId });
    expect(store.appends).toEqual([
      {
        revision: {
          id: accountSetRevisionId,
          sourceRecordId,
          supersedesAccountSetRevisionId: null,
          memberCount: 2,
        },
        members: [...members]
          .sort((left, right) =>
            left.accountSourceId.localeCompare(right.accountSourceId),
          )
          .map((member) => ({
            accountSetRevisionId,
            ...member,
            role: "observed_account",
          })),
      },
    ]);
  });

  test("prepares a corrected successor with the exact predecessor", async () => {
    const store = new FakeSourceRecordAssociationStore();
    const service = createSourceRecordAssociationService(store);
    const accountSetRevisionId = randomUUID();
    const sourceRecordId = randomUUID();
    const supersedesAccountSetRevisionId = randomUUID();
    const member = {
      accountSourceId: randomUUID(),
      linkRevisionId: randomUUID(),
    };

    await service.correctAccountSet({
      accountSetRevisionId,
      sourceRecordId,
      supersedesAccountSetRevisionId,
      members: [member],
    });

    expect(store.appends[0]).toEqual({
      revision: {
        id: accountSetRevisionId,
        sourceRecordId,
        supersedesAccountSetRevisionId,
        memberCount: 1,
      },
      members: [
        {
          accountSetRevisionId,
          ...member,
          role: "observed_account",
        },
      ],
    });
  });

  test("rejects duplicate account sources before persistence", async () => {
    const store = new FakeSourceRecordAssociationStore();
    const service = createSourceRecordAssociationService(store);
    const accountSourceId = randomUUID();

    await expect(
      service.sealInitialAccountSet({
        accountSetRevisionId: randomUUID(),
        sourceRecordId: randomUUID(),
        members: [
          { accountSourceId, linkRevisionId: randomUUID() },
          { accountSourceId, linkRevisionId: randomUUID() },
        ],
      }),
    ).rejects.toThrow(`duplicate account source: ${accountSourceId}`);
    expect(store.appends).toHaveLength(0);
  });

  test.each([
    {
      name: "empty members",
      command: {
        accountSetRevisionId: randomUUID(),
        sourceRecordId: randomUUID(),
        members: [],
      },
    },
    {
      name: "malformed set ID",
      command: {
        accountSetRevisionId: "not-a-uuid",
        sourceRecordId: randomUUID(),
        members: [
          { accountSourceId: randomUUID(), linkRevisionId: randomUUID() },
        ],
      },
    },
    {
      name: "malformed member ID",
      command: {
        accountSetRevisionId: randomUUID(),
        sourceRecordId: randomUUID(),
        members: [
          { accountSourceId: "not-a-uuid", linkRevisionId: randomUUID() },
        ],
      },
    },
    {
      name: "caller-controlled persistence fields",
      command: {
        accountSetRevisionId: randomUUID(),
        sourceRecordId: randomUUID(),
        memberCount: 1,
        members: [
          {
            accountSourceId: randomUUID(),
            linkRevisionId: randomUUID(),
            role: "observed_account",
          },
        ],
      },
    },
  ])("rejects $name before persistence", async ({ command }) => {
    const store = new FakeSourceRecordAssociationStore();
    const service = createSourceRecordAssociationService(store);

    await expect(service.sealInitialAccountSet(command)).rejects.toBeDefined();
    expect(store.appends).toHaveLength(0);
  });

  test("rejects a malformed correction predecessor before persistence", async () => {
    const store = new FakeSourceRecordAssociationStore();
    const service = createSourceRecordAssociationService(store);

    await expect(
      service.correctAccountSet({
        accountSetRevisionId: randomUUID(),
        sourceRecordId: randomUUID(),
        supersedesAccountSetRevisionId: "not-a-uuid",
        members: [
          { accountSourceId: randomUUID(), linkRevisionId: randomUUID() },
        ],
      }),
    ).rejects.toBeDefined();
    expect(store.appends).toHaveLength(0);
  });
});
