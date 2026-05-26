// Tests for src/cli/wizard.ts — the v0.2.17 interactive wizard orchestrator.
//
// Two cuts:
//   1. `runInitNonInteractive(--yes path)` — no prompts at all; just apply defaults. Tested
//      directly against the temp dir.
//   2. `runInitWizard` — `@inquirer/prompts` is mocked at module scope so each test can script
//      the user's answer sequence and then assert the resulting filesystem + summary output.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Mocked prompts — see top of file. Each test pushes the answers it wants.
// If `value` is an Error instance, the mock throws it (used to test the Ctrl-C path).
const promptQueue: { name: string; value: unknown }[] = [];
function nextAnswer<T>(name: string): T {
  const entry = promptQueue.shift();
  if (!entry) throw new Error(`No queued answer for prompt "${name}"`);
  if (entry.name !== name) {
    throw new Error(`Expected prompt "${entry.name}", got "${name}"`);
  }
  if (entry.value instanceof Error) throw entry.value;
  return entry.value as T;
}

vi.mock("@inquirer/prompts", () => ({
  select: vi.fn(async (config: { message: string }) => nextAnswer(`select:${config.message}`)),
  checkbox: vi.fn(async (config: { message: string }) => nextAnswer(`checkbox:${config.message}`)),
  confirm: vi.fn(async (config: { message: string }) => nextAnswer(`confirm:${config.message}`)),
  password: vi.fn(async (config: { message: string }) => nextAnswer(`password:${config.message}`)),
}));

import {
  runInitNonInteractive,
  runInitWizard,
  type WizardIO,
} from "../../src/cli/wizard";
import { detectExistingSetup, type EditorKind, type RunMode, type SearchProvider } from "../../src/cli/init";

function captureIO(): WizardIO & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    out: (s) => stdout.push(s),
    err: (s) => stderr.push(s),
    stdout,
    stderr,
  };
}

let dir: string;
let home: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "krimto-wizard-"));
  home = await fs.mkdtemp(path.join(os.tmpdir(), "krimto-wizard-home-"));
  promptQueue.length = 0;
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
  await fs.rm(home, { recursive: true, force: true });
});

describe("runInitNonInteractive (--yes path)", () => {
  it("applies sensible defaults: detected editors + as-needed + keyword", async () => {
    await fs.mkdir(path.join(dir, ".cursor"));
    const result = await runInitNonInteractive(dir, { homeDir: home });
    const wired = result.editorOutcomes.map((o) => o.editor);
    expect(wired).toContain("cursor");
    expect(wired).not.toContain("claude-code"); // not detected
    expect(result.embeddingsConfigured).toBe(false);
    expect(result.serviceInstall).toBeUndefined();

    // Cursor MCP config + standing rule should be on disk.
    const cursorMcp = JSON.parse(
      await fs.readFile(path.join(home, ".cursor", "mcp.json"), "utf8"),
    ) as { mcpServers: { krimto: unknown } };
    expect(cursorMcp.mcpServers.krimto).toBeDefined();
    expect(
      await fs.readFile(path.join(dir, ".cursor", "rules", "krimto.mdc"), "utf8"),
    ).toContain("krimto_recall");
  });

  it("falls back to all four editors when none are detected (safer than empty setup)", async () => {
    // dryRun is required so claude-code's CLI write doesn't actually invoke `claude mcp add`.
    const result = await runInitNonInteractive(dir, { homeDir: home, dryRun: true });
    const wired = result.editorOutcomes.map((o) => o.editor).sort();
    expect(wired).toEqual(["claude-code", "codex", "cursor", "gemini-cli"]);
  });

  it("explicit `editors` option overrides detection", async () => {
    await fs.mkdir(path.join(dir, ".cursor"));
    const result = await runInitNonInteractive(dir, {
      homeDir: home,
      editors: ["claude-code"],
      dryRun: true, // avoid touching the host's real `claude` CLI
    });
    expect(result.editorOutcomes.map((o) => o.editor)).toEqual(["claude-code"]);
  });

  it("respects runMode=always-running with dryRun=true", async () => {
    await fs.mkdir(path.join(dir, ".cursor"));
    const result = await runInitNonInteractive(dir, {
      homeDir: home,
      runMode: "always-running",
      dryRun: true,
      binPath: "/usr/bin/node",
      serviceArgs: ["/krimto/bin/krimto.mjs", "serve"],
    });
    expect(result.serviceInstall).toBeDefined();
    expect(result.serviceInstall?.activated).toBe(false);
  });
});

