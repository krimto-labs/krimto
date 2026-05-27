// `krimto reset` — machine-level wipe of Krimto's configuration. Removes:
//
//   • MCP-config entries from every editor we wired (Cursor JSON + Claude Code CLI via dry-run)
//   • The standing rule from the current project's rules files (best-effort — only this cwd)
//   • The background service (launchd / systemd / schtasks), if installed
//   • The local API-key store (`.krimto/keys.json`)
//
// Does NOT touch:
//   • The notes folder (`<dataDir>/{user,team,org}/...`) — that's data, not config
//   • `members.yaml` and the git history (those are shared team state)
//
// `--wipe-notes` adds a second, explicit confirm before atomically moving the entire data dir
// to a timestamped trash sibling. The trash is left on disk so the user can recover if they
// realise it was a mistake; a final `rm -rf <trash>` is their call.

import { confirm } from "@inquirer/prompts";
import { promises as fs } from "node:fs";
import * as path from "node:path";

import { removeRule } from "../agentRule";
import {
  detectEditorEnvironments,
  type EditorEnvironment,
  type EditorKind,
} from "./init";
import { removeMcpConfig } from "./mcpConfig";
import { assertInteractiveOrUsage, defaultIO, isExitPrompt, type WizardIO } from "./promptHelpers";
import { detectPlatform, uninstallService } from "./service";

const EDITOR_LABEL: Record<EditorKind, string> = {
  cursor: "Cursor",
  "claude-code": "Claude Code",
  codex: "Codex",
  "gemini-cli": "Gemini CLI",
};

export interface ResetOptions {
  io?: WizardIO;
  cwd?: string;
  homeDir?: string;
  dataDir?: string;
  /** Also move the notes folder into a trash directory. Requires an extra confirmation. */
  wipeNotes?: boolean;
  /** Skip both confirmations (tests, scripts). */
  yes?: boolean;
  /** Forwarded to uninstallService for tests. */
  dryRun?: boolean;
}

export interface ResetResult {
  editorsDisconnected: EditorKind[];
  rulesStripped: string[];
  serviceRemoved: boolean;
  keysWiped: boolean;
  notesTrashedTo?: string;
}

