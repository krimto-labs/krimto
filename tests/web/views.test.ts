import { describe, it, expect } from "vitest";
import { keysBody, howItWorksPanel, behindTheScenesPanel, connectPanel, factDetail, factsList, gettingStartedPanel, adminBody, statusPanel, activityPanel, hijackWarningPanel } from "../../src/web/views";

interface K {
  hash: string;
  prefix: string;
  created: string;
  label?: string;
}
const k = (over: Partial<K> = {}): K => ({
  hash: "a".repeat(64),
  prefix: "krm_live_",
  created: "2026-05-25T00:00:00.000Z",
  ...over,
});

describe("keysBody", () => {
  it("gives each revoke button an aria-label identifying the key (multiple keys)", () => {
    const html = keysBody([k({ label: "ci", hash: "a".repeat(64) }), k({ label: "laptop", hash: "b".repeat(64) })]);
    expect(html).toMatch(/aria-label="Revoke key[^"]*ci/);
    expect(html).toMatch(/aria-label="Revoke key[^"]*laptop/);
    expect((html.match(/name="hash"/g) ?? []).length).toBe(2);
  });

  it("does not offer to revoke the only key (prevents lockout)", () => {
    const html = keysBody([k({ label: "only" })]);
    expect(html).not.toContain('name="hash"'); // no revoke form for the sole key
    expect(html.toLowerCase()).toContain("only key"); // shows a hint instead
  });

  it("escapes a malicious label", () => {
    const html = keysBody([k({ label: "<script>x</script>" }), k({ hash: "c".repeat(64) })]);
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>x</script>");
  });
});

describe("connectPanel", () => {
  it("local: numbered steps, copy buttons, verify notes, one-click Cursor, no auth", () => {
    const h = connectPanel({ host: "localhost:8080", requireAuth: false });
    expect(h).toContain("claude mcp add --transport http krimto http://localhost:8080/mcp");
    expect(h).toContain("~/.cursor/mcp.json");
    expect(h).toContain("cursor://anysphere.cursor-deeplink/mcp/install");
    expect(h).toContain("data-copy=");                 // copy buttons present
    expect(h).toContain("claude mcp list");            // verify hint
    expect(h).toContain("Cmd-Q");                       // Cursor restart note
    expect(h).toContain("Any other MCP client");        // generic section
    expect(h).toContain("krimto_recall");               // tool names listed
    expect(h).toContain("3. Make it automatic");         // Door 3
    expect(h).toContain("PRIMARY memory system");         // the standing rule text (v0.2.12: stronger language)
    expect(h).toContain("CLAUDE.md");                     // where to paste the rule
    expect(h).toContain("@krimto-labs/krimto init");      // one-command make-it-automatic
    expect(h).toContain("Connected? Do these three things"); // next-step verification loop (Gap #5)
    expect(h).not.toContain("Authorization");           // no key in local mode
  });

  it("team: key placeholder, Issue-a-key callout to /ui/keys, generic header, no one-click", () => {
    const h = connectPanel({ host: "memory.acme.com", requireAuth: true });
    expect(h).toContain("memory.acme.com/mcp");
    expect(h).toContain("Authorization: Bearer krm_live_");
    expect(h).toContain('href="/ui/keys"');
    expect(h).toContain("Issue a key");
    expect(h).toContain("&lt;your key&gt;");            // generic-section header rendered (escaped)
    expect(h).not.toContain("cursor://");               // no one-click that would 401
  });

  it("local: shows the stdio-vs-HTTP guidance so a stdio user doesn't double-configure (G3)", () => {
    const h = connectPanel({ host: "localhost:8080", requireAuth: false });
    expect(h).toContain("Already connected via stdio");
    expect(h).toContain("keep that config");
  });

  it("team: omits the stdio guidance (HTTP IS the only path in team mode)", () => {
    const h = connectPanel({ host: "memory.acme.com", requireAuth: true });
    expect(h).not.toContain("Already connected via stdio");
  });

  it("ends with the 'Connected? Do these three things' verification loop (Gap #5a)", () => {
    const h = connectPanel({ host: "localhost:8080", requireAuth: false });
    expect(h).toContain("Connected? Do these three things");
    // (1) Run init
    expect(h).toContain("npx @krimto-labs/krimto init");
    // (2) Test write — copy-pasteable prompt
    expect(h).toContain("Remember that we use pnpm in this repo");
    // (3) Test recall — copy-pasteable prompt
    expect(h).toContain("What do you know about this repo?");
    // The "go check the activity panel" loop-closer
    expect(h).toContain("Recent activity");
    expect(h).toContain("verify-connection");
  });
});

