// v0.2.31 — User-Agent → source slug mapping. Lets the HTTP MCP handler stamp each fact
// with the editor it came from ("cursor" / "claude-code" / "codex" / "gemini") so the
// dashboard can render "saved from a Cursor chat" without MCP clients having to pass
// `source` explicitly. Undefined return = unknown UA (or absent), in which case the
// existing fallback ("saved by you" / "saved by <author>") takes over.

/**
 * Map a User-Agent string to a canonical source slug. Match against the lowercased UA so
 * version digits and capitalisation don't matter. Order matters: more specific patterns
 * first (so "claude-code" doesn't accidentally match a "claude" prefix elsewhere).
 */
export function userAgentToSource(ua: string | undefined | null): string | undefined {
  if (!ua) return undefined;
  const s = ua.toLowerCase();
  if (s.includes("claude-code")) return "claude-code";
  if (s.includes("cursor")) return "cursor";
  if (s.includes("codex")) return "codex";
  if (s.includes("gemini")) return "gemini";
  // The MCP SDK's default UA looks like "node-fetch/x" or "Node/vx" — nothing identifying.
  // Return undefined so the renderer falls back to "saved by <author>".
  return undefined;
}
