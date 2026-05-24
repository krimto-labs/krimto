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
