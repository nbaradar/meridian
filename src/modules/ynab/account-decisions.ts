import { z } from "zod";

import {
  accountSourceIdSchema,
  accountSourceLinkRevisionIdSchema,
  createAccountCommandSchema,
  prepareNewAccount,
  sha256DigestSchema,
  utcTimestampSchema,
  type AccountId,
  type AccountSourceId,
  type AccountType,
  type NewAccount,
  type NewAccountSource,
  type NewAccountSourceLinkRevision,
  type UtcTimestamp,
} from "../../core/ledger";
import type { YnabResolvedAccountMapping } from "./account-mapping";

/**
 * RFC 0005: a keyed digest of a YNAB account name. It lets a later export
 * recognize a saved account without Meridian storing the name, which often
 * contains an account-number suffix.
 */
export const ynabLabelDigestSchema = z.strictObject({
  digestKeyId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u),
  labelDigest: sha256DigestSchema,
});

export type YnabLabelDigest = z.infer<typeof ynabLabelDigestSchema>;

export interface YnabLabelDigester {
  /** The digest under the given key version, or the current one. */
  digest(label: string, keyId?: string): YnabLabelDigest;
  /** Every available key version, current first. */
  keyIds(): readonly string[];
}

export const ynabAccountDecisionIdSchema = z
  .uuid()
  .brand<"YnabAccountDecisionId">();

export type YnabAccountDecisionId = z.infer<typeof ynabAccountDecisionIdSchema>;

export interface TrackedAccountSummary {
  id: AccountId;
  name: string;
  accountType: AccountType;
}

export type CurrentYnabAccountDecision = YnabLabelDigest & {
  id: YnabAccountDecisionId;
  recordedAt: UtcTimestamp;
} & (
    | {
        decision: "tracked";
        accountSourceId: AccountSourceId;
        /** The account the source currently links to; null while unlinked. */
        account: TrackedAccountSummary | null;
      }
    | { decision: "excluded"; accountSourceId: null; account: null }
  );

export interface NewYnabAccountDecision extends YnabLabelDigest {
  id: YnabAccountDecisionId;
  decision: "tracked" | "excluded";
  accountSourceId: AccountSourceId | null;
  supersedesDecisionId: YnabAccountDecisionId | null;
}

export type YnabAccountDecisionWrite =
  | {
      kind: "create_account";
      account: NewAccount;
      source: NewAccountSource;
      link: NewAccountSourceLinkRevision;
      decision: NewYnabAccountDecision;
    }
  | {
      kind: "link_account";
      source: NewAccountSource;
      link: NewAccountSourceLinkRevision;
      decision: NewYnabAccountDecision;
    }
  | { kind: "reuse_source"; decision: NewYnabAccountDecision }
  | { kind: "exclude"; decision: NewYnabAccountDecision };

export interface YnabAccountDecisionStore {
  /** Current decisions for any of the given digests. */
  findCurrentDecisions(
    digests: readonly YnabLabelDigest[],
  ): Promise<readonly CurrentYnabAccountDecision[]>;
  /** Every current tracked decision, for offering renamed-account matches. */
  listTrackedDecisions(): Promise<readonly CurrentYnabAccountDecision[]>;
  /**
   * Atomically performs the write and records its decision. Fails with
   * YnabAccountAlreadyDecidedError when the digest's current decision is not
   * the declared predecessor.
   */
  saveDecision(write: YnabAccountDecisionWrite): Promise<void>;
}

export class YnabAccountAlreadyDecidedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "YnabAccountAlreadyDecidedError";
  }
}

export type YnabAccountSaveState =
  | { status: "unsaved" }
  | {
      status: "tracked";
      decisionId: YnabAccountDecisionId;
      accountSourceId: AccountSourceId;
      account: TrackedAccountSummary | null;
    }
  | { status: "excluded"; decisionId: YnabAccountDecisionId };

function saveState(
  decision: CurrentYnabAccountDecision | undefined,
): YnabAccountSaveState {
  if (!decision) return { status: "unsaved" };
  if (decision.decision === "excluded") {
    return { status: "excluded", decisionId: decision.id };
  }
  return {
    status: "tracked",
    decisionId: decision.id,
    accountSourceId: decision.accountSourceId,
    account: decision.account,
  };
}

function digestKey(digest: YnabLabelDigest): string {
  return `${digest.digestKeyId}:${digest.labelDigest}`;
}

