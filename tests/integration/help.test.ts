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

  // v0.2.32 — the audit caught --help advertising 14 of 28 commands. The rewrite surfaces
  // everything in 7 groups. These assertions guard against regression — every command the
  // dispatch table accepts must appear in --help, or it's a discovery dead-end.
  it("surfaces every dispatched command (regression guard for the v0.2.32 rewrite)", () => {
    const out = formatHelp("0.2.32");
    // Get connected
    for (const v of ["init", "connect", "uninit"]) expect(out).toContain(v);
    // Look at your notes
    for (const v of ["notes", "ui", "open", "edit", "mv", "supersede", "tag", "rm"]) expect(out).toContain(v);
    // Stop & reset — the missing piece the audit flagged
    for (const v of ["stop", "start", "restart", "reset"]) expect(out).toContain(v);
    // Is it working?
    for (const v of ["status", "whoami", "verify-connection"]) expect(out).toContain(v);
    // Configure
    for (const v of ["editors", "service", "search", "remote", "folder", "set identity"]) expect(out).toContain(v);
    // Team
    for (const v of ["team init", "team disband", "join"]) expect(out).toContain(v);
    // Advanced
    for (const v of ["serve", "reindex", "setup-remote", "setup-embeddings"]) expect(out).toContain(v);
  });

  it("groups commands by user intent (the seven section headers from the rewrite)", () => {
    const out = formatHelp("0.2.32");
    expect(out).toContain("Get connected");
    expect(out).toContain("Look at your notes");
    expect(out).toContain("Stop & reset");
    expect(out).toContain("Is it working?");
    expect(out).toContain("Configure");
    expect(out).toContain("Team");
    expect(out).toContain("Advanced");
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
    expect(longFlag.stdout).toContain("Usage");
    expect(shortFlag.stdout).toBe(longFlag.stdout);
    expect(bareWord.stdout).toBe(longFlag.stdout);
  }, 30000);
});
