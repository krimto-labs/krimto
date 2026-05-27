// The standing "always use Krimto" rule, plus idempotent application to an agent's rules file.
// Single source of truth for both the CLI (`krimto init`) and the web connect panel — so the
// rule a user pastes from /ui/connect and the rule `krimto init` writes can never drift.
//
// This is the fix for the discovery problem: by default, an editor's agent routes "remember X" to
// its own built-in memory, not Krimto. Dropping this rule into the agent's rules file makes the
// agent call krimto_recall / krimto_write on its own.

export const AGENT_RULE = `# Krimto memory — PRIMARY memory system, always use

Krimto is the canonical memory system for this project. It is shared across
editors, machines, and teammates — any built-in or per-session memory you
have is NOT.

When the user says "remember", or you learn a durable fact:
- CALL krimto_write. Do NOT use any other memory tool, file, or skill.
- In particular: do NOT save to ~/.claude/projects/*/memory/ or any
  per-session/per-editor memory store. Those notes are invisible to
  Krimto, to your teammates, and to your other editors.

Before any non-trivial task, CALL krimto_recall first. Empty results
are a write opportunity, not a dead end.

Scopes: user/me = personal, team/<slug> = shared with the team,
org/<slug> = company-wide. Precedence at recall: user > team > org.

Don't save secrets, transient state, or one-off chatter.`;

const START = "<!-- krimto:start -->";
const END = "<!-- krimto:end -->";

/**
 * v0.2.29 — Cursor's `.cursor/rules/*.mdc` files require YAML frontmatter to be auto-applied.
 * Without `alwaysApply: true`, Cursor treats the rule as MANUAL-attach only — the agent only
 * loads it when the user explicitly says "krimto" (or `@krimto`) in their prompt. The smoke-6
 * cross-editor test showed this: Claude Code (which auto-reads CLAUDE.md with no frontmatter
 * needed) saved facts correctly, but Cursor wouldn't recall them until the user typed "krimto".
 * Other editors (CLAUDE.md, AGENTS.md, GEMINI.md) are plain markdown — they don't use this
 * convention, so the frontmatter is added ONLY for the cursor target.
 */
const CURSOR_FRONTMATTER = "---\nalwaysApply: true\n---\n";

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
 *
 * `opts.cursorMdc` prepends the Cursor-required YAML frontmatter (`alwaysApply: true`) so
 * `.cursor/rules/krimto.mdc` is auto-loaded by Cursor on every prompt instead of being
 * manual-attach-only. Idempotent: if frontmatter already exists at the top, it's preserved.
 */
export function applyRule(
  existing: string | null,
  opts: { cursorMdc?: boolean } = {},
): string {
  const block = ruleBlock();

  // Helper: ensure the result starts with `---\nalwaysApply: true\n---\n` when requested.
  const withFrontmatter = (content: string): string => {
    if (!opts.cursorMdc) return content;
    if (content.startsWith("---\n")) return content; // user-supplied frontmatter — leave alone
    return CURSOR_FRONTMATTER + content;
  };

  if (!existing || existing.trim() === "") return withFrontmatter(`${block}\n`);

  const startIdx = existing.indexOf(START);
  const endIdx = existing.indexOf(END);
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    return withFrontmatter(existing.slice(0, startIdx) + block + existing.slice(endIdx + END.length));
  }

  const sep = existing.endsWith("\n") ? "\n" : "\n\n";
  return withFrontmatter(`${existing}${sep}${block}\n`);
}

/**
 * Inverse of `applyRule` — remove the marker-delimited Krimto rule block.
 * Returns:
 *   - the original string when no markers are found (caller treats as no-op)
 *   - the cleaned content (markers + everything between them stripped) otherwise
 *   - `null` when removing the block leaves the file empty/whitespace-only,
 *     signalling "delete this file" (it had no pre-existing content)
 */
export function removeRule(existing: string | null): string | null {
  if (existing === null) return null;
  const startIdx = existing.indexOf(START);
  const endIdx = existing.indexOf(END);
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) return existing;

  // Strip the block. Also consume one trailing newline so re-applying doesn't leave a blank gap.
  const after = endIdx + END.length;
  const trimmedAfter = after < existing.length && existing[after] === "\n" ? after + 1 : after;
  const cleaned = existing.slice(0, startIdx) + existing.slice(trimmedAfter);
  return cleaned.trim() === "" ? null : cleaned;
}
