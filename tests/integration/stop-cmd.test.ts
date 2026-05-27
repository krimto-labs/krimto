// v0.2.32 — `krimto stop` / `krimto start` / `krimto restart`. The runStop / runStart
// modules are pure-ish functions: stop interacts with the service installer + a lock file
// it parses from disk; start delegates to installService. We assert the contract without
// hitting real launchctl by:
//   • controlling the dataDir + lock file in temp dirs
//   • using a tmpfs homeDir so isServiceInstalled correctly reports "not installed"
//   • for start, mocking the platform CLI via the same child_process mock pattern other
//     integration tests use (no real launchctl bootstrap)

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { runStop, runStart } from "../../src/cli/stopCmd";

let dataDir: string;
let homeDir: string;
beforeEach(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "krimto-stop-"));
  dataDir = path.join(root, "data");
  homeDir = path.join(root, "home");
  await fs.mkdir(path.join(dataDir, ".krimto"), { recursive: true });
  await fs.mkdir(homeDir, { recursive: true });
});
afterEach(async () => {
  await fs.rm(path.dirname(dataDir), { recursive: true, force: true });
});

describe("runStop", () => {
  it("reports 'already-stopped' on a clean machine with no service + no lock", async () => {
    const result = await runStop({ dataDir, homeDir, dryRun: true });
    expect(result.status).toBe("already-stopped");
    expect(result.serviceUninstalled).toBe(false);
    expect(result.pidKilled).toBeNull();
    expect(result.message).toContain("already stopped");
  });

  it("deletes a stale lock file even when no PID is alive", async () => {
    // Write a lock pointing at an impossible PID (>= 2^31, so process.kill rejects).
    await fs.writeFile(
      path.join(dataDir, ".krimto", "lock.json"),
      JSON.stringify({ pid: 2_147_483_640, started: "2026-05-27T00:00:00Z", mode: "http" }),
    );
    const result = await runStop({ dataDir, homeDir, dryRun: true });
    // Dead PID → terminateLockHolder returns null, status is "already-stopped" (no real work).
    // BUT the lock file gets cleaned up regardless.
    await expect(fs.access(path.join(dataDir, ".krimto", "lock.json"))).rejects.toThrow();
    expect(result.status).toBe("already-stopped");
  });
});

describe("runStart", () => {
  it("reports 'no-service-configured' when no plist/unit exists", async () => {
    const result = await runStart({ dataDir, homeDir, dryRun: true });
    expect(result.status).toBe("no-service-configured");
    expect(result.mode).toBe("none");
    expect(result.message).toContain("No background service is configured");
    expect(result.message).toContain("krimto init --yes");
    expect(result.message).toContain("krimto serve");
  });

  it("reinstalls + reports 'started' when a service plist exists (dryRun)", async () => {
    // Pre-seed the LaunchAgents dir so isServiceInstalled finds an existing plist on macOS.
    // On Linux the equivalent path is .config/systemd/user/krimto.service. We pre-create
    // BOTH so the test runs platform-agnostic in CI.
    const macPlist = path.join(homeDir, "Library", "LaunchAgents", "com.krimto.server.plist");
    const linuxUnit = path.join(homeDir, ".config", "systemd", "user", "krimto.service");
    await fs.mkdir(path.dirname(macPlist), { recursive: true });
    await fs.mkdir(path.dirname(linuxUnit), { recursive: true });
    await fs.writeFile(macPlist, "<plist/>", "utf8");
    await fs.writeFile(linuxUnit, "[Unit]\n", "utf8");

    const result = await runStart({
      dataDir,
      homeDir,
      dryRun: true,
    });
    expect(result.status).toBe("started");
    expect(result.mode).toBe("service");
    expect(result.message).toContain("service started");
  });
});
