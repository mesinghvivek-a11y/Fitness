/* Timely Fit PWA — offline-first, no runtime dependencies. */
const DB_NAME = 'forma_local_v1';
const DB_VERSION = 1;
const DEFAULT_PROFILE = { weightKg: 72.5, calorieTarget: 2200, proteinTarget: 130, waterTarget: 2500, eatBack: false };
const MEALS = [
  { key: 'breakfast', label: 'Breakfast', icon: '☀️', hint: 'Start your day' },
  { key: 'lunch', label: 'Lunch', icon: '🥗', hint: 'Midday fuel' },
  { key: 'dinner', label: 'Dinner', icon: '🌙', hint: 'Evening meal' },
  { key: 'snacks', label: 'Snacks', icon: '🍐', hint: 'Little extras' }
];
let db = null;
let masterFoods = [];
let masterExercises = [];
let state = freshState();
let expandedWaterLog = false;
let activeFoodSelection = null;
let activeFoodMeal = 'breakfast';
let editFoodEntryId = null;
let editExerciseIndex = null;
let activeExerciseSelection = null;
let exerciseDetailReturnState = null;
let recipeIngredients = [];
let activeRecipeIngredient = null;
let analyticsPeriod = 'weekly';
let supabaseClient = null;
let authUser = null;
let syncing = false;
let suppressDirtyTracking = false;
let saveQueue = Promise.resolve();
let lastRestTick = null;

