"use strict";
/* =========================================================================
   ORBITAL DYNAMICS GAME
   Physics: circular orbit, PQW -> ECI -> ECEF -> geodetic(lat/lon)
   ========================================================================= */

/* ---------- constants ---------- */
const MU   = 398600.4418;          // km^3/s^2
const WE   = 7.2921159e-5;         // rad/s  (earth rotation)
const R_E  = 6371.0;               // km  mean earth radius
const FLATTEN = 0.0;               // spherical earth for lat/lon (educational)
const SIDEREAL = 2*Math.PI/WE;     // s
const REV_PER_DAY = 15;
const PERIOD = SIDEREAL / REV_PER_DAY;          // s
const A_SMA  = Math.cbrt(MU*PERIOD*PERIOD/(4*Math.PI*Math.PI)); // km
const ALT    = A_SMA - R_E;
const V_ORB  = Math.sqrt(MU/A_SMA);
const SHIFT_DEG = 360/REV_PER_DAY;              // ground-track drift per orbit (deg west)
const WIN_KM = 60;

/* ---------- tiny math ---------- */
const D2R = Math.PI/180, R2D = 180/Math.PI;
function wrap360(d){ d%=360; if(d<0)d+=360; return d; }
function wrap180(d){ d=wrap360(d); if(d>180)d-=360; return d; }
const clamp=(x,a,b)=>x<a?a:(x>b?b:x);


/* Rotation matrix multiply: R * v  (rows given) */
function rotx(a){const c=Math.cos(a),s=Math.sin(a);return [[1,0,0],[0,c,-s],[0,s,c]];}
function rotz(a){const c=Math.cos(a),s=Math.sin(a);return [[c,-s,0],[s,c,0],[0,0,1]];}
function m3mul(A,B){
  const C=[[0,0,0],[0,0,0],[0,0,0]];
  for(let i=0;i<3;i++)for(let j=0;j<3;j++){let s=0;for(let k=0;k<3;k++)s+=A[i][k]*B[k][j];C[i][j]=s;}
  return C;
}
function m3v(M,v){return [
  M[0][0]*v[0]+M[0][1]*v[1]+M[0][2]*v[2],
  M[1][0]*v[0]+M[1][1]*v[1]+M[1][2]*v[2],
  M[2][0]*v[0]+M[2][1]*v[1]+M[2][2]*v[2]];}

/* PQW->ECI: R3(-RAAN) R1(-i) R3(-omega); omega=0 for circular */
function pqwToEci(i, raan){
  return m3mul(rotz(-raan*D2R), rotx(-i*D2R));
}

/* ECI -> ECEF (rotation about z by earth angle theta) */
function eciToEcef(theta){ return rotz(-theta); }

/* ECEF -> lat/lon (spherical) */
function ecefToLatLon(p){
  const r=Math.hypot(p[0],p[1],p[2]);
  const lat=Math.asin(clamp(p[2]/r,-1,1))*R2D;
  const lon=Math.atan2(p[1],p[0])*R2D;
  return [lat, wrap180(lon)];
}

/* state of satellite at time t given orbital params */
function satState(t, inc, raan, ma0){
  // mean motion
  const n = Math.sqrt(MU/(A_SMA*A_SMA*A_SMA));     // rad/s
  const u = ma0*D2R + n*t;                          // argument of latitude (circular)
  // position in PQW
  const p = [A_SMA*Math.cos(u), A_SMA*Math.sin(u), 0];
  const R = pqwToEci(inc, raan);
  const eci = m3v(R, p);
  const theta = WE*t;                               // earth rotation angle
  const ecef = m3v(eciToEcef(theta), eci);
  const ll = ecefToLatLon(ecef);
  return {eci, ecef, lat:ll[0], lon:ll[1]};
}

/* great-circle distance km */
function gcDist(lat1,lon1,lat2,lon2){
  const p1=lat1*D2R,p2=lat2*D2R,dl=(lon2-lon1)*D2R;
  let c=Math.sin(p1)*Math.sin(p2)+Math.cos(p1)*Math.cos(p2)*Math.cos(dl);
  c=clamp(c,-1,1);
  return Math.acos(c)*R_E;
}

/* =========================================================================
   GAME STATE
   ========================================================================= */
