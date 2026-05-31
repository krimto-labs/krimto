// v0.2.34 — non-TTY guard for the Phase B commands. When an AI agent or CI shell tool
// (no stdin TTY) runs `krimto editors / service / search / reset / remote / folder`
// without a relevant flag, the command used to:
//   1. Spawn an @inquirer/prompts UI that waits for input
//   2. Never get input (no TTY)
//   3. Crash with the cryptic "Detected unsettled top-level await … Aborted." warning
//
// The fix: each `run*` function asserts `process.stdin.isTTY === true` before opening a
// prompt. When false, it prints a copy-pasteable flag-form usage and exits 2 cleanly.
// This test spawns the real bin with `stdin: "ignore"` (forces non-TTY) and verifies the
// guard fires for every Phase B command — no hang, no warning, exit 2 + usage on stderr.

import { describe, expect, it } from "vitest";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { FactStore } from "../../src/storage/store";

const execFileP = promisify(execFile);
const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../bin/krimto.mjs");

/** Run a krimto command with no TTY and return {code, stderr, stdout, elapsed}. */
async function runNoTty(
  args: string[],
  env?: NodeJS.ProcessEnv,
  timeoutMs = 8000,
): Promise<{ code: number | null; stderr: string; stdout: string; elapsedMs: number }> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: env ? { ...process.env, ...env } : process.env,
    });
    let stderr = "";
    let stdout = "";
    child.stdout.on("data", (b: Buffer) => { stdout += b.toString("utf8"); });
    child.stderr.on("data", (b: Buffer) => { stderr += b.toString("utf8"); });
    const killTimer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Command hung for ${timeoutMs}ms — guard didn't fire`));
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(killTimer);
      resolve({ code, stderr, stdout, elapsedMs: Date.now() - start });
    });
  });
}

describe("Phase B non-TTY guard (v0.2.34)", () => {
  it("`krimto editors` (no flags, no TTY) exits 2 with flag usage", async () => {
    const { code, stderr, elapsedMs } = await runNoTty(["editors"]);
    expect(code).toBe(2);
    expect(stderr).toContain("No interactive terminal detected");
    expect(stderr).toContain("krimto editors --add cursor");
    expect(stderr).not.toContain("unsettled top-level await");
    expect(elapsedMs).toBeLessThan(5000); // sanity: exited quickly, didn't hang
  }, 15000);

  it("`krimto service` (no flags, no TTY) exits 2 with flag usage", async () => {
    const { code, stderr } = await runNoTty(["service"]);
    expect(code).toBe(2);
    expect(stderr).toContain("krimto service --as-needed");
    expect(stderr).toContain("krimto service --always");
    expect(stderr).not.toContain("unsettled top-level await");
  }, 15000);

  it("`krimto search` (no flags, no TTY) exits 2 with flag usage", async () => {
    const { code, stderr } = await runNoTty(["search"]);
    expect(code).toBe(2);
    expect(stderr).toContain("krimto search --keyword");
    expect(stderr).toContain("krimto search --openai");
    expect(stderr).not.toContain("unsettled top-level await");
  }, 15000);

  it("`krimto reset` (no --yes, no TTY) exits 2 with flag usage", async () => {
    const { code, stderr } = await runNoTty(["reset"]);
    expect(code).toBe(2);
    expect(stderr).toContain("krimto reset --yes");
    expect(stderr).not.toContain("unsettled top-level await");
  }, 15000);

  it("`krimto remote` (no flags, no TTY) exits 2 with flag usage", async () => {
    const { code, stderr } = await runNoTty(["remote"]);
    expect(code).toBe(2);
    expect(stderr).toContain("krimto remote --show");
    expect(stderr).toContain("krimto remote --set");
    expect(stderr).not.toContain("unsettled top-level await");
  }, 15000);

  it("`krimto folder` (no flags, no TTY) exits 2 with flag usage", async () => {
    const { code, stderr } = await runNoTty(["folder"]);
    expect(code).toBe(2);
    expect(stderr).toContain("krimto folder --to");
    expect(stderr).not.toContain("unsettled top-level await");
  }, 15000);

  // Sanity: when an agent passes the right flag, the guard does NOT fire — the command
  // proceeds normally. Smoke-tested with `search --keyword` because it has no side
  // effects on a clean machine and exits in <2s.
  it("`krimto search --keyword` (with flag, no TTY) bypasses the guard", async () => {
    const { code, stderr } = await runNoTty(["search", "--keyword"]);
    // Either succeeded (0) OR failed for a non-guard reason (e.g. no editors configured —
    // applySearch returns 0 with updatedEditors=0). The point is it didn't exit with the
    // guard's exit-2 + "No interactive terminal detected" message.
    expect(code).toBe(0);
    expect(stderr).not.toContain("No interactive terminal detected");
  }, 15000);
});

