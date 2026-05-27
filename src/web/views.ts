import { escapeHtml } from "./html";
import { connectSnippets, cursorDeeplink, genericContract } from "../server/connect";
import { AGENT_RULE } from "../agentRule";
import { scopeLabel } from "../access/scopeLabels";
import { type Membership } from "../access/membership";

export function loginBody(error?: string): string {
  const err = error ? `<p style="color:#b91c1c">${escapeHtml(error)}</p>` : "";
  return (
    `<h1>Krimto</h1><p>Sign in with your API key.</p>${err}` +
    `<form method="post" action="/ui/login">` +
    `<input name="key" type="password" placeholder="krm_live_..." style="width:60%" autofocus>` +
    `<button type="submit">Sign in</button></form>`
  );
}

// ── Dashboard chrome (v0.2.30) ────────────────────────────────────────────
//
// Matches docs/krimto-v0.2.17-maria-journey.html §04. Same function names as before, but
// the bodies render the warm-paper notes-app aesthetic instead of the engineering table.
// Router signatures unchanged.

/**
 * Plain-English relative time for the dashboard. Mirrors the activity-panel `humanAgo`
 * helper further down in this file but takes no `now` arg (uses `Date.now()` directly,
 * which is what the note-row meta and header subtitle want).
 */
function agoFromNow(iso?: string | null): string {
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
}

/** Emoji icon by scope kind. user/* → 📔, team/* → 📓, org/* → 🏢. */
function scopeIcon(scope: string): string {
  if (scope.startsWith("team/")) return "📓";
  if (scope.startsWith("org/")) return "🏢";
  return "📔"; // user/* (and any unknown — keeps the layout uniform)
}

/**
 * v0.2.30 — page header on the dashboard. The mockup shows the viewer's identity at the top
 * ("Krimto · Maria's AI memory") plus a small mono-font subtitle with totals + sync time.
 * `syncedAgo` is computed by the caller as max(last commit, last write activity) so the
 * headline reflects a write that happened seconds ago even before the 30s commit batch fires.
 */
export function dashboardHeader(viewer: string, totalNotes: number, syncedAgo: string | null): string {
  const sub = syncedAgo
    ? `${totalNotes} note${totalNotes === 1 ? "" : "s"} · synced ${escapeHtml(syncedAgo)}`
    : `${totalNotes} note${totalNotes === 1 ? "" : "s"}`;
  return (
    `<div class="dashboard-header">` +
    `<h1>Krimto · <em>${escapeHtml(viewer)}</em>'s AI memory</h1>` +
    `<p class="dashboard-sub">${sub}</p>` +
    `</div>`
  );
}

/**
 * Search input. Sits between the header and the scope cards. Keeps the same `/ui/facts?q=`
 * GET shape so existing URLs still work.
 */
export function searchBox(q: string): string {
  return (
    `<form method="get" action="/ui/facts" style="margin:1rem 0">` +
    `<input name="q" value="${escapeHtml(q)}" placeholder="Search notes..." style="width:60%">` +
    `<button type="submit">Search</button></form>`
  );
}

export interface RecallRow { id: string; scope: string; title: string }
export function factResults(results: RecallRow[]): string {
  if (results.length === 0) return `<p class="muted">No matching notes.</p>`;
  return results
    .map(
      (r) =>
        `<div class="note-row">` +
        `<div class="title"><a href="/ui/facts/${encodeURIComponent(r.id)}">${escapeHtml(r.title)}</a></div>` +
        `<div class="meta">${escapeHtml(r.scope)}</div>` +
        `</div>`,
    )
    .join("");
}

export interface FactListRow {
  id: string;
  scope: string;
  title: string;
  author?: string;
  updated?: string;
  /** Optional editor attribution — when set, rendered as "saved from a <source> chat". */
  source?: string | null;
}

/**
 * v0.2.30 — vertical timeline of notes the viewer can read, newest-first. Replaces the
 * v0.2.16 table. Each row carries a Fraunces-serif title, a mono meta line with ago +
 * plain-English scope label + source attribution, and an action row deep-linking to the
 * detail page (which already houses the inline Edit/Move/Delete forms — no new routes).
 *
 * The action row is gated by whether the viewer wrote the fact (best-effort canEdit
 * heuristic — the detail page enforces canWrite server-side, this is purely for UI noise
 * reduction). When the fact has someone else's author, only "View" / "View file" show.
 */
