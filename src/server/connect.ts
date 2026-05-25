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
