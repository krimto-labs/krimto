import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");

async function readVersion(rel: string): Promise<string> {
  const text = await fs.readFile(path.join(root, rel), "utf8");
  return (JSON.parse(text) as { version?: string }).version ?? "";
}

describe("version consistency", () => {
  it("plugin manifests match the package version (no drift)", async () => {
    const pkg = await readVersion("package.json");
    expect(pkg, "package.json missing version").toMatch(/^\d+\.\d+\.\d+/);

    for (const rel of [".claude-plugin/plugin.json", "gemini-extension.json"]) {
      const v = await readVersion(rel);
      expect(v, `${rel} version (${v}) != package.json version (${pkg})`).toBe(pkg);
    }
  });

  it("the marketplace plugin entry version matches the package version", async () => {
    const pkg = await readVersion("package.json");
    const text = await fs.readFile(
      path.join(root, ".claude-plugin/marketplace.json"),
      "utf8",
    );
    const market = JSON.parse(text) as {
      plugins?: Array<{ name?: string; version?: string }>;
    };
    const krimto = market.plugins?.find((p) => p.name === "krimto");
    expect(krimto, "marketplace.json has no 'krimto' plugin entry").toBeTruthy();
    expect(
      krimto?.version,
      `marketplace krimto version (${krimto?.version}) != package version (${pkg})`,
    ).toBe(pkg);
  });
});
