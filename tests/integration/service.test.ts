// Tests for src/cli/service.ts — the v0.2.17 wizard's "Always running" installer.
//
// Every test runs in dryRun mode against a temp homeDir, so no real launchd/systemd/schtasks
// state is touched. We assert: (a) the unit file is written to the right path with the right
// contents, (b) the platform CLI invocation the wizard *would* run has the right argv, and (c)
// the matching uninstall removes what was installed.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  detectPlatform,
  installService,
  isServiceInstalled,
  SERVICE_LABEL,
  SERVICE_NAME,
  uninstallService,
  unitPathFor,
  type ServiceConfig,
} from "../../src/cli/service";

let home: string;
beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "krimto-service-home-"));
});
afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

const baseConfig = (overrides: Partial<ServiceConfig> = {}): ServiceConfig => ({
  binPath: "/usr/bin/node",
  args: ["/usr/lib/krimto/bin/krimto.mjs", "serve"],
  env: { KRIMTO_DATA: "/Users/maria/.krimto", KRIMTO_HTTP_PORT: "8080" },
  ...overrides,
});

describe("detectPlatform", () => {
  it("maps darwin/linux/win32 directly and falls back to unsupported", () => {
    expect(detectPlatform("darwin")).toBe("darwin");
    expect(detectPlatform("linux")).toBe("linux");
    expect(detectPlatform("win32")).toBe("win32");
    expect(detectPlatform("freebsd")).toBe("unsupported");
    expect(detectPlatform("openbsd")).toBe("unsupported");
  });
});

