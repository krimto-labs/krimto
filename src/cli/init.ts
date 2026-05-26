// `krimto init` — drop the always-use-Krimto standing rule into a project's agent rules files so the
// agent actually uses Krimto (fix for the discovery problem). Idempotent and non-destructive: it only
// adds/refreshes a marker-delimited block, never clobbering other content (see ../agentRule).
//
// G4 — by default, init now auto-detects which editor is in use (`.cursor/`, `.claude/`, existing
// CLAUDE.md / AGENTS.md / GEMINI.md, etc.) and writes ONLY matching files instead of all four. If
// no signals are present, it falls back to writing all four so a brand-new project still picks up
// the rule for whichever editor ships next. `--all` keeps the legacy "write everything" behavior.

import { promises as fs } from "node:fs";
import * as path from "node:path";

import { applyRule } from "../agentRule";

/** The agent rules files `krimto init` targets, relative to the project dir. */
export const INIT_TARGETS = [
  "CLAUDE.md",
  "AGENTS.md",
  "GEMINI.md",
  path.join(".cursor", "rules", "krimto.mdc"),
];

export interface InitResult {
  /** Relative paths that were created or updated (empty when everything was already current). */
  written: string[];
  /** Targets considered (after detection/--all decisions). Exposed for the CLI's success message. */
  considered: string[];
  /** True when targets came from auto-detection (some editor signals matched). */
  detected: boolean;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Auto-detect which editor rules files the project should get based on local signals.
 * Returns the subset of INIT_TARGETS that has a positive signal, OR an empty array when
 * nothing matches (caller falls back to writing everything).
 */
export async function detectEditorTargets(cwd: string): Promise<string[]> {
  const matches: string[] = [];

  // CLAUDE.md — Claude Code
  if ((await exists(path.join(cwd, "CLAUDE.md"))) || (await exists(path.join(cwd, ".claude"))) || (await exists(path.join(cwd, ".claude-plugin")))) {
    matches.push("CLAUDE.md");
  }
  // AGENTS.md — Codex CLI / generic
  if (await exists(path.join(cwd, "AGENTS.md"))) {
    matches.push("AGENTS.md");
  }
  // GEMINI.md — Gemini CLI
  if ((await exists(path.join(cwd, "GEMINI.md"))) || (await exists(path.join(cwd, "gemini-extension.json"))) || (await exists(path.join(cwd, ".gemini")))) {
    matches.push("GEMINI.md");
  }
  // .cursor/rules/krimto.mdc — Cursor
  if (await exists(path.join(cwd, ".cursor"))) {
    matches.push(path.join(".cursor", "rules", "krimto.mdc"));
  }

  return matches;
}

export interface RunInitOptions {
  /** Force writing all four files regardless of detection (the legacy behavior). */
  all?: boolean;
  /** Override the target list directly (tests; takes precedence over `all` + detection). */
  targets?: string[];
}

/** Write/refresh the Krimto standing rule into each target rules file under `cwd`, idempotently. */
export async function runInit(cwd: string, opts: RunInitOptions = {}): Promise<InitResult> {
  let targets: string[];
  let detected = false;
  if (opts.targets) {
    targets = opts.targets;
  } else if (opts.all) {
    targets = INIT_TARGETS;
  } else {
    const auto = await detectEditorTargets(cwd);
    if (auto.length > 0) {
      targets = auto;
      detected = true;
    } else {
      targets = INIT_TARGETS;
    }
  }

  const written: string[] = [];
  for (const rel of targets) {
    const file = path.join(cwd, rel);
    let existing: string | null = null;
    try {
      existing = await fs.readFile(file, "utf8");
    } catch {
      existing = null; // file doesn't exist yet — we'll create it
    }
    const next = applyRule(existing);
    if (next === existing) continue; // already up to date
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, next, "utf8");
    written.push(rel);
  }
  return { written, considered: targets, detected };
}
