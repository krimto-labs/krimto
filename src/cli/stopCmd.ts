// `krimto stop` / `krimto start` / `krimto restart` — v0.2.32 zero-friction off-ramp.
//
// The Maria-journey audit caught Krimto with three half-overlapping teardown verbs
// (`uninit` for rules-only, `service` for run-mode-switching, `reset` for full machine
// disconnect) and NO first-class verb for "stop the running krimto". Users guessing for
// the stop button found nothing — the deeper verbs that did the work were named after
// internal subsystems, not after what the user wanted to accomplish.
//
// This module owns the three plain-English verbs:
//
//   krimto stop      Stop whatever's running. Idempotent. No prompts.
//                    • Service-mode install? Uninstall it (launchd boots out the process).
//                    • Lock-file PID alive? SIGTERM, then SIGKILL after 500ms.
//                    • Lock-file gone? No-op.
//
//   krimto start     Get krimto running again.
//                    • Service plist exists on disk? Reinstall + bootstrap (back to
//                      always-running mode).
//                    • No plist? Print an instructive message — ad-hoc background spawn is
//                      brittle; the user can `krimto serve` foreground or `krimto init` to
//                      configure always-running.
//
//   krimto restart   stop + start. On always-running mode this uses launchctl kickstart -k
//                    via the v0.2.26 install path (atomic SIGTERM + respawn, no race).

import { confirm } from "@inquirer/prompts";
import { promises as fs } from "node:fs";
import * as path from "node:path";

import { defaultIdentity } from "./init";
import { isExitPrompt, type WizardIO } from "./promptHelpers";
import {
  detectPlatform,
  installService,
  isServiceInstalled,
  serviceLabel,
  servicePort,
  stopService,
  type InstallResult,
  type ServiceOptions,
} from "./service";
import { buildTeamSummary } from "./teamSummary";

export interface StopOptions {
  io?: WizardIO;
  dataDir: string;
  homeDir?: string;
  /** Forwarded to uninstallService for tests. */
  dryRun?: boolean;
  /** Skip the confirm() — stop is non-destructive, so default-Y; the flag exists for symmetry. */
  yes?: boolean;
}

export interface StopResult {
  status: "stopped" | "already-stopped";
  serviceUninstalled: boolean;
  pidKilled: number | null;
  message: string;
}

export async function runStop(opts: StopOptions): Promise<StopResult> {
  const platform = detectPlatform();

  // Safety: stopping the team server disconnects every teammate that relies on it. Only guard
  // when THIS machine is actually hosting a team (a live HTTP server + admins in members.yaml) —
  // a plain solo stop stays prompt-free. `--yes` bypasses for scripts.
  const team = await buildTeamSummary(opts.dataDir, "");
  if (team.mode === "team" && team.hostedHere && !opts.yes) {
    const warn = `\n⚠ This machine is the team server — stopping disconnects ${team.memberCount} teammate${
      team.memberCount === 1 ? "" : "s"
    } until it's restarted.\n`;
    if (process.stdin.isTTY === true) {
      opts.io?.out(warn);
      const ok = await confirm({ message: "Stop the team server anyway?", default: false });
      if (!ok) {
        return {
          status: "already-stopped",
          serviceUninstalled: false,
          pidKilled: null,
          message: "\n  Left the team server running.\n\n",
        };
      }
    } else {
      return {
        status: "already-stopped",
        serviceUninstalled: false,
        pidKilled: null,
        message: warn + "  Re-run with `krimto stop --yes` to confirm.\n\n",
      };
    }
  }

  const svc = await isServiceInstalled(platform, opts.homeDir, opts.dataDir);

  // v0.2.32 — use stopService (not uninstallService) so the unit file stays on disk and
  // `krimto start` can reload it. uninstallService is the heavier hammer used by `reset`
  // and by `service` when switching modes.
  let serviceUninstalled = false;
  if (svc.installed) {
    const stop = await stopService({ platform, homeDir: opts.homeDir, dataDir: opts.dataDir, dryRun: opts.dryRun });
    serviceUninstalled = stop.removed;
  }

  // Kill any ad-hoc PID still holding the lock. Service-mode uninstall already killed its
  // own process, so this catches `krimto serve` in a separate terminal or a stale lock that
  // outlived its PID by being on a different filesystem etc.
  const pidKilled = await terminateLockHolder(opts.dataDir);

  // Wipe the lock file so the next `krimto serve` / editor stdio launch starts clean.
  const lockPath = path.join(opts.dataDir, ".krimto", "lock.json");
  try {
    await fs.unlink(lockPath);
  } catch {
    /* no lock — fine */
  }

  if (!serviceUninstalled && pidKilled === null) {
    return {
      status: "already-stopped",
      serviceUninstalled: false,
      pidKilled: null,
      message: "\n  Krimto is already stopped — nothing to do.\n\n",
    };
  }

  const lines: string[] = ["", "✅ Krimto stopped."];
  if (serviceUninstalled) lines.push("   • Background service uninstalled.");
  if (pidKilled !== null) lines.push(`   • Sent SIGTERM to PID ${pidKilled}.`);
  lines.push("");
  lines.push("Start again with:  krimto start");
  lines.push("");
  return {
    status: "stopped",
    serviceUninstalled,
    pidKilled,
    message: lines.join("\n"),
  };
}

