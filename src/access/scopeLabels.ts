// Plain-English scope display helpers — used by both the CLI (`krimto notes`) and the web UI
// (`/ui/facts`). Kept in its own small module so importing the labels doesn't pull in the heavier
// CLI runtime or web rendering layers.
//
// Names render based on `members.yaml` display names when present:
//   user/<viewer-email>  → "Just me"
//   user/<other-email>   → "<other-email>"                       (not anonymised — same as MCP recall surface)
//   team/<slug>          → team.name when set, else "team/<slug>"
//   org/<slug>           → org.name when set, else "org/<slug>"

import { parseScope, type ScopeKind } from "./scope";
import { type Membership } from "./membership";

export function scopeLabel(scope: string, viewerEmail: string, membership: Membership): string {
  const parsed = parseScope(scope);
  if (!parsed) return scope;
  if (parsed.kind === "user") {
    return parsed.id === viewerEmail ? "Just me" : parsed.id;
  }
  if (parsed.kind === "team") {
    const team = membership.teams.find((t) => t.slug === parsed.id);
    return team?.name ?? `team/${parsed.id}`;
  }
  return membership.org.name ?? `org/${membership.org.slug}`;
}

/** Sort key for grouped-by-scope rendering: user < team < org. Memweave precedence order. */
export function scopeSortKey(scope: string): number {
  const k = (parseScope(scope)?.kind as ScopeKind | undefined) ?? "other";
  return { user: 0, team: 1, org: 2, other: 3 }[k as ScopeKind | "other"] ?? 3;
}
