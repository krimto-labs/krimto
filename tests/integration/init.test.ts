// `krimto init` writes the always-use-Krimto standing rule into a project's agent rules files —
// the fix for the discovery problem (agents otherwise route "remember X" to their built-in memory).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  applyWizardAnswers,
  defaultIdentity,
  detectEditorEnvironments,
  detectEditorTargets,
  detectExistingSetup,
  runInit,
  INIT_TARGETS,
  type WizardAnswers,
} from "../../src/cli/init";
import { servicePort } from "../../src/cli/service";

const exec = promisify(execFile);
const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../bin/krimto.mjs");

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "krimto-init-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});
const read = (rel: string): Promise<string> => fs.readFile(path.join(dir, rel), "utf8");

describe("runInit", () => {
  it("writes the standing rule into the standard agent rules files", async () => {
    const res = await runInit(dir);
    expect(res.written).toContain("CLAUDE.md");
    expect(res.written).toContain("AGENTS.md");
    expect(await read("CLAUDE.md")).toContain("krimto_recall");
    expect(await read(path.join(".cursor", "rules", "krimto.mdc"))).toContain("krimto_write");
  });

  it("preserves existing content and is idempotent", async () => {
    await fs.writeFile(path.join(dir, "CLAUDE.md"), "# Team rules\n- use pnpm\n", "utf8");
    await runInit(dir);
    const after1 = await read("CLAUDE.md");
    expect(after1).toContain("# Team rules"); // preserved
    expect(after1).toContain("- use pnpm");
    expect(after1).toContain("krimto_recall"); // added

    const res2 = await runInit(dir); // second run
    expect(res2.written).not.toContain("CLAUDE.md"); // no-op — already up to date
    expect(await read("CLAUDE.md")).toBe(after1);
    expect((after1.match(/<!-- krimto:start -->/g) ?? []).length).toBe(1);
  });
});

describe("detectEditorTargets (G4)", () => {
  it("returns the matching target when CLAUDE.md exists", async () => {
    await fs.writeFile(path.join(dir, "CLAUDE.md"), "# existing\n");
    expect(await detectEditorTargets(dir)).toEqual(["CLAUDE.md"]);
  });

  it("returns CLAUDE.md when .specstory/ exists (Claude Code's transcript dir)", async () => {
    await fs.mkdir(path.join(dir, ".specstory"));
    expect(await detectEditorTargets(dir)).toEqual(["CLAUDE.md"]);
  });

  it("returns the cursor target when .cursor/ exists", async () => {
    await fs.mkdir(path.join(dir, ".cursor"));
    const targets = await detectEditorTargets(dir);
    expect(targets).toEqual([path.join(".cursor", "rules", "krimto.mdc")]);
  });

  it("returns the Gemini target when gemini-extension.json exists", async () => {
    await fs.writeFile(path.join(dir, "gemini-extension.json"), "{}");
    expect(await detectEditorTargets(dir)).toEqual(["GEMINI.md"]);
  });

  it("returns multiple targets when multiple signals match", async () => {
    await fs.writeFile(path.join(dir, "CLAUDE.md"), "# x");
    await fs.mkdir(path.join(dir, ".cursor"));
    const targets = await detectEditorTargets(dir);
    expect(targets).toContain("CLAUDE.md");
    expect(targets).toContain(path.join(".cursor", "rules", "krimto.mdc"));
    expect(targets).not.toContain("GEMINI.md");
  });

  it("returns an empty list when no signals present (caller falls back to all)", async () => {
    expect(await detectEditorTargets(dir)).toEqual([]);
  });
});

