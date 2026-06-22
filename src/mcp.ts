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
  "# easy_host — build guide",
  "",
  "You generate a web app; easy_host hosts it as an installable phone PWA with a backend: persistent data (easyhost.data) and real push notifications that fire even when the app is closed (easyhost.notify). This is only what's platform-specific — you already know how to build good mobile web UI, so spend your effort there.",
  "",
  "## Files & hosting",
  "- Ship EITHER one self-contained <!doctype html> (publish_app `html`) — simplest, best for a small app — OR several text files (publish_app `files`: a list of { path, content }). Prefer multi-file when the app has multiple screens/modules or you'll iterate on it. No build step / bundler.",
  "- Multi-file: index.html is the ENTRY — head tags + the easyhost SDK are injected only into it (easyhost is a global, available in every module you import; await easyhost.ready in your entry). Reference siblings with relative URLs: <script type='module' src='app.js'>, <link href='styles.css'>, import './lib/x.js'. Nested folders are fine (screens/editor.js, import '../store.js'). Text files only (html/js/mjs/css/json/svg/txt; <=20 files, ~2MB); images via URL/CDN/data: URI.",
  "- Routing: an unknown path falls back to index.html (with injection) and a <base href> at the app root is injected — so BOTH hash (#/note/1) and History-API (/note/1) client-side routing work, and relative assets resolve from the root at any route depth.",
  "- Reserved filenames (do NOT name a file these): sw.js, sdk.js, manifest.webmanifest, robots.txt, icon-192.png, icon-512.png, apple-touch-icon.png, or anything under api/.",
  "- update_app MERGES files — to revise a multi-file app, send only the files that changed (cheaper, lower-risk); use removeFiles to delete one.",
  "- The network IS available — fetch external APIs, embed <iframe>s, load remote images, or pull a library from a CDN.",
  "",
  "## Already injected — do NOT add",
  "- viewport, theme-color, manifest, apple-touch meta/icon, app icons, the service worker, and the easyhost SDK (window.easyhost). The home-screen icon is an auto lettermark from the name; pass `icon` (one A-Z/0-9 char) for a non-Latin name.",
  "",
  "## Principles (you know mobile UI; these are the easy-to-miss ones)",
  "- Make it WORK first: the smallest thing that works end-to-end beats an ambitious half-broken one. Every control must do something; don't add unrequested subsystems (levels, upgrades, multi-step flows) — the user can ask via update_app. Guard risky parts so one bug can't blank the screen.",
  "- Keep it light: it runs on a mid-range phone — animate transform/opacity only, no backdrop-blur / big or animated shadows / always-on animations, update the DOM in place. Heavy decoration is the usual jank. (Double-tap zoom is already disabled — don't set user-scalable=no.)",
  "- Fill the safe area (BOTH edges): viewport-fit=cover + a translucent status bar are injected, so your page renders full-screen UNDER the iOS clock (top) AND home indicator (bottom). Set a background on html/body — the browser default is white, which is what shows as a gap. Then keep content clear of both strips: pad whatever sits against the top (a header/title, or a fixed top bar) with env(safe-area-inset-top) and whatever sits against the bottom (a nav/tab bar) with env(safe-area-inset-bottom) — e.g. padding-top: calc(10px + env(safe-area-inset-top)) and padding-bottom: calc(10px + env(safe-area-inset-bottom)) — so the bar's own background fills the strip while its content clears the clock / home indicator. Skip the top and your title hides under the clock; skip the bottom and a nav bar leaves a white gap.",
  "- Have a point of view: intentional and specific to its purpose, not a generic template.",
  "",
  "## Data — easyhost.data (cloud; survives reinstall; prefer over localStorage)",
  "- await easyhost.ready, then set(k,v) / get(k) / delete(k); list(prefix, { keysOnly, limit, reverse }) -> [{ key, value }] (key-ascending; reverse = newest-first); count(prefix). JSON values, string keys.",
  "- Limits: ~64KB per value, 1000 keys/app; set() THROWS past either, so await writes. Store one key PER record (`entry:2026-06-02`, or a sortable id `${Date.now().toString(36)}${Math.random().toString(36).slice(2,6)}`) — never one growing array.",
  "",
  "## Notifications — easyhost.notify",
  "- enable() ONLY inside a click (asks permission + subscribes); check .permission, handle 'denied'. Call sendNow/schedule/every only AFTER enable() succeeds. iOS: push works only once the app is installed to the Home Screen and opened from its icon — if .installed is false on iOS, hide Enable and tell them to install first (Android/desktop work in-browser).",
  "- sendNow({title,body}) · schedule({title,body,at}) (at = epoch ms or ISO-with-tz) · every({title,body,everyMinutes}) · every({...,dailyAt:'08:30'}) — dailyAt is the user's LOCAL time (SDK handles the zone). All fire server-side even when the app is closed.",
  "- Any notification also takes icon/image/badge (URLs). every({bodies:[...]}) fires a random entry each time. Pass a stable `tag` to REPLACE rather than stack (cancelByTag(tag) removes it). Deep-link: url:'#/path' + easyhost.notify.onClick((url)=>…). list() -> {id,tag,title,body,url,icon,image,type,time,cron}; cancel(id). Limits: 50 reminders, ~30 sendNow/min.",
  "",
  "To revise an app, call update_app with the SAME id (keeps its data, reminders, and icon).",
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
        "easy_host turns a web app you generate into an installable phone PWA with a backend: persistent storage (easyhost.data) " +
        "and real push notifications, including ones that fire when the app is closed (easyhost.notify). " +
        "Call get_build_guide once before building, and follow it. The PWA tags, icons, service worker, and the `easyhost` SDK are " +
        "injected for you — don't add your own. Generate the app (one self-contained HTML doc, or several files via `files` for a " +
        "multi-screen app) and call publish_app; it returns a URL. To revise, call update_app with the same id (preserves data, " +
        "reminders, and icon) — never publish_app again for edits. Then give the user the URL and tell them to Add to Home Screen.",
    }
  );

  async init() {
    this.server.resource("build-guide", "easyhost://guide", async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/markdown", text: BUILD_GUIDE }],
    }));

    this.server.tool(
      "get_build_guide",
      "easy_host's build guide: the platform specifics, the easyhost.data / easyhost.notify SDK, and a few principles. Read it BEFORE generating an app.",
      {},
      async () => ({ content: [{ type: "text", text: BUILD_GUIDE }] })
    );

    this.server.tool(
      "publish_app",
      "Publish a NEW installable phone app (PWA) with storage + notifications. Provide a single `html` document OR a `files` list (multi-file). " +
        "Call get_build_guide first. Returns an id + URL. To revise an existing app use update_app, not publish_app.",
      {
        html: z
          .string()
          .optional()
          .describe(
            "Single-file app: the complete HTML document (CSS/JS inline; the network is available). viewport/manifest/service-worker/icons/the `easyhost` SDK are injected — don't add them. Provide this OR `files`."
          ),
        files: z
          .array(z.object({ path: z.string(), content: z.string() }))
          .optional()
          .describe(
            "Multi-file app: a list like [{ path:'index.html', content:'...' }, { path:'app.js', content:'...' }]. MUST include index.html (the entry — head tags + SDK are injected there). " +
              "Reference siblings with relative URLs / ESM imports. Text files only (html/js/mjs/css/json/svg/txt); images via URL/CDN/data-URI. Provide this OR `html`."
          ),
        name: z.string().optional().describe("Short app name on the home screen (e.g. 'Water Reminder'). Under ~30 chars."),
        theme_color: z.string().optional().describe("Theme color hex, e.g. '#4f46e5'."),
        icon: z.string().optional().describe("One letter or digit (A-Z / 0-9) for the home-screen icon monogram. Defaults to the app name's first letter; set this for non-Latin names (e.g. 'W' for a water app)."),
        dryRun: z.boolean().optional().describe("Validate only — check the files and report sizes, don't actually publish."),
      },
      async ({ html, files, name, theme_color, icon, dryRun }) => {
        const built = buildFiles(html, filesToMap(files));
        if (built.error) return { content: [{ type: "text", text: `Error: ${built.error}` }], isError: true };
        if (dryRun) return { content: [{ type: "text", text: `Dry run OK — would publish ${Object.keys(built.files!).length} file(s). ${sizesLine(built.files!)}` }] };
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
                `Published${n > 1 ? ` (${n} files)` : ""} — id ${id}\n${url}\n\n` +
                `Private by default (only the signed-in owner can open it). Tell the user to open it on their phone while signed in, then Add to Home Screen (iOS Safari) / Install (Android). Make it Public in the dashboard to share. Revise later with update_app id "${id}".\n${sizesLine(built.files!)}` +
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
        files: z
          .array(z.object({ path: z.string(), content: z.string() }))
          .optional()
          .describe("Files to add or replace, e.g. [{ path:'app.js', content:'...' }] — merged into the existing app, so send ONLY what changed."),
        removeFiles: z.array(z.string()).optional().describe("Paths to delete from the app (index.html cannot be removed)."),
        name: z.string().optional().describe("Optional new app name."),
        theme_color: z.string().optional().describe("Optional new theme color hex."),
        icon: z.string().optional().describe("Optional new icon monogram letter/digit."),
        dryRun: z.boolean().optional().describe("Validate only — check the merged result and report, don't actually save."),
      },
      async ({ id, html, files, removeFiles, name, theme_color, icon, dryRun }) => {
        const owner = (this.props as { id?: string } | undefined)?.id;
        if (!owner) return { content: [{ type: "text", text: "Please sign in: reconnect this easy_host connector and authorize with Google." }], isError: true };
        const closed = serviceClosedReason(this.env);
        if (closed) return { content: [{ type: "text", text: closed }], isError: true };
        const existing = await getSite(this.env, id);
        if (!existing) return { content: [{ type: "text", text: `Error: no app with id "${id}". Use publish_app to create one.` }], isError: true };
        if (existing.owner && existing.owner !== owner)
          return { content: [{ type: "text", text: "You don't own this app, so it can't be updated from this account." }], isError: true };
        // Merge the patch (html replaces index.html) into the existing files, then validate the result.
        const patchMap = filesToMap(files);
        const patch = html !== undefined ? { ...(patchMap || {}), [ENTRY]: html } : patchMap;
        const merged = mergeFiles(siteFiles(existing), patch, removeFiles);
        const ok = sanitizeFiles(merged);
        if (ok.error) return { content: [{ type: "text", text: `Error: ${ok.error}` }], isError: true };
        if (dryRun) return { content: [{ type: "text", text: `Dry run OK — would update to ${Object.keys(ok.files!).length} file(s). ${sizesLine(ok.files!)}` }] };
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
                `The user's saved data, reminders, and home-screen icon are preserved. They get the new version next time they open it.\n${sizesLine(ok.files!)}` +
                warnText(lint(Object.values(ok.files!).join("\n"))),
            },
          ],
        };
      }
    );

    this.server.tool(
      "get_app",
      "Read an app you own — its current files (path, size, content) so you can edit precisely or confirm what's deployed. Pass includeContent:false for just paths + sizes.",
      {
        id: z.string().describe("The app id."),
        includeContent: z.boolean().optional().describe("Include each file's full text (default true)."),
      },
      async ({ id, includeContent }) => {
        const owner = (this.props as { id?: string } | undefined)?.id;
        if (!owner) return { content: [{ type: "text", text: "Please sign in: reconnect this easy_host connector and authorize with Google." }], isError: true };
        const site = await getSite(this.env, id);
        if (!site) return { content: [{ type: "text", text: `Error: no app with id "${id}".` }], isError: true };
        if (site.owner && site.owner !== owner) return { content: [{ type: "text", text: "You don't own this app." }], isError: true };
        const files = siteFiles(site);
        const withContent = includeContent !== false;
        const body = Object.entries(files).map(([p, c]) => `### ${p} (${c.length} bytes)` + (withContent ? `\n${c}` : "")).join("\n\n");
        return { content: [{ type: "text", text: `App ${id} — ${appUrl(this.env, id)}\n${sizesLine(files)}\n\n${body}` }] };
      }
    );
  }
}

// Tool args carry files as a [{path,content}] array (converts cleanly to JSON Schema, unlike z.record);
// turn it into a path->content map. Returns undefined for an empty/absent list.
function filesToMap(files: { path: string; content: string }[] | undefined): Record<string, string> | undefined {
  if (!files || !files.length) return undefined;
  const map: Record<string, string> = {};
  for (const f of files) map[f.path] = f.content;
  return map;
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

// "Files: index.html 2.1KB, app.js 4.3KB — 6.4KB of ~2MB." — so the AI can gauge how close to the limit.
function sizesLine(files: Record<string, string>): string {
  const total = Object.values(files).reduce((a, c) => a + c.length, 0);
  const each = Object.entries(files).map(([p, c]) => `${p} ${(c.length / 1024).toFixed(1)}KB`).join(", ");
  return `Files: ${each} — ${(total / 1024).toFixed(1)}KB of ~2MB.`;
}
