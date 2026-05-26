// Tests for the v0.2.17-2 per-note CLI commands: `notes`, `edit`, `mv`, `supersede`, `tag`.
// All five share the `buildCliContext` helper, so a single file with one describe per command
// keeps the setup compact. Each test seeds facts via `krimtoWrite` (the canonical write path)
// so the SQLite index + markdown directory + git repo are consistent — same shape production
// code reaches.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";

import { buildCliContext, scopeLabel } from "../../src/cli/cliRuntime";
import { runEdit } from "../../src/cli/edit";
import { runMv } from "../../src/cli/mv";
import { runNotes } from "../../src/cli/notes";
import { runSupersede } from "../../src/cli/supersedeCmd";
import { runTag } from "../../src/cli/tag";
import { krimtoWrite } from "../../src/server/tools";
import {
  parseFact,
  serializeFact,
  type Fact,
} from "../../src/storage/fact";

let dataDir: string;
beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "krimto-per-note-"));
});
afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

/** Seed a fact in the personal scope via the canonical write pipeline. Returns the new id. */
async function seedFact(
  identity: string,
  title: string,
  body: string,
  scope = "user/me",
): Promise<string> {
  const { ctx, close } = await buildCliContext({ dataDir, identity, readOnly: true });
  try {
    const res = await krimtoWrite(ctx, { scope, title, body });
    return res.id;
  } finally {
    await close();
  }
}

describe("krimto notes", () => {
  it("lists nothing helpful when the store is empty", async () => {
    const res = await runNotes({ dataDir, identity: "alice@acme.com" });
    expect(res.message).toContain("No notes yet");
    expect(res.message).toContain("remember");
  });

  it("groups by plain-English scope label", async () => {
    await seedFact("alice@acme.com", "pnpm not npm", "we use pnpm");
    await seedFact("alice@acme.com", "staging resets sundays", "midnight UTC");
    const res = await runNotes({ dataDir, identity: "alice@acme.com" });
    expect(res.message).toContain("━━ Just me (2 notes) ━━");
    expect(res.message).toContain("pnpm not npm");
    expect(res.message).toContain("staging resets sundays");
    expect(res.message).toContain("saved by you");
    expect(res.message).toMatch(/Daily commands.*edit.*mv.*supersede.*tag/);
  });

  it("renders a search query through krimtoRecall", async () => {
    await seedFact("alice@acme.com", "Stripe webhook signing", "use lib/stripe/verify.ts");
    await seedFact("alice@acme.com", "unrelated note", "nothing about stripe here");
    const res = await runNotes({
      dataDir,
      identity: "alice@acme.com",
      query: "stripe webhook",
    });
    expect(res.message).toContain('Search: "stripe webhook"');
    expect(res.message).toContain("Stripe webhook signing");
    expect(res.message).toMatch(/score \d/);
  });

  it("returns a helpful 'no matches' block when the query hits nothing", async () => {
    await seedFact("alice@acme.com", "real fact", "body");
    const res = await runNotes({
      dataDir,
      identity: "alice@acme.com",
      query: "xyz-no-such-thing",
    });
    expect(res.message).toContain("No matches");
  });
});

describe("krimto edit", () => {
  it("bumps `updated` and reindexes after the user saves a new body", async () => {
    const id = await seedFact("alice@acme.com", "pnpm not npm", "old body");
    const before = (await openFactFile(dataDir, id))!;

    // Sleep 1s so the `updated` timestamp moves visibly (ISO seconds resolution).
    await new Promise((r) => setTimeout(r, 1000));

    const res = await runEdit({
      dataDir,
      identity: "alice@acme.com",
      id,
      editorImpl: async (file) => {
        const text = await fs.readFile(file, "utf8");
        await fs.writeFile(file, text.replace("old body", "new body — updated"), "utf8");
      },
    });
    expect(res.status).toBe("ok");
    expect(res.message).toContain("Saved");

    const after = (await openFactFile(dataDir, id))!;
    expect(after.fact.body).toBe("new body — updated");
    expect(after.fact.frontmatter.updated).not.toBe(before.fact.frontmatter.updated);
    expect(after.fact.frontmatter.id).toBe(before.fact.frontmatter.id); // id preserved
  });

  it("reports 'no-change' when the user saves the file unchanged", async () => {
    const id = await seedFact("alice@acme.com", "x", "body");
    const res = await runEdit({
      dataDir,
      identity: "alice@acme.com",
      id,
      editorImpl: async () => {}, // touch nothing
    });
    expect(res.status).toBe("no-change");
  });

  it("returns not_found for an unknown id", async () => {
    const res = await runEdit({
      dataDir,
      identity: "alice@acme.com",
      id: "fct_doesnt-exist",
      editorImpl: async () => {},
    });
    expect(res.status).toBe("not_found");
  });

  it("restores immutable fields if the user edits them in the file", async () => {
    const id = await seedFact("alice@acme.com", "title", "body");
    await runEdit({
      dataDir,
      identity: "alice@acme.com",
      id,
      editorImpl: async (file) => {
        // Swap the id and created in the frontmatter — should be silently restored.
        const text = await fs.readFile(file, "utf8");
        await fs.writeFile(
          file,
          text
            .replace(/^id:.*$/m, "id: fct_HACKED_ID")
            .replace(/^created:.*$/m, "created: 1999-01-01T00:00:00Z")
            .replace("body", "body edited"),
          "utf8",
        );
      },
    });
    const after = (await openFactFile(dataDir, id))!;
    expect(after.fact.frontmatter.id).toBe(id); // restored
    expect(after.fact.frontmatter.created).not.toBe("1999-01-01T00:00:00Z"); // restored
    expect(after.fact.body).toBe("body edited"); // body change kept
  });
});