export function factsList(
  facts: FactListRow[],
  totalAvailable: number,
  membership: Membership,
  viewer: string,
): string {
  if (facts.length === 0) return "";
  const rows = facts
    .map((f) => {
      const ownerLine = renderSourceAttribution(f, viewer);
      const meta = `${escapeHtml(agoFromNow(f.updated))} · ${escapeHtml(scopeLabel(f.scope, viewer, membership))} · ${ownerLine}`;
      // Edit/Move/Delete are deep links into the detail page's existing inline forms (anchors
      // open the corresponding <details> block automatically via #fragment + :target CSS in v1
      // we just route to the detail page — the user clicks the form open from there).
      const canEdit = f.author === viewer;
      const detail = `/ui/facts/${encodeURIComponent(f.id)}`;
      const actions = canEdit
        ? `<a class="btn primary" href="${detail}">Edit</a>` +
          `<a class="btn" href="${detail}">Move</a>` +
          `<a class="btn" href="${detail}">Delete</a>` +
          `<a class="btn" href="${detail}">View file</a>`
        : `<a class="btn" href="${detail}">View</a>` +
          `<a class="btn" href="${detail}">View file</a>`;
      return (
        `<div class="note-row">` +
        `<div class="title"><a href="${detail}">${escapeHtml(f.title)}</a></div>` +
        `<div class="meta">${meta}</div>` +
        `<div class="actions">${actions}</div>` +
        `</div>`
      );
    })
    .join("");
  const moreLine =
    totalAvailable > facts.length
      ? `<p class="muted" style="margin-top:8px">Showing ${facts.length} of ${totalAvailable} notes. ` +
        `Use the search box above to find a specific one.</p>`
      : "";
  return (
    `<div class="section-label">Recent</div>` +
    rows +
    moreLine
  );
}

/**
 * Render the per-note "saved from / saved by" sub-line. v0.2.30 — when frontmatter `source`
 * is set (e.g. "cursor"), prefer "saved from a Cursor chat". MCP clients don't currently
 * populate the field, but the slot is here so any future agent-prompt convention that does
 * lands automatically. Fallback: "saved by you" / "saved by <author>".
 */
function renderSourceAttribution(f: FactListRow, viewer: string): string {
  if (f.source && f.source.trim() !== "") {
    const label = sourceDisplay(f.source);
    return `saved from a ${escapeHtml(label)} chat`;
  }
  return f.author === viewer ? "saved by you" : `saved by ${escapeHtml(f.author ?? "—")}`;
}

/** Map a raw source slug to its display label. Adds light formatting only. */
function sourceDisplay(source: string): string {
  const s = source.toLowerCase();
  if (s === "cursor") return "Cursor";
  if (s === "claude-code" || s === "claude") return "Claude Code";
  if (s === "codex") return "Codex";
  if (s === "gemini-cli" || s === "gemini") return "Gemini";
  return source;
}

export interface ScopeRow { scope: string; factCount: number }

/**
 * v0.2.30 — scope cards in a responsive grid. One card per scope, no collapsing. Each card
 * links to `/ui/facts?scope=<encoded>` so the user can drill into a single scope (router can
 * honour or ignore the param — v1 leaves it as a no-op page-load that still works).
 */
export function scopeList(
  scopes: ScopeRow[],
  membership: Membership,
  viewer: string,
): string {
  if (scopes.length === 0) return `<p class="muted">No readable scopes yet.</p>`;
  const cards = scopes
    .map((s) => {
      const label = scopeLabel(s.scope, viewer, membership);
      const icon = scopeIcon(s.scope);
      const count = `${s.factCount} note${s.factCount === 1 ? "" : "s"}`;
      const href = `/ui/facts?scope=${encodeURIComponent(s.scope)}`;
      return (
        `<a class="scope-card" href="${href}">` +
        `<div class="icon">${icon}</div>` +
        `<div class="name">${escapeHtml(label)}</div>` +
        `<div class="count">${count}</div>` +
        `</a>`
      );
    })
    .join("");
  return `<div class="scope-row">${cards}</div>`;
}

/**
 * v0.2.30 — page footer on the dashboard. Two buttons matching the mockup:
 *   📂 Open notes folder  →  copies the absolute data-dir path to the clipboard via the
 *                            existing `data-copy-text` hook in html.ts. Shelling out to
 *                            `open <path>` from a browser POST is an attack surface we
 *                            don't need; the CLI `krimto open` is the right tool.
 *   ⚙ Settings            →  links to /ui/settings (existing route).
 */
export function dashboardFooter(dataDir: string): string {
  return (
    `<div class="dashboard-footer">` +
    `<button class="btn" data-copy-text="${escapeHtml(dataDir)}">📂 Copy notes folder path</button>` +
    `<a class="btn" href="/ui/settings">⚙ Settings</a>` +
    `<span class="muted" style="margin-left:auto">${escapeHtml(dataDir)}</span>` +
    `</div>`
  );
}

