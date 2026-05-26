// `krimto connect` — print the stdio connect snippets so a user on the npx on-ramp doesn't have to
// dig the README out of a closed browser tab. The shapes come from `stdioConnectSnippets` so this
// surface and the /ui/connect panel can never drift.

import { stdioConnectSnippets } from "../server/connect";

export interface ConnectOpts {
  /** Identity to embed in the Cursor env block. Defaults to a generic placeholder. */
  identity?: string;
}

/** Build the multi-line, copy-pasteable output `krimto connect` prints to stdout. */
export function formatConnect(opts: ConnectOpts = {}): string {
  const { claude, cursorJson } = stdioConnectSnippets(opts);
  const indentedJson = cursorJson.split("\n").map((line) => `     ${line}`).join("\n");
  return [
    "",
    "✅ Connect your agent to Krimto (stdio — no key needed)",
    "",
    "━━ 1. Paste the config ━━",
    "",
    "  Claude Code:",
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
