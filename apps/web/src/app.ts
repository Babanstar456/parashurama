import {
  avg, brgOf, buildScenario, calStats, chainHash, clamp, classificationStats, drillsToCsv, createEngine, decisionClass, demoHistory, expertPolicy, FAULT_LABEL,
  fmtTime, inReach, isCleared, isDone, needsClearance, mastery, mulberry, observe, planNext, runSim, runTotal, scoreRun, sectorOf, SKILLS, step, sumCal,
  tti, visibleBlip, windOf, cameraRange, weatherFx, WEATHER_LABEL,
} from '@parashurama/engine';
import { $, $$, cap, cssv } from './dom';
import { C, TYPES, ORDER, EFF, EFF_ORDER, CONF, RULES, SIM, DT, SWEEP, RMAX, BASE, MAXT, T, confLabel, CERT } from './cfg';
import { drawPaper, symPath, kindOfCls, symSvg } from './paper';
import { radarChart } from './charts';
import { toast } from './toast';

const fmt = fmtTime;
// ---- extension points: feature modules subscribe here instead of editing this file ----
type Handler = (arg?: any) => void;
const listeners: Record<string, Handler[]> = {};
export function on(ev: string, fn: Handler) { (listeners[ev] = listeners[ev] || []).push(fn); }
function emit(ev: string, arg?: any) { (listeners[ev] || []).forEach((f) => { try { f(arg); } catch (e) { console.error(`[${ev}]`, e); } }); }
export const hooks: any = { blockers: [] as (() => boolean)[], next: null as null | (() => boolean), operators: null as null | (() => any[]), tourBegin: null as null | (() => void), syncDrill: null as null | ((rec: any, R: any) => void) };
let L: any = null;
let R: any = null;
// ===================== persistence =====================
const STORE='parashurama.v2';
const TRAINEE={name:'Nk Arjun Rao',unit:'AD Troop 2'};
function loadDB(){
  try{if(location.search.includes('reset'))localStorage.removeItem(STORE);}catch(e){}
  try{const j=JSON.parse(localStorage.getItem(STORE)||'null');if(j&&Array.isArray(j.H)&&j.H.length)return j;}catch(e){}
  return{H:demoHistory(),tourDone:false};
}
function saveDB(){try{localStorage.setItem(STORE,JSON.stringify({H:DB.H.map(s=>({...s,actions:undefined})),tourDone:DB.tourDone,academy:DB.academy,settings:DB.settings}));}catch(e){}}
const DB=loadDB();DB.academy=DB.academy||{done:[]};DB.settings=DB.settings||{sound:'sound'};
let plan=planNext(DB.H);
let phase='brief';
const ABBR={north:'N','north-east':'NE',east:'E','south-east':'SE',south:'S','south-west':'SW',west:'W','north-west':'NW'};

// ===================== BRIEF =====================
function renderBrief(){
  const c=plan.cfg;
  $('#drillNo').textContent='DRILL '+String(c.drill).padStart(2,'0');
  $('#drillWhen').innerHTML=`Built for ${TRAINEE.name}<br>Seed ${c.seed}`;
  const tested=plan.tests.join(' ');
  const cards=[['Time',c.time==='night'?'Night':'Day',c.time==='night'],['Terrain',cap(c.terrain),false],['Sensors',c.fault==='radar'?`Radar fault ${ABBR[windOf(c.faultSector)]}`:FAULT_LABEL[c.fault],c.fault!=='none'],['Weather',WEATHER_LABEL[c.weather||'clear'],(c.weather||'clear')!=='clear'],['Attack',c.pattern==='swarm'?'Swarm raid':'Mixed raid',c.pattern==='swarm'],...(c.ewRestricted?[['Spectrum','EW-restricted area',true]]:[]),...((c.roe||'free')!=='free'?[['ROE',c.roe==='peacetime'?'Peacetime: clear every shot':'Tight: clear kinetic shots',true]]:[])];
  $('#conds').innerHTML=cards.map(([k,v,h])=>`<div class="cond ${h?'hot':''}"><small>${k}</small><b>${v}</b></div>`).join('');
  const sp=buildScenario(c);const nh=sp.filter(x=>TYPES[x.type].hostile).length;
  $('#expect').innerHTML=`<span>Expected hostiles <b>${Math.max(1,nh-1)}–${nh+2}</b></span><span>Difficulty <b>${c.difficulty} / 6</b></span><span>About <b>2½ min</b></span>`;
  $('#intentSub').textContent=DB.H.length?`Built from your last ${Math.min(5,DB.H.length)} drills`:'Starts after your first drill';
  $('#intentList').innerHTML=plan.lines.map((l,i)=>`<li><i>${i+1}</i><span><b>${l.b}</b>${l.t}</span></li>`).join('');
  $('#tests').innerHTML=`<b>This drill tests:</b> ${plan.tests.join(', ')}.`;
  const m=mastery(DB.H);
  $('#fingerSvg').innerHTML=radarChart(m,null,{w:200,h:190,r:70,labels:false});
  $('#mlist').innerHTML=SKILLS.map(([k,l])=>`<div class="mrow ${m[k]<0.5?'weak':''}"><span>${l}</span><div class="mbar"><i style="width:${Math.round(m[k]*100)}%"></i></div><em class="num">${Math.round(m[k]*100)}%</em></div>`).join('');
  const cv=$('#mapBrief');drawPaper(cv.getContext('2d'),cv.width,cv.height,c,{axes:sp,rad:cv.height*0.45});
  emit('brief');
}

