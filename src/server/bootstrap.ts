// First-run bootstrap: ensure the admin is an org admin in .krimto/members.yaml and issue one
// API key for them (printed once by the caller). Idempotent. (Gap 06)

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { type ApiKeyStore } from "../access/auth";

export interface BootstrapResult {
  /** The plaintext key, to be printed once — or null if the admin already had one. */
  key: string | null;
}

export async function bootstrapAdmin(email: string, keys: ApiKeyStore, dataDir: string): Promise<BootstrapResult> {
  await ensureFirstOrgAdmin(email, dataDir);
  // Called once at startup (single process), so the list→issue check needs no lock.
  const hasKey = (await keys.list()).some((k) => k.identity === email);
  if (hasKey) return { key: null };
  const { key } = await keys.issue(email);
  return { key };
}

/**
 * Recovery path (BUG-1): always mint and return a fresh key for `email`, ensuring they are an org
 * admin — even when an unusable key record already exists (e.g. the admin lost their only key's
 * plaintext). Unlike bootstrapAdmin, this does not check whether a record exists first.
 */
export async function reissueKey(email: string, keys: ApiKeyStore, dataDir: string): Promise<string> {
  await ensureFirstOrgAdmin(email, dataDir);
  const { key } = await keys.issue(email, "live", "reissued");
  return key;
}

async function ensureFirstOrgAdmin(email: string, dataDir: string): Promise<void> {
  const file = path.join(dataDir, ".krimto", "members.yaml");
  let text: string | null = null;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  let raw: Record<string, unknown> = {};
  if (text !== null) {
    // A corrupt members.yaml must NOT be silently reset — let parse errors propagate.
    raw = (parseYaml(text) ?? {}) as Record<string, unknown>;
  }
  const org = (raw.org ?? {}) as { slug?: string; admins?: string[] };
  org.slug = org.slug ?? "default";
  org.admins = Array.isArray(org.admins) ? org.admins : [];
  // Elevate to org-admin ONLY on first boot (no admins yet). Later, KRIMTO_BOOTSTRAP_ADMIN still
  // issues a key for any email (non-admins included) but does not auto-promote — use the admin API.
  if (org.admins.length === 0) org.admins.push(email);
  raw.org = org;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, stringifyYaml(raw), "utf8");
}
