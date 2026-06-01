// Server-rendered HTML pages: the manual upload form (/) and the owner dashboard (/dashboard).
import type { SessionUser } from "./types";
import { escapeAttr, safeJson } from "./util";
import { SITE_PWA_HEAD } from "./pwa";

// Brand favicon for the easy_host site itself (the apps under /s/:id/ get their own generated icons).
export const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><text x="32" y="37" font-size="52" text-anchor="middle" dominant-baseline="central">🚀</text></svg>`;
const FAVICON_LINK = `<link rel="icon" href="/favicon.svg?v=2" type="image/svg+xml">`;

// Shared minimal style: monospace, near-monochrome, generous whitespace. No chromatic accent.
const BASE_CSS = `
  :root{--bg:#0c0c0d;--fg:#ededec;--mut:#7c7c82;--line:#1f1f22;--field:#111113;--btn:#ededec;--btnfg:#0c0c0d}
  *{box-sizing:border-box}
  html,body{margin:0}
  body{font:14px/1.65 ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,monospace;background:var(--bg);color:var(--fg);-webkit-font-smoothing:antialiased;display:flex;justify-content:center;padding:0 20px}
  a{color:#9ecbff;text-decoration:none}a:hover{text-decoration:underline}
  header.top{display:flex;align-items:center;justify-content:space-between;margin-bottom:48px}
  .brand{font-weight:600;letter-spacing:.3px}
  header.top nav a{color:var(--mut);margin-left:18px;font-size:13px}
  header.top nav a:hover{color:var(--fg);text-decoration:none}
  label{display:block;color:var(--mut);font-size:12px;margin:18px 0 7px}
  input,textarea{width:100%;background:var(--field);border:1px solid var(--line);color:var(--fg);border-radius:8px;padding:10px 12px;font:inherit}
  input::placeholder,textarea::placeholder{color:#48484d}
  input:focus,textarea:focus{outline:none;border-color:#3a3a40}
`;

export function renderLanding(user: SessionUser | null): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ship it</title>
${FAVICON_LINK}${SITE_PWA_HEAD}
<style>
${BASE_CSS}
  .wrap{width:100%;max-width:560px;padding:60px 0 80px}
  h1{font-size:21px;font-weight:600;letter-spacing:-.2px;margin:0 0 10px;line-height:1.35}
  .lead{color:var(--mut);margin:0 0 8px}
  .row{display:flex;gap:12px}.row>div{flex:1}
  textarea{min-height:180px;font-size:13px;resize:vertical}
  .file{margin-top:14px;color:var(--mut);font-size:12px}
  .filebtn{display:inline-block;margin:0;border:1px solid var(--line);background:var(--field);color:var(--fg);border-radius:7px;padding:7px 12px;font-size:12px;cursor:pointer}
  .filebtn:hover{border-color:#3a3a40}
  #fname{color:var(--mut);font-size:12px;margin-left:8px}
  #go{margin-top:24px;width:100%;background:transparent;color:var(--fg);border:1px solid #2e2e34;border-radius:8px;padding:13px;font:inherit;font-weight:600;letter-spacing:.3px;cursor:pointer;transition:background .15s,border-color .15s}
  #go:hover{background:#141416;border-color:#45454d}#go:disabled{opacity:.4;cursor:default}
  #out{margin-top:24px;border:1px solid var(--line);border-radius:8px;padding:14px;display:none}
  #out.show{display:block}
  #link{display:block;word-break:break-all;margin:6px 0 12px}
  #copy{background:transparent;border:1px solid var(--line);color:var(--fg);border-radius:7px;padding:7px 12px;font:inherit;cursor:pointer}
  .hint{color:var(--mut);font-size:12px;margin:12px 0 0}
  .priv{color:var(--mut);font-size:12px;margin:14px 0 0}
  .signin{display:inline-block;border:1px solid var(--line);background:var(--field);color:var(--fg);border-radius:8px;padding:8px 14px;font-size:13px}
  .signin:hover{border-color:#45454d;text-decoration:none}
  header.top nav .who{color:var(--mut);font-size:12px;margin-right:4px}
  #authnote{display:none;margin-top:16px;border:1px solid #45454d;border-radius:8px;padding:16px;font-size:13px;color:var(--fg)}
</style>
</head>
<body>
<div class="wrap">
  <header class="top">
    <div class="brand">ship it <span>🚀</span></div>
    <nav><a href="/how">How it works</a>${user ? `<span class="who">${escapeAttr(user.email)}</span><a href="/dashboard">Dashboard</a>` : `<a class="signin" href="/auth/login?next=%2F">Sign in with Google</a>`}</nav>
  </header>

  <h1>Ship a real app to your phone.</h1>
  <p class="lead">Ask your AI to build it — or paste HTML below. You get an installable web app with storage and push notifications. No app store.</p>

  <div class="row">
    <div><label>App name (optional)</label><input id="name" type="text" placeholder="My App"></div>
    <div><label>Theme color (optional)</label><input id="theme" type="text" placeholder="#0ea5e9"></div>
  </div>
  <label>HTML — paste below, or choose a .html file</label>
  <textarea id="html" placeholder="<!doctype html>..."></textarea>
  <div class="file"><label class="filebtn" for="file">Choose .html file</label><span id="fname">No file chosen</span><input id="file" type="file" accept=".html,text/html" style="display:none"></div>
  <button id="go">Create app link</button>
  <p class="priv">Apps are <b>private by default</b> — only you can open them. Set one to <b>public</b> in your <a href="/dashboard">dashboard</a> to share.</p>

  <div id="authnote">Sign in to publish your app.<br><a class="signin" href="/auth/login?next=%2F" style="margin-top:10px">Sign in with Google</a></div>

  <div id="out">
    <div class="mut" style="color:var(--mut);font-size:12px">Your app is live at</div>
    <a id="link" href="#"></a>
    <button id="copy">Copy link</button>
    <p class="hint">Open this link on your phone, then <b>Add to Home Screen</b> (iOS Safari) or <b>Install</b> (Android Chrome).</p>
  </div>
</div>
<script>
var $=function(id){return document.getElementById(id)};
$('file').addEventListener('change',function(e){
  var f=e.target.files[0];$('fname').textContent=f?f.name:'No file chosen';if(!f)return;
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
    if(res.status===401){$('authnote').style.display='block';return}
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
}

// "How it works" walkthrough: connect the Claude connector -> ask Claude to build -> open in a real
// browser -> Add to Home Screen. Same minimal aesthetic as the landing.
export function renderHow(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>ship it — how it works</title>
${FAVICON_LINK}${SITE_PWA_HEAD}
<style>${BASE_CSS}
  .wrap{width:100%;max-width:640px;padding:56px 0 96px}
  h1{font-size:22px;font-weight:600;letter-spacing:-.2px;margin:0 0 8px}
  .lead{color:var(--mut);margin:0 0 42px}
  ol.steps{list-style:none;margin:0;padding:0;counter-reset:s}
  ol.steps>li{position:relative;padding:0 0 32px 54px;counter-increment:s}
  ol.steps>li:not(:last-child)::after{content:"";position:absolute;left:17px;top:38px;bottom:-2px;width:1px;background:var(--line)}
  .num{position:absolute;left:0;top:0;width:35px;height:35px;border:1px solid #2e2e34;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:14px;color:#9ecbff;background:var(--field)}
  .num::before{content:counter(s)}
  .st{font-size:15px;font-weight:600;margin:6px 0 7px}
  .sd{color:var(--mut);margin:0 0 4px}
  .sd b{color:var(--fg);font-weight:600}
  code.chip{display:inline-block;background:var(--field);border:1px solid var(--line);border-radius:6px;padding:4px 9px;color:#9ecbff;font-size:13px;margin-top:9px;word-break:break-all}
  .note{margin-top:13px;border:1px solid #45454d;border-radius:8px;padding:13px 14px;font-size:13px;color:var(--fg);line-height:1.6}
  .note b{color:#9ecbff}
  .alt{margin-top:8px;color:var(--mut);font-size:13px}
  footer{margin-top:46px;color:var(--mut);font-size:12px;border-top:1px solid var(--line);padding-top:18px}
</style></head>
<body><div class="wrap">
  <header class="top"><div class="brand">ship it 🚀</div><nav><a href="/">Home</a></nav></header>

  <h1>How it works</h1>
  <p class="lead">Ask Claude to build an app, then install it on your phone. No app store, no build tools — about five minutes end to end.</p>

  <ol class="steps">
    <li><div class="num"></div>
      <div class="st">Connect ship it to Claude — once</div>
      <p class="sd">In Claude, open <b>Settings → Connectors → Add custom connector</b> and paste this URL. Authorize with your Google account when prompted.</p>
      <code class="chip">https://ship-it-app.com/mcp</code>
    </li>
    <li><div class="num"></div>
      <div class="st">Ask Claude to build your app</div>
      <p class="sd">Just describe it — e.g. <b>“Build a water reminder that pings me every 2 hours.”</b> Claude generates the app, publishes it here, and replies with a link.</p>
    </li>
    <li><div class="num"></div>
      <div class="st">Open the link in your phone's browser</div>
      <p class="sd">Open it in <b>Safari</b> (iPhone) or <b>Chrome</b> (Android) — your normal browser, not an in-app one. Sign in with the same Google account; your apps are private to you.</p>
    </li>
    <li><div class="num"></div>
      <div class="st">Add it to your Home Screen</div>
      <p class="sd"><b>iPhone:</b> tap the <b>Share</b> button → scroll down → <b>Add to Home Screen</b> → Add.</p>
      <p class="sd"><b>Android:</b> tap the <b>⋮</b> menu → <b>Install app</b>.</p>
      <div class="note"><b>iOS heads-up:</b> notifications only work after the app is on your Home Screen and opened from its icon — not in a Safari tab. So add it here <b>before</b> turning on reminders.</div>
    </li>
    <li><div class="num"></div>
      <div class="st">Open it from the icon — done</div>
      <p class="sd">Launch from the home-screen icon. It runs full-screen, works offline, saves your data, and can send real push notifications.</p>
    </li>
  </ol>

  <footer>No Claude? You can <a href="/">paste your own HTML</a> on the home page instead.</footer>
</div></body></html>`;
}

// Shown site-wide (account site + every app) when the service is hard-closed — either the operator
// flipped /admin/close or the daily-request budget tripped. Friendly, not an error wall.
export function renderOops(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>ship it — taking a breather</title>
${FAVICON_LINK}
<style>${BASE_CSS}
  .wrap{width:100%;max-width:480px;padding:96px 0 80px;text-align:center}
  .rk{font-size:46px;line-height:1;margin-bottom:22px}
  h1{font-size:19px;font-weight:600;margin:0 0 12px}
  p{color:var(--mut);margin:0 0 10px}
</style></head><body><div class="wrap">
  <div class="rk">🚀</div>
  <h1>ship it is taking a breather</h1>
  <p>Too many people are using the free demo right now, so it's paused to keep it free.</p>
  <p>Please check back a little later — your installed apps and data are safe.</p>
</div></body></html>`;
}

// Branded interstitial shown on an app subdomain when a logged-out (or wrong-account) visitor opens a
// PRIVATE app — instead of bouncing straight to a bare Google consent screen with no context.
export function renderAppGate(loginUrl: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><title>Private app — ship it</title>
${FAVICON_LINK}
<style>${BASE_CSS}
  body{align-items:center}
  .wrap{width:100%;max-width:400px;padding:0 0 env(safe-area-inset-bottom);text-align:center}
  .rk{font-size:42px;line-height:1;margin-bottom:20px}
  h1{font-size:18px;font-weight:600;margin:0 0 10px}
  p{color:var(--mut);margin:0 0 22px}
  .signin{display:inline-block;border:1px solid #2e2e34;background:transparent;color:var(--fg);border-radius:8px;padding:13px 22px;font-weight:600;letter-spacing:.3px}
  .signin:hover{background:#141416;border-color:#45454d;text-decoration:none}
  .brand{margin-top:30px;font-size:12px;color:var(--mut)}
</style></head><body><div class="wrap">
  <div class="rk">🚀</div>
  <h1>This app is private</h1>
  <p>It's hosted on ship it and only its owner can open it. Sign in with the Google account that created it.</p>
  <a class="signin" href="${escapeAttr(loginUrl)}">Sign in with Google</a>
  <div class="brand">ship it · install AI-built apps on your phone</div>
</div></body></html>`;
}

export function renderDashboard(user: SessionUser, apps: { id: string; name?: string; visibility: string }[]): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>ship it — dashboard</title>
${FAVICON_LINK}${SITE_PWA_HEAD}
<style>
${BASE_CSS}
  .wrap{width:100%;max-width:640px;padding:48px 0 80px}
  h1{font-size:18px;margin:0;font-weight:600}
  .card{background:var(--field);border:1px solid var(--line);border-radius:10px;padding:14px;margin-bottom:10px}
  .card h3{margin:0 0 4px;font-size:15px;font-weight:600}
  .ctl{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:10px}
  select,button{background:#0c0e11;color:var(--fg);border:1px solid var(--line);border-radius:7px;padding:7px 10px;font:inherit;cursor:pointer}
  button.del{border-color:#3a2326;color:#ff9aa8}
  .empty{color:var(--mut);padding:24px 0}
</style></head><body><div class="wrap">
<header class="top"><div class="brand">ship it 🚀 · your apps</div><nav><span class="mut" style="color:var(--mut);font-size:12px">${escapeAttr(user.email)}</span><a href="/">new</a><a href="/auth/logout">log out</a></nav></header>
<div id="list"></div>
<p class="mut" style="color:var(--mut);font-size:12px;margin-top:18px">Build apps by asking your AI (connector) or via the <a href="/">paste form</a>.</p>
<script>
var APPS=${safeJson(apps)};
var list=document.getElementById('list');
function render(){
  if(!APPS.length){list.innerHTML='<div class="empty">No apps yet.</div>';return}
  list.innerHTML=APPS.map(function(a){
    var url=location.origin+'/s/'+a.id+'/';
    return '<div class="card" data-id="'+a.id+'"><h3>'+(a.name||'(untitled)')+'</h3>'+
      '<div class="mut" style="color:#7c7c82;font-size:12px"><a href="'+url+'" target="_blank">'+url+'</a></div>'+
      '<div class="ctl"><select class="vis">'+
        ['private','public'].map(function(v){return '<option value="'+v+'"'+(a.visibility===v?' selected':'')+'>'+v+'</option>'}).join('')+
      '</select><button class="copy">Copy link</button><button class="del">Delete</button></div></div>';
  }).join('');
}
render();
list.addEventListener('change',function(e){
  if(!e.target.classList.contains('vis'))return;
  var id=e.target.closest('.card').dataset.id;
  fetch('/api/apps/'+id+'/visibility',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({visibility:e.target.value})});
});
list.addEventListener('click',function(e){
  var rowEl=e.target.closest('.card');if(!rowEl)return;var id=rowEl.dataset.id;
  if(e.target.classList.contains('copy')){navigator.clipboard.writeText(location.origin+'/s/'+id+'/');e.target.textContent='Copied!';setTimeout(function(){e.target.textContent='Copy link'},1200)}
  if(e.target.classList.contains('del')){if(!confirm('Delete this app?'))return;fetch('/api/apps/'+id,{method:'DELETE'}).then(function(){APPS=APPS.filter(function(a){return a.id!==id});render()})}
});
</script></div></body></html>`;
}
