// `krimto init` writes the always-use-Krimto standing rule into a project's agent rules files —
// the fix for the discovery problem (agents otherwise route "remember X" to their built-in memory).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { detectEditorTargets, runInit, INIT_TARGETS } from "../../src/cli/init";

const exec = promisify(execFile);
const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../bin/krimto.mjs");

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "krimto-init-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});
const read = (rel: string): Promise<string> => fs.readFile(path.join(dir, rel), "utf8");

describe("runInit", () => {
  it("writes the standing rule into the standard agent rules files", async () => {
    const res = await runInit(dir);
    expect(res.written).toContain("CLAUDE.md");
    expect(res.written).toContain("AGENTS.md");
    expect(await read("CLAUDE.md")).toContain("krimto_recall");
    expect(await read(path.join(".cursor", "rules", "krimto.mdc"))).toContain("krimto_write");
  });

  it("preserves existing content and is idempotent", async () => {
    await fs.writeFile(path.join(dir, "CLAUDE.md"), "# Team rules\n- use pnpm\n", "utf8");
    await runInit(dir);
    const after1 = await read("CLAUDE.md");
    expect(after1).toContain("# Team rules"); // preserved
    expect(after1).toContain("- use pnpm");
    expect(after1).toContain("krimto_recall"); // added

    const res2 = await runInit(dir); // second run
    expect(res2.written).not.toContain("CLAUDE.md"); // no-op — already up to date
    expect(await read("CLAUDE.md")).toBe(after1);
    expect((after1.match(/<!-- krimto:start -->/g) ?? []).length).toBe(1);
  });
});

describe("detectEditorTargets (G4)", () => {
  it("returns the matching target when CLAUDE.md exists", async () => {
    await fs.writeFile(path.join(dir, "CLAUDE.md"), "# existing\n");
    expect(await detectEditorTargets(dir)).toEqual(["CLAUDE.md"]);
  });

  it("returns the cursor target when .cursor/ exists", async () => {
    await fs.mkdir(path.join(dir, ".cursor"));
    const targets = await detectEditorTargets(dir);
    expect(targets).toEqual([path.join(".cursor", "rules", "krimto.mdc")]);
  });

  it("returns the Gemini target when gemini-extension.json exists", async () => {
    await fs.writeFile(path.join(dir, "gemini-extension.json"), "{}");
    expect(await detectEditorTargets(dir)).toEqual(["GEMINI.md"]);
  });

  it("returns multiple targets when multiple signals match", async () => {
    await fs.writeFile(path.join(dir, "CLAUDE.md"), "# x");
    await fs.mkdir(path.join(dir, ".cursor"));
    const targets = await detectEditorTargets(dir);
    expect(targets).toContain("CLAUDE.md");
    expect(targets).toContain(path.join(".cursor", "rules", "krimto.mdc"));
    expect(targets).not.toContain("GEMINI.md");
  });

  it("returns an empty list when no signals present (caller falls back to all)", async () => {
    expect(await detectEditorTargets(dir)).toEqual([]);
  });
});

describe("runInit auto-detection (G4)", () => {
  it("writes only the matching file when one editor signal is present", async () => {
    await fs.mkdir(path.join(dir, ".cursor"));
    const res = await runInit(dir);
    expect(res.detected).toBe(true);
    expect(res.written).toEqual([path.join(".cursor", "rules", "krimto.mdc")]);
    expect(res.considered).toEqual([path.join(".cursor", "rules", "krimto.mdc")]);
    // Other targets must NOT exist
    await expect(fs.access(path.join(dir, "CLAUDE.md"))).rejects.toThrow();
    await expect(fs.access(path.join(dir, "AGENTS.md"))).rejects.toThrow();
    await expect(fs.access(path.join(dir, "GEMINI.md"))).rejects.toThrow();
  });

  it("writes everything when no signals are present (safe default)", async () => {
    const res = await runInit(dir);
    expect(res.detected).toBe(false);
    expect(res.written.sort()).toEqual([...INIT_TARGETS].sort());
  });

  it("writes everything when --all is forced even if signals are present", async () => {
    await fs.mkdir(path.join(dir, ".cursor"));
    const res = await runInit(dir, { all: true });
    expect(res.detected).toBe(false); // legacy mode, not detection
    expect(res.written.sort()).toEqual([...INIT_TARGETS].sort());
  });
});

describe("krimto init (bin dispatch)", () => {
  it("`node bin/krimto.mjs init` writes the rule in the current directory", async () => {
    await exec(process.execPath, [BIN, "init"], { cwd: dir });
    expect(await read("AGENTS.md")).toContain("krimto_recall");
  }, 30000);

  it("prints what changed AND how to remove the rule", async () => {
    const { stderr } = await exec(process.execPath, [BIN, "init"], { cwd: dir });
    expect(stderr).toContain("What changed");
    expect(stderr).toContain("To remove the rule");
    expect(stderr).toContain("<!-- krimto:start -->");
    expect(stderr).toContain("<!-- krimto:end -->");
  }, 30000);
});
