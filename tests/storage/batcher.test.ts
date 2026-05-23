import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileP = promisify(execFile);

import { GitRepo } from "../../src/storage/git";
import { FactStore } from "../../src/storage/store";
import { createFact } from "../../src/storage/fact";
import {
  CommitBatcher,
  batchCommitMessage,
  batcherConfigFromEnv,
  DEFAULT_BATCHER_CONFIG,
} from "../../src/storage/batcher";

describe("batcherConfigFromEnv", () => {
  it("defaults when unset, parses valid, falls back on invalid", () => {
    expect(batcherConfigFromEnv({})).toEqual(DEFAULT_BATCHER_CONFIG);
    expect(batcherConfigFromEnv({ KRIMTO_COMMIT_INTERVAL_MS: "5000", KRIMTO_COMMIT_MAX_BATCH: "3" })).toEqual({
      intervalMs: 5000,
      maxBatch: 3,
    });
    expect(batcherConfigFromEnv({ KRIMTO_COMMIT_MAX_BATCH: "0" }).maxBatch).toBe(DEFAULT_BATCHER_CONFIG.maxBatch);
    expect(batcherConfigFromEnv({ KRIMTO_COMMIT_INTERVAL_MS: "abc" }).intervalMs).toBe(
      DEFAULT_BATCHER_CONFIG.intervalMs,
    );
    expect(batcherConfigFromEnv({ KRIMTO_COMMIT_MAX_BATCH: "-5" }).maxBatch).toBe(DEFAULT_BATCHER_CONFIG.maxBatch);
  });
});

describe("batchCommitMessage", () => {
  it("lists each fact and the co-authored-by trailer", () => {
    const a = createFact({ scope: "team/payments", title: "Stripe", body: "x", author: "alice@acme.com" });
    const b = createFact({ scope: "org/acme", title: "Deploy", body: "y", author: "bob@acme.com" });
    const msg = batchCommitMessage([a, b]);
    expect(msg).toContain("krimto: write batch — 2 facts");
    expect(msg).toContain(`- [team/payments] Stripe (${a.frontmatter.id}) by alice@acme.com`);
    expect(msg).toContain(`- [org/acme] Deploy (${b.frontmatter.id}) by bob@acme.com`);
    expect(msg).toContain("Co-authored-by: Krimto-Server <krimto@localhost>");
  });

  it("uses singular wording for one fact", () => {
    const a = createFact({ scope: "org/acme", title: "X", body: "x", author: "a@x.com" });
    expect(batchCommitMessage([a])).toContain("krimto: write batch — 1 fact");
  });
});

describe("CommitBatcher", () => {
  let dir: string;
  let repo: GitRepo;
  let store: FactStore;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "krimto-batch-"));
    repo = await GitRepo.open(dir);
    store = new FactStore(dir);
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function stageNew(batcher: CommitBatcher, i: number): Promise<void> {
    const { fact, path: rel } = await store.writeFact({
      scope: "org/acme",
      title: `Fact ${i}`,
      body: `body ${i}`,
      author: "a@x.com",
    });
    await batcher.stage(rel, fact);
  }

  it("does not commit until maxBatch is reached", async () => {
    const batcher = new CommitBatcher(repo, { intervalMs: 60_000, maxBatch: 3 });
    await stageNew(batcher, 1);
    await stageNew(batcher, 2);
    expect(batcher.pendingCount()).toBe(2);
    expect(await repo.head()).toBeNull();
    await stageNew(batcher, 3);
    expect(batcher.pendingCount()).toBe(0);
    expect(await repo.head()).toMatch(/^[0-9a-f]{40}$/);
  });

  it("flush() commits pending and returns the SHA; empty flush returns null", async () => {
    const batcher = new CommitBatcher(repo, { intervalMs: 60_000, maxBatch: 100 });
    expect(await batcher.flush()).toBeNull();
    await stageNew(batcher, 1);
    const sha = await batcher.flush();
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(batcher.pendingCount()).toBe(0);
    expect(await batcher.flush()).toBeNull();
  });

  it("starts a fresh batch after a flush", async () => {
    const batcher = new CommitBatcher(repo, { intervalMs: 60_000, maxBatch: 100 });
    await stageNew(batcher, 1);
    const first = await batcher.flush();
    await stageNew(batcher, 2);
    const second = await batcher.flush();
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
  });

  it("flushes on its interval (real timer, short interval)", async () => {
    const batcher = new CommitBatcher(repo, { intervalMs: 40, maxBatch: 100 });
    await stageNew(batcher, 1);
    expect(await repo.head()).toBeNull();
    batcher.start((fn) => fn());
    await new Promise((r) => setTimeout(r, 120));
    batcher.stop();
    expect(batcher.pendingCount()).toBe(0);
    expect(await repo.head()).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("CommitBatcher remote push", () => {
  let dir: string;
  let remoteDir: string;
  let repo: GitRepo;
  let store: FactStore;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "krimto-batchpush-"));
    remoteDir = await fs.mkdtemp(path.join(os.tmpdir(), "krimto-remote-"));
    await execFileP("git", ["init", "--bare", "-q", remoteDir]);
    repo = await GitRepo.open(dir);
    store = new FactStore(dir);
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(remoteDir, { recursive: true, force: true });
  });

  async function stageNew(batcher: CommitBatcher, i: number): Promise<void> {
    const { fact, path: rel } = await store.writeFact({
      scope: "org/acme",
      title: `Fact ${i}`,
      body: `body ${i}`,
      author: "a@x.com",
    });
    await batcher.stage(rel, fact);
  }

  it("pushes the batch commit to a configured remote", async () => {
    await repo.setRemote(remoteDir);
    const batcher = new CommitBatcher(repo, { intervalMs: 60_000, maxBatch: 100 });
    await stageNew(batcher, 1);
    await batcher.flush();
    expect(batcher.lastPushStatus()).toBe("ok");
    const { stdout } = await execFileP("git", ["-C", remoteDir, "rev-list", "--all"]);
    expect(stdout.trim()).not.toBe("");
  });

  it("commits and reports skipped push when no remote is configured", async () => {
    const batcher = new CommitBatcher(repo, { intervalMs: 60_000, maxBatch: 100 });
    expect(batcher.lastPushStatus()).toBe("none");
    await stageNew(batcher, 1);
    await batcher.flush();
    expect(batcher.lastPushStatus()).toBe("skipped");
    expect(await repo.head()).toMatch(/^[0-9a-f]{40}$/);
  });
});
