// Server-rendered HTML chrome for the /ui surface. Pure functions; all caller-supplied text
// MUST be escaped via escapeHtml before insertion.
//
// v0.2.42 — brand alignment. The page now follows the official Krimto brand
// (docs/Krimto Brand _standalone_.html): cool-gray paper (#F1F3F2), a desaturated slate accent,
// and the rising two-segment logomark. Per the v0.2.42 decision we adopt the brand COLORS + MARK but
// NOT the three brand webfonts — the same --serif/--sans/--mono token names carry the brand's own
// system fallbacks, so fonts can be self-hosted later with zero markup change and the page makes no
// third-party request. Legacy var names (--bg, --red, --rule, …) are kept as aliases onto the brand
// tokens so existing inline `var(--…)` references in views.ts render on-brand without edits.

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// The Krimto logomark: a rising two-segment stroke (26,74)→(50,44)→(76,22). Inline SVG using
// currentColor so callers tint it via CSS (.brand .logo paints it slate). No external asset.
export const LOGOMARK =
  `<svg class="logo" width="20" height="20" viewBox="0 0 100 100" aria-hidden="true">` +
  `<line x1="26" y1="74" x2="50" y2="44" stroke="currentColor" stroke-width="8" stroke-linecap="round"/>` +
  `<line x1="50" y1="44" x2="76" y2="22" stroke="currentColor" stroke-width="8" stroke-linecap="round"/>` +
  `</svg>`;

const STYLE = `
:root{
  /* Brand tokens (canonical) — docs/Krimto Brand _standalone_.html */
  --paper:#F1F3F2; --surface:#FBFCFC;
  --ink:#16191A; --ink-2:#3A4042; --muted:#6E7578; --faint:#9AA0A2;
  --line:#E0E3E2; --line-2:#D0D4D3;
  --accent:oklch(0.52 0.035 235); --accent-soft:oklch(0.52 0.035 235 / 0.10);
  --ok:#1f7a4d; --warn:#8a6817; --danger:#b3402f;
  --serif:"Newsreader",Georgia,serif;
  --sans:"Hanken Grotesk",system-ui,-apple-system,"Segoe UI",sans-serif;
  --mono:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,monospace;
  --maxw:1080px; --radius:6px;

  /* Back-compat aliases (old names → brand values) so existing views stay on-brand */
  --bg:var(--paper); --bg-deep:#E8ECEB;
  --ink-soft:var(--ink-2); --ink-mute:var(--muted);
  --rule:var(--line); --rule-soft:var(--line-2);
  --red:var(--accent); --red-soft:var(--accent);
  --green:var(--ok); --gold:var(--warn);
}
*{box-sizing:border-box}
body{
  background:var(--paper); color:var(--ink);
  font-family:var(--sans); font-weight:400; line-height:1.55;
  max-width:var(--maxw); margin:0 auto; padding:1.5rem;
  -webkit-font-smoothing:antialiased;
}
a{color:var(--accent); text-decoration:none}
a:hover{text-decoration:underline}

nav{
  display:flex; gap:1.1rem; align-items:center;
  border-bottom:1px solid var(--line); padding-bottom:.7rem; margin-bottom:1.5rem;
  font-family:var(--mono); font-size:12px; letter-spacing:.02em;
}
nav a{color:var(--ink-2)}
nav a:hover{color:var(--accent); text-decoration:none}
.brand{
  display:inline-flex; align-items:center; gap:7px; margin-right:.5rem;
  font-family:var(--serif); font-weight:600; font-size:15px; letter-spacing:-.01em;
  color:var(--ink);
}
.brand:hover{color:var(--ink); text-decoration:none}
.brand .logo{color:var(--accent)}
.nav-account{margin-left:auto; color:var(--muted); font-size:11px}
.nav-account a{color:var(--muted)}

h1{
  font-family:var(--serif); font-weight:400;
  font-size:clamp(26px,3.4vw,36px); line-height:1.12; letter-spacing:-.02em;
  margin:0 0 .3rem;
}
h1 em{font-style:italic; color:var(--accent); font-weight:500}
h2{font-family:var(--serif); font-weight:500; font-size:21px; margin:1.6rem 0 .8rem}
h3{font-family:var(--serif); font-weight:600; font-size:17px; margin:1rem 0 .5rem}
p{margin:0 0 .8rem; color:var(--ink-2); max-width:760px}

.muted{color:var(--muted); font-size:.85rem}
.mono{font-family:var(--mono)}

pre{
  background:var(--bg-deep); padding:1rem; border-radius:var(--radius);
  border:1px solid var(--line); overflow:auto; white-space:pre-wrap;
  font-family:var(--mono); font-size:12.5px; color:var(--ink);
}
code{font-family:var(--mono); background:var(--bg-deep); padding:1px 5px; border-radius:3px; font-size:.9em}
input,button,textarea,select{font:inherit; padding:.42rem .65rem; border:1px solid var(--line-2); background:var(--surface); color:var(--ink); border-radius:5px}
input:focus,textarea:focus,select:focus{outline:none; border-color:var(--accent); box-shadow:0 0 0 3px var(--accent-soft)}
button{cursor:pointer}
button:hover{border-color:var(--accent); color:var(--accent)}

table{border-collapse:collapse; width:100%; max-width:900px}
td,th{text-align:left; padding:.5rem .6rem; border-bottom:1px solid var(--line-2); color:var(--ink-2)}
th{font-family:var(--mono); font-size:10px; text-transform:uppercase; letter-spacing:.1em; color:var(--muted); background:var(--surface)}

/* ── Reusable panel (cards / sections) ───────────────────────────────────── */
.panel{background:var(--surface); border:1px solid var(--line); border-radius:var(--radius); padding:1rem 1.1rem; margin:0 0 1rem}
.panel h2{margin-top:0}

/* ── Dashboard chrome ─────────────────────────────────────────────────── */

.dashboard-header{margin-bottom:1.4rem}
.dashboard-sub{font-family:var(--mono); font-size:11px; letter-spacing:.04em; color:var(--muted); margin:0}

.scope-row{display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:12px; margin:1.4rem 0 1.6rem}
.scope-card{
  background:var(--surface); border:1px solid var(--line);
  padding:14px 18px; border-radius:var(--radius);
  text-decoration:none; color:inherit; display:block; transition:border-color .12s,box-shadow .12s;
}
.scope-card:hover{border-color:var(--accent); box-shadow:0 0 0 3px var(--accent-soft); text-decoration:none}
.scope-card .icon{font-size:20px; line-height:1; margin-bottom:6px}
.scope-card .name{font-family:var(--serif); font-size:15px; color:var(--ink); margin-bottom:2px}
.scope-card .count{font-family:var(--mono); font-size:11px; color:var(--muted)}

.note-row{border-top:1px solid var(--line-2); padding:16px 0}
.note-row:first-of-type{border-top:none}
.note-row .title{font-family:var(--serif); font-size:16px; color:var(--ink); margin-bottom:4px}
.note-row .title a{color:var(--ink)}
.note-row .title a:hover{color:var(--accent)}
.note-row .meta{font-family:var(--mono); font-size:11px; color:var(--muted); letter-spacing:.02em; margin-bottom:8px}
.note-row .actions{display:flex; gap:8px; flex-wrap:wrap}

.btn{
  font-family:var(--mono); font-size:11px; padding:4px 10px;
  border:1px solid var(--line-2); background:var(--surface); color:var(--ink-2);
  border-radius:5px; text-decoration:none; display:inline-block; cursor:pointer;
}
.btn:hover{border-color:var(--accent); color:var(--accent); text-decoration:none}
.btn.primary{color:var(--accent); border-color:var(--accent)}
.btn.danger{color:var(--danger); border-color:var(--danger)}
.btn.danger:hover{background:var(--danger); color:#fff}

.section-label{font-family:var(--mono); font-size:10px; text-transform:uppercase; letter-spacing:.14em; color:var(--muted); margin:1.4rem 0 .5rem}

.dashboard-footer{margin-top:2rem; padding-top:1rem; border-top:1px solid var(--line-2); display:flex; gap:12px; align-items:center; flex-wrap:wrap}
`;

