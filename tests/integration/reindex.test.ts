// `krimto reindex` — rebuild index.db from the markdown source of truth. Specifically tested
// against the user's reported failure mode: manually deleted .md file leaves an orphan in the index.

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
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "krimto-reindex-"));
});
afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe("krimto reindex (bin dispatch)", () => {
  it("drops orphan index entries whose .md file was deleted manually (the user's failure mode)", async () => {
    // Seed two facts
    const db = openIndexDb(path.join(dataDir, "index.db"), { provider: "none", dimensions: 0 });
    const store = new FactStore(dataDir);
    const index = new FactIndex(db);
    const ctx: ToolContext = {
      store, index, writeQueue: new Serializer(),
      requester: { identity: "user@localhost", teams: [] },
      membership: { org: { slug: "default", admins: [] }, teams: [], users: [] },
    };
    const a = await krimtoWrite(ctx, { scope: "user/me", title: "Keep this", body: "x" });
    const b = await krimtoWrite(ctx, { scope: "user/me", title: "Stale orphan", body: "y" });
    expect(index.factCount()).toBe(2);
    // Manually delete fact B's .md — same failure mode the user reported
    await fs.unlink(path.join(dataDir, b.path));
    db.close();

    const { stdout } = await exec(process.execPath, [BIN, "reindex"], {
      env: { ...process.env, KRIMTO_DATA: dataDir },
    });
    expect(stdout).toContain("Reindexed from markdown");
    expect(stdout).toContain("1 fact now indexed");
    expect(stdout).toMatch(/dropped 1 orphan entr/);
    // Verify by reopening the index
    const db2 = openIndexDb(path.join(dataDir, "index.db"), { provider: "none", dimensions: 0 });
    const index2 = new FactIndex(db2);
    expect(index2.factCount()).toBe(1);
    expect(index2.getFact(a.id)).not.toBeNull();
    expect(index2.getFact(b.id)).toBeNull();
  }, 30000);

  it("reports 'No changes' when the index already matches the markdown", async () => {
    const db = openIndexDb(path.join(dataDir, "index.db"), { provider: "none", dimensions: 0 });
    const store = new FactStore(dataDir);
    const index = new FactIndex(db);
    const ctx: ToolContext = {
      store, index, writeQueue: new Serializer(),
      requester: { identity: "user@localhost", teams: [] },
      membership: { org: { slug: "default", admins: [] }, teams: [], users: [] },
    };
    await krimtoWrite(ctx, { scope: "user/me", title: "Steady", body: "x" });
    db.close();

    const { stdout } = await exec(process.execPath, [BIN, "reindex"], {
      env: { ...process.env, KRIMTO_DATA: dataDir },
    });
    expect(stdout).toContain("No changes");
  }, 30000);

  it("refuses when a Krimto server holds the lock", async () => {
    await fs.mkdir(path.join(dataDir, ".krimto"), { recursive: true });
    await fs.writeFile(
      path.join(dataDir, ".krimto", "lock.json"),
      JSON.stringify({ pid: 1, started: "2026-01-01T00:00:00Z", mode: "http" }),
    );
    await expect(
      exec(process.execPath, [BIN, "reindex"], { env: { ...process.env, KRIMTO_DATA: dataDir } }),
    ).rejects.toMatchObject({
      code: 1,
      stdout: expect.stringContaining("Cannot reindex while a Krimto server is running"),
    });
  }, 30000);
});
