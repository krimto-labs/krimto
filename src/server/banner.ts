// Startup banner strings (friction-log #1/#3/#4/D). Pure functions so the boot proof is unit-testable.
// The banner is a sign that points at one door (/ui or /ui/connect), not the door itself.

import { connectSnippets } from "./connect";

/** The placeholder identity that resolves when KRIMTO_IDENTITY is unset. Keep in sync with resolveIdentity(). */
export const DEFAULT_IDENTITY = "user@localhost";

/**
 * G2 — warn when the resolved identity is the unset-placeholder default. Two Krimto processes
 * on the same data dir (e.g. Cursor's stdio launch + a separate `serve` in her terminal) often
 * resolve to different identities — the MCP config sets one, the bare shell doesn't. The result
 * is scope mismatch: she writes facts under one identity and sees a different scope in /ui.
 * Returns an empty string when the identity was explicitly set.
 */
export function identityWarning(identity: string): string {
  if (identity !== DEFAULT_IDENTITY) return "";
  return (
    `  ⚠️  Identity = ${DEFAULT_IDENTITY} (KRIMTO_IDENTITY is unset). If your editor's MCP\n` +
    `     config sets a different KRIMTO_IDENTITY, you'll see different scopes between\n` +
    `     surfaces. Set KRIMTO_IDENTITY in your shell to match for a consistent view.\n`
  );
}

/**
 * Stdio mode banner — printed on stderr when the npx/stdio MCP server boots. Surfaces the four
 * subcommands so a user who ran `npx ...krimto` interactively (and sees a process that just sits
 * there) can discover the CLI surface without hunting for the README.
 */
export function stdioStartupBanner(version: string, dataDir: string, identity = DEFAULT_IDENTITY): string {
  return (
    `\nKrimto ${version} — stdio MCP server ready (data: ${dataDir})\n` +
    `  This process speaks MCP over stdin/stdout. Point an MCP client at it.\n` +
    `  CLI: krimto serve · connect · init · uninit · usage · storage · setup-remote · setup-embeddings · verify-connection · where · --help\n` +
    identityWarning(identity) +
    `\n`
  );
}

/** Local mode (no auth): the explicit 2-command recipe, the data location, plus the team upgrade hint. */
export function localModeBanner(port: number, dataDir: string, identity = DEFAULT_IDENTITY): string {
  return (
    `\nKrimto is running → http://localhost:${port}\n` +
    `\n` +
    `┌─ To connect your editor — BOTH commands are required ─────────────────┐\n` +
    `│                                                                       │\n` +
    `│  1. Tell your editor about Krimto:                                    │\n` +
    `│       claude mcp add --transport http krimto http://localhost:${port}/mcp\n` +
    `│       (Cursor / other editors: http://localhost:${port}/ui/connect)\n` +
    `│                                                                       │\n` +
    `│  2. In your PROJECT root, make the agent auto-use Krimto:             │\n` +
    `│       cd <your project> && npx @krimto-labs/krimto init               │\n` +
    `│       ↑ Without step 2, your agent uses its own memory and ignores    │\n` +
    `│         Krimto. The agent never calls krimto_recall / krimto_write.   │\n` +
    `│                                                                       │\n` +
    `│  3. Test it in your AI chat:                                          │\n` +
    `│       "Remember that we use pnpm in this repo (not npm)."             │\n` +
    `│     Then in a NEW chat: "What do you use for installing deps?"        │\n` +
    `│                                                                       │\n` +
    `└───────────────────────────────────────────────────────────────────────┘\n` +
    `\n` +
    `  💾 Data: ${dataDir}  (run \`npx @krimto-labs/krimto where\` to find it later)\n` +
    `  📝 Your facts are plain markdown files — open any .md in that folder to read them.\n` +
    `  🔌 Already connected via stdio (the npx path)? Keep that config — this HTTP server is\n` +
    `     just for the browser dashboard, not a second MCP connection.\n` +
    `  🔒 Local mode (no auth — local/trusted use only). For teams: set KRIMTO_BOOTSTRAP_ADMIN=<email>.\n` +
    identityWarning(identity) +
    `\n`
  );
}

/**
 * Team mode. When `key` is non-null (minted this boot) we print a ready-to-paste config with the key
 * baked in. When `key` is null (admin already existed — we don't know their key) we print recovery
 * guidance instead of a misleading placeholder.
 */
export function teamModeBanner(opts: { host: string; key: string | null; dataDir: string }): string {
  if (!opts.key) {
    return (
      `\nKrimto is running (team mode) → http://${opts.host}\n` +
      `  Admin already set up. Use your existing key, or set KRIMTO_REISSUE_ADMIN_KEY=<email> to mint a fresh one.\n` +
      `  💾 Data: ${opts.dataDir}\n` +
      `  Open http://${opts.host}/ui/connect for copy-paste setup.\n\n`
    );
  }
  const s = connectSnippets({ host: opts.host, key: opts.key });
  const cursor = s.cursorJson
    .split("\n")
    .map((l) => `    ${l}`)
    .join("\n");
  return (
    `\nConnect your agent (team mode):\n` +
    `  Claude Code:  ${s.claude}\n` +
    `  Cursor (~/.cursor/mcp.json):\n${cursor}\n` +
    `  💾 Data: ${opts.dataDir}\n` +
    `  Open http://${opts.host}/ui/connect for copy-paste + an "Add to Cursor" button.\n\n`
  );
}
