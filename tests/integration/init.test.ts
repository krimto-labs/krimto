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

  it("returns CLAUDE.md when .specstory/ exists (Claude Code's transcript dir)", async () => {
    await fs.mkdir(path.join(dir, ".specstory"));
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

describe("runInit auto-detection (G4 + v0.2.16 safer default)", () => {
  it("DEFAULT writes all 4 files even when only `.cursor/` is present — safer than guessing", async () => {
    // This is the smoke-5 failure mode: user has `.cursor/` but is actually using Claude Code.
    // Default behavior must write CLAUDE.md too so the rule reaches the active editor.
    await fs.mkdir(path.join(dir, ".cursor"));
    const res = await runInit(dir);
    expect(res.detected).toBe(false);
    expect(res.written.sort()).toEqual([...INIT_TARGETS].sort());
  });

  it("--minimal honors editor signals and writes only matching files", async () => {
    await fs.mkdir(path.join(dir, ".cursor"));
    const res = await runInit(dir, { minimal: true });
    expect(res.detected).toBe(true);
    expect(res.written).toEqual([path.join(".cursor", "rules", "krimto.mdc")]);
    await expect(fs.access(path.join(dir, "CLAUDE.md"))).rejects.toThrow();
  });

  it("--minimal still writes everything when there are no signals (safe fallback)", async () => {
    const res = await runInit(dir, { minimal: true });
    expect(res.detected).toBe(false);
    expect(res.written.sort()).toEqual([...INIT_TARGETS].sort());
  });

  it("--all (legacy flag, still supported) writes everything", async () => {
    await fs.mkdir(path.join(dir, ".cursor"));
    const res = await runInit(dir, { all: true });
    expect(res.written.sort()).toEqual([...INIT_TARGETS].sort());
  });

  it("`.specstory/` is detected as a Claude Code signal (fixes the smoke-5 false-negative)", async () => {
    // Project has BOTH .cursor/ and .specstory/ — the smoke-5 scenario where Claude Code is the
    // active editor. With --minimal, BOTH editor files must be written.
    await fs.mkdir(path.join(dir, ".cursor"));
    await fs.mkdir(path.join(dir, ".specstory"));
    const res = await runInit(dir, { minimal: true });
    expect(res.detected).toBe(true);
    expect(res.written).toContain("CLAUDE.md"); // ← .specstory/ → Claude Code signal
    expect(res.written).toContain(path.join(".cursor", "rules", "krimto.mdc"));
  });
});

describe("krimto init (bin dispatch)", () => {
  it("`node bin/krimto.mjs init` writes the rule in the current directory", async () => {
    await exec(process.execPath, [BIN, "init"], { cwd: dir });
    expect(await read("AGENTS.md")).toContain("krimto_recall");
  }, 30000);

  it("prints the AUTO MODE confirmation + next steps + how to undo", async () => {
    const { stderr } = await exec(process.execPath, [BIN, "init"], { cwd: dir });
    expect(stderr).toContain("AUTO MODE on");
    expect(stderr).toContain("Next steps");
    expect(stderr).toContain("To undo:");
    expect(stderr).toContain("<!-- krimto:start -->");
  }, 30000);

  it("surfaces `krimto uninit` prominently on success", async () => {
    const { stderr } = await exec(process.execPath, [BIN, "init"], { cwd: dir });
    expect(stderr).toContain("npx @krimto-labs/krimto uninit");
  }, 30000);

  it("mentions `krimto uninit` on the no-op path too (so a re-run discovers it)", async () => {
    // First run writes the rule. Second run is a no-op.
    await exec(process.execPath, [BIN, "init"], { cwd: dir });
    const { stderr } = await exec(process.execPath, [BIN, "init"], { cwd: dir });
    expect(stderr).toContain("Already in AUTO MODE");
    expect(stderr).toContain("npx @krimto-labs/krimto uninit");
  }, 30000);
});
