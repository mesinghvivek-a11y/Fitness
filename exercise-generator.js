/* Timely Fit exercise generator (muscle-map picker, auto plan) and dashboard muscle-workload card. */
(function(){
'use strict';
const $q=(s,r=document)=>r.querySelector(s),$$q=(s,r=document)=>r.querySelectorAll(s);
const MORDER=["Chest","Lats","Upper Back","Traps","Lower Back","Shoulders","Biceps","Triceps","Forearms","Abs & Core","Quads","Hamstrings","Glutes","Hips","Calves","Neck","Cardio","Full Body"];
const SLUG={chest:["Chest"],deltoids:["Shoulders"],trapezius:["Traps"],"upper-back":["Lats","Upper Back"],"lower-back":["Lower Back"],biceps:["Biceps"],triceps:["Triceps"],forearm:["Forearms"],abs:["Abs & Core"],obliques:["Abs & Core"],quadriceps:["Quads"],hamstring:["Hamstrings"],gluteal:["Glutes"],adductors:["Hips"],calves:["Calves"],tibialis:["Calves"],neck:["Neck"]};
const M2R={};Object.entries(SLUG).forEach(([s,ms])=>ms.forEach(m=>(M2R[m]=M2R[m]||[]).push(s)));
const SLBL={chest:"Chest",deltoids:"Shoulders",trapezius:"Traps","upper-back":"Upper back & lats","lower-back":"Lower back",biceps:"Biceps",triceps:"Triceps",forearm:"Forearms",abs:"Abs",obliques:"Obliques",quadriceps:"Quads",hamstring:"Hamstrings",gluteal:"Glutes",adductors:"Inner thigh",calves:"Calves",tibialis:"Shins",neck:"Neck"};
const FRONT_ONLY=["chest","abs","obliques","biceps","quadriceps","tibialis"],BACK_ONLY=["upper-back","lower-back","gluteal","hamstring"];
const EQL={"Cable Machine":"Cable","Plate-Loaded & Pin Machines":"Machines","Functional Accessories":"Accessories","Resistance Band":"Band","Cardio Machine":"Cardio machine","Weight Plate":"Plate"};
const eqLabel=q=>EQL[q]||q;
const PRI={Barbell:0,"Smith Machine":1,Dumbbell:2,"Plate-Loaded & Pin Machines":3,Kettlebell:3,"Cable Machine":4};
const PREF="timelyfit_gen_pref",ZMAX=3.2;
const G={mch:null,side:"front",view:"pick",count:6,selP:new Set(),selE:new Set(),list:[],H:[],pool:[],active:[],respect:true,prog:false,busy:false,timers:[],skip:false,heatSide:"front",zs:1,tx:0,ty:0,autoN:0,dragged:false};
const gender=()=>(state.profile&&state.profile.gender==="female")?"female":"male";
/* ---------- canonical muscle + movement pattern ---------- */
function cmName(s){const t=String(s||"").toLowerCase();return /cardio/.test(t)?"Cardio":/full body/.test(t)?"Full Body":/pector|chest/.test(t)?"Chest":/delt|shoulder/.test(t)?"Shoulders":/^lat/.test(t)?"Lats":/upper back|rhomboid|levator|^back/.test(t)?"Upper Back":/trap/.test(t)?"Traps":/spine|lower back|posterior/.test(t)?"Lower Back":/bicep/.test(t)?"Biceps":/tricep/.test(t)?"Triceps":/forearm|grip/.test(t)?"Forearms":/abs|core|serratus|oblique|waist/.test(t)?"Abs & Core":/hamstring/.test(t)?"Hamstrings":/glute|hip/.test(t)?"Glutes":/adductor|abductor/.test(t)?"Hips":/calve|ankle/.test(t)?"Calves":/quad|leg/.test(t)?"Quads":/neck/.test(t)?"Neck":/arm/.test(t)?"Biceps":null}
const cmOf=ex=>cmName(ex.primary_muscle||ex.target||ex.body_part||"");
function patOf(n){return String(n||"").toLowerCase().replace(/\(.*?\)/g,"").replace(/\b(dumbbells?|barbell|ez[- ]?(bar|barbell)|olympic|cable|lever(age)?|machine|smith|kettlebell|bands?|resistance|assisted|weighted|seated|standing|lying|kneeling|one|single|two|arms?|alternate|alternating|v\.?\s?\d|rope|bosu|stability|ball|medicine|sled|hammer|bodyweight|with|on|the)\b/g,"").replace(/[^a-z ]/g," ").replace(/\s+/g," ").trim()}
const META=new Map();const meta=ex=>{let m=META.get(ex.id);if(!m){m={m:cmOf(ex),pat:patOf(ex.name)};META.set(ex.id,m)}return m};
/* ---------- real history from the app's logs ---------- */
function hist(){const out=[];Object.keys(state.logs||{}).sort().forEach(date=>{const log=state.logs[date];if(!log)return;workoutSessions(log).forEach(s=>{const t=s.end_ms||s.start_ms||parseDateKey(date).getTime(),ex=[];
 (s.exercises||[]).forEach(e=>{const done=(e.sets||[]).filter(x=>x.completed);if(!done.length)return;const ref=findExercise(e.exercise_id)||e,pl=(e.sets||[]).length;ex.push({id:e.exercise_id,bp:cmOf(ref),eq:ref.equipment||e.equipment,w:Math.max(...done.map(x=>n(x.weight))),done:done.length>=pl?4:Math.min(3,done.length),rpe:e.feel||"ok"})});
 if(ex.length)out.push({t,ex})})});return out.sort((a,b)=>a.t-b.t)}
const lastEx=id=>{for(let i=G.H.length-1;i>=0;i--){const x=G.H[i].ex.find(e=>e.id===id);if(x)return x}return null};
const lastBp=ex=>{const m=meta(ex).m;for(let i=G.H.length-1;i>=0;i--){const x=G.H[i].ex.find(q=>q.bp===m&&q.eq===ex.equipment&&q.w>0);if(x)return x.w}return 0};
const r25=v=>Math.round(v/2.5)*2.5;
function consecUp(id){const a=[];G.H.forEach(q=>{const x=q.ex.find(e=>e.id===id);if(x)a.push(x.w)});let k=0;for(let i=a.length-1;i>0;i--){if(a[i]>a[i-1])k++;else break}return k}
function suggest(ex,mode){if(mode!=="weight")return{w:0,note:""};const L=lastEx(ex.id);
 if(L&&L.w>0){let w=L.w,t="Same as last time · "+L.w+" kg";
  if(L.done<=2){w=r25(L.w*.95);t="5% lighter · last session wasn't finished"}
  else if(L.done<4){}
  else if(consecUp(ex.id)>=4){w=r25(L.w*.9);t="Deload −10% to recover"}
  else if(L.rpe==="easy"){w=L.w+Math.max(2.5,r25(L.w*.05));t="Up · it felt easy last time ("+L.w+" kg)"}
  else if(L.rpe==="hard"){t="Same as last time · it felt hard"}
  else{w=L.w+2.5;t="+2.5 kg · last time "+L.w+" kg"}
  return{w,note:t}}
 const B=lastBp(ex);return B?{w:B,note:"Start from your last "+meta(ex).m.toLowerCase()+" weight on this equipment"}:{w:0,note:"First time · start light"}}
function recMap(){const last={};G.H.forEach(q=>q.ex.forEach(e=>{last[e.bp]=Math.max(last[e.bp]||0,q.t)}));const r={_last:last};MORDER.forEach(m=>r[m]=(last[m]&&!/Cardio|Full/.test(m))?Math.min(1,(Date.now()-last[m])/172800000):1);return r}
const rec=m=>recMap()[m]??1;
const recCol=v=>{const A=[255,74,54],B=[255,176,32],f=(p,q,u)=>p.map((x,i)=>x+(q[i]-x)*u|0);return f(A,B,Math.min(1,v))};
const setOf=k=>new Set((state.profile&&state.profile[k])||[]);
function saveSet(k,s){state.profile[k]=[...s];if(state.syncMeta)state.syncMeta.pendingProfile=true;scheduleSave(false)}
/* ---------- variety engine ---------- */
function usage(){const u={};G.H.forEach((q,i)=>q.ex.forEach(e=>{const o=u[e.id]||(u[e.id]={n:0,last:0});o.n++;o.last=i}));return u}
const score=(e,u,fav)=>{const o=u[e.id];let w=1/(1+(o?o.n:0)*.7);if(o&&G.H.length-1-o.last<3)w*=.25;if(fav.has(e.id))w*=3;return w};
const wpick=(a,f)=>{let t=a.reduce((s,e)=>s+f(e),0),r=Math.random()*t;for(const e of a){r-=f(e);if(r<=0)return e}return a[a.length-1]};
function generate(cnt,av){const u=usage(),fav=setOf("genFav"),hid=setOf("genHide"),seen=new Set,ec={},out=[];
 av.forEach(id=>{const e=G.pool.find(x=>x.id===id);if(e){seen.add(meta(e).pat);ec[e.equipment]=(ec[e.equipment]||0)+1}});
 const ok=e=>G.selE.has(e.equipment)&&!av.has(e.id)&&!hid.has(e.id)&&!out.includes(e);
 const rc=recMap(),ps=G.active.filter(p=>G.pool.some(e=>meta(e).m===p&&ok(e))).sort((a,b)=>rc[b]-rc[a]),base=cnt/ps.length|0;let extra=cnt-base*ps.length;
 ps.forEach(p=>{let k=base+(extra-->0?1:0);while(k-->0){let c=G.pool.filter(e=>meta(e).m===p&&ok(e));if(!c.length)break;const f=c.filter(e=>!seen.has(meta(e).pat));if(f.length)c=f;
  const mn=Math.min(...[...new Set(c.map(e=>e.equipment))].map(q=>ec[q]||0));c=c.filter(x=>(ec[x.equipment]||0)===mn);const e=wpick(c,x=>score(x,u,fav));out.push(e);seen.add(meta(e).pat);ec[e.equipment]=(ec[e.equipment]||0)+1}});
 while(out.length<cnt){const c=G.pool.filter(e=>ps.includes(meta(e).m)&&ok(e));if(!c.length)break;out.push(wpick(c,x=>score(x,u,fav)))}
 return out.sort((a,b)=>ps.indexOf(meta(a).m)-ps.indexOf(meta(b).m)||(PRI[a.equipment]??5)-(PRI[b.equipment]??5))}
function prep(ex){const mode=exerciseMode(ex),q=suggest(ex,mode);return{ex,mode,w:q.w,note:q.note,sets:mode==="time"?1:4,reps:mode==="time"?10:12,inc:2.5,lock:false}}
const setWeights=p=>Array.from({length:p.sets},(_,i)=>round(p.w+(G.prog&&p.mode==="weight"?i*p.inc:0),2));
/* ---------- body model svg ---------- */
function modelSvg(side){const M=BODY_MODEL[gender()][side];return `<svg viewBox="${M.vb}" preserveAspectRatio="xMidYMid meet" aria-hidden="true"><path class="bm-ol" d="${M.ol}"/>${Object.entries(M.parts).map(([k,ds])=>`<g class="${SLUG[k]?"bm-m":"bm-b"}" data-s="${k}">${ds.map(d=>`<path d="${d}"/>`).join("")}</g>`).join("")}</svg>`}
const flipHtml=(sd,id)=>`<div class="bm-sway"><div class="bm-flip ${sd==="back"?"back":""}" ${id?`id="${id}"`:""}><div class="bm-face f">${modelSvg("front")}</div><div class="bm-face b">${modelSvg("back")}</div></div></div>`;
/* ---------- modal ---------- */
const root=()=>$q("#gRoot"),t=(msg)=>{const el=$q("#gToast");if(!el)return;el.textContent=msg;el.classList.add("on");clearTimeout(G.tt);G.tt=setTimeout(()=>el.classList.remove("on"),3200)};
function loadPref(){try{const p=JSON.parse(localStorage.getItem(PREF)||"{}");G.count=p.count||6;G.respect=p.respect!==false;G.prog=!!p.prog;G.selE=new Set(p.eq||[])}catch(_){}}
function savePref(){try{localStorage.setItem(PREF,JSON.stringify({count:G.count,respect:G.respect,prog:G.prog,eq:[...G.selE]}))}catch(_){}}
function open(){cleanup();G.H=hist();G.pool=masterExercises.filter(e=>meta(e).m);G.list=[];G.view="pick";G.side="front";G.selP=new Set();G.zs=1;G.tx=0;G.ty=0;G.autoN=0;loadPref();
 const eqs=new Set(G.pool.map(e=>e.equipment));G.selE=new Set([...G.selE].filter(q=>eqs.has(q)));
 const tpl=(state.profile.workoutTemplates||[]).length;
 showModal(`<div id="gRoot"><div class="modal-handle"></div><div class="gen-head"><button type="button" class="g-ic" data-g="menu" aria-label="More options">${icon("more")}</button><div class="g-seg"><button type="button" data-g="tab" data-v="pick" class="on">Pick</button><button type="button" data-g="tab" data-v="plan" id="gTabPlan">Plan</button></div><button type="button" class="close-modal" data-action="close-modal" aria-label="Close">${icon("x")}</button></div>
 <div class="g-menu g-hide" id="gMenu"><label class="g-chk"><input type="checkbox" id="gRc" ${G.respect?"checked":""}> Respect 48h muscle recovery</label><button type="button" data-g="search">${icon("search")} Search exercises by name</button>${tpl?`<button type="button" data-action="open-templates">${icon("bookmark")} Templates</button>`:""}</div>
 <div class="gen-main"><section id="gPick"><div class="g-stage" id="gStage"><div class="bm-sd"><button type="button" data-g="side" data-v="front" class="on">Front</button><button type="button" data-g="side" data-v="back">Back</button></div>
 <div class="g-zoom"><button type="button" data-g="zin" aria-label="Zoom in">+</button><button type="button" data-g="zout" aria-label="Zoom out">−</button><button type="button" data-g="zreset" id="gZoomR" class="g-hide" aria-label="Reset zoom">⤢</button></div>
 <div class="bm-floor"></div><div class="bm-zoom" id="gZoom">${flipHtml("front","gFlip")}</div>
 <div class="g-run"><div class="g-eqtags" id="gTags"></div><div class="g-status" id="gSt"></div><div class="g-prog"><i id="gPr"></i></div></div></div>
 <div class="g-row g-ctrl" id="gSel"></div><div class="g-row g-ctrl" id="gEq"></div></section>
 <section id="gPlan" class="g-hide"><div class="g-add"><div class="g-search"><svg class="i" aria-hidden="true"><use href="#i-search"/></svg><input id="gQ" type="search" placeholder="Search an exercise or machine" autocomplete="off" enterkeyhint="search"><button type="button" class="g-qx g-hide" id="gQx" data-g="qx" aria-label="Clear search">×</button></div><div class="g-row g-mrow" id="gMch"></div><div class="g-res g-hide" id="gRes"></div></div><div class="g-sumrow"><div class="g-sum" id="gSum"></div><label class="g-tg" title="Add weight on every set"><span>Progressive</span><input type="checkbox" id="gProg" ${G.prog?"checked":""}><i></i></label></div><div id="gList"></div></section></div>
 <div class="gen-bar" id="gBarPick"><div class="g-step"><button type="button" data-g="cnt" data-d="-1" aria-label="Fewer exercises">−</button><b id="gCn">6</b><button type="button" data-g="cnt" data-d="1" aria-label="More exercises">+</button></div><button type="button" class="g-go" id="gGo" data-g="go" disabled>Pick muscles &amp; equipment</button></div>
 <div class="gen-bar g-hide" id="gBarPlan"><button type="button" class="g-ghost" id="gRr" data-g="reroll">⟳ Reroll</button><button type="button" class="g-go" data-g="add" id="gAdd">Add to workout</button></div>
 <div class="g-gif g-hide" id="gGif" data-g="gifx"></div><div class="g-toast" id="gToast"></div></div>`,"gen");
 eqBuild();paint()}
function cleanup(){G.timers.forEach(clearTimeout);G.timers=[];G.busy=false}
function eqBuild(){const c={};G.pool.forEach(e=>c[e.equipment]=(c[e.equipment]||0)+1);const el=$q("#gEq");if(!el)return;el.innerHTML=`<button type="button" class="g-ch" data-g="eq" data-q="*">All</button>`+Object.entries(c).sort((a,b)=>b[1]-a[1]).map(([q])=>`<button type="button" class="g-ch" data-g="eq" data-q="${safe(q)}">${safe(eqLabel(q))}</button>`).join("")}
function paint(){const r=recMap(),el=root();if(!el)return;
 $$q(".bm-m",el).forEach(g=>{const ms=SLUG[g.dataset.s],on=ms.every(x=>G.selP.has(x)),rc=Math.min(...ms.map(x=>r[x]??1));g.classList.toggle("on",on);g.classList.toggle("tired",!on&&rc<1);g.style.setProperty("--tc","rgb("+recCol(rc)+")")});
 $q("#gSel").innerHTML=`<button type="button" class="g-ch auto" data-g="auto">✨ Auto</button>`+MORDER.filter(m=>G.selP.has(m)).map(m=>`<button type="button" class="g-ch on${r[m]<1?" tired":""}" data-g="muscle" data-m="${safe(m)}">${safe(m)} ×</button>`).join("")+["Cardio","Full Body"].filter(m=>!G.selP.has(m)).map(m=>`<button type="button" class="g-ch" data-g="muscle" data-m="${safe(m)}">+ ${safe(m)}</button>`).join("")+(G.selP.size?"":`<span class="g-hint">Tap muscles on the body</span>`);
 const all=new Set(G.pool.map(e=>e.equipment)).size;$$q("#gEq .g-ch",el).forEach(b=>b.classList.toggle("on",b.dataset.q==="*"?G.selE.size===all:G.selE.has(b.dataset.q)));
 const ok=G.selP.size&&G.selE.size,g=$q("#gGo");g.disabled=!ok;g.textContent=ok?"Generate · "+G.count+" exercises":"Pick muscles & equipment";$q("#gCn").textContent=G.count;
 $q("#gTabPlan").dataset.n=G.list.length||""}
function setView(v){G.view=v;const p=v==="pick";$q("#gPick").classList.toggle("g-hide",!p);$q("#gPlan").classList.toggle("g-hide",p);$q("#gBarPick").classList.toggle("g-hide",!p);$q("#gBarPlan").classList.toggle("g-hide",p);$$q('[data-g="tab"]').forEach(b=>b.classList.toggle("on",b.dataset.v===v))}
function setSide(s){G.side=s;$q("#gFlip").classList.toggle("back",s==="back");$$q('.bm-sd [data-g="side"]').forEach(b=>b.classList.toggle("on",b.dataset.v===s))}
/* zoom + pan so small muscles are easy to hit */
function applyZoom(){const z=$q("#gZoom");if(!z)return;z.style.transform=`translate(${G.tx}px,${G.ty}px) scale(${G.zs})`;const r=$q("#gZoomR");if(r)r.classList.toggle("g-hide",G.zs<=1.01)}
function clampPan(){const z=$q("#gZoom");if(!z)return;const mx=Math.max(0,(G.zs-1)*z.offsetWidth/2),my=Math.max(0,(G.zs-1)*z.offsetHeight/2);G.tx=Math.max(-mx,Math.min(mx,G.tx));G.ty=Math.max(-my,Math.min(my,G.ty))}
function zoomTo(s){G.zs=Math.max(1,Math.min(ZMAX,s));if(G.zs<=1.01){G.zs=1;G.tx=G.ty=0}clampPan();applyZoom()}
/* auto: next-best fresh muscles, favouring ones not trained yet this week */
const GR=[["Push",["Chest","Shoulders","Triceps"]],["Pull",["Lats","Upper Back","Traps","Biceps"]],["Legs",["Quads","Hamstrings","Glutes","Calves"]],["Core",["Abs & Core","Lower Back"]],["Arms",["Biceps","Triceps","Forearms"]],["Shoulders & back",["Shoulders","Traps","Upper Back"]]];
function weekStartMs(){const d=new Date();d.setHours(0,0,0,0);d.setDate(d.getDate()-((d.getDay()+6)%7));return d.getTime()}
function auto(){const r=recMap(),L=r._last,ws=weekStartMs(),now=Date.now(),cand=[];
 const info=m=>({m,fresh:r[m]>=1&&G.pool.some(e=>meta(e).m===m),newWk:!(L[m]>=ws),hrs:L[m]?Math.min(336,(now-L[m])/36e5):336});
 GR.forEach(([nm,list])=>{const f=list.map(info).filter(x=>x.fresh).sort((a,b)=>(b.newWk-a.newWk)||(b.hrs-a.hrs)).slice(0,3);if(f.length<Math.min(2,list.length))return;
  cand.push({nm,f,score:f.reduce((s,x)=>s+(x.newWk?1000:0)+x.hrs,0)/f.length})});
 if(!cand.length){G.selP.clear();t("Everything is still recovering. Rest today.");paint();return}
 cand.sort((a,b)=>b.score-a.score);let c=cand[G.autoN++%cand.length];
 if(cand.length>1&&[...G.selP].sort().join()===c.f.map(x=>x.m).sort().join())c=cand[G.autoN++%cand.length];
 G.selP=new Set(c.f.map(x=>x.m));const nw=c.f.filter(x=>x.newWk).map(x=>x.m);
 t(c.nm+" · "+(nw.length?"not trained this week: "+nw.join(", "):"all trained this week already"));paint()}
/* ---------- generate with the enlarged body-model transition ---------- */
function go(){if(G.busy)return;let use=[...G.selP],sk=[];if(G.respect){sk=use.filter(p=>rec(p)<1);use=use.filter(p=>rec(p)>=1)}
 if(!use.length){t("Those muscles are still recovering (48h). Try ✨ Auto.");return}
 G.active=use;const hid=setOf("genHide"),avail=G.pool.filter(e=>use.includes(meta(e).m)&&G.selE.has(e.equipment)&&!hid.has(e.id)).length;if(!avail){t("No exercises match that muscle and equipment.");return}
 const man=G.list.filter(l=>l.manual);G.list=[...man,...generate(G.count,new Set(man.map(m=>m.ex.id))).map(prep)];chooseSide(use);savePref();zoomTo(1);transition(()=>{renderPlan();setView("plan");paint();if(sk.length)t("Skipped "+sk.join(", ")+" (recovering)");else if(avail<G.count)t("Only "+avail+" matches found")})}
function chooseSide(use){let f=0,b=0;use.forEach(m=>(M2R[m]||[]).forEach(s=>{if(FRONT_ONLY.includes(s))f++;else if(BACK_ONLY.includes(s))b++}));setSide(b>f?"back":"front")}
function transition(done){const el=root();G.busy=true;G.skip=false;el.classList.add("gen-run");
 $q("#gTags").innerHTML=[...G.selE].map(q=>`<span>${safe(eqLabel(q))}</span>`).join("");
 const S=["Scanning muscle map","Locking target muscles","Matching equipment","Balancing volume","Workout ready"],T=2800;let t0=Date.now(),fin=false;
 const finish=()=>{if(fin)return;fin=true;cleanup();const r=root();if(!r)return;r.classList.remove("gen-run");done()};
 const tick=()=>{if(!root()||fin)return;const p=G.skip?1:Math.min(1,(Date.now()-t0)/T);$q("#gSt").textContent=S[Math.min(4,p*5|0)];$q("#gPr").style.width=p*100+"%";if(p>=1)G.timers.push(setTimeout(finish,250));else G.timers.push(setTimeout(tick,80))};
 G.timers.push(setTimeout(tick,60))}
/* ---------- plan ---------- */
function thumb(ex){const glyph=exerciseEmoji(ex.primary_muscle||ex.target||"");return exerciseHasLicensedMedia(ex)?`<i class="g-th"><img src="${safe(ex.image)}" alt="" loading="lazy" onerror="this.remove()"><span>${glyph}</span></i>`:`<i class="g-th"><span>${glyph}</span></i>`}
function tile(lbl,i,f,v,u){return `<div class="g-tile"><span>${lbl}</span><div><button type="button" data-g="adj" data-i="${i}" data-f="${f}" data-d="-1" aria-label="Less ${lbl}">−</button><b>${v}${u||""}</b><button type="button" data-g="adj" data-i="${i}" data-f="${f}" data-d="1" aria-label="More ${lbl}">+</button></div></div>`}
function rowHtml(i){const p=G.list[i],ex=p.ex,m=meta(ex).m,fav=setOf("genFav").has(ex.id),wk=p.mode==="weight",first=!i||meta(G.list[i-1].ex).m!==m,ramp=wk&&G.prog;
 const wts=setWeights(p),wtxt=wk?(ramp&&p.inc>0?fmt(wts[0],1)+" → "+fmt(wts[wts.length-1],1):fmt(p.w,1))+" kg":"";
 const wu=wk&&first&&p.w>=20?`<div class="g-wu">Warm-up · 8 × ${fmt(r25(p.w*.5),1)} kg, 4 × ${fmt(r25(p.w*.7),1)} kg</div>`:"";
 return `<div class="g-ex" data-i="${i}"><div class="g-hd" data-g="row" data-i="${i}"><button type="button" class="g-thbtn" data-g="gif" data-i="${i}" aria-label="Preview ${safe(ex.name)} movement">${thumb(ex)}<b class="g-play">▶</b></button><div class="g-tx"><b>${safe(ex.name)}</b><small>${safe(m)} · ${safe(eqLabel(ex.equipment))}${wk?` · <u>${wtxt}</u>`:""}</small></div><span class="g-sr">${p.mode==="time"?p.reps+" min":p.sets+" × "+p.reps}</span></div>
 <div class="g-more"><div><div class="g-tiles">${wk?tile("Weight",i,"w",fmt(p.w,1)," kg"):""}${ramp?tile("Add per set",i,"inc","+"+fmt(p.inc,1)," kg"):""}${p.mode==="time"?tile("Minutes",i,"reps",p.reps,""):tile("Sets",i,"sets",p.sets,"")+tile("Reps",i,"reps",p.reps,"")}</div>
 ${ramp?`<div class="g-ramp">${wts.map((w,k)=>`<span><small>Set ${k+1}</small>${fmt(w,1)}</span>`).join("")}</div>`:""}
 ${wk&&p.note?`<div class="g-note">${safe(p.note)}</div>`:""}${wu}
 <div class="g-ac"><button type="button" data-g="fav" data-i="${i}"><b>${fav?"★":"☆"}</b>Favorite</button><button type="button" data-g="lock" data-i="${i}"><b>${p.lock?"🔒":"🔓"}</b>${p.lock?"Locked":"Lock"}</button><button type="button" data-g="swap" data-i="${i}"><b>⟳</b>Swap</button><button type="button" data-g="hide" data-i="${i}"><b>⊘</b>Hide</button></div></div></div></div>`}
function renderPlan(){const sets=G.list.reduce((a,p)=>a+p.sets,0),min=Math.round(G.list.reduce((a,p)=>a+(p.mode==="time"?p.reps:p.sets*(.7+n(p.ex.default_rest_sec||60)/60)),0));
 $q("#gSum").textContent=G.list.length?sets+" sets · about "+min+" min":"Nothing in your plan yet";
 $q("#gList").innerHTML=G.list.length?G.list.map((_,i)=>rowHtml(i)).join(""):`<div class="g-empty">Add the exercises your trainer gave you: search by name or tap a muscle above. You can also generate a plan from the Pick tab.</div>`;
 const a=$q("#gAdd");a.textContent=G.list.length?"Add "+G.list.length+" to workout":"Add to workout";a.disabled=!G.list.length;
 const rr=$q("#gRr");if(rr)rr.disabled=!G.list.some(l=>!l.lock);
 const mc=$q("#gMch");if(mc&&!mc.children.length)mc.innerHTML=MORDER.filter(m=>G.pool.some(e=>meta(e).m===m)).map(m=>`<button type="button" class="g-ch" data-g="mch" data-m="${safe(m)}">${safe(m)}</button>`).join("");
 $$q("#gMch .g-ch").forEach(b=>b.classList.toggle("on",b.dataset.m===G.mch));$q("#gTabPlan").dataset.n=G.list.length||"";renderRes()}
/* manual add: search by name or browse by muscle */
function renderRes(){const box=$q("#gRes");if(!box)return;const q=($q("#gQ").value||"").trim();$q("#gQx").classList.toggle("g-hide",!q);
 if(!q&&!G.mch){box.classList.add("g-hide");box.innerHTML="";return}
 let list=q?searchExercises(q).map(x=>x.ex):G.pool.slice().sort((a,b)=>a.name.localeCompare(b.name));if(G.mch)list=list.filter(e=>meta(e).m===G.mch);
 const total=list.length,inPlan=new Set(G.list.map(p=>p.ex.id));list=list.slice(0,40);box.classList.remove("g-hide");
 box.innerHTML=list.length?list.map(e=>`<div class="g-rr"><button type="button" class="g-thbtn" data-g="gifr" data-id="${safe(e.id)}" aria-label="Preview ${safe(e.name)}">${thumb(e)}<b class="g-play">▶</b></button><div class="g-tx"><b>${safe(e.name)}</b><small>${safe(meta(e).m||"")} · ${safe(eqLabel(e.equipment))}</small></div>${inPlan.has(e.id)?`<span class="g-in">✓ Added</span>`:`<button type="button" class="g-plus" data-g="addx" data-id="${safe(e.id)}" aria-label="Add ${safe(e.name)}">+</button>`}</div>`).join("")+(total>40?`<div class="g-more-note">Showing 40 of ${total}. Type to narrow the list.</div>`:""):`<div class="g-more-note">No exercises found. Try another name or muscle.</div>`}
function addManual(id){const ex=findExercise(id)||G.pool.find(e=>e.id===id);if(!ex||G.list.some(p=>p.ex.id===id))return;const p=prep(ex);p.lock=true;p.manual=true;G.list.push(p);renderPlan();t("Added · "+ex.name)}
function refreshRow(i){const el=$q('#gList .g-ex[data-i="'+i+'"]');if(!el)return;const open=el.classList.contains("open");el.outerHTML=rowHtml(i);if(open)$q('#gList .g-ex[data-i="'+i+'"]').classList.add("open")}
function swap(i){const e=G.list[i].ex,m=meta(e).m,pats=new Set(G.list.map(x=>meta(x.ex).pat)),u=usage(),fav=setOf("genFav"),hid=setOf("genHide");let c=G.pool.filter(x=>meta(x).m===m&&G.selE.has(x.equipment)&&!hid.has(x.id)&&!G.list.some(l=>l.ex.id===x.id));const f=c.filter(x=>!pats.has(meta(x).pat));if(f.length)c=f;
 if(!c.length){t("No other match for "+m);return false}G.list[i]=prep(wpick(c,x=>score(x,u,fav)));renderPlan();return true}
function reroll(){const keep=G.list.filter(l=>l.lock),cnt=G.list.length-keep.length;if(!cnt||!G.selE.size||!G.active.length){t("Nothing to reroll. Locked and manually added exercises stay.");return}const fresh=generate(cnt,new Set(keep.map(k=>k.ex.id))).map(prep);G.list=[...keep,...fresh];setView("pick");transition(()=>{renderPlan();setView("plan")})}
function glance(ex){const el=$q("#gGif"),has=exerciseHasLicensedMedia(ex);
 el.innerHTML=`<div class="g-gif-card"><button type="button" class="g-gif-x" data-g="gifx" aria-label="Close preview">${icon("x")}</button>${has?`<img src="${safe(ex.gif_url)}" alt="${safe(ex.name)} movement animation" onerror="this.outerHTML='<div class=&quot;g-gif-ph&quot;>Animation could not be loaded</div>'">`:`<div class="g-gif-ph"><span>${exerciseEmoji(ex.primary_muscle||ex.target||"")}</span>No animation for this exercise yet</div>`}<strong>${safe(ex.name)}</strong><small>${safe(meta(ex).m)} · ${safe(eqLabel(ex.equipment))}</small></div>`;el.classList.remove("g-hide")}
function addAll(){if(!G.list.length)return;const wk=ensureWorkout();
 G.list.forEach(p=>{const ex=p.ex,wts=setWeights(p);state.recentExerciseIds=recentIds(state.recentExerciseIds,ex.id);
  wk.exercises.push({exercise_id:ex.id,mode:p.mode,name:ex.name,primary_muscle:ex.primary_muscle,secondary_muscles:ex.secondary_muscles||[],equipment:ex.equipment,met_value:ex.met_value,default_rest_sec:ex.default_rest_sec,tracking_metrics:ex.tracking_metrics||["weight","reps"],sets:Array.from({length:p.sets},(_,i)=>({set_num:i+1,weight:p.mode==="weight"?wts[i]:0,reps:p.reps,completed:false})),started:false,finished:false,rest_until:null,last_completed_set:null,created_at:new Date().toISOString(),generated:true})});
 const cnt=G.list.length;state.selectedDomain="workout";state.selectedTab="timeline";if(typeof openExIdx!=="undefined")openExIdx=-1;scheduleSave();closeModal();render();toast(cnt+" exercises added to your session.")}
/* ---------- events ---------- */
document.addEventListener("click",ev=>{const el=root();
 const hm=ev.target.closest(".heat-card [data-heat-side]");if(hm){G.heatSide=hm.dataset.heatSide;const c=hm.closest(".heat-card");c.querySelector(".bm-flip").classList.toggle("back",G.heatSide==="back");c.querySelectorAll("[data-heat-side]").forEach(b=>b.classList.toggle("on",b===hm));return}
 const hg=ev.target.closest(".heat-card .bm-m");if(hg){const c=hg.closest(".heat-card");c.querySelectorAll(".bm-m.pick").forEach(x=>x.classList.remove("pick"));hg.classList.add("pick");const rd=c.querySelector(".heat-read");if(rd)rd.innerHTML=`<strong>${safe(hg.dataset.name)}</strong> · ${hg.dataset.v} sets`;return}
 if(!el||!el.contains(ev.target))return;
 const mg=ev.target.closest(".bm-m");if(mg&&G.view==="pick"&&!G.busy){if(G.dragged){G.dragged=false;return}const ms=SLUG[mg.dataset.s],all=ms.every(x=>G.selP.has(x));ms.forEach(x=>all?G.selP.delete(x):G.selP.add(x));try{navigator.vibrate&&navigator.vibrate(8)}catch(_){}paint();return}
 if(G.busy&&ev.target.closest("#gStage")){G.skip=true;return}
 if(ev.target.id==="gGif"){ev.target.classList.add("g-hide");return}
 const b=ev.target.closest("[data-g]");if(!b)return;const a=b.dataset.g,i=+b.dataset.i;
 if(a!=="menu"&&!ev.target.closest("#gMenu"))$q("#gMenu").classList.add("g-hide");
 switch(a){
 case"tab":if(b.dataset.v==="plan")renderPlan();setView(b.dataset.v);break;
 case"side":setSide(b.dataset.v);break;
 case"menu":$q("#gMenu").classList.toggle("g-hide");break;
 case"search":openExerciseSearchModal();break;
 case"muscle":{const m=b.dataset.m;G.selP.has(m)?G.selP.delete(m):G.selP.add(m);paint();break}
 case"eq":{const q=b.dataset.q,all=[...new Set(G.pool.map(e=>e.equipment))];if(q==="*")G.selE.size===all.length?G.selE.clear():all.forEach(x=>G.selE.add(x));else G.selE.has(q)?G.selE.delete(q):G.selE.add(q);savePref();paint();break}
 case"cnt":G.count=Math.max(1,Math.min(15,G.count+ +b.dataset.d));savePref();paint();break;
 case"zin":zoomTo(G.zs*1.45);break;case"zout":zoomTo(G.zs/1.45);break;case"zreset":zoomTo(1);break;
 case"auto":auto();break;
 case"go":go();break;
 case"reroll":reroll();break;
 case"add":addAll();break;
 case"gif":glance(G.list[i].ex);break;
 case"gifr":glance(findExercise(b.dataset.id));break;
 case"addx":addManual(b.dataset.id);break;
 case"mch":G.mch=G.mch===b.dataset.m?null:b.dataset.m;renderPlan();break;
 case"qx":$q("#gQ").value="";renderRes();break;
 case"gifx":$q("#gGif").classList.add("g-hide");break;
 case"row":{const row=$q('#gList .g-ex[data-i="'+i+'"]'),was=row.classList.contains("open");$$q("#gList .g-ex.open").forEach(x=>x.classList.remove("open"));if(!was){row.classList.add("open");setTimeout(()=>row.scrollIntoView({block:"nearest",behavior:"smooth"}),60)}break}
 case"adj":{const p=G.list[i],f=b.dataset.f,d=+b.dataset.d;if(f==="w")p.w=Math.max(0,round(p.w+d*2.5,2));else if(f==="inc")p.inc=Math.max(0,Math.min(10,round(p.inc+d*2.5,2)));else if(f==="sets")p.sets=Math.max(1,Math.min(10,p.sets+d));else p.reps=Math.max(1,Math.min(p.mode==="time"?120:50,p.reps+d));refreshRow(i);break}
 case"fav":{const s=setOf("genFav"),id=G.list[i].ex.id;s.has(id)?s.delete(id):s.add(id);saveSet("genFav",s);refreshRow(i);break}
 case"lock":G.list[i].lock=!G.list[i].lock;refreshRow(i);break;
 case"swap":swap(i);break;
 case"hide":{const s=setOf("genHide");s.add(G.list[i].ex.id);saveSet("genHide",s);if(!swap(i)){G.list.splice(i,1);renderPlan();paint()}t("Hidden from future workouts");break}
 }});
let qt;document.addEventListener("input",ev=>{if(ev.target.id==="gQ"){clearTimeout(qt);qt=setTimeout(renderRes,120)}});
document.addEventListener("change",ev=>{if(ev.target.id==="gRc"){G.respect=ev.target.checked;savePref()}if(ev.target.id==="gProg"){G.prog=ev.target.checked;savePref();renderPlan()}});
/* pinch / drag / swipe on the body model */
const ptr=new Map();let pinch0=0,zs0=1;
document.addEventListener("pointerdown",e=>{if(!e.target.closest("#gStage")||G.busy)return;ptr.set(e.pointerId,{x:e.clientX,y:e.clientY,sx:e.clientX,sy:e.clientY});G.dragged=false;if(ptr.size===2){const[a,b]=[...ptr.values()];pinch0=Math.hypot(a.x-b.x,a.y-b.y);zs0=G.zs}});
document.addEventListener("pointermove",e=>{const p=ptr.get(e.pointerId);if(!p)return;
 if(ptr.size===2){p.x=e.clientX;p.y=e.clientY;const[a,b]=[...ptr.values()],d=Math.hypot(a.x-b.x,a.y-b.y);if(pinch0){G.dragged=true;zoomTo(zs0*d/pinch0)}return}
 const dx=e.clientX-p.x,dy=e.clientY-p.y;p.x=e.clientX;p.y=e.clientY;if(Math.hypot(e.clientX-p.sx,e.clientY-p.sy)>6)G.dragged=true;
 if(G.zs>1.01&&G.dragged){G.tx+=dx;G.ty+=dy;clampPan();applyZoom()}});
const up=e=>{const p=ptr.get(e.pointerId);if(!p)return;ptr.delete(e.pointerId);if(ptr.size<2)pinch0=0;if(G.zs<=1.01&&e.type==="pointerup"&&Math.abs(e.clientX-p.sx)>60&&Math.abs(e.clientY-p.sy)<50){setSide(G.side==="front"?"back":"front");G.dragged=true}};
document.addEventListener("pointerup",up);document.addEventListener("pointercancel",up);
document.addEventListener("wheel",e=>{if(e.target.closest&&e.target.closest("#gStage")&&!G.busy){e.preventDefault();zoomTo(G.zs*(e.deltaY<0?1.15:.87))}},{passive:false});
/* ---------- dashboard muscle workload ---------- */
function heatColor(x){const S=[[0,[108,203,242]],[.35,[199,243,108]],[.7,[255,176,32]],[1,[255,74,54]]];for(let i=1;i<S.length;i++)if(x<=S[i][0]){const[a,A]=S[i-1],[b,B]=S[i],u=(x-a)/(b-a);return"rgb("+A.map((v,k)=>Math.round(v+(B[k]-v)*u)).join(",")+")"}return"rgb(255,74,54)"}
function heatCard(entries){const reg={},byM={};let total=0;
 const add=(m,c,w)=>{if(!m)return;byM[m]=(byM[m]||0)+c*w;(M2R[m]||[]).forEach(s=>reg[s]=(reg[s]||0)+c*w)};
 entries.forEach(x=>{if(!x.log)return;workoutSessions(x.log).forEach(s=>(s.exercises||[]).forEach(e=>{const c=(e.sets||[]).filter(q=>q.completed).length;if(!c)return;total+=c;const ref=findExercise(e.exercise_id)||e;add(cmOf(ref),c,1);(e.secondary_muscles||ref.secondary_muscles||[]).forEach(sm=>{const k=cmName(sm);if(k&&k!==cmOf(ref))add(k,c,.5)})}))});
 const max=Math.max(0,...Object.values(reg)),den=Math.max(max,6);
 const top=Object.entries(byM).sort((a,b)=>b[1]-a[1]).slice(0,6),topMax=top.length?top[0][1]:1;
 const side=sd=>{const M=BODY_MODEL[gender()][sd];return `<svg viewBox="${M.vb}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Muscle workload, ${sd}"><path class="bm-ol" d="${M.ol}"/>${Object.entries(M.parts).map(([k,ds])=>{const v=reg[k]||0;return SLUG[k]?`<g class="bm-m" data-s="${k}" data-name="${safe(SLBL[k])}" data-v="${Math.round(v*10)/10}" style="${v?`--hc:${heatColor(v/den)}`:""}">${ds.map(d=>`<path d="${d}"/>`).join("")}</g>`:`<g class="bm-b">${ds.map(d=>`<path d="${d}"/>`).join("")}</g>`}).join("")}</svg>`};
 return `<div class="analysis-card heat-card"><div class="analysis-card-head"><div><div class="analysis-card-title">Muscle workload</div></div><span class="card-badge">${fmt(total)} sets</span></div>
 <div class="heat-grid"><div class="bm-stage heat-stage"><div class="bm-sd"><button type="button" data-heat-side="front" class="${G.heatSide==="front"?"on":""}">Front</button><button type="button" data-heat-side="back" class="${G.heatSide==="back"?"on":""}">Back</button></div><div class="bm-floor"></div><div class="bm-sway"><div class="bm-flip ${G.heatSide==="back"?"back":""}"><div class="bm-face f">${side("front")}</div><div class="bm-face b">${side("back")}</div></div></div></div>
 <div class="heat-side">${total?`<div class="heat-legend"><i></i><div><span>Light</span><span>${fmt(Math.round(den))} sets</span></div></div><div class="heat-read">Tap a muscle to see its sets</div><div class="heat-rank">${top.map(([m,v])=>`<div class="heat-row"><span>${safe(m)}</span><div><i style="width:${Math.max(6,v/topMax*100)}%;background:${heatColor(v/den)}"></i></div><b>${fmt(Math.round(v))}</b></div>`).join("")}</div><div class="heat-note">Colour = sets per muscle in this period. Muscles that assist a lift count half a set.</div>`:`<div class="empty-chart">Complete sets to colour the muscles you trained.</div>`}</div></div></div>`}
window.genOpen=open;window.genHeatCard=heatCard;window.genCleanup=cleanup;
})();
