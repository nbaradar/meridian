import { sql } from "drizzle-orm";
import { afterAll, describe, expect, test } from "vitest";

import { createDatabase } from "../../src/infrastructure/database/client";

const connection = createDatabase();

afterAll(async () => {
  await connection.close();
});

describe("PostgreSQL integration harness", () => {
  test("connects to PostgreSQL 16 with pgvector available", async () => {
    const result = await connection.database.execute<{
      server_version: string;
      vector_available: boolean;
    }>(sql`
      select
        current_setting('server_version') as server_version,
        exists (
          select 1
          from pg_available_extensions
          where name = 'vector'
        ) as vector_available
    `);

    expect(result[0]?.server_version).toMatch(/^16\./u);
    expect(result[0]?.vector_available).toBe(true);
  });
});
