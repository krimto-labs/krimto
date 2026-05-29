// `krimto usage` — the in-terminal guide to actually USING Krimto, once it's connected.
// Lists the five MCP tools, shows how each one gets invoked in DEFAULT MODE vs AUTO MODE,
// and gives copy-pasteable chat examples. Tool names come from `MCP_TOOL_NAMES` so this
// surface can't drift from the registered toolset.

import { MCP_TOOL_NAMES } from "../server/connect";

// Sanity guard at module load: if someone changes the tool list in connect.ts without updating
// this file's examples, fail loudly rather than silently shipping stale guidance.
const EXPECTED: readonly string[] = [
  "krimto_write",
  "krimto_recall",
  "krimto_read",
  "krimto_supersede",
  "krimto_list_scopes",
  "krimto_whoami",
];
if (MCP_TOOL_NAMES.length !== EXPECTED.length || MCP_TOOL_NAMES.some((t, i) => t !== EXPECTED[i])) {
  throw new Error("src/cli/usage.ts examples are out of sync with src/server/connect.ts MCP_TOOL_NAMES");
}

/** Build the long-form usage guide printed by `krimto usage`. */
export function formatUsage(version: string): string {
  return [
    "",
    `✅ How to use Krimto (v${version})`,
    "",
    "━━ The 6 tools ━━",
    "",
    "  krimto_write        Save a fact",
    "  krimto_recall       Search facts",
    "  krimto_read         Open one fact by id",
    "  krimto_supersede    Replace a fact with a new version (old kept in git)",
    "  krimto_list_scopes  See which scopes you can read",
    "  krimto_whoami       Ask Krimto which identity you're writing as (and your scopes)",
    "",
    "━━ DEFAULT MODE — explicit (\"use krimto to ...\") ━━",
    "",
    "  \"Use krimto to remember staging resets every Sunday.\"",
    "  → calls krimto_write (scope: user/me)",
    "",
    "  \"Use krimto to recall what we know about deploys.\"",
    "  → calls krimto_recall(\"deploys\")",
    "",
    "  \"Use krimto to update the staging note: it now runs at 9am.\"",
    "  → calls krimto_recall → krimto_supersede",
    "",
    "━━ AUTO MODE — natural language (after `krimto init`) ━━",
    "",
    "  \"Help me add a Stripe webhook.\"",
    "  → agent auto-calls krimto_recall, finds team conventions, uses them.",
    "",
    "  \"Remember our migrations run nightly at 2am.\"",
    "  → agent auto-calls krimto_write (no \"use krimto\" prefix needed).",
    "",
    "  \"What's our convention for naming feature flags?\"",
    "  → agent auto-calls krimto_recall first, then answers from the result.",
    "",
    "━━ Scopes (where facts live) ━━",
    "",
    "  user/me        Personal — just you",
    "  team/<slug>    Your team — shared with team members",
    "  org/<slug>     Company-wide — admins only",
    "",
    "  Precedence at recall: user > team > org.",
    "",
    "  Target a specific scope (either mode):",
    "    \"Use krimto to remember (team/backend) that we use pnpm, never npm.\"",
    "    \"Remember in team/backend that we use pnpm, never npm.\"",
    "",
    "━━ Syncing across machines / teammates ━━",
    "",
    "  Personal + team notes live in one data dir and sync together over git.",
    "  Set a shared remote → two-way sync turns on (auto-push every commit,",
    "  a running server auto-pulls every ~60s):",
    "    $ krimto remote --set git@github.com:acme/krimto-data.git",
    "    $ krimto sync        Pull teammates' notes now + push yours (alias: pull)",
    "",
    "  Or connect to a teammate's server instead (no local data to pull):",
    "    $ krimto join --server <url> --key <key>",
    "",
    "━━ Related commands ━━",
    "",
    "  $ krimto init       Switch this project to AUTO MODE",
    "  $ krimto uninit     Switch back to DEFAULT MODE",
    "  $ krimto connect    Print the editor config snippets",
    "  $ krimto usage      Print this guide",
    "",
  ].join("\n");
}
