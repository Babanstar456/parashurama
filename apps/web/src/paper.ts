import { mulberry, sectorOf, type DrillConfig, type Spawn } from '@parashurama/engine';
import { cssv } from './dom';
import { TYPES, EFF, RMAX, BASE } from './cfg';

// Sand-table (map paper) renderer, shared by the brief map and the debrief replay.
export function drawPaper(ctx: CanvasRenderingContext2D, W: number, H: number, cfg: DrillConfig, o: { rad?: number; axes?: Spawn[] } = {}) {
  const cx=W/2,cy=H/2,rad=o.rad||Math.min(W,H)/2*0.86,s=rad/RMAX,k=W/1000;
  const ink=cssv('--ink'),cond=cssv('--cond');
  ctx.save();ctx.fillStyle=cssv('--paper');ctx.fillRect(0,0,W,H);
  const r=mulberry(cfg.seed*3+(cfg.terrain==='urban'?1:2));
  if(cfg.terrain==='urban'){
    ctx.strokeStyle='rgba(24,35,29,0.10)';ctx.lineWidth=9*k;
    for(let i=0;i<5;i++){const a=r()*Math.PI;const ox=cx+(r()-0.5)*W*0.6,oy=cy+(r()-0.5)*H*0.6;ctx.beginPath();ctx.moveTo(ox-Math.cos(a)*W,oy-Math.sin(a)*W);ctx.lineTo(ox+Math.cos(a)*W,oy+Math.sin(a)*W);ctx.stroke();}
    for(let i=0;i<260;i++){const a=r()*6.283,d=Math.sqrt(r())*rad*1.2;const x=cx+Math.cos(a)*d,y=cy+Math.sin(a)*d,w=(6+r()*22)*k,h=(6+r()*16)*k;
      ctx.fillStyle='rgba(70,85,76,0.12)';ctx.fillRect(x,y,w,h);ctx.strokeStyle='rgba(24,35,29,0.20)';ctx.lineWidth=0.8*k;ctx.strokeRect(x,y,w,h);}
  }else{
    for(let i=0;i<34;i++){const x=r()*W,y=r()*H,w=(40+r()*90)*k,h=(30+r()*70)*k,a=(r()-0.5)*0.8;ctx.save();ctx.translate(x,y);ctx.rotate(a);
      ctx.fillStyle=i%3?'rgba(43,119,70,0.07)':'rgba(173,131,4,0.06)';ctx.fillRect(-w/2,-h/2,w,h);ctx.strokeStyle='rgba(24,35,29,0.12)';ctx.lineWidth=0.8*k;ctx.strokeRect(-w/2,-h/2,w,h);ctx.restore();}
    ctx.strokeStyle='rgba(124,153,172,0.55)';ctx.lineWidth=7*k;ctx.lineCap='round';ctx.beginPath();const y0=H*(0.2+r()*0.2);ctx.moveTo(-10,y0);ctx.bezierCurveTo(W*0.3,y0+H*0.35,W*0.6,y0-H*0.1,W+10,y0+H*(0.3+r()*0.2));ctx.stroke();
  }
  // contour lines
  for(let hI=0;hI<4;hI++){const hx=r()*W,hy=r()*H,base=(30+r()*30)*k,ph=r()*6,ps=r()*6;
    for(let i=1;i<=8;i++){ctx.beginPath();for(let t=0;t<=64;t++){const th=t/64*6.283;const rr=base*i*(1+0.13*Math.sin(3*th+ph)+0.08*Math.sin(5*th+ps));const x=hx+Math.cos(th)*rr,y=hy+Math.sin(th)*rr*0.8;t?ctx.lineTo(x,y):ctx.moveTo(x,y);}
      ctx.strokeStyle=`rgba(163,140,99,${i%4===0?0.55:0.3})`;ctx.lineWidth=(i%4===0?1.4:0.8)*k;ctx.stroke();}}
  // grid references
  const cell=W/8;ctx.strokeStyle='rgba(124,153,172,0.35)';ctx.lineWidth=1*k;ctx.font=`600 ${13*k}px ${cond}`;ctx.fillStyle='rgba(70,85,76,0.8)';
  for(let i=1;i<8;i++){ctx.beginPath();ctx.moveTo(i*cell,0);ctx.lineTo(i*cell,H);ctx.stroke();}
  for(let j=1;j*cell<H;j++){ctx.beginPath();ctx.moveTo(0,j*cell);ctx.lineTo(W,j*cell);ctx.stroke();}
  for(let i=0;i<8;i++)ctx.fillText(String.fromCharCode(65+i),i*cell+6*k,16*k);
  for(let j=0;j*cell<H;j++)ctx.fillText(String(j+1),6*k,j*cell+cell-8*k);
  // fault
  if(cfg.fault==='radar'){const a0=(cfg.faultSector-30-90)*Math.PI/180,a1=(cfg.faultSector+30-90)*Math.PI/180;
    ctx.save();ctx.beginPath();ctx.moveTo(cx,cy);ctx.arc(cx,cy,rad,a0,a1);ctx.closePath();ctx.clip();ctx.strokeStyle='rgba(173,131,4,0.55)';ctx.lineWidth=2*k;
    for(let d=-W;d<W;d+=14*k){ctx.beginPath();ctx.moveTo(cx+d,cy-W);ctx.lineTo(cx+d+W,cy+W*0);ctx.lineTo(cx+d+2*W,cy+W);ctx.stroke();}ctx.restore();
    const am=(cfg.faultSector-90)*Math.PI/180;ctx.fillStyle=cssv('--ochre');ctx.font=`700 ${15*k}px ${cond}`;ctx.textAlign='center';ctx.fillText('RADAR FAULT',cx+Math.cos(am)*rad*0.72,cy+Math.sin(am)*rad*0.72);ctx.textAlign='left';}
  else if(cfg.fault!=='none'){ctx.fillStyle=cssv('--ochre');ctx.font=`700 ${15*k}px ${cond}`;ctx.fillText(cfg.fault==='eo'?'CAMERA DEGRADED':'RF DETECTOR OFFLINE',W-200*k,H-18*k);}
  // weather: haze over the sand table and a label (training effect on sensors)
  const wx=cfg.weather||'clear';
  if(wx!=='clear'){const tint={rain:'rgba(90,120,160,0.10)',fog:'rgba(150,158,166,0.16)',dust:'rgba(176,134,80,0.13)'}[wx];ctx.fillStyle=tint;ctx.fillRect(0,0,W,H);
    const lbl={rain:'HEAVY RAIN · RADAR + CAMERA DEGRADED',fog:'DENSE FOG · CAMERA RANGE SHORT',dust:'DUST STORM · RADAR + CAMERA DEGRADED'}[wx];
    ctx.fillStyle=cssv('--ochre');ctx.font=`700 ${15*k}px ${cond}`;ctx.fillText(lbl,30*k,42*k);}
  // rings
  const ring=(R,col,dash,lw,label)=>{ctx.beginPath();ctx.setLineDash(dash.map(v=>v*k));ctx.strokeStyle=col;ctx.lineWidth=lw*k;ctx.arc(cx,cy,R*s,0,7);ctx.stroke();ctx.setLineDash([]);
    if(label){ctx.fillStyle=col;ctx.font=`600 ${12.5*k}px ${cond}`;ctx.fillText(label,cx+R*s*0.71+4*k,cy-R*s*0.71-4*k);}};
  ring(RMAX,ink,[7,5],1.4,'RADAR 3 KM');ring(EFF.jam.range,cssv('--jam'),[],1.6,'JAM 2 KM');ring(EFF.gun.range,cssv('--gun'),[],1.6,'GUN 1 KM');
  // asset
  ctx.fillStyle=cssv('--blue');ctx.fillRect(cx-8*k,cy-8*k,16*k,16*k);ctx.strokeStyle=cssv('--blue');ctx.lineWidth=1.5*k;ctx.setLineDash([4*k,3*k]);ctx.beginPath();ctx.arc(cx,cy,BASE*s+10*k,0,7);ctx.stroke();ctx.setLineDash([]);
  ctx.font=`700 ${13*k}px ${cond}`;ctx.fillText('PROTECTED ASSET',cx+16*k,cy+24*k);
  // axes (brief)
  if(o.axes){const cnt=new Array(12).fill(0),types: Record<number, Set<string>>={};for(const sp of o.axes){if(!TYPES[sp.type].hostile)continue;const si=sectorOf(sp.brg);cnt[si]++;(types[si]=types[si]||new Set()).add(sp.type);}
    const top=cnt.map((v,i)=>[v,i] as [number,number]).filter(x=>x[0]>0).sort((a,b)=>b[0]-a[0]).slice(0,3);const jr=mulberry(cfg.seed+99);
    top.forEach(([v,si],n)=>{const ang=(si*30+15+(jr()-0.5)*16-90)*Math.PI/180;const x0=cx+Math.cos(ang)*rad*1.04,y0=cy+Math.sin(ang)*rad*1.04,x1=cx+Math.cos(ang)*rad*0.55,y1=cy+Math.sin(ang)*rad*0.55;
      ctx.strokeStyle=cssv('--red');ctx.lineWidth=2.4*k;ctx.setLineDash([10*k,7*k]);ctx.beginPath();ctx.moveTo(x0,y0);ctx.lineTo(x1,y1);ctx.stroke();ctx.setLineDash([]);
      const hd=Math.atan2(y1-y0,x1-x0);ctx.fillStyle=cssv('--red');ctx.beginPath();ctx.moveTo(x1,y1);ctx.lineTo(x1-Math.cos(hd-0.4)*14*k,y1-Math.sin(hd-0.4)*14*k);ctx.lineTo(x1-Math.cos(hd+0.4)*14*k,y1-Math.sin(hd+0.4)*14*k);ctx.fill();
      const ts=types[si];const note=ts.has('swarm')?'swarm likely':ts.has('loiter')?'fast movers':'small drones';
      const lx=cx+Math.cos(ang)*rad*0.8,ly=cy+Math.sin(ang)*rad*0.8;ctx.font=`700 ${14*k}px ${cond}`;const lbl=`AXIS ${String.fromCharCode(65+n)} · ${note}`;const tw=ctx.measureText(lbl).width;
      ctx.fillStyle='rgba(226,230,219,0.9)';ctx.fillRect(lx-tw/2-5*k,ly-14*k,tw+10*k,20*k);ctx.fillStyle=cssv('--red');ctx.textAlign='center';ctx.fillText(lbl,lx,ly+1*k);ctx.textAlign='left';});}
  // north arrow + scale bar
  const nx=W-40*k,ny=44*k;ctx.fillStyle=ink;ctx.beginPath();ctx.moveTo(nx,ny-22*k);ctx.lineTo(nx+9*k,ny+8*k);ctx.lineTo(nx,ny+2*k);ctx.lineTo(nx-9*k,ny+8*k);ctx.closePath();ctx.fill();ctx.font=`700 ${14*k}px ${cond}`;ctx.textAlign='center';ctx.fillText('N',nx,ny+24*k);ctx.textAlign='left';
  const sx=24*k,sy=H-24*k,L1=1000*s;ctx.fillStyle=ink;ctx.fillRect(sx,sy,L1/2,5*k);ctx.strokeStyle=ink;ctx.lineWidth=1*k;ctx.strokeRect(sx,sy,L1,5*k);ctx.font=`600 ${12*k}px ${cond}`;ctx.fillText('0',sx-2*k,sy-5*k);ctx.fillText('1 km',sx+L1-12*k,sy-5*k);
  ctx.restore();
  return{cx,cy,s};
}
export function symPath(ctx: CanvasRenderingContext2D, x: number, y: number, kind: string, sz: number) {ctx.beginPath();if(kind==='hostile'){ctx.moveTo(x,y-sz*1.25);ctx.lineTo(x+sz*1.25,y);ctx.lineTo(x,y+sz*1.25);ctx.lineTo(x-sz*1.25,y);ctx.closePath();}else if(kind==='friend'){ctx.arc(x,y,sz,0,7);}else ctx.rect(x-sz,y-sz,sz*2,sz*2);}
export const kindOfCls=(cls: string | null | undefined)=>!cls||!TYPES[cls]?'unknown':TYPES[cls].friendly?'friend':TYPES[cls].hostile?'hostile':'neutral';
export const symSvg=(kind: string, col: string, dashed?: boolean)=>{const d=dashed?'stroke-dasharray="3 2"':'';if(kind==='hostile')return`<svg class="sym" viewBox="0 0 20 20"><path d="M10 2 18 10 10 18 2 10Z" fill="none" stroke="${col}" stroke-width="2"/></svg>`;if(kind==='friend')return`<svg class="sym" viewBox="0 0 20 20"><circle cx="10" cy="10" r="7" fill="none" stroke="${col}" stroke-width="2"/></svg>`;return`<svg class="sym" viewBox="0 0 20 20"><rect x="3" y="3" width="14" height="14" fill="none" stroke="${col}" stroke-width="2" ${d}/></svg>`;};

