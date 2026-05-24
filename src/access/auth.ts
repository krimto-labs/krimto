// Gap 06 — Authentication. MCP clients present an API key (bearer token); humans
// paste an API key into the web UI (/ui), which holds it as a signed-cookie session
// (real OAuth sign-in is v0.3). Keys are krm_live_/krm_test_ + 32 random base62 chars,
// shown once, stored only as a hash.
//
// Note: API keys are ~190-bit random tokens, not passwords. A fast SHA-256 hash at
// rest is the correct, performant choice (a per-request memory-hard KDF would add
// ~100ms to every call). This is an intentional, reasoned divergence from the Build
// Spec's literal "Argon2", which is meant for low-entropy secrets.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";

export type KeyEnvironment = "live" | "test";

/** OAuth providers supported for the web UI (v0.3). Scaffold only for now. */
export const OAUTH_PROVIDERS = ["google", "github", "microsoft-entra", "okta", "auth0"] as const;

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const KEY_BODY_LENGTH = 32;

export interface ApiKeyRecord {
  /** sha256(plaintext key), hex. */
  hash: string;
  identity: string;
  prefix: string;
  created: string;
  label?: string;
}

export interface GeneratedKey {
  /** Plaintext key — shown once, never persisted. */
  key: string;
  record: ApiKeyRecord;
}

function randomBase62(length: number): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += BASE62[(bytes[i] ?? 0) % 62];
  return out;
}

export function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export function generateApiKey(
  identity: string,
  env: KeyEnvironment = "live",
  now: Date = new Date(),
  label?: string,
): GeneratedKey {
  const prefix = `krm_${env}_`;
  const key = `${prefix}${randomBase62(KEY_BODY_LENGTH)}`;
  return { key, record: { hash: hashKey(key), identity, prefix, created: now.toISOString(), label } };
}

/** Constant-time comparison of a presented key against a stored hash. */
export function keyMatches(presented: string, storedHashHex: string): boolean {
  const a = Buffer.from(hashKey(presented), "hex");
  const b = Buffer.from(storedHashHex, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * File-backed API key store. MUST live outside the facts git repo (it holds secrets,
 * even though only hashes are stored).
 */
export class ApiKeyStore {
  constructor(private readonly filePath: string) {}

  private async read(): Promise<ApiKeyRecord[]> {
    try {
      return JSON.parse(await fs.readFile(this.filePath, "utf8")) as ApiKeyRecord[];
    } catch {
      return [];
    }
  }

  private async write(records: ApiKeyRecord[]): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(records, null, 2), "utf8");
  }

  /** Issue a new key for an identity. Returns the plaintext once. */
  async issue(identity: string, env: KeyEnvironment = "live", label?: string): Promise<GeneratedKey> {
    const generated = generateApiKey(identity, env, new Date(), label);
    const records = await this.read();
    records.push(generated.record);
    await this.write(records);
    return generated;
  }

  /** Resolve a presented key to its identity, or null if unknown. */
  async resolveIdentity(presentedKey: string): Promise<string | null> {
    for (const record of await this.read()) {
      if (keyMatches(presentedKey, record.hash)) return record.identity;
    }
    return null;
  }

  /** List keys. Exposes the hash so callers can revoke by id. */
  async list(): Promise<{ hash: string; identity: string; prefix: string; created: string; label?: string }[]> {
    return (await this.read()).map((r) => ({
      hash: r.hash,
      identity: r.identity,
      prefix: r.prefix,
      created: r.created,
      label: r.label,
    }));
  }

  /** Remove the key with this hash. Returns true if one was removed. */
  async revoke(hash: string): Promise<boolean> {
    const records = await this.read();
    const next = records.filter((r) => r.hash !== hash);
    if (next.length === records.length) return false;
    await this.write(next);
    return true;
  }
}
