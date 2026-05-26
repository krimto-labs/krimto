// G10 — `krimto verify-connection`. Reads the lock file + activity JSONL to diagnose whether the
// agent is hitting Krimto. Three states: running / stale / none.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { ActivityLog } from "../../src/server/activity";
import { runVerifyConnection } from "../../src/cli/verifyConnection";

let dir: string;
const lockFile = (): string => path.join(dir, ".krimto", "lock.json");

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "krimto-verify-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("runVerifyConnection", () => {
  it("reports 'none' with a hint to start Krimto when no lock file exists", async () => {
    const r = await runVerifyConnection(dir);
    expect(r.status).toBe("none");
    expect(r.message).toContain("No Krimto running");
    expect(r.message).toContain("krimto serve");
  });

  it("reports 'running' when the lock points at a live PID", async () => {
    await fs.mkdir(path.join(dir, ".krimto"), { recursive: true });
    await fs.writeFile(
      lockFile(),
      JSON.stringify({ pid: process.pid, started: new Date().toISOString(), mode: "stdio" }),
    );
    const r = await runVerifyConnection(dir);
    expect(r.status).toBe("running");
    expect(r.message).toContain("🟢");
    expect(r.message).toContain(`PID:     ${process.pid}`);
    expect(r.message).toContain("Mode:    stdio");
  });

  it("reports 'stale' when the lock PID is dead", async () => {
    await fs.mkdir(path.join(dir, ".krimto"), { recursive: true });
    const fakeDeadPid = 2_147_483_640;
    await fs.writeFile(
      lockFile(),
      JSON.stringify({ pid: fakeDeadPid, started: new Date().toISOString(), mode: "http" }),
    );
    const r = await runVerifyConnection(dir);
    expect(r.status).toBe("stale");
    expect(r.message).toContain("Stale lock");
    expect(r.message).toContain("auto-replace");
  });

  it("includes the last 5 activity entries when present, newest first", async () => {
    const log = new ActivityLog(dir);
    await log.record("krimto_write", "maria@acme.com", "user/me: First");
    await log.record("krimto_recall", "maria@acme.com", '"deploys" → 1 hit');
    await log.record("krimto_list_scopes", "maria@acme.com", "3 scope(s)");
    const r = await runVerifyConnection(dir, new Date(Date.now() + 1000));
    expect(r.recent).toHaveLength(3);
    expect(r.message).toContain("Recent activity");
    // Most recent printed first
    const listIdx = r.message.indexOf("krimto_list_scopes");
    const writeIdx = r.message.indexOf("krimto_write");
    expect(listIdx).toBeLessThan(writeIdx);
  });

  it("shows the try-this prompt when there is no activity yet", async () => {
    const r = await runVerifyConnection(dir);
    expect(r.message).toContain("Nothing yet");
    expect(r.message).toContain('Use krimto to list');
  });

  it("treats a malformed lock file the same as no lock and notes it in the message", async () => {
    await fs.mkdir(path.join(dir, ".krimto"), { recursive: true });
    await fs.writeFile(lockFile(), "garbage not json");
    const r = await runVerifyConnection(dir);
    expect(r.status).toBe("none");
  });

  it("flags 'Hijack suspected' when many recalls landed with no writes (Gap #5)", async () => {
    const log = new ActivityLog(dir);
    for (let i = 0; i < 5; i++) await log.record("krimto_recall", "maria@acme.com", `try ${i}`);
    const r = await runVerifyConnection(dir);
    expect(r.message).toContain("Hijack suspected");
    expect(r.message).toContain("5 recalls, 0 writes");
    expect(r.message).toContain("npx @krimto-labs/krimto init");
  });

  it("does NOT flag a hijack when at least one write happened recently", async () => {
    const log = new ActivityLog(dir);
    for (let i = 0; i < 5; i++) await log.record("krimto_recall", "maria@acme.com", `try ${i}`);
    await log.record("krimto_write", "maria@acme.com", "user/me: a fact");
    const r = await runVerifyConnection(dir);
    expect(r.message).not.toContain("Hijack suspected");
  });
});