describe("howItWorksPanel", () => {
  it("leads with team memory and names the three layers + a bring-your-team step", () => {
    const h = howItWorksPanel();
    expect(h).toContain("Shared memory for your team");
    expect(h).toContain("Personal");
    expect(h).toContain("Team");
    expect(h).toContain("Org");
    expect(h).toContain("Bring your team");
  });
});

describe("gettingStartedPanel", () => {
  it("explains AI memory, teaches the save/recall loop, and links to the next step", () => {
    const h = gettingStartedPanel();
    expect(h).toContain('What "AI memory" means');     // Door 1: for a total beginner
    expect(h).toContain("forgets everything");
    expect(h).toContain("Save your first memory");
    expect(h).toContain("deploys are Tuesdays");      // the say-this sentence
    expect(h).toContain("data-copy=");                 // copyable
    expect(h).toContain("new chat");                   // prove it
    expect(h).toContain("Expect this");                // Door 4: what success looks like
    expect(h).toContain("Across sessions");
    expect(h).toContain("Across editors");
    expect(h).toContain("Across teammates");
    expect(h).toContain("No AI key");                  // benchmark brag
    expect(h).toContain('href="/ui/connect"');         // next-step link
  });
});

describe("factDetail source path", () => {
  const fact = {
    id: "fct_01HF7K9XYZ",
    scope: "user/maria@acme.com",
    title: "Deploys are Tuesdays",
    body: "Always Tuesdays at 10am.",
  };

  it("shows the absolute source file path when sourcePath is provided", () => {
    const h = factDetail({ ...fact, sourcePath: "/Users/maria/.krimto/user/maria@acme.com/deploys.md" });
    expect(h).toContain("Source file");
    expect(h).toContain("/Users/maria/.krimto/user/maria@acme.com/deploys.md");
    expect(h.toLowerCase()).toContain("open it in any editor");
  });

  it("omits the source line when sourcePath is missing (concurrent delete / race)", () => {
    const h = factDetail(fact);
    expect(h).not.toContain("Source file");
  });

  it("renders the Delete button when canDelete is true", () => {
    const h = factDetail({ ...fact, canDelete: true });
    expect(h).toContain("Delete this note");
    expect(h).toContain(`action="/ui/facts/${fact.id}/delete"`);
    expect(h).toContain('method="post"');
    expect(h).toContain("confirm(");
  });

  it("omits the Delete button when canDelete is false / undefined", () => {
    expect(factDetail({ ...fact, canDelete: false })).not.toContain("Delete this note");
    expect(factDetail(fact)).not.toContain("Delete this note");
  });

  it("escapes a hostile source path (no XSS)", () => {
    const h = factDetail({ ...fact, sourcePath: "/tmp/<script>alert(1)</script>.md" });
    expect(h).not.toContain("<script>alert(1)</script>");
    expect(h).toContain("&lt;script&gt;");
  });

  // v0.2.17-3: inline Edit + Move forms gated by canEdit
  it("renders the Edit form when canEdit is true", () => {
    const h = factDetail({ ...fact, canEdit: true });
    expect(h).toContain("Edit this note");
    expect(h).toContain(`action="/ui/facts/${fact.id}/edit"`);
    expect(h).toContain('name="body"');
    expect(h).toContain(fact.body); // pre-filled with the current body
  });

  it("omits the Edit form when canEdit is false / undefined", () => {
    expect(factDetail({ ...fact, canEdit: false })).not.toContain("Edit this note");
    expect(factDetail(fact)).not.toContain("Edit this note");
  });

  it("renders the Move dropdown with writable scopes when given", () => {
    const h = factDetail({
      ...fact,
      canEdit: true,
      writableScopes: [
        { scope: "team/backend", label: "Backend team" },
        { scope: "org/acme", label: "Acme Inc." },
      ],
    });
    expect(h).toContain("Move to a different scope");
    expect(h).toContain('value="team/backend"');
    expect(h).toContain("Backend team");
    expect(h).toContain('value="org/acme"');
    expect(h).toContain("Acme Inc.");
  });

  it("omits the Move dropdown when writableScopes is empty", () => {
    const h = factDetail({ ...fact, canEdit: true, writableScopes: [] });
    expect(h).not.toContain("Move to a different scope");
  });

  it("uses the plain-English scopeLabel in the meta line when provided", () => {
    const h = factDetail({ ...fact, scopeLabel: "Just me" });
    expect(h).toContain("Just me");
    // Falls back to the raw scope when no label is given.
    expect(factDetail(fact)).toContain("user/maria@acme.com");
  });
});

