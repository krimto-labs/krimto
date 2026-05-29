import { randomBytes } from "node:crypto";
import express, { type Request, type Response, type Router } from "express";
import { layout, escapeHtml } from "./html";
import { COOKIE_NAME, signSession, verifySession, parseCookies } from "./session";
import { loginBody, searchBox, factResults, scopeList, factsList, factDetail, keysBody, newKeyBody, adminBody, hijackWarningPanel, connectPanel, gettingStartedPanel, activityPanel, behaviorPanel, machinePanel, reconnectingPanel, dashboardHeader, type FactView, type StatusPanelOpts } from "./views";
import { readDataDirGitInfo } from "../storage/git";
import { type ApiKeyStore } from "../access/auth";
import { type Membership, requesterFor, isOrgAdmin } from "../access/membership";
import { krimtoRecall, krimtoRead, krimtoListScopes, type ToolContext } from "../server/tools";
import { deleteFact } from "../server/deleteFact";
import { editFact } from "../server/editFact";
import { moveFact } from "../server/moveFact";
import { tagFact, parseTagInput, diffTags } from "../server/tagFact";
import { isLoopbackAddress } from "../server/localOps";
import { canRead, canWrite } from "../access/membership";
import { scopeLabel } from "../access/scopeLabels";
import { KrimtoError } from "../server/errors";
import { type AdminContext } from "../server/admin";
import { addUser, removeUser, createTeam, setTeamMember } from "../access/membershipStore";

/**
 * In-process server-side config actions for Settings ▸ Behavior (v0.2.42). These operate on the
 * running server's own data dir / index, so they go through the write serializer in main() rather
 * than spawning a CLI (which would refuse while the server holds the lock). All are admin-gated.
 */
export interface BehaviorOps {
  /** Point the data-dir git repo's origin at `url` (two-way sync follows). */
  setRemote: (url: string) => Promise<void>;
  /** Drop the origin remote (back to local-only). */
  removeRemote: () => Promise<void>;
  /** On-demand two-way sync: pull the team's notes, then push ours. Returns both statuses. */
  syncNow: () => Promise<{ pull: string; push: string }>;
  /** Rebuild index.db from the markdown source of truth. Returns the resulting fact count. */
  reindexNow: () => Promise<number>;
}

/** Read-only runtime snapshot shown in Settings ▸ This machine. */
export interface MachineStatus {
  /** "always-running" | "as-needed" | "manual" */
  runMode: string;
  serviceRunning: boolean;
  dataDir: string;
  identity: string;
  /** "keyword" | "openai" */
  searchProvider: string;
}

/**
 * Loopback-gated machine controls for Settings ▸ This machine (v0.2.42). `run` spawns the krimto
 * CLI as a detached child (it cannot run in-process — see src/server/localOps.ts). The router gates
 * every call on loopback peer + admin role + a CSRF nonce before invoking this.
 */
export interface LocalMachineOps {
  run: (action: string, params: Record<string, string>) => { ok: boolean; message?: string; bounces?: boolean };
  status: () => Promise<MachineStatus>;
}

export interface WebRouterDeps {
  ctx: ToolContext;
  keys: ApiKeyStore;
  membership: () => Membership;
  sessionSecret: string;
  /** When set, enables the admin-only /ui/admin page (only reachable in team mode). */
  admin?: AdminContext;
  /** Live team-mode predicate. Evaluated per request: team ⇒ require login; solo ⇒ use localIdentity. */
  teamModeActive: () => boolean;
  /** The local/solo identity — used (no login) whenever team mode is NOT active. Always provided. */
  localIdentity: string;
  /** Live status snapshot for the /ui/facts status panel. Called per request so it's never stale. */
  status?: () => StatusPanelOpts;
  /** In-process Settings ▸ Behavior actions. Omitted in contexts that don't expose them. */
  behavior?: BehaviorOps;
  /** Loopback-gated Settings ▸ This machine controls. Omitted in contexts that don't expose them. */
  localMachine?: LocalMachineOps;
}

type WithIdentity = Request & { identity: string };

