// `krimto connect` — print the stdio connect snippets so a user on the npx on-ramp doesn't have to
// dig the README out of a closed browser tab. The shapes come from `stdioConnectSnippets` so this
// surface and the /ui/connect panel can never drift.

import { stdioConnectSnippets } from "../server/connect";

export interface ConnectOpts {
  /** Identity to embed in the Cursor env block. Defaults to git config user.email, falling back to a generic placeholder. */
  identity?: string;
}

/**
 * Build the multi-line, copy-pasteable output `krimto connect` prints to stdout.
 *
 * v0.2.24 — identity falls back to {@link defaultIdentity} (git config user.email) when not
 * supplied. Before this, the printed snippet always showed `you@acme.com`, so users
 * pasting the snippet ended up with the placeholder as their literal KRIMTO_IDENTITY.
 *
 * v0.2.24 — the printed `claude mcp add` line is now preceded by `claude mcp remove krimto`
 * so a copy-paste rerun doesn't fail with "MCP server krimto already exists in local config"
 * (the same idempotency fix v0.2.19 made to the wizard's MCP writer).
 */
export async function formatConnect(opts: ConnectOpts = {}): Promise<string> {
  const identity = opts.identity ?? (await defaultIdentityForConnect());
  const { claude, cursorJson } = stdioConnectSnippets({ identity });
  const indentedJson = cursorJson.split("\n").map((line) => `     ${line}`).join("\n");
  return [
    "",
    "✅ Connect your agent to Krimto (stdio — no key needed)",
    "",
    "━━ 1. Paste the config ━━",
    "",
    "  Claude Code (the `remove` clears any prior entry so re-runs don't error):",
    "     $ claude mcp remove krimto 2>/dev/null; true",
    `     $ ${claude}`,
    "",
    "  Cursor (add to ~/.cursor/mcp.json, then restart Cursor):",
    indentedJson,
    "",
    "━━ 2. Make it AUTOMATIC (in your project root) ━━",
    "",
    "  $ npx @krimto-labs/krimto init",
    "",
    "  Without this, your agent has the 5 Krimto tools but only uses them",
    "  when you say \"use krimto to ...\". With it, the agent auto-recalls",
    "  before tasks and auto-saves when you say \"remember\".",
    "",
    "━━ 3. Test the loop ━━",
    "",
    "  In your AI chat:",
    "     \"Remember that we use pnpm in this repo (not npm).\"",
    "",
    "  Then in a NEW chat:",
    "     \"What do you know about this repo?\"",
    "",
    "  The agent should find the pnpm fact and use it. If not:",
    "     $ npx @krimto-labs/krimto verify-connection",
    "",
    "━━ Optional add-ons (skip unless you need them) ━━",
    "",
    "  Cross-machine / team sync:",
    "     KRIMTO_GIT_REMOTE=git@github.com:acme/krimto-data.git",
    "     → set up safely: $ npx krimto setup-remote <url>",
    "",
    "  Smarter semantic recall:",
    "     KRIMTO_EMBED_PROVIDER=openai",
    "     KRIMTO_EMBED_API_KEY=sk-...",
    "     → verify first: $ npx krimto setup-embeddings",
    "",
    "  Add either to the `env` block in your editor's MCP config.",
    "",
    "(Team mode with HTTP + bearer auth: start the server and open /ui/connect.)",
    "",
  ].join("\n");
}

/**
 * Local copy of init.ts's git-config lookup, scoped to the connect command. We don't import
 * `defaultIdentity` directly from init.ts to keep `connect` cheap (init.ts pulls in
 * `applyRule`, service installer, MCP writer, etc.). Same regex; same fallback.
 */
async function defaultIdentityForConnect(): Promise<string> {
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const exec = promisify(execFile);
    const { stdout } = await exec("git", ["config", "--global", "user.email"]);
    const email = stdout.trim();
    if (email && /^[^@\s]+@[^@\s]+$/.test(email)) return email;
  } catch {
    /* git missing or unconfigured — fall through to the legacy placeholder */
  }
  return "you@acme.com";
}
