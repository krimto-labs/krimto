import { escapeHtml } from "./html";
import { connectSnippets, cursorDeeplink, genericContract } from "../server/connect";
import { AGENT_RULE } from "../agentRule";

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
    `<h1>API keys</h1><p class="muted">Issue and revoke the keys your agents use to authenticate.</p>` +
    `<table><thead><tr><th>Label</th><th>Key</th><th></th></tr></thead><tbody>${rows}</tbody></table>` +
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
    `<h1>Admin</h1><p class="muted">Add teammates and manage teams.</p>` +
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
  const contract = genericContract({ host: opts.host, requireAuth: opts.requireAuth });
  const copy = (id: string): string => `<button type="button" data-copy="${escapeHtml(id)}">Copy</button>`;

  const cursorButton = opts.requireAuth
    ? ""
    : `<p><a href="${escapeHtml(cursorDeeplink(opts.host))}">Add to Cursor (one-click)</a></p>`;

  const teamKeyCallout = opts.requireAuth
    ? `<h2>Get your key (team mode)</h2>` +
      `<p>Krimto never displays issued keys. <a href="/ui/keys">Issue a key</a>, copy it, then ` +
      `replace <code>krm_live_…</code> in the config above with it.</p>`
    : "";

  const headerLine = contract.header
    ? `<li>Header: <code>${escapeHtml(contract.header)}</code></li>`
    : "";

  return (
    `<h1>Connect your agent</h1>` +
    `<p class="muted">Point your editor at Krimto: pick it, copy the config, paste it, then check the connection.</p>` +
    `<h2>1. Claude Code</h2>` +
    `<pre id="cc-cmd">${escapeHtml(claude)}</pre>${copy("cc-cmd")}` +
    `<p class="muted">Run it in your terminal. If Claude Code is already open, restart the session. ` +
    `Verify: <code>claude mcp list</code> shows <code>krimto</code> as ✓ Connected.</p>` +
    `<h2>2. Cursor</h2>${cursorButton}` +
    `<p class="muted">…or add to <code>~/.cursor/mcp.json</code>, then fully quit Cursor (Cmd-Q) and reopen:</p>` +
    `<pre id="cursor-json">${escapeHtml(cursorJson)}</pre>${copy("cursor-json")}` +
    `<p class="muted">Verify: Settings → MCP shows a green dot next to <code>krimto</code>.</p>` +
    teamKeyCallout +
    `<h2>3. Make it automatic</h2>` +
    `<p>By default your AI uses memory only when you ask. Paste this rule once so it remembers and recalls on its own:</p>` +
    `<pre id="auto-rule">${escapeHtml(AGENT_RULE)}</pre>${copy("auto-rule")}` +
    `<p class="muted">Where to paste it: Claude Code → <code>CLAUDE.md</code> · Cursor → ` +
    `<code>.cursor/rules/krimto.mdc</code> · Codex → <code>AGENTS.md</code> · Gemini CLI → <code>GEMINI.md</code>.</p>` +
    `<h2>Any other MCP client</h2>` +
    `<p class="muted">Krimto speaks the Model Context Protocol. Configure your client with:</p>` +
    `<ul>` +
    `<li>Transport: <strong>Streamable HTTP</strong></li>` +
    `<li>URL: <code>${escapeHtml(contract.url)}</code></li>` +
    headerLine +
    `<li>Tools: <code>${escapeHtml(contract.tools.join(", "))}</code></li>` +
    `</ul>` +
    `<p class="muted">See your client's own MCP-server docs for where to paste this.</p>` +
    `<p><strong>Next:</strong> <a href="/ui/facts">save your first memory →</a></p>`
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
    `<p class="muted"><strong>What to expect when you turn on team mode:</strong> Krimto starts asking ` +
    `for a key (so only your team gets in), prints your ready-to-paste config, and unlocks the Team page ` +
    `to invite people.</p>` +
    `<p><strong>Bring your team:</strong> restart with <code>KRIMTO_BOOTSTRAP_ADMIN=you@acme.com</code> to turn on ` +
    `accounts and invite teammates (hosted Krimto Cloud is on the roadmap).</p>` +
    `</section>`
  );
}

/**
 * The empty-dashboard guide (friction-log C/E; journey Doors 1 & 4): shown when there are no facts
 * yet. It first explains AI memory to a total newcomer, then walks them through the first save→recall
 * loop (with "what to expect"), the value, and the next step.
 */
export function gettingStartedPanel(): string {
  const say = "Use krimto to remember that our deploys are Tuesdays at 10am.";
  return (
    `<section style="border:1px solid #ddd;border-radius:6px;padding:1rem;margin:0 0 1rem">` +
    `<h2 style="margin-top:0">New here? What "AI memory" means</h2>` +
    `<p>Normally your AI forgets everything when you close the chat. Krimto gives it a memory: ` +
    `you teach it once, and it remembers next time — across chats, across editors, and across your team.</p>` +
    `</section>` +
    `<section style="border:1px solid #ddd;border-radius:6px;padding:1rem;margin:0 0 1rem">` +
    `<h2 style="margin-top:0">Save your first memory</h2>` +
    `<p>In your editor, tell your agent:</p>` +
    `<pre id="say-this">${escapeHtml(say)}</pre><button type="button" data-copy="say-this">Copy</button>` +
    `<p>Then open a <strong>new chat</strong> and ask: <em>"what do you know about deploys?"</em></p>` +
    `<p><strong>Expect this:</strong> your AI answers correctly even in a brand-new chat — that's the memory working.</p>` +
    `<h3>Why this matters</h3>` +
    `<ul>` +
    `<li><strong>Across sessions</strong> — your AI stops forgetting every time you start a new chat.</li>` +
    `<li><strong>Across editors</strong> — Cursor and Claude Code share what you taught them.</li>` +
    `<li><strong>Across teammates</strong> — your team's conventions live in one place every agent can read.</li>` +
    `</ul>` +
    `<p class="muted">No AI key and no database to set up — Krimto works out of the box.</p>` +
    `<p>Not connected yet? <a href="/ui/connect">Start here →</a> Bring your team: restart with ` +
    `<code>KRIMTO_BOOTSTRAP_ADMIN=you@acme.com</code>.</p>` +
    `</section>`
  );
}
