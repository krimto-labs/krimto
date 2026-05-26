// Tests for the v0.2.17-4 shortcut commands: `editors`, `search`, `service`, `reset`.
// Each is a one-question wizard over a Phase A primitive — the apply step is exercised
// directly (no prompts) while the interactive wrappers are mocked via @inquirer/prompts.

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
  select: vi.fn(async (c: { message: string }) => nextAnswer(`select:${c.message}`)),
  checkbox: vi.fn(async (c: { message: string }) => nextAnswer(`checkbox:${c.message}`)),
  confirm: vi.fn(async (c: { message: string }) => nextAnswer(`confirm:${c.message}`)),
  input: vi.fn(async (c: { message: string }) => nextAnswer(`input:${c.message}`)),
  password: vi.fn(async (c: { message: string }) => nextAnswer(`password:${c.message}`)),
}));

import { applyEditors, runEditors } from "../../src/cli/editors";
import { applySearch, runSearchSettings } from "../../src/cli/searchSettings";
import { applyService, runServiceCmd } from "../../src/cli/serviceCmd";
import { applyReset, runReset } from "../../src/cli/reset";
import { runInitNonInteractive } from "../../src/cli/wizard";

let cwd: string;
let home: string;
beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), "krimto-shortcuts-"));
  home = await fs.mkdtemp(path.join(os.tmpdir(), "krimto-shortcuts-home-"));
  promptQueue.length = 0;
});
afterEach(async () => {
  await fs.rm(cwd, { recursive: true, force: true });
  await fs.rm(home, { recursive: true, force: true });
});

function captureIO(): { out: (s: string) => void; err: (s: string) => void; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { out: (s) => stdout.push(s), err: (s) => stderr.push(s), stdout, stderr };
}

// ============================================================================
// editors
// ============================================================================

describe("applyEditors", () => {
  it("adds a newly-checked editor (writes MCP config + standing rule)", async () => {
    // Seed: only Cursor connected.
    await fs.mkdir(path.join(cwd, ".cursor"));
    await runInitNonInteractive(cwd, { homeDir: home, editors: ["cursor"], dryRun: true });

    const res = await applyEditors(["cursor", "claude-code"], { cwd, homeDir: home, dryRun: true });
    const claude = res.outcomes.find((o) => o.editor === "claude-code")!;
    expect(claude.action).toBe("added");
    expect(claude.ruleWritten).toBe(true);

    // Cursor was already connected — should be reported as no-change.
    const cursor = res.outcomes.find((o) => o.editor === "cursor")!;
    expect(cursor.action).toBe("no-change");
  });

  it("removes a newly-unchecked editor (drops MCP entry + strips rule block)", async () => {
    await fs.mkdir(path.join(cwd, ".cursor"));
    await runInitNonInteractive(cwd, { homeDir: home, editors: ["cursor"] });

    const res = await applyEditors([], { cwd, homeDir: home });
    const cursor = res.outcomes.find((o) => o.editor === "cursor")!;
    expect(cursor.action).toBe("removed");
    // MCP entry should be gone from ~/.cursor/mcp.json
    const cursorJson = JSON.parse(
      await fs.readFile(path.join(home, ".cursor", "mcp.json"), "utf8"),
    ) as { mcpServers: Record<string, unknown> };
    expect(cursorJson.mcpServers.krimto).toBeUndefined();
    // Rule file should have its marker block stripped (or be deleted if it was rule-only).
    const ruleExists = await fs
      .access(path.join(cwd, ".cursor", "rules", "krimto.mdc"))
      .then(() => true)
      .catch(() => false);
    if (ruleExists) {
      const ruleText = await fs.readFile(
        path.join(cwd, ".cursor", "rules", "krimto.mdc"),
        "utf8",
      );
      expect(ruleText).not.toContain("<!-- krimto:start -->");
    }
  });

  it("reports no-change when the selection equals the current state", async () => {
    await fs.mkdir(path.join(cwd, ".cursor"));
    await runInitNonInteractive(cwd, { homeDir: home, editors: ["cursor"] });

    const res = await applyEditors(["cursor"], { cwd, homeDir: home });
    expect(res.outcomes.every((o) => o.action === "no-change")).toBe(true);
  });
});

