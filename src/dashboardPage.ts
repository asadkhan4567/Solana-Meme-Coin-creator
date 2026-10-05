/**
 * Self-contained dashboard page (no external scripts or fonts: the server's CSP forbids them).
 * Charts are hand-drawn SVG. All data-derived text goes through textContent / setAttribute,
 * never innerHTML: coin names come from an AI and are untrusted.
 * NOTE: this string is a template literal, so the embedded JS avoids backticks and dollar-brace.
 */
export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Meme Agent Control</title>
<style>
:root{
  --bg:#07080d;--bg2:#0d0f17;--panel:#11141f;--panel2:#161a28;--line:#232839;--line2:#2e3550;
  --text:#e9ecf5;--muted:#8a91a8;--faint:#5b6280;
  --sol:#9945ff;--mint:#14f195;--amber:#ffb547;--red:#ff5c7a;--blue:#4fa3ff;
  --r:14px;
  --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  --sans:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 var(--sans)}
body{min-height:100vh;background:
  radial-gradient(900px 500px at 85% -10%,rgba(153,69,255,.16),transparent 60%),
  radial-gradient(700px 400px at -10% 110%,rgba(20,241,149,.08),transparent 60%),var(--bg)}
button{font:inherit;color:inherit;cursor:pointer}
a{color:var(--mint);text-decoration:none}a:hover{text-decoration:underline}
.mono{font-family:var(--mono)}
.muted{color:var(--muted)}
.wrap{max-width:1320px;margin:0 auto;padding:20px 20px 60px}

/* header */
header{display:flex;align-items:center;gap:16px;flex-wrap:wrap;margin-bottom:18px}
.brand{display:flex;align-items:center;gap:12px;margin-right:auto}
.logo{width:38px;height:38px;border-radius:11px;background:linear-gradient(135deg,var(--sol),var(--mint));
  display:grid;place-items:center;font-weight:800;color:#07080d;font-size:18px;box-shadow:0 0 24px rgba(153,69,255,.45)}
.brand h1{font-size:18px;margin:0;letter-spacing:.2px}
.brand small{display:block;color:var(--muted);font-size:12px}
.pill{display:inline-flex;align-items:center;gap:7px;padding:6px 11px;border-radius:99px;border:1px solid var(--line2);
  background:var(--panel);font-size:12px;font-weight:600;white-space:nowrap}
.dot{width:8px;height:8px;border-radius:50%;background:var(--faint)}
.dot.ok{background:var(--mint);box-shadow:0 0 10px var(--mint)}
.dot.warn{background:var(--amber);box-shadow:0 0 10px var(--amber)}
.dot.bad{background:var(--red);box-shadow:0 0 10px var(--red)}
.btn{padding:8px 14px;border-radius:10px;border:1px solid var(--line2);background:var(--panel2);font-weight:600;font-size:13px}
.btn:hover{border-color:var(--sol)}
.btn.primary{background:linear-gradient(135deg,var(--sol),#6b2fd6);border-color:transparent}
.btn.primary:hover{filter:brightness(1.12)}
.btn:disabled{opacity:.5;cursor:wait}

/* tabs */
nav.tabs{display:flex;gap:4px;padding:4px;background:var(--panel);border:1px solid var(--line);border-radius:12px;
  margin-bottom:18px;overflow-x:auto;scrollbar-width:none}
nav.tabs button{flex:0 0 auto;border:0;background:transparent;padding:9px 16px;border-radius:9px;color:var(--muted);font-weight:600}
nav.tabs button:hover{color:var(--text)}
nav.tabs button[aria-selected=true]{background:var(--panel2);color:var(--text);box-shadow:inset 0 -2px 0 var(--sol)}
.tab{display:none;animation:fade .25s ease}.tab.active{display:block}
@keyframes fade{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}

/* layout */
.grid{display:grid;gap:14px}
.kpis{grid-template-columns:repeat(auto-fit,minmax(170px,1fr));margin-bottom:14px}
.cols-2{grid-template-columns:repeat(auto-fit,minmax(min(100%,420px),1fr))}
.cols-3{grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr))}
.card{background:linear-gradient(180deg,var(--panel),var(--bg2));border:1px solid var(--line);border-radius:var(--r);padding:16px;min-width:0}
.card h3{margin:0 0 12px;font-size:13px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;
  display:flex;justify-content:space-between;align-items:center}
.kpi .label{color:var(--muted);font-size:12px;font-weight:600}
.kpi .value{font-size:26px;font-weight:750;margin-top:4px;font-variant-numeric:tabular-nums;letter-spacing:-.5px}
.kpi .sub{color:var(--faint);font-size:12px;margin-top:2px}
.pos{color:var(--mint)}.neg{color:var(--red)}
.chart{width:100%;height:auto;display:block}
.legend{display:flex;gap:14px;flex-wrap:wrap;font-size:12px;color:var(--muted);margin-top:8px}
.legend i{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:6px;vertical-align:-1px}
.empty{color:var(--faint);text-align:center;padding:34px 10px;font-size:13px}

/* bars */
.bars{display:flex;flex-direction:column;gap:10px}
.bar-row{display:grid;grid-template-columns:120px 1fr 64px;gap:10px;align-items:center;font-size:13px}
.bar-row .name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.track{height:10px;background:var(--bg);border-radius:99px;overflow:hidden;border:1px solid var(--line)}
.fill{height:100%;border-radius:99px;background:linear-gradient(90deg,var(--sol),var(--mint));transition:width .6s ease}
.bar-row .num{text-align:right;font-family:var(--mono);color:var(--muted)}

/* launches */
.toolbar{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px;align-items:center}
.search{flex:1 1 220px;padding:9px 12px;border-radius:10px;border:1px solid var(--line2);background:var(--panel);color:var(--text);font:inherit}
.search:focus{outline:none;border-color:var(--sol)}
.seg{display:inline-flex;border:1px solid var(--line2);border-radius:10px;overflow:hidden}
.seg button{border:0;background:var(--panel);padding:8px 12px;color:var(--muted);font-weight:600;font-size:12px}
.seg button.on{background:var(--panel2);color:var(--text)}
.gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:12px}
.coin{background:var(--panel);border:1px solid var(--line);border-radius:var(--r);overflow:hidden;cursor:pointer;
  transition:transform .15s ease,border-color .15s ease;text-align:left;padding:0}
