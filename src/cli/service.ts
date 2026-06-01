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
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export type ServicePlatform = "darwin" | "linux" | "win32" | "unsupported";

/**
 * Stable identifier for Krimto's service across all three platforms. This is the LEGACY/default
 * label — the canonical `~/.krimto` install keeps it exactly, so single-install users and every
 * doc that references `com.krimto.server` are unaffected. Non-default data dirs get a slug suffix
 * (see {@link serviceLabel}) so two installs on one machine don't hijack each other.
 */
export const SERVICE_LABEL = "com.krimto.server";
/** Short name used by systemctl/schtasks (where the dotted label isn't a valid id). */
export const SERVICE_NAME = "krimto";
/** The legacy/default HTTP port — preserved exactly for the canonical `~/.krimto` install. */
export const DEFAULT_HTTP_PORT = 8080;

/**
 * The canonical data dir a DEFAULT install lives in: always `~/.krimto`.
 *
 * Deliberately NOT `resolveDataDir()` — it must ignore `KRIMTO_DATA`. At runtime a non-default
 * install sets `KRIMTO_DATA=/projX/.krimto`; if we measured the slug against that, the install's
 * own dir would read as "canonical" (slug "" → port 8080) and collide with the real `~/.krimto`
 * install. The default is a fixed location, not whatever the current process points at.
 */
function canonicalDataDir(): string {
  return path.join(os.homedir(), ".krimto");
}

/**
 * Per-install "slot" discriminator, derived deterministically from the data-dir path.
 *
 * Returns `""` for the canonical data dir (so the legacy label/port are preserved verbatim), and
 * an 8-hex-char hash for any other data dir. Deterministic + state-free: every command
 * (`init`/`serve`/`ui`/`stop`/`status`) recomputes the same slug from the same data dir, so they
 * all agree on one install's label + port without any persisted discovery file.
 */
export function serviceSlug(dataDir: string, defaultDir: string = canonicalDataDir()): string {
  if (path.resolve(dataDir) === path.resolve(defaultDir)) return "";
  return createHash("sha256").update(path.resolve(dataDir)).digest("hex").slice(0, 8);
}

/** launchd/systemd label for the install serving `dataDir` (legacy label for the canonical dir). */
export function serviceLabel(dataDir: string, defaultDir: string = canonicalDataDir()): string {
  const slug = serviceSlug(dataDir, defaultDir);
  return slug ? `${SERVICE_LABEL}.${slug}` : SERVICE_LABEL;
}

/** systemctl/schtasks short id for the install serving `dataDir` (the dotted label isn't valid there). */
export function serviceName(dataDir: string, defaultDir: string = canonicalDataDir()): string {
  const slug = serviceSlug(dataDir, defaultDir);
  return slug ? `${SERVICE_NAME}-${slug}` : SERVICE_NAME;
}

/** The platform-neutral identity (dotted label + short name) of the install serving `dataDir`. */
export interface ServiceIdentity {
  label: string;
  name: string;
}
export function serviceIdentity(dataDir: string, defaultDir: string = canonicalDataDir()): ServiceIdentity {
  return { label: serviceLabel(dataDir, defaultDir), name: serviceName(dataDir, defaultDir) };
}

/**
 * HTTP port for the install serving `dataDir`. The canonical dir keeps {@link DEFAULT_HTTP_PORT}
 * (8080); any other dir maps deterministically into 8081..8980 — distinct from 8080 so a
 * non-default install never fights the canonical one for the port.
 */
