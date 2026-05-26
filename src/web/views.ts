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

export interface FactListRow {
  id: string;
  scope: string;
  title: string;
  author?: string;
  updated?: string;
}

/**
 * Flat list of every fact the viewer can read, newest-first. Renders below the per-scope summary
 * on /ui/facts so a user can browse without typing a search query first.
 */
export function factsList(facts: FactListRow[], totalAvailable: number): string {
  if (facts.length === 0) return "";
  const ago = (iso?: string): string => {
    if (!iso) return "—";
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return iso;
    const secs = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (secs < 60) return `${secs}s ago`;
    const mins = Math.round(secs / 60);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.round(hrs / 24)}d ago`;
  };
  const rows = facts
    .map(
      (f) =>
        `<tr>` +
        `<td><a href="/ui/facts/${encodeURIComponent(f.id)}">${escapeHtml(f.title)}</a></td>` +
        `<td class="muted">${escapeHtml(f.scope)}</td>` +
        `<td class="muted" style="white-space:nowrap">${escapeHtml(ago(f.updated))}</td>` +
        `<td class="muted">${escapeHtml(f.author ?? "—")}</td>` +
        `</tr>`,
    )
    .join("");
  const moreLine =
    totalAvailable > facts.length
      ? `<p class="muted" style="margin-top:8px">Showing ${facts.length} of ${totalAvailable} facts. ` +
        `Use the search box above to find a specific one.</p>`
      : "";
  return (
    `<h2 style="margin-top:2rem">All facts <span class="muted" style="font-weight:normal;font-size:0.7em">(${totalAvailable} total)</span></h2>` +
    `<table><thead><tr><th>Title</th><th>Scope</th><th>Updated</th><th>Author</th></tr></thead>` +
    `<tbody>${rows}</tbody></table>` +
    moreLine
  );
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
  /** Absolute path to the markdown file on disk. Surfaced so users learn "this is just a file." */
  sourcePath?: string;
  /** When true, render the Delete form (caller decides based on canWrite for the fact's scope). */
  canDelete?: boolean;
}
export function factDetail(f: FactView): string {
  const tags = f.tags && f.tags.length ? f.tags.map((t) => escapeHtml(t)).join(", ") : "—";
  const sourceLine = f.sourcePath
    ? `<p class="muted" style="margin-top:0.5rem">📝 Source file: <code>${escapeHtml(f.sourcePath)}</code> ` +
      `<span style="opacity:0.7">— open it in any editor to see exactly what was stored.</span></p>`
    : "";
  // Delete is opt-in (canDelete) — the route handler checks canWrite and only sets it when allowed.
  const deleteForm = f.canDelete
    ? `<form method="post" action="/ui/facts/${encodeURIComponent(f.id)}/delete" ` +
      `style="margin-top:1.5rem;padding-top:1rem;border-top:1px solid #ddd" ` +
      `onsubmit="return confirm('Permanently delete this fact? The .md file will be removed and the deletion committed to git (old content stays in git log).');">` +
      `<button type="submit" style="background:#a82c1c;color:#fff;border:0;padding:6px 14px;border-radius:3px;cursor:pointer">` +
      `🗑️ Delete this fact</button>` +
      `<span class="muted" style="margin-left:10px">Hard-delete: file is unlinked + git records the removal. ` +
      `Old content stays in <code>git log</code>.</span>` +
      `</form>`
    : "";
  return (
    `<p><a href="/ui/facts">← Facts</a></p><h1>${escapeHtml(f.title)}</h1>` +
    `<p class="muted">${escapeHtml(f.scope)} · ${escapeHtml(f.author ?? "unknown")} · ${escapeHtml(f.created ?? "")}</p>` +
    `<pre>${escapeHtml(f.body)}</pre>` +
    `<p class="muted">id: ${escapeHtml(f.id)} · source: ${escapeHtml(f.source ?? "—")} · tags: ${tags}</p>` +
    sourceLine +
    deleteForm
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

  // G3 — only render the "already on stdio?" notice in local mode (the `serve` path). In team
  // mode this page is the ONLY connect path users have, so the notice would just confuse them.
  const stdioAlreadyNotice = opts.requireAuth
    ? ""
    : `<p style="background:#fff8d5;border:1px solid #c8a830;border-radius:4px;padding:10px 14px;margin:0 0 16px">` +
      `<strong>🔌 Already connected via stdio?</strong> If your editor already runs Krimto via ` +
      `<code>npx @krimto-labs/krimto</code> (the npx path), <strong>keep that config</strong>. ` +
      `This page is for clients you haven't connected yet. Two configs pointing at one Krimto ` +
      `aren't needed — and adding the HTTP one alongside stdio risks two processes fighting ` +
      `over the same data folder.</p>`;
  return (
    `<h1>Connect your agent</h1>` +
    `<p class="muted">Point your editor at Krimto: pick it, copy the config, paste it, then check the connection.</p>` +
    stdioAlreadyNotice +
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
    `<p>By default your AI uses memory only when you ask. <strong>Fastest:</strong> run ` +
    `<code>npx @krimto-labs/krimto init</code> in your project — it writes the rule below into your ` +
    `agent's rules files for you. Or paste it yourself so the agent remembers and recalls on its own:</p>` +
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
    `<h2>✅ Connected? Do these three things</h2>` +
    `<p>Pasting the snippet above only makes the five tools <em>available</em> to your agent. To make ` +
    `your agent actually use them — and to confirm the whole loop end-to-end — do these in order:</p>` +
    `<ol>` +
    `<li><strong>Make it auto.</strong> In your project root, run:` +
    `<pre id="verify-init">npx @krimto-labs/krimto init</pre>${copy("verify-init")}` +
    `Restart your editor afterward so the rule takes effect.</li>` +
    `<li><strong>Test the write path.</strong> Paste this into your AI chat:` +
    `<pre id="verify-write">Remember that we use pnpm in this repo (not npm).</pre>${copy("verify-write")}` +
    `Your agent should call <code>krimto_write</code> and confirm it saved.</li>` +
    `<li><strong>Test the recall path.</strong> Open a <em>new</em> chat and paste:` +
    `<pre id="verify-recall">What do you know about this repo?</pre>${copy("verify-recall")}` +
    `Your agent should call <code>krimto_recall</code>, find the pnpm fact, and use it.</li>` +
    `</ol>` +
    `<p>Then come back here → <a href="/ui/facts">/ui/facts</a> — the <strong>Recent activity</strong> panel ` +
    `should show both calls within a few seconds. If it's empty, run ` +
    `<code>npx @krimto-labs/krimto verify-connection</code> in your terminal to diagnose.</p>`
  );
}

