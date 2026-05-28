import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  canRead,
  canWrite,
  emptyMembership,
  isTeamLead,
  loadMembership,
  parseMembership,
  requesterFor,
  roleOf,
  shouldAdoptReload,
  teamsOf,
  type Membership,
} from "../../src/access/membership";

const YAML = `
org:
  slug: acme
  name: ACME Corporation
  admins:
    - alice@acme.com
teams:
  - slug: payments
    name: Payments
    members: [alice@acme.com, bob@acme.com]
    leads: [bob@acme.com]
  - slug: infra
    members: [carol@acme.com]
    leads: [carol@acme.com]
users:
  - email: alice@acme.com
    name: Alice
`;

let m: Membership;
beforeEach(() => {
  m = parseMembership(YAML);
});

describe("parseMembership", () => {
  it("parses org, teams, users with defaults", () => {
    expect(m.org.slug).toBe("acme");
    expect(m.org.admins).toEqual(["alice@acme.com"]);
    expect(m.teams).toHaveLength(2);
    expect(m.teams.find((t) => t.slug === "payments")?.members).toContain("bob@acme.com");
  });
  it("tolerates empty / malformed input", () => {
    expect(parseMembership("")).toEqual(emptyMembership());
  });
});

describe("roles", () => {
  it("classifies roles by precedence", () => {
    expect(roleOf(m, "alice@acme.com")).toBe("org-admin");
    expect(roleOf(m, "bob@acme.com")).toBe("team-lead");
    expect(roleOf(m, "carol@acme.com")).toBe("team-lead");
    expect(roleOf(m, "dave@acme.com")).toBe("org-member");
  });
  it("teamsOf and isTeamLead", () => {
    expect(teamsOf(m, "alice@acme.com")).toEqual(["payments"]);
    expect(isTeamLead(m, "payments", "bob@acme.com")).toBe(true);
    expect(isTeamLead(m, "payments", "alice@acme.com")).toBe(false);
  });
  it("requesterFor carries identity + teams", () => {
    expect(requesterFor(m, "bob@acme.com")).toEqual({ identity: "bob@acme.com", teams: ["payments"] });
  });
});

describe("canRead", () => {
  it("own user scope only; not another user's", () => {
    expect(canRead(m, "alice@acme.com", "user/alice@acme.com")).toBe(true);
    expect(canRead(m, "alice@acme.com", "user/bob@acme.com")).toBe(false);
  });
  it("team scope for members only", () => {
    expect(canRead(m, "bob@acme.com", "team/payments")).toBe(true);
    expect(canRead(m, "carol@acme.com", "team/payments")).toBe(false);
  });
  it("org scope readable by any member", () => {
    expect(canRead(m, "carol@acme.com", "org/acme")).toBe(true);
  });
});

describe("canWrite", () => {
  it("org admin writes anywhere", () => {
    expect(canWrite(m, "alice@acme.com", "team/infra")).toBe(true);
    expect(canWrite(m, "alice@acme.com", "org/acme")).toBe(true);
  });
  it("members write their own user + their team, not others", () => {
    expect(canWrite(m, "bob@acme.com", "user/bob@acme.com")).toBe(true);
    expect(canWrite(m, "bob@acme.com", "team/payments")).toBe(true);
    expect(canWrite(m, "bob@acme.com", "team/infra")).toBe(false);
    expect(canWrite(m, "bob@acme.com", "org/acme")).toBe(false); // non-admin
  });
});

describe("loadMembership", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "krimto-mem-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  it("loads from .krimto/members.yaml", async () => {
    await fs.mkdir(path.join(dir, ".krimto"), { recursive: true });
    await fs.writeFile(path.join(dir, ".krimto", "members.yaml"), YAML, "utf8");
    const loaded = await loadMembership(dir);
    expect(loaded.org.slug).toBe("acme");
  });
  it("returns an empty membership when the file is absent", async () => {
    expect((await loadMembership(dir)).teams).toEqual([]);
  });
});

describe("shouldAdoptReload (live-reload downgrade guard)", () => {
  const withAdmin: Membership = { org: { slug: "o", admins: ["a@b.com"] }, teams: [], users: [] };
  const noAdmin: Membership = { org: { slug: "o", admins: [] }, teams: [], users: [] };

  it("adopts solo→team (gaining an admin turns auth ON — desired)", () => {
    expect(shouldAdoptReload(noAdmin, withAdmin)).toBe(true);
  });
  it("adopts team→team (still has an admin)", () => {
    expect(shouldAdoptReload(withAdmin, withAdmin)).toBe(true);
  });
  it("REFUSES team→solo (dropping the last admin would disable auth — the exposure-window guard)", () => {
    expect(shouldAdoptReload(withAdmin, noAdmin)).toBe(false);
  });
  it("adopts solo→solo (nothing to protect)", () => {
    expect(shouldAdoptReload(noAdmin, noAdmin)).toBe(true);
  });
});