export function servicePort(dataDir: string, defaultDir: string = canonicalDataDir()): number {
  const slug = serviceSlug(dataDir, defaultDir);
  if (!slug) return DEFAULT_HTTP_PORT;
  return 8081 + (Number.parseInt(slug, 16) % 900);
}

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
  /**
   * v0.2.27 — only meaningful when `activated: true` and the service config sets
   * `KRIMTO_HTTP_PORT`. `true` = TCP connection to `localhost:<port>` was accepted before
   * we returned, so the server is actually serving and clients (Cursor / Claude Code) won't
   * hit ECONNREFUSED if they reconnect immediately. `false` = the probe timed out; the
   * service IS installed and launchd reports it running, but the server hasn't bound the
   * port — usually a misconfig surfaced in the stderr log file. `undefined` = no probe ran
   * (dry run, stdio mode, or no HTTP port in the env block).
   */
  portReady?: boolean;
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
  /**
   * v0.2.27 — dependency-injected port probe. Default uses real `net.connect`. Tests pass
   * a stub that resolves immediately (so they don't open real TCP sockets). When omitted,
   * `installService` polls `localhost:<KRIMTO_HTTP_PORT>` until accept or `probeTimeoutMs`.
   */
  probePort?: (port: number) => Promise<boolean>;
  /** Maximum time (ms) to wait for the HTTP port to start accepting connections. Default 10000. */
  probeTimeoutMs?: number;
}

/** Map `process.platform` → the four service flavors Krimto knows about. */
export function detectPlatform(p: NodeJS.Platform = process.platform): ServicePlatform {
  if (p === "darwin") return "darwin";
  if (p === "linux") return "linux";
  if (p === "win32") return "win32";
  return "unsupported";
}

/**
 * Where Krimto's service definition would live on this platform. `dataDir` selects the install:
 * the canonical `~/.krimto` yields the legacy `com.krimto.server.plist` / `krimto.service`, any
 * other data dir yields a slug-suffixed file so two installs don't share one unit file.
 */
export function unitPathFor(
  platform: ServicePlatform,
  homeDir: string = os.homedir(),
  dataDir: string = canonicalDataDir(),
): string | null {
  if (platform === "darwin") {
    return path.join(homeDir, "Library", "LaunchAgents", `${serviceLabel(dataDir)}.plist`);
  }
  if (platform === "linux") {
    return path.join(homeDir, ".config", "systemd", "user", `${serviceName(dataDir)}.service`);
  }
  // Windows registers via schtasks; there is no on-disk unit file we manage directly.
  return null;
}

/** Is the service currently registered? Best-effort — uses file presence + platform CLI when available. */
export async function isServiceInstalled(
  platform: ServicePlatform = detectPlatform(),
  homeDir: string = os.homedir(),
  dataDir: string = canonicalDataDir(),
): Promise<{ platform: ServicePlatform; installed: boolean; unitPath?: string }> {
  if (platform === "unsupported") return { platform, installed: false };
  const unitPath = unitPathFor(platform, homeDir, dataDir);
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
    await exec("schtasks", ["/Query", "/TN", serviceName(dataDir)]);
    return { platform, installed: true };
  } catch {
    return { platform, installed: false };
  }
}

/**
 * v0.2.26 — richer probe than {@link isServiceInstalled}. Distinguishes three states the
 * smoke-6 transcript proved we needed:
 *   • `unitPresent: true, loaded: false`    — plist on disk but not bootstrapped (failed install left over)
 *   • `unitPresent: true, loaded: true`     — fully active service
 *   • `unitPresent: false, loaded: false`   — clean machine (or service was uninstalled)
 *
 * Also returns the PID launchd is currently running, so the caller can correlate it against
 * the lock file — when the running Krimto PID equals launchd's `pid`, the process IS the
 * service-launched one, even if its lock file is missing the `launchedBy` field (because the
 * process started under an old version).
 */
