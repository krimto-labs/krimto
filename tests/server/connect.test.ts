import { describe, it, expect } from "vitest";
import { connectSnippets, cursorDeeplink, genericContract, MCP_TOOL_NAMES } from "../../src/server/connect";

describe("connectSnippets", () => {
  it("builds a no-key local config", () => {
    const s = connectSnippets({ host: "localhost:8080" });
    expect(s.url).toBe("http://localhost:8080/mcp");
    expect(s.claude).toBe("claude mcp add --transport http krimto http://localhost:8080/mcp");
    expect(s.cursorJson).toContain('"url": "http://localhost:8080/mcp"');
    expect(s.cursorJson).not.toContain("Authorization");
  });

  it("includes the bearer header when a key is given", () => {
    const s = connectSnippets({ host: "localhost:8080", key: "krm_live_abc" });
    expect(s.claude).toContain('--header "Authorization: Bearer krm_live_abc"');
    expect(s.cursorJson).toContain('"Authorization": "Bearer krm_live_abc"');
  });
});

describe("cursorDeeplink", () => {
  it("base64-encodes the bare server config in the install scheme", () => {
    const link = cursorDeeplink("localhost:8080");
    expect(link.startsWith("cursor://anysphere.cursor-deeplink/mcp/install?name=krimto&config=")).toBe(true);
    const config = new URL(link).searchParams.get("config") ?? "";
    const decoded = JSON.parse(Buffer.from(config, "base64").toString("utf8"));
    expect(decoded).toEqual({ url: "http://localhost:8080/mcp" });
  });
});

describe("genericContract", () => {
  it("returns the URL and the five tool names; header only in team mode", () => {
    const local = genericContract({ host: "localhost:8080", requireAuth: false });
    expect(local.url).toBe("http://localhost:8080/mcp");
    expect(local.tools).toEqual([...MCP_TOOL_NAMES]);
    expect(local.tools).toHaveLength(5);
    expect(local.header).toBeUndefined();

    const team = genericContract({ host: "memory.acme.com", requireAuth: true });
    expect(team.header).toContain("Authorization: Bearer");
  });
});
