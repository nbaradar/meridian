import Link from "next/link";

import {
  addDays,
  canDismiss,
  canSnooze,
  isExternalLink,
  maxSnoozeDays,
  type AttentionItem,
  type AttentionSeverity,
  type InboxEntry,
  type OwnerTask,
} from "@/core/inbox";
import {
  createLedgerDestinationService,
  utcTimestampSchema,
} from "@/core/ledger";
import { createDatabase } from "@/infrastructure/database/client";
import { createPostgresLedgerDestinationStore } from "@/infrastructure/database/postgres-ledger-destinations";

import {
  AddTaskForm,
  ItemActions,
  RestoreButton,
  TaskActions,
  type TaskAccountOption,
} from "./inbox-forms";
import { InboxLink } from "./inbox-link";
import { withInboxService } from "./inbox-service";

export const dynamic = "force-dynamic";

async function loadAccounts(): Promise<readonly TaskAccountOption[]> {
  const connection = createDatabase();
  try {
    const service = createLedgerDestinationService(
      createPostgresLedgerDestinationStore(connection.database),
      () => utcTimestampSchema.parse(new Date().toISOString()),
    );
    const accounts = await service.listAccounts();
    return accounts
      .map((account) => ({ id: account.id, name: account.name }))
      .sort((left, right) => left.name.localeCompare(right.name));
  } finally {
    await connection.close();
  }
}

const severityLabels: Readonly<Record<AttentionSeverity, string>> = {
  review: "Needs review",
  decision: "Decisions",
  action: "To do",
  info: "For information",
};

function dateOf(timestamp: string): string {
  return timestamp.slice(0, 10);
}

function ItemTitle({ item }: Readonly<{ item: AttentionItem }>) {
  return (
    <div className="balance-main">
      <span>
        <Link href={item.href}>{item.title}</Link>
      </span>
      <small>{item.kind.replaceAll("_", " ")}</small>
    </div>
  );
}

function TaskLink({ link }: Readonly<{ link: string }>) {
  return isExternalLink(link) ? (
    <a href={link} rel="noopener noreferrer" target="_blank">
      {link}
    </a>
  ) : (
    <Link href={link}>{link}</Link>
  );
}

function TaskDetails({
  task,
  accountNames,
  overdue,
}: Readonly<{
  task: OwnerTask;
  accountNames: ReadonlyMap<string, string>;
  overdue: boolean;
}>) {
  const account = task.accountId ? accountNames.get(task.accountId) : null;
  return (
    <>
      <div className="balance-main">
        <span className={task.status === "done" ? "inbox-done-title" : ""}>
          {task.title}
        </span>
        <small>task</small>
      </div>
      {task.note ? <p className="inbox-note">{task.note}</p> : null}
      <p className="balance-meta">
        {task.dueOn ? (
          <span className={overdue ? "balance-flag" : ""}>
            Due {task.dueOn}
            {overdue ? " · overdue" : ""} ·{" "}
          </span>
        ) : null}
        {account && task.accountId ? (
          <>
            <Link href={`/#account-${task.accountId}`}>{account}</Link> ·{" "}
          </>
        ) : null}
        {task.link ? (
          <>
            <TaskLink link={task.link} /> ·{" "}
          </>
        ) : null}
        {task.completedAt
          ? `Done ${dateOf(task.completedAt)}`
          : `Added ${dateOf(task.createdAt)}`}
      </p>
    </>
  );
}

function taskValues(task: OwnerTask) {
  return {
    title: task.title,
    note: task.note ?? "",
    accountId: task.accountId ?? "",
    link: task.link ?? "",
    dueOn: task.dueOn ?? "",
  };
}

interface EntryContext {
  accounts: readonly TaskAccountOption[];
  accountNames: ReadonlyMap<string, string>;
  minSnoozeDate: string;
  maxSnoozeDate: string;
}

function EntryRow({
  entry,
  context,
}: Readonly<{ entry: InboxEntry; context: EntryContext }>) {
  const { accounts, accountNames, minSnoozeDate, maxSnoozeDate } = context;
  if (entry.type === "task") {
    return (
      <li className="balance-row">
        <TaskDetails
          accountNames={accountNames}
          overdue={entry.overdue}
          task={entry.task}
        />
        <TaskActions
          accounts={accounts}
          key={entry.task.updatedAt}
          status="open"
          taskId={entry.task.id}
          values={taskValues(entry.task)}
        />
      </li>
    );
  }
  const { item } = entry;
  return (
    <li className="balance-row">
      <ItemTitle item={item} />
      {item.since ? (
        <p className="balance-meta">Since {dateOf(item.since)}</p>
      ) : null}
      {canSnooze(item) ? (
        <ItemActions
          canDismiss={canDismiss(item)}
          itemKey={item.key}
          itemVersion={item.version}
          maxDate={maxSnoozeDate}
          minDate={minSnoozeDate}
        />
      ) : null}
    </li>
  );
}

