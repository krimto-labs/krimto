// `krimto editors` — one-question shortcut to add or remove editor connections without going
// through the full 5-question setup wizard. Re-uses Phase A's `writeMcpConfig` + `removeMcpConfig`
// + the rule helpers, plus Phase D's `buildCliContext` only for the lock check (this command
// doesn't touch the SQLite index, so we skip the rest).
//
// Pure apply step lives in `applyEditors`; `runEditors` wraps it with the @inquirer/prompts
// checkbox question.

import { checkbox } from "@inquirer/prompts";
import { promises as fs } from "node:fs";
import * as path from "node:path";

import { applyRule, removeRule } from "../agentRule";
import { stdioMcpEntry, type KrimtoMcpEntry } from "../server/connect";
import {
  defaultIdentity,
  detectEditorEnvironments,
  detectExistingSetup,
  type EditorEnvironment,
  type EditorKind,
} from "./init";
import {
  removeMcpConfig,
  writeMcpConfig,
  type WriteAction,
} from "./mcpConfig";
import { defaultIO, isExitPrompt, type WizardIO } from "./promptHelpers";

const EDITOR_LABEL: Record<EditorKind, string> = {
  cursor: "Cursor",
  "claude-code": "Claude Code",
  codex: "Codex",
  "gemini-cli": "Gemini CLI",
};

export interface EditorsOptions {
  io?: WizardIO;
  cwd?: string;
  homeDir?: string;
  dryRun?: boolean;
  /** Skip the checkbox prompt; pass the new selection directly. */
  editors?: EditorKind[];
}

export interface EditorOutcome {
  editor: EditorKind;
  action: "added" | "removed" | "no-change";
  mcpAction?: WriteAction;
  ruleWritten?: boolean;
}

export interface EditorsResult {
  outcomes: EditorOutcome[];
}

export async function applyEditors(
  selected: EditorKind[],
  opts: EditorsOptions = {},
): Promise<EditorsResult> {
  const cwd = opts.cwd ?? process.cwd();
  const homeDir = opts.homeDir;
  const envs = await detectEditorEnvironments(cwd, homeDir);
  const snapshot = await detectExistingSetup(cwd, homeDir);
  const identity = await defaultIdentity();
  const wanted = new Set<EditorKind>(selected);
  const current = new Set<EditorKind>(snapshot.registeredEditors);

  const outcomes: EditorOutcome[] = [];
  for (const env of envs) {
    const isWanted = wanted.has(env.editor);
    const isCurrent = current.has(env.editor);
    if (isWanted && !isCurrent) {
      // Add: write MCP config + standing rule.
      const entry: KrimtoMcpEntry = { transport: "stdio", ...stdioMcpEntry({ identity }) };
      const mcp = await writeMcpConfig(env, entry, { dryRun: opts.dryRun });
      const ruleWritten = await applyRuleToFile(cwd, env);
      outcomes.push({ editor: env.editor, action: "added", mcpAction: mcp.action, ruleWritten });
    } else if (!isWanted && isCurrent) {
      // Remove: drop MCP entry + strip rule block from project file (if present).
      await removeMcpConfig(env);
      await removeRuleFromFile(cwd, env);
      outcomes.push({ editor: env.editor, action: "removed" });
    } else {
      outcomes.push({ editor: env.editor, action: "no-change" });
    }
  }
  return { outcomes };
}

export async function runEditors(opts: EditorsOptions = {}): Promise<EditorsResult | null> {
  const io = opts.io ?? defaultIO;
  try {
    const cwd = opts.cwd ?? process.cwd();
    const envs = await detectEditorEnvironments(cwd, opts.homeDir);
    const snapshot = await detectExistingSetup(cwd, opts.homeDir);
    io.out("\nKrimto — Editors\n\n");
    io.out(
      `  Currently connected: ${
        snapshot.registeredEditors.map((e) => EDITOR_LABEL[e]).join(", ") || "(none)"
      }\n\n`,
    );
    const selected = opts.editors ?? (await askEditorsList(envs, snapshot.registeredEditors));
    io.out("\nApplying...\n");
    const result = await applyEditors(selected, opts);
    printResult(result, io);
    return result;
  } catch (e) {
    if (isExitPrompt(e)) {
      io.err("\nAborted. No changes were made.\n");
      process.exitCode = 130;
      return null;
    }
    throw e;
  }
}

async function askEditorsList(
  envs: EditorEnvironment[],
  current: EditorKind[],
): Promise<EditorKind[]> {
  return checkbox<EditorKind>({
    message: "Which editors should be connected to Krimto?",
    choices: envs.map((env) => ({
      value: env.editor,
      name: EDITOR_LABEL[env.editor],
      description: current.includes(env.editor)
        ? "currently connected"
        : env.present
          ? "detected in this project"
          : env.installed
            ? "installed on this machine (not in this project yet)"
            : env.mcpWire === null
              ? "not detected — manual snippet only"
              : "not detected — toggle on if you want anyway",
      checked: current.includes(env.editor),
    })),
  });
}

async function applyRuleToFile(cwd: string, env: EditorEnvironment): Promise<boolean> {
  const rulePath = path.join(cwd, env.rulesPath);
  const existing = await readMaybe(rulePath);
  // v0.2.29 — Cursor's .mdc rules need `alwaysApply: true` frontmatter.
  const next = applyRule(existing, { cursorMdc: env.editor === "cursor" });
  if (next === existing) return false;
  await fs.mkdir(path.dirname(rulePath), { recursive: true });
  await fs.writeFile(rulePath, next, "utf8");
  return true;
}

async function removeRuleFromFile(cwd: string, env: EditorEnvironment): Promise<void> {
  const rulePath = path.join(cwd, env.rulesPath);
  const existing = await readMaybe(rulePath);
  if (existing === null) return;
  const next = removeRule(existing);
  if (next === existing) return; // no markers in file — nothing to remove
  if (next === null) {
    await fs.unlink(rulePath).catch(() => undefined);
    return;
  }
  await fs.writeFile(rulePath, next, "utf8");
}

async function readMaybe(p: string): Promise<string | null> {
  try {
    return await fs.readFile(p, "utf8");
  } catch {
    return null;
  }
}

function printResult(res: EditorsResult, io: WizardIO): void {
  const added = res.outcomes.filter((o) => o.action === "added");
  const removed = res.outcomes.filter((o) => o.action === "removed");
  if (added.length === 0 && removed.length === 0) {
    io.out("\nNo changes — your editor list already matches.\n");
    return;
  }
  io.out("\n");
  for (const o of added) io.out(`  + ${EDITOR_LABEL[o.editor]} connected\n`);
  for (const o of removed) io.out(`  − ${EDITOR_LABEL[o.editor]} disconnected\n`);
  io.out("\nRestart your editor(s) so they pick up the change.\n");
}
