import "dotenv/config";

import { defineConfig } from "drizzle-kit";

import { migrationEnvironment } from "./src/infrastructure/database/environment";

const environment = migrationEnvironment();

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/infrastructure/database/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: environment.DATABASE_OWNER_URL,
  },
  strict: true,
  verbose: true,
});