const state = {
  inc: 51.6,
  raan: 0,
  ma0: 0,
  t: 0,
  speed: 1000,
  paused: false,
  target: {lat:0, lon:0},
  best: Infinity,
  bestParams: null,
  won: false,
  views: {ts:true, gt:true, gl:true},
  history: [],          // sampled lat/lon for traces
  cam: {yaw: null, pitch: 30}  // globe view drag; yaw null => follows RAAN
};

/* ---------- target generation (lat/lon only, random) ---------- */
function newTarget(){
  // uniform on sphere: lat = asin(2u-1)
  const u = Math.random();
  const lat = Math.asin(2*u-1)*R2D;
  const lon = Math.random()*360-180;
  state.target = {lat, lon};
  state.best = Infinity;
  state.bestParams = null;
  state.won = false;
  state.history = [];
}

/* =========================================================================
   DOM
   ========================================================================= */
const $ = id => document.getElementById(id);
const incEl=$("inc"), raanEl=$("raan"), maEl=$("ma");
const vInc=$("vInc"), vRaan=$("vRaan"), vMa=$("vMa");
const liveMissEl=$("liveMiss"), bestMissEl=$("bestMiss");
const reachEl=$("reach"), clockEl=$("clock");
const hintBox=$("hint"), toast=$("toast");

/* ---------- slider plumbing ---------- */
function syncLabels(){
  vInc.innerHTML  = state.inc.toFixed(1)+"&deg;";
  vRaan.innerHTML = state.raan.toFixed(1)+"&deg;";
  vMa.innerHTML   = state.ma0.toFixed(1)+"&deg;";
}
incEl.addEventListener("input",e=>{ state.inc=+e.target.value; syncLabels(); onParamChange(); });
raanEl.addEventListener("input",e=>{ state.raan=+e.target.value; syncLabels(); onParamChange(); });
maEl.addEventListener("input",e=>{ state.ma0=+e.target.value; syncLabels(); onParamChange(); });

function onParamChange(){
  // reset timing so player sees effect of M0 predictably
  state.t = 0;
  state.history = [];
  updateBest();
}

/* ---------- buttons ---------- */
$("btnRandom").addEventListener("click",()=>{
  newTarget(); state.t=0; state.history=[]; updateBest(); toastMsg("New target generated.");
});
$("btnPause").addEventListener("click",e=>{
  state.paused=!state.paused;
  e.target.innerHTML = state.paused ? "&#9654; Resume" : "&#10074;&#10074; Pause";
  e.target.classList.toggle("active",state.paused);
});
$("btnReset").addEventListener("click",()=>{ state.t=0; state.history=[]; });
document.querySelectorAll(".spd").forEach(b=>{
  b.addEventListener("click",()=>{
    document.querySelectorAll(".spd").forEach(x=>x.classList.remove("active"));
    b.classList.add("active");
    state.speed=+b.dataset.spd;
  });
});
$("btnHint").addEventListener("click",()=>{
  const t=state.target;
  hintBox.innerHTML = "Target is at lat <b>"+t.lat.toFixed(1)+"&deg;</b>, lon <b>"+t.lon.toFixed(1)+"&deg;</b>. "+
    "You can only reach |lat| &le; i. Set <b>i &ge; "+Math.abs(t.lat).toFixed(1)+"&deg;</b>.";
});
$("btnOpt").addEventListener("click",autoSolve);
$("btnResetView").addEventListener("click",()=>{
  state.cam.yaw=null; state.cam.pitch=62;
  toastMsg("Globe view reset to follow RAAN.");
});
document.querySelectorAll(".vt").forEach(b=>{
  b.classList.add("active");
  b.addEventListener("click",()=>{
    const k=b.dataset.v;
    state.views[k]=!state.views[k];
    b.classList.toggle("active",state.views[k]);
    applyViewLayout();
  });
});

function applyViewLayout(){
  $("view-ts").classList.toggle("hidden",!state.views.ts);
  $("view-gt").classList.toggle("hidden",!state.views.gt);
  $("view-gl").classList.toggle("hidden",!state.views.gl);
  // if exactly one view shown, span it
  const shown = ["ts","gt","gl"].filter(k=>state.views[k]);
  ["ts","gt","gl"].forEach(k=>$("view-"+k).classList.remove("span"));
  if(shown.length===1) $("view-"+shown[0]).classList.add("span");
}

