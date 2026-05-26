// `krimto connect` prints stdio connect snippets to stdout so a solo user on the npx on-ramp
// doesn't have to dig the README out of a closed tab.

import { describe, expect, it } from "vitest";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { formatConnect } from "../../src/cli/connect";

const exec = promisify(execFile);
const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../bin/krimto.mjs");

describe("formatConnect", () => {
  it("includes the npx-based Claude Code line and the Cursor JSON block", () => {
    const out = formatConnect();
    expect(out).toContain("claude mcp add krimto -- npx -y @krimto-labs/krimto");
    expect(out).toContain('"command": "npx"');
    expect(out).toContain('"KRIMTO_IDENTITY"');
    expect(out).toContain("npx @krimto-labs/krimto init");
  });

  it("explains what `connect` alone gives the user vs. what `init` adds", () => {
    const out = formatConnect();
    // The "tools are available but on-demand" half (text spans 2 lines, match key phrases):
    expect(out).toMatch(/only uses them[\s\S]+use krimto to/);
    // The "init makes it automatic" half of the story:
    expect(out).toContain("AUTOMATIC");
    // And: init is presented as the second of three numbered steps.
    expect(out).toContain("npx @krimto-labs/krimto init");
  });

  it("threads through a caller-provided identity", () => {
    const out = formatConnect({ identity: "maria@acme.com" });
    expect(out).toContain("maria@acme.com");
  });

  it("documents the optional env vars (git remote + embeddings) and points at the setup commands", () => {
    const out = formatConnect();
    expect(out).toContain("Optional add-ons");
    expect(out).toContain("KRIMTO_GIT_REMOTE");
    expect(out).toContain("KRIMTO_EMBED_PROVIDER");
    expect(out).toContain("KRIMTO_EMBED_API_KEY");
    expect(out).toContain("krimto setup-remote");
    expect(out).toContain("krimto setup-embeddings");
  });

  it("walks through the connect → init → test → verify loop (Gap #5b)", () => {
    const out = formatConnect();
    expect(out).toContain("npx @krimto-labs/krimto init");
    expect(out).toContain("Remember that we use pnpm in this repo");
    expect(out).toContain("What do you know about this repo?");
    expect(out).toContain("verify-connection");
    expect(out).toContain("Test the loop");
  });
});

describe("krimto connect (bin dispatch)", () => {
  it("`node bin/krimto.mjs connect` prints the snippets to stdout", async () => {
    const { stdout } = await exec(process.execPath, [BIN, "connect"], {
      env: { ...process.env, KRIMTO_IDENTITY: "maria@acme.com" },
    });
    expect(stdout).toContain("claude mcp add krimto -- npx -y @krimto-labs/krimto");
    expect(stdout).toContain("maria@acme.com");
    expect(stdout).toContain("/ui/connect");
  }, 30000);
});
