// Composition root: HTTP routing, the per-request glue handlers, the OAuth provider entry point,
// and the Durable Object re-exports that wrangler binds.
import { getAgentByName } from "agents";
import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import type { Env, Site } from "./types";
import { genId, json, redirectTo } from "./util";
import {
  MAX_HTML_BYTES,
  accountOrigin,
  appHostId,
  appUrl,
  getSite,
  indexAddApp,
  indexRemoveApp,
  isBlocked,
  listOwnerApps,
  rateLimited,
  reserveAppSlot,
  serviceClosedReason,
  setBlocked,
  subdomainMode,
  userAppCapReached,
} from "./store";
import {
  clearSessionCookie,
  getSessionUser,
  handleAuthCallback,
  handleAuthLogin,
  handleAuthorize,
  handleAuthorizeCallback,
  mintAppToken,
  verifyAppToken,
} from "./auth";
import { manifest, serveApp, serveIcon, serveSW, serveSdk, serveSiteIcon, serveSiteSW, siteManifest } from "./pwa";
import { FAVICON_SVG, renderLanding, renderDashboard } from "./pages";
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
  if (crossOrigin(request, env)) return json({ error: "cross-origin request blocked" }, 403);
  const html = typeof payload.html === "string" ? payload.html : "";
  if (!html.trim()) return json({ error: "html is required" }, 400);
  if (html.length > MAX_HTML_BYTES) return json({ error: "html too large (max ~2 MB)" }, 413);

  const user = await getSessionUser(request, env);
  if (!user) return json({ error: "Sign in to publish.", login: "/auth/login" }, 401);

  const closed = serviceClosedReason(env);
  if (closed) return json({ error: closed }, 503);
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  if (await rateLimited(env, ip)) return json({ error: "Too many apps from this IP — try again later." }, 429);
  if (await userAppCapReached(env, user.id)) return json({ error: "You've reached your app limit. Delete one in your dashboard." }, 429);
  if (!(await reserveAppSlot(env))) return json({ error: "This public demo has reached its app limit — deploy your own instance to keep going." }, 503);

  const site: Site = {
    html,
    name: typeof payload.name === "string" ? payload.name.slice(0, 60) : undefined,
    theme_color: typeof payload.theme_color === "string" ? payload.theme_color.slice(0, 16) : undefined,
    owner: user.id,
    visibility: "private",
  };
  const id = genId();
  await env.SITES.put(id, JSON.stringify(site));
  await indexAddApp(env, user.id, id);
  return json({ id, url: appUrl(env, id) });
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
  if (request.method !== "GET" && crossOrigin(request, env)) return json({ error: "cross-origin request blocked" }, 403);
  const user = await getSessionUser(request, env);
  if (!user) return json({ error: "unauthorized" }, 401);
  if (sub === "" && request.method === "GET") return json({ email: user.email, apps: await listOwnerApps(env, user.id) });

  const mVis = sub.match(/^\/([A-Za-z0-9_-]+)\/visibility$/);
  if (mVis && request.method === "POST") {
    const site = await getSite(env, mVis[1]);
    if (!site || site.owner !== user.id) return json({ error: "not found" }, 404);
    const b = (await request.json().catch(() => ({}))) as { visibility?: string };
    if (b.visibility !== "private" && b.visibility !== "public") return json({ error: "bad visibility" }, 400);
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

// True if a browser request comes from an origin other than our account origin (CSRF guard).
function crossOrigin(request: Request, env: Env): boolean {
  const o = request.headers.get("Origin");
  return !!o && o !== accountOrigin(env);
}

// Operator takedown: POST {id} with Authorization: Bearer ADMIN_TOKEN.
async function handleAdmin(request: Request, env: Env, block: boolean): Promise<Response> {
  if (!env.ADMIN_TOKEN || request.headers.get("authorization") !== `Bearer ${env.ADMIN_TOKEN}`) return json({ error: "forbidden" }, 403);
  const b = (await request.json().catch(() => ({}))) as { id?: string };
  if (!b.id) return json({ error: "id required" }, 400);
  await setBlocked(env, b.id, block);
  return json({ ok: true, id: b.id, blocked: block });
}

// Serve a single hosted app. `sub` is the app-relative path ("/", "/sw.js", "/api/...", or any
// other path -> SPA fallback). Used for both the app subdomain and path-mode /s/:id/.
async function serveAppHost(request: Request, env: Env, id: string, sub: string, url: URL): Promise<Response> {
  if (await isBlocked(env, id)) return new Response("This app has been disabled.", { status: 410 });
  if (sub.startsWith("/api/")) return handleApi(request, env, id, sub.slice("/api/".length), url);
  if (sub === "/sw.js") return serveSW();
  if (sub === "/sdk.js") return serveSdk();
  if (sub === "/icon-192.png" || sub === "/icon-512.png" || sub === "/apple-touch-icon.png") {
    const size = sub === "/icon-512.png" ? 512 : sub === "/apple-touch-icon.png" ? 180 : 192;
    return serveIcon(size, await getSite(env, id));
  }
  const site = await getSite(env, id);
  if (!site) return new Response("Not found", { status: 404 });
  if (sub === "/manifest.webmanifest") return manifest(site);

  // HTML-serving: "/" or any unknown subpath (SPA fallback). Enforce private + mint a scoped token.
  if (request.method === "GET") {
    const u = await getSessionUser(request, env);
    if (site.visibility === "private" && (!u || u.id !== site.owner)) {
      return redirectTo(`${accountOrigin(env)}/auth/login?next=${encodeURIComponent(appUrl(env, id))}`);
    }
    return serveApp(site, await mintAppToken(env, id, u?.id || "shared"));
  }
  return new Response("Not found", { status: 404 });
}

// ---------- main app router (account host; the OAuth provider owns the MCP API) ----------
const appRouter: ExportedHandler<Env> = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // App subdomain host (<id>.<apex>) serves ONLY that app (isolated origin).
    const hostId = appHostId(env, url.hostname);
    if (hostId) return serveAppHost(request, env, hostId, path, url);

    // ---- account / site host (apex, *.workers.dev, localhost) ----
    if (path === "/authorize") return handleAuthorize(request, env);
    if (path === "/authorize/google-callback") return handleAuthorizeCallback(request, env);
    if (path === "/favicon.svg") {
      return new Response(FAVICON_SVG, { headers: { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "public, max-age=86400" } });
    }
    // The ship-it site itself is an installable PWA (rocket icon).
    if (path === "/manifest.webmanifest") return siteManifest();
    if (path === "/sw.js") return serveSiteSW();
    if (path === "/icon-192.png") return serveSiteIcon(192);
    if (path === "/icon-512.png") return serveSiteIcon(512);
    if (path === "/apple-touch-icon.png") return serveSiteIcon(180);
    if (path === "/auth/login") return handleAuthLogin(request, env);
    if (path === "/auth/callback") return handleAuthCallback(request, env);
    if (path === "/auth/logout") return redirectTo("/", clearSessionCookie(env));
    if (path === "/dashboard") return handleDashboard(request, env);
    if (path === "/api/apps") return handleAppsApi(request, env, "");
    if (path.startsWith("/api/apps/")) return handleAppsApi(request, env, path.slice("/api/apps".length));
    if ((path === "/admin/block" || path === "/admin/unblock") && request.method === "POST") return handleAdmin(request, env, path === "/admin/block");

    if (path === "/" && request.method === "GET") {
      return new Response(renderLanding(await getSessionUser(request, env)), { headers: { "content-type": "text/html;charset=utf-8" } });
    }
    if (path === "/api/create" && request.method === "POST") return handleCreate(request, env);

    // /s/:id/ : in subdomain mode redirect to the app subdomain; in path mode serve here.
    const m = path.match(/^\/s\/([A-Za-z0-9_-]+)(\/.*)?$/);
    if (m) {
      const id = m[1];
      const subRaw = m[2]; // undefined => no trailing slash
      if (subdomainMode(env) && /^[a-z0-9-]+$/.test(id)) {
        return redirectTo(`https://${id}.${new URL(accountOrigin(env)).hostname}${subRaw || "/"}`);
      }
      if (subRaw === undefined) return redirectTo(`${url.origin}/s/${id}/`); // path mode: enforce trailing slash
      return serveAppHost(request, env, id, subRaw, url);
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
