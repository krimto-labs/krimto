// `krimto team status` — answers "is team mode on, who's in it, what's my role, and is THIS
// machine the server everyone depends on?" Built on the shared buildTeamSummary so it can't drift
// from the Team block in `krimto status`.

import { type Role } from "../access/membership";
import { parseScope } from "../access/scope";
import { buildTeamSummary } from "./teamSummary";

export interface TeamStatusOptions {
  dataDir: string;
  identity: string;
  port?: number;
}

export interface TeamStatusResult {
  status: "team" | "solo";
  message: string;
}

/** The natural phrase that routes a save to a given scope — shown so users discover how to target
 *  each scope without memorizing anything. Spelling out each team teaches multi-team users to name
 *  the team ("for the backend team") instead of the ambiguous "for the team". For the org scope we
 *  show the friendly org NAME (never the raw `org/<slug>` path), falling back to "your whole org"
 *  when the org hasn't been named yet. */
function saveTargetLine(scope: string, orgName?: string): string {
  const p = parseScope(scope);
  if (p?.kind === "org") {
    const label = orgName ? `${orgName} (whole org)` : "your whole org";
    return `    ${'"remember company-wide …"'.padEnd(36)} → ${label}  (admins)`;
  }
  const phrase =
    !p || p.kind === "user" ? '"remember …"' : `"remember for the ${p.id} team …"`;
  const note = !p || p.kind === "user" ? "  (personal)" : "";
  return `    ${phrase.padEnd(36)} → ${scope}${note}`;
}

function roleLabel(role: Role): string {
  switch (role) {
    case "org-admin":
      return "admin (can manage members + see org scope)";
    case "team-lead":
      return "team lead";
    case "team-member":
      return "team member";
    default:
      return "member";
  }
}

export async function runTeamStatus(opts: TeamStatusOptions): Promise<TeamStatusResult> {
  const s = await buildTeamSummary(opts.dataDir, opts.identity, opts.port ? { port: opts.port } : {});

  if (s.mode === "solo") {
    return {
      status: "solo",
      message:
        "\nKrimto — Team status\n\n" +
        "  Mode:    Solo (no team)\n" +
        "  No login is required and your notes are personal to you.\n" +
        "  Start a team with:  krimto team init\n\n",
    };
  }

  let body = "\nKrimto — Team status\n\n";
  body += "  Mode:    Team (login required — every member uses an API key)\n";
  body += `  You:     ${opts.identity} · ${roleLabel(s.myRole)}\n`;
  body += `  Admins:  ${s.admins.join(", ") || "(none)"}\n`;
  body += `  Members: ${s.memberCount}\n`;
  if (s.hostedHere) {
    body += `  Server:  🟢 THIS machine is the team server (${s.serverUrl})\n`;
    body += "           Teammates connect here. If you run `krimto stop`, uninstall, or this\n";
    body += "           machine sleeps, they go offline until it's back up.\n";
  } else {
    body += "  Server:  Hosted elsewhere — this machine isn't the team server.\n";
  }
  body += "\n  Save targets (just tell your AI):\n";
  for (const scope of s.writableScopes) body += saveTargetLine(scope, s.orgName) + "\n";

  // The org scope exists but hasn't been given a real name (still the `org/default` placeholder) —
  // surface the exact command to name it, so company-wide notes stop reading as "org/default".
  if (s.writableScopes.includes(`org/${s.orgSlug}`) && !s.orgName) {
    body += '\n  Tip: name your org so company-wide notes read nicely:\n';
    body += '    krimto team init --org "Your Company"\n';
  }

  if (s.adminGapTeams.length > 0) {
    body += `\n  ⚠ You're an admin but not a member of: ${s.adminGapTeams.join(", ")}\n`;
    body += "    You can't save those team notes (you couldn't read them back). Re-run\n";
    body += "    `krimto team init --team <slug>` (adds you), or add yourself in /ui/admin.\n";
  }

  body += "\n  Manage members:  open /ui/admin (admins only)\n";
  body += "  Add teammates:   krimto team init  (idempotent — re-run to add more)\n\n";
  return { status: "team", message: body };
}
