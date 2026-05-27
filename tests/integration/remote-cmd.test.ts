// v0.2.31 — `krimto remote` wraps setup-remote with three actions: show / set / remove.
// We cover the non-prompted action paths (action passed directly) so we don't have to mock
// @inquirer/prompts. The set path forwards to runSetupRemote which has its own coverage.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { runRemoteCmd } from "../../src/cli/remoteCmd";

const exec = promisify(execFile);

let dataDir: string;
beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "krimto-remote-"));
  await exec("git", ["-C", dataDir, "init", "-q"]);
});
afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

function captureIO(): { out: (s: string) => void; err: (s: string) => void; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { out: (s) => stdout.push(s), err: (s) => stderr.push(s), stdout, stderr };
}

describe("runRemoteCmd", () => {
  it("show: reports '(none)' when no remote is configured", async () => {
    const io = captureIO();
    const result = await runRemoteCmd({ dataDir, action: "show", io });
    expect(result?.action).toBe("show");
    expect(result?.url).toBeNull();
    expect(result?.message).toContain("(no remote configured)");
  });

  it("show: prints the URL when a remote is configured", async () => {
    await exec("git", ["-C", dataDir, "remote", "add", "origin", "git@example.com:acme/notes.git"]);
    const io = captureIO();
    const result = await runRemoteCmd({ dataDir, action: "show", io });
    expect(result?.url).toBe("git@example.com:acme/notes.git");
    expect(result?.message).toContain("git@example.com:acme/notes.git");
  });

  it("remove: reports nothing-to-remove when no remote exists", async () => {
    const io = captureIO();
    const result = await runRemoteCmd({ dataDir, action: "remove", io, yes: true });
    expect(result?.action).toBe("remove");
    expect(result?.url).toBeNull();
    expect(result?.message).toContain("Nothing to remove");
  });

  it("remove: unwires origin and reports success when --yes is passed", async () => {
    await exec("git", ["-C", dataDir, "remote", "add", "origin", "git@example.com:x/y.git"]);
    const io = captureIO();
    const result = await runRemoteCmd({ dataDir, action: "remove", io, yes: true });
    expect(result?.url).toBeNull();
    expect(result?.message).toContain("Removed remote");
    // git should no longer know about origin
    const { stdout } = await exec("git", ["-C", dataDir, "remote"]);
    expect(stdout.trim()).toBe("");
  });
});
