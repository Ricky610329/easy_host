// The MCP server (connector) AI assistants call, plus the build guide and a publish-time linter.
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Env, Site } from "./types";
import { genId } from "./util";
import { MAX_HTML_BYTES, appUrl, getSite, indexAddApp, reserveAppSlot, serviceClosedReason, userAppCapReached } from "./store";

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
  "- The home-screen icon is auto-generated as a lettermark (the app name's first letter on your theme_color). For a non-Latin name, pass `icon` (one A-Z/0-9 letter, e.g. 'W' for a water app) so the icon shows a clean monogram.",
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
  "- await easyhost.ready first. Then: await easyhost.data.set(key, value) / get(key) / delete(key).",
  "- List/scan: easyhost.data.list(prefix, { keysOnly, limit, reverse }) -> [{key, value}] sorted by key ASCENDING. Pass { reverse:true } for newest-first, { limit:N } to cap, { keysOnly:true } to page keys without downloading every value. easyhost.data.count(prefix) returns how many keys match.",
  "- Values are any JSON. Keys are strings. easyhost.data survives reinstall; localStorage does not — use localStorage only as an offline cache.",
  "- LIMITS — design around these: each value max ~64KB; max 1000 keys per app. set() REJECTS (throws) if a value is too big or you hit the key cap, so always `await` your writes (and catch if it matters).",
  "- Model multi-record data as one key PER record, not one giant array: e.g. a journal/tracker stores `entry:2026-06-02` per day and reads list('entry:'); one ever-growing array will blow the 64KB limit. Use sortable keys (ISO dates, zero-padded numbers) so list()/reverse gives the order you want.",
  "- Pattern: render immediately, load from easyhost.data after ready, write through (await) on every change.",
  "",
  "## 5. Notifications (the headline feature)",
  "- Gate behind a user gesture: call easyhost.notify.enable() ONLY inside a click handler, after briefly explaining why.",
  "- enable() requests permission and subscribes. Check easyhost.notify.permission ('default'|'granted'|'denied') and handle 'denied' gracefully.",
  "- iOS REQUIREMENT: on iPhone/iPad push only works after the app is installed to the Home Screen and opened from the icon (iOS 16.4+) — NOT in a Safari tab. So on iOS, if easyhost.notify.installed === false, hide Enable and show 'Add to Home Screen, then open from the icon to turn on reminders.' On Android/desktop enable() works in the browser too — don't hide it there just because installed is false.",
  "- Kinds of notification:",
  "  - Immediate test:   easyhost.notify.sendNow({ title, body })",
  "  - One-off at a time: easyhost.notify.schedule({ title, body, at })          // at = epoch ms (compute with Date in the browser) or an ISO string WITH a timezone",
  "  - Recurring:         easyhost.notify.every({ title, body, everyMinutes })   // e.g. every 120 minutes",
  "  -                    easyhost.notify.every({ title, body, dailyAt: '08:30' }) // every day at the USER'S LOCAL time — the SDK sends the timezone for you, no conversion needed (may shift 1h across daylight-saving changes)",
  "  - Manage: easyhost.notify.list() and easyhost.notify.cancel(id). Keep the id you got back (or read it from list()) to cancel later.",
  "- LIMITS: up to 50 scheduled/recurring reminders per app; immediate sendNow capped at ~30/min. For a big list of items, don't schedule one reminder each — send a single daily summary instead.",
  "- Keep title+body short (a notification, not an essay).",
  "",
  "## 6. Design quality",
  "- Design with taste and restraint: make it feel intentional and specific to its purpose, not a generic template. Commit to one clear idea and keep everything else quiet. Aim for something you'd be proud to ship.",
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
        icon: z.string().optional().describe("One letter or digit (A-Z / 0-9) for the home-screen icon monogram. Defaults to the app name's first letter; set this for non-Latin names (e.g. 'W' for a water app)."),
      },
      async ({ html, name, theme_color, icon }) => {
        if (!html || !html.trim()) return { content: [{ type: "text", text: "Error: html is empty." }], isError: true };
        const owner = (this.props as { id?: string } | undefined)?.id;
        if (!owner) return { content: [{ type: "text", text: "Please sign in: reconnect this easy_host connector and authorize with Google." }], isError: true };
        if (html.length > MAX_HTML_BYTES) return { content: [{ type: "text", text: "App HTML is too large (max ~2 MB). Trim it and try again." }], isError: true };
        const closed = serviceClosedReason(this.env);
        if (closed) return { content: [{ type: "text", text: closed }], isError: true };
        if (await userAppCapReached(this.env, owner))
          return { content: [{ type: "text", text: "You've reached your app limit on this instance. Delete an app in your dashboard, or self-host to raise the cap." }], isError: true };
        if (!(await reserveAppSlot(this.env)))
          return { content: [{ type: "text", text: "This public demo has reached its app limit — deploy your own instance to keep going." }], isError: true };
        const site: Site = { html, name: name?.slice(0, 60), theme_color: theme_color?.slice(0, 16), icon: icon?.slice(0, 2), owner, visibility: "private" };
        const id = genId();
        await this.env.SITES.put(id, JSON.stringify(site));
        await indexAddApp(this.env, owner, id);
        const url = appUrl(this.env, id);
        return {
          content: [
            {
              type: "text",
              text:
                `Published. id: ${id}\nInstallable app URL: ${url}\n\n` +
                `This app is PRIVATE by default — only the signed-in owner can open it. The user should open it while signed in (same Google account), then Add to Home Screen (iOS Safari) / Install (Android Chrome). To share it, set it to Public in the dashboard — anyone who opens it then signs in and gets their own private copy of the data.\n` +
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
        icon: z.string().optional().describe("Optional new icon monogram letter/digit."),
      },
      async ({ id, html, name, theme_color, icon }) => {
        if (!html || !html.trim()) return { content: [{ type: "text", text: "Error: html is empty." }], isError: true };
        if (html.length > MAX_HTML_BYTES) return { content: [{ type: "text", text: "App HTML is too large (max ~2 MB). Trim it and try again." }], isError: true };
        const owner = (this.props as { id?: string } | undefined)?.id;
        if (!owner) return { content: [{ type: "text", text: "Please sign in: reconnect this easy_host connector and authorize with Google." }], isError: true };
        const closed = serviceClosedReason(this.env);
        if (closed) return { content: [{ type: "text", text: closed }], isError: true };
        const existing = await getSite(this.env, id);
        if (!existing) return { content: [{ type: "text", text: `Error: no app with id "${id}". Use publish_app to create one.` }], isError: true };
        if (existing.owner && existing.owner !== owner)
          return { content: [{ type: "text", text: "You don't own this app, so it can't be updated from this account." }], isError: true };
        const site: Site = { html, name: name ?? existing.name, theme_color: theme_color ?? existing.theme_color, icon: icon?.slice(0, 2) ?? existing.icon, owner, visibility: existing.visibility === "public" ? "public" : "private" };
        await this.env.SITES.put(id, JSON.stringify(site));
        await indexAddApp(this.env, owner, id);
        const url = appUrl(this.env, id);
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
