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
          <span>Accounts only</span>
          <strong>Account mapping</strong>
          <p>
            Saving creates or links Meridian accounts. Transactions and balances
            are not imported yet.
          </p>
        </div>
      </header>
      <Link className="text-link" href="/">
        Back to manual setup
      </Link>
      <YnabMappingReview />
    </main>
  );
}