.coin:hover{transform:translateY(-2px);border-color:var(--sol)}
.coin .img{aspect-ratio:1;background:linear-gradient(135deg,#1b1f31,#0e1019);display:grid;place-items:center;
  font-size:34px;font-weight:800;color:var(--line2)}
.coin .img img{width:100%;height:100%;object-fit:cover;display:block}
.coin .body{padding:10px 12px 12px}
.coin .t{display:flex;justify-content:space-between;gap:8px;align-items:baseline}
.coin .t b{font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.coin .meta{font-size:12px;color:var(--muted);margin-top:4px;display:flex;justify-content:space-between}
.tag{font-size:10.5px;font-weight:700;padding:2px 7px;border-radius:6px;letter-spacing:.04em;text-transform:uppercase;white-space:nowrap}
.tag.success{background:rgba(20,241,149,.14);color:var(--mint)}
.tag.dud{background:rgba(255,92,122,.14);color:var(--red)}
.tag.pending{background:rgba(255,181,71,.14);color:var(--amber)}
.tag.dry{background:rgba(79,163,255,.14);color:var(--blue)}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:10px 8px;border-bottom:1px solid var(--line)}
th{color:var(--faint);font-weight:600;font-size:11.5px;text-transform:uppercase;letter-spacing:.06em}
tbody tr{cursor:pointer}tbody tr:hover{background:var(--panel2)}
.table-wrap{overflow-x:auto}

/* modal */
.modal{position:fixed;inset:0;background:rgba(3,4,8,.72);backdrop-filter:blur(6px);display:none;place-items:center;padding:16px;z-index:20}
.modal.open{display:grid}
.sheet{width:min(720px,100%);max-height:90vh;overflow:auto;background:var(--panel);border:1px solid var(--line2);border-radius:18px;padding:20px}
.sheet-head{display:flex;gap:16px;align-items:center;margin-bottom:16px}
.sheet-head .thumb{width:84px;height:84px;border-radius:14px;overflow:hidden;background:var(--bg);flex:0 0 auto}
.sheet-head .thumb img{width:100%;height:100%;object-fit:cover}
.sheet-head h2{margin:0;font-size:22px}
.kv{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:14px 0}
.kv div{background:var(--bg2);border:1px solid var(--line);border-radius:10px;padding:10px}
.kv span{display:block;font-size:11px;color:var(--faint);text-transform:uppercase;letter-spacing:.06em}
.kv b{font-size:14px;font-family:var(--mono);word-break:break-all}

/* system */
.list{display:flex;flex-direction:column}
.list .row{display:flex;justify-content:space-between;gap:12px;padding:9px 0;border-bottom:1px solid var(--line);font-size:13px}
.list .row:last-child{border:0}
.list .row span:first-child{color:var(--muted)}
.list .row span:last-child{font-family:var(--mono);text-align:right;word-break:break-all}
.chips{display:flex;gap:6px;flex-wrap:wrap}
.chip{padding:3px 9px;border-radius:99px;background:var(--panel2);border:1px solid var(--line2);font-size:12px;font-family:var(--mono)}
.toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%) translateY(20px);opacity:0;background:var(--panel2);
  border:1px solid var(--line2);padding:11px 18px;border-radius:12px;transition:all .25s ease;z-index:30;font-weight:600}