describe("runInitWizard — fresh setup (no existing config)", () => {
  it("walks the 5 questions and writes the chosen editors", async () => {
    await fs.mkdir(path.join(dir, ".cursor"));
    const io = captureIO();

    // Script: keep cursor, As needed, Just me, Keyword, confirm Y
    promptQueue.push({
      name: "checkbox:Which editors should your AI memory work with?",
      value: ["cursor"] as EditorKind[],
    });
    promptQueue.push({
      name: "select:How should Krimto run?",
      value: "as-needed" as RunMode,
    });
    promptQueue.push({
      name: "select:Who's this for?",
      value: "just-me" as const,
    });
    promptQueue.push({
      name: "select:Smarter search? (optional)",
      value: "keyword" as SearchProvider,
    });
    promptQueue.push({
      name: "confirm:Apply this setup?",
      value: true,
    });

    const result = await runInitWizard(dir, { homeDir: home, io });
    expect(result).not.toBeNull();
    expect(result?.editorOutcomes.map((o) => o.editor)).toEqual(["cursor"]);
    const out = io.stdout.join("");
    expect(out).toContain("Scanning your machine");
    expect(out).toContain("Ready to set up Krimto");
    expect(out).toContain("✅ All set");
    // The post-apply summary should tell the user where their notes will live (smoke-test polish).
    expect(out).toContain("Notes will live at");
    expect(out).toContain(result!.dataDir);
  });

  it("aborts cleanly when the user declines the final confirm", async () => {
    await fs.mkdir(path.join(dir, ".cursor"));
    const io = captureIO();
    promptQueue.push({ name: "checkbox:Which editors should your AI memory work with?", value: ["cursor"] });
    promptQueue.push({ name: "select:How should Krimto run?", value: "as-needed" });
    promptQueue.push({ name: "select:Who's this for?", value: "just-me" });
    promptQueue.push({ name: "select:Smarter search? (optional)", value: "keyword" });
    promptQueue.push({ name: "confirm:Apply this setup?", value: false });

    const result = await runInitWizard(dir, { homeDir: home, io });
    expect(result).toBeNull();
    expect(io.stdout.join("")).toContain("No changes made");
    // Nothing should have been written.
    await expect(fs.access(path.join(home, ".cursor", "mcp.json"))).rejects.toThrow();
  });

  it("'My team' selection short-circuits to the team-init suggestion", async () => {
    const io = captureIO();
    promptQueue.push({ name: "checkbox:Which editors should your AI memory work with?", value: [] });
    promptQueue.push({ name: "select:How should Krimto run?", value: "as-needed" });
    promptQueue.push({ name: "select:Who's this for?", value: "team" });

    const result = await runInitWizard(dir, { homeDir: home, io });
    expect(result).toBeNull();
    expect(io.stdout.join("")).toContain("krimto team init");
  });

  it("Ctrl-C (ExitPromptError) exits with code 130, no partial writes", async () => {
    await fs.mkdir(path.join(dir, ".cursor"));
    const io = captureIO();
    // The mock throws when `value` is an Error instance — simulating the user hitting Ctrl-C
    // at the first prompt. The wizard's `isExitPrompt` sniffer matches on `err.name`.
    const err = new Error("Prompt was exited");
    err.name = "ExitPromptError";
    promptQueue.push({
      name: "checkbox:Which editors should your AI memory work with?",
      value: err,
    });

    const exitCodeBefore = process.exitCode;
    const result = await runInitWizard(dir, { homeDir: home, io });
    expect(result).toBeNull();
    expect(process.exitCode).toBe(130);
    expect(io.stderr.join("")).toContain("Ctrl-C");
    // Nothing should have been written.
    await expect(fs.access(path.join(home, ".cursor", "mcp.json"))).rejects.toThrow();
    process.exitCode = exitCodeBefore; // restore so vitest doesn't inherit it
  });
});

describe("runInitWizard — already configured (reconfigure menu)", () => {
  it("shows the reconfigure menu and 'refresh rule' applies just the rule", async () => {
    // Pre-configure: run --yes once so the snapshot detects "configured".
    await fs.mkdir(path.join(dir, ".cursor"));
    await runInitNonInteractive(dir, { homeDir: home });
    expect((await detectExistingSetup(dir, home)).configured).toBe(true);

    // Delete the rule file to verify the "refresh" path re-creates it.
    await fs.rm(path.join(dir, ".cursor", "rules", "krimto.mdc"));

    const io = captureIO();
    promptQueue.push({
      name: "select:What would you like to do?",
      value: "refresh" as const,
    });

    const result = await runInitWizard(dir, { homeDir: home, io });
    expect(result).not.toBeNull();
    expect(io.stdout.join("")).toContain("Standing rule refreshed");
    await expect(
      fs.readFile(path.join(dir, ".cursor", "rules", "krimto.mdc"), "utf8"),
    ).resolves.toContain("krimto_recall");
  });

  it("'Quit' exits without applying anything", async () => {
    await fs.mkdir(path.join(dir, ".cursor"));
    await runInitNonInteractive(dir, { homeDir: home });

    const io = captureIO();
    promptQueue.push({ name: "select:What would you like to do?", value: "quit" });

    const result = await runInitWizard(dir, { homeDir: home, io });
    expect(result).toBeNull();
    expect(io.stdout.join("")).toContain("No changes made");
  });

  it("'View status' points the user at `krimto status`", async () => {
    await fs.mkdir(path.join(dir, ".cursor"));
    await runInitNonInteractive(dir, { homeDir: home });

    const io = captureIO();
    promptQueue.push({ name: "select:What would you like to do?", value: "status" });

    const result = await runInitWizard(dir, { homeDir: home, io });
    expect(result).toBeNull();
    expect(io.stdout.join("")).toContain("krimto status");
  });
});
