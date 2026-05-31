// `krimto set identity <email>` — change KRIMTO_IDENTITY everywhere the wizard wrote it.
//
// Surfaces touched (in order):
//   1. Each registered editor's MCP config — for JSON-method editors, mutate
//      `env.KRIMTO_IDENTITY` in place (other env keys like KRIMTO_EMBED_* are preserved).
//      For CLI-method editors (Claude Code), rebuild a fresh stdio entry via writeMcpConfig
//      (extra env keys are lost — known limitation noted below).
//   2. The always-running service (launchd/systemd/schtasks) — uninstall + reinstall with
//      the new env. Same dataDir + port as before, mirroring serviceCmd.applyService.
//
// HTTP-transport MCP entries don't carry identity (it lives in the service env); they are
// left untouched.
//
// Existing notes do NOT migrate. The folder for the old identity stays under
// `~/.krimto/user/<old-email>/` — moving them is intentionally a separate step (would need
// a git rename + reindex; out of scope for this command).

import { confirm } from "@inquirer/prompts";
import { promises as fs } from "node:fs";
import * as path from "node:path";

import { stdioMcpEntry, type KrimtoMcpEntry } from "../server/connect";
import {
  detectEditorEnvironments,
  detectExistingSetup,
  type EditorEnvironment,
  type EditorKind,
} from "./init";
import { writeMcpConfig } from "./mcpConfig";
import {
  detectPlatform,
  installService,
  isServiceInstalled,
  uninstallService,
} from "./service";
import { assertInteractiveOrUsage, defaultIO, isExitPrompt, type WizardIO } from "./promptHelpers";
import { runWhoami } from "./whoami";

const EDITOR_LABEL: Record<EditorKind, string> = {
  cursor: "Cursor",
  "claude-code": "Claude Code",
  codex: "Codex",
  "gemini-cli": "Gemini CLI",
};

// Same permissive shape used by defaultIdentity() — accepts anything that looks like name@host.
const EMAIL_REGEX = /^[^@\s]+@[^@\s]+$/;

/** batch 5 — non-interactive usage shown by the TTY guard (mirrors the Phase B commands). */
const SET_IDENTITY_USAGE =
  "For non-interactive use (AI agents / CI):\n" +
  "  krimto set identity <email> --yes            Apply the identity change without a prompt";

export interface SetIdentityOptions {
  identity: string;
  io?: WizardIO;
  cwd?: string;
  homeDir?: string;
  dataDir?: string;
  /** Skip the confirmation prompt (CI / scripted runs). */
  yes?: boolean;
  /** Forwarded to install/uninstallService for tests. */
  dryRun?: boolean;
}

export interface SetIdentityResult {
  status: "ok" | "no-change" | "error";
  message: string;
  updatedEditors: EditorKind[];
  serviceUpdated: boolean;
}

