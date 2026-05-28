// `krimto team disband` — the per-machine step-back from team mode to solo. Scope is narrow on
// purpose: it reverts the MCP-transport in each editor's config from HTTP (team) back to stdio
// (solo) and leaves everything else alone.
//
// What it DOES NOT do:
//   • Remove members.yaml or the org's keys — those belong to the data dir (which is also a git
//     repo) and may be shared with teammates. Editing them is the admin's job, via `/ui/admin`.
//   • Delete any notes. Data is preserved unconditionally.
//   • Stop a running server. That's `launchctl bootout` / `systemctl --user stop` / Ctrl-C —
//     and on solo machines is usually not needed (stdio Krimto runs on demand).
//
// A future Phase-B `krimto reset --wipe-team-state` will handle the heavier "scrub everything"
// reversal. Until then, this command is the right tool for "I tried team mode, want to go back."

import { confirm } from "@inquirer/prompts";

import { isOrgAdmin, loadMembership } from "../access/membership";
import { stdioMcpEntry, type KrimtoMcpEntry } from "../server/connect";
import { detectEditorEnvironments, defaultIdentity, type EditorKind } from "./init";
import { readMcpConfig, writeMcpConfig, type WriteAction } from "./mcpConfig";
import { defaultIO, isExitPrompt, type WizardIO } from "./promptHelpers";

const EDITOR_LABEL: Record<EditorKind, string> = {
  cursor: "Cursor",
  "claude-code": "Claude Code",
  codex: "Codex",
  "gemini-cli": "Gemini CLI",
};

export interface DisbandOptions {
  io?: WizardIO;
  cwd?: string;
  homeDir?: string;
  /** Data dir — used to read members.yaml so we can tell "I host this team" from "I joined one". */
  dataDir?: string;
  /** Skip the confirmation prompt — used by `--yes` and by tests. */
  yes?: boolean;
  /** Forwarded to `writeMcpConfig` for the CLI-method editors. */
  dryRun?: boolean;
  /** Reframes the messaging for `krimto team leave` (a teammate leaving someone else's team). */
  asLeave?: boolean;
}

export interface DisbandEditorOutcome {
  editor: EditorKind;
  /** True when this editor was found to have an HTTP/team MCP entry. */
  wasTeam: boolean;
  /** What `writeMcpConfig` returned (or "no-change" when the entry was already stdio). */
  mcpAction: WriteAction | "no-change";
}

export interface DisbandResult {
  /** Per-editor outcome. Empty when there were no Krimto MCP entries at all. */
  editorOutcomes: DisbandEditorOutcome[];
  /** Identity baked into the new stdio entries. */
  identity: string;
  /** The team server URL we disconnected from (for the reconnect hint), or null if none found. */
  serverUrl: string | null;
  /** True when this machine's identity is a team admin (it hosts/owns the team). */
  isAdmin: boolean;
}

/**
 * Pure apply step. Walks every supported editor, finds the ones with a team-mode (HTTP) Krimto
 * entry, and rewrites them as stdio entries with the same identity. Editors without a Krimto
 * entry are skipped; editors already on stdio are reported as `no-change`.
 */
export async function applyTeamDisband(opts: DisbandOptions = {}): Promise<DisbandResult> {
  const cwd = opts.cwd ?? process.cwd();
  const envs = await detectEditorEnvironments(cwd, opts.homeDir);
  const identity = await defaultIdentity();

  let serverUrl: string | null = null;
  const outcomes: DisbandEditorOutcome[] = [];
  for (const env of envs) {
    if (env.mcpWire?.method !== "json") continue; // we only rewrite editors with a JSON config
    const existing = await readMcpConfig(env);
    if (!existing || !existing.krimtoPresent) continue;
    const servers = existing.raw[env.mcpWire.key] as Record<string, unknown> | undefined;
    const krimto = servers?.krimto as { url?: string; command?: string } | undefined;
    const wasTeam = typeof krimto?.url === "string"; // HTTP entries carry `url`, stdio entries carry `command`

    if (!wasTeam) {
      outcomes.push({ editor: env.editor, wasTeam: false, mcpAction: "no-change" });
      continue;
    }
    if (!serverUrl && typeof krimto?.url === "string") serverUrl = krimto.url; // remember it for the reconnect hint

    const entry: KrimtoMcpEntry = { transport: "stdio", ...stdioMcpEntry({ identity }) };
    const res = await writeMcpConfig(env, entry, { dryRun: opts.dryRun });
    outcomes.push({ editor: env.editor, wasTeam: true, mcpAction: res.action });
  }

  // Best-effort host-vs-joined detection: am I an admin in the roster? (needs the data dir).
  let isAdmin = false;
  if (opts.dataDir) {
    isAdmin = isOrgAdmin(await loadMembership(opts.dataDir), identity);
  }

  return { editorOutcomes: outcomes, identity, serverUrl, isAdmin };
}

