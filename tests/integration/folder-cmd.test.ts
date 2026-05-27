// v0.2.31 — `krimto folder` moves the notes folder to a new location, stops + reinstalls
// the always-running service so its env points at the new path, and prints an export hint.
// Tests run with `yes: true` + `dryRun: true` to avoid real prompts / launchctl invocations.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { runFolderCmd } from "../../src/cli/folderCmd";

let fromDir: string;
let toDir: string;
let homeDir: string;
beforeEach(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "krimto-folder-"));
  fromDir = path.join(root, "from");
  toDir = path.join(root, "to");
  homeDir = path.join(root, "home");
  await fs.mkdir(fromDir, { recursive: true });
  await fs.writeFile(path.join(fromDir, "a.md"), "hello", "utf8");
});
afterEach(async () => {
  await fs.rm(path.dirname(fromDir), { recursive: true, force: true });
});

function captureIO(): { out: (s: string) => void; err: (s: string) => void; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { out: (s) => stdout.push(s), err: (s) => stderr.push(s), stdout, stderr };
}

describe("runFolderCmd", () => {
  it("moves the data dir atomically when src + dst share a filesystem", async () => {
    const io = captureIO();
    const result = await runFolderCmd({ from: fromDir, to: toDir, io, yes: true, homeDir, dryRun: true });
    expect(result?.status).toBe("ok");
    expect(result?.from).toBe(fromDir);
    expect(result?.to).toBe(toDir);

    // Source is gone, destination has the file.
    await expect(fs.access(fromDir)).rejects.toThrow();
    await expect(fs.readFile(path.join(toDir, "a.md"), "utf8")).resolves.toBe("hello");
  });

  it("refuses to move into a non-empty destination", async () => {
    await fs.mkdir(toDir, { recursive: true });
    await fs.writeFile(path.join(toDir, "existing.md"), "do not clobber", "utf8");
    const io = captureIO();
    const result = await runFolderCmd({ from: fromDir, to: toDir, io, yes: true, homeDir, dryRun: true });
    expect(result?.status).toBe("error");
    expect(result?.message).toContain("exists and isn't empty");
    // Source untouched.
    await expect(fs.readFile(path.join(fromDir, "a.md"), "utf8")).resolves.toBe("hello");
  });

  it("takes over an empty destination directory (counts as 'absent' for our purposes)", async () => {
    await fs.mkdir(toDir, { recursive: true });
    const io = captureIO();
    const result = await runFolderCmd({ from: fromDir, to: toDir, io, yes: true, homeDir, dryRun: true });
    expect(result?.status).toBe("ok");
    await expect(fs.readFile(path.join(toDir, "a.md"), "utf8")).resolves.toBe("hello");
  });

  it("no-ops when source and destination are the same", async () => {
    const io = captureIO();
    const result = await runFolderCmd({ from: fromDir, to: fromDir, io, yes: true, homeDir, dryRun: true });
    expect(result?.status).toBe("no-change");
  });

  it("prints the KRIMTO_DATA export hint on success", async () => {
    const io = captureIO();
    const result = await runFolderCmd({ from: fromDir, to: toDir, io, yes: true, homeDir, dryRun: true });
    expect(result?.message).toContain(`export KRIMTO_DATA="${toDir}"`);
  });
});
