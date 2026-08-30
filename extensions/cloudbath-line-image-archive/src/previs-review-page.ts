import crypto from "node:crypto";
import type { PrevisVersion } from "./previs-types.js";

/**
 * The human-facing previs review page.
 *
 * Cloudbath-owned and dependency-free on purpose. CozyClay's own studio is an
 * AGPL Vite application; serving it (or an adaptation of it) to reviewers would
 * ship AGPL frontend code over a network and pull in the section 13
 * source-offer obligation. Rendering Cloudbath's OWN PrevisDocument with our own
 * arithmetic keeps the AGPL work confined to the separate MCP process that
 * produced the `.cclayproject`, and keeps the browser free of third-party code.
 *
 * No external scripts, styles, fonts or images: nothing can leak the capability
 * token in the page URL through a cross-origin request, and the CSP below can
 * stay closed. The R2 object key is never rendered.
 */

/** Escapes text for HTML element and attribute contexts. */
export function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/gu,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );
}

/**
 * Serialises state for a `<script type="application/json">` block.
 *
 * `<` and `&` are escaped so a scene prompt containing `</script>` cannot close
 * the block, and the JSON line terminators are escaped because they are literal
 * newlines in JavaScript string context.
 */
export function escapeJsonForHtml(value: unknown): string {
  return JSON.stringify(value).replace(
    /[&<>\u2028\u2029]/gu,
    (character) =>
      ({
        "&": "\\u0026",
        "<": "\\u003c",
        ">": "\\u003e",
        "\u2028": "\\u2028",
        "\u2029": "\\u2029",
      })[character]!,
  );
}

/** Display model handed to the browser. Deliberately excludes storage identity. */
export function reviewPageModel(params: {
  version: PrevisVersion;
  latestVersionNumber: number;
  approvedVersionNumber?: number;
  isLatest: boolean;
}): Readonly<Record<string, unknown>> {
  const { version } = params;
  return {
    previsProjectId: version.previsProjectId,
    sceneId: version.sceneId,
    versionNumber: version.versionNumber,
    latestVersionNumber: params.latestVersionNumber,
    approvedVersionNumber: params.approvedVersionNumber ?? null,
    approved: Boolean(version.approvedAt),
    isLatest: params.isLatest,
    durationSeconds: version.document.durationSeconds,
    aspectRatio: version.document.aspectRatio,
    scenePrompt: version.document.scenePrompt,
    // Canonical Character identity for the reviewer, mapped to its stand-in.
    cast: version.document.cast.map((member) => ({
      characterCode: member.characterCode,
      displayName: member.displayName,
      standIn: member.standIn,
    })),
    placements: version.document.placements,
    movements: version.document.movements,
    shots: version.document.shots,
    deferredCapabilities: version.deferredCapabilities,
  };
}

const STYLES = `
:root{color-scheme:dark;--bg:#111214;--panel:#191b1f;--line:#2b2f36;--text:#e8eaed;--muted:#9aa1ab;--accent:#6ea8fe}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
.wrap{max-width:1080px;margin:0 auto;padding:16px;display:grid;gap:12px}
h1{font-size:16px;margin:0}
.meta{display:flex;flex-wrap:wrap;gap:8px;color:var(--muted);font-size:12px}
.tag{border:1px solid var(--line);border-radius:999px;padding:2px 9px}
.tag.ok{border-color:#2f7d4f;color:#7ee2a8}
.tag.draft{border-color:#7d6b2f;color:#e2cf7e}
.stage{background:#000;border:1px solid var(--line);border-radius:10px;overflow:hidden;display:flex;justify-content:center}
/* No width:100%: stretching a fixed backing store to the panel width would
   distort every figure horizontally and misrepresent the framing. */
canvas{display:block;max-width:100%;height:auto;touch-action:none}
.controls{display:flex;align-items:center;gap:12px;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:10px 12px}
button{background:var(--accent);color:#0b1220;border:0;border-radius:7px;padding:7px 15px;font:inherit;font-weight:600;cursor:pointer}
button:focus-visible{outline:2px solid #fff;outline-offset:2px}
.time{font-variant-numeric:tabular-nums;color:var(--muted);min-width:96px}
input[type=range]{flex:1;accent-color:var(--accent);min-width:120px}
.cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px}
.card h2{font-size:12px;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);margin:0 0 8px}
dl{margin:0;display:grid;grid-template-columns:auto 1fr;gap:3px 10px}
dt{color:var(--muted)}
dd{margin:0}
.cast{margin:0;padding:0;list-style:none;display:grid;gap:5px}
.cast li{display:flex;gap:8px;align-items:center}
.chip{background:#2b2f36;border-radius:5px;padding:1px 7px;font-weight:600;font-size:12px}
.note{color:var(--muted);font-size:12px}
`;

