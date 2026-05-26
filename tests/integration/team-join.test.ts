// Tests for src/cli/join.ts — the v0.2.17.1 teammate-side join command.
//
// Two cuts:
//   • `applyJoin` (pure) — verifies HTTP MCP entry shape, key normalization, idempotency.
//   • `runJoin` — interactive flow with mocked prompts (when multiple editors are detected).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const promptQueue: { name: string; value: unknown }[] = [];
function nextAnswer<T>(name: string): T {
  const entry = promptQueue.shift();
  if (!entry) throw new Error(`No queued answer for prompt "${name}"`);
  if (entry.name !== name) throw new Error(`Expected "${entry.name}", got "${name}"`);
  if (entry.value instanceof Error) throw entry.value;
  return entry.value as T;
}

vi.mock("@inquirer/prompts", () => ({
  select: vi.fn(async (config: { message: string }) => nextAnswer(`select:${config.message}`)),
  checkbox: vi.fn(async (config: { message: string }) => nextAnswer(`checkbox:${config.message}`)),
  confirm: vi.fn(async (config: { message: string }) => nextAnswer(`confirm:${config.message}`)),
  input: vi.fn(async (config: { message: string }) => nextAnswer(`input:${config.message}`)),
  password: vi.fn(async (config: { message: string }) => nextAnswer(`password:${config.message}`)),
}));

import { applyJoin, normalizeServerUrl, runJoin } from "../../src/cli/join";

let dir: string;
let home: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "krimto-join-"));
  home = await fs.mkdtemp(path.join(os.tmpdir(), "krimto-join-home-"));
  promptQueue.length = 0;
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
  await fs.rm(home, { recursive: true, force: true });
});

// 32 chars after the prefix — matches `KEY_BODY_LENGTH` in src/access/auth.ts.
const VALID_KEY = "krm_live_4f7Qabcdefghijklmnopqrstuvwxyzab";

describe("normalizeServerUrl", () => {
  it("adds http:// when missing", () => {
    expect(normalizeServerUrl("maria-mbp:8080")).toBe("http://maria-mbp:8080/mcp");
  });
  it("strips trailing slash and appends /mcp", () => {
    expect(normalizeServerUrl("http://maria:8080/")).toBe("http://maria:8080/mcp");
  });
  it("leaves /mcp alone when already present", () => {
    expect(normalizeServerUrl("http://maria:8080/mcp")).toBe("http://maria:8080/mcp");
  });
  it("preserves https://", () => {
    expect(normalizeServerUrl("https://krimto.acme.com")).toBe("https://krimto.acme.com/mcp");
  });
});