let toastTimer=null;
function toastMsg(msg, bad){
  toast.textContent=msg;
  toast.classList.toggle("bad",!!bad);
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer=setTimeout(()=>toast.classList.remove("show"),2200);
}

/* =========================================================================
   CANVAS HELPERS
   ========================================================================= */
const cvTs=$("cvTs"), cvGt=$("cvGt"), cvGl=$("cvGl");
const tasks=[
  {cv:cvTs, ctx:null, dpr:1},
  {cv:cvGt, ctx:null, dpr:1},
  {cv:cvGl, ctx:null, dpr:1},
];
function fitCanvas(t){
  const dpr=Math.min(2, window.devicePixelRatio||1);
  const r=t.cv.getBoundingClientRect();
  t.dpr=dpr;
  t.cv.width=Math.max(2,Math.round(r.width*dpr));
  t.cv.height=Math.max(2,Math.round(r.height*dpr));
  t.ctx=t.cv.getContext("2d");
}
function fitAll(){ tasks.forEach(fitCanvas); }
window.addEventListener("resize",()=>{ fitAll(); });

/* ---------- globe view: drag to rotate ---------- */
(function(){
  let dragging=false, lastX=0, lastY=0;
  const el=cvGl;
  el.style.cursor="grab";
  function down(e){
    dragging=true;
    el.style.cursor="grabbing";
    const p=e.touches?e.touches[0]:e;
    lastX=p.clientX; lastY=p.clientY;
    if(e.cancelable)e.preventDefault();
  }
  function move(e){
    if(!dragging)return;
    const p=e.touches?e.touches[0]:e;
    const dx=p.clientX-lastX, dy=p.clientY-lastY;
    lastX=p.clientX; lastY=p.clientY;
    // lazily seed yaw from RAAN-follow value on first drag
    if(state.cam.yaw==null) state.cam.yaw = state.raan+35;
    state.cam.yaw  = wrap360(state.cam.yaw - dx*0.4);
    state.cam.pitch = clamp(state.cam.pitch + dy*0.4, -89, 89);
    if(e.cancelable)e.preventDefault();
  }
  function up(){ dragging=false; el.style.cursor="grab"; }
  el.addEventListener("mousedown",down);
  el.addEventListener("touchstart",down,{passive:false});
  window.addEventListener("mousemove",move);
  window.addEventListener("touchmove",move,{passive:false});
  window.addEventListener("mouseup",up);
  window.addEventListener("touchend",up);
})();

function clearCtx(t,bg){
  const c=t.ctx, W=t.cv.width, H=t.cv.height;
  c.setTransform(1,0,0,1,0,0);
  c.fillStyle=bg; c.fillRect(0,0,W,H);
  c.setTransform(t.dpr,0,0,t.dpr,0,0);
  return {W:t.cv.width/t.dpr, H:t.cv.height/t.dpr, c};
}

/* =========================================================================
   VIEW 1 : TIME SERIES  (lat(t) and lon(t))
   ========================================================================= */
