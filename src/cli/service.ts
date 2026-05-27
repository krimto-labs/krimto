// Service installer for the v0.2.17 wizard's "Always running" run mode.
//
// One interface, three platform-specific implementations:
//   • macOS  — launchd: writes `~/Library/LaunchAgents/com.krimto.server.plist`,
//              loads it with `launchctl bootstrap gui/<uid> <plist-path>`.
//   • Linux  — systemd (user scope): writes `~/.config/systemd/user/krimto.service`,
//              enables + starts via `systemctl --user enable --now krimto`.
//   • Windows — Task Scheduler: registers a scheduled task with `schtasks /Create /SC ONLOGON`.
//
// The unit/plist content paths and trigger conditions are derived from a single `ServiceConfig`,
// so the wizard's "install" + "uninstall" + "status" verbs all reason about the same record.
//
// Testability: every install/uninstall path supports `opts.dryRun`. In dry-run mode, files are
// written to a caller-supplied `homeDir` but the platform CLI (launchctl/systemctl/schtasks) is
// NOT invoked, and the resolved command is returned so tests can assert the exact argv. This
// keeps CI from mutating the runner's actual user services.
//
// Unsupported platforms (e.g. BSDs, exotic Linux without systemd) fall back gracefully: the
// wizard reports the "as needed" mode is recommended and the install call returns a clear error
// rather than crashing.

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export type ServicePlatform = "darwin" | "linux" | "win32" | "unsupported";

/** Stable identifier for Krimto's service across all three platforms. */
export const SERVICE_LABEL = "com.krimto.server";
/** Short name used by systemctl/schtasks (where the dotted label isn't a valid id). */
export const SERVICE_NAME = "krimto";

export interface ServiceConfig {
  /** Absolute path to the executable that should run as the service (typically `node`). */
  binPath: string;
  /** Arguments to pass to the binary (typically `["bin/krimto.mjs", "serve"]`). */
  args: string[];
  /** Env vars to set on the service process (`KRIMTO_DATA`, `KRIMTO_HTTP_PORT`, etc.). */
  env?: Record<string, string>;
  /** Override `os.homedir()` for tests so unit/plist files land in a temp dir. */
  homeDir?: string;
}

export interface InstallResult {
  platform: ServicePlatform;
  /** Where the service definition was written (plist path on macOS, .service unit on Linux). */
  unitPath?: string;
  /** The full body that was written to `unitPath` (plist XML, systemd unit, etc.). Returned for tests/logs. */
  unitContents?: string;
  /** The CLI invocation that loads/activates the service (launchctl, systemctl, schtasks). */
  activateCommand?: { command: string; args: string[] };
  /** True when the platform CLI was actually executed (false in dry-run mode). */
  activated: boolean;
}

export interface UninstallResult {
  platform: ServicePlatform;
  /** True when something was removed (unit file deleted, service unloaded). */
  removed: boolean;
  /** CLI invocation that unloaded the service (e.g. `launchctl bootout`). */
  deactivateCommand?: { command: string; args: string[] };
}

export interface ServiceOptions {
  /** When true, files are written but the platform CLI is NOT executed. Tests use this. */
  dryRun?: boolean;
  /**
   * Override the detected platform. In production this is omitted (we always honor
   * `process.platform`); tests use it to exercise each platform's install path on a single
   * CI runner without `process.platform` rewiring.
   */
  platform?: ServicePlatform;
}

/** Map `process.platform` → the four service flavors Krimto knows about. */
export function detectPlatform(p: NodeJS.Platform = process.platform): ServicePlatform {
  if (p === "darwin") return "darwin";
  if (p === "linux") return "linux";
  if (p === "win32") return "win32";
  return "unsupported";
}