// batch 5 — the guard previously only covered the no-flag entry of each command. The ACTION
// branches (`folder --to`, `remote --remove`, `set identity <email>`) reached confirm() directly,
// so a non-TTY agent got an exit-130 "Aborted" instead of the copy-pasteable --yes usage.
describe("non-TTY guard — confirm-gated action branches (batch 5)", () => {
  it("`krimto folder --to <path>` (no --yes, no TTY) exits 2 with usage, not an abort", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "krimto-g5folder-"));
    const data = path.join(dir, "data");
    await fs.mkdir(data, { recursive: true });
    const { code, stderr } = await runNoTty(["folder", "--to", path.join(dir, "target")], { KRIMTO_DATA: data });
    expect(code).toBe(2);
    expect(stderr).toContain("No interactive terminal detected");
    expect(stderr).toContain("krimto folder --to");
    expect(stderr).not.toContain("unsettled top-level await");
    await fs.rm(dir, { recursive: true, force: true });
  }, 15000);

  it("`krimto remote --remove` (no --yes, no TTY) exits 2 with usage", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "krimto-g5remote-"));
    const data = path.join(dir, "data");
    await fs.mkdir(data, { recursive: true });
    await execFileP("git", ["-C", data, "init", "-q"]);
    await execFileP("git", ["-C", data, "remote", "add", "origin", "https://example.invalid/r.git"]);
    const { code, stderr } = await runNoTty(["remote", "--remove"], { KRIMTO_DATA: data });
    expect(code).toBe(2);
    expect(stderr).toContain("No interactive terminal detected");
    expect(stderr).toContain("krimto remote --remove --yes");
    await fs.rm(dir, { recursive: true, force: true });
  }, 15000);

  it("`krimto set identity <email>` (no --yes, no TTY) exits 2 with usage", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "krimto-g5ident-"));
    const data = path.join(dir, "data");
    await fs.mkdir(data, { recursive: true });
    const { code, stderr } = await runNoTty(["set", "identity", "agent-batch5@example.invalid"], {
      KRIMTO_DATA: data,
      KRIMTO_IDENTITY: "current-user@example.invalid",
    });
    expect(code).toBe(2);
    expect(stderr).toContain("No interactive terminal detected");
    expect(stderr).toContain("krimto set identity");
    await fs.rm(dir, { recursive: true, force: true });
  }, 15000);

  it("`krimto stop` forwards --yes so the team-host guard's escape hatch actually works", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "krimto-g5stop-"));
    const kd = path.join(dir, ".krimto");
    await fs.mkdir(kd, { recursive: true });
    await fs.writeFile(path.join(kd, "members.yaml"), "org:\n  slug: acme\n  admins:\n    - admin@x.com\n");
    // A live dummy process stands in as the hosted HTTP server, so a real stop SIGTERMs IT, not the test runner.
    const dummy = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e9)"], { stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 60));
    await fs.writeFile(
      path.join(kd, "lock.json"),
      JSON.stringify({ pid: dummy.pid, started: "2026-01-01T00:00:00.000Z", mode: "http", launchedBy: "ad-hoc" }),
    );
    try {
      // Without --yes (non-TTY) the team-host guard shows the escape hatch (control).
      const noYes = await runNoTty(["stop"], { KRIMTO_DATA: dir });
      expect(noYes.stdout + noYes.stderr).toContain("krimto stop --yes");
      // With --yes the flag must be forwarded → guard bypassed → it actually stops.
      const withYes = await runNoTty(["stop", "--yes"], { KRIMTO_DATA: dir });
      expect(withYes.stdout + withYes.stderr).not.toContain("Re-run with");
    } finally {
      dummy.kill("SIGKILL");
      await fs.rm(dir, { recursive: true, force: true });
    }
  }, 20000);

  it("`krimto edit <id> --body` edits non-interactively (no $EDITOR — the agent path)", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "krimto-g5edit-"));
    const store = new FactStore(dir);
    const { fact } = await store.writeFact({ scope: "user/me@x.com", title: "t", body: "old body", author: "me@x.com" });
    const id = fact.frontmatter.id;
    const { code } = await runNoTty(["edit", id, "--body", "new agent body"], { KRIMTO_DATA: dir, KRIMTO_IDENTITY: "me@x.com" });
    expect(code).toBe(0);
    const after = await store.readFact(id);
    expect(after?.fact.body).toBe("new agent body");
    await fs.rm(dir, { recursive: true, force: true });
  }, 20000);

  it("`krimto edit <id>` (no --body, no TTY) exits 2 with the --body usage instead of opening an editor", async () => {
    const { code, stderr } = await runNoTty(["edit", "fct_whatever"]);
    expect(code).toBe(2);
    expect(stderr).toContain("No interactive terminal detected");
    expect(stderr).toContain("krimto edit <fact-id> --body");
  }, 15000);

  it("`krimto supersede <id>` (no --body, no TTY) exits 2 with the --body usage", async () => {
    const { code, stderr } = await runNoTty(["supersede", "fct_whatever"]);
    expect(code).toBe(2);
    expect(stderr).toContain("No interactive terminal detected");
    expect(stderr).toContain("krimto supersede <fact-id> --body");
  }, 15000);
});
