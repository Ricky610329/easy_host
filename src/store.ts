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
