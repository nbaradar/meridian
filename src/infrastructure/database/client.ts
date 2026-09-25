import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import {
  databaseEnvironment,
  operationalDatabaseEnvironment,
  type DatabaseEnvironment,
  type OperationalDatabaseEnvironment,
} from "./environment";
import * as schema from "./schema";

export function createDatabase(
  environment: DatabaseEnvironment = databaseEnvironment(),
) {
  const client = postgres(environment.DATABASE_URL, { max: 10 });

  return {
    database: drizzle(client, { schema }),
    close: () => client.end(),
  };
}

export type DatabaseConnection = ReturnType<typeof createDatabase>;
export type MeridianDatabase = DatabaseConnection["database"];

function createOperationalDatabase(connectionUrl: string) {
  const client = postgres(connectionUrl, { max: 10 });
  return {
    database: drizzle(client, { schema }),
    close: () => client.end(),
  };
}

export function createOpsControlDatabase(
  environment: OperationalDatabaseEnvironment = operationalDatabaseEnvironment(),
) {
  return createOperationalDatabase(environment.OPS_CONTROL_DATABASE_URL);
}

export function createReadWorkerDatabase(
  environment: OperationalDatabaseEnvironment = operationalDatabaseEnvironment(),
) {
  return createOperationalDatabase(environment.READ_WORKER_DATABASE_URL);
}