// Wires any <button data-copy="ID"> to copy the text of <pre id="ID"> (friction-log #9).
// Also wires <button data-copy-text="...literal..."> for short strings like a data dir path.
const COPY_SCRIPT = `<script>
document.addEventListener('click',function(e){
  var b=e.target.closest&&e.target.closest('[data-copy],[data-copy-text]'); if(!b)return;
  var text=b.getAttribute('data-copy-text');
  if(!text){var el=document.getElementById(b.getAttribute('data-copy')); if(!el)return; text=el.textContent;}
  if(!navigator.clipboard)return;
  navigator.clipboard.writeText(text).then(function(){
    var prev=b.textContent; b.textContent='Copied'; setTimeout(function(){b.textContent=prev;},1200);
  }).catch(function(){});
});
</script>`;

// Opens the <details> targeted by the URL fragment (the note-list deep-links #edit / #move / #tag /
// #delete into the detail page) and scrolls it into view. Runs on load and on hash change.
const OPEN_TARGET_DETAILS_SCRIPT = `<script>
(function(){
  function openTarget(){
    if(!location.hash) return;
    var el; try{ el=document.querySelector(location.hash); }catch(e){ return; }
    if(!el) return;
    if(el.tagName==='DETAILS') el.open=true;
    el.scrollIntoView({block:'center'});
  }
  window.addEventListener('DOMContentLoaded',openTarget);
  window.addEventListener('hashchange',openTarget);
})();
</script>`;

/**
 * Page chrome. The nav is role-adaptive (v0.2.42):
 *   • solo (no team mode)  → brand · Memory · Settings · identity        (no auth ⇒ no Keys/Logout)
 *   • team member          → … · Keys · Logout
 *   • team admin           → adds the Team link
 * Connect + per-user Keys are reachable from Settings; the top nav stays lean.
 */
export function layout(
  title: string,
  bodyHtml: string,
  nav?: { identity?: string; isAdmin?: boolean; teamMode?: boolean },
): string {
  let navBar = "";
  if (nav?.identity) {
    const teamLink = nav.isAdmin ? `<a href="/ui/admin">Team</a>` : "";
    const account = nav.teamMode
      ? `<span class="nav-account">${escapeHtml(nav.identity)} · <a href="/ui/keys">Keys</a> · <a href="/ui/logout">Logout</a></span>`
      : `<span class="nav-account">${escapeHtml(nav.identity)}</span>`;
    navBar =
      `<nav>` +
      `<a class="brand" href="/ui/facts">${LOGOMARK}<span>Krimto</span></a>` +
      `<a href="/ui/facts">Memory</a>` +
      teamLink +
      `<a href="/ui/settings">Settings</a>` +
      account +
      `</nav>`;
  }
  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${escapeHtml(title)} · Krimto</title>` +
    `<style>${STYLE}</style></head>` +
    `<body>${navBar}${bodyHtml}${COPY_SCRIPT}${OPEN_TARGET_DETAILS_SCRIPT}</body></html>`
  );
}