export async function applyReset(opts: ResetOptions = {}): Promise<ResetResult> {
  const cwd = opts.cwd ?? process.cwd();
  const homeDir = opts.homeDir;
  const dataDir = opts.dataDir ?? path.join(homeDir ?? "", ".krimto");

  // v0.2.26 — reset is now "always sweep, never trust detection". The smoke-6 transcript
  // caught reset reporting "No changes made" while a service was actually loaded and
  // Cursor's mcp.json still had a krimto entry: detection was wrong (Claude Code was
  // invisible to CLI-method scans), so reset's gated-by-detection cleanup ran nothing.
  // Now every cleanup path runs best-effort regardless of what detection thinks. We can
  // distinguish "ran but found nothing" from "intentionally skipped" by inspecting the
  // result type — `editorsDisconnected` only includes editors whose removeMcpConfig
  // returned removed=true, so an empty list still means "nothing to remove" cleanly.

  const envs = await detectEditorEnvironments(cwd, homeDir);

  // 1. Try to disconnect every editor we know about, regardless of what detection says.
  //    removeMcpConfig is already idempotent — it returns removed=false if there was nothing
  //    to remove, so blanket-running it is safe.
  const editorsDisconnected: EditorKind[] = [];
  for (const env of envs) {
    const res = await removeMcpConfig(env);
    if (res.removed) editorsDisconnected.push(env.editor);
  }

  // 2. Strip the standing rule from each detected rule file in CWD (already idempotent).
  const rulesStripped: string[] = [];
  for (const env of envs) {
    const stripped = await stripRule(cwd, env);
    if (stripped) rulesStripped.push(env.rulesPath);
  }

  // 3. Uninstall the background service ALWAYS (even if isServiceInstalled said no). The
  //    inner uninstall is best-effort: the platform CLI errors when nothing's loaded, but
  //    we swallow them. This catches the case where a stale plist exists without an active
  //    launchctl entry (or vice versa) — both halves get cleaned in one pass.
  const platform = detectPlatform();
  let serviceRemoved = false;
  try {
    const res = await uninstallService({ dryRun: opts.dryRun, platform, homeDir });
    serviceRemoved = res.removed;
  } catch {
    /* uninstall path can throw on unsupported platforms or missing CLIs — we're sweeping, not validating */
  }

  // 4. Kill any live ad-hoc Krimto process holding the lock — otherwise a `krimto serve`
  //    that's still running keeps the data dir busy and the next init will conflict on the
  //    lock. Best-effort: SIGTERM, give it 500ms, SIGKILL if still alive.
  await terminateLockHolder(dataDir);

  // 5. Wipe the keys store (best-effort — file may not exist).
  const keysPath = path.join(dataDir, ".krimto", "keys.json");
  let keysWiped = false;
  try {
    await fs.unlink(keysPath);
    keysWiped = true;
  } catch {
    /* no keys file — fine */
  }

  // 6. Wipe the lock file itself so the next init starts from a known-clean slate. Without
  //    this, a stale lock from a process we just killed can confuse subsequent commands.
  const lockPath = path.join(dataDir, ".krimto", "lock.json");
  try {
    await fs.unlink(lockPath);
  } catch {
    /* no lock — fine */
  }

  // 5. Optionally move the data dir to a timestamped trash sibling.
  let notesTrashedTo: string | undefined;
  if (opts.wipeNotes) {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const trashPath = `${dataDir}.trash-${ts}`;
    try {
      await fs.rename(dataDir, trashPath);
      notesTrashedTo = trashPath;
    } catch (e) {
      process.stderr.write(
        `krimto: --wipe-notes failed to move ${dataDir} → ${trashPath}: ${
          e instanceof Error ? e.message : String(e)
        }\n`,
      );
    }
  }

  return {
    editorsDisconnected,
    rulesStripped,
    serviceRemoved,
    keysWiped,
    notesTrashedTo,
  };
}

