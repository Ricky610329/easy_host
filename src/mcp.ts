// The MCP server (connector) AI assistants call, plus the build guide and a publish-time linter.
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Env, Site } from "./types";
import { genId } from "./util";
import { MAX_HTML_BYTES, appUrl, getSite, indexAddApp, putSite, reserveAppSlot, serviceClosedReason, userAppCapReached } from "./store";
import { ENTRY, mergeFiles, sanitizeFiles, siteFiles } from "./files";

// ---------- the build guide handed to the AI (no backticks: this is a template literal) ----------
const BUILD_GUIDE = [
  "# easy_host — how to build a great app",
  "",
  "You are generating ONE self-contained HTML page. easy_host hosts it, makes it an installable PWA,",
  "and gives it a backend: persistent data (easyhost.data) and real push notifications (easyhost.notify),",
  "including scheduled and recurring reminders that fire even when the app is closed. Build for a phone.",
  "",
  "## 1. Files & constraints",
  "- Ship EITHER one self-contained <!doctype html> document (publish_app `html`), OR several text files (publish_app `files` map: index.html + app.js + styles.css + more). No build step / bundler — you provide the final files.",
  "- Multi-file: index.html is the entry (head tags + the easyhost SDK are injected into it). Reference siblings with normal relative URLs — <script src='app.js'>, <link href='styles.css'>, or ESM import './x.js'. Text files only (html/js/mjs/css/json/svg/txt; up to 20 files, ~2MB total); put images on a URL/CDN or a data: URI.",
  "- The network IS available — build online apps freely: fetch external APIs, embed <iframe>s (maps, video, widgets), load remote images, or pull a library from a CDN.",
  "- update_app can send just the changed files (they're merged) — cheaper than resending the whole app.",
  "- Offline is optional, not required. For a simple self-contained tool it's nice to inline assets / use data: URIs so it keeps working with no connection — do that when it fits, skip it when the app is inherently online.",
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
  "- Accidental double-tap zoom and the tap delay are already disabled for you (touch-action: manipulation) — don't add user-scalable=no.",
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
  "- Per-notification look: any of the above also accept `icon` (small image URL, e.g. a sender's avatar), `image` (large hero image URL), and `badge`. So different notifications can show different pictures — e.g. sendNow({ title:'Mia', body:'hi!', icon:'https://.../mia.png' }). Use URLs (data: URIs count against a ~4KB push-payload limit).",
  "- Rotating content: every({ everyMinutes:120, bodies:[...] }) sends a RANDOM entry from `bodies` each time — entries are strings (body text) or objects { title, body, icon, image, url }. Use this for variety instead of scheduling many one-offs (which burns the 50-reminder cap).",
  "- Server-side: scheduled / recurring reminders fire on our servers (even when the app is fully closed) — you do NOT keep the app open or run your own timers.",
  "- Deep-linking: set `url` on a notification (e.g. url:'./#/chat/42'). On tap, a closed app opens at that url; an already-open app receives it via easyhost.notify.onClick((url, data) => { /* route in-app */ }) — register that once at startup.",
  "  - Return shapes: schedule()/every() resolve to { id }. list() resolves to rows { id, tag, title, body, type, time, cron }. Cancel one with easyhost.notify.cancel(id).",
  "  - Idempotent reminders (recommended): pass a stable `tag` to schedule()/every() (e.g. every({ dailyAt:'09:00', tag:'water-daily', ... })) and it REPLACES any existing reminder with that tag instead of stacking duplicates. Turn it off with easyhost.notify.cancelByTag(tag). Use this instead of list-then-cancel.",
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
  "- One self-contained HTML document, or a `files` map with index.html (external APIs/iframes/CDNs are fine if the app needs them)?",
  "- Uses easyhost.data for anything worth keeping?",
  "- Notifications behind a button + an install check, with iOS guidance?",
  "- 100dvh + safe-area padding + 44px touch targets?",
  "- Then call publish_app. To revise later, call update_app with the SAME id (keeps the user's data, reminders, and home-screen icon).",
].join("\n");

