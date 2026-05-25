import { escapeHtml } from "./html";
import { connectSnippets, cursorDeeplink } from "../server/connect";

export function loginBody(error?: string): string {
  const err = error ? `<p style="color:#b91c1c">${escapeHtml(error)}</p>` : "";
  return (
    `<h1>Krimto</h1><p>Sign in with your API key.</p>${err}` +
    `<form method="post" action="/ui/login">` +
    `<input name="key" type="password" placeholder="krm_live_..." style="width:60%" autofocus>` +
    `<button type="submit">Sign in</button></form>`
  );
}

export function searchBox(q: string): string {
  return (
    `<h1>Facts</h1><form method="get" action="/ui/facts">` +
    `<input name="q" value="${escapeHtml(q)}" placeholder="Search facts..." style="width:60%">` +
    `<button type="submit">Search</button></form>`
  );
}

export interface RecallRow { id: string; scope: string; title: string }
export function factResults(results: RecallRow[]): string {
  if (results.length === 0) return `<p class="muted">No matching facts.</p>`;
  const rows = results
    .map(
      (r) =>
        `<tr><td><a href="/ui/facts/${encodeURIComponent(r.id)}">${escapeHtml(r.title)}</a></td>` +
        `<td class="muted">${escapeHtml(r.scope)}</td></tr>`,
    )
    .join("");
  return `<table><thead><tr><th>Title</th><th>Scope</th></tr></thead><tbody>${rows}</tbody></table>`;
}

export interface ScopeRow { scope: string; factCount: number }
export function scopeList(scopes: ScopeRow[]): string {
  if (scopes.length === 0) return `<p class="muted">No readable scopes yet.</p>`;
  const rows = scopes
    .map((s) => `<tr><td>${escapeHtml(s.scope)}</td><td class="muted">${s.factCount} facts</td></tr>`)
    .join("");
  return `<p class="muted">Your scopes — use search to find facts.</p><table><tbody>${rows}</tbody></table>`;
}

export interface FactView {
  id: string; scope: string; title: string; body: string;
  author?: string; source?: string; created?: string; tags?: string[];
}
export function factDetail(f: FactView): string {
  const tags = f.tags && f.tags.length ? f.tags.map((t) => escapeHtml(t)).join(", ") : "—";
  return (
    `<p><a href="/ui/facts">← Facts</a></p><h1>${escapeHtml(f.title)}</h1>` +
    `<p class="muted">${escapeHtml(f.scope)} · ${escapeHtml(f.author ?? "unknown")} · ${escapeHtml(f.created ?? "")}</p>` +
    `<pre>${escapeHtml(f.body)}</pre>` +
    `<p class="muted">id: ${escapeHtml(f.id)} · source: ${escapeHtml(f.source ?? "—")} · tags: ${tags}</p>`
  );
}

export interface KeyRow { hash: string; prefix: string; created: string; label?: string }
export function keysBody(keys: KeyRow[]): string {
  // Never offer to revoke the sole key — that locks the user out (BUG-1). The aria-label and
  // the visible label+id identify exactly which key a revoke button acts on (BUG-2).
  const onlyKey = keys.length === 1;
  const rows =
    keys.length === 0
      ? `<tr><td colspan="3" class="muted">No keys yet.</td></tr>`
      : keys
          .map((k) => {
            const label = k.label ?? "(no label)";
            const id = `${label} (${k.prefix}…${k.hash.slice(0, 8)})`;
            const action = onlyKey
              ? `<span class="muted" title="Issue another key before you can revoke this one">only key</span>`
              : `<form method="post" action="/ui/keys/revoke" ` +
                `onsubmit="return confirm('Revoke this key? You will lose access from it — this cannot be undone.')">` +
                `<input type="hidden" name="hash" value="${escapeHtml(k.hash)}">` +
                `<button type="submit" aria-label="Revoke key ${escapeHtml(id)}">Revoke</button></form>`;
            return (
              `<tr><td>${escapeHtml(label)}</td>` +
              `<td class="muted">${escapeHtml(k.prefix)}…${escapeHtml(k.hash.slice(0, 8))} · ${escapeHtml(k.created)}</td>` +
              `<td>${action}</td></tr>`
            );
          })
          .join("");
  return (
    `<h1>API keys</h1><table><thead><tr><th>Label</th><th>Key</th><th></th></tr></thead><tbody>${rows}</tbody></table>` +
    `<h2>Issue a new key</h2><form method="post" action="/ui/keys">` +
    `<input name="label" placeholder="label (optional)"><button type="submit">Issue key</button></form>`
  );
}

