import Link from "next/link";

import {
  createBalanceObservationService,
  entryAmountFromBalance,
  utcTimestampSchema,
  type AccountType,
  type BalanceObservationSource,
  type DashboardAccount,
  type DecimalAmount,
} from "@/core/ledger";
import { createDatabase } from "@/infrastructure/database/client";
import { createPostgresBalanceObservationStore } from "@/infrastructure/database/postgres-balance-observations";

import {
  CurrentBalanceActions,
  RecordBalanceForm,
} from "./balances/balance-forms";
import { formatUsd } from "./format";
import { InboxLink } from "./inbox/inbox-link";

export const dynamic = "force-dynamic";

async function loadDashboard() {
  const connection = createDatabase();
  try {
    const service = createBalanceObservationService(
      createPostgresBalanceObservationStore(connection.database),
      () => utcTimestampSchema.parse(new Date().toISOString()),
    );
    return await service.dashboard();
  } finally {
    await connection.close();
  }
}

const typeLabels: Readonly<Record<AccountType, string>> = {
  checking: "Checking",
  savings: "Savings",
  cash: "Cash",
  credit_card: "Credit cards",
  loan: "Loans",
  mortgage: "Mortgages",
  brokerage: "Brokerage",
  retirement: "Retirement",
  crypto: "Crypto",
  other: "Other",
};

const sourceLabels: Readonly<Record<BalanceObservationSource, string>> = {
  manual: "Manual",
  ynab_export: "YNAB export",
};

/** Liabilities read as an amount owed; a negative owed amount is a credit. */
function owedText(amount: DecimalAmount): string {
  const owed = entryAmountFromBalance("liability", amount);
  return owed.startsWith("-")
    ? `${formatUsd(owed.slice(1))} credit`
    : `${formatUsd(owed)} owed`;
}

function ageText(ageDays: number): string {
  if (ageDays <= 0) return "today";
  return ageDays === 1 ? "1 day old" : `${ageDays} days old`;
}

function AccountRow({
  item,
  latestAllowedDate,
}: Readonly<{ item: DashboardAccount; latestAllowedDate: string }>) {
  const { account, balance } = item;
  const closed = account.status === "closed";
  return (
    <li
      className={closed ? "balance-row closed" : "balance-row"}
      id={`account-${account.id}`}
    >
      <div className="balance-main">
        <span>
          {account.name}
          {closed ? <small> · closed</small> : null}
        </span>
        <strong>
          {balance === null
            ? "No balance yet"
            : account.accountClass === "liability"
              ? owedText(balance.amount)
              : formatUsd(balance.amount)}
        </strong>
      </div>
      {balance ? (
        <p className="balance-meta">
          As of {balance.observedOn} · {sourceLabels[balance.source]} ·{" "}
          {ageText(item.ageDays ?? 0)}
          {item.flaggedClosed ? (
            <span className="balance-flag">
              {" "}
              · Closed with a nonzero balance; not counted
            </span>
          ) : null}
        </p>
      ) : null}
      {balance ? (
        <CurrentBalanceActions
          accountClass={account.accountClass}
          accountId={account.id}
          entryAmount={entryAmountFromBalance(
            account.accountClass,
            balance.amount,
          )}
          key={balance.observationId}
          latestAllowedDate={latestAllowedDate}
          observationId={balance.observationId}
          observedOn={balance.observedOn}
        />
      ) : null}
    </li>
  );
}

export default async function NetWorthPage() {
  const dashboard = await loadDashboard();
  const { netWorth } = dashboard;
  const accounts = dashboard.groups.flatMap((group) => group.accounts);

  return (
    <main>
      <header className="masthead">
        <div>
          <p className="eyebrow">Meridian / Net worth</p>
          <h1>{formatUsd(netWorth.netWorth)}</h1>
        </div>
        <div className="status-block">
          <span>Assets {formatUsd(netWorth.assets)}</span>
          <strong>Liabilities {owedText(netWorth.liabilities)}</strong>
          <p>
            {netWorth.included.length} of {accounts.length} accounts counted.
            {netWorth.withoutBalance.length > 0
              ? ` ${netWorth.withoutBalance.length} active ${netWorth.withoutBalance.length === 1 ? "account has" : "accounts have"} no balance yet.`
              : ""}
            {netWorth.closedWithBalance.length > 0
              ? ` ${netWorth.closedWithBalance.length} closed ${netWorth.closedWithBalance.length === 1 ? "account has" : "accounts have"} a nonzero balance.`
              : ""}
          </p>
        </div>
      </header>

      <nav className="page-links" aria-label="Pages">
        <Link className="text-link" href="/setup">
          Setup
        </Link>
        <Link className="text-link" href="/ynab">
          YNAB migration
        </Link>
        <InboxLink />
      </nav>

      <section className="forms-grid single" aria-label="Record a balance">
        <RecordBalanceForm
          accounts={accounts.map(({ account }) => ({
            id: account.id,
            name: account.name,
            accountClass: account.accountClass,
          }))}
          latestAllowedDate={dashboard.latestAllowedDate}
        />
      </section>

      <section className="balance-groups" aria-label="Accounts">
        {dashboard.groups.length === 0 ? (
          <p className="empty-copy">
            No accounts yet. Create one in <Link href="/setup">setup</Link> or
            save them from a <Link href="/ynab">YNAB export</Link>.
          </p>
        ) : (
          dashboard.groups.map((group) => (
            <div
              className="index-columns balance-group"
              key={group.accountType}
            >
              <div>
                <h3>
                  {typeLabels[group.accountType]}{" "}
                  <span>{group.accounts.length}</span>
                </h3>
                <ul>
                  {group.accounts.map((item) => (
                    <AccountRow
                      item={item}
                      key={item.account.id}
                      latestAllowedDate={dashboard.latestAllowedDate}
                    />
                  ))}
                </ul>
              </div>
            </div>
          ))
        )}
      </section>
    </main>
  );
}
