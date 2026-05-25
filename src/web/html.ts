// Minimal server-rendered HTML chrome for the /ui surface. Pure functions; all
// caller-supplied text MUST be escaped via escapeHtml before insertion.

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const STYLE = `body{font-family:system-ui,sans-serif;max-width:820px;margin:2rem auto;padding:0 1rem;color:#1a1a1a}
a{color:#2563eb;text-decoration:none}a:hover{text-decoration:underline}
nav{display:flex;gap:1rem;align-items:center;border-bottom:1px solid #ddd;padding-bottom:.5rem;margin-bottom:1rem}
.muted{color:#666;font-size:.85rem}pre{background:#f5f5f5;padding:1rem;border-radius:6px;overflow:auto;white-space:pre-wrap}
input,button{font:inherit;padding:.4rem .6rem}table{border-collapse:collapse;width:100%}td,th{text-align:left;padding:.4rem;border-bottom:1px solid #eee}`;

// Wires any <button data-copy="ID"> to copy the text of <pre id="ID"> (friction-log #9).
// Static markup — no user input — so no escaping is needed here.
const COPY_SCRIPT = `<script>
document.addEventListener('click',function(e){
  var b=e.target.closest&&e.target.closest('[data-copy]'); if(!b)return;
  var el=document.getElementById(b.getAttribute('data-copy')); if(!el)return;
  navigator.clipboard.writeText(el.innerText).then(function(){
    var prev=b.textContent; b.textContent='Copied'; setTimeout(function(){b.textContent=prev;},1200);
  });
});
</script>`;

export function layout(title: string, bodyHtml: string, nav?: { identity?: string }): string {
  const navBar = nav?.identity
    ? `<nav><a href="/ui/facts">Facts</a><a href="/ui/connect">Connect</a><a href="/ui/keys">Keys</a>` +
      `<span class="muted" style="margin-left:auto">${escapeHtml(nav.identity)} · <a href="/ui/logout">Logout</a></span></nav>`
    : "";
  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${escapeHtml(title)} · Krimto</title><style>${STYLE}</style></head>` +
    `<body>${navBar}${bodyHtml}${COPY_SCRIPT}</body></html>`
  );
}
