import express, { type Request, type Response, type Router } from "express";
import { layout, escapeHtml } from "./html";
import { COOKIE_NAME, signSession, verifySession, parseCookies } from "./session";
import { loginBody, searchBox, factResults, scopeList, factDetail, keysBody, newKeyBody, adminBody, howItWorksPanel, type FactView } from "./views";
import { type ApiKeyStore } from "../access/auth";
import { type Membership, requesterFor, isOrgAdmin } from "../access/membership";
import { krimtoRecall, krimtoRead, krimtoListScopes, type ToolContext } from "../server/tools";
import { KrimtoError } from "../server/errors";
import { type AdminContext } from "../server/admin";
import { addUser } from "../access/membershipStore";

export interface WebRouterDeps {
  ctx: ToolContext;
  keys: ApiKeyStore;
  membership: () => Membership;
  sessionSecret: string;
  /** When set, enables the admin-only /ui/admin page. */
  admin?: AdminContext;
  /** When set (local mode), skip login and use this identity for every request. */
  localIdentity?: string;
}

type WithIdentity = Request & { identity: string };

export function buildWebRouter(deps: WebRouterDeps): Router {
  const router = express.Router();
  const secret = deps.sessionSecret;

  const page = (res: Response, status: number, title: string, body: string, identity?: string): void => {
    res.status(status).type("html").send(layout(title, body, { identity }));
  };
  const errorPage = (res: Response, status: number, message: string, identity?: string): void => {
    page(res, status, "Error", `<h1>${escapeHtml(message)}</h1><p><a href="/ui/facts">Back</a></p>`, identity);
  };
  const bodyOf = (req: Request): Record<string, unknown> =>
    (typeof req.body === "object" && req.body !== null ? req.body : {}) as Record<string, unknown>;

  router.get("/login", (_req, res) => page(res, 200, "Sign in", loginBody()));
  router.post("/login", (req, res) => {
    void (async () => {
      const raw = bodyOf(req).key;
      const key = typeof raw === "string" ? raw.trim() : "";
      const identity = key ? await deps.keys.resolveIdentity(key) : null;
      if (!identity) {
        page(res, 401, "Sign in", loginBody("Invalid key"));
        return;
      }
      res.cookie(COOKIE_NAME, signSession(identity, secret), { httpOnly: true, sameSite: "lax", path: "/" });
      res.redirect("/ui/facts");
    })();
  });
  router.get("/logout", (_req, res) => {
    res.clearCookie(COOKIE_NAME, { path: "/" });
    res.redirect("/ui/login");
  });

  router.use((req, res, next) => {
    if (deps.localIdentity) {
      (req as WithIdentity).identity = deps.localIdentity; // local mode: no login
      next();
      return;
    }
    const identity = verifySession(parseCookies(req.headers.cookie)[COOKIE_NAME], secret);
    if (!identity) {
      res.redirect("/ui/login");
      return;
    }
    (req as WithIdentity).identity = identity;
    next();
  });
  const idOf = (req: Request): string => (req as WithIdentity).identity;
  const ctxFor = (req: Request): ToolContext => ({ ...deps.ctx, requester: requesterFor(deps.membership(), idOf(req)) });

  router.get("/", (_req, res) => res.redirect("/ui/facts"));

  router.get("/facts", (req, res) => {
    void (async () => {
      const identity = idOf(req);
      const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
      try {
        let body = searchBox(q);
        if (q) {
          const { results } = await krimtoRecall(ctxFor(req), { query: q });
          // RecallHit shape: { id, scope, title, body, score, author, updated }
          body += factResults(results.map((r) => ({ id: r.id, scope: r.scope, title: r.title })));
        } else {
          body = howItWorksPanel() + body; // team-first explainer on the landing
          const { scopes } = await krimtoListScopes(ctxFor(req));
          // ListScopesResult.scopes shape: { path, fact_count, last_updated }
          // "path" is the scope name field
          body += scopeList(scopes.map((s) => ({ scope: s.path, factCount: s.fact_count })));
        }
        page(res, 200, "Facts", body, identity);
      } catch (e) {
        errorPage(res, 500, e instanceof KrimtoError ? e.message : "Something went wrong", identity);
      }
    })();
  });

  router.get("/facts/:id", (req, res) => {
    void (async () => {
      const identity = idOf(req);
      try {
        const fact = await krimtoRead(ctxFor(req), req.params.id);
        page(res, 200, "Fact", factDetail(toFactView(fact)), identity);
      } catch (e) {
        if (e instanceof KrimtoError) {
          errorPage(res, 404, "Not found", identity);
          return;
        }
        errorPage(res, 500, "Something went wrong", identity);
      }
    })();
  });

  router.get("/keys", (req, res) => {
    void (async () => {
      const identity = idOf(req);
      const mine = (await deps.keys.list()).filter((k) => k.identity === identity);
      page(res, 200, "API keys", keysBody(mine), identity);
    })();
  });
  router.post("/keys", (req, res) => {
    void (async () => {
      const identity = idOf(req);
      const rawLabel = bodyOf(req).label;
      const label = typeof rawLabel === "string" && rawLabel.trim() ? rawLabel.trim() : undefined;
      const { key } = await deps.keys.issue(identity, "live", label);
      page(res, 200, "API keys", newKeyBody(key), identity);
    })();
  });
  router.post("/keys/revoke", (req, res) => {
    void (async () => {
      const identity = idOf(req);
      const rawHash = bodyOf(req).hash;
      const hash = typeof rawHash === "string" ? rawHash : "";
      const mine = (await deps.keys.list()).filter((k) => k.identity === identity);
      if (!mine.some((k) => k.hash === hash)) {
        errorPage(res, 404, "Not found", identity);
        return;
      }
      // Lockout guard (BUG-1): never let someone revoke their last key.
      if (mine.length <= 1) {
        errorPage(res, 409, "This is your only key — issue a new key first, or you'll be locked out.", identity);
        return;
      }
      await deps.keys.revoke(hash);
      res.redirect("/ui/keys");
    })();
  });

  const isAdmin = (req: Request): boolean => !!deps.admin && isOrgAdmin(deps.membership(), idOf(req));

  router.get("/admin", (req, res) => {
    const m = deps.membership();
    page(
      res,
      isAdmin(req) ? 200 : 403,
      "Admin",
      adminBody({
        isAdmin: isAdmin(req),
        users: m.users.map((u) => ({ email: u.email })),
        teams: m.teams.map((t) => ({ slug: t.slug, members: t.members })),
      }),
      idOf(req),
    );
  });
  router.post("/admin/members", (req, res) => {
    void (async () => {
      const identity = idOf(req);
      const admin = deps.admin;
      if (!admin || !isOrgAdmin(deps.membership(), identity)) {
        errorPage(res, 403, "Org admin required", identity);
        return;
      }
      const rawEmail = bodyOf(req).email;
      const email = typeof rawEmail === "string" ? rawEmail.trim() : "";
      const rawTeam = bodyOf(req).team;
      const team = typeof rawTeam === "string" && rawTeam.trim() ? rawTeam.trim() : undefined;
      if (email) await admin.applyChange(() => addUser(admin.dataDir, email, team ? { team } : {}));
      res.redirect("/ui/admin");
    })();
  });
  router.post("/admin/keys", (req, res) => {
    void (async () => {
      const identity = idOf(req);
      const admin = deps.admin;
      if (!admin || !isOrgAdmin(deps.membership(), identity)) {
        errorPage(res, 403, "Org admin required", identity);
        return;
      }
      const rawEmail = bodyOf(req).email;
      const email = typeof rawEmail === "string" ? rawEmail.trim() : "";
      if (!email) {
        res.redirect("/ui/admin");
        return;
      }
      const rawLabel = bodyOf(req).label;
      const label = typeof rawLabel === "string" && rawLabel.trim() ? rawLabel.trim() : undefined;
      const { key } = await admin.keys.issue(email, "live", label);
      page(res, 200, "API key", newKeyBody(key), identity);
    })();
  });

  return router;
}

// ReadResult shape: { id, scope, title, body, frontmatter: FactFrontmatter, history }
// FactFrontmatter has: author, created, updated, tags?, source?
// Top-level id, scope, title, body are promoted; the rest live under frontmatter.
function toFactView(fact: unknown): FactView {
  const f = fact as Record<string, unknown>;
  const fm = (typeof f.frontmatter === "object" && f.frontmatter !== null ? f.frontmatter : {}) as Record<string, unknown>;
  const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
  const tags = Array.isArray(fm.tags) ? fm.tags.filter((t): t is string => typeof t === "string") : undefined;
  return {
    id: str(f.id) ?? "",
    scope: str(f.scope) ?? "",
    title: str(f.title) ?? "",
    body: str(f.body) ?? "",
    author: str(fm.author),
    source: str(fm.source),
    created: str(fm.created),
    tags,
  };
}