// Cheap heuristics surfaced back to the AI so it can self-correct via update_app.
function lint(html: string): string[] {
  const w: string[] = [];
  // External resources are allowed (online apps are fine) — only flag genuine issues.
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
      "Publish a NEW web app so the user can open it on their phone and install it as an app (PWA), with data + notifications. " +
        "Provide a single `html` document, OR a `files` map for a multi-file app. Call get_build_guide first. " +
        "Returns an id and URL. Use update_app (not publish_app) to revise an existing app.",
      {
        html: z
          .string()
          .optional()
          .describe(
            "Single-file app: the COMPLETE HTML document (your CSS/JS inline). The app may use the network freely " +
              "(external APIs, iframes, CDNs, remote images). A viewport, manifest, service worker, icons, and the `easyhost` " +
              "SDK are injected — do not add them. Provide this OR `files`."
          ),
        files: z
          .record(z.string(), z.string())
          .optional()
          .describe(
            "Multi-file app: a map of relative path -> text content, e.g. { \"index.html\": \"...\", \"app.js\": \"...\", \"styles.css\": \"...\" }. " +
              "MUST include index.html (the entry; head tags + SDK are injected into it). Reference siblings with normal relative URLs " +
              "(<script src=\"app.js\">, import './x.js'). Text files only (html/js/mjs/css/json/svg/txt); images via URL/CDN/data-URI. Provide this OR `html`."
          ),
        name: z.string().optional().describe("Short app name on the home screen (e.g. 'Water Reminder'). Under ~30 chars."),
        theme_color: z.string().optional().describe("Theme color hex, e.g. '#4f46e5'."),
        icon: z.string().optional().describe("One letter or digit (A-Z / 0-9) for the home-screen icon monogram. Defaults to the app name's first letter; set this for non-Latin names (e.g. 'W' for a water app)."),
      },
      async ({ html, files, name, theme_color, icon }) => {
        const built = buildFiles(html, files);
        if (built.error) return { content: [{ type: "text", text: `Error: ${built.error}` }], isError: true };
        const owner = (this.props as { id?: string } | undefined)?.id;
        if (!owner) return { content: [{ type: "text", text: "Please sign in: reconnect this easy_host connector and authorize with Google." }], isError: true };
        const closed = serviceClosedReason(this.env);
        if (closed) return { content: [{ type: "text", text: closed }], isError: true };
        if (await userAppCapReached(this.env, owner))
          return { content: [{ type: "text", text: "You've reached your app limit on this instance. Delete an app in your dashboard, or self-host to raise the cap." }], isError: true };
        if (!(await reserveAppSlot(this.env)))
          return { content: [{ type: "text", text: "This public demo has reached its app limit — deploy your own instance to keep going." }], isError: true };
        const site: Site = { files: built.files, name: name?.slice(0, 60), theme_color: theme_color?.slice(0, 16), icon: icon?.slice(0, 2), owner, visibility: "private" };
        const id = genId();
        await putSite(this.env, id, site);
        await indexAddApp(this.env, owner, id);
        const url = appUrl(this.env, id);
        const n = Object.keys(built.files!).length;
        return {
          content: [
            {
              type: "text",
              text:
                `Published${n > 1 ? ` (${n} files)` : ""}. id: ${id}\nInstallable app URL: ${url}\n\n` +
                `This app is PRIVATE by default — only the signed-in owner can open it. The user should open it while signed in (same Google account), then Add to Home Screen (iOS Safari) / Install (Android Chrome). To share it, set it to Public in the dashboard — anyone who opens it then signs in and gets their own private copy of the data.\n` +
                `To revise this app later, call update_app with id "${id}" — that keeps the user's data, reminders, and icon (and you can update just the changed files).` +
                warnText(lint(Object.values(built.files!).join("\n"))),
            },
          ],
        };
      }
    );

    this.server.tool(
      "update_app",
      "Revise an EXISTING app in place (same id, URL, icon, saved data, and reminders are preserved). Use this for every edit after publish_app. " +
        "For a multi-file app you can send ONLY the changed files (they're merged), which is cheaper than resending everything.",
      {
        id: z.string().describe("The app id returned by publish_app."),
        html: z.string().optional().describe("Replace the single-file document / the index.html entry. Provide this OR `files`."),
        files: z.record(z.string(), z.string()).optional().describe("Files to add or replace (merged into the existing app — send only what changed). Provide this OR `html`."),
        removeFiles: z.array(z.string()).optional().describe("Paths to delete from the app (index.html cannot be removed)."),
        name: z.string().optional().describe("Optional new app name."),
        theme_color: z.string().optional().describe("Optional new theme color hex."),
        icon: z.string().optional().describe("Optional new icon monogram letter/digit."),
      },
      async ({ id, html, files, removeFiles, name, theme_color, icon }) => {
        const owner = (this.props as { id?: string } | undefined)?.id;
        if (!owner) return { content: [{ type: "text", text: "Please sign in: reconnect this easy_host connector and authorize with Google." }], isError: true };
        const closed = serviceClosedReason(this.env);
        if (closed) return { content: [{ type: "text", text: closed }], isError: true };
        const existing = await getSite(this.env, id);
        if (!existing) return { content: [{ type: "text", text: `Error: no app with id "${id}". Use publish_app to create one.` }], isError: true };
        if (existing.owner && existing.owner !== owner)
          return { content: [{ type: "text", text: "You don't own this app, so it can't be updated from this account." }], isError: true };
        // Merge the patch (html replaces index.html) into the existing files, then validate the result.
        const patch = html !== undefined ? { ...(files || {}), [ENTRY]: html } : files;
        const merged = mergeFiles(siteFiles(existing), patch, removeFiles);
        const ok = sanitizeFiles(merged);
        if (ok.error) return { content: [{ type: "text", text: `Error: ${ok.error}` }], isError: true };
        const site: Site = {
          files: ok.files,
          name: name ?? existing.name,
          theme_color: theme_color ?? existing.theme_color,
          icon: icon?.slice(0, 2) ?? existing.icon,
          owner,
          visibility: existing.visibility === "public" ? "public" : "private",
        };
        await putSite(this.env, id, site);
        await indexAddApp(this.env, owner, id);
        const url = appUrl(this.env, id);
        return {
          content: [
            {
              type: "text",
              text:
                `Updated app ${id} (${Object.keys(ok.files!).length} files). URL (unchanged): ${url}\n` +
                `The user's saved data, reminders, and home-screen icon are preserved. They get the new version next time they open it.` +
                warnText(lint(Object.values(ok.files!).join("\n"))),
            },
          ],
        };
      }
    );
  }
}

// Resolve publish_app's html|files into a validated files map (single-file html => { index.html }).
function buildFiles(html: string | undefined, files: Record<string, string> | undefined): { files?: Record<string, string>; error?: string } {
  if (files && Object.keys(files).length) return sanitizeFiles(files);
  if (html && html.trim()) {
    if (html.length > MAX_HTML_BYTES) return { error: "App HTML is too large (max ~2 MB)." };
    return { files: { [ENTRY]: html } };
  }
  return { error: "provide `html` (single file) or `files` (multi-file, must include index.html)." };
}
