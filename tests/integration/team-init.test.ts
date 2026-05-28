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

import { createServer } from "node:http";
import { canRead, canWrite, loadMembership } from "../../src/access/membership";
import { FactStore } from "../../src/storage/store";
import {
  applyTeamInit,
  confirmTeamModeLive,
  detectNotesOwner,
  runTeamInit,
  runTeamInitNonInteractive,
  type TeamInitAnswers,
} from "../../src/cli/teamInit";

interface MembersYaml {
  org?: { slug?: string; name?: string; admins?: string[] };
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

// The interactive org-name prompt (added in the org-naming change). Its mock key, reused across the
// interactive flow tests so they stay in sync with the prompt's wording.
const ORG_PROMPT =
  'input:What\'s your organization called? (e.g. "Acme Inc" — for company-wide notes; Enter to skip)';

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

  // The creator must be a MEMBER of the team they just made — otherwise they're an org-admin who
  // can technically write team/<slug> but can't read it back, so krimtoWrite's ghost-fact guard
  // refuses. Adding them as a member makes "remember for the team" work for the admin too.
  it("adds the creator as a team member so they can write team notes", async () => {
    await applyTeamInit(baseAnswers(), { dataDir });
    const parsed = parseYaml(
      await fs.readFile(path.join(dataDir, ".krimto", "members.yaml"), "utf8"),
    ) as MembersYaml;
    const team = parsed.teams?.find((t) => t.slug === "backend");
    expect(team?.members).toContain("maria@acme.com");
    expect(team?.name).toBe("Backend team"); // name preserved (createTeam ran before the add)

    // The admin can now both write AND read the team scope (no ghost-fact refusal).
    const mem = await loadMembership(dataDir);
    expect(canWrite(mem, "maria@acme.com", "team/backend")).toBe(true);
    expect(canRead(mem, "maria@acme.com", "team/backend")).toBe(true);
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

  it("names the org and derives a path-safe slug from the org name", async () => {
    const res = await applyTeamInit(baseAnswers({ orgName: "Acme Inc" }), { dataDir });
    expect(res.orgName).toBe("Acme Inc");
    expect(res.orgSlug).toBe("acme-inc");
    const parsed = parseYaml(
      await fs.readFile(path.join(dataDir, ".krimto", "members.yaml"), "utf8"),
    ) as MembersYaml;
    expect(parsed.org?.name).toBe("Acme Inc");
    expect(parsed.org?.slug).toBe("acme-inc");
  });

  it("leaves the org slug 'default' when no org name is given", async () => {
    const res = await applyTeamInit(baseAnswers(), { dataDir });
    expect(res.orgSlug).toBe("default");
    expect(res.orgName).toBeUndefined();
  });

  it("keeps the existing org slug (no orphaning) when company-wide notes already exist", async () => {
    // A company-wide note already lives under the current default org scope.
    await new FactStore(dataDir).writeFact({
      scope: "org/default",
      title: "company holiday",
      body: "office closed Dec 25",
      author: "maria@acme.com",
    });
    const res = await applyTeamInit(baseAnswers({ orgName: "Acme Inc" }), { dataDir });
    expect(res.orgName).toBe("Acme Inc"); // display name still set
    expect(res.orgSlug).toBe("default"); // slug unchanged — the existing note isn't orphaned
    const parsed = parseYaml(
      await fs.readFile(path.join(dataDir, ".krimto", "members.yaml"), "utf8"),
    ) as MembersYaml;
    expect(parsed.org?.name).toBe("Acme Inc");
    expect(parsed.org?.slug).toBe("default");
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

  // Smoke-6 follow-up: invite keys + DM template land in a 0600 file so the admin can
  // recover them if scrollback is lost. Admin's key is shown-once-only; without this
  // backup the only recovery is `reset-admin-key`.
  it("writes invite keys + DM template to a 0600 file", async () => {
    const res = await applyTeamInit(baseAnswers(), { dataDir });
    expect(res.inviteFilePath).toBeDefined();
    const stat = await fs.stat(res.inviteFilePath!);
    expect((stat.mode & 0o777).toString(8)).toBe("600");
    const body = await fs.readFile(res.inviteFilePath!, "utf8");
    expect(body).toContain("maria@acme.com");
    expect(body).toContain(res.adminKey);
    expect(body).toContain("ben@acme.com");
    expect(body).toContain("priya@acme.com");
    // Every minted key is present so the admin can DM them out from the file alone.
    for (const inv of res.invites) expect(body).toContain(inv.key);
    expect(body).toContain("npx @krimto-labs/krimto join");
  });

  it("skips the invite file on idempotent rerun when no new keys were minted", async () => {
    await applyTeamInit(baseAnswers(), { dataDir });
    const second = await applyTeamInit(baseAnswers(), { dataDir });
    // No admin key reissued + no teammate keys reissued = no new file. The first run's
    // file is still on disk (we don't delete prior backups).
    expect(second.adminKey).toBeNull();
    expect(second.invites).toEqual([]);
    expect(second.inviteFilePath).toBeUndefined();
  });
});

// detectNotesOwner finds the identity that already owns notes, so the wizard keeps it as the
// admin instead of silently splitting the solo user into two identities.
describe("detectNotesOwner", () => {
  it("returns the user identity with the most notes", async () => {
    const store = new FactStore(dataDir);
    await store.writeFact({ scope: "user/old@x.com", title: "note one", body: "a", author: "old@x.com" });
    await store.writeFact({ scope: "user/old@x.com", title: "note two", body: "b", author: "old@x.com" });
    await store.writeFact({ scope: "user/other@x.com", title: "note three", body: "c", author: "other@x.com" });
    expect(await detectNotesOwner(dataDir)).toEqual({ email: "old@x.com", factCount: 2 });
  });

  it("returns null when no user notes exist", async () => {
    expect(await detectNotesOwner(dataDir)).toBeNull();
  });
});

// Live activation replaces the v0.2.36 restart dance: members.yaml is the switch, and the wizard
// only VERIFIES the running server flipped (polls /mcp for 401) instead of restarting anything.
describe("confirmTeamModeLive", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    if (close) await close();
    close = undefined;
  });
  async function serveStatus(status: number): Promise<string> {
    const srv = createServer((_req, res) => {
      res.statusCode = status;
      res.end();
    });
    await new Promise<void>((r) => srv.listen(0, () => r()));
    close = () => new Promise<void>((r) => srv.close(() => r()));
    return `localhost:${(srv.address() as { port: number }).port}`;
  }

  it("returns 'live' when /mcp responds 401 (bearer required = team mode enforced)", async () => {
    const host = await serveStatus(401);
    expect(await confirmTeamModeLive(host, 2000)).toBe("live");
  });

  it("returns 'timeout' when a server responds but never 401", async () => {
    const host = await serveStatus(200);
    expect(await confirmTeamModeLive(host, 800)).toBe("timeout");
  });

  it("returns 'no-server' when nothing is listening on the host", async () => {
    // Bind to claim a port, then free it — guarantees nothing is listening there.
    const srv = createServer();
    await new Promise<void>((r) => srv.listen(0, () => r()));
    const port = (srv.address() as { port: number }).port;
    await new Promise<void>((r) => srv.close(() => r()));
    expect(await confirmTeamModeLive(`localhost:${port}`, 800)).toBe("no-server");
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
    promptQueue.push({ name: ORG_PROMPT, value: "Acme Inc" });
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

    const res = await runTeamInit({ io, dataDir, confirmLive: async () => "no-server" });
    expect(res).not.toBeNull();
    expect(res?.invites).toHaveLength(2);
    expect(res?.orgName).toBe("Acme Inc"); // interactive org capture
    expect(res?.orgSlug).toBe("acme-inc");

    const out = io.stdout.join("");
    expect(out).toContain("✅ Team mode is on");
    expect(out).toContain("DM template for each teammate");
    expect(out).toContain("krimto join");
    expect(out).toContain("ben@acme.com");
    expect(out).toContain("priya@acme.com");
    // Discoverability: the success screen teaches how to save to each scope (no need to know in advance).
    expect(out).toContain("How to save notes");
    expect(out).toContain("for the backend team");
    expect(out).toContain("company-wide");
    expect(out).toContain("Acme Inc (whole org)"); // org name displayed, not org/default
    // confirmLive → "no-server" path prints a plain serve recipe (members.yaml is the switch now —
    // no KRIMTO_BOOTSTRAP_ADMIN env var needed).
    expect(out).toContain("npx @krimto-labs/krimto serve");
  });

  it("aborts cleanly when the user declines the final confirm", async () => {
    const io = captureIO();
    promptQueue.push({ name: "input:What's your email? (this becomes the admin account)", value: "maria@acme.com" });
    promptQueue.push({ name: ORG_PROMPT, value: "" });
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

    const res = await runTeamInit({ io, dataDir, confirmLive: async () => "no-server" });
    expect(res).toBeNull();
    expect(io.stdout.join("")).toContain("No changes made");
    // members.yaml shouldn't exist — nothing was applied.
    await expect(fs.access(path.join(dataDir, ".krimto", "members.yaml"))).rejects.toThrow();
  });

  const divergeMsg = (count: number, email: string): string =>
    `confirm:You have ${count} note${count === 1 ? "" : "s"} saved as ${email}. ` +
    `Use that as your admin so they come with you? ` +
    `(otherwise they stay private to ${email} and the admin won't see them)`;

  function queueRemainingTeamQuestions(): void {
    promptQueue.push({ name: ORG_PROMPT, value: "" }); // org prompt fires after the divergence confirm
    promptQueue.push({
      name: 'input:What\'s your team called? (lowercase slug — e.g. "backend", "infra", "growth")',
      value: "backend",
    });
    promptQueue.push({ name: 'input:Team display name (optional — press Enter to use "backend")', value: "" });
    promptQueue.push({ name: "select:Set up a shared git remote for cross-machine sync?", value: "later" });
    promptQueue.push({ name: "input:Invite teammates now? (comma-separated emails, or press Enter to skip)", value: "" });
    promptQueue.push({ name: "confirm:Apply this setup?", value: true });
  }

  it("diverging admin email + 'use existing' → keeps the notes-owner as admin", async () => {
    const store = new FactStore(dataDir);
    await store.writeFact({ scope: "user/old@x.com", title: "n1", body: "a", author: "old@x.com" });
    await store.writeFact({ scope: "user/old@x.com", title: "n2", body: "b", author: "old@x.com" });
    const io = captureIO();
    promptQueue.push({ name: "input:What's your email? (this becomes the admin account)", value: "new@y.com" });
    promptQueue.push({ name: divergeMsg(2, "old@x.com"), value: true }); // "use old@x.com instead"
    queueRemainingTeamQuestions();

    const res = await runTeamInit({ io, dataDir, confirmLive: async () => "no-server" });
    expect(res?.adminEmail).toBe("old@x.com");
    const parsed = parseYaml(await fs.readFile(path.join(dataDir, ".krimto", "members.yaml"), "utf8")) as MembersYaml;
    expect(parsed.org?.admins).toContain("old@x.com");
    expect(parsed.org?.admins).not.toContain("new@y.com");
  });

  it("diverging admin email + decline → keeps the typed admin and prints migration guidance", async () => {
    const store = new FactStore(dataDir);
    await store.writeFact({ scope: "user/old@x.com", title: "n1", body: "a", author: "old@x.com" });
    await store.writeFact({ scope: "user/old@x.com", title: "n2", body: "b", author: "old@x.com" });
    const io = captureIO();
    promptQueue.push({ name: "input:What's your email? (this becomes the admin account)", value: "new@y.com" });
    promptQueue.push({ name: divergeMsg(2, "old@x.com"), value: false }); // proceed with new@y.com
    queueRemainingTeamQuestions();

    const res = await runTeamInit({ io, dataDir, confirmLive: async () => "no-server" });
    expect(res?.adminEmail).toBe("new@y.com");
    const out = io.stdout.join("");
    expect(out).toContain("stay private to");
    expect(out).toContain("old@x.com");
    expect(out).toContain("krimto mv");
  });

  it("Ctrl-C at the first prompt exits 130 with no writes", async () => {
    const io = captureIO();
    const err = new Error("Prompt was exited");
    err.name = "ExitPromptError";
    promptQueue.push({ name: "input:What's your email? (this becomes the admin account)", value: err });

    const exitBefore = process.exitCode;
    const res = await runTeamInit({ io, dataDir, confirmLive: async () => "no-server" });
    expect(res).toBeNull();
    expect(process.exitCode).toBe(130);
    process.exitCode = exitBefore;
  });
});