export default async function InboxPage() {
  const [view, accounts] = await Promise.all([
    withInboxService((service) => service.view()),
    loadAccounts(),
  ]);
  const accountNames = new Map(
    accounts.map((account) => [account.id, account.name]),
  );
  const context: EntryContext = {
    accounts,
    accountNames,
    minSnoozeDate: addDays(view.today, 1),
    maxSnoozeDate: addDays(view.today, maxSnoozeDays),
  };

  return (
    <main>
      <header className="masthead">
        <div>
          <p className="eyebrow">Meridian / Inbox</p>
          <h1>{view.count === 0 ? "All clear" : `${view.count} to do`}</h1>
        </div>
        <div className="status-block">
          <span>Today {view.today} (UTC)</span>
          <strong>
            {view.snoozed.length} snoozed · {view.dismissed.length} dismissed
          </strong>
          <p>
            Items clear themselves once fixed. The Inbox links to where each one
            is resolved; it never changes your ledger.
          </p>
        </div>
      </header>

      <nav className="page-links" aria-label="Pages">
        <Link className="text-link" href="/">
          Net worth
        </Link>
        <Link className="text-link" href="/setup">
          Setup
        </Link>
        <Link className="text-link" href="/ynab">
          YNAB migration
        </Link>
        <InboxLink />
      </nav>

      <section className="forms-grid single" aria-label="Add a task">
        <AddTaskForm accounts={accounts} />
      </section>

      <section className="balance-groups" aria-label="Inbox">
        {view.groups.length === 0 ? (
          <p className="empty-copy">Nothing needs your attention.</p>
        ) : (
          view.groups.map((group) => (
            <div className="index-columns balance-group" key={group.severity}>
              <div>
                <h3>
                  {severityLabels[group.severity]}{" "}
                  <span>{group.entries.length}</span>
                </h3>
                <ul>
                  {group.entries.map((entry) => (
                    <EntryRow context={context} entry={entry} key={entry.key} />
                  ))}
                </ul>
              </div>
            </div>
          ))
        )}

        {view.snoozed.length > 0 ? (
          <div className="index-columns balance-group">
            <div>
              <h3>
                Snoozed <span>{view.snoozed.length}</span>
              </h3>
              <ul>
                {view.snoozed.map(({ item, snoozedUntil }) => (
                  <li className="balance-row" key={item.key}>
                    <ItemTitle item={item} />
                    <p className="balance-meta">
                      {severityLabels[item.severity]} · returns {snoozedUntil}
                    </p>
                    <RestoreButton itemKey={item.key} />
                  </li>
                ))}
              </ul>
            </div>
          </div>
        ) : null}

        {view.dismissed.length > 0 ? (
          <div className="index-columns balance-group">
            <div>
              <h3>
                Dismissed <span>{view.dismissed.length}</span>
              </h3>
              <ul>
                {view.dismissed.map((item) => (
                  <li className="balance-row" key={item.key}>
                    <ItemTitle item={item} />
                    <p className="balance-meta">
                      {severityLabels[item.severity]} · returns if it changes
                    </p>
                    <RestoreButton itemKey={item.key} />
                  </li>
                ))}
              </ul>
            </div>
          </div>
        ) : null}

        {view.done.length > 0 ? (
          <div className="index-columns balance-group">
            <div>
              <h3>
                Done <span>{view.done.length}</span>
              </h3>
              <ul>
                {view.done.map((task) => (
                  <li className="balance-row" key={task.id}>
                    <TaskDetails
                      accountNames={accountNames}
                      overdue={false}
                      task={task}
                    />
                    <TaskActions
                      accounts={accounts}
                      key={task.updatedAt}
                      status="done"
                      taskId={task.id}
                      values={taskValues(task)}
                    />
                  </li>
                ))}
              </ul>
            </div>
          </div>
        ) : null}
      </section>
    </main>
  );
}
