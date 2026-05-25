// The standing "always use Krimto" rule, plus idempotent application to an agent's rules file.
// Single source of truth for both the CLI (`krimto init`) and the web connect panel — so the
// rule a user pastes from /ui/connect and the rule `krimto init` writes can never drift.
//
// This is the fix for the discovery problem: by default, an editor's agent routes "remember X" to
// its own built-in memory, not Krimto. Dropping this rule into the agent's rules file makes the
// agent call krimto_recall / krimto_write on its own.

export const AGENT_RULE = `# Krimto memory — always use
- Before a task, call krimto_recall to load what we already know.
- When I say "remember", or you learn a durable fact, call krimto_write
  (user/me = personal, team/<slug> = shared).
- Respect precedence: user beats team beats org.
- Don't save secrets or one-off chatter.`;

const START = "<!-- krimto:start -->";
const END = "<!-- krimto:end -->";

/** The rule wrapped in stable markers, so it can be found and updated in place later. */
export function ruleBlock(): string {
  return `${START}\n${AGENT_RULE}\n${END}`;
}

/**
 * Insert or refresh the Krimto rule block in an agent rules file's content, idempotently:
 * - null/blank existing  → just the block (with a trailing newline)
 * - existing WITHOUT our markers → append the block, preserving all existing content
 * - existing WITH our markers    → replace only the marked block, preserving the rest
 * Re-applying the same rule yields identical content (so callers can detect a no-op).
 */
export function applyRule(existing: string | null): string {
  const block = ruleBlock();
  if (!existing || existing.trim() === "") return `${block}\n`;

  const startIdx = existing.indexOf(START);
  const endIdx = existing.indexOf(END);
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    return existing.slice(0, startIdx) + block + existing.slice(endIdx + END.length);
  }

  const sep = existing.endsWith("\n") ? "\n" : "\n\n";
  return `${existing}${sep}${block}\n`;
}