describe("runEditors (interactive)", () => {
  it("walks the checkbox prompt and applies the new selection", async () => {
    await fs.mkdir(path.join(cwd, ".cursor"));
    await runInitNonInteractive(cwd, { homeDir: home, editors: ["cursor"], dryRun: true });

    const io = captureIO();
    promptQueue.push({
      name: "checkbox:Which editors should be connected to Krimto?",
      value: ["cursor", "claude-code"],
    });
    const res = await runEditors({ io, cwd, homeDir: home, dryRun: true });
    expect(res).not.toBeNull();
    expect(io.stdout.join("")).toContain("+ Claude Code connected");
  });

  it("Ctrl-C exits 130, no apply", async () => {
    const io = captureIO();
    const err = new Error("Prompt was exited");
    err.name = "ExitPromptError";
    promptQueue.push({
      name: "checkbox:Which editors should be connected to Krimto?",
      value: err,
    });
    const exitBefore = process.exitCode;
    const res = await runEditors({ io, cwd, homeDir: home });
    expect(res).toBeNull();
    expect(process.exitCode).toBe(130);
    process.exitCode = exitBefore;
  });
});

// ============================================================================
// search
// ============================================================================

describe("applySearch", () => {
  beforeEach(async () => {
    await fs.mkdir(path.join(cwd, ".cursor"));
    await runInitNonInteractive(cwd, { homeDir: home, editors: ["cursor"] });
  });

  it("OpenAI: writes KRIMTO_EMBED_PROVIDER + KRIMTO_EMBED_API_KEY into each connected editor's env", async () => {
    const res = await applySearch("openai", "sk-test", { cwd, homeDir: home });
    expect(res.updatedEditors).toBeGreaterThanOrEqual(1);
    const cursorJson = JSON.parse(
      await fs.readFile(path.join(home, ".cursor", "mcp.json"), "utf8"),
    ) as { mcpServers: { krimto: { env: Record<string, string> } } };
    expect(cursorJson.mcpServers.krimto.env.KRIMTO_EMBED_PROVIDER).toBe("openai");
    expect(cursorJson.mcpServers.krimto.env.KRIMTO_EMBED_API_KEY).toBe("sk-test");
  });

  it("keyword: strips the embed env vars", async () => {
    // First put OpenAI in.
    await applySearch("openai", "sk-test", { cwd, homeDir: home });
    // Then flip back to keyword.
    const res = await applySearch("keyword", undefined, { cwd, homeDir: home });
    expect(res.newProvider).toBe("keyword");
    const cursorJson = JSON.parse(
      await fs.readFile(path.join(home, ".cursor", "mcp.json"), "utf8"),
    ) as { mcpServers: { krimto: { env: Record<string, string> } } };
    expect(cursorJson.mcpServers.krimto.env.KRIMTO_EMBED_PROVIDER).toBeUndefined();
    expect(cursorJson.mcpServers.krimto.env.KRIMTO_EMBED_API_KEY).toBeUndefined();
    // Other env vars (KRIMTO_IDENTITY) should still be there.
    expect(cursorJson.mcpServers.krimto.env.KRIMTO_IDENTITY).toBeDefined();
  });
});

describe("runSearchSettings (interactive)", () => {
  beforeEach(async () => {
    await fs.mkdir(path.join(cwd, ".cursor"));
    await runInitNonInteractive(cwd, { homeDir: home, editors: ["cursor"] });
  });

  it("keyword flow: applies without asking for a key", async () => {
    const io = captureIO();
    promptQueue.push({ name: "select:Smarter search?", value: "keyword" });
    const res = await runSearchSettings({ io, cwd, homeDir: home });
    expect(res?.newProvider).toBe("keyword");
  });

  it("OpenAI flow: prompts for key, verifies via injected verifier, applies on ok", async () => {
    const io = captureIO();
    promptQueue.push({ name: "select:Smarter search?", value: "openai" });
    promptQueue.push({ name: "password:OpenAI API key (input hidden):", value: "sk-test" });
    const res = await runSearchSettings({
      io,
      cwd,
      homeDir: home,
      verify: async () => ({ status: "ok" }),
    });
    expect(res?.newProvider).toBe("openai");
    expect(io.stdout.join("")).toContain("Key verified");
  });

  it("OpenAI flow: aborts cleanly when verifier reports failure (no editor configs written)", async () => {
    const io = captureIO();
    promptQueue.push({ name: "select:Smarter search?", value: "openai" });
    promptQueue.push({ name: "password:OpenAI API key (input hidden):", value: "sk-bad" });
    const res = await runSearchSettings({
      io,
      cwd,
      homeDir: home,
      verify: async () => ({ status: "request_failed" }),
    });
    expect(res).toBeNull();
    expect(io.stderr.join("")).toContain("verification failed");
  });
});

