// Builds copy-paste connect instructions for MCP clients. One source of truth for the startup banner
// and the /ui/connect panel so they never drift. `host` is "host:port" (e.g. localhost:8080).
export interface ConnectOpts {
  host: string;
  key?: string;
}

/** Structured Krimto entry for an MCP client config file (stdio variant — `npx`-launched). */
export interface StdioMcpEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/** Structured Krimto entry for an MCP client config file (HTTP variant — talks to a running server). */
export interface HttpMcpEntry {
  url: string;
  headers?: Record<string, string>;
}

/** Discriminated union covering both transports. Consumers narrow on the presence of `url`. */
export type KrimtoMcpEntry =
  | ({ transport: "stdio" } & StdioMcpEntry)
  | ({ transport: "http" } & HttpMcpEntry);

/**
 * Build the structured stdio entry. Single source of truth for what a Krimto MCP server entry
 * looks like — both `stdioConnectSnippets` (which renders it as a snippet) and the wizard's
 * `writeMcpConfig` (which writes it into an editor's config file) consume this.
 */
export function stdioMcpEntry(opts: { identity?: string } = {}): StdioMcpEntry {
  const identity = opts.identity ?? "you@acme.com";
  return {
    command: "npx",
    args: ["-y", "@krimto-labs/krimto"],
    env: { KRIMTO_IDENTITY: identity },
  };
}

/** Build the structured HTTP entry. Mirrors {@link stdioMcpEntry} for HTTP-transport setups. */
export function httpMcpEntry(opts: ConnectOpts): HttpMcpEntry {
  const entry: HttpMcpEntry = { url: `http://${opts.host}/mcp` };
  if (opts.key) entry.headers = { Authorization: `Bearer ${opts.key}` };
  return entry;
}

export function connectSnippets(opts: ConnectOpts): { url: string; claude: string; cursorJson: string } {
  const entry = httpMcpEntry(opts);
  const claude =
    `claude mcp add --transport http krimto ${entry.url}` +
    (opts.key ? ` --header "Authorization: Bearer ${opts.key}"` : "");
  const cursorJson = JSON.stringify({ mcpServers: { krimto: entry } }, null, 2);
  return { url: entry.url, claude, cursorJson };
}

/**
 * Stdio (solo, no HTTP) connect snippets — the npx on-ramp shape. Returned as one object so the
 * `krimto connect` CLI and any future surface can't drift on what we tell users to paste.
 */
export function stdioConnectSnippets(opts: { identity?: string } = {}): {
  claude: string;
  cursorJson: string;
} {
  const entry = stdioMcpEntry(opts);
  const claude = "claude mcp add krimto -- npx -y @krimto-labs/krimto";
  const cursorJson = JSON.stringify({ mcpServers: { krimto: entry } }, null, 2);
  return { claude, cursorJson };
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