// ===================== FIGHT =====================
const live={queue:[],actions:[],did:{},labels:{},nLab:0,paused:false,sel:null,pick:{cls:null,conf:null},pointer:null,attn:new Array(12).fill(0),endAt:null,endTick:0,acc:0,last:0,sig:'',defSig:'',frame:0,mode:'scored',lesson:null,spawns:null,speed:1,doneFn:null,maxSec:null,cfg:null,template:null,auto:false};
const rc=$('#radar'),rx=rc.getContext('2d');
/** Start a drill. opts: { mode:'scored'|'academy'|'template', cfg, spawns, speed, doneFn, maxSec, lesson, template } */
function startDrill(fromTour,opts:any={}){
  const cfg=opts.cfg||plan.cfg;
  L=createEngine(cfg,undefined,opts.spawns);
  Object.assign(live,{queue:[],actions:[],did:{},labels:{},nLab:0,paused:false,sel:null,pick:{cls:null,conf:null},pointer:null,attn:new Array(12).fill(0),endAt:null,endTick:0,acc:0,sig:'',defSig:'',
    mode:opts.mode||'scored',lesson:opts.lesson??null,spawns:opts.spawns||null,speed:opts.speed||1,doneFn:opts.doneFn||null,maxSec:opts.maxSec||null,cfg,template:opts.template||null,auto:!!opts.auto});
  document.body.dataset.mode=live.mode;
  // warm start so the first blips are already on the scope
  while(L.tick<T(SIM.warmStartSec+7)&&(L.tick<T(SIM.warmStartSec)||!L.contacts.some(c=>visibleBlip(L,c))))step(L,[]);
  setPhase('fight');sizeRadar();renderRail(true);emit('start',{fromTour,opts});
}
function sizeRadar(){const w=$('#radarWrap');const side=Math.max(320,Math.min(w.clientWidth-28,w.clientHeight-28));rc.style.width=side+'px';rc.style.height=side+'px';}
function act(a){a.tick=L.tick;live.queue.push(a);live.actions.push(a);}
function doTrack(c){if((live.did[c.id]||{}).track)return;live.did[c.id]={...(live.did[c.id]||{}),track:true};if(!live.labels[c.id])live.labels[c.id]='T'+String(++live.nLab).padStart(2,'0');act({k:'track',cid:c.id});emit('act',{k:'track',c});}
function doId(c,cls,conf){const d=live.did[c.id]||{};if(d.id)return;live.did[c.id]={...d,id:{cls,conf}};act({k:'id',cid:c.id,cls,conf});emit('act',{k:'id',c,cls,conf});}
// A shot that could work but missed (effector pk < 1): tell the trainee once, so they engage again.
const missSeen=new WeakSet();
function noteMisses(){for(const c of L.contacts){const e=c.engs[c.engs.length-1];if(e&&e.miss&&!missSeen.has(e)){missSeen.add(e);toast(`MISS: ${EFF[e.eff].label} on ${live.labels[c.id]||'contact'}. Engage again.`);}}}
function doReq(c){act({k:'req',cid:c.id});const d=live.did[c.id]||{};live.did[c.id]={...d,req:true};emit('act',{k:'req',c});}
function doEng(c,eff){act({k:'eng',cid:c.id,eff});const d=live.did[c.id]||{};live.did[c.id]={...d,engAt:L.tick,lastEff:eff};emit('act',{k:'eng',c,eff});}
const R0=470,C0=500;const w2c=(x,y)=>[C0+x*R0/RMAX,C0+y*R0/RMAX];
function contactKind(c){const d=live.did[c.id]||{};const cls=c.idCls||(d.id&&d.id.cls);return kindOfCls(cls);}
const KCOL=k=>k==='hostile'?cssv('--nh'):k==='friend'?cssv('--nf'):k==='neutral'?cssv('--nn'):cssv('--nu');
// Weather on the radar scope: rain clutter speckle, fog/dust haze, and a label with the sensor penalty.
const WX_TINT={rain:'rgba(120,150,190,',fog:'rgba(170,180,190,',dust:'rgba(190,150,95,'};
function drawWeatherScope(ctx,cond){
  const w=live.cfg.weather||'clear';if(w==='clear')return;const fx=weatherFx(C,w);
  ctx.fillStyle=WX_TINT[w]+(w==='fog'?'0.10)':'0.07)');ctx.fillRect(0,0,1000,1000);
  const r=mulberry((L.tick>>1)*131+7);const n=w==='rain'?260:w==='dust'?160:60;
  for(let i=0;i<n;i++){const a=r()*6.283,d=Math.sqrt(r())*R0;ctx.fillStyle=WX_TINT[w]+(0.15+r()*0.35)+')';const s=w==='rain'?2:1.5;ctx.fillRect(C0+Math.cos(a)*d,C0+Math.sin(a)*d,s,s);}
  ctx.font=`600 17px ${cond}`;ctx.fillStyle=WX_TINT[w]+'0.85)';ctx.textAlign='center';
  ctx.fillText(`${fx.label.toUpperCase()} · radar ${Math.round((1-fx.radar)*100)>0?'−'+Math.round((1-fx.radar)*100)+'%':'ok'} · camera −${Math.round((1-fx.camera)*100)}%`,C0,C0-R0*0.8);ctx.textAlign='left';
}
function drawRadar(){
  const ctx=rx,cond=cssv('--cond');ctx.clearRect(0,0,1000,1000);
  const g=ctx.createRadialGradient(C0,C0,30,C0,C0,R0);g.addColorStop(0,'#14212B');g.addColorStop(1,'#0A1117');ctx.fillStyle=g;ctx.beginPath();ctx.arc(C0,C0,R0,0,7);ctx.fill();
  ctx.save();ctx.beginPath();ctx.arc(C0,C0,R0,0,7);ctx.clip();
  const tr=mulberry(live.cfg.seed+5);ctx.strokeStyle='rgba(141,160,176,0.06)';ctx.lineWidth=1;
  if(live.cfg.terrain==='urban'){for(let i=0;i<120;i++){ctx.strokeRect(tr()*1000,tr()*1000,6+tr()*20,6+tr()*14);}}else{for(let i=0;i<14;i++){ctx.beginPath();ctx.ellipse(tr()*1000,tr()*1000,30+tr()*70,20+tr()*40,tr()*3,0,7);ctx.stroke();}}
  if(live.cfg.fault==='radar'){const a0=(live.cfg.faultSector-30-90)*Math.PI/180,a1=(live.cfg.faultSector+30-90)*Math.PI/180;ctx.fillStyle='rgba(242,201,76,0.07)';ctx.beginPath();ctx.moveTo(C0,C0);ctx.arc(C0,C0,R0,a0,a1);ctx.closePath();ctx.fill();
    const am=(live.cfg.faultSector-90)*Math.PI/180;ctx.fillStyle='rgba(242,201,76,0.7)';ctx.font=`600 19px ${cond}`;ctx.textAlign='center';ctx.fillText('RADAR FAULT',C0+Math.cos(am)*R0*0.62,C0+Math.sin(am)*R0*0.62);ctx.textAlign='left';}
  drawWeatherScope(ctx,cond);
  const sw=(L.tick*DT/SWEEP*360)%360;for(let i=0;i<36;i++){const a=(sw-i*1.1-90)*Math.PI/180;ctx.strokeStyle=`rgba(63,167,150,${0.32*(1-i/36)})`;ctx.lineWidth=4;ctx.beginPath();ctx.moveTo(C0,C0);ctx.lineTo(C0+Math.cos(a)*R0,C0+Math.sin(a)*R0);ctx.stroke();}
  ctx.restore();
  ctx.font=`500 15px ${cond}`;ctx.fillStyle='rgba(138,157,174,0.85)';
  for(let k=1;k<=3;k++){ctx.strokeStyle='rgba(138,157,174,0.25)';ctx.lineWidth=1.2;ctx.beginPath();ctx.arc(C0,C0,R0*k/3,0,7);ctx.stroke();ctx.fillText(k+' km',C0+5,C0-R0*k/3+16);}
  const ringE=(R,col,lbl)=>{ctx.strokeStyle=col;ctx.globalAlpha=0.45;ctx.setLineDash([6,6]);ctx.lineWidth=1.4;ctx.beginPath();ctx.arc(C0,C0,R*R0/RMAX,0,7);ctx.stroke();ctx.setLineDash([]);ctx.globalAlpha=0.8;ctx.fillStyle=col;ctx.fillText(lbl,C0+R*R0/RMAX*0.71+4,C0+R*R0/RMAX*0.71+14);ctx.globalAlpha=1;};
  ringE(EFF.jam.range,cssv('--jam'),'jam');ringE(EFF.gun.range,cssv('--gun'),'gun');
  ctx.strokeStyle='rgba(138,157,174,0.5)';ctx.fillStyle='rgba(138,157,174,0.85)';
  for(let a=0;a<360;a+=10){const t=(a-90)*Math.PI/180,l=a%30?6:12;ctx.beginPath();ctx.moveTo(C0+Math.cos(t)*R0,C0+Math.sin(t)*R0);ctx.lineTo(C0+Math.cos(t)*(R0-l),C0+Math.sin(t)*(R0-l));ctx.stroke();
    if(a%30===0){const lb=a===0?'N':a===90?'E':a===180?'S':a===270?'W':String(a).padStart(3,'0');ctx.textAlign='center';ctx.fillText(lb,C0+Math.cos(t)*(R0+18),C0+Math.sin(t)*(R0+18)+5);ctx.textAlign='left';}}
  ctx.fillStyle=cssv('--nf');ctx.fillRect(C0-8,C0-8,16,16);ctx.strokeStyle=cssv('--nf');ctx.setLineDash([3,3]);ctx.beginPath();ctx.arc(C0,C0,BASE*R0/RMAX+8,0,7);ctx.stroke();ctx.setLineDash([]);
  const now=L.tick;const placed=[];
  for(const c of L.contacts){
    const [px,py]=w2c(c.x,c.y);
    if(c.state==='leaked'){if(now-c.endTick<T(2.5)){ctx.strokeStyle=cssv('--nh');ctx.lineWidth=3;ctx.globalAlpha=1-(now-c.endTick)/T(2.5);ctx.beginPath();ctx.arc(C0,C0,20+(now-c.endTick)*1.2,0,7);ctx.stroke();ctx.globalAlpha=1;}continue;}
    if(c.state==='neutralised'){if(now-c.endTick<T(3)){ctx.strokeStyle=cssv('--nn');ctx.lineWidth=3;ctx.globalAlpha=1-(now-c.endTick)/T(3);ctx.beginPath();ctx.moveTo(px-12,py-12);ctx.lineTo(px+12,py+12);ctx.moveTo(px+12,py-12);ctx.lineTo(px-12,py+12);ctx.stroke();ctx.globalAlpha=1;}continue;}
    const tracked=c.trackTick!=null||(live.did[c.id]||{}).track;
    if(!tracked){const age=now-c.lastPaint;if(age>T(SWEEP*1.6))continue;ctx.fillStyle=cssv('--nu');ctx.globalAlpha=clamp(1-age/T(SWEEP*1.6),0.18,1);ctx.beginPath();ctx.arc(px,py,7,0,7);ctx.fill();ctx.globalAlpha=1;continue;}
    const kind=contactKind(c),col=KCOL(kind);ctx.strokeStyle=col;ctx.lineWidth=2.6;if(kind==='unknown')ctx.setLineDash([5,4]);symPath(ctx,px,py,kind,11);ctx.stroke();ctx.setLineDash([]);
    if(!c.orbit&&c.type!=='bird'&&!c.hover){const [hx,hy]=w2c(c.x+Math.sin(c.hdg)*c.v*18,c.y-Math.cos(c.hdg)*c.v*18);ctx.beginPath();ctx.moveTo(px,py);ctx.lineTo(hx,hy);ctx.stroke();}
    if(live.sel===c.id||!placed.some(([qx,qy])=>Math.abs(qx-px)<46&&Math.abs(qy-py)<22)){ctx.fillStyle=col;ctx.font=`600 19px ${cond}`;ctx.fillText(live.labels[c.id]||'',px+16,py-12);placed.push([px,py]);}
    if(c.effectAt!=null){const e=c.engs[c.engs.length-1]||{tick:c.effectAt-T(EFF[c.effectBy].delay)};const fx=cssv(EFF[c.effectBy].color);const prog=clamp((now-e.tick)/(c.effectAt-e.tick),0,1);ctx.strokeStyle=fx;ctx.lineWidth=2;
      if(c.effectBy==='jam'||c.effectBy==='spoof'){for(let k=0;k<3;k++){const rr=14+((now*2+k*12)%36);ctx.globalAlpha=1-rr/50;ctx.beginPath();ctx.arc(px,py,rr,0,7);ctx.stroke();}ctx.globalAlpha=1;}
      else{const ix=C0+(px-C0)*prog,iy=C0+(py-C0)*prog;ctx.setLineDash(c.effectBy==='gun'?[2,6]:[]);ctx.beginPath();ctx.moveTo(C0,C0);ctx.lineTo(ix,iy);ctx.stroke();ctx.setLineDash([]);ctx.fillStyle=fx;ctx.beginPath();ctx.arc(ix,iy,4,0,7);ctx.fill();}}
    if(live.sel===c.id){ctx.strokeStyle='#FFFFFF';ctx.lineWidth=1.6;ctx.setLineDash([4,4]);ctx.beginPath();ctx.arc(px,py,25,0,7);ctx.stroke();ctx.setLineDash([]);}
  }
  emit('radar',{ctx,w2c});
}
rc.addEventListener('click',e=>{
  if(!L||tourBlocking())return;const b=rc.getBoundingClientRect(),mx=(e.clientX-b.left)*1000/b.width,my=(e.clientY-b.top)*1000/b.height;
  let best=null,bd=34;for(const c of L.contacts){if(!visibleBlip(L,c)&&!(live.did[c.id]||{}).track)continue;if(c.state!=='live')continue;const [px,py]=w2c(c.x,c.y);const d=Math.hypot(px-mx,py-my);if(d<bd){bd=d;best=c;}}
  if(best){doTrack(best);select(best.id);}
});
rc.addEventListener('mousemove',e=>{const b=rc.getBoundingClientRect(),mx=(e.clientX-b.left)*1000/b.width-C0,my=(e.clientY-b.top)*1000/b.height-C0;live.pointer=Math.hypot(mx,my)<R0?sectorOf(brgOf(mx,my)):null;});
rc.addEventListener('mouseleave',()=>live.pointer=null);
function select(id){live.sel=id;live.pick={cls:null,conf:null};live.sig='';live.defSig='';renderRail(true);}
function selC(){return L&&live.sel!=null?L.contacts.find(c=>c.id===live.sel):null;}
function windows(c){
  const out={};const d=Math.hypot(c.x,c.y);const tImp=tti(c);
  for(const k of EFF_ORDER){const ef=EFF[k];
    if(!isFinite(tImp)){out[k]=inReach(c,k)?[0,60]:null;continue;}
    const te=Math.max(0,(d-ef.range)/c.v);let end=tImp-ef.delay;if(ef.min)end=Math.min(end,(d-ef.min)/c.v);out[k]=end>te?[te,Math.min(60,end)]:null;}
  return out;
}
function availability(c,k){
  if(EFF[k].stock!=null&&(L.stock[k]??0)<=0)return{ok:false,txt:'none left'};
  if(c.effectAt!=null)return{ok:false,txt:'effect pending'};
  if(inReach(c,k))return{ok:true,txt:'in reach'};
  const w=windows(c)[k];if(w&&w[0]>0)return{ok:false,txt:`in ${Math.ceil(w[0])} s`};
  return{ok:false,txt:'out of reach'};
}
function renderRail(force=false){
  if(!L)return;
  const tracked=L.contacts.filter(c=>c.trackTick!=null||(live.did[c.id]||{}).track);
  const blips=L.contacts.filter(c=>c.trackTick==null&&!(live.did[c.id]||{}).track&&visibleBlip(L,c)).length;
  $('#ccount').textContent=`${tracked.filter(c=>c.state==='live').length} tracked · ${blips} unknown blip${blips===1?'':'s'}`;
  const order=tracked.slice().sort((a,b)=>(a.state==='live'?0:1)-(b.state==='live'?0:1)||tti(a)-tti(b));
  $('#contacts').innerHTML=order.map(c=>{
    const kind=contactKind(c),col=KCOL(kind);const d=live.did[c.id]||{};const cls=c.idCls||(d.id&&d.id.cls);const tt=tti(c);
    const st=c.state==='neutralised'?'Neutralised':c.state==='leaked'?'Reached asset':!cls?'Identify':c.effectAt!=null?'Engaging':(c.engs.length&&c.engs[0].eff==='hold'?'Holding':'Decide');
    const w=c.state==='live'?windows(c):null;
    const win=!w?'':(isFinite(tt)||Object.values(w).some(Boolean))?`<div class="win"><div class="wbox">${EFF_ORDER.map((k,i)=>w[k]?`<i style="top:${2+i*4}px;left:${w[k][0]/60*100}%;width:${Math.max(1.5,(w[k][1]-w[k][0])/60*100)}%;background:var(${EFF[k].color})"></i>`:'').join('')}${isFinite(tt)&&tt<60?`<b style="left:${tt/60*100}%"></b>`:''}</div></div>`:`<div class="wnote">Not closing on the asset</div>`;
    return `<div class="ccard ${live.sel===c.id?'sel':''} ${c.state!=='live'?'done':''}" data-id="${c.id}">${symSvg(kind,col,kind==='unknown')}<div class="nm">${live.labels[c.id]||'—'}<small>${cls?TYPES[cls].short:'Unknown'}</small></div><div class="tt">${c.state!=='live'?st:isFinite(tt)?`<b class="num ${tt<15?'urgent':''}">${Math.round(tt)} s</b> to impact`:`<b>${(Math.hypot(c.x,c.y)/1000).toFixed(1)} km</b>`}<br><span style="font-size:12.5px">${c.state==='live'?st:''}</span></div>${win}</div>`;}).join('')||'<div class="empty">No tracks yet. Click a yellow blip on the radar.</div>';
  $('#clock').textContent=fmt(L.tick*DT);
  $('#left').textContent=L.contacts.filter(c=>TYPES[c.type].hostile&&c.state==='live').length+(L.spawns.slice(L.next).filter(s=>TYPES[s.type].hostile).length);
  renderClues(force);
  const c=selC();const dd=c?live.did[c.id]||{}:{};
  const hint=!tracked.length&&blips?'Click a yellow blip to start a track':c&&c.state==='live'&&!(c.idCls||dd.id)?'Read the clues, then identify':c&&c.state==='live'&&c.effectAt==null&&!c.engs.length?'Choose a weapon in reach, or hold':blips?`${blips} unknown blip${blips===1?'':'s'} not tracked yet`:'';
  $('#hint').textContent=hint;$('#hint').style.opacity=hint?1:0;
}
function clueList(c){
  const Ty=TYPES[c.type],since=c.trackTick!=null?(L.tick-c.trackTick)*DT:0,d=Math.hypot(c.x,c.y),camR=cameraRange(C,live.cfg.time,live.cfg.weather);
  const sw=Ty.motion==='swarm'?L.contacts.filter(o=>o!==c&&o.type===c.type&&o.state==='live'&&Math.hypot(o.x-c.x,o.y-c.y)<600).length:0;
  const beh=(c.hover&&Ty.behaviourHover?Ty.behaviourHover:Ty.behaviour).replace('{n}',String(sw)).replace('with 1 others','with 1 other');
  const CL=C.training.clues;
  return[
    {k:'Radar',at:0,v:`${Math.round(c.v*3.6)} km/h · ${Math.round(c.alt)} m · ${Ty.echo.toLowerCase()} echo`},
    {k:'Friendly check',at:CL.friendlyCheckSec,v:Ty.friendly?'Matches flight plan F-21':'No flight-plan match'},
    {k:'RF signal',at:CL.rfSec,v:live.cfg.fault==='rf'?'Detector offline':Ty.rf},
    {k:'Behaviour',at:CL.behaviourSec,v:beh},
    {k:'Camera',at:0,cam:true,ready:d<camR,v:d<camR?(live.cfg.time==='night'?'Thermal':'Daylight')+(live.cfg.fault==='eo'?', degraded':'')+((live.cfg.weather||'clear')!=='clear'?', '+WEATHER_LABEL[live.cfg.weather].toLowerCase():''):`Out of range until ${(camR/1000).toFixed(1)} km`+((live.cfg.weather||'clear')!=='clear'?` (${WEATHER_LABEL[live.cfg.weather].toLowerCase()})`:'')},
  ].map(x=>({...x,ok:x.cam?x.ready:since>=x.at,left:Math.max(0,x.at-since)}));
}
function renderClues(force){
  const c=selC();
  if(!c||c.trackTick==null&&!(live.did[c.id]||{}).track){if(live.sig!=='none'||force){live.sig='none';$('#selTitle').textContent='No contact selected';$('#selSub').textContent='';$('#selMeta').textContent='Select a contact to see its clues.';$('#clues').innerHTML='';$('#idBody').innerHTML='<div class="empty" style="padding:2px 0 8px">Select a contact first.</div>';$('#defBody').innerHTML='<div class="empty" style="padding:2px 0 8px">Identify first.</div>';}return;}
  const cl=c.trackTick!=null?clueList(c):[];const d=live.did[c.id]||{};const cls=c.idCls||(d.id&&d.id.cls);const conf=c.idConf||(d.id&&d.id.conf);
  const sig=[c.id,c.trackTick!=null,cl.map(x=>x.ok?1:0).join(''),cls,conf,live.pick.cls,live.pick.conf].join('|');
  $('#selSub').textContent=c.state==='live'?`${(Math.hypot(c.x,c.y)/1000).toFixed(2)} km · ${String(Math.round(brgOf(c.x,c.y))).padStart(3,'0')}°`:'';
  if(sig!==live.sig||force){
    const prevOk=(live.sig.split('|')[2]||'');live.sig=sig;
    $('#selTitle').textContent=`${live.labels[c.id]||'—'} · ${cls?TYPES[cls].label:'Unknown contact'}`;
    $('#selMeta').textContent=cls?'Identification locked.':'Clues arrive over a few seconds. Commit when you are sure enough.';
    $('#clues').innerHTML=cl.map((x,i)=>`<div class="clue ${x.ok?'':'wait'} ${x.ok&&prevOk[i]==='0'?'fresh':''}"><div class="k">${x.k}</div><div>${x.cam?(x.ok?`<canvas id="eo" width="264" height="176"></canvas><div class="v" style="font-size:12.5px;color:var(--nm);margin-top:3px">${x.v}</div>`:`<div class="v">${x.v}</div>`):`<div class="v">${x.ok?x.v:'arriving…'}</div>${x.ok?'':`<div class="prog"><i data-at="${x.at}" style="width:0%"></i></div>`}`}</div></div>`).join('');
    if(cls){$('#idBody').innerHTML=`<div class="locked">Identified as <b style="color:${KCOL(kindOfCls(cls))}">${TYPES[cls].label}</b> · ${confLabel(conf)}</div>`;}
    else{$('#idBody').innerHTML=`<div class="idGrid">${ORDER.map((k,i)=>`<button class="nbtn ${live.pick.cls===k?'pick':''}" data-cls="${k}">${TYPES[k].short}${i<10?`<small>${(i+1)%10}</small>`:''}</button>`).join('')}</div><div class="confRow">${CONF.map(x=>`<button class="nbtn ${live.pick.conf===x.p?'pick':''}" data-conf="${x.p}">${x.label}<small>${x.key} · ${Math.round(x.p*100)}%</small></button>`).join('')}</div><button class="commit" id="commitBtn" ${live.pick.cls&&live.pick.conf?'':'disabled'}>Commit identification <kbd>Enter</kbd></button>`;}
  }
  if(c.trackTick!=null){const since=(L.tick-c.trackTick)*DT;$$('#clues .prog i').forEach(el=>{el.style.width=clamp(since/(+el.dataset.at)*100,0,100)+'%';});}
  renderDef(c,cls);
}
function renderDef(c,cls){
  const d=live.did[c.id]||{};
  const last=c.engs[c.engs.length-1];
  const av=EFF_ORDER.map(k=>availability(c,k));
  const clrLeft=c.clrAt!=null?Math.ceil(Math.max(0,(c.clrAt-L.tick)*DT)):'';
  const dsig=[c.id,cls,c.state,c.effectAt,c.engs.length,av.map(a=>a.txt).join(','),JSON.stringify(L.stock),c.clrReq,d.req,clrLeft].join('|');
  if(dsig===live.defSig)return;live.defSig=dsig;
  if(!cls){$('#defBody').innerHTML='<div class="empty" style="padding:2px 0 8px">Identify first.</div>';return;}
  if(c.state==='neutralised'){$('#defBody').innerHTML=`<div class="locked" style="border-color:var(--nn)">Neutralised by <b>${EFF[c.effectBy].label}</b>.</div>`;return;}
  if(c.state==='leaked'){$('#defBody').innerHTML='<div class="locked" style="border-color:var(--nh)">Reached the protected asset.</div>';return;}
  let note='';
  if(c.effectAt!=null)note=`<div class="locked" style="margin-bottom:8px">${EFF[c.effectBy].label} sent. Effect in ${Math.max(0,(c.effectAt-L.tick)*DT).toFixed(1)} s.</div>`;
  else if(last&&last.miss)note=`<div class="locked" style="margin-bottom:8px;border-color:var(--nh)">${EFF[last.eff].label}: <b>MISS</b>. It is still coming. Engage again.</div>`;
  else if(last&&last.eff!=='hold'&&!last.effective)note=`<div class="locked" style="margin-bottom:8px;border-color:var(--nh)">${EFF[last.eff].label}: <b>no effect</b>. It is still coming. Choose again.</div>`;
  else if(last&&last.eff==='hold')note=`<div class="locked" style="margin-bottom:8px">Holding fire. Keep watching it.</div>`;
  // Rules of engagement: some effectors need clearance first (key C). Firing without it still works but costs R12.
  const need=TYPES[cls]?.hostile?EFF_ORDER.filter(k=>needsClearance(L,k)):[];
  if(need.length&&c.effectAt==null){
    if(c.clrReq==null&&!d.req)note+=`<div class="clrRow"><button class="nbtn" data-act="req"><span>Request clearance<small>${L.cfg.roe} ROE: ${need.map(k=>EFF[k].label).join(', ')} need clearance</small></span><kbd>C</kbd></button></div>`;
    else if(c.clrAt==null||L.tick<c.clrAt)note+=`<div class="locked" style="margin-bottom:8px">Clearance requested. Cleared in ${clrLeft===''?'…':clrLeft+' s'}.</div>`;
    else note+=`<div class="locked" style="margin-bottom:8px;border-color:var(--nn)">Cleared to engage.</div>`;
  }
  $('#defBody').innerHTML=note+`<div class="effGrid">${EFF_ORDER.map((k,i)=>`<button class="nbtn" data-eff="${k}" ${av[i].ok?'':'disabled'}><span>${needsClearance(L,k)&&!isCleared(L,c,k)?'🔒 ':''}${EFF[k].label}${EFF[k].stock!=null?` (${L.stock[k]})`:''}<small>${av[i].txt}</small></span><kbd>${EFF[k].key}</kbd></button>`).join('')}<button class="nbtn hold" data-eff="hold" ${c.effectAt!=null||c.engs.length?'disabled':''}><span>Hold / report<small>friendlies, birds, civil drones</small></span><kbd>H</kbd></button></div>`;
}
function drawEO(){
  const cv=$('#eo');const c=selC();if(!cv||!c)return;const ctx=cv.getContext('2d',{willReadFrequently:true});const W=cv.width,H=cv.height;const night=live.cfg.time==='night';
  ctx.fillStyle=night?'#101214':'#6F8B9C';ctx.fillRect(0,0,W,H);if(!night){ctx.fillStyle='#8DA7B6';ctx.fillRect(0,0,W,H*0.6);}
  const d=Math.hypot(c.x,c.y),sc=clamp(1.7-d/cameraRange(C,live.cfg.time,live.cfg.weather),0.35,1.5);const Ty=TYPES[c.type];
  ctx.save();ctx.translate(W/2,H/2);ctx.scale(sc,sc);ctx.fillStyle=night?'#F4F4F4':'#1B242B';ctx.strokeStyle=ctx.fillStyle;ctx.lineWidth=4;
  if(Ty.shape==='quad'){ctx.fillRect(-14,-6,28,12);[[-30,-16],[30,-16],[-30,16],[30,16]].forEach(([a,b])=>{ctx.beginPath();ctx.moveTo(0,0);ctx.lineTo(a,b);ctx.stroke();ctx.beginPath();ctx.ellipse(a,b,13,3,0,0,7);ctx.fill();});}
  else if(Ty.shape==='wing'){ctx.beginPath();ctx.moveTo(-42,0);ctx.lineTo(42,0);ctx.lineTo(32,6);ctx.lineTo(-32,6);ctx.closePath();ctx.fill();ctx.fillRect(-6,-12,12,28);ctx.fillRect(-14,16,28,4);}
  else{const f=Math.sin(L.tick*0.9)*10;ctx.beginPath();ctx.moveTo(-32,-f);ctx.quadraticCurveTo(-12,-8,0,0);ctx.quadraticCurveTo(12,-8,32,-f);ctx.stroke();ctx.beginPath();ctx.ellipse(0,1,7,4,0,0,7);ctx.fill();}
  ctx.restore();
  const wx=live.cfg.weather||'clear',wfx=weatherFx(C,wx);
  if(wx==='fog'){ctx.fillStyle=night?'rgba(70,74,78,0.55)':'rgba(205,210,214,0.62)';ctx.fillRect(0,0,W,H);}
  else if(wx==='dust'){ctx.fillStyle=night?'rgba(80,60,35,0.45)':'rgba(176,138,88,0.5)';ctx.fillRect(0,0,W,H);}
  else if(wx==='rain'){const rr=mulberry(L.tick*17+c.id);ctx.strokeStyle=night?'rgba(200,210,220,0.35)':'rgba(230,236,242,0.5)';ctx.lineWidth=1;ctx.beginPath();for(let i=0;i<70;i++){const x=rr()*W,y=rr()*H;ctx.moveTo(x,y);ctx.lineTo(x-3,y+11);}ctx.stroke();}
  const noise=(live.cfg.fault==='eo'?0.6:night?0.2:0.08)+wfx.noise;const img=ctx.getImageData(0,0,W,H);const r=mulberry(L.tick+c.id);for(let i=0;i<img.data.length;i+=4){const v=(r()-0.5)*255*noise;img.data[i]+=v;img.data[i+1]+=v;img.data[i+2]+=v;}ctx.putImageData(img,0,0);
  ctx.strokeStyle='rgba(255,255,255,0.55)';ctx.lineWidth=1.5;ctx.beginPath();[[-1,0],[1,0],[0,-1],[0,1]].forEach(([a,b])=>{ctx.moveTo(W/2+a*8,H/2+b*8);ctx.lineTo(W/2+a*20,H/2+b*20);});ctx.stroke();
}
$('#contacts').addEventListener('click',e=>{const el=e.target.closest('.ccard');if(el)select(+el.dataset.id);});
$('#idBody').addEventListener('click',e=>{const b=e.target.closest('button');if(!b||b.disabled)return;if(b.dataset.cls){live.pick.cls=b.dataset.cls;live.sig='';renderRail();}else if(b.dataset.conf){live.pick.conf=+b.dataset.conf;live.sig='';renderRail();}else if(b.id==='commitBtn')commitId();});
$('#defBody').addEventListener('click',e=>{const b=e.target.closest('button');if(!b||b.disabled)return;if(b.dataset.act==='req'){reqSel();return;}engageSel(b.dataset.eff);});
function reqSel(){const c=selC();if(!c)return;const d=live.did[c.id]||{};const cls=c.idCls||(d.id&&d.id.cls);if(!cls||d.req||c.clrReq!=null||!TYPES[cls].hostile)return;doReq(c);live.defSig='';setTimeout(()=>renderRail(true),120);}
function commitId(){const c=selC();if(!c||!live.pick.cls||!live.pick.conf||c.trackTick==null)return;doId(c,live.pick.cls,live.pick.conf);live.sig='';renderRail(true);}
function engageSel(eff){const c=selC();if(!c)return;const d=live.did[c.id]||{};if(!(c.idCls||d.id))return;if(eff!=='hold'&&!availability(c,eff).ok)return;if(eff==='hold'&&(c.engs.length||c.effectAt!=null))return;doEng(c,eff);live.defSig='';setTimeout(()=>renderRail(true),120);}
function accumulate(){if(live.pointer!=null)live.attn[live.pointer]+=DT;else{const c=selC();if(c&&c.state==='live')live.attn[sectorOf(brgOf(c.x,c.y))]+=DT*0.5;}}
function frame(now){
  requestAnimationFrame(frame); // schedule first, so an error below can never stop the loop
  const dt=Math.min(0.1,(now-live.last)/1000||0);live.last=now;
  try{frameBody(dt);}catch(e){console.error('[frame]',e);}
}
function frameBody(dt){
  if(phase==='fight'&&L){
    if(!live.paused&&!tourBlocking()&&!hooks.blockers.some(f=>f())){live.acc+=dt*live.speed*((window as any).__TIMEWARP||1);while(live.acc>=DT){live.acc-=DT;if(live.auto)botActs();step(L,live.queue.splice(0));accumulate();noteMisses();emit('tick');
      const done=(live.doneFn?live.doneFn(L):isDone(L))||(live.maxSec&&L.tick>=T(live.maxSec));
      if(done){if(live.endAt==null)live.endAt=L.tick+T(1.5);if(L.tick>=live.endAt){finishDrill();break;}}}}
    if(phase==='fight'){drawRadar();drawEO();if(++live.frame%6===0)renderRail();emit('frame');}
  }
  if(phase==='learn'&&replay.playing)tickReplay(dt);
}
$('#pauseBtn').onclick=()=>togglePause();
$('#endBtn').onclick=()=>{if(L)finishDrill();};
function togglePause(){live.paused=!live.paused;$('#veil').classList.toggle('on',live.paused);$('#pauseBtn').firstChild.textContent=live.paused?'Resume ':'Pause ';}