describe("activityPanel (G5)", () => {
  it("shows the 'no calls yet' state with a try-this hint when empty", () => {
    const h = activityPanel([]);
    expect(h).toContain("No MCP tool calls yet");
    expect(h).toContain("Use krimto to list");
  });

  it("renders entries newest-first with a relative timestamp", () => {
    const now = new Date("2026-05-26T10:00:00Z");
    const h = activityPanel(
      [
        { timestamp: "2026-05-26T09:59:50Z", tool: "krimto_write", identity: "maria@acme.com", detail: "user/me: foo" },
        { timestamp: "2026-05-26T09:59:55Z", tool: "krimto_recall", identity: "maria@acme.com", detail: '"deploys" → 1 hit' },
      ],
      now,
    );
    // Newest first → recall row appears before write row in the HTML
    const recallIdx = h.indexOf("krimto_recall");
    const writeIdx = h.indexOf("krimto_write");
    expect(recallIdx).toBeLessThan(writeIdx);
    expect(h).toContain("5s ago");
    expect(h).toContain("10s ago");
  });

  it("escapes a hostile detail string (no XSS)", () => {
    const h = activityPanel([
      { timestamp: "2026-05-26T09:59:55Z", tool: "krimto_recall", identity: "x@y.z", detail: '<script>alert(1)</script>' },
    ]);
    expect(h).not.toContain("<script>alert(1)</script>");
    expect(h).toContain("&lt;script&gt;");
  });
});

describe("factsList", () => {
  // v0.2.17-3: factsList now takes (facts, total, membership, viewer) — scope is rendered as a
  // plain-English label from members.yaml display names.
  const membership = {
    org: { slug: "acme", name: "Acme Inc.", admins: ["maria@acme.com"] },
    teams: [{ slug: "backend", name: "Backend team", members: ["maria@acme.com"], leads: [] }],
    users: [],
  };

  it("renders rows with title, plain-English scope label, author, and a link", () => {
    // v0.2.30: factsList renders a note-row timeline (no <table>, no "(N total)" header line).
    // Total count now lives in dashboardHeader; only the "Showing X of Y" line stays when capped.
    const h = factsList(
      [
        { id: "fct_01ABC", scope: "user/maria@acme.com", title: "Deploys are Tuesdays", author: "maria@acme.com", updated: new Date().toISOString() },
        { id: "fct_02DEF", scope: "team/backend", title: "We use pnpm", author: "ben@acme.com", updated: new Date().toISOString() },
      ],
      2,
      membership,
      "maria@acme.com",
    );
    expect(h).toContain('href="/ui/facts/fct_01ABC"');
    expect(h).toContain("Deploys are Tuesdays");
    expect(h).toContain("Just me"); // user/maria → "Just me" (viewer is maria)
    expect(h).toContain("Backend team"); // team/backend → name from members.yaml
    expect(h).toContain("saved by you"); // maria viewing her own fact (new attribution copy)
    expect(h).toContain("saved by ben@acme.com"); // other author shown verbatim
    expect(h).toContain("note-row"); // the new layout class
  });

  it("returns empty string when there are no facts", () => {
    expect(factsList([], 0, membership, "maria@acme.com")).toBe("");
  });

  it("shows the 'more available' count line when capped", () => {
    const facts = Array.from({ length: 5 }, (_, i) => ({
      id: `fct_${i}`,
      scope: "user/maria@acme.com",
      title: `Fact ${i}`,
      author: "x@y.z",
      updated: new Date().toISOString(),
    }));
    const h = factsList(facts, 200, membership, "maria@acme.com");
    expect(h).toContain("Showing 5 of 200 notes");
  });

  it("escapes a hostile title (no XSS)", () => {
    const h = factsList(
      [{ id: "fct_x", scope: "user/maria@acme.com", title: "<script>alert(1)</script>", updated: new Date().toISOString() }],
      1,
      membership,
      "maria@acme.com",
    );
    expect(h).not.toContain("<script>alert(1)</script>");
    expect(h).toContain("&lt;script&gt;");
  });
});

