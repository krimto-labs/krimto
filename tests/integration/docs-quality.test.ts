import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { clientMatrix } from "../../src/cli/clientMatrix";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");

describe("docs quality", () => {
  it("README and ROADMAP have no links into gitignored docs/", async () => {
    for (const f of ["README.md", "ROADMAP.md"]) {
      const text = await fs.readFile(path.join(root, f), "utf8");
      expect(text, `${f} links into gitignored docs/`).not.toMatch(/\]\(docs\//);
    }
  });

  it("the README client matrix matches the code", async () => {
    const readme = await fs.readFile(path.join(root, "README.md"), "utf8");
    for (const row of clientMatrix()) {
      expect(readme, `README missing ${row.label}`).toContain(row.label);
    }
    expect(readme).toMatch(/auto-connects/);
    expect(readme).toMatch(/manual snippet/);
  });
});
