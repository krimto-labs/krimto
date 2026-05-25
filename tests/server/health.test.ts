import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { openIndexDb } from "../../src/index/db";
import { FactIndex } from "../../src/index/factIndex";
import { GitRepo } from "../../src/storage/git";
import { FactStore } from "../../src/storage/store";
import { CommitBatcher } from "../../src/storage/batcher";
import { sqliteHealth, indexHealth, healthReady, gitRemoteHealth, gitSyncCheck } from "../../src/server/health";

describe("health checks reflect real index state", () => {
  it("reports ok sqlite and a fact count once built", () => {
    const db = openIndexDb(":memory:", { provider: "none", dimensions: 0 });
    const idx = new FactIndex(db);
    expect(sqliteHealth(db).status).toBe("ok");
    expect(indexHealth(idx, false)).toMatchObject({ status: "ok", fact_count: 0 });
    expect(indexHealth(idx, true)).toMatchObject({ status: "building" });
    db.close();
  });

  it("healthReady is 200 only when sqlite and index are ok", () => {
    const ok = { status: "ok" } as const;
    const ready = healthReady("0.2.0", { sqlite: ok, index: { status: "ok", fact_count: 3 }, git_remote: ok });
    expect(ready.http).toBe(200);
    const notReady = healthReady("0.2.0", { sqlite: ok, index: { status: "building" }, git_remote: ok });
    expect(notReady.http).toBe(503);
  });
});

describe("gitRemoteHealth", () => {
  it("is ok before any push and when no remote is configured", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "krimto-grh-"));
    const repo = await GitRepo.open(dir);
    const batcher = new CommitBatcher(repo, { intervalMs: 60_000, maxBatch: 100 });
    expect(gitRemoteHealth(batcher).status).toBe("ok"); // "none"
    const store = new FactStore(dir);
    const { fact, path: rel } = await store.writeFact({ scope: "org/acme", title: "X", body: "y", author: "a@x.com" });
    await batcher.stage(rel, fact);
    await batcher.flush();
    expect(gitRemoteHealth(batcher).status).toBe("ok"); // "skipped"
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("reports error after a failed push", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "krimto-grh-"));
    const repo = await GitRepo.open(dir);
    await repo.setRemote(path.join(os.tmpdir(), "krimto-no-such-remote-xyz.git"));
    const batcher = new CommitBatcher(repo, { intervalMs: 60_000, maxBatch: 100 });
    const store = new FactStore(dir);
    const { fact, path: rel } = await store.writeFact({ scope: "org/acme", title: "X", body: "y", author: "a@x.com" });
    await batcher.stage(rel, fact);
    await batcher.flush();
    expect(gitRemoteHealth(batcher).status).toBe("error");
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("a failed remote does not block readiness", () => {
    const ok = { status: "ok" } as const;
    const r = healthReady("0.2.0", { sqlite: ok, index: { status: "ok", fact_count: 1 }, git_remote: { status: "error" } });
    expect(r.http).toBe(200);
  });
});

describe("gitSyncCheck (BUG-3 visibility)", () => {
  it("surfaces pull failures/conflicts as error status, healthy states as ok", () => {
    expect(gitSyncCheck("error").status).toBe("error");
    expect(gitSyncCheck("conflict").status).toBe("error");
    expect(gitSyncCheck("ok").status).toBe("ok");
    expect(gitSyncCheck("up-to-date").status).toBe("ok");
    expect(gitSyncCheck("none").status).toBe("ok");
  });

  it("a failed pull is visible but does not block readiness", () => {
    const ok = { status: "ok" } as const;
    const r = healthReady("0.2.0", {
      sqlite: ok,
      index: { status: "ok", fact_count: 1 },
      git_remote: ok,
      git_sync: gitSyncCheck("error"),
    });
    expect(r.http).toBe(200); // visible in body.checks.git_sync, but never 503
    expect(r.body.checks.git_sync?.status).toBe("error");
  });
});
