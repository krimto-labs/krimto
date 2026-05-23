import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { GitRepo } from "../../src/storage/git";
import { FactStore } from "../../src/storage/store";
const execFileP = promisify(execFile);

describe("GitRepo", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "krimto-git-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("initializes, stages, and commits, returning the SHA", async () => {
    const repo = await GitRepo.open(dir);
    expect(await repo.isRepo()).toBe(true);
    const store = new FactStore(dir);
    const { path: rel } = await store.writeFact({
      scope: "team/payments",
      title: "Stripe webhooks",
      body: "verify the signature",
      author: "alice@acme.com",
    });
    await repo.stage(rel);
    const sha = await repo.commit("krimto: test");
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(await repo.head()).toBe(sha);
  });

  it("commit returns null when there is nothing to commit", async () => {
    const repo = await GitRepo.open(dir);
    expect(await repo.commit("nothing changed")).toBeNull();
  });
});

describe("GitRepo remote", () => {
  let dir: string;
  let remoteDir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "krimto-git-"));
    remoteDir = await fs.mkdtemp(path.join(os.tmpdir(), "krimto-remote-"));
    await execFileP("git", ["init", "--bare", "-q", remoteDir]);
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(remoteDir, { recursive: true, force: true });
  });

  async function commitOne(repo: GitRepo): Promise<string | null> {
    const store = new FactStore(dir);
    const { path: rel } = await store.writeFact({ scope: "org/acme", title: "X", body: "y", author: "a@x.com" });
    await repo.stage(rel);
    return repo.commit("krimto: test");
  }

  it("pushes commits to a configured remote", async () => {
    const repo = await GitRepo.open(dir);
    const sha = await commitOne(repo);
    await repo.setRemote(remoteDir);
    expect(await repo.hasRemote()).toBe(true);
    expect((await repo.push()).status).toBe("ok");
    const { stdout } = await execFileP("git", ["-C", remoteDir, "rev-list", "--all"]);
    expect(stdout.trim().split("\n")).toContain(sha);
  });

  it("push is skipped when no remote is configured", async () => {
    const repo = await GitRepo.open(dir);
    expect(await repo.hasRemote()).toBe(false);
    expect((await repo.push()).status).toBe("skipped");
  });

  it("push returns error (not throw) on a bad remote", async () => {
    const repo = await GitRepo.open(dir);
    await commitOne(repo);
    await repo.setRemote(path.join(os.tmpdir(), "krimto-does-not-exist-xyz.git"));
    const res = await repo.push();
    expect(res.status).toBe("error");
    expect(res.detail).toBeTruthy();
  });

  it("setRemote updates the URL when origin already exists", async () => {
    const repo = await GitRepo.open(dir);
    await repo.setRemote("/tmp/first.git");
    await repo.setRemote(remoteDir);
    expect(await repo.hasRemote()).toBe(true);
  });
});

describe("GitRepo pull", () => {
  let bare: string;
  let dir: string;
  let mate: string;
  beforeEach(async () => {
    bare = await fs.mkdtemp(path.join(os.tmpdir(), "krimto-bare-"));
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "krimto-local-"));
    mate = await fs.mkdtemp(path.join(os.tmpdir(), "krimto-mate-"));
    await execFileP("git", ["init", "--bare", "-q", bare]);
    const repo = await GitRepo.open(dir);
    const store = new FactStore(dir);
    const { path: rel } = await store.writeFact({ scope: "org/acme", title: "Seed", body: "seed body", author: "a@x.com" });
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

  it("pulls a teammate's new file and lists it as changed", async () => {
    await fs.mkdir(path.join(mate, "org/acme"), { recursive: true });
    await fs.writeFile(path.join(mate, "org/acme/mate.md"), "---\nid: x\n---\nmate note\n", "utf8");
    await execFileP("git", ["-C", mate, "add", "-A"]);
    await execFileP("git", ["-C", mate, "commit", "-q", "-m", "mate: add"]);
    await execFileP("git", ["-C", mate, "push", "-q"]);

    const repo = await GitRepo.open(dir);
    const res = await repo.pull();
    expect(res.status).toBe("ok");
    expect(res.changedFiles).toContain("org/acme/mate.md");
    await expect(fs.access(path.join(dir, "org/acme/mate.md"))).resolves.toBeUndefined();
  });

  it("returns up-to-date when there is nothing new", async () => {
    const repo = await GitRepo.open(dir);
    expect((await repo.pull()).status).toBe("up-to-date");
  });

  it("returns skipped when no remote is configured", async () => {
    const solo = await fs.mkdtemp(path.join(os.tmpdir(), "krimto-solo-"));
    const repo = await GitRepo.open(solo);
    expect((await repo.pull()).status).toBe("skipped");
    await fs.rm(solo, { recursive: true, force: true });
  });

  it("aborts a conflicting rebase and preserves the local commit", async () => {
    const seedRel = "org/acme/seed.md";
    await fs.writeFile(path.join(mate, seedRel), "---\nid: s\n---\nteammate version\n", "utf8");
    await execFileP("git", ["-C", mate, "commit", "-aqm", "mate: edit seed"]);
    await execFileP("git", ["-C", mate, "push", "-q"]);
    const repo = await GitRepo.open(dir);
    await fs.writeFile(path.join(dir, seedRel), "---\nid: s\n---\nkrimto version\n", "utf8");
    await execFileP("git", ["-C", dir, "commit", "-aqm", "krimto: edit seed"]);
    const localHead = await repo.head();
    const res = await repo.pull();
    expect(res.status).toBe("conflict");
    expect(await repo.head()).toBe(localHead);
  });
});