export async function runReset(opts: ResetOptions = {}): Promise<ResetResult | null> {
  const io = opts.io ?? defaultIO;
  // v0.2.34 — when --yes was NOT passed we'd open a confirm prompt. Without a TTY (AI
  // agent / CI) the prompt would hang. Surface the flag form instead.
  if (!opts.yes) {
    assertInteractiveOrUsage(RESET_USAGE);
  }
  try {
    const dataDir = opts.dataDir ?? path.join(opts.homeDir ?? "", ".krimto");

    // v0.2.33 — single-prompt UX. The original flow asked "Proceed with reset?" first
    // (default N), and only AFTER that asked the wipe-notes-specific confirmation. Users
    // who passed `--wipe-notes` were tripped up by the first prompt: they'd typed the flag,
    // hit Enter at "Proceed?", and got "No changes made" without realising the flag they
    // passed had no consent baked in. The fix: when `--wipe-notes` is passed, collapse the
    // two confirmations into ONE that names the worst thing explicitly. Without the flag,
    // the single-prompt flow stays exactly as it was.
    io.out("\nKrimto — Reset machine-level config\n\n");
    if (opts.wipeNotes) {
      io.out("  ⚠️  --wipe-notes — this will:\n");
      io.out("    • Disconnect Krimto from all editors (MCP config + standing rule)\n");
      io.out("    • Stop and uninstall the background service (if installed)\n");
      io.out("    • Wipe the local API-key store\n");
      io.out(`    • MOVE your notes folder (${dataDir}) to a timestamped trash sibling\n`);
      io.out(`      ${dataDir}.trash-<ts> stays on disk until you delete it manually.\n\n`);
      io.out("  This will NOT touch:\n");
      io.out("    • The team's git history or members.yaml on the remote\n\n");
    } else {
      io.out("  This will:\n");
      io.out("    • Disconnect Krimto from all editors (MCP config + standing rule)\n");
      io.out("    • Stop and uninstall the background service (if installed)\n");
      io.out("    • Wipe the local API-key store\n\n");
      io.out("  This will NOT touch:\n");
      io.out(`    • Your notes folder (${dataDir}) — pass --wipe-notes to also move it\n`);
      io.out("    • The team's git history or members.yaml\n\n");
    }

    const promptMessage = opts.wipeNotes
      ? "Wipe notes folder AND disconnect everything?"
      : "Proceed with reset?";
    const ok = opts.yes ?? (await confirm({ message: promptMessage, default: false }));
    if (!ok) {
      io.out("\nNo changes made.\n");
      return null;
    }

    const result = await applyReset(opts);
    printResetResult(result, io);
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

/**
 * If the lock file points at a live PID, send SIGTERM then SIGKILL (after 500ms). Best-effort;
 * we don't return the outcome because reset's contract is "do the cleanup, don't validate".
 * v0.2.26 — without this step, a leftover `krimto serve` PID survived `reset` and the next
 * init would either reuse the dead lock OR conflict on the live port (whichever came first).
 */
async function terminateLockHolder(dataDir: string): Promise<void> {
  const lockPath = path.join(dataDir, ".krimto", "lock.json");
  let pid: number | null = null;
  try {
    const raw = await fs.readFile(lockPath, "utf8");
    const parsed = JSON.parse(raw) as { pid?: unknown };
    if (typeof parsed.pid === "number" && parsed.pid > 0) pid = parsed.pid;
  } catch {
    return; // no lock — nothing to terminate
  }
  if (pid === null) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return; // already gone
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
  try {
    process.kill(pid, 0); // existence probe
    process.kill(pid, "SIGKILL");
  } catch {
    /* exited cleanly on SIGTERM */
  }
}

async function stripRule(cwd: string, env: EditorEnvironment): Promise<boolean> {
  const rulePath = path.join(cwd, env.rulesPath);
  let existing: string;
  try {
    existing = await fs.readFile(rulePath, "utf8");
  } catch {
    return false;
  }
  const next = removeRule(existing);
  if (next === existing) return false;
  if (next === null) {
    await fs.unlink(rulePath).catch(() => undefined);
    return true;
  }
  await fs.writeFile(rulePath, next, "utf8");
  return true;
}

function printResetResult(res: ResetResult, io: WizardIO): void {
  io.out("\nDone:\n");
  if (res.editorsDisconnected.length > 0) {
    for (const e of res.editorsDisconnected) io.out(`  ✓ Disconnected ${EDITOR_LABEL[e]}\n`);
  } else {
    io.out(`  – No editors were connected\n`);
  }
  if (res.rulesStripped.length > 0) {
    for (const r of res.rulesStripped) io.out(`  ✓ Removed standing rule from ${r}\n`);
  }
  io.out(
    res.serviceRemoved
      ? `  ✓ Uninstalled the background service\n`
      : `  – No background service was installed\n`,
  );
  io.out(
    res.keysWiped ? `  ✓ Wiped the API-key store\n` : `  – No API-key store to wipe\n`,
  );
  if (res.notesTrashedTo) {
    io.out(`  ✓ Notes moved to ${res.notesTrashedTo}  (delete that dir to finalise)\n`);
  }
  io.out("\nRestart your editor(s) so they pick up the changes.\n");
}

/** v0.2.34 — non-interactive usage shown by the TTY guard. */
const RESET_USAGE =
  "For non-interactive use (AI agents / CI):\n" +
  "  krimto reset --yes                            Disconnect everything (notes preserved)\n" +
  "  krimto reset --yes --wipe-notes               Also MOVE notes to a trash sibling";
