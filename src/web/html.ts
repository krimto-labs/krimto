// Server-rendered HTML chrome for the /ui surface. Pure functions; all caller-supplied text
// MUST be escaped via escapeHtml before insertion.
//
// v0.2.30 — visual redesign matching docs/krimto-v0.2.17-maria-journey.html §04 ("Door 2 —
// She Looks At Her Notes"). The page used to be a generic-blue-link engineering dashboard;
// now it's a warm-paper notes app. Same router, same access checks, same data shape —
// only the chrome changed.

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Fraunces (serif headlines) + JetBrains Mono (terminal-y tech bits) via Google Fonts CDN.
// system-ui fallback in every font stack so the page renders fine if the CDN is unreachable.
const FONTS_LINK =
  `<link rel="preconnect" href="https://fonts.googleapis.com">` +
  `<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>` +
  `<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,300..600&family=JetBrains+Mono:wght@400;500&family=Inter+Tight:wght@400;500;600&display=swap" rel="stylesheet">`;

const STYLE = `
:root{
  --bg:#f1ede4; --bg-deep:#e8e3d6; --paper:#f7f3eb;
  --ink:#14110d; --ink-soft:#4a4338; --ink-mute:#7a6f5e;
  --rule:#c8bea9; --rule-soft:#d9d0bc;
  --red:#a82c1c; --red-soft:#c44a3a;
  --green:#3d5a3d; --gold:#8a6817;
}
*{box-sizing:border-box}
body{
  background:var(--bg); color:var(--ink);
  font-family:'Inter Tight',system-ui,sans-serif;
  font-weight:400; line-height:1.5;
  max-width:1100px; margin:0 auto; padding:1.5rem;
  -webkit-font-smoothing:antialiased;
}
a{color:var(--red); text-decoration:none}
a:hover{text-decoration:underline}

nav{
  display:flex; gap:1.2rem; align-items:center;
  border-bottom:1px solid var(--rule); padding-bottom:.6rem; margin-bottom:1.4rem;
  font-family:'JetBrains Mono',ui-monospace,monospace;
  font-size:12px; letter-spacing:.04em;
}
nav a{color:var(--ink-soft)}
nav a:hover{color:var(--red)}

h1{
  font-family:'Fraunces',Georgia,serif; font-weight:300;
  font-size:clamp(28px,4vw,40px); line-height:1.1; letter-spacing:-.02em;
  margin:0 0 .25rem; font-variation-settings:"opsz" 96;
}
h1 em{font-style:italic; color:var(--red); font-weight:400}
h2{font-family:'Fraunces',Georgia,serif; font-weight:400; font-size:22px; margin:1.6rem 0 .8rem; font-variation-settings:"opsz" 48}
h3{font-family:'Fraunces',Georgia,serif; font-weight:500; font-size:18px; margin:1rem 0 .5rem}
p{margin:0 0 .8rem; color:var(--ink-soft); max-width:780px}

.muted{color:var(--ink-mute); font-size:.85rem}
.mono{font-family:'JetBrains Mono',ui-monospace,monospace}

pre{
  background:var(--bg-deep); padding:1rem; border-radius:3px;
  border:1px solid var(--rule); overflow:auto; white-space:pre-wrap;
  font-family:'JetBrains Mono',ui-monospace,monospace; font-size:12.5px;
}
code{font-family:'JetBrains Mono',ui-monospace,monospace; background:var(--bg-deep); padding:1px 5px; border-radius:2px; font-size:.9em}
input,button,textarea,select{font:inherit; padding:.4rem .65rem; border:1px solid var(--rule); background:var(--paper); color:var(--ink); border-radius:3px}
button{cursor:pointer}
button:hover{border-color:var(--red); color:var(--red)}

table{border-collapse:collapse; width:100%; max-width:900px}
td,th{text-align:left; padding:.5rem .6rem; border-bottom:1px solid var(--rule-soft); color:var(--ink-soft)}
th{font-family:'JetBrains Mono',ui-monospace,monospace; font-size:10px; text-transform:uppercase; letter-spacing:.1em; color:var(--ink-mute); background:var(--bg-deep)}

/* ── Dashboard chrome ─────────────────────────────────────────────────── */

.dashboard-header{margin-bottom:1.5rem}
.dashboard-sub{
  font-family:'JetBrains Mono',ui-monospace,monospace;
  font-size:11px; letter-spacing:.05em;
  color:var(--ink-mute); margin:0;
}

.scope-row{
  display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr));
  gap:12px; margin:1.4rem 0 1.6rem;
}
.scope-card{
  background:var(--paper); border:1px solid var(--rule);
  padding:14px 18px; border-radius:3px;
  text-decoration:none; color:inherit; display:block;
  transition:border-color .12s;
}
.scope-card:hover{border-color:var(--red); text-decoration:none}
.scope-card .icon{font-size:20px; line-height:1; margin-bottom:6px}
.scope-card .name{font-family:'Fraunces',Georgia,serif; font-size:15px; color:var(--ink); margin-bottom:2px}
.scope-card .count{font-family:'JetBrains Mono',ui-monospace,monospace; font-size:11px; color:var(--ink-mute)}

.note-row{
  border-top:1px solid var(--rule-soft); padding:16px 0;
}
.note-row:first-of-type{border-top:none}
.note-row .title{
  font-family:'Fraunces',Georgia,serif; font-size:16px;
  color:var(--ink); margin-bottom:4px;
}
.note-row .title a{color:var(--ink)}
.note-row .title a:hover{color:var(--red)}
.note-row .meta{
  font-family:'JetBrains Mono',ui-monospace,monospace;
  font-size:11px; color:var(--ink-mute); letter-spacing:.02em;
  margin-bottom:8px;
}
.note-row .actions{display:flex; gap:8px; flex-wrap:wrap}

.btn{
  font-family:'JetBrains Mono',ui-monospace,monospace;
  font-size:11px; padding:4px 10px;
  border:1px solid var(--rule); background:var(--paper); color:var(--ink-soft);
  border-radius:3px; text-decoration:none; display:inline-block; cursor:pointer;
}
.btn:hover{border-color:var(--red); color:var(--red); text-decoration:none}
.btn.primary{color:var(--red); border-color:var(--red)}

.section-label{
  font-family:'JetBrains Mono',ui-monospace,monospace;
  font-size:10px; text-transform:uppercase; letter-spacing:.14em;
  color:var(--ink-mute); margin:1.4rem 0 .5rem;
}

.dashboard-footer{
  margin-top:2rem; padding-top:1rem;
  border-top:1px solid var(--rule-soft);
  display:flex; gap:12px; align-items:center; flex-wrap:wrap;
}
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

export function layout(title: string, bodyHtml: string, nav?: { identity?: string; isAdmin?: boolean }): string {
  const navBar = nav?.identity
    ? `<nav><a href="/ui/facts">Memory</a><a href="/ui/connect">Connect</a>` +
      `<a href="/ui/keys">Keys</a><a href="/ui/settings">Settings</a>` +
      (nav.isAdmin ? `<a href="/ui/admin">Team</a>` : "") +
      `<span class="muted" style="margin-left:auto">${escapeHtml(nav.identity)} · <a href="/ui/logout">Logout</a></span></nav>`
    : "";
  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${escapeHtml(title)} · Krimto</title>` +
    FONTS_LINK +
    `<style>${STYLE}</style></head>` +
    `<body>${navBar}${bodyHtml}${COPY_SCRIPT}</body></html>`
  );
}
