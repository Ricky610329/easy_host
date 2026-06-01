// KV-backed app store, the hosted-demo kill-switch, and the per-owner app index.
import type { Env, Site } from "./types";

export const MAX_HTML_BYTES = 2_000_000; // hard cap on a published page (KV allows 25MiB, but bound abuse)

export async function getSite(env: Env, id: string): Promise<Site | null> {
  const raw = await env.SITES.get(id);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Site;
  } catch {
    return null;
  }
}

export function baseUrl(env: Env): string {
  return (env.PUBLIC_BASE_URL || "http://localhost:8787").replace(/\/+$/, "");
}
export function accountOrigin(env: Env): string {
  return baseUrl(env);
}
function apexHost(env: Env): string {
  try {
    return new URL(baseUrl(env)).hostname;
  } catch {
    return "localhost";
  }
}
// Subdomain isolation is on only for a real custom domain; workers.dev / localhost stay path-mode.
export function subdomainMode(env: Env): boolean {
  const h = apexHost(env);
  return !(h.endsWith(".workers.dev") || h === "localhost" || /^[0-9.]+$/.test(h));
}
// The public URL of an app: <id>.<apex> in subdomain mode, else <base>/s/<id>/.
export function appUrl(env: Env, id: string): string {
  return subdomainMode(env) ? `https://${id}.${apexHost(env)}/` : `${baseUrl(env)}/s/${id}/`;
}
// If hostname is a single-label app subdomain (<id>.<apex>), return the id, else null.
export function appHostId(env: Env, hostname: string): string | null {
  if (!subdomainMode(env)) return null;
  const apex = apexHost(env);
  if (hostname === apex || hostname === "www." + apex || !hostname.endsWith("." + apex)) return null;
  const label = hostname.slice(0, hostname.length - apex.length - 1);
  return /^[a-z0-9-]+$/.test(label) ? label : null;
}
// Share the session cookie across subdomains (so app subdomains can gate private apps); host-only in dev.
export function cookieDomainAttr(env: Env): string {
  return subdomainMode(env) ? `; Domain=${apexHost(env)}` : "";
}

// ---------- operator takedown (block an app id) ----------
export async function isBlocked(env: Env, id: string): Promise<boolean> {
  return (await env.SITES.get(`blocked:${id}`)) !== null;
}
export async function setBlocked(env: Env, id: string, on: boolean): Promise<void> {
  if (on) await env.SITES.put(`blocked:${id}`, "1");
  else await env.SITES.delete(`blocked:${id}`);
}

// ---------- hosted-demo gate (kill-switch + cap + rate limit) ----------
// All checks are no-ops unless the corresponding env var is set, so a self-hosted
// instance with none of these set behaves exactly as before (unrestricted).
const COUNT_KEY = "__count";
const RL_LIMIT = 10; // creates per IP per window
const RL_WINDOW = 600; // seconds

// Returns a human-readable reason if new publishing is currently closed, else null.
export function serviceClosedReason(env: Env): string | null {
  if (env.SERVICE_OPEN && env.SERVICE_OPEN.toLowerCase() === "false") return "This demo is currently closed.";
  if (env.SERVICE_OPEN_UNTIL) {
    const until = Date.parse(env.SERVICE_OPEN_UNTIL);
    if (!Number.isNaN(until) && Date.now() > until) return "This public demo window has ended — deploy your own instance to keep going.";
  }
  return null;
}

// ---------- whole-site hard close (cost auto-shutoff + manual kill) ----------
// Two independent flags in KV: "manual" (operator, via /admin/close) and "auto" (the budget cron).
// Either present => the whole site serves the "oops, too many users" page. Cached in isolate memory
// (~60s) so we don't read KV on every request (KV reads are themselves a free-plan budget).
const HC_MANUAL = "service:closed_manual";
const HC_AUTO = "service:closed_auto";
let hcCache: { at: number; closed: boolean } = { at: 0, closed: false };

export async function isServiceHardClosed(env: Env): Promise<boolean> {
  const now = Date.now();
  if (now - hcCache.at < 60_000) return hcCache.closed;
  const [m, a] = await Promise.all([env.SITES.get(HC_MANUAL), env.SITES.get(HC_AUTO)]);
  hcCache = { at: now, closed: m !== null || a !== null };
  return hcCache.closed;
}
// Operator switch: close sets the manual flag; open clears BOTH flags (force-reopen, overriding the cron).
export async function setServiceClosedManual(env: Env, on: boolean): Promise<void> {
  if (on) await env.SITES.put(HC_MANUAL, "1");
  else await Promise.all([env.SITES.delete(HC_MANUAL), env.SITES.delete(HC_AUTO)]);
  hcCache = { at: 0, closed: false }; // bust the cache so it takes effect immediately in this isolate
}
// The budget cron's switch: set/clear the auto flag without touching the operator's manual flag.
export async function setServiceClosedAuto(env: Env, on: boolean): Promise<void> {
  if (on) await env.SITES.put(HC_AUTO, "1");
  else await env.SITES.delete(HC_AUTO);
  hcCache = { at: 0, closed: false };
}

// Reserve one slot against MAX_APPS. No cap set => always allowed. (KV is not atomic;
// approximate counting is fine for a demo cap.)
export async function reserveAppSlot(env: Env): Promise<boolean> {
  const max = env.MAX_APPS ? parseInt(env.MAX_APPS, 10) : 0;
  if (!max) return true;
  const cur = parseInt((await env.SITES.get(COUNT_KEY)) || "0", 10);
  if (cur >= max) return false;
  await env.SITES.put(COUNT_KEY, String(cur + 1));
  return true;
}

// Simple per-IP rolling rate limit (only used on the public web form).
export async function rateLimited(env: Env, ip: string): Promise<boolean> {
  const key = `__rl:${ip}`;
  const cur = parseInt((await env.SITES.get(key)) || "0", 10);
  if (cur >= RL_LIMIT) return true;
  await env.SITES.put(key, String(cur + 1), { expirationTtl: RL_WINDOW });
  return false;
}

// Per-account app cap. No cap set => unlimited.
export async function userAppCapReached(env: Env, owner: string): Promise<boolean> {
  const max = env.MAX_APPS_PER_USER ? parseInt(env.MAX_APPS_PER_USER, 10) : 0;
  if (!max) return false;
  const arr = JSON.parse((await env.SITES.get(`owner:${owner}`)) || "[]") as string[];
  return arr.length >= max;
}

// ---------- per-owner app index (SITES is keyed by app id; this maps owner -> app ids) ----------
export async function indexAddApp(env: Env, owner: string, appId: string): Promise<void> {
  const key = `owner:${owner}`;
  const arr = JSON.parse((await env.SITES.get(key)) || "[]") as string[];
  if (!arr.includes(appId)) {
    arr.push(appId);
    await env.SITES.put(key, JSON.stringify(arr));
  }
}
export async function indexRemoveApp(env: Env, owner: string, appId: string): Promise<void> {
  const key = `owner:${owner}`;
  const arr = JSON.parse((await env.SITES.get(key)) || "[]") as string[];
  await env.SITES.put(key, JSON.stringify(arr.filter((x) => x !== appId)));
}
export async function listOwnerApps(env: Env, owner: string): Promise<{ id: string; name?: string; visibility: string }[]> {
  const arr = JSON.parse((await env.SITES.get(`owner:${owner}`)) || "[]") as string[];
  const out: { id: string; name?: string; visibility: string }[] = [];
  for (const id of arr) {
    const s = await getSite(env, id);
    if (s) out.push({ id, name: s.name, visibility: s.visibility === "private" ? "private" : "public" });
  }
  return out;
}
