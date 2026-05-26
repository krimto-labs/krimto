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
  return [
    "Connect your agent to Krimto (solo, stdio — no key needed):",
    "",
    "Claude Code:",
    `  ${claude}`,
    "",
    "Cursor (~/.cursor/mcp.json):",
    ...cursorJson.split("\n").map((line) => `  ${line}`),
    "",
    "What you get after pasting the snippet above:",
    "  The five Krimto tools (write, recall, read, supersede, list_scopes) are",
    "  available to your agent — but it only calls them when YOU explicitly ask,",
    "  e.g. \"use krimto to remember X\" or \"use krimto to recall what we know\".",
    "",
    "Want your agent to use Krimto AUTOMATICALLY (recall before tasks, save what",
    "it learns when you say \"remember\")? Also run this once per project:",
    "  npx @krimto-labs/krimto init",
    "",
    "  Skip `init` if you only want Krimto on-demand. The rule it writes can be",
    "  removed at any time — `krimto init` will explain how when you run it.",
    "",
    "Optional add-ons — add these to the `env` block above if you want them:",
    '  "KRIMTO_GIT_REMOTE": "git@github.com:acme/krimto-data.git"',
    "      ↑ pushes every batch to a private git remote (team sync across machines)",
    "      Set this up safely first: `krimto setup-remote <url>` verifies the push works.",
    '  "KRIMTO_EMBED_PROVIDER": "openai"',
    '  "KRIMTO_EMBED_API_KEY":  "sk-..."',
    "      ↑ turns on semantic / vector search (recall matches paraphrases, not just",
    "      keywords). Verify the provider works first: `krimto setup-embeddings`.",
    "  Both are optional — Krimto works fully without them.",
    "",
    "──────────────────────────────────────────────────────────────────────────",
    "✅ CONNECTED? DO THESE THREE THINGS",
    "──────────────────────────────────────────────────────────────────────────",
    "Pasting the snippet only makes the five tools AVAILABLE to your agent. To",
    "make your agent actually USE them — and to confirm the whole loop end-to-",
    "end — do these in order:",
    "",
    "  1. Make it auto. In your project root, run:",
    "       npx @krimto-labs/krimto init",
    "     Restart your editor afterward so the rule takes effect.",
    "",
    "  2. Test the write path. Paste this into your AI chat:",
    '       "Remember that we use pnpm in this repo (not npm)."',
    "     Your agent should call krimto_write and confirm it saved.",
    "",
    "  3. Test the recall path. Open a NEW chat and paste:",
    '       "What do you know about this repo?"',
    "     Your agent should call krimto_recall, find the pnpm fact, and use it.",
    "",
    "If the agent doesn't seem to be calling Krimto, run:",
    "  npx @krimto-labs/krimto verify-connection",
    "to see whether any MCP requests reached Krimto.",
    "",
    "For team mode (HTTP + bearer auth), start the server and open /ui/connect.",
    "",
  ].join("\n");
}
