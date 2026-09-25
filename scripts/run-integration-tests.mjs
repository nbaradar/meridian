import "dotenv/config";

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import postgres from "postgres";

const ownerUrl = process.env.DATABASE_OWNER_URL;
const applicationUrl = process.env.DATABASE_URL;
if (!ownerUrl || !applicationUrl) {
  throw new Error(
    "DATABASE_OWNER_URL and DATABASE_URL are required for integration tests",
  );
}

function roleUrlFrom(connectionUrl, username, password) {
  const url = new URL(connectionUrl);
  url.username = username;
  url.password = password;
  return url.toString();
}

const opsControlUrl =
  process.env.OPS_CONTROL_DATABASE_URL ??
  roleUrlFrom(applicationUrl, "meridian_ops_control", "meridian_ops_control");
const readWorkerUrl =
  process.env.READ_WORKER_DATABASE_URL ??
  roleUrlFrom(applicationUrl, "meridian_read_worker", "meridian_read_worker");

const databaseName = `meridian_test_${randomUUID().replaceAll("-", "")}`;

function withDatabase(connectionUrl, name) {
  const url = new URL(connectionUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

function runPnpm(arguments_, environment) {
  const pnpmCli = process.env.npm_execpath;
  if (!pnpmCli) throw new Error("pnpm executable path is unavailable");
  const result = spawnSync(process.execPath, [pnpmCli, ...arguments_], {
    cwd: process.cwd(),
    env: environment,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

const admin = postgres(withDatabase(ownerUrl, "postgres"), { max: 1 });
let exitCode = 1;

async function ensureLoginRole(connectionUrl) {
  const url = new URL(connectionUrl);
  const username = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  const existing = await admin`
    select exists(select 1 from pg_roles where rolname = ${username}) as exists
  `;
  if (existing[0]?.exists) return;
  const statement = await admin`
    select format(
      'create role %I login password %L',
      ${username}::text,
      ${password}::text
    ) as command
  `;
  if (!statement[0]) throw new Error("could not prepare integration role");
  await admin.unsafe(statement[0].command);
}

try {
  await ensureLoginRole(opsControlUrl);
  await ensureLoginRole(readWorkerUrl);
  await admin.unsafe(`create database "${databaseName}"`);
  const environment = {
    ...process.env,
    DATABASE_OWNER_URL: withDatabase(ownerUrl, databaseName),
    DATABASE_URL: withDatabase(applicationUrl, databaseName),
    OPS_CONTROL_DATABASE_URL: withDatabase(opsControlUrl, databaseName),
    READ_WORKER_DATABASE_URL: withDatabase(readWorkerUrl, databaseName),
  };

  exitCode = runPnpm(["db:migrate"], environment);
  if (exitCode === 0) {
    exitCode = runPnpm(
      ["exec", "vitest", "run", "--config", "vitest.integration.config.ts"],
      environment,
    );
  }
} finally {
  await admin.unsafe(`drop database if exists "${databaseName}" with (force)`);
  await admin.end();
}

process.exitCode = exitCode;