function freshState() {
  return {
    version: 1,
    selectedDomain: 'diet',
    selectedTab: 'timeline',
    activeDate: toDateKey(new Date()),
    profile: { ...DEFAULT_PROFILE },
    logs: {},
    customFoods: [],
    recentFoodIds: [],
    recentExerciseIds: [],
    syncMeta: { dirtyDates: [], dirtyFoodIds: [], pendingProfile: false, hasCompletedSync: false, hasCompletedPull: false, userId: null, lastSyncedAt: null, lastCloudPullAt: null },
    profileUpdatedAt: null,
    preferences: { lastMasterSeed: 1 }
  };
}
function toDateKey(date) { const d = new Date(date); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
function parseDateKey(key) { const [y,m,d] = key.split('-').map(Number); return new Date(y,m-1,d,12,0,0); }
function shiftDate(key, days) { const d=parseDateKey(key); d.setDate(d.getDate()+days); return toDateKey(d); }
function weekStart(key) { const d=parseDateKey(key); const offset=(d.getDay()+6)%7; d.setDate(d.getDate()-offset); return toDateKey(d); }
function prettyShortDate(key) { return parseDateKey(key).toLocaleDateString('en-IN',{month:'short',day:'numeric'}); }
function prettyLongDate(key) { return parseDateKey(key).toLocaleDateString('en-IN',{weekday:'long',month:'long',day:'numeric'}); }
function timeLabel(iso) { if (!iso) return ''; const d = new Date(iso); return d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}); }
function $(id) { return document.getElementById(id); }
function uid(prefix='id') { return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,7)}`; }
function n(value) { const parsed=Number(value); return Number.isFinite(parsed)?parsed:0; }
function round(value, digits=0) { const m=10**digits; return Math.round((n(value)+Number.EPSILON)*m)/m; }
function fmt(value, digits=0) { return round(value,digits).toLocaleString('en-IN',{maximumFractionDigits:digits}); }
function clamp(value,min,max) { return Math.max(min,Math.min(max,value)); }
function pct(value,goal) { return goal>0?clamp(value/goal*100,0,100):0; }
function safe(str) { return String(str??'').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function currentLog(dateKey=state.activeDate) {
  if (!state.logs[dateKey]) state.logs[dateKey] = {
    date: dateKey,
    diet_log: { breakfast: [], lunch: [], dinner: [], snacks: [] },
    workout_log: null,
    workout_history: [],
    water_log: []
  };
  const log=state.logs[dateKey];
  if (!log.diet_log) log.diet_log={breakfast:[],lunch:[],dinner:[],snacks:[]};
  for (const meal of ['breakfast','lunch','dinner','snacks']) if (!Array.isArray(log.diet_log[meal])) log.diet_log[meal]=[];
  if (!Array.isArray(log.water_log)) log.water_log=[];
  if (!Array.isArray(log.workout_history)) log.workout_history=[];
  return log;
}
function workoutSessions(log) {
  const sessions=[...(log.workout_history||[])];
  if (log.workout_log) sessions.push(log.workout_log);
  return sessions;
}
function logHasData(log) {
  if(!log)return false;
  if((log.water_log||[]).length)return true;
  if(workoutSessions(log).some(session=>(session.exercises||[]).length>0))return true;
  return MEALS.some(meal=>(log.diet_log?.[meal.key]||[]).length>0);
}
function logTotals(log) {
  const macros={calories:0,protein:0,carbs:0,fat:0,fiber:0};
  for (const meal of MEALS) for (const item of (log.diet_log?.[meal.key]||[])) {
    for (const k of Object.keys(macros)) macros[k]+=n(item.macros?.[k]);
  }
  const water= (log.water_log||[]).reduce((sum,item)=>sum+n(item.amount_ml),0);
  const sessions=workoutSessions(log);
  const burned=sessions.reduce((sum,s)=>sum+n(s.total_calories_burned),0);
  const net=macros.calories-(state.profile.eatBack?burned:0);
  return {...macros,water,burned,net,remaining:state.profile.calorieTarget+(state.profile.eatBack?burned:0)-macros.calories};
}
function activeLog() { return currentLog(state.activeDate); }
function allFoods() { return [...masterFoods,...(state.customFoods||[])]; }
function findFood(id) { return allFoods().find(food=>food.id===id); }
function findExercise(id) { return masterExercises.find(ex=>ex.id===id); }
/* ---------- shared UI helpers ---------- */
function sheetHead(title) { return `<div class="modal-handle"></div><div class="modal-head"><h2>${title}</h2><button class="close-modal" data-action="close-modal" aria-label="Close">×</button></div>`; }
function autoMeal() { const h=new Date().getHours(); return h<11?'breakfast':h<16?'lunch':h<21?'dinner':'snacks'; }
function renderFoodThumb(food) {
  const glyph=nutritionEmoji(food);
  const img=food?.image?`<img src="${safe(food.image)}" alt="" loading="lazy" onerror="this.hidden=true;this.nextElementSibling.hidden=false"><span class="thumb-fallback" hidden>${glyph}</span>`:`<span class="thumb-fallback">${glyph}</span>`;
  return `<span class="thumb">${img}</span>`;
}
/* Which fields an exercise needs: weight + reps, reps only (body-weight), or minutes (timed/cardio). */
const WEIGHT_EQUIPMENT=/barbell|dumbbell|cable|machine|smith|kettlebell|weighted|assisted|sled|medicine|ez[ -]|plate|trap bar|hex|olympic|lever/i;
function exerciseMode(ex) {
  const m=ex?.tracking_metrics||['weight','reps'];
  if(m.includes('duration')&&!m.includes('reps'))return 'time';
  if(!m.includes('weight'))return 'reps';
  return WEIGHT_EQUIPMENT.test(String(ex?.equipment||''))?'weight':'reps';
}
function entryMode(ex) {
  if(ex.mode)return ex.mode;
  if((ex.sets||[]).some(s=>n(s.weight)>0))return 'weight';
  return exerciseMode(findExercise(ex.exercise_id)||ex);
}
/* Muscle search: "chest" also finds pectoral work whose name never says chest. */
const MUSCLE_SYNONYMS=[['chest','pectorals','pectoral','pecs','pec'],['lats','lat','latissimus','latissimus dorsi'],['traps','trapezius'],['delts','delt','deltoids','deltoid','shoulder','shoulders'],['abs','abdominals','abdominal','core'],['quads','quad','quadriceps'],['hamstrings','hamstring'],['glutes','glute','hips'],['calves','calf','soleus'],['biceps','bicep'],['triceps','tricep'],['forearms','forearm','grip','wrist','wrists'],['spine','erector','lower back'],['cardio','cardiovascular','cardiovascular system','conditioning']];
const MUSCLE_REGIONS={back:['back','lats','traps','rhomboids','upper back','lower back','spine','posterior chain'],arm:['arms','biceps','triceps','forearms','upper arms','lower arms','brachialis'],arms:['arms','biceps','triceps','forearms','upper arms','lower arms','brachialis'],leg:['legs','quads','quadriceps','hamstrings','glutes','calves','adductors','abductors','upper legs','lower legs','soleus'],legs:['legs','quads','quadriceps','hamstrings','glutes','calves','adductors','abductors','upper legs','lower legs','soleus'],core:['abs','core','obliques','waist','abdominals'],abs:['abs','core','obliques','waist','abdominals']};
function expandTerms(word) {
  const w=word.toLowerCase(),singular=w.endsWith('s')?w.slice(0,-1):w,terms=new Set([w]);
  for(const group of MUSCLE_SYNONYMS)if(group.includes(w)||group.includes(singular))group.forEach(t=>terms.add(t));
  for(const key of Object.keys(MUSCLE_REGIONS))if(w===key||singular===key)MUSCLE_REGIONS[key].forEach(t=>terms.add(t));
  return [...terms];
}
function searchExercises(query) {
  const words=String(query||'').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if(!words.length)return [];
  const prepared=words.map(w=>({w,terms:expandTerms(w)}));
  const found=[];
  for(const ex of masterExercises){
    const name=String(ex.name||'').toLowerCase();
    const primary=[ex.primary_muscle,ex.target,ex.source_target,ex.body_part,ex.muscle_group,ex.category,ex.equipment].filter(Boolean).join(' ').toLowerCase();
    const secondary=(ex.secondary_muscles||[]).join(' ').toLowerCase();
    let tier=0,ok=true;
    for(const {w,terms} of prepared){
      let t;
      if(new RegExp('(^|[^a-z0-9])'+w.replace(/[^a-z0-9]/g,'')).test(name))t=0;
      else if(terms.some(x=>primary.includes(x)))t=1;
      else if(terms.some(x=>secondary.includes(x)))t=2;
      else {ok=false;break;}
      if(t>tier)tier=t;
    }
    if(ok)found.push({ex,tier,starts:name.startsWith(words[0])?0:1});
  }
  found.sort((x,y)=>x.tier-y.tier||x.starts-y.starts||String(x.ex.name).length-String(y.ex.name).length||String(x.ex.name).localeCompare(String(y.ex.name)));
  const seen=new Set();
  return found.filter(item=>{const key=String(item.ex.name||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();if(seen.has(key))return false;seen.add(key);return true;});
}
function searchFoods(query,pool) {
  const words=String(query||'').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const found=[];
  for(const food of pool){
    const name=String(food.name||'').toLowerCase();
    const extra=`${(food.tags||[]).join(' ')} ${food.type==='raw_ingredient'?'ingredient raw':food.type==='custom_recipe'?'recipe':'meal cooked'}`.toLowerCase();
    let tier=0,ok=true;
    for(const w of words){if(name.includes(w))continue;if(extra.includes(w)){tier=1;continue;}ok=false;break;}
    if(ok)found.push({food,tier,starts:name.startsWith(words[0])?0:name.split(/[^a-z0-9]+/).some(part=>part.startsWith(words[0]))?1:2});
  }
  found.sort((x,y)=>x.tier-y.tier||x.starts-y.starts||String(x.food.name).length-String(y.food.name).length||String(x.food.name).localeCompare(String(y.food.name)));
  if(found.length)return found.map(x=>x.food);
  return pool.map(food=>({food,score:searchScore(query,food.name)})).filter(x=>x.score>=10).sort((x,y)=>y.score-x.score).slice(0,20).map(x=>x.food);
}
function exerciseHasLicensedMedia(ex) { return ex?.media_status==='licensed' && !!ex.image && !!ex.gif_url; }
function renderExerciseThumbnail(ex,size='regular') {
  const glyph=exerciseEmoji(ex?.primary_muscle||ex?.target||'');
  const licensed=exerciseHasLicensedMedia(ex);
  const image=licensed ? `<img src="${safe(ex.image)}" alt="" loading="lazy" onerror="this.hidden=true;this.nextElementSibling.hidden=false"><span class="exercise-thumb-placeholder" hidden>${glyph}</span>` : `<span class="exercise-thumb-placeholder">${glyph}</span>`;
  return `<button type="button" class="exercise-media-trigger ${size}" data-action="open-exercise-detail" data-id="${safe(ex?.id||'')}" aria-label="View ${safe(ex?.name||'exercise')} demonstration">${image}</button>`;
}
function exerciseShortDescription(ex) {
  const description=String(ex?.description||'').trim();
  if(description) return description;
  const target=String(ex?.primary_muscle||ex?.body_part||'muscles').toLowerCase();
  const equipment=String(ex?.equipment||'bodyweight').toLowerCase();
  return `A ${target} exercise using ${equipment}.`;
}
function foodIsRaw(food) { return food?.type==='raw_ingredient'; }
function unitScale(unit) {
  const u=String(unit||'').toLowerCase();
  return ['kg','l','litre','liter','litres','liters'].includes(u) ? 1000 : 1;
}
function foodMacros(food, amount, unit=foodAmountUnit(food)) {
  const amountN=Math.max(0,n(amount));
  if (!food) return {calories:0,protein:0,carbs:0,fat:0,fiber:0};
  const u=String(unit||foodAmountUnit(food)).toLowerCase();
  if (food.macros_per_100ml) {
    const base=amountN*unitScale(u);
    const result={};
    for(const key of ['calories','protein','carbs','fat','fiber']) result[key]=round(n(food.macros_per_100ml[key])*base/100,2);
    return result;
  }
  if (food.macros_per_100g) {
    let base=amountN*unitScale(u);
    if(food.serving_unit==='scoop' && u==='scoop') base=amountN*n(food.default_serving_size||30);
    // Legacy entries that use ml with macros_per_100g are treated as per 100 ml.
    const result={};
    for(const key of ['calories','protein','carbs','fat','fiber']) result[key]=round(n(food.macros_per_100g[key])*base/100,2);
    return result;
  }
  const per=food.macros_per_serving||{};
  const normalizedAmount=amountN*unitScale(u);
  const servingScale=food.type==='custom_recipe' ? amountN : normalizedAmount/Math.max(.001,n(food.default_serving_size)||1);
  const result={};
  for(const key of ['calories','protein','carbs','fat','fiber']) result[key]=round(n(per[key])*servingScale,2);
  return result;
}
function defaultFoodAmount(food) {
  if (!food) return 1;
  if (food.serving_unit==='scoop') return 1;
  return n(food.default_serving_size)||1;
}
function foodAmountUnit(food) { return food?.serving_unit || (foodIsRaw(food)?'g':'serving'); }
function amountLabel(food, amount, unit=foodAmountUnit(food)) { const label=String(unit||foodAmountUnit(food)); return `${fmt(amount, amount%1?2:0)} ${label}${amount!==1 && ['piece','bowl','glass','slice','serving','scoop','handful','plate','roll','burger'].includes(label.toLowerCase())?'s':''}`; }
function foodUnits(food) { const unit=String(foodAmountUnit(food)).toLowerCase(); if(unit==='g')return ['g','kg']; if(unit==='ml')return ['ml','L']; return [foodAmountUnit(food)]; }
function recentIds(list,id,limit=3) { return [id,...(list||[]).filter(x=>x!==id)].slice(0,limit); }
function markDateDirty(dateKey=state.activeDate) { if(suppressDirtyTracking)return; const log=currentLog(dateKey); log.updated_at=new Date().toISOString(); state.syncMeta=state.syncMeta||{dirtyDates:[],dirtyFoodIds:[],pendingProfile:false,hasCompletedSync:false,userId:null,lastSyncedAt:null}; state.syncMeta.dirtyDates=Array.from(new Set([...(state.syncMeta.dirtyDates||[]),dateKey])); }
function nutritionEmoji(food) {
  const tags=food?.tags||[]; const name=(food?.name||'').toLowerCase();
  if (name.includes('whey')||name.includes('soya')||name.includes('paneer')||name.includes('tofu')) return '🥛';
  if (name.includes('rice')||name.includes('roti')||name.includes('atta')||name.includes('oat')||name.includes('poha')||name.includes('upma')) return '🌾';
  if (name.includes('dal')||name.includes('lentil')||name.includes('chickpea')||name.includes('sprout')) return '🫘';
  if (name.includes('banana')||name.includes('apple')||name.includes('orange')) return '🍌';
  if (name.includes('sabzi')||name.includes('spinach')||name.includes('vegetable')||name.includes('peas')) return '🥬';
  if (tags.includes('snack')||name.includes('almond')||name.includes('peanut')) return '🥜';
  return food?.type==='custom_recipe'?'🍲':'🍽️';
}

// IndexedDB: master data is cached once; the active app state is persisted locally.
function openDatabase() {
  return new Promise((resolve,reject)=>{
    if (!('indexedDB' in window)) return resolve(null);
    const request=indexedDB.open(DB_NAME,DB_VERSION);
    request.onupgradeneeded=()=>{
      const database=request.result;
      if(!database.objectStoreNames.contains('kv')) database.createObjectStore('kv',{keyPath:'key'});
      if(!database.objectStoreNames.contains('foods')) database.createObjectStore('foods',{keyPath:'id'});
      if(!database.objectStoreNames.contains('exercises')) database.createObjectStore('exercises',{keyPath:'id'});
    };
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>reject(request.error);
  });
}
function idbRequest(storeName, method, value) {
  return new Promise((resolve,reject)=>{
    if(!db) return resolve(null);
    const tx=db.transaction(storeName,method==='getAll'?'readonly':'readwrite');
    const store=tx.objectStore(storeName);
    const req=method==='get'?store.get(value):method==='getAll'?store.getAll():method==='put'?store.put(value):method==='clear'?store.clear():null;
    if(!req) return resolve(null);
    req.onsuccess=()=>resolve(req.result??null); req.onerror=()=>reject(req.error);
  });
}
function idbReplaceAll(storeName,items) {
  return new Promise((resolve,reject)=>{
    if(!db)return resolve(null);
    const tx=db.transaction(storeName,'readwrite');const store=tx.objectStore(storeName);
    store.clear();for(const item of items)store.put(item);
    tx.oncomplete=()=>resolve(true);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||new Error('IndexedDB transaction aborted'));
  });
}
async function readMaster(storeName, fileName) {
  let cached=[];
  try { cached=await idbRequest(storeName,'getAll')||[]; } catch(_) {}
  try {
    const response=await fetch(fileName,{cache:'no-cache'});
    if(!response.ok) throw new Error(`Could not load ${fileName}`);
    const items=await response.json();
    if(db) await idbReplaceAll(storeName,items);
    return items;
  } catch(error) {
    console.warn(`Using cached ${fileName} because refresh failed:`,error);
    return cached;
  }
}
async function persistState() {
  const snapshot=JSON.parse(JSON.stringify(state));
  try {
    if(db) await idbRequest('kv','put',{key:'app_state',value:snapshot});
    try { localStorage.setItem('forma_state_fallback',JSON.stringify(snapshot)); } catch(_) {}
    refreshSyncStatus();
  } catch(error) { console.error(error); setSyncStatus('Local save issue',true); }
}
let saveTimer=null;
function scheduleSave(markCurrentDate=true) {
  if(!suppressDirtyTracking&&markCurrentDate) markDateDirty(state.activeDate);
  setSyncStatus('Saving locally…',false);
  clearTimeout(saveTimer);
  saveTimer=setTimeout(()=>{ saveQueue=saveQueue.then(persistState).catch(console.error); },180);
}
function setSyncStatus(text,error=false) {
  const el=$('syncStatus');if(!el)return;
  el.innerHTML=`<span class="sync-dot" style="background:${error?'#ef987b':syncing?'#f3bd61':'#9bbd61'}"></span><span>${safe(text)}</span>`;
}
function refreshSyncStatus() {
  if(syncing){setSyncStatus('Syncing…');return;}
  const meta=state.syncMeta||{};
  const dirty=(meta.dirtyDates||[]).length+(meta.dirtyFoodIds||[]).length+(meta.pendingProfile?1:0);
  if(authUser) setSyncStatus(dirty?'Signed in · unsynced changes':'Signed in · synced');
  else setSyncStatus('Saved locally');
}
function registerServiceWorker() {
  if ('serviceWorker' in navigator && (location.protocol==='https:'||location.hostname==='localhost'||location.hostname==='127.0.0.1')) {
    navigator.serviceWorker.register('./sw.js').catch(err=>console.info('Offline cache not enabled:',err));
  }
}
async function initialise() {
  try { db=await openDatabase(); } catch(error) { console.warn('IndexedDB unavailable; using local storage',error); }
  const stored=db?await idbRequest('kv','get','app_state').catch(()=>null):null;
  if(stored?.value) state={...freshState(),...stored.value,profile:{...DEFAULT_PROFILE,...stored.value.profile}};
  else {
    try { const local=JSON.parse(localStorage.getItem('forma_state_fallback')||'null'); if(local) state={...freshState(),...local,profile:{...DEFAULT_PROFILE,...local.profile}}; } catch(_) {}
  }
  if(state.selectedTab==='analyze') state.selectedTab='dashboard';
  state.recentFoodIds=Array.isArray(state.recentFoodIds)?state.recentFoodIds:[];
  state.recentExerciseIds=Array.isArray(state.recentExerciseIds)?state.recentExerciseIds:[];
  state.syncMeta={...freshState().syncMeta,...(state.syncMeta||{})};
  masterFoods=await readMaster('foods','foods.json');
  masterExercises=await readMaster('exercises','exercises.json');
  if(!masterFoods.length)masterFoods=offlineFoodsFallback();
  if(!masterExercises.length)masterExercises=offlineExercisesFallback();
  currentLog(state.activeDate);
  await initialiseSupabase();
  render();
  registerServiceWorker();
  await persistState();
}
function offlineFoodsFallback() { return [{id:'food_101',name:'Soya Chunks (Dry/Raw)',type:'raw_ingredient',serving_unit:'g',default_serving_size:50,macros_per_100g:{calories:345,protein:52,carbs:33,fat:.5,fiber:13},tags:['high-protein']},{id:'food_105',name:'Rice (Dry/Raw)',type:'raw_ingredient',serving_unit:'g',default_serving_size:75,macros_per_100g:{calories:365,protein:7.1,carbs:80,fat:.7,fiber:1.3},tags:['pantry']},{id:'food_125',name:'Besan Chilla (Cooked Estimate) *',type:'standard_estimate',serving_unit:'piece',default_serving_size:1,macros_per_serving:{calories:140,protein:7,carbs:18,fat:4.5,fiber:3},tags:['breakfast','estimate']}]; }
function offlineExercisesFallback() { return [{id:'ex_101',name:'Barbell Bench Press',category:'Compound',primary_muscle:'Chest',secondary_muscles:['Triceps'],equipment:'Barbell',default_rest_sec:120,met_value:6,tracking_metrics:['weight','reps']},{id:'ex_102',name:'Barbell Back Squat',category:'Compound',primary_muscle:'Legs/Quadriceps',secondary_muscles:['Glutes'],equipment:'Barbell',default_rest_sec:150,met_value:6,tracking_metrics:['weight','reps']}]; }

function render() {
  if(!authUser) { updateAuthGate(); return; }
  updateAuthGate();
  document.querySelectorAll('.domain-tab').forEach(btn=>btn.classList.toggle('active',btn.dataset.domain===state.selectedDomain));
  document.querySelectorAll('.bottom-tab').forEach(btn=>btn.classList.toggle('active',btn.dataset.tab===state.selectedTab));
  const datePicker=$('datePicker');if(datePicker)datePicker.value=state.activeDate;
  const dateStrip=document.querySelector('.date-strip');if(dateStrip)dateStrip.classList.toggle('hidden',state.selectedTab!=='timeline');
  renderDates();
  $('mainContent').innerHTML=state.selectedTab==='timeline'?renderTimeline():renderAnalytics();
}
function renderDates() {
  const host=$('dateOptions'); if(!host)return;
  const dates=[-2,-1,0,1,2].map(offset=>shiftDate(state.activeDate,offset));
  const today=toDateKey(new Date());
  host.innerHTML=dates.map(key=>{
    const d=parseDateKey(key); const day=d.toLocaleDateString('en-IN',{weekday:'short'}).toUpperCase();
    const active=key===state.activeDate; const istoday=key===today;
    return `<button class="date-pill ${active?'active':''} ${istoday?'today':''}" data-action="choose-date" data-date="${key}"><span class="date-day">${istoday?'TODAY':day}</span><strong>${d.toLocaleDateString('en-IN',{month:'short',day:'numeric'})}</strong></button>`;
  }).join('');
}
function renderTimeline() {
  const log=activeLog();
  const totals=logTotals(log);
  if(state.selectedDomain==='diet')return renderDiet(log,totals);
  if(state.selectedDomain==='workout')return renderWorkout(log,totals);
  return renderWater(log,totals);
}

function itemsCount(log) { return MEALS.reduce((sum,meal)=>sum+(log.diet_log[meal.key]||[]).length,0); }
function renderDiet(log,totals) {
  const meals=MEALS.map(meal=>{
    const items=log.diet_log[meal.key]||[];
    const kcal=items.reduce((sum,item)=>sum+n(item.macros?.calories),0);
    const rows=items.map(item=>`<article class="food-entry">
      ${renderFoodThumb(findFood(item.food_id)||item)}
      <div class="food-entry-copy"><div class="food-entry-name">${safe(item.name)}</div><div class="food-entry-meta">${safe(item.amount_label||`${fmt(item.amount)} ${item.unit||''}`)} · P ${fmt(item.macros?.protein,1)} · C ${fmt(item.macros?.carbs,1)} · F ${fmt(item.macros?.fat,1)}</div></div>
      <div class="food-entry-macros">${fmt(item.macros?.calories)}<small> kcal</small></div>
      <div class="entry-tools"><button class="mini-icon" title="Edit entry" aria-label="Edit ${safe(item.name)}" data-action="edit-food" data-id="${item.entry_id}">✎</button><button class="mini-icon" title="Delete entry" aria-label="Delete ${safe(item.name)}" data-action="delete-food" data-id="${item.entry_id}">×</button></div>
    </article>`).join('');
    return `<section class="meal-section"><div class="meal-head"><div class="meal-title"><span class="meal-symbol">${meal.icon}</span>${meal.label}</div><div class="meal-side"><span class="meal-meta">${kcal?fmt(kcal)+' kcal':''}</span><button class="meal-add" data-action="open-food" data-meal="${meal.key}" aria-label="Add to ${meal.label}">＋</button></div></div>${rows?`<div class="meal-items">${rows}</div>`:''}</section>`;
  }).join('');
  return `<div class="day-summary"><div><strong>${fmt(totals.calories)}</strong><span>kcal</span></div><div><strong>${fmt(totals.protein,1)}</strong><span>protein g</span></div><div><strong>${fmt(totals.carbs,1)}</strong><span>carbs g</span></div><div><strong>${fmt(totals.fat,1)}</strong><span>fat g</span></div><div><strong>${fmt(totals.fiber,1)}</strong><span>fiber g</span></div></div>${meals}`;
}
function renderWorkout(log,totals) {
  const workout=log.workout_log;
  if(!workout) {
    const completed=(log.workout_history||[]).slice().reverse();
    const history=completed.map(session=>{
      const exercises=session.exercises||[];const sets=exercises.reduce((sum,ex)=>sum+ex.sets.filter(st=>st.completed).length,0);
      return `<article class="exercise-card"><div class="exercise-card-header"><div class="exercise-icon">✅</div><div class="exercise-main"><div class="exercise-name">Session complete</div><div class="exercise-meta">${session.end_time?timeLabel(session.end_time)+' · ':''}${fmt(session.duration_minutes||0,1)} min · ${exercises.length} exercises · ${sets} sets${n(session.total_calories_burned)?` · ${fmt(session.total_calories_burned)} kcal`:''}</div></div></div></article>`;
    }).join('');
    return `<section class="empty-card"><div class="empty-graphic">🏋️</div><h3>No exercises yet</h3><button class="primary-button" data-action="add-exercise">＋ Add exercise</button></section>${history?`<div class="section-title-row"><h3>Completed today</h3></div>${history}`:''}`;
  }
  const isStarted=!!workout.start_ms&&!workout.ended;
  const exerciseCards=(workout.exercises||[]).map((ex,index)=>renderExerciseCard(ex,index,workout)).join('');
  const doneSets=(workout.exercises||[]).reduce((sum,ex)=>sum+ex.sets.filter(s=>s.completed).length,0);
  const allSets=(workout.exercises||[]).reduce((sum,ex)=>sum+ex.sets.length,0);
  const volume=(workout.exercises||[]).reduce((sum,ex)=>sum+ex.sets.reduce((s,set)=>s+n(set.weight)*n(set.reps)*(set.completed?1:0),0),0);
  return `<section class="session-bar"><div><strong>${doneSets}/${allSets} sets</strong><span>${isStarted?durationLabel(Date.now()-workout.start_ms):'Not started'}${volume?` · ${fmt(volume)} kg volume`:''}</span></div><button class="primary-button ${isStarted?'lime':''}" data-action="${isStarted?'finish-session':'start-session'}">${isStarted?'⏹ Finish':'▶ Start'}</button></section>
    <div class="section-title-row"><h3>Exercises</h3><button class="muted-link" data-action="add-exercise">＋ Add</button></div>
    ${exerciseCards}`;
}
function durationLabel(ms) { const mins=Math.max(0,Math.floor(ms/60000)); return mins>=60?`${Math.floor(mins/60)}h ${mins%60}m`:`${mins} min`; }
function calcVolume(workout) { return fmt((workout.exercises||[]).reduce((sum,ex)=>sum+ex.sets.reduce((s,set)=>s+n(set.weight)*n(set.reps)*(set.completed?1:0),0),0)); }
function renderExerciseCard(ex,index,workout) {
  const started=!!ex.started && !ex.finished;
  const done=!!ex.finished;
  const mode=entryMode(ex);const withWeight=mode==='weight';
  const completedSets=ex.sets.filter(s=>s.completed).length;
  const totalVolume=ex.sets.reduce((sum,s)=>sum+(s.completed?n(s.weight)*n(s.reps):0),0);
  const repsLabel=mode==='time'?'MIN':'REPS';
  const sets=ex.sets.map((set,sidx)=>`<div class="set-row ${withWeight?'':'no-weight'}"><div class="set-num">${sidx+1}</div>${withWeight?`<input class="set-input" type="number" inputmode="decimal" min="0" step="0.5" aria-label="Weight for set ${sidx+1}" value="${safe(set.weight??0)}" data-role="set-weight" data-ex-index="${index}" data-set-index="${sidx}" ${done?'disabled':''}/>`:''}<input class="set-input" type="number" inputmode="decimal" min="0" step="${mode==='time'?'0.5':'1'}" aria-label="${mode==='time'?'Minutes':'Reps'} for set ${sidx+1}" value="${safe(set.reps??10)}" data-role="set-reps" data-ex-index="${index}" data-set-index="${sidx}" ${done?'disabled':''}/><button class="set-complete ${set.completed?'checked':''}" data-action="complete-set" data-ex-index="${index}" data-set-index="${sidx}" ${done?'disabled':''} aria-label="Mark set ${sidx+1} complete">${set.completed?'✓':'○'}</button></div>`).join('');
  const restSec=n(ex.default_rest_sec||60);
  const reference=findExercise(ex.exercise_id)||ex;
  return `<article class="exercise-card"><div class="exercise-card-header">${renderExerciseThumbnail(reference,'timeline')}<div class="exercise-main"><div class="exercise-name">${safe(ex.name)}</div><div class="exercise-meta">${safe(ex.primary_muscle||'Full body')} · ${safe(ex.equipment||'Bodyweight')}</div></div><span class="exercise-state ${done?'done':''}">${done?'DONE':`${completedSets}/${ex.sets.length}`}</span><button type="button" class="mini-icon" data-action="edit-exercise" data-ex-index="${index}" aria-label="Edit ${safe(ex.name)}">✎</button></div>
    <div class="exercise-start-row"><div class="exercise-stats">${ex.sets.length} sets${withWeight&&totalVolume?` · ${fmt(totalVolume)} kg`:''}</div><button class="exercise-start ${started?'running':''}" data-action="${started?'toggle-exercise':'start-exercise'}" data-ex-index="${index}" ${done?'disabled':''}>${done?'✓ Complete':started?'⌄ Sets open':'▶ Start'}</button></div>
    ${started?`<div class="sets-panel"><div class="sets-header ${withWeight?'':'no-weight'}"><span>SET</span>${withWeight?'<span>KG</span>':''}<span>${repsLabel}</span><span></span></div>${sets}<div class="set-actions"><button class="outline-button full" data-action="add-set" data-ex-index="${index}">＋ Add set</button><button class="outline-button full" data-action="finish-exercise" data-ex-index="${index}">Finish exercise</button></div>${ex.rest_until&&ex.last_completed_set!=null?`<div class="rest-timer"><div class="rest-timer-text">⏱ <span>Rest</span> <span class="rest-clock" id="rest-clock" data-until="${ex.rest_until}">--:--</span></div><div class="timer-adjust"><button data-action="adjust-rest" data-ex-index="${index}" data-seconds="-30">−30s</button><button data-action="adjust-rest" data-ex-index="${index}" data-seconds="30">+30s</button></div></div>`:''}</div>`:''}</article>`;
}
function exerciseEmoji(muscle='') { const x=String(muscle).toLowerCase(); if(x.includes('chest'))return '🏋️';if(x.includes('back'))return '🧗';if(x.includes('leg')||x.includes('hamstring')||x.includes('glute'))return '🦵';if(x.includes('arm')||x.includes('bicep')||x.includes('tricep'))return '💪';if(x.includes('core'))return '🧘';if(x.includes('shoulder'))return '🏋️';if(x.includes('full'))return '🏃';return '🏋️'; }
function renderWater(log,totals) {
  const goal=state.profile.waterTarget;const percentage=pct(totals.water,goal);
  const sorted=[...(log.water_log||[])].sort((a,b)=>String(b.timestamp).localeCompare(String(a.timestamp)));
  const visible=expandedWaterLog?sorted:sorted.slice(0,4);
  const rows=visible.map(item=>`<div class="water-log-row"><div class="water-log-icon">💧</div><div class="water-log-info"><strong>${fmt(item.amount_ml)} ml</strong><span>${timeLabel(item.timestamp)}</span></div><div class="water-entry-actions"><button class="mini-icon" data-action="edit-water" data-id="${safe(item.entry_id||item.timestamp)}" aria-label="Edit water entry">✎</button><button class="mini-icon" data-action="delete-water" data-id="${safe(item.entry_id||item.timestamp)}" aria-label="Delete water entry">×</button></div></div>`).join('');
  return `<section class="water-card"><div class="water-big">${fmt(totals.water)}<span> / ${fmt(goal)} ml</span></div><div class="water-sub">${percentage>=100?'Goal reached':`${fmt(Math.max(0,goal-totals.water))} ml to go`}</div><div class="water-progress"><div style="width:${percentage}%"></div></div>
    <div class="water-quick"><button data-action="add-water" data-amount="250">💧 250 ml</button><button data-action="add-water" data-amount="500">🥤 500 ml</button><button class="custom" data-action="add-water" data-amount="custom">Custom</button></div></section>
    <div class="section-title-row"><h3>Today</h3>${sorted.length>4?`<button class="muted-link" data-action="toggle-water-log">${expandedWaterLog?'Show less':`Show all ${sorted.length}`}</button>`:''}</div>
    <div class="water-log-list">${rows||'<div class="empty-state">No water logged yet.</div>'}</div>`;
}
function periodDates() {
  if(analyticsPeriod==='daily') return [state.activeDate];
  if(analyticsPeriod==='weekly') { const start=weekStart(state.activeDate);return Array.from({length:7},(_,i)=>shiftDate(start,i)); }
  const date=parseDateKey(state.activeDate);const start=new Date(date.getFullYear(),date.getMonth(),1,12);const days=new Date(date.getFullYear(),date.getMonth()+1,0).getDate();return Array.from({length:days},(_,i)=>toDateKey(new Date(start.getFullYear(),start.getMonth(),i+1,12)));
}
function logsForPeriod() { return periodDates().map(date=>({date,log:state.logs[date]||null,totals:state.logs[date]?logTotals(state.logs[date]):{calories:0,protein:0,carbs:0,fat:0,fiber:0,water:0,burned:0,net:0}})); }
function periodLabel() {
  if(analyticsPeriod==='daily') return parseDateKey(state.activeDate).toLocaleDateString('en-IN',{weekday:'short',day:'numeric',month:'short',year:'numeric'});
  if(analyticsPeriod==='weekly') { const start=weekStart(state.activeDate),end=shiftDate(start,6);return `${prettyShortDate(start)} – ${prettyShortDate(end)}`; }
  return parseDateKey(state.activeDate).toLocaleDateString('en-IN',{month:'long',year:'numeric'});
}
function shiftAnalyticsPeriod(delta) {
  if(analyticsPeriod==='daily') state.activeDate=shiftDate(state.activeDate,delta);
  else if(analyticsPeriod==='weekly') state.activeDate=shiftDate(state.activeDate,delta*7);
  else { const d=parseDateKey(state.activeDate);const day=d.getDate();d.setDate(1);d.setMonth(d.getMonth()+delta);d.setDate(Math.min(day,new Date(d.getFullYear(),d.getMonth()+1,0).getDate()));state.activeDate=toDateKey(d); }
  currentLog();render();persistState();
}
function renderDashboardTargets() {
  const entries=logsForPeriod();const days=Math.max(1,entries.length);
  const sum=entries.reduce((acc,x)=>({net:acc.net+x.totals.net,protein:acc.protein+x.totals.protein,water:acc.water+x.totals.water,burned:acc.burned+x.totals.burned}),{net:0,protein:0,water:0,burned:0});
  const values={net:sum.net/days,protein:sum.protein/days,water:sum.water/days};
  const left=Math.max(0,state.profile.calorieTarget-values.net);
  const rows=[
    {label:state.profile.eatBack?'Net calories':'Calories',value:values.net,goal:state.profile.calorieTarget,unit:'kcal',kind:'calorie'},
    {label:'Protein',value:values.protein,goal:state.profile.proteinTarget,unit:'g',kind:'protein'},
    {label:'Water',value:values.water,goal:state.profile.waterTarget,unit:'ml',kind:'water'}
  ];
  return `<section class="target-card"><div class="target-label">${analyticsPeriod==='daily'?'Targets':'Daily average'}</div><div class="progress-stack">${rows.map(row=>`<div class="progress-row"><div class="progress-label">${row.label}</div><div class="progress-track"><div class="progress-fill ${row.kind==='protein'?'protein':row.kind==='water'?'water':''}" style="width:${pct(row.value,row.goal)}%"></div></div><div class="progress-value">${fmt(row.value,row.kind==='water'?0:1)}<span> / ${fmt(row.goal)}${row.unit}</span></div></div>`).join('')}</div><div class="target-foot">${fmt(left)} kcal left${state.profile.eatBack?` · includes ${fmt(sum.burned/days)} kcal workout burn`:''}</div></section>`;
}
function chartBuckets(entries,valueFn,goalFn=()=>0) {
  if(!entries.length)return [];
  const toPoint=(group,label)=>({label,value:round(group.reduce((sum,x)=>sum+n(valueFn(x)),0)/Math.max(1,group.length),1),goal:round(group.reduce((sum,x)=>sum+n(typeof goalFn==='function'?goalFn(x):goalFn),0)/Math.max(1,group.length),1)});
  if(analyticsPeriod==='daily')return [toPoint(entries,parseDateKey(entries[0].date).toLocaleDateString('en-IN',{day:'numeric',month:'short'}))];
  if(analyticsPeriod==='weekly')return entries.map(x=>({label:parseDateKey(x.date).toLocaleDateString('en-IN',{weekday:'short'}),value:round(n(valueFn(x)),1),goal:round(n(typeof goalFn==='function'?goalFn(x):goalFn),1)}));
  const out=[];for(let i=0;i<entries.length;i+=7){const group=entries.slice(i,i+7);const first=parseDateKey(group[0].date).getDate();const last=parseDateKey(group[group.length-1].date).getDate();out.push(toPoint(group,`${first}–${last}`));}return out;
}
function aggregateMealLog(entries) {
  const diet_log={};for(const meal of MEALS)diet_log[meal.key]=entries.flatMap(x=>x.log?.diet_log?.[meal.key]||[]);
  return {diet_log};
}
function muscleHeatKey(name) {
  const x=String(name||'').toLowerCase();
  if(x.includes('chest'))return 'Chest';if(x.includes('back')||x.includes('lat'))return 'Back';if(x.includes('shoulder')||x.includes('deltoid'))return 'Shoulders';
  if(x.includes('arm')||x.includes('bicep')||x.includes('tricep')||x.includes('forearm'))return 'Arms';if(x.includes('leg')||x.includes('quad')||x.includes('hamstring')||x.includes('glute')||x.includes('calf'))return 'Legs';
  if(x.includes('core')||x.includes('abs')||x.includes('oblique'))return 'Core';if(x.includes('cardio')||x.includes('full body')||x.includes('conditioning'))return 'Cardio';return 'Other';
}
function renderWorkoutHeatmap(entries) {
  const rows=['Chest','Back','Shoulders','Arms','Legs','Core','Cardio'];
  let buckets=[];
  if(analyticsPeriod==='daily')buckets=[{label:parseDateKey(entries[0]?.date||state.activeDate).toLocaleDateString('en-IN',{day:'numeric',month:'short'}),dates:entries.map(x=>x.date)}];
  else if(analyticsPeriod==='weekly')buckets=entries.map(x=>({label:parseDateKey(x.date).toLocaleDateString('en-IN',{weekday:'narrow'}),dates:[x.date]}));
  else {for(let i=0;i<entries.length;i+=7){const group=entries.slice(i,i+7);buckets.push({label:`W${buckets.length+1}`,dates:group.map(x=>x.date)});}}
  const grid={};let any=false;for(const row of rows){grid[row]={};for(let i=0;i<buckets.length;i++){let count=0;for(const entry of entries.filter(x=>buckets[i].dates.includes(x.date))){if(!entry.log)continue;for(const session of workoutSessions(entry.log))for(const ex of session.exercises||[]){if(muscleHeatKey(ex.primary_muscle)!==row)continue;count+=(ex.sets||[]).filter(set=>set.completed).length;}}grid[row][i]=count;if(count)any=true;}}
  if(!any)return '<div class="empty-chart">Complete sets to see the heatmap.</div>';
  return `<div class="heatmap-wrap"><div class="heatmap-grid" style="--heat-cols:${buckets.length}"><div class="heatmap-corner"></div>${buckets.map(b=>`<div class="heatmap-day">${safe(b.label)}</div>`).join('')}${rows.map(row=>`<div class="heatmap-muscle">${row}</div>${buckets.map((_,i)=>{const v=grid[row][i];const opacity=v?Math.min(.95,.18+v*.12):.06;return `<div class="heatmap-cell" title="${row}: ${v} completed sets" style="--heat-alpha:${opacity}">${v||''}</div>`;}).join('')}`).join('')}</div><div class="heatmap-caption">Completed sets by body part · dates grouped by week in monthly view</div></div>`;
}
function renderAnalytics() {
  const periods=`<div class="period-toggle" role="tablist" aria-label="Dashboard range">${[['daily','Daily'],['weekly','Weekly'],['monthly','Monthly']].map(([key,label])=>`<button class="${analyticsPeriod===key?'active':''}" data-action="set-period" data-value="${key}">${label}</button>`).join('')}</div>`;
  const content=state.selectedDomain==='diet'?renderDietAnalytics():state.selectedDomain==='workout'?renderWorkoutAnalytics():renderWaterAnalytics();
  return `${renderDashboardTargets()}${periods}<div class="period-range"><button class="period-arrow" data-action="previous-period" aria-label="Previous ${analyticsPeriod} range">‹</button><div class="period-range-copy"><strong>${safe(periodLabel())}</strong></div><button class="period-arrow" data-action="next-period" aria-label="Next ${analyticsPeriod} range">›</button></div>${content}`;
}
function renderDietAnalytics() {
  const periods=logsForPeriod(); const totals=periods.reduce((s,x)=>({calories:s.calories+x.totals.calories,protein:s.protein+x.totals.protein,carbs:s.carbs+x.totals.carbs,fat:s.fat+x.totals.fat,fiber:s.fiber+x.totals.fiber,burned:s.burned+x.totals.burned}),{calories:0,protein:0,carbs:0,fat:0,fiber:0,burned:0});
  const d=logTotals(currentLog(state.activeDate));const days=Math.max(1,periods.length);const avg={calories:totals.calories/days,protein:totals.protein/days,carbs:totals.carbs/days,fat:totals.fat/days,fiber:totals.fiber/days,burned:totals.burned/days};
  const target=state.profile.calorieTarget+(state.profile.eatBack?avg.burned:0);
  const macroRing=(name,val,goal,color)=>`<div class="macro-ring-card"><div class="ring" style="background:conic-gradient(${color} ${pct(val,goal)}%,#edf1e9 ${pct(val,goal)}% 100%)"><strong>${fmt(val)}g</strong></div><div class="macro-name">${name}</div><div class="macro-small">${fmt(val/Math.max(1,goal)*100)}%</div></div>`;
  const bars=chartBuckets(periods,x=>x.totals.calories,x=>state.profile.calorieTarget+(state.profile.eatBack?x.totals.burned:0));
  const insights=dietInsight(analyticsPeriod==='daily'?d:avg,target);
  const daily=analyticsPeriod==='daily';
  return `<div class="analysis-card"><div class="analysis-card-head"><div class="analysis-card-title">Calories</div></div><div class="analysis-number-row"><div class="analysis-number">${fmt(totals.calories)}</div><div class="analysis-unit">kcal logged</div></div>${renderBarChart(bars,'orange')}<div class="chart-legend"><div class="legend-item"><span class="legend-dot orange"></span>Eaten</div><div class="legend-item"><span class="legend-dot" style="background:#fa9d83"></span>Goal ${fmt(state.profile.calorieTarget)} kcal</div></div></div>
    <div class="analysis-card"><div class="analysis-card-head"><div class="analysis-card-title">Macros</div><span class="card-badge">${daily?'Day total':'Daily average'}</span></div><div class="macro-rings">${macroRing('Protein',daily?d.protein:avg.protein,state.profile.proteinTarget,'#c8f16d')}${macroRing('Carbs',daily?d.carbs:avg.carbs,Math.round(state.profile.calorieTarget*.45/4),'#8cd3e9')}${macroRing('Fat',daily?d.fat:avg.fat,Math.round(state.profile.calorieTarget*.30/9),'#ffc5a8')}</div></div>
    <div class="analysis-card"><div class="analysis-card-head"><div class="analysis-card-title">Meals</div></div>${renderMealDonut(aggregateMealLog(periods))}</div>
    ${insights}`;
}
function renderBarChart(items,color='green') {
  const max=Math.max(1,...items.map(i=>i.value||0),...items.map(i=>i.goal||0));
  if(!items.some(i=>i.value)) return `<div class="empty-chart">${color==='blue'?'Log water to see your hydration trend here.':color==='purple'?'Log a workout to see this trend here.':'Log a meal to see your calorie trend here.'}</div>`;
  return `<div class="bar-chart">${items.map(item=>`<div class="chart-bar-wrap"><span class="chart-bar-value">${item.value?(color==='blue'?fmt(item.value):item.value>=1000?fmt(item.value/1000,1)+'k':fmt(item.value)):''}</span><div style="height:${Math.max(2,pct(item.value,max))}%;width:100%;display:flex;justify-content:center;align-items:end;position:relative"><div class="chart-bar ${color==='blue'?'blue':color==='orange'?'orange':color==='purple'?'purple':''}" style="height:100%;width:min(24px,78%)"></div>${item.goal?`<div style="position:absolute;bottom:${pct(item.goal,max)}%;width:100%;border-top:1px dashed #f39b80"></div>`:''}</div><span class="chart-label">${safe(item.label)}</span></div>`).join('')}</div>`;
}
function renderMealDonut(log) {
  const vals=MEALS.map(m=>({label:m.label,icon:m.icon,value:(log.diet_log[m.key]||[]).reduce((s,x)=>s+n(x.macros?.calories),0)}));
  const sum=vals.reduce((s,v)=>s+v.value,0);
  if(!sum)return `<div class="empty-chart">Log foods to see your meal distribution.</div>`;
  const colors=['#c8f16d','#8cd3e9','#ffc5a8','#c5bdf7']; let cursor=0; const stops=vals.map((v,i)=>{const start=cursor;cursor+=v.value/sum*100;return `${colors[i]} ${start}% ${cursor}%`;}).join(',');
  return `<div class="donut-row"><div class="donut" style="background:conic-gradient(${stops})"><div class="donut-center"><strong>${fmt(sum)}</strong><span>KCAL</span></div></div><div class="legend-list">${vals.map((v,i)=>`<div class="legend-row"><span class="legend-square" style="background:${colors[i]}"></span>${v.label}<strong>${v.value?fmt(v.value):'—'}</strong></div>`).join('')}</div></div>`;
}
function dietInsight(d,target) {
  let title='Keep your rhythm'; let body='Small, consistent choices make a pattern. Log meals as you go and use estimates when exact weights are not practical.';
  if(d.calories===0){title='Start with one entry';body='Log your first meal to see calorie, macro and meal-distribution insights. Your entries stay on this device until sync is configured.';}
  else if(d.protein<state.profile.proteinTarget*.65){title='Give protein some attention';body=`You have logged ${fmt(d.protein)}g of protein. A protein-rich vegetarian serving at your next meal can help close the ${fmt(Math.max(0,state.profile.proteinTarget-d.protein))}g gap to your target.`;}
  else if(d.calories>target*1.1){title='A little over target';body='You are above your current calorie allowance. One day does not define a trend—check the weekly pattern before making adjustments.';}
  else if(d.protein>=state.profile.proteinTarget){title='Protein target reached';body='Nice consistency. Keep meals varied and include fiber-rich foods alongside protein sources.';}
  else {title='Steady progress';body=`You have ${fmt(Math.max(0,target-d.calories))} kcal of allowance remaining. Build your next meal around a satisfying protein source and vegetables.`;}
  return `<section class="insight-card"><div class="insight-title">${title}</div><div class="insight-body">${body}</div><div class="insight-foot">Not medical advice</div></section>`;
}
function renderWorkoutAnalytics() {
  const entries=logsForPeriod();
  const sessions=entries.flatMap(x=>x.log?workoutSessions(x.log).map(s=>({...s,date:x.date})):[]).filter(s=>s.ended||s.total_calories_burned>0);
  const allWorkouts=entries.flatMap(x=>x.log?workoutSessions(x.log).map(s=>({...s,date:x.date})):[]);
  const exCounts={};const exercisePeaks={};let totalVolume=0,totalSets=0,totalBurn=0;
  allWorkouts.forEach(s=>{totalBurn+=n(s.total_calories_burned);(s.exercises||[]).forEach(ex=>{const muscle=ex.primary_muscle||'Other';exCounts[muscle]=(exCounts[muscle]||0)+ex.sets.filter(st=>st.completed).length;ex.sets.filter(st=>st.completed).forEach(st=>{totalVolume+=n(st.weight)*n(st.reps);totalSets++;const label=ex.name;exercisePeaks[label]=Math.max(exercisePeaks[label]||0,n(st.weight));});});});
  const muscleEntries=Object.entries(exCounts).sort((a,b)=>b[1]-a[1]).slice(0,5);const muscleSum=muscleEntries.reduce((s,x)=>s+x[1],0);
  const colors=['#c8f16d','#8cd3e9','#ffc5a8','#c5bdf7','#9bd1a8'];let cursor=0;const stops=muscleEntries.map((x,i)=>{const start=cursor;cursor+=muscleSum?x[1]/muscleSum*100:0;return `${colors[i]} ${start}% ${cursor}%`;}).join(',');
  const donut=muscleSum?`<div class="donut-row"><div class="donut" style="background:conic-gradient(${stops})"><div class="donut-center"><strong>${fmt(totalSets)}</strong><span>SETS</span></div></div><div class="legend-list">${muscleEntries.map((x,i)=>`<div class="legend-row"><span class="legend-square" style="background:${colors[i]}"></span><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${safe(x[0])}</span><strong>${x[1]}</strong></div>`).join('')}</div></div>`:`<div class="empty-chart">Complete a set to see muscle groups.</div>`;
  const volumeTrend=chartBuckets(entries,x=>x.log?workoutSessions(x.log).reduce((a,s)=>a+(s.exercises||[]).reduce((v,ex)=>v+ex.sets.reduce((st,set)=>st+(set.completed?n(set.weight)*n(set.reps):0),0),0),0):0,0);
  const lineValues=Object.entries(exercisePeaks).slice(-8); const maxPeak=Math.max(1,...lineValues.map(x=>x[1]));
  let line='';
  if(lineValues.length){const coords=lineValues.map((x,i)=>`${10+i*(180/Math.max(1,lineValues.length-1))},${105-(x[1]/maxPeak*80)}`).join(' ');line=`<svg viewBox="0 0 200 120" width="100%" height="130" role="img" aria-label="Highest completed weight by exercise"><path d="M10 105 H190" stroke="#e8eee4" stroke-width="1" fill="none"/><polyline points="${coords}" fill="none" stroke="#80b95a" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>${lineValues.map((x,i)=>`<circle cx="${10+i*(180/Math.max(1,lineValues.length-1))}" cy="${105-(x[1]/maxPeak*80)}" r="3.2" fill="#c7f36c" stroke="#fff" stroke-width="1.5"/>`).join('')}</svg><div class="legend-list">${lineValues.map(x=>`<div class="legend-row"><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${safe(x[0])}</span><strong>${fmt(x[1],1)} kg</strong></div>`).join('')}</div>`;} else line=`<div class="empty-chart">Top weights appear after you complete sets.</div>`;
  const insights=workoutInsight(totalSets,totalVolume,allWorkouts.length);
  return `<div class="analysis-card"><div class="analysis-card-head"><div><div class="analysis-card-title">Muscle group distribution</div></div></div>${donut}</div>
    <div class="analysis-card"><div class="analysis-card-head"><div><div class="analysis-card-title">Strength snapshot</div></div><span class="card-badge">${lineValues.length} movements</span></div>${line}</div>
    <div class="analysis-card"><div class="analysis-card-head"><div><div class="analysis-card-title">Total volume load</div></div><span class="card-badge">${fmt(totalVolume)} kg</span></div>${totalVolume?`<div class="volume-bars">${volumeTrend.map((item,i)=>`<div><div class="vbar" style="height:${Math.max(3,pct(item.value,Math.max(1,...volumeTrend.map(x=>x.value))))}%"></div><small>${safe(item.label)}</small></div>`).join('')}</div>`:`<div class="empty-chart">Log weighted sets to see volume.</div>`}</div>
    <div class="analysis-card"><div class="analysis-card-head"><div><div class="analysis-card-title">Body-part heatmap</div></div></div>${renderWorkoutHeatmap(entries)}</div>
    <div class="analysis-card"><div class="analysis-card-head"><div><div class="analysis-card-title">Training summary</div></div></div><div class="nutri-summary" style="margin:0"><div class="micro-card"><div class="micro-label">SESSIONS</div><div class="micro-value">${allWorkouts.length}</div><div class="micro-unit">logged</div></div><div class="micro-card"><div class="micro-label">SETS</div><div class="micro-value">${totalSets}</div><div class="micro-unit">completed</div></div><div class="micro-card"><div class="micro-label">BURN</div><div class="micro-value">${fmt(totalBurn)}</div><div class="micro-unit">kcal estimate</div></div></div></div>${insights}`;
}
function workoutInsight(sets,volume,sessions) { let title='Build the base';let body='Add a workout and log completed sets to build a useful training history.';if(sets>=12){title='Strong training consistency';body=`You've completed ${sets} sets and logged ${fmt(volume)} kg of volume in this period. Compare like-for-like exercises across weeks rather than chasing every session.`;}else if(sets>0){title='Every completed set counts';body=`${sets} sets are in the log so far. Aim to record the actual reps and load you complete; a reliable baseline makes progressive overload more meaningful.`;}return `<section class="insight-card"><div class="insight-title">${title}</div><div class="insight-body">${body}</div><div class="insight-foot">Not medical advice</div></section>`; }
function renderWaterAnalytics() {
  const periods=logsForPeriod();const consumed=periods.reduce((s,x)=>s+x.totals.water,0);const dailyAvg=consumed/Math.max(1,periods.length);const completed=periods.filter(x=>x.totals.water>=state.profile.waterTarget).length;
  const bars=chartBuckets(periods,x=>x.totals.water,()=>state.profile.waterTarget);
  let title='Make hydration easy';let body='Keep water within reach and use a quick-add button after each glass.';
  if(consumed){if(completed>0){title=`${completed} goal ${completed===1?'day':'days'} reached`;body=`You hit your ${fmt(state.profile.waterTarget)} ml target on ${completed} ${completed===1?'day':'days'} in this period.`;}else{title='Small sips add up';body=`Your average is ${fmt(dailyAvg)} ml per day, ${fmt(Math.max(0,state.profile.waterTarget-dailyAvg))} ml below your target.`;}}
  return `<div class="analysis-card"><div class="analysis-card-head"><div class="analysis-card-title">Water</div></div><div class="analysis-number-row"><div class="analysis-number">${fmt(dailyAvg)}</div><div class="analysis-unit">ml per day on average</div></div>${renderBarChart(bars,'blue')}<div class="chart-legend"><div class="legend-item"><span class="legend-dot blue"></span>Logged</div><div class="legend-item"><span class="legend-dot orange"></span>Goal ${fmt(state.profile.waterTarget)} ml</div></div></div>
    <div class="analysis-card"><div class="analysis-card-head"><div class="analysis-card-title">Days on target</div></div><div class="analysis-number-row"><div class="analysis-number">${completed}</div><div class="analysis-unit">of ${periods.length} days</div></div><div class="progress-track light"><div class="progress-fill water" style="width:${pct(completed,periods.length)}%"></div></div></div>
    <section class="insight-card"><div class="insight-title">${title}</div><div class="insight-body">${body}</div><div class="insight-foot">Needs vary</div></section>`;
}
// Modal shell and diet logging
function showModal(html,size='') { $('modalRoot').innerHTML=`<div class="modal-backdrop" data-action="backdrop-close"><section class="modal-sheet ${size}" role="dialog" aria-modal="true">${html}</section></div>`; }
function closeModal() {
  $('modalRoot').innerHTML=''; activeFoodSelection=null; editFoodEntryId=null; activeRecipeIngredient=null;
  const returnState=exerciseDetailReturnState; exerciseDetailReturnState=null;
  if(returnState){
    openWorkoutModal();activeExerciseSelection=returnState.id;
    const input=$('exerciseSearch');if(input){input.value=returnState.query;renderExerciseResults(returnState.query);updateExerciseDetail();}
    return;
  }
  activeExerciseSelection=null;
}
function modalHead(kicker,title,description='') { return `<div class="modal-handle"></div><div class="modal-head"><div><div class="eyebrow">${kicker}</div><h2>${title}</h2>${description?`<p>${description}</p>`:''}</div><button class="close-modal" data-action="close-modal" aria-label="Close">×</button></div>`; }
let activeFoodFilter = 'all';
function openFoodModal(meal='breakfast', preselect=null, allowRecipeCreation=false) {
  activeFoodMeal=meal||'breakfast';activeFoodSelection=preselect||null;activeFoodFilter='all';
  showModal(`${sheetHead('Add food')}
    <div id="foodStep1">
      <div class="search-box"><span class="search-icon">⌕</span><input id="foodSearch" type="search" placeholder="Search food or meal" autocomplete="off" enterkeyhint="search" /></div>
      <div class="chip-row" role="group" aria-label="Food type">${[['all','All'],['raw_ingredient','Ingredients'],['standard_estimate','Meals'],['custom_recipe','My recipes']].map(([value,label])=>`<button type="button" class="chip ${value==='all'?'active':''}" data-action="food-filter" data-value="${value}">${label}</button>`).join('')}</div>
      <div id="foodResults" class="pick-list"></div>
      ${allowRecipeCreation?'<button type="button" class="link-button" data-action="open-recipe">＋ Create a recipe</button>':''}
    </div>
    <div id="foodStep2" class="hidden">
      <button type="button" class="step-back" data-action="food-back">‹ Back to search</button>
      <div id="selectedFoodDetail"></div>
      <div class="field-grid food-log-grid"><div class="field"><label for="foodAmount">AMOUNT</label><input id="foodAmount" type="number" inputmode="decimal" min="0.01" step="0.1" value="100" /></div><div class="field"><label for="foodUnit">UNIT</label><select id="foodUnit"><option value="g">g</option></select></div></div>
      <div class="meal-chips" role="group" aria-label="Meal">${MEALS.map(m=>`<button type="button" class="chip ${m.key===activeFoodMeal?'active':''}" data-action="pick-meal" data-value="${m.key}">${m.label}</button>`).join('')}</div>
      <input type="hidden" id="foodMeal" value="${activeFoodMeal}" />
      <button class="big-button" data-action="confirm-add-food">Add food</button>
    </div>`,'tall');
  renderFoodResults('');
  if(activeFoodSelection) selectFoodInPicker(activeFoodSelection);
}
function searchScore(query,text) {
  const q=query.toLowerCase().trim();const t=text.toLowerCase();if(!q)return 1;
  if(t.startsWith(q))return 100-q.length/100;if(t.includes(q))return 80-q.length/100;
  const parts=q.split(/\s+/);let total=0;for(const part of parts){if(t.includes(part))total+=20;else{let best=0;for(let i=0;i<part.length;i++)if(t.includes(part.slice(0,part.length-i)))best=Math.max(best,(part.length-i)/part.length*10);total+=best;}}return total/parts.length;
}
function renderFoodResults(query) {
  const host=$('foodResults');if(!host)return;
  const q=String(query||'').trim();
  const pool=allFoods().filter(food=>activeFoodFilter==='all'||food.type===activeFoodFilter);
  if(!q){
    const recents=activeFoodFilter==='all'?(state.recentFoodIds||[]).map(findFood).filter(Boolean):[];
    if(recents.length){host.innerHTML=`<div class="picker-caption">Recent</div>${recents.map(food=>foodResultButton(food,activeFoodSelection===food.id)).join('')}<div class="pick-hint">Type to search ${fmt(pool.length)} foods, or pick a type above.</div>`;return;}
    const list=[...pool].sort((x,y)=>String(x.name).localeCompare(String(y.name))).slice(0,40);
    host.innerHTML=list.length?`${list.map(food=>foodResultButton(food,activeFoodSelection===food.id)).join('')}${pool.length>40?`<div class="pick-hint">Showing 40 of ${fmt(pool.length)}. Type to search.</div>`:''}`:'<div class="pick-hint">You have no saved recipes yet.</div>';
    return;
  }
  const results=searchFoods(q,pool);const shown=results.slice(0,60);
  host.innerHTML=shown.length?`${shown.map(food=>foodResultButton(food,activeFoodSelection===food.id)).join('')}${results.length>60?`<div class="pick-hint">Showing 60 of ${results.length}. Add a word to narrow it down.</div>`:''}`:'<div class="pick-hint">No match. Try another name.</div>';
}
function foodResultButton(food,selected=false) {
  const amount=defaultFoodAmount(food),unit=foodAmountUnit(food);
  const kcal=foodMacros(food,amount,unit).calories;
  const kind=food.type==='raw_ingredient'?'Ingredient':food.type==='custom_recipe'?'Your recipe':'Meal';
  return `<button type="button" class="pick-row ${selected?'selected':''}" data-action="select-food" data-id="${safe(food.id)}">${renderFoodThumb(food)}<span class="pick-main"><strong>${safe(food.name)}</strong><span>${kind} · ${safe(amountLabel(food,amount,unit))}</span></span><span class="pick-kcal">${fmt(kcal)}<small>kcal</small></span></button>`;
}
function selectFoodInPicker(foodId) {
  const food=findFood(foodId);if(!food)return;activeFoodSelection=foodId;
  const amount=$('foodAmount');if(amount)amount.value=defaultFoodAmount(food);
  const unitSelect=$('foodUnit');if(unitSelect){unitSelect.innerHTML=foodUnits(food).map(u=>`<option value="${safe(u)}">${safe(u)}</option>`).join('');unitSelect.value=foodAmountUnit(food);}
  const detail=$('selectedFoodDetail');if(detail)detail.innerHTML=`<div class="pick-card">${renderFoodThumb(food)}<div><strong class="selected-food-name">${safe(food.name)}</strong><span class="selected-food-macros"></span></div></div>`;
  showFoodStep(2);updateSelectedFoodPreview();
}
function showFoodStep(step) {
  $('foodStep1')?.classList.toggle('hidden',step!==1);$('foodStep2')?.classList.toggle('hidden',step!==2);
  if(step===1){activeFoodSelection=null;renderFoodResults($('foodSearch')?.value||'');}
}
function updateSelectedFoodPreview() {
  const food=findFood(activeFoodSelection);if(!food)return;const amount=Math.max(.01,n($('foodAmount')?.value)||defaultFoodAmount(food));const unit=$('foodUnit')?.value||foodAmountUnit(food);const macros=foodMacros(food,amount,unit);const line=document.querySelector('#selectedFoodDetail .selected-food-macros');if(line)line.textContent=`${fmt(macros.calories)} kcal · P ${fmt(macros.protein,1)} · C ${fmt(macros.carbs,1)} · F ${fmt(macros.fat,1)}`;
}
function addSelectedFood() {
  const food=findFood(activeFoodSelection);if(!food){toast('Search and select a food first.',true);return;}
  const amount=Math.max(.01,n($('foodAmount')?.value)||defaultFoodAmount(food));const unit=$('foodUnit')?.value||foodAmountUnit(food);const meal=$('foodMeal')?.value||activeFoodMeal;
  const macros=foodMacros(food,amount,unit);const item={entry_id:uid('log'),food_id:food.id,name:food.name,type:food.type,amount,unit,amount_label:amountLabel(food,amount,unit),macros:{...macros},logged_at:new Date().toISOString(),tags:[...(food.tags||[])]};
  currentLog().diet_log[meal].push(item);state.recentFoodIds=recentIds(state.recentFoodIds,food.id);state.selectedDomain='diet';state.selectedTab='timeline';scheduleSave();closeModal();render();toast(`${food.name} added to ${meal}.`);
}
function findFoodEntry(entryId) {
  const log=activeLog();for(const meal of MEALS){const item=(log.diet_log[meal.key]||[]).find(x=>x.entry_id===entryId);if(item)return {item,meal:meal.key};}return null;
}
function openEditFood(entryId) {
  const result=findFoodEntry(entryId);if(!result)return;editFoodEntryId=entryId;const item=result.item;const macros=item.macros||{};
  showModal(`${sheetHead('Edit entry')}
    <div class="pick-card">${renderFoodThumb(findFood(item.food_id)||item)}<div><strong>${safe(item.name)}</strong><span>Only this entry changes</span></div></div>
    <div class="field-grid"><div class="field"><label for="editAmount">AMOUNT</label><input id="editAmount" type="number" inputmode="decimal" min="0.1" step="0.1" value="${safe(item.amount??1)}" /></div><div class="field"><label for="editUnit">UNIT</label><select id="editUnit">${[...new Set([...(foodUnits(findFood(item.food_id)||item)),item.unit||'g'])].map(u=>`<option value="${safe(u)}" ${(item.unit||'g')===u?'selected':''}>${safe(u)}</option>`).join('')}</select></div></div>
    <div class="macro-edit-grid">${[['calories','KCAL'],['protein','PROTEIN'],['carbs','CARBS'],['fat','FAT'],['fiber','FIBER']].map(([key,label])=>`<div class="field"><label for="macro_${key}">${label}</label><input id="macro_${key}" type="number" inputmode="decimal" min="0" step="0.1" value="${safe(macros[key]??0)}" /></div>`).join('')}</div>
    <div class="modal-actions"><button class="cancel" data-action="close-modal">Cancel</button><button class="save lime" data-action="save-food-edit">Save</button></div>`);
}
function saveFoodEdit() {
  const result=findFoodEntry(editFoodEntryId);if(!result)return;const item=result.item;
  const amount=Math.max(.1,n($('editAmount')?.value)||1);item.amount=amount;item.unit=$('editUnit')?.value||item.unit;item.amount_label=amountLabel(findFood(item.food_id)||item,amount,item.unit);
  item.macros={calories:round(n($('macro_calories')?.value),2),protein:round(n($('macro_protein')?.value),2),carbs:round(n($('macro_carbs')?.value),2),fat:round(n($('macro_fat')?.value),2),fiber:round(n($('macro_fiber')?.value),2)};
  item.edited=true; scheduleSave(); closeModal(); render(); toast('Entry updated. Master food unchanged.');
}
function removeFoodEntry(entryId) {
  const log=activeLog();for(const meal of MEALS){const i=log.diet_log[meal.key].findIndex(x=>x.entry_id===entryId);if(i>=0){log.diet_log[meal.key].splice(i,1);scheduleSave();render();toast('Food entry removed.');return;}}
}