describe("detectEditorEnvironments (v0.2.17 — adds MCP-wire info to detection)", () => {
  it("returns all four editors in a clean dir, all present=false", async () => {
    const envs = await detectEditorEnvironments(dir, "/home/test");
    expect(envs.map((e) => e.editor).sort()).toEqual([
      "claude-code",
      "codex",
      "cursor",
      "gemini-cli",
    ]);
    expect(envs.every((e) => e.present === false)).toBe(true);
  });

  it("marks Cursor present when .cursor/ exists, with a json mcpWire pointing at ~/.cursor/mcp.json", async () => {
    await fs.mkdir(path.join(dir, ".cursor"));
    const envs = await detectEditorEnvironments(dir, "/home/test");
    const cursor = envs.find((e) => e.editor === "cursor")!;
    expect(cursor.present).toBe(true);
    expect(cursor.rulesPath).toBe(path.join(".cursor", "rules", "krimto.mdc"));
    expect(cursor.mcpWire).toEqual({
      method: "json",
      path: path.join("/home/test", ".cursor", "mcp.json"),
      key: "mcpServers",
    });
  });

  it("marks Claude Code present via CLAUDE.md, with a cli mcpWire (`claude mcp add krimto`)", async () => {
    await fs.writeFile(path.join(dir, "CLAUDE.md"), "");
    const envs = await detectEditorEnvironments(dir, "/home/test");
    const cc = envs.find((e) => e.editor === "claude-code")!;
    expect(cc.present).toBe(true);
    expect(cc.rulesPath).toBe("CLAUDE.md");
    expect(cc.mcpWire).toEqual({
      method: "cli",
      command: "claude",
      baseArgs: ["mcp", "add", "krimto"],
    });
  });

  it("marks Claude Code present via .specstory/ alone (the smoke-5 signal)", async () => {
    await fs.mkdir(path.join(dir, ".specstory"));
    const envs = await detectEditorEnvironments(dir, "/home/test");
    expect(envs.find((e) => e.editor === "claude-code")!.present).toBe(true);
  });

  it("marks Gemini CLI present via gemini-extension.json (mcpWire null — TOML/manual for now)", async () => {
    await fs.writeFile(path.join(dir, "gemini-extension.json"), "{}");
    const envs = await detectEditorEnvironments(dir, "/home/test");
    const gemini = envs.find((e) => e.editor === "gemini-cli")!;
    expect(gemini.present).toBe(true);
    expect(gemini.rulesPath).toBe("GEMINI.md");
    expect(gemini.mcpWire).toBeNull();
  });

  it("marks Codex present via AGENTS.md (mcpWire null — TOML deferred)", async () => {
    await fs.writeFile(path.join(dir, "AGENTS.md"), "");
    const envs = await detectEditorEnvironments(dir, "/home/test");
    const codex = envs.find((e) => e.editor === "codex")!;
    expect(codex.present).toBe(true);
    expect(codex.rulesPath).toBe("AGENTS.md");
    expect(codex.mcpWire).toBeNull();
  });

  it("defaults homeDir to os.homedir() when omitted", async () => {
    await fs.mkdir(path.join(dir, ".cursor"));
    const envs = await detectEditorEnvironments(dir);
    const cursor = envs.find((e) => e.editor === "cursor")!;
    expect(cursor.mcpWire).toMatchObject({
      method: "json",
      path: path.join(os.homedir(), ".cursor", "mcp.json"),
    });
  });

  // v0.2.21: machine-level installation signals — catches the case where the user is editing
  // in Cursor but the project folder has no editor-specific files yet.
  it("Cursor `installed=true` when homeDir has `.cursor/` (no project signal)", async () => {
    await fs.mkdir(path.join(dir, "some-other-marker"));
    const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), "krimto-fake-home-"));
    await fs.mkdir(path.join(fakeHome, ".cursor"));
    try {
      const envs = await detectEditorEnvironments(dir, fakeHome);
      const cursor = envs.find((e) => e.editor === "cursor")!;
      expect(cursor.present).toBe(false); // no `.cursor/` in cwd
      expect(cursor.installed).toBe(true); // but `.cursor/` in homeDir
    } finally {
      await fs.rm(fakeHome, { recursive: true, force: true });
    }
  });

  it("Claude Code `installed=true` when homeDir has `.claude.json` (no project signal)", async () => {
    const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), "krimto-fake-home-"));
    await fs.writeFile(path.join(fakeHome, ".claude.json"), "{}");
    try {
      const envs = await detectEditorEnvironments(dir, fakeHome);
      const claude = envs.find((e) => e.editor === "claude-code")!;
      expect(claude.present).toBe(false);
      expect(claude.installed).toBe(true);
    } finally {
      await fs.rm(fakeHome, { recursive: true, force: true });
    }
  });

  it("all editors `installed=false` when homeDir has no editor footprints (existing test envs)", async () => {
    // The earlier "all present=false in a clean dir" test used a temp homeDir without any of
    // ~/.cursor/, ~/.claude.json, etc. — pin that behaviour explicitly so a future change to the
    // `installed` heuristic doesn't accidentally flip baseline cleanliness.
    const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), "krimto-fake-home-"));
    try {
      const envs = await detectEditorEnvironments(dir, fakeHome);
      expect(envs.every((e) => e.installed === false)).toBe(true);
    } finally {
      await fs.rm(fakeHome, { recursive: true, force: true });
    }
  });

  it("multiple signals → multiple present=true entries", async () => {
    await fs.mkdir(path.join(dir, ".cursor"));
    await fs.writeFile(path.join(dir, "CLAUDE.md"), "");
    const envs = await detectEditorEnvironments(dir, "/home/test");
    const presentEditors = envs.filter((e) => e.present).map((e) => e.editor).sort();
    expect(presentEditors).toEqual(["claude-code", "cursor"]);
  });
});

