import Link from "next/link";

import { YnabMappingReview } from "./ynab-mapping-review";

export const dynamic = "force-dynamic";

export default function YnabImportReviewPage() {
  return (
    <main>
      <header className="review-masthead">
        <div>
          <p className="eyebrow">Meridian / YNAB migration</p>
          <h1>Review each account. Save when ready.</h1>
        </div>
        <div className="status-block">
          <span>Accounts and balances</span>
          <strong>Account mapping</strong>
          <p>
            Saving creates or links Meridian accounts and can record their
            balances. Transactions are not imported yet.
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
      </nav>
      <YnabMappingReview />
    </main>
  );
}
