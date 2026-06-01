// `krimto import <path>` — batch-import facts from a markdown file into the caller's personal
// scope, through the canonical `krimtoWrite` pipeline (server-set id/timestamps, SQLite index +
// markdown store + git stage). Idempotent: a second run of the same file imports zero new facts,
// deduped by a content hash of (title + body). Krimto's own injected rule block (the
// `<!-- krimto:start -->` ... `<!-- krimto:end -->` markers it writes into CLAUDE.md/AGENTS.md)
// is stripped before parsing, so importing a project's own rules file never re-imports the rule.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { runImport, parseFacts, hashFact } from "../../src/cli/import";
import { ruleBlock } from "../../src/agentRule";
import { buildCliContext } from "../../src/cli/cliRuntime";

let dataDir: string;
const IDENTITY = "alice@acme.com";

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "krimto-import-"));
});
afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

/** Count `.md` files under the caller's personal scope folder. */
async function personalFactFiles(): Promise<string[]> {
  const dir = path.join(dataDir, "user", IDENTITY);
  try {
    const names = await fs.readdir(dir);
    return names.filter((n) => n.endsWith(".md"));
  } catch {
    return [];
  }
}

describe("parseFacts", () => {
  it("splits on H1 headers into title + body pairs", () => {
    const facts = parseFacts("# Fact 1\n\nBody 1\n\n# Fact 2\n\nBody 2\n");
    expect(facts).toEqual([
      { title: "Fact 1", body: "Body 1" },
      { title: "Fact 2", body: "Body 2" },
    ]);
  });

  it("strips the Krimto rule block before parsing", () => {
    const markdown = `# Real 1\n\nBody 1\n\n${ruleBlock()}\n\n# Real 2\n\nBody 2\n`;
    const facts = parseFacts(markdown);
    expect(facts.map((f) => f.title)).toEqual(["Real 1", "Real 2"]);
    // The injected rule's own "# Krimto memory" heading must NOT become a fact.
    expect(facts.some((f) => /Krimto memory/i.test(f.title))).toBe(false);
  });

  it("ignores a header with no body", () => {
    const facts = parseFacts("# Title only\n\n# Has body\n\nthe body\n");
    expect(facts).toEqual([{ title: "Has body", body: "the body" }]);
  });

  it("returns nothing for content with no headers", () => {
    expect(parseFacts("just prose, no headers")).toEqual([]);
  });
});

describe("hashFact", () => {
  it("is stable for identical (title, body) and differs otherwise", () => {
    expect(hashFact("T", "B")).toBe(hashFact("T", "B"));
    expect(hashFact("T", "B")).not.toBe(hashFact("T", "B2"));
    expect(hashFact("T", "B")).not.toBe(hashFact("T2", "B"));
  });
});

describe("krimto import", () => {
  it("imports facts from a markdown file into the caller's personal scope", async () => {
    const file = path.join(dataDir, "facts.md");
    await fs.writeFile(file, "# Fact 1\n\nBody 1\n\n# Fact 2\n\nBody 2\n");

    const result = await runImport({ dataDir, identity: IDENTITY, filePath: file });

    expect(result.status).toBe("ok");
    expect(result.imported).toBe(2);
    expect(result.skipped).toBe(0);
    expect(await personalFactFiles()).toHaveLength(2);
  });

  it("writes through the canonical pipeline (server-set id + timestamps, indexed)", async () => {
    const file = path.join(dataDir, "facts.md");
    await fs.writeFile(file, "# Indexed fact\n\nthe body text\n");
    await runImport({ dataDir, identity: IDENTITY, filePath: file });

    const { ctx, close } = await buildCliContext({ dataDir, identity: IDENTITY, readOnly: true });
    try {
      const facts = ctx.index.listFacts([`user/${IDENTITY}`]);
      expect(facts).toHaveLength(1);
      const fact = ctx.index.getFact(facts[0]!.id);
      expect(fact).not.toBeNull();
      expect(fact!.frontmatter.id).toMatch(/^fct_/); // server-generated id
      expect(fact!.frontmatter.author).toBe(IDENTITY);
      expect(fact!.frontmatter.scope).toBe(`user/${IDENTITY}`);
      expect(fact!.frontmatter.created).toMatch(/Z$/); // server-generated timestamp
    } finally {
      await close();
    }
  });

  it("is idempotent — a second run of the same file imports zero facts", async () => {
    const file = path.join(dataDir, "facts.md");
    await fs.writeFile(file, "# Test\n\nBody\n");

    const first = await runImport({ dataDir, identity: IDENTITY, filePath: file });
    expect(first.imported).toBe(1);
    expect(first.skipped).toBe(0);

    const second = await runImport({ dataDir, identity: IDENTITY, filePath: file });
    expect(second.imported).toBe(0);
    expect(second.skipped).toBe(1);
    // No duplicate file written on the second pass.
    expect(await personalFactFiles()).toHaveLength(1);
  });

  it("excludes Krimto's own injected rule block", async () => {
    const file = path.join(dataDir, "CLAUDE.md");
    await fs.writeFile(
      file,
      `# Real 1\n\nBody 1\n\n${ruleBlock()}\n\n# Real 2\n\nBody 2\n`,
    );

    const result = await runImport({ dataDir, identity: IDENTITY, filePath: file });
    expect(result.status).toBe("ok");
    expect(result.imported).toBe(2); // not 3 — the rule's own heading is skipped
  });

  it("dedupes identical facts within a single file", async () => {
    const file = path.join(dataDir, "facts.md");
    await fs.writeFile(file, "# Same\n\nidentical body\n\n# Same\n\nidentical body\n");
    const result = await runImport({ dataDir, identity: IDENTITY, filePath: file });
    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(1);
  });

  it("returns not_found for a missing file", async () => {
    const result = await runImport({
      dataDir,
      identity: IDENTITY,
      filePath: path.join(dataDir, "no-such-file.md"),
    });
    expect(result.status).toBe("not_found");
    expect(result.imported ?? 0).toBe(0);
  });

  it("reports when the file has no importable facts", async () => {
    const file = path.join(dataDir, "empty.md");
    await fs.writeFile(file, "just prose, nothing to import\n");
    const result = await runImport({ dataDir, identity: IDENTITY, filePath: file });
    expect(result.status).toBe("ok");
    expect(result.imported).toBe(0);
    expect(result.skipped).toBe(0);
  });
});
