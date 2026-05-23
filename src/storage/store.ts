// Storage layer — facts as markdown files in a data directory laid out by scope:
//   <root>/user/<id>/<slug>.md, <root>/team/<slug>/<slug>.md, <root>/org/<slug>/<slug>.md
// v0.1 reads/scans the tree directly; the SQLite index (Gap 09) lands in v0.2.

import { promises as fs } from "node:fs";
import * as path from "node:path";

import {
  createFact,
  parseFact,
  resolveFilename,
  serializeFact,
  slugifyTitle,
  type Fact,
  type NewFactInput,
} from "./fact";
import { parseScope, scopeRelativePath, type ScopeKind } from "../access/scope";

const SCOPE_KINDS: ScopeKind[] = ["user", "team", "org"];

export interface StoredFact {
  fact: Fact;
  /** Path relative to the store root, using forward slashes. */
  path: string;
}

export interface ScopeSummary {
  path: string;
  factCount: number;
  lastUpdated: string | null;
}

export class FactStore {
  constructor(private readonly root: string) {}

  /** Create a fact (server-set id/timestamps), write it to its scope folder, return it + its path. */
  async writeFact(input: NewFactInput): Promise<StoredFact> {
    return this.writeFactExact(createFact(input));
  }

  /** Write an already-created fact (id/timestamps set by the caller) to its scope folder. */
  async writeFactExact(fact: Fact): Promise<StoredFact> {
    if (!parseScope(fact.frontmatter.scope)) throw new Error(`Invalid scope: ${fact.frontmatter.scope}`);
    const rel = scopeRelativePath(fact.frontmatter.scope);
    const dir = path.join(this.root, rel);
    await fs.mkdir(dir, { recursive: true });
    const filename = resolveFilename(slugifyTitle(fact.frontmatter.title), await this.markdownIn(dir));
    await fs.writeFile(path.join(dir, filename), serializeFact(fact), "utf8");
    return { fact, path: `${rel}/${filename}` };
  }

  /** Find a fact by its frontmatter id (scans the tree). Returns null when absent. */
  async readFact(id: string): Promise<StoredFact | null> {
    for (const abs of await this.factFiles()) {
      const fact = parseFact(await fs.readFile(abs, "utf8"));
      if (fact.frontmatter.id === id) {
        return { fact, path: path.relative(this.root, abs).split(path.sep).join("/") };
      }
    }
    return null;
  }

  /** Every fact in the store (used by recall until the SQLite index exists). */
  async allFacts(): Promise<Fact[]> {
    const facts: Fact[] = [];
    for (const abs of await this.factFiles()) {
      facts.push(parseFact(await fs.readFile(abs, "utf8")));
    }
    return facts;
  }

  /** All scopes present, with fact counts and the most recent `updated` timestamp. */
  async listScopes(): Promise<ScopeSummary[]> {
    const summaries: ScopeSummary[] = [];
    for (const kind of SCOPE_KINDS) {
      const kindDir = path.join(this.root, kind);
      for (const id of await this.dirsIn(kindDir)) {
        const dir = path.join(kindDir, id);
        let factCount = 0;
        let lastUpdated: string | null = null;
        for (const name of await this.markdownIn(dir)) {
          const fact = parseFact(await fs.readFile(path.join(dir, name), "utf8"));
          factCount++;
          if (!lastUpdated || fact.frontmatter.updated > lastUpdated) {
            lastUpdated = fact.frontmatter.updated;
          }
        }
        summaries.push({ path: `${kind}/${id}`, factCount, lastUpdated });
      }
    }
    return summaries;
  }

  private async factFiles(): Promise<string[]> {
    const files: string[] = [];
    for (const kind of SCOPE_KINDS) {
      const kindDir = path.join(this.root, kind);
      for (const id of await this.dirsIn(kindDir)) {
        const dir = path.join(kindDir, id);
        for (const name of await this.markdownIn(dir)) files.push(path.join(dir, name));
      }
    }
    return files;
  }

  private async dirsIn(dir: string): Promise<string[]> {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      return entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return [];
    }
  }

  private async markdownIn(dir: string): Promise<string[]> {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      return entries.filter((e) => e.isFile() && e.name.endsWith(".md")).map((e) => e.name);
    } catch {
      return [];
    }
  }
}