/** Canvas player. Deterministic: state is a pure function of the playhead. */
const PLAYER = String.raw`
(function(){
var M=JSON.parse(document.getElementById("previs-model").textContent);
var cv=document.getElementById("view"),cx=cv.getContext("2d");
var range=document.getElementById("seek"),btn=document.getElementById("play"),
    clock=document.getElementById("clock"),beatEl=document.getElementById("beat"),
    shotEl=document.getElementById("shot");
var SIZE_D={"extreme close-up":0.7,"close-up":1.1,"medium close-up":1.8,"medium shot":3.2,"medium-wide shot":4.8,"wide shot":8,"extreme wide shot":14};
var LEVEL_H={ground:0.2,low:0.7,hip:1,eye:1.6,high:2.6,overhead:5};
var VIEW_O={front:0,"front three-quarter":45,profile:90,"rear three-quarter":135,back:180};
var PALETTE=["#6ea8fe","#f0a868","#7ee2a8","#e07ec8","#e2cf7e","#9a8cf0"];
var t=0,playing=false,last=0;

function legs(s){return M.movements.filter(function(m){return m.standIn===s;}).slice().sort(function(a,b){return a.startSecond-b.startSecond||a.endSecond-b.endSecond||a.beat.localeCompare(b.beat);});}
function actorAt(s,sec){
  var p=M.placements.filter(function(q){return q.standIn===s;})[0]||{x:0,z:0,facing:0};
  var x=p.x,z=p.z,f=p.facing,beat=null,L=legs(s);
  for(var i=0;i<L.length;i++){var g=L[i];
    if(sec<=g.startSecond)break;
    var span=g.endSecond-g.startSecond,pr=sec>=g.endSecond?1:(span<=0?1:(sec-g.startSecond)/span);
    if(g.to){x=x+(g.to.x-x)*pr;z=z+(g.to.z-z)*pr;}
    if(g.facingTo!==undefined&&g.facingTo!==null){var d=((g.facingTo-f+540)%360)-180;f=f+d*pr;}
    if(sec<g.endSecond){beat=g.beat;break;}
    if(g.to){x=g.to.x;z=g.to.z;}
    if(g.facingTo!==undefined&&g.facingTo!==null){f=g.facingTo;}
  }
  return {standIn:s,x:x,z:z,facing:((f%360)+360)%360,beat:beat};
}
function shotAt(sec){
  var inside=M.shots.filter(function(s){return sec>=s.startSecond&&sec<s.endSecond;})[0];
  if(inside)return inside;
  var past=M.shots.filter(function(s){return sec>=s.endSecond;});
  return past.length?past[past.length-1]:M.shots[0];
}
function cameraAt(sec){
  var sh=shotAt(sec),focus=sh?sh.camera.focus:(M.cast[0]||{}).standIn,
      su=focus?actorAt(focus,sec):{x:0,z:0,facing:0},
      d=SIZE_D[sh?sh.camera.size:"medium shot"]||3.2,
      h=LEVEL_H[sh?sh.camera.level:"eye"]||1.6,
      o=VIEW_O[sh?sh.camera.view:"profile"];
  if(o===undefined)o=90;
  var side=sh&&sh.camera.side==="left"?-1:1,a=(su.facing+o*side)*Math.PI/180;
  return {x:su.x+Math.sin(a)*d,y:h,z:su.z+Math.cos(a)*d,tx:su.x,ty:1.1,tz:su.z};
}
function sub(a,b){return [a[0]-b[0],a[1]-b[1],a[2]-b[2]];}
function cross(a,b){return [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];}
function dot(a,b){return a[0]*b[0]+a[1]*b[1]+a[2]*b[2];}
function norm(a){var l=Math.hypot(a[0],a[1],a[2])||1;return [a[0]/l,a[1]/l,a[2]/l];}
function makeCam(c){
  var eye=[c.x,c.y,c.z],fwd=norm(sub([c.tx,c.ty,c.tz],eye)),
      rt=norm(cross(fwd,[0,1,0])),up=cross(rt,fwd);
  return {eye:eye,fwd:fwd,rt:rt,up:up};
}
function project(cam,p){
  var v=sub(p,cam.eye),z=dot(v,cam.fwd);
  if(z<=0.05)return null;
  // Vertical FOV from a 35mm review lens on a 24mm sensor height.
  var f=(cv.height/2)/Math.tan(Math.atan(24/(2*35)));
  return {x:cv.width/2+f*dot(v,cam.rt)/z,y:cv.height/2-f*dot(v,cam.up)/z,z:z};
}
function draw(){
  var sec=t,cam=makeCam(cameraAt(sec));
  cx.fillStyle="#0a0c10";cx.fillRect(0,0,cv.width,cv.height);
  cx.strokeStyle="#242a33";cx.lineWidth=1;
  for(var g=-8;g<=8;g++){
    var seg=[[[g,0,-8],[g,0,8]],[[-8,0,g],[8,0,g]]];
    for(var s=0;s<2;s++){
      var a=project(cam,seg[s][0]),b=project(cam,seg[s][1]);
      if(a&&b){cx.beginPath();cx.moveTo(a.x,a.y);cx.lineTo(b.x,b.y);cx.stroke();}
    }
  }
  // Colour is keyed to the CAST index, not the draw order: depth sorting
  // reorders the array every time the actors cross, and a stand-in that
  // changed colour mid-scene would be untrackable.
  var acts=M.cast.map(function(c,ci){return {c:c,ci:ci,st:actorAt(c.standIn,sec)};});
  acts.sort(function(p,q){
    var pa=project(cam,[p.st.x,0,p.st.z]),qa=project(cam,[q.st.x,0,q.st.z]);
    return (qa?qa.z:0)-(pa?pa.z:0);
  });
  acts.forEach(function(e){
    var st=e.st,base=project(cam,[st.x,0,st.z]),head=project(cam,[st.x,1.75,st.z]);
    if(!base||!head)return;
    var h=Math.abs(base.y-head.y),w=Math.max(3,h*0.26),
        col=PALETTE[e.ci%PALETTE.length];
    cx.fillStyle="rgba(0,0,0,.45)";cx.beginPath();
    cx.ellipse(base.x,base.y,w*0.75,w*0.28,0,0,Math.PI*2);cx.fill();
    cx.fillStyle=col;
    cx.beginPath();cx.roundRect(base.x-w/2,head.y+h*0.16,w,h*0.84,w*0.32);cx.fill();
    cx.beginPath();cx.arc(base.x,head.y+h*0.09,w*0.30,0,Math.PI*2);cx.fill();
    // Facing nub: which way the stand-in is turned, so a turn beat is visible.
    var fr=(st.facing*Math.PI)/180,
        nose=project(cam,[st.x+Math.sin(fr)*0.55,0.95,st.z+Math.cos(fr)*0.55]);
    if(nose){cx.strokeStyle=col;cx.lineWidth=2;cx.beginPath();
      cx.moveTo(base.x,head.y+h*0.5);cx.lineTo(nose.x,nose.y);cx.stroke();}
    cx.fillStyle="#e8eaed";cx.font="600 13px system-ui,sans-serif";cx.textAlign="center";
    cx.fillText(e.c.displayName+" ("+e.c.standIn+")",base.x,base.y+18);
  });
}
function fmt(v){var m=Math.floor(v/60),s=Math.floor(v%60);return (m<10?"0":"")+m+":"+(s<10?"0":"")+s;}
function sync(){
  range.value=String(t);
  clock.textContent=fmt(t)+" / "+fmt(M.durationSeconds);
  clock.setAttribute("data-second",String(Math.floor(t)));
  var sh=shotAt(t);
  shotEl.textContent=sh?(sh.camera.size+" · "+sh.camera.view+" · "+sh.camera.level+" level · "+sh.camera.move):"—";
  var beats=M.cast.map(function(c){var a=actorAt(c.standIn,t);return a.beat?c.displayName+" "+a.beat:null;}).filter(Boolean);
  beatEl.textContent=beats.length?beats.join(" · "):"—";
  draw();
}
function tick(now){
  if(!playing)return;
  if(!last)last=now;
  t=Math.min(M.durationSeconds,t+(now-last)/1000);
  last=now;sync();
  if(t>=M.durationSeconds){pause();return;}
  requestAnimationFrame(tick);
}
function play(){if(t>=M.durationSeconds)t=0;playing=true;last=0;btn.textContent="Pause";btn.setAttribute("data-state","playing");requestAnimationFrame(tick);}
function pause(){playing=false;btn.textContent="Play";btn.setAttribute("data-state","paused");}
btn.addEventListener("click",function(){playing?pause():play();});
range.addEventListener("input",function(){pause();t=Number(range.value);sync();});
function resize(){
  var w=cv.parentNode.clientWidth,portrait=M.aspectRatio==="9:16",
      ratio=portrait?16/9:(M.aspectRatio==="1:1"?1:(M.aspectRatio==="4:3"?3/4:9/16));
  cv.width=Math.max(320,Math.min(w,portrait?520:960));
  cv.height=Math.round(cv.width*ratio);
  sync();
}
window.addEventListener("resize",resize);
// Exposed for the browser smoke test to drive playback without wall-clock waits.
window.cloudbathPrevisPlayer={seek:function(v){pause();t=v;sync();},state:function(){return {second:t,playing:playing};}};
resize();
})();
`;

