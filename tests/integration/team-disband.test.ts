// Tests for src/cli/teamDisband.ts — the v0.2.17.1 "step back to solo" reversal.
//
// The disband flow walks each editor's MCP config, finds HTTP-transport `krimto` entries (those
// are team-mode), and rewrites them as stdio entries. Other servers in the same file are
// preserved. Editors without a Krimto entry are skipped; editors already on stdio are reported
// as no-change.

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

import { applyTeamDisband, runTeamDisband } from "../../src/cli/teamDisband";
import { applyJoin } from "../../src/cli/join";
import { runInitNonInteractive } from "../../src/cli/wizard";

let dir: string;
let home: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "krimto-disband-"));
  home = await fs.mkdtemp(path.join(os.tmpdir(), "krimto-disband-home-"));
  promptQueue.length = 0;
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
  await fs.rm(home, { recursive: true, force: true });
});

// 32 chars after the prefix — matches `KEY_BODY_LENGTH` in src/access/auth.ts.
const VALID_KEY = "krm_live_4f7Qabcdefghijklmnopqrstuvwxyzab";

describe("applyTeamDisband — pure apply step", () => {
  it("rewrites Cursor's HTTP entry back to stdio", async () => {
    await fs.mkdir(path.join(dir, ".cursor"));
    // First, join a (fake) team — installs HTTP entry.
    await applyJoin(
      { server: "http://maria:8080", key: VALID_KEY },
      { cwd: dir, homeDir: home },
    );
    let cursorMcp = JSON.parse(
      await fs.readFile(path.join(home, ".cursor", "mcp.json"), "utf8"),
    ) as { mcpServers: { krimto: { url?: string; command?: string } } };
    expect(cursorMcp.mcpServers.krimto.url).toBeDefined();

    // Disband.
    const res = await applyTeamDisband({ cwd: dir, homeDir: home });
    const cursor = res.editorOutcomes.find((o) => o.editor === "cursor")!;
    expect(cursor.wasTeam).toBe(true);
    expect(cursor.mcpAction).toBe("updated");

    // Cursor's entry is now stdio (`command`, no `url`).
    cursorMcp = JSON.parse(
      await fs.readFile(path.join(home, ".cursor", "mcp.json"), "utf8"),
    ) as { mcpServers: { krimto: { url?: string; command?: string } } };
    expect(cursorMcp.mcpServers.krimto.url).toBeUndefined();
    expect(cursorMcp.mcpServers.krimto.command).toBe("npx");
  });

  it("leaves stdio entries alone (no-change)", async () => {
    await fs.mkdir(path.join(dir, ".cursor"));
    await runInitNonInteractive(dir, { homeDir: home }); // installs stdio entry

    const res = await applyTeamDisband({ cwd: dir, homeDir: home });
    const cursor = res.editorOutcomes.find((o) => o.editor === "cursor")!;
    expect(cursor.wasTeam).toBe(false);
    expect(cursor.mcpAction).toBe("no-change");
  });

  it("returns an empty outcomes list when no Krimto entries exist", async () => {
    const res = await applyTeamDisband({ cwd: dir, homeDir: home });
    expect(res.editorOutcomes).toEqual([]);
  });

  it("preserves other (non-Krimto) MCP servers in Cursor's config", async () => {
    await fs.mkdir(path.join(dir, ".cursor"));
    // Pre-populate with a non-Krimto server.
    const cursorMcpPath = path.join(home, ".cursor", "mcp.json");
    await fs.mkdir(path.dirname(cursorMcpPath), { recursive: true });
    await fs.writeFile(
      cursorMcpPath,
      JSON.stringify({ mcpServers: { other: { command: "node", args: ["other.js"] } } }, null, 2),
      "utf8",
    );
    await applyJoin(
      { server: "http://maria:8080", key: VALID_KEY },
      { cwd: dir, homeDir: home },
    );
    await applyTeamDisband({ cwd: dir, homeDir: home });

    const cursorMcp = JSON.parse(await fs.readFile(cursorMcpPath, "utf8")) as {
      mcpServers: Record<string, { command?: string; url?: string; args?: string[] }>;
    };
    expect(cursorMcp.mcpServers.other).toEqual({ command: "node", args: ["other.js"] });
    expect(cursorMcp.mcpServers.krimto?.command).toBe("npx");
  });
});

describe("runTeamDisband — interactive", () => {
  function captureIO(): { out: (s: string) => void; err: (s: string) => void; stdout: string[]; stderr: string[] } {
    const stdout: string[] = [];
    const stderr: string[] = [];
    return { out: (s) => stdout.push(s), err: (s) => stderr.push(s), stdout, stderr };
  }

  it("aborts when the user declines the confirm", async () => {
    await fs.mkdir(path.join(dir, ".cursor"));
    await applyJoin(
      { server: "http://maria:8080", key: VALID_KEY },
      { cwd: dir, homeDir: home },
    );
    promptQueue.push({ name: "confirm:Proceed?", value: false });

    const io = captureIO();
    const res = await runTeamDisband({ io, cwd: dir, homeDir: home });
    expect(res).toBeNull();
    expect(io.stdout.join("")).toContain("No changes made");
    // The HTTP entry should still be there.
    const cursorMcp = JSON.parse(
      await fs.readFile(path.join(home, ".cursor", "mcp.json"), "utf8"),
    ) as { mcpServers: { krimto: { url?: string } } };
    expect(cursorMcp.mcpServers.krimto.url).toBeDefined();
  });

  it("yes:true skips the confirm prompt and applies", async () => {
    await fs.mkdir(path.join(dir, ".cursor"));
    await applyJoin(
      { server: "http://maria:8080", key: VALID_KEY },
      { cwd: dir, homeDir: home },
    );
    const io = captureIO();
    const res = await runTeamDisband({ io, cwd: dir, homeDir: home, yes: true });
    expect(res).not.toBeNull();
    expect(io.stdout.join("")).toContain("Switched back to solo mode");
  });
});