function drawTimeSeries(){
  const t=tasks[0];
  const {W,H,c}=clearCtx(t,"#080d18");

  const padL=44,padR=14,padT=36,padB=24;
  const plotH=(H-padT-padB);
  const half=plotH/2-8;
  const hLat={x0:padL,y0:padT,w:W-padL-padR,h:half};
  const hLon={x0:padL,y0:padT+half+16,w:W-padL-padR,h:half};

  // time window: current +- 1.5 orbits
  const span=PERIOD*3;
  const tStart=state.t-span/2, tEnd=state.t+span/2;
  const N=260;
  const latPts=[],lonPts=[];
  for(let k=0;k<=N;k++){
    const tt=tStart+(tEnd-tStart)*k/N;
    const s=satState(tt,state.inc,state.raan,state.ma0);
    const x=hLat.x0+hLat.w*(k/N);
    latPts.push([x, hLat.y0+hLat.h*(1-(s.lat+90)/180)]);
    lonPts.push([x, hLon.y0+hLon.h*(1-(s.lon+180)/360)]);
  }
  const nowX=hLat.x0+hLat.w*(state.t-tStart)/(tEnd-tStart);

  function frame(h,title,labels,yFor){
    c.strokeStyle="#1c2740";c.lineWidth=1;
    c.strokeRect(h.x0,h.y0,h.w,h.h);
    c.fillStyle="#7f8db0";c.font="9px ui-monospace,monospace";c.textAlign="left";
    c.fillText(title,h.x0+2,h.y0-5);
    c.strokeStyle="#141d31";
    labels.forEach(v=>{
      const y=h.y0+h.h*(1-yFor(v));
      c.beginPath();c.moveTo(h.x0,y);c.lineTo(h.x0+h.w,y);c.stroke();
      c.fillStyle="#5f6d90";c.textAlign="right";c.fillText(v+"\u00b0",h.x0-4,y+3);
      c.textAlign="left";
    });
  }

  frame(hLat,"LATITUDE",[-90,-45,0,45,90],v=>(v+90)/180);
  frame(hLon,"LONGITUDE",[-180,-90,0,90,180],v=>(v+180)/360);

  // vertical grid times (orbit marks)
  c.fillStyle="#5f6d90";c.font="8.5px ui-monospace,monospace";c.textAlign="center";
  for(let k=-2;k<=2;k++){
    const tt=state.t+k*PERIOD/2;
    if(tt<tStart||tt>tEnd)continue;
    const x=hLat.x0+hLat.w*(tt-tStart)/(tEnd-tStart);
    c.strokeStyle="#101828";c.beginPath();c.moveTo(x,hLat.y0);c.lineTo(x,hLon.y0+hLon.h);c.stroke();
    c.fillStyle="#4c5a7c";c.fillText((k/2).toFixed(1)+"T",x,hLon.y0+hLon.h+12);
  }

  // target lines
  function targetLine(h,yFor,val,col){
    const y=h.y0+h.h*(1-yFor(val));
    c.save();c.setLineDash([5,4]);c.strokeStyle=col;c.lineWidth=1.4;
    c.beginPath();c.moveTo(h.x0,y);c.lineTo(h.x0+h.w,y);c.stroke();c.restore();
    c.fillStyle=col;c.font="9px ui-monospace,monospace";c.textAlign="left";
    c.fillText("TARGET "+val.toFixed(1)+"\u00b0",h.x0+h.w-96,y-3);
  }
  targetLine(hLat,v=>(v+90)/180,state.target.lat,"#ff5db1");
  targetLine(hLon,v=>(v+180)/360,state.target.lon,"#ff5db1");

  // past / future split line
  c.save();c.setLineDash([2,3]);c.strokeStyle="#3a4d78";c.lineWidth=1;
  c.beginPath();c.moveTo(nowX,hLat.y0);c.lineTo(nowX,hLon.y0+hLon.h);c.stroke();c.restore();
  c.fillStyle="#8fa3cf";c.font="9px ui-monospace,monospace";c.textAlign="center";
  c.fillText("now",nowX,hLat.y0-5);

  function trace(h,pts,isLat){
    // past dim, future bright
    c.lineWidth=1.8;c.lineJoin="round";
    for(let k=1;k<pts.length;k++){
      const past = pts[k][0]<=nowX;
      c.strokeStyle = past ? "#2b6f8c" : "#41d6ff";
      c.globalAlpha = past?0.55:1;
      c.beginPath();c.moveTo(pts[k-1][0],pts[k-1][1]);c.lineTo(pts[k][0],pts[k][1]);c.stroke();
    }
    c.globalAlpha=1;
  }
  trace(hLat,latPts,true);
  trace(hLon,lonPts,false);

  // current markers
  const s=satState(state.t,state.inc,state.raan,state.ma0);
  function marker(h,val,isLat){
    const y=h.y0+h.h*(1-(isLat?(val+90)/180:(val+180)/360));
    c.fillStyle="#ffd23f";c.beginPath();c.arc(nowX,y,4,0,7);c.fill();
    c.strokeStyle="#241a00";c.lineWidth=1;c.stroke();
  }
  marker(hLat,s.lat,true);
  marker(hLon,s.lon,false);
}

/* =========================================================================
   VIEW 2 : GROUND TRACK  (equirectangular map)
   ========================================================================= */
/* Land is drawn from the same world.js GeoJSON the globe view uses.  d3 does the
   geographic work: an equirectangular projection cuts the antimeridian and closes
   Antarctica's ring along the pole, which a naive lon/lat plot does not do.
   The projection is unit-scaled, so d3 hands us (lon_rad, -lat_rad) and we map
   those through the same linear lon/lat mapping used by the rest of this view. */
