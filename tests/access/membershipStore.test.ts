import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { addUser, removeUser, createTeam, setTeamMember, setOrgAdmin } from "../../src/access/membershipStore";
import { loadMembership } from "../../src/access/membership";
import { KrimtoError } from "../../src/server/errors";

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "krimto-ms-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("membershipStore", () => {
  it("addUser adds a user, optionally to a team and as admin", async () => {
    await addUser(dir, "bob@x.com", { team: "payments", admin: false });
    const m = await loadMembership(dir);
    expect(m.users.map((u) => u.email)).toContain("bob@x.com");
    expect(m.teams.find((t) => t.slug === "payments")?.members).toContain("bob@x.com");
    expect(m.org.admins).not.toContain("bob@x.com");
  });

  it("setTeamMember adds and removes; createTeam is idempotent", async () => {
    await createTeam(dir, "infra", "Infra");
    await createTeam(dir, "infra"); // idempotent
    await setTeamMember(dir, "infra", "ann@x.com", true);
    expect((await loadMembership(dir)).teams.find((t) => t.slug === "infra")?.members).toEqual(["ann@x.com"]);
    await setTeamMember(dir, "infra", "ann@x.com", false);
    expect((await loadMembership(dir)).teams.find((t) => t.slug === "infra")?.members).toEqual([]);
  });

  it("preserves unknown YAML fields", async () => {
    await fs.mkdir(path.join(dir, ".krimto"), { recursive: true });
    await fs.writeFile(
      path.join(dir, ".krimto", "members.yaml"),
      "org:\n  slug: acme\n  admins: [alice@x.com]\n  custom_field: keepme\n",
      "utf8",
    );
    await addUser(dir, "bob@x.com");
    const text = await fs.readFile(path.join(dir, ".krimto", "members.yaml"), "utf8");
    expect(text).toContain("custom_field: keepme");
  });

  it("refuses to remove the last org admin", async () => {
    await setOrgAdmin(dir, "alice@x.com", true);
    await expect(removeUser(dir, "alice@x.com")).rejects.toMatchObject({ code: "conflict" });
    await expect(setOrgAdmin(dir, "alice@x.com", false)).rejects.toBeInstanceOf(KrimtoError);
    expect((await loadMembership(dir)).org.admins).toContain("alice@x.com");
  });
});
