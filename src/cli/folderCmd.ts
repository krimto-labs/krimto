// `krimto folder` — guided move of the notes folder (`KRIMTO_DATA`) to a new location.
// The Maria-journey doc §06 names this as a "direct shortcut for power users". v0.2.31.
//
// What it does:
//   1. Reads the current data dir via resolveDataDir() (honours KRIMTO_DATA).
//   2. Prompts for a destination path (or accepts --to <path>).
//   3. Validates: destination must not exist OR be an empty directory we can take over.
//   4. Confirms with the user, listing the consequences.
//   5. If the always-running service is installed, uninstalls it first (the launchd plist
//      / systemd unit env still points at the OLD path; we'll reinstall with the new one
//      after the move).
//   6. Atomic-ish rename (`fs.rename`). When source and destination are on different
//      filesystems and `rename` errors with EXDEV, fall back to a recursive copy + remove.
//   7. Reinstalls the service (if it was installed) with `KRIMTO_DATA=<new path>` baked in.
//   8. Prints an `export KRIMTO_DATA=<new>` hint so the user's terminal sessions and any
//      scripts pick up the new path on next shell.

import { confirm, input } from "@inquirer/prompts";
import { promises as fs } from "node:fs";
import * as path from "node:path";

import {
  detectPlatform,
  installService,
  isServiceInstalled,
  uninstallService,
  type InstallResult,
} from "./service";
import { defaultIdentity } from "./init";
import { assertInteractiveOrUsage, defaultIO, isExitPrompt, type WizardIO } from "./promptHelpers";

export interface FolderCmdOptions {
  io?: WizardIO;
  /** Current data dir — usually `resolveDataDir()`. */
  from: string;
  /** Destination path. When omitted, the user is prompted. */
  to?: string;
  /** Override `os.homedir()` so installService writes the new service unit to a temp dir in tests. */
  homeDir?: string;
  /** Skip the confirmation prompt. */
  yes?: boolean;
  /** Forwarded to installService for tests so we don't really hit launchctl/systemctl. */
  dryRun?: boolean;
}

export interface FolderCmdResult {
  status: "ok" | "no-change" | "error";
  from: string;
  to: string;
  serviceReinstalled: boolean;
  message: string;
  reinstall?: InstallResult;
}

