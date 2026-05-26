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
