// `krimto uninit` — the inverse of `init`. Removes the marker-delimited rule block from each
// agent rules file. If removing the block leaves the file empty, the file is deleted (so a file
// that was created by `init` is fully reversed). Pre-existing content around the block is kept.

import { promises as fs } from "node:fs";
import * as path from "node:path";

import { removeRule } from "../agentRule";
import { INIT_TARGETS } from "./init";

export interface UninitResult {
  /** Relative paths where the rule block was removed (file rewritten OR deleted). */
  cleaned: string[];
  /** Relative paths that were deleted entirely (the rule was their only content). */
  deleted: string[];
}

/** Strip the Krimto rule from every target file under `cwd`. Idempotent + non-destructive. */
export async function runUninit(cwd: string, targets: string[] = INIT_TARGETS): Promise<UninitResult> {
  const cleaned: string[] = [];
  const deleted: string[] = [];
  for (const rel of targets) {
    const file = path.join(cwd, rel);
    let existing: string | null = null;
    try {
      existing = await fs.readFile(file, "utf8");
    } catch {
      continue; // file doesn't exist — nothing to remove
    }
    const next = removeRule(existing);
    if (next === existing) continue; // no marker block present — nothing to do
    if (next === null) {
      await fs.unlink(file);
      cleaned.push(rel);
      deleted.push(rel);
    } else {
      await fs.writeFile(file, next, "utf8");
      cleaned.push(rel);
    }
  }
  return { cleaned, deleted };
}
