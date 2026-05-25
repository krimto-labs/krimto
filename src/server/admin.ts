// Admin-only REST API for membership + key management (BUG-5). Mounted at /admin behind bearer auth;
// every route additionally requires the caller to be an org admin. REST, not MCP tools (the tool
// surface stays at five). Each mutating route serializes the change, commits members.yaml, and
// reloads membership in-process via AdminContext.applyChange.
import express, { type Request, type Response, type Router } from "express";
import { type ApiKeyStore } from "../access/auth";
import { isOrgAdmin, type Membership } from "../access/membership";
import { addUser, removeUser, createTeam, setTeamMember } from "../access/membershipStore";
import { KrimtoError, httpStatus } from "./errors";

export interface AdminContext {
  dataDir: string;
  keys: ApiKeyStore;
  membership: () => Membership;
  /** Serialize a members.yaml mutation, commit it, and reload membership in-process. */
  applyChange: (mutate: () => Promise<void>) => Promise<void>;
}

export function buildAdminRouter(admin: AdminContext): Router {
  const router = express.Router();
  const body = (req: Request): Record<string, unknown> =>
    (typeof req.body === "object" && req.body !== null ? req.body : {}) as Record<string, unknown>;
  const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const errJson = (res: Response, status: number, code: string, message: string): void => {
    res.status(status).json({ error: { code, message } });
  };
  const fail = (res: Response, e: unknown): void => {
    if (e instanceof KrimtoError) errJson(res, httpStatus(e.code), e.code, e.message);
    else errJson(res, 500, "internal", "internal error");
  };

  // adminOnly: requireBearerAuth (mounted before this router) has populated req.auth.
  router.use((req: Request, res: Response, next: () => void) => {
    const id = req.auth?.clientId;
    if (!id || !isOrgAdmin(admin.membership(), id)) {
      errJson(res, 403, "forbidden", "org admin required");
      return;
    }
    next();
  });

  router.get("/members", (_req, res) => {
    const m = admin.membership();
    res.json({ org: m.org, teams: m.teams, users: m.users });
  });

  router.post("/members", (req, res) => {
    void (async () => {
      const email = str(body(req).email);
      if (!email) {
        errJson(res, 422, "invalid_params", "email required");
        return;
      }
      try {
        await admin.applyChange(() =>
          addUser(admin.dataDir, email, { team: str(body(req).team), admin: body(req).admin === true }),
        );
        res.status(201).json({ email });
      } catch (e) {
        fail(res, e);
      }
    })();
  });

  router.delete("/members/:email", (req, res) => {
    void (async () => {
      try {
        await admin.applyChange(() => removeUser(admin.dataDir, req.params.email));
        res.json({ removed: req.params.email });
      } catch (e) {
        fail(res, e);
      }
    })();
  });

  router.post("/keys", (req, res) => {
    void (async () => {
      const email = str(body(req).email);
      if (!email) {
        errJson(res, 422, "invalid_params", "email required");
        return;
      }
      const { key } = await admin.keys.issue(email, "live", str(body(req).label));
      res.status(201).json({ email, key }); // shown once
    })();
  });

  router.delete("/keys/:hash", (req, res) => {
    void (async () => {
      const { hash } = req.params;
      const rec = (await admin.keys.list()).find((k) => k.hash === hash);
      if (!rec) {
        errJson(res, 404, "not_found", "key not found");
        return;
      }
      const remaining = (await admin.keys.list()).filter((k) => k.identity === rec.identity).length;
      if (remaining <= 1) {
        errJson(res, 409, "conflict", "refusing to revoke a user's only key");
        return;
      }
      await admin.keys.revoke(hash);
      res.json({ revoked: hash });
    })();
  });

  router.post("/teams", (req, res) => {
    void (async () => {
      const slug = str(body(req).slug);
      if (!slug) {
        errJson(res, 422, "invalid_params", "slug required");
        return;
      }
      try {
        await admin.applyChange(() => createTeam(admin.dataDir, slug, str(body(req).name)));
        res.status(201).json({ slug });
      } catch (e) {
        fail(res, e);
      }
    })();
  });

  router.patch("/teams/:slug", (req, res) => {
    void (async () => {
      const add = str(body(req).add);
      const remove = str(body(req).remove);
      try {
        if (add) await admin.applyChange(() => setTeamMember(admin.dataDir, req.params.slug, add, true));
        if (remove) await admin.applyChange(() => setTeamMember(admin.dataDir, req.params.slug, remove, false));
        res.json({ slug: req.params.slug, added: add, removed: remove });
      } catch (e) {
        fail(res, e);
      }
    })();
  });

  return router;
}
