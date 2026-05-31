// Tests for src/cli/mcpConfig.ts — the v0.2.17 wizard's editor-config writer.
//
// JSON method (Cursor): round-trip create → idempotent re-write → update → remove, with
// multi-server preservation (other MCP servers in the same file must survive a Krimto write).
//
// CLI method (Claude Code): tested in dry-run mode so we don't shell out to a `claude` binary
// that may or may not exist on the CI runner. We verify the exact argv shape produced.
//
// Manual method (null mcpWire — Gemini CLI / Codex): a copy-paste snippet is returned.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { detectEditorEnvironments, type EditorEnvironment } from "../../src/cli/init";
import {
  readMcpConfig,
  removeMcpConfig,
  writeMcpConfig,
} from "../../src/cli/mcpConfig";
import { stdioMcpEntry, httpMcpEntry, type KrimtoMcpEntry } from "../../src/server/connect";

let dir: string;
let home: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "krimto-mcpconfig-"));
  home = await fs.mkdtemp(path.join(os.tmpdir(), "krimto-mcpconfig-home-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
  await fs.rm(home, { recursive: true, force: true });
});

const stdioEntry: KrimtoMcpEntry = {
  transport: "stdio",
  ...stdioMcpEntry({ identity: "alice@acme.com" }),
};

async function envFor(editor: "cursor" | "claude-code" | "gemini-cli" | "codex"): Promise<EditorEnvironment> {
  // Trigger the detection signal for the editor so `present === true`. We then look up the env.
  switch (editor) {
    case "cursor":
      await fs.mkdir(path.join(dir, ".cursor"));
      break;
    case "claude-code":
      await fs.writeFile(path.join(dir, "CLAUDE.md"), "");
      break;
    case "gemini-cli":
      await fs.writeFile(path.join(dir, "gemini-extension.json"), "{}");
      break;
    case "codex":
      await fs.writeFile(path.join(dir, "AGENTS.md"), "");
      break;
  }
  const envs = await detectEditorEnvironments(dir, home);
  return envs.find((e) => e.editor === editor)!;
}

