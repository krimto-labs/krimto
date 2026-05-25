// Builds copy-paste connect instructions for MCP clients. One source of truth for the startup banner
// and the /ui/connect panel so they never drift. `host` is "host:port" (e.g. localhost:8080).
export interface ConnectOpts {
  host: string;
  key?: string;
}

export function connectSnippets(opts: ConnectOpts): { url: string; claude: string; cursorJson: string } {
  const url = `http://${opts.host}/mcp`;
  const claude =
    `claude mcp add --transport http krimto ${url}` +
    (opts.key ? ` --header "Authorization: Bearer ${opts.key}"` : "");
  const server: Record<string, unknown> = { url };
  if (opts.key) server.headers = { Authorization: `Bearer ${opts.key}` };
  const cursorJson = JSON.stringify({ mcpServers: { krimto: server } }, null, 2);
  return { url, claude, cursorJson };
}

// One-click "Add to Cursor" deeplink. Cursor expects the BARE server-config object, base64-encoded
// (verified against Cursor's MCP install-links docs); for our HTTP transport that's `{ url }`.
export function cursorDeeplink(host: string): string {
  const config = Buffer.from(JSON.stringify({ url: `http://${host}/mcp` }), "utf8").toString("base64");
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=krimto&config=${config}`;
}

/** The five MCP tools Krimto exposes (kept in lockstep with src/server/index.ts registrations). */
export const MCP_TOOL_NAMES = [
  "krimto_write",
  "krimto_recall",
  "krimto_read",
  "krimto_supersede",
  "krimto_list_scopes",
] as const;

/** The transport-level contract for wiring up any MCP client we haven't shipped a verified snippet for. */
export function genericContract(opts: { host: string; requireAuth: boolean }): {
  url: string;
  tools: readonly string[];
  header?: string;
} {
  return {
    url: `http://${opts.host}/mcp`,
    tools: MCP_TOOL_NAMES,
    header: opts.requireAuth ? "Authorization: Bearer <your key>" : undefined,
  };
}
