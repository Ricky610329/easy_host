import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

interface Env {
  SITES: KVNamespace;
  MCP_OBJECT: DurableObjectNamespace;
  PUBLIC_BASE_URL?: string;
}

interface Site {
  html: string;
  name?: string;
  theme_color?: string;
}

const DEFAULT_NAME = "App";
const DEFAULT_THEME = "#4f46e5";

// ---------- id ----------
// 9 random bytes -> 12-char base64url. Unguessable: this is the only access control in v1.
function genId(): string {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
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

// ---------- MCP server: the "connector" AI assistants call to publish ----------
export class EasyHostMCP extends McpAgent<Env> {
  server = new McpServer(
    { name: "easy_host", version: "0.1.0" },
    {
      instructions:
        "easy_host hosts web apps so the user can install them on their phone. " +
        "Whenever the user asks you to build, create, or make a web app, webpage, tool, " +
        "dashboard, game, tracker, or anything they want to use or install on a phone, " +
        "generate a COMPLETE self-contained HTML document (all CSS and JS inline, no external " +
        "files) and call publish_app with it. Then give the user the returned URL and tell them " +
        "to open it on their phone and use Add to Home Screen to install it as an app.",
    }
  );

  async init() {
    this.server.tool(
      "publish_app",
      "Publish a self-contained web app so the user can open it on their phone and install it as an app (PWA). " +
        "Call this whenever the user wants a webpage, app, tool, or game they can use or install on a phone. " +
        "Returns a public HTTPS URL to share with the user.",
      {
        html: z
          .string()
          .describe(
            "The COMPLETE, standalone HTML document (a full <!doctype html> page). Put ALL CSS " +
              "and JavaScript inline — external files and relative asset paths are NOT hosted. " +
              "Make it mobile-friendly and responsive. A viewport tag, web app manifest, service " +
              "worker, and icons are injected automatically, so you do not need to add them."
          ),
        name: z
          .string()
          .optional()
          .describe("Short app name shown under the icon on the phone home screen (e.g. 'Workout Log'). Keep it under ~30 characters."),
        theme_color: z
          .string()
          .optional()
          .describe("Optional theme color as a hex string for the status bar / splash, e.g. '#4f46e5'."),
      },
      async ({ html, name, theme_color }) => {
        if (!html || !html.trim()) {
          return { content: [{ type: "text", text: "Error: html is empty." }], isError: true };
        }
        const site: Site = {
          html,
          name: name?.slice(0, 60),
          theme_color: theme_color?.slice(0, 16),
        };
        const id = genId();
        await this.env.SITES.put(id, JSON.stringify(site));
        const base = (this.env.PUBLIC_BASE_URL || "http://localhost:8787").replace(/\/+$/, "");
        const url = `${base}/s/${id}/`;
        return {
          content: [
            {
              type: "text",
              text:
                `Published. Installable app URL: ${url}\n\n` +
                `Tell the user to open this link on their phone, then:\n` +
                `- iOS Safari: Share -> Add to Home Screen\n` +
                `- Android Chrome: menu -> Install app / Add to Home screen`,
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
    `<script>if('serviceWorker' in navigator)addEventListener('load',function(){navigator.serviceWorker.register('sw.js',{scope:'./'})});</script>`
  );
}

function serveApp(site: Site): Response {
  const block = injectBlock(site.name || DEFAULT_NAME, site.theme_color || DEFAULT_THEME);
  const html = site.html;
  const lower = html.toLowerCase();
  const headers = { "content-type": "text/html;charset=utf-8" };

  if (lower.includes("<head")) {
    // Prepend our PWA tags as the first children of <head> so our <base> wins.
    return new HTMLRewriter()
      .on("head", {
        element(el) {
          el.prepend(block, { html: true });
        },
      })
      .transform(new Response(html, { headers }));
  }
  // No <head>: synthesize one (robust fallback for bare fragments).
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

// ---------- service worker ----------
// A fetch handler is required for Chrome's installability check; network-first
// with cache fallback also makes the single-page app work offline once visited.
const SW_JS = `const CACHE='easy-host-v1';
self.addEventListener('install',function(){self.skipWaiting()});
self.addEventListener('activate',function(e){e.waitUntil(self.clients.claim())});
self.addEventListener('fetch',function(e){
  if(e.request.method!=='GET')return;
  e.respondWith(
    fetch(e.request).then(function(res){
      var copy=res.clone();
      caches.open(CACHE).then(function(c){c.put(e.request,copy)});
      return res;
    }).catch(function(){
      return caches.match(e.request).then(function(r){return r||caches.match('./')});
    })
  );
});`;

function serveSW(): Response {
  return new Response(SW_JS, {
    headers: { "content-type": "text/javascript; charset=utf-8" },
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
  const rowLen = 1 + size * 3; // filter byte + RGB pixels
  const raw = new Uint8Array(rowLen * size);
  for (let y = 0; y < size; y++) {
    const off = y * rowLen;
    raw[off] = 0; // filter: none
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
  dv.setUint32(0, size); // width
  dv.setUint32(4, size); // height
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

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
  const site: Site = {
    html,
    name: typeof payload.name === "string" ? payload.name.slice(0, 60) : undefined,
    theme_color: typeof payload.theme_color === "string" ? payload.theme_color.slice(0, 16) : undefined,
  };
  const id = genId();
  await env.SITES.put(id, JSON.stringify(site));
  const url = `${new URL(request.url).origin}/s/${id}/`;
  return json({ id, url });
}

// ---------- main router ----------
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // MCP connector endpoints (Streamable HTTP + legacy SSE).
    if (path === "/mcp") {
      return EasyHostMCP.serve("/mcp").fetch(request, env, ctx);
    }
    if (path === "/sse" || path === "/sse/message") {
      return EasyHostMCP.serveSSE("/sse").fetch(request, env, ctx);
    }

    if (path === "/" && request.method === "GET") {
      return new Response(LANDING, { headers: { "content-type": "text/html;charset=utf-8" } });
    }
    if (path === "/api/create" && request.method === "POST") {
      return handleCreate(request, env);
    }

    // Hosted apps live under /s/:id/ (trailing slash is required for SW scope).
    const m = path.match(/^\/s\/([A-Za-z0-9_-]+)(\/.*)?$/);
    if (m) {
      const id = m[1];
      const sub = m[2]; // undefined => no trailing slash
      if (sub === undefined) {
        return Response.redirect(`${url.origin}/s/${id}/`, 301);
      }
      if (sub === "/icon-192.png") return serveIcon(192);
      if (sub === "/icon-512.png") return serveIcon(512);
      if (sub === "/apple-touch-icon.png") return serveIcon(180);

      const site = await getSite(env, id);
      if (!site) return new Response("Not found", { status: 404 });
      if (sub === "/") return serveApp(site);
      if (sub === "/manifest.webmanifest") return manifest(site);
      if (sub === "/sw.js") return serveSW();
      return new Response("Not found", { status: 404 });
    }

    return new Response("Not found", { status: 404 });
  },
};
