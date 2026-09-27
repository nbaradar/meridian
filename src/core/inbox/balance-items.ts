import {
  balanceAgeDays,
  computeNetWorth,
  type BalanceObservationStore,
  type CalendarDate,
  type CurrentAccount,
  type CurrentBalance,
} from "../ledger";
import {
  addDays,
  startOfDay,
  type AttentionItem,
  type AttentionProvider,
} from "./attention";

export const balanceAttentionProviderId = "balances";

/** RFC 0009: a balance older than this many days is stale, for every account. */
export const staleBalanceDays = 30;

function accountHref(account: CurrentAccount): string {
  return `/#account-${account.id}`;
}

/**
 * RFC 0009 balance items. Titles name the account but never an amount. A
 * closed account only ever yields `closed_with_balance`.
 */
export function balanceAttentionItems(
  accounts: readonly CurrentAccount[],
  balances: readonly CurrentBalance[],
  today: CalendarDate,
): AttentionItem[] {
  // One classification rule, shared with net worth (RFC 0006).
  const { included, withoutBalance, closedWithBalance } = computeNetWorth(
    accounts,
    balances,
  );
  const missing = withoutBalance.map((account): AttentionItem => ({
    key: `balances:no_balance:${account.id}`,
    version: "none",
    kind: "no_balance",
    severity: "action",
    title: `Record a balance for ${account.name}`,
    subject: { accountId: account.id },
    href: accountHref(account),
    since: null,
  }));
  // 30 days old is not stale; 31 is. A future-dated balance never is.
  const stale = included
    .filter(
      ({ balance }) =>
        balanceAgeDays(balance.observedOn, today) > staleBalanceDays,
    )
    .map(({ account, balance }): AttentionItem => ({
      key: `balances:stale_balance:${account.id}`,
      version: balance.observationId,
      kind: "stale_balance",
      severity: "action",
      title: `Update the balance for ${account.name}, last recorded ${balance.observedOn}`,
      subject: {
        accountId: account.id,
        observationId: balance.observationId,
      },
      href: accountHref(account),
      // The first day the balance counted as stale.
      since: startOfDay(addDays(balance.observedOn, staleBalanceDays + 1)),
    }));
  const closed = closedWithBalance.map(
    ({ account, balance }): AttentionItem => ({
      key: `balances:closed_with_balance:${account.id}`,
      version: balance.observationId,
      kind: "closed_with_balance",
      severity: "review",
      title: `Closed account ${account.name} still shows a balance`,
      subject: { accountId: account.id, observationId: balance.observationId },
      href: accountHref(account),
      since: null,
    }),
  );
  return [...closed, ...missing, ...stale];
}

/** Reads current accounts and balances; never calls a write method. */
export function createBalanceAttentionProvider(
  store: Pick<BalanceObservationStore, "listAccounts" | "listCurrentBalances">,
): AttentionProvider {
  return {
    id: balanceAttentionProviderId,
    async items({ today }) {
      const [accounts, balances] = await Promise.all([
        store.listAccounts(),
        store.listCurrentBalances(),
      ]);
      return balanceAttentionItems(accounts, balances, today);
    },
  };
}
