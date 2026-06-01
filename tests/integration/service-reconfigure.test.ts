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
// `serviceLoaded` simulates whether the launchd label is currently registered. v0.2.26's
// install path probes this with `launchctl print` (exit 0 = loaded) and branches:
//   • loaded:    `launchctl kickstart -k <label>`  — atomic restart, no race
//   • not loaded: `launchctl bootstrap gui/<uid> <plist>`
// The bootout+bootstrap pattern from v0.2.23 is gone.
let serviceLoaded = false;

vi.mock("node:child_process", async () => {
  return {
    execFile: (
      cmd: string,
      args: string[],
      cb: (err: Error | null, value: { stdout: string; stderr: string }) => void,
    ) => {
      calls.push({ command: cmd, args: [...args] });
      // `launchctl print` exits non-zero when the label isn't loaded.
      if (cmd === "launchctl" && args[0] === "print") {
        if (serviceLoaded) {
          cb(null, { stdout: "state = running\n\tpid = 12345\n", stderr: "" });
        } else {
          cb(new Error("Could not find service"), { stdout: "", stderr: "" });
        }
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

describe("installService — macOS reconfigure-safe (v0.2.26: print + kickstart)", () => {
  it("first install (service NOT loaded): probes print, then bootstrap — no race possible", async () => {
    serviceLoaded = false;
    // v0.2.27 — installService now also waits for the HTTP port to accept connections.
    // Stub the probe so it doesn't try to actually open a TCP socket during the unit test.
    const res = await installService(baseConfig(), { platform: "darwin", probePort: async () => true });
    expect(res.activated).toBe(true);

    const launchctlCalls = calls.filter((c) => c.command === "launchctl");
    expect(launchctlCalls.map((c) => c.args[0])).toEqual(["print", "bootstrap"]);
    // `print gui/<uid>/<label>` — label is per-install (slug-suffixed for this non-default dir)
    expect(launchctlCalls[0]?.args[1]).toMatch(/^gui\/\d+\/com\.krimto\.server\.[0-9a-f]{8}$/);
    // `bootstrap gui/<uid> <plist-path>`
    expect(launchctlCalls[1]?.args[1]).toMatch(/^gui\/\d+$/);
  });

  it("reconfigure (service ALREADY loaded): probes print, then kickstart -k — no EIO", async () => {
    serviceLoaded = true;
    const res = await installService(baseConfig(), { platform: "darwin", probePort: async () => true });
    expect(res.activated).toBe(true);

    // No bootout / no bootstrap. `kickstart -k` is atomic: it SIGTERMs the running process,
    // waits for clean exit, then re-spawns from the on-disk plist (which we already rewrote
    // before the launchctl calls, so the new process picks up the latest env / argv).
    const launchctlCalls = calls.filter((c) => c.command === "launchctl");
    expect(launchctlCalls.map((c) => c.args[0])).toEqual(["print", "kickstart"]);
    expect(launchctlCalls[1]?.args.slice(0, 2)).toEqual(["kickstart", "-k"]);
    expect(launchctlCalls[1]?.args[2]).toMatch(/^gui\/\d+\/com\.krimto\.server\.[0-9a-f]{8}$/);
    expect(launchctlCalls.find((c) => c.args[0] === "bootout")).toBeUndefined();
    expect(launchctlCalls.find((c) => c.args[0] === "bootstrap")).toBeUndefined();
  });

  it("writes the plist BEFORE running launchctl (so the reload picks up new content)", async () => {
    serviceLoaded = false;
    const res = await installService(baseConfig({ env: { CHANGED: "value-after-reconfigure" } }), {
      platform: "darwin",
      probePort: async () => true,
    });

    const plist = await fs.readFile(res.unitPath!, "utf8");
    expect(plist).toContain("CHANGED");
    expect(plist).toContain("value-after-reconfigure");
  });

  it("dryRun skips all launchctl calls (file written, no CLI invoked)", async () => {
    const res = await installService(baseConfig(), { platform: "darwin", dryRun: true });
    expect(res.activated).toBe(false);
    expect(calls.filter((c) => c.command === "launchctl")).toHaveLength(0);
    await expect(fs.access(res.unitPath!)).resolves.toBeUndefined();
  });

  // v0.2.25 — Gap 8. Every service-launched Krimto stamps `launchedBy: "service"` in its
  // lock file by reading KRIMTO_LAUNCHED_BY from its env. installService injects that env
  // marker into the unit file so verify-connection / status can tell launchd-started runs
  // apart from ad-hoc `krimto serve` invocations.
  it("injects KRIMTO_LAUNCHED_BY=service into the unit env (macOS)", async () => {
    serviceLoaded = false;
    const res = await installService(baseConfig(), { platform: "darwin", probePort: async () => true });
    const plist = await fs.readFile(res.unitPath!, "utf8");
    expect(plist).toContain("<key>KRIMTO_LAUNCHED_BY</key>");
    expect(plist).toContain("<string>service</string>");
  });

  it("injects KRIMTO_LAUNCHED_BY=service into the unit env (Linux)", async () => {
    const res = await installService(baseConfig(), { platform: "linux", dryRun: true });
    const unit = await fs.readFile(res.unitPath!, "utf8");
    expect(unit).toContain("Environment=KRIMTO_LAUNCHED_BY=service");
  });

  it("caller-supplied env keys are preserved alongside the launchedBy marker", async () => {
    serviceLoaded = false;
    const res = await installService(
      baseConfig({ env: { KRIMTO_DATA: "/x/y", KRIMTO_HTTP_PORT: "9090" } }),
      { platform: "darwin", probePort: async () => true },
    );
    const plist = await fs.readFile(res.unitPath!, "utf8");
    expect(plist).toContain("<key>KRIMTO_LAUNCHED_BY</key>");
    expect(plist).toContain("<key>KRIMTO_DATA</key>");
    expect(plist).toContain("<string>/x/y</string>");
    expect(plist).toContain("<key>KRIMTO_HTTP_PORT</key>");
  });
});

// v0.2.27 — port-readiness probe. The smoke-6 transcript showed Cursor failing with
// ECONNREFUSED in the ~3-second window between launchd accepting the bootstrap and the
// Node process actually binding :8080. installService now polls localhost:<port> after
// the platform-specific install before returning, so the wizard never declares "started"
// while the port is still unbound.
describe("installService — port readiness probe (v0.2.27)", () => {
  it("reports portReady=true when the probe succeeds immediately", async () => {
    serviceLoaded = false;
    const probeCalls: number[] = [];
    const res = await installService(baseConfig(), {
      platform: "darwin",
      probePort: async (port) => {
        probeCalls.push(port);
        return true; // accepted on first poll
      },
    });
    expect(res.activated).toBe(true);
    expect(res.portReady).toBe(true);
    expect(probeCalls).toEqual([8080]); // baseConfig sets KRIMTO_HTTP_PORT=8080
  });

  it("polls until the probe succeeds (typical 3-second window)", async () => {
    serviceLoaded = false;
    let attempts = 0;
    const res = await installService(baseConfig(), {
      platform: "darwin",
      probePort: async () => {
        attempts += 1;
        return attempts >= 4; // first 3 attempts return false, 4th succeeds
      },
      probeTimeoutMs: 5000,
    });
    expect(res.portReady).toBe(true);
    expect(attempts).toBeGreaterThanOrEqual(4);
  });

  it("reports portReady=false when the port never comes up within the timeout", async () => {
    serviceLoaded = false;
    const res = await installService(baseConfig(), {
      platform: "darwin",
      probePort: async () => false, // never accepts
      probeTimeoutMs: 500, // short for the test
    });
    expect(res.activated).toBe(true);
    expect(res.portReady).toBe(false);
  });

  it("skips the probe entirely when no KRIMTO_HTTP_PORT is in the env (stdio install)", async () => {
    serviceLoaded = false;
    let probed = false;
    const res = await installService(
      baseConfig({ env: { KRIMTO_DATA: "/x/y" } }), // no KRIMTO_HTTP_PORT
      {
        platform: "darwin",
        probePort: async () => {
          probed = true;
          return true;
        },
      },
    );
    expect(probed).toBe(false);
    expect(res.portReady).toBeUndefined();
  });

  it("skips the probe in dry-run mode (tests don't open real sockets)", async () => {
    let probed = false;
    const res = await installService(baseConfig(), {
      platform: "darwin",
      dryRun: true,
      probePort: async () => {
        probed = true;
        return true;
      },
    });
    expect(probed).toBe(false);
    expect(res.activated).toBe(false);
    expect(res.portReady).toBeUndefined();
  });
});