export function newKeyBody(key: string): string {
  return (
    `<h1>New API key</h1><p>Copy it now — it won't be shown again.</p>` +
    `<pre>${escapeHtml(key)}</pre><p><a href="/ui/keys">← Back to keys</a></p>`
  );
}

export interface AdminView {
  isAdmin: boolean;
  users: { email: string }[];
  teams: { slug: string; members: string[] }[];
}
export function adminBody(v: AdminView): string {
  if (!v.isAdmin) return `<h1>Admin</h1><p class="muted">Org-admin access required.</p>`;
  const userRows = v.users.length
    ? v.users.map((u) => `<tr><td>${escapeHtml(u.email)}</td></tr>`).join("")
    : `<tr><td class="muted">No users yet.</td></tr>`;
  const teamRows = v.teams.length
    ? v.teams
        .map(
          (t) =>
            `<tr><td>${escapeHtml(t.slug)}</td><td class="muted">${t.members.map((m) => escapeHtml(m)).join(", ")}</td></tr>`,
        )
        .join("")
    : `<tr><td colspan="2" class="muted">No teams yet.</td></tr>`;
  return (
    `<h1>Admin</h1>` +
    `<h2>Members</h2><table><tbody>${userRows}</tbody></table>` +
    `<form method="post" action="/ui/admin/members">` +
    `<input name="email" placeholder="teammate@acme.com" required>` +
    `<input name="team" placeholder="team slug (optional)">` +
    `<button type="submit">Add member</button></form>` +
    `<h2>Issue a key for a member</h2><form method="post" action="/ui/admin/keys">` +
    `<input name="email" placeholder="teammate@acme.com" required>` +
    `<input name="label" placeholder="label (optional)"><button type="submit">Issue key</button></form>` +
    `<h2>Teams</h2><table><tbody>${teamRows}</tbody></table>`
  );
}

/**
 * In-product connect instructions (Claude Code + Cursor), rendered from the request host so the URL
 * matches whatever the user typed. Local mode shows working no-key snippets and a one-click "Add to
 * Cursor" button; team mode shows the same shapes with a `krm_live_…` placeholder and points at the
 * Keys page — no one-click button there, since a link can't carry the user's real key.
 */
export function connectPanel(opts: { host: string; requireAuth: boolean }): string {
  const placeholderKey = opts.requireAuth ? "krm_live_…" : undefined;
  const { claude, cursorJson } = connectSnippets({ host: opts.host, key: placeholderKey });
  const button = opts.requireAuth
    ? ""
    : `<p><a href="${escapeHtml(cursorDeeplink(opts.host))}">Add to Cursor</a></p>`;
  const note = opts.requireAuth
    ? `<p class="muted">Team mode is on. Replace <code>krm_live_…</code> with a key from the ` +
      `<a href="/ui/keys">Keys</a> page (each key is shown once, when issued).</p>`
    : `<p class="muted">Local mode — no key needed. To bring your team, restart with ` +
      `<code>KRIMTO_BOOTSTRAP_ADMIN=you@acme.com</code>.</p>`;
  return (
    `<h1>Connect your agent</h1>` +
    `<p class="muted">Krimto is one MCP server — point any agent at it.</p>` +
    `<h2>Claude Code</h2><pre>${escapeHtml(claude)}</pre>` +
    `<h2>Cursor</h2>${button}` +
    `<p class="muted">…or add to <code>~/.cursor/mcp.json</code> and restart Cursor:</p>` +
    `<pre>${escapeHtml(cursorJson)}</pre>` +
    note
  );
}

/** Team-first explainer for the dashboard landing. The wedge (personal→team→org) is the headline. */
export function howItWorksPanel(): string {
  return (
    `<section style="border:1px solid #ddd;border-radius:6px;padding:1rem;margin:0 0 1rem">` +
    `<h2 style="margin-top:0">Shared memory for your team's AI</h2>` +
    `<p class="muted">Every agent on your team reads and writes the same memory, in three layers:</p>` +
    `<ul>` +
    `<li><strong>Personal</strong> — just you (your preferences, your notes).</li>` +
    `<li><strong>Team</strong> — your squad's shared conventions and facts.</li>` +
    `<li><strong>Org</strong> — company-wide rules everyone inherits.</li>` +
    `</ul>` +
    `<p class="muted">More specific wins: your personal note overrides the team's, which overrides the org's.</p>` +
    `<p><strong>Bring your team:</strong> restart with <code>KRIMTO_BOOTSTRAP_ADMIN=you@acme.com</code> to turn on ` +
    `accounts and invite teammates (hosted Krimto Cloud is on the roadmap).</p>` +
    `</section>`
  );
}
