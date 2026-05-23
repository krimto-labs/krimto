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
import { healthLive, healthReady, sqliteHealth, indexHealth, gitRemoteCheck } from "./health";
import { KrimtoTokenVerifier } from "./tokenVerifier";

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
}

export function buildHttpApp(deps: HttpAppDeps): Express {
  const app = express();
  app.use(express.json());

  app.get("/health/live", (_req: Request, res: Response) => {
    res.json(healthLive(deps.version, (Date.now() - deps.startedAt) / 1000));
  });
  app.get("/health/ready", (_req: Request, res: Response) => {
    const ready = healthReady(deps.version, {
      sqlite: sqliteHealth(deps.db),
      index: indexHealth(deps.index, deps.isBuilding()),
      git_remote: gitRemoteCheck(deps.gitRemoteStatus()),
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
  app.post("/mcp", auth, (req, res) => {
    void handleMcp(req, res);
  });
  app.get("/mcp", auth, (req, res) => {
    void handleMcp(req, res);
  });

  return app;
}
