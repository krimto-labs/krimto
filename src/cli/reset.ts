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
  detectExistingSetup,
  type EditorEnvironment,
  type EditorKind,
} from "./init";
import { removeMcpConfig } from "./mcpConfig";
import { defaultIO, isExitPrompt, type WizardIO } from "./promptHelpers";
import {
  detectPlatform,
  isServiceInstalled,
  uninstallService,
} from "./service";

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

  // 1. Disconnect every detected editor.
  const envs = await detectEditorEnvironments(cwd, homeDir);
  const snapshot = await detectExistingSetup(cwd, homeDir);
  const editorsDisconnected: EditorKind[] = [];
  for (const env of envs) {
    if (!snapshot.registeredEditors.includes(env.editor)) continue;
    const res = await removeMcpConfig(env);
    if (res.removed) editorsDisconnected.push(env.editor);
  }

  // 2. Strip the standing rule from each detected rule file in CWD.
  const rulesStripped: string[] = [];
  for (const env of envs) {
    const stripped = await stripRule(cwd, env);
    if (stripped) rulesStripped.push(env.rulesPath);
  }

  // 3. Uninstall the background service if installed.
  const platform = detectPlatform();
  const current = await isServiceInstalled(platform, homeDir);
  let serviceRemoved = false;
  if (current.installed) {
    const res = await uninstallService({ dryRun: opts.dryRun, platform, homeDir });
    serviceRemoved = res.removed;
  }

  // 4. Wipe the keys store (best-effort — file may not exist).
  const keysPath = path.join(dataDir, ".krimto", "keys.json");
  let keysWiped = false;
  try {
    await fs.unlink(keysPath);
    keysWiped = true;
  } catch {
    /* no keys file — fine */
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
  try {
    const dataDir = opts.dataDir ?? path.join(opts.homeDir ?? "", ".krimto");

    io.out("\nKrimto — Reset machine-level config\n\n");
    io.out("  This will:\n");
    io.out("    • Disconnect Krimto from all editors (MCP config + standing rule)\n");
    io.out("    • Stop and uninstall the background service (if installed)\n");
    io.out("    • Wipe the local API-key store\n\n");
    io.out("  This will NOT touch:\n");
    io.out(`    • Your notes folder (${dataDir}) — unless you pass --wipe-notes\n`);
    io.out("    • The team's git history or members.yaml\n\n");

    const ok = opts.yes ?? (await confirm({ message: "Proceed with reset?", default: false }));
    if (!ok) {
      io.out("\nNo changes made.\n");
      return null;
    }

    // The --wipe-notes path needs its OWN confirmation — the default reset is reversible
    // (just re-run `krimto init`), but wiping notes is data loss.
    if (opts.wipeNotes && !opts.yes) {
      io.out(
        `\n⚠️  --wipe-notes will MOVE ${dataDir} to a timestamped trash sibling.\n` +
          `   The notes stay on disk (recoverable) until you delete the trash dir manually.\n`,
      );
      const wipeOk = await confirm({
        message: `Confirm: also move ${dataDir} to ${dataDir}.trash-<ts>?`,
        default: false,
      });
      if (!wipeOk) {
        io.out("\n(Reset proceeding without --wipe-notes — notes preserved.)\n");
        opts = { ...opts, wipeNotes: false };
      }
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
