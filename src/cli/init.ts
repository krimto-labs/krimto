// `krimto init` — drop the always-use-Krimto standing rule into a project's agent rules files so the
// agent actually uses Krimto (fix for the discovery problem). Idempotent and non-destructive: it only
// adds/refreshes a marker-delimited block, never clobbering other content (see ../agentRule).

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
}

/** Write/refresh the Krimto standing rule into each target rules file under `cwd`, idempotently. */
export async function runInit(cwd: string, targets: string[] = INIT_TARGETS): Promise<InitResult> {
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
  return { written };
}
