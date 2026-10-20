import{$ as o,h as f,a as i,e as T,f as L}from"./app-13D8TKnR.js";import{LESSONS as b,startLesson as P}from"./academy-EaAFC8V3.js";import{startScenario as H}from"./scenarios-Cv3sajL1.js";import{S as R}from"./scenarios-sMZQ30Z3.js";import{v as M,W as O,w as E}from"./report-CR5-JBGS.js";import"./config-B3ryAbU-.js";import"./index-DN8Rkw3T.js";import"./fieldguide--qCEX-dQ.js";let y=!1,A=0;const B={clear:"☀",rain:"☔",fog:"🌫",dust:"🌪"};function C(){const a=new Set(i.DB.academy?.done??[]),e=b.find(s=>!a.has(s.n)),t=M(i.DB.H),r=["night","swarm","degraded","weather"].reduce((s,l)=>t[s]<=t[l]?s:l),v={night:"night drills",swarm:"swarm attacks",degraded:"faulty sensors",weather:"bad weather"}[r],g=Object.values(t).filter(s=>s>=L.certifiedMastery).length;return`
  <canvas id="homeFx" aria-hidden="true"></canvas>
  <div class="homeIn">
    <div class="homeHero">
      <div class="homeKicker">Smart India Hackathon 2026 · SIH26247 · Ministry of Defence</div>
      <h1 class="homeTitle">PARASHURAMA</h1>
      <p class="homeTag">Train every soldier to stop hostile drones.<br><span>On any laptop. Even offline.</span></p>
      <button class="homeDemo" id="hcDemo"><i aria-hidden="true">▶</i><span><b>Watch the 90-second demo</b><small>The whole product, narrated. No clicks needed.</small></span></button>
      <ol class="homeSteps">
        <li><i>1</i><b>Learn</b><span>Short lessons with a coach who explains every clue.</span></li>
        <li><i>2</i><b>Fight</b><span>Live drills on radar and in 3D. The enemy AI attacks your weak spots.</span></li>
        <li><i>3</i><b>Improve</b><span>Every decision scored and explained, replayed against an expert.</span></li>
      </ol>
      <p class="homeMobile">📱 Watch the demo or try a mission here. Full drills work best on a laptop or a tablet in landscape.</p>
      <div class="homeChips"><span>Works offline</span><span>Every score explained</span><span>Night · rain · fog · dust</span><span>3D view · VR-ready</span><span>Results can't be faked</span></div>
    </div>
    <div class="homeCards">
      <button class="hc hcPrimary" id="hcAcademy">
        <small>${e?`New here? Start here · lesson ${e.n} of ${b.length}`:"Academy complete ✓"}</small>
        <b>${e?"Learn in 10 minutes":"Replay the Academy"}</b>
        <span>${e?"A coach walks you through every clue and decision. No experience needed.":"All four lessons done. Replay any lesson from the brief."}</span>
        <div class="hcProg">${b.map(s=>`<i class="${a.has(s.n)?"on":""}"></i>`).join("")}</div>
        <em>${e?`Start: ${e.title}`:"Open lesson 1"} →</em>
      </button>
      <button class="hc" id="hcDrill">
        <small>Adaptive drill</small><b>Quick drill</b>
        <span>A 2-minute drill the enemy AI builds around your weakest skill: <strong>${v}</strong>.</span>
        <em>Begin →</em>
      </button>
      <div class="hc hcMissions">
        <small>Real-world missions</small><b>Defend a real kind of site</b>
        <div class="hmList">${R.map((s,l)=>`<button class="hm" data-hm="${l}"><span class="hmIcon" aria-hidden="true">${B[s.cfg.weather??"clear"]}</span>
          <span><b>${s.name}</b><small>${s.agency} · ${s.cfg.time==="night"?"Night":"Day"} · ${O[s.cfg.weather??"clear"]}</small></span><em>→</em></button>`).join("")}</div>
      </div>
      <button class="hc" id="hcUnit">
        <small>For commanders</small><b>Unit readiness</b>
        <span>Who in the troop is ready for tonight: night, swarm, faulty sensors or bad weather. You: ${g} of ${Object.keys(t).length} skills certified.</span>
        <em>Open the board →</em>
      </button>
      <button class="hc hcGun" id="hcGun">
        <small>Air defence guns · ZU-23-2 / ZSU-23-4</small><b>Control Room · On Ground</b>
        <span>Give the fire orders, or crew the gun: load, lay, set the lead and fire only on the order. Real ballistics.</span>
        <em>Open the gun drills →</em>
      </button>
      <button class="hc" id="hcLectures">
        <small>Self-study · by course</small><b>Classroom library</b>
        <span>Videos and notes from your instructors: Control Room, On Ground, UAV GCS, live-fire safety and more.</span>
        <em>Open the library →</em>
      </button>
    </div>
  </div>
  <div class="homeFoot"><span>Team Dhwanik_TH06</span><span>Vendor-neutral · indigenous · runs on hardware every unit already has</span><span>Training values only, not equipment specifications</span></div>`}function W(){const a=o("#homeFx");if(!a)return;const e=a.getContext("2d"),t=E(7),r=Array.from({length:14},()=>({a:t()*6.283,d:.25+t()*.7,s:6e-4+t()*.0012,k:t()<.3?1:0}));let v=performance.now();const g=s=>{if(!y)return;const l=a.width=a.clientWidth*devicePixelRatio,k=a.height=a.clientHeight*devicePixelRatio,c=Math.min(l,k)*.62,m=l*.78,p=k*.55,S=(s-v)/4e3*6.283;e.clearRect(0,0,l,k),e.strokeStyle="rgba(63,167,150,0.16)",e.lineWidth=1.2*devicePixelRatio;for(let n=1;n<=4;n++)e.beginPath(),e.arc(m,p,c*n/4,0,7),e.stroke();for(let n=0;n<12;n++){const d=n/12*6.283;e.beginPath(),e.moveTo(m,p),e.lineTo(m+Math.cos(d)*c,p+Math.sin(d)*c),e.stroke()}for(let n=0;n<40;n++){const d=S-n*.012;e.strokeStyle=`rgba(63,167,150,${.28*(1-n/40)})`,e.lineWidth=3*devicePixelRatio,e.beginPath(),e.moveTo(m,p),e.lineTo(m+Math.cos(d)*c,p+Math.sin(d)*c),e.stroke()}for(const n of r){n.d-=n.s*(n.k?1:.3),n.d<.08&&(n.d=.95);const d=m+Math.cos(n.a)*n.d*c,x=p+Math.sin(n.a)*n.d*c,D=((S-n.a)%6.283+6.283)%6.283,$=Math.max(.15,1-D/4);e.fillStyle=n.k?`rgba(229,72,77,${$})`:`rgba(242,201,76,${$})`,e.beginPath(),e.arc(d,x,4.5*devicePixelRatio,0,7),e.fill()}A=requestAnimationFrame(g)};A=requestAnimationFrame(g)}function w(){if(i.phase==="fight")return;let a=o("#home");a||(a=document.createElement("div"),a.id="home",a.setAttribute("role","dialog"),a.setAttribute("aria-label","PARASHURAMA home"),document.body.appendChild(a)),a.innerHTML=C(),a.classList.add("on"),y=!0,document.body.classList.add("homeOn"),o("#hcAcademy").onclick=()=>{const e=new Set(i.DB.academy?.done??[]),t=b.find(r=>!e.has(r.n))??b[0];h(),u(),P(t.n)},o("#hcDrill").onclick=()=>{h(),i.renderBrief(),i.setPhase("brief"),i.DB.tourDone||i.startTour(0)},T("[data-hm]").forEach(e=>e.onclick=()=>{h(),u(),H(R[+e.dataset.hm])}),o("#hcDemo").onclick=()=>{h(),f.showcase?.()},o("#hcLectures").onclick=()=>{h(),u(),f.openLectures?.()},o("#hcGun").onclick=()=>{h(),u(),f.openGun?.()},o("#hcUnit").onclick=()=>{h(),u(),i.renderUnit(),i.setPhase("learn"),o(".learnTabs [data-t=unit]").click()},W(),o("#hcAcademy").focus({preventScroll:!0}),a.scrollTop=0}function u(){i.DB.tourDone||(i.DB.tourDone=!0,i.saveDB())}function h(){y=!1,cancelAnimationFrame(A),o("#home")?.classList.remove("on"),document.body.classList.remove("homeOn")}function _(){f.showHome=w;const a=new URLSearchParams(location.search),e=a.has("nohome")||a.has("instructor")||a.has("demo")||a.has("gun");f.holdTour=!e||a.has("gun");const t=document.createElement("button");t.className="topBtn",t.id="homeBtn",t.textContent="Home",t.onclick=()=>w(),o("#helpBtn").before(t),document.addEventListener("keydown",r=>{y&&(r.stopPropagation(),r.key==="Escape"&&o("#hcDrill").click())},!0),e||w()}const Z=()=>y;export{h as closeHome,Z as homeOpen,_ as initHome,w as showHome};
