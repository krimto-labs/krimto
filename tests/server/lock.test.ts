// G1 — Cross-process data-dir lock. Validates that a live holder is refused, a stale holder is
// replaced, and release leaves the dir lock-free for the next boot.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { acquireLock, isProcessAlive, LockHeldError } from "../../src/server/lock";

let dir: string;
const lockFile = (d: string): string => path.join(d, ".krimto", "lock.json");

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "krimto-lock-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("acquireLock", () => {
  it("writes a lock file naming this process when none exists", async () => {
    const handle = await acquireLock(dir, "stdio");
    const raw = JSON.parse(await fs.readFile(lockFile(dir), "utf8")) as Record<string, unknown>;
    expect(raw.pid).toBe(process.pid);
    expect(raw.mode).toBe("stdio");
    expect(typeof raw.started).toBe("string");
    await handle.release();
  });

  it("refuses with LockHeldError when an existing lock is held by a live (other) PID", async () => {
    // PID 1 (init) is always alive and is not us — perfect for simulating a live holder.
    await fs.mkdir(path.join(dir, ".krimto"), { recursive: true });
    await fs.writeFile(
      lockFile(dir),
      JSON.stringify({ pid: 1, started: "2026-01-01T00:00:00Z", mode: "http" }),
    );
    await expect(acquireLock(dir, "stdio")).rejects.toBeInstanceOf(LockHeldError);
  });

  it("replaces a stale lockfile whose PID is dead", async () => {
    // A PID nobody is using. process.kill(0, 0) returns no permission; we need a definitely-dead
    // pid. The kernel reuses PIDs but 2^31-1 is way above any realistic process — and even if
    // it ever existed, isProcessAlive returns false on ESRCH.
    await fs.mkdir(path.join(dir, ".krimto"), { recursive: true });
    const fakeDead = 2_147_483_640;
    expect(isProcessAlive(fakeDead)).toBe(false);
    await fs.writeFile(
      lockFile(dir),
      JSON.stringify({ pid: fakeDead, started: "2020-01-01T00:00:00Z", mode: "stdio" }),
    );
    const handle = await acquireLock(dir, "http");
    const raw = JSON.parse(await fs.readFile(lockFile(dir), "utf8")) as { pid: number };
    expect(raw.pid).toBe(process.pid); // we took it over
    await handle.release();
  });

  it("treats a malformed/empty lock file as no lock", async () => {
    await fs.mkdir(path.join(dir, ".krimto"), { recursive: true });
    await fs.writeFile(lockFile(dir), "{ this is not valid JSON");
    const handle = await acquireLock(dir, "stdio");
    expect(JSON.parse(await fs.readFile(lockFile(dir), "utf8")).pid).toBe(process.pid);
    await handle.release();
  });

  it("release deletes the lock file (idempotent on double release)", async () => {
    const handle = await acquireLock(dir, "stdio");
    await handle.release();
    await expect(fs.access(lockFile(dir))).rejects.toThrow();
    await handle.release(); // second release: must not throw
  });

  it("release does NOT delete a file claimed by another process (defensive)", async () => {
    const handle = await acquireLock(dir, "stdio");
    // Simulate the file being rewritten by some other process between acquire and release.
    await fs.writeFile(
      lockFile(dir),
      JSON.stringify({ pid: 1, started: "2026-01-01T00:00:00Z", mode: "http" }),
    );
    await handle.release();
    await expect(fs.access(lockFile(dir))).resolves.toBeUndefined(); // still there
  });
});

describe("isProcessAlive", () => {
  it("returns true for the current process and false for negative / zero PIDs", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
  });
});
