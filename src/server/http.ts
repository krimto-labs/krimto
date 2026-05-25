// HTTP transport: MCP over Streamable HTTP (stateless: a fresh transport+server per request),
// guarded by bearer auth; plus unauthenticated /health endpoints. (Gap 02, Gap 06, Gap 17)

import express, { type Express, type Request, type Response } from "express";
import type { Database as Db } from "better-sqlite3";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";

import { type ApiKeyStore } from "../access/auth";
import { type Membership } from "../access/membership";
import { type FactIndex } from "../index/factIndex";
import { buildServer } from "./index";
import { requesterFromAuth, type ToolContext } from "./tools";
import { healthLive, healthReady, sqliteHealth, indexHealth, gitRemoteCheck, gitSyncCheck } from "./health";
import { KrimtoTokenVerifier } from "./tokenVerifier";
import { type RateLimiter } from "./ratelimit";
import { buildWebRouter } from "../web/router";
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

  const auth = requireBearerAuth({ verifier: new KrimtoTokenVerifier(deps.keys, deps.membership) });
  const handleMcp = async (req: Request, res: Response): Promise<void> => {
    const mcp = buildServer(deps.ctx, (extra) => requesterFromAuth(extra.authInfo));
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
  app.post("/mcp", auth, rateLimit, (req, res) => {
    void handleMcp(req, res);
  });
  app.get("/mcp", auth, rateLimit, (req, res) => {
    void handleMcp(req, res);
  });

  if (deps.admin) app.use("/admin", auth, buildAdminRouter(deps.admin));

  app.use(
    "/ui",
    buildWebRouter({
      ctx: deps.ctx,
      keys: deps.keys,
      membership: deps.membership,
      sessionSecret: sessionConfigFromEnv().secret,
      admin: deps.admin,
    }),
  );

  return app;
}
