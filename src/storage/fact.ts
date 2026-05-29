// Gap 01 — Fact / file schema.
// One markdown file per fact: YAML frontmatter (machine-readable metadata) + a
// markdown body (human-readable content). Anchored to the Build Spec field rules.

import { ulid } from "ulid";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export const FACT_ID_PREFIX = "fct_";
export const MAX_TITLE_LENGTH = 80;

/** Machine-readable metadata stored as YAML frontmatter. */
export interface FactFrontmatter {
  /** ULID with an `fct_` prefix. Immutable once created. */
  id: string;
  /** Scope path, e.g. `user/alice@acme.com`, `team/payments`, `org/acme`. */
  scope: string;
  /** Required, <= 80 characters. */
  title: string;
  /** Identity in local-part@domain form. */
  author: string;
  /** ISO 8601 UTC. Server-set; mirrors `created` on first write. */
  created: string;
  updated: string;
  reviewed_by?: string[];
  /** Lowercase kebab-case. */
  tags?: string[];
  source?: string;
  /** Fact ids this fact replaces. */
  supersedes?: string[];
  /** ISO 8601 UTC, or null. Fact is excluded from retrieval after this date. */
  expires?: string | null;
}

export interface Fact {
  frontmatter: FactFrontmatter;
  body: string;
}

export interface ValidationIssue {
  field: string;
  message: string;
}

/** Generate a new, immutable fact id: `fct_` + ULID. */
export function generateFactId(): string {
  return `${FACT_ID_PREFIX}${ulid()}`;
}

/** `fct_` followed by a 26-char Crockford base32 ULID. */
export function isValidFactId(id: string): boolean {
  return /^fct_[0-9A-HJKMNP-TV-Z]{26}$/.test(id);
}

/** Render an ISO 8601 UTC timestamp without milliseconds (e.g. 2026-05-22T14:32:00Z). */
export function toIsoUtc(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function isIso8601Utc(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(value)) return false;
  return !Number.isNaN(Date.parse(value));
}

/** Slugify a title to lowercase kebab-case for use as a filename stem. */
export function slugifyTitle(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "untitled";
}

/**
 * Resolve a non-colliding `<slug>.md` filename within a scope folder,
 * appending `-2`, `-3`, ... when the base name is already taken.
 */