describe("krimto mv", () => {
  beforeEach(async () => {
    // Seed members.yaml so alice can write to team/backend.
    await fs.mkdir(path.join(dataDir, ".krimto"), { recursive: true });
    await fs.writeFile(
      path.join(dataDir, ".krimto", "members.yaml"),
      `org:\n  slug: acme\n  admins: [alice@acme.com]\nusers:\n  - email: alice@acme.com\nteams:\n  - slug: backend\n    members: [alice@acme.com]\n`,
      "utf8",
    );
  });

  it("moves a fact between scopes, preserves the id, bumps `updated`", async () => {
    const id = await seedFact("alice@acme.com", "pnpm", "we use pnpm", "user/alice@acme.com");
    const before = (await openFactFile(dataDir, id))!;
    await new Promise((r) => setTimeout(r, 1000));

    const res = await runMv({
      dataDir,
      identity: "alice@acme.com",
      id,
      newScope: "team/backend",
    });
    expect(res.status).toBe("ok");

    const after = (await openFactFile(dataDir, id))!;
    expect(after.fact.frontmatter.scope).toBe("team/backend");
    expect(after.fact.frontmatter.id).toBe(id);
    expect(after.fact.frontmatter.updated).not.toBe(before.fact.frontmatter.updated);
    expect(after.path.startsWith("team/backend/")).toBe(true);

    // Old file should be gone.
    await expect(
      fs.access(path.join(dataDir, before.path)),
    ).rejects.toThrow();
  });

  it("refuses an invalid scope", async () => {
    const id = await seedFact("alice@acme.com", "x", "y", "user/alice@acme.com");
    const res = await runMv({
      dataDir,
      identity: "alice@acme.com",
      id,
      newScope: "weird format",
    });
    expect(res.status).toBe("invalid_scope");
  });

  it("returns no-change when moving to the same scope", async () => {
    const id = await seedFact("alice@acme.com", "x", "y", "user/alice@acme.com");
    const res = await runMv({
      dataDir,
      identity: "alice@acme.com",
      id,
      newScope: "user/alice@acme.com",
    });
    expect(res.status).toBe("no-change");
  });

  it("user/me alias resolves to the caller's personal scope", async () => {
    const id = await seedFact("alice@acme.com", "x", "y", "team/backend");
    const res = await runMv({
      dataDir,
      identity: "alice@acme.com",
      id,
      newScope: "user/me",
    });
    expect(res.status).toBe("ok");
    const after = (await openFactFile(dataDir, id))!;
    expect(after.fact.frontmatter.scope).toBe("user/alice@acme.com");
  });
});

describe("krimto supersede", () => {
  it("replaces a fact with a new version (new id, old kept in index)", async () => {
    const oldId = await seedFact("alice@acme.com", "deploys", "deploys are Tuesdays at 10am");
    const res = await runSupersede({
      dataDir,
      identity: "alice@acme.com",
      id: oldId,
      newBody: "deploys are now Wednesdays at 09:00 UTC",
      reason: "updated cadence",
    });
    expect(res.status).toBe("ok");
    expect(res.message).toContain("Superseded");
    expect(res.message).toContain("New id:");

    // Verify both ids exist in the index (the old one is excluded from recall by supersededIds).
    const { ctx, close } = await buildCliContext({
      dataDir,
      identity: "alice@acme.com",
      readOnly: true,
    });
    try {
      const old = ctx.index.getFact(oldId);
      expect(old).not.toBeNull();
    } finally {
      await close();
    }
  });

  it("returns no-change when the body is identical", async () => {
    const id = await seedFact("alice@acme.com", "x", "same body");
    const res = await runSupersede({
      dataDir,
      identity: "alice@acme.com",
      id,
      newBody: "same body",
    });
    expect(res.status).toBe("no-change");
  });
});

