import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { expect, test } from "vitest";

// Private exports live under docs/ but are gitignored and never documentation.
const ignoredDirectories = new Set(["ynab_exports"]);

async function markdownFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        return ignoredDirectories.has(entry.name) ? [] : markdownFiles(path);
      }
      return entry.name.endsWith(".md") ? [path] : [];
    }),
  );
  return nested.flat();
}

function relativeLinks(markdown) {
  return [...markdown.matchAll(/\]\(([^)\s]+)\)/gu)]
    .map((match) => match[1])
    .filter((target) => !/^[a-z]+:/iu.test(target) && !target.startsWith("#"))
    .map((target) => target.split("#")[0]);
}

test("every document under docs/ declares summary and read_when front matter", async () => {
  for (const file of await markdownFiles("docs")) {
    const source = await readFile(file, "utf8");
    const frontMatter = /^---\nsummary: (.+)\nread_when: (.+)\n---\n/u.exec(
      source,
    );
    expect(
      frontMatter,
      `${file} needs summary/read_when front matter`,
    ).not.toBeNull();
  }
});

// docs/README.md indexes everything except individual plans, which
// docs/plans/README.md indexes alongside their status.
const indexFiles = ["docs/README.md", "docs/plans/README.md"];

test("the docs indexes list every document", async () => {
  const indexed = new Set();
  for (const indexFile of indexFiles) {
    const index = await readFile(indexFile, "utf8");
    for (const target of relativeLinks(index)) {
      indexed.add(join(dirname(indexFile), target));
    }
  }
  for (const file of await markdownFiles("docs")) {
    if (file === join("docs", "README.md")) continue;
    expect(indexed.has(file), `${file} is missing from the docs indexes`).toBe(
      true,
    );
  }
});

test("relative links in project documentation resolve", async () => {
  const files = [
    "AGENTS.md",
    "PLAN.md",
    "README.md",
    ...(await markdownFiles("docs")),
  ];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    for (const target of relativeLinks(source)) {
      const resolved = join(dirname(file), target);
      expect(
        existsSync(resolved),
        `${file} links to missing ${relative(".", resolved)}`,
      ).toBe(true);
    }
  }
});

test("CLAUDE.md loads the AGENTS.md contract", async () => {
  expect((await readFile("CLAUDE.md", "utf8")).trim()).toBe("@AGENTS.md");
});

const planStatuses = ["Draft", "Approved", "In progress", "Done", "Superseded"];

async function plans() {
  const names = (await readdir("docs/plans")).filter((name) =>
    /^\d{4}-.+\.md$/u.test(name),
  );
  return Promise.all(
    names.map(async (name) => {
      const source = await readFile(join("docs/plans", name), "utf8");
      const status = /^- Status: (.+)$/mu.exec(source)?.[1];
      const openQuestions =
        /^## Open questions\n([\s\S]*?)^## /mu.exec(source)?.[1] ?? "";
      return { name, source, status, openQuestions };
    }),
  );
}

test("every plan has a valid status that matches the plans index", async () => {
  const index = await readFile("docs/plans/README.md", "utf8");
  for (const plan of await plans()) {
    expect(planStatuses, `${plan.name} status`).toContain(plan.status);
    const row = index
      .split("\n")
      .find((line) => line.includes(`](${plan.name})`));
    expect(row, `${plan.name} row in docs/plans/README.md`).toBeDefined();
    const cells = row.split("|").map((cell) => cell.trim());
    expect(cells, `${plan.name} index status`).toContain(plan.status);
  }
});

test("approved and later plans have no open questions", async () => {
  for (const plan of await plans()) {
    if (plan.status === "Draft" || plan.status === "Superseded") continue;
    expect(
      plan.openQuestions.trim(),
      `${plan.name} is ${plan.status} but still has open questions`,
    ).toMatch(/^(?:None\.?)?$/u);
  }
});

test("at most one plan is in progress, and status.md links it", async () => {
  const inProgress = (await plans()).filter(
    (plan) => plan.status === "In progress",
  );
  expect(inProgress.length).toBeLessThanOrEqual(1);
  const status = await readFile("docs/status.md", "utf8");
  for (const plan of inProgress) {
    expect(status, `docs/status.md must link ${plan.name}`).toContain(
      `plans/${plan.name}`,
    );
  }
});

test("paths named in AGENTS.md exist", async () => {
  const source = await readFile("AGENTS.md", "utf8");
  const paths = [
    ...source.matchAll(/`((?:docs\/|src\/|\.claude\/)?[\w./-]+\.md)`/gu),
  ].map((match) => match[1]);
  expect(paths.length).toBeGreaterThan(15);
  for (const path of paths) {
    expect(existsSync(path), `AGENTS.md names missing ${path}`).toBe(true);
  }
});
