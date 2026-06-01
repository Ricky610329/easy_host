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

export async function serveIcon(size: number): Promise<Response> {
  const png = await getIcon(size);
  return new Response(png.slice(), {
    headers: { "content-type": "image/png", "cache-control": "public, max-age=31536000, immutable" },
  });
}