function drawLand(c, lonX, latY){
  const proj = d3.geoEquirectangular().scale(1).translate([0,0]);
  const landCtx = {
    moveTo:   (x,y)=>c.moveTo(lonX(x*R2D), latY(-y*R2D)),
    lineTo:   (x,y)=>c.lineTo(lonX(x*R2D), latY(-y*R2D)),
    closePath: ()=>c.closePath(),
    arc:      (x,y,r)=>c.arc(lonX(x*R2D), latY(-y*R2D), r),
  };
  const path = d3.geoPath(proj, landCtx);
  c.beginPath();path(landGeoJSON);c.fill();
  c.beginPath();path(landGeoJSON);c.stroke();
}

function drawGroundTrack(){
  const t=tasks[1];
  const {W,H,c}=clearCtx(t,"#08101c");
  const padL=30,padR=10,padT=26,padB=18;
  const x0=padL,y0=padT,w=W-padL-padR,h=H-padT-padB;

  // linear map: -180 at left, 0 center, +180 at right
  const lonX = lo => x0+w*(clamp(lo,-180,180)+180)/360;
  const latY = la => y0+h*(1-(la+90)/180);

  // ocean
  c.fillStyle="#0b1626";c.fillRect(x0,y0,w,h);

  // graticule
  c.strokeStyle="#152238";c.lineWidth=1;
  for(let lo=-180;lo<=180;lo+=30){const x=lonX(lo);c.beginPath();c.moveTo(x,y0);c.lineTo(x,y0+h);c.stroke();}
  for(let la=-90;la<=90;la+=30){const y=latY(la);c.beginPath();c.moveTo(x0,y);c.lineTo(x0+w,y);c.stroke();}
  // equator + prime meridian
  c.strokeStyle="#2a3d5e";c.lineWidth=1.2;
  c.beginPath();c.moveTo(x0,latY(0));c.lineTo(x0+w,latY(0));c.stroke();
  c.beginPath();c.moveTo(lonX(0),y0);c.lineTo(lonX(0),y0+h);c.stroke();

  // continents / landmasses (world.js GeoJSON, drawn through d3)
  c.strokeStyle="#2a6b4f";c.fillStyle="#143024";c.lineWidth=0.8;c.lineJoin="round";
  drawLand(c, lonX, latY);

  // reachability band
  c.fillStyle="#41d6ff0a";
  c.fillRect(x0,latY(state.inc),w,latY(-state.inc)-latY(state.inc));
  c.strokeStyle="#41d6ff44";c.setLineDash([4,4]);
  c.beginPath();c.moveTo(x0,latY(state.inc));c.lineTo(x0+w,latY(state.inc));c.stroke();
  c.beginPath();c.moveTo(x0,latY(-state.inc));c.lineTo(x0+w,latY(-state.inc));c.stroke();
  c.setLineDash([]);

  // ---- ground track over +-1.5 orbits, split past/future ----
  const span=PERIOD*3;
  const N=520;
  let prev=null;
  for(let k=0;k<=N;k++){
    const tt=state.t-span/2+(span)*k/N;
    const s=satState(tt,state.inc,state.raan,state.ma0);
    const x=lonX(s.lon), y=latY(s.lat);
    if(prev){
      let px=prev.x, py=prev.y;
      // handle wrap: skip segment if jump > half map
      if(Math.abs(x-px)>w*0.5){
        // draw toward edge instead
        const past=tt<=state.t;
        c.strokeStyle=past?"#2b6f8c77":"#41d6ff";
        c.lineWidth=past?1.4:2;
        const edge = x<px ? 0 : x0+w;
        c.beginPath();
        if(x<px){ c.moveTo(px,py); c.lineTo(x0+w,py); c.moveTo(x0,y); c.lineTo(x,y);}
        else { c.moveTo(px,py);c.lineTo(x0,py); c.moveTo(x0+w,y); c.lineTo(x,y);}
        c.stroke();
      } else {
        const past=tt<=state.t;
        c.strokeStyle=past?"#2b6f8c77":"#41d6ff";
        c.lineWidth=past?1.4:2.2;
        c.beginPath();c.moveTo(px,py);c.lineTo(x,y);c.stroke();
      }
    }
    prev={x,y};
  }

  // ---- target marker ----
  const tx=lonX(state.target.lon), ty=latY(state.target.lat);
  c.strokeStyle="#ff5db1";c.lineWidth=2;
  c.beginPath();c.arc(tx,ty,7,0,7);c.stroke();
  c.beginPath();c.moveTo(tx-11,ty);c.lineTo(tx+11,ty);c.moveTo(tx,ty-11);c.lineTo(tx,ty+11);c.stroke();

  // ---- current subsatellite point ----
  const s=satState(state.t,state.inc,state.raan,state.ma0);
  const sx=lonX(s.lon), sy=latY(s.lat);
  // closest-approach connector
  c.strokeStyle="#ffd23f88";c.setLineDash([3,3]);c.lineWidth=1.2;
  c.beginPath();c.moveTo(sx,sy);c.lineTo(tx,ty);c.stroke();c.setLineDash([]);

  c.fillStyle="#ffd23f";c.beginPath();c.arc(sx,sy,5,0,7);c.fill();
  c.strokeStyle="#3a2c00";c.lineWidth=1;c.stroke();
  c.fillStyle="#ffd23f";c.font="10px ui-monospace,monospace";c.textAlign="left";
  c.fillText("SAT",sx+8, sy-6);

  // labels
  c.fillStyle="#4c5a7c";c.font="8.5px ui-monospace,monospace";c.textAlign="center";
  for(let lo=-180;lo<=180;lo+=60) c.fillText(lo+"\u00b0",lonX(lo),y0+h+12);
  c.textAlign="right";
  for(let la=-60;la<=60;la+=30) c.fillText(la+"\u00b0",x0-3,latY(la)+3);
  c.textAlign="left";c.fillStyle="#8fa3cf";
  c.fillText("\u2212180\u00b0 \u2190\u2192 0\u00b0 \u2190\u2192 +180\u00b0",x0+4,y0+10);
}

