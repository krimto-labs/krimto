// `krimto service` — change Krimto's run mode (as-needed / always-running / manual) after
// initial setup. Re-runs the run-mode question from Phase A and installs or uninstalls the
// platform service (launchd / systemd-user / schtasks) to match the new selection.
//
// "as-needed" → uninstall any service (editor launches Krimto on demand via stdio).
// "always-running" → install the service so Krimto stays up across reboots.
// "manual" → uninstall the service; the user runs `krimto serve` themselves.

import { select } from "@inquirer/prompts";
import * as path from "node:path";

import {
  detectPlatform,
  installService,
  isServiceInstalled,
  uninstallService,
  type InstallResult,
  type UninstallResult,
} from "./service";
import { defaultIdentity, type RunMode } from "./init";
import { assertInteractiveOrUsage, defaultIO, isExitPrompt, type WizardIO } from "./promptHelpers";

export interface ServiceCmdOptions {
  io?: WizardIO;
  dataDir?: string;
  homeDir?: string;
  /** Skip the prompt; pass the desired mode directly. */
  mode?: RunMode;
  /** Forwarded to install/uninstallService for tests. */
  dryRun?: boolean;
  /** Override service binPath (defaults to process.execPath). */
  binPath?: string;
  /** Override service argv (defaults to bin/krimto.mjs + "serve"). */
  serviceArgs?: string[];
}

export interface ServiceCmdResult {
  newMode: RunMode;
  install?: InstallResult;
  uninstall?: UninstallResult;
}

/** Apply the run-mode change: install or uninstall the platform service as needed. */
export async function applyService(
  mode: RunMode,
  opts: ServiceCmdOptions = {},
): Promise<ServiceCmdResult> {
  const homeDir = opts.homeDir;
  const platform = detectPlatform();
  const current = await isServiceInstalled(platform, homeDir);

  if (mode === "always-running") {
    if (current.installed) return { newMode: mode };
    const identity = await defaultIdentity();
    const dataDir = opts.dataDir ?? path.join(homeDir ?? "", ".krimto");
    const install = await installService(
      {
        binPath: opts.binPath ?? process.execPath,
        args: opts.serviceArgs ?? [process.argv[1] ?? "krimto", "serve"],
        env: { KRIMTO_IDENTITY: identity, KRIMTO_DATA: dataDir, KRIMTO_HTTP_PORT: "8080" },
        homeDir,
      },
      { dryRun: opts.dryRun, platform },
    );
    return { newMode: mode, install };
  }

  // "as-needed" and "manual" both want the service NOT to be installed. Uninstall if present.
  if (current.installed) {
    const uninstall = await uninstallService({ dryRun: opts.dryRun, platform, homeDir });
    return { newMode: mode, uninstall };
  }
  return { newMode: mode };
}

export async function runServiceCmd(opts: ServiceCmdOptions = {}): Promise<ServiceCmdResult | null> {
  const io = opts.io ?? defaultIO;
  // v0.2.34 — guard against agents calling `krimto service` cold. Without a mode flag we
  // would spawn a select prompt; without a TTY that hangs and then crashes with "unsettled
  // top-level await". Surface the flag forms instead.
  if (!opts.mode) {
    assertInteractiveOrUsage(SERVICE_USAGE);
  }
  try {
    const platform = detectPlatform();
    const current = await isServiceInstalled(platform, opts.homeDir);
    const currentLabel: RunMode = current.installed ? "always-running" : "as-needed";
    io.out("\nKrimto — Run mode\n\n");
    io.out(`  Current: ${runModeLabel(currentLabel)}\n\n`);

    const mode =
      opts.mode ??
      (await select<RunMode>({
        message: "How should Krimto run?",
        default: currentLabel,
        choices: [
          {
            value: "as-needed",
            name: "As needed",
            description: "Your editor launches Krimto on demand via stdio. Simplest.",
          },
          {
            value: "always-running",
            name: "Always running (background service)",
            description:
              "Install launchd/systemd/schtasks so Krimto stays up across reboots.\nBest if multiple editors talk to one Krimto.",
          },
          {
            value: "manual",
            name: "Manual (`krimto serve`)",
            description: "Power-user mode. You start the server yourself when needed.",
          },
        ],
      }));

    const result = await applyService(mode, opts);
    if (result.install) {
      io.out(
        result.install.activated
          ? `\n✅ Service installed and started (${result.install.platform}).\n`
          : `\n✅ Service definition written (${result.install.platform}, dry-run).\n`,
      );
    } else if (result.uninstall) {
      io.out(
        result.uninstall.removed
          ? `\n✅ Service uninstalled (${result.uninstall.platform}).\n`
          : `\n(No service was installed — nothing to remove.)\n`,
      );
    } else {
      io.out("\nNo change — already in the requested mode.\n");
    }
    return result;
  } catch (e) {
    if (isExitPrompt(e)) {
      io.err("\nAborted.\n");
      process.exitCode = 130;
      return null;
    }
    throw e;
  }
}

function runModeLabel(m: RunMode): string {
  switch (m) {
    case "as-needed":
      return "As needed (editor launches it)";
    case "always-running":
      return "Always running (background service)";
    case "manual":
      return "Manual (`krimto serve`)";
  }
}

/** v0.2.34 — non-interactive usage shown by the TTY guard. */
const SERVICE_USAGE =
  "For non-interactive use (AI agents / CI):\n" +
  "  krimto service --as-needed                    Editor launches Krimto on demand (stdio)\n" +
  "  krimto service --always                       Run continuously as a background service\n" +
  "  krimto service --manual                       Don't auto-start; user runs `krimto serve`";