describe("runInit auto-detection (G4 + v0.2.16 safer default)", () => {
  it("DEFAULT writes all 4 files even when only `.cursor/` is present — safer than guessing", async () => {
    // This is the smoke-5 failure mode: user has `.cursor/` but is actually using Claude Code.
    // Default behavior must write CLAUDE.md too so the rule reaches the active editor.
    await fs.mkdir(path.join(dir, ".cursor"));
    const res = await runInit(dir);
    expect(res.detected).toBe(false);
    expect(res.written.sort()).toEqual([...INIT_TARGETS].sort());
  });

  it("--minimal honors editor signals and writes only matching files", async () => {
    await fs.mkdir(path.join(dir, ".cursor"));
    const res = await runInit(dir, { minimal: true });
    expect(res.detected).toBe(true);
    expect(res.written).toEqual([path.join(".cursor", "rules", "krimto.mdc")]);
    await expect(fs.access(path.join(dir, "CLAUDE.md"))).rejects.toThrow();
  });

  it("--minimal still writes everything when there are no signals (safe fallback)", async () => {
    const res = await runInit(dir, { minimal: true });
    expect(res.detected).toBe(false);
    expect(res.written.sort()).toEqual([...INIT_TARGETS].sort());
  });

  it("--all (legacy flag, still supported) writes everything", async () => {
    await fs.mkdir(path.join(dir, ".cursor"));
    const res = await runInit(dir, { all: true });
    expect(res.written.sort()).toEqual([...INIT_TARGETS].sort());
  });

  it("`.specstory/` is detected as a Claude Code signal (fixes the smoke-5 false-negative)", async () => {
    // Project has BOTH .cursor/ and .specstory/ — the smoke-5 scenario where Claude Code is the
    // active editor. With --minimal, BOTH editor files must be written.
    await fs.mkdir(path.join(dir, ".cursor"));
    await fs.mkdir(path.join(dir, ".specstory"));
    const res = await runInit(dir, { minimal: true });
    expect(res.detected).toBe(true);
    expect(res.written).toContain("CLAUDE.md"); // ← .specstory/ → Claude Code signal
    expect(res.written).toContain(path.join(".cursor", "rules", "krimto.mdc"));
  });
});

