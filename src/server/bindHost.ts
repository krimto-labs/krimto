// Resolves the TCP host the HTTP server binds to (Gap C1 — network exposure).
//
// Default is loopback (127.0.0.1): the server is then reachable only from this machine, which is
// the solo-mode trust boundary. KRIMTO_HTTP_HOST can override it, but binding a non-loopback
// interface while auth is OFF (solo mode) would expose the whole memory to the network with no
// key — so we refuse that combination unless the operator explicitly opts in with
// KRIMTO_ALLOW_INSECURE_HOST=1. Team mode (auth on) may bind any host.

export const DEFAULT_BIND_HOST = "127.0.0.1";

/** True for hosts reachable only from the local machine. */
export function isLoopbackHost(host: string): boolean {
  // Accept the bracketed IPv6 form (e.g. "[::1]") that Node/operators may use.
  const h = host.trim().toLowerCase().replace(/^\[(.+)\]$/, "$1");
  return (
    h === "localhost" ||
    h === "::1" ||
    h === "::ffff:127.0.0.1" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)
  );
}

export function resolveBindHost(env: NodeJS.ProcessEnv, opts: { authOn: boolean }): string {
  const requested = env.KRIMTO_HTTP_HOST?.trim();
  if (!requested) return DEFAULT_BIND_HOST;
  if (isLoopbackHost(requested)) return requested;
  if (opts.authOn || env.KRIMTO_ALLOW_INSECURE_HOST === "1") return requested;
  throw new Error(
    `Refusing to bind Krimto to "${requested}": that exposes the server to the network, but auth ` +
      `is off (solo mode), so anyone who can reach it could read or write your memory with no key. ` +
      `Run in team mode (add an admin to members.yaml or set KRIMTO_REQUIRE_AUTH=1), bind a loopback ` +
      `host, or set KRIMTO_ALLOW_INSECURE_HOST=1 if you have your own network controls in place.`,
  );
}
