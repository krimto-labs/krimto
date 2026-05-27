// v0.2.30 — dashboard renderers (`/ui/facts` chrome). These functions emit the warm-paper
// notes-app HTML the Maria-journey doc §04 specifies. Tests assert the structural pieces a
// human reviewer would scroll for: scope cards with the right emoji per kind, note rows with
// the right source attribution, action gating that respects authorship, and the footer's
// copy-button data attribute.

import { describe, expect, it } from "vitest";

import {
  dashboardHeader,
  dashboardFooter,
  factsList,
  scopeList,
  type FactListRow,
  type ScopeRow,
} from "../../src/web/views";
import { type Membership } from "../../src/access/membership";

const membership: Membership = {
  org: { slug: "acme", name: "Acme", admins: ["maria@acme.com"] },
  teams: [
    { slug: "backend", name: "Backend team", members: ["maria@acme.com", "ben@acme.com"], leads: [] },
  ],
  users: [],
};

describe("dashboardHeader", () => {
  it("renders the viewer's identity in the title and the totals + sync subtitle", () => {
    const html = dashboardHeader("maria@acme.com", 15, "8s ago");
    expect(html).toContain("Krimto");
    expect(html).toContain("maria@acme.com");
    expect(html).toContain("15 notes");
    expect(html).toContain("synced 8s ago");
  });

  it("omits the sync clause when no timestamp is known yet (fresh install)", () => {
    const html = dashboardHeader("maria@acme.com", 0, null);
    expect(html).toContain("0 notes");
    expect(html).not.toContain("synced");
  });

  it("escapes the identity (no HTML injection via display name)", () => {
    const html = dashboardHeader('<script>x</script>@acme.com', 1, null);
    expect(html).not.toContain("<script>x</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("scopeList — scope cards", () => {
  it("renders one card per scope with the right emoji icon per kind", () => {
    const scopes: ScopeRow[] = [
      { scope: "user/maria@acme.com", factCount: 12 },
      { scope: "team/backend", factCount: 3 },
      { scope: "org/acme", factCount: 0 },
    ];
    const html = scopeList(scopes, membership, "maria@acme.com");
    expect(html).toContain("📔"); // user/* — "Just me" for the viewer
    expect(html).toContain("📓"); // team/*
    expect(html).toContain("🏢"); // org/*
    expect(html).toContain("Just me");
    expect(html).toContain("Backend team");
    expect(html).toContain("Acme");
    expect(html).toContain("12 notes");
    expect(html).toContain("3 notes");
    expect(html).toContain("0 notes");
  });

  it("uses singular 'note' when count is 1", () => {
    const html = scopeList([{ scope: "user/maria@acme.com", factCount: 1 }], membership, "maria@acme.com");
    expect(html).toContain("1 note<");
    expect(html).not.toContain("1 notes");
  });

  it("wraps N cards in a grid (multi-team users not hidden — user choice)", () => {
    const extraMembership: Membership = {
      ...membership,
      teams: [
        ...membership.teams,
        { slug: "infra", name: "Infra", members: ["maria@acme.com"], leads: [] },
      ],
    };
    const html = scopeList(
      [
        { scope: "user/maria@acme.com", factCount: 1 },
        { scope: "team/backend", factCount: 1 },
        { scope: "team/infra", factCount: 1 },
        { scope: "org/acme", factCount: 1 },
      ],
      extraMembership,
      "maria@acme.com",
    );
    // All four scope cards render — no collapsing.
    expect(html).toContain("Backend team");
    expect(html).toContain("Infra");
    expect(html.match(/scope-card/g)?.length).toBe(4);
  });

  it("returns an explicit empty-state when no scopes exist", () => {
    expect(scopeList([], membership, "maria@acme.com")).toContain("No readable scopes");
  });
});

describe("factsList — notes timeline", () => {
  const baseRow = (overrides: Partial<FactListRow> = {}): FactListRow => ({
    id: "fct_01",
    scope: "user/maria@acme.com",
    title: "Staging resets every Sunday",
    author: "maria@acme.com",
    updated: new Date(Date.now() - 60_000).toISOString(),
    source: null,
    ...overrides,
  });

  it("renders a Fraunces title + meta line per note (no <table>)", () => {
    const html = factsList([baseRow()], 1, membership, "maria@acme.com");
    expect(html).toContain("note-row");
    expect(html).toContain("Staging resets every Sunday");
    expect(html).not.toContain("<table>");
  });

  it("renders 'saved from a Cursor chat' when frontmatter.source = 'cursor'", () => {
    const html = factsList([baseRow({ source: "cursor" })], 1, membership, "maria@acme.com");
    expect(html).toContain("saved from a Cursor chat");
  });

  it("renders 'saved by you' when author matches viewer and no source is set", () => {
    const html = factsList([baseRow({ source: null })], 1, membership, "maria@acme.com");
    expect(html).toContain("saved by you");
  });

  it("renders 'saved by <author>' when the fact is someone else's and no source is set", () => {
    const html = factsList([baseRow({ author: "ben@acme.com", source: null })], 1, membership, "maria@acme.com");
    expect(html).toContain("saved by ben@acme.com");
  });

  it("shows Edit/Move/Delete/View file action buttons for the viewer's own notes", () => {
    const html = factsList([baseRow()], 1, membership, "maria@acme.com");
    expect(html).toContain(">Edit<");
    expect(html).toContain(">Move<");
    expect(html).toContain(">Delete<");
    expect(html).toContain(">View file<");
  });

  it("hides write actions for notes the viewer didn't author (only View / View file)", () => {
    const html = factsList(
      [baseRow({ author: "ben@acme.com" })],
      1,
      membership,
      "maria@acme.com",
    );
    expect(html).toContain(">View<");
    expect(html).toContain(">View file<");
    expect(html).not.toContain(">Edit<");
    expect(html).not.toContain(">Delete<");
  });

  it("plain-English scope label appears in the meta line ('Just me', team name)", () => {
    const html = factsList(
      [
        baseRow({ id: "fct_01", scope: "user/maria@acme.com" }),
        baseRow({ id: "fct_02", scope: "team/backend", title: "Stripe webhook signing" }),
      ],
      2,
      membership,
      "maria@acme.com",
    );
    expect(html).toContain("Just me");
    expect(html).toContain("Backend team");
  });

  it("emits the 'showing X of Y' line when more notes exist than rendered", () => {
    const html = factsList([baseRow()], 50, membership, "maria@acme.com");
    expect(html).toContain("Showing 1 of 50 notes");
  });

  it("returns empty string when there are no notes (header takes over the empty state)", () => {
    expect(factsList([], 0, membership, "maria@acme.com")).toBe("");
  });
});

describe("dashboardFooter", () => {
  it("emits a copy-button wired to the data dir path via data-copy-text", () => {
    const html = dashboardFooter("/Users/maria/.krimto");
    expect(html).toContain('data-copy-text="/Users/maria/.krimto"');
    expect(html).toContain("📂");
    expect(html).toContain("Copy notes folder path");
  });

  it("links to /ui/settings", () => {
    const html = dashboardFooter("/x");
    expect(html).toContain('href="/ui/settings"');
    expect(html).toContain("⚙");
  });

  it("escapes the data-dir path (no attribute injection)", () => {
    const html = dashboardFooter('"; alert(1); //');
    expect(html).not.toContain('"; alert(1)');
    expect(html).toContain("&quot;");
  });
});
