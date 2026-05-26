// Tests for src/cli/teamInit.ts — the v0.2.17.1 admin-side team-mode wizard.
//
// Two cuts:
//   • `applyTeamInit` — pure orchestrator, exercised directly against temp dirs.
//   • `runTeamInit` — interactive flow with mocked `@inquirer/prompts`.
//
// Verifies the membership.yaml writes, key issuance, idempotency, and the rendered
// "DM template for each teammate" footer (the user-facing payoff of the wizard).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";

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
  input: vi.fn(async (config: { message: string }) => nextAnswer(`input:${config.message}`)),
}));

import { applyTeamInit, runTeamInit, type TeamInitAnswers } from "../../src/cli/teamInit";

interface MembersYaml {
  org?: { slug?: string; admins?: string[] };
  teams?: { slug?: string; name?: string; members?: string[]; leads?: string[] }[];
  users?: { email?: string; created?: string }[];
}
interface KeyRecord {
  identity: string;
  prefix: string;
}

let dataDir: string;
beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "krimto-teaminit-"));
  promptQueue.length = 0;
});
afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

const baseAnswers = (over: Partial<TeamInitAnswers> = {}): TeamInitAnswers => ({
  adminEmail: "maria@acme.com",
  teamSlug: "backend",
  teamName: "Backend team",
  gitRemote: undefined,
  teammates: ["ben@acme.com", "priya@acme.com"],
  ...over,
});

describe("applyTeamInit — pure apply step", () => {
  it("bootstraps the admin, creates the team, and invites the teammates", async () => {
    const res = await applyTeamInit(baseAnswers(), { dataDir });

    expect(res.adminEmail).toBe("maria@acme.com");
    expect(res.adminKey).not.toBeNull();
    expect(res.teamSlug).toBe("backend");
    expect(res.invites).toHaveLength(2);
    expect(res.invites.map((i) => i.email).sort()).toEqual(["ben@acme.com", "priya@acme.com"]);
    for (const inv of res.invites) {
      expect(inv.key).toMatch(/^krm_(live|test)_[A-Za-z0-9]{32}$/);
    }
  });

  it("writes a well-formed members.yaml", async () => {
    await applyTeamInit(baseAnswers(), { dataDir });
    const yamlText = await fs.readFile(path.join(dataDir, ".krimto", "members.yaml"), "utf8");
    const parsed = parseYaml(yamlText) as MembersYaml;
    expect(parsed.org?.admins).toContain("maria@acme.com");
    expect(parsed.users?.map((u) => u.email).sort()).toEqual([
      "ben@acme.com",
      "maria@acme.com",
      "priya@acme.com",
    ]);
    const team = parsed.teams?.find((t) => t.slug === "backend");
    expect(team).toBeDefined();
    expect(team?.members).toEqual(expect.arrayContaining(["ben@acme.com", "priya@acme.com"]));
    expect(team?.name).toBe("Backend team");
  });

  it("issues a key per teammate (stored hashed in keys.json)", async () => {
    await applyTeamInit(baseAnswers(), { dataDir });
    const keysText = await fs.readFile(path.join(dataDir, ".krimto", "keys.json"), "utf8");
    const records = JSON.parse(keysText) as KeyRecord[];
    const identities = records.map((r) => r.identity).sort();
    expect(identities).toEqual(["ben@acme.com", "maria@acme.com", "priya@acme.com"]);
  });

  it("is idempotent: re-running doesn't re-issue keys for teammates who already have one", async () => {
    const first = await applyTeamInit(baseAnswers(), { dataDir });
    const second = await applyTeamInit(baseAnswers(), { dataDir });
    expect(first.invites).toHaveLength(2);
    expect(second.invites).toHaveLength(0); // already had keys, no churn
    expect(second.adminKey).toBeNull(); // bootstrapAdmin idempotency
  });

  it("captures the git remote URL when given (skipRemoteSetup avoids touching real git in tests)", async () => {
    const res = await applyTeamInit(
      baseAnswers({ gitRemote: "git@github.com:acme/krimto-data.git" }),
      { dataDir, skipRemoteSetup: true },
    );
    expect(res.remote?.url).toBe("git@github.com:acme/krimto-data.git");
    expect(res.remote?.pushStatus).toBe("ok");
  });

  it("defaults serverHost to localhost:8080 when KRIMTO_HTTP_PORT isn't set", async () => {
    const res = await applyTeamInit(baseAnswers(), { dataDir });
    expect(res.serverHost).toBe("localhost:8080");
  });

  it("honors the port override (used in tests; production reads KRIMTO_HTTP_PORT)", async () => {
    const res = await applyTeamInit(baseAnswers(), { dataDir, port: 4242 });
    expect(res.serverHost).toBe("localhost:4242");
  });

  it("works without any teammates (admin-only init)", async () => {
    const res = await applyTeamInit(baseAnswers({ teammates: [] }), { dataDir });
    expect(res.invites).toEqual([]);
    expect(res.adminKey).not.toBeNull();
  });
});