export async function probeServiceState(
  platform: ServicePlatform = detectPlatform(),
  homeDir: string = os.homedir(),
  dataDir: string = canonicalDataDir(),
): Promise<{
  platform: ServicePlatform;
  unitPresent: boolean;
  loaded: boolean;
  runningPid: number | null;
}> {
  const base = await isServiceInstalled(platform, homeDir, dataDir);
  const unitPresent = base.installed;
  const label = serviceLabel(dataDir);
  const name = serviceName(dataDir);

  if (platform === "darwin") {
    const uid = process.getuid?.() ?? 501;
    try {
      const { stdout } = await exec("launchctl", ["print", `gui/${uid}/${label}`]);
      const pidMatch = stdout.match(/\bpid\s*=\s*(\d+)/);
      const pid = pidMatch && pidMatch[1] ? Number.parseInt(pidMatch[1], 10) : null;
      return { platform, unitPresent, loaded: true, runningPid: pid };
    } catch {
      return { platform, unitPresent, loaded: false, runningPid: null };
    }
  }
  if (platform === "linux") {
    try {
      // `systemctl --user is-active <name>` exits 0 with "active" when running.
      const { stdout } = await exec("systemctl", ["--user", "is-active", name]);
      const active = stdout.trim() === "active";
      if (!active) return { platform, unitPresent, loaded: false, runningPid: null };
      // Best-effort PID lookup.
      try {
        const { stdout: pidOut } = await exec("systemctl", ["--user", "show", "--property=MainPID", "--value", name]);
        const pid = Number.parseInt(pidOut.trim(), 10);
        return { platform, unitPresent, loaded: true, runningPid: Number.isFinite(pid) && pid > 0 ? pid : null };
      } catch {
        return { platform, unitPresent, loaded: true, runningPid: null };
      }
    } catch {
      return { platform, unitPresent, loaded: false, runningPid: null };
    }
  }
  if (platform === "win32") {
    try {
      await exec("schtasks", ["/Query", "/TN", name]);
      return { platform, unitPresent: true, loaded: true, runningPid: null };
    } catch {
      return { platform, unitPresent: false, loaded: false, runningPid: null };
    }
  }
  return { platform, unitPresent: false, loaded: false, runningPid: null };
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

  // Per-install identity, derived from the data dir the service will serve. The canonical
  // `~/.krimto` keeps the legacy label/name; any other data dir gets a slug-suffixed identity so
  // this install's plist/unit + launchctl/systemctl/schtasks ops never touch another install's.
  const ident = serviceIdentity(config.env?.KRIMTO_DATA ?? canonicalDataDir());

  let result: InstallResult;
  if (platform === "darwin") {
    result = await installLaunchd(configWithMarker, homeDir, opts, ident);
  } else if (platform === "linux") {
    result = await installSystemd(configWithMarker, homeDir, opts, ident);
  } else if (platform === "win32") {
    result = await installSchtasks(configWithMarker, opts, ident);
  } else {
    throw new Error(
      `Krimto's "Always running" mode isn't supported on platform "${process.platform}" yet. ` +
        `Use "As needed" mode (the wizard default) or run \`krimto serve\` manually.`,
    );
  }

  // v0.2.27 — port-readiness probe. The smoke-6 transcript showed Cursor failing with
  // ECONNREFUSED in the ~3-second window between launchd accepting the bootstrap and the
  // Node process actually binding the HTTP port. The wizard's "Background service installed
  // and started" line ran during that window, so users restarted their editor right when
  // the port was still unbound. Now we wait for the port to accept a TCP connection before
  // returning success; if it doesn't come up within `probeTimeoutMs`, the wizard surfaces
  // the warning instead of giving false confidence.
  if (result.activated && !opts.dryRun) {
    const portStr = configWithMarker.env?.KRIMTO_HTTP_PORT;
    const port = portStr ? Number.parseInt(portStr, 10) : NaN;
    if (Number.isFinite(port) && port > 0) {
      const probe = opts.probePort ?? defaultPortProbe;
      result.portReady = await waitForPort(port, probe, opts.probeTimeoutMs ?? 10000);
    }
  }
  return result;
}

/**
 * Poll the port via the injected probe every 250ms until it accepts or the timeout elapses.
 * Returns true on first successful connect, false on timeout. v0.2.27.
 */
async function waitForPort(
  port: number,
  probe: (port: number) => Promise<boolean>,
  timeoutMs: number,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await probe(port)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/**
 * Real port probe: open a TCP socket to 127.0.0.1:<port>, resolve true on `connect`, false on
 * error or 500ms timeout. The probe itself is cheap (kernel-level connect refusal), so a tight
 * 250ms poll loop over a 10s window is fine.
 */
async function defaultPortProbe(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    let done = false;
    const finish = (ok: boolean): void => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(ok);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(500, () => finish(false));
  });
}

