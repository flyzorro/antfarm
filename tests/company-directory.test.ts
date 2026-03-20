import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const repoRoot = path.resolve(import.meta.dirname, "..");
const cliPath = path.join(repoRoot, "dist", "cli", "cli.js");

const tempDirs: string[] = [];

function createTempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "antfarm-company-directory-"));
  tempDirs.push(dir);
  return path.join(dir, "antfarm.db");
}

async function importFresh<T>(relativePath: string): Promise<T> {
  return import(`${relativePath}?nonce=${Date.now()}-${Math.random()}`) as Promise<T>;
}

afterEach(async () => {
  const dbModule = await importFresh<typeof import("../dist/db.js")>("../dist/db.js");
  dbModule.closeDbForTests();
  delete process.env.ANTFARM_DB_PATH;

  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("company directory backend", () => {
  it("creates company storage through the existing db migration path", async () => {
    process.env.ANTFARM_DB_PATH = createTempDbPath();

    const dbModule = await importFresh<typeof import("../dist/db.js")>("../dist/db.js");
    const db = dbModule.getDb();

    const table = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'companies'"
    ).get() as { name: string } | undefined;

    assert.equal(table?.name, "companies");
  });

  it("persists and lists companies in deterministic order", async () => {
    process.env.ANTFARM_DB_PATH = createTempDbPath();

    const dbModule = await importFresh<typeof import("../dist/db.js")>("../dist/db.js");
    dbModule.getDb();

    const companyModule = await importFresh<typeof import("../dist/company-directory.js")>("../dist/company-directory.js");

    const first = companyModule.createCompany("Alpha Co");
    const second = companyModule.createCompany("Beta Co");
    const companies = companyModule.listCompanies();

    assert.deepEqual(
      companies.map((company) => ({ id: company.id, name: company.name })),
      [
        { id: first.id, name: "Alpha Co" },
        { id: second.id, name: "Beta Co" },
      ]
    );
    assert.ok(companies.every((company) => company.createdAt.length > 0));
    assert.ok(companies.every((company) => company.updatedAt.length > 0));
  });

  it("exposes mechanically callable create and list paths via the CLI", () => {
    const dbPath = createTempDbPath();
    const env = { ...process.env, ANTFARM_DB_PATH: dbPath };

    const created = JSON.parse(
      execFileSync("node", [cliPath, "company", "create", "Gamma Co"], {
        cwd: repoRoot,
        encoding: "utf-8",
        env,
      })
    ) as { id: string; name: string };

    const listed = JSON.parse(
      execFileSync("node", [cliPath, "company", "list", "--json"], {
        cwd: repoRoot,
        encoding: "utf-8",
        env,
      })
    ) as Array<{ id: string; name: string }>;

    assert.equal(created.name, "Gamma Co");
    assert.deepEqual(listed, [created]);
  });
});
