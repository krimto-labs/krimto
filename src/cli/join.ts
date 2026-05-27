// `krimto join --server <url> --key <key>` — the teammate-side entry point for v0.2.17.1.
//
// What it does: detects which editors are present in the current project, writes an HTTP-transport
// MCP-config entry into each (pointing at the admin's server, with the bearer header), and
// applies the standing rule. Reuses Phase A's `writeMcpConfig` (idempotent per-editor merge) and
// the rule-writing primitive from `src/agentRule.ts`.
//
// Unlike `krimto init`, this flow has no five-question wizard — the admin already made the
// choices on their side, and the teammate's job is to apply them. A single optional prompt asks
// which detected editors to wire (default: all detected); `--editors` flag skips it.

import { checkbox } from "@inquirer/prompts";
import { promises as fs } from "node:fs";
import * as path from "node:path";

import { applyRule } from "../agentRule";
import { type KrimtoMcpEntry } from "../server/connect";
import {
  detectEditorEnvironments,
  type EditorEnvironment,
  type EditorKind,
} from "./init";
import { writeMcpConfig, type WriteAction } from "./mcpConfig";
import { defaultIO, isExitPrompt, type WizardIO } from "./promptHelpers";

const EDITOR_LABEL: Record<EditorKind, string> = {
  cursor: "Cursor",
  "claude-code": "Claude Code",
  codex: "Codex",
  "gemini-cli": "Gemini CLI",
};

export interface JoinArgs {
  /** Base URL of the team's Krimto server (e.g. `http://maria-mbp:8080` or with `/mcp`). */
  server: string;
  /** The plaintext API key issued by `krimto team init` and DM'd to this teammate. */
  key: string;
}

export interface JoinOptions {
  io?: WizardIO;
  /** Override `process.cwd()`. */
  cwd?: string;
  /** Override `os.homedir()` so tests don't touch the host's real config. */
  homeDir?: string;
  /** Skip CLI invocations (Claude Code) and snippet-only outputs — tests use this. */
  dryRun?: boolean;
  /** Explicit editor list (skips the prompt). */
  editors?: EditorKind[];
}

export interface JoinEditorOutcome {
  editor: EditorKind;
  mcpAction: WriteAction;
  ruleWritten: boolean;
  rulePath: string;
  manualSnippet?: string;
}

export interface JoinResult {
  /** The normalized URL the wizard wrote into each editor's MCP config (always ends in `/mcp`). */
  url: string;
  /** Editor outcomes — one row per editor the wizard tried to wire. */
  editorOutcomes: JoinEditorOutcome[];
}

const KEY_RE = /^krm_(live|test)_[A-Za-z0-9]{32}$/;

