// PWA delivery: head injection, manifest, service worker, the injected client SDK, and app icons.
import type { Site } from "./types";
import { escapeAttr } from "./util";

const DEFAULT_NAME = "App";
const DEFAULT_THEME = "#4f46e5";

// ---------- head injection (relative URLs only, so it works for every site id under /s/:id/) ----------
function injectBlock(name: string, theme: string, token: string): string {
  const t = escapeAttr(theme);
  const n = escapeAttr(name);
  return (
    `<base href="./">` +
    `<script>window.__EH_TOKEN__=${JSON.stringify(token)}</script>` +
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

export function serveApp(site: Site, token: string): Response {
  const block = injectBlock(site.name || DEFAULT_NAME, site.theme_color || DEFAULT_THEME, token);
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
export function manifest(site: Site): Response {
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

export function serveSW(): Response {
  return new Response(SW_JS, { headers: { "content-type": "text/javascript; charset=utf-8" } });
}

// ---------- injected client SDK (window.easyhost), served at /s/:id/sdk.js ----------
const SDK_JS = `(function(){
  var cfg=null, resolveReady;
  var ready=new Promise(function(r){resolveReady=r});
  function api(method,path,opts){
    opts=opts||{};
    var init={method:method,headers:{}};
    init.headers['authorization']='Bearer '+(window.__EH_TOKEN__||'');
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
    schedule:function(m){return api('POST','reminders',{body:withTz(m)})},
    every:function(m){return api('POST','reminders',{body:withTz(m)})},
    list:function(){return api('GET','reminders').then(function(r){return r.items})},
    cancel:function(id){return api('DELETE','reminders/'+encodeURIComponent(id))}
  };
  // Attach the device's UTC offset so dailyAt fires at the user's LOCAL time (server converts it).
  function withTz(m){m=m||{};if(m.tzOffset===undefined)m.tzOffset=new Date().getTimezoneOffset();return m}
  var data={
    get:function(k){return api('GET','data',{query:{key:k}}).then(function(r){return r.value})},
    set:function(k,v){return api('PUT','data',{body:{key:k,value:v}}).then(function(r){if(r&&r.error)throw new Error('easyhost.data.set failed: '+r.error);return r})},
    delete:function(k){return api('DELETE','data',{query:{key:k}})},
    list:function(prefix,opts){opts=opts||{};var q={};if(prefix)q.prefix=prefix;if(opts.keysOnly)q.keysOnly='1';if(opts.limit)q.limit=String(opts.limit);if(opts.reverse)q.reverse='1';return api('GET','data/list',{query:q}).then(function(r){return r.items})},
    count:function(prefix){return api('GET','data/count',{query:prefix?{prefix:prefix}:{}}).then(function(r){return r.count})}
  };
  window.easyhost={ready:ready,user:{id:null},notify:notify,data:data};
  api('GET','config').then(function(c){cfg=c;window.easyhost.user.id=c.userId||'shared';resolveReady()}).catch(function(){resolveReady()});
})();`;

export function serveSdk(): Response {
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

// 5x7 bitmap font (each row is 5 bits, MSB = leftmost). The 1-pattern is the glyph shape.
const FONT: Record<string, number[]> = {
  A: [0b01110, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001],
  B: [0b11110, 0b10001, 0b10001, 0b11110, 0b10001, 0b10001, 0b11110],
  C: [0b01110, 0b10001, 0b10000, 0b10000, 0b10000, 0b10001, 0b01110],
  D: [0b11110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b11110],
  E: [0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b11111],
  F: [0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b10000],
  G: [0b01110, 0b10001, 0b10000, 0b10111, 0b10001, 0b10001, 0b01111],
  H: [0b10001, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001],
  I: [0b11111, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b11111],
  J: [0b00111, 0b00010, 0b00010, 0b00010, 0b00010, 0b10010, 0b01100],
  K: [0b10001, 0b10010, 0b10100, 0b11000, 0b10100, 0b10010, 0b10001],
  L: [0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b11111],
  M: [0b10001, 0b11011, 0b10101, 0b10101, 0b10001, 0b10001, 0b10001],
  N: [0b10001, 0b10001, 0b11001, 0b10101, 0b10011, 0b10001, 0b10001],
  O: [0b01110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110],
  P: [0b11110, 0b10001, 0b10001, 0b11110, 0b10000, 0b10000, 0b10000],
  Q: [0b01110, 0b10001, 0b10001, 0b10001, 0b10101, 0b10010, 0b01101],
  R: [0b11110, 0b10001, 0b10001, 0b11110, 0b10100, 0b10010, 0b10001],
  S: [0b01111, 0b10000, 0b10000, 0b01110, 0b00001, 0b00001, 0b11110],
  T: [0b11111, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100],
  U: [0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110],
  V: [0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01010, 0b00100],
  W: [0b10001, 0b10001, 0b10001, 0b10101, 0b10101, 0b11011, 0b10001],
  X: [0b10001, 0b10001, 0b01010, 0b00100, 0b01010, 0b10001, 0b10001],
  Y: [0b10001, 0b10001, 0b01010, 0b00100, 0b00100, 0b00100, 0b00100],
  Z: [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b10000, 0b11111],
  "0": [0b01110, 0b10011, 0b10101, 0b10101, 0b11001, 0b10001, 0b01110],
  "1": [0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
  "2": [0b01110, 0b10001, 0b00001, 0b00110, 0b01000, 0b10000, 0b11111],
  "3": [0b11111, 0b00010, 0b00100, 0b00010, 0b00001, 0b10001, 0b01110],
  "4": [0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010],
  "5": [0b11111, 0b10000, 0b11110, 0b00001, 0b00001, 0b10001, 0b01110],
  "6": [0b00110, 0b01000, 0b10000, 0b11110, 0b10001, 0b10001, 0b01110],
  "7": [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000],
  "8": [0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110],
  "9": [0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00010, 0b01100],
};

// First renderable glyph from an explicit icon, else the name; "" => no glyph (gradient only).
function pickGlyph(site: Site | null): string {
  const src = (site?.icon || site?.name || "").toUpperCase();
  for (const ch of src) if (FONT[ch]) return ch;
  return "";
}

async function renderIcon(size: number, color: string, glyph: string): Promise<Uint8Array> {
  const [r, g, b] = hexToRgb(color);
  // Glyph contrast: dark on light backgrounds, white otherwise.
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  const fg = lum > 0.6 ? [17, 17, 17] : [255, 255, 255];

  const rowLen = 1 + size * 3;
  const raw = new Uint8Array(rowLen * size);
  for (let y = 0; y < size; y++) {
    const off = y * rowLen;
    raw[off] = 0; // filter: none
    const shade = 1 - 0.22 * (y / size); // subtle vertical gradient
    const br = Math.round(r * shade), bg = Math.round(g * shade), bb = Math.round(b * shade);
    for (let x = 0; x < size; x++) {
      const p = off + 1 + x * 3;
      raw[p] = br;
      raw[p + 1] = bg;
      raw[p + 2] = bb;
    }
  }

  const bitmap = glyph && FONT[glyph];
  if (bitmap) {
    const scale = Math.max(1, Math.floor((size * 0.52) / 7));
    const gw = 5 * scale, gh = 7 * scale;
    const ox = Math.floor((size - gw) / 2), oy = Math.floor((size - gh) / 2);
    for (let ry = 0; ry < 7; ry++) {
      for (let rx = 0; rx < 5; rx++) {
        if (!(bitmap[ry] & (1 << (4 - rx)))) continue;
        for (let dy = 0; dy < scale; dy++) {
          const yy = oy + ry * scale + dy;
          const base = yy * rowLen + 1 + (ox + rx * scale) * 3;
          for (let dx = 0; dx < scale; dx++) {
            const p = base + dx * 3;
            raw[p] = fg[0];
            raw[p + 1] = fg[1];
            raw[p + 2] = fg[2];
          }
        }
      }
    }
  }

  return encodePngRGB(size, raw);
}

// Assemble a truecolor (RGB, color type 2) PNG from a raw filtered scanline buffer.
async function encodePngRGB(size: number, raw: Uint8Array): Promise<Uint8Array> {
  const idat = await deflate(raw);
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, size);
  dv.setUint32(4, size);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB
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

const iconCache = new Map<string, Promise<Uint8Array>>();
function getIcon(size: number, color: string, glyph: string): Promise<Uint8Array> {
  const key = `${size}:${color}:${glyph}`;
  let p = iconCache.get(key);
  if (!p) {
    p = renderIcon(size, color, glyph);
    iconCache.set(key, p);
  }
  return p;
}

export async function serveIcon(size: number, site: Site | null): Promise<Response> {
  const png = await getIcon(size, site?.theme_color || DEFAULT_THEME, pickGlyph(site));
  return new Response(png.slice(), {
    headers: { "content-type": "image/png", "cache-control": "public, max-age=31536000, immutable" },
  });
}

// ---------- the ship-it site's own PWA: rocket icon, manifest, service worker ----------
// A parametric rocket drawn with basic shapes (nose, body, window, fins, flame) on a dark square.
async function renderRocket(size: number): Promise<Uint8Array> {
  const S = size;
  const rowLen = 1 + S * 3;
  const raw = new Uint8Array(rowLen * S);
  const BG = [12, 12, 14], BODY = [240, 240, 238], WIN = [90, 170, 255], FIN = [255, 107, 61], FLAME = [255, 176, 59];
  for (let y = 0; y < S; y++) {
    const off = y * rowLen;
    raw[off] = 0;
    const fy = y / S;
    for (let x = 0; x < S; x++) {
      const fx = x / S;
      const dxc = Math.abs(fx - 0.5);
      let col = BG;
      // flame (under the body)
      if (fy >= 0.7 && fy <= 0.9) {
        const t = (fy - 0.7) / 0.2;
        if (dxc <= 0.06 * (1 - t) + 0.004) col = FLAME;
      }
      // fins (stick out beyond the body sides)
      if (fy >= 0.56 && fy <= 0.76) {
        const t = (fy - 0.56) / 0.2;
        const outer = 0.09 + 0.19 * t;
        if (dxc <= outer && dxc >= 0.115) col = FIN;
      }
      // body
      if (fy >= 0.32 && fy <= 0.7 && dxc <= 0.135) col = BODY;
      // nose cone
      if (fy >= 0.15 && fy < 0.32) {
        const t = (fy - 0.15) / 0.17;
        if (dxc <= 0.135 * t) col = BODY;
      }
      // window
      const wdx = fx - 0.5, wdy = fy - 0.44;
      if (wdx * wdx + wdy * wdy <= 0.058 * 0.058) col = WIN;
      const p = off + 1 + x * 3;
      raw[p] = col[0];
      raw[p + 1] = col[1];
      raw[p + 2] = col[2];
    }
  }
  return encodePngRGB(S, raw);
}

const rocketCache = new Map<number, Promise<Uint8Array>>();
export async function serveSiteIcon(size: number): Promise<Response> {
  let p = rocketCache.get(size);
  if (!p) {
    p = renderRocket(size);
    rocketCache.set(size, p);
  }
  return new Response((await p).slice(), {
    headers: { "content-type": "image/png", "cache-control": "public, max-age=86400" },
  });
}

export function siteManifest(): Response {
  const body = {
    name: "ship it",
    short_name: "ship it",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#0c0c0d",
    theme_color: "#0c0c0d",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/manifest+json; charset=utf-8" } });
}

// Tags injected into the apex site's <head> so it installs as a PWA (absolute paths; apex has no <base>).
export const SITE_PWA_HEAD =
  `<link rel="manifest" href="/manifest.webmanifest">` +
  `<meta name="theme-color" content="#0c0c0d">` +
  `<meta name="mobile-web-app-capable" content="yes">` +
  `<meta name="apple-mobile-web-app-capable" content="yes">` +
  `<meta name="apple-mobile-web-app-status-bar-style" content="black">` +
  `<meta name="apple-mobile-web-app-title" content="ship it">` +
  `<link rel="apple-touch-icon" href="/apple-touch-icon.png">` +
  `<script>if('serviceWorker' in navigator)addEventListener('load',function(){navigator.serviceWorker.register('/sw.js')});</script>`;

// Site service worker: network-first; never touches auth/API/MCP; offline-falls-back to "/".
const SITE_SW_JS = `const C='ship-it-site-v1';
self.addEventListener('install',function(){self.skipWaiting()});
self.addEventListener('activate',function(e){e.waitUntil(caches.keys().then(function(k){return Promise.all(k.filter(function(x){return x!==C}).map(function(x){return caches.delete(x)}))}).then(function(){return self.clients.claim()}))});
self.addEventListener('fetch',function(e){
  if(e.request.method!=='GET')return;
  var p=new URL(e.request.url).pathname;
  if(/^\\/(api|auth|authorize|mcp|admin|token|register)(\\/|$)/.test(p)||p.indexOf('/.well-known')===0)return;
  e.respondWith(fetch(e.request).then(function(r){var c=r.clone();caches.open(C).then(function(k){k.put(e.request,c)});return r}).catch(function(){return caches.match(e.request).then(function(r){return r||caches.match('/')})}));
});`;
export function serveSiteSW(): Response {
  return new Response(SITE_SW_JS, { headers: { "content-type": "text/javascript; charset=utf-8" } });
}
