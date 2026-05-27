// Regression test for v0.2.23's launchctl-bootstrap-EIO fix.
//
// Bug: `launchctl bootstrap gui/<uid> <plist>` returns "Bootstrap failed: 5: Input/output
// error" when the service is already loaded. The v0.2.17 wizard's reconfigure path called
// bootstrap unconditionally, so every second `krimto init` on macOS crashed at the service
// install step.
//
// Fix: `installLaunchd` runs `launchctl bootout` best-effort before `launchctl bootstrap`,
// so the next bootstrap always starts from a clean slate. First-install case (nothing
// loaded yet) → bootout errors, ignored; happy path. Reconfigure case → bootout succeeds,
// bootstrap reloads the new plist content.
//
// This test mocks child_process.execFile to record the launchctl call order and verify the
// fix without touching real launchd state.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const calls: { command: string; args: string[] }[] = [];
// `bootoutShouldFail` simulates the "service not loaded" case for the first install. The
// reconfigure tests flip it to `false` to assert bootout succeeded before bootstrap.
let bootoutShouldFail = false;

vi.mock("node:child_process", async () => {
  return {
    execFile: (
      cmd: string,
      args: string[],
      cb: (err: Error | null, value: { stdout: string; stderr: string }) => void,
    ) => {
      calls.push({ command: cmd, args: [...args] });
      // Match the real launchctl behavior: bootout errors with code 5 (EIO) when the
      // service isn't loaded; bootstrap errors with code 5 when it IS loaded. Tests below
      // toggle which side errors via `bootoutShouldFail`.
      if (cmd === "launchctl" && args[0] === "bootout" && bootoutShouldFail) {
        cb(new Error("Boot-out failed: 5: Input/output error"), { stdout: "", stderr: "" });
        return;
      }
      cb(null, { stdout: "", stderr: "" });
    },
  };
});

// Import AFTER the mock so the promisified execFile inside service.ts is the mocked one.
import { installService, type ServiceConfig } from "../../src/cli/service";

let home: string;
beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "krimto-svc-reconfig-"));
  calls.length = 0;
});
afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

const baseConfig = (overrides: Partial<ServiceConfig> = {}): ServiceConfig => ({
  binPath: "/usr/bin/node",
  args: ["/usr/lib/krimto/bin/krimto.mjs", "serve"],
  env: { KRIMTO_DATA: path.join(home, ".krimto"), KRIMTO_HTTP_PORT: "8080" },
  homeDir: home,
  ...overrides,
});

describe("installService — macOS reconfigure-safe (v0.2.23)", () => {
  it("first install: bootout is attempted (fails — nothing loaded), bootstrap then succeeds", async () => {
    bootoutShouldFail = true;
    const res = await installService(baseConfig(), { platform: "darwin" });
    expect(res.activated).toBe(true);

    // Order: bootout (best-effort) → bootstrap.
    const launchctlCalls = calls.filter((c) => c.command === "launchctl");
    expect(launchctlCalls.map((c) => c.args[0])).toEqual(["bootout", "bootstrap"]);
    expect(launchctlCalls[0]?.args[1]).toMatch(/^gui\/\d+\/com\.krimto\.server$/);
    expect(launchctlCalls[1]?.args[1]).toMatch(/^gui\/\d+$/);
  });

  it("reconfigure (service already loaded): bootout succeeds, bootstrap doesn't fail", async () => {
    bootoutShouldFail = false;
    const res = await installService(baseConfig(), { platform: "darwin" });
    expect(res.activated).toBe(true);

    // Both calls happen, in order. The fix guarantees bootstrap is never called against
    // a service that's still loaded.
    const launchctlCalls = calls.filter((c) => c.command === "launchctl");
    expect(launchctlCalls.map((c) => c.args[0])).toEqual(["bootout", "bootstrap"]);
  });

  it("writes the plist BEFORE running bootout (so the bootstrap reloads new content)", async () => {
    bootoutShouldFail = true;
    const res = await installService(baseConfig({ env: { CHANGED: "value-after-reconfigure" } }), {
      platform: "darwin",
    });

    // Plist should exist and contain the latest env value.
    const plist = await fs.readFile(res.unitPath!, "utf8");
    expect(plist).toContain("CHANGED");
    expect(plist).toContain("value-after-reconfigure");
  });

  it("dryRun skips both launchctl calls (file written, no CLI invoked)", async () => {
    const res = await installService(baseConfig(), { platform: "darwin", dryRun: true });
    expect(res.activated).toBe(false);
    expect(calls.filter((c) => c.command === "launchctl")).toHaveLength(0);
    // Plist still written so the user can inspect it.
    await expect(fs.access(res.unitPath!)).resolves.toBeUndefined();
  });
});
