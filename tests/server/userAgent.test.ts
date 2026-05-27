// v0.2.31 — User-Agent → source slug mapping for the HTTP MCP handler. Used so the dashboard
// can render "saved from a Cursor chat" without callers passing `source` explicitly.

import { describe, expect, it } from "vitest";
import { userAgentToSource } from "../../src/server/userAgent";

describe("userAgentToSource", () => {
  it("recognises Cursor", () => {
    expect(userAgentToSource("Cursor/0.42.3")).toBe("cursor");
    expect(userAgentToSource("MyApp Cursor/1.x extra")).toBe("cursor");
  });

  it("recognises Claude Code (the dash form wins over the generic 'claude' prefix)", () => {
    expect(userAgentToSource("claude-code/1.0.5")).toBe("claude-code");
    expect(userAgentToSource("Claude-Code/2.x")).toBe("claude-code");
  });

  it("recognises Codex", () => {
    expect(userAgentToSource("codex/0.43.0")).toBe("codex");
    expect(userAgentToSource("Codex CLI 1.0")).toBe("codex");
  });

  it("recognises Gemini CLI", () => {
    expect(userAgentToSource("gemini-cli/0.43.0")).toBe("gemini");
    expect(userAgentToSource("Gemini/1.0")).toBe("gemini");
  });

  it("returns undefined for absent or unknown UAs", () => {
    expect(userAgentToSource(undefined)).toBeUndefined();
    expect(userAgentToSource(null)).toBeUndefined();
    expect(userAgentToSource("")).toBeUndefined();
    expect(userAgentToSource("node-fetch/3.0")).toBeUndefined();
    expect(userAgentToSource("Mozilla/5.0")).toBeUndefined();
  });

  it("is case-insensitive", () => {
    expect(userAgentToSource("CURSOR/1.0")).toBe("cursor");
    expect(userAgentToSource("cursor/1.0")).toBe("cursor");
    expect(userAgentToSource("Cursor/1.0")).toBe("cursor");
  });
});
