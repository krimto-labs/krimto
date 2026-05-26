// `krimto uninit` cleanly reverses `krimto init` — the AUTO MODE → DEFAULT MODE switch.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { runInit } from "../../src/cli/init";
import { runUninit } from "../../src/cli/uninit";

const exec = promisify(execFile);
const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../bin/krimto.mjs");

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "krimto-uninit-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});
const exists = async (rel: string): Promise<boolean> => {
  try {
    await fs.access(path.join(dir, rel));
    return true;
  } catch {
    return false;
  }
};
const read = (rel: string): Promise<string> => fs.readFile(path.join(dir, rel), "utf8");

describe("runUninit", () => {
  it("deletes files that init created from scratch", async () => {
    await runInit(dir);
    expect(await exists("AGENTS.md")).toBe(true);
    const res = await runUninit(dir);
    expect(res.cleaned).toContain("AGENTS.md");
    expect(res.deleted).toContain("AGENTS.md");
    expect(await exists("AGENTS.md")).toBe(false);
  });

  it("strips the block but preserves files with pre-existing content", async () => {
    await fs.writeFile(path.join(dir, "CLAUDE.md"), "# Team rules\n- use pnpm\n", "utf8");
    await runInit(dir);
    const res = await runUninit(dir);
    expect(res.cleaned).toContain("CLAUDE.md");
    expect(res.deleted).not.toContain("CLAUDE.md");
    expect(await exists("CLAUDE.md")).toBe(true);
    const after = await read("CLAUDE.md");
    expect(after).toContain("# Team rules"); // pre-existing content preserved
    expect(after).toContain("- use pnpm");
    expect(after).not.toContain("<!-- krimto:start -->");
    expect(after).not.toContain("krimto_recall");
  });

  it("is idempotent — second run finds nothing to clean", async () => {
    await runInit(dir);
    await runUninit(dir);
    const second = await runUninit(dir);
    expect(second.cleaned).toEqual([]);
    expect(second.deleted).toEqual([]);
  });
});

describe("krimto uninit (bin dispatch)", () => {
  it("`node bin/krimto.mjs uninit` removes the rule and prints the DEFAULT MODE explanation", async () => {
    await exec(process.execPath, [BIN, "init"], { cwd: dir });
    const { stderr } = await exec(process.execPath, [BIN, "uninit"], { cwd: dir });
    expect(stderr).toContain("Switched back to DEFAULT MODE");
    expect(stderr).toContain("rule removed");
    expect(await exists("AGENTS.md")).toBe(false);
  }, 30000);

  it("prints a clear no-op message when there is nothing to remove", async () => {
    const { stderr } = await exec(process.execPath, [BIN, "uninit"], { cwd: dir });
    expect(stderr).toContain("No Krimto rule found");
  }, 30000);
});
