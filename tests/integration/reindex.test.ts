// `krimto reindex` — rebuild index.db from the markdown source of truth. Specifically tested
// against the user's reported failure mode: manually deleted .md file leaves an orphan in the index.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import http from "node:http";

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

describe("krimto reindex with embeddings (H5 — vectors survive a reindex)", () => {
  it("rebuilds facts_vec from markdown when a provider is configured", async () => {
    // Fake OpenAI-shaped embeddings endpoint: one fixed 4-dim vector per input.
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const parsed = JSON.parse(body || "{}") as { input?: string[] };
        const data = (parsed.input ?? [""]).map(() => ({ embedding: [0.1, 0.2, 0.3, 0.4] }));
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ data }));
      });
    });
    await new Promise<void>((r) => server.listen(0, () => r()));
    const port = (server.address() as { port: number }).port;
    try {
      // Seed two facts on disk (lexical write — no embeddings yet).
      const db = openIndexDb(path.join(dataDir, "index.db"), { provider: "none", dimensions: 0 });
      const index = new FactIndex(db);
      const ctx: ToolContext = {
        store: new FactStore(dataDir),
        index,
        writeQueue: new Serializer(),
        requester: { identity: "user@localhost", teams: [] },
        membership: { org: { slug: "default", admins: [] }, teams: [], users: [] },
      };
      await krimtoWrite(ctx, { scope: "user/me", title: "A", body: "idempotency keys" });
      await krimtoWrite(ctx, { scope: "user/me", title: "B", body: "deploy tuesdays" });
      db.close();

      const { stdout } = await exec(process.execPath, [BIN, "reindex"], {
        env: {
          ...process.env,
          KRIMTO_DATA: dataDir,
          KRIMTO_EMBED_PROVIDER: "custom",
          KRIMTO_EMBED_API_KEY: "k",
          KRIMTO_EMBED_MODEL: "m",
          KRIMTO_EMBED_BASE_URL: `http://127.0.0.1:${port}`,
          KRIMTO_EMBED_DIMENSIONS: "4",
        },
      });
      expect(stdout).toContain("Reindexed from markdown");

      // Reopen and confirm vectors were populated (the bug left facts_vec empty after reindex).
      const db2 = openIndexDb(path.join(dataDir, "index.db"), { provider: "custom", dimensions: 4 });
      const index2 = new FactIndex(db2);
      expect(index2.factCount()).toBe(2);
      expect(index2.vectorCount()).toBe(2);
      db2.close();
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 30000);
});