describe("writeMcpConfig — JSON wire method (Cursor)", () => {
  it("creates the file when absent and writes the krimto entry", async () => {
    const env = await envFor("cursor");
    const res = await writeMcpConfig(env, stdioEntry);
    expect(res.action).toBe("created");

    const text = await fs.readFile(path.join(home, ".cursor", "mcp.json"), "utf8");
    const json = JSON.parse(text) as { mcpServers: { krimto: { command: string; args: string[] } } };
    expect(json.mcpServers.krimto.command).toBe("npx");
    expect(json.mcpServers.krimto.args).toEqual(["-y", "@krimto-labs/krimto"]);
    // The TypeScript-only `transport` discriminator must not appear in the persisted file.
    expect(text).not.toContain('"transport"');
  });

  it("is idempotent: re-writing the same entry returns no-change", async () => {
    const env = await envFor("cursor");
    await writeMcpConfig(env, stdioEntry);
    const res2 = await writeMcpConfig(env, stdioEntry);
    expect(res2.action).toBe("no-change");
  });

  it("preserves other MCP servers in the file across a write", async () => {
    const env = await envFor("cursor");
    const cursorMcp = path.join(home, ".cursor", "mcp.json");
    await fs.mkdir(path.dirname(cursorMcp), { recursive: true });
    await fs.writeFile(
      cursorMcp,
      JSON.stringify(
        { mcpServers: { other: { command: "node", args: ["other.js"] } } },
        null,
        2,
      ),
      "utf8",
    );

    const res = await writeMcpConfig(env, stdioEntry);
    expect(res.action).toBe("created");

    const json = JSON.parse(await fs.readFile(cursorMcp, "utf8")) as {
      mcpServers: Record<string, { command: string }>;
    };
    expect(json.mcpServers.other).toEqual({ command: "node", args: ["other.js"] });
    expect(json.mcpServers.krimto).toBeDefined();
  });

  it("updates (not creates) when the entry already exists with different contents", async () => {
    const env = await envFor("cursor");
    await writeMcpConfig(env, stdioEntry);
    const altered: KrimtoMcpEntry = {
      transport: "stdio",
      ...stdioMcpEntry({ identity: "bob@acme.com" }),
    };
    const res = await writeMcpConfig(env, altered);
    expect(res.action).toBe("updated");
  });

  it("removeMcpConfig deletes the krimto key but preserves other servers", async () => {
    const env = await envFor("cursor");
    const cursorMcp = path.join(home, ".cursor", "mcp.json");
    await fs.mkdir(path.dirname(cursorMcp), { recursive: true });
    await fs.writeFile(
      cursorMcp,
      JSON.stringify(
        { mcpServers: { other: { command: "node" }, krimto: { command: "npx" } } },
        null,
        2,
      ),
      "utf8",
    );

    const res = await removeMcpConfig(env);
    expect(res.removed).toBe(true);
    const json = JSON.parse(await fs.readFile(cursorMcp, "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect("krimto" in json.mcpServers).toBe(false);
    expect("other" in json.mcpServers).toBe(true);
  });

  it("removeMcpConfig is a no-op when the file or entry is absent", async () => {
    const env = await envFor("cursor");
    expect((await removeMcpConfig(env)).removed).toBe(false);

    const cursorMcp = path.join(home, ".cursor", "mcp.json");
    await fs.mkdir(path.dirname(cursorMcp), { recursive: true });
    await fs.writeFile(cursorMcp, JSON.stringify({ mcpServers: {} }), "utf8");
    expect((await removeMcpConfig(env)).removed).toBe(false);
  });

  it("writes HTTP entries (team-mode shape) verbatim", async () => {
    const env = await envFor("cursor");
    const httpWithKey: KrimtoMcpEntry = {
      transport: "http",
      ...httpMcpEntry({ host: "localhost:8080", key: "krm_live_abc" }),
    };
    await writeMcpConfig(env, httpWithKey);
    const json = JSON.parse(await fs.readFile(path.join(home, ".cursor", "mcp.json"), "utf8")) as {
      mcpServers: { krimto: { url: string; headers: Record<string, string> } };
    };
    expect(json.mcpServers.krimto.url).toBe("http://localhost:8080/mcp");
    expect(json.mcpServers.krimto.headers.Authorization).toBe("Bearer krm_live_abc");
  });
});

describe("readMcpConfig", () => {
  it("returns null when the file is missing (or the env is non-JSON)", async () => {
    const env = await envFor("cursor");
    expect(await readMcpConfig(env)).toBeNull();
    expect(await readMcpConfig(await envFor("claude-code"))).toBeNull();
    expect(await readMcpConfig(await envFor("gemini-cli"))).toBeNull();
  });

  it("reports krimtoPresent correctly", async () => {
    const env = await envFor("cursor");
    await writeMcpConfig(env, stdioEntry);
    const res = await readMcpConfig(env);
    expect(res?.krimtoPresent).toBe(true);
  });

  it("throws a helpful error when the JSON is malformed", async () => {
    const env = await envFor("cursor");
    const cursorMcp = path.join(home, ".cursor", "mcp.json");
    await fs.mkdir(path.dirname(cursorMcp), { recursive: true });
    await fs.writeFile(cursorMcp, "{ not valid json", "utf8");
    await expect(readMcpConfig(env)).rejects.toThrow(/not valid JSON/);
  });
});

describe("writeMcpConfig — CLI wire method (Claude Code, dry-run)", () => {
  it("returns the stdio argv shape: `mcp add krimto -- npx -y @krimto-labs/krimto`", async () => {
    const env = await envFor("claude-code");
    const res = await writeMcpConfig(env, stdioEntry, { dryRun: true });
    expect(res.action).toBe("cli-dry-run");
    expect(res.cliCommand).toEqual({
      command: "claude",
      args: ["mcp", "add", "krimto", "--", "npx", "-y", "@krimto-labs/krimto"],
    });
  });

  it("falls back to a manual snippet (no crash) when the CLI binary isn't on PATH (batch 5)", async () => {
    const base = await envFor("claude-code");
    if (!base.mcpWire || base.mcpWire.method !== "cli") throw new Error("expected claude-code cli wire");
    const env: EditorEnvironment = {
      ...base,
      mcpWire: { ...base.mcpWire, command: "krimto-definitely-missing-binary-zzz" },
    };
    // Real exec (no dryRun) → the binary doesn't exist → ENOENT. Must NOT throw (that crashes the
    // wizard); instead fall back to the copy-paste snippet so the user can wire it by hand.
    const res = await writeMcpConfig(env, stdioEntry);
    expect(res.action).toBe("manual");
    expect(res.snippet).toContain("@krimto-labs/krimto");
  });

  it("returns the http argv shape with --transport http and the server URL", async () => {
    const env = await envFor("claude-code");
    const httpWithKey: KrimtoMcpEntry = {
      transport: "http",
      ...httpMcpEntry({ host: "localhost:8080", key: "krm_live_abc" }),
    };
    const res = await writeMcpConfig(env, httpWithKey, { dryRun: true });
    expect(res.action).toBe("cli-dry-run");
    expect(res.cliCommand?.args).toEqual([
      "mcp",
      "add",
      "--transport",
      "http",
      "krimto",
      "http://localhost:8080/mcp",
      "--header",
      "Authorization: Bearer krm_live_abc",
    ]);
  });

  it("provides a copy-paste snippet alongside the dry-run command", async () => {
    const env = await envFor("claude-code");
    const res = await writeMcpConfig(env, stdioEntry, { dryRun: true });
    expect(res.snippet).toContain("claude mcp add krimto");
  });
});

describe("writeMcpConfig — CLI wire method (re-run safety)", () => {
  // v0.2.19 regression: `claude mcp add krimto` errors on the second invocation in the same
  // project scope with "MCP server krimto already exists in local config". The fix is to run
  // `claude mcp remove krimto` first (ignoring not-found), so reconfigure is idempotent. This
  // test simulates Claude Code with a tiny shell script and verifies a second add succeeds.
  it("calls `mcp remove` before `mcp add` and re-runs successfully even when an entry exists", async () => {
    const fakeClaude = path.join(dir, "fake-claude.sh");
    const stateFile = path.join(dir, ".fake-claude-state");
    await fs.writeFile(
      fakeClaude,
      `#!/bin/bash
sub="$1 $2"   # e.g. "mcp add" or "mcp remove"
case "$sub" in
  "mcp add")
    if [ -f "${stateFile}" ]; then
      echo "MCP server krimto already exists in local config" >&2
      exit 1
    fi
    echo "registered" > "${stateFile}"
    ;;
  "mcp remove")
    if [ -f "${stateFile}" ]; then
      rm "${stateFile}"
    else
      echo "MCP server krimto not found" >&2
      exit 1
    fi
    ;;
  *)
    exit 2
    ;;
esac
`,
      "utf8",
    );
    await fs.chmod(fakeClaude, 0o755);

    // Synthesize an env that uses the fake claude script.
    const claudeEnv = await envFor("claude-code");
    claudeEnv.mcpWire = { method: "cli", command: fakeClaude, baseArgs: ["mcp", "add", "krimto"] };

    // First call: state file doesn't exist → add succeeds. The "remove first" step errors
    // ("not found") but is swallowed.
    const first = await writeMcpConfig(claudeEnv, stdioEntry);
    expect(first.action).toBe("cli-executed");
    await expect(fs.access(stateFile)).resolves.toBeUndefined();

    // Second call: state file exists. Pre-v0.2.19 this would crash with "already exists".
    // With the fix, `mcp remove` runs first, the state file is cleared, then `mcp add` succeeds.
    const second = await writeMcpConfig(claudeEnv, stdioEntry);
    expect(second.action).toBe("cli-executed");
    await expect(fs.access(stateFile)).resolves.toBeUndefined();
  });
});

describe("writeMcpConfig — manual (null mcpWire)", () => {
  it("Gemini CLI returns a manual snippet, no file is touched", async () => {
    const env = await envFor("gemini-cli");
    const res = await writeMcpConfig(env, stdioEntry);
    expect(res.action).toBe("manual");
    expect(res.snippet).toContain("mcpServers");
    expect(res.snippet).toContain("krimto");
  });

  it("Codex (AGENTS.md detection) returns a manual snippet", async () => {
    const env = await envFor("codex");
    const res = await writeMcpConfig(env, stdioEntry);
    expect(res.action).toBe("manual");
    expect(res.snippet).toContain("krimto");
  });
});