export interface StartOptions {
  io?: WizardIO;
  dataDir: string;
  homeDir?: string;
  /** Forwarded to installService for tests. */
  dryRun?: boolean;
  /** Override the port probe (tests). Default uses real net.connect. */
  probePort?: ServiceOptions["probePort"];
}

export interface StartResult {
  status: "started" | "already-running" | "no-service-configured" | "error";
  mode: "service" | "ad-hoc" | "none";
  install?: InstallResult;
  message: string;
}

export async function runStart(opts: StartOptions): Promise<StartResult> {
  const platform = detectPlatform();
  const svc = await isServiceInstalled(platform, opts.homeDir, opts.dataDir);

  if (svc.installed) {
    // Service was previously installed. Reinstall via the existing v0.2.26 path which
    // detects "already loaded" and uses kickstart -k vs bootstrap accordingly — so `start`
    // works correctly whether the service is fully stopped or just hung mid-boot.
    const identity = await defaultIdentity();
    const dataDir = opts.dataDir;
    const port = servicePort(dataDir);
    const install = await installService(
      {
        binPath: process.execPath,
        args: [process.argv[1] ?? "krimto", "serve"],
        env: { KRIMTO_IDENTITY: identity, KRIMTO_DATA: dataDir, KRIMTO_HTTP_PORT: String(port) },
        homeDir: opts.homeDir,
      },
      { dryRun: opts.dryRun, platform, ...(opts.probePort ? { probePort: opts.probePort } : {}) },
    );
    return {
      status: "started",
      mode: "service",
      install,
      message:
        `\n✅ Krimto service started (${install.platform}).\n` +
        (install.portReady === false
          ? `   ⚠ The HTTP port didn't come up within 10s. Check /tmp/${serviceLabel(dataDir)}.err.log.\n`
          : install.portReady === true
            ? `   Port :${port} accepting connections.\n`
            : "") +
        "\n",
    };
  }

  // No service installed. We deliberately don't background-detach `krimto serve` here —
  // doing it correctly across macOS / Linux / Windows is brittle. Instead, give the user
  // two honest paths.
  return {
    status: "no-service-configured",
    mode: "none",
    message:
      "\n  No background service is configured on this machine.\n\n" +
      "  Either set one up (one-time):\n" +
      "    $ krimto init --yes\n" +
      "  Or start ad-hoc in a foreground terminal:\n" +
      "    $ krimto serve\n\n",
  };
}

export interface RestartOptions extends StartOptions {
  yes?: boolean;
}

export interface RestartResult {
  stopResult: StopResult;
  startResult: StartResult;
  message: string;
}

/**
 * Stop + start. For always-running mode this naturally goes through `launchctl kickstart -k`
 * (via installService's v0.2.26 reload path), which is atomic — no port-unbound window.
 */
export async function runRestart(opts: RestartOptions): Promise<RestartResult> {
  const stopResult = await runStop(opts);
  const startResult = await runStart(opts);
  return {
    stopResult,
    startResult,
    message: stopResult.message + startResult.message,
  };
}

/**
 * v0.2.32 — shared with src/cli/reset.ts. Sends SIGTERM to the lock-file PID and SIGKILLs
 * 500ms later if still alive. Returns the PID we acted on, or null when nothing was found.
 * Best-effort: a missing/malformed/dead lock file silently no-ops.
 */
export async function terminateLockHolder(dataDir: string): Promise<number | null> {
  const lockPath = path.join(dataDir, ".krimto", "lock.json");
  let pid: number | null = null;
  try {
    const raw = await fs.readFile(lockPath, "utf8");
    const parsed = JSON.parse(raw) as { pid?: unknown };
    if (typeof parsed.pid === "number" && parsed.pid > 0) pid = parsed.pid;
  } catch {
    return null;
  }
  if (pid === null) return null;
  if (pid === process.pid) return null; // never kill ourselves
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return null; // already gone
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
  try {
    process.kill(pid, 0);
    process.kill(pid, "SIGKILL");
  } catch {
    /* exited cleanly on SIGTERM */
  }
  return pid;
}

/**
 * Convenience wrapper for callers that want a confirm-prompt before stop. The `uninit`
 * command uses this when offering "Also stop the service?" after rule removal.
 */
export async function confirmStop(): Promise<boolean> {
  try {
    return await confirm({ message: "Also stop the background service?", default: false });
  } catch (e) {
    if (isExitPrompt(e)) return false;
    throw e;
  }
}