describe("applyWizardAnswers — pure apply step (v0.2.17 wizard)", () => {
  let home: string;
  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "krimto-apply-home-"));
  });
  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  const baseAnswers = (over: Partial<WizardAnswers> = {}): WizardAnswers => ({
    selectedEditors: ["cursor"],
    runMode: "as-needed",
    whoFor: "just-me",
    search: { provider: "keyword" },
    identity: "alice@acme.com",
    ...over,
  });

  it("writes Cursor's MCP config + standing rule when 'cursor' is selected (as-needed mode)", async () => {
    await fs.mkdir(path.join(dir, ".cursor"));
    const res = await applyWizardAnswers(dir, baseAnswers(), { homeDir: home });

    const cursorOutcome = res.editorOutcomes.find((o) => o.editor === "cursor")!;
    expect(cursorOutcome.mcpAction).toBe("created");
    expect(cursorOutcome.ruleWritten).toBe(true);
    expect(cursorOutcome.rulePath).toBe(path.join(".cursor", "rules", "krimto.mdc"));

    const cursorMcp = JSON.parse(
      await fs.readFile(path.join(home, ".cursor", "mcp.json"), "utf8"),
    ) as { mcpServers: { krimto: { command: string; env: Record<string, string> } } };
    expect(cursorMcp.mcpServers.krimto.command).toBe("npx");
    expect(cursorMcp.mcpServers.krimto.env.KRIMTO_IDENTITY).toBe("alice@acme.com");

    const rule = await fs.readFile(path.join(dir, ".cursor", "rules", "krimto.mdc"), "utf8");
    expect(rule).toContain("<!-- krimto:start -->");
    expect(rule).toContain("krimto_recall");
  });

  it("bakes KRIMTO_EMBED_PROVIDER + key into the MCP env when search is OpenAI", async () => {
    await fs.mkdir(path.join(dir, ".cursor"));
    await applyWizardAnswers(
      dir,
      baseAnswers({ search: { provider: "openai", apiKey: "sk-test-123" } }),
      { homeDir: home },
    );
    const cursorMcp = JSON.parse(
      await fs.readFile(path.join(home, ".cursor", "mcp.json"), "utf8"),
    ) as { mcpServers: { krimto: { env: Record<string, string> } } };
    expect(cursorMcp.mcpServers.krimto.env.KRIMTO_EMBED_PROVIDER).toBe("openai");
    expect(cursorMcp.mcpServers.krimto.env.KRIMTO_EMBED_API_KEY).toBe("sk-test-123");
  });

  it("writes an HTTP MCP entry (no env) when run mode is 'always-running'", async () => {
    await fs.mkdir(path.join(dir, ".cursor"));
    const res = await applyWizardAnswers(
      dir,
      baseAnswers({ runMode: "always-running" }),
      {
        homeDir: home,
        dryRun: true,
        binPath: "/usr/bin/node",
        serviceArgs: ["/krimto/bin/krimto.mjs", "serve"],
      },
    );
    const cursorMcp = JSON.parse(
      await fs.readFile(path.join(home, ".cursor", "mcp.json"), "utf8"),
    ) as { mcpServers: { krimto: { url: string } } };
    // The editor HTTP entry + the service env must wire the SAME per-install port, derived from
    // this (non-default, temp) data dir — so it's distinct from another install's :8080.
    const expectedPort = servicePort(path.join(home, ".krimto"));
    expect(expectedPort).not.toBe(8080);
    expect(cursorMcp.mcpServers.krimto.url).toBe(`http://localhost:${expectedPort}/mcp`);
    expect(res.serviceInstall?.unitContents).toContain(`<string>${expectedPort}</string>`);
    expect(res.serviceInstall).toBeDefined();
    expect(res.serviceInstall?.activated).toBe(false); // dryRun
    expect(res.serviceInstall?.platform).toBeDefined();
  });

  it("falls back to keyless stdio (NOT a tokenless HTTP entry) when the always-running server is in team mode", async () => {
    await fs.mkdir(path.join(dir, ".cursor"));
    // Team mode = an org admin in members.yaml — the bearer-auth switch. A keyless HTTP entry to such
    // a server silently 401s (the editor drops the tools with no error: the krimto-smoke-6 failure).
    const dataDir = path.join(home, ".krimto");
    await fs.mkdir(path.join(dataDir, ".krimto"), { recursive: true });
    await fs.writeFile(
      path.join(dataDir, ".krimto", "members.yaml"),
      "org:\n  slug: acme\n  admins:\n    - alice@acme.com\nteams: []\nusers: []\n",
    );
    await applyWizardAnswers(
      dir,
      baseAnswers({ runMode: "always-running" }),
      { homeDir: home, dryRun: true, binPath: "/usr/bin/node", serviceArgs: ["/krimto/bin/krimto.mjs", "serve"] },
    );
    const cursorMcp = JSON.parse(
      await fs.readFile(path.join(home, ".cursor", "mcp.json"), "utf8"),
    ) as { mcpServers: { krimto: { command?: string; url?: string } } };
    expect(cursorMcp.mcpServers.krimto.url).toBeUndefined(); // no tokenless HTTP entry that 401s
    expect(cursorMcp.mcpServers.krimto.command).toBe("npx"); // keyless stdio that actually works
  });

  it("reports 'manual' for Gemini CLI (mcpWire null) and still writes the rule file", async () => {
    await fs.writeFile(path.join(dir, "gemini-extension.json"), "{}");
    const res = await applyWizardAnswers(
      dir,
      baseAnswers({ selectedEditors: ["gemini-cli"] }),
      { homeDir: home },
    );
    const gemini = res.editorOutcomes.find((o) => o.editor === "gemini-cli")!;
    expect(gemini.mcpAction).toBe("manual");
    expect(gemini.manualSnippet).toContain("krimto");
    expect(gemini.ruleWritten).toBe(true);
    expect(await fs.readFile(path.join(dir, "GEMINI.md"), "utf8")).toContain("krimto_recall");
  });

  it("idempotent: re-applying identical answers reports no-change / ruleWritten=false", async () => {
    await fs.mkdir(path.join(dir, ".cursor"));
    await applyWizardAnswers(dir, baseAnswers(), { homeDir: home });
    const res = await applyWizardAnswers(dir, baseAnswers(), { homeDir: home });
    const cursorOutcome = res.editorOutcomes.find((o) => o.editor === "cursor")!;
    expect(cursorOutcome.mcpAction).toBe("no-change");
    expect(cursorOutcome.ruleWritten).toBe(false);
  });

  it("only writes for selected editors, even if multiple are present", async () => {
    await fs.mkdir(path.join(dir, ".cursor"));
    await fs.writeFile(path.join(dir, "CLAUDE.md"), "");
    const res = await applyWizardAnswers(
      dir,
      baseAnswers({ selectedEditors: ["cursor"] }), // not claude-code
      { homeDir: home, dryRun: true },
    );
    expect(res.editorOutcomes.map((o) => o.editor)).toEqual(["cursor"]);
  });
});

