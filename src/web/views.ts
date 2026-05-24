import { escapeHtml } from "./html";

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
  const rows =
    keys.length === 0
      ? `<tr><td colspan="3" class="muted">No keys yet.</td></tr>`
      : keys
          .map(
            (k) =>
              `<tr><td>${escapeHtml(k.label ?? "(no label)")}</td>` +
              `<td class="muted">${escapeHtml(k.prefix)}… ${escapeHtml(k.hash.slice(0, 12))} · ${escapeHtml(k.created)}</td>` +
              `<td><form method="post" action="/ui/keys/revoke" onsubmit="return confirm('Revoke this key?')">` +
              `<input type="hidden" name="hash" value="${escapeHtml(k.hash)}"><button type="submit">Revoke</button></form></td></tr>`,
          )
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
