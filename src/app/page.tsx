import {
  createLedgerDestinationService,
  utcTimestampSchema,
} from "@/core/ledger";
import Link from "next/link";
import { createDatabase } from "@/infrastructure/database/client";
import { createPostgresLedgerDestinationStore } from "@/infrastructure/database/postgres-ledger-destinations";

import { AccountForm, CategoryForm } from "./manual/manual-entry-forms";

export const dynamic = "force-dynamic";

async function loadDestinations() {
  const connection = createDatabase();
  try {
    const store = createPostgresLedgerDestinationStore(connection.database);
    const service = createLedgerDestinationService(store, () =>
      utcTimestampSchema.parse(new Date().toISOString()),
    );
    const [accounts, categories] = await Promise.all([
      service.listAccounts(),
      service.listCategories(),
    ]);
    return { accounts, categories };
  } finally {
    await connection.close();
  }
}

export default async function Home() {
  const { accounts, categories } = await loadDestinations();

  return (
    <main>
      <header className="masthead">
        <div>
          <p className="eyebrow">Meridian / Manual setup</p>
        </div>
        <div className="status-block">
          <span>Phase 0</span>
          <strong>Offline destinations</strong>
          <p>For imports and accounts without live connections.</p>
        </div>
      </header>

      <Link className="workflow-link" href="/ynab">
        <span>YNAB migration</span>
        <strong>Analyze exports and review account mappings →</strong>
      </Link>

      <section className="forms-grid" aria-label="Manual ledger setup">
        <AccountForm />
        <CategoryForm categories={categories} />
      </section>

      <section
        className="ledger-index"
        aria-label="Current ledger destinations"
      >
        <div className="index-heading">
          <p className="eyebrow">Current index</p>
          <h2>{accounts.length + categories.length} destinations</h2>
        </div>
        <div className="index-columns">
          <div>
            <h3>
              Accounts <span>{accounts.length}</span>
            </h3>
            {accounts.length === 0 ? (
              <p className="empty-copy">No accounts recorded yet.</p>
            ) : (
              <ul>
                {accounts.map((account) => (
                  <li key={account.id}>
                    <span>{account.name}</span>
                    <small>
                      {account.accountType.replace("_", " ")} /{" "}
                      {account.currency}
                    </small>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <h3>
              Categories <span>{categories.length}</span>
            </h3>
            {categories.length === 0 ? (
              <p className="empty-copy">No categories recorded yet.</p>
            ) : (
              <ul>
                {categories.map((category) => (
                  <li key={category.id}>
                    <span>{category.name}</span>
                    <small>{category.kind}</small>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </section>
    </main>
  );
}