/** Uninstall the service. Removes the unit file + invokes the platform CLI to deactivate it. */
export async function uninstallService(
  opts: ServiceOptions & { homeDir?: string; dataDir?: string } = {},
): Promise<UninstallResult> {
  const platform = opts.platform ?? detectPlatform();
  const homeDir = opts.homeDir ?? os.homedir();
  const ident = serviceIdentity(opts.dataDir ?? canonicalDataDir());

  if (platform === "darwin") return uninstallLaunchd(homeDir, opts, ident);
  if (platform === "linux") return uninstallSystemd(homeDir, opts, ident);
  if (platform === "win32") return uninstallSchtasks(opts, ident);

  return { platform, removed: false };
}

/**
 * v0.2.32 — STOP the service without removing the unit file. The Maria-journey audit caught
 * `krimto stop` mistakenly deleting the plist (because it used `uninstallService`), which
 * left `krimto start` with nothing to reload. Semantic split:
 *
 *   stopService()        — unload now. Unit file stays. `start` can reload it.
 *   uninstallService()   — unload + delete unit file. `reset` and run-mode switches use this.
 *
 * Returns the same UninstallResult shape so callers can branch on `removed` uniformly.
 * `removed` here means "the service was loaded AND we unloaded it" — NOT "the unit file
 * was deleted" (it wasn't).
 */
export async function stopService(
  opts: ServiceOptions & { homeDir?: string; dataDir?: string } = {},
): Promise<UninstallResult> {
  const platform = opts.platform ?? detectPlatform();
  // homeDir intentionally unused — the bootout/disable commands address the service by its
  // label, not by file path. We accept the param so the call signature matches uninstallService.
  const { label, name } = serviceIdentity(opts.dataDir ?? canonicalDataDir());
  if (platform === "darwin") {
    const uid = process.getuid?.() ?? 501;
    const deactivateCommand = { command: "launchctl", args: ["bootout", `gui/${uid}/${label}`] };
    if (opts.dryRun) return { platform, removed: false, deactivateCommand };
    try {
      await exec(deactivateCommand.command, deactivateCommand.args);
      return { platform, removed: true, deactivateCommand };
    } catch {
      return { platform, removed: false, deactivateCommand };
    }
  }
  if (platform === "linux") {
    const deactivateCommand = { command: "systemctl", args: ["--user", "stop", name] };
    if (opts.dryRun) return { platform, removed: false, deactivateCommand };
    try {
      await exec(deactivateCommand.command, deactivateCommand.args);
      return { platform, removed: true, deactivateCommand };
    } catch {
      return { platform, removed: false, deactivateCommand };
    }
  }
  if (platform === "win32") {
    // Task Scheduler has no "stop without delete" — there's nothing per-run holding the
    // service open. Best we can do is `schtasks /End` to terminate the current run.
    const deactivateCommand = { command: "schtasks", args: ["/End", "/TN", name] };
    if (opts.dryRun) return { platform, removed: false, deactivateCommand };
    try {
      await exec(deactivateCommand.command, deactivateCommand.args);
      return { platform, removed: true, deactivateCommand };
    } catch {
      return { platform, removed: false, deactivateCommand };
    }
  }
  return { platform, removed: false };
}

// --- macOS (launchd) --------------------------------------------------------

