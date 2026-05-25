// Startup banner strings (friction-log #1/#3/#4/D). Pure functions so the boot proof is unit-testable.
// The banner is a sign that points at one door (/ui or /ui/connect), not the door itself.

import { connectSnippets } from "./connect";

/** Local mode (no auth): one signpost line to /ui/connect, plus the team upgrade hint. */
export function localModeBanner(port: number): string {
  return (
    `\nKrimto is running → http://localhost:${port}\n` +
    `  👉 Open http://localhost:${port}/ui/connect to connect your editor (60 seconds)\n` +
    `  🔒 Local mode (no auth — local/trusted use only). For teams: set KRIMTO_BOOTSTRAP_ADMIN=<email>.\n\n`
  );
}

/**
 * Team mode. When `key` is non-null (minted this boot) we print a ready-to-paste config with the key
 * baked in. When `key` is null (admin already existed — we don't know their key) we print recovery
 * guidance instead of a misleading placeholder.
 */
export function teamModeBanner(opts: { host: string; key: string | null }): string {
  if (!opts.key) {
    return (
      `\nKrimto is running (team mode) → http://${opts.host}\n` +
      `  Admin already set up. Use your existing key, or set KRIMTO_REISSUE_ADMIN_KEY=<email> to mint a fresh one.\n` +
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
    `  Open http://${opts.host}/ui/connect for copy-paste + an "Add to Cursor" button.\n\n`
  );
}
