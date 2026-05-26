import express, { type Request, type Response, type Router } from "express";
import { layout, escapeHtml } from "./html";
import { COOKIE_NAME, signSession, verifySession, parseCookies } from "./session";
import { loginBody, searchBox, factResults, scopeList, factsList, factDetail, keysBody, newKeyBody, adminBody, howItWorksPanel, behindTheScenesPanel, statusPanel, activityPanel, hijackWarningPanel, connectPanel, gettingStartedPanel, type FactView, type StatusPanelOpts } from "./views";
import { type ApiKeyStore } from "../access/auth";
import { type Membership, requesterFor, isOrgAdmin } from "../access/membership";
import { krimtoRecall, krimtoRead, krimtoListScopes, type ToolContext } from "../server/tools";
import { deleteFact } from "../server/deleteFact";
import { editFact } from "../server/editFact";
import { moveFact } from "../server/moveFact";
import { canRead, canWrite } from "../access/membership";
import { scopeLabel } from "../access/scopeLabels";
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
  /** Live status snapshot for the /ui/facts status panel. Called per request so it's never stale. */
  status?: () => StatusPanelOpts;
}

type WithIdentity = Request & { identity: string };

export function buildWebRouter(deps: WebRouterDeps): Router {
  const router = express.Router();
  const secret = deps.sessionSecret;

  const page = (res: Response, status: number, title: string, body: string, identity?: string): void => {
    const isAdmin = !!identity && !!deps.admin && isOrgAdmin(deps.membership(), identity);
    res.status(status).type("html").send(layout(title, body, { identity, isAdmin }));
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

  router.get("/connect", (req, res) => {
    const host = typeof req.headers.host === "string" ? req.headers.host : "localhost:8080";
    page(res, 200, "Connect", connectPanel({ host, requireAuth: !deps.localIdentity }), idOf(req));
  });

  router.get("/facts", (req, res) => {
    void (async () => {
      const identity = idOf(req);
      const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
      try {
        if (q) {
          const { results } = await krimtoRecall(ctxFor(req), { query: q });
          const body = searchBox(q) + factResults(results.map((r) => ({ id: r.id, scope: r.scope, title: r.title })));
          page(res, 200, "Memory", body, identity);
          return;
        }
        const { scopes } = await krimtoListScopes(ctxFor(req));
        const totalFacts = scopes.reduce((n, s) => n + s.fact_count, 0);
        if (totalFacts === 0) {
          page(res, 200, "Memory", gettingStartedPanel(), identity); // empty store: teach, don't show a blank list
          return;
        }
        // Pull recent activity (best-effort — empty list when no log file yet).
        const recent = deps.ctx.activity ? await deps.ctx.activity.tail(5) : [];
        // Gap #5 — detect the recall-without-write hijack pattern (Claude Code's auto-memory winning).
        const stats = deps.ctx.activity ? await deps.ctx.activity.stats() : { recalls: 0, writes: 0, total: 0 };
        // Flat list of every readable fact (newest-first, capped at 50). Caller scope-filters
        // via canRead — we compute the readable-scope set the same way recall does.
        const readableScopes = deps.ctx.index
          .allScopes()
          .filter((s) => canRead(deps.membership(), identity, s));
        const allFacts = deps.ctx.index.listFacts(readableScopes, 50);
        const body =
          howItWorksPanel() +
          behindTheScenesPanel(deps.ctx.store.dataDir()) +
          hijackWarningPanel(stats) + // shown ONLY when threshold met; "" otherwise
          (deps.status ? statusPanel(deps.status()) : "") +
          activityPanel(recent) +
          searchBox(q) +
          scopeList(
            scopes.map((s) => ({ scope: s.path, factCount: s.fact_count })),
            deps.membership(),
            identity,
          ) +
          factsList(allFacts, totalFacts, deps.membership(), identity);
        page(res, 200, "Memory", body, identity);
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
        // Resolve the markdown file's absolute path so the user learns "this is just a file."
        // Best-effort: a missing entry (concurrent delete, sync race) just hides the line.
        const stored = await deps.ctx.store.readFact(req.params.id).catch(() => null);
        const sourcePath = stored ? `${deps.ctx.store.dataDir()}/${stored.path}` : undefined;
        // The Edit/Move/Delete buttons are gated by canWrite — same access control as `krimto rm`.
        const factScope = (fact as { scope?: string }).scope ?? "";
        const m = deps.membership();
        const canWriteHere = canWrite(m, identity, factScope);
        // Compute target scopes for the Move dropdown — every scope the viewer can write to
        // EXCEPT the current one. Mirrors the writableScopesFor logic in src/server/tools.ts.
        const writableScopes = canWriteHere
          ? writableScopeOptions(m, identity, factScope)
          : [];
        page(
          res,
          200,
          "Fact",
          factDetail(
            toFactView(fact, sourcePath, canWriteHere, writableScopes, scopeLabel(factScope, identity, m)),
          ),
          identity,
        );
      } catch (e) {
        if (e instanceof KrimtoError) {
          errorPage(res, 404, "Not found", identity);
          return;
        }
        errorPage(res, 500, "Something went wrong", identity);
      }
    })();
  });

  router.post("/facts/:id/edit", (req, res) => {
    void (async () => {
      const identity = idOf(req);
      const rawBody = bodyOf(req).body;
      const newBody = typeof rawBody === "string" ? rawBody : "";
      try {
        // Confirm read access first so existence isn't leaked to viewers who can't see the fact.
        await krimtoRead(ctxFor(req), req.params.id);
        await editFact(ctxFor(req), req.params.id, newBody);
        res.redirect(`/ui/facts/${encodeURIComponent(req.params.id)}`);
      } catch (e) {
        if (e instanceof KrimtoError) {
          if (e.code === "not_found") {
            errorPage(res, 404, "Fact not found", identity);
            return;
          }
          if (e.code === "forbidden") {
            errorPage(res, 403, "You don't have permission to edit this note.", identity);
            return;
          }
          if (e.code === "invalid_params") {
            errorPage(res, 422, e.message, identity);
            return;
          }
        }
        errorPage(res, 500, "Edit failed — see server logs", identity);
      }
    })();
  });

  router.post("/facts/:id/move", (req, res) => {
    void (async () => {
      const identity = idOf(req);
      const rawScope = bodyOf(req).scope;
      const newScope = typeof rawScope === "string" ? rawScope.trim() : "";
      try {
        await krimtoRead(ctxFor(req), req.params.id);
        await moveFact(ctxFor(req), req.params.id, newScope);
        res.redirect(`/ui/facts/${encodeURIComponent(req.params.id)}`);
      } catch (e) {
        if (e instanceof KrimtoError) {
          if (e.code === "not_found") {
            errorPage(res, 404, "Fact not found", identity);
            return;
          }
          if (e.code === "forbidden") {
            errorPage(res, 403, "You don't have permission to move this note.", identity);
            return;
          }
          if (e.code === "invalid_params") {
            errorPage(res, 422, e.message, identity);
            return;
          }
        }
        errorPage(res, 500, "Move failed — see server logs", identity);
      }
    })();
  });

  router.post("/facts/:id/delete", (req, res) => {
    void (async () => {
      const identity = idOf(req);
      try {
        // "Can't act on what you can't see": confirm the user can read this fact before deleting.
        // krimtoRead surfaces not_found for unreadable facts (no existence leak); we mirror that.
        await krimtoRead(ctxFor(req), req.params.id);
        await deleteFact(ctxFor(req), req.params.id);
        res.redirect("/ui/facts");
      } catch (e) {
        if (e instanceof KrimtoError) {
          if (e.code === "not_found") {
            errorPage(res, 404, "Fact not found (already deleted?)", identity);
            return;
          }
          if (e.code === "forbidden") {
            errorPage(res, 403, "You don't have permission to delete this fact.", identity);
            return;
          }
        }
        errorPage(res, 500, "Delete failed — see server logs", identity);
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
function toFactView(
  fact: unknown,
  sourcePath?: string,
  canWriteHere?: boolean,
  writableScopes?: { scope: string; label: string }[],
  scopeLabelText?: string,
): FactView {
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
    sourcePath,
    canEdit: canWriteHere,
    canDelete: canWriteHere,
    scopeLabel: scopeLabelText,
    writableScopes,
  };
}

/**
 * Compute the Move dropdown's option list — every scope the viewer can write to except the
 * current one. Mirrors `writableScopesFor` in `src/server/tools.ts`: own user scope, every team
 * they're a member of, plus the org scope when they're an org admin.
 */
function writableScopeOptions(
  m: Membership,
  identity: string,
  currentScope: string,
): { scope: string; label: string }[] {
  const opts: { scope: string; label: string }[] = [];
  const userScope = `user/${identity}`;
  if (userScope !== currentScope) opts.push({ scope: userScope, label: "Just me" });
  for (const team of m.teams) {
    if (!team.members.includes(identity)) continue;
    const s = `team/${team.slug}`;
    if (s === currentScope) continue;
    opts.push({ scope: s, label: team.name ?? `team/${team.slug}` });
  }
  if (isOrgAdmin(m, identity)) {
    const s = `org/${m.org.slug}`;
    if (s !== currentScope) opts.push({ scope: s, label: m.org.name ?? `org/${m.org.slug}` });
  }
  return opts;
}