/**
 * "You own your data" explainer — taught at the moment a user is looking at their facts. Surfaces
 * the markdown-in-git storage model (Krimto's wedge vs. Mem0 / Cursor's built-in memory) so a
 * first-timer learns it from the product, not from the README they didn't read.
 */
export function behindTheScenesPanel(dataDir: string): string {
  return (
    `<section style="border:1px solid #ddd;border-radius:6px;padding:1rem;margin:0 0 1rem">` +
    `<h2 style="margin-top:0">Behind the scenes — your data, your files</h2>` +
    `<p class="muted">Your facts aren't locked in a database. They live as <strong>plain markdown files</strong> ` +
    `you can open in any editor, tracked by <strong>git</strong> (audit log + history).</p>` +
    `<ul>` +
    `<li><strong>📝 Markdown files</strong> — one fact per file at ` +
    `<code>${escapeHtml(dataDir)}/{user,team,org}/&lt;id&gt;/&lt;slug&gt;.md</code>. ` +
    `The real source of truth. Open one with any editor.</li>` +
    `<li><strong>📚 Git repo</strong> — every change is committed (batched every 30s). ` +
    `Run <code>git log</code> inside the folder for the full history.</li>` +
    `<li><strong>⚡ index.db</strong> — a fast search index. Just a cache — Krimto rebuilds ` +
    `it from your markdown on next boot. You can ignore it.</li>` +
    `</ul>` +
    `<p class="muted">If Krimto disappeared tomorrow, you'd still have every fact: they're just files in a folder you own. ` +
    `Run <code>npx @krimto-labs/krimto storage</code> in your terminal for the full explanation.</p>` +
    `</section>`
  );
}