// ===================== LEARN =====================
const replay={tick:0,playing:false};
function finishDrill(){
  live.endTick=L.tick;live.paused=false;$('#veil').classList.remove('on');
  const cfg=live.cfg,spawns=live.spawns||undefined,acts=live.actions.slice(),endTick=live.endTick;const practice=live.mode==='academy'||live.mode==='showcase'; // practice runs are never saved or synced
  const E=runSim(cfg,{actions:acts,until:endTick,spawns});
  const X=runSim(cfg,{policy:expertPolicy,until:Math.max(endTick,T(60)),stopWhenDone:!live.doneFn,spawns});
  const sc=scoreRun(E),scX=scoreRun(X);const total=runTotal(sc),totalX=runTotal(scX),totalLive=runTotal(scoreRun(L));
  const thr=new Array(12).fill(0);E.contacts.filter(c=>TYPES[c.type].hostile).forEach(c=>thr[sectorOf(c.brg0)]++);
  const at=live.attn.reduce((a,b)=>a+b,0);const attn=live.attn.map(v=>at?v/at:1/12);
  const jamNoRF=sc.filter(s=>s.src===s.c&&s.e0&&s.e0.eff==='jam'&&!TYPES[s.c.type].rfOn).length;
  const cal=calStats(sc),obs=observe(E,sc);const before=mastery(DB.H);
  const prev=DB.H[DB.H.length-1];
  const rec:any={n:DB.H.length+1,demo:false,date:Date.now(),cfg,total,obs,attn,thr,cal,cls:classificationStats(sc,C),jamNoRF,endTick,mode:live.mode,template:live.template};
  if(!practice){DB.H.push(rec);saveDB();}
  R={cfg,spawns,acts,E,X,sc,scX,total,totalX,verified:total===totalLive,before,after:practice?before:mastery(DB.H),thr,attn,cal,endTick,prevTotal:prev?prev.total:null,labels:{...live.labels},mode:live.mode,lesson:live.lesson,template:live.template,rec,server:null};
  if(!practice){plan=planNext(DB.H);if(hooks.syncDrill)hooks.syncDrill(rec,R);}
  setPhase('learn');renderLearn();emit('finish',R);
}
function bestCall(type){const Ty=TYPES[type];if(Ty.friendly)return 'hold fire';if(!Ty.hostile)return 'hold, no effector';const cls=decisionClass(Ty);return EFF[C.doctrine.defeat.preferred[cls]].label+(cls==='gnssOnly'?' (or interceptor)':'');}
function labelOf(c){if(R.labels[c.id])return R.labels[c.id];if(c.area&&R.labels[c.areaFrom])return R.labels[c.areaFrom]+'+';return 'Missed';}
function renderLearn(){
  const c=R.cfg;const conds=[c.time==='night'?'Night':'Day',cap(c.terrain)];if(c.fault!=='none')conds.push(FAULT_LABEL[c.fault]);if((c.weather||'clear')!=='clear')conds.push(WEATHER_LABEL[c.weather]);if(c.pattern==='swarm')conds.push('Swarm');
  const pass=R.total>=CERT.passMark;const hostiles=R.E.contacts.filter(x=>TYPES[x.type].hostile);const stopped=hostiles.filter(x=>x.state==='neutralised').length;
  $('#scoreCard').innerHTML=`<div class="kicker">Drill ${String(c.drill).padStart(2,'0')} · ${conds.join(', ')}</div><div class="scoreBig"><b class="num">${R.total}</b><span>/ 100</span></div>
   <div class="verdict ${pass?'yes':'no'}">${pass?'Certified for these conditions':'Not yet certified for these conditions'} · pass mark ${CERT.passMark}</div>
   <div class="cmp"><div>Expert ghost<b class="num">${R.totalX}</b></div><div>Last drill<b class="num">${R.prevTotal==null?'—':`${R.total-R.prevTotal>=0?'+':''}${R.total-R.prevTotal}`}</b></div><div>Hostiles stopped<b class="num">${stopped} / ${hostiles.length}</b></div></div>`;
  // lessons
  const losses=R.sc.map(s=>{const lD=30-s.D,lC=30-s.C,lF=40-s.F;return{s,loss:100-s.total,lD,lC,lF};}).sort((a,b)=>b.loss-a.loss);
  const les=losses.filter(x=>x.loss>8).slice(0,3).map(({s,lD,lC,lF})=>{
    const Ty=TYPES[s.c.type],lab=labelOf(s.c);
    if(s.missed)return{h:`${lab === 'Missed'?'A hostile':lab} was never tracked`,p:`A ${Ty.label.toLowerCase()} came from the ${windOf(s.c.brg0)} and ${s.c.state==='leaked'?'reached the asset':'was never challenged'}.`,r:'R8'};
    if(lC>=lD&&lC>=lF&&s.src.idCls&&s.src.idCls!==s.c.type)return{h:`${lab}: called it a ${TYPES[s.src.idCls].short.toLowerCase()}; it was a ${Ty.label.toLowerCase()}`,p:`You said ${confLabel(s.src.idConf)}. The deciding clue: ${TYPES[s.c.type].deciding}.`,r:'C1'};
    if(lD>=lF)return{h:`${lab}: ${s.det.toFixed(1)} s to start the track`,p:`It was on radar for ${s.det.toFixed(1)} s before you tracked it. Full marks need under 3 s.`,r:'D1'};
    const rr=s.rules.filter(x=>x[0]==='R');return{h:`${lab}: ${s.why[0]}`,p:`Right first call for a ${Ty.label.toLowerCase()}: ${bestCall(s.c.type)}.${s.why.length>1?' '+s.why.slice(1).join('. ')+'.':''}`,r:rr[rr.length-1]||'R3'};
  });
  while(les.length<3)les.push({h:'Clean decision',p:'No major point loss here. Keep the same habit.',r:'—'});
  $('#lessons').innerHTML=les.map((l,i)=>`<div class="lesson"><div class="ln">${i+1}</div><h4>${l.h}</h4><p>${l.p}</p>${l.r!=='—'?`<span class="rule" title="${RULES[l.r]||''}">Rule ${l.r}</span>`:''}</div>`).join('');
  // replay + tape
  const sl=$('#scrub');sl.max=R.endTick;sl.value=Math.min(R.endTick,T(40));replay.tick=+sl.value;replay.playing=false;$('#playBtn').textContent='▶';
  renderTape();drawReplay();
  // analytics
  renderCal();renderAtt();
  $('#fpSvg').innerHTML=radarChart(R.after,R.before);
  const diffs=SKILLS.map(([k,l])=>[l,R.after[k]-R.before[k],R.after[k]]).sort((a,b)=>b[1]-a[1]);const weakest=SKILLS.map(([k,l])=>[l,R.after[k]]).sort((a,b)=>a[1]-b[1])[0];
  $('#fpCap').innerHTML=`Biggest gain: <b>${diffs[0][0]}</b> (${diffs[0][1]>=0?'+':''}${Math.round(diffs[0][1]*100)} pts). Weakest now: <b>${weakest[0]}</b> (${Math.round(weakest[1]*100)}%). Dashed = before this drill.`;
  // audit
  $('#audit').innerHTML=`<tr><th>Track</th><th>Truth</th><th>You said</th><th>You did</th><th style="text-align:right">Detect</th><th style="text-align:right">Identify</th><th style="text-align:right">Defeat</th><th style="text-align:right">Total</th><th>Rules</th><th>Why</th></tr>`+
    R.sc.map(s=>{const Ty=TYPES[s.c.type];const said=s.src.idCls?`${TYPES[s.src.idCls].short} · ${confLabel(s.src.idConf)}`:'—';const did=s.e0?(s.e0.eff==='hold'?'Hold':EFF[s.e0.eff].label):'—';const cl=v=>v>=75?'good':v>=50?'mid':'bad';
      return `<tr><td><b>${labelOf(s.c)}</b></td><td>${Ty.label}</td><td class="${s.src.idCls&&s.src.idCls!==s.c.type?'bad':''}">${said}</td><td>${did}${s.src!==s.c||s.c.areaCredit?' (area)':''}</td><td class="n">${s.D}</td><td class="n">${s.C}</td><td class="n">${s.F}</td><td class="n ${cl(s.total)}">${s.total}</td><td>${s.rules.map(r=>`<span class="chip" title="${RULES[r]}">${r}</span>`).join('')}</td><td>${s.why.join('. ')}</td></tr>`;}).join('');
  $('#integrity').innerHTML=`<span>Record: <b>${R.acts.length} decisions</b></span><span>Deterministic replay: <b class="${R.verified?'good':'bad'}">${R.verified?'verified, same score on re-run':'mismatch'}</b></span><span id="hashOut">SHA-256 chain: computing…</span>`;
  chainHash(R.acts).then(h=>{$('#hashOut').innerHTML=`SHA-256 chain: <b>${h.slice(0,10)}…${h.slice(-6)}</b> (each decision is linked to the one before)`;});
  $('#nextText').innerHTML=`It noticed: ${plan.lines.map(l=>l.b.replace(/\.$/,'')).slice(0,2).join('; ')}. <b>Drill ${String(plan.cfg.drill).padStart(2,'0')} will test ${plan.tests.join(', ')}.</b>`;
  renderUnit();
  emit('learn',R);
}
function renderTape(){
  const lanes=R.sc.slice().sort((a,b)=>a.c.born-b.c.born);const endS=R.endTick*DT;const x0=150,x1=920,W=1000;const X=t=>x0+(t/endS)*(x1-x0);const H=34+lanes.length*34+28;
  const ghost=id=>R.X.contacts.find(o=>o.id===id);
  let s=`<svg class="tapeSvg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Drill tape">`;
  for(let t=0;t<=endS;t+=30){s+=`<line x1="${X(t)}" y1="20" x2="${X(t)}" y2="${H-22}" stroke="#D2D9CD"/><text x="${X(t)}" y="${H-6}" text-anchor="middle" font-family="Barlow Condensed, DejaVu Sans Condensed, sans-serif" font-size="13" fill="#78867D">${fmt(t)}</text>`;}
  lanes.forEach((sl,i)=>{const c=sl.c,y=36+i*34,Ty=TYPES[c.type],col=Ty.friendly?'#1C5BA3':Ty.hostile?'#B3122A':'#2B7746';const g=ghost(c.id);
    const end=(c.endTick??R.endTick)*DT;s+=`<text x="12" y="${y+5}" font-family="Barlow Condensed, DejaVu Sans Condensed, sans-serif" font-size="15" font-weight="600" fill="#18231D">${labelOf(c)}</text><text x="56" y="${y+5}" font-family="Barlow Condensed, DejaVu Sans Condensed, sans-serif" font-size="13" fill="${col}">${Ty.short}</text>`;
    s+=`<line x1="${X(c.born*DT)}" y1="${y}" x2="${X(end)}" y2="${y}" stroke="#B9C3B4" stroke-width="2"/>`;
    const src=sl.src;if(src.trackTick!=null&&src===c)s+=`<line x1="${X(src.trackTick*DT)}" y1="${y}" x2="${X(end)}" y2="${y}" stroke="${col}" stroke-width="4" opacity=".35"/>`;
    const dia=(t,fill)=>`<path d="M${X(t)} ${y-7} ${X(t)+7} ${y} ${X(t)} ${y+7} ${X(t)-7} ${y}Z" fill="${fill?'#18231D':'none'}" stroke="#18231D" stroke-width="1.5"/>`;
    const tri=(t,fill,lab)=>`<path d="M${X(t)} ${y-9} ${X(t)+7} ${y+4} ${X(t)-7} ${y+4}Z" fill="${fill?col:'none'}" stroke="${col}" stroke-width="1.5"/>${lab?`<text x="${X(t)}" y="${y+17}" text-anchor="middle" font-family="Barlow Condensed, DejaVu Sans Condensed, sans-serif" font-size="11" font-weight="700" fill="${col}">${lab}</text>`:''}`;
    if(g){if(g.trackTick!=null)s+=dia(g.trackTick*DT,false);if(g.idTick!=null)s+=`<circle cx="${X(g.idTick*DT)}" cy="${y}" r="6" fill="none" stroke="#46554C" stroke-width="1.5" stroke-dasharray="2 2"/>`;if(g.engs[0])s+=tri(g.engs[0].tick*DT,false,'');}
    if(src===c&&c.trackTick!=null)s+=dia(c.trackTick*DT,true);
    if(src===c&&c.idTick!=null){const ok=c.idCls===c.type;s+=`<circle cx="${X(c.idTick*DT)}" cy="${y}" r="${3+c.idConf*4.5}" fill="${ok?'#2B7746':'#B3122A'}"/>`;}
    if(src===c)c.engs.forEach((e,j)=>{s+=tri(e.tick*DT,!e.miss,e.eff==='hold'?'H':EFF[e.eff].key+(e.miss?'✕':''));});
    const out=sl.missed?'Missed':c.state==='neutralised'?'Stopped':c.state==='leaked'?'Leaked':Ty.hostile?'Live':'Held';
    let delta='';if(g&&g.engs[0]&&src.engs[0]&&src===c){const dd=(src.engs[0].tick-g.engs[0].tick)*DT;delta=`${dd>=0?'+':''}${dd.toFixed(1)} s`;}
    s+=`<text x="${x1+12}" y="${y-1}" font-family="Barlow Condensed, DejaVu Sans Condensed, sans-serif" font-size="13" font-weight="600" fill="${out==='Leaked'||out==='Missed'?'#B3122A':'#18231D'}">${out}</text>${delta?`<text x="${x1+12}" y="${y+13}" font-family="Barlow Condensed, DejaVu Sans Condensed, sans-serif" font-size="11.5" fill="${parseFloat(delta)>3?'#B3122A':'#78867D'}">${delta} vs ghost</text>`:''}`;});
  s+=`<line id="playhead" x1="${X(replay.tick*DT)}" y1="16" x2="${X(replay.tick*DT)}" y2="${H-22}" stroke="#18231D" stroke-width="1.5" stroke-dasharray="3 3"/></svg>`;
  $('#tape').innerHTML=s;$('#tapeSub').textContent=`${lanes.length} contacts · ${fmt(endS)} · outlines show the expert ghost on the same seed`;
  R.tapeX=X;
}
function drawReplay(){
  const cv=$('#replay'),ctx=cv.getContext('2d'),W=cv.width,H=cv.height;
  const E=runSim(R.cfg,{actions:R.acts,until:replay.tick,spawns:R.spawns}),G=runSim(R.cfg,{policy:expertPolicy,until:replay.tick,spawns:R.spawns});
  const {cx,cy,s}=drawPaper(ctx,W,H,R.cfg,{rad:W*0.44});
  const P=(x,y)=>[cx+x*s,cy+y*s];
  for(const g of G.contacts){if(g.state!=='live')continue;const Ty=TYPES[g.type];const kind=Ty.friendly?'friend':Ty.hostile?'hostile':'neutral';const [px,py]=P(g.x,g.y);ctx.strokeStyle='rgba(24,35,29,0.55)';ctx.lineWidth=1.5;ctx.setLineDash([3,3]);symPath(ctx,px,py,kind,10);ctx.stroke();ctx.setLineDash([]);}
  for(const c of E.contacts){const Ty=TYPES[c.type];const kind=Ty.friendly?'friend':Ty.hostile?'hostile':'neutral';const col=Ty.friendly?cssv('--blue'):Ty.hostile?cssv('--red'):cssv('--green');const [px,py]=P(c.x,c.y);
    if(c.state==='neutralised'){if(replay.tick-c.endTick<T(4)){ctx.strokeStyle=cssv('--green');ctx.lineWidth=2.5;ctx.beginPath();ctx.moveTo(px-9,py-9);ctx.lineTo(px+9,py+9);ctx.moveTo(px+9,py-9);ctx.lineTo(px-9,py+9);ctx.stroke();}continue;}
    if(c.state==='leaked'){ctx.strokeStyle=cssv('--red');ctx.lineWidth=3;ctx.beginPath();ctx.arc(cx,cy,24,0,7);ctx.stroke();continue;}
    ctx.fillStyle=col;ctx.strokeStyle=col;ctx.lineWidth=2;symPath(ctx,px,py,kind,8);ctx.globalAlpha=0.85;ctx.fill();ctx.globalAlpha=1;ctx.stroke();
    if(R.labels[c.id]){ctx.fillStyle=cssv('--ink');ctx.font=`600 16px ${cssv('--cond')}`;ctx.fillText(R.labels[c.id],px+12,py-10);}
    if(c.effectAt!=null){ctx.strokeStyle=cssv(EFF[c.effectBy].color);ctx.lineWidth=2;ctx.setLineDash([5,4]);ctx.beginPath();ctx.moveTo(cx,cy);ctx.lineTo(px,py);ctx.stroke();ctx.setLineDash([]);}}
  $('#scrubT').textContent=fmt(replay.tick*DT);
  const ph=$('#playhead');if(ph&&R.tapeX){const x=R.tapeX(replay.tick*DT);ph.setAttribute('x1',x);ph.setAttribute('x2',x);}
}
$('#scrub').addEventListener('input',e=>{replay.tick=+e.target.value;drawReplay();});
$('#playBtn').onclick=()=>{replay.playing=!replay.playing;if(replay.playing&&replay.tick>=R.endTick)replay.tick=0;$('#playBtn').textContent=replay.playing?'❚❚':'▶';};
let rpAcc=0;function tickReplay(dt){rpAcc+=dt*4;const n=Math.floor(rpAcc/DT);if(!n)return;rpAcc-=n*DT;replay.tick=Math.min(R.endTick,replay.tick+n);$('#scrub').value=replay.tick;drawReplay();if(replay.tick>=R.endTick){replay.playing=false;$('#playBtn').textContent='▶';}}
function renderCal(){
  const hist=sumCal(DB.H.slice(-6));const W=360,H=230,x0=44,y0=20,h=160,bw=60;const Y=v=>y0+h*(1-v);
  let s=`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Calibration">`;
  for(const v of [0,0.25,0.5,0.75,1])s+=`<line x1="${x0}" x2="${W-10}" y1="${Y(v)}" y2="${Y(v)}" stroke="#D2D9CD"/><text x="${x0-6}" y="${Y(v)+4}" text-anchor="end" font-family="Barlow Condensed, DejaVu Sans Condensed, sans-serif" font-size="12" fill="#78867D">${v*100}%</text>`;
  let worst=null;
  CONF.forEach((c,i)=>{const [n,ok]=hist[c.k];const x=x0+30+i*((W-x0-40)/3);const acc=n?ok/n:0;
    if(n)s+=`<rect x="${x}" y="${Y(acc)}" width="${bw}" height="${h*acc}" fill="${acc<c.p-0.15?'#B3122A':'#18231D'}" opacity=".85"/>`;
    s+=`<line x1="${x-8}" x2="${x+bw+8}" y1="${Y(c.p)}" y2="${Y(c.p)}" stroke="#AD8304" stroke-width="2.5" stroke-dasharray="5 3"/>`;
    s+=`<text x="${x+bw/2}" y="${y0+h+18}" text-anchor="middle" font-family="Barlow Condensed, DejaVu Sans Condensed, sans-serif" font-size="14" font-weight="600" fill="#18231D">${c.label}</text><text x="${x+bw/2}" y="${y0+h+32}" text-anchor="middle" font-family="Barlow Condensed, DejaVu Sans Condensed, sans-serif" font-size="12" fill="#78867D">${n?`${Math.round(acc*100)}% right · n=${n}`:'no calls'}</text>`;
    if(n&&(!worst||c.p-acc>worst.gap))worst={c,acc,gap:c.p-acc};});
  $('#calSvg').innerHTML=s+'</svg>';
  $('#calCap').innerHTML=worst&&worst.gap>0.1?`When you said <b>${worst.c.label}</b> you were right <b>${Math.round(worst.acc*100)}%</b> of the time; it should be about ${Math.round(worst.c.p*100)}%. <b>You are over-confident</b> there. Gold dashes = what each word should mean.`:`Your confidence matches your accuracy. Gold dashes = what each word should mean.`;
}
function renderAtt(){
  const W=320,H=270,cx=W/2,cy=H/2+4,R0a=46,R1=104;const mx=Math.max(...R.attn,0.01);
  let s=`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Attention by sector">`;
  s+=`<circle cx="${cx}" cy="${cy}" r="${R1}" fill="none" stroke="#B9C3B4"/><circle cx="${cx}" cy="${cy}" r="${R0a}" fill="none" stroke="#D2D9CD"/>`;
  let neg=null;
  R.attn.forEach((v,i)=>{const a0=(i*30-90)*Math.PI/180,a1=((i+1)*30-90)*Math.PI/180;const rr=R0a+(R1-R0a)*(v/mx);const bad=R.thr[i]>0&&v<0.05;
    if(bad&&(!neg||R.thr[i]>R.thr[neg.i]))neg={i,v};
    s+=`<path d="M${cx+Math.cos(a0)*R0a} ${cy+Math.sin(a0)*R0a} L${cx+Math.cos(a0)*rr} ${cy+Math.sin(a0)*rr} A${rr} ${rr} 0 0 1 ${cx+Math.cos(a1)*rr} ${cy+Math.sin(a1)*rr} L${cx+Math.cos(a1)*R0a} ${cy+Math.sin(a1)*R0a} A${R0a} ${R0a} 0 0 0 ${cx+Math.cos(a0)*R0a} ${cy+Math.sin(a0)*R0a}Z" fill="${bad?'rgba(179,18,42,0.18)':'rgba(24,35,29,0.16)'}" stroke="${bad?'#B3122A':'#46554C'}" stroke-width="${bad?1.6:0.8}"/>`;
    for(let k=0;k<R.thr[i];k++){const am=((i*30+15+(k-(R.thr[i]-1)/2)*7)-90)*Math.PI/180;const tx=cx+Math.cos(am)*(R1+11),ty=cy+Math.sin(am)*(R1+11);s+=`<path d="M${tx} ${ty-5} ${tx+5} ${ty+4} ${tx-5} ${ty+4}Z" fill="#B3122A"/>`;}});
  ([['N',0],['E',90],['S',180],['W',270]] as [string,number][]).forEach(([l,d])=>{const a=(d-90)*Math.PI/180;s+=`<text x="${cx+Math.cos(a)*(R1+26)}" y="${cy+Math.sin(a)*(R1+26)+4}" text-anchor="middle" font-family="Barlow Condensed, DejaVu Sans Condensed, sans-serif" font-size="13" font-weight="600" fill="#46554C">${l}</text>`;});
  s+=`<text x="${cx}" y="${cy+4}" text-anchor="middle" font-family="Barlow Condensed, DejaVu Sans Condensed, sans-serif" font-size="12" fill="#78867D">asset</text>`;
  $('#attSvg').innerHTML=s+'</svg>';
  const topT=R.thr.indexOf(Math.max(...R.thr));
  $('#attCap').innerHTML=neg?`<b>${R.thr[neg.i]} threat${R.thr[neg.i]>1?'s':''}</b> came from the <b>${windOf(neg.i*30+15)}</b>, but it got only <b>${Math.round(neg.v*100)}%</b> of your attention. Red triangles = where threats came from.`:`Most threats came from the <b>${windOf(topT*30+15)}</b>, and your attention followed them. Red triangles = where threats came from.`;
}
$$('.learnTabs button').forEach(b=>b.onclick=()=>{$$('.learnTabs button').forEach(x=>x.classList.toggle('on',x===b));$('#tabDrill').style.display=b.dataset.t==='drill'?'':'none';$('#tabUnit').style.display=b.dataset.t==='unit'?'':'none';});
$('#nextBtn').onclick=()=>goNext();
function goNext(){if(hooks.next&&hooks.next())return;renderBrief();setPhase('brief');}