/* =========================================================================
   VIEW 3 : FIXED GLOBE
   ========================================================================= */
function drawGlobe(){
  const t=tasks[2];
  const {W,H,c}=clearCtx(t,"#05070f");
  const cx=W*0.5, cy=H*0.54, rad=Math.min(W,H)*0.34;

  // --- camera orientation (draggable) ---
  // The camera lives in the INERTIAL frame: yaw follows RAAN until the player
  // drags, then becomes user-controlled. We express that inertial eye direction
  // as the geographic (lon/lat) point currently under the camera, which is what
  // d3's orthographic projection wants via rotate([-lon,-lat,0]).
  const camYaw = (state.cam.yaw==null) ? (state.raan+35) : state.cam.yaw;
  const yaw = camYaw*D2R;
  const pitch = state.cam.pitch*D2R;
  const eyeDir = [Math.cos(pitch)*Math.cos(yaw),
                  Math.cos(pitch)*Math.sin(yaw),
                  Math.sin(pitch)];   // unit vector from origin toward viewer (ECI)
  const theta = WE*state.t;            // Earth rotation angle ECI<->ECEF
  // geographic lon/lat of the point beneath the (inertial) camera
  const eyeEcef = m3v(rotz(-theta), eyeDir);
  const camLat = Math.asin(clamp(eyeEcef[2],-1,1))*R2D;
  const camLon = Math.atan2(eyeEcef[1],eyeEcef[0])*R2D;

  // d3 orthographic projection: centers on (camLon,camLat), east right / north up.
  const projection = d3.geoOrthographic()
    .scale(rad)
    .translate([cx,cy])
    .clipAngle(90)
    .rotate([-camLon,-camLat,0]);
  const path = d3.geoPath(projection, c);

  // front/back test for a geographic point: is it on the visible hemisphere?
  const isFront = (lon,lat)=>{
    const la=lat*D2R, lo=lon*D2R, cla=camLat*D2R, clo=camLon*D2R;
    // dot of unit vectors (geo) between point and camera center
    const d=Math.sin(la)*Math.sin(cla)+Math.cos(la)*Math.cos(cla)*Math.cos(lo-clo);
    return d>0;
  };
  // geographic lon/lat of an ECI direction (used for the inertial orbit)
  const eciToLL = (v)=>{
    const e=m3v(rotz(-theta), v);
    return [Math.atan2(e[1],e[0])*R2D, Math.asin(clamp(e[2],-1,1))*R2D];
  };

  // ---- draw earth sphere as shaded disc ----
  const g=c.createRadialGradient(cx-rad*0.35,cy-rad*0.4,rad*0.1,cx,cy,rad*1.15);
  g.addColorStop(0,"#1d3556");g.addColorStop(0.7,"#0e1c33");g.addColorStop(1,"#050a14");
  c.fillStyle=g;c.beginPath();c.arc(cx,cy,rad,0,7);c.fill();
  c.strokeStyle="#2b4566";c.lineWidth=1;
  c.beginPath();c.arc(cx,cy,rad,0,7);c.stroke();

  // ---- graticule (30 deg) ----
  c.strokeStyle="#1b3355";c.lineWidth=0.5;
  c.beginPath();path(d3.geoGraticule().step([30,30])());c.stroke();

  // ---- landmasses (d3 handles clipping to the visible hemisphere) ----
  c.fillStyle="#143024";c.strokeStyle="#2a6b4f";c.lineWidth=0.8;c.lineJoin="round";
  c.beginPath();path(landGeoJSON);c.fill();
  c.beginPath();path(landGeoJSON);c.stroke();

  // ---- orbital plane + orbit path ----
  // Build the orbit direction using the SAME PQW->ECI transform as satState,
  // so the drawn curve and the satellite marker are guaranteed consistent.
  const R = pqwToEci(state.inc, state.raan);   // PQW -> ECI
  const AB = A_SMA / R_E;                       // orbit radius in earth radii (~1.088)
  const orbitDir = ang => m3v(R, [Math.cos(ang), Math.sin(ang), 0]);   // ECI unit dir
  // Project a unit-sphere ECI direction to screen by scaling the projected
  // offset from center by `scale` (1 => earth surface, AB => orbit radius).
  const orbitXY = (ang, scale)=>{
    const ll = eciToLL(orbitDir(ang));
    const s = projection(ll);
    if(!s) return null;
    return {x:cx+(s[0]-cx)*scale, y:cy+(s[1]-cy)*scale};
  };

  // plane disc: faint filled halo, no outline (the orbit line is the edge)
  c.fillStyle="#8a7dff12";
  c.beginPath();
  let wrote=false;
  for(let k=0;k<=90;k++){
    const s=orbitXY(k/90*2*Math.PI, AB*1.04);
    if(!s) continue;
    wrote?c.lineTo(s.x,s.y):c.moveTo(s.x,s.y);wrote=true;
  }
  if(wrote)c.fill();

  // orbit path
  c.strokeStyle="#41d6ff";c.lineWidth=1.6;
  c.beginPath();
  wrote=false;
  for(let k=0;k<=180;k++){
    const s=orbitXY(k/180*2*Math.PI, AB);
    if(!s){wrote=false;continue;}
    wrote?c.lineTo(s.x,s.y):c.moveTo(s.x,s.y);wrote=true;
  }
  c.stroke();

  // ---- target point (earth-fixed) ----
  const tpXY = projection([state.target.lon,state.target.lat]);
  if(tpXY && isFront(state.target.lon,state.target.lat)){
    c.fillStyle="#ff5db1";c.beginPath();c.arc(tpXY[0],tpXY[1],4,0,7);c.fill();
    c.strokeStyle="#ff5db1";c.lineWidth=1.5;
    c.beginPath();c.arc(tpXY[0],tpXY[1],7,0,7);c.stroke();
    c.fillStyle="#ff5db1";c.font="9px ui-monospace,monospace";c.textAlign="left";
    c.fillText("TARGET",tpXY[0]+9,tpXY[1]+3);
  } else {
    c.fillStyle="#ff5db155";c.font="9px ui-monospace,monospace";c.textAlign="center";
    c.fillText("target behind Earth",cx,cy+rad+16);
  }

  // ---- satellite (same transform as the orbit path) ----
  const n_mm = Math.sqrt(MU/(A_SMA*A_SMA*A_SMA));
  const u_now = state.ma0*D2R + n_mm*state.t;       // arg of latitude now
  const satPt = orbitXY(u_now, AB);
  if(satPt){
    c.fillStyle="#ffd23f";c.beginPath();c.arc(satPt.x,satPt.y,5,0,7);c.fill();
    c.strokeStyle="#3a2c00";c.lineWidth=1;c.stroke();
  }
}

