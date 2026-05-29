// Tests for `krimto sync` (src/cli/syncCmd.ts) — the on-demand two-way git sync verb.
//
// The model-B teammate flow: each person runs their own Krimto, synced through a shared git
// remote. `sync` pulls teammates' pushed notes, re-indexes them, and pushes any local commits.
// Exercised against a real bare remote + two clones so the round-trip is genuine, not mocked.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { GitRepo } from "../../src/storage/git";
import { FactStore } from "../../src/storage/store";
import { runSync } from "../../src/cli/syncCmd";

const exec = promisify(execFile);

let bare: string;
let dirA: string;
let dirB: string;

beforeEach(async () => {
  bare = await fs.mkdtemp(path.join(os.tmpdir(), "krimto-sync-bare-"));
  dirA = await fs.mkdtemp(path.join(os.tmpdir(), "krimto-sync-a-"));
  dirB = await fs.mkdtemp(path.join(os.tmpdir(), "krimto-sync-b-"));
  await exec("git", ["init", "--bare", "-b", "main", bare]);
});
afterEach(async () => {
  for (const d of [bare, dirA, dirB]) await fs.rm(d, { recursive: true, force: true });
});

async function commitAll(dir: string, msg: string): Promise<void> {
  await exec("git", ["-C", dir, "add", "-A"]);
  await exec("git", [
    "-C", dir, "-c", "user.email=t@x.com", "-c", "user.name=t", "commit", "-m", msg,
  ]);
}

describe("runSync", () => {
  it("reports no_remote when the data dir has no git remote", async () => {
    await GitRepo.open(dirA); // init a clean repo, no remote
    const res = await runSync(dirA);
    expect(res.status).toBe("no_remote");
    expect(res.message).toMatch(/remote --set/);
  });

  it("pulls a teammate's pushed fact from the shared remote and re-indexes it", async () => {
    // A: init, wire the remote, seed one fact, push.
    const repoA = await GitRepo.open(dirA);
    await repoA.setRemote(bare);
    const storeA = new FactStore(dirA);
    await storeA.writeFact({ scope: "team/backend", title: "deploy fridays", body: "we ship on fridays", author: "a@x.com" });
    await commitAll(dirA, "seed");
    expect((await repoA.push()).status).toBe("ok");

    // B: clone the shared repo (tracks origin/main with the seed fact).
    await exec("git", ["clone", "-b", "main", bare, dirB]);

    // A: a teammate writes a NEW fact and pushes.
    await storeA.writeFact({ scope: "team/backend", title: "oncall rotation", body: "pager duty weekly", author: "a@x.com" });
    await commitAll(dirA, "second");
    expect((await repoA.push()).status).toBe("ok");

    // B: sync pulls the new fact and re-indexes it.
    const res = await runSync(dirB);
    expect(res.status).toBe("ok");

    const all = await new FactStore(dirB).allFacts();
    expect(all.some((f) => f.frontmatter.title === "oncall rotation")).toBe(true);
    // The index was rebuilt from the pulled markdown.
    await expect(fs.access(path.join(dirB, "index.db"))).resolves.toBeUndefined();
  });

  it("reports up_to_date when there's nothing new to pull", async () => {
    const repoA = await GitRepo.open(dirA);
    await repoA.setRemote(bare);
    await new FactStore(dirA).writeFact({ scope: "user/a@x.com", title: "n1", body: "b", author: "a@x.com" });
    await commitAll(dirA, "seed");
    await repoA.push();
    await exec("git", ["clone", "-b", "main", bare, dirB]);

    const res = await runSync(dirB); // B is already current
    expect(res.status).toBe("up_to_date");
  });
});
