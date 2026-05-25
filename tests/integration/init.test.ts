// `krimto init` writes the always-use-Krimto standing rule into a project's agent rules files —
// the fix for the discovery problem (agents otherwise route "remember X" to their built-in memory).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { runInit } from "../../src/cli/init";

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

describe("krimto init (bin dispatch)", () => {
  it("`node bin/krimto.mjs init` writes the rule in the current directory", async () => {
    await exec(process.execPath, [BIN, "init"], { cwd: dir });
    expect(await read("AGENTS.md")).toContain("krimto_recall");
  }, 30000);
});