// The agent-safe twin of runTeamInit: builds answers from flags (not prompts) and applies. This
// is what `krimto team init --yes --team <slug> ...` calls so an AI agent can stand up a team
// unattended — same bar as solo's `krimto init --yes`. The mocked @inquirer throws on any prompt
// call, so a passing test here proves NO prompt was reached.
describe("runTeamInitNonInteractive — agent-safe flag form", () => {
  function captureIO(): {
    out: (s: string) => void;
    err: (s: string) => void;
    stdout: string[];
    stderr: string[];
  } {
    const stdout: string[] = [];
    const stderr: string[] = [];
    return { out: (s) => stdout.push(s), err: (s) => stderr.push(s), stdout, stderr };
  }

  it("applies from flags with no prompts and writes members.yaml", async () => {
    const io = captureIO();
    const res = await runTeamInitNonInteractive({
      io,
      dataDir,
      teamSlug: "backend",
      teamName: "Backend team",
      adminEmail: "maria@acme.com",
      teammates: ["ben@acme.com"],
      confirmLive: async () => "no-server",
    });
    expect(res.adminEmail).toBe("maria@acme.com");
    expect(res.adminKey).not.toBeNull();
    expect(res.invites.map((i) => i.email)).toEqual(["ben@acme.com"]);

    const parsed = parseYaml(
      await fs.readFile(path.join(dataDir, ".krimto", "members.yaml"), "utf8"),
    ) as MembersYaml;
    expect(parsed.org?.admins).toContain("maria@acme.com");
    const team = parsed.teams?.find((t) => t.slug === "backend");
    expect(team?.members).toEqual(expect.arrayContaining(["ben@acme.com"]));
    // promptQueue stays empty — if any prompt ran, the mock would have thrown "No queued answer".
    expect(promptQueue).toHaveLength(0);
  });

  it("names the org from --org with no prompts", async () => {
    const io = captureIO();
    const res = await runTeamInitNonInteractive({
      io,
      dataDir,
      teamSlug: "backend",
      orgName: "Acme Inc",
      confirmLive: async () => "no-server",
    });
    expect(res.orgName).toBe("Acme Inc");
    expect(res.orgSlug).toBe("acme-inc");
    expect(promptQueue).toHaveLength(0);
  });

  it("defaults the admin to the notes-owner when --admin is omitted", async () => {
    const store = new FactStore(dataDir);
    await store.writeFact({ scope: "user/old@x.com", title: "n1", body: "a", author: "old@x.com" });
    await store.writeFact({ scope: "user/old@x.com", title: "n2", body: "b", author: "old@x.com" });

    const io = captureIO();
    const res = await runTeamInitNonInteractive({
      io,
      dataDir,
      teamSlug: "backend",
      confirmLive: async () => "no-server",
    });
    expect(res.adminEmail).toBe("old@x.com");
    const parsed = parseYaml(
      await fs.readFile(path.join(dataDir, ".krimto", "members.yaml"), "utf8"),
    ) as MembersYaml;
    expect(parsed.org?.admins).toContain("old@x.com");
  });

  it("prints migration guidance when an explicit --admin diverges from the notes-owner", async () => {
    const store = new FactStore(dataDir);
    await store.writeFact({ scope: "user/old@x.com", title: "n1", body: "a", author: "old@x.com" });

    const io = captureIO();
    const res = await runTeamInitNonInteractive({
      io,
      dataDir,
      teamSlug: "backend",
      adminEmail: "new@y.com",
      confirmLive: async () => "no-server",
    });
    expect(res.adminEmail).toBe("new@y.com");
    const out = io.stdout.join("");
    expect(out).toContain("stay private to");
    expect(out).toContain("old@x.com");
    expect(out).toContain("krimto mv");
  });

  it("rejects when no team slug is provided", async () => {
    const io = captureIO();
    await expect(
      runTeamInitNonInteractive({ io, dataDir, confirmLive: async () => "no-server" }),
    ).rejects.toThrow(/--team/);
  });

  it("rejects an invalid team slug", async () => {
    const io = captureIO();
    await expect(
      runTeamInitNonInteractive({
        io,
        dataDir,
        teamSlug: "Bad Slug!",
        confirmLive: async () => "no-server",
      }),
    ).rejects.toThrow();
  });

  it("rejects an invalid invite email", async () => {
    const io = captureIO();
    await expect(
      runTeamInitNonInteractive({
        io,
        dataDir,
        teamSlug: "backend",
        teammates: ["not-an-email"],
        confirmLive: async () => "no-server",
      }),
    ).rejects.toThrow();
  });
});