function openRecipeModal() {
  recipeIngredients=[{foodId:'',amount:100,unit:'g',query:''}];
  showModal(`${sheetHead('New recipe')}
    <div class="field"><label for="recipeName">NAME</label><input id="recipeName" placeholder="e.g. Paneer & soya bowl" maxlength="70" /></div>
    <div class="field"><label for="recipeYield">SERVINGS MADE</label><input id="recipeYield" type="number" inputmode="numeric" min="1" step="1" value="2" /></div>
    <div class="divider-label">Ingredients</div><div id="recipeIngredients"></div>
    <button class="outline-button wide" data-action="recipe-add-ingredient">＋ Add ingredient</button>
    <div id="recipePreview" class="form-note"></div>
    <div class="modal-actions"><button class="cancel" data-action="close-modal">Cancel</button><button class="save lime" data-action="save-recipe">Save recipe</button></div>`,'tall');
  renderRecipeIngredients();
}
function renderRecipeIngredients() {
  const host=$('recipeIngredients');if(!host)return;
  host.innerHTML=recipeIngredients.map((ingredient,index)=>{
    const food=findFood(ingredient.foodId);const units=food?foodUnits(food):['g','kg','ml','L'];const unit=ingredient.unit||foodAmountUnit(food)||'g';
    const query=ingredient.query||(food?food.name:'');
    return `<div class="recipe-ingredient"><div class="recipe-picker"><input class="recipe-search" data-role="recipe-search" data-index="${index}" placeholder="Search ingredient…" value="${safe(query)}" autocomplete="off" aria-label="Search ingredient ${index+1}"/><div class="recipe-selected">${food?`<span>${safe(food.name)}</span><small>${safe(food.type==='raw_ingredient'?'Ingredient':'Estimate')} selected</small>`:'<small>Search and select an ingredient</small>'}</div><div class="recipe-results-mini" id="recipe-results-${index}"></div></div><input type="number" min="0.01" step="0.1" value="${safe(ingredient.amount)}" data-role="recipe-amount" data-index="${index}" aria-label="Ingredient amount"/><select data-role="recipe-unit" data-index="${index}" aria-label="Ingredient unit">${units.map(u=>`<option value="${safe(u)}" ${unit===u?'selected':''}>${safe(u)}</option>`).join('')}</select><button data-action="recipe-remove-ingredient" data-index="${index}" aria-label="Remove ingredient">×</button></div>`;
  }).join('');
  recipeIngredients.forEach((ing,index)=>{if(ing.query&&(!findFood(ing.foodId)||ing.query.toLowerCase()!==findFood(ing.foodId).name.toLowerCase()))renderRecipeSearchResults(index,ing.query);});
  updateRecipePreview();
}
function renderRecipeSearchResults(index,query) {
  const host=$(`recipe-results-${index}`);if(!host)return;const q=String(query||'').trim();
  if(!q){host.innerHTML='';return;}
  const results=allFoods().filter(f=>f.type==='raw_ingredient').map(food=>({food,score:searchScore(q,`${food.name} ${(food.tags||[]).join(' ')}`)})).filter(x=>x.score>0).sort((a,b)=>b.score-a.score||a.food.name.localeCompare(b.food.name)).slice(0,5);
  host.innerHTML=results.map(({food})=>`<button class="recipe-result-option" data-action="recipe-select-ingredient" data-index="${index}" data-id="${safe(food.id)}"><strong>${safe(food.name)}</strong><span>${safe(foodAmountUnit(food))} · ${fmt(foodMacros(food,defaultFoodAmount(food),foodAmountUnit(food)).calories)} kcal default</span></button>`).join('')||'<small class="recipe-no-result">No ingredient matched. Try another search.</small>';
}
function selectRecipeIngredient(index,foodId) {
  const food=findFood(foodId);if(!food||!recipeIngredients[index])return;recipeIngredients[index].foodId=foodId;recipeIngredients[index].query=food.name;recipeIngredients[index].unit=foodAmountUnit(food);recipeIngredients[index].amount=defaultFoodAmount(food);renderRecipeIngredients();
}
function updateRecipePreview() {
  const host=$('recipePreview');if(!host)return;let total={calories:0,protein:0,carbs:0,fat:0,fiber:0};let selected=0;
  recipeIngredients.forEach(ing=>{const food=findFood(ing.foodId);if(!food)return;selected++;const m=foodMacros(food,ing.amount,ing.unit||foodAmountUnit(food));for(const key of Object.keys(total))total[key]+=m[key]||0;});
  const yieldCount=Math.max(1,n($('recipeYield')?.value)||2);host.innerHTML=`${selected}/${recipeIngredients.length} ingredients selected · Whole recipe: <strong>${fmt(total.calories)} kcal</strong> · P ${fmt(total.protein,1)}g · C ${fmt(total.carbs,1)}g · F ${fmt(total.fat,1)}g. Per serving (${yieldCount}): <strong>${fmt(total.calories/yieldCount)} kcal</strong>.`;
}
function saveRecipe() {
  const name=$('recipeName')?.value.trim();if(!name){toast('Give your recipe a name first.',true);return;}
  const yieldCount=Math.max(1,Math.round(n($('recipeYield')?.value)||1));let total={calories:0,protein:0,carbs:0,fat:0,fiber:0};const components=[];
  for(const ing of recipeIngredients){const food=findFood(ing.foodId);if(!food){toast('Search and select every ingredient.',true);return;}const amount=Math.max(.01,n(ing.amount));const unit=ing.unit||foodAmountUnit(food);const m=foodMacros(food,amount,unit);for(const key of Object.keys(total))total[key]+=m[key]||0;components.push({food_id:food.id,name:food.name,amount,unit,macros:m});}
  if(!components.length){toast('Add at least one ingredient.',true);return;}
  const item={id:uid('recipe'),name,type:'custom_recipe',serving_unit:'serving',default_serving_size:1,macros_per_serving:Object.fromEntries(Object.entries(total).map(([k,v])=>[k,round(v/yieldCount,2)])),tags:['custom','recipe','vegetarian'],recipe_ingredients:components,yield:yieldCount,created_at:new Date().toISOString(),updated_at:new Date().toISOString()};
  state.customFoods.push(item);state.recentFoodIds=recentIds(state.recentFoodIds,item.id);state.syncMeta.dirtyFoodIds=Array.from(new Set([...(state.syncMeta.dirtyFoodIds||[]),item.id]));scheduleSave(false);closeModal();openFoodModal('breakfast',item.id);toast('Recipe saved. Add it to any meal when ready.');
}