/** Where Krimto's service definition would live on this platform. */
export function unitPathFor(platform: ServicePlatform, homeDir: string = os.homedir()): string | null {
  if (platform === "darwin") {
    return path.join(homeDir, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
  }
  if (platform === "linux") {
    return path.join(homeDir, ".config", "systemd", "user", `${SERVICE_NAME}.service`);
  }
  // Windows registers via schtasks; there is no on-disk unit file we manage directly.
  return null;
}

/** Is the service currently registered? Best-effort — uses file presence + platform CLI when available. */
export async function isServiceInstalled(
  platform: ServicePlatform = detectPlatform(),
  homeDir: string = os.homedir(),
): Promise<{ platform: ServicePlatform; installed: boolean; unitPath?: string }> {
  if (platform === "unsupported") return { platform, installed: false };
  const unitPath = unitPathFor(platform, homeDir);
  if (unitPath) {
    try {
      await fs.access(unitPath);
      return { platform, installed: true, unitPath };
    } catch {
      return { platform, installed: false, unitPath };
    }
  }
  // Windows — query schtasks.
  try {
    await exec("schtasks", ["/Query", "/TN", SERVICE_NAME]);
    return { platform, installed: true };
  } catch {
    return { platform, installed: false };
  }
}

/**
 * Install the service for the current platform. Writes the unit file (where applicable) and
 * activates the service via the platform's CLI. Pass `opts.dryRun=true` to skip activation
 * (used by tests so CI doesn't actually register a service).
 */
export async function installService(
  config: ServiceConfig,
  opts: ServiceOptions = {},
): Promise<InstallResult> {
  const platform = opts.platform ?? detectPlatform();
  const homeDir = config.homeDir ?? os.homedir();

  // v0.2.25 — Gap 8 provenance. Every service-launched Krimto stamps `launchedBy: "service"`
  // into its lock file. We inject the marker env var here (vs every caller remembering to)
  // so the wizard, the `service` shortcut, and any future installer share the same shape.
  const configWithMarker: ServiceConfig = {
    ...config,
    env: { KRIMTO_LAUNCHED_BY: "service", ...(config.env ?? {}) },
  };

  if (platform === "darwin") return installLaunchd(configWithMarker, homeDir, opts);
  if (platform === "linux") return installSystemd(configWithMarker, homeDir, opts);
  if (platform === "win32") return installSchtasks(configWithMarker, opts);

  throw new Error(
    `Krimto's "Always running" mode isn't supported on platform "${process.platform}" yet. ` +
      `Use "As needed" mode (the wizard default) or run \`krimto serve\` manually.`,
  );
}

/** Uninstall the service. Removes the unit file + invokes the platform CLI to deactivate it. */
export async function uninstallService(
  opts: ServiceOptions & { homeDir?: string } = {},
): Promise<UninstallResult> {
  const platform = opts.platform ?? detectPlatform();
  const homeDir = opts.homeDir ?? os.homedir();

  if (platform === "darwin") return uninstallLaunchd(homeDir, opts);
  if (platform === "linux") return uninstallSystemd(homeDir, opts);
  if (platform === "win32") return uninstallSchtasks(opts);

  return { platform, removed: false };
}

// --- macOS (launchd) --------------------------------------------------------

function renderPlist(config: ServiceConfig): string {
  const argv = [config.binPath, ...config.args];
  const argvXml = argv
    .map((s) => `        <string>${escapeXml(s)}</string>`)
    .join("\n");
  const envXml = config.env
    ? `    <key>EnvironmentVariables</key>\n    <dict>\n${Object.entries(config.env)
        .map(
          ([k, v]) =>
            `      <key>${escapeXml(k)}</key>\n      <string>${escapeXml(v)}</string>`,
        )
        .join("\n")}\n    </dict>\n`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${SERVICE_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
${argvXml}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
${envXml}    <key>StandardOutPath</key>
    <string>/tmp/${SERVICE_LABEL}.out.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/${SERVICE_LABEL}.err.log</string>
  </dict>
</plist>
`;
}

async function installLaunchd(
  config: ServiceConfig,
  homeDir: string,
  opts: ServiceOptions,
): Promise<InstallResult> {
  const unitPath = path.join(homeDir, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
  const unitContents = renderPlist(config);
  await fs.mkdir(path.dirname(unitPath), { recursive: true });
  await fs.writeFile(unitPath, unitContents, "utf8");

  const uid = process.getuid?.() ?? 501;
  const activateCommand = {
    command: "launchctl",
    args: ["bootstrap", `gui/${uid}`, unitPath],
  };
  if (opts.dryRun) {
    return { platform: "darwin", unitPath, unitContents, activateCommand, activated: false };
  }
  // v0.2.23 — reconfigure-safe: `launchctl bootstrap` errors with EIO (Input/output error)
  // when the service is already loaded, which broke every second `krimto init` after the
  // first install. Best-effort bootout first so the bootstrap below always starts from a
  // clean slate. The new plist content was already written above, so the bootstrap picks
  // up the latest env / argv when it reloads.
  try {
    await exec("launchctl", ["bootout", `gui/${uid}/${SERVICE_LABEL}`]);
  } catch {
    // Not loaded yet — happy first-install case, nothing to undo.
  }
  await exec(activateCommand.command, activateCommand.args);
  return { platform: "darwin", unitPath, unitContents, activateCommand, activated: true };
}

async function uninstallLaunchd(homeDir: string, opts: ServiceOptions): Promise<UninstallResult> {
  const unitPath = path.join(homeDir, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
  const uid = process.getuid?.() ?? 501;
  const deactivateCommand = {
    command: "launchctl",
    args: ["bootout", `gui/${uid}/${SERVICE_LABEL}`],
  };
  let removed = false;
  try {
    await fs.access(unitPath);
    if (!opts.dryRun) {
      // Best-effort bootout — service may already be unloaded.
      try {
        await exec(deactivateCommand.command, deactivateCommand.args);
      } catch {
        /* already unloaded */
      }
    }
    await fs.unlink(unitPath);
    removed = true;
  } catch {
    // Unit file absent — already uninstalled.
  }
  return { platform: "darwin", removed, deactivateCommand };
}

// --- Linux (systemd-user) ---------------------------------------------------

function renderSystemdUnit(config: ServiceConfig): string {
  const exec = [config.binPath, ...config.args].map(shellQuote).join(" ");
  const envLines = config.env
    ? Object.entries(config.env)
        .map(([k, v]) => `Environment=${k}=${v}`)
        .join("\n") + "\n"
    : "";
  return `[Unit]
Description=Krimto — team memory for AI coding agents
After=network.target

[Service]
Type=simple
ExecStart=${exec}
${envLines}Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}

async function installSystemd(
  config: ServiceConfig,
  homeDir: string,
  opts: ServiceOptions,
): Promise<InstallResult> {
  const unitPath = path.join(homeDir, ".config", "systemd", "user", `${SERVICE_NAME}.service`);
  const unitContents = renderSystemdUnit(config);
  await fs.mkdir(path.dirname(unitPath), { recursive: true });
  await fs.writeFile(unitPath, unitContents, "utf8");

  const activateCommand = {
    command: "systemctl",
    args: ["--user", "enable", "--now", SERVICE_NAME],
  };
  if (opts.dryRun) {
    return { platform: "linux", unitPath, unitContents, activateCommand, activated: false };
  }
  // daemon-reload first so systemd picks up the new unit, then enable+start.
  try {
    await exec("systemctl", ["--user", "daemon-reload"]);
  } catch {
    /* daemon-reload may fail on minimal containers; the enable below will surface real problems */
  }
  await exec(activateCommand.command, activateCommand.args);
  return { platform: "linux", unitPath, unitContents, activateCommand, activated: true };
}

async function uninstallSystemd(homeDir: string, opts: ServiceOptions): Promise<UninstallResult> {
  const unitPath = path.join(homeDir, ".config", "systemd", "user", `${SERVICE_NAME}.service`);
  const deactivateCommand = {
    command: "systemctl",
    args: ["--user", "disable", "--now", SERVICE_NAME],
  };
  let removed = false;
  try {
    await fs.access(unitPath);
    if (!opts.dryRun) {
      try {
        await exec(deactivateCommand.command, deactivateCommand.args);
      } catch {
        /* unit may already be inactive */
      }
    }
    await fs.unlink(unitPath);
    removed = true;
  } catch {
    // Already gone.
  }
  return { platform: "linux", removed, deactivateCommand };
}

// --- Windows (schtasks) -----------------------------------------------------

async function installSchtasks(config: ServiceConfig, opts: ServiceOptions): Promise<InstallResult> {
  // schtasks /TR takes a single command line, so we join argv with spaces (quoted appropriately).
  const trAction = [config.binPath, ...config.args].map(shellQuoteWindows).join(" ");
  const activateCommand = {
    command: "schtasks",
    args: ["/Create", "/F", "/SC", "ONLOGON", "/TN", SERVICE_NAME, "/TR", trAction],
  };
  if (opts.dryRun) {
    return { platform: "win32", activateCommand, activated: false };
  }
  await exec(activateCommand.command, activateCommand.args);
  return { platform: "win32", activateCommand, activated: true };
}

async function uninstallSchtasks(opts: ServiceOptions): Promise<UninstallResult> {
  const deactivateCommand = {
    command: "schtasks",
    args: ["/Delete", "/F", "/TN", SERVICE_NAME],
  };
  if (opts.dryRun) return { platform: "win32", removed: false, deactivateCommand };
  try {
    await exec(deactivateCommand.command, deactivateCommand.args);
    return { platform: "win32", removed: true, deactivateCommand };
  } catch {
    return { platform: "win32", removed: false, deactivateCommand };
  }
}

// --- shared helpers ---------------------------------------------------------

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function shellQuote(s: string): string {
  return /^[A-Za-z0-9_\-./]+$/.test(s) ? s : `"${s.replace(/"/g, '\\"')}"`;
}

function shellQuoteWindows(s: string): string {
  return /^[A-Za-z0-9_\-./:\\]+$/.test(s) ? s : `"${s.replace(/"/g, '\\"')}"`;
}