export function renderPrevisReviewPage(params: {
  version: PrevisVersion;
  latestVersionNumber: number;
  approvedVersionNumber?: number;
  isLatest: boolean;
}): { html: string; nonce: string; csp: string } {
  const model = reviewPageModel(params);
  const { version } = params;
  const nonce = crypto.randomBytes(16).toString("base64");
  // Closed by default: no external origin can be reached, so the capability
  // token in the URL cannot leave the page. `img-src data:` covers the canvas.
  const csp = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src 'nonce-${nonce}'`,
    "img-src data:",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
  const statusTag = version.approvedAt
    ? `<span class="tag ok">Approved</span>`
    : `<span class="tag draft">Draft</span>`;
  const latestTag = params.isLatest
    ? `<span class="tag">latest</span>`
    : `<span class="tag">historical · latest is v${params.latestVersionNumber}</span>`;
  const cast = version.document.cast
    .map(
      (member) =>
        `<li><span class="chip">${escapeHtml(member.standIn)}</span> ${escapeHtml(
          member.displayName,
        )} <span class="note">${escapeHtml(member.characterCode)}</span></li>`,
    )
    .join("");
  return {
    nonce,
    csp,
    html: `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Previs ${escapeHtml(version.previsProjectId)} · v${version.versionNumber}</title>
<style nonce="${nonce}">${STYLES}</style></head>
<body><div class="wrap">
<header>
<h1>3D Previs — ${escapeHtml(version.sceneId)}</h1>
<div class="meta">
<span class="tag">v${version.versionNumber}</span>${latestTag}${statusTag}
<span class="tag">${version.document.durationSeconds}s</span>
<span class="tag">${escapeHtml(version.document.aspectRatio)}</span>
</div>
</header>
<div class="stage"><canvas id="view" width="520" height="924" role="img"
 aria-label="Previs viewport"></canvas></div>
<div class="controls">
<button id="play" type="button" data-state="paused">Play</button>
<span class="time" id="clock" data-second="0">00:00 / 00:${String(
      version.document.durationSeconds,
    ).padStart(2, "0")}</span>
<input id="seek" type="range" min="0" max="${version.document.durationSeconds}" step="0.1"
 value="0" aria-label="Seek">
</div>
<div class="cols">
<section class="card"><h2>Cast</h2><ul class="cast">${cast}</ul></section>
<section class="card"><h2>Current shot</h2><div id="shot">—</div></section>
<section class="card"><h2>Current action</h2><div id="beat">—</div></section>
<section class="card"><h2>Scene</h2><div>${escapeHtml(version.document.scenePrompt)}</div></section>
</div>
<p class="note">Blocking, timing and framing preview. Generic stand-ins are intentional — photoreal
character identity is applied later in the video pipeline, not in previs.</p>
</div>
<script id="previs-model" type="application/json" nonce="${nonce}">${escapeJsonForHtml(model)}</script>
<script nonce="${nonce}">${PLAYER}</script>
</body></html>`,
  };
}
