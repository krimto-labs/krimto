// `krimto whoami` — show the active KRIMTO_IDENTITY and every place it's set.
//
// Motivation: the v0.2.21 "data-location surprise" bug class — users end up with two scopes
// (`user/lpdthemes@gmail.com` and `user/user@localhost`) because different surfaces saw
// different identities and they only noticed weeks later. `whoami` makes drift visible
// before it leads to split notes.

import { promises as fs } from "node:fs";

import {
  defaultIdentity,
  detectEditorEnvironments,
  type EditorEnvironment,
  type EditorKind,
} from "./init";
import { detectPlatform, isServiceInstalled, type ServicePlatform } from "./service";

const EDITOR_LABEL: Record<EditorKind, string> = {
  cursor: "Cursor",
  "claude-code": "Claude Code",
  codex: "Codex",
  "gemini-cli": "Gemini CLI",
};

export interface WhoamiOptions {
  cwd?: string;
  homeDir?: string;
}

export interface IdentitySource {
  label: string;
  /** The literal value found; `null` when nothing readable, `"(http)"` for HTTP entries with no inline identity. */
  identity: string | null;
  detail?: string;
}

export interface WhoamiResult {
  /** The identity Krimto would use for a write right now (best inference). */
  activeIdentity: string;
  sources: IdentitySource[];
  /** True when registered surfaces disagree on identity. */
  mismatch: boolean;
  message: string;
}

export async function runWhoami(opts: WhoamiOptions = {}): Promise<WhoamiResult> {
  const cwd = opts.cwd ?? process.cwd();
  const homeDir = opts.homeDir;
  const envs = await detectEditorEnvironments(cwd, homeDir);

  const sources: IdentitySource[] = [];
  const distinctIdentities = new Set<string>();

  for (const env of envs) {
    const found = await readIdentityFromEditor(env);
    if (found === null) continue;
    sources.push(found);
    if (found.identity && found.identity !== "(http)") distinctIdentities.add(found.identity);
  }

  const platform = detectPlatform();
  const service = await isServiceInstalled(platform, homeDir);
  if (service.installed && service.unitPath) {
    const id = await readIdentityFromServiceUnit(service.unitPath, platform);
    if (id) {
      sources.push({ label: "Background service", identity: id, detail: service.unitPath });
      distinctIdentities.add(id);
    }
  }

  const envOverride = process.env.KRIMTO_IDENTITY ?? null;
  const gitDefault = await defaultIdentity();

  // Active identity = first concrete source we found; fall back through env → git → server default.
  const firstConcrete = sources.find((s) => s.identity && s.identity !== "(http)")?.identity;
  const activeIdentity = firstConcrete ?? envOverride ?? gitDefault;
  const mismatch = distinctIdentities.size > 1;

  return {
    activeIdentity,
    sources,
    mismatch,
    message: formatWhoami({ activeIdentity, sources, mismatch, envOverride, gitDefault }),
  };
}

async function readIdentityFromEditor(env: EditorEnvironment): Promise<IdentitySource | null> {
  if (env.mcpWire === null || env.mcpWire.method !== "json") return null;
  let text: string;
  try {
    text = await fs.readFile(env.mcpWire.path, "utf8");
  } catch {
    return null;
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
  const servers = parsed[env.mcpWire.key] as Record<string, unknown> | undefined;
  if (!servers || !("krimto" in servers)) return null;
  const krimto = servers.krimto as { env?: Record<string, string>; url?: string };
  const label = `${EDITOR_LABEL[env.editor]} MCP config`;
  if (krimto.env?.KRIMTO_IDENTITY) {
    return { label, identity: krimto.env.KRIMTO_IDENTITY, detail: env.mcpWire.path };
  }
  if (krimto.url) {
    return { label, identity: "(http)", detail: env.mcpWire.path };
  }
  return null;
}

async function readIdentityFromServiceUnit(
  unitPath: string,
  platform: ServicePlatform,
): Promise<string | null> {
  let text: string;
  try {
    text = await fs.readFile(unitPath, "utf8");
  } catch {
    return null;
  }
  if (platform === "darwin") {
    // plist XML pattern written by installService — KRIMTO_IDENTITY appears as a <key>/<string> pair.
    const m = text.match(/<key>KRIMTO_IDENTITY<\/key>\s*<string>([^<]+)<\/string>/);
    return m && m[1] ? m[1] : null;
  }
  if (platform === "linux") {
    const m = text.match(/KRIMTO_IDENTITY=([^"\s\n]+)/);
    return m && m[1] ? m[1] : null;
  }
  // Windows: schtasks doesn't store env in a readable file we own. Skip.
  return null;
}

function formatWhoami(opts: {
  activeIdentity: string;
  sources: IdentitySource[];
  mismatch: boolean;
  envOverride: string | null;
  gitDefault: string;
}): string {
  const lines: string[] = ["", "Krimto — Identity", ""];
  lines.push(`  Active identity:   ${opts.activeIdentity}`, "");
  lines.push("  Where it's set:");
  if (opts.sources.length === 0) {
    lines.push("    (no editors registered, no service installed — run `krimto init` first)");
  } else {
    for (const s of opts.sources) {
      const display = s.identity === "(http)" ? "(uses service identity)" : (s.identity ?? "(unset)");
      const marker = s.identity === "(http)" || s.identity === opts.activeIdentity ? "✓" : "⚠";
      lines.push(`    ${marker} ${s.label.padEnd(28)} ${display}`);
    }
  }
  lines.push("");
  lines.push("  Fallback chain (used when no source above sets it):");
  lines.push(`    KRIMTO_IDENTITY env       ${opts.envOverride ?? "(unset)"}`);
  lines.push(`    git config user.email     ${opts.gitDefault}`);
  lines.push("    Server default            user@localhost");
  lines.push("");
  if (opts.mismatch) {
    lines.push("  ⚠️  Mismatch — different sources disagree on identity.");
    lines.push("     Run `krimto set identity <email>` to sync them.");
  } else if (opts.sources.length > 0) {
    lines.push("  ✅  All sources agree.");
  }
  lines.push("");
  lines.push("To change it: krimto set identity <email>");
  lines.push("");
  return lines.join("\n");
}
