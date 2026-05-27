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
import { spawn } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../bin/krimto.mjs");

/** Run a krimto command with no TTY and return {code, stderr, stdout, elapsed}. */
async function runNoTty(args: string[], timeoutMs = 8000): Promise<{ code: number | null; stderr: string; stdout: string; elapsedMs: number }> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], { stdio: ["ignore", "pipe", "pipe"] });
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