/** Interactive entry point. Confirms first, then calls {@link applyTeamDisband}. */
export async function runTeamDisband(opts: DisbandOptions = {}): Promise<DisbandResult | null> {
  const io = opts.io ?? defaultIO;
  const verb = opts.asLeave ? "team leave" : "team disband";

  // Non-TTY guard (v0.2.40): the confirm below can't be answered from an AI-agent shell, so it
  // would hang. When there's no TTY and no --yes, print the flag form and bail. We RETURN null
  // (not process.exit) so callers/tests can handle it; the bin maps null → a non-zero exit code.
  if (!opts.yes && process.stdin.isTTY !== true) {
    io.err(
      `\nℹ️  No interactive terminal detected — re-run with --yes to confirm.\n\n` +
        `    krimto ${verb} --yes\n\n` +
        `This only changes THIS machine (MCP config back to stdio). Your notes, members.yaml,\n` +
        `API keys, and any running server are untouched.\n`,
    );
    return null;
  }

  try {
    io.out("\nKrimto — Stepping back to solo mode\n\n");
    io.out("  This rewrites each editor's MCP config to launch Krimto on-demand (stdio),\n");
    io.out("  instead of talking to your team's HTTP server.\n");
    io.out("\n  What stays untouched:\n");
    io.out("    • Your notes (folder + git history)\n");
    io.out("    • members.yaml, API keys, the team's git remote\n");
    io.out("    • Any running Krimto server (stop it yourself if needed)\n\n");

    const ok = opts.yes ?? (await confirm({ message: "Proceed?", default: false }));
    if (!ok) {
      io.out("\nNo changes made.\n");
      return null;
    }

    const result = await applyTeamDisband(opts);
    printApplyResult(result, io, opts.asLeave ?? false);
    return result;
  } catch (e) {
    if (isExitPrompt(e)) {
      io.err("\nAborted (Ctrl-C). No changes were made.\n");
      process.exitCode = 130;
      return null;
    }
    throw e;
  }
}

function printApplyResult(res: DisbandResult, io: WizardIO, asLeave: boolean): void {
  const switched = res.editorOutcomes.filter((o) => o.wasTeam);
  const untouched = res.editorOutcomes.filter((o) => !o.wasTeam);

  if (switched.length === 0 && untouched.length === 0) {
    io.out("\nNo Krimto MCP entries found in any editor on this machine.\n");
    io.out(`(Krimto might still work via \`claude mcp\` / a CLI we don't manage here.)\n`);
    if (asLeave) io.out("\nIf you're in a team's roster, ask the admin to remove you to fully leave.\n");
    io.out("\n");
    return;
  }

  if (switched.length > 0) {
    io.out("\n✅ Switched back to solo mode:\n");
    for (const o of switched) {
      io.out(`  ✓ ${EDITOR_LABEL[o.editor]}: HTTP entry rewritten as stdio (identity ${res.identity})\n`);
    }
  }
  if (untouched.length > 0) {
    io.out("\nAlready solo (no change needed):\n");
    for (const o of untouched) io.out(`  – ${EDITOR_LABEL[o.editor]}\n`);
  }
  io.out("\nRestart your editor so it picks up the new MCP entry.\n");

  // The crucial clarification: this is PER-MACHINE, not team-wide.
  io.out("\n  This only changed THIS machine. The team is unaffected — members.yaml, the API keys,\n");
  io.out("  and the running server all stay as they are; your teammates keep their access.\n");
  if (res.serverUrl) {
    io.out(`\n  Reconnect any time:\n    krimto join --server ${res.serverUrl} --key <your-key>\n`);
    io.out("  (your key is in your invite file — or ask the admin for a fresh one)\n");
  }
  if (res.isAdmin && !asLeave) {
    io.out("\n  You're the team admin: the team server keeps running. `krimto stop` takes it down for EVERYONE.\n");
  }
  if (asLeave) {
    io.out("\n  You're still in the team's roster — ask the admin to remove you (/ui/admin) to fully leave.\n");
  }
  io.out("\n");
}
