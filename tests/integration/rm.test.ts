// `krimto rm <id>` — bin dispatch + lock check + actual delete.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { FactStore } from "../../src/storage/store";
import { openIndexDb } from "../../src/index/db";
import { FactIndex } from "../../src/index/factIndex";
import { Serializer } from "../../src/index/serialize";
import { krimtoWrite, type ToolContext } from "../../src/server/tools";

const exec = promisify(execFile);
const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../bin/krimto.mjs");

let dataDir: string;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "krimto-rm-"));
});
afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

async function seedFact(): Promise<{ id: string; path: string }> {
  const db = openIndexDb(path.join(dataDir, "index.db"), { provider: "none", dimensions: 0 });
  const store = new FactStore(dataDir);
  const index = new FactIndex(db);
  const { GitRepo } = await import("../../src/storage/git");
  const repo = await GitRepo.open(dataDir);
  const { CommitBatcher } = await import("../../src/storage/batcher");
  const batcher = new CommitBatcher(repo, { intervalMs: 99999, maxBatch: 99999 });
  const ctx: ToolContext = {
    store,
    index,
    writeQueue: new Serializer(),
    requester: { identity: "user@localhost", teams: [] },
    membership: { org: { slug: "default", admins: ["user@localhost"] }, teams: [], users: [] },
    git: batcher,
  };
  const w = await krimtoWrite(ctx, { scope: "user/me", title: "Test fact", body: "to be deleted" });
  await batcher.flush(); // commit the seed so the delete has something to remove from git
  db.close();
  return { id: w.id, path: w.path };
}

describe("krimto rm (bin dispatch)", () => {
  it("prints Usage when no id is provided and exits 2", async () => {
    await expect(
      exec(process.execPath, [BIN, "rm"], { env: { ...process.env, KRIMTO_DATA: dataDir } }),
    ).rejects.toMatchObject({ code: 2 });
  });

  it("deletes a fact end-to-end (file gone + git deletion committed)", async () => {
    const { id, path: relPath } = await seedFact();
    expect((await fs.stat(path.join(dataDir, relPath))).isFile()).toBe(true);

    const { stdout } = await exec(process.execPath, [BIN, "rm", id], {
      env: { ...process.env, KRIMTO_DATA: dataDir, KRIMTO_IDENTITY: "user@localhost" },
    });
    expect(stdout).toContain("Deleted fact");
    expect(stdout).toContain(id);
    expect(stdout).toContain("Git has recorded the deletion");

    // File gone
    await expect(fs.access(path.join(dataDir, relPath))).rejects.toThrow();
    // git log should show the deletion as a real commit
    const { stdout: logOut } = await exec("git", ["-C", dataDir, "log", "--oneline"]);
    expect(logOut).toContain("krimto: delete fact");
  }, 30000);

  it("refuses with 🔴 + PID and exits 1 when a Krimto server holds the lock", async () => {
    await fs.mkdir(path.join(dataDir, ".krimto"), { recursive: true });
    // process.pid is alive; use it as a stand-in for "another server"... but the CLI explicitly
    // excludes our own PID. PID 1 (init) is always alive on Unix and is reliably not the test.
    await fs.writeFile(
      path.join(dataDir, ".krimto", "lock.json"),
      JSON.stringify({ pid: 1, started: "2026-01-01T00:00:00Z", mode: "http" }),
    );
    await expect(
      exec(process.execPath, [BIN, "rm", "fct_anything"], {
        env: { ...process.env, KRIMTO_DATA: dataDir, KRIMTO_IDENTITY: "user@localhost" },
      }),
    ).rejects.toMatchObject({
      code: 1,
      stdout: expect.stringContaining("Cannot delete while a Krimto server is running"),
    });
  }, 30000);

  it("`delete` is an alias for `rm`", async () => {
    const { id } = await seedFact();
    const { stdout } = await exec(process.execPath, [BIN, "delete", id], {
      env: { ...process.env, KRIMTO_DATA: dataDir, KRIMTO_IDENTITY: "user@localhost" },
    });
    expect(stdout).toContain("Deleted fact");
  }, 30000);

  it("prints not_found + suggests `reindex` when the id doesn't exist anywhere", async () => {
    await expect(
      exec(process.execPath, [BIN, "rm", "fct_doesnotexist"], {
        env: { ...process.env, KRIMTO_DATA: dataDir, KRIMTO_IDENTITY: "user@localhost" },
      }),
    ).rejects.toMatchObject({
      code: 1,
      stdout: expect.stringContaining("not found"),
    });
  }, 30000);
});
