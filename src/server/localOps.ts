// Settings ▸ This machine (v0.2.42) — the loopback-gated control plane. These ops act on the
// LOCAL machine (editor configs + the OS service + the data dir), so they cannot run in-process
// (the running server holds the data-dir lock, and some ops stop/restart it). Instead the web
// route spawns the `krimto` CLI as a detached child — reusing the exact, tested CLI code paths.
//
// SECURITY (this is the load-bearing surface):
//   • Strict ALLOWLIST: only the fixed action ids below resolve to an argv. No flag smuggling.
//   • execFile/spawn with an ARG ARRAY and NO shell ⇒ free-text params can never inject a command.
//   • Free-text params (identity email, folder path, OpenAI key) are validated before use.
//   • The route additionally requires a loopback peer + admin role + CSRF nonce (see router.ts).

import { spawn as nodeSpawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

const IDENTITY_EMAIL_RE = /^[^@\s]+@[^@\s]+$/;
const OPENAI_KEY_RE = /^sk-[A-Za-z0-9_-]{8,}$/;

export interface LocalOpResolved {
  ok: true;
  id: string;
  /** The krimto CLI argv (NOT including the node binary / bin path). */
  argv: string[];
  /** True when running this op stops or restarts the server (UI shows a reconnect state). */
  bounces: boolean;
}
export interface LocalOpError {
  ok: false;
  message: string;
}
export type LocalOpResult = LocalOpResolved | LocalOpError;

/** Loopback peer check for the machine-ops gate. Accepts the IPv4, IPv6, and mapped forms. */
export function isLoopbackAddress(addr: string | undefined | null): boolean {
  if (!addr) return false;
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

/** Fixed-verb ops: no free-text params, so the argv is constant. */
const FIXED: Record<string, { argv: string[]; bounces: boolean }> = {
  "service-as-needed": { argv: ["service", "--as-needed"], bounces: false },
  "service-always": { argv: ["service", "--always"], bounces: true },
  "service-manual": { argv: ["service", "--manual"], bounces: false },
  stop: { argv: ["stop"], bounces: true },
  start: { argv: ["start"], bounces: false },
  restart: { argv: ["restart"], bounces: true },
  "search-keyword": { argv: ["search", "--keyword"], bounces: false },
  reset: { argv: ["reset", "--yes"], bounces: true },
};

/**
 * Resolve an allowlisted action (+ validated params) to a krimto CLI argv. Pure; never spawns.
 * Returns `{ ok:false }` for an unknown action or a param that fails validation — the caller must
 * not spawn in that case.
 */
export function resolveLocalOp(action: string, params: Record<string, string> = {}): LocalOpResult {
  const fixed = FIXED[action];
  if (fixed) return { ok: true, id: action, argv: fixed.argv, bounces: fixed.bounces };

  if (action === "set-identity") {
    const email = (params.email ?? "").trim();
    if (!IDENTITY_EMAIL_RE.test(email)) return { ok: false, message: "Enter a valid email (local-part@domain)." };
    return { ok: true, id: action, argv: ["set", "identity", email, "--yes"], bounces: false };
  }
  if (action === "search-openai") {
    const key = (params.apiKey ?? "").trim();
    if (!OPENAI_KEY_RE.test(key)) return { ok: false, message: "Enter a valid OpenAI key (sk-…)." };
    return { ok: true, id: action, argv: ["search", "--openai", "--api-key", key], bounces: false };
  }
  if (action === "folder") {
    const dir = (params.path ?? "").trim();
    if (!dir || !path.isAbsolute(dir)) return { ok: false, message: "Enter an absolute folder path." };
    return { ok: true, id: action, argv: ["folder", "--to", dir, "--yes"], bounces: true };
  }
  return { ok: false, message: `Unknown action: ${action}` };
}

export type SpawnFn = (cmd: string, args: string[]) => void;

export interface LocalOpRunner {
  /** Absolute path to bin/krimto.mjs. */
  binPath: string;
  /** Override the spawn (tests inject a recorder). Defaults to a detached, no-shell spawn. */
  spawn?: SpawnFn;
}

/** Detached, no-shell spawn — the child outlives a server this op stops/restarts. */
function defaultSpawn(cmd: string, args: string[]): void {
  const child = nodeSpawn(cmd, args, { detached: true, stdio: "ignore" });
  child.unref();
}

/** Resolve then spawn an allowlisted op. Returns the resolution; never spawns on a resolve error. */
export function runLocalOp(action: string, params: Record<string, string>, runner: LocalOpRunner): LocalOpResult {
  const resolved = resolveLocalOp(action, params);
  if (!resolved.ok) return resolved;
  (runner.spawn ?? defaultSpawn)(process.execPath, [runner.binPath, ...resolved.argv]);
  return resolved;
}

/** Absolute path to bin/krimto.mjs, resolved relative to this module (src/server/localOps.ts). */
export function defaultBinPath(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../bin/krimto.mjs");
}
