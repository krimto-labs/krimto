// `krimto serve` — boots the HTTP server from the npx on-ramp so a stranger gets /ui without
// cloning the repo or installing Docker. Spawns the bin as a real process, picks a free port
// to avoid clashing with anything on 8080, and proves /health/live answers.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../bin/krimto.mjs");

let root: string;
let child: ChildProcessWithoutNullStreams;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "krimto-serve-"));
});

afterEach(async () => {
  if (child && !child.killed) {
    child.kill("SIGTERM");
    await new Promise((r) => child.once("exit", r));
  }
  await fs.rm(root, { recursive: true, force: true });
});

describe("krimto serve (bin dispatch)", () => {
  it("boots the HTTP server, answers /health/live, surfaces the local-mode banner", async () => {
    const port = await freePort();
    child = spawn(process.execPath, [BIN, "serve"], {
      env: { ...process.env, KRIMTO_DATA: root, KRIMTO_HTTP_PORT: String(port) },
    });

    // Wait for the local-mode banner — that proves the HTTP listen() callback fired.
    let stderr = "";
    await new Promise<void>((resolve, reject) => {
      const onData = (chunk: Buffer): void => {
        stderr += chunk.toString();
        if (stderr.includes(`http://localhost:${port}`)) {
          child.stderr.off("data", onData);
          resolve();
        }
      };
      child.stderr.on("data", onData);
      child.once("exit", (code) => reject(new Error(`process exited before banner (code ${code})`)));
      setTimeout(() => reject(new Error("timed out waiting for banner")), 15000);
    });

    expect(stderr).toContain("/ui/connect");
    expect(stderr).toContain("Mode:  Local");

    const res = await fetch(`http://localhost:${port}/health/live`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("alive");
  }, 30000);
});
