// `krimto --help` (and `-h`, and `help`) prints the full CLI surface so a user who never read the
// README can still discover every subcommand.

import { describe, expect, it } from "vitest";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { formatHelp } from "../../src/cli/help";

const exec = promisify(execFile);
const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../bin/krimto.mjs");

describe("formatHelp", () => {
  it("lists every CLI subcommand (including serve + uninit + usage) and the relevant env vars", () => {
    const out = formatHelp("0.2.7");
    expect(out).toContain("v0.2.7");
    expect(out).toContain("serve");
    expect(out).toContain("connect");
    expect(out).toContain("init");
    expect(out).toContain("uninit");
    expect(out).toContain("usage");
    expect(out).toContain("storage");
    expect(out).toContain("setup-remote");
    expect(out).toContain("setup-embeddings");
    expect(out).toContain("verify-connection");
    expect(out).toContain("where");
    expect(out).toContain("--help");
    expect(out).toContain("KRIMTO_DATA");
    expect(out).toContain("KRIMTO_IDENTITY");
    expect(out).toContain("KRIMTO_HTTP_PORT");
    expect(out).toContain("KRIMTO_BOOTSTRAP_ADMIN");
  });

  it("leads with the two-mode framing so the user knows DEFAULT vs AUTO", () => {
    const out = formatHelp("0.2.7");
    expect(out).toContain("DEFAULT MODE");
    expect(out).toContain("AUTO MODE");
    expect(out).toContain("uninit"); // documented as the switch back to DEFAULT
  });
});

describe("krimto --help (bin dispatch)", () => {
  it("accepts --help, -h, and help (all produce identical output)", async () => {
    const [longFlag, shortFlag, bareWord] = await Promise.all([
      exec(process.execPath, [BIN, "--help"]),
      exec(process.execPath, [BIN, "-h"]),
      exec(process.execPath, [BIN, "help"]),
    ]);
    expect(longFlag.stdout).toContain("connect");
    expect(longFlag.stdout).toContain("init");
    expect(longFlag.stdout).toContain("where");
    expect(longFlag.stdout).toContain("Usage:");
    expect(shortFlag.stdout).toBe(longFlag.stdout);
    expect(bareWord.stdout).toBe(longFlag.stdout);
  }, 30000);
});