describe("unitPathFor", () => {
  it("computes the macOS LaunchAgent plist path", () => {
    expect(unitPathFor("darwin", "/home/maria")).toBe(
      path.join("/home/maria", "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`),
    );
  });

  it("computes the Linux user-systemd unit path", () => {
    expect(unitPathFor("linux", "/home/maria")).toBe(
      path.join("/home/maria", ".config", "systemd", "user", `${SERVICE_NAME}.service`),
    );
  });

  it("returns null on Windows (schtasks has no on-disk unit file)", () => {
    expect(unitPathFor("win32", "/home/maria")).toBeNull();
  });
});

describe("installService — macOS (launchd, dryRun)", () => {
  it("writes a valid plist and returns the launchctl bootstrap command", async () => {
    const res = await installService(baseConfig({ homeDir: home }), {
      dryRun: true,
      platform: "darwin",
    });
    expect(res.platform).toBe("darwin");
    expect(res.activated).toBe(false);
    expect(res.unitPath).toBe(
      path.join(home, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`),
    );
    const plist = await fs.readFile(res.unitPath!, "utf8");
    expect(plist).toContain(`<string>${SERVICE_LABEL}</string>`);
    expect(plist).toContain("<string>/usr/bin/node</string>");
    expect(plist).toContain("<string>/usr/lib/krimto/bin/krimto.mjs</string>");
    expect(plist).toContain("<key>KRIMTO_DATA</key>");
    expect(plist).toContain("<string>/Users/maria/.krimto</string>");
    expect(plist).toContain("<key>RunAtLoad</key>");
    expect(plist).toContain("<key>KeepAlive</key>");

    expect(res.activateCommand?.command).toBe("launchctl");
    expect(res.activateCommand?.args[0]).toBe("bootstrap");
    expect(res.activateCommand?.args[1]).toMatch(/^gui\/\d+$/);
    expect(res.activateCommand?.args[2]).toBe(res.unitPath);
  });

  it("escapes XML special characters in arg/env values", async () => {
    const res = await installService(
      baseConfig({ homeDir: home, env: { TRICKY: 'has "quotes" & <tags>' } }),
      { dryRun: true, platform: "darwin" },
    );
    const plist = await fs.readFile(res.unitPath!, "utf8");
    expect(plist).toContain("&amp;");
    expect(plist).toContain("&lt;tags&gt;");
    expect(plist).toContain("&quot;quotes&quot;");
    expect(plist).not.toContain('has "quotes"');
  });
});

describe("installService — Linux (systemd, dryRun)", () => {
  it("writes a valid user-scoped unit and returns the systemctl enable command", async () => {
    const res = await installService(baseConfig({ homeDir: home }), {
      dryRun: true,
      platform: "linux",
    });
    expect(res.platform).toBe("linux");
    expect(res.activated).toBe(false);
    expect(res.unitPath).toBe(
      path.join(home, ".config", "systemd", "user", `${SERVICE_NAME}.service`),
    );
    const unit = await fs.readFile(res.unitPath!, "utf8");
    expect(unit).toContain("[Unit]");
    expect(unit).toContain("[Service]");
    expect(unit).toContain("ExecStart=/usr/bin/node /usr/lib/krimto/bin/krimto.mjs serve");
    expect(unit).toContain("Environment=KRIMTO_DATA=/Users/maria/.krimto");
    expect(unit).toContain("Environment=KRIMTO_HTTP_PORT=8080");
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("WantedBy=default.target");

    expect(res.activateCommand).toEqual({
      command: "systemctl",
      args: ["--user", "enable", "--now", SERVICE_NAME],
    });
  });

  it("quotes ExecStart arguments that contain spaces", async () => {
    const res = await installService(
      baseConfig({
        homeDir: home,
        binPath: "/usr/bin/node",
        args: ["/path with spaces/krimto.mjs", "serve"],
      }),
      { dryRun: true, platform: "linux" },
    );
    const unit = await fs.readFile(res.unitPath!, "utf8");
    expect(unit).toContain('"/path with spaces/krimto.mjs"');
  });
});

describe("installService — Windows (schtasks, dryRun)", () => {
  it("returns the schtasks Create command without invoking it", async () => {
    const res = await installService(baseConfig({ homeDir: home }), {
      dryRun: true,
      platform: "win32",
    });
    expect(res.platform).toBe("win32");
    expect(res.activated).toBe(false);
    expect(res.unitPath).toBeUndefined();

    expect(res.activateCommand?.command).toBe("schtasks");
    const args = res.activateCommand!.args;
    expect(args).toContain("/Create");
    expect(args).toContain("/F");
    expect(args).toContain("/SC");
    expect(args).toContain("ONLOGON");
    expect(args).toContain("/TN");
    expect(args).toContain(SERVICE_NAME);
    expect(args).toContain("/TR");
    const tr = args[args.indexOf("/TR") + 1];
    expect(tr).toContain("/usr/bin/node");
    expect(tr).toContain("/usr/lib/krimto/bin/krimto.mjs serve");
  });
});

describe("installService — unsupported platforms", () => {
  it("throws a clear error with a fallback suggestion", async () => {
    await expect(
      installService(baseConfig({ homeDir: home }), {
        dryRun: true,
        platform: "unsupported",
      }),
    ).rejects.toThrow(/isn't supported/);
  });
});

describe("uninstallService", () => {
  it("removes the macOS plist when one was installed", async () => {
    const installed = await installService(baseConfig({ homeDir: home }), {
      dryRun: true,
      platform: "darwin",
    });
    await expect(fs.access(installed.unitPath!)).resolves.toBeUndefined();

    const res = await uninstallService({ dryRun: true, homeDir: home, platform: "darwin" });
    expect(res.removed).toBe(true);
    await expect(fs.access(installed.unitPath!)).rejects.toThrow();
    expect(res.deactivateCommand?.command).toBe("launchctl");
    expect(res.deactivateCommand?.args[0]).toBe("bootout");
  });

  it("removes the Linux unit when one was installed", async () => {
    const installed = await installService(baseConfig({ homeDir: home }), {
      dryRun: true,
      platform: "linux",
    });
    await expect(fs.access(installed.unitPath!)).resolves.toBeUndefined();

    const res = await uninstallService({ dryRun: true, homeDir: home, platform: "linux" });
    expect(res.removed).toBe(true);
    await expect(fs.access(installed.unitPath!)).rejects.toThrow();
    expect(res.deactivateCommand?.args).toEqual(["--user", "disable", "--now", SERVICE_NAME]);
  });

  it("returns removed=false when nothing is installed", async () => {
    const res = await uninstallService({ dryRun: true, homeDir: home, platform: "darwin" });
    expect(res.removed).toBe(false);
  });

  it("Windows dryRun returns the schtasks Delete command without invoking", async () => {
    const res = await uninstallService({ dryRun: true, platform: "win32" });
    expect(res.platform).toBe("win32");
    expect(res.deactivateCommand?.command).toBe("schtasks");
    expect(res.deactivateCommand?.args).toEqual(["/Delete", "/F", "/TN", SERVICE_NAME]);
  });
});

describe("isServiceInstalled", () => {
  it("reports installed=true after an install on macOS", async () => {
    await installService(baseConfig({ homeDir: home }), { dryRun: true, platform: "darwin" });
    const status = await isServiceInstalled("darwin", home);
    expect(status.installed).toBe(true);
    expect(status.platform).toBe("darwin");
    expect(status.unitPath).toContain(`${SERVICE_LABEL}.plist`);
  });

  it("reports installed=true after an install on Linux", async () => {
    await installService(baseConfig({ homeDir: home }), { dryRun: true, platform: "linux" });
    const status = await isServiceInstalled("linux", home);
    expect(status.installed).toBe(true);
    expect(status.unitPath).toContain(`${SERVICE_NAME}.service`);
  });

  it("reports installed=false when nothing is installed", async () => {
    const status = await isServiceInstalled("darwin", home);
    expect(status.installed).toBe(false);
  });

  it("returns installed=false on unsupported platforms", async () => {
    const status = await isServiceInstalled("unsupported", home);
    expect(status.installed).toBe(false);
  });
});