export interface ActivityRow {
  timestamp: string;
  tool: string;
  identity: string;
  detail?: string;
}

/**
 * Gap #5+#6 — recall-without-write warning. When the activity log shows many recalls but no
 * writes in the recent window, that's the signature of another memory system (Claude Code's
 * per-session auto-memory at `~/.claude/projects/<slug>/memory/`) intercepting "remember X"
 * before krimto_write gets a chance. Surface it to the user so they don't have to grep JSONL.
 *
 * Returns "" when the threshold isn't met — caller renders nothing in the healthy case.
 */
export function hijackWarningPanel(stats: { recalls: number; writes: number; total: number }): string {
  // Threshold: 3+ recalls AND zero writes in the window. Below 3 it's normal "just-started" noise.
  if (stats.recalls < 3 || stats.writes > 0) return "";
  return (
    `<section style="border:1px solid #c44a3a;border-left-width:4px;border-radius:6px;` +
    `padding:1rem;margin:0 0 1rem;background:#fdf3f0">` +
    `<h2 style="margin-top:0;color:#a82c1c">⚠️ ${stats.recalls} recalls, 0 writes — your agent may be saving facts somewhere else</h2>` +
    `<p>Krimto received ${stats.recalls} <code>krimto_recall</code> call(s) but no writes ` +
    `recently. That usually means another memory system is intercepting "remember X" requests — ` +
    `most often Claude Code's per-session auto-memory at <code>~/.claude/projects/*/memory/</code>, ` +
    `which is invisible to teammates and to your other editors.</p>` +
    `<p><strong>Fix:</strong> in your project root, run:</p>` +
    `<pre>npx @krimto-labs/krimto init</pre>` +
    `<p class="muted">That refreshes the always-use-Krimto rule with stronger primacy language. ` +
    `Restart your editor afterward, then try "remember" again.</p>` +
    `</section>`
  );
}

/**
 * G5 — "Recent activity" panel on /ui/facts. Shows the last few MCP tool calls so a user can see
 * at a glance whether her agent is actually hitting Krimto, and what scope/title each call touched.
 * Critical for diagnosing the silent-no-call failure mode (DEFAULT mode without the "use krimto" prefix).
 */
export function activityPanel(entries: ActivityRow[], now: Date = new Date()): string {
  if (entries.length === 0) {
    return (
      `<section style="border:1px solid #ddd;border-radius:6px;padding:1rem;margin:0 0 1rem">` +
      `<h2 style="margin-top:0">Recent activity</h2>` +
      `<p class="muted">No MCP tool calls yet.</p>` +
      `<p class="muted">Try this in your editor: <em>"Use krimto to list the scopes I can see."</em> ` +
      `That should trigger a <code>krimto_list_scopes</code> call and appear here within a few seconds.</p>` +
      `</section>`
    );
  }
  // Newest first
  const sorted = [...entries].sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
  const rows = sorted
    .map((e) => {
      const ago = humanAgo(e.timestamp, now);
      return (
        `<tr>` +
        `<td class="muted" style="white-space:nowrap">${escapeHtml(ago)}</td>` +
        `<td><code>${escapeHtml(e.tool)}</code></td>` +
        `<td>${escapeHtml(e.detail ?? "—")}</td>` +
        `<td class="muted">${escapeHtml(e.identity)}</td>` +
        `</tr>`
      );
    })
    .join("");
  return (
    `<section style="border:1px solid #ddd;border-radius:6px;padding:1rem;margin:0 0 1rem">` +
    `<h2 style="margin-top:0">Recent activity</h2>` +
    `<p class="muted">Last few MCP tool calls Krimto received. Helps diagnose "did my agent actually search?"</p>` +
    `<table><thead><tr><th>When</th><th>Tool</th><th>Detail</th><th>Caller</th></tr></thead>` +
    `<tbody>${rows}</tbody></table>` +
    `</section>`
  );
}

