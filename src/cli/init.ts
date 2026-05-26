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

  // CLAUDE.md — Claude Code. `.specstory/` is Claude Code's SpecStory transcript directory and
  // is a reliable "this project has been used with Claude Code" signal even when no CLAUDE.md
  // exists yet (added to fix the smoke-5 false-negative where `.cursor/` existed but the user
  // was actually using Claude Code).
  if (
    (await exists(path.join(cwd, "CLAUDE.md"))) ||
    (await exists(path.join(cwd, ".claude"))) ||
    (await exists(path.join(cwd, ".claude-plugin"))) ||
    (await exists(path.join(cwd, ".specstory")))
  ) {
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
  /** Force writing all four files (the v0.2.16+ default — opt out via `minimal: true`). */
  all?: boolean;
  /**
   * Opt in to "write only files for editors actually present in this project" behavior. Default
   * since v0.2.16 is "write all four" to avoid silent failures when detection misses the active
   * editor (e.g. `.cursor/` exists from an earlier session but the user has switched to Claude Code).
   */
  minimal?: boolean;
  /** Override the target list directly (tests; takes precedence over flags). */
  targets?: string[];
}

/** Write/refresh the Krimto standing rule into each target rules file under `cwd`, idempotently. */
export async function runInit(cwd: string, opts: RunInitOptions = {}): Promise<InitResult> {
  let targets: string[];
  let detected = false;
  if (opts.targets) {
    targets = opts.targets;
  } else if (opts.minimal) {
    const auto = await detectEditorTargets(cwd);
    if (auto.length > 0) {
      targets = auto;
      detected = true;
    } else {
      // `--minimal` but nothing matched → still need to write something. Fall back to all four.
      targets = INIT_TARGETS;
    }
  } else {
    // v0.2.16+ default: write to all supported editors. `--all` is now redundant but kept for
    // backwards compatibility with users who scripted it.
    targets = INIT_TARGETS;
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