/** Normalize the `--server` value into the canonical `<base>/mcp` URL used by the MCP entry. */
export function normalizeServerUrl(raw: string): string {
  let url = raw.trim();
  if (!/^https?:\/\//.test(url)) url = `http://${url}`;
  url = url.replace(/\/+$/, "");
  if (!url.endsWith("/mcp")) url = `${url}/mcp`;
  return url;
}

/**
 * Pure apply step — no prompts. Tests call this directly with `dryRun: true` so claude-code's
 * CLI invocation doesn't touch the runner's real Claude Code config.
 */
export async function applyJoin(
  args: JoinArgs,
  opts: JoinOptions = {},
): Promise<JoinResult> {
  if (!KEY_RE.test(args.key)) {
    throw new Error(
      `That key doesn't look like one Krimto issued (expected "krm_live_..." or "krm_test_...").`,
    );
  }
  const url = normalizeServerUrl(args.server);
  const cwd = opts.cwd ?? process.cwd();
  const homeDir = opts.homeDir;
  const envs = await detectEditorEnvironments(cwd, homeDir);
  const selected = (opts.editors ?? envs.filter((e) => e.present).map((e) => e.editor)).filter(
    (kind) => envs.some((e) => e.editor === kind),
  );

  const entry: KrimtoMcpEntry = {
    transport: "http",
    url,
    headers: { Authorization: `Bearer ${args.key}` },
  };

  const outcomes: JoinEditorOutcome[] = [];
  for (const editor of selected) {
    const env = envs.find((e) => e.editor === editor)!;
    const mcpResult = await writeMcpConfig(env, entry, { dryRun: opts.dryRun });
    const rulePath = path.join(cwd, env.rulesPath);
    const existing = await readMaybe(rulePath);
    const nextRule = applyRule(existing);
    let ruleWritten = false;
    if (nextRule !== existing) {
      await fs.mkdir(path.dirname(rulePath), { recursive: true });
      await fs.writeFile(rulePath, nextRule, "utf8");
      ruleWritten = true;
    }
    outcomes.push({
      editor: env.editor,
      mcpAction: mcpResult.action,
      ruleWritten,
      rulePath: env.rulesPath,
      manualSnippet: mcpResult.snippet,
    });
  }

  return { url, editorOutcomes: outcomes };
}

/**
 * Interactive teammate-side entry point. If `opts.editors` isn't given and multiple editors are
 * detected, asks which ones to wire. Then calls {@link applyJoin}.
 */
export async function runJoin(args: JoinArgs, opts: JoinOptions = {}): Promise<JoinResult | null> {
  const io = opts.io ?? defaultIO;
  try {
    io.out("\nKrimto — Joining team server\n\n");
    io.out(`  Server: ${normalizeServerUrl(args.server)}\n`);
    io.out("  Detecting your editors...\n");

    const cwd = opts.cwd ?? process.cwd();
    const envs = await detectEditorEnvironments(cwd, opts.homeDir);
    const detected = envs.filter((e) => e.present);
    if (detected.length === 0) {
      io.err(
        "\nNo supported editors detected in this project. " +
          "Run `krimto join` from inside a project that has CLAUDE.md / .cursor / etc.\n",
      );
      return null;
    }

    let editors: EditorKind[];
    if (opts.editors) {
      editors = opts.editors;
    } else if (detected.length === 1) {
      editors = detected.map((e) => e.editor);
      io.out(`  Will wire: ${EDITOR_LABEL[editors[0]!]}\n\n`);
    } else {
      editors = await askEditors(envs);
    }

    io.out("Applying...\n");
    const result = await applyJoin(args, { ...opts, editors });
    printApplyResult(result, io);
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

async function askEditors(envs: EditorEnvironment[]): Promise<EditorKind[]> {
  return checkbox<EditorKind>({
    message: "Which editors should connect to the team server?",
    choices: envs.map((env) => ({
      value: env.editor,
      name: EDITOR_LABEL[env.editor],
      description: env.present
        ? "detected in this project"
        : env.installed
          ? "installed on this machine (not in this project yet)"
          : env.mcpWire === null
            ? "not detected — manual snippet only"
            : "not detected — toggle on if you want anyway",
      // v0.2.21: preselect on either signal — installed-on-machine still counts.
      checked: env.present || env.installed,
    })),
  });
}

async function readMaybe(p: string): Promise<string | null> {
  try {
    return await fs.readFile(p, "utf8");
  } catch {
    return null;
  }
}

function printApplyResult(res: JoinResult, io: WizardIO): void {
  for (const o of res.editorOutcomes) {
    const label = EDITOR_LABEL[o.editor];
    if (o.mcpAction === "manual") {
      io.out(`  ! ${label}: manual MCP wiring required (snippet shown below)\n`);
    } else if (o.mcpAction === "no-change") {
      io.out(`  ✓ ${label}: already connected to this server\n`);
    } else {
      io.out(`  ✓ ${label}: MCP config + standing rule applied\n`);
    }
  }

  io.out("\n✅ Joined. Restart your editor so it loads the new rule.\n\n");
  io.out("━━ Try it now ━━\n\n");
  io.out("  In a chat, say:\n");
  io.out("     \"Remember our package manager is pnpm.\"\n\n");
  io.out("  Then open a new chat and ask:\n");
  io.out("     \"What do we use?\"\n\n");
  io.out("━━ What's next ━━\n\n");
  io.out("  $ krimto notes     See team notes you can read\n");
  io.out("  $ krimto status    Verify the connection\n\n");

  // Print manual snippets (if any) so editors without auto-wiring still get an actionable
  // copy-paste path.
  const manuals = res.editorOutcomes.filter((o) => o.mcpAction === "manual" && o.manualSnippet);
  for (const m of manuals) {
    io.out(`Manual snippet for ${EDITOR_LABEL[m.editor]} — paste into the editor's MCP config:\n`);
    io.out(m.manualSnippet + "\n\n");
  }
}
