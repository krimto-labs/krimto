// HTTP transport: MCP over Streamable HTTP (stateless: a fresh transport+server per request),
// guarded by bearer auth; plus unauthenticated /health endpoints. (Gap 02, Gap 06, Gap 17)

import express, { type Express, type Request, type Response, type RequestHandler } from "express";
import type { Database as Db } from "better-sqlite3";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";

import { type ApiKeyStore } from "../access/auth";
import { type Membership } from "../access/membership";
import { type FactIndex } from "../index/factIndex";
import { buildServer } from "./index";
import { requesterFromAuth, type ToolContext } from "./tools";
import { userAgentToSource } from "./userAgent";
import { type Requester } from "../access/scope";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { healthLive, healthReady, sqliteHealth, indexHealth, gitRemoteCheck, gitSyncCheck } from "./health";
import { KrimtoTokenVerifier } from "./tokenVerifier";
import { type RateLimiter } from "./ratelimit";
import { buildWebRouter } from "../web/router";
import { type StatusPanelOpts } from "../web/views";
import { sessionConfigFromEnv } from "../web/session";
import { buildAdminRouter, type AdminContext } from "./admin";

export interface HttpAppDeps {
  ctx: ToolContext;
  keys: ApiKeyStore;
  membership: () => Membership;
  db: Db;
  index: FactIndex;
  version: string;
  startedAt: number;
  isBuilding: () => boolean;
  gitRemoteStatus: () => "ok" | "skipped" | "error" | "none";
  /** Optional inbound-pull status for /health/ready observability (BUG-3). */
  gitSyncStatus?: () => "ok" | "skipped" | "up-to-date" | "conflict" | "error" | "none";
  /** When set, per-identity rate limiting is enforced on /mcp. */
  rateLimiter?: RateLimiter;
  /** When set, mounts the admin-only membership/key API at /admin and enables /ui/admin. */
  admin?: AdminContext;
  /**
   * Live predicate for team mode (auth on /mcp + /ui login + /admin). Evaluated PER REQUEST, not
   * captured once — so when `members.yaml` gains an admin the running server flips to team mode
   * without a restart. True ⇒ enforce auth; false ⇒ local/solo mode (no auth).
   */
  teamModeActive: () => boolean;
  /** Live status snapshot for the /ui dashboard status panel. */
  status?: () => StatusPanelOpts;
  /** Called once, on the first request to /mcp (any verb). Powers the "🟢 client connected" boot hint. */
  onFirstClient?: () => void;
}

export function buildHttpApp(deps: HttpAppDeps): Express {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  app.get("/health/live", (_req: Request, res: Response) => {
    res.json(healthLive(deps.version, (Date.now() - deps.startedAt) / 1000));
  });
  app.get("/health/ready", (_req: Request, res: Response) => {
    const ready = healthReady(deps.version, {
      sqlite: sqliteHealth(deps.db),
      index: indexHealth(deps.index, deps.isBuilding()),
      git_remote: gitRemoteCheck(deps.gitRemoteStatus()),
      ...(deps.gitSyncStatus ? { git_sync: gitSyncCheck(deps.gitSyncStatus()) } : {}),
    });
    res.status(ready.http).json(ready.body);
  });

  app.get("/", (_req: Request, res: Response) => {
    res.redirect("/ui");
  });

  const auth = requireBearerAuth({ verifier: new KrimtoTokenVerifier(deps.keys, deps.membership) });
  let firstClientFired = false;
  const handleMcp = async (req: Request, res: Response): Promise<void> => {
    // Gap #5c — fire the "client connected" hook on the FIRST /mcp request (any verb), so a user
    // running `serve` sees one stderr line confirming the agent attached. Per-process, single-shot.
    if (!firstClientFired) {
      firstClientFired = true;
      try {
        deps.onFirstClient?.();
      } catch {
        /* the hook is observational — never let it break a tool call */
      }
    }
    // v0.2.31 — editor attribution from User-Agent. Captured BEFORE the resolver closes over
    // it because each /mcp request gets a fresh `mcp` server and the resolver runs per tool
    // call. The resolver enriches the Requester with `source` so krimtoWrite can stamp facts
    // with "cursor" / "claude-code" / etc. when the caller didn't pass `source` explicitly.
    const source = userAgentToSource(req.get("User-Agent"));
    const baseResolver = deps.teamModeActive()
      ? (extra: { authInfo?: AuthInfo }) => requesterFromAuth(extra.authInfo)
      : (() => deps.ctx.requester) as (extra: { authInfo?: AuthInfo }) => Requester;
    const resolver: (extra: { authInfo?: AuthInfo }) => Requester = source
      ? (extra) => ({ ...baseResolver(extra), source })
      : baseResolver;
    const mcp = buildServer(deps.ctx, resolver);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void mcp.close();
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, req.body as unknown);
  };
  const limiter = deps.rateLimiter;
  const rateLimit = (req: Request, res: Response, next: () => void): void => {
    if (!limiter) {
      next();
      return;
    }
    const result = limiter.check(req.auth?.clientId ?? "anonymous"); // req.auth set by requireBearerAuth
    res.set(limiter.headers(result));
    if (!result.allowed) {
      if (result.retryAfter !== undefined) res.set("Retry-After", String(result.retryAfter));
      res.status(429).json({ error: { code: "rate_limited", message: "rate limit exceeded" } });
      return;
    }
    next();
  };
  // Per-request gate: run bearer auth only when team mode is active right now. In solo mode the
  // request falls straight through to rateLimit + handler (req.auth stays unset; rateLimit keys
  // on "anonymous"). Mounted always so a live flip to team mode takes effect with no rebuild.
  const maybeAuth: RequestHandler = (req, res, next) => {
    if (deps.teamModeActive()) {
      auth(req, res, next);
    } else {
      next();
    }
  };
  app.post("/mcp", maybeAuth, rateLimit, (req, res) => {
    void handleMcp(req, res);
  });
  app.get("/mcp", maybeAuth, rateLimit, (req, res) => {
    void handleMcp(req, res);
  });

  // /admin is mounted whenever an admin context exists, but each request is gated on live team
  // mode: in solo mode it 404s (invisible), in team mode it requires the admin bearer key.
  if (deps.admin) {
    app.use(
      "/admin",
      (req, res, next) => {
        if (deps.teamModeActive()) {
          auth(req, res, next);
        } else {
          res.sendStatus(404);
        }
      },
      buildAdminRouter(deps.admin),
    );
  }

  app.use(
    "/ui",
    buildWebRouter({
      ctx: deps.ctx,
      keys: deps.keys,
      membership: deps.membership,
      sessionSecret: sessionConfigFromEnv().secret,
      admin: deps.admin,
      teamModeActive: deps.teamModeActive,
      localIdentity: deps.ctx.requester.identity,
      status: deps.status,
    }),
  );

  return app;
}
