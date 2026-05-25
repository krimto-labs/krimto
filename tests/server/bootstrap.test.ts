import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ApiKeyStore } from "../../src/access/auth";
import { loadMembership } from "../../src/access/membership";
import { bootstrapAdmin, reissueKey } from "../../src/server/bootstrap";

describe("bootstrapAdmin", () => {
  it("issues a key for the admin and makes them an org admin; idempotent", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "krimto-boot-"));
    const keys = new ApiKeyStore(path.join(dir, "keys.json"));
    const result = await bootstrapAdmin("alice@x.com", keys, dir);
    expect(result.key).toMatch(/^krm_live_/);
    const membership = await loadMembership(dir);
    expect(membership.org.admins).toContain("alice@x.com");
    // second run: admin already has a key -> no new key, still admin
    const again = await bootstrapAdmin("alice@x.com", keys, dir);
    expect(again.key).toBeNull();
    expect((await loadMembership(dir)).org.admins).toEqual(["alice@x.com"]); // not duplicated
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("preserves an existing members.yaml and issues a key without elevating a later admin (BUG-6)", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "krimto-boot2-"));
    await fs.mkdir(path.join(dir, ".krimto"), { recursive: true });
    await fs.writeFile(path.join(dir, ".krimto", "members.yaml"),
      "org:\n  slug: acme\n  admins:\n    - bob@x.com\nteams:\n  - slug: payments\n    members: [bob@x.com]\n    leads: []\n", "utf8");
    const keys = new ApiKeyStore(path.join(dir, "keys.json"));
    const res = await bootstrapAdmin("alice@x.com", keys, dir);
    expect(res.key).toMatch(/^krm_live_/); // alice still gets a key
    const m = await loadMembership(dir);
    expect(m.org.slug).toBe("acme");
    expect(m.org.admins).toEqual(["bob@x.com"]); // alice NOT elevated (admins non-empty)
    expect(m.teams).toHaveLength(1); // existing teams preserved
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("reissueKey mints a fresh, usable key even when a (stale) record already exists", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "krimto-reissue-"));
    const keys = new ApiKeyStore(path.join(dir, "keys.json"));
    await bootstrapAdmin("alice@x.com", keys, dir); // alice already has a record
    const before = (await keys.list()).filter((k) => k.identity === "alice@x.com").length;

    const fresh = await reissueKey("alice@x.com", keys, dir);
    expect(fresh).toMatch(/^krm_live_/);
    expect(await keys.resolveIdentity(fresh)).toBe("alice@x.com"); // the new key works
    const after = (await keys.list()).filter((k) => k.identity === "alice@x.com").length;
    expect(after).toBe(before + 1); // minted despite an existing record
    expect((await loadMembership(dir)).org.admins).toContain("alice@x.com");
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("does not elevate a new email to org-admin once an admin already exists (BUG-6)", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "krimto-boot6-"));
    const keys = new ApiKeyStore(path.join(dir, "keys.json"));
    await bootstrapAdmin("alice@x.com", keys, dir); // first admin
    const res = await bootstrapAdmin("bob@x.com", keys, dir); // second email, admins non-empty
    expect(res.key).toMatch(/^krm_live_/); // bob still gets a key
    const m = await loadMembership(dir);
    expect(m.org.admins).toEqual(["alice@x.com"]); // bob is NOT elevated
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("does not clobber a corrupt members.yaml — it propagates the parse error", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "krimto-boot3-"));
    await fs.mkdir(path.join(dir, ".krimto"), { recursive: true });
    const file = path.join(dir, ".krimto", "members.yaml");
    const corrupt = "org:\n  admins:\n    - bob@x.com\n  : : broken : :\n"; // invalid YAML
    await fs.writeFile(file, corrupt, "utf8");
    const keys = new ApiKeyStore(path.join(dir, "keys.json"));
    await expect(bootstrapAdmin("alice@x.com", keys, dir)).rejects.toBeTruthy();
    expect(await fs.readFile(file, "utf8")).toBe(corrupt); // file untouched
    await fs.rm(dir, { recursive: true, force: true });
  });
});
