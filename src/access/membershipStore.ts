// Raw-preserving mutations of <dataDir>/.krimto/members.yaml. Each reads the raw YAML, applies one
// change, and writes it back — unknown fields survive (generalizes bootstrap's ensureFirstOrgAdmin).
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { KrimtoError } from "../server/errors";

interface RawTeam {
  slug?: string;
  name?: string;
  members?: string[];
  leads?: string[];
}

export function membersFile(dataDir: string): string {
  return path.join(dataDir, ".krimto", "members.yaml");
}

async function readRaw(dataDir: string): Promise<Record<string, unknown>> {
  let text: string | null = null;
  try {
    text = await fs.readFile(membersFile(dataDir), "utf8");
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  // Corrupt YAML must propagate (never silently reset) — matches bootstrap.
  return text === null ? {} : ((parseYaml(text) ?? {}) as Record<string, unknown>);
}

/** Read members.yaml, apply `mutate`, write it back. Preserves unknown fields. */
export async function editMembersYaml(
  dataDir: string,
  mutate: (raw: Record<string, unknown>) => void,
): Promise<void> {
  const raw = await readRaw(dataDir);
  mutate(raw); // may throw (e.g. last-admin guard) — then nothing is written
  const file = membersFile(dataDir);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, stringifyYaml(raw), "utf8");
}

function org(raw: Record<string, unknown>): { slug: string; admins: string[] } {
  const o = (raw.org ?? {}) as { slug?: string; admins?: string[] };
  o.slug = o.slug ?? "default";
  o.admins = Array.isArray(o.admins) ? o.admins : [];
  raw.org = o;
  return o as { slug: string; admins: string[] };
}
function teams(raw: Record<string, unknown>): RawTeam[] {
  if (!Array.isArray(raw.teams)) raw.teams = [];
  return raw.teams as RawTeam[];
}
function users(raw: Record<string, unknown>): { email: string; created?: string }[] {
  if (!Array.isArray(raw.users)) raw.users = [];
  return raw.users as { email: string; created?: string }[];
}
function addToTeam(raw: Record<string, unknown>, slug: string, email: string): void {
  const list = teams(raw);
  let team = list.find((t) => t.slug === slug);
  if (!team) {
    team = { slug, members: [], leads: [] };
    list.push(team);
  }
  team.members = Array.isArray(team.members) ? team.members : [];
  if (!team.members.includes(email)) team.members.push(email);
}

export async function addUser(
  dataDir: string,
  email: string,
  opts: { team?: string; admin?: boolean } = {},
): Promise<void> {
  await editMembersYaml(dataDir, (raw) => {
    const list = users(raw);
    if (!list.some((u) => u.email === email)) list.push({ email, created: new Date().toISOString() });
    if (opts.team) addToTeam(raw, opts.team, email);
    if (opts.admin) {
      const o = org(raw);
      if (!o.admins.includes(email)) o.admins.push(email);
    }
  });
}

export async function removeUser(dataDir: string, email: string): Promise<void> {
  await editMembersYaml(dataDir, (raw) => {
    const o = org(raw);
    if (o.admins.includes(email) && o.admins.length === 1) {
      throw new KrimtoError("conflict", "Cannot remove the last org admin");
    }
    o.admins = o.admins.filter((a) => a !== email);
    raw.users = users(raw).filter((u) => u.email !== email);
    for (const t of teams(raw)) {
      if (Array.isArray(t.members)) t.members = t.members.filter((m) => m !== email);
      if (Array.isArray(t.leads)) t.leads = t.leads.filter((l) => l !== email);
    }
  });
}

/** Set the organization's display name and/or path slug, preserving the admin list + unknown
 *  fields. Used by `team init` to replace the meaningless `org/default` placeholder with the real
 *  org identity. Idempotent. Callers own the "don't rename a slug that already has notes" guard. */
export async function setOrg(
  dataDir: string,
  opts: { name?: string; slug?: string },
): Promise<void> {
  await editMembersYaml(dataDir, (raw) => {
    const o = org(raw) as { slug: string; admins: string[]; name?: string };
    if (opts.name !== undefined) o.name = opts.name;
    if (opts.slug !== undefined) o.slug = opts.slug;
  });
}

export async function createTeam(dataDir: string, slug: string, name?: string): Promise<void> {
  await editMembersYaml(dataDir, (raw) => {
    const list = teams(raw);
    if (!list.some((t) => t.slug === slug)) list.push({ slug, name, members: [], leads: [] });
  });
}

export async function setTeamMember(
  dataDir: string,
  slug: string,
  email: string,
  present: boolean,
): Promise<void> {
  await editMembersYaml(dataDir, (raw) => {
    if (present) {
      addToTeam(raw, slug, email);
    } else {
      const team = teams(raw).find((t) => t.slug === slug);
      if (team && Array.isArray(team.members)) team.members = team.members.filter((m) => m !== email);
    }
  });
}

export async function setOrgAdmin(dataDir: string, email: string, present: boolean): Promise<void> {
  await editMembersYaml(dataDir, (raw) => {
    const o = org(raw);
    if (present) {
      if (!o.admins.includes(email)) o.admins.push(email);
    } else {
      if (o.admins.length === 1 && o.admins.includes(email)) {
        throw new KrimtoError("conflict", "Cannot remove the last org admin");
      }
      o.admins = o.admins.filter((a) => a !== email);
    }
  });
}
