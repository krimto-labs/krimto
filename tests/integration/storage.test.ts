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
    expect(out).toContain("Markdown files");
    expect(out).toContain("Git repo");
    expect(out).toContain("index.db");
    expect(out).toContain("the real data");
    expect(out).toContain("audit log");
  });

  it("tells the user what they can and shouldn't do by hand", () => {
    const out = formatStorage("/tmp/k-data");
    expect(out).toContain("Things you CAN do by hand");
    expect(out).toContain("Don't touch");
    expect(out).toContain("index.db");
  });

  it("leads with 'already set up — no action needed' so Maria doesn't think she has to install anything", () => {
    const out = formatStorage("/tmp/k-data");
    expect(out).toContain("already set up");
    expect(out).toContain("no action needed");
  });

  it("shows how to verify each layer is working (cd + git log + ls index.db)", () => {
    const out = formatStorage("/tmp/k-data");
    expect(out).toContain("Verify it's working");
    expect(out).toContain("cd /tmp/k-data");
    expect(out).toContain("git log");
    expect(out).toContain("ls index.db");
  });

  it("warns about the 30-second batch-commit lag so 'git log shows nothing' isn't mistaken for a bug (G8)", () => {
    const out = formatStorage("/tmp/k-data");
    expect(out).toContain("batched");
    expect(out).toContain("immediately"); // ".md file is written immediately"
  });

  it("documents the only two optional add-ons with the exact env vars", () => {
    const out = formatStorage("/tmp/k-data");
    expect(out).toContain("Optional: share");
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
    expect(stdout).toContain("Markdown files");
    expect(stdout).toContain("Git repo");
  }, 30000);
});