export function resolveFilename(slug: string, existing: Iterable<string>): string {
  const taken = new Set(existing);
  let candidate = `${slug}.md`;
  if (!taken.has(candidate)) return candidate;
  for (let i = 2; ; i++) {
    candidate = `${slug}-${i}.md`;
    if (!taken.has(candidate)) return candidate;
  }
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

/** Parse a markdown fact file into frontmatter + body. */
export function parseFact(markdown: string): Fact {
  const match = FRONTMATTER_RE.exec(markdown);
  if (!match) {
    throw new Error("Fact markdown is missing YAML frontmatter (--- ... ---).");
  }
  const frontmatter = parseYaml(match[1] ?? "") as FactFrontmatter;
  const body = (match[2] ?? "").replace(/^\n+/, "").trimEnd();
  return { frontmatter, body };
}

/** Serialize a fact to a markdown file (frontmatter + blank line + body + trailing newline). */
export function serializeFact(fact: Fact): string {
  const fm = stringifyYaml(fact.frontmatter).trimEnd();
  const body = fact.body.trim();
  return `---\n${fm}\n---\n\n${body}\n`;
}

export interface NewFactInput {
  scope: string;
  title: string;
  body: string;
  author: string;
  tags?: string[];
  source?: string;
  supersedes?: string[];
  /** Override the clock (tests); defaults to now. */
  now?: Date;
}

/** Build a new fact with server-controlled fields (id, created, updated) set. */
export function createFact(input: NewFactInput): Fact {
  const ts = toIsoUtc(input.now ?? new Date());
  const frontmatter: FactFrontmatter = {
    id: generateFactId(),
    scope: input.scope,
    title: input.title,
    author: input.author,
    created: ts,
    updated: ts,
  };
  if (input.tags?.length) frontmatter.tags = input.tags;
  if (input.source) frontmatter.source = input.source;
  if (input.supersedes?.length) frontmatter.supersedes = input.supersedes;
  return { frontmatter, body: input.body };
}

const REQUIRED_FIELDS: (keyof FactFrontmatter)[] = [
  "id",
  "scope",
  "title",
  "author",
  "created",
  "updated",
];

/** Validate frontmatter against the Build Spec field rules. Returns an empty array when valid. */
export function validateFrontmatter(fm: Partial<FactFrontmatter>): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (const field of REQUIRED_FIELDS) {
    const value = fm[field];
    if (value === undefined || value === null || value === "") {
      issues.push({ field, message: `${field} is required` });
    }
  }

  if (fm.id !== undefined && !isValidFactId(fm.id)) {
    issues.push({ field: "id", message: "id must be 'fct_' followed by a 26-char ULID" });
  }
  if (fm.title !== undefined && fm.title.length > MAX_TITLE_LENGTH) {
    issues.push({ field: "title", message: `title must be <= ${MAX_TITLE_LENGTH} characters` });
  }
  if (fm.author !== undefined && fm.author !== "" && !/^[^@\s]+@[^@\s]+$/.test(fm.author)) {
    issues.push({ field: "author", message: "author must be in local-part@domain form" });
  }
  for (const field of ["created", "updated"] as const) {
    const value = fm[field];
    if (value !== undefined && value !== "" && !isIso8601Utc(value)) {
      issues.push({ field, message: `${field} must be ISO 8601 UTC` });
    }
  }
  if (fm.tags) {
    for (const tag of fm.tags) {
      if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(tag)) {
        issues.push({ field: "tags", message: `tag '${tag}' must be lowercase kebab-case` });
      }
    }
  }
  return issues;
}

/** A set of tag additions/removals to apply to a fact. */
export interface TagChange {
  add: string[];
  remove: string[];
}

/**
 * Outcome of {@link applyTagChanges}:
 *   • `ok`         — the tag set changed; `frontmatter` is the next frontmatter (tags sorted, the
 *                    field dropped when empty). `before`/`after` are the sorted tag sets.
 *   • `no-change`  — the resulting set equals the current one; nothing to write.
 *   • `invalid`    — a resulting tag fails the kebab-case rule; `issues` lists the offenders.
 */
export type TagApplyResult =
  | { status: "ok"; frontmatter: FactFrontmatter; before: string[]; after: string[] }
  | { status: "no-change"; tags: string[] }
  | { status: "invalid"; issues: ValidationIssue[] };

/**
 * Pure tag-set transform shared by the web tag editor (`src/server/tagFact.ts`) and the CLI
 * (`krimto tag`). Adds then removes, dedupes, sorts. Does NOT touch `updated` — the caller bumps
 * it before persisting — and never mutates the input frontmatter.
 */
export function applyTagChanges(fm: FactFrontmatter, change: TagChange): TagApplyResult {
  const beforeSet = new Set(fm.tags ?? []);
  const afterSet = new Set(beforeSet);
  for (const t of change.add) afterSet.add(t);
  for (const t of change.remove) afterSet.delete(t);

  const before = [...beforeSet].sort();
  const after = [...afterSet].sort();
  const unchanged = before.length === after.length && before.every((t, i) => t === after[i]);
  if (unchanged) return { status: "no-change", tags: before };

  const next: FactFrontmatter = { ...fm };
  if (after.length === 0) delete next.tags;
  else next.tags = after;

  const issues = validateFrontmatter(next).filter((i) => i.field === "tags");
  if (issues.length > 0) return { status: "invalid", issues };
  return { status: "ok", frontmatter: next, before, after };
}