describe("detectExistingSetup", () => {
  let home: string;
  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "krimto-existing-home-"));
  });
  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  it("reports configured=false on a clean machine", async () => {
    const snap = await detectExistingSetup(dir, home);
    expect(snap.configured).toBe(false);
    expect(snap.registeredEditors).toEqual([]);
    expect(snap.runMode).toBe("as-needed");
    expect(snap.searchProvider).toBe("keyword");
  });

  it("reports configured=true with cursor registered after a wizard apply", async () => {
    await fs.mkdir(path.join(dir, ".cursor"));
    await applyWizardAnswers(
      dir,
      {
        selectedEditors: ["cursor"],
        runMode: "as-needed",
        whoFor: "just-me",
        search: { provider: "keyword" },
        identity: "alice@acme.com",
      },
      { homeDir: home },
    );
    const snap = await detectExistingSetup(dir, home);
    expect(snap.configured).toBe(true);
    expect(snap.registeredEditors).toEqual(["cursor"]);
    expect(snap.runMode).toBe("as-needed");
    expect(snap.searchProvider).toBe("keyword");
  });

  it("reports searchProvider='openai' when the MCP env carries the KRIMTO_EMBED_PROVIDER flag", async () => {
    await fs.mkdir(path.join(dir, ".cursor"));
    await applyWizardAnswers(
      dir,
      {
        selectedEditors: ["cursor"],
        runMode: "as-needed",
        whoFor: "just-me",
        search: { provider: "openai", apiKey: "sk-test" },
        identity: "alice@acme.com",
      },
      { homeDir: home },
    );
    const snap = await detectExistingSetup(dir, home);
    expect(snap.searchProvider).toBe("openai");
  });
});

