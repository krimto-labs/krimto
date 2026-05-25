import { describe, it, expect } from "vitest";
import { escapeHtml, layout } from "../../src/web/html";

describe("escapeHtml", () => {
  it("escapes all five special characters", () => {
    expect(escapeHtml(`<a href="x" o='y'>&`)).toBe("&lt;a href=&quot;x&quot; o=&#39;y&#39;&gt;&amp;");
  });
});

describe("layout", () => {
  it("includes the escaped title and raw body, with nav when identity is present", () => {
    const html = layout("T<>", "<p>hi</p>", { identity: "a@x.com" });
    expect(html).toContain("T&lt;&gt;");
    expect(html).toContain("<p>hi</p>");
    expect(html).toContain("/ui/logout");
    expect(html).toContain("a@x.com");
  });
  it("omits nav when there is no identity", () => {
    expect(layout("T", "<p>x</p>")).not.toContain("/ui/logout");
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

describe("layout nav labels", () => {
  it("uses plain labels and shows Team only for admins", () => {
    const member = layout("T", "x", { identity: "a@acme.com" });
    expect(member).toContain(">Memory<");
    expect(member).toContain("/ui/connect");
    expect(member).not.toContain(">Team<");

    const admin = layout("T", "x", { identity: "a@acme.com", isAdmin: true });
    expect(admin).toContain('href="/ui/admin">Team<');
  });
});
