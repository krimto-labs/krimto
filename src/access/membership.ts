// Gap 07 — User/team/org membership and server-enforced access control.
// Membership lives in .krimto/members.yaml in the git repo (diffable, reviewable);
// the API server is the access enforcer (folder permissions are NOT access control).

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";

import { parseScope, type Requester } from "./scope";

export interface OrgConfig {
  slug: string;
  name?: string;
  admins: string[];
}
export interface TeamConfig {
  slug: string;
  name?: string;
  members: string[];
  leads: string[];
}
export interface UserConfig {
  email: string;
  name?: string;
  created?: string;
}
export interface Membership {
  org: OrgConfig;
  teams: TeamConfig[];
  users: UserConfig[];
}

export type Role = "org-admin" | "team-lead" | "team-member" | "org-member";

export function emptyMembership(orgSlug = "default"): Membership {
  return { org: { slug: orgSlug, admins: [] }, teams: [], users: [] };
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}
function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** Parse members.yaml into a normalized Membership, tolerating missing fields. */
export function parseMembership(yamlText: string): Membership {
  const raw = (parseYaml(yamlText) ?? {}) as Record<string, unknown>;
  const orgRaw = (raw.org ?? {}) as Record<string, unknown>;
  const org: OrgConfig = {
    slug: asString(orgRaw.slug) ?? "default",
    name: asString(orgRaw.name),
    admins: asStringArray(orgRaw.admins),
  };
  const teams: TeamConfig[] = (Array.isArray(raw.teams) ? raw.teams : [])
    .map((t): TeamConfig => {
      const tr = (t ?? {}) as Record<string, unknown>;
      return {
        slug: asString(tr.slug) ?? "",
        name: asString(tr.name),
        members: asStringArray(tr.members),
        leads: asStringArray(tr.leads),
      };
    })
    .filter((t) => t.slug !== "");
  const users: UserConfig[] = (Array.isArray(raw.users) ? raw.users : [])
    .map((u): UserConfig => {
      const ur = (u ?? {}) as Record<string, unknown>;
      return { email: asString(ur.email) ?? "", name: asString(ur.name), created: asString(ur.created) };
    })
    .filter((u) => u.email !== "");
  return { org, teams, users };
}

export function teamsOf(m: Membership, email: string): string[] {
  return m.teams.filter((t) => t.members.includes(email)).map((t) => t.slug);
}

export function isOrgAdmin(m: Membership, email: string): boolean {
  return m.org.admins.includes(email);
}

/** True when the org has at least one admin — the live signal that team mode should be enforced. */
export function hasOrgAdmin(m: Membership): boolean {
  return m.org.admins.length > 0;
}

/**
 * Guard for LIVE membership reloads: refuse to adopt a reload that would drop the last admin,
 * because that silently turns auth OFF on a running server. A transient/mid-write read that
 * momentarily parses zero admins must NOT open an auth-off window. Turning team mode off is a
 * deliberate, restart-gated operator action — never an automatic side effect of a file watch.
 */
export function shouldAdoptReload(current: Membership, next: Membership): boolean {
  return !(hasOrgAdmin(current) && !hasOrgAdmin(next));
}

export function isTeamLead(m: Membership, teamSlug: string, email: string): boolean {
  const team = m.teams.find((t) => t.slug === teamSlug);
  return team ? team.leads.includes(email) : false;
}

export function roleOf(m: Membership, email: string): Role {
  if (isOrgAdmin(m, email)) return "org-admin";
  if (m.teams.some((t) => t.leads.includes(email))) return "team-lead";
  if (m.teams.some((t) => t.members.includes(email))) return "team-member";
  return "org-member";
}

export function requesterFor(m: Membership, email: string): Requester {
  return { identity: email, teams: teamsOf(m, email) };
}

/** Server-enforced read access (Build Spec Gap 07 pseudocode). */
export function canRead(m: Membership, email: string, scope: string): boolean {
  const p = parseScope(scope);
  if (!p) return false;
  if (p.kind === "user") return p.id === email;
  if (p.kind === "team") {
    const team = m.teams.find((t) => t.slug === p.id);
    return team ? team.members.includes(email) : false;
  }
  return true; // org scope: readable by any authenticated member of this org
}

/** Server-enforced write access (Build Spec Gap 07 pseudocode). */
export function canWrite(m: Membership, email: string, scope: string): boolean {
  const p = parseScope(scope);
  if (!p) return false;
  if (isOrgAdmin(m, email)) return true; // admins write anywhere
  if (p.kind === "user") return p.id === email;
  if (p.kind === "team") {
    const team = m.teams.find((t) => t.slug === p.id);
    return team ? team.members.includes(email) : false;
  }
  return false; // org scope: org admins only (handled above)
}

/**
 * Scopes `email` may write to AND read back: their own user scope, every team they're a member of,
 * and the org scope when they're an org admin. Mirrors the server's per-request `writableScopesFor`
 * (the union that {@link canWrite} ∩ {@link canRead} would accept) so the CLI/status surfaces can
 * show "where can I save?" without a tool context. Note: an org-admin who isn't a team member does
 * NOT get that team's scope here — they'd hit the read-back guard, so it isn't a real save target.
 */
export function writableScopesFor(m: Membership, email: string): string[] {
  const scopes = [`user/${email}`, ...teamsOf(m, email).map((t) => `team/${t}`)];
  if (isOrgAdmin(m, email)) scopes.push(`org/${m.org.slug}`);
  return scopes;
}

/** Load membership from <dataDir>/.krimto/members.yaml. Returns an empty membership if absent. */
export async function loadMembership(dataDir: string): Promise<Membership> {
  try {
    const text = await fs.readFile(path.join(dataDir, ".krimto", "members.yaml"), "utf8");
    return parseMembership(text);
  } catch {
    return emptyMembership();
  }
}
