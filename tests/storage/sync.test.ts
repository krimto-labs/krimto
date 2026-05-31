import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { GitRepo } from "../../src/storage/git";
import { FactStore } from "../../src/storage/store";
import { RemoteSync, syncConfigFromEnv, DEFAULT_SYNC_CONFIG } from "../../src/storage/sync";
const execFileP = promisify(execFile);

describe("syncConfigFromEnv", () => {
  it("defaults when unset, parses valid, falls back on invalid", () => {
    expect(syncConfigFromEnv({})).toEqual(DEFAULT_SYNC_CONFIG);
    expect(syncConfigFromEnv({ KRIMTO_PULL_INTERVAL_MS: "5000" }).intervalMs).toBe(5000);
    expect(syncConfigFromEnv({ KRIMTO_PULL_INTERVAL_MS: "0" }).intervalMs).toBe(DEFAULT_SYNC_CONFIG.intervalMs);
    expect(syncConfigFromEnv({ KRIMTO_PULL_INTERVAL_MS: "abc" }).intervalMs).toBe(DEFAULT_SYNC_CONFIG.intervalMs);
  });
});

describe("RemoteSync", () => {
  let bare: string;
  let dir: string;
  let mate: string;
  beforeEach(async () => {
    bare = await fs.mkdtemp(path.join(os.tmpdir(), "krimto-bare-"));
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "krimto-local-"));
    mate = await fs.mkdtemp(path.join(os.tmpdir(), "krimto-mate-"));
    await execFileP("git", ["init", "--bare", "-q", "-b", "main", bare]); // pin main so it matches the app on a master-default git (CI)
    const repo = await GitRepo.open(dir);
    const store = new FactStore(dir);
    const { path: rel } = await store.writeFact({ scope: "org/acme", title: "Seed", body: "seed", author: "a@x.com" });
    await repo.stage(rel);
    await repo.commit("krimto: seed");
    await repo.setRemote(bare);
    await repo.push();
    await execFileP("git", ["clone", "-q", bare, mate]);
    await execFileP("git", ["-C", mate, "config", "user.email", "mate@x.com"]);
    await execFileP("git", ["-C", mate, "config", "user.name", "Mate"]);
  });
  afterEach(async () => {
    for (const d of [bare, dir, mate]) await fs.rm(d, { recursive: true, force: true });
  });

  it("calls onPulledChanges only when the pull brought changes", async () => {
    const repo = await GitRepo.open(dir);
    const onChanged = vi.fn(async () => {});
    const sync = new RemoteSync(repo, onChanged, { intervalMs: 60_000 });

    await sync.pullOnce();
    expect(onChanged).not.toHaveBeenCalled();
    expect(sync.lastPullStatus()).toBe("up-to-date");

    await fs.mkdir(path.join(mate, "org/acme"), { recursive: true });
    await fs.writeFile(path.join(mate, "org/acme/mate.md"), "---\nid: x\n---\nnote\n", "utf8");
    await execFileP("git", ["-C", mate, "add", "-A"]);
    await execFileP("git", ["-C", mate, "commit", "-qm", "mate: add"]);
    await execFileP("git", ["-C", mate, "push", "-q"]);

    await sync.pullOnce();
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(sync.lastPullStatus()).toBe("ok");
  });

  it("reports skipped when no remote is configured and does not call onPulledChanges", async () => {
    const solo = await fs.mkdtemp(path.join(os.tmpdir(), "krimto-solo-"));
    const repo = await GitRepo.open(solo);
    const onChanged = vi.fn(async () => {});
    const sync = new RemoteSync(repo, onChanged, { intervalMs: 60_000 });
    await sync.pullOnce();
    expect(sync.lastPullStatus()).toBe("skipped");
    expect(onChanged).not.toHaveBeenCalled();
    await fs.rm(solo, { recursive: true, force: true });
  });

  it("lastPullStatus defaults to none before any pull", async () => {
    const repo = await GitRepo.open(dir);
    const sync = new RemoteSync(repo, vi.fn(async () => {}), { intervalMs: 60_000 });
    expect(sync.lastPullStatus()).toBe("none");
  });

  it("runs pullOnce on its interval (real timer, short interval)", async () => {
    const solo = await fs.mkdtemp(path.join(os.tmpdir(), "krimto-solo-"));
    const repo = await GitRepo.open(solo); // no remote -> pull returns skipped
    const sync = new RemoteSync(repo, vi.fn(async () => {}), { intervalMs: 40 });
    expect(sync.lastPullStatus()).toBe("none");
    sync.start((fn) => fn());
    await new Promise((r) => setTimeout(r, 120));
    sync.stop();
    expect(sync.lastPullStatus()).toBe("skipped"); // the timer fired pullOnce
    await fs.rm(solo, { recursive: true, force: true });
  });

  it("does not throw when onPulledChanges fails; reports error", async () => {
    // teammate pushes a real change so onPulledChanges would be invoked
    await fs.mkdir(path.join(mate, "org/acme"), { recursive: true });
    await fs.writeFile(path.join(mate, "org/acme/mate2.md"), "---\nid: y\n---\nnote\n", "utf8");
    await execFileP("git", ["-C", mate, "add", "-A"]);
    await execFileP("git", ["-C", mate, "commit", "-qm", "mate: add2"]);
    await execFileP("git", ["-C", mate, "push", "-q"]);
    const repo = await GitRepo.open(dir);
    const sync = new RemoteSync(repo, async () => { throw new Error("indexer boom"); }, { intervalMs: 60_000 });
    const res = await sync.pullOnce(); // must NOT throw
    expect(res.status).toBe("error");
    expect(sync.lastPullStatus()).toBe("error");
  });

  it("on a rebase conflict: aborts, does not re-index, reports conflict", async () => {
    // teammate edits the seed file and pushes
    await fs.writeFile(path.join(mate, "org/acme/seed.md"), "---\nid: s\n---\nteammate version\n", "utf8");
    await execFileP("git", ["-C", mate, "commit", "-aqm", "mate: edit seed"]);
    await execFileP("git", ["-C", mate, "push", "-q"]);
    // krimto makes a conflicting local commit
    const repo = await GitRepo.open(dir);
    await fs.writeFile(path.join(dir, "org/acme/seed.md"), "---\nid: s\n---\nkrimto version\n", "utf8");
    await execFileP("git", ["-C", dir, "commit", "-aqm", "krimto: edit seed"]);
    const onChanged = vi.fn(async () => {});
    const sync = new RemoteSync(repo, onChanged, { intervalMs: 60_000 });
    const res = await sync.pullOnce();
    expect(res.status).toBe("conflict");
    expect(onChanged).not.toHaveBeenCalled();
    expect(sync.lastPullStatus()).toBe("conflict");
  });

  it("pulls inbound changes even when a local write is staged but uncommitted (autostash)", async () => {
    const repo = await GitRepo.open(dir);
    const store = new FactStore(dir);

    // Local pending write: stage a NEW fact but don't commit — the batcher's between-cycle state.
    const { path: rel } = await store.writeFact({ scope: "user/me", title: "Local pending", body: "draft idea", author: "me@x.com" });
    await repo.stage(rel);

    // Teammate pushes a different fact to the remote.
    await fs.mkdir(path.join(mate, "org/acme"), { recursive: true });
    await fs.writeFile(path.join(mate, "org/acme/mate3.md"), "---\nid: m3\n---\nteammate note\n", "utf8");
    await execFileP("git", ["-C", mate, "add", "-A"]);
    await execFileP("git", ["-C", mate, "commit", "-qm", "mate: add3"]);
    await execFileP("git", ["-C", mate, "push", "-q"]);

    // RED today: the dirty index makes `git pull --rebase` abort → error, silently dropping the update.
    const res = await repo.pull();
    expect(res.status).toBe("ok");
    expect(res.changedFiles).toContain("org/acme/mate3.md");
    // The local pending write survives the rebase (re-applied from the autostash).
    expect(await fs.readFile(path.join(dir, rel), "utf8")).toContain("draft idea");
  });

  it("never reports ok or writes conflict markers when an inbound change overlaps a pending edit", async () => {
    const repo = await GitRepo.open(dir);
    // Local UNCOMMITTED edit to the seed file (same lines the teammate will change). With --autostash
    // this fast-forwards then the stash RE-APPLY conflicts — and `git pull` still exits 0.
    await fs.writeFile(path.join(dir, "org/acme/seed.md"), "---\nid: s\n---\nLOCAL pending edit\n", "utf8");
    await fs.writeFile(path.join(mate, "org/acme/seed.md"), "---\nid: s\n---\nREMOTE teammate edit\n", "utf8");
    await execFileP("git", ["-C", mate, "commit", "-aqm", "mate: edit seed"]);
    await execFileP("git", ["-C", mate, "push", "-q"]);

    const res = await repo.pull();
    expect(res.status).toBe("conflict"); // must NOT silently report ok
    const seed = await fs.readFile(path.join(dir, "org/acme/seed.md"), "utf8");
    expect(seed).not.toContain("<<<<<<<"); // no conflict markers left on disk to be indexed/committed
    expect(seed).not.toContain(">>>>>>>");
  });
});
