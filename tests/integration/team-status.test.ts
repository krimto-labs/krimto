import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildTeamSummary } from "../../src/cli/teamSummary";
import { runTeamStatus } from "../../src/cli/teamStatus";

let dataDir: string;
beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "krimto-teamsum-"));
  await fs.mkdir(path.join(dataDir, ".krimto"), { recursive: true });
});
afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

async function writeMembers(yaml: string): Promise<void> {
  await fs.writeFile(path.join(dataDir, ".krimto", "members.yaml"), yaml, "utf8");
}
async function writeLock(mode: "http" | "stdio", pid = process.pid): Promise<void> {
  await fs.writeFile(
    path.join(dataDir, ".krimto", "lock.json"),
    JSON.stringify({ pid, started: new Date().toISOString(), mode, launchedBy: "service" }),
    "utf8",
  );
}

describe("buildTeamSummary", () => {
  it("reports solo mode when members.yaml has no admins", async () => {
    const s = await buildTeamSummary(dataDir, "me@x.com");
    expect(s.mode).toBe("solo");
    expect(s.memberCount).toBe(0);
    expect(s.hostedHere).toBe(false);
    expect(s.serverUrl).toBeNull();
  });

  it("reports team mode + role + unique member count when an admin and members exist", async () => {
    await writeMembers(
      [
        "org:",
        "  slug: acme",
        "  admins:",
        "    - admin@x.com",
        "teams:",
        "  - slug: backend",
        "    members:",
        "      - admin@x.com",
        "      - ben@x.com",
        "users:",
        "  - email: admin@x.com",
        "  - email: ben@x.com",
        "  - email: priya@x.com",
      ].join("\n"),
    );
    const s = await buildTeamSummary(dataDir, "admin@x.com");
    expect(s.mode).toBe("team");
    expect(s.admins).toContain("admin@x.com");
    expect(s.myRole).toBe("org-admin");
    expect(s.memberCount).toBe(3); // admin + ben + priya, de-duped across teams ∪ users
  });

  it("lists writable scopes (save targets): own user + each team membership + org for admins", async () => {
    await writeMembers(
      [
        "org:",
        "  slug: acme",
        "  admins:",
        "    - admin@x.com",
        "teams:",
        "  - slug: backend",
        "    members:",
        "      - admin@x.com",
        "      - dana@x.com",
        "  - slug: growth",
        "    members:",
        "      - dana@x.com",
        "users:",
        "  - email: admin@x.com",
        "  - email: dana@x.com",
      ].join("\n"),
    );
    const dana = await buildTeamSummary(dataDir, "dana@x.com");
    expect(dana.writableScopes).toEqual(["user/dana@x.com", "team/backend", "team/growth"]);
    const admin = await buildTeamSummary(dataDir, "admin@x.com");
    expect(admin.writableScopes).toEqual(
      expect.arrayContaining(["user/admin@x.com", "team/backend", "org/acme"]),
    );
    expect(admin.orgSlug).toBe("acme");
    expect(admin.orgName).toBeUndefined(); // no name set in this fixture
  });

  it("flags teams an org-admin can't write (admin but not a member) for the legacy-setup nudge", async () => {
    await writeMembers(
      [
        "org:",
        "  slug: acme",
        "  admins:",
        "    - admin@x.com",
        "teams:",
        "  - slug: lpd",
        "    members:",
        "      - dana@x.com", // admin is NOT a member of lpd
        "users:",
        "  - email: admin@x.com",
        "  - email: dana@x.com",
      ].join("\n"),
    );
    const s = await buildTeamSummary(dataDir, "admin@x.com");
    expect(s.adminGapTeams).toEqual(["lpd"]);
    expect(s.writableScopes).not.toContain("team/lpd"); // can't actually write it back
  });

  it("detects hostedHere (this machine is the server) on a live HTTP lock", async () => {
    await writeMembers("org:\n  slug: acme\n  admins:\n    - admin@x.com\n");
    await writeLock("http"); // pid = process.pid → alive
    const s = await buildTeamSummary(dataDir, "admin@x.com");
    expect(s.hostedHere).toBe(true);
    expect(s.serverUrl).toMatch(/^http:\/\/localhost:/);
  });

  it("hostedHere is false for a stdio lock (local, not the team server)", async () => {
    await writeMembers("org:\n  slug: acme\n  admins:\n    - admin@x.com\n");
    await writeLock("stdio");
    const s = await buildTeamSummary(dataDir, "admin@x.com");
    expect(s.hostedHere).toBe(false);
  });
});

describe("runTeamStatus", () => {
  it("solo: explains there's no team and points at team init", async () => {
    const r = await runTeamStatus({ dataDir, identity: "me@x.com" });
    expect(r.status).toBe("solo");
    expect(r.message).toContain("Solo (no team)");
    expect(r.message).toContain("krimto team init");
  });

  it("team: shows Save targets; named org shows its name (not the raw slug)", async () => {
    await writeMembers(
      [
        "org:",
        "  slug: acme",
        "  name: Acme Inc",
        "  admins:",
        "    - admin@x.com",
        "teams:",
        "  - slug: backend",
        "    members:",
        "      - admin@x.com",
        "users:",
        "  - email: admin@x.com",
      ].join("\n"),
    );
    const r = await runTeamStatus({ dataDir, identity: "admin@x.com" });
    expect(r.message).toContain("Save targets");
    expect(r.message).toContain("team/backend");
    expect(r.message).toContain("for the backend team"); // teaches naming the team
    expect(r.message).toContain("Acme Inc (whole org)"); // friendly name, not org/acme
    expect(r.message).not.toContain("org/acme"); // raw slug never shown to humans
  });

  it("team: unnamed org shows 'your whole org' + the name-it command", async () => {
    await writeMembers(
      [
        "org:",
        "  slug: default",
        "  admins:",
        "    - admin@x.com",
        "users:",
        "  - email: admin@x.com",
      ].join("\n"),
    );
    const r = await runTeamStatus({ dataDir, identity: "admin@x.com" });
    expect(r.message).toContain("your whole org");
    expect(r.message).not.toContain("org/default"); // never show the ugly placeholder
    expect(r.message).toContain('krimto team init --org "Your Company"');
  });

  it("team: nudges an admin who isn't a member of an existing team", async () => {
    await writeMembers(
      [
        "org:",
        "  slug: acme",
        "  admins:",
        "    - admin@x.com",
        "teams:",
        "  - slug: lpd",
        "    members:",
        "      - dana@x.com",
        "users:",
        "  - email: admin@x.com",
        "  - email: dana@x.com",
      ].join("\n"),
    );
    const r = await runTeamStatus({ dataDir, identity: "admin@x.com" });
    expect(r.message).toContain("lpd"); // names the team they can't write
    expect(r.message).toMatch(/can't write|not a member/i);
  });

  it("team + hosted here: shows role, member count, and the 'this machine is the server' warning", async () => {
    await writeMembers(
      [
        "org:",
        "  slug: acme",
        "  admins:",
        "    - admin@x.com",
        "users:",
        "  - email: admin@x.com",
        "  - email: ben@x.com",
      ].join("\n"),
    );
    await writeLock("http");
    const r = await runTeamStatus({ dataDir, identity: "admin@x.com" });
    expect(r.status).toBe("team");
    expect(r.message).toContain("admin (can manage members");
    expect(r.message).toContain("Members: 2");
    expect(r.message).toContain("THIS machine is the team server");
  });
});