.toast.show{opacity:1;transform:translateX(-50%)}
.banner{display:none;margin-bottom:14px;padding:11px 14px;border-radius:12px;font-weight:600;font-size:13px}
.banner.show{display:block}
.banner.dry{background:rgba(79,163,255,.1);border:1px solid rgba(79,163,255,.35);color:#a9cfff}
.banner.paused{background:rgba(255,181,71,.1);border:1px solid rgba(255,181,71,.35);color:var(--amber)}
@media (max-width:640px){.bar-row{grid-template-columns:90px 1fr 50px}.kpi .value{font-size:22px}}
</style>
</head>
<body>
<div class="wrap">
<header>
  <div class="brand"><div class="logo">M</div><div><h1>Meme Agent Control</h1><small id="updated">Loading...</small></div></div>
  <span class="pill"><span class="dot" id="health-dot"></span><span id="health-text">-</span></span>
  <span class="pill" id="mode-pill">-</span>
  <span class="pill mono" id="balance-pill">- SOL</span>
  <button class="btn" id="btn-fees">Collect fees</button>
  <button class="btn primary" id="btn-run">Run cycle now</button>
</header>

<div class="banner dry" id="banner-dry">Dry-run mode: cycles simulate launches and spend no SOL. Set DRY_RUN=false in .env to go live.</div>
<div class="banner paused" id="banner-paused"></div>

<nav class="tabs" role="tablist">
  <button role="tab" data-tab="overview" aria-selected="true">Overview</button>
  <button role="tab" data-tab="launches" aria-selected="false">Launches</button>
  <button role="tab" data-tab="arena" aria-selected="false">AI Arena</button>
  <button role="tab" data-tab="trends" aria-selected="false">Trends</button>
  <button role="tab" data-tab="money" aria-selected="false">Wallet &amp; Fees</button>
  <button role="tab" data-tab="system" aria-selected="false">System</button>
</nav>

<!-- OVERVIEW -->
<section class="tab active" id="tab-overview">
  <div class="grid kpis">
    <div class="card kpi"><div class="label">Live launches</div><div class="value" id="k-live">-</div><div class="sub" id="k-live-sub"></div></div>
    <div class="card kpi"><div class="label">Win rate (24h)</div><div class="value" id="k-win">-</div><div class="sub" id="k-win-sub"></div></div>
    <div class="card kpi"><div class="label">SOL spent</div><div class="value" id="k-spent">-</div><div class="sub">initial buys</div></div>
    <div class="card kpi"><div class="label">Fees earned</div><div class="value" id="k-fees">-</div><div class="sub">creator fees</div></div>
    <div class="card kpi"><div class="label">Net (fees - buys)</div><div class="value" id="k-net">-</div><div class="sub">excl. tokens held</div></div>
    <div class="card kpi"><div class="label">Dry runs</div><div class="value" id="k-dry">-</div><div class="sub">simulated</div></div>
  </div>
  <div class="grid cols-2">
    <div class="card"><h3>Launches per day</h3><div id="c-daily"></div>
      <div class="legend"><span><i style="background:var(--sol)"></i>Live</span><span><i style="background:var(--blue)"></i>Dry run</span></div></div>
    <div class="card"><h3>Outcomes</h3><div id="c-outcomes"></div></div>
    <div class="card"><h3>Cumulative SOL: spent vs fees</h3><div id="c-cum"></div>
      <div class="legend"><span><i style="background:var(--red)"></i>Spent</span><span><i style="background:var(--mint)"></i>Fees</span></div></div>
    <div class="card"><h3>Latest coins</h3><div class="gallery" id="latest"></div></div>
  </div>
</section>

<!-- LAUNCHES -->
<section class="tab" id="tab-launches">
  <div class="toolbar">
    <input class="search" id="q" placeholder="Search name, ticker or theme..." autocomplete="off">
    <div class="seg" id="f-status">
      <button data-v="all" class="on">All</button><button data-v="live">Live</button><button data-v="dry">Dry</button>
      <button data-v="success">Success</button><button data-v="pending">Pending</button><button data-v="dud">Dud</button>
    </div>
    <div class="seg" id="f-view"><button data-v="grid" class="on">Grid</button><button data-v="table">Table</button></div>
  </div>
  <div id="launch-grid" class="gallery"></div>
  <div id="launch-table" class="card table-wrap" style="display:none;padding:6px 10px">
    <table><thead><tr><th>Time</th><th>Coin</th><th>Theme</th><th>Status</th><th>Buy</th><th>Mcap</th><th>Fees</th><th>Writer</th></tr></thead>
    <tbody id="launch-rows"></tbody></table>
  </div>
  <div class="empty" id="launch-empty" style="display:none">No launches match.</div>
</section>

<!-- AI ARENA -->
<section class="tab" id="tab-arena">
  <div class="grid cols-2">
    <div class="card"><h3>Concept writers: wins</h3><div class="bars" id="b-llm"></div></div>
    <div class="card"><h3>Logo artists: wins</h3><div class="bars" id="b-img"></div></div>
    <div class="card"><h3>Writer success rate (live, 24h)</h3><div class="bars" id="b-llm-sr"></div></div>
    <div class="card"><h3>Artist success rate (live, 24h)</h3><div class="bars" id="b-img-sr"></div></div>
  </div>
</section>

<!-- TRENDS -->
<section class="tab" id="tab-trends">
  <div class="grid cols-2">
    <div class="card"><h3>Trend sources: launches</h3><div class="bars" id="b-src"></div></div>
    <div class="card"><h3>Trend sources: success rate</h3><div class="bars" id="b-src-sr"></div></div>
    <div class="card"><h3>Top themes</h3><div class="bars" id="b-themes"></div></div>
    <div class="card"><h3>Launches by hour (UTC)</h3><div id="c-hours"></div></div>
  </div>
</section>

<!-- MONEY -->
<section class="tab" id="tab-money">
  <div class="grid kpis">
    <div class="card kpi"><div class="label">Wallet balance</div><div class="value" id="m-bal">-</div><div class="sub mono" id="m-wallet"></div></div>
    <div class="card kpi"><div class="label">Spent</div><div class="value neg" id="m-spent">-</div><div class="sub">SOL</div></div>
    <div class="card kpi"><div class="label">Fees</div><div class="value pos" id="m-fees">-</div><div class="sub">SOL</div></div>
    <div class="card kpi"><div class="label">Avg buy / launch</div><div class="value" id="m-avg">-</div><div class="sub">SOL</div></div>
  </div>
  <div class="grid cols-2">
    <div class="card"><h3>Fees earned per coin</h3><div class="bars" id="b-fees"></div></div>
    <div class="card"><h3>Best market caps</h3><div class="bars" id="b-mcap"></div></div>
  </div>
</section>

<!-- SYSTEM -->
<section class="tab" id="tab-system">
  <div class="grid cols-3">
    <div class="card"><h3>Scheduler</h3><div class="list" id="l-sched"></div></div>
    <div class="card"><h3>Risk limits</h3><div class="list" id="l-limits"></div></div>
    <div class="card"><h3>Providers</h3>
      <div class="muted" style="font-size:12px;margin-bottom:6px">Writers / judges</div><div class="chips" id="p-llm"></div>
      <div class="muted" style="font-size:12px;margin:14px 0 6px">Logo artists</div><div class="chips" id="p-img"></div>
      <div class="muted" style="font-size:12px;margin:16px 0 0">Change these in .env, then restart the agent.</div>
    </div>
  </div>
</section>
</div>

<div class="modal" id="modal" aria-hidden="true"><div class="sheet" role="dialog" aria-modal="true">
  <div class="sheet-head"><div class="thumb" id="d-thumb"></div>
    <div style="flex:1;min-width:0"><h2 id="d-name"></h2><div class="muted mono" id="d-ticker"></div></div>
    <button class="btn" id="d-close">Close</button></div>
  <div class="kv" id="d-kv"></div>
  <div class="card" style="padding:12px"><h3>Market cap (USD)</h3><div id="d-chart"></div></div>
  <div style="margin-top:12px;display:flex;gap:10px;flex-wrap:wrap" id="d-links"></div>
</div></div>
<div class="toast" id="toast"></div>

<script>
(function(){
"use strict";
var DATA=null, FILTER="all", VIEW="grid", QUERY="";
var NS="http://www.w3.org/2000/svg";
var C={sol:"#9945ff",mint:"#14f195",blue:"#4fa3ff",red:"#ff5c7a",amber:"#ffb547",line:"#232839",faint:"#5b6280",muted:"#8a91a8"};

function $(id){return document.getElementById(id)}
function el(tag,attrs,text){var e=document.createElement(tag);if(attrs)for(var k in attrs)e.setAttribute(k,attrs[k]);if(text!=null)e.textContent=text;return e}
function svg(tag,attrs){var e=document.createElementNS(NS,tag);for(var k in attrs)e.setAttribute(k,attrs[k]);return e}
function clear(n){while(n.firstChild)n.removeChild(n.firstChild);return n}
function sol(n){return n==null?"-":(Math.abs(n)>=1?n.toFixed(3):n.toFixed(4))}
function usd(n){if(n==null)return "-";if(n>=1e6)return "$"+(n/1e6).toFixed(2)+"M";if(n>=1e3)return "$"+(n/1e3).toFixed(1)+"k";return "$"+Math.round(n)}
function pct(n){return n==null?"-":Math.round(n*100)+"%"}
function ago(iso){if(!iso)return "never";var s=(Date.now()-Date.parse(iso))/1000,f=s<0;s=Math.abs(s);
  var t=s<60?Math.round(s)+"s":s<3600?Math.round(s/60)+"m":s<86400?Math.round(s/3600)+"h":Math.round(s/86400)+"d";return f?"in "+t:t+" ago"}
function fmtTime(iso){var d=new Date(iso);return d.toLocaleDateString(undefined,{month:"short",day:"numeric"})+" "+d.toLocaleTimeString(undefined,{hour:"2-digit",minute:"2-digit"})}
function statusOf(l){return l.dryRun?"dry":l.outcome}
function tag(l){var s=statusOf(l);return el("span",{"class":"tag "+s},s==="dry"?"dry run":s)}
function toast(msg){var t=$("toast");t.textContent=msg;t.classList.add("show");clearTimeout(toast._t);toast._t=setTimeout(function(){t.classList.remove("show")},3200)}
function empty(node,msg){clear(node).appendChild(el("div",{"class":"empty"},msg))}

/* ---------- charts ---------- */
function barChart(node,labels,series,colors){
  clear(node);
  if(!labels.length){empty(node,"No data yet");return}
  var W=520,H=220,P={l:30,r:8,t:10,b:26},iw=W-P.l-P.r,ih=H-P.t-P.b;
  var max=1;labels.forEach(function(_,i){var s=0;series.forEach(function(se){s+=se[i]});max=Math.max(max,s)});
  var s=svg("svg",{viewBox:"0 0 "+W+" "+H,"class":"chart",role:"img"});
  for(var g=0;g<=4;g++){var y=P.t+ih-ih*g/4;s.appendChild(svg("line",{x1:P.l,x2:W-P.r,y1:y,y2:y,stroke:C.line,"stroke-width":1}));
    var tx=svg("text",{x:P.l-6,y:y+4,"text-anchor":"end",fill:C.faint,"font-size":10});tx.textContent=String(Math.round(max*g/4));s.appendChild(tx)}
  var bw=iw/labels.length,w=Math.max(4,Math.min(34,bw*.62));
  labels.forEach(function(lab,i){
    var x=P.l+bw*i+(bw-w)/2,base=P.t+ih;
    series.forEach(function(se,k){if(!se[i])return;var h=ih*se[i]/max;
      var r=svg("rect",{x:x,y:base-h,width:w,height:h,rx:3,fill:colors[k]});
      var ti=svg("title",{});ti.textContent=lab+": "+se[i];r.appendChild(ti);s.appendChild(r);base-=h});
    if(labels.length<=14||i%Math.ceil(labels.length/12)===0){var t=svg("text",{x:x+w/2,y:H-8,"text-anchor":"middle",fill:C.faint,"font-size":10});t.textContent=lab;s.appendChild(t)}
  });
  node.appendChild(s);
}
function lineChart(node,points,lines,opts){
  clear(node);opts=opts||{};
  if(points.length<2){empty(node,opts.emptyMsg||"Needs at least two data points");return}
  var W=520,H=opts.h||220,P={l:44,r:10,t:12,b:24},iw=W-P.l-P.r,ih=H-P.t-P.b;
  var max=0;lines.forEach(function(L){L.values.forEach(function(v){max=Math.max(max,v)})});max=max||1;
  var s=svg("svg",{viewBox:"0 0 "+W+" "+H,"class":"chart",role:"img"});
  var defs=svg("defs",{});s.appendChild(defs);
  for(var g=0;g<=4;g++){var y=P.t+ih-ih*g/4;s.appendChild(svg("line",{x1:P.l,x2:W-P.r,y1:y,y2:y,stroke:C.line}));
    var tx=svg("text",{x:P.l-6,y:y+4,"text-anchor":"end",fill:C.faint,"font-size":10});tx.textContent=(opts.fmt||sol)(max*g/4);s.appendChild(tx)}
  function X(i){return P.l+iw*i/(points.length-1)}function Y(v){return P.t+ih-ih*v/max}
  lines.forEach(function(L,k){
    var id="g"+k+Math.random().toString(36).slice(2,7);
    var gr=svg("linearGradient",{id:id,x1:0,y1:0,x2:0,y2:1});
    gr.appendChild(svg("stop",{offset:"0%","stop-color":L.color,"stop-opacity":.35}));
    gr.appendChild(svg("stop",{offset:"100%","stop-color":L.color,"stop-opacity":0}));defs.appendChild(gr);
    var d="";L.values.forEach(function(v,i){d+=(i?"L":"M")+X(i).toFixed(1)+" "+Y(v).toFixed(1)});
    s.appendChild(svg("path",{d:d+"L"+X(points.length-1)+" "+(P.t+ih)+"L"+P.l+" "+(P.t+ih)+"Z",fill:"url(#"+id+")"}));
    s.appendChild(svg("path",{d:d,fill:"none",stroke:L.color,"stroke-width":2.2,"stroke-linejoin":"round"}));
    L.values.forEach(function(v,i){var c=svg("circle",{cx:X(i),cy:Y(v),r:3,fill:L.color});var t=svg("title",{});t.textContent=points[i]+": "+(opts.fmt||sol)(v);c.appendChild(t);s.appendChild(c)});
  });
  [0,points.length-1].forEach(function(i){var t=svg("text",{x:X(i),y:H-6,"text-anchor":i?"end":"start",fill:C.faint,"font-size":10});t.textContent=points[i];s.appendChild(t)});
  node.appendChild(s);
}
function donut(node,parts){
  clear(node);var total=0;parts.forEach(function(p){total+=p.v});
  if(!total){empty(node,"No launches yet");return}
  var wrap=el("div",{style:"display:flex;align-items:center;gap:22px;flex-wrap:wrap"});
  var R=70,r=46,cx=90,cy=90,a=-Math.PI/2,s=svg("svg",{viewBox:"0 0 180 180",width:180,height:180});
  parts.forEach(function(p){if(!p.v)return;var a2=a+2*Math.PI*p.v/total;if(p.v===total)a2-=.0001;
    var lg=a2-a>Math.PI?1:0,p1=[cx+R*Math.cos(a),cy+R*Math.sin(a)],p2=[cx+R*Math.cos(a2),cy+R*Math.sin(a2)],
        p3=[cx+r*Math.cos(a2),cy+r*Math.sin(a2)],p4=[cx+r*Math.cos(a),cy+r*Math.sin(a)];
    var path=svg("path",{d:"M"+p1+"A"+R+" "+R+" 0 "+lg+" 1 "+p2+"L"+p3+"A"+r+" "+r+" 0 "+lg+" 0 "+p4+"Z",fill:p.c});
    var t=svg("title",{});t.textContent=p.k+": "+p.v;path.appendChild(t);s.appendChild(path);a=a2});
  var t1=svg("text",{x:cx,y:cy+2,"text-anchor":"middle",fill:"#e9ecf5","font-size":26,"font-weight":750});t1.textContent=String(total);s.appendChild(t1);
  var t2=svg("text",{x:cx,y:cy+20,"text-anchor":"middle",fill:C.muted,"font-size":11});t2.textContent="coins";s.appendChild(t2);
  wrap.appendChild(s);
  var leg=el("div",{"class":"list",style:"flex:1;min-width:150px"});
  parts.forEach(function(p){var row=el("div",{"class":"row"});var a=el("span");var i=el("i",{style:"display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:8px;background:"+p.c});
    a.appendChild(i);a.appendChild(document.createTextNode(p.k));row.appendChild(a);row.appendChild(el("span",null,p.v+" ("+Math.round(p.v*100/total)+"%)"));leg.appendChild(row)});
  wrap.appendChild(leg);node.appendChild(wrap);
}
function hbars(node,rows,fmt){
  clear(node);if(!rows.length){empty(node,"No data yet");return}
  var max=0;rows.forEach(function(r){max=Math.max(max,r.v)});max=max||1;
  rows.forEach(function(r){var row=el("div",{"class":"bar-row"});row.appendChild(el("span",{"class":"name",title:r.k},r.k));
    var tr=el("div",{"class":"track"}),f=el("div",{"class":"fill",style:"width:0%"});tr.appendChild(f);row.appendChild(tr);
    row.appendChild(el("span",{"class":"num"},fmt?fmt(r.v):String(r.v)));node.appendChild(row);
    requestAnimationFrame(function(){f.style.width=Math.max(2,100*r.v/max)+"%"})});
}

/* ---------- views ---------- */
function coinCard(l){
  var b=el("button",{"class":"coin",type:"button"});
  var im=el("div",{"class":"img"});
  if(l.imageUri){var i=el("img",{alt:"",loading:"lazy",referrerpolicy:"no-referrer"});i.src=l.imageUri;im.appendChild(i)}else im.textContent=(l.ticker||"?").slice(0,4);
  b.appendChild(im);
  var body=el("div",{"class":"body"}),t=el("div",{"class":"t"});t.appendChild(el("b",null,l.name));t.appendChild(tag(l));body.appendChild(t);
  var m=el("div",{"class":"meta"});m.appendChild(el("span",{"class":"mono"},"$"+l.ticker));m.appendChild(el("span",null,ago(l.createdAt)));body.appendChild(m);
  b.appendChild(body);b.addEventListener("click",function(){openDetail(l)});return b;
}
function renderOverview(d){
  var t=d.totals;
  $("k-live").textContent=t.live;$("k-live-sub").textContent=t.pending+" pending";
  $("k-win").textContent=pct(t.winRate);$("k-win-sub").textContent=t.successes+" won / "+t.duds+" dud";
  $("k-spent").textContent=sol(t.spentSol);$("k-fees").textContent=sol(t.feesSol);
  var n=$("k-net");n.textContent=(t.feesMinusBuysSol>0?"+":"")+sol(t.feesMinusBuysSol);n.className="value "+(t.feesMinusBuysSol>=0?"pos":"neg");
  $("k-dry").textContent=t.dryRuns;
  // per day, last 14 days
  var days=[],live=[],dry=[],map={};
  for(var i=13;i>=0;i--){var dt=new Date(Date.now()-i*864e5),key=dt.toISOString().slice(0,10);map[key]=days.length;
    days.push(dt.toLocaleDateString(undefined,{month:"short",day:"numeric"}));live.push(0);dry.push(0)}
  d.launches.forEach(function(l){var k=map[l.createdAt.slice(0,10)];if(k==null)return;(l.dryRun?dry:live)[k]++});
  barChart($("c-daily"),days,[live,dry],[C.sol,C.blue]);
  donut($("c-outcomes"),[{k:"Success",v:t.successes,c:C.mint},{k:"Pending",v:t.pending,c:C.amber},{k:"Dud",v:t.duds,c:C.red},{k:"Dry run",v:t.dryRuns,c:C.blue}]);
  var lv=d.launches.filter(function(l){return !l.dryRun}).slice().reverse(),sp=0,fe=0,pts=[],a=[],b=[];
  lv.forEach(function(l){sp+=l.buySol;fe+=l.feesSol;pts.push(fmtTime(l.createdAt));a.push(sp);b.push(fe)});
  lineChart($("c-cum"),pts,[{color:C.red,values:a},{color:C.mint,values:b}],{emptyMsg:"Appears after two live launches"});
  var g=clear($("latest"));d.launches.slice(0,4).forEach(function(l){g.appendChild(coinCard(l))});
  if(!d.launches.length)empty(g,"No coins yet");
}
function filtered(){
  return DATA.launches.filter(function(l){
    if(FILTER==="live"&&l.dryRun)return false;
    if(FILTER!=="all"&&FILTER!=="live"&&statusOf(l)!==FILTER)return false;
    if(QUERY){var h=(l.name+" "+l.ticker+" "+l.theme).toLowerCase();if(h.indexOf(QUERY)<0)return false}
    return true;});
}
function renderLaunches(){
  var rows=filtered(),g=clear($("launch-grid")),tb=clear($("launch-rows"));
  $("launch-empty").style.display=rows.length?"none":"block";
  $("launch-grid").style.display=VIEW==="grid"&&rows.length?"grid":"none";
  $("launch-table").style.display=VIEW==="table"&&rows.length?"block":"none";
  rows.forEach(function(l){
    g.appendChild(coinCard(l));
    var tr=el("tr");tr.appendChild(el("td",{"class":"muted"},fmtTime(l.createdAt)));
    var c=el("td");c.appendChild(el("b",null,l.name));c.appendChild(el("span",{"class":"muted mono"}," $"+l.ticker));tr.appendChild(c);
    tr.appendChild(el("td",null,l.theme));var st=el("td");st.appendChild(tag(l));tr.appendChild(st);
    tr.appendChild(el("td",{"class":"mono"},sol(l.buySol)));tr.appendChild(el("td",{"class":"mono"},usd(l.lastMcapUsd)));
    tr.appendChild(el("td",{"class":"mono"},sol(l.feesSol)));tr.appendChild(el("td",null,l.llmWinner));
    tr.addEventListener("click",function(){openDetail(l)});tb.appendChild(tr)});
}
function rate(r){return r.settled?r.successes/r.settled:0}
function renderArena(d){
  hbars($("b-llm"),d.contests.llm.map(function(r){return{k:r.name,v:r.wins}}));
  hbars($("b-img"),d.contests.image.map(function(r){return{k:r.name,v:r.wins}}));
  hbars($("b-llm-sr"),d.contests.llm.filter(function(r){return r.settled}).map(function(r){return{k:r.name,v:rate(r)}}),pct);
  hbars($("b-img-sr"),d.contests.image.filter(function(r){return r.settled}).map(function(r){return{k:r.name,v:rate(r)}}),pct);
}
function renderTrends(d){
  hbars($("b-src"),d.sources.map(function(s){return{k:s.name,v:s.launches}}));
  hbars($("b-src-sr"),d.sources.filter(function(s){return s.launches}).map(function(s){return{k:s.name,v:s.successes/s.launches}}),pct);
  var th={};d.launches.forEach(function(l){th[l.theme]=(th[l.theme]||0)+1});
  hbars($("b-themes"),Object.keys(th).map(function(k){return{k:k,v:th[k]}}).sort(function(a,b){return b.v-a.v}).slice(0,10));
  var hrs=[],c=[];for(var h=0;h<24;h++){hrs.push(String(h));c.push(0)}
  d.launches.forEach(function(l){c[new Date(l.createdAt).getUTCHours()]++});
  barChart($("c-hours"),hrs,[c],[C.sol]);
}
function renderMoney(d){
  $("m-bal").textContent=d.balanceSol==null?"-":sol(d.balanceSol);$("m-wallet").textContent=d.wallet?d.wallet.slice(0,6)+"..."+d.wallet.slice(-6):"no wallet (dry run)";
  $("m-spent").textContent=sol(d.totals.spentSol);$("m-fees").textContent=sol(d.totals.feesSol);
  $("m-avg").textContent=d.totals.live?sol(d.totals.spentSol/d.totals.live):"-";
  var lv=d.launches.filter(function(l){return !l.dryRun});
  hbars($("b-fees"),lv.filter(function(l){return l.feesSol>0}).sort(function(a,b){return b.feesSol-a.feesSol}).slice(0,10).map(function(l){return{k:"$"+l.ticker,v:l.feesSol}}),sol);
  hbars($("b-mcap"),lv.filter(function(l){return l.lastMcapUsd}).sort(function(a,b){return b.lastMcapUsd-a.lastMcapUsd}).slice(0,10).map(function(l){return{k:"$"+l.ticker,v:l.lastMcapUsd}}),usd);
}
function listRows(node,rows){clear(node);rows.forEach(function(r){var row=el("div",{"class":"row"});row.appendChild(el("span",null,r[0]));row.appendChild(el("span",null,r[1]));node.appendChild(row)})}
function chips(node,arr){clear(node);(arr||[]).forEach(function(x){node.appendChild(el("span",{"class":"chip"},x))});if(!arr||!arr.length)node.appendChild(el("span",{"class":"muted"},"-"))}
function renderSystem(d){
  var s=d.status||{},c=d.settings||{};
  listRows($("l-sched"),[["Mode",d.dryRun?"Dry run":"LIVE"],["Last run",s.lastRunAt?ago(s.lastRunAt):"never"],["Last result",s.lastStatus||"-"],
    ["Next run",s.nextRunAt?ago(s.nextRunAt):"-"],["Failures in a row",String(s.consecutiveFailures||0)],["Paused until",d.pausedUntil?fmtTime(d.pausedUntil):"not paused"]]);
  listRows($("l-limits"),[["Launch hours (UTC)",c.launchHoursUtc||"-"],["Cycle interval",c.cycleIntervalMin!=null?c.cycleIntervalMin+" min":"-"],
    ["Max launches / day",String(c.maxLaunchesPerDay!=null?c.maxLaunchesPerDay:"-")],["Max spend / day",c.maxDailySpendSol!=null?c.maxDailySpendSol+" SOL":"-"],
    ["Initial buy",c.initialBuyMinSol!=null?c.initialBuyMinSol+" - "+c.initialBuyMaxSol+" SOL":"-"],["Min trend score",String(c.minTrendScore!=null?c.minTrendScore:"-")]]);
  chips($("p-llm"),c.llms);chips($("p-img"),c.images);
}
function renderHeader(d){
  var s=d.status||{},f=s.consecutiveFailures||0,dot=$("health-dot");
  dot.className="dot "+(d.pausedUntil?"warn":f>=3?"bad":f?"warn":"ok");
  $("health-text").textContent=d.pausedUntil?"Paused":f>=3?"Failing":f?"Retrying":"Healthy";
  $("mode-pill").textContent=d.dryRun?"DRY RUN":"LIVE";$("mode-pill").style.color=d.dryRun?"var(--blue)":"var(--mint)";
  $("balance-pill").textContent=(d.balanceSol==null?"-":sol(d.balanceSol))+" SOL";
  $("updated").textContent="Updated "+new Date(d.generatedAt).toLocaleTimeString()+(s.nextRunAt?" | next cycle "+ago(s.nextRunAt):"");
  $("banner-dry").classList.toggle("show",!!d.dryRun);
  var bp=$("banner-paused");bp.classList.toggle("show",!!d.pausedUntil);bp.textContent=d.pausedUntil?"Launching paused by the circuit breaker until "+fmtTime(d.pausedUntil)+".":"";
}

/* ---------- detail modal ---------- */
function openDetail(l){
  var th=clear($("d-thumb"));if(l.imageUri){var i=el("img",{alt:"",referrerpolicy:"no-referrer"});i.src=l.imageUri;th.appendChild(i)}
  $("d-name").textContent=l.name;$("d-ticker").textContent="$"+l.ticker+"  |  "+fmtTime(l.createdAt);
  var kv=clear($("d-kv"));
  [["Status",l.dryRun?"dry run":l.outcome],["Theme",l.theme],["Initial buy",sol(l.buySol)+" SOL"],["Fees",sol(l.feesSol)+" SOL"],
   ["Market cap",usd(l.lastMcapUsd)],["Writer",l.llmWinner],["Artist",l.imageWinner],["Mint",l.mint||"-"]].forEach(function(p){
    var d=el("div");d.appendChild(el("span",null,p[0]));d.appendChild(el("b",null,p[1]));kv.appendChild(d)});
  var h=l.mcapHistory||[];
  lineChart($("d-chart"),h.map(function(x){return fmtTime(x.at)}),[{color:C.mint,values:h.map(function(x){return x.usd})}],{fmt:usd,h:180,emptyMsg:"Market cap is sampled at 1h and 24h after launch"});
  var lk=clear($("d-links"));
  if(l.pumpUrl&&/^https:\\/\\/pump\\.fun\\//.test(l.pumpUrl)){var a=el("a",{"class":"btn primary",href:l.pumpUrl,target:"_blank",rel:"noopener noreferrer"},"Open on pump.fun");lk.appendChild(a)}
  (l.posts||[]).forEach(function(p){if(p.url&&/^https:\\/\\//.test(p.url))lk.appendChild(el("a",{"class":"btn",href:p.url,target:"_blank",rel:"noopener noreferrer"},p.channel+" post"));
    else lk.appendChild(el("span",{"class":"pill"},p.channel+(p.ok?" posted":" failed")))});
  $("modal").classList.add("open");$("modal").setAttribute("aria-hidden","false");
}
function closeDetail(){$("modal").classList.remove("open");$("modal").setAttribute("aria-hidden","true")}

/* ---------- data + actions ---------- */
function render(){if(!DATA)return;renderHeader(DATA);renderOverview(DATA);renderLaunches();renderArena(DATA);renderTrends(DATA);renderMoney(DATA);renderSystem(DATA)}
function load(){
  return fetch("./api/summary",{credentials:"same-origin",cache:"no-store"}).then(function(r){
    if(r.status===401){$("updated").textContent="Session expired: reload the page and log in";throw new Error("auth")}
    if(!r.ok)throw new Error("HTTP "+r.status);return r.json()}).then(function(d){DATA=d;render()})
    .catch(function(e){if(e.message!=="auth")$("updated").textContent="Could not reach the agent ("+e.message+")"});
}
function post(path,btn,label){
  btn.disabled=true;var old=btn.textContent;btn.textContent=label;
  return fetch(path,{method:"POST",credentials:"same-origin"}).then(function(r){return r.json().then(function(j){return{s:r.status,j:j}})})
    .then(function(x){
      if(path==="./run"){toast(x.s===409?"A cycle is already running":"Cycle finished: "+(x.j.status||"done")+(x.j.reason?" ("+x.j.reason+")":""))}
      else toast(x.j.error?x.j.error:"Checked "+x.j.checked+" coins, collected "+sol(x.j.collectedSol)+" SOL");
      return load()})
    .catch(function(e){toast("Failed: "+e.message)}).then(function(){btn.disabled=false;btn.textContent=old});
}
document.querySelectorAll("nav.tabs button").forEach(function(b){b.addEventListener("click",function(){
  document.querySelectorAll("nav.tabs button").forEach(function(x){x.setAttribute("aria-selected",String(x===b))});
  document.querySelectorAll(".tab").forEach(function(t){t.classList.toggle("active",t.id==="tab-"+b.dataset.tab)});
  try{location.hash=b.dataset.tab}catch(e){}})});
function seg(id,cb){$(id).querySelectorAll("button").forEach(function(b){b.addEventListener("click",function(){
  $(id).querySelectorAll("button").forEach(function(x){x.classList.toggle("on",x===b)});cb(b.dataset.v)})})}
seg("f-status",function(v){FILTER=v;renderLaunches()});
seg("f-view",function(v){VIEW=v;renderLaunches()});
$("q").addEventListener("input",function(e){QUERY=e.target.value.trim().toLowerCase();renderLaunches()});
$("btn-run").addEventListener("click",function(){post("./run",$("btn-run"),"Running... (~2 min)")});
$("btn-fees").addEventListener("click",function(){post("./collect-fees",$("btn-fees"),"Collecting...")});
$("d-close").addEventListener("click",closeDetail);
$("modal").addEventListener("click",function(e){if(e.target===$("modal"))closeDetail()});
document.addEventListener("keydown",function(e){if(e.key==="Escape")closeDetail()});
var h=(location.hash||"").slice(1);if(h){var tb=document.querySelector('nav.tabs button[data-tab="'+h+'"]');if(tb)tb.click()}
load();setInterval(function(){if(!document.hidden)load()},30000);
})();
</script>
</body>
</html>`;
