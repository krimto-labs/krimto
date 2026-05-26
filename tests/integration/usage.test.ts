// `krimto usage` — the long-form guide. Verifies every tool name is documented and that both
// modes (DEFAULT and AUTO) show up with chat examples, so the surface can't silently regress.

import { describe, expect, it } from "vitest";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { formatUsage } from "../../src/cli/usage";
import { MCP_TOOL_NAMES } from "../../src/server/connect";

const exec = promisify(execFile);
const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../bin/krimto.mjs");

describe("formatUsage", () => {
  it("documents every registered MCP tool by name", () => {
    const out = formatUsage("0.2.7");
    for (const tool of MCP_TOOL_NAMES) {
      expect(out).toContain(tool);
    }
  });

  it("covers both modes with chat examples", () => {
    const out = formatUsage("0.2.7");
    expect(out).toContain("DEFAULT MODE");
    expect(out).toContain("AUTO MODE");
    // A DEFAULT-mode example (explicit "Use krimto" prefix):
    expect(out).toContain('"Use krimto to remember');
    // An AUTO-mode example (natural phrasing, no Krimto prefix):
    expect(out).toContain('"Remember our');
    // Scope guidance (user > team > org):
    expect(out).toContain("user/me");
    expect(out).toContain("team/<slug>");
    expect(out).toContain("org/<slug>");
    expect(out).toContain("Precedence");
  });

  it("ends with discoverable next steps pointing at the related commands", () => {
    const out = formatUsage("0.2.7");
    expect(out).toContain("krimto init");
    expect(out).toContain("krimto uninit");
    expect(out).toContain("krimto connect");
  });
});

describe("krimto usage (bin dispatch)", () => {
  it("`node bin/krimto.mjs usage` prints the guide to stdout", async () => {
    const { stdout } = await exec(process.execPath, [BIN, "usage"]);
    expect(stdout).toContain("The 5 tools");
    expect(stdout).toContain("krimto_write");
    expect(stdout).toContain("krimto_recall");
    expect(stdout).toContain("DEFAULT MODE");
    expect(stdout).toContain("AUTO MODE");
  }, 30000);
});
