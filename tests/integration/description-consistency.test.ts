import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");

async function json(rel: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(path.join(root, rel), "utf8"));
}

// One canonical positioning sentence must appear byte-identical across every
// public surface, so the category framing compounds instead of blurring.
// (See the standardization rationale in docs/north-star-b-submissions.md.)
describe("description consistency", () => {
  it("every manifest description matches package.json's, byte-for-byte", async () => {
    const canonical = (await json("package.json")).description as string;
    expect(canonical, "package.json description missing").toMatch(
      /team memory layer for AI coding agents/,
    );

    const plugin = (await json(".claude-plugin/plugin.json")).description;
    const gemini = (await json("gemini-extension.json")).description;
    const market = await json(".claude-plugin/marketplace.json");
    const marketTop = market.description;
    const marketPlugin = (market.plugins as Array<{ description?: string }>)[0]
      ?.description;

    for (const [label, value] of [
      ["plugin.json", plugin],
      ["gemini-extension.json", gemini],
      ["marketplace.json (top)", marketTop],
      ["marketplace.json (plugin entry)", marketPlugin],
    ] as const) {
      expect(value, `${label} description drifted from package.json`).toBe(
        canonical,
      );
    }
  });

  it("the README headline carries the same canonical sentence", async () => {
    const canonical = (await json("package.json")).description as string;
    const readme = await fs.readFile(path.join(root, "README.md"), "utf8");
    expect(readme, "README headline does not match canonical description").toContain(
      canonical,
    );
  });
});
