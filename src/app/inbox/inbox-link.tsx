import Link from "next/link";

import { withInboxService } from "./inbox-service";

/** `Inbox (N)` for every page's links; a failed count never breaks a page. */
export async function InboxLink() {
  let count: number | null = null;
  try {
    count = await withInboxService((service) => service.count());
  } catch (error) {
    // Logged by name only; the page still renders with a plain link.
    console.error(
      `Inbox count failed: ${error instanceof Error ? error.name : "unknown error"}`,
    );
    count = null;
  }
  return (
    <Link className="text-link" href="/inbox">
      {count === null ? "Inbox" : `Inbox (${count})`}
    </Link>
  );
}