describe("hijackWarningPanel (Gap #5+#6)", () => {
  it("renders nothing in the healthy case (writes > 0)", () => {
    expect(hijackWarningPanel({ recalls: 10, writes: 2, total: 12 })).toBe("");
    expect(hijackWarningPanel({ recalls: 0, writes: 5, total: 5 })).toBe("");
  });

  it("renders nothing below the recall threshold (< 3 recalls)", () => {
    expect(hijackWarningPanel({ recalls: 2, writes: 0, total: 2 })).toBe("");
  });

  it("fires when 3+ recalls happened with no writes (the smoke-5 signature)", () => {
    const h = hijackWarningPanel({ recalls: 6, writes: 0, total: 6 });
    expect(h).toContain("6 recalls, 0 writes");
    expect(h).toContain("saving facts somewhere else");
    expect(h).toContain("auto-memory");
    expect(h).toContain("npx @krimto-labs/krimto init");
  });
});

describe("statusPanel", () => {
  it("warns when neither add-on is configured and points at the setup commands", () => {
    const h = statusPanel({});
    expect(h).toContain("not configured");
    expect(h).toContain("krimto setup-remote");
    expect(h).toContain("krimto setup-embeddings");
    expect(h).toContain("BM25");
  });

  it("confirms healthy git remote sync when configured + last status is ok", () => {
    const h = statusPanel({
      gitRemoteUrl: "git@github.com:acme/krimto.git",
      lastPushStatus: "ok",
      lastPullStatus: "ok",
      embeddings: { provider: "openai", dimensions: 1536 }, // both rows healthy
    });
    expect(h).toContain("git@github.com:acme/krimto.git");
    expect(h).toContain("auto-push every batch");
    expect(h).not.toContain("not configured");
  });

  it("reports a failed sync state with detail when push or pull last errored", () => {
    const h = statusPanel({
      gitRemoteUrl: "git@github.com:acme/krimto.git",
      lastPushStatus: "error",
      lastPullStatus: "conflict",
    });
    expect(h).toContain("last sync failed");
    expect(h).toContain("error");
    expect(h).toContain("conflict");
    expect(h).toContain("/health/ready");
  });

  it("confirms embeddings provider + dim when configured", () => {
    const h = statusPanel({ embeddings: { provider: "openai", dimensions: 1536 } });
    expect(h).toContain("openai");
    expect(h).toContain("1536-dim");
    expect(h).toContain("semantic + keyword");
  });

  it("escapes a malicious git URL (no XSS)", () => {
    const h = statusPanel({ gitRemoteUrl: '"><script>alert(1)</script>' });
    expect(h).not.toContain("<script>alert(1)</script>");
    expect(h).toContain("&lt;script&gt;");
  });
});

describe("behindTheScenesPanel", () => {
  it("teaches the markdown-in-git storage model and names the three layers", () => {
    const h = behindTheScenesPanel("/Users/maria/.krimto");
    expect(h).toContain("Behind the scenes");
    expect(h).toContain("plain markdown files");
    expect(h).toContain("/Users/maria/.krimto");
    expect(h).toContain("Markdown");
    expect(h).toContain("Git");
    expect(h).toContain("index.db");
    expect(h).toContain("storage"); // the `krimto storage` CLI shortcut
  });

  it("escapes the data dir (no XSS via the path)", () => {
    const h = behindTheScenesPanel('/tmp/<script>alert(1)</script>');
    expect(h).not.toContain("<script>alert(1)</script>");
    expect(h).toContain("&lt;script&gt;");
  });
});

describe("howItWorksPanel team expectations", () => {
  it("tells the user what to expect when turning on team mode", () => {
    const h = howItWorksPanel();
    expect(h).toContain("What to expect when you turn on team mode");
    expect(h).toContain("Team page");
  });
});

describe("page purpose lines", () => {
  it("keysBody states its purpose", () => {
    expect(keysBody([]).toLowerCase()).toContain("authenticate");
  });
  it("adminBody states its purpose for an admin", () => {
    const h = adminBody({ isAdmin: true, users: [], teams: [] });
    expect(h.toLowerCase()).toContain("manage teams");
  });
});