// ===================== unit readiness board =====================
const OPS=[{n:'Sep Vikram Singh',v:{detect:.91,identify:.88,defeat:.86,night:.87,swarm:.72,degraded:.81,weather:0.79,roe:0.84}},{n:'Sep Imran Khan',v:{detect:.86,identify:.9,defeat:.92,night:.9,swarm:.88,degraded:.86,weather:0.83,roe:0.9}},{n:'L/Nk Deepak Thapa',v:{detect:.86,identify:.74,defeat:.7,night:.61,swarm:.55,degraded:.66,weather:0.57,roe:0.62}},{n:'Sep Rahul Yadav',v:{detect:.93,identify:.89,defeat:.9,night:.86,swarm:.9,degraded:.58,weather:0.84,roe:0.88}},{n:'Sep Kiran Patil',v:{detect:.71,identify:.66,defeat:.62,night:.48,swarm:.4,degraded:.52,weather:0.45,roe:0.47}},{n:'Nk Suresh Nair',v:{detect:.89,identify:.92,defeat:.87,night:.91,swarm:.86,degraded:.88,weather:0.82,roe:0.86}}];
const BCOLS=[['detect','Detection'],['identify','Identification'],['defeat','Defeat'],['night','Night'],['swarm','Swarm'],['degraded','Faulty sensors'],['weather','Bad weather'],['roe','ROE']];
const roster=new Set(['night','swarm']);
function renderUnit(){
  const me={n:TRAINEE.name+' (you)',v:mastery(DB.H),me:true};const all: any[]=hooks.operators?hooks.operators():[me,...OPS];
  const stc=v=>v>=CERT.certifiedMastery?'st3':v>=CERT.developingMastery?'st2':'st1';
  $('#board').innerHTML=`<tr><th>Operator</th>${BCOLS.map(([,l])=>`<th>${l}</th>`).join('')}<th>Overall</th></tr>`+all.map(o=>{const ov=avg(BCOLS.map(([k])=>(o.v[k]??0)));return `<tr class="${o.me?'me':''}"><td>${o.n}</td>${BCOLS.map(([k])=>`<td class="${stc((o.v[k]??0))} num">${Math.round((o.v[k]??0)*100)}</td>`).join('')}<td class="${stc(ov)} num">${Math.round(ov*100)}</td></tr>`;}).join('');
  $('#rosterSeg').innerHTML=[['night','Night'],['swarm','Swarm'],['degraded','Faulty sensors'],['weather','Bad weather']].map(([k,l])=>`<button data-k="${k}" class="${roster.has(k)?'on':''}">${l}</button>`).join('');
  const need=[...roster];const scored=all.map(o=>({o,min:need.length?Math.min(...need.map(k=>o.v[k]??0)):avg(BCOLS.map(([k])=>o.v[k]))})).sort((a,b)=>b.min-a.min);const ready=scored.filter(x=>x.min>=CERT.certifiedMastery);
  $('#rosterAns').innerHTML=`<div class="kicker">Ready for ${need.length?need.map(k=>({night:'night',swarm:'swarm',degraded:'faulty sensors',weather:'bad weather'}[k])).join(' + '):'any task'}</div><div class="bigAns">${ready.length} of ${all.length}</div>`;
  $('#rlist').innerHTML=scored.map(x=>`<div class="ritem ${x.min>=CERT.certifiedMastery?'ok':''}"><span>${x.o.n}</span><em class="num">${x.min>=CERT.certifiedMastery?'Ready':'Not yet'} · ${Math.round(x.min*100)}%</em></div>`).join('');
}
// Drill history as CSV for after-action review. Online: the server's verified records (scoped by role); offline: this browser's history.
$('#csvBtn').addEventListener('click',()=>{
  if(hooks.exportCsv)return hooks.exportCsv();
  const blob=new Blob([drillsToCsv(DB.H.map(r=>({operator:TRAINEE.name,unit:TRAINEE.unit,record:r})),CERT.passMark)],{type:'text/csv'});
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='parashurama-drills.csv';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);
});
$('#rosterSeg').addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;const k=b.dataset.k;roster.has(k)?roster.delete(k):roster.add(k);renderUnit();});

