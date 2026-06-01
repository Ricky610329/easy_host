// Composition root: HTTP routing, the per-request glue handlers, the OAuth provider entry point,
// and the Durable Object re-exports that wrangler binds.
import { getAgentByName } from "agents";
import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import type { Env, Site } from "./types";
import { genId, json, redirectTo } from "./util";
import { getSite, indexAddApp, indexRemoveApp, listOwnerApps, rateLimited, reserveAppSlot, serviceClosedReason } from "./store";
import {
  CLEAR_SESSION_COOKIE,
  getSessionUser,
  handleAuthCallback,
  handleAuthLogin,
  handleAuthorize,
  handleAuthorizeCallback,
  mintAppToken,
  verifyAppToken,
} from "./auth";
import { manifest, serveApp, serveIcon, serveSW, serveSdk } from "./pwa";
import { LANDING, renderDashboard } from "./pages";
import { AppBackend, type ApiResult } from "./backend";
import { EasyHostMCP } from "./mcp";

// Durable Object classes must be exported from the Worker entry for wrangler to bind them.
export { AppBackend } from "./backend";
export { EasyHostMCP } from "./mcp";

async function handleCreate(request: Request, env: Env): Promise<Response> {
  let payload: { html?: unknown; name?: unknown; theme_color?: unknown };
  try {
    payload = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  const html = typeof payload.html === "string" ? payload.html : "";
  if (!html.trim()) return json({ error: "html is required" }, 400);

  const user = await getSessionUser(request, env);
  if (!user) return json({ error: "Sign in to publish.", login: "/auth/login" }, 401);

  const closed = serviceClosedReason(env);
  if (closed) return json({ error: closed }, 503);
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  if (await rateLimited(env, ip)) return json({ error: "Too many apps from this IP — try again later." }, 429);
  if (!(await reserveAppSlot(env))) return json({ error: "This public demo has reached its app limit — deploy your own instance to keep going." }, 503);

  const site: Site = {
    html,
    name: typeof payload.name === "string" ? payload.name.slice(0, 60) : undefined,
    theme_color: typeof payload.theme_color === "string" ? payload.theme_color.slice(0, 16) : undefined,
    owner: user.id,
    visibility: "unlisted",
  };
  const id = genId();
  await env.SITES.put(id, JSON.stringify(site));
  await indexAddApp(env, user.id, id);
  return json({ id, url: `${new URL(request.url).origin}/s/${id}/` });
}

async function handleApi(request: Request, env: Env, id: string, apiPath: string, url: URL): Promise<Response> {
  let body: unknown = undefined;
  if (request.method === "POST" || request.method === "PUT") {
    try {
      body = await request.json();
    } catch {
      body = undefined;
    }
  }
  const query = Object.fromEntries(url.searchParams);

  // Capability token authorizes /s/:id/api/* and must match THIS app id (blocks cross-app reads).
  const auth = request.headers.get("authorization") || "";
  const claims = await verifyAppToken(env, auth.startsWith("Bearer ") ? auth.slice(7) : null);
  if (!claims || claims.a !== id) return json({ error: "unauthorized" }, 401);

  const stub = await getAgentByName(env.APP_OBJECT, id);
  const r = (await (stub as unknown as AppBackend).apiCall(request.method, apiPath, query, body, id, claims.u)) as ApiResult;
  return new Response(JSON.stringify(r.json), { status: r.status, headers: { "content-type": "application/json" } });
}

async function handleDashboard(request: Request, env: Env): Promise<Response> {
  const user = await getSessionUser(request, env);
  if (!user) return redirectTo("/auth/login?next=%2Fdashboard");
  return new Response(renderDashboard(user, await listOwnerApps(env, user.id)), { headers: { "content-type": "text/html;charset=utf-8" } });
}

async function handleAppsApi(request: Request, env: Env, sub: string): Promise<Response> {
  const user = await getSessionUser(request, env);
  if (!user) return json({ error: "unauthorized" }, 401);
  if (sub === "" && request.method === "GET") return json({ email: user.email, apps: await listOwnerApps(env, user.id) });

  const mVis = sub.match(/^\/([A-Za-z0-9_-]+)\/visibility$/);
  if (mVis && request.method === "POST") {
    const site = await getSite(env, mVis[1]);
    if (!site || site.owner !== user.id) return json({ error: "not found" }, 404);
    const b = (await request.json().catch(() => ({}))) as { visibility?: string };
    if (b.visibility !== "unlisted" && b.visibility !== "private" && b.visibility !== "public") return json({ error: "bad visibility" }, 400);
    site.visibility = b.visibility;
    await env.SITES.put(mVis[1], JSON.stringify(site));
    return json({ ok: true });
  }
  const mDel = sub.match(/^\/([A-Za-z0-9_-]+)$/);
  if (mDel && request.method === "DELETE") {
    const site = await getSite(env, mDel[1]);
    if (!site || site.owner !== user.id) return json({ error: "not found" }, 404);
    await env.SITES.delete(mDel[1]);
    await indexRemoveApp(env, user.id, mDel[1]);
    return json({ ok: true });
  }
  return json({ error: "not found" }, 404);
}

// ---------- main app router (everything except the MCP API, which the OAuth provider owns) ----------
const appRouter: ExportedHandler<Env> = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // OAuth authorize (the provider delegates /authorize here) + Google upstream callback.
    if (path === "/authorize") return handleAuthorize(request, env);
    if (path === "/authorize/google-callback") return handleAuthorizeCallback(request, env);

    // Auth + account surfaces.
    if (path === "/auth/login") return handleAuthLogin(request, env);
    if (path === "/auth/callback") return handleAuthCallback(request, env);
    if (path === "/auth/logout") return redirectTo("/", CLEAR_SESSION_COOKIE);
    if (path === "/dashboard") return handleDashboard(request, env);
    if (path === "/api/apps") return handleAppsApi(request, env, "");
    if (path.startsWith("/api/apps/")) return handleAppsApi(request, env, path.slice("/api/apps".length));

    if (path === "/" && request.method === "GET") {
      return new Response(LANDING, { headers: { "content-type": "text/html;charset=utf-8" } });
    }
    if (path === "/api/create" && request.method === "POST") return handleCreate(request, env);

    // Hosted apps live under /s/:id/ (trailing slash required for SW scope).
    const m = path.match(/^\/s\/([A-Za-z0-9_-]+)(\/.*)?$/);
    if (m) {
      const id = m[1];
      const sub = m[2]; // undefined => no trailing slash
      if (sub === undefined) return redirectTo(`${url.origin}/s/${id}/`);

      if (sub.startsWith("/api/")) return handleApi(request, env, id, sub.slice("/api/".length), url);
      if (sub === "/icon-192.png") return serveIcon(192);
      if (sub === "/icon-512.png") return serveIcon(512);
      if (sub === "/apple-touch-icon.png") return serveIcon(180);
      if (sub === "/sw.js") return serveSW();
      if (sub === "/sdk.js") return serveSdk();

      const site = await getSite(env, id);
      if (!site) return new Response("Not found", { status: 404 });
      if (sub === "/manifest.webmanifest") return manifest(site);

      // HTML-serving: "/" or any unknown subpath (SPA fallback). Enforce private + mint a scoped token.
      if (request.method === "GET") {
        const u = await getSessionUser(request, env);
        if (site.visibility === "private" && (!u || u.id !== site.owner)) {
          return redirectTo(`/auth/login?next=${encodeURIComponent(path)}`);
        }
        return serveApp(site, await mintAppToken(env, id, u?.id || "shared"));
      }
      return new Response("Not found", { status: 404 });
    }

    return new Response("Not found", { status: 404 });
  },
};

// The OAuth provider owns /authorize, /token, /register, the discovery docs, and the MCP API (/mcp).
// Everything else falls through to appRouter. Authenticated /mcp requests arrive with the Google
// user in `this.props` (set via completeAuthorization in ./auth).
export default new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler: EasyHostMCP.serve("/mcp") as any,
  defaultHandler: appRouter as any,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  scopesSupported: ["openid", "email", "profile"],
});