// Workout progression & execution
function openWorkoutModal() {
  activeExerciseSelection=null;
  showModal(`${sheetHead('Add exercise')}
    <div id="exStep1">
      <div class="search-box"><span class="search-icon">⌕</span><input id="exerciseSearch" type="search" placeholder="Search name or muscle" autocomplete="off" enterkeyhint="search" /></div>
      <div class="chip-row" role="group" aria-label="Quick search">${['Chest','Back','Shoulders','Arms','Legs','Core','Cardio','Bodyweight'].map(label=>`<button type="button" class="chip" data-action="ex-chip" data-q="${label}">${label}</button>`).join('')}</div>
      <div id="exerciseResults" class="pick-list"></div>
    </div>
    <div id="exStep2" class="hidden"></div>`,'tall');
  renderExerciseResults('');
}
function renderExerciseResults(query) {
  const host=$('exerciseResults');if(!host)return;const q=String(query||'').trim();
  if(!q){host.innerHTML='<div class="pick-hint">Search by name or muscle, or tap a body part above. Searching “chest” also lists exercises that train the chest without saying so in the name.</div>';return;}
  const found=searchExercises(q);
  if(!found.length){
    const close=masterExercises.map(ex=>({ex,score:searchScore(q,ex.name)})).filter(x=>x.score>=10).sort((x,y)=>y.score-x.score).slice(0,20);
    host.innerHTML=close.length?`<div class="picker-caption">Closest matches</div>${close.map(({ex})=>exerciseResultButton(ex)).join('')}`:'<div class="pick-hint">No exercise matched. Try a muscle, equipment or movement name.</div>';
    return;
  }
  const CAP=200;const shown=found.slice(0,CAP);const tiers=new Set(shown.map(item=>item.tier));
  const caption=tier=>tier===0?'Name matches':tier===1?`Works ${safe(q)}`:'Also trains it';
  let htmlOut='';let last=-1;
  for(const item of shown){if(tiers.size>1&&item.tier!==last){htmlOut+=`<div class="picker-caption">${caption(item.tier)}</div>`;last=item.tier;}htmlOut+=exerciseResultButton(item.ex);}
  if(found.length>CAP)htmlOut+=`<div class="pick-hint">Showing ${CAP} of ${found.length}. Add a word to narrow it down.</div>`;
  host.innerHTML=htmlOut;
}
function exerciseResultButton(ex) {
  const primary=ex.primary_muscle||ex.target||'Full body';
  return `<div class="pick-row ex">${renderExerciseThumbnail(ex,'picker')}<button type="button" class="pick-main" data-action="select-exercise" data-id="${safe(ex.id)}"><strong>${safe(ex.name)}</strong><span>${safe(primary)} · ${safe(ex.equipment||'Bodyweight')}</span></button><span class="pick-chev" aria-hidden="true">›</span></div>`;
}
function updateExerciseDetail() {
  const ex=findExercise(activeExerciseSelection);const s1=$('exStep1'),s2=$('exStep2');if(!s1||!s2)return;
  if(!ex){s1.classList.remove('hidden');s2.classList.add('hidden');return;}
  const mode=exerciseMode(ex);
  s1.classList.add('hidden');s2.classList.remove('hidden');
  s2.innerHTML=`<button type="button" class="step-back" data-action="exercise-back">‹ Back to search</button>
    <div class="pick-card">${renderExerciseThumbnail(ex,'selected')}<div><strong class="selected-exercise-name">${safe(ex.name)}</strong><span>${safe(ex.primary_muscle||ex.target||'Full body')} · ${safe(ex.equipment||'Bodyweight')}</span></div></div>
    <div class="setup-grid ${mode==='weight'?'three':'two'}">
      <div class="field"><label for="targetSets">SETS</label><input type="number" inputmode="numeric" id="targetSets" min="1" max="20" value="3" /></div>
      <div class="field"><label for="targetReps">${mode==='time'?'MINUTES':'REPS'}</label><input type="number" inputmode="decimal" id="targetReps" min="${mode==='time'?'0.5':'1'}" max="100" step="${mode==='time'?'0.5':'1'}" value="10" /></div>
      ${mode==='weight'?'<div class="field"><label for="startingWeight">KG</label><input type="number" inputmode="decimal" id="startingWeight" min="0" step="0.5" value="40" /></div>':''}
    </div>
    ${mode==='weight'?'<label class="toggle-row"><span>Increase weight each set</span><span class="switch"><input type="checkbox" id="progressiveToggle" checked><span class="switch-track"></span></span></label><div class="field" id="incrementField"><label for="weightIncrement">ADD PER SET (KG)</label><input type="number" inputmode="decimal" id="weightIncrement" min="0" step="0.5" value="5" /></div>':''}
    <div id="setPreview" class="set-preview"></div>
    <button class="big-button" data-action="save-exercise">Add exercise</button>`;
  updateSetPreview();
}
function openExerciseDetail(id) {
  const ex=findExercise(id);if(!ex)return;
  if($('exerciseSearch')) exerciseDetailReturnState={id:ex.id,query:$('exerciseSearch').value||''};
  else exerciseDetailReturnState=null;
  const licensed=exerciseHasLicensedMedia(ex);
  const media=licensed
    ? `<div class="exercise-guide-media"><img src="${safe(ex.gif_url)}" alt="${safe(ex.name)} movement animation" loading="eager" onerror="this.hidden=true;this.nextElementSibling.hidden=false"><div class="exercise-media-fallback" hidden><span>${exerciseEmoji(ex.primary_muscle)}</span><strong>Animation could not be loaded</strong><small>Check the licensed media file path.</small></div></div>`
    : `<div class="exercise-guide-media"><div class="exercise-media-fallback"><span>${exerciseEmoji(ex.primary_muscle||ex.target)}</span><strong>${ex.media_status==='needs_license'?'Animation slot ready':'No animation linked yet'}</strong><small>${ex.media_status==='needs_license'?'The source includes the media paths, but Gym Visual images/GIFs are not bundled until reuse rights are confirmed. Add licensed files under exercise-media/ and set this record\'s media_status to licensed.':'This older Forma exercise has no demonstration file linked. A licensed thumbnail/GIF can be added later if available.'}</small></div></div>`;
  const bodyPart=ex.body_part||ex.category||'Not specified';
  const target=ex.primary_muscle||ex.target||'Not specified';
  const muscles=(ex.secondary_muscles||[]).filter(Boolean);
  showModal(`${sheetHead(safe(ex.name))}${media}<p class="exercise-guide-description">${safe(exerciseShortDescription(ex))}</p><div class="exercise-guide-facts"><div><span>BODY PART</span><strong>${safe(bodyPart)}</strong></div><div><span>TARGET MUSCLE</span><strong>${safe(target)}</strong></div><div><span>EQUIPMENT</span><strong>${safe(ex.equipment||'Bodyweight')}</strong></div><div><span>REST</span><strong>${n(ex.default_rest_sec)?`${n(ex.default_rest_sec)} sec`:'No preset'}</strong></div>${muscles.length?`<div class="wide"><span>SECONDARY MUSCLES</span><strong>${safe(muscles.join(', '))}</strong></div>`:''}</div><div class="exercise-guide-credit">${ex.media_attribution?safe(ex.media_attribution):''}</div><div class="modal-actions"><button class="save lime" data-action="close-modal">Done</button></div>`);
}
function openEditExercise(index) {
  const ex=activeLog().workout_log?.exercises?.[index];if(!ex)return;
  editExerciseIndex=index;
  const reference=findExercise(ex.exercise_id)||ex;const locked=!!ex.finished;const mode=entryMode(ex);const withWeight=mode==='weight';
  const rows=ex.sets.map((set,i)=>`<div class="set-row edit-set-row ${withWeight?'':'no-weight'}"><div class="set-num">${i+1}</div>${withWeight?`<input class="set-input" type="number" inputmode="decimal" min="0" step="0.5" id="editSetWeight${i}" aria-label="Weight for set ${i+1}" value="${safe(set.weight??0)}" ${locked?'disabled':''}/>`:''}<input class="set-input" type="number" inputmode="decimal" min="0" step="${mode==='time'?'0.5':'1'}" id="editSetReps${i}" aria-label="${mode==='time'?'Minutes':'Reps'} for set ${i+1}" value="${safe(set.reps??10)}" ${locked?'disabled':''}/><button type="button" class="mini-icon" data-action="edit-remove-set" data-set-index="${i}" aria-label="Remove set ${i+1}" ${locked||ex.sets.length<=1?'disabled':''}>✕</button></div>`).join('');
  showModal(`${sheetHead('Edit exercise')}
    <div class="pick-card">${renderExerciseThumbnail(reference,'selected')}<div><strong class="selected-exercise-name">${safe(ex.name)}</strong><span>${locked?'Finished. Sets are locked.':safe(ex.primary_muscle||'Full body')+' · '+safe(ex.equipment||'Bodyweight')}</span></div></div>
    <div class="sets-header edit-sets-header ${withWeight?'':'no-weight'}"><span>SET</span>${withWeight?'<span>KG</span>':''}<span>${mode==='time'?'MIN':'REPS'}</span><span></span></div>
    ${rows}
    <button type="button" class="outline-button wide" style="margin-top:6px" data-action="edit-add-set" ${locked?'disabled':''}>＋ Add set</button>
    <div class="field" style="margin-top:14px"><label for="editRest">REST BETWEEN SETS (SECONDS)</label><input id="editRest" type="number" inputmode="numeric" min="0" step="5" value="${safe(n(ex.default_rest_sec))}" ${locked?'disabled':''}/></div>
    <div class="modal-actions"><button class="cancel" data-action="close-modal">Cancel</button><button class="save" data-action="save-exercise-edit" ${locked?'disabled':''}>Save</button></div>
    <button type="button" class="danger-button" data-action="delete-exercise">🗑 Delete exercise</button>`);
}
function readEditedSets(ex) {
  if(ex.finished)return;
  ex.sets.forEach((set,i)=>{const w=$('editSetWeight'+i),r=$('editSetReps'+i);if(w)set.weight=Math.max(0,n(w.value));if(r)set.reps=Math.max(0,n(r.value));});
}
function editExerciseAddSet() {
  const ex=activeLog().workout_log?.exercises?.[editExerciseIndex];if(!ex||ex.finished)return;
  readEditedSets(ex);const last=ex.sets[ex.sets.length-1]||{weight:0,reps:10};
  ex.sets.push({set_num:ex.sets.length+1,weight:n(last.weight),reps:n(last.reps),completed:false});
  scheduleSave();render();openEditExercise(editExerciseIndex);
}
function editExerciseRemoveSet(setIndex) {
  const ex=activeLog().workout_log?.exercises?.[editExerciseIndex];if(!ex||ex.finished||ex.sets.length<=1)return;
  readEditedSets(ex);ex.sets.splice(setIndex,1);ex.sets.forEach((s,i)=>{s.set_num=i+1;});
  ex.rest_until=null;ex.last_completed_set=null;
  scheduleSave();render();openEditExercise(editExerciseIndex);
}
function saveExerciseEdit() {
  const ex=activeLog().workout_log?.exercises?.[editExerciseIndex];if(!ex)return;
  if(!ex.finished){readEditedSets(ex);if($('editRest'))ex.default_rest_sec=Math.max(0,Math.round(n($('editRest').value)));}
  scheduleSave();closeModal();render();toast('Exercise updated.');
}
function deleteExerciseEntry(button) {
  if(button&&button.dataset.armed!=='1'){button.dataset.armed='1';button.textContent='Tap again to delete this exercise';return;}
  const log=activeLog();const workout=log.workout_log;const ex=workout?.exercises?.[editExerciseIndex];if(!ex)return;
  const name=ex.name;workout.exercises.splice(editExerciseIndex,1);
  if(!workout.exercises.length&&!workout.start_ms)log.workout_log=null;
  editExerciseIndex=null;scheduleSave();closeModal();render();toast(`${name} deleted.`);
}
function updateSetPreview() {
  const host=$('setPreview');if(!host)return;
  const ex=findExercise(activeExerciseSelection);const mode=ex?exerciseMode(ex):'weight';
  const sets=clamp(Math.round(n($('targetSets')?.value)||3),1,20);
  const reps=mode==='time'?Math.max(.5,n($('targetReps')?.value)||10):Math.max(1,Math.round(n($('targetReps')?.value)||10));
  const progressive=!!$('progressiveToggle')?.checked;$('incrementField')?.classList.toggle('hidden',!progressive);
  if(mode==='weight'){
    const start=Math.max(0,n($('startingWeight')?.value)||0);const inc=progressive?Math.max(0,n($('weightIncrement')?.value)||0):0;
    host.innerHTML=Array.from({length:sets},(_,i)=>`<span>Set ${i+1}: <strong>${fmt(start+i*inc,1)} kg × ${reps}</strong></span>`).join('');
  } else host.innerHTML=`<span><strong>${sets} × ${mode==='time'?fmt(reps,1)+' min':reps+' reps'}</strong></span>`;
}
function ensureWorkout() {
  const log=activeLog();if(!log.workout_log)log.workout_log={session_id:uid('ws'),start_time:null,end_time:null,start_ms:null,end_ms:null,total_calories_burned:0,exercises:[],status:'planned'};return log.workout_log;
}
function saveExerciseSetup() {
  const ex=findExercise(activeExerciseSelection);if(!ex){toast('Choose an exercise.',true);return;}
  const mode=exerciseMode(ex);const count=clamp(Math.round(n($('targetSets')?.value)||3),1,20);const reps=mode==='time'?Math.max(.5,n($('targetReps')?.value)||10):Math.max(1,Math.round(n($('targetReps')?.value)||10));const start=mode==='weight'?Math.max(0,n($('startingWeight')?.value)||0):0;const increment=mode==='weight'&&$('progressiveToggle')?.checked?Math.max(0,n($('weightIncrement')?.value)||0):0;
  const workout=ensureWorkout();const sets=Array.from({length:count},(_,i)=>({set_num:i+1,weight:round(start+i*increment,2),reps,completed:false}));
  state.recentExerciseIds=recentIds(state.recentExerciseIds,ex.id);
  workout.exercises.push({exercise_id:ex.id,mode,name:ex.name,primary_muscle:ex.primary_muscle,secondary_muscles:ex.secondary_muscles||[],equipment:ex.equipment,met_value:ex.met_value,default_rest_sec:ex.default_rest_sec,tracking_metrics:ex.tracking_metrics||['weight','reps'],sets,started:false,finished:false,rest_until:null,last_completed_set:null,created_at:new Date().toISOString()});
  state.selectedDomain='workout';state.selectedTab='timeline';scheduleSave();closeModal();render();toast(`${ex.name} added to your session.`);
}
function startSession() {
  const workout=activeLog().workout_log;if(!workout||!workout.exercises.length){toast('Add an exercise first.',true);return;}
  if(!workout.start_ms){workout.start_ms=Date.now();workout.start_time=new Date(workout.start_ms).toISOString();workout.status='active';}
  scheduleSave();render();toast('Session started. Go one set at a time.');
}
function startExercise(index) {
  const workout=activeLog().workout_log;if(!workout)return;const ex=workout.exercises[index];if(!ex||ex.finished)return;
  if(!workout.start_ms){workout.start_ms=Date.now();workout.start_time=new Date(workout.start_ms).toISOString();workout.status='active';}
  ex.started=true;ex.start_ms=ex.start_ms||Date.now();scheduleSave();render();
}
function completeSet(exIndex,setIndex) {
  const workout=activeLog().workout_log;const ex=workout?.exercises?.[exIndex];const set=ex?.sets?.[setIndex];if(!set||ex.finished)return;
  if(!workout.start_ms){workout.start_ms=Date.now();workout.start_time=new Date(workout.start_ms).toISOString();workout.status='active';}
  ex.started=true;set.completed=!set.completed;set.completed_at=set.completed?new Date().toISOString():null;
  if(set.completed&&n(ex.default_rest_sec)>0){ex.rest_until=Date.now()+n(ex.default_rest_sec)*1000;ex.last_completed_set=setIndex;startRestTicker();}
  else if(!set.completed){ex.rest_until=null;ex.last_completed_set=null;}
  scheduleSave();render();
}
function startRestTicker() {
  if(lastRestTick)return;
  lastRestTick=setInterval(()=>{
    const clock=$('rest-clock');if(!clock){clearInterval(lastRestTick);lastRestTick=null;return;}
    const until=n(clock.dataset.until);const seconds=Math.max(0,Math.ceil((until-Date.now())/1000));clock.textContent=`${String(Math.floor(seconds/60)).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`;
    if(seconds<=0){clock.textContent='00:00';clock.style.color='#bb6541';}
  },250);
}
function adjustRest(index,delta) { const ex=activeLog().workout_log?.exercises?.[index];if(!ex?.rest_until)return;ex.rest_until=Math.max(Date.now(),ex.rest_until+n(delta)*1000);scheduleSave();render();startRestTicker(); }
function addSet(index) { const ex=activeLog().workout_log?.exercises?.[index];if(!ex||ex.finished)return;const last=ex.sets[ex.sets.length-1]||{weight:0,reps:10};ex.sets.push({set_num:ex.sets.length+1,weight:n(last.weight),reps:n(last.reps),completed:false});scheduleSave();render(); }
function finishExercise(index) { const ex=activeLog().workout_log?.exercises?.[index];if(!ex)return;ex.finished=true;ex.started=false;ex.finished_at=new Date().toISOString();ex.rest_until=null;scheduleSave();render();toast(`${ex.name} finished.`); }
function finishSession() {
  const log=activeLog();const workout=log.workout_log;if(!workout)return;
  if(!workout.start_ms){toast('Start the session before finishing it.',true);return;}
  const end=Date.now();const hours=Math.max(0,(end-workout.start_ms)/3600000);const activeExercises=(workout.exercises||[]).filter(ex=>ex.started||ex.finished||ex.sets.some(s=>s.completed));const vals=activeExercises.map(ex=>Number(ex.met_value));const hasCompleteMET=activeExercises.length>0&&vals.every(value=>Number.isFinite(value)&&value>0);
  const averageMET=hasCompleteMET?vals.reduce((a,b)=>a+b,0)/vals.length:0;const burned=hasCompleteMET?round(averageMET*n(state.profile.weightKg)*hours):0;
  workout.end_ms=end;workout.end_time=new Date(end).toISOString();workout.total_calories_burned=burned;workout.duration_minutes=round((end-workout.start_ms)/60000,1);workout.status='completed';workout.exercises.forEach(ex=>{ex.started=false;if(!ex.finished&&ex.sets.some(s=>s.completed))ex.finished=true;});
  log.workout_history.push(workout);log.workout_log=null;scheduleSave();render();toast(hasCompleteMET?`Session saved · ${fmt(burned)} kcal estimated.`:'Session saved. Calorie estimate unavailable because one or more exercises have no MET values.');if(authUser)setTimeout(()=>syncNow(),350);
}