// ===================== guided tour =====================
const TOUR=[
  {p:'brief',sel:null,t:'Welcome to PARASHURAMA',x:'A counter-drone decision trainer. Every drill runs in three steps: <b>Brief</b>, <b>Fight</b>, <b>Learn</b>. This tour takes about a minute, and you can end it any time.'},
  {p:'brief',sel:'#mapCard',t:'The sand table',x:'Your protected asset, sensor cover and weapon reach. Red dashed arrows are the intel estimate of where threats may come from. A hatched sector is a sensor fault.'},
  {p:'brief',sel:'#intentCard',t:'The enemy studies you',x:'Every drill is built from your past mistakes. Here the enemy tells you which habits it will exploit.'},
  {p:'brief',sel:'#fingerCard',t:'Your skill fingerprint',x:'A learning model estimates how well you have mastered each skill. It updates after every drill.'},
  {p:'brief',sel:'#beginBtn',t:'Begin the drill',x:'Press <kbd>Enter</kbd> or this button. The tour continues inside the drill, which stays paused until the tour moves on.',next:'Begin',go:()=>{if(hooks.tourBegin)hooks.tourBegin();else startDrill(true);}},
  {p:'fight',sel:'#radarWrap',t:'Night console',x:'Yellow dots are unknown radar contacts. <b>Click one to start a track.</b> The dashed rings show where your jammer and gun can reach.'},
  {p:'fight',sel:'#contactsPanel',t:'Contacts and decision windows',x:'Tracked contacts, most urgent first. The coloured bars show when each weapon can reach it in the next 60 seconds. The red tick is impact.'},
  {p:'fight',sel:'#cluePanel',t:'Clues arrive over time',x:'Radar, friendly check, radio signal, behaviour and camera. Waiting costs time; guessing costs points. Decide when you are sure enough.'},
  {p:'fight',sel:'#idStep',t:'Identify, with confidence',x:'Pick what it is (<kbd>1</kbd>–<kbd>6</kbd>) and how sure you are (<kbd>Q</kbd> <kbd>W</kbd> <kbd>E</kbd>). Right and Certain scores most; wrong and Certain scores almost nothing.'},
  {p:'fight',sel:'#defStep',t:'Decide and defeat',x:'Only weapons in reach are live (<kbd>J</kbd> <kbd>S</kbd> <kbd>I</kbd> <kbd>G</kbd>). Friendly or bird? <b>Hold</b> (<kbd>H</kbd>). The tour picks up again in the debrief.',next:'Start the drill'},
  {p:'learn',sel:'#scoreCard',t:'Your result',x:'Your score against the pass mark for these conditions, against the expert ghost, and against your last drill.'},
  {p:'learn',sel:'#tapeCard',t:'The drill tape',x:'Every decision on one timeline. Outlines show what the expert ghost did on the exact same drill. Drag the replay slider to watch any moment.'},
  {p:'learn',sel:'#calCard',t:'Analytics that coach',x:'Are you over-confident? Which sector did you ignore? Which skills moved? Every point in the audit below cites a doctrine rule.'},
  {p:'learn',sel:'#nextCard',t:'The loop',x:'The enemy has already adapted to this drill. Press <b>Next drill</b> to face it. That is the end of the tour.',next:'Finish'},
];
const tour={on:false,i:0};
function tourBlocking(){return tour.on&&TOUR[tour.i]&&TOUR[tour.i].p===phase;}
function startTour(i){tour.on=true;tour.i=i;showTour();}
function endTour(){tour.on=false;DB.tourDone=true;saveDB();$('#tour').classList.remove('on');}
function showTour(){
  const ordP=['brief','fight','learn'];
  if(tour.on&&TOUR[tour.i]&&ordP.indexOf(TOUR[tour.i].p)<ordP.indexOf(phase)){const j=TOUR.findIndex(x=>x.p===phase);if(j>=0)tour.i=j;}
  const st=TOUR[tour.i];if(!tour.on||!st){$('#tour').classList.remove('on');return;}
  if(st.p!==phase){$('#tour').classList.remove('on');return;}
  $('#tour').classList.add('on');
  const same=TOUR.filter(x=>x.p===st.p),k=same.indexOf(st);
  $('#tourN').textContent=`${cap(st.p)} · ${k+1} of ${same.length}`;$('#tourT').textContent=st.t;$('#tourP').innerHTML=st.x;
  $('#tourDots').innerHTML=same.map((_,j)=>`<i class="${j===k?'on':''}"></i>`).join('');
  $('#tourNext').textContent=st.next||'Next';
  requestAnimationFrame(placeTour);
}
function placeTour(){
  const st=TOUR[tour.i];if(!st)return;const hole=$('#tourHole'),card=$('#tourCard');const cw=360,ch=card.offsetHeight||190,m=16;
  if(!st.sel){hole.classList.add('none');card.style.left=(innerWidth-cw)/2+'px';card.style.top=(innerHeight-ch)/2+'px';return;}
  const el=$(st.sel);if(!el)return;el.scrollIntoView({block:'nearest'});const r=el.getBoundingClientRect();hole.classList.remove('none');
  Object.assign(hole.style,{left:r.left-6+'px',top:r.top-6+'px',width:r.width+12+'px',height:r.height+12+'px'});
  let x,y;if(r.right+m+cw<innerWidth){x=r.right+m;y=r.top;}else if(r.left-m-cw>0){x=r.left-m-cw;y=r.top;}else{x=clamp(r.left,m,innerWidth-cw-m);y=r.bottom+m+ch<innerHeight?r.bottom+m:Math.max(m,r.top-m-ch);}
  card.style.left=clamp(x,m,innerWidth-cw-m)+'px';card.style.top=clamp(y,m,innerHeight-ch-m)+'px';
}
$('#tourEnd').onclick=()=>endTour();
$('#tourNext').onclick=()=>{const st=TOUR[tour.i];tour.i++;if(tour.i>=TOUR.length){endTour();return;}if(st.go)st.go();showTour();};
$('#helpBtn').onclick=()=>{const i=TOUR.findIndex(x=>x.p===phase);startTour(i<0?0:i);};
addEventListener('resize',()=>{if(phase==='fight')sizeRadar();if(tour.on)placeTour();});

