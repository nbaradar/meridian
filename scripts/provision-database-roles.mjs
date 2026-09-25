import "dotenv/config";

import postgres from "postgres";

const ownerUrl = process.env.DATABASE_OWNER_URL;
const appUrl = process.env.DATABASE_URL;
const opsControlUrl = process.env.OPS_CONTROL_DATABASE_URL;
const readWorkerUrl = process.env.READ_WORKER_DATABASE_URL;
if (!ownerUrl || !appUrl || !opsControlUrl || !readWorkerUrl) {
  throw new Error(
    "DATABASE_OWNER_URL, DATABASE_URL, OPS_CONTROL_DATABASE_URL, and READ_WORKER_DATABASE_URL are required",
  );
}

const roleUrls = [appUrl, opsControlUrl, readWorkerUrl];

const owner = postgres(ownerUrl, { max: 1 });
try {
  for (const connectionUrl of roleUrls) {
    const url = new URL(connectionUrl);
    const username = decodeURIComponent(url.username);
    const password = decodeURIComponent(url.password);
    const existing = await owner`
      select exists(select 1 from pg_roles where rolname = ${username}) as exists
    `;
    if (existing[0]?.exists) continue;
    const statement = await owner`
      select format(
        'create role %I login password %L',
        ${username}::text,
        ${password}::text
      ) as command
    `;
    if (!statement[0]) throw new Error("could not prepare role creation");
    await owner.unsafe(statement[0].command);
  }
} finally {
  await owner.end();
}
