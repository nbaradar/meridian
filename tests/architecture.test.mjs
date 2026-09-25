import { readFile, readdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { expect, test } from "vitest";

const sourceExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs"]);
async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? sourceFiles(path) : [path];
    }),
  );
  return nested.flat().filter((path) => sourceExtensions.has(extname(path)));
}

async function allFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? allFiles(path) : [path];
    }),
  );
  return nested.flat();
}

test("core, modules, and infrastructure do not depend on Next.js", async () => {
  const files = (
    await Promise.all([
      sourceFiles("src/core"),
      sourceFiles("src/modules"),
      sourceFiles("src/infrastructure"),
    ])
  ).flat();
  for (const file of files) {
    const source = await readFile(file, "utf8");
    expect(source, file).not.toMatch(
      /(?:from|import\s*)[\s(]*["']next(?:\/[^"']*)?["']/u,
    );
  }
});

test("account-source linkage does not depend on transaction recording", async () => {
  const files = [
    "src/core/ledger/account-sources.ts",
    "src/infrastructure/database/postgres-account-sources.ts",
  ];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    expect(source, file).not.toMatch(/["'][^"']*core\/ledger["']/u);
    expect(source, file).not.toMatch(
      /(?:from|import\s*)[\s(]*["'][^"']*(?:transaction|source-record)[^"']*["']/u,
    );
    expect(source, file).not.toMatch(/\b(?:transactions|sourceRecords)\b/u);
  }
});

test("YNAB account decisions cannot record source records or transactions", async () => {
  const files = [
    "src/modules/ynab/account-decisions.ts",
    "src/infrastructure/database/postgres-ynab-account-decisions.ts",
    "src/infrastructure/ynab/label-digest.ts",
  ];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    expect(source, file).not.toMatch(
      /(?:from|import\s*)[\s(]*["'][^"']*(?:transaction|source-record)[^"']*["']/u,
    );
    expect(source, file).not.toMatch(
      /ledger\.(?:transactions|entries|source_records|raw_payloads|imports)\b/u,
    );
    expect(source, file).not.toMatch(/\b(?:console|logger)\s*\./u);
  }
});

test("account-source linkage has no provider-native identity surface", async () => {
  const files = [
    "src/core/ledger/account-sources.ts",
    "src/infrastructure/database/postgres-account-sources.ts",
    "drizzle/0007_romantic_mephisto.sql",
    "drizzle/meta/0007_snapshot.json",
    ...(await allFiles("tests/fixtures")),
  ];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    expect(source, file).not.toMatch(
      /(?:provider[_A-Z -]?account[_A-Z -]?(?:id|ref|key|number|mask)|native[_A-Z -]?account|connection[_A-Z -]?id|account[_A-Z -]?(?:number|mask)|routing[_A-Z -]?number|source[_A-Z -]?account[_A-Z -]?ref|credential|access[_A-Z -]?token|refresh[_A-Z -]?token)/iu,
    );
    if (file.includes("account-source")) {
      expect(source, file).not.toMatch(/\b(?:console|logger)\s*\./u);
    }
  }

  const schema = await readFile(
    "src/infrastructure/database/schema.ts",
    "utf8",
  );
  const accountSourceBoundary = schema.slice(
    schema.indexOf("export const accountSources"),
    schema.indexOf("export const accountSourceLinkRevisions"),
  );
  expect(accountSourceBoundary).not.toMatch(
    /(?:provider[_A-Z -]?account[_A-Z -]?(?:id|ref|key|number|mask)|native[_A-Z -]?account|connection[_A-Z -]?id|account[_A-Z -]?(?:number|mask)|routing[_A-Z -]?number|source[_A-Z -]?account[_A-Z -]?ref|credential|access[_A-Z -]?token|refresh[_A-Z -]?token)/iu,
  );
});

test("web adapters cannot load operational protection or worker databases", async () => {
  const files = await allFiles("src/app");
  for (const file of files) {
    const source = await readFile(file, "utf8");
    expect(source, file).not.toMatch(
      /(?:from|import\s*)[\s(]*["'][^"']*(?:protected-data|createReadWorkerDatabase|credentialProtectionEnvironment|identityProtectionEnvironment)[^"']*["']/u,
    );
  }
});

test("operational key access stays inside protected-data and read workers", async () => {
  const files = await allFiles("src");
  for (const file of files) {
    if (
      file.includes("src/infrastructure/protected-data/") ||
      file.includes("src/infrastructure/read-worker/")
    ) {
      continue;
    }
    const source = await readFile(file, "utf8");
    expect(source, file).not.toMatch(
      /(?:from|import\s*)[\s(]*["'][^"']*protected-data[^"']*["']/u,
    );
  }
});
