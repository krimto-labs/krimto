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
