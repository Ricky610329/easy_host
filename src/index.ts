import { McpAgent } from "agents/mcp";
import { Agent, getAgentByName } from "agents";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { buildPushHTTPRequest } from "@pushforge/builder";

interface Env {
  SITES: KVNamespace;
  MCP_OBJECT: DurableObjectNamespace;
  APP_OBJECT: DurableObjectNamespace<AppBackend>;
  PUBLIC_BASE_URL?: string;
  VAPID_PUBLIC_KEY: string;
  VAPID_PRIVATE_JWK: string;
  VAPID_SUBJECT: string;
  // Hosted-demo kill-switch (all optional; unset => unrestricted, so self-hosters are unaffected).
  SERVICE_OPEN?: string; // "false" closes new publishing
  SERVICE_OPEN_UNTIL?: string; // ISO timestamp; publishing closes after it
  MAX_APPS?: string; // numeric cap on total published apps
}

interface Site {
  html: string;
  name?: string;
  theme_color?: string;
}

const DEFAULT_NAME = "App";
const DEFAULT_THEME = "#4f46e5";
const PUSH_TTL = 3600;
const MAX_VALUE_BYTES = 64 * 1024;

// ---------- helpers ----------
// 9 random bytes -> 12-char base64url. Unguessable: the only access control in this POC.
function genId(): string {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function getSite(env: Env, id: string): Promise<Site | null> {
  const raw = await env.SITES.get(id);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Site;
  } catch {
    return null;
  }
}

function baseUrl(env: Env): string {
  return (env.PUBLIC_BASE_URL || "http://localhost:8787").replace(/\/+$/, "");
}

// ---------- hosted-demo gate (kill-switch + cap + rate limit) ----------
// All checks are no-ops unless the corresponding env var is set, so a self-hosted
// instance with none of these set behaves exactly as before (unrestricted).
const COUNT_KEY = "__count";
const RL_LIMIT = 10; // creates per IP per window
const RL_WINDOW = 600; // seconds

// Returns a human-readable reason if new publishing is currently closed, else null.
function serviceClosedReason(env: Env): string | null {
  if (env.SERVICE_OPEN && env.SERVICE_OPEN.toLowerCase() === "false") return "This demo is currently closed.";
  if (env.SERVICE_OPEN_UNTIL) {
    const until = Date.parse(env.SERVICE_OPEN_UNTIL);
    if (!Number.isNaN(until) && Date.now() > until) return "This public demo window has ended — deploy your own instance to keep going.";
  }
  return null;
}

// Reserve one slot against MAX_APPS. No cap set => always allowed. (KV is not atomic;
// approximate counting is fine for a demo cap.)
async function reserveAppSlot(env: Env): Promise<boolean> {
  const max = env.MAX_APPS ? parseInt(env.MAX_APPS, 10) : 0;
  if (!max) return true;
  const cur = parseInt((await env.SITES.get(COUNT_KEY)) || "0", 10);
  if (cur >= max) return false;
  await env.SITES.put(COUNT_KEY, String(cur + 1));
  return true;
}

// Simple per-IP rolling rate limit (only used on the public web form).
async function rateLimited(env: Env, ip: string): Promise<boolean> {
  const key = `__rl:${ip}`;
  const cur = parseInt((await env.SITES.get(key)) || "0", 10);
  if (cur >= RL_LIMIT) return true;
  await env.SITES.put(key, String(cur + 1), { expirationTtl: RL_WINDOW });
  return false;
}

