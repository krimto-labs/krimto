// `krimto storage` — teaches a first-time user where Krimto keeps things on disk (markdown /
// git / index) and what they can edit by hand. Surfaces the "you own your data" half of Krimto's
// pitch on demand, without forcing anyone to read the README.

import { describe, expect, it } from "vitest";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { formatStorage } from "../../src/cli/storage";

const exec = promisify(execFile);
const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../bin/krimto.mjs");

describe("formatStorage", () => {
  it("names every layer (markdown / git / index) and explains the role of each", () => {
    const out = formatStorage("/tmp/k-data");
    expect(out).toContain("/tmp/k-data");
    expect(out).toContain("MARKDOWN FILES");
    expect(out).toContain("GIT REPO");
    expect(out).toContain("INDEX.DB");
    expect(out).toContain("source of truth");
    expect(out).toContain("audit log");
  });

  it("tells the user what they can and shouldn't do by hand", () => {
    const out = formatStorage("/tmp/k-data");
    expect(out).toContain("WHAT YOU CAN DO BY HAND");
    expect(out).toContain("WHAT YOU SHOULDN'T DO");
    expect(out).toContain("Don't edit index.db");
  });

  it("leads with 'already set up — no setup needed' so Maria doesn't think she has to install anything", () => {
    const out = formatStorage("/tmp/k-data");
    expect(out).toContain("ALREADY SET UP");
    expect(out).toContain("created automatically");
  });

  it("shows how to verify each layer is working (cd + git log + ls index.db)", () => {
    const out = formatStorage("/tmp/k-data");
    expect(out).toContain("HOW TO CHECK IT'S WORKING");
    expect(out).toContain("cd /tmp/k-data");
    expect(out).toContain("git log");
    expect(out).toContain("ls index.db");
  });

  it("warns about the 30-second batch-commit lag so 'git log shows nothing' isn't mistaken for a bug (G8)", () => {
    const out = formatStorage("/tmp/k-data");
    expect(out).toMatch(/batched every 30 seconds/i); // matches "BATCHED" too
    expect(out).toContain("written immediately"); // ".md file is written immediately"
  });

  it("documents the only two optional add-ons with the exact env vars", () => {
    const out = formatStorage("/tmp/k-data");
    expect(out).toContain("OPTIONAL: SHARE & UPGRADE");
    expect(out).toContain("KRIMTO_GIT_REMOTE");
    expect(out).toContain("KRIMTO_EMBED_PROVIDER");
    expect(out).toContain("KRIMTO_EMBED_API_KEY");
  });
});

describe("krimto storage (bin dispatch)", () => {
  it("`node bin/krimto.mjs storage` prints the explainer to stdout", async () => {
    const { stdout } = await exec(process.execPath, [BIN, "storage"], {
      env: { ...process.env, KRIMTO_DATA: "/tmp/k-test-data" },
    });
    expect(stdout).toContain("/tmp/k-test-data");
    expect(stdout).toContain("MARKDOWN FILES");
    expect(stdout).toContain("GIT REPO");
  }, 30000);
});
