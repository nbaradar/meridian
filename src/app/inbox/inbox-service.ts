import {
  createBalanceAttentionProvider,
  createInboxService,
  type InboxService,
} from "@/core/inbox";
import { utcTimestampSchema } from "@/core/ledger";
import { createDatabase } from "@/infrastructure/database/client";
import { createPostgresBalanceObservationStore } from "@/infrastructure/database/postgres-balance-observations";
import { createPostgresInboxItemStateStore } from "@/infrastructure/database/postgres-inbox-item-states";
import { createPostgresInboxTaskStore } from "@/infrastructure/database/postgres-inbox-tasks";

/**
 * Composes the Inbox for one request. The provider list is assembled here
 * until Plan 0006 builds the module registry.
 */
export async function withInboxService<T>(
  operation: (service: InboxService) => Promise<T>,
): Promise<T> {
  const connection = createDatabase();
  try {
    const database = connection.database;
    const service = createInboxService({
      providers: [
        createBalanceAttentionProvider(
          createPostgresBalanceObservationStore(database),
        ),
      ],
      taskStore: createPostgresInboxTaskStore(database),
      itemStateStore: createPostgresInboxItemStateStore(database),
      clock: () => utcTimestampSchema.parse(new Date().toISOString()),
    });
    return await operation(service);
  } finally {
    await connection.close();
  }
}