/* =========================================================================
   TELEMETRY / GAME LOOP
   ========================================================================= */
function currentMiss(){
  const s=satState(state.t,state.inc,state.raan,state.ma0);
  return gcDist(s.lat,s.lon,state.target.lat,state.target.lon);
}

function updateBest(){
  // scan next 3 orbits from t=0 for closest approach under current params
  // (proxy for player's "closest approach" feedback)
  const s0=satState(0,state.inc,state.raan,state.ma0);
  let best=Infinity,bestT=0;
  const N=900, span=PERIOD*3;
  for(let k=0;k<=N;k++){
    const tt=span*k/N;
    const s=satState(tt,state.inc,state.raan,state.ma0);
    const d=gcDist(s.lat,s.lon,state.target.lat,state.target.lon);
    if(d<best){best=d;bestT=tt;}
  }
  state.predBest=best;
  return {best,bestT};
}

function autoSolve(){
  const tgt=state.target;
  // choose inclination to reach target latitude exactly
  let i=Math.abs(tgt.lat);
  if(i<0.5)i=0.5;
  // find M0 and RAAN such that a pass goes over target.
  // sweep RAAN over 0..360 and M0 over 0..360 to minimize miss at nearest pass.
  let best={d:Infinity,i,raan:0,ma0:0};
  for(let rs=0; rs<360; rs+=3){
    for(let ms=0; ms<360; ms+=3){
      // sample one orbit from t=0
      for(let k=0;k<=120;k++){
        const tt=PERIOD*k/120;
        const s=satState(tt,i,rs,ms);
        const d=gcDist(s.lat,s.lon,tgt.lat,tgt.lon);
        if(d<best.d) best={d,i,raan:rs,ma0:ms};
      }
    }
  }
  state.inc=best.i; state.raan=best.raan; state.ma0=best.ma0;
  incEl.value=best.i; raanEl.value=best.raan; maEl.value=best.ma0;
  syncLabels(); state.t=0; state.history=[]; updateBest();
  toastMsg("Auto-solve: i="+best.i.toFixed(1)+"\u00b0, \u03a9="+best.raan.toFixed(0)+"\u00b0, M\u2080="+best.ma0.toFixed(0)+"\u00b0");
}