// ===================== phases, keyboard, boot =====================
function setPhase(p){
  phase=p;$$('.phase').forEach(s=>s.classList.toggle('on',s.id===p));document.body.classList.toggle('night',p==='fight');
  const ord=['brief','fight','learn'];$$('.phases li').forEach(li=>{const i=ord.indexOf(li.dataset.p),j=ord.indexOf(p);li.classList.toggle('on',i===j);li.classList.toggle('done',i<j);});
  window.scrollTo(0,0);if(p==='fight')requestAnimationFrame(sizeRadar);
  if(tour.on)setTimeout(showTour,60);
}
addEventListener('keydown',e=>{
  if(tour.on&&$('#tour').classList.contains('on')){if(e.key==='Escape')endTour();else if(e.key==='Enter'){e.preventDefault();$('#tourNext').click();}return;}
  if(phase==='brief'&&e.key==='Enter'){e.preventDefault();startDrill(false);return;}
  if(phase==='learn'&&e.key==='Enter'){e.preventDefault();goNext();return;}
  if(phase!=='fight'||!L)return;
  const k=e.key.toLowerCase();
  if(e.key===' '){e.preventDefault();togglePause();return;}
  if(e.key==='Tab'){e.preventDefault();const lst=L.contacts.filter(c=>c.state==='live'&&(c.trackTick!=null||(live.did[c.id]||{}).track)).sort((a,b)=>tti(a)-tti(b));if(lst.length){const i=lst.findIndex(c=>c.id===live.sel);select(lst[(i+1)%lst.length].id);}return;}
  const c=selC();if(!c)return;const identified=c.idCls||(live.did[c.id]||{}).id;
  if(!identified){if(k>='0'&&k<='9'&&ORDER[(+k+9)%10]){live.pick.cls=ORDER[(+k+9)%10];live.sig='';renderRail();return;}const cf=CONF.find(x=>x.key.toLowerCase()===k);if(cf){live.pick.conf=cf.p;live.sig='';renderRail();return;}if(e.key==='Enter'){commitId();return;}}
  else{const ef=EFF_ORDER.find(x=>EFF[x].key.toLowerCase()===k);if(ef){engageSel(ef);return;}if(k==='c'){reqSel();return;}if(k==='h')engageSel('hold');}
});
$('#beginBtn').onclick=()=>{if(tour.on&&TOUR[tour.i].p==='brief'){tour.i=TOUR.findIndex(x=>x.p==='fight');if(hooks.tourBegin)hooks.tourBegin();else startDrill(true);}else startDrill(false);};

