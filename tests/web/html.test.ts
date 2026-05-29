import { describe, it, expect } from "vitest";
import { escapeHtml, layout } from "../../src/web/html";

describe("escapeHtml", () => {
  it("escapes all five special characters", () => {
    expect(escapeHtml(`<a href="x" o='y'>&`)).toBe("&lt;a href=&quot;x&quot; o=&#39;y&#39;&gt;&amp;");
  });
});

describe("layout", () => {
  it("includes the escaped title and raw body", () => {
    const html = layout("T<>", "<p>hi</p>", { identity: "a@x.com" });
    expect(html).toContain("T&lt;&gt;");
    expect(html).toContain("<p>hi</p>");
    expect(html).toContain("a@x.com");
  });
  it("omits nav when there is no identity", () => {
    const html = layout("T", "<p>x</p>");
    expect(html).not.toContain("/ui/logout");
    expect(html).not.toContain(">Memory<");
  });
});

describe("layout — brand", () => {
  it("applies brand tokens + the rising-stroke logomark, with no webfont CDN", () => {
    const html = layout("T", "x", { identity: "a@x.com" });
    expect(html).toContain("#F1F3F2"); // brand paper background
    expect(html).toContain("--accent"); // slate accent token
    expect(html).toContain("<svg"); // inline logomark
    expect(html).not.toContain("fonts.googleapis.com"); // no Google Fonts CDN
    expect(html).not.toContain("Fraunces"); // old warm-paper serif removed
  });
});

describe("layout — role-adaptive nav", () => {
  it("solo: Memory + Settings, no Team, no Keys/Logout (no auth)", () => {
    const solo = layout("T", "x", { identity: "me@local" });
    expect(solo).toContain(">Memory<");
    expect(solo).toContain('<a href="/ui/settings">Settings</a>');
    expect(solo).not.toContain(">Team<");
    expect(solo).not.toContain("/ui/logout");
    expect(solo).not.toContain("/ui/keys");
  });
  it("team member: adds Keys + Logout, still no Team", () => {
    const member = layout("T", "x", { identity: "a@acme.com", teamMode: true });
    expect(member).toContain(">Memory<");
    expect(member).toContain('<a href="/ui/settings">Settings</a>');
    expect(member).toContain("/ui/keys");
    expect(member).toContain("/ui/logout");
    expect(member).not.toContain(">Team<");
  });
  it("team admin: shows the Team link", () => {
    const admin = layout("T", "x", { identity: "a@acme.com", isAdmin: true, teamMode: true });
    expect(admin).toContain('href="/ui/admin">Team<');
  });
});

describe("layout copy-button support", () => {
  it("embeds a copy script that reads data-copy targets", () => {
    const html = layout("T", "<pre id='x'>hi</pre><button data-copy='x'>Copy</button>");
    expect(html).toContain("data-copy");
    expect(html).toContain("navigator.clipboard");
    expect(html).toContain("getElementById");
  });
});
