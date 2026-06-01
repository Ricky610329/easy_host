// Server-rendered HTML pages: the manual upload form (/) and the owner dashboard (/dashboard).
import type { SessionUser } from "./types";
import { escapeAttr, safeJson } from "./util";

export const LANDING = `<!doctype html>
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
    if(res.status===401){window.location='/auth/login?next=%2F';return}
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

export function renderDashboard(user: SessionUser, apps: { id: string; name?: string; visibility: string }[]): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>easy_host — dashboard</title>
<style>
  :root{--bg:#0b0b10;--fg:#e7e7ee;--mut:#9aa0b0;--ac:#4f46e5;--card:#15151d;--line:#2a2a36}
  *{box-sizing:border-box}body{margin:0;font:16px/1.5 system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--fg);display:flex;justify-content:center;padding:32px 16px}
  main{width:100%;max-width:680px}
  header{display:flex;align-items:center;justify-content:space-between;margin-bottom:20px}
  h1{font-size:22px;margin:0}.mut{color:var(--mut);font-size:13px}
  a{color:#a5b4fc}
  .row{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px;margin-bottom:10px}
  .row h3{margin:0 0 4px;font-size:16px}
  .ctl{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:8px}
  select,button{background:#0f0f17;color:var(--fg);border:1px solid var(--line);border-radius:8px;padding:8px 10px;font:inherit;cursor:pointer}
  button.del{border-color:#5b2330;color:#ff9aa8}
  .empty{color:var(--mut);padding:24px 0}
</style></head><body><main>
<header><h1>Your apps</h1><div class="mut">${escapeAttr(user.email)} · <a href="/auth/logout">log out</a></div></header>
<div id="list"></div>
<p class="mut">Build new apps by asking your AI (connector) or via the <a href="/">paste form</a>.</p>
<script>
var APPS=${safeJson(apps)};
var list=document.getElementById('list');
function render(){
  if(!APPS.length){list.innerHTML='<div class="empty">No apps yet.</div>';return}
  list.innerHTML=APPS.map(function(a){
    var url=location.origin+'/s/'+a.id+'/';
    return '<div class="row" data-id="'+a.id+'"><h3>'+(a.name||'(untitled)')+'</h3>'+
      '<div class="mut"><a href="'+url+'" target="_blank">'+url+'</a></div>'+
      '<div class="ctl"><select class="vis">'+
        ['unlisted','private','public'].map(function(v){return '<option value="'+v+'"'+(a.visibility===v?' selected':'')+'>'+v+'</option>'}).join('')+
      '</select><button class="copy">Copy link</button><button class="del">Delete</button></div></div>';
  }).join('');
}
render();
list.addEventListener('change',function(e){
  if(!e.target.classList.contains('vis'))return;
  var id=e.target.closest('.row').dataset.id;
  fetch('/api/apps/'+id+'/visibility',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({visibility:e.target.value})});
});
list.addEventListener('click',function(e){
  var rowEl=e.target.closest('.row');if(!rowEl)return;var id=rowEl.dataset.id;
  if(e.target.classList.contains('copy')){navigator.clipboard.writeText(location.origin+'/s/'+id+'/');e.target.textContent='Copied!';setTimeout(function(){e.target.textContent='Copy link'},1200)}
  if(e.target.classList.contains('del')){if(!confirm('Delete this app?'))return;fetch('/api/apps/'+id,{method:'DELETE'}).then(function(){APPS=APPS.filter(function(a){return a.id!==id});render()})}
});
</script></main></body></html>`;
}
