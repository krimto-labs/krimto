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

  it("v0.2.20 smart default: 1 detected editor → as-needed (no service install)", async () => {
    await fs.mkdir(path.join(dir, ".cursor"));
    const result = await runInitNonInteractive(dir, { homeDir: home, dryRun: true });
    // Only Cursor signal present → exactly 1 detected → as-needed (no service install).
    expect(result.editorOutcomes.map((o) => o.editor)).toEqual(["cursor"]);
    expect(result.serviceInstall).toBeUndefined();
  });

  it("v0.2.20 smart default: 2+ detected editors → always-running (service install fires)", async () => {
    // Two editor signals: cursor + claude-code.
    await fs.mkdir(path.join(dir, ".cursor"));
    await fs.writeFile(path.join(dir, "CLAUDE.md"), "");
    const result = await runInitNonInteractive(dir, {
      homeDir: home,
      dryRun: true,
      binPath: "/usr/bin/node",
      serviceArgs: ["/krimto/bin/krimto.mjs", "serve"],
    });
    expect(result.editorOutcomes.map((o) => o.editor).sort()).toEqual([
      "claude-code",
      "cursor",
    ]);
    expect(result.serviceInstall).toBeDefined();
    expect(result.serviceInstall?.activated).toBe(false); // dryRun
  });

  it("v0.2.20 smart default: explicit runMode override wins over the smart default", async () => {
    await fs.mkdir(path.join(dir, ".cursor"));
    await fs.writeFile(path.join(dir, "CLAUDE.md"), "");
    const result = await runInitNonInteractive(dir, {
      homeDir: home,
      runMode: "as-needed", // explicit override on a 2-editor setup
      dryRun: true,
    });
    expect(result.serviceInstall).toBeUndefined(); // override honored
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
  // v0.2.35 — these tests now go through `inspectRuntime` which shells out to `claude mcp
  // list`. On dev machines with HTTP MCP servers configured (the typical case), that
  // health-checks each one and can take up to 8s. We extend the timeout accordingly.
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

    const result = await runInitWizard(dir, { homeDir: home, io, dataDir: path.join(home, ".krimto") });
    expect(result).not.toBeNull();
    expect(io.stdout.join("")).toContain("Standing rule refreshed");
    await expect(
      fs.readFile(path.join(dir, ".cursor", "rules", "krimto.mdc"), "utf8"),
    ).resolves.toContain("krimto_recall");
  }, 30000);

  it("'Quit' exits without applying anything", async () => {
    await fs.mkdir(path.join(dir, ".cursor"));
    await runInitNonInteractive(dir, { homeDir: home });

    const io = captureIO();
    promptQueue.push({ name: "select:What would you like to do?", value: "quit" });

    const result = await runInitWizard(dir, { homeDir: home, io, dataDir: path.join(home, ".krimto") });
    expect(result).toBeNull();
    expect(io.stdout.join("")).toContain("No changes made");
  }, 30000);

  it("'View status' points the user at `krimto status`", async () => {
    await fs.mkdir(path.join(dir, ".cursor"));
    await runInitNonInteractive(dir, { homeDir: home });

    const io = captureIO();
    promptQueue.push({ name: "select:What would you like to do?", value: "status" });

    const result = await runInitWizard(dir, { homeDir: home, io, dataDir: path.join(home, ".krimto") });
    expect(result).toBeNull();
    expect(io.stdout.join("")).toContain("krimto status");
  }, 30000);

  // v0.2.35 — the smoke-6 user read "Krimto is already set up on this machine" as
  // "Krimto is running" and was confused when the process wasn't actually serving. The
  // menu now drops the ambiguous phrase, leads with neutral "Krimto on this machine:"
  // chrome, and shows a real Service: line driven by inspectRuntime.
  it("header uses 'Krimto on this machine:' (not the old 'already set up')", async () => {
    await fs.mkdir(path.join(dir, ".cursor"));
    await runInitNonInteractive(dir, { homeDir: home });

    const io = captureIO();
    promptQueue.push({ name: "select:What would you like to do?", value: "quit" });

    await runInitWizard(dir, { homeDir: home, io, dataDir: path.join(home, ".krimto") });
    const out = io.stdout.join("");
    expect(out).toContain("Krimto on this machine:");
    expect(out).not.toContain("already set up");
    // The new Service: line is present — its exact text varies by runtime, but it MUST
    // always appear so the user always sees runtime state, not just config snapshot.
    expect(out).toContain("Service:");
  }, 30000);

  it("shows 'Not running' when no service AND no live process holds the lock", async () => {
    await fs.mkdir(path.join(dir, ".cursor"));
    // runInitNonInteractive with the default config installs no service in dryRun. Force
    // dryRun so the service-install path never touches the real host.
    await runInitNonInteractive(dir, { homeDir: home, dryRun: true });

    const io = captureIO();
    promptQueue.push({ name: "select:What would you like to do?", value: "quit" });

    await runInitWizard(dir, { homeDir: home, io, dataDir: path.join(home, ".krimto") });
    expect(io.stdout.join("")).toContain("Not running");
    expect(io.stdout.join("")).toContain("editor launches it on demand");
  }, 30000);

  it("'Start it running continuously' routes to applyService (dryRun-safe)", async () => {
    await fs.mkdir(path.join(dir, ".cursor"));
    await runInitNonInteractive(dir, { homeDir: home, dryRun: true });

    const io = captureIO();
    promptQueue.push({
      name: "select:What would you like to do?",
      value: "start-service" as const,
    });
    const result = await runInitWizard(dir, {
      homeDir: home,
      io,
      dryRun: true,
      dataDir: path.join(home, ".krimto"),
    });
    expect(result).toBeNull();
    expect(io.stdout.join("")).toContain("Installing background service");
  }, 30000);
});
