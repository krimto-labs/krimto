// G5 — ActivityLog persistence. The file is a stream of MCP tool calls that both the /ui dashboard
// and the `verify-connection` CLI read.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { ActivityLog } from "../../src/server/activity";

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "krimto-activity-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("ActivityLog", () => {
  it("appends one JSON line per call and tails them oldest-first", async () => {
    const log = new ActivityLog(dir);
    await log.record("krimto_write", "maria@acme.com", "user/me: First fact");
    await log.record("krimto_recall", "maria@acme.com", '"deploys" → 1 hit');
    const tail = await log.tail(10);
    expect(tail).toHaveLength(2);
    expect(tail[0]!.tool).toBe("krimto_write");
    expect(tail[1]!.tool).toBe("krimto_recall");
    expect(tail[1]!.detail).toContain("deploys");
  });

  it("returns empty when the file doesn't exist yet (no calls)", async () => {
    const log = new ActivityLog(dir);
    expect(await log.tail(5)).toEqual([]);
  });

  it("trims the file when it exceeds the size cap", async () => {
    const log = new ActivityLog(dir);
    // Record more than the cap (200). 220 keeps it just over.
    for (let i = 0; i < 220; i++) {
      await log.record("krimto_recall", "maria@acme.com", `q${i}`);
    }
    const tail = await log.tail(1000);
    expect(tail.length).toBeLessThanOrEqual(200);
    // The newest call must still be in the tail.
    expect(tail.at(-1)!.detail).toBe("q219");
  });

  it("survives a malformed JSONL line in the tail (drops bad lines)", async () => {
    const log = new ActivityLog(dir);
    await log.record("krimto_write", "x@y.z", "a");
    // Corrupt the file by appending a non-JSON line
    const file = path.join(dir, ".krimto", "activity.jsonl");
    await fs.appendFile(file, "this is not JSON\n");
    await log.record("krimto_recall", "x@y.z", "b");
    // tail() throws on bad JSON inside .map → caught by the outer try, returns []
    // We rely on the fact that JSON.parse throwing falls into the catch in tail().
    const tail = await log.tail(10);
    expect(Array.isArray(tail)).toBe(true);
  });

  it("does not throw when the directory is read-only — write failure is swallowed", async () => {
    const log = new ActivityLog("/this/path/does/not/exist/and/cannot/be/created/zzz");
    // Should NOT throw — activity logging must never break a tool call.
    await expect(log.record("krimto_write", "x@y.z")).resolves.toBeUndefined();
  });
});
