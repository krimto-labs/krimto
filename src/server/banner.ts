// Startup banner strings (friction-log #1/#3/#4/D). Pure functions so the boot proof is unit-testable.
// The banner is a sign that points at one door (/ui or /ui/connect), not the door itself.

import { connectSnippets } from "./connect";
import { DEFAULT_BIND_HOST, isLoopbackHost } from "./bindHost";

/** The placeholder identity that resolves when KRIMTO_IDENTITY is unset AND git config user.email is
 * unset/invalid. Keep in sync with resolveIdentity()'s final fallback. */
export const DEFAULT_IDENTITY = "user@localhost";

/**
 * G2 — warn when the resolved identity is the unset-placeholder default. Two Krimto processes
 * on the same data dir (e.g. Cursor's stdio launch + a separate `serve` in her terminal) often
 * resolve to different identities — the MCP config sets one, the bare shell doesn't. The result
 * is scope mismatch: facts saved under one identity, viewed under another in /ui. After the
 * smoke-6 fix, `resolveIdentity()` falls back to global git user.email before this placeholder,
 * so the warning only fires when both sources are missing.
 * Returns an empty string when a real identity was resolved.
 */
export function identityWarning(identity: string): string {
  if (identity !== DEFAULT_IDENTITY) return "";
  return (
    `⚠️  Identity = ${DEFAULT_IDENTITY} (KRIMTO_IDENTITY is unset).\n` +
    `   If your editor sets a different KRIMTO_IDENTITY, you'll see\n` +
    `   different scopes between surfaces. Set KRIMTO_IDENTITY to match.\n`
  );
}

/**
 * Stdio mode banner — printed on stderr when the npx/stdio MCP server boots. Surfaces the four
 * subcommands so a user who ran `npx ...krimto` interactively (and sees a process that just sits
 * there) can discover the CLI surface without hunting for the README.
 */
export function stdioStartupBanner(version: string, dataDir: string, identity = DEFAULT_IDENTITY): string {
  const warn = identityWarning(identity);
  return (
    `\n✅ Krimto v${version} — your AI's shared memory (stdio MCP server ready)\n` +
    `\n` +
    `   This process speaks MCP over stdin/stdout — an MCP client (your editor) drives it.\n` +
    `\n` +
    `━━ Where your notes live ━━\n` +
    `\n` +
    `   ${dataDir}\n` +
    `   Plain markdown files — the same folder no matter which project you're in.\n` +
    `\n` +
    `━━ Useful next steps ━━\n` +
    `\n` +
    `   $ npx @krimto-labs/krimto init      Make your agent use Krimto automatically\n` +
    `   $ npx @krimto-labs/krimto notes     List your saved notes\n` +
    `   $ npx @krimto-labs/krimto ui        Open the browser dashboard\n` +
    `   $ npx @krimto-labs/krimto --help    Full command list + which editors auto-connect\n` +
    (warn ? `\n${warn}` : "") +
    `\n`
  );
}

/** Local mode (no auth): clean visual hierarchy — headline, recipe, then context. */
export function localModeBanner(
  port: number,
  dataDir: string,
  identity = DEFAULT_IDENTITY,
  bindHost: string = DEFAULT_BIND_HOST,
): string {
  const warn = identityWarning(identity);
  const modeLine = isLoopbackHost(bindHost)
    ? `  Mode:  Local (no auth) — bound to ${bindHost}, reachable from this machine only.\n` +
      `         Bring teammates in with \`npx @krimto-labs/krimto team init\`.\n`
    : `  Mode:  Local — ⚠ EXPOSED on ${bindHost} with NO auth: anyone who can reach this host can\n` +
      `         read or write your memory with no key. Add auth with \`npx @krimto-labs/krimto team init\`,\n` +
      `         or bind a loopback host (unset KRIMTO_HTTP_HOST / KRIMTO_ALLOW_INSECURE_HOST).\n`;
  return (
    `\n✅ Krimto running → http://localhost:${port}\n` +
    `\n` +
    `━━ Connect your editor (BOTH steps required) ━━\n` +
    `\n` +
    `  1. Tell your editor about Krimto:\n` +
    `     $ claude mcp add --transport http krimto http://localhost:${port}/mcp\n` +
    `     (Cursor / other editors: http://localhost:${port}/ui/connect)\n` +
    `\n` +
    `  2. In your PROJECT dir, make the agent auto-use Krimto:\n` +
    `     $ npx @krimto-labs/krimto init\n` +
    `     ↑ without this, your agent uses its own memory and ignores Krimto.\n` +
    `\n` +
    `  Test: in chat → "Remember we use pnpm" → new chat → "What do we use?"\n` +
    `\n` +
    `━━ Where things live ━━\n` +
    `\n` +
    `  Data:  ${dataDir}\n` +
    `  Files: plain markdown — the same folder no matter which project you're in.\n` +
    modeLine +
    `\n` +
    `  Already connected via stdio (the npx path)? Keep that config —\n` +
    `  this HTTP server is just for the browser dashboard.\n` +
    (warn ? `\n${warn}` : "") +
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