export async function runFolderCmd(opts: FolderCmdOptions): Promise<FolderCmdResult | null> {
  const io = opts.io ?? defaultIO;
  const fromDir = path.resolve(opts.from);

  // v0.2.34 — when --to was NOT supplied we'd open an input prompt for the destination.
  // Without a TTY (AI agent / CI) that hangs. Surface the flag form.
  if (!opts.to) {
    assertInteractiveOrUsage(FOLDER_USAGE);
  }

  try {
    io.out("\nKrimto — Move the notes folder\n\n");
    io.out(`  Current location:  ${fromDir}\n\n`);

    const to =
      opts.to ??
      (await input({
        message: "New location (absolute path):",
        validate: (v) => {
          const trimmed = v.trim();
          if (trimmed.length === 0) return "Path is required";
          if (!path.isAbsolute(trimmed)) return "Must be an absolute path (starts with /)";
          return true;
        },
      }));
    const toDir = path.resolve(to);

    if (toDir === fromDir) {
      return {
        status: "no-change",
        from: fromDir,
        to: toDir,
        serviceReinstalled: false,
        message: "\n  Source and destination are the same — nothing to move.\n\n",
      };
    }

    // Destination must be either absent or an empty directory. Refuse anything else so we
    // never silently merge into an existing notes folder.
    const destState = await classifyDestination(toDir);
    if (destState === "non-empty") {
      return {
        status: "error",
        from: fromDir,
        to: toDir,
        serviceReinstalled: false,
        message:
          `\n❌ ${toDir} exists and isn't empty.\n` +
          `   Pick an absent path or an empty directory. Krimto won't merge into an existing folder.\n\n`,
      };
    }

    io.out("\n  This will:\n");
    io.out(`    • Move every file from ${fromDir}\n`);
    io.out(`      to ${toDir}\n`);
    io.out("    • Reinstall the background service (if installed) with the new path\n\n");
    io.out("  This will NOT touch:\n");
    io.out("    • Editor MCP configs (they point at the HTTP server, not the dir)\n");
    io.out("    • Project rule files (.cursor/rules/*.mdc, CLAUDE.md, etc.)\n\n");
    io.out("  ⚠️  After the move, set KRIMTO_DATA in your shell so any new krimto\n");
    io.out("     processes (CLI or editor stdio launches) pick up the new path:\n\n");
    io.out(`       export KRIMTO_DATA="${toDir}"\n\n`);

    if (!opts.yes) {
      const ok = await confirm({ message: "Proceed?", default: false });
      if (!ok) {
        return {
          status: "no-change",
          from: fromDir,
          to: toDir,
          serviceReinstalled: false,
          message: "\nAborted. Nothing moved.\n\n",
        };
      }
    }

    // Uninstall the service first — its plist/unit env still names the OLD KRIMTO_DATA.
    // After the move we reinstall with the new one. We do this BEFORE the rename so launchd
    // / systemd isn't holding any handles into the (about-to-vanish) source dir.
    const platform = detectPlatform();
    const svc = await isServiceInstalled(platform, opts.homeDir);
    let serviceWasInstalled = false;
    if (svc.installed) {
      serviceWasInstalled = true;
      await uninstallService({ platform, homeDir: opts.homeDir, dryRun: opts.dryRun });
    }

    // The move itself. fs.rename is atomic when src + dst share a filesystem. When they
    // don't, Node throws EXDEV — fall back to copy-then-remove.
    try {
      await fs.mkdir(path.dirname(toDir), { recursive: true });
      await fs.rename(fromDir, toDir);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EXDEV") {
        // Cross-device fallback: cp -R then rm -rf, both via fs primitives.
        await fs.cp(fromDir, toDir, { recursive: true, preserveTimestamps: true });
        await fs.rm(fromDir, { recursive: true, force: true });
      } else {
        return {
          status: "error",
          from: fromDir,
          to: toDir,
          serviceReinstalled: false,
          message: `\n❌ Move failed: ${e instanceof Error ? e.message : String(e)}\n\n`,
        };
      }
    }

    // Reinstall the service (if it was) with the new data dir baked into its env.
    let reinstall: InstallResult | undefined;
    let serviceReinstalled = false;
    if (serviceWasInstalled) {
      const identity = await defaultIdentity();
      reinstall = await installService(
        {
          binPath: process.execPath,
          args: [process.argv[1] ?? "krimto", "serve"],
          env: { KRIMTO_IDENTITY: identity, KRIMTO_DATA: toDir, KRIMTO_HTTP_PORT: "8080" },
          homeDir: opts.homeDir,
        },
        { dryRun: opts.dryRun, platform },
      );
      serviceReinstalled = true;
    }

    const lines: string[] = [
      "",
      `✅ Notes folder moved.`,
      `   from: ${fromDir}`,
      `   to:   ${toDir}`,
      "",
    ];
    if (serviceReinstalled) lines.push("   • Background service reinstalled with the new path.");
    lines.push("");
    lines.push("Add this to your shell so future krimto runs find the new location:");
    lines.push(`   export KRIMTO_DATA="${toDir}"`);
    lines.push("");

    return {
      status: "ok",
      from: fromDir,
      to: toDir,
      serviceReinstalled,
      message: lines.join("\n"),
      ...(reinstall ? { reinstall } : {}),
    };
  } catch (e) {
    if (isExitPrompt(e)) {
      io.err("\nAborted.\n");
      process.exitCode = 130;
      return null;
    }
    throw e;
  }
}

/** Categorise the destination: "absent" (we'll create it), "empty" (take over), or "non-empty" (refuse). */
async function classifyDestination(dir: string): Promise<"absent" | "empty" | "non-empty"> {
  try {
    const entries = await fs.readdir(dir);
    return entries.length === 0 ? "empty" : "non-empty";
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    // Other errors (permission, not-a-dir) — treat as non-empty so we refuse.
    return "non-empty";
  }
}

/** v0.2.34 — non-interactive usage shown by the TTY guard. */
const FOLDER_USAGE =
  "For non-interactive use (AI agents / CI):\n" +
  "  krimto folder --to /new/absolute/path --yes   Move the notes folder";
