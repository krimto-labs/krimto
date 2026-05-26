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
];
if (MCP_TOOL_NAMES.length !== EXPECTED.length || MCP_TOOL_NAMES.some((t, i) => t !== EXPECTED[i])) {
  throw new Error("src/cli/usage.ts examples are out of sync with src/server/connect.ts MCP_TOOL_NAMES");
}

/** Build the long-form usage guide printed by `krimto usage`. */
export function formatUsage(version: string): string {
  return [
    `krimto — using Krimto from your editor (v${version})`,
    "",
    "THE FIVE TOOLS",
    "  krimto_write        Save a fact. Used when you (or the agent) want to remember.",
    "  krimto_recall       Search for relevant facts. Used before tasks or by request.",
    "  krimto_read         Open one specific fact by id, with full frontmatter.",
    "  krimto_supersede    Replace a fact with an updated version (old kept in git history).",
    "  krimto_list_scopes  See which user / team / org scopes you can read from.",
    "",
    "DEFAULT MODE — you call the tools by mentioning Krimto by name",
    "  Your agent has all five tools wired up but only calls them when you ask it to.",
    "  Examples (paste into any AI chat):",
    "",
    '    "Use krimto to remember that staging resets every Sunday."',
    "       → agent calls krimto_write (scope: user/me)",
    "",
    '    "Use krimto to recall what we know about deploys."',
    "       → agent calls krimto_recall(\"deploys\")",
    "",
    '    "Use krimto to list the scopes I can access."',
    "       → agent calls krimto_list_scopes",
    "",
    '    "Open krimto fact fct_01HF...XYZ and show me the body."',
    "       → agent calls krimto_read(id)",
    "",
    '    "Use krimto to update the staging-resets note: it now runs at 9am."',
    "       → agent calls krimto_recall to find the fact, then krimto_supersede",
    "",
    "AUTO MODE — the agent uses the tools automatically (after `init`)",
    "  The rule written by `init` tells your agent to call recall before tasks and",
    '  write when you say "remember". You can phrase things naturally — no need to',
    '  mention Krimto every time.',
    "  Examples (paste into any AI chat):",
    "",
    '    "Help me add a Stripe webhook."',
    "       → agent first calls krimto_recall(\"stripe webhook\"), uses what it",
    "         finds, and may call krimto_write to save anything new it learned.",
    "",
    '    "Remember that our migrations run nightly at 2am."',
    '       → agent calls krimto_write (no "use krimto" prefix needed).',
    "",
    '    "What\'s our convention for naming feature flags?"',
    "       → agent calls krimto_recall first, then answers from the result.",
    "",
    "SCOPES — where facts live",
    "  user/me       Your personal scope. (The server resolves `me` to your identity.)",
    "                Use this for things only you care about.",
    "  team/<slug>   Your team's scope. Visible to all team members.",
    "                Use this for shared conventions.",
    "  org/<slug>    Org-wide scope. Visible to everyone in the org.",
    "                Used for company rules; org admins write here.",
    "",
    "  Precedence at recall: user > team > org. A personal note beats a team note;",
    "  a team note beats an org note (when both match a query).",
    "",
    "  Targeting a specific scope (either mode):",
    '    "Use krimto to remember (team/backend) that we use pnpm, never npm."',
    '    "Remember in team/backend that we use pnpm, never npm."',
    "",
    "NEXT STEPS",
    "  • Switch this project to AUTO MODE:  krimto init",
    "  • Switch this project to DEFAULT:    krimto uninit",
    "  • Print the connect config again:    krimto connect",
    "  • Print this guide again:            krimto usage",
    "",
  ].join("\n");
}
