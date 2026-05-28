import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MembershipWatcher } from "../../src/server/membershipWatcher";

let dir: string;
let file: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "krimto-memwatch-"));
  file = path.join(dir, "members.yaml");
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("MembershipWatcher", () => {
  it("fires onChange once when the file is first seen, and not again while unchanged", async () => {
    await fs.writeFile(file, "org:\n  admins: [a@b.com]\n", "utf8");
    let fired = 0;
    const w = new MembershipWatcher(file, async () => { fired += 1; });
    await w.checkOnce();
    expect(fired).toBe(1);
    await w.checkOnce(); // mtime unchanged → no fire
    expect(fired).toBe(1);
  });

  it("fires again when the file's mtime changes (team init rewriting members.yaml)", async () => {
    await fs.writeFile(file, "org:\n  admins: []\n", "utf8");
    let fired = 0;
    const w = new MembershipWatcher(file, async () => { fired += 1; });
    await w.checkOnce();
    expect(fired).toBe(1);
    // Force a strictly-newer mtime so the change is detected deterministically (avoids same-ms races).
    await fs.writeFile(file, "org:\n  admins: [a@b.com]\n", "utf8");
    const later = new Date(Date.now() + 5000);
    await fs.utimes(file, later, later);
    await w.checkOnce();
    expect(fired).toBe(2);
  });

  it("is a no-op when the file does not exist (solo stays solo)", async () => {
    let fired = 0;
    const w = new MembershipWatcher(path.join(dir, "absent.yaml"), async () => { fired += 1; });
    await w.checkOnce();
    expect(fired).toBe(0);
  });
});