describe("krimto tag", () => {
  it("adds and removes tags via +tag / -tag specs", async () => {
    const id = await seedFact("alice@acme.com", "x", "y");
    const res1 = await runTag({
      dataDir,
      identity: "alice@acme.com",
      id,
      changes: ["+rule", "+ci"],
    });
    expect(res1.status).toBe("ok");
    let after = (await openFactFile(dataDir, id))!;
    expect(after.fact.frontmatter.tags).toEqual(["ci", "rule"]);

    const res2 = await runTag({
      dataDir,
      identity: "alice@acme.com",
      id,
      changes: ["-ci", "+new-tag"],
    });
    expect(res2.status).toBe("ok");
    after = (await openFactFile(dataDir, id))!;
    expect(after.fact.frontmatter.tags).toEqual(["new-tag", "rule"]);
  });

  it("rejects invalid tag spec format", async () => {
    const id = await seedFact("alice@acme.com", "x", "y");
    const res = await runTag({
      dataDir,
      identity: "alice@acme.com",
      id,
      changes: ["badtag"], // missing +/- prefix
    });
    expect(res.status).toBe("invalid_change");
  });

  it("rejects non-kebab-case tags during frontmatter validation", async () => {
    const id = await seedFact("alice@acme.com", "x", "y");
    const res = await runTag({
      dataDir,
      identity: "alice@acme.com",
      id,
      changes: ["+UPPERCASE"],
    });
    expect(res.status).toBe("invalid_change");
    expect(res.message).toContain("kebab-case");
  });

  it("no-change when add/remove leaves the tag set unchanged", async () => {
    const id = await seedFact("alice@acme.com", "x", "y");
    // Add a tag first.
    await runTag({ dataDir, identity: "alice@acme.com", id, changes: ["+rule"] });
    // Now try to remove a tag that isn't there.
    const res = await runTag({
      dataDir,
      identity: "alice@acme.com",
      id,
      changes: ["-nonexistent"],
    });
    expect(res.status).toBe("no-change");
  });
});

describe("scopeLabel", () => {
  it("renders 'Just me' for the viewer's own personal scope", () => {
    const membership = parseYaml(
      `org:\n  slug: acme\nteams:\n  - slug: backend\n    name: Backend team\n`,
    ) as { org: { slug: string }; teams: { slug: string; name: string; members: string[]; leads: string[] }[] };
    const full = { org: { slug: "acme", admins: [] as string[] }, teams: membership.teams.map((t) => ({ ...t, members: [], leads: [] })), users: [] };
    expect(scopeLabel("user/alice@acme.com", "alice@acme.com", full)).toBe("Just me");
    expect(scopeLabel("user/bob@acme.com", "alice@acme.com", full)).toBe("bob@acme.com");
    expect(scopeLabel("team/backend", "alice@acme.com", full)).toBe("Backend team");
    expect(scopeLabel("team/unknown", "alice@acme.com", full)).toBe("team/unknown");
    expect(scopeLabel("org/acme", "alice@acme.com", full)).toBe("org/acme");
  });
});

// --- helpers ---------------------------------------------------------------

async function openFactFile(dataDir: string, id: string): Promise<{ fact: Fact; path: string } | null> {
  for (const kind of ["user", "team", "org"]) {
    const kindDir = path.join(dataDir, kind);
    let entries: string[];
    try {
      entries = await fs.readdir(kindDir);
    } catch {
      continue;
    }
    for (const subdir of entries) {
      const sd = path.join(kindDir, subdir);
      let files: string[];
      try {
        files = await fs.readdir(sd);
      } catch {
        continue;
      }
      for (const f of files) {
        if (!f.endsWith(".md")) continue;
        const text = await fs.readFile(path.join(sd, f), "utf8");
        const fact = parseFact(text);
        if (fact.frontmatter.id === id) {
          return { fact, path: path.relative(dataDir, path.join(sd, f)) };
        }
      }
    }
  }
  return null;
}

// silence "unused import" warning for the helper-only re-export
void serializeFact;
