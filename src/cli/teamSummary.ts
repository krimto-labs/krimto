// One reconciled view of "what is the team, and is this machine the server?" — the data behind
// `krimto team status`, the Team line in `krimto status`, and the reset/stop safety warnings.
// Pure composition of existing pieces: the membership roster + the runtime lock. No new detection.

import {
  hasOrgAdmin,
  isOrgAdmin,
  loadMembership,
  roleOf,
  writableScopesFor,
  type Role,
} from "../access/membership";
import { readLock } from "./inspectRuntime";

export interface TeamSummary {
  /** "team" when members.yaml has at least one admin (auth enforced); else "solo". */
  mode: "team" | "solo";
  /** The caller's role in the roster. */
  myRole: Role;
  /** Org admins (the people who can manage members + see org scope). */
  admins: string[];
  /** Distinct member emails across all teams ∪ the users list. */
  memberCount: number;
  /** True when a live HTTP Krimto server holds this data dir's lock — i.e. THIS machine is the
   *  server teammates connect to. */
  hostedHere: boolean;
  /** The URL teammates would reach when hostedHere, else null. */
  serverUrl: string | null;
  /** Scopes the caller can actually save to (write AND read back): own user + their teams + org
   *  if admin. Drives the "Save targets" discoverability block. */
  writableScopes: string[];
  /** Teams the caller is an org-admin of but NOT a member of — so they can't write those team
   *  notes (the read-back guard refuses). Non-empty only on legacy setups created before the
   *  creator was auto-added as a member; drives the one-line nudge in `team status`. */
  adminGapTeams: string[];
  /** The organization's display name, when set — shown instead of the raw `org/<slug>` path. */
  orgName?: string;
  /** The org's slug (the `org/<slug>` path) — `"default"` until the org is named. */
  orgSlug: string;
}

export interface TeamSummaryOptions {
  /** Override the port used to render serverUrl (defaults to KRIMTO_HTTP_PORT or 8080). */
  port?: number;
}

export async function buildTeamSummary(
  dataDir: string,
  identity: string,
  opts: TeamSummaryOptions = {},
): Promise<TeamSummary> {
  const membership = await loadMembership(dataDir);
  const lock = await readLock(dataDir);

  const memberEmails = new Set<string>();
  for (const t of membership.teams) for (const m of t.members) memberEmails.add(m);
  for (const u of membership.users) memberEmails.add(u.email);

  const hostedHere = lock !== null && lock.alive && lock.mode === "http";
  const port = opts.port ?? Number(process.env.KRIMTO_HTTP_PORT ?? "8080");

  const adminGapTeams = isOrgAdmin(membership, identity)
    ? membership.teams.filter((t) => !t.members.includes(identity)).map((t) => t.slug)
    : [];

  return {
    mode: hasOrgAdmin(membership) ? "team" : "solo",
    myRole: roleOf(membership, identity),
    admins: membership.org.admins,
    memberCount: memberEmails.size,
    hostedHere,
    serverUrl: hostedHere ? `http://localhost:${port}` : null,
    writableScopes: writableScopesFor(membership, identity),
    adminGapTeams,
    ...(membership.org.name ? { orgName: membership.org.name } : {}),
    orgSlug: membership.org.slug,
  };
}