function telemetry(){
  const miss=currentMiss();
  const pb=state.predBest!=null?state.predBest:updateBest().best;

  liveMissEl.querySelector("b").textContent = miss.toFixed(1)+" km";
  liveMissEl.querySelector("b").style.color = miss<WIN_KM?"#39e08a":(miss<300?"#ffd23f":"#ff8b96");
  bestMissEl.querySelector("b").textContent = (pb<1e9?pb.toFixed(1)+" km":"--");

  // reachability
  const reachable = state.inc>=Math.abs(state.target.lat)-1e-9;
  reachEl.textContent = reachable ? "lat reachable" : "lat NOT reachable";
  reachEl.style.color = reachable ? "#39e08a" : "#ff5d6c";

  // clock
  const revs=state.t/PERIOD;
  clockEl.textContent = (state.t/60).toFixed(1)+" min  ("+revs.toFixed(2)+" rev)";
}

function checkWin(){
  const miss=currentMiss();
  if(!state.won && miss<WIN_KM){
    state.won=true;
    toastMsg("\u2714 TARGET HIT \u2014 miss "+miss.toFixed(1)+" km! New target incoming...");
    setTimeout(()=>{ newTarget(); state.t=0; state.history=[]; },1800);
  }
}

/* ---------- main loop ---------- */
let last=performance.now();
function loop(now){
  const dtReal=Math.min(0.05,(now-last)/1000); last=now;
  if(!state.paused){
    state.t += dtReal*state.speed;
  }
  // history sampling (for potential traces)
  drawTimeSeries();
  if(state.views.gt) drawGroundTrack();
  if(state.views.gl) drawGlobe();
  telemetry();
  checkWin();
  requestAnimationFrame(loop);
}

/* ---------- init ---------- */
fitAll();
applyViewLayout();
newTarget();
updateBest();
syncLabels();
requestAnimationFrame(loop);