describe("runTeamInit — interactive flow", () => {
  function captureIO(): {
    out: (s: string) => void;
    err: (s: string) => void;
    stdout: string[];
    stderr: string[];
  } {
    const stdout: string[] = [];
    const stderr: string[] = [];
    return {
      out: (s) => stdout.push(s),
      err: (s) => stderr.push(s),
      stdout,
      stderr,
    };
  }

  it("walks the 4 questions, applies, and prints the DM template", async () => {
    const io = captureIO();
    promptQueue.push({ name: "input:What's your email? (this becomes the admin account)", value: "maria@acme.com" });
    promptQueue.push({
      name: 'input:What\'s your team called? (lowercase slug — e.g. "backend", "infra", "growth")',
      value: "backend",
    });
    promptQueue.push({
      name: 'input:Team display name (optional — press Enter to use "backend")',
      value: "Backend team",
    });
    promptQueue.push({
      name: "select:Set up a shared git remote for cross-machine sync?",
      value: "later",
    });
    promptQueue.push({
      name: "input:Invite teammates now? (comma-separated emails, or press Enter to skip)",
      value: "ben@acme.com, priya@acme.com",
    });
    promptQueue.push({ name: "confirm:Apply this setup?", value: true });

    const res = await runTeamInit({ io, dataDir });
    expect(res).not.toBeNull();
    expect(res?.invites).toHaveLength(2);

    const out = io.stdout.join("");
    expect(out).toContain("✅ Team mode is on");
    expect(out).toContain("DM template for each teammate");
    expect(out).toContain("krimto join");
    expect(out).toContain("ben@acme.com");
    expect(out).toContain("priya@acme.com");
    expect(out).toContain("KRIMTO_BOOTSTRAP_ADMIN=maria@acme.com");
  });

  it("aborts cleanly when the user declines the final confirm", async () => {
    const io = captureIO();
    promptQueue.push({ name: "input:What's your email? (this becomes the admin account)", value: "maria@acme.com" });
    promptQueue.push({
      name: 'input:What\'s your team called? (lowercase slug — e.g. "backend", "infra", "growth")',
      value: "backend",
    });
    promptQueue.push({
      name: 'input:Team display name (optional — press Enter to use "backend")',
      value: "",
    });
    promptQueue.push({
      name: "select:Set up a shared git remote for cross-machine sync?",
      value: "later",
    });
    promptQueue.push({
      name: "input:Invite teammates now? (comma-separated emails, or press Enter to skip)",
      value: "",
    });
    promptQueue.push({ name: "confirm:Apply this setup?", value: false });

    const res = await runTeamInit({ io, dataDir });
    expect(res).toBeNull();
    expect(io.stdout.join("")).toContain("No changes made");
    // members.yaml shouldn't exist — nothing was applied.
    await expect(fs.access(path.join(dataDir, ".krimto", "members.yaml"))).rejects.toThrow();
  });

  it("Ctrl-C at the first prompt exits 130 with no writes", async () => {
    const io = captureIO();
    const err = new Error("Prompt was exited");
    err.name = "ExitPromptError";
    promptQueue.push({ name: "input:What's your email? (this becomes the admin account)", value: err });

    const exitBefore = process.exitCode;
    const res = await runTeamInit({ io, dataDir });
    expect(res).toBeNull();
    expect(process.exitCode).toBe(130);
    process.exitCode = exitBefore;
  });
});