export function buildWebRouter(deps: WebRouterDeps): Router {
  const router = express.Router();
  const secret = deps.sessionSecret;
  // Per-process CSRF nonce for the loopback machine-ops forms (Settings ▸ This machine). Embedded in
  // those forms + required on POST, so another local app can't drive the control plane via the browser.
  const csrfNonce = randomBytes(18).toString("hex");

  const page = (res: Response, status: number, title: string, body: string, identity?: string): void => {
    const isAdmin = !!identity && !!deps.admin && isOrgAdmin(deps.membership(), identity);
    res.status(status).type("html").send(layout(title, body, { identity, isAdmin, teamMode: deps.teamModeActive() }));
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
    if (!deps.teamModeActive()) {
      (req as WithIdentity).identity = deps.localIdentity; // solo mode: no login
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
    page(res, 200, "Connect", connectPanel({ host, requireAuth: deps.teamModeActive() }), idOf(req));
  });

  // Behavior actions act on the running server's data dir / index. Owner-in-solo / org-admin-in-team.
  const canManageBehavior = (req: Request): boolean =>
    !deps.teamModeActive() || isOrgAdmin(deps.membership(), idOf(req));

  router.get("/settings", (req, res) => {
    void (async () => {
      const identity = idOf(req);
      // Read the full activity log (cap matches the panel's tail; no truncation here so the
      // dedicated Settings page is the full record).
      const activity = deps.ctx.activity ? await deps.ctx.activity.tail(50) : [];
      const gitInfo = await readDataDirGitInfo(deps.ctx.store.dataDir());
      const behavior = behaviorPanel({
        remoteUrl: gitInfo.remote,
        embeddings: deps.status ? deps.status().embeddings : undefined,
        canManage: canManageBehavior(req),
      });
      const machine = deps.localMachine
        ? machinePanel({
            status: await deps.localMachine.status(),
            loopback: isLoopbackAddress(req.socket.remoteAddress),
            canManage: canManageBehavior(req),
            csrfNonce,
          })
        : "";
      page(
        res,
        200,
        "Settings",
        `<div class="page-head"><h1>Settings</h1>` +
          `<p class="muted">Customize Krimto and see what your agents have been doing.</p></div>` +
          behavior +
          machine +
          activityPanel(activity),
        identity,
      );
    })();
  });

  // ── Settings ▸ Behavior actions (in-process; admin-gated) ──────────────────
  const behaviorGuard = (req: Request, res: Response): boolean => {
    const identity = idOf(req);
    if (!canManageBehavior(req)) {
      errorPage(res, 403, "Org admin required", identity);
      return false;
    }
    if (!deps.behavior) {
      errorPage(res, 500, "Behavior actions are unavailable on this server.", identity);
      return false;
    }
    return true;
  };

  router.post("/settings/remote", (req, res) => {
    void (async () => {
      if (!behaviorGuard(req, res)) return;
      const identity = idOf(req);
      const rawUrl = bodyOf(req).url;
      const url = typeof rawUrl === "string" ? rawUrl.trim() : "";
      if (!url) {
        errorPage(res, 422, "A remote URL is required.", identity);
        return;
      }
      try {
        await deps.behavior!.setRemote(url);
        res.redirect("/ui/settings");
      } catch {
        errorPage(res, 500, "Could not set the remote — see server logs.", identity);
      }
    })();
  });

  router.post("/settings/remote/remove", (req, res) => {
    void (async () => {
      if (!behaviorGuard(req, res)) return;
      const identity = idOf(req);
      try {
        await deps.behavior!.removeRemote();
        res.redirect("/ui/settings");
      } catch {
        errorPage(res, 500, "Could not remove the remote — see server logs.", identity);
      }
    })();
  });

  router.post("/settings/sync", (req, res) => {
    void (async () => {
      if (!behaviorGuard(req, res)) return;
      const identity = idOf(req);
      try {
        await deps.behavior!.syncNow();
        res.redirect("/ui/settings");
      } catch {
        errorPage(res, 500, "Sync failed — see server logs.", identity);
      }
    })();
  });

  router.post("/settings/reindex", (req, res) => {
    void (async () => {
      if (!behaviorGuard(req, res)) return;
      const identity = idOf(req);
      try {
        await deps.behavior!.reindexNow();
        res.redirect("/ui/settings");
      } catch {
        errorPage(res, 500, "Reindex failed — see server logs.", identity);
      }
    })();
  });

  // ── Settings ▸ This machine — the loopback-gated control plane (LOAD-BEARING) ──────────────────
  // One endpoint dispatches every allowlisted machine op. Gated on: loopback peer (a remote teammate
  // can never reach it) + admin role + a per-process CSRF nonce. The allowlist + arg validation +
  // no-shell spawn live in src/server/localOps.ts (via deps.localMachine.run).
  router.post("/settings/machine", (req, res) => {
    const identity = idOf(req);
    if (!isLoopbackAddress(req.socket.remoteAddress)) {
      errorPage(res, 403, "Machine controls are only available in a browser on the computer running Krimto.", identity);
      return;
    }
    if (!canManageBehavior(req)) {
      errorPage(res, 403, "Org admin required", identity);
      return;
    }
    if (!deps.localMachine) {
      errorPage(res, 500, "Machine controls are unavailable on this server.", identity);
      return;
    }
    const body = bodyOf(req);
    if (typeof body._csrf !== "string" || body._csrf !== csrfNonce) {
      errorPage(res, 403, "Invalid or missing form token — reload the page and try again.", identity);
      return;
    }
    const action = typeof body.action === "string" ? body.action : "";
    const params: Record<string, string> = {};
    for (const key of ["email", "apiKey", "path"]) {
      if (typeof body[key] === "string") params[key] = body[key] as string;
    }
    const result = deps.localMachine.run(action, params);
    if (!result.ok) {
      errorPage(res, 422, result.message ?? "Invalid request", identity);
      return;
    }
    if (result.bounces) {
      // The op stops/restarts this server; show a page that waits for it to come back.
      page(res, 200, "Applying…", reconnectingPanel(), identity);
      return;
    }
    res.redirect("/ui/settings");
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
        // v0.2.17-5: the engineering panels (How-it-works, Behind-the-scenes, Status, full
        // Activity feed) moved to /ui/settings. /ui/facts is now notes-focused. We keep the
        // hijack warning HERE because it's an urgent diagnostic the user must see immediately,
        // plus a 3-line activity tail so "did my agent call?" is one glance away.
        const recent = deps.ctx.activity ? await deps.ctx.activity.tail(3) : [];
        const stats = deps.ctx.activity ? await deps.ctx.activity.stats() : { recalls: 0, writes: 0, total: 0 };
        const readableScopes = deps.ctx.index
          .allScopes()
          .filter((s) => canRead(deps.membership(), identity, s));
        const allFacts = deps.ctx.index.listFacts(readableScopes, 50);

        // v0.2.30 — header sync timestamp. Use max(last git commit, last write activity) so
        // a write that just happened still reads "synced Ns ago" even before the 30s commit
        // batch fires. readDataDirGitInfo handles a missing/empty repo gracefully.
        const gitInfo = await readDataDirGitInfo(deps.ctx.store.dataDir());
        const lastCommitIso = gitInfo.lastCommitAt ? gitInfo.lastCommitAt.toISOString() : null;
        const lastWriteIso = await lastWriteActivityTime(deps.ctx.activity);
        const syncedAgo = humanAgoForSync(lastCommitIso, lastWriteIso);

        const recentBlurb =
          recent.length > 0
            ? `<p class="muted" style="margin:1rem 0 0">Last MCP calls: ` +
              recent
                .slice()
                .reverse()
                .map((e) => `<code>${e.tool}</code>`)
                .join(", ") +
              ` · <a href="/ui/settings">see full activity →</a></p>`
            : "";
        const body =
          dashboardHeader(identity, totalFacts, syncedAgo) +
          hijackWarningPanel(stats) +
          searchBox(q) +
          scopeList(
            scopes.map((s) => ({ scope: s.path, factCount: s.fact_count })),
            deps.membership(),
            identity,
          ) +
          factsList(allFacts, totalFacts, deps.membership(), identity) +
          recentBlurb;
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

  router.post("/facts/:id/tag", (req, res) => {
    void (async () => {
      const identity = idOf(req);
      const rawTags = bodyOf(req).tags;
      const desired = typeof rawTags === "string" ? parseTagInput(rawTags) : [];
      try {
        // Read first (enforces access; no existence leak) — also gives us the current tag set so a
        // submitted "full set" can be diffed into the add/remove shape tagFact wants.
        const fact = await krimtoRead(ctxFor(req), req.params.id);
        const fm = (fact as { frontmatter?: { tags?: unknown } }).frontmatter ?? {};
        const current = Array.isArray(fm.tags) ? fm.tags.filter((t): t is string => typeof t === "string") : [];
        await tagFact(ctxFor(req), req.params.id, diffTags(current, desired));
        res.redirect(`/ui/facts/${encodeURIComponent(req.params.id)}`);
      } catch (e) {
        if (e instanceof KrimtoError) {
          if (e.code === "not_found") {
            errorPage(res, 404, "Fact not found", identity);
            return;
          }
          if (e.code === "forbidden") {
            errorPage(res, 403, "You don't have permission to tag this note.", identity);
            return;
          }
          if (e.code === "invalid_params") {
            errorPage(res, 422, e.message, identity);
            return;
          }
        }
        errorPage(res, 500, "Tag update failed — see server logs", identity);
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

  const adminOr403 = (req: Request, res: Response): AdminContext | null => {
    const identity = idOf(req);
    if (!deps.admin || !isOrgAdmin(deps.membership(), identity)) {
      errorPage(res, 403, "Org admin required", identity);
      return null;
    }
    return deps.admin;
  };

  router.get("/admin", (req, res) => {
    void (async () => {
      const m = deps.membership();
      const allKeys = isAdmin(req) && deps.admin ? await deps.admin.keys.list() : [];
      page(
        res,
        isAdmin(req) ? 200 : 403,
        "Team",
        adminBody({
          isAdmin: isAdmin(req),
          users: m.users.map((u) => ({ email: u.email })),
          teams: m.teams.map((t) => ({ slug: t.slug, name: t.name, members: t.members })),
          keys: allKeys.map((k) => ({ hash: k.hash, identity: k.identity, label: k.label, prefix: k.prefix })),
        }),
        idOf(req),
      );
    })();
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

  router.post("/admin/members/remove", (req, res) => {
    void (async () => {
      const admin = adminOr403(req, res);
      if (!admin) return;
      const rawEmail = bodyOf(req).email;
      const email = typeof rawEmail === "string" ? rawEmail.trim() : "";
      if (!email) {
        res.redirect("/ui/admin");
        return;
      }
      try {
        await admin.applyChange(() => removeUser(admin.dataDir, email));
        res.redirect("/ui/admin");
      } catch (e) {
        errorPage(res, 409, e instanceof KrimtoError ? e.message : "Could not remove member.", idOf(req));
      }
    })();
  });

  router.post("/admin/teams", (req, res) => {
    void (async () => {
      const admin = adminOr403(req, res);
      if (!admin) return;
      const b = bodyOf(req);
      const slug = typeof b.slug === "string" ? b.slug.trim() : "";
      const name = typeof b.name === "string" && b.name.trim() ? b.name.trim() : undefined;
      if (!slug) {
        res.redirect("/ui/admin");
        return;
      }
      try {
        await admin.applyChange(() => createTeam(admin.dataDir, slug, name));
        res.redirect("/ui/admin");
      } catch (e) {
        errorPage(res, 409, e instanceof KrimtoError ? e.message : "Could not create team.", idOf(req));
      }
    })();
  });

  router.post("/admin/teams/members", (req, res) => {
    void (async () => {
      const admin = adminOr403(req, res);
      if (!admin) return;
      const b = bodyOf(req);
      const slug = typeof b.slug === "string" ? b.slug.trim() : "";
      const email = typeof b.email === "string" ? b.email.trim() : "";
      const add = b.op !== "remove";
      if (!slug || !email) {
        res.redirect("/ui/admin");
        return;
      }
      try {
        await admin.applyChange(() => setTeamMember(admin.dataDir, slug, email, add));
        res.redirect("/ui/admin");
      } catch (e) {
        errorPage(res, 409, e instanceof KrimtoError ? e.message : "Could not update team membership.", idOf(req));
      }
    })();
  });

  router.post("/admin/keys/revoke", (req, res) => {
    void (async () => {
      const admin = adminOr403(req, res);
      if (!admin) return;
      const rawHash = bodyOf(req).hash;
      const hash = typeof rawHash === "string" ? rawHash : "";
      const all = await admin.keys.list();
      const rec = all.find((k) => k.hash === hash);
      if (!rec) {
        errorPage(res, 404, "Key not found.", idOf(req));
        return;
      }
      // Lockout guard (mirrors the admin REST): never strip a member's only key.
      if (all.filter((k) => k.identity === rec.identity).length <= 1) {
        errorPage(res, 409, "That's the member's only key — issue another first.", idOf(req));
        return;
      }
      await admin.keys.revoke(hash);
      res.redirect("/ui/admin");
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

/**
 * v0.2.30 — sync-timestamp helper for the dashboard header. Reads the most recent
 * `krimto_write` (or `krimto_supersede`) from the activity log so a write that just happened
 * is reflected immediately, even before the 30s CommitBatcher fires. Returns null when no
 * writes have ever been recorded (a brand-new install).
 */
async function lastWriteActivityTime(
  activity: ToolContext["activity"] | undefined,
): Promise<string | null> {
  if (!activity) return null;
  // tail(200) covers the full bounded log; we then pick the latest write-like entry.
  const entries = await activity.tail(200);
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (!e) continue;
    if (e.tool === "krimto_write" || e.tool === "krimto_supersede") return e.timestamp;
  }
  return null;
}

/** Pick the more recent of two ISO timestamps and render as "Ns ago" / "Nm ago" / etc. */
function humanAgoForSync(a: string | null, b: string | null): string | null {
  const ta = a ? Date.parse(a) : NaN;
  const tb = b ? Date.parse(b) : NaN;
  let t: number;
  if (Number.isFinite(ta) && Number.isFinite(tb)) t = Math.max(ta, tb);
  else if (Number.isFinite(ta)) t = ta;
  else if (Number.isFinite(tb)) t = tb;
  else return null;
  const secs = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}
