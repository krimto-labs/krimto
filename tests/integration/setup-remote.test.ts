// `krimto setup-remote` — points the data dir's git repo at a remote and verifies the push works.
// Uses a temp bare repo as the "remote" so we exercise the full git plumbing without a network.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { runSetupRemote } from "../../src/cli/setupRemote";
import { GitRepo } from "../../src/storage/git";

const exec = promisify(execFile);

let dataDir: string;
let bareRemote: string;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "krimto-setupr-data-"));
  bareRemote = await fs.mkdtemp(path.join(os.tmpdir(), "krimto-setupr-bare-"));
  await exec("git", ["init", "--bare", "-b", "main", bareRemote]);
  // Krimto needs the data dir initialized as a git repo with a commit on `main` so push has something.
  const repo = await GitRepo.open(dataDir);
  await fs.writeFile(path.join(dataDir, "seed.md"), "seed", "utf8");
  await repo.stage("seed.md");
  await repo.commit("seed");
});

afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
  await fs.rm(bareRemote, { recursive: true, force: true });
});

describe("runSetupRemote", () => {
  it("rejects an obviously invalid URL with a helpful message", async () => {
    const r = await runSetupRemote(dataDir, "not a url");
    expect(r.status).toBe("invalid_url");
    expect(r.message).toContain("Invalid URL");
  });

  it("configures the remote and pushes the existing commit when the remote is empty", async () => {
    const r = await runSetupRemote(dataDir, bareRemote);
    expect(r.status).toBe("ok");
    expect(r.message).toContain("✅");
    expect(r.message).toContain("KRIMTO_GIT_REMOTE");
    // Verify by listing refs on the bare remote — `main` must now point at the seeded commit.
    const { stdout } = await exec("git", ["-C", bareRemote, "rev-parse", "main"]);
    expect(stdout.trim()).toMatch(/^[0-9a-f]{40}$/);
  });

  it("reports push_failed with a hint when the remote already has its own history", async () => {
    // Pollute the bare remote with an unrelated commit so the push rejects (non-fast-forward).
    const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "krimto-setupr-pol-"));
    await exec("git", ["clone", bareRemote, workdir]);
    await fs.writeFile(path.join(workdir, "README.md"), "hi", "utf8");
    await exec("git", ["-C", workdir, "config", "user.email", "x@x.x"]);
    await exec("git", ["-C", workdir, "config", "user.name", "x"]);
    await exec("git", ["-C", workdir, "add", "README.md"]);
    await exec("git", ["-C", workdir, "commit", "-m", "preexisting"]);
    await exec("git", ["-C", workdir, "push", "origin", "main"]);
    await fs.rm(workdir, { recursive: true, force: true });

    const r = await runSetupRemote(dataDir, bareRemote);
    expect(r.status).toBe("push_failed");
    expect(r.message).toContain("Common causes");
    expect(r.message.toLowerCase()).toContain("readme");
  });
});
