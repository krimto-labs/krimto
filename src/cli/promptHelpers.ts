// Tiny helpers shared by every interactive wizard (`init`, `team init`, `join`, `team disband`).
// Kept in a single file so the wizard surfaces share one I/O contract and one Ctrl-C detection
// rule — adding a future wizard means re-using this, not re-implementing it.

export interface WizardIO {
  /** stdout writer. Tests inject a buffer; production uses `process.stdout.write`. */
  out: (s: string) => void;
  /** stderr writer. */
  err: (s: string) => void;
}

export const defaultIO: WizardIO = {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
};

/**
 * Detect a Ctrl-C abort from `@inquirer/prompts`. The library throws `ExitPromptError` (from
 * `@inquirer/core`) but doesn't re-export it from the top-level `prompts` package — we sniff by
 * the error's `name` field, which the class sets explicitly. Stable across @inquirer versions.
 */
export function isExitPrompt(e: unknown): boolean {
  return e instanceof Error && e.name === "ExitPromptError";
}

/**
 * v0.2.34 — guard for the Phase B commands (`editors`, `service`, `search`, `reset`,
 * `remote`, `folder`) when about to spawn an `@inquirer/prompts` UI. If the process has no
 * TTY on stdin (typical for an AI-agent shell tool), the prompt would hang forever, then
 * Node would surface the cryptic "Detected unsettled top-level await" warning and abort.
 *
 * Instead, we detect the no-TTY case here, print a copy-pasteable usage block, and exit
 * 2 cleanly. The TTY case is a no-op — the interactive wizard runs as before. Each caller
 * supplies its own `usage` text naming the flags an agent should use.
 *
 * NOTE: this is only called BEFORE the first prompt would run. When a flag like
 * `--always` / `--add cursor` / `--keyword` IS passed, the caller skips the prompt entirely
 * and never invokes this — the non-interactive path stays open.
 */
export function assertInteractiveOrUsage(usage: string): void {
  if (process.stdin.isTTY === true) return;
  process.stderr.write(
    "\nℹ️  No interactive terminal detected — this command needs flags for non-interactive use.\n\n" +
      usage +
      "\n\nSee `krimto --help` for the full list.\n",
  );
  process.exit(2);
}