function humanAgo(iso: string, now: Date): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const secs = Math.max(0, Math.round((now.getTime() - t) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

export interface StatusPanelOpts {
  /** The configured git remote URL, or undefined when none. */
  gitRemoteUrl?: string;
  /** Status of the most recent push attempt. */
  lastPushStatus?: "ok" | "skipped" | "error" | "none";
  /** Most recent inbound pull status, when a remote sync loop is running. */
  lastPullStatus?: "ok" | "skipped" | "up-to-date" | "conflict" | "error" | "none";
  /** Configured embedding provider name + dim, or undefined when lexical-only. */
  embeddings?: { provider: string; dimensions: number };
}

/**
 * "Operational status" panel — shows whether the two optional add-ons (git remote sync, semantic
 * embeddings) are configured and working, so Maria doesn't have to grep stderr or `git remote -v`
 * to know whether her facts are syncing.
 */
export function statusPanel(opts: StatusPanelOpts): string {
  const dot = (color: string): string =>
    `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${color};margin-right:6px"></span>`;
  const ok = dot("#3d5a3d");
  const warn = dot("#8a6817");
  const err = dot("#a82c1c");

  // Git remote row — three states: configured + healthy, configured + recent error, not configured.
  let gitRow: string;
  if (opts.gitRemoteUrl) {
    const pushBad = opts.lastPushStatus === "error";
    const pullBad = opts.lastPullStatus === "conflict" || opts.lastPullStatus === "error";
    if (pushBad || pullBad) {
      gitRow =
        `<li>${err}<strong>Git remote:</strong> <code>${escapeHtml(opts.gitRemoteUrl)}</code>` +
        ` — last sync failed (push: ${escapeHtml(opts.lastPushStatus ?? "?")}, ` +
        `pull: ${escapeHtml(opts.lastPullStatus ?? "?")}). Check <code>/health/ready</code> for detail.</li>`;
    } else {
      gitRow =
        `<li>${ok}<strong>Git remote:</strong> <code>${escapeHtml(opts.gitRemoteUrl)}</code>` +
        ` — auto-push every batch, auto-pull every 60s.</li>`;
    }
  } else {
    gitRow =
      `<li>${warn}<strong>Git remote:</strong> not configured — facts stay on this machine only. ` +
      `Set up cross-machine sync with: <code>npx @krimto-labs/krimto setup-remote &lt;url&gt;</code></li>`;
  }

  // Embedding row — two states: provider configured (semantic+lexical) vs none (lexical only).
  let embedRow: string;
  if (opts.embeddings) {
    embedRow =
      `<li>${ok}<strong>Embeddings:</strong> ${escapeHtml(opts.embeddings.provider)} ` +
      `(${opts.embeddings.dimensions}-dim) — semantic + keyword search enabled.</li>`;
  } else {
    embedRow =
      `<li>${warn}<strong>Embeddings:</strong> not configured — recall uses keyword search (BM25) only. ` +
      `Turn on semantic search with: <code>npx @krimto-labs/krimto setup-embeddings</code></li>`;
  }

  return (
    `<section style="border:1px solid #ddd;border-radius:6px;padding:1rem;margin:0 0 1rem">` +
    `<h2 style="margin-top:0">Status</h2>` +
    `<p class="muted">Both rows below are optional add-ons. Krimto works fully without them.</p>` +
    `<ul style="list-style:none;padding-left:0;margin:0">${gitRow}${embedRow}</ul>` +
    `</section>`
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