export function createYnabAccountDecisionService(
  store: YnabAccountDecisionStore,
  digester: YnabLabelDigester,
  clock: () => UtcTimestamp,
  newId: () => string,
) {
  /** The current decision for a name under any key, preferring the newest key. */
  async function currentDecision(
    sourceName: string,
  ): Promise<CurrentYnabAccountDecision | undefined> {
    const digests = digester
      .keyIds()
      .map((keyId) => digester.digest(sourceName, keyId));
    const decisions = new Map(
      (await store.findCurrentDecisions(digests)).map((decision) => [
        digestKey(decision),
        decision,
      ]),
    );
    for (const digest of digests) {
      const decision = decisions.get(digestKey(digest));
      if (decision) return decision;
    }
    return undefined;
  }

  return {
    /** Save state for each YNAB account name in an export. */
    async lookup(
      sourceNames: readonly string[],
    ): Promise<ReadonlyMap<string, YnabAccountSaveState>> {
      const keyIds = digester.keyIds();
      const digestsByName = new Map(
        sourceNames.map((name) => [
          name,
          keyIds.map((keyId) => digester.digest(name, keyId)),
        ]),
      );
      const decisions = new Map(
        (
          await store.findCurrentDecisions([...digestsByName.values()].flat())
        ).map((decision) => [digestKey(decision), decision]),
      );
      return new Map(
        [...digestsByName].map(([name, digests]) => [
          name,
          saveState(
            digests
              .map((digest) => decisions.get(digestKey(digest)))
              .find((decision) => decision !== undefined),
          ),
        ]),
      );
    },

    /** Tracked YNAB sources a renamed YNAB account could reuse. */
    async listTrackedSources(): Promise<
      readonly {
        accountSourceId: AccountSourceId;
        account: TrackedAccountSummary;
      }[]
    > {
      const unique = new Map<
        string,
        { accountSourceId: AccountSourceId; account: TrackedAccountSummary }
      >();
      for (const decision of await store.listTrackedDecisions()) {
        // Only a currently linked source can be reused by a rename.
        if (decision.decision !== "tracked" || !decision.account) continue;
        unique.set(decision.accountSourceId, {
          accountSourceId: decision.accountSourceId,
          account: decision.account,
        });
      }
      return [...unique.values()];
    },

    /**
     * Records a validated decision. A first decision uses the current digest
     * key; re-deciding an excluded account extends that exclusion's chain.
     */
    async save(mapping: YnabResolvedAccountMapping): Promise<void> {
      const existing = await currentDecision(mapping.sourceName);
      if (existing?.decision === "tracked") {
        throw new YnabAccountAlreadyDecidedError(
          `YNAB account is already saved: ${mapping.sourceName}`,
        );
      }
      if (existing && mapping.action === "exclude") {
        throw new YnabAccountAlreadyDecidedError(
          `YNAB account is already excluded: ${mapping.sourceName}`,
        );
      }

      const now = utcTimestampSchema.parse(clock());
      const digest = existing
        ? {
            digestKeyId: existing.digestKeyId,
            labelDigest: existing.labelDigest,
          }
        : digester.digest(mapping.sourceName);
      const decisionFields = {
        id: ynabAccountDecisionIdSchema.parse(newId()),
        ...digest,
        supersedesDecisionId: existing?.id ?? null,
      };

      if (mapping.action === "exclude") {
        await store.saveDecision({
          kind: "exclude",
          decision: {
            ...decisionFields,
            decision: "excluded",
            accountSourceId: null,
          },
        });
        return;
      }
      if (mapping.action === "renamed") {
        await store.saveDecision({
          kind: "reuse_source",
          decision: {
            ...decisionFields,
            decision: "tracked",
            accountSourceId: mapping.accountSourceId,
          },
        });
        return;
      }

      const source: NewAccountSource = {
        id: accountSourceIdSchema.parse(newId()),
        source: "ynab",
        sourceKind: "import",
        ingestedAt: now,
      };
      const decision: NewYnabAccountDecision = {
        ...decisionFields,
        decision: "tracked",
        accountSourceId: source.id,
      };
      if (mapping.action === "link") {
        await store.saveDecision({
          kind: "link_account",
          source,
          link: initialLink(newId(), source.id, mapping.accountId),
          decision,
        });
        return;
      }

      const account = prepareNewAccount(
        createAccountCommandSchema.parse({
          accountId: newId(),
          revisionId: newId(),
          name: mapping.name,
          accountType: mapping.accountType,
          accountClass: mapping.accountClass,
          openedOn: mapping.openedOn,
        }),
        now,
      );
      await store.saveDecision({
        kind: "create_account",
        account,
        source,
        link: initialLink(newId(), source.id, account.id),
        decision,
      });
    },
  };
}

function initialLink(
  id: string,
  accountSourceId: AccountSourceId,
  accountId: AccountId,
): NewAccountSourceLinkRevision {
  return {
    id: accountSourceLinkRevisionIdSchema.parse(id),
    accountSourceId,
    accountId,
    status: "linked",
    supersedesLinkRevisionId: null,
    reasonCode: "initial_mapping",
  };
}

export type YnabAccountDecisionService = ReturnType<
  typeof createYnabAccountDecisionService
>;