function renderPlist(config: ServiceConfig, label: string): string {
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
    <string>${label}</string>
    <key>ProgramArguments</key>
    <array>
${argvXml}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
${envXml}    <key>StandardOutPath</key>
    <string>/tmp/${label}.out.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/${label}.err.log</string>
  </dict>
</plist>
`;
}

async function installLaunchd(
  config: ServiceConfig,
  homeDir: string,
  opts: ServiceOptions,
  ident: ServiceIdentity,
): Promise<InstallResult> {
  const { label } = ident;
  const unitPath = path.join(homeDir, "Library", "LaunchAgents", `${label}.plist`);
  const unitContents = renderPlist(config, label);
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
  // v0.2.26 — supersedes the v0.2.23 bootout+bootstrap pattern. The previous fix raced
  // against launchd's still-tearing-down state: `launchctl bootout` returns when the unload
  // is QUEUED, not when it completes, so the subsequent `bootstrap` could still hit EIO.
  // Correct pattern:
  //   • If the service is currently loaded → `launchctl kickstart -k gui/<uid>/<label>`
  //     atomically kills + restarts the running process. Because we already overwrote the
  //     plist above, the new process starts with the latest env / argv.
  //   • If the service is NOT loaded → plain `bootstrap`. No race possible.
  // `launchctl print` returning exit-0 is the canonical "is it loaded" probe.
  const printRes = await exec("launchctl", ["print", `gui/${uid}/${label}`]).then(
    () => ({ loaded: true }),
    () => ({ loaded: false }),
  );
  if (printRes.loaded) {
    // Kickstart -k: send SIGTERM, wait for clean exit, then restart from the plist on disk.
    // launchctl returns from kickstart only AFTER the new process is up, so no follow-on race.
    // Because the label is per-data-dir, this only ever restarts THIS install's service — a
    // second install on a different data dir has a different label and is left untouched.
    await exec("launchctl", ["kickstart", "-k", `gui/${uid}/${label}`]);
    return {
      platform: "darwin",
      unitPath,
      unitContents,
      activateCommand: { command: "launchctl", args: ["kickstart", "-k", `gui/${uid}/${label}`] },
      activated: true,
    };
  }
  await exec(activateCommand.command, activateCommand.args);
  return { platform: "darwin", unitPath, unitContents, activateCommand, activated: true };
}

async function uninstallLaunchd(
  homeDir: string,
  opts: ServiceOptions,
  ident: ServiceIdentity,
): Promise<UninstallResult> {
  const unitPath = path.join(homeDir, "Library", "LaunchAgents", `${ident.label}.plist`);
  const uid = process.getuid?.() ?? 501;
  const deactivateCommand = {
    command: "launchctl",
    args: ["bootout", `gui/${uid}/${ident.label}`],
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
  ident: ServiceIdentity,
): Promise<InstallResult> {
  const { name } = ident;
  const unitPath = path.join(homeDir, ".config", "systemd", "user", `${name}.service`);
  const unitContents = renderSystemdUnit(config);
  await fs.mkdir(path.dirname(unitPath), { recursive: true });
  await fs.writeFile(unitPath, unitContents, "utf8");

  const activateCommand = {
    command: "systemctl",
    args: ["--user", "enable", "--now", name],
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

async function uninstallSystemd(
  homeDir: string,
  opts: ServiceOptions,
  ident: ServiceIdentity,
): Promise<UninstallResult> {
  const { name } = ident;
  const unitPath = path.join(homeDir, ".config", "systemd", "user", `${name}.service`);
  const deactivateCommand = {
    command: "systemctl",
    args: ["--user", "disable", "--now", name],
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

async function installSchtasks(
  config: ServiceConfig,
  opts: ServiceOptions,
  ident: ServiceIdentity,
): Promise<InstallResult> {
  // schtasks /TR takes a single command line, so we join argv with spaces (quoted appropriately).
  const trAction = [config.binPath, ...config.args].map(shellQuoteWindows).join(" ");
  const activateCommand = {
    command: "schtasks",
    args: ["/Create", "/F", "/SC", "ONLOGON", "/TN", ident.name, "/TR", trAction],
  };
  if (opts.dryRun) {
    return { platform: "win32", activateCommand, activated: false };
  }
  await exec(activateCommand.command, activateCommand.args);
  return { platform: "win32", activateCommand, activated: true };
}

async function uninstallSchtasks(opts: ServiceOptions, ident: ServiceIdentity): Promise<UninstallResult> {
  const deactivateCommand = {
    command: "schtasks",
    args: ["/Delete", "/F", "/TN", ident.name],
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
