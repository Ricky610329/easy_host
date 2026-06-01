// Google sign-in: web session (cookie) + the MCP connector OAuth flow, plus capability tokens.
import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import type { Env, SessionUser } from "./types";
import { b64url, parseCookie, redirectTo, signToken, verifyToken } from "./util";

export const SESSION_TTL = 60 * 60 * 24 * 30;
export const CLEAR_SESSION_COOKIE = "eh_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0";

function sessionCookie(value: string, maxAge: number): string {
  return `eh_session=${encodeURIComponent(value)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

async function signSession(env: Env, u: SessionUser): Promise<string> {
  return signToken(env.COOKIE_SECRET, { uid: u.id, email: u.email, exp: Math.floor(Date.now() / 1000) + SESSION_TTL });
}
export async function getSessionUser(request: Request, env: Env): Promise<SessionUser | null> {
  const claims = await verifyToken<{ uid: string; email: string }>(env.COOKIE_SECRET, parseCookie(request.headers.get("cookie"), "eh_session"));
  return claims ? { id: claims.uid, email: claims.email } : null;
}

// Capability token binding (user, app) — authorizes /s/:id/api/* (NOT the ambient cookie).
export async function mintAppToken(env: Env, appId: string, userId: string): Promise<string> {
  return signToken(env.CAP_SECRET, { a: appId, u: userId, exp: Math.floor(Date.now() / 1000) + 60 * 60 });
}
export async function verifyAppToken(env: Env, token: string | null): Promise<{ a: string; u: string } | null> {
  return verifyToken<{ a: string; u: string }>(env.CAP_SECRET, token);
}

// ---------- Google OAuth ----------
function googleAuthUrl(env: Env, redirectUri: string, state: string): string {
  const p = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state,
    prompt: "select_account",
  });
  return "https://accounts.google.com/o/oauth2/v2/auth?" + p.toString();
}
async function googleUserFromCode(env: Env, code: string, redirectUri: string): Promise<SessionUser | null> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) return null;
  const tok = (await res.json()) as { id_token?: string };
  if (!tok.id_token) return null;
  const parts = tok.id_token.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"))) as { sub?: string; email?: string };
    if (!payload.sub) return null;
    return { id: payload.sub, email: payload.email || "" };
  } catch {
    return null;
  }
}

// ---------- web session routes ----------
export async function handleAuthLogin(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const next = url.searchParams.get("next") || "/dashboard";
  const state = await signToken(env.COOKIE_SECRET, {
    next,
    n: b64url(crypto.getRandomValues(new Uint8Array(8))),
    exp: Math.floor(Date.now() / 1000) + 600,
  });
  return redirectTo(googleAuthUrl(env, `${url.origin}/auth/callback`, state));
}
export async function handleAuthCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const st = await verifyToken<{ next: string }>(env.COOKIE_SECRET, url.searchParams.get("state"));
  if (!code || !st) return new Response("Invalid OAuth state", { status: 400 });
  const user = await googleUserFromCode(env, code, `${url.origin}/auth/callback`);
  if (!user) return new Response("Google sign-in failed", { status: 400 });
  await env.SITES.put(`user:${user.id}`, JSON.stringify(user));
  const next = st.next && st.next.startsWith("/") ? st.next : "/dashboard";
  return redirectTo(next, sessionCookie(await signSession(env, user), SESSION_TTL));
}

// ---------- MCP connector OAuth (provider delegates /authorize here; Google is the upstream IdP) ----------
export async function handleAuthorize(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  let authReq: AuthRequest;
  try {
    authReq = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  } catch {
    return new Response("Invalid OAuth authorization request.", { status: 400 });
  }
  // Carry the parsed OAuth request through Google via signed state, then complete it on the way back.
  const state = await signToken(env.COOKIE_SECRET, { ar: authReq, exp: Math.floor(Date.now() / 1000) + 600 });
  return redirectTo(googleAuthUrl(env, `${url.origin}/authorize/google-callback`, state));
}
export async function handleAuthorizeCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const st = await verifyToken<{ ar: AuthRequest }>(env.COOKIE_SECRET, url.searchParams.get("state"));
  if (!code || !st?.ar) return new Response("Invalid OAuth state", { status: 400 });
  const user = await googleUserFromCode(env, code, `${url.origin}/authorize/google-callback`);
  if (!user) return new Response("Google sign-in failed", { status: 400 });
  await env.SITES.put(`user:${user.id}`, JSON.stringify(user));
  const { redirectTo: to } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: st.ar,
    userId: user.id,
    metadata: { email: user.email },
    scope: st.ar.scope,
    props: { id: user.id, email: user.email }, // becomes this.props in the McpAgent tools
  });
  return redirectTo(to);
}