// Water and settings
function addWater(amount) {
  if(amount==='custom') { showModal(`${sheetHead('Add water')}<div class="field"><label for="customWaterAmount">AMOUNT (ML)</label><input id="customWaterAmount" type="number" inputmode="numeric" min="1" step="25" placeholder="e.g. 350" autofocus /></div><div class="modal-actions"><button class="cancel" data-action="close-modal">Cancel</button><button class="save lime" data-action="save-custom-water">Add water</button></div>`);return; }
  const ml=Math.round(n(amount));if(ml<=0)return;currentLog().water_log.push({entry_id:uid('water'),timestamp:new Date().toISOString(),amount_ml:ml});scheduleSave();render();toast(`${fmt(ml)} ml water logged.`);
}
function saveCustomWater() { const ml=Math.round(n($('customWaterAmount')?.value));if(ml<=0){toast('Enter an amount above zero.',true);return;}currentLog().water_log.push({entry_id:uid('water'),timestamp:new Date().toISOString(),amount_ml:ml});scheduleSave();closeModal();render();toast(`${fmt(ml)} ml water logged.`); }
function deleteWater(entryId) { const log=activeLog();const idx=log.water_log.findIndex(item=>(item.entry_id||item.timestamp)===entryId);if(idx<0)return;log.water_log.splice(idx,1);scheduleSave();render();toast('Water entry removed.'); }
function toDateTimeLocal(iso) { const d=new Date(iso);const pad=v=>String(v).padStart(2,'0');return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; }
function editWaterEntry(entryId) {
  const item=activeLog().water_log.find(x=>(x.entry_id||x.timestamp)===entryId);if(!item)return;
  showModal(`${sheetHead('Edit water')}<div class="field"><label for="editWaterAmount">AMOUNT (ML)</label><input id="editWaterAmount" type="number" min="1" step="25" value="${safe(item.amount_ml)}" /></div><div class="field"><label for="editWaterTime">TIME</label><input id="editWaterTime" type="datetime-local" value="${safe(toDateTimeLocal(item.timestamp))}" /></div><div class="modal-actions"><button class="cancel" data-action="close-modal">Cancel</button><button class="save lime" data-action="save-water-edit" data-id="${safe(entryId)}">Save changes</button></div>`);
}
function saveWaterEdit(entryId) {
  const item=activeLog().water_log.find(x=>(x.entry_id||x.timestamp)===entryId);if(!item)return;const amount=Math.round(n($('editWaterAmount')?.value));const time=$('editWaterTime')?.value;
  if(amount<1||!time||Number.isNaN(new Date(time).getTime())){toast('Enter a valid amount and time.',true);return;}
  item.amount_ml=amount;item.timestamp=new Date(time).toISOString();scheduleSave();closeModal();render();toast('Water entry updated.');
}
function renderSupabaseAccountSection() {
  const last=state.syncMeta?.lastSyncedAt?`Synced ${safe(new Date(state.syncMeta.lastSyncedAt).toLocaleString([], {dateStyle:'medium',timeStyle:'short'}))}`:'Not synced yet';
  return `<div class="setting-section"><div class="account-line"><strong>${safe(authUser?.email||'Signed in')}</strong><span>${last}</span></div><div class="button-stack"><button class="outline-button wide" data-action="sync-now">${syncing?'Syncing…':'↻ Sync now'}</button><button class="outline-button wide" data-action="export-data">↧ Export my data</button><button class="outline-button wide" data-action="auth-signout">Sign out</button></div></div>`;
}
function openSettings() {
  const p=state.profile;
  showModal(`${sheetHead('Settings')}
    <div class="setting-section"><div class="field-grid"><div class="field"><label for="targetCalories">CALORIES (KCAL)</label><input id="targetCalories" type="number" inputmode="numeric" min="500" max="10000" step="50" value="${safe(p.calorieTarget)}" /></div><div class="field"><label for="targetProtein">PROTEIN (G)</label><input id="targetProtein" type="number" inputmode="numeric" min="1" max="600" step="5" value="${safe(p.proteinTarget)}" /></div><div class="field"><label for="targetWater">WATER (ML)</label><input id="targetWater" type="number" inputmode="numeric" min="250" max="10000" step="250" value="${safe(p.waterTarget)}" /></div><div class="field"><label for="profileWeight">BODY WEIGHT (KG)</label><input id="profileWeight" type="number" inputmode="decimal" min="20" max="350" step="0.1" value="${safe(p.weightKg)}" /></div></div>
    <div class="switch-row"><div class="switch-copy"><strong>Add workout calories to my allowance</strong></div><label class="switch"><input type="checkbox" id="eatBackToggle" ${p.eatBack?'checked':''}><span class="switch-track"></span></label></div></div>
    ${renderSupabaseAccountSection()}
    <div class="modal-actions"><button class="cancel" data-action="close-modal">Cancel</button><button class="save lime" data-action="save-settings">Save</button></div>`);
}
function saveSettings() {
  const next={weightKg:n($('profileWeight')?.value),calorieTarget:Math.round(n($('targetCalories')?.value)),proteinTarget:Math.round(n($('targetProtein')?.value)),waterTarget:Math.round(n($('targetWater')?.value)),eatBack:!!$('eatBackToggle')?.checked};
  if(next.weightKg<20||next.calorieTarget<500||next.proteinTarget<1||next.waterTarget<250){toast('Check the target values and try again.',true);return;}
  state.profile=next;state.profileUpdatedAt=new Date().toISOString();state.syncMeta.pendingProfile=true;scheduleSave(false);closeModal();render();toast('Your targets have been updated.');
}
function supabaseConfigured() { const c=window.FORMA_SUPABASE_CONFIG||{};return !!(c.url&&c.publishableKey); }
let supabaseInitPromise=null;
async function initialiseSupabase() {
  if(supabaseClient)return;
  if(supabaseInitPromise)return supabaseInitPromise;
  if(!supabaseConfigured()){refreshSyncStatus();return;}
  if(!window.supabase?.createClient){setSyncStatus('Supabase library unavailable',true);updateAuthGate();return;}
  supabaseInitPromise=(async()=>{
    const config=window.FORMA_SUPABASE_CONFIG;
    const client=window.supabase.createClient(config.url,config.publishableKey,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});
    const {data,error}=await client.auth.getSession();if(error)throw error;
    supabaseClient=client;authUser=data.session?.user||null;
    supabaseClient.auth.onAuthStateChange((event,session)=>{
      authUser=session?.user||null;refreshSyncStatus();
      if(event==='SIGNED_IN')setTimeout(()=>loadCloudData().catch(err=>{console.error(err);render();toast('Signed in, but cloud download failed. Local tracking remains available.',true);}),0);
      if(event==='PASSWORD_RECOVERY')setTimeout(()=>{render();openPasswordUpdateModal();},0);
      if(event==='SIGNED_OUT')render();
    });
    if(authUser){
      try{await loadCloudData();}
      catch(error){console.error('Initial cloud pull failed:',error);toast('Signed in, but cloud refresh failed. Local tracking remains available.',true);}
    }
    refreshSyncStatus();
  })();
  try{await supabaseInitPromise;}
  catch(error){console.error('Supabase initialization failed',error);supabaseClient=null;setSyncStatus('Cloud connection failed',true);}
  finally{supabaseInitPromise=null;}
}
function normalizeRemoteLog(log,date) {
  const base={date,diet_log:{breakfast:[],lunch:[],dinner:[],snacks:[]},workout_log:null,workout_history:[],water_log:[],...log};
  if(!base.diet_log)base.diet_log={breakfast:[],lunch:[],dinner:[],snacks:[]};
  for(const meal of ['breakfast','lunch','dinner','snacks'])if(!Array.isArray(base.diet_log[meal]))base.diet_log[meal]=[];
  if(!Array.isArray(base.workout_history))base.workout_history=[];if(!Array.isArray(base.water_log))base.water_log=[];return base;
}
async function fetchCloudLogs(sinceTimestamp=null) {
  const collected=[];const pageSize=500;let offset=0;
  while(true) {
    let query=supabaseClient.from('daily_logs').select('date,content,updated_at').order('updated_at',{ascending:true}).range(offset,offset+pageSize-1);
    if(sinceTimestamp)query=query.gt('updated_at',sinceTimestamp);
    const {data,error}=await query;if(error)throw error;
    collected.push(...(data||[]));
    if(!data||data.length<pageSize)break;
    offset+=pageSize;
  }
  return collected;
}
async function loadCloudData() {
  if(!supabaseClient||!authUser)return;
  const userId=authUser.id;state.syncMeta=state.syncMeta||freshState().syncMeta;
  // Keep browser data separated when accounts change on a shared device.
  const previousOwner=state.syncMeta.userId;
  if(previousOwner&&previousOwner!==userId){
    const snapshot=JSON.parse(JSON.stringify(state));
    try{await idbRequest('kv','put',{key:`app_state_user_${previousOwner}`,value:snapshot});}catch(_){}
    try{localStorage.setItem(`forma_state_user_${previousOwner}`,JSON.stringify(snapshot));}catch(_){}
    let restored=null;
    try{const cached=await idbRequest('kv','get',`app_state_user_${userId}`);restored=cached?.value||null;}catch(_){}
    if(!restored){try{restored=JSON.parse(localStorage.getItem(`forma_state_user_${userId}`)||'null');}catch(_) {}}
    const date=state.activeDate;
    state=restored?{...freshState(),...restored,profile:{...DEFAULT_PROFILE,...restored.profile}}:{...freshState(),activeDate:date};
  }
  if(state.syncMeta.userId!==userId){state.syncMeta={...freshState().syncMeta,userId,hasCompletedSync:false,hasCompletedPull:false,lastCloudPullAt:null};}
  const meta=state.syncMeta;
  // Only fetch the full timeline the first time this browser loads an account.
  // Later logins transfer only date rows updated since the last successful pull.
  const needsFullPull=!meta.hasCompletedPull||!meta.lastCloudPullAt;
  const [remoteLogs,profileResult,foodsResult]=await Promise.all([
    fetchCloudLogs(needsFullPull?null:meta.lastCloudPullAt),
    supabaseClient.from('user_profiles').select('profile,updated_at').eq('id',userId).maybeSingle(),
    supabaseClient.from('user_custom_foods').select('id,data,updated_at')
  ]);
  if(profileResult.error)throw profileResult.error;if(foodsResult.error)throw foodsResult.error;
  suppressDirtyTracking=true;
  try {
    const remoteDates=new Set(remoteLogs.map(r=>r.date));
    for(const row of remoteLogs){
      const remoteLog=normalizeRemoteLog(row.content||{},row.date);remoteLog.updated_at=row.updated_at||remoteLog.updated_at||new Date(0).toISOString();
      const local=state.logs[row.date];const dirty=(meta.dirtyDates||[]).includes(row.date);
      const localTs=new Date(local?.updated_at||0).getTime();const remoteTs=new Date(remoteLog.updated_at||0).getTime();
      if(!local||(!dirty&&remoteTs>localTs))state.logs[row.date]=remoteLog;
      else if(localTs>remoteTs&&!dirty)meta.dirtyDates=Array.from(new Set([...(meta.dirtyDates||[]),row.date]));
    }
    // Only a full pull can prove which local dates are absent in the cloud.
    if(needsFullPull){
      for(const date of Object.keys(state.logs)){
        const local=state.logs[date];
        // Do not create cloud rows for auto-created but still-empty days.
        if(!remoteDates.has(date)&&(local.updated_at||logHasData(local)))meta.dirtyDates=Array.from(new Set([...(meta.dirtyDates||[]),date]));
      }
    }
    const newestCloudLog=remoteLogs.reduce((latest,row)=>!row.updated_at||row.updated_at<=latest?latest:row.updated_at,'');
    if(newestCloudLog&&(!meta.lastCloudPullAt||newestCloudLog>meta.lastCloudPullAt))meta.lastCloudPullAt=newestCloudLog;
    const remoteProfile=profileResult.data;
    if(remoteProfile?.profile){
      if(!meta.pendingProfile&&new Date(remoteProfile.updated_at||0).getTime()>new Date(state.profileUpdatedAt||0).getTime()){
        state.profile={...DEFAULT_PROFILE,...remoteProfile.profile};state.profileUpdatedAt=remoteProfile.updated_at;
      }
    } else meta.pendingProfile=true;
    const remoteFoods=foodsResult.data||[];const remoteIds=new Set(remoteFoods.map(r=>r.id));
    for(const row of remoteFoods){
      const idx=state.customFoods.findIndex(f=>f.id===row.id);const local=idx>=0?state.customFoods[idx]:null;
      const localTs=new Date(local?.updated_at||local?.created_at||0).getTime();const remoteTs=new Date(row.updated_at||0).getTime();
      if(!local)state.customFoods.push({...row.data,id:row.id,updated_at:row.updated_at});
      else if(!(meta.dirtyFoodIds||[]).includes(row.id)&&remoteTs>localTs)state.customFoods[idx]={...row.data,id:row.id,updated_at:row.updated_at};
      else if(localTs>remoteTs&&!(meta.dirtyFoodIds||[]).includes(row.id))meta.dirtyFoodIds=Array.from(new Set([...(meta.dirtyFoodIds||[]),row.id]));
    }
    for(const food of state.customFoods){if(!remoteIds.has(food.id))meta.dirtyFoodIds=Array.from(new Set([...(meta.dirtyFoodIds||[]),food.id]));}
    meta.userId=userId;meta.hasCompletedPull=true;
  } finally { suppressDirtyTracking=false; }
  await persistState();render();refreshSyncStatus();
}
async function syncNow() {
  if(!supabaseClient||!authUser){toast('Configure Supabase and sign in before syncing.',true);return;}
  if(syncing)return;
  syncing=true;setSyncStatus('Syncing…');
  try {
    clearTimeout(saveTimer);await (saveQueue=saveQueue.then(persistState));
    const meta=state.syncMeta;
    // Send only date logs explicitly marked dirty. The initial cloud pull identifies local-only dates,
    // so first sync does not need to rewrite every date already stored in Supabase.
    const selectedLogs=(meta.dirtyDates||[]).map(date=>state.logs[date]).filter(Boolean);
    const now=new Date().toISOString();
    const logRows=selectedLogs.map(log=>{
      // date and updated_at already live in typed SQL columns; omit duplicate copies from JSONB.
      const content={...log};delete content.date;delete content.updated_at;
      return {user_id:authUser.id,date:log.date,content,updated_at:log.updated_at||now};
    });
    for(let i=0;i<logRows.length;i+=50){
      const {data,error}=await supabaseClient.from('daily_logs').upsert(logRows.slice(i,i+50),{onConflict:'user_id,date'}).select('date,updated_at');
      if(error)throw error;
      for(const row of data||[])if(state.logs[row.date])state.logs[row.date].updated_at=row.updated_at;
    }
    const shouldSyncProfile=!!meta.pendingProfile;
    if(shouldSyncProfile){
      const {data,error}=await supabaseClient.from('user_profiles').upsert({id:authUser.id,profile:state.profile,updated_at:now},{onConflict:'id'}).select('updated_at').single();
      if(error)throw error;state.profileUpdatedAt=data?.updated_at||now;
    }
    const foodIds=(meta.dirtyFoodIds||[]);
    const selectedFoods=state.customFoods.filter(f=>foodIds.includes(f.id));const foodRows=selectedFoods.map(food=>{
      const data={...food};delete data.id;delete data.updated_at;delete data.created_at;
      return {user_id:authUser.id,id:food.id,data,updated_at:food.updated_at||food.created_at||now};
    });
    for(let i=0;i<foodRows.length;i+=50){
      const {data,error}=await supabaseClient.from('user_custom_foods').upsert(foodRows.slice(i,i+50),{onConflict:'user_id,id'}).select('id,updated_at');
      if(error)throw error;
      for(const row of data||[]){const food=state.customFoods.find(item=>item.id===row.id);if(food)food.updated_at=row.updated_at;}
    }
    const sentDates=new Set(selectedLogs.map(log=>log.date));meta.dirtyDates=(meta.dirtyDates||[]).filter(date=>!sentDates.has(date));meta.dirtyFoodIds=(meta.dirtyFoodIds||[]).filter(id=>!foodIds.includes(id));if(shouldSyncProfile)meta.pendingProfile=false;
    meta.hasCompletedSync=true;meta.userId=authUser.id;meta.lastSyncedAt=now;meta.hasCompletedPull=true;
    await persistState();render();refreshSyncStatus();toast(`Sync complete · ${logRows.length} date logs, ${foodRows.length} recipes.`);
  } catch(error) { console.error('Supabase sync failed:',error);setSyncStatus('Sync failed · changes kept locally',true);toast(error.message||'Sync failed. Your local data is safe.',true); }
  finally { syncing=false;refreshSyncStatus(); }
}
function updateAuthGate() {
  const gate=$('authGate'),shell=$('appShell');if(!gate||!shell)return;
  if(authUser){gate.classList.add('hidden');shell.classList.remove('hidden');return;}
  gate.classList.remove('hidden');shell.classList.add('hidden');
  const configured=supabaseConfigured()&&!!window.supabase?.createClient;
  const notice=$('authSetupNotice');
  if(notice){
    notice.classList.toggle('hidden',configured);
    const span=notice.querySelector('span');
    if(span&&!supabaseConfigured())span.textContent='Add your Supabase Project URL and publishable key to supabase-config.js. Do not put a secret or service-role key in this browser app.';
    else if(span&&!window.supabase?.createClient)span.textContent='The Supabase client library did not load. Check your internet connection or serve a local copy of the Supabase JS v2 library.';
  }
  gate.querySelectorAll('input').forEach(input=>input.disabled=!configured);
  gate.querySelectorAll('[data-action="auth-signin"],[data-action="auth-signup"],[data-action="auth-google"],[data-action="auth-reset"]').forEach(button=>button.disabled=!configured);
}
async function handleAuth(mode) {
  if(!supabaseClient){toast('Supabase is not configured yet. Add the Project URL and publishable key first.',true);updateAuthGate();return;}
  const email=$('authEmail')?.value.trim();const password=$('authPassword')?.value||'';
  if(!email||!password){toast('Enter both email and password.',true);return;}
  if(password.length<8){toast('Use a password with at least 8 characters.',true);return;}
  try {
    const result=mode==='signup'?await supabaseClient.auth.signUp({email,password}):await supabaseClient.auth.signInWithPassword({email,password});
    if(result.error)throw result.error;
    if(mode==='signup'&&!result.data.session){toast('Account created. Check your email to confirm, then return here to sign in.');return;}
    // The single auth-state listener performs the cloud pull, avoiding duplicate reads.
    toast(mode==='signup'?'Account created. Loading your Timely Fit workspace…':'Signed in. Loading your Timely Fit workspace…');
  } catch(error) { toast(error.message||'Authentication failed.',true); }
}
async function handleGoogleAuth() {
  if(!supabaseClient){toast('Supabase is not configured yet. Add the Project URL and publishable key first.',true);updateAuthGate();return;}
  try {
    const redirectTo=`${window.location.origin}${window.location.pathname}${window.location.search}`;
    const {error}=await supabaseClient.auth.signInWithOAuth({provider:'google',options:{redirectTo}});
    if(error)throw error;
  } catch(error) { toast(error.message||'Google sign-in could not start.',true); }
}
async function handlePasswordReset() {
  if(!supabaseClient){toast('Configure Supabase before requesting a password reset.',true);return;}
  const email=$('authEmail')?.value.trim();if(!email){toast('Enter your email first, then tap Forgot password.',true);return;}
  try {
    const redirectTo=`${window.location.origin}${window.location.pathname}`;
    const {error}=await supabaseClient.auth.resetPasswordForEmail(email,{redirectTo});if(error)throw error;
    toast('Password reset email requested. Check your inbox.');
  } catch(error) { toast(error.message||'Could not send reset email.',true); }
}
async function signOut() {
  if(!supabaseClient)return;const {error}=await supabaseClient.auth.signOut();if(error){toast(error.message,true);return;}
  authUser=null;refreshSyncStatus();render();toast('Signed out. The main app is locked until you sign in again.');
}
function openPasswordUpdateModal() {
  showModal(`${modalHead('ACCOUNT SECURITY','Choose a new password','Use at least 8 characters. This updates the password for your Timely Fit account.')}<div class="field"><label for="newAccountPassword">NEW PASSWORD</label><input id="newAccountPassword" type="password" autocomplete="new-password" minlength="8" placeholder="At least 8 characters" /></div><div class="modal-actions"><button class="save lime" data-action="save-new-password">Update password</button></div>`);
}
async function saveNewPassword() {
  const password=$('newAccountPassword')?.value||'';if(password.length<8){toast('Use a password with at least 8 characters.',true);return;}
  try{const {error}=await supabaseClient.auth.updateUser({password});if(error)throw error;closeModal();render();toast('Password updated successfully.');}
  catch(error){toast(error.message||'Could not update password.',true);}
}
function exportData() {
  const output={exported_at:new Date().toISOString(),schema_version:1,user_profile:state.profile,daily_logs:Object.values(state.logs).map(log=>{const totals=logTotals(log);return {user_id:'local_user',date:log.date,daily_totals:{net_calories:round(totals.net),protein_g:round(totals.protein,2),carbs_g:round(totals.carbs,2),fat_g:round(totals.fat,2),water_ml:Math.round(totals.water),calories_burned:Math.round(totals.burned)},diet_log:log.diet_log,workout_log:log.workout_log,workout_history:log.workout_history,water_log:log.water_log};}),user_custom_foods:state.customFoods};
  const blob=new Blob([JSON.stringify(output,null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=`timely-fit-export-${toDateKey(new Date())}.json`;document.body.appendChild(a);a.click();a.remove();URL.revokeObjectURL(url);toast('Export prepared.');
}

// Event delegation

document.addEventListener('click', async (event)=>{
  const button=event.target.closest('[data-action]');if(!button)return;
  const action=button.dataset.action;
  if(action==='backdrop-close'&&event.target!==button)return;
  if(action==='backdrop-close'){closeModal();return;}
  if(action==='close-modal'){closeModal();return;}
  event.preventDefault();
  switch(action){
    case 'domain': state.selectedDomain=button.dataset.value;render();persistState();break;
    case 'tab': state.selectedTab=button.dataset.tab;render();persistState();break;
    case 'choose-date': state.activeDate=button.dataset.date;expandedWaterLog=false;currentLog();render();persistState();break;
    case 'open-settings': openSettings();break;
    case 'open-add': openCurrentAdd();break;
    case 'open-food': openFoodModal(button.dataset.meal||'breakfast');break;
    case 'select-food': selectFoodInPicker(button.dataset.id);break;
    case 'confirm-add-food': addSelectedFood();break;
    case 'edit-food': openEditFood(button.dataset.id);break;
    case 'delete-food': removeFoodEntry(button.dataset.id);break;
    case 'save-food-edit': saveFoodEdit();break;
    case 'open-recipe': openRecipeModal();break;
    case 'recipe-add-ingredient': recipeIngredients.push({foodId:'',amount:100,unit:'g',query:''});renderRecipeIngredients();break;
    case 'recipe-select-ingredient': selectRecipeIngredient(n(button.dataset.index),button.dataset.id);break;
    case 'recipe-remove-ingredient': recipeIngredients.splice(n(button.dataset.index),1);renderRecipeIngredients();break;
    case 'save-recipe': saveRecipe();break;
    case 'add-exercise': openWorkoutModal();break;
    case 'select-exercise': activeExerciseSelection=button.dataset.id;updateExerciseDetail();break;
    case 'exercise-back': activeExerciseSelection=null;updateExerciseDetail();renderExerciseResults($('exerciseSearch')?.value||'');break;
    case 'ex-chip': { const input=$('exerciseSearch');if(input)input.value=button.dataset.q;document.querySelectorAll('[data-action="ex-chip"]').forEach(b=>b.classList.toggle('active',b===button));renderExerciseResults(button.dataset.q);break; }
    case 'food-filter': activeFoodFilter=button.dataset.value;document.querySelectorAll('[data-action="food-filter"]').forEach(b=>b.classList.toggle('active',b===button));renderFoodResults($('foodSearch')?.value||'');break;
    case 'food-back': showFoodStep(1);break;
    case 'pick-meal': { const input=$('foodMeal');if(input)input.value=button.dataset.value;document.querySelectorAll('[data-action="pick-meal"]').forEach(b=>b.classList.toggle('active',b===button));break; }
    case 'open-exercise-detail': openExerciseDetail(button.dataset.id);break;
    case 'edit-exercise': openEditExercise(n(button.dataset.exIndex));break;
    case 'edit-add-set': editExerciseAddSet();break;
    case 'edit-remove-set': editExerciseRemoveSet(n(button.dataset.setIndex));break;
    case 'save-exercise-edit': saveExerciseEdit();break;
    case 'delete-exercise': deleteExerciseEntry(button);break;
    case 'save-exercise': saveExerciseSetup();break;
    case 'start-session': startSession();break;
    case 'start-exercise': startExercise(n(button.dataset.exIndex));break;
    case 'toggle-exercise': { const ex=activeLog().workout_log?.exercises?.[n(button.dataset.exIndex)];if(ex){ex.started=false;scheduleSave();render();} break; }
    case 'complete-set': completeSet(n(button.dataset.exIndex),n(button.dataset.setIndex));break;
    case 'add-set': addSet(n(button.dataset.exIndex));break;
    case 'finish-exercise': finishExercise(n(button.dataset.exIndex));break;
    case 'finish-session': finishSession();break;
    case 'adjust-rest': adjustRest(n(button.dataset.exIndex),n(button.dataset.seconds));break;
    case 'add-water': addWater(button.dataset.amount);break;
    case 'save-custom-water': saveCustomWater();break;
    case 'toggle-water-log': expandedWaterLog=!expandedWaterLog;render();break;
    case 'delete-water': deleteWater(button.dataset.id);break;
    case 'edit-water': editWaterEntry(button.dataset.id);break;
    case 'save-water-edit': saveWaterEdit(button.dataset.id);break;
    case 'save-settings': saveSettings();break;
    case 'previous-period': shiftAnalyticsPeriod(-1);break;
    case 'next-period': shiftAnalyticsPeriod(1);break;
    case 'auth-signin': await handleAuth('signin');break;
    case 'auth-signup': await handleAuth('signup');break;
    case 'auth-google': await handleGoogleAuth();break;
    case 'auth-reset': await handlePasswordReset();break;
    case 'save-new-password': await saveNewPassword();break;
    case 'auth-signout': await signOut();break;
    case 'sync-now': await syncNow();break;
    case 'export-data': exportData();break;
    case 'set-period': analyticsPeriod=button.dataset.value;render();break;
  }
});

document.addEventListener('input',(event)=>{
  const target=event.target;
  if(target.id==='foodSearch'){renderFoodResults(target.value);return;}
  if(target.id==='foodAmount'){updateSelectedFoodPreview();return;}
  if(target.id==='foodUnit'){updateSelectedFoodPreview();return;}
  if(target.dataset.role==='recipe-search'){const i=n(target.dataset.index);const ing=recipeIngredients[i];if(ing){ing.query=target.value;if(findFood(ing.foodId)?.name.toLowerCase()!==target.value.trim().toLowerCase())ing.foodId='';renderRecipeSearchResults(i,target.value);updateRecipePreview();}return;}
  if(target.id==='exerciseSearch'){document.querySelectorAll('[data-action="ex-chip"]').forEach(b=>b.classList.toggle('active',b.dataset.q.toLowerCase()===target.value.trim().toLowerCase()));renderExerciseResults(target.value);return;}
  if(['targetSets','targetReps','startingWeight','weightIncrement'].includes(target.id)||target.id==='progressiveToggle'){updateSetPreview();return;}
  if(target.id==='recipeYield'){updateRecipePreview();return;}
});
document.addEventListener('change',(event)=>{
  const target=event.target;
  if(target.id==='datePicker'&&target.value){state.activeDate=target.value;currentLog();render();persistState();return;}
  if(target.id==='recipeYield'){updateRecipePreview();return;}
  if(target.id==='progressiveToggle'){updateSetPreview();return;}
  if(target.dataset.role==='recipe-unit'){const i=n(target.dataset.index);if(recipeIngredients[i]){recipeIngredients[i].unit=target.value;updateRecipePreview();}return;}
  if(target.dataset.role==='recipe-amount'){const i=n(target.dataset.index);if(recipeIngredients[i]){recipeIngredients[i].amount=Math.max(.01,n(target.value));updateRecipePreview();}return;}
  if(target.dataset.role==='set-weight'||target.dataset.role==='set-reps'){
    const ex=activeLog().workout_log?.exercises?.[n(target.dataset.exIndex)];const set=ex?.sets?.[n(target.dataset.setIndex)];if(!set)return;
    if(target.dataset.role==='set-weight')set.weight=Math.max(0,n(target.value));else set.reps=Math.max(0,Math.round(n(target.value)));
    scheduleSave();return;
  }
  if(target.id==='foodAmount')return;
});
$('prevDate').addEventListener('click',()=>{state.activeDate=shiftDate(state.activeDate,-1);currentLog();render();persistState();});
$('nextDate').addEventListener('click',()=>{state.activeDate=shiftDate(state.activeDate,1);currentLog();render();persistState();});
$('settingsButton').addEventListener('click',openSettings);
$('globalAdd').addEventListener('click',openCurrentAdd);
function openCurrentAdd() {
  if(state.selectedTab==='dashboard'){state.selectedTab='timeline';render();persistState();}
  if(state.selectedDomain==='diet')openFoodModal(autoMeal(),null,true);
  else if(state.selectedDomain==='workout')openWorkoutModal();
  else addWater('custom');
}
function toast(message,error=false) {
  const region=$('toastRegion');if(!region)return;const el=document.createElement('div');el.className=`toast ${error?'error':''}`;el.textContent=message;region.appendChild(el);setTimeout(()=>{el.style.opacity='0';el.style.transform='translateY(5px)';setTimeout(()=>el.remove(),220);},2400);
}

// Keep the visible rest timer ticking without rebuilding inputs or losing focus.
setInterval(()=>{
  const clock=$('rest-clock');if(!clock)return;const seconds=Math.max(0,Math.ceil((n(clock.dataset.until)-Date.now())/1000));clock.textContent=`${String(Math.floor(seconds/60)).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`;if(seconds===0)clock.style.color='#bb6541';
},500);

// Batch background sync every five minutes after the user has completed the first explicit sync.
setInterval(()=>{
  const meta=state.syncMeta||{};
  const pending=(meta.dirtyDates||[]).length||(meta.dirtyFoodIds||[]).length||meta.pendingProfile;
  if(authUser&&!syncing&&meta.hasCompletedSync&&pending)syncNow();
},300000);

const supabaseSdkScript=$('supabaseSdk');
if(supabaseSdkScript&&!window.supabase?.createClient){
  supabaseSdkScript.addEventListener('load',async()=>{await initialiseSupabase();render();},{once:true});
  supabaseSdkScript.addEventListener('error',()=>{updateAuthGate();}, {once:true});
}
initialise();