// ---- scripted trainee, used for the walkthrough video and screenshots ----
function botActs(skipRecentSec=0){
  for(const c of L.contacts){if(c.state!=='live')continue;const d=live.did[c.id]||{};
    if(c.trackTick==null&&!d.track){if(c.firstPaint!=null&&!c.area&&c.effectAt==null&&visibleBlip(L,c)&&L.tick>=c.firstPaint+T(1.5+(c.id%5)*0.9))doTrack(c);continue;}
    if(c.trackTick==null)continue;
    if(skipRecentSec&&L.tick-c.trackTick<T(skipRecentSec))continue;
    if(c.idTick==null&&!d.id){if(L.tick>=c.trackTick+T(3+(c.id%3)*1.5)){let cls=c.type,conf=[0.8,0.95,0.6][c.id%3];if(c.type==='loiter'&&c.id%3===0){cls='recon';conf=0.95;}if(c.type==='bird'&&c.id%2===1){cls='swarm';conf=0.6;}doId(c,cls,conf);}continue;}
    if(c.idTick==null||c.effectAt!=null)continue;
    const Tb=TYPES[c.idCls];const last=c.engs[c.engs.length-1];
    if(!Tb.hostile){if(!c.engs.length)doEng(c,'hold');continue;}
    if(last&&L.tick<last.tick+T(4))continue;if(L.tick<c.idTick+T(2+(c.id%4)))continue;
    if(c.clrReq==null&&EFF_ORDER.some(k=>needsClearance(L,k))){if(!d.req)doReq(c);continue;}
    let want=Tb.rfOn?'jam':'spoof';if(last&&!last.effective)want=TYPES[c.type].gnss?'spoof':'intc';if(c.id%5===0&&inReach(c,'gun'))want='gun';
    if(availability(c,want).ok&&isCleared(L,c,want))doEng(c,want);
  }
}
(window as any).PARA={
  get plan(){return plan;},get R(){return R;},get L(){return L;},DB,live,setPhase,startDrill,endTour,finishDrill,
  playUntil(sec,skipRecent){if(!L)startDrill(false);live.paused=true;while(L.tick<T(sec)&&!isDone(L)){botActs(skipRecent);step(L,live.queue.splice(0));accumulate();}renderRail(true);},
  autoplay(){if(!L)startDrill(false);live.paused=true;let g=0;while(!isDone(L)&&g++<T(MAXT)){botActs();step(L,live.queue.splice(0));accumulate();}finishDrill();},
  select(id){select(id);},
  scrubTo(sec){replay.tick=Math.min(R.endTick,T(sec));$('#scrub').value=replay.tick;drawReplay();},
};
// If a lesson or drill already started from the hub before fonts loaded, don't send it back to the brief.
export function boot(){document.fonts.ready.then(()=>{if(!L){renderBrief();setPhase('brief');if(!DB.tourDone&&!hooks.holdTour)startTour(0);}requestAnimationFrame(frame);emit('boot');});}
/** Public surface for feature modules (academy, coach, audio, what-if, online, editor). */
export const app: any = {
  get L(){return L;}, get R(){return R;}, get plan(){return plan;}, set plan(p){plan=p;}, get phase(){return phase;},
  live, DB, saveDB, TRAINEE, OPS, replay, tour, TOUR,
  startDrill, setPhase, select, selC, renderRail, renderBrief, renderLearn, renderUnit, finishDrill, availability, windows, clueList,
  doTrack, doId, doEng, drawReplay, labelOf, startTour, togglePause, emit,
};