// ============================================================================
// service
// ============================================================================

describe("applyService", () => {
  it("as-needed → no install, no uninstall when no service is present", async () => {
    const res = await applyService("as-needed", { homeDir: home, dryRun: true });
    expect(res.newMode).toBe("as-needed");
    expect(res.install).toBeUndefined();
    expect(res.uninstall).toBeUndefined();
  });

  it("always-running installs the platform service (dryRun)", async () => {
    const res = await applyService("always-running", {
      homeDir: home,
      dryRun: true,
      binPath: "/usr/bin/node",
      serviceArgs: ["/krimto/bin/krimto.mjs", "serve"],
    });
    expect(res.newMode).toBe("always-running");
    expect(res.install).toBeDefined();
    expect(res.install?.activated).toBe(false); // dryRun
  });
});

describe("runServiceCmd (interactive)", () => {
  it("walks the run-mode prompt and applies the new mode", async () => {
    const io = captureIO();
    promptQueue.push({ name: "select:How should Krimto run?", value: "as-needed" });
    const res = await runServiceCmd({ io, homeDir: home, dryRun: true });
    expect(res).not.toBeNull();
    expect(res?.newMode).toBe("as-needed");
  });
});

// ============================================================================
// reset
// ============================================================================

describe("applyReset", () => {
  it("disconnects all editors, strips rules, uninstalls service, wipes keys", async () => {
    await fs.mkdir(path.join(cwd, ".cursor"));
    await runInitNonInteractive(cwd, { homeDir: home, editors: ["cursor"] });
    // Seed a keys.json file so reset can wipe it.
    const dataDir = path.join(home, ".krimto");
    await fs.mkdir(path.join(dataDir, ".krimto"), { recursive: true });
    await fs.writeFile(
      path.join(dataDir, ".krimto", "keys.json"),
      JSON.stringify([{ identity: "x", hash: "y", prefix: "krm_live_", created: "now" }]),
      "utf8",
    );

    const res = await applyReset({ cwd, homeDir: home, dataDir, dryRun: true });
    expect(res.editorsDisconnected).toContain("cursor");
    expect(res.rulesStripped.length).toBeGreaterThan(0);
    expect(res.keysWiped).toBe(true);
    // Notes folder should still exist (only --wipe-notes moves it).
    await expect(fs.access(dataDir)).resolves.toBeUndefined();
  });

  it("--wipe-notes moves the data dir to a timestamped trash sibling", async () => {
    const dataDir = path.join(home, ".krimto");
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(path.join(dataDir, "marker.txt"), "marker", "utf8");

    const res = await applyReset({
      cwd,
      homeDir: home,
      dataDir,
      dryRun: true,
      wipeNotes: true,
    });
    expect(res.notesTrashedTo).toBeDefined();
    expect(res.notesTrashedTo).toContain(".trash-");
    // Original location is gone.
    await expect(fs.access(dataDir)).rejects.toThrow();
    // Trash location is present with the marker file.
    await expect(fs.access(res.notesTrashedTo!)).resolves.toBeUndefined();
    expect(
      await fs.readFile(path.join(res.notesTrashedTo!, "marker.txt"), "utf8"),
    ).toBe("marker");
  });
});

describe("runReset (interactive)", () => {
  it("aborts when the user declines the first confirm", async () => {
    const io = captureIO();
    promptQueue.push({ name: "confirm:Proceed with reset?", value: false });
    const res = await runReset({ io, cwd, homeDir: home });
    expect(res).toBeNull();
    expect(io.stdout.join("")).toContain("No changes made");
  });

  it("yes:true skips both confirms and applies", async () => {
    const io = captureIO();
    const res = await runReset({
      io,
      cwd,
      homeDir: home,
      dataDir: path.join(home, ".krimto"),
      yes: true,
      dryRun: true,
    });
    expect(res).not.toBeNull();
  });
});