describe("defaultIdentity", () => {
  it("returns either a real email-shaped string or the safe fallback", async () => {
    const id = await defaultIdentity();
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
    // Either the safe default OR a real email-shaped string.
    expect(/^[^@\s]+@[^@\s]+$/.test(id)).toBe(true);
  });
});

describe("krimto init (bin dispatch)", () => {
  it("`node bin/krimto.mjs init` writes the rule in the current directory", async () => {
    await exec(process.execPath, [BIN, "init"], { cwd: dir });
    expect(await read("AGENTS.md")).toContain("krimto_recall");
  }, 30000);

  it("prints the AUTO MODE confirmation + next steps + how to undo", async () => {
    // v0.2.32: the "To undo:" single-line message was replaced with three honest off-ramps
    // ("To stop the service", "To undo this project only", "To disconnect everything") so
    // users aren't stranded thinking `uninit` is the full stop button. Test the new shape.
    const { stderr } = await exec(process.execPath, [BIN, "init"], { cwd: dir });
    expect(stderr).toContain("AUTO MODE on");
    expect(stderr).toContain("Next steps");
    expect(stderr).toContain("To stop the service");
    expect(stderr).toContain("To undo this project only");
    expect(stderr).toContain("To disconnect everything");
  }, 30000);

  it("surfaces `krimto uninit` prominently on success", async () => {
    const { stderr } = await exec(process.execPath, [BIN, "init"], { cwd: dir });
    expect(stderr).toContain("npx @krimto-labs/krimto uninit");
  }, 30000);

  it("mentions `krimto uninit` on the no-op path too (so a re-run discovers it)", async () => {
    // First run writes the rule. Second run is a no-op.
    await exec(process.execPath, [BIN, "init"], { cwd: dir });
    const { stderr } = await exec(process.execPath, [BIN, "init"], { cwd: dir });
    expect(stderr).toContain("Already in AUTO MODE");
    expect(stderr).toContain("npx @krimto-labs/krimto uninit");
  }, 30000);

  // v014 work item 4 — DATA-LOCATION HINT. The data-location surprise (facts always land in
  // ~/.krimto regardless of CWD) must be surfaced on first-run init, not just in the wizard /
  // --yes paths. A user who runs `krimto init` (or has it run for them in a non-TTY editor)
  // should be told where their notes live.
  it("init output surfaces the data location (where notes live)", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "krimto-init-home-"));
    try {
      const { stderr } = await exec(process.execPath, [BIN, "init"], {
        cwd: dir,
        env: { ...process.env, KRIMTO_DATA: path.join(home, ".krimto") },
      });
      // The resolved data dir is named explicitly...
      expect(stderr).toContain(path.join(home, ".krimto"));
      // ...with a "where your notes/data live" callout so the user can find it later.
      expect(stderr).toMatch(/notes? (live|stored)|data (live|dir|stored)|where.*live/i);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  }, 30000);
});
