// Gap 03 — Scope path convention.
// Strict three-level hierarchy: user/<id>, team/<slug>, org/<slug>. The scope
// string maps one-to-one with a folder path in the git repository. Precedence
// (user > team > org) applies to retrieval ranking, not access control.

export type ScopeKind = "user" | "team" | "org";

export interface ParsedScope {
  kind: ScopeKind;
  /** The identifier after the kind: a user email, team slug, or org slug. */
  id: string;
}

const KINDS: ScopeKind[] = ["user", "team", "org"];

// Identifier charset per the Build Spec: alphanumeric, dashes, dots, at-signs.
const ID_RE = /^[A-Za-z0-9.@-]+$/;

/** Parse and validate a scope string. Returns null when malformed. */
export function parseScope(scope: string): ParsedScope | null {
  const slash = scope.indexOf("/");
  if (slash < 0) return null;
  const kind = scope.slice(0, slash);
  const id = scope.slice(slash + 1);
  if (!KINDS.includes(kind as ScopeKind)) return null;
  // Exactly two segments — no nested teams or sub-orgs.
  if (id.length === 0 || id.includes("/")) return null;
  if (!ID_RE.test(id)) return null;
  return { kind: kind as ScopeKind, id };
}

export function isValidScope(scope: string): boolean {
  return parseScope(scope) !== null;
}

/** The repository-relative folder path for a scope (it is the scope string, validated). */
export function scopeRelativePath(scope: string): string {
  const parsed = parseScope(scope);
  if (!parsed) throw new Error(`Invalid scope: ${scope}`);
  return `${parsed.kind}/${parsed.id}`;
}

/** Recover a scope from a (possibly Windows-separated) relative folder path. */
export function scopeFromPath(relPath: string): ParsedScope | null {
  return parseScope(relPath.replace(/\\/g, "/"));
}

// Most-specific-first: user(0) < team(1) < org(2).
export const SCOPE_PRECEDENCE: Record<ScopeKind, number> = { user: 0, team: 1, org: 2 };

/** Negative if a is more specific than b. */
export function comparePrecedence(a: ScopeKind, b: ScopeKind): number {
  return SCOPE_PRECEDENCE[a] - SCOPE_PRECEDENCE[b];
}

export interface Requester {
  /** e.g. alice@acme.com */
  identity: string;
  /** Team slugs the requester belongs to. */
  teams: string[];
}

export type ScopeRelation = "own-user" | "own-team" | "org" | "other";

/** Classify a scope relative to the requester — drives the retrieval scope boost (Gap 04). */
export function scopeRelation(scope: string, requester: Requester): ScopeRelation {
  const parsed = parseScope(scope);
  if (!parsed) return "other";
  if (parsed.kind === "user") return parsed.id === requester.identity ? "own-user" : "other";
  if (parsed.kind === "team") return requester.teams.includes(parsed.id) ? "own-team" : "other";
  return "org"; // org scope is the shared baseline for all members
}
