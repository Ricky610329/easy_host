// Generic, env-free helpers (crypto, encoding, signed tokens, small HTTP helpers).

// 8 random bytes -> 16-char lowercase hex. DNS-label-safe (usable as a subdomain) and
// case-insensitive; unguessable (64-bit) — the only access control on a raw app URL.
export function genId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let h = "";
  for (const b of bytes) h += b.toString(16).padStart(2, "0");
  return h;
}

export async function sha256hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function b64urlStr(str: string): string {
  return b64url(new TextEncoder().encode(str));
}
export function b64urlToStr(s: string): string {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return b64url(new Uint8Array(sig));
}
// Constant-time string compare (avoids leaking how many leading chars of an HMAC matched).
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false; // HMACs are fixed-length, so length isn't secret
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// payload.signature, where payload = base64url(JSON). exp (unix seconds) is enforced if present.
export async function signToken(secret: string, obj: Record<string, unknown>): Promise<string> {
  const p = b64urlStr(JSON.stringify(obj));
  return p + "." + (await hmac(secret, p));
}
export async function verifyToken<T>(secret: string, token: string | null): Promise<T | null> {
  if (!token) return null;
  const i = token.lastIndexOf(".");
  if (i < 0) return null;
  const p = token.slice(0, i);
  if (!timingSafeEqual(await hmac(secret, p), token.slice(i + 1))) return null;
  try {
    const obj = JSON.parse(b64urlToStr(p)) as T & { exp?: number };
    if (obj.exp && obj.exp < Math.floor(Date.now() / 1000)) return null;
    return obj;
  } catch {
    return null;
  }
}

// dailyAt ('HH:MM', the user's LOCAL time) + tzOffset (JS getTimezoneOffset, minutes) -> a UTC
// daily cron string. Fixed offset, so it can drift 1h across daylight-saving changes.
export function dailyAtToCron(dailyAt: string, tzOffset: number): string {
  const total = ((hhmmToMin(dailyAt) + (Number.isFinite(tzOffset) ? Math.trunc(tzOffset) : 0)) % 1440 + 1440) % 1440;
  return `${total % 60} ${Math.floor(total / 60)} * * *`;
}

// 'HH:MM' -> minutes since local midnight (0..1439).
export function hhmmToMin(s: string): number {
  const [h, m] = String(s).split(":");
  return ((Number(h) || 0) * 60 + (Number(m) || 0)) % 1440;
}

export function parseCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

export function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}
export function redirectTo(location: string, setCookie?: string): Response {
  const headers: Record<string, string> = { Location: location };
  if (setCookie) headers["Set-Cookie"] = setCookie;
  return new Response(null, { status: 302, headers });
}
export function safeJson(v: unknown): string {
  return JSON.stringify(v).replace(/</g, "\\u003c");
}
export function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