export interface FactView {
  id: string; scope: string; title: string; body: string;
  author?: string; source?: string; created?: string; tags?: string[];
  /** Absolute path to the markdown file on disk. Surfaced so users learn "this is just a file." */
  sourcePath?: string;
  /** When true, render the Edit/Move/Delete forms. Set by the route handler from canWrite. */
  canEdit?: boolean;
  /** Same gating as canEdit — kept separate so future "soft edit but no delete" UIs work. */
  canDelete?: boolean;
  /** Plain-English label for the scope (e.g. "Just me", "Backend team"). */
  scopeLabel?: string;
  /** Other scopes the viewer can write to (for the Move dropdown). Excludes the current scope. */
  writableScopes?: { scope: string; label: string }[];
}
export function factDetail(f: FactView): string {
  const tags = f.tags && f.tags.length ? f.tags.map((t) => escapeHtml(t)).join(", ") : "—";
  const sourceLine = f.sourcePath
    ? `<p class="muted" style="margin-top:0.5rem">📝 Source file: <code>${escapeHtml(f.sourcePath)}</code> ` +
      `<span style="opacity:0.7">— open it in any editor to see exactly what was stored.</span></p>`
    : "";
  const scopeDisplay = f.scopeLabel ?? f.scope;

  // Inline Edit form (v0.2.17-3) — opens a <details> so the page stays compact by default.
  const editForm = f.canEdit
    ? `<details style="margin-top:1.5rem">` +
      `<summary style="cursor:pointer;font-weight:500">Edit this note</summary>` +
      `<form method="post" action="/ui/facts/${encodeURIComponent(f.id)}/edit" style="margin-top:8px">` +
      `<textarea name="body" rows="12" required style="width:100%;font-family:inherit;font-size:0.95em">${escapeHtml(f.body)}</textarea>` +
      `<p style="margin:6px 0"><button type="submit">Save changes</button> ` +
      `<span class="muted">Replaces the body in place. Title, scope, tags unchanged.</span></p>` +
      `</form></details>`
    : "";

  // Inline Move form (v0.2.17-3) — dropdown of writable scopes, excluding the current one.
  const moveForm = f.canEdit && f.writableScopes && f.writableScopes.length > 0
    ? `<details style="margin-top:1rem">` +
      `<summary style="cursor:pointer;font-weight:500">Move to a different scope</summary>` +
      `<form method="post" action="/ui/facts/${encodeURIComponent(f.id)}/move" style="margin-top:8px">` +
      `<select name="scope" required>` +
      f.writableScopes
        .map(
          (s) =>
            `<option value="${escapeHtml(s.scope)}">${escapeHtml(s.label)}</option>`,
        )
        .join("") +
      `</select> <button type="submit">Move</button> ` +
      `<span class="muted">Id is preserved. Markdown moves to the new scope's folder; git tracks both halves.</span>` +
      `</form></details>`
    : "";

  // Delete form (existing; canDelete preserved for back-compat).
  const deleteForm = f.canDelete
    ? `<form method="post" action="/ui/facts/${encodeURIComponent(f.id)}/delete" ` +
      `style="margin-top:1.5rem;padding-top:1rem;border-top:1px solid #ddd" ` +
      `onsubmit="return confirm('Permanently delete this note? The .md file will be removed and the deletion committed to git (old content stays in git log).');">` +
      `<button type="submit" style="background:#a82c1c;color:#fff;border:0;padding:6px 14px;border-radius:3px;cursor:pointer">` +
      `🗑️ Delete this note</button>` +
      `<span class="muted" style="margin-left:10px">Hard-delete: file is unlinked + git records the removal. ` +
      `Old content stays in <code>git log</code>.</span>` +
      `</form>`
    : "";
  return (
    `<p><a href="/ui/facts">← Notes</a></p><h1>${escapeHtml(f.title)}</h1>` +
    `<p class="muted">${escapeHtml(scopeDisplay)} · ${escapeHtml(f.author ?? "unknown")} · ${escapeHtml(f.created ?? "")}</p>` +
    `<pre>${escapeHtml(f.body)}</pre>` +
    `<p class="muted">id: ${escapeHtml(f.id)} · source: ${escapeHtml(f.source ?? "—")} · tags: ${tags}</p>` +
    sourceLine +
    editForm +
    moveForm +
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

/**
 * The v0.2.17-5 /ui/settings page. Composes the engineering-y panels that used to live on
 * /ui/facts so the Memory page stays focused on the notes themselves. Settings is the home
 * for: how it works, where data lives, status of the optional add-ons, full activity log,
 * pointers to keys + team admin pages.
 */
export function settingsBody(opts: {
  dataDir: string;
  status?: StatusPanelOpts;
  activity: ActivityRow[];
  isAdmin?: boolean;
}): string {
  const adminLinkRow = opts.isAdmin
    ? `<li><strong>Team admin</strong> — invite members, manage teams, issue keys: <a href="/ui/admin">/ui/admin</a></li>`
    : "";
  return (
    `<h1>Settings</h1>` +
    `<p class="muted">How Krimto works, where your data lives, what's configured, and recent agent activity.</p>` +
    howItWorksPanel() +
    behindTheScenesPanel(opts.dataDir) +
    (opts.status ? statusPanel(opts.status) : "") +
    activityPanel(opts.activity) +
    `<section style="border:1px solid #ddd;border-radius:6px;padding:1rem;margin:0 0 1rem">` +
    `<h2 style="margin-top:0">Other settings</h2>` +
    `<ul>` +
    `<li><strong>API keys</strong> — issue or revoke your own keys: <a href="/ui/keys">/ui/keys</a></li>` +
    `<li><strong>Connect a new editor</strong> — copy-paste config + standing rule: <a href="/ui/connect">/ui/connect</a></li>` +
    adminLinkRow +
    `</ul></section>`
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