// Cheap heuristics surfaced back to the AI so it can self-correct via update_app.
function lint(html: string): string[] {
  const w: string[] = [];
  if (/<script[^>]+src=["']https?:/i.test(html)) w.push("External <script src> will not load offline — inline the code instead.");
  if (/<link[^>]+href=["']https?:/i.test(html)) w.push("External <link> (CSS/font) breaks offline — inline your CSS and use system fonts.");
  if (/<img[^>]+src=["']https?:/i.test(html)) w.push("External <img> will not show offline — embed images as data URIs or inline SVG.");
  if (html.length > 1_500_000) w.push("App HTML is very large (>1.5MB) — consider trimming.");
  if (/localStorage\./.test(html) && !/easyhost\.data/.test(html))
    w.push("Uses localStorage but not easyhost.data — localStorage is wiped on reinstall; use easyhost.data for durable storage.");
  return w;
}

function warnText(w: string[]): string {
  return w.length ? "\n\nLint warnings (you can fix these with update_app):\n- " + w.join("\n- ") : "";
}

// ---------- per-app backend: data store + push subscriptions + scheduled notifications ----------
type ApiResult = { status: number; json: unknown };

export class AppBackend extends Agent<Env> {
  private schemaReady = false;

  private ensure() {
    if (this.schemaReady) return;
    this.sql`CREATE TABLE IF NOT EXISTS subs (id TEXT PRIMARY KEY, ns TEXT, endpoint TEXT, p256dh TEXT, auth TEXT, created INTEGER)`;
    this.sql`CREATE TABLE IF NOT EXISTS kv (ns TEXT, k TEXT, v TEXT, updated INTEGER, PRIMARY KEY (ns, k))`;
    this.schemaReady = true;
  }

  // Single RPC entrypoint the Worker forwards /s/:id/api/* calls to.
  async apiCall(method: string, path: string, query: Record<string, string>, body: any, appId: string): Promise<ApiResult> {
    this.ensure();
    const ns = "shared"; // POC: one shared bucket per app (ns column kept for future per-user mode)
    try {
      if (path === "config" && method === "GET") {
        return { status: 200, json: { vapidPublicKey: this.env.VAPID_PUBLIC_KEY || "", appId, userId: ns } };
      }
      if (path === "subscribe" && method === "POST") {
        const sub = body?.subscription;
        if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) return { status: 400, json: { error: "bad subscription" } };
        const id = await sha256hex(sub.endpoint);
        this.sql`INSERT OR REPLACE INTO subs (id, ns, endpoint, p256dh, auth, created) VALUES (${id}, ${ns}, ${sub.endpoint}, ${sub.keys.p256dh}, ${sub.keys.auth}, ${Date.now()})`;
        return { status: 200, json: { ok: true } };
      }
      if (path === "unsubscribe" && method === "POST") {
        if (body?.endpoint) {
          const id = await sha256hex(body.endpoint);
          this.sql`DELETE FROM subs WHERE id = ${id}`;
        }
        return { status: 200, json: { ok: true } };
      }
      if (path === "notify" && method === "POST") {
        return { status: 200, json: { sent: await this.sendToAll(ns, body || {}) } };
      }
      if (path === "reminders" && method === "POST") {
        return { status: 200, json: { id: await this.scheduleReminder(ns, body || {}) } };
      }
      if (path === "reminders" && method === "GET") {
        return { status: 200, json: { items: await this.listReminders(ns) } };
      }
      if (path.startsWith("reminders/") && method === "DELETE") {
        await this.cancelSchedule(decodeURIComponent(path.slice("reminders/".length)));
        return { status: 200, json: { ok: true } };
      }
      if (path === "data" && method === "GET") {
        const rows = this.sql<{ v: string }>`SELECT v FROM kv WHERE ns = ${ns} AND k = ${query.key || ""}`;
        return { status: 200, json: { value: rows.length ? JSON.parse(rows[0].v) : null } };
      }
      if (path === "data" && method === "PUT") {
        const k = String(body?.key ?? "");
        if (!k) return { status: 400, json: { error: "key required" } };
        const v = JSON.stringify(body?.value ?? null);
        if (v.length > MAX_VALUE_BYTES) return { status: 413, json: { error: "value too large" } };
        this.sql`INSERT OR REPLACE INTO kv (ns, k, v, updated) VALUES (${ns}, ${k}, ${v}, ${Date.now()})`;
        return { status: 200, json: { ok: true } };
      }
      if (path === "data" && method === "DELETE") {
        this.sql`DELETE FROM kv WHERE ns = ${ns} AND k = ${query.key || ""}`;
        return { status: 200, json: { ok: true } };
      }
      if (path === "data/list" && method === "GET") {
        const rows = query.prefix
          ? this.sql<{ k: string; v: string }>`SELECT k, v FROM kv WHERE ns = ${ns} AND k LIKE ${query.prefix + "%"} ORDER BY k`
          : this.sql<{ k: string; v: string }>`SELECT k, v FROM kv WHERE ns = ${ns} ORDER BY k`;
        return { status: 200, json: { items: rows.map((r) => ({ key: r.k, value: JSON.parse(r.v) })) } };
      }
      return { status: 404, json: { error: "not found" } };
    } catch (e) {
      return { status: 500, json: { error: String((e as Error)?.message || e) } };
    }
  }

  private async scheduleReminder(ns: string, b: any): Promise<string> {
    const payload = { ns, title: String(b.title || "Reminder"), body: String(b.body || ""), url: b.url ? String(b.url) : "./" };
    if (b.everyMinutes) {
      const sec = Math.max(60, Math.round(Number(b.everyMinutes) * 60));
      return (await this.scheduleEvery(sec, "fireReminder" as keyof this, payload)).id;
    }
    if (b.dailyAt) {
      const [h, m] = String(b.dailyAt).split(":");
      return (await this.schedule(`${Number(m) || 0} ${Number(h) || 0} * * *`, "fireReminder" as keyof this, payload)).id;
    }
    if (b.at) {
      const when = typeof b.at === "number" ? new Date(b.at) : new Date(String(b.at));
      return (await this.schedule(when, "fireReminder" as keyof this, payload)).id;
    }
    throw new Error("reminder needs one of: at, everyMinutes, dailyAt");
  }

  private async listReminders(ns: string) {
    const all = await this.listSchedules();
    return all
      .filter((s: any) => s.payload && s.payload.ns === ns)
      .map((s: any) => ({ id: s.id, title: s.payload.title, body: s.payload.body, type: s.type, time: s.time ?? null, cron: s.cron ?? null }));
  }

  // Alarm callback (must be public so this.schedule can invoke it by name).
  async fireReminder(payload: { ns: string; title: string; body: string; url: string }) {
    this.ensure();
    await this.sendToAll(payload.ns, payload);
  }

  private async sendToAll(ns: string, msg: any): Promise<number> {
    const subs = this.sql<{ id: string; endpoint: string; p256dh: string; auth: string }>`SELECT id, endpoint, p256dh, auth FROM subs WHERE ns = ${ns}`;
    let sent = 0;
    for (const s of subs) if (await this.sendOne(s, msg)) sent++;
    return sent;
  }

  private async sendOne(s: { id: string; endpoint: string; p256dh: string; auth: string }, msg: any): Promise<boolean> {
    try {
      const req = await buildPushHTTPRequest({
        privateJWK: this.env.VAPID_PRIVATE_JWK,
        subscription: { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        message: {
          payload: { title: String(msg.title || "Reminder").slice(0, 120), body: String(msg.body || "").slice(0, 300), url: msg.url || "./" },
          adminContact: this.env.VAPID_SUBJECT || "mailto:admin@example.com",
          options: { ttl: PUSH_TTL, urgency: "high" },
        },
      });
      const res = await fetch(req.endpoint, { method: "POST", headers: req.headers as HeadersInit, body: req.body });
      if (res.status === 404 || res.status === 410) {
        this.sql`DELETE FROM subs WHERE id = ${s.id}`;
        return false;
      }
      return res.ok;
    } catch {
      return false;
    }
  }
}

// ---------- the build guide handed to the AI (no backticks: this is a template literal) ----------
const BUILD_GUIDE = [
  "# easy_host — how to build a great app",
  "",
  "You are generating ONE self-contained HTML page. easy_host hosts it, makes it an installable PWA,",
  "and gives it a backend: persistent data (easyhost.data) and real push notifications (easyhost.notify),",
  "including scheduled and recurring reminders that fire even when the app is closed. Build for a phone.",
  "",
  "## 1. Hard constraints (offline is a feature)",
  "- Output ONE complete <!doctype html> document. Put ALL CSS in a <style> tag and ALL JS in <script> tags, inline.",
  "- NO external resources: no CDN scripts, no Google Fonts, no external <link>/<script src>/<img src=\"http...\">. The app must work offline after first load.",
  "- Embed any images/sounds as data: URIs; prefer inline SVG and CSS gradients over raster images.",
  "- No build step, no bundler-dependent frameworks. Vanilla JS (or a tiny library pasted in full) only.",
  "",
  "## 2. Already injected for you — do NOT add these",
  "- Viewport meta, theme-color, web app manifest, apple-touch meta/icon, app icons, and the service worker (registered for you).",
  "- The easyhost SDK (sdk.js) — window.easyhost is available. Do not write your own manifest, icons, or register a service worker.",
  "",
  "## 3. Mobile / PWA UX (this is what makes it feel like a real app)",
  "- Use 100dvh, not 100vh (mobile URL bar resizes the viewport).",
  "- Respect safe areas: add padding using env(safe-area-inset-top) / -bottom / -left / -right; keep bottom bars above the home indicator.",
  "- Touch targets at least 44x44 px; space controls for thumbs. No hover-only interactions — everything works on tap.",
  "- Design for standalone (no browser chrome): provide your own header / back navigation; never rely on the address bar.",
  "- Show an 'Add to Home Screen' hint ONLY when not installed: check easyhost.notify.installed (false = still in browser).",
  "- Set -webkit-tap-highlight-color, disable text selection on buttons, and use overscroll-behavior to avoid rubber-banding where appropriate.",
  "",
  "## 4. Data (use easyhost.data, not just localStorage)",
  "- await easyhost.ready first. Then: await easyhost.data.set(key, value) / get(key) / delete(key) / list(prefix?).",
  "- Values are any JSON. Keys are strings. easyhost.data survives reinstall; localStorage does not — use localStorage only as an offline cache.",
  "- Pattern: render immediately, load from easyhost.data after ready, write through on every change.",
  "",
  "## 5. Notifications (the headline feature)",
  "- Gate behind a user gesture: call easyhost.notify.enable() ONLY inside a click handler, after briefly explaining why.",
  "- enable() requests permission and subscribes. Check easyhost.notify.permission ('default'|'granted'|'denied') and handle 'denied' gracefully.",
  "- iOS REQUIREMENT: push only works after the user installs the app to the Home Screen and opens it from the icon (iOS 16.4+). It does NOT work in a Safari tab.",
  "  - So: if easyhost.notify.installed === false, hide the Enable button and instead show 'Add to Home Screen, then open from the icon to turn on reminders.'",
  "- Kinds of notification:",
  "  - Immediate test:   easyhost.notify.sendNow({ title, body })",
  "  - One-off at a time: easyhost.notify.schedule({ title, body, at })          // at = epoch ms or ISO string",
  "  - Recurring:         easyhost.notify.every({ title, body, everyMinutes })   // e.g. every 120 minutes",
  "  -                    easyhost.notify.every({ title, body, dailyAt: '08:30' }) // every day at a local-ish time (UTC cron)",
  "  - Manage: easyhost.notify.list() and easyhost.notify.cancel(id).",
  "- Keep title+body short (a notification, not an essay).",
  "",
  "## 6. Design quality",
  "- One restrained accent color + neutrals; consistent 4/8px spacing rhythm; clear hierarchy.",
  "- Use the system font stack (system-ui, -apple-system, Segoe UI, Roboto, sans-serif) so it feels native and needs no download.",
  "- Support dark mode via prefers-color-scheme and set a matching theme color. Respect prefers-reduced-motion.",
  "",
  "## 7. Before you publish — checklist",
  "- Single file, everything inline, zero external URLs?",
  "- Uses easyhost.data for anything worth keeping?",
  "- Notifications behind a button + an install check, with iOS guidance?",
  "- 100dvh + safe-area padding + 44px touch targets?",
  "- Then call publish_app. To revise later, call update_app with the SAME id (keeps the user's data, reminders, and home-screen icon).",
].join("\n");

// ---------- MCP server: the connector AI assistants call ----------
export class EasyHostMCP extends McpAgent<Env> {
  server = new McpServer(
    { name: "easy_host", version: "0.2.0" },
    {
      instructions:
        "easy_host hosts web apps so the user can install them on their phone, with a backend for persistent " +
        "data and real push notifications (including scheduled/recurring reminders). " +
        "BEFORE generating any app, call get_build_guide once and follow it. Apps get auto-injected PWA tags plus a " +
        "global `easyhost` SDK (easyhost.data for storage, easyhost.notify for notifications) — use them; do not add your own " +
        "manifest/service worker. Generate a COMPLETE self-contained HTML document and call publish_app; it returns an id. " +
        "To revise an existing app, call update_app with that id (this preserves the user's saved data, reminders, and home-screen icon) " +
        "— do NOT call publish_app again for edits. Then give the user the URL and tell them to Add to Home Screen.",
    }
  );

  async init() {
    this.server.resource("build-guide", "easyhost://guide", async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/markdown", text: BUILD_GUIDE }],
    }));

    this.server.tool(
      "get_build_guide",
      "Return easy_host's app-building guide: platform constraints, the easyhost.data / easyhost.notify SDK, mobile PWA best practices, and design guidance. Call this BEFORE generating an app.",
      {},
      async () => ({ content: [{ type: "text", text: BUILD_GUIDE }] })
    );

    this.server.tool(
      "publish_app",
      "Publish a NEW self-contained web app so the user can open it on their phone and install it as an app (PWA), with data + notifications. " +
        "Call get_build_guide first. Returns an id and URL. Use update_app (not publish_app) to revise an existing app.",
      {
        html: z
          .string()
          .describe(
            "The COMPLETE, standalone HTML document. ALL CSS and JS inline; no external files. A viewport, manifest, service " +
              "worker, icons, and the `easyhost` SDK are injected automatically — do not add them. Follow get_build_guide."
          ),
        name: z.string().optional().describe("Short app name on the home screen (e.g. 'Water Reminder'). Under ~30 chars."),
        theme_color: z.string().optional().describe("Theme color hex, e.g. '#4f46e5'."),
      },
      async ({ html, name, theme_color }) => {
        if (!html || !html.trim()) return { content: [{ type: "text", text: "Error: html is empty." }], isError: true };
        const closed = serviceClosedReason(this.env);
        if (closed) return { content: [{ type: "text", text: closed }], isError: true };
        if (!(await reserveAppSlot(this.env)))
          return { content: [{ type: "text", text: "This public demo has reached its app limit — deploy your own instance to keep going." }], isError: true };
        const site: Site = { html, name: name?.slice(0, 60), theme_color: theme_color?.slice(0, 16) };
        const id = genId();
        await this.env.SITES.put(id, JSON.stringify(site));
        const url = `${baseUrl(this.env)}/s/${id}/`;
        return {
          content: [
            {
              type: "text",
              text:
                `Published. id: ${id}\nInstallable app URL: ${url}\n\n` +
                `Tell the user to open this link on their phone, then Add to Home Screen (iOS Safari) / Install (Android Chrome).\n` +
                `To revise this app later, call update_app with id "${id}" — that keeps the user's data, reminders, and icon.` +
                warnText(lint(html)),
            },
          ],
        };
      }
    );

    this.server.tool(
      "update_app",
      "Revise an EXISTING app in place (same id, URL, icon, saved data, and reminders are preserved). Use this for every edit after publish_app.",
      {
        id: z.string().describe("The app id returned by publish_app."),
        html: z.string().describe("The new complete self-contained HTML document (replaces the old one)."),
        name: z.string().optional().describe("Optional new app name."),
        theme_color: z.string().optional().describe("Optional new theme color hex."),
      },
      async ({ id, html, name, theme_color }) => {
        if (!html || !html.trim()) return { content: [{ type: "text", text: "Error: html is empty." }], isError: true };
        const closed = serviceClosedReason(this.env);
        if (closed) return { content: [{ type: "text", text: closed }], isError: true };
        const existing = await getSite(this.env, id);
        if (!existing) return { content: [{ type: "text", text: `Error: no app with id "${id}". Use publish_app to create one.` }], isError: true };
        const site: Site = { html, name: name ?? existing.name, theme_color: theme_color ?? existing.theme_color };
        await this.env.SITES.put(id, JSON.stringify(site));
        const url = `${baseUrl(this.env)}/s/${id}/`;
        return {
          content: [
            {
              type: "text",
              text:
                `Updated app ${id}. URL (unchanged): ${url}\n` +
                `The user's saved data, reminders, and home-screen icon are preserved. They get the new version next time they open it.` +
                warnText(lint(html)),
            },
          ],
        };
      }
    );
  }
}

// ---------- PWA injection ----------
function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Relative URLs only, so the same block works for every site id under /s/:id/.
function injectBlock(name: string, theme: string): string {
  const t = escapeAttr(theme);
  const n = escapeAttr(name);
  return (
    `<base href="./">` +
    `<link rel="manifest" href="manifest.webmanifest">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">` +
    `<meta name="theme-color" content="${t}">` +
    `<meta name="mobile-web-app-capable" content="yes">` +
    `<meta name="apple-mobile-web-app-capable" content="yes">` +
    `<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">` +
    `<meta name="apple-mobile-web-app-title" content="${n}">` +
    `<link rel="apple-touch-icon" href="apple-touch-icon.png">` +
    `<script src="sdk.js"></script>` +
    `<script>if('serviceWorker' in navigator)addEventListener('load',function(){navigator.serviceWorker.register('sw.js',{scope:'./'})});</script>`
  );
}

function serveApp(site: Site): Response {
  const block = injectBlock(site.name || DEFAULT_NAME, site.theme_color || DEFAULT_THEME);
  const html = site.html;
  const lower = html.toLowerCase();
  const headers = { "content-type": "text/html;charset=utf-8" };

  if (lower.includes("<head")) {
    // Prepend our PWA tags as the first children of <head> so our <base> and SDK load first.
    return new HTMLRewriter()
      .on("head", {
        element(el) {
          el.prepend(block, { html: true });
        },
      })
      .transform(new Response(html, { headers }));
  }
  let out: string;
  if (lower.includes("<html")) {
    out = html.replace(/<html[^>]*>/i, (m) => `${m}<head>${block}</head>`);
  } else {
    out = `<!doctype html><head>${block}</head>${html}`;
  }
  return new Response(out, { headers });
}

// ---------- manifest ----------
function manifest(site: Site): Response {
  const name = site.name || DEFAULT_NAME;
  const body = {
    name,
    short_name: name.slice(0, 12),
    start_url: "./",
    scope: "./",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: site.theme_color || DEFAULT_THEME,
    icons: [
      { src: "icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/manifest+json; charset=utf-8" },
  });
}

// ---------- service worker (shared by all apps; served at /s/:id/sw.js) ----------
const SW_JS = `const CACHE='easy-host-v2';
self.addEventListener('install',function(){self.skipWaiting()});
self.addEventListener('activate',function(e){
  e.waitUntil(caches.keys().then(function(keys){
    return Promise.all(keys.filter(function(k){return k!==CACHE}).map(function(k){return caches.delete(k)}));
  }).then(function(){return self.clients.claim()}));
});
self.addEventListener('fetch',function(e){
  if(e.request.method!=='GET')return;
  var p=new URL(e.request.url).pathname;
  if(p.indexOf('/api/')!==-1)return; // never cache the data/notify API
  e.respondWith(
    fetch(e.request).then(function(res){
      var copy=res.clone();
      caches.open(CACHE).then(function(c){c.put(e.request,copy)});
      return res;
    }).catch(function(){
      return caches.match(e.request).then(function(r){return r||caches.match('./')});
    })
  );
});
self.addEventListener('push',function(e){
  var d={};
  try{d=e.data?e.data.json():{}}catch(_){d={body:e.data?e.data.text():''}}
  e.waitUntil(self.registration.showNotification(d.title||'Reminder',{
    body:d.body||'', data:{url:d.url||'./'}, icon:'icon-192.png', badge:'icon-192.png'
  }));
});
self.addEventListener('notificationclick',function(e){
  e.notification.close();
  var target=(e.notification.data&&e.notification.data.url)||'./';
  e.waitUntil(self.clients.matchAll({type:'window'}).then(function(list){
    for(var i=0;i<list.length;i++){if('focus' in list[i])return list[i].focus()}
    if(self.clients.openWindow)return self.clients.openWindow(target);
  }));
});`;

function serveSW(): Response {
  return new Response(SW_JS, { headers: { "content-type": "text/javascript; charset=utf-8" } });
}

// ---------- injected client SDK (window.easyhost), served at /s/:id/sdk.js ----------
const SDK_JS = `(function(){
  var cfg=null, resolveReady;
  var ready=new Promise(function(r){resolveReady=r});
  function api(method,path,opts){
    opts=opts||{};
    var init={method:method,headers:{}};
    if(opts.body!==undefined){init.headers['content-type']='application/json';init.body=JSON.stringify(opts.body)}
    var q=opts.query?('?'+new URLSearchParams(opts.query)):'';
    return fetch('api/'+path+q,init).then(function(r){return r.json()});
  }
  function b64ToU8(s){
    var pad='='.repeat((4-s.length%4)%4);
    var b=(s+pad).replace(/-/g,'+').replace(/_/g,'/');
    var raw=atob(b), arr=new Uint8Array(raw.length);
    for(var i=0;i<raw.length;i++)arr[i]=raw.charCodeAt(i);
    return arr;
  }
  var notify={
    get permission(){return (typeof Notification!=='undefined')?Notification.permission:'denied'},
    get installed(){return (window.matchMedia&&window.matchMedia('(display-mode: standalone)').matches)||window.navigator.standalone===true},
    enable:async function(){
      if(!('serviceWorker' in navigator)||!('PushManager' in window))throw new Error('Push not supported here');
      var perm=await Notification.requestPermission();
      if(perm!=='granted')throw new Error('Permission '+perm);
      var reg=await navigator.serviceWorker.ready;
      var sub=await reg.pushManager.getSubscription();
      if(!sub){
        if(!cfg||!cfg.vapidPublicKey)throw new Error('Server is missing its VAPID key');
        sub=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:b64ToU8(cfg.vapidPublicKey)});
      }
      await api('POST','subscribe',{body:{subscription:sub.toJSON()}});
      return true;
    },
    disable:async function(){
      var reg=await navigator.serviceWorker.ready;
      var sub=await reg.pushManager.getSubscription();
      if(sub){await api('POST','unsubscribe',{body:{endpoint:sub.endpoint}});await sub.unsubscribe()}
      return true;
    },
    sendNow:function(m){return api('POST','notify',{body:m})},
    schedule:function(m){return api('POST','reminders',{body:m})},
    every:function(m){return api('POST','reminders',{body:m})},
    list:function(){return api('GET','reminders').then(function(r){return r.items})},
    cancel:function(id){return api('DELETE','reminders/'+encodeURIComponent(id))}
  };
  var data={
    get:function(k){return api('GET','data',{query:{key:k}}).then(function(r){return r.value})},
    set:function(k,v){return api('PUT','data',{body:{key:k,value:v}})},
    delete:function(k){return api('DELETE','data',{query:{key:k}})},
    list:function(prefix){return api('GET','data/list',{query:prefix?{prefix:prefix}:{}}).then(function(r){return r.items})}
  };
  window.easyhost={ready:ready,user:{id:null},notify:notify,data:data};
  api('GET','config').then(function(c){cfg=c;window.easyhost.user.id=c.userId||'shared';resolveReady()}).catch(function(){resolveReady()});
})();`;

function serveSdk(): Response {
  return new Response(SDK_JS, {
    headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=300" },
  });
}

// ---------- PNG icon generation (solid color, generated at runtime) ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const body = new Uint8Array(typeBytes.length + data.length);
  body.set(typeBytes, 0);
  body.set(data, typeBytes.length);
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set(body, 4);
  dv.setUint32(8 + data.length, crc32(body));
  return out;
}

async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream("deflate"); // zlib (RFC 1950) wrapper, as PNG IDAT requires
  const w = cs.writable.getWriter();
  void w.write(data);
  void w.close();
  const buf = await new Response(cs.readable).arrayBuffer();
  return new Uint8Array(buf);
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const v = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(v.slice(0, 6) || "4f46e5", 16);
  if (Number.isNaN(n)) return [0x4f, 0x46, 0xe5];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

async function makePng(size: number, color: string): Promise<Uint8Array> {
  const [r, g, b] = hexToRgb(color);
  const rowLen = 1 + size * 3;
  const raw = new Uint8Array(rowLen * size);
  for (let y = 0; y < size; y++) {
    const off = y * rowLen;
    raw[off] = 0;
    for (let x = 0; x < size; x++) {
      const p = off + 1 + x * 3;
      raw[p] = r;
      raw[p + 1] = g;
      raw[p + 2] = b;
    }
  }
  const idat = await deflate(raw);

  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, size);
  dv.setUint32(4, size);
  ihdr[8] = 8;
  ihdr[9] = 2;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const chunks = [sig, pngChunk("IHDR", ihdr), pngChunk("IDAT", idat), pngChunk("IEND", new Uint8Array(0))];
  const total = chunks.reduce((a, c) => a + c.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

const iconCache = new Map<number, Promise<Uint8Array>>();
function getIcon(size: number): Promise<Uint8Array> {
  let p = iconCache.get(size);
  if (!p) {
    p = makePng(size, DEFAULT_THEME);
    iconCache.set(size, p);
  }
  return p;
}

async function serveIcon(size: number): Promise<Response> {
  const png = await getIcon(size);
  return new Response(png.slice(), {
    headers: { "content-type": "image/png", "cache-control": "public, max-age=31536000, immutable" },
  });
}

// ---------- manual upload UI (universal fallback) ----------
const LANDING = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>easy_host</title>
<style>
  :root{--bg:#0b0b10;--fg:#e7e7ee;--mut:#9aa0b0;--ac:#4f46e5}
  *{box-sizing:border-box}
  body{margin:0;font:16px/1.5 system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--fg);display:flex;justify-content:center;padding:32px 16px}
  main{width:100%;max-width:640px}
  h1{font-size:24px;margin:0 0 4px}
  p.sub{color:var(--mut);margin:0 0 24px}
  label{display:block;font-size:13px;color:var(--mut);margin:16px 0 6px}
  textarea,input[type=text]{width:100%;background:#15151d;border:1px solid #2a2a36;color:var(--fg);border-radius:10px;padding:12px;font:inherit}
  textarea{min-height:220px;font-family:ui-monospace,monospace;font-size:13px;resize:vertical}
  .row{display:flex;gap:12px}.row>*{flex:1}
  button{margin-top:20px;width:100%;background:var(--ac);color:#fff;border:0;border-radius:10px;padding:14px;font:inherit;font-weight:600;cursor:pointer}
  button:disabled{opacity:.5;cursor:default}
  #out{margin-top:20px;padding:16px;background:#15151d;border:1px solid #2a2a36;border-radius:10px;display:none}
  #out.show{display:block}
  #link{word-break:break-all;color:#a5b4fc;margin:6px 0}
  .hint{font-size:13px;color:var(--mut);margin-top:8px}
  input[type=file]{color:var(--mut);font-size:13px;margin-top:10px}
</style>
</head>
<body>
<main>
  <h1>easy_host</h1>
  <p class="sub">Paste AI-generated HTML, get an installable phone-app link.</p>
  <div class="row">
    <div><label>App name (optional)</label><input id="name" type="text" placeholder="My App"></div>
    <div><label>Theme color (optional)</label><input id="theme" type="text" placeholder="#4f46e5"></div>
  </div>
  <label>HTML — paste below, or choose a .html file</label>
  <textarea id="html" placeholder="<!doctype html>..."></textarea>
  <input id="file" type="file" accept=".html,text/html">
  <button id="go">Create app link</button>
  <div id="out">
    <div>Your app is live at:</div>
    <a id="link" href="#"></a>
    <button id="copy" style="margin-top:8px">Copy link</button>
    <p class="hint">Open this link on your phone, then <b>Add to Home Screen</b> (iOS Safari) or <b>Install</b> (Android Chrome).</p>
  </div>
</main>
<script>
var $=function(id){return document.getElementById(id)};
$('file').addEventListener('change',function(e){
  var f=e.target.files[0];if(!f)return;
  var r=new FileReader();r.onload=function(){$('html').value=r.result};r.readAsText(f);
});
$('go').addEventListener('click',async function(){
  var html=$('html').value.trim();
  if(!html){alert('Paste some HTML first.');return}
  $('go').disabled=true;$('go').textContent='Creating...';
  try{
    var res=await fetch('/api/create',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({html:html,name:$('name').value.trim()||undefined,theme_color:$('theme').value.trim()||undefined})});
    var data=await res.json();
    if(!res.ok)throw new Error(data.error||'failed');
    $('link').textContent=data.url;$('link').href=data.url;
    $('out').classList.add('show');
  }catch(err){alert('Error: '+err.message)}
  finally{$('go').disabled=false;$('go').textContent='Create app link'}
});
$('copy').addEventListener('click',function(){
  navigator.clipboard.writeText($('link').textContent);
  $('copy').textContent='Copied!';setTimeout(function(){$('copy').textContent='Copy link'},1500);
});
</script>
</body>
</html>`;

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}

async function handleCreate(request: Request, env: Env): Promise<Response> {
  let payload: { html?: unknown; name?: unknown; theme_color?: unknown };
  try {
    payload = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  const html = typeof payload.html === "string" ? payload.html : "";
  if (!html.trim()) return json({ error: "html is required" }, 400);

  const closed = serviceClosedReason(env);
  if (closed) return json({ error: closed }, 503);
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  if (await rateLimited(env, ip)) return json({ error: "Too many apps from this IP — try again later." }, 429);
  if (!(await reserveAppSlot(env))) return json({ error: "This public demo has reached its app limit — deploy your own instance to keep going." }, 503);

  const site: Site = {
    html,
    name: typeof payload.name === "string" ? payload.name.slice(0, 60) : undefined,
    theme_color: typeof payload.theme_color === "string" ? payload.theme_color.slice(0, 16) : undefined,
  };
  const id = genId();
  await env.SITES.put(id, JSON.stringify(site));
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
  const stub = await getAgentByName(env.APP_OBJECT, id);
  const r = (await (stub as unknown as AppBackend).apiCall(request.method, apiPath, query, body, id)) as ApiResult;
  return new Response(JSON.stringify(r.json), { status: r.status, headers: { "content-type": "application/json" } });
}

// ---------- main router ----------
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // MCP connector endpoints (Streamable HTTP + legacy SSE).
    if (path === "/mcp") return EasyHostMCP.serve("/mcp").fetch(request, env, ctx);
    if (path === "/sse" || path === "/sse/message") return EasyHostMCP.serveSSE("/sse").fetch(request, env, ctx);

    if (path === "/" && request.method === "GET") {
      return new Response(LANDING, { headers: { "content-type": "text/html;charset=utf-8" } });
    }
    if (path === "/api/create" && request.method === "POST") return handleCreate(request, env);

    // Hosted apps live under /s/:id/ (trailing slash required for SW scope).
    const m = path.match(/^\/s\/([A-Za-z0-9_-]+)(\/.*)?$/);
    if (m) {
      const id = m[1];
      const sub = m[2]; // undefined => no trailing slash
      if (sub === undefined) return Response.redirect(`${url.origin}/s/${id}/`, 301);

      if (sub.startsWith("/api/")) return handleApi(request, env, id, sub.slice("/api/".length), url);
      if (sub === "/icon-192.png") return serveIcon(192);
      if (sub === "/icon-512.png") return serveIcon(512);
      if (sub === "/apple-touch-icon.png") return serveIcon(180);
      if (sub === "/sw.js") return serveSW();
      if (sub === "/sdk.js") return serveSdk();

      const site = await getSite(env, id);
      if (!site) return new Response("Not found", { status: 404 });
      if (sub === "/") return serveApp(site);
      if (sub === "/manifest.webmanifest") return manifest(site);
      return new Response("Not found", { status: 404 });
    }

    return new Response("Not found", { status: 404 });
  },
};
