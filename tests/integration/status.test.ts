// Tests for src/cli/status.ts — the v0.2.17 consolidated `krimto status` command.
//
// We exercise three states the report can produce:
//   • "error"   — fresh data dir, nothing configured → tells the user how to get started
//   • "ok"      — wired in via the wizard + recent activity present
//   • "warning" — hijack pattern (3+ recalls, 0 writes in 5 min) detected
//
// And we verify the section structure matches the §04 mockup (Connections / Storage /
// Optional add-ons / Recent activity).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { runStatus } from "../../src/cli/status";
import { runInitNonInteractive } from "../../src/cli/wizard";

const exec = promisify(execFile);

let dataDir: string;
let projectDir: string;
let home: string;
beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "krimto-status-data-"));
  projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "krimto-status-proj-"));
  home = await fs.mkdtemp(path.join(os.tmpdir(), "krimto-status-home-"));
});
afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
  await fs.rm(projectDir, { recursive: true, force: true });
  await fs.rm(home, { recursive: true, force: true });
});

describe("runStatus — error path (nothing set up)", () => {
  it("reports status=error and points at `krimto init`", async () => {
    const res = await runStatus(dataDir, { cwd: projectDir, homeDir: home });
    expect(res.status).toBe("error");
    expect(res.message).toContain("isn't set up");
    expect(res.message).toContain("krimto init");
  });
});

describe("runStatus — team sync reflects the real git remote", () => {
  it("shows push + pull when an origin remote is configured (no KRIMTO_GIT_REMOTE needed)", async () => {
    await exec("git", ["-C", dataDir, "init"]);
    await exec("git", ["-C", dataDir, "remote", "add", "origin", "git@github.com:acme/krimto-data.git"]);
    const prev = process.env.KRIMTO_GIT_REMOTE;
    delete process.env.KRIMTO_GIT_REMOTE; // prove it reads the remote, not the env var
    try {
      const res = await runStatus(dataDir, { cwd: projectDir, homeDir: home });
      expect(res.message).toContain("git@github.com:acme/krimto-data.git");
      expect(res.message).toMatch(/push \+ pull/);
    } finally {
      if (prev !== undefined) process.env.KRIMTO_GIT_REMOTE = prev;
    }
  });
});

describe("runStatus — ok path (wizard already applied)", () => {
  it("reports status=ok with the Connections + Storage + Add-ons sections", async () => {
    await fs.mkdir(path.join(projectDir, ".cursor"));
    await runInitNonInteractive(projectDir, { homeDir: home });

    const res = await runStatus(dataDir, { cwd: projectDir, homeDir: home });
    expect(res.status).toBe("ok");
    expect(res.message).toContain("✅ Krimto");
    expect(res.message).toContain("━━ Connections ━━");
    expect(res.message).toContain("✓ Cursor");
    expect(res.message).toContain("━━ Storage ━━");
    expect(res.message).toContain(dataDir);
    expect(res.message).toContain("━━ Optional add-ons ━━");
    expect(res.message).toContain("Semantic search:");
    expect(res.message).toContain("not configured · using keyword");
    expect(res.message).toContain("━━ Recent activity");
  });

  it("reports the OpenAI semantic provider when the wizard configured it", async () => {
    await fs.mkdir(path.join(projectDir, ".cursor"));
    await runInitNonInteractive(projectDir, {
      homeDir: home,
      search: "openai",
      dryRun: true, // don't try to call OpenAI for real in tests
    });
    // runInitNonInteractive's --yes path reads OPENAI_API_KEY from env when search=openai.
    // In a clean test env that key is empty; the MCP entry is still written with the placeholder.
    const res = await runStatus(dataDir, { cwd: projectDir, homeDir: home });
    expect(res.message).toContain("Semantic search:");
    expect(res.message).toContain("OpenAI");
  });
});

describe("runStatus — warning path (hijack pattern)", () => {
  it("warns when the activity log shows 3+ recalls and 0 writes in the last 5min", async () => {
    await fs.mkdir(path.join(projectDir, ".cursor"));
    await runInitNonInteractive(projectDir, { homeDir: home });

    // Seed an activity log with the hijack pattern.
    const activityPath = path.join(dataDir, ".krimto", "activity.jsonl");
    await fs.mkdir(path.dirname(activityPath), { recursive: true });
    const now = Date.now();
    const lines = [
      { timestamp: new Date(now - 60_000).toISOString(), tool: "krimto_recall", identity: "alice@acme.com", detail: '"staging" → 0 hit(s)' },
      { timestamp: new Date(now - 90_000).toISOString(), tool: "krimto_recall", identity: "alice@acme.com", detail: '"deploys" → 0 hit(s)' },
      { timestamp: new Date(now - 120_000).toISOString(), tool: "krimto_recall", identity: "alice@acme.com", detail: '"db reset" → 0 hit(s)' },
    ];
    await fs.writeFile(activityPath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");

    const res = await runStatus(dataDir, {
      cwd: projectDir,
      homeDir: home,
      now: new Date(now),
    });
    expect(res.status).toBe("warning");
    expect(res.message).toContain("Hijack suspected");
    expect(res.message).toContain("3 recalls, 0 writes");
  });
});

describe("runStatus — recent activity rendering", () => {
  it("shows recent entries newest-first with human-readable ago timestamps", async () => {
    await fs.mkdir(path.join(projectDir, ".cursor"));
    await runInitNonInteractive(projectDir, { homeDir: home });

    const activityPath = path.join(dataDir, ".krimto", "activity.jsonl");
    await fs.mkdir(path.dirname(activityPath), { recursive: true });
    const now = Date.now();
    const lines = [
      { timestamp: new Date(now - 600_000).toISOString(), tool: "krimto_write", identity: "alice@acme.com", detail: "user/alice: pnpm" },
      { timestamp: new Date(now - 30_000).toISOString(), tool: "krimto_recall", identity: "alice@acme.com", detail: '"pnpm"' },
    ];
    await fs.writeFile(activityPath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");

    const res = await runStatus(dataDir, {
      cwd: projectDir,
      homeDir: home,
      now: new Date(now),
    });
    expect(res.message).toMatch(/Recall.*pnpm.*30s ago/);
    expect(res.message).toMatch(/Saved.*pnpm.*10m ago/);
  });
});