describe("applyJoin — pure apply step", () => {
  it("writes Cursor's MCP config with the HTTP transport + bearer header", async () => {
    await fs.mkdir(path.join(dir, ".cursor"));
    const res = await applyJoin(
      { server: "http://maria-mbp:8080", key: VALID_KEY },
      { cwd: dir, homeDir: home },
    );
    expect(res.url).toBe("http://maria-mbp:8080/mcp");

    const cursorMcp = JSON.parse(
      await fs.readFile(path.join(home, ".cursor", "mcp.json"), "utf8"),
    ) as { mcpServers: { krimto: { url: string; headers: Record<string, string> } } };
    expect(cursorMcp.mcpServers.krimto.url).toBe("http://maria-mbp:8080/mcp");
    expect(cursorMcp.mcpServers.krimto.headers.Authorization).toBe(`Bearer ${VALID_KEY}`);
  });

  it("writes the standing rule to the editor's rules file", async () => {
    await fs.mkdir(path.join(dir, ".cursor"));
    await applyJoin(
      { server: "http://maria:8080", key: VALID_KEY },
      { cwd: dir, homeDir: home },
    );
    const rule = await fs.readFile(path.join(dir, ".cursor", "rules", "krimto.mdc"), "utf8");
    expect(rule).toContain("krimto_recall");
    expect(rule).toContain("<!-- krimto:start -->");
  });

  it("rejects keys that don't match the krm_live_/krm_test_ shape", async () => {
    await fs.mkdir(path.join(dir, ".cursor"));
    await expect(
      applyJoin({ server: "http://x:8080", key: "not-a-real-key" }, { cwd: dir, homeDir: home }),
    ).rejects.toThrow(/doesn't look like one Krimto issued/);
  });

  it("is idempotent: rerunning with the same args reports no-change", async () => {
    await fs.mkdir(path.join(dir, ".cursor"));
    await applyJoin(
      { server: "http://maria:8080", key: VALID_KEY },
      { cwd: dir, homeDir: home },
    );
    const second = await applyJoin(
      { server: "http://maria:8080", key: VALID_KEY },
      { cwd: dir, homeDir: home },
    );
    expect(second.editorOutcomes[0]?.mcpAction).toBe("no-change");
    expect(second.editorOutcomes[0]?.ruleWritten).toBe(false);
  });

  it("Claude Code: in dryRun mode, returns the cli command (HTTP transport shape)", async () => {
    await fs.writeFile(path.join(dir, "CLAUDE.md"), "");
    const res = await applyJoin(
      { server: "http://maria:8080", key: VALID_KEY },
      { cwd: dir, homeDir: home, dryRun: true, editors: ["claude-code"] },
    );
    const claude = res.editorOutcomes.find((o) => o.editor === "claude-code")!;
    expect(claude.mcpAction).toBe("cli-dry-run");
    // The cli snippet should include --transport http + the URL + the bearer header.
    expect(claude.manualSnippet).toContain("--transport");
    expect(claude.manualSnippet).toContain("http://maria:8080/mcp");
    expect(claude.manualSnippet).toContain("Authorization: Bearer");
  });

  it("only wires the explicit editor list when given", async () => {
    await fs.mkdir(path.join(dir, ".cursor"));
    await fs.writeFile(path.join(dir, "CLAUDE.md"), "");
    const res = await applyJoin(
      { server: "http://maria:8080", key: VALID_KEY },
      { cwd: dir, homeDir: home, editors: ["cursor"], dryRun: true },
    );
    expect(res.editorOutcomes.map((o) => o.editor)).toEqual(["cursor"]);
  });
});

describe("runJoin — interactive", () => {
  function captureIO(): { out: (s: string) => void; err: (s: string) => void; stdout: string[]; stderr: string[] } {
    const stdout: string[] = [];
    const stderr: string[] = [];
    return { out: (s) => stdout.push(s), err: (s) => stderr.push(s), stdout, stderr };
  }

  it("auto-wires the only detected editor without prompting", async () => {
    await fs.mkdir(path.join(dir, ".cursor"));
    const io = captureIO();
    const res = await runJoin(
      { server: "http://maria:8080", key: VALID_KEY },
      { cwd: dir, homeDir: home, io },
    );
    expect(res?.editorOutcomes.map((o) => o.editor)).toEqual(["cursor"]);
    expect(io.stdout.join("")).toContain("Will wire: Cursor");
  });

  it("prompts when multiple editors are detected", async () => {
    await fs.mkdir(path.join(dir, ".cursor"));
    await fs.writeFile(path.join(dir, "CLAUDE.md"), "");
    promptQueue.push({
      name: "checkbox:Which editors should connect to the team server?",
      value: ["cursor"], // user toggles off claude-code
    });
    const io = captureIO();
    const res = await runJoin(
      { server: "http://maria:8080", key: VALID_KEY },
      { cwd: dir, homeDir: home, io },
    );
    expect(res?.editorOutcomes.map((o) => o.editor)).toEqual(["cursor"]);
  });

  it("errors out cleanly when no editors are detected", async () => {
    const io = captureIO();
    const res = await runJoin(
      { server: "http://maria:8080", key: VALID_KEY },
      { cwd: dir, homeDir: home, io },
    );
    expect(res).toBeNull();
    expect(io.stderr.join("")).toContain("No supported editors detected");
  });
});