export async function runSetIdentity(opts: SetIdentityOptions): Promise<SetIdentityResult> {
  const io = opts.io ?? defaultIO;
  const cwd = opts.cwd ?? process.cwd();

  if (!EMAIL_REGEX.test(opts.identity)) {
    return {
      status: "error",
      message:
        `\n❌ Not a valid email: "${opts.identity}"\n` +
        `   Expected something like name@example.com\n\n`,
      updatedEditors: [],
      serviceUpdated: false,
    };
  }

  const current = await runWhoami({ cwd, homeDir: opts.homeDir });
  const snapshot = await detectExistingSetup(cwd, opts.homeDir);

  if (!snapshot.configured) {
    return {
      status: "error",
      message: "\n❌ Krimto isn't set up here yet. Run `krimto init` first.\n\n",
      updatedEditors: [],
      serviceUpdated: false,
    };
  }

  if (current.activeIdentity === opts.identity && !current.mismatch) {
    return {
      status: "no-change",
      message: `\nNo change — identity is already ${opts.identity}.\n\n`,
      updatedEditors: [],
      serviceUpdated: false,
    };
  }

  if (!opts.yes) {
    assertInteractiveOrUsage(SET_IDENTITY_USAGE); // batch 5 — non-TTY agent gets usage+exit 2, not an abort
    io.out("\nKrimto — Set identity\n\n");
    io.out(`  Current identity: ${current.activeIdentity}\n`);
    io.out(`  New identity:     ${opts.identity}\n\n`);
    io.out("  Will update:\n");
    for (const e of snapshot.registeredEditors) {
      io.out(`    • ${EDITOR_LABEL[e]} MCP config\n`);
    }
    if (snapshot.runMode === "always-running") {
      io.out("    • Background service (launchd/systemd/schtasks)\n");
    }
    io.out("\n  ⚠️  Existing notes will NOT move — they stay under\n");
    io.out(`     ~/.krimto/user/${current.activeIdentity}/\n`);
    io.out(`     New facts will go to ~/.krimto/user/${opts.identity}/\n\n`);
    try {
      const ok = await confirm({ message: "Apply this change?", default: true });
      if (!ok) {
        return {
          status: "no-change",
          message: "\nAborted. No changes were made.\n\n",
          updatedEditors: [],
          serviceUpdated: false,
        };
      }
    } catch (e) {
      if (isExitPrompt(e)) {
        return {
          status: "no-change",
          message: "\nAborted. No changes were made.\n\n",
          updatedEditors: [],
          serviceUpdated: false,
        };
      }
      throw e;
    }
  }

  const envs = await detectEditorEnvironments(cwd, opts.homeDir);
  const updatedEditors: EditorKind[] = [];
  for (const env of envs) {
    if (!snapshot.registeredEditors.includes(env.editor)) continue;
    const ok = await updateEditorIdentity(env, opts.identity);
    if (ok) updatedEditors.push(env.editor);
  }

  let serviceUpdated = false;
  const platform = detectPlatform();
  const service = await isServiceInstalled(platform, opts.homeDir);
  if (service.installed) {
    const dataDir = opts.dataDir ?? path.join(opts.homeDir ?? "", ".krimto");
    await uninstallService({ platform, homeDir: opts.homeDir, dryRun: opts.dryRun });
    await installService(
      {
        binPath: process.execPath,
        args: [process.argv[1] ?? "krimto", "serve"],
        env: { KRIMTO_IDENTITY: opts.identity, KRIMTO_DATA: dataDir, KRIMTO_HTTP_PORT: "8080" },
        homeDir: opts.homeDir,
      },
      { dryRun: opts.dryRun, platform },
    );
    serviceUpdated = true;
  }

  const lines: string[] = ["", `✅ Identity changed → ${opts.identity}`, ""];
  for (const e of updatedEditors) {
    lines.push(`   • Updated ${EDITOR_LABEL[e]} MCP config`);
  }
  if (serviceUpdated) lines.push("   • Restarted background service");
  if (updatedEditors.length === 0 && !serviceUpdated) {
    lines.push("   (Nothing to update — no editors registered + no service installed)");
  }
  lines.push("");
  lines.push("Restart your editor(s) so they pick up the new identity.");
  lines.push("");
  lines.push(`New facts → ~/.krimto/user/${opts.identity}/`);
  lines.push(`Old facts stay at ~/.krimto/user/${current.activeIdentity}/`);
  lines.push("");

  return {
    status: "ok",
    message: lines.join("\n"),
    updatedEditors,
    serviceUpdated,
  };
}

/**
 * Update KRIMTO_IDENTITY in this editor's MCP entry.
 *  • JSON method: surgical mutation preserves any other env keys (KRIMTO_EMBED_*).
 *  • CLI method (Claude Code): rebuild + re-add via writeMcpConfig. Extra env keys are lost.
 *  • HTTP entry (url-based): no-op — identity lives in the service env.
 *  • mcpWire === null: no automated wiring; skip silently.
 */
async function updateEditorIdentity(env: EditorEnvironment, identity: string): Promise<boolean> {
  if (env.mcpWire === null) return false;
  if (env.mcpWire.method === "json") {
    return updateIdentityInJson(env.mcpWire.path, env.mcpWire.key, identity);
  }
  const entry: KrimtoMcpEntry = { transport: "stdio", ...stdioMcpEntry({ identity }) };
  await writeMcpConfig(env, entry);
  return true;
}

async function updateIdentityInJson(
  filePath: string,
  key: string,
  identity: string,
): Promise<boolean> {
  let text: string;
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch {
    return false;
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return false;
  }
  const servers = parsed[key] as Record<string, unknown> | undefined;
  if (!servers || !("krimto" in servers)) return false;
  const krimto = servers.krimto as { env?: Record<string, string>; url?: string };
  if (krimto.url) return false;
  const nextEnv = { ...(krimto.env ?? {}), KRIMTO_IDENTITY: identity };
  (servers.krimto as { env: Record<string, string> }).env = nextEnv;
  await fs.writeFile(filePath, JSON.stringify(parsed, null, 2) + "\n", "utf8");
  return true;
}
