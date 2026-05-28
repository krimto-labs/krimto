// Safety guards: reset/stop must warn before they hurt teammates.
//   • reset wipes keys.json → in team mode that locks everyone out.
//   • stop on the team-server host disconnects everyone.
// These tests stay fully isolated (cwd/homeDir/dataDir = temp, dryRun) and never terminate a real
// PID — the stop guard returns BEFORE terminateLockHolder, so writing process.pid into the lock is
// safe (it's only read to detect "a live server is here").

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runReset } from "../../src/cli/reset";
import { runStop } from "../../src/cli/stopCmd";

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "krimto-teamsafe-"));
  await fs.mkdir(path.join(dir, ".krimto"), { recursive: true });
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function captureIO() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { out: (s: string) => stdout.push(s), err: (s: string) => stderr.push(s), stdout, stderr };
}
const writeMembers = (yaml: string) => fs.writeFile(path.join(dir, ".krimto", "members.yaml"), yaml, "utf8");
const writeHttpLock = () =>
  fs.writeFile(
    path.join(dir, ".krimto", "lock.json"),
    JSON.stringify({ pid: process.pid, started: new Date().toISOString(), mode: "http", launchedBy: "service" }),
    "utf8",
  );

describe("reset — team lockout warning", () => {
  it("warns that wiping keys locks out the team when team mode is active", async () => {
    await writeMembers("org:\n  slug: acme\n  admins:\n    - a@x.com\nusers:\n  - email: a@x.com\n  - email: b@x.com\n");
    const io = captureIO();
    await runReset({ dataDir: dir, cwd: dir, homeDir: dir, yes: true, dryRun: true, io });
    const out = io.stdout.join("");
    expect(out).toContain("TEAM MODE IS ACTIVE");
    expect(out).toContain("locked out");
  });

  it("does NOT show the team warning in solo mode", async () => {
    const io = captureIO();
    await runReset({ dataDir: dir, cwd: dir, homeDir: dir, yes: true, dryRun: true, io });
    expect(io.stdout.join("")).not.toContain("TEAM MODE IS ACTIVE");
  });
});

describe("stop — team-server disconnect guard", () => {
  it("refuses (non-TTY) to stop the team server without --yes, naming the disconnect", async () => {
    await writeMembers("org:\n  slug: acme\n  admins:\n    - a@x.com\nusers:\n  - email: a@x.com\n  - email: b@x.com\n");
    await writeHttpLock(); // live HTTP server here → hostedHere
    const res = await runStop({ dataDir: dir, homeDir: dir }); // no --yes, no TTY in tests
    expect(res.status).toBe("already-stopped"); // guard returned early; nothing was killed
    expect(res.message).toContain("disconnects");
    expect(res.message).toContain("--yes");
  });

  it("does not prompt/guard a solo stop", async () => {
    const res = await runStop({ dataDir: dir, homeDir: dir });
    expect(res.message).not.toContain("disconnects");
  });
});
