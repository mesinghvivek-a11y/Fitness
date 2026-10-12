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
const domainMeta = {
  diet: { title: 'Food journal', eyebrow: 'NOURISH YOUR DAY', icon: '🍎' },
  workout: { title: 'Training log', eyebrow: 'SHOW UP STRONG', icon: '🏋️' },
  water: { title: 'Hydration', eyebrow: 'KEEP YOUR FLOW', icon: '💧' }
};
let db = null;
let masterFoods = [];
let masterExercises = [];
let externalFoodMatches = [];
let externalFoodSearchTerm = '';
let barcodeStream = null;
let barcodeScanTimer = null;
let barcodeReaderControls = null;
let barcodeReader = null;
let foodSearchTimer = null;
let foodKindFilters = { ingredients: true, recipes: true };
let activeExerciseBodyFilter = 'all';
let activeExerciseEquipmentFilter = 'all';
let recipeReturnMeal = 'breakfast';
let state = freshState();
let expandedWaterLog = false;
let activeFoodSelection = null;
let activeFoodMeal = 'breakfast';
let editFoodEntryId = null;
let editExerciseIndex = null;
let editExerciseLocation = null;
const numberWheelTimers = new WeakMap();
let activeExerciseSelection = null;
let exerciseDetailReturnState = null;
let recipeIngredients = [];
let activeRecipeIngredient = null;
let analyticsPeriod = 'weekly';
let supabaseClient = null;
let authUser = null;
let localOnlyMode = false;
let syncing = false;
let suppressDirtyTracking = false;
let saveQueue = Promise.resolve();
let lastRestTick = null;
let autoSyncTimer = null;
let universalAddMode = 'ingredient';

function freshState() {
  return {
    version: 1,
    selectedDomain: 'diet',
    selectedTab: 'timeline',
    activeDate: toDateKey(new Date()),
    profile: { ...DEFAULT_PROFILE },
    logs: {},
    customFoods: [],
    externalFoods: [],
    recentFoodIds: [],
    recentExerciseIds: [],
    syncMeta: { dirtyDates: [], dirtyFoodIds: [], pendingProfile: false, hasCompletedSync: false, hasCompletedPull: false, userId: null, lastSyncedAt: null, lastCloudPullAt: null },
    profileUpdatedAt: null,
    preferences: { lastMasterSeed: 1, darkMode: false }
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
  const macros={calories:0,protein:0,carbs:0,fat:0,fiber:0};let fiberUnknownItems=0;
  for (const meal of MEALS) for (const item of (log.diet_log?.[meal.key]||[])) {
    for (const k of Object.keys(macros)) {
      if(k==='fiber'&&item.fiber_data_available===false){fiberUnknownItems++;continue;}
      macros[k]+=n(item.macros?.[k]);
    }
  }
  const water= (log.water_log||[]).reduce((sum,item)=>sum+n(item.amount_ml),0);
  const sessions=workoutSessions(log);
  const burned=sessions.reduce((sum,s)=>sum+n(s.total_calories_burned),0);
  const net=macros.calories-(state.profile.eatBack?burned:0);
  return {...macros,fiberUnknownItems,water,burned,net,remaining:state.profile.calorieTarget+(state.profile.eatBack?burned:0)-macros.calories};
}
function activeLog() { return currentLog(state.activeDate); }
function allFoods() { return [...masterFoods,...(state.externalFoods||[]),...(state.customFoods||[])]; }
function findFood(id) { return allFoods().find(food=>food.id===id); }
function findExercise(id) { return masterExercises.find(ex=>ex.id===id); }
function exerciseHasLicensedMedia(ex) { return ex?.media_status==='licensed' && !!ex.image && !!ex.gif_url; }
function renderExerciseThumbnail(ex,size='regular') {
  const glyph=exerciseEmoji(ex?.primary_muscle||ex?.target||'');
  const licensed=exerciseHasLicensedMedia(ex);
  const image=licensed ? `<img src="${safe(ex.image)}" alt="" loading="lazy" onerror="this.hidden=true;this.nextElementSibling.hidden=false"><span class="exercise-thumb-placeholder" hidden>${glyph}</span>` : `<span class="exercise-thumb-placeholder">${glyph}</span>`;
  return `<button type="button" class="exercise-media-trigger ${size}" data-action="open-exercise-detail" data-id="${safe(ex?.id||ex?.exercise_id||'')}" aria-label="View ${safe(ex?.name||'exercise')} demonstration">${image}</button>`;
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
function foodCategory(food) { return food?.category || (food?.type==='custom_recipe'?'Recipes':'Other/Mixed'); }
function foodSourceLabel(food) { return food?.data_source || (food?.type==='custom_recipe'?'Your recipe':food?.type==='standard_estimate'?'Timely Fit estimate':'Timely Fit library'); }
function foodFiberKnown(food) { return food?.fiber_data_available!==false && (food?.nutrient_fields_available ? food.nutrient_fields_available.includes('fiber') : true); }
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
  scheduleAutoSync();
}
function scheduleAutoSync(delay=18000) {
  if(!authUser||!state.syncMeta?.hasCompletedPull)return;
  clearTimeout(autoSyncTimer);
  autoSyncTimer=setTimeout(()=>{
    const meta=state.syncMeta||{};
    const pending=(meta.dirtyDates||[]).length||(meta.dirtyFoodIds||[]).length||meta.pendingProfile;
    if(authUser&&!syncing&&pending)syncNow({quiet:true});
  },delay);
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
  else if(localOnlyMode) setSyncStatus('Local only · not synced');
  else setSyncStatus('Saved locally');
}
function registerServiceWorker() {
  if ('serviceWorker' in navigator && (location.protocol==='https:'||location.hostname==='localhost'||location.hostname==='127.0.0.1')) {
    navigator.serviceWorker.register('./sw.js').catch(err=>console.info('Offline cache not enabled:',err));
  }
}
async function initialise() {
  try { db=await openDatabase(); } catch(error) { console.warn('IndexedDB unavailable; using local storage',error); }
  if(!supabaseConfigured()){try{localOnlyMode=localStorage.getItem('forma_local_only_mode')==='true';}catch(_){}}
  const stored=db?await idbRequest('kv','get','app_state').catch(()=>null):null;
  if(stored?.value) state={...freshState(),...stored.value,profile:{...DEFAULT_PROFILE,...stored.value.profile}};
  else {
    try { const local=JSON.parse(localStorage.getItem('forma_state_fallback')||'null'); if(local) state={...freshState(),...local,profile:{...DEFAULT_PROFILE,...local.profile}}; } catch(_) {}
  }
  if(state.selectedTab==='analyze') state.selectedTab='dashboard';
  state.externalFoods=Array.isArray(state.externalFoods)?state.externalFoods:[];
  state.recentFoodIds=Array.isArray(state.recentFoodIds)?state.recentFoodIds:[];
  state.recentExerciseIds=Array.isArray(state.recentExerciseIds)?state.recentExerciseIds:[];
  state.syncMeta={...freshState().syncMeta,...(state.syncMeta||{})};
  state.preferences={...freshState().preferences,...(state.preferences||{})};
  applyTheme();
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
  if(!authUser&&!localOnlyMode) { updateAuthGate(); return; }
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
  // A generous date window makes the strip genuinely scrollable while the active date remains centred.
  const dates=Array.from({length:31},(_,i)=>shiftDate(state.activeDate,i-15));
  const today=toDateKey(new Date());
  host.innerHTML=dates.map(key=>{
    const d=parseDateKey(key); const day=d.toLocaleDateString('en-IN',{weekday:'short'}).toUpperCase();
    const active=key===state.activeDate; const istoday=key===today;
    return `<button class="date-pill ${active?'active':''} ${istoday?'today':''}" data-action="choose-date" data-date="${key}" aria-pressed="${active}" aria-label="${istoday?'Today, ':''}${prettyLongDate(key)}"><span class="date-day">${istoday?'TODAY':day}</span><strong>${d.toLocaleDateString('en-IN',{month:'short',day:'numeric'})}</strong></button>`;
  }).join('');
  requestAnimationFrame(()=>{const active=host.querySelector('.date-pill.active');if(active){const delta=active.getBoundingClientRect().left-host.getBoundingClientRect().left-host.clientWidth/2+active.clientWidth/2;host.scrollTo({left:host.scrollLeft+delta,behavior:'auto'});}});
}
function renderTimeline() {
  const domain=domainMeta[state.selectedDomain];
  const log=activeLog();
  const totals=logTotals(log);
  let body='';
  if(state.selectedDomain==='diet') body=renderDiet(log,totals);
  else if(state.selectedDomain==='workout') body=renderWorkout(log,totals);
  else body=renderWater(log,totals);
  return `${body}`;
}
function renderStreak(log,totals) {
  const calorieGoal=state.profile.calorieTarget+(state.profile.eatBack?totals.burned:0);
  const rem=Math.max(0,state.profile.calorieTarget-totals.net);
  const netLabel=state.profile.eatBack?'NET CALORIES':'CALORIES';
  return `<section class="streak-card">
    <div class="streak-top"><div><div class="streak-label">DAILY TARGETS · ${state.profile.eatBack?'EAT-BACK ON':'EAT-BACK OFF'}</div><div class="streak-headline">Your day, in balance</div><div class="streak-sub">${fmt(rem)} kcal left to your goal</div></div></div>
    <div class="progress-stack">
      <div class="progress-row"><div class="progress-label">${netLabel}</div><div class="progress-track"><div class="progress-fill" style="width:${pct(totals.net,state.profile.calorieTarget)}%"></div></div><div class="progress-value">${fmt(totals.net)} <span>/ ${fmt(state.profile.calorieTarget)}</span></div></div>
      <div class="progress-row"><div class="progress-label">Protein</div><div class="progress-track"><div class="progress-fill protein" style="width:${pct(totals.protein,state.profile.proteinTarget)}%"></div></div><div class="progress-value">${fmt(totals.protein)}g <span>/ ${fmt(state.profile.proteinTarget)}g</span></div></div>
      <div class="progress-row"><div class="progress-label">Water</div><div class="progress-track"><div class="progress-fill water" style="width:${pct(totals.water,state.profile.waterTarget)}%"></div></div><div class="progress-value">${fmt(totals.water)} <span>/ ${fmt(state.profile.waterTarget)}ml</span></div></div>
    </div>
    <div class="eat-back-note"><span class="tiny-dot"></span>${state.profile.eatBack?`Workout allowance includes ${fmt(totals.burned)} active kcal`:'Targets stay fixed; workout calories are not added back'}</div>
  </section>`;
}
function itemsCount(log) { return MEALS.reduce((sum,meal)=>sum+(log.diet_log[meal.key]||[]).length,0); }
function renderDiet(log,totals) {
  const meals=MEALS.map(meal=>{
    const items=log.diet_log[meal.key]||[];
    const kcal=items.reduce((sum,item)=>sum+n(item.macros?.calories),0);
    const itemHTML=items.length?items.map(item=>`<article class="food-entry">
      <div class="food-thumb">${nutritionEmoji(findFood(item.food_id)||item)}</div>
      <div class="food-entry-copy"><div class="food-entry-name">${safe(item.name)}</div><div class="food-entry-meta">${safe(item.amount_label||`${fmt(item.amount)} ${item.unit||''}`)}</div><div class="food-macro-chips"><span class="macro-protein">P ${fmt(item.macros?.protein,1)}g</span><span class="macro-carbs">C ${fmt(item.macros?.carbs,1)}g</span><span class="macro-fat">F ${fmt(item.macros?.fat,1)}g</span></div></div>
      <div class="food-entry-macros"><strong>${fmt(item.macros?.calories)}</strong><div class="food-entry-meta">kcal</div></div>
      <div class="entry-tools"><button class="mini-icon" title="Edit entry" data-action="edit-food" data-id="${item.entry_id}">✎</button><button class="mini-icon" title="Delete entry" data-action="delete-food" data-id="${item.entry_id}">×</button></div>
    </article>`).join(''):`<div class="empty-meal"><span>${meal.hint}</span><button data-action="open-food" data-meal="${meal.key}">＋ Add food</button></div>`;
    return `<section class="meal-section meal-${meal.key}"><div class="meal-head"><div class="meal-title"><span class="meal-symbol">${meal.icon}</span>${meal.label}<span class="meal-meta">${items.length?`${items.length} item${items.length>1?'s':''}`:''}</span></div><div style="display:flex;align-items:center;gap:7px"><span class="meal-meta">${kcal?fmt(kcal)+' kcal':''}</span><button class="meal-add" data-action="open-food" data-meal="${meal.key}" aria-label="Add to ${meal.label}">＋</button></div></div><div class="meal-items">${itemHTML}</div></section>`;
  }).join('');
  return `<div class="section-title-row" style="margin-top:2px"><h3>Today’s plate</h3><span class="meal-meta">${itemsCount(log)} items logged</span></div>
    ${meals}
    <div class="nutri-summary">
      <div class="micro-card"><div class="micro-label">CARBS</div><div class="micro-value">${fmt(totals.carbs,1)}<span style="font-size:var(--fs-cap)">g</span></div><div class="micro-unit">of daily intake</div></div>
      <div class="micro-card"><div class="micro-label">FAT</div><div class="micro-value">${fmt(totals.fat,1)}<span style="font-size:var(--fs-cap)">g</span></div><div class="micro-unit">of daily intake</div></div>
      <div class="micro-card"><div class="micro-label">FIBER</div><div class="micro-value">${fmt(totals.fiber,1)}<span style="font-size:var(--fs-cap)">g</span></div><div class="micro-unit">of daily intake</div></div>
    </div>
    ${totals.fiberUnknownItems?`<div class="food-source-note">Fibre total includes only foods whose source reported fibre. ${totals.fiberUnknownItems} logged item${totals.fiberUnknownItems===1?' has':'s have'} no fibre data, so this figure is incomplete.</div>`:''}
    <div style="display:flex;justify-content:space-between;align-items:center;margin:13px 2px 0;color:#94a097;font-size:var(--fs-cap)"><span>✳ Estimates marked with * are approximate</span><button class="muted-link" data-action="open-food">＋ Log food</button></div>`;
}
function renderWorkout(log,totals) {
  const workout=log.workout_log;
  const completedSessions=(log.workout_history||[]).slice().reverse();
  const historyMarkup=completedSessions.map(session=>{
    const performed=(session.exercises||[]).filter(ex=>ex.finished||(ex.sets||[]).some(st=>st.completed));
    const exercises=performed.map(ex=>{
      const reference=findExercise(ex.exercise_id)||ex;
      const doneSets=(ex.sets||[]).filter(st=>st.completed);
      const setSummary=doneSets.length?doneSets.map((st,i)=>`Set ${i+1}: ${fmt(st.weight,1)} kg × ${fmt(st.reps)}`).join(' · '):'Exercise completed';
      const startedAt=n(ex.start_ms)||n(session.start_ms);
      const endedAt=Date.parse(ex.finished_at||'')||n(session.end_ms)||Date.parse(session.end_time||'');
      const exDuration=startedAt&&endedAt&&endedAt>=startedAt?formatDurationHMS(endedAt-startedAt):'—';
      return `<div class="completed-exercise-row"><div class="completed-exercise-media">${renderExerciseThumbnail(reference,'history')}</div><div class="completed-exercise-copy"><div class="completed-exercise-title"><strong>${safe(ex.name)}</strong><button type="button" class="history-edit-button" data-action="edit-history-exercise" data-session-index="${(log.workout_history||[]).indexOf(session)}" data-ex-index="${(session.exercises||[]).indexOf(ex)}" aria-label="Edit ${safe(ex.name)}">Edit</button></div><span>${safe(ex.primary_muscle||ex.target||'Full body')} · ${safe(ex.equipment||'Bodyweight')}</span><small>${setSummary}</small></div><div class="completed-exercise-duration"><b>${exDuration}</b><span>duration</span></div><span class="completed-check" aria-label="Completed">✓</span></div>`;
    }).join('');
    const sessionStart=n(session.start_ms)||Date.parse(session.start_time||'');
    const sessionEnd=n(session.end_ms)||Date.parse(session.end_time||'');
    const durationMs=sessionStart&&sessionEnd&&sessionEnd>=sessionStart?sessionEnd-sessionStart:n(session.duration_minutes)*60000;
    return `<article class="completed-session-card"><div class="completed-session-heading"><div><span class="completed-kicker">WORKOUT SAVED</span><h3>Training session</h3><span class="completed-session-meta">${session.end_time?new Date(session.end_time).toLocaleDateString('en-IN',{day:'numeric',month:'short'})+' · '+timeLabel(session.end_time):'Completed'}</span></div><div class="completed-session-total"><b>${formatDurationHMS(durationMs)}</b><span>TOTAL DURATION</span></div></div><div class="completed-session-stats"><span>${performed.length} exercises</span><span>${performed.reduce((sum,ex)=>sum+(ex.sets||[]).filter(st=>st.completed).length,0)} sets completed</span><strong>${fmt(session.total_calories_burned)} kcal</strong></div><div class="completed-exercise-list">${exercises||'<div class="empty-chart">No completed exercise details were saved for this session.</div>'}</div></article>`;
  }).join('');
  const historySection=completedSessions.length?`<div class="section-title-row completed-today-heading"><h3>Completed today</h3><span class="meal-meta">${completedSessions.length} session${completedSessions.length===1?'':'s'}</span></div>${historyMarkup}`:'';
  if(!workout) {
    return `<section class="workout-hero"><div><div class="eyebrow">${completedSessions.length?'NICE WORK':'READY WHEN YOU ARE'}</div><h2>${completedSessions.length?'Session in the books.':'Build your session.'}</h2><p>${completedSessions.length?'Your completed exercises and set details stay in today’s log.':'Log sets. Track progress. Keep it moving.'}</p></div><button class="primary-button" data-action="add-exercise">＋ EXERCISE</button></section>
      ${historySection||`<section class="workout-empty"><div class="empty-graphic">🏋️</div><h3>Nothing logged yet</h3><p>Add an exercise to set your reps, starting weight and progression. Your rest timer will take it from there.</p><button class="primary-button" data-action="add-exercise">＋ Add first exercise</button></section>`}`;
  }
  const isStarted=!!workout.start_ms&&!workout.ended;
  const exerciseCards=(workout.exercises||[]).map((ex,index)=>renderExerciseCard(ex,index,workout)).join('');
  const doneSets=(workout.exercises||[]).reduce((sum,ex)=>sum+ex.sets.filter(s=>s.completed).length,0);
  const allSets=(workout.exercises||[]).reduce((sum,ex)=>sum+ex.sets.length,0);
  return `<section class="workout-hero ${isStarted?'session-active':''}"><div class="workout-hero-copy"><div class="eyebrow">${isStarted?'SESSION IN PROGRESS':'SESSION BUILDER'}</div><h2>${isStarted?'Stay in your groove.':'Your training plan.'}</h2>${isStarted?`<div class="session-live-clock" aria-live="off"><span class="live-clock-dot"></span><strong id="session-clock" data-start-ms="${workout.start_ms}">${formatDurationHMS(Date.now()-workout.start_ms)}</strong><span>elapsed</span></div><p>${doneSets}/${allSets} sets complete</p>`:'<p>Add exercises, then press start.</p>'}</div><button class="primary-button ${isStarted?'lime':''}" data-action="${isStarted?'finish-session':'start-session'}">${isStarted?'⏹ FINISH':'▶ START SESSION'}</button></section>
    <div class="section-title-row"><h3>Exercises <span style="color:#9aa69a;font-weight:500">(${workout.exercises.length})</span></h3><button class="muted-link" data-action="add-exercise">＋ Add exercise</button></div>
    ${exerciseCards}
    <div class="session-summary"><div><strong>${doneSets}/${allSets}</strong><span>SETS DONE</span></div><div><strong>${calcVolume(workout)}</strong><span>VOLUME · KG</span></div><div><strong>${fmt(totals.burned)}</strong><span>KCAL BURNED TODAY</span></div></div>
    ${isStarted?`<button class="finish-button" data-action="finish-session">⏹ FINISH SESSION & CALCULATE CALORIES</button>`:''}
    ${historySection}
    <div style="font-size:var(--fs-cap);color:#98a499;text-align:center;margin:13px 0 0;line-height:1.5">Session calories use available MET values × body weight × elapsed hours. Imported exercises without a verified MET value are not assigned a fabricated value.</div>`;
}
function durationLabel(ms) { const mins=Math.max(0,Math.floor(ms/60000)); return mins>=60?`${Math.floor(mins/60)}h ${mins%60}m`:`${mins} min`; }
function formatDurationHMS(ms) { const sec=Math.max(0,Math.floor(n(ms)/1000));return `${String(Math.floor(sec/3600)).padStart(2,'0')}:${String(Math.floor((sec%3600)/60)).padStart(2,'0')}:${String(sec%60).padStart(2,'0')}`; }
function calcVolume(workout) { return fmt((workout.exercises||[]).reduce((sum,ex)=>sum+ex.sets.reduce((s,set)=>s+n(set.weight)*n(set.reps)*(set.completed?1:0),0),0)); }
function renderExerciseCard(ex,index,workout) {
  const started=!!ex.started && !ex.finished;
  const done=!!ex.finished;
  const completedSets=ex.sets.filter(s=>s.completed).length;
  const totalVolume=ex.sets.reduce((sum,s)=>sum+(s.completed?n(s.weight)*n(s.reps):0),0);
  const sets=ex.sets.map((set,sidx)=>`<div class="set-row"><div class="set-num">SET ${sidx+1}</div><input class="set-input" type="number" min="0" step="0.5" aria-label="Weight for set ${sidx+1}" value="${safe(set.weight??0)}" data-role="set-weight" data-ex-index="${index}" data-set-index="${sidx}" ${done?'disabled':''}/><input class="set-input" type="number" min="0" step="1" aria-label="Reps for set ${sidx+1}" value="${safe(set.reps??10)}" data-role="set-reps" data-ex-index="${index}" data-set-index="${sidx}" ${done?'disabled':''}/><button class="set-complete ${set.completed?'checked':''}" data-action="complete-set" data-ex-index="${index}" data-set-index="${sidx}" ${done?'disabled':''} aria-label="Mark set ${sidx+1} complete">${set.completed?'✓':'○'}</button></div>`).join('');
  const restSec=n(ex.default_rest_sec||60);
  const reference=findExercise(ex.exercise_id)||ex;
  const completedSummary=ex.sets.map((set,i)=>set.completed?`<span>✓ ${i+1}: ${fmt(set.weight,1)} kg × ${fmt(set.reps)}</span>`:null).filter(Boolean).join('');
  return `<article class="exercise-card active-exercise-card ${done?'exercise-finished':''}"><div class="exercise-card-header">${renderExerciseThumbnail(reference,'timeline')}<div class="exercise-main"><div class="exercise-name">${safe(ex.name)}</div><div class="exercise-meta">${safe(ex.primary_muscle||'Full body')} · ${safe(ex.equipment||'Bodyweight')} · ${restSec?`${restSec}s rest`:'no rest preset'}</div></div><span class="exercise-state ${done?'done':''}">${done?'DONE':`${completedSets}/${ex.sets.length} SETS`}</span><button type="button" class="mini-icon" data-action="edit-exercise" data-ex-index="${index}" aria-label="Edit ${safe(ex.name)}">✎</button></div>
    <div class="exercise-start-row"><div class="exercise-stats"><strong>${completedSets}/${ex.sets.length} sets completed</strong><span>${totalVolume?fmt(totalVolume)+' kg completed volume':'Target: '+ex.sets.length+' sets'}</span></div><button class="exercise-start ${started?'running':''}" data-action="${started?'toggle-exercise':'start-exercise'}" data-ex-index="${index}" ${done?'disabled':''}>${done?'✓ COMPLETE':started?'⌃ Hide sets':'＋ Expand sets'}</button></div>
    ${completedSummary?`<div class="set-summary-line">${completedSummary}</div>`:''}
    ${started?`<div class="sets-panel"><div class="sets-header"><span>SET</span><span>WEIGHT KG</span><span>REPS / MIN</span><span>DONE</span></div>${sets}<div class="set-actions"><button class="outline-button full" data-action="add-set" data-ex-index="${index}">＋ Add set</button><button class="outline-button full" data-action="finish-exercise" data-ex-index="${index}">Finish exercise</button></div>${ex.rest_until&&ex.last_completed_set!=null?`<div class="rest-timer"><div class="rest-timer-text">⏱ <span>REST</span> <span class="rest-clock" id="rest-clock-${index}" data-until="${ex.rest_until}">--:--</span></div><div class="timer-adjust"><button data-action="adjust-rest" data-ex-index="${index}" data-seconds="-30">−30s</button><button data-action="adjust-rest" data-ex-index="${index}" data-seconds="30">+30s</button></div></div>`:''}</div>`:''}</article>`;
}
function exerciseEmoji(muscle='') { const x=String(muscle).toLowerCase(); if(x.includes('chest'))return '🏋️';if(x.includes('back'))return '🧗';if(x.includes('leg')||x.includes('hamstring')||x.includes('glute'))return '🦵';if(x.includes('arm')||x.includes('bicep')||x.includes('tricep'))return '💪';if(x.includes('core'))return '🧘';if(x.includes('shoulder'))return '🏋️';if(x.includes('full'))return '🏃';return '🏋️'; }
function renderWater(log,totals) {
  const percentage=pct(totals.water,state.profile.waterTarget);
  const quick=`<div class="quick-water"><button class="quick-water-btn" data-action="add-water" data-amount="250">💧 +250 ml<span>Small glass</span></button><button class="quick-water-btn" data-action="add-water" data-amount="500">🥤 +500 ml<span>Large glass</span></button><button class="quick-water-btn custom" data-action="add-water" data-amount="custom">🚰 Custom<span>Enter amount</span></button></div>`;
  const sorted=[...(log.water_log||[])].sort((a,b)=>String(b.timestamp).localeCompare(String(a.timestamp)));
  const visible=expandedWaterLog?sorted:sorted.slice(0,3);
  const waterRows=visible.map(item=>`<div class="water-log-row"><div class="water-log-icon">💧</div><div class="water-log-info"><strong>${fmt(item.amount_ml)} ml</strong><span>${timeLabel(item.timestamp)} · ${new Date(item.timestamp).toLocaleDateString('en-IN',{day:'numeric',month:'short'})}</span></div><strong class="water-log-amount">+${fmt(item.amount_ml)} ml</strong><div class="water-entry-actions"><button class="mini-icon" data-action="edit-water" data-id="${safe(item.entry_id||item.timestamp)}" aria-label="Edit water entry">✎</button><button class="mini-icon" data-action="delete-water" data-id="${safe(item.entry_id||item.timestamp)}" aria-label="Delete water entry">×</button></div></div>`).join('');
  return `${quick}<section class="water-hero"><div class="water-hero-top"><div><div class="eyebrow">YOUR HYDRATION GOAL</div><h2>Stay in flow.</h2><p>${percentage>=100?'Goal reached. Keep listening to your body.':`${fmt(Math.max(0,state.profile.waterTarget-totals.water))} ml to go today`}</p></div><button class="water-big-number" data-action="toggle-water-log" aria-label="Manage water entries">${fmt(totals.water)}<span> ml</span></button></div><div class="water-progress"><div style="width:${percentage}%"></div></div><div style="display:flex;justify-content:space-between;margin-top:8px;position:relative;z-index:1;color:#6694a2;font-size:var(--fs-cap)"><span>${fmt(percentage)}% completed</span><span>Goal ${fmt(state.profile.waterTarget)} ml</span></div></section>
    <div class="section-title-row"><h3>Hydration timeline</h3><button class="muted-link" data-action="toggle-water-log">${expandedWaterLog?'Show recent':'Manage all entries'}</button></div>
    <div class="water-log-list">${waterRows||'<div class="empty-state"><div class="empty-icon">💦</div>Your first glass is one tap away.</div>'}</div>
    ${!expandedWaterLog&&sorted.length>3?`<button class="outline-button" style="width:100%;margin-top:8px" data-action="toggle-water-log">View all ${sorted.length} entries</button>`:''}
    <div style="font-size:var(--fs-cap);color:#98a499;text-align:center;margin:17px 0 0">Hydration entries are editable and deletable. Changes sync automatically when an account is connected.</div>`;
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
  const label=analyticsPeriod==='daily'?'SELECTED DAY TARGETS':`DAILY AVERAGE · ${analyticsPeriod==='weekly'?'7 DAYS':`${days} DAYS`}`;
  const caloriesLeft=state.profile.calorieTarget-values.net;
  const rows=[
    {label:state.profile.eatBack?'Net calories':'Calories',value:values.net,goal:state.profile.calorieTarget,unit:'kcal',kind:'calorie'},
    {label:'Protein',value:values.protein,goal:state.profile.proteinTarget,unit:'g',kind:'protein'},
    {label:'Hydration',value:values.water,goal:state.profile.waterTarget,unit:'ml',kind:'water'}
  ];
  return `<section class="streak-card dashboard-target-card"><div class="streak-top"><div><div class="streak-label">${label}</div><div class="streak-headline">Your target history</div><div class="streak-sub">${safe(periodLabel())} · ${fmt(Math.max(0,caloriesLeft))} kcal ${analyticsPeriod==='daily'?'remaining':'remaining on average'}</div></div></div><div class="progress-stack">${rows.map(row=>`<div class="progress-row"><div class="progress-label">${row.label}</div><div class="progress-track"><div class="progress-fill ${row.kind==='protein'?'protein':row.kind==='water'?'water':''}" style="width:${pct(row.value,row.goal)}%"></div></div><div class="progress-value">${fmt(row.value,row.kind==='water'?0:1)}<span> / ${fmt(row.goal)}${row.unit}</span></div></div>`).join('')}</div><div class="eat-back-note"><span class="tiny-dot"></span>${state.profile.eatBack?`Workout estimate included · ${fmt(sum.burned/days)} kcal burned per day on average`:'Workout calories do not change the nutrition allowance'}</div></section>`;
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
  if(!any)return '<div class="empty-chart">Complete sets to populate the body-part heatmap.</div>';
  return `<div class="heatmap-wrap"><div class="heatmap-grid" style="--heat-cols:${buckets.length}"><div class="heatmap-corner"></div>${buckets.map(b=>`<div class="heatmap-day">${safe(b.label)}</div>`).join('')}${rows.map(row=>`<div class="heatmap-muscle">${row}</div>${buckets.map((_,i)=>{const v=grid[row][i];const opacity=v?Math.min(.95,.18+v*.12):.06;return `<div class="heatmap-cell" title="${row}: ${v} completed sets" style="--heat-alpha:${opacity}">${v||''}</div>`;}).join('')}`).join('')}</div><div class="heatmap-caption">Completed sets by body part · dates grouped by week in monthly view</div></div>`;
}
function renderAnalytics() {
  const periods=`<div class="period-toggle" role="tablist" aria-label="Dashboard range">${[['daily','Daily'],['weekly','Weekly'],['monthly','Monthly']].map(([key,label])=>`<button class="${analyticsPeriod===key?'active':''}" data-action="set-period" data-value="${key}">${label}</button>`).join('')}</div>`;
  const title=state.selectedDomain==='diet'?'Nutrition overview':state.selectedDomain==='workout'?'Training performance':'Hydration overview';
  const content=state.selectedDomain==='diet'?renderDietAnalytics():state.selectedDomain==='workout'?renderWorkoutAnalytics():renderWaterAnalytics();
  const leftDisabled=false,rightDisabled=false;
  return `${renderDashboardTargets()}${periods}<div class="period-range"><button class="period-arrow" data-action="previous-period" aria-label="Previous ${analyticsPeriod} range" ${leftDisabled?'disabled':''}>‹</button><div class="period-range-copy"><strong>${safe(periodLabel())}</strong><span>${analyticsPeriod==='daily'?'Daily view':analyticsPeriod==='weekly'?'Monday – Sunday':'Calendar month'}</span></div><button class="period-arrow" data-action="next-period" aria-label="Next ${analyticsPeriod} range" ${rightDisabled?'disabled':''}>›</button></div><div class="section-title-row dashboard-section-title"><h3>${title}</h3><span class="meal-meta">${analyticsPeriod.toUpperCase()}</span></div>${content}`;
}
function renderDietAnalytics() {
  const periods=logsForPeriod(); const totals=periods.reduce((s,x)=>({calories:s.calories+x.totals.calories,protein:s.protein+x.totals.protein,carbs:s.carbs+x.totals.carbs,fat:s.fat+x.totals.fat,fiber:s.fiber+x.totals.fiber,burned:s.burned+x.totals.burned}),{calories:0,protein:0,carbs:0,fat:0,fiber:0,burned:0});
  const d=logTotals(currentLog(state.activeDate));const days=Math.max(1,periods.length);const avg={calories:totals.calories/days,protein:totals.protein/days,carbs:totals.carbs/days,fat:totals.fat/days,fiber:totals.fiber/days,burned:totals.burned/days};
  const target=state.profile.calorieTarget+(state.profile.eatBack?avg.burned:0);
  const macroRing=(name,val,goal,color)=>`<div class="macro-ring-card"><div class="ring" style="background:conic-gradient(${color} ${pct(val,goal)}%,#edf1e9 ${pct(val,goal)}% 100%)"><strong>${fmt(val)}g</strong></div><div class="macro-name">${name}</div><div class="macro-small">${fmt(val/Math.max(1,goal)*100)}% of goal</div></div>`;
  const bars=chartBuckets(periods,x=>x.totals.calories,x=>state.profile.calorieTarget+(state.profile.eatBack?x.totals.burned:0));
  const insights=dietInsight(analyticsPeriod==='daily'?d:avg,target);
  const macroLabel=analyticsPeriod==='daily'?'Selected day':'Average per day';
  return `<div class="analysis-card"><div class="analysis-card-head"><div><div class="analysis-card-title">Calories logged</div><div class="analysis-card-sub">${analyticsPeriod==='daily'?'One-day intake':`Daily average bars · ${periodLabel().toLowerCase()}`}</div></div><span class="card-badge">${fmt(d.calories)} / ${fmt(state.profile.calorieTarget+(state.profile.eatBack?d.burned:0))} kcal selected day</span></div><div class="analysis-number-row"><div class="analysis-number">${fmt(totals.calories)}</div><div class="analysis-unit">kcal logged in period</div></div>${renderBarChart(bars,'orange')}<div class="chart-legend"><div class="legend-item"><span class="legend-dot orange"></span>Calories eaten</div><div class="legend-item"><span class="legend-dot" style="background:#fa9d83"></span>Daily goal${state.profile.eatBack?' incl. workout estimate':''}: ${fmt(state.profile.calorieTarget)} kcal${state.profile.eatBack?' + burn':''}</div></div></div>
    <div class="analysis-card"><div class="analysis-card-head"><div><div class="analysis-card-title">Macro balance</div><div class="analysis-card-sub">${macroLabel} · consumed vs macro targets</div></div></div><div class="macro-rings">${macroRing('Protein',analyticsPeriod==='daily'?d.protein:avg.protein,state.profile.proteinTarget,'#c8f16d')}${macroRing('Carbs',analyticsPeriod==='daily'?d.carbs:avg.carbs,Math.round(state.profile.calorieTarget*.45/4),'#8cd3e9')}${macroRing('Fat',analyticsPeriod==='daily'?d.fat:avg.fat,Math.round(state.profile.calorieTarget*.30/9),'#ffc5a8')}</div></div>
    <div class="analysis-card"><div class="analysis-card-head"><div><div class="analysis-card-title">Meal distribution</div><div class="analysis-card-sub">${analyticsPeriod==='daily'?'Selected day':'Across the selected range'}</div></div></div>${renderMealDonut(aggregateMealLog(periods))}</div>
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
  return `<section class="insight-card"><div class="insight-kicker">✳ TIMELY FIT INSIGHT</div><div class="insight-title">${title}</div><div class="insight-body">${body}</div><div class="insight-foot"><span></span>Simple rule-based coaching · not medical advice</div></section>`;
}
function renderWorkoutAnalytics() {
  const entries=logsForPeriod();
  const sessions=entries.flatMap(x=>x.log?workoutSessions(x.log).map(s=>({...s,date:x.date})):[]).filter(s=>s.ended||s.total_calories_burned>0);
  const allWorkouts=entries.flatMap(x=>x.log?workoutSessions(x.log).map(s=>({...s,date:x.date})):[]);
  const exCounts={};const exercisePeaks={};let totalVolume=0,totalSets=0,totalBurn=0;
  allWorkouts.forEach(s=>{totalBurn+=n(s.total_calories_burned);(s.exercises||[]).forEach(ex=>{const muscle=ex.primary_muscle||'Other';exCounts[muscle]=(exCounts[muscle]||0)+ex.sets.filter(st=>st.completed).length;ex.sets.filter(st=>st.completed).forEach(st=>{totalVolume+=n(st.weight)*n(st.reps);totalSets++;const label=ex.name;exercisePeaks[label]=Math.max(exercisePeaks[label]||0,n(st.weight));});});});
  const muscleEntries=Object.entries(exCounts).sort((a,b)=>b[1]-a[1]).slice(0,5);const muscleSum=muscleEntries.reduce((s,x)=>s+x[1],0);
  const colors=['#c8f16d','#8cd3e9','#ffc5a8','#c5bdf7','#9bd1a8'];let cursor=0;const stops=muscleEntries.map((x,i)=>{const start=cursor;cursor+=muscleSum?x[1]/muscleSum*100:0;return `${colors[i]} ${start}% ${cursor}%`;}).join(',');
  const donut=muscleSum?`<div class="donut-row"><div class="donut" style="background:conic-gradient(${stops})"><div class="donut-center"><strong>${fmt(totalSets)}</strong><span>SETS</span></div></div><div class="legend-list">${muscleEntries.map((x,i)=>`<div class="legend-row"><span class="legend-square" style="background:${colors[i]}"></span><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${safe(x[0])}</span><strong>${x[1]}</strong></div>`).join('')}</div></div>`:`<div class="empty-chart">Complete a workout set to build your muscle-group distribution.</div>`;
  const volumeTrend=chartBuckets(entries,x=>x.log?workoutSessions(x.log).reduce((a,s)=>a+(s.exercises||[]).reduce((v,ex)=>v+ex.sets.reduce((st,set)=>st+(set.completed?n(set.weight)*n(set.reps):0),0),0),0):0,0);
  const lineValues=Object.entries(exercisePeaks).slice(-8); const maxPeak=Math.max(1,...lineValues.map(x=>x[1]));
  let line='';
  if(lineValues.length){const coords=lineValues.map((x,i)=>`${10+i*(180/Math.max(1,lineValues.length-1))},${105-(x[1]/maxPeak*80)}`).join(' ');line=`<svg viewBox="0 0 200 120" width="100%" height="130" role="img" aria-label="Highest completed weight by exercise"><path d="M10 105 H190" stroke="#e8eee4" stroke-width="1" fill="none"/><polyline points="${coords}" fill="none" stroke="#80b95a" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>${lineValues.map((x,i)=>`<circle cx="${10+i*(180/Math.max(1,lineValues.length-1))}" cy="${105-(x[1]/maxPeak*80)}" r="3.2" fill="#c7f36c" stroke="#fff" stroke-width="1.5"/>`).join('')}</svg><div class="legend-list">${lineValues.map(x=>`<div class="legend-row"><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${safe(x[0])}</span><strong>${fmt(x[1],1)} kg</strong></div>`).join('')}</div>`;} else line=`<div class="empty-chart">Your top weights appear after you complete sets.</div>`;
  const insights=workoutInsight(totalSets,totalVolume,allWorkouts.length);
  return `<div class="analysis-card"><div class="analysis-card-head"><div><div class="analysis-card-title">Muscle group distribution</div><div class="analysis-card-sub">Completed sets by primary muscle group</div></div></div>${donut}</div>
    <div class="analysis-card"><div class="analysis-card-head"><div><div class="analysis-card-title">Strength snapshot</div><div class="analysis-card-sub">Highest recorded working weight per exercise</div></div><span class="card-badge">${lineValues.length} movements</span></div>${line}</div>
    <div class="analysis-card"><div class="analysis-card-head"><div><div class="analysis-card-title">Total volume load</div><div class="analysis-card-sub">Completed sets × reps × weight · kg</div></div><span class="card-badge">${fmt(totalVolume)} kg</span></div>${totalVolume?`<div class="volume-bars">${volumeTrend.map((item,i)=>`<div><div class="vbar" style="height:${Math.max(3,pct(item.value,Math.max(1,...volumeTrend.map(x=>x.value))))}%"></div><small>${safe(item.label)}</small></div>`).join('')}</div>`:`<div class="empty-chart">Log completed weighted sets to see training volume.</div>`}</div>
    <div class="analysis-card"><div class="analysis-card-head"><div><div class="analysis-card-title">Body-part heatmap</div><div class="analysis-card-sub">Completed sets across the selected range</div></div></div>${renderWorkoutHeatmap(entries)}</div>
    <div class="analysis-card"><div class="analysis-card-head"><div><div class="analysis-card-title">Training summary</div><div class="analysis-card-sub">${periodLabel()}</div></div></div><div class="nutri-summary" style="margin:0"><div class="micro-card"><div class="micro-label">SESSIONS</div><div class="micro-value">${allWorkouts.length}</div><div class="micro-unit">logged</div></div><div class="micro-card"><div class="micro-label">SETS</div><div class="micro-value">${totalSets}</div><div class="micro-unit">completed</div></div><div class="micro-card"><div class="micro-label">BURN</div><div class="micro-value">${fmt(totalBurn)}</div><div class="micro-unit">kcal estimate</div></div></div></div>${insights}`;
}
function workoutInsight(sets,volume,sessions) { let title='Build the base';let body='Add a workout and log completed sets to build a useful training history.';if(sets>=12){title='Strong training consistency';body=`You've completed ${sets} sets and logged ${fmt(volume)} kg of volume in this period. Compare like-for-like exercises across weeks rather than chasing every session.`;}else if(sets>0){title='Every completed set counts';body=`${sets} sets are in the log so far. Aim to record the actual reps and load you complete; a reliable baseline makes progressive overload more meaningful.`;}return `<section class="insight-card"><div class="insight-kicker">✳ TRAINING INSIGHT</div><div class="insight-title">${title}</div><div class="insight-body">${body}</div><div class="insight-foot"><span></span>Based on logged sessions · estimates can vary</div></section>`; }
function renderWaterAnalytics() {
  const periods=logsForPeriod();const consumed=periods.reduce((s,x)=>s+x.totals.water,0);const dailyAvg=consumed/Math.max(1,periods.length);const completed=periods.filter(x=>x.totals.water>=state.profile.waterTarget).length;
  const bars=chartBuckets(periods,x=>x.totals.water,()=>state.profile.waterTarget);
  let title='Make hydration easy';let body='Keep water within reach and use a quick-add button after each glass. Your progress becomes clearer as you log more days.';
  if(consumed){if(completed>0){title=`${completed} goal ${completed===1?'day':'days'} reached`;body=`You hit your ${fmt(state.profile.waterTarget)} ml target on ${completed} ${completed===1?'day':'days'} in this period. Keep the routine realistic and consistent.`;}else{title='Small sips add up';body=`Your average is ${fmt(dailyAvg)} ml per day. You are ${fmt(Math.max(0,state.profile.waterTarget-dailyAvg))} ml below your daily target on average.`;}}
  return `<div class="analysis-card"><div class="analysis-card-head"><div><div class="analysis-card-title">Hydration intake</div><div class="analysis-card-sub">Daily amount vs target line</div></div><span class="card-badge">Goal ${fmt(state.profile.waterTarget)} ml</span></div><div class="analysis-number-row"><div class="analysis-number">${fmt(consumed/Math.max(1,periods.length))}</div><div class="analysis-unit">ml average per day</div></div>${renderBarChart(bars,'blue')}<div class="chart-legend"><div class="legend-item"><span class="legend-dot blue"></span>Water logged</div><div class="legend-item"><span class="legend-dot orange"></span>Daily target</div></div></div>
    <div class="analysis-card"><div class="analysis-card-head"><div><div class="analysis-card-title">Hydration consistency</div><div class="analysis-card-sub">Days meeting the daily target</div></div></div><div class="analysis-number-row"><div class="analysis-number">${completed}</div><div class="analysis-unit">of ${periods.length} days met target</div></div><div class="progress-track" style="height:9px;margin-top:13px;background:#edf2ef"><div class="progress-fill water" style="width:${pct(completed,periods.length)}%"></div></div></div>
    <section class="insight-card"><div class="insight-kicker">✳ HYDRATION INSIGHT</div><div class="insight-title">${title}</div><div class="insight-body">${body}</div><div class="insight-foot"><span></span>General guidance; individual needs vary</div></section>`;
}

// Modal shell and diet logging
function showModal(html) {
  $('modalRoot').innerHTML=`<div class="modal-backdrop" data-action="backdrop-close"><section class="modal-sheet" role="dialog" aria-modal="true">${html}</section></div>`;
  upgradeNumberWheels($('modalRoot'));
}
function numericWheelEligible(input) {
  if(!input || input.type!=='number')return false;
  const id=input.id||'';
  return ['foodAmount','recipeYield','targetSets','targetReps','startingWeight','weightIncrement','editRest','customIngredientDefault','customWaterAmount','editWaterAmount'].includes(id)
    || /^editSet(?:Weight|Reps)\d+$/.test(id)
    || input.dataset.role==='recipe-amount'
    || input.closest('.recipe-ingredient')!==null;
}
function wheelStep(input) {
  const parsed=Number(input.step);return Number.isFinite(parsed)&&parsed>0?parsed:1;
}
function wheelBounds(input) {
  let min=input.min!==''&&Number.isFinite(Number(input.min))?Number(input.min):0;
  let max=input.max!==''&&Number.isFinite(Number(input.max))?Number(input.max):10000;
  if(input.id==='foodAmount'||input.dataset.role==='recipe-amount'){min=0.1;max=5000;}
  if(input.id==='recipeYield'){min=1;max=100;}
  if(input.id==='targetSets'){min=1;max=20;}
  if(input.id==='targetReps'){min=1;max=100;}
  if(input.id==='startingWeight'){min=0;max=500;}
  if(input.id==='weightIncrement'){min=0;max=50;}
  if(input.id==='editRest'){min=0;max=1800;}
  return {min,max};
}
function wheelDigits(step) {const text=String(step);return text.includes('.')?Math.min(3,text.split('.')[1].length):0;}
function wheelDisplay(value,step) {return Number(value).toLocaleString('en-US',{minimumFractionDigits:0,maximumFractionDigits:wheelDigits(step)});}
function upgradeNumberWheels(root=document) {
  if(!root)return;
  const all=[];
  if(root.matches?.('input[type=number]'))all.push(root);
  all.push(...(root.querySelectorAll?.('input[type=number]')||[]));
  for(const input of all){
    if(!numericWheelEligible(input)||input.dataset.wheelReady==='1')continue;
    const originalParent=input.parentNode;if(!originalParent)continue;
    const slot=document.createElement('div');slot.className='number-wheel-slot';
    originalParent.insertBefore(slot,input);slot.appendChild(input);input.classList.add('number-wheel-source');input.dataset.wheelReady='1';
    const wheel=document.createElement('div');wheel.className='number-wheel';wheel.tabIndex=0;wheel.setAttribute('role','spinbutton');wheel.setAttribute('aria-label',input.getAttribute('aria-label')||document.querySelector(`label[for="${CSS.escape(input.id)}"]`)?.textContent?.trim()||'Adjust value');
    wheel.innerHTML='<div class="number-wheel-list"></div><div class="number-wheel-focus" aria-hidden="true"></div>';
    slot.appendChild(wheel);
    const updateValue=(next,dispatch=true)=>{
      const {min,max}=wheelBounds(input),step=wheelStep(input),digits=wheelDigits(step);
      next=clamp(round(next,digits),min,max);input.value=String(next);
      wheel.setAttribute('aria-valuemin',String(min));wheel.setAttribute('aria-valuemax',String(max));wheel.setAttribute('aria-valuenow',String(next));wheel.setAttribute('aria-valuetext',wheelDisplay(next,step));
      const list=wheel.querySelector('.number-wheel-list');list.innerHTML=Array.from({length:7},(_,i)=>{const offset=i-3,val=clamp(round(next+offset*step,digits),min,max);return `<div class="number-wheel-item ${offset===0?'is-current':''}" data-offset="${offset}" data-value="${val}"><span>${wheelDisplay(val,step)}</span></div>`;}).join('');
      const rowHeight=parseFloat(getComputedStyle(wheel.querySelector('.number-wheel-item')).height)||36;wheel.dataset.recentering='1';wheel.scrollTop=2*rowHeight;requestAnimationFrame(()=>{delete wheel.dataset.recentering;});
      if(dispatch){input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));}
    };
    input._wheelRefresh=()=>updateValue(n(input.value),false);
    input._wheelSet=(value,dispatch=true)=>updateValue(value,dispatch);
    updateValue(n(input.value),false);
    const finishScroll=()=>{
      if(wheel.dataset.recentering==='1')return;
      const rowHeight=parseFloat(getComputedStyle(wheel.querySelector('.number-wheel-item')).height)||36,centerItem=Math.round(wheel.scrollTop/rowHeight)+1,delta=centerItem-3;
      if(delta)updateValue(n(input.value)+delta*wheelStep(input),true);else updateValue(n(input.value),false);
    };
    wheel.addEventListener('scroll',()=>{
      if(wheel.dataset.recentering==='1')return;
      clearTimeout(numberWheelTimers.get(wheel));numberWheelTimers.set(wheel,setTimeout(finishScroll,90));
    },{passive:true});
    wheel.addEventListener('click',event=>{const item=event.target.closest('.number-wheel-item');if(item)updateValue(n(input.value)+n(item.dataset.offset)*wheelStep(input),true);});
    wheel.addEventListener('keydown',event=>{
      const step=wheelStep(input);let delta=0;
      if(event.key==='ArrowUp')delta=step;
      else if(event.key==='ArrowDown')delta=-step;
      else if(event.key==='PageUp')delta=step*5;
      else if(event.key==='PageDown')delta=-step*5;
      else return;
      event.preventDefault();updateValue(n(input.value)+delta,true);
    });
    const lab=document.querySelector(`label[for="${CSS.escape(input.id)}"]`);
    if(lab)lab.addEventListener('click',()=>wheel.focus({preventScroll:true}));
  }
}
function refreshNumberWheel(input) {if(input?._wheelRefresh)input._wheelRefresh();}

function closeModal() {
  stopBarcodeScanner();
  $('modalRoot').innerHTML=''; activeFoodSelection=null; editFoodEntryId=null; activeRecipeIngredient=null; editExerciseIndex=null; editExerciseLocation=null;
  const returnState=exerciseDetailReturnState; exerciseDetailReturnState=null;
  if(returnState){
    openWorkoutModal();activeExerciseBodyFilter=returnState.bodyFilter||'all';activeExerciseEquipmentFilter=returnState.equipmentFilter||'all';activeExerciseSelection=returnState.id;renderExerciseFilters();
    const input=$('exerciseSearch');if(input){input.value=returnState.query;renderExerciseResults(returnState.query);updateExerciseDetail();}
    return;
  }
  activeExerciseSelection=null;
}
function modalHead(kicker,title,description='') { return `<div class="modal-handle"></div><div class="modal-head"><div>${kicker?`<div class="eyebrow">${kicker}</div>`:''}<h2>${title}</h2>${description?`<p>${description}</p>`:''}</div><button class="close-modal" data-action="close-modal" aria-label="Close">×</button></div>`; }
function openFoodModal(meal='breakfast', preselect=null, allowRecipeCreation=false) {
  activeFoodMeal=meal||'breakfast';activeFoodSelection=preselect||null;
  externalFoodMatches=[];externalFoodSearchTerm='';foodKindFilters={ingredients:true,recipes:true};
  if(foodSearchTimer){clearTimeout(foodSearchTimer);foodSearchTimer=null;}
  const clock=new Date();const defaultTime=`${String(clock.getHours()).padStart(2,'0')}:${String(clock.getMinutes()).padStart(2,'0')}`;
  const ingredientCount=allFoods().filter(food=>!isRecipeFood(food)).length;
  const recipeCount=allFoods().filter(isRecipeFood).length;
  showModal(`${modalHead('','Add food')}
    <div class="food-search-add-row"><div class="food-search-hero"><span class="search-icon">⌕</span><input id="foodSearch" type="search" placeholder="Search ingredients or recipes…" autocomplete="off" aria-label="Search ingredients and recipes"/><span class="food-search-shortcut">⌘ K</span></div><button type="button" class="food-universal-add" data-action="open-universal-add" aria-label="Add an ingredient or recipe">＋ <span>Add</span><span class="add-chevron">⌄</span></button></div>
    <div class="food-picker-toolbar">
      <div class="food-type-pills" role="group" aria-label="Filter food type">
        <button type="button" class="food-type-pill active" data-action="toggle-food-kind" data-kind="ingredients" aria-pressed="true"><span class="pill-dot ingredient-dot"></span>Ingredients <span class="food-pill-count">${fmt(ingredientCount)}</span></button>
        <button type="button" class="food-type-pill active" data-action="toggle-food-kind" data-kind="recipes" aria-pressed="true"><span class="pill-dot recipe-dot"></span>Recipes <span class="food-pill-count">${fmt(recipeCount)}</span></button>
      </div>
      <div class="food-inline-tools"><button type="button" class="food-scan-button" data-action="scan-food-barcode" title="Scan barcode or QR code">▦ Scan</button><button type="button" class="food-online-button" data-action="search-online-foods" title="Search online products">⌕ Online</button></div>
    </div>
    <div id="foodResults" class="search-results food-local-results"></div>
    <div id="foodSelectionPanel" class="food-selection-panel" hidden>
      <div id="selectedFoodDetail"></div>
      <div class="food-detail-heading"><strong>Log details</strong><span>Adjust the amount before adding</span></div>
      <div class="field-grid food-log-grid"><div class="field"><label for="foodAmount">QUANTITY / SERVINGS</label><input id="foodAmount" type="number" min="0.01" step="0.1" value="100" /></div><div class="field"><label for="foodUnit">UNIT</label><select id="foodUnit"><option value="g">g</option></select></div></div>
      <div class="field-grid food-log-grid"><div class="field"><label for="foodMeal">MEAL</label><select id="foodMeal">${MEALS.map(m=>`<option value="${m.key}" ${m.key===activeFoodMeal?'selected':''}>${m.label}</option>`).join('')}</select></div><div class="field"><label for="foodTime">TIME</label><input id="foodTime" type="time" value="${defaultTime}" /></div></div>
      <div class="form-note">Nutrition is scaled from the source basis. Unknown nutrients remain unreported. Check package labels where accuracy matters.</div>
      <div class="modal-actions"><button class="cancel" data-action="clear-food-selection">Back to search</button><button class="save lime" data-action="confirm-add-food">＋ Add to timeline</button></div>
    </div>
    <div class="food-online-section"><div class="food-online-heading"><div><div class="eyebrow">ONLINE CATALOGUE</div><h3>Product matches</h3></div><span class="food-online-badge">OPEN FOOD FACTS</span></div>
      <div class="food-barcode-row"><input id="barcodeSearch" inputmode="numeric" autocomplete="off" placeholder="Or enter a barcode number" aria-label="Product barcode"/><button type="button" class="outline-button" data-action="lookup-food-barcode">Look up</button></div>
      <div id="foodOnlineResults" class="search-results food-online-results"><div class="picker-prompt">Search online or scan a product to load matches. Online lookup needs internet access.</div></div>
    </div>`);
  renderFoodResults('');
  if(activeFoodSelection)selectFoodInPicker(activeFoodSelection);
  const input=$('foodSearch');if(input&&!activeFoodSelection&&window.matchMedia?.('(pointer: fine)').matches)input.focus({preventScroll:true});
}
function renderUniversalAddModal() {
  const ingredient=universalAddMode==='ingredient';
  showModal(`${modalHead('ADD TO LIBRARY','Add your own food')}
    <div class="universal-add-toggle" role="group" aria-label="Choose what to create">
      <button type="button" class="${ingredient?'active':''}" data-action="set-universal-add-mode" data-mode="ingredient" aria-pressed="${ingredient}">Ingredient</button>
      <button type="button" class="${!ingredient?'active':''}" data-action="set-universal-add-mode" data-mode="recipe" aria-pressed="${!ingredient}">Recipe</button>
    </div>
    <div class="universal-add-explainer"><span class="universal-add-icon">${ingredient?'＋':'✳'}</span><div><strong>${ingredient?'One item → Ingredient':'Two or more ingredients → Recipe'}</strong><p>${ingredient?'Create one ingredient and enter its nutrition values from a verified source.':'Choose at least two ingredients, set the recipe yield, and Timely Fit calculates nutrition per serving from the ingredients.'}</p></div></div>
    <div class="modal-actions"><button type="button" class="cancel" data-action="close-modal">Cancel</button><button type="button" class="save lime" data-action="continue-universal-add">Continue →</button></div>`);
}
function isRecipeFood(food) {
  return !!food && (food.type==='custom_recipe' || String(food.category||'').toLowerCase()==='recipes' || (food.tags||[]).some(tag=>String(tag).toLowerCase()==='recipe'));
}
function scheduleOnlineFoodSearch(query) {
  if(foodSearchTimer){clearTimeout(foodSearchTimer);foodSearchTimer=null;}
  const q=String(query||'').trim();const host=$('foodOnlineResults');
  if(!host)return;
  if(q.length<3){host.innerHTML='<div class="picker-prompt">Type at least 3 characters to search packaged products online.</div>';return;}
  host.innerHTML='<div class="picker-prompt">Searching local foods now. Online products will load below…</div>';
  foodSearchTimer=setTimeout(()=>{searchOpenFoodFacts(q);},850);
}

function searchScore(query,text) {
  const q=query.toLowerCase().trim();const t=text.toLowerCase();if(!q)return 1;
  if(t.startsWith(q))return 100-q.length/100;if(t.includes(q))return 80-q.length/100;
  const parts=q.split(/\s+/);let total=0;for(const part of parts){if(t.includes(part))total+=20;else{let best=0;for(let i=0;i<part.length;i++)if(t.includes(part.slice(0,part.length-i)))best=Math.max(best,(part.length-i)/part.length*10);total+=best;}}return total/parts.length;
}
function renderFoodResults(query) {
  const host=$('foodResults');if(!host)return;
  const q=String(query||'').trim();
  const enabled=food=>isRecipeFood(food)?foodKindFilters.recipes:foodKindFilters.ingredients;
  const local=allFoods().filter(enabled);
  if(!foodKindFilters.ingredients&&!foodKindFilters.recipes){
    host.innerHTML='<div class="picker-prompt">Both filters are off. Turn on Ingredients or Recipes to show results.</div>';return;
  }
  const renderGroup=(label,items)=>items.length?`<div class="food-result-group"><div class="picker-caption">${label} <span>${items.length}</span></div>${items.map(({food})=>foodResultButton(food,activeFoodSelection===food.id)).join('')}</div>`:'';
  if(!q){
    const recents=(state.recentFoodIds||[]).map(findFood).filter(Boolean).filter(food=>enabled(food));
    if(recents.length){
      const ing=recents.filter(food=>!isRecipeFood(food)).slice(0,3).map(food=>({food}));
      const recipes=recents.filter(isRecipeFood).slice(0,3).map(food=>({food}));
      host.innerHTML=renderGroup('RECENT INGREDIENTS',ing)+renderGroup('RECENT RECIPES',recipes);
    } else {
      host.innerHTML='<div class="picker-prompt food-empty-prompt"><span class="food-prompt-icon">⌕</span><strong>Your food library is ready</strong><span>Search by name, ingredient, recipe, brand or tag. Use Add to create an ingredient or build a recipe.</span></div>';
    }
    return;
  }
  const scored=local.map(food=>({food,score:searchScore(q,`${food.name} ${(food.tags||[]).join(' ')} ${foodCategory(food)} ${food.subcategory||''} ${food.brand||''} ${food.description||''}`)})).filter(x=>x.score>0).sort((a,b)=>b.score-a.score||a.food.name.localeCompare(b.food.name));
  const ingredients=scored.filter(x=>!isRecipeFood(x.food));
  const recipes=scored.filter(x=>isRecipeFood(x.food));
  let shownIngredients=[],shownRecipes=[];
  if(foodKindFilters.ingredients&&foodKindFilters.recipes){
    shownIngredients=ingredients.slice(0,7);shownRecipes=recipes.slice(0,5);
  } else if(foodKindFilters.ingredients){shownIngredients=ingredients.slice(0,12);}
  else {shownRecipes=recipes.slice(0,12);}
  const total=ingredients.length+recipes.length;
  host.innerHTML=total?`${renderGroup(`INGREDIENTS · ${ingredients.length} MATCH${ingredients.length===1?'':'ES'}`,shownIngredients)}${renderGroup(`RECIPES · ${recipes.length} MATCH${recipes.length===1?'':'ES'}`,shownRecipes)}${total>(shownIngredients.length+shownRecipes.length)?'<div class="food-more-hint">Refine your search to narrow the results.</div>':''}`:'<div class="empty-chart food-no-match">No local match. Add it yourself above, or check packaged products online below.</div>';
}

function foodResultButton(food,selected=false) {
  const kcal=foodMacros(food,defaultFoodAmount(food),foodAmountUnit(food)).calories;
  const image=food.image_url?`<img class="food-result-image" src="${safe(food.image_url)}" alt="" loading="lazy" onerror="this.hidden=true;this.nextElementSibling.hidden=false"><span class="food-result-emoji" hidden>${nutritionEmoji(food)}</span>`:`<span class="food-result-emoji">${nutritionEmoji(food)}</span>`;
  return `<button type="button" class="search-result ${selected?'selected':''}" data-action="select-food" data-id="${safe(food.id)}"><span class="result-icon food-result-icon">${image}</span><span class="result-copy"><strong>${safe(food.name)}</strong><span>${isRecipeFood(food)?'Recipe':'Ingredient'} · ${safe(foodCategory(food))} · ${safe(foodSourceLabel(food))}</span></span><span class="result-calories">${fmt(kcal)} kcal</span></button>`;
}
function externalFoodResultButton(food) {
  const amount=100;const m=foodMacros(food,amount,'g');
  const image=food.image_url?`<img class="food-result-image" src="${safe(food.image_url)}" alt="" loading="lazy" onerror="this.hidden=true;this.nextElementSibling.hidden=false"><span class="food-result-emoji" hidden>📦</span>`:'<span class="food-result-emoji">📦</span>';
  const fields=food.nutrient_fields_available||[];
  return `<button type="button" class="search-result" data-action="select-external-food" data-id="${safe(food.id)}"><span class="result-icon food-result-icon">${image}</span><span class="result-copy"><strong>${safe(food.name)}</strong><span>Open Food Facts · per 100 g${fields.length<4?' · partial nutrition data':''}${food.brands?` · ${safe(food.brands)}`:''}</span></span><span class="result-calories">${fmt(m.calories)} kcal</span></button>`;
}
function productToExternalFood(product) {
  const name=String(product?.product_name||product?.product_name_en||'').trim();
  const code=String(product?.code||product?.id||'').trim();
  const nutr=product?.nutriments||{};
  if(!name) return null;
  const read=(...keys)=>{for(const key of keys){const v=Number(nutr[key]);if(Number.isFinite(v)&&v>=0&&String(nutr[key]).trim()!=='')return round(v,4);}return null;};
  let calories=read('energy-kcal_100g');
  if(calories===null){const kj=read('energy-kj_100g');if(kj!==null)calories=round(kj/4.184,2);}
  const protein=read('proteins_100g');const carbs=read('carbohydrates_100g');const fat=read('fat_100g');const fiber=read('fiber_100g');
  const available=[];if(calories!==null)available.push('calories');if(protein!==null)available.push('protein');if(carbs!==null)available.push('carbs');if(fat!==null)available.push('fat');if(fiber!==null)available.push('fiber');
  const id=`off_${(code||name.toLowerCase().replace(/[^a-z0-9]+/g,'-')).slice(0,90)}`;
  const cats=Array.isArray(product.categories_tags)?product.categories_tags.map(x=>String(x).split(':').pop().replace(/-/g,' ')).filter(Boolean):[];
  const category=cats.length?cats[cats.length-1].replace(/\b\w/g,c=>c.toUpperCase()):'Packaged food';
  if(!available.length)return null;
  const macros={};if(calories!==null)macros.calories=calories;if(protein!==null)macros.protein=protein;if(carbs!==null)macros.carbs=carbs;if(fat!==null)macros.fat=fat;if(fiber!==null)macros.fiber=fiber;
  // Calculations require numeric values; unavailable fields are zero in the calculation but are surfaced as missing below.
  for(const key of ['calories','protein','carbs','fat'])if(macros[key]===undefined)macros[key]=0;
  return {id,name,type:'raw_ingredient',serving_unit:'g',default_serving_size:100,macros_per_100g:macros,tags:['open-food-facts',...cats.slice(0,5)],category,data_source:'Open Food Facts',data_quality:available.length>=4?'external product data':'external product data; partial nutrition',nutrient_fields_available:available,fiber_data_available:fiber!==null,image_url:product.image_front_small_url||product.image_front_url||'',brands:String(product.brands||''),barcode:code,product_quantity:String(product.quantity||'')};
}
async function searchOpenFoodFacts(query) {
  const q=String(query||'').trim();if(!q){toast('Enter a food or packaged-product name first.',true);return;}
  const host=$('foodOnlineResults');if(!host)return;
  host.innerHTML='<div class="picker-prompt">Searching Open Food Facts… This requires internet access.</div>';
  try{
    const url=`https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(q)}&search_simple=1&action=process&json=1&page_size=8&fields=code,product_name,product_name_en,brands,categories_tags,nutriments,image_front_small_url,image_front_url,quantity`;
    const response=await fetch(url,{headers:{Accept:'application/json'}});if(!response.ok)throw new Error(`Open Food Facts returned ${response.status}`);
    const data=await response.json();if(($('foodSearch')?.value||'').trim()!==q)return;externalFoodMatches=(data.products||[]).map(productToExternalFood).filter(Boolean);externalFoodSearchTerm=q.toLowerCase();
    host.innerHTML=externalFoodMatches.length?`<div class="picker-caption">OPEN FOOD FACTS · ${externalFoodMatches.length} RESULTS</div>${externalFoodMatches.map(externalFoodResultButton).join('')}<div class="food-source-note">Community-submitted product database. Verify the packet label if values matter. Data and image licence information: <a href="https://openfoodfacts.github.io/documentation/docs/Product-Opener/api/tutorials/license-be-on-the-legal-side/" target="_blank" rel="noopener noreferrer">Open Food Facts licences</a>.</div>`:'<div class="empty-chart">No packaged products found. Try the brand or a shorter search phrase.</div>';
  }catch(error){console.warn('Open Food Facts search failed',error);host.innerHTML='<div class="empty-chart">Online lookup failed. Check your connection and try again; your local food library still works offline.</div>';}
}
async function lookupOpenFoodFactsBarcode(rawCode, selectAfterLookup=false) {
  const code=String(rawCode||'').replace(/\s+/g,'').trim();if(!code){toast('Enter a product barcode first.',true);return;}
  if(!/^\d{8,14}$/.test(code)){toast('Barcode should contain 8–14 digits.',true);return;}
  const host=$('foodOnlineResults');if(host)host.innerHTML='<div class="picker-prompt">Looking up barcode…</div>';
  try{
    const response=await fetch(`https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(code)}.json?fields=code,product_name,product_name_en,brands,categories_tags,nutriments,image_front_small_url,image_front_url,quantity`,{headers:{Accept:'application/json'}});
    if(!response.ok)throw new Error(`Open Food Facts returned ${response.status}`);
    const data=await response.json();if(data.status!==1||!data.product)throw new Error('That barcode is not listed in Open Food Facts.');
    const food=productToExternalFood({...data.product,code:data.code||code});if(!food)throw new Error('The product record has no readable name.');
    externalFoodMatches=[food];externalFoodSearchTerm=code;
    if(selectAfterLookup){const existingIndex=state.externalFoods.findIndex(x=>x.id===food.id);if(existingIndex>=0)state.externalFoods[existingIndex]=food;else state.externalFoods.push(food);selectFoodInPicker(food.id);scheduleSave(false);}
    else if(host)host.innerHTML=`<div class="picker-caption">BARCODE MATCH</div>${externalFoodResultButton(food)}<div class="food-source-note">Community-submitted product data. Verify the packet label if values matter. Data and image licence information: <a href="https://openfoodfacts.github.io/documentation/docs/Product-Opener/api/tutorials/license-be-on-the-legal-side/" target="_blank" rel="noopener noreferrer">Open Food Facts licences</a>.</div>`;
  }catch(error){console.warn('Open Food Facts barcode lookup failed',error);if(host)host.innerHTML=`<div class="empty-chart">${safe(error.message||'Barcode lookup failed.')} Check the number and connection, or enter the nutrition from the product label manually.</div>`;if(selectAfterLookup)toast(error.message||'Barcode lookup failed.',true);}
}
function loadZXingFallback() {
  if(window.ZXing?.BrowserMultiFormatReader)return Promise.resolve(window.ZXing);
  if(window.__formaZXingPromise)return window.__formaZXingPromise;
  window.__formaZXingPromise=new Promise((resolve,reject)=>{
    const script=document.createElement('script');
    script.src='https://unpkg.com/@zxing/library@0.21.3/umd/index.min.js';
    script.async=true;script.onload=()=>window.ZXing?.BrowserMultiFormatReader?resolve(window.ZXing):reject(new Error('Camera scanner library did not load.'));
    script.onerror=()=>reject(new Error('Could not load the camera scanner. Connect to the internet or enter the barcode manually.'));
    document.head.appendChild(script);
  });
  return window.__formaZXingPromise;
}
function scannedProductCode(rawValue) {
  const raw=String(rawValue||'').trim();
  const direct=raw.match(/^\d{8,14}$/);if(direct)return direct[0];
  try{const url=new URL(raw);const matches=[...url.pathname.matchAll(/(?:product\/|\/)(\d{8,14})(?:\/|$)/g)];if(matches.length)return matches[matches.length-1][1];const q=url.searchParams.get('code')||url.searchParams.get('barcode');if(q&&/^\d{8,14}$/.test(q))return q;}catch(_){}
  const embedded=raw.match(/(?:barcode|product)[^\d]{0,12}(\d{8,14})/i);return embedded?embedded[1]:'';
}
async function handleScannedFoodValue(rawValue) {
  const meal=activeFoodMeal||'breakfast';const raw=String(rawValue||'').trim();
  stopBarcodeScanner();
  const code=scannedProductCode(raw);
  openFoodModal(meal);
  if(code){if($('barcodeSearch'))$('barcodeSearch').value=code;await lookupOpenFoodFactsBarcode(code,true);return;}
  if($('foodSearch'))$('foodSearch').value=raw.slice(0,120);
  renderFoodResults(raw.slice(0,120));
  if(raw.length>=3)await searchOpenFoodFacts(raw.slice(0,120));
  else toast('QR code read. It was not a product barcode; try the decoded text as a search.',true);
}
async function startBarcodeScanner() {
  showModal(`${modalHead('CAMERA SCANNER','Scan a barcode or QR','Allow camera access, then fit the code inside the frame.')}
    <div class="barcode-camera-frame"><video id="foodBarcodeVideo" autoplay muted playsinline></video><div class="barcode-reticle"></div></div>
    <div class="barcode-scan-status" id="barcodeScanStatus">Starting camera…</div>
    <p class="food-source-note">The camera is used to read the code. Product barcodes are looked up through Open Food Facts. QR content is searched when it is not a product barcode.</p>
    <div class="modal-actions"><button type="button" class="cancel" data-action="stop-food-barcode">Cancel scan</button></div>`);
  try {
    if(!navigator.mediaDevices?.getUserMedia)throw new Error('Camera access requires a secure HTTPS connection or localhost.');
    const video=$('foodBarcodeVideo');if(!video)throw new Error('Camera view is unavailable.');
    let nativeScannerReady=typeof window.BarcodeDetector==='function';
    let detector=null;
    if(nativeScannerReady){
      let formats=['ean_13','ean_8','upc_a','upc_e','qr_code'];
      if(BarcodeDetector.getSupportedFormats){const supported=await BarcodeDetector.getSupportedFormats();formats=formats.filter(f=>supported.includes(f));if(!formats.length)nativeScannerReady=false;}
      if(nativeScannerReady)detector=new BarcodeDetector({formats});
    }
    if(nativeScannerReady){
      barcodeStream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'}},audio:false});video.srcObject=barcodeStream;await video.play();
      const status=$('barcodeScanStatus');if(status)status.textContent='Camera ready · Hold the code steady';
      barcodeScanTimer=setInterval(async()=>{if(!video||video.readyState<2)return;try{const codes=await detector.detect(video);if(codes?.length&&codes[0].rawValue){await handleScannedFoodValue(codes[0].rawValue);}}catch(error){console.warn('Barcode frame scan failed',error);}},350);
      return;
    }
    // Safari/iOS currently lacks BarcodeDetector on many versions. Load ZXing as a fallback.
    const zxing=await loadZXingFallback();
    const reader=new zxing.BrowserMultiFormatReader();barcodeReader=reader;
    const status=$('barcodeScanStatus');if(status)status.textContent='Camera ready · Barcode and QR modes enabled';
    barcodeReaderControls=await reader.decodeFromVideoDevice(undefined,video,(result,error,controls)=>{
      if(result){handleScannedFoodValue(result.getText());}
    });
  }catch(error){stopBarcodeScanner();closeModal();toast(error.message||'Could not start the camera. Use manual barcode entry instead.',true);}
}
function stopBarcodeScanner() {
  if(barcodeScanTimer){clearInterval(barcodeScanTimer);barcodeScanTimer=null;}
  if(barcodeReaderControls){try{barcodeReaderControls.stop();}catch(_){}barcodeReaderControls=null;}
  if(barcodeReader){try{barcodeReader.reset();}catch(_){}barcodeReader=null;}
  if(barcodeStream){for(const track of barcodeStream.getTracks())track.stop();barcodeStream=null;}
  const video=$('foodBarcodeVideo');if(video){video.pause?.();video.srcObject=null;}
}

function selectFoodInPicker(foodId) {
  const food=findFood(foodId);if(!food)return;activeFoodSelection=foodId;
  const amount=$('foodAmount');if(amount){amount.value=defaultFoodAmount(food);refreshNumberWheel(amount);}
  const unitSelect=$('foodUnit');if(unitSelect){unitSelect.innerHTML=foodUnits(food).map(u=>`<option value="${safe(u)}">${safe(u)}</option>`).join('');unitSelect.value=foodAmountUnit(food);}
  const panel=$('foodSelectionPanel');if(panel)panel.hidden=false;
  const detail=$('selectedFoodDetail');if(detail){const macros=foodMacros(food,defaultFoodAmount(food),foodAmountUnit(food));detail.innerHTML=`<div class="selected-food"><span class="result-icon">${nutritionEmoji(food)}</span><div style="flex:1;min-width:0"><strong class="selected-food-name">${safe(food.name)}</strong><small>${fmt(macros.calories)} kcal · P ${fmt(macros.protein,1)}g · C ${fmt(macros.carbs,1)}g · F ${fmt(macros.fat,1)}g</small><small class="food-source-caption">Source: ${safe(foodSourceLabel(food))}${!foodFiberKnown(food)?' · Fibre data unavailable':''}${food.data_quality?.includes('partial')?' · nutrition is incomplete':''}</small></div><span class="food-selected-badge">SELECTED</span></div>`;}
  const search=$('foodSearch');if(search&&search.value.trim())renderFoodResults(search.value);else renderFoodResults('');
  updateSelectedFoodPreview();
}
function updateSelectedFoodPreview() {
  const food=findFood(activeFoodSelection);if(!food)return;const amount=Math.max(.01,n($('foodAmount')?.value)||defaultFoodAmount(food));const unit=$('foodUnit')?.value||foodAmountUnit(food);const macros=foodMacros(food,amount,unit);const small=$('selectedFoodDetail')?.querySelector('small');if(small)small.textContent=`${fmt(macros.calories)} kcal · P ${fmt(macros.protein,1)}g · C ${fmt(macros.carbs,1)}g · F ${fmt(macros.fat,1)}g`;
}
function addSelectedFood() {
  const food=findFood(activeFoodSelection);if(!food){toast('Search and select a food first.',true);return;}
  const amount=Math.max(.01,n($('foodAmount')?.value)||defaultFoodAmount(food));const unit=$('foodUnit')?.value||foodAmountUnit(food);const meal=$('foodMeal')?.value||activeFoodMeal;
  const macros=foodMacros(food,amount,unit);const timeValue=$('foodTime')?.value||'';const logDateTime=timeValue?new Date(`${state.activeDate}T${timeValue}:00`):new Date();const loggedAt=Number.isNaN(logDateTime.getTime())?new Date().toISOString():logDateTime.toISOString();const item={entry_id:uid('log'),food_id:food.id,name:food.name,type:food.type,category:foodCategory(food),data_source:foodSourceLabel(food),fiber_data_available:foodFiberKnown(food),amount,unit,amount_label:amountLabel(food,amount,unit),macros:{...macros},logged_at:loggedAt,tags:[...(food.tags||[])]};
  currentLog().diet_log[meal].push(item);state.recentFoodIds=recentIds(state.recentFoodIds,food.id);state.selectedDomain='diet';state.selectedTab='timeline';scheduleSave();closeModal();render();toast(`${food.name} added to ${meal}.`);
}
function findFoodEntry(entryId) {
  const log=activeLog();for(const meal of MEALS){const item=(log.diet_log[meal.key]||[]).find(x=>x.entry_id===entryId);if(item)return {item,meal:meal.key};}return null;
}
function openEditFood(entryId) {
  const result=findFoodEntry(entryId);if(!result)return;editFoodEntryId=entryId;const item=result.item;const macros=item.macros||{};
  showModal(`${modalHead('EDIT ENTRY','Tune this portion','Changes apply only to this logged item, not the master database.')}
    <div class="selected-food"><span class="result-icon">${nutritionEmoji(item)}</span><div><strong>${safe(item.name)}</strong><small>Logged in ${result.meal}</small></div></div>
    <div class="field-grid"><div class="field"><label for="editAmount">AMOUNT</label><input id="editAmount" type="number" min="0.1" step="0.1" value="${safe(item.amount??1)}" /></div><div class="field"><label for="editUnit">UNIT LABEL</label><select id="editUnit">${[...new Set([...(foodUnits(findFood(item.food_id)||item)),item.unit||'g'])].map(u=>`<option value="${safe(u)}" ${(item.unit||'g')===u?'selected':''}>${safe(u)}</option>`).join('')}</select></div></div>
    <div class="divider-label">Macros for this entry</div><div class="macro-edit-grid">${[['calories','KCAL'],['protein','PROTEIN G'],['carbs','CARBS G'],['fat','FAT G']].map(([key,label])=>`<div class="field"><label for="macro_${key}">${label}</label><input id="macro_${key}" type="number" min="0" step="0.1" value="${safe(macros[key]??0)}" /></div>`).join('')}</div>
    <div class="field" style="margin-top:12px"><label for="macro_fiber">FIBER G</label><input id="macro_fiber" type="number" min="0" step="0.1" value="${safe(macros.fiber??0)}" /></div>
    <div class="modal-actions"><button class="cancel" data-action="close-modal">Cancel</button><button class="save lime" data-action="save-food-edit">Save entry</button></div>`);
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

function openCustomIngredientModal() {
  activeFoodMeal=$('foodMeal')?.value||activeFoodMeal||'breakfast';
  showModal(`${modalHead('YOUR FOOD LIBRARY','Add an ingredient','Enter known nutrition values. Unknown nutrients should be left blank, not guessed.')}
    <div class="field"><label for="customIngredientName">INGREDIENT NAME *</label><input id="customIngredientName" maxlength="100" placeholder="e.g. Homemade paneer" autocomplete="off" /></div>
    <div class="field-grid"><div class="field"><label for="customIngredientUnit">UNIT / BASIS *</label><select id="customIngredientUnit"><option value="g">g · per 100 g</option><option value="ml">ml · per 100 ml</option><option value="scoop">scoop · per 100 g (scoop size below)</option><option value="piece">piece · per serving</option><option value="bowl">bowl · per serving</option><option value="slice">slice · per serving</option><option value="serving">serving · per serving</option></select></div><div class="field"><label for="customIngredientDefault">DEFAULT AMOUNT</label><input id="customIngredientDefault" type="number" min="0.1" step="0.1" value="100" /></div></div>
    <div class="field"><label for="customIngredientCategory">CATEGORY</label><input id="customIngredientCategory" maxlength="50" placeholder="e.g. Pulses & Legumes" value="Other/Mixed" /></div>
    <div class="macro-edit-grid custom-food-macros"><div class="field"><label for="customFoodCalories">KCAL *</label><input id="customFoodCalories" type="number" min="0" step="0.1" placeholder="0" /></div><div class="field"><label for="customFoodProtein">PROTEIN g *</label><input id="customFoodProtein" type="number" min="0" step="0.1" placeholder="0" /></div><div class="field"><label for="customFoodCarbs">CARBS g *</label><input id="customFoodCarbs" type="number" min="0" step="0.1" placeholder="0" /></div><div class="field"><label for="customFoodFat">FAT g *</label><input id="customFoodFat" type="number" min="0" step="0.1" placeholder="0" /></div><div class="field"><label for="customFoodFiber">FIBRE g</label><input id="customFoodFiber" type="number" min="0" step="0.1" placeholder="Unknown" /></div></div>
    <div class="field"><label for="customIngredientSource">SOURCE / REFERENCE</label><input id="customIngredientSource" maxlength="120" placeholder="Package label, database, or your calculation" /></div>
    <div class="field"><label for="customIngredientTags">SEARCH TAGS</label><input id="customIngredientTags" maxlength="180" placeholder="e.g. vegetarian, high-protein, breakfast" /></div>
    <div class="form-note">For g and ml, nutrients are recorded per 100 g or 100 ml. For piece, bowl, slice and serving, values are for the default serving amount. Keep the original source so you can verify values later.</div>
    <div class="modal-actions"><button class="cancel" data-action="close-modal">Cancel</button><button class="save lime" data-action="save-custom-ingredient">Save ingredient</button></div>`);
  const unit=$('customIngredientUnit');unit?.addEventListener('change',()=>{const defaultInput=$('customIngredientDefault');if(defaultInput)defaultInput.value=['g','ml'].includes(unit.value)?100:unit.value==='scoop'?30:1;});
}
function saveCustomIngredient() {
  const name=$('customIngredientName')?.value.trim()||'';if(!name){toast('Enter an ingredient name.',true);return;}
  const unit=$('customIngredientUnit')?.value||'g';const servingSize=Math.max(.01,n($('customIngredientDefault')?.value)||(['g','ml'].includes(unit)?100:unit==='scoop'?30:1));
  const nutrientIds=['customFoodCalories','customFoodProtein','customFoodCarbs','customFoodFat'];
  if(nutrientIds.some(id=>$(id)?.value===''||!Number.isFinite(Number($(id)?.value))||Number($(id).value)<0)){toast('Enter non-negative values for calories, protein, carbohydrates and fat. Leave fibre blank if unknown.',true);return;}
  const macros={calories:n($('customFoodCalories').value),protein:n($('customFoodProtein').value),carbs:n($('customFoodCarbs').value),fat:n($('customFoodFat').value)};
  const fiberRaw=$('customFoodFiber')?.value??'';const fiberKnown=String(fiberRaw).trim()!==''&&Number.isFinite(Number(fiberRaw))&&Number(fiberRaw)>=0;if(fiberKnown)macros.fiber=n(fiberRaw);
  const liquid=unit==='ml';const gramBased=unit==='g'||unit==='scoop';const item={id:uid('food'),name,type:gramBased||liquid?'raw_ingredient':'standard_estimate',serving_unit:unit,default_serving_size:servingSize,tags:String($('customIngredientTags')?.value||'').split(',').map(x=>x.trim()).filter(Boolean),category:$('customIngredientCategory')?.value.trim()||'Other/Mixed',data_source:$('customIngredientSource')?.value.trim()||'User added',data_quality:$('customIngredientSource')?.value.trim()?'source-reported; user-entered':'user-entered; verify before relying on values',nutrient_fields_available:['calories','protein','carbs','fat',...(fiberKnown?['fiber']:[])],fiber_data_available:fiberKnown};
  if(liquid)item.macros_per_100ml=macros;else if(gramBased)item.macros_per_100g=macros;else item.macros_per_serving=macros;
  const returnMeal=$('foodMeal')?.value||activeFoodMeal||'breakfast';
  state.customFoods.push(item);state.recentFoodIds=recentIds(state.recentFoodIds,item.id);state.syncMeta.dirtyFoodIds=Array.from(new Set([...(state.syncMeta.dirtyFoodIds||[]),item.id]));scheduleSave(false);
  closeModal();openFoodModal(returnMeal,item.id);toast(`${name} added to your food library.`);
}

function openRecipeModal() {
  recipeReturnMeal=$('foodMeal')?.value||activeFoodMeal||'breakfast';
  recipeIngredients=[{foodId:'',amount:100,unit:'g',query:''}];
  showModal(`${modalHead('CUSTOM RECIPE','Build your own recipe','Search each ingredient, add its amount and unit, then set how many servings the finished recipe makes.')}
    <div class="field"><label for="recipeName">RECIPE NAME</label><input id="recipeName" placeholder="e.g. Paneer & soya bowl" maxlength="70" /></div>
    <div class="field"><label for="recipeYield">FINISHED YIELD (SERVINGS)</label><input id="recipeYield" type="number" min="1" step="1" value="2" /></div>
    <div class="divider-label">Search ingredients</div><div id="recipeIngredients"></div>
    <button class="outline-button" style="width:100%" data-action="recipe-add-ingredient">＋ Add ingredient</button>
    <div id="recipePreview" class="form-note">Search for each ingredient to calculate recipe nutrition.</div>
    <div class="modal-actions"><button class="cancel" data-action="close-modal">Cancel</button><button class="save lime" data-action="save-recipe">Save recipe</button></div>`);
  renderRecipeIngredients();
}
function renderRecipeIngredients() {
  const host=$('recipeIngredients');if(!host)return;
  host.innerHTML=recipeIngredients.map((ingredient,index)=>{
    const food=findFood(ingredient.foodId);const units=food?foodUnits(food):['g','kg','ml','L'];const unit=ingredient.unit||foodAmountUnit(food)||'g';
    const query=ingredient.query||(food?food.name:'');
    return `<div class="recipe-ingredient"><div class="recipe-picker"><input class="recipe-search" data-role="recipe-search" data-index="${index}" placeholder="Search ingredient…" value="${safe(query)}" autocomplete="off" aria-label="Search ingredient ${index+1}"/><div class="recipe-selected">${food?`<span>${safe(food.name)}</span><small>${safe(food.type==='raw_ingredient'?'Ingredient':'Estimate')} selected</small>`:'<small>Search and select an ingredient</small>'}</div><div class="recipe-results-mini" id="recipe-results-${index}"></div></div><input type="number" min="0.01" step="0.1" value="${safe(ingredient.amount)}" data-role="recipe-amount" data-index="${index}" aria-label="Ingredient amount"/><select data-role="recipe-unit" data-index="${index}" aria-label="Ingredient unit">${units.map(u=>`<option value="${safe(u)}" ${unit===u?'selected':''}>${safe(u)}</option>`).join('')}</select><button data-action="recipe-remove-ingredient" data-index="${index}" aria-label="Remove ingredient">×</button></div>`;
  }).join('');
  upgradeNumberWheels(host);
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
  const host=$('recipePreview');if(!host)return;let total={calories:0,protein:0,carbs:0,fat:0,fiber:0};let selected=0;let fibreMissing=0;
  recipeIngredients.forEach(ing=>{const food=findFood(ing.foodId);if(!food)return;selected++;if(!foodFiberKnown(food))fibreMissing++;const m=foodMacros(food,ing.amount,ing.unit||foodAmountUnit(food));for(const key of Object.keys(total))total[key]+=m[key]||0;});
  const yieldCount=Math.max(1,n($('recipeYield')?.value)||2);host.innerHTML=`${selected}/${recipeIngredients.length} ingredients selected · Whole recipe: <strong>${fmt(total.calories)} kcal</strong> · P ${fmt(total.protein,1)}g · C ${fmt(total.carbs,1)}g · F ${fmt(total.fat,1)}g. Per serving (${yieldCount}): <strong>${fmt(total.calories/yieldCount)} kcal</strong>.${fibreMissing?` <span class="food-source-caption">Fibre data is missing for ${fibreMissing} ingredient${fibreMissing===1?'':'s'}; recipe fibre will be incomplete.</span>`:''}`;
}
function saveRecipe() {
  const name=$('recipeName')?.value.trim();if(!name){toast('Give your recipe a name first.',true);return;}
  const yieldCount=Math.max(1,Math.round(n($('recipeYield')?.value)||1));let total={calories:0,protein:0,carbs:0,fat:0,fiber:0};const components=[];
  for(const ing of recipeIngredients){const food=findFood(ing.foodId);if(!food){toast('Search and select every ingredient.',true);return;}const amount=Math.max(.01,n(ing.amount));const unit=ing.unit||foodAmountUnit(food);const m=foodMacros(food,amount,unit);for(const key of Object.keys(total))total[key]+=m[key]||0;components.push({food_id:food.id,name:food.name,amount,unit,macros:m,...(food.data_source==='Open Food Facts'?{food_snapshot:{...food}}:{})});}
  if(components.length<2){toast('A recipe needs at least two ingredients. Add one more ingredient to continue.',true);return;}
  const containsNonVegetarian=components.some(c=>foodCategory(findFood(c.food_id))==='Meat & Eggs'||/\b(egg|eggs|meat|chicken|fish|pork|beef|lamb|poultry|shrimp|prawn|tuna|salmon|mutton|seafood|bacon|ham|turkey|duck)\b/i.test(c.name));
  const item={id:uid('recipe'),name,type:'custom_recipe',serving_unit:'serving',default_serving_size:1,macros_per_serving:Object.fromEntries(Object.entries(total).map(([k,v])=>[k,round(v/yieldCount,2)])),fiber_data_available:components.every(c=>findFood(c.food_id)&&foodFiberKnown(findFood(c.food_id))),tags:['custom','recipe',...(containsNonVegetarian?[]:['vegetarian'])],recipe_ingredients:components,yield:yieldCount,created_at:new Date().toISOString(),updated_at:new Date().toISOString()};
  state.customFoods.push(item);state.recentFoodIds=recentIds(state.recentFoodIds,item.id);state.syncMeta.dirtyFoodIds=Array.from(new Set([...(state.syncMeta.dirtyFoodIds||[]),item.id]));scheduleSave(false);const returnMeal=recipeReturnMeal||'breakfast';closeModal();openFoodModal(returnMeal,item.id);toast('Recipe saved. Add it to any meal when ready.');
}


// Workout progression & execution
const EXERCISE_BODY_FILTERS = [
  ['all','All parts'],['chest','Chest'],['back','Back'],['shoulders','Shoulders'],['arms','Arms'],['core','Core / waist'],['legs','Legs'],['glutes','Glutes / hips'],['calves','Calves'],['cardio','Cardio'],['full-body','Full body'],['neck','Neck'],['ankles','Ankles']
];
const EXERCISE_EQUIPMENT_FILTERS = [
  ['all','All equipment'],['bodyweight','Bodyweight'],['dumbbell','Dumbbell'],['barbell','Barbell'],['cable','Cable'],['bench','Bench'],['machine','Machine'],['kettlebell','Kettlebell'],['bands','Bands'],['ball-roller','Ball / roller'],['cardio-equipment','Cardio gear'],['other','Other']
];
function exerciseBodyMatches(ex,filter) {
  if(filter==='all')return true;
  const fields=[ex.body_part,ex.primary_muscle,ex.target,ex.muscle_group,ex.category,...(ex.secondary_muscles||[])].filter(Boolean).join(' ').toLowerCase();
  const patterns={chest:/chest|pectoral/,back:/back|lat\b|traps?|rhomboid|spine/,shoulders:/shoulder|delt|rotator cuff/,arms:/arm|biceps?|triceps?|forearm|brachialis|wrists?/,core:/waist|abs|abdom|core|oblique|spine/,legs:/leg|quad|hamstring|thigh|calf|calves|soleus/,glutes:/glute|hip|adductor|abductor/,calves:/calf|calves|soleus|lower leg/,cardio:/cardio|cardiovascular|heart|aerobic/, 'full-body':/full body|total body/,neck:/neck|sternocleidomastoid/,ankles:/ankle/};
  return (patterns[filter]||/.^/).test(fields);
}
function exerciseEquipmentMatches(ex,filter) {
  if(filter==='all')return true;
  const equipment=String(ex.equipment||'Other').toLowerCase();
  const patterns={bodyweight:/body ?weight|calisthenics/,dumbbell:/dumbbell/,barbell:/barbell|ez bar|trap bar|olympic bar/,cable:/cable/,bench:/bench/,machine:/machine|smith|leverage|assisted/,kettlebell:/kettlebell/,bands:/band|resistance tubing/,'ball-roller':/ball|roller|bosu|mat|foam roll/,'cardio-equipment':/treadmill|bike|bicycle|ergometer|ski.?erg|elliptical|rower|rowing|pool/,other:/.*/};
  if(filter==='other')return !EXERCISE_EQUIPMENT_FILTERS.filter(([key])=>!['all','other'].includes(key)).some(([key])=>exerciseEquipmentMatches(ex,key));
  return (patterns[filter]||/.^/).test(equipment);
}
function renderExerciseFilters() {
  const bodyHost=$('exerciseBodyFilters');const equipmentHost=$('exerciseEquipmentFilters');
  if(bodyHost)bodyHost.innerHTML=EXERCISE_BODY_FILTERS.map(([key,label])=>`<button type="button" class="filter-chip ${activeExerciseBodyFilter===key?'active':''}" data-action="exercise-body-filter" data-filter="${key}" aria-pressed="${activeExerciseBodyFilter===key}">${label}</button>`).join('');
  if(equipmentHost)equipmentHost.innerHTML=EXERCISE_EQUIPMENT_FILTERS.map(([key,label])=>`<button type="button" class="filter-chip ${activeExerciseEquipmentFilter===key?'active':''}" data-action="exercise-equipment-filter" data-filter="${key}" aria-pressed="${activeExerciseEquipmentFilter===key}">${label}</button>`).join('');
}
function openWorkoutModal() {
  activeExerciseSelection=null;activeExerciseBodyFilter='all';activeExerciseEquipmentFilter='all';
  showModal(`${modalHead('BUILD YOUR SESSION','Add exercise','Find your movement with search, muscle filters and equipment filters.')}
    <div class="exercise-search-hero"><span class="search-icon">⌕</span><input id="exerciseSearch" type="search" placeholder="Search exercises, muscles or movement…" autocomplete="off" aria-label="Search exercises" /></div>
    <div class="exercise-filter-block"><div class="exercise-filter-label"><span>BODY PART</span><span>Choose one</span></div><div id="exerciseBodyFilters" class="exercise-filter-strip" role="group" aria-label="Filter by body part"></div></div>
    <div class="exercise-filter-block equipment"><div class="exercise-filter-label"><span>EQUIPMENT</span><span>Choose one</span></div><div id="exerciseEquipmentFilters" class="exercise-filter-strip" role="group" aria-label="Filter by equipment"></div></div>
    <div class="exercise-results-heading"><strong>Exercise library</strong><span>${fmt(masterExercises.length)} movements</span></div>
    <div id="exerciseResults" class="search-results exercise-picker-results"></div>
    <div class="selected-food selected-exercise-card" id="selectedExerciseDetail"><span class="result-icon">🏋️</span><div><strong class="selected-exercise-name">Choose an exercise</strong><small class="selected-exercise-sub">Select a result to set your training target.</small></div></div>
    <div class="field-grid workout-wheel-grid"><div class="field"><label for="targetSets">TARGET SETS</label><input type="number" id="targetSets" min="1" max="20" step="1" value="3" aria-label="Target sets"/></div><div class="field"><label for="targetReps">REPS PER SET</label><input type="number" id="targetReps" min="1" max="100" step="1" value="10" aria-label="Reps per set"/></div></div>
    <div class="field"><label for="startingWeight">STARTING WEIGHT (KG)</label><input type="number" id="startingWeight" min="0" max="500" step="2.5" value="40" aria-label="Starting weight in kilograms"/></div>
    <div class="setting-section progressive-setting"><div class="switch-row"><div class="switch-copy"><strong>Progressive overload</strong><span>Increase the planned weight with each set.</span></div><label class="switch"><input type="checkbox" id="progressiveToggle" checked><span class="switch-track"></span></label></div><div class="field" id="progressiveSettingsBox" style="margin:0"><label for="weightIncrement">INCREMENT PER SET (KG)</label><input type="number" id="weightIncrement" min="0" step="0.5" value="5"/></div></div>
    <div id="setPreview" class="form-note">Set 1: 40 kg · Set 2: 45 kg · Set 3: 50 kg</div>
    <div class="modal-actions"><button class="cancel" data-action="close-modal">Cancel</button><button class="save lime" data-action="save-exercise">Add to session →</button></div>`);
  renderExerciseFilters();renderExerciseResults('');updateExerciseDetail();updateSetPreview();
}
function renderExerciseResults(query) {
  const host=$('exerciseResults');if(!host)return;const q=String(query||'').trim();
  const filtered=masterExercises.filter(ex=>exerciseBodyMatches(ex,activeExerciseBodyFilter)&&exerciseEquipmentMatches(ex,activeExerciseEquipmentFilter));
  if(!q){
    if(activeExerciseBodyFilter==='all'&&activeExerciseEquipmentFilter==='all'){
      const recents=(state.recentExerciseIds||[]).map(findExercise).filter(Boolean).slice(0,5);
      host.innerHTML=recents.length?`<div class="picker-caption">RECENT EXERCISES</div>${recents.map(ex=>exerciseResultButton(ex)).join('')}`:'<div class="picker-prompt">Start typing, or use the filters above to browse the library.</div>';return;
    }
    const results=filtered.slice(0,12);host.innerHTML=results.length?`<div class="picker-caption">FILTERED RESULTS · ${fmt(filtered.length)} MOVEMENTS</div>${results.map(ex=>exerciseResultButton(ex)).join('')}`:'<div class="empty-chart">No movements match these filters. Try another body part or equipment.</div>';return;
  }
  const ranked=filtered.map(ex=>({ex,score:searchScore(q,`${ex.name} ${ex.primary_muscle} ${ex.target||''} ${ex.body_part||''} ${ex.muscle_group||''} ${(ex.secondary_muscles||[]).join(' ')} ${ex.category} ${ex.equipment} ${ex.description||''}`)})).filter(x=>x.score>0).sort((a,b)=>b.score-a.score||a.ex.name.localeCompare(b.ex.name));
  const results=[];const seenNames=new Set();for(const item of ranked){const key=String(item.ex.name||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();if(seenNames.has(key))continue;seenNames.add(key);results.push(item);if(results.length===12)break;}
  host.innerHTML=results.length?`<div class="picker-caption">${results.length} MATCHING MOVEMENTS</div>${results.map(({ex})=>exerciseResultButton(ex)).join('')}`:'<div class="empty-chart">No exercise matched these filters. Try a different keyword, body part or equipment.</div>';
}
function exerciseResultButton(ex) {
  const selected=activeExerciseSelection===ex.id;
  const primary=ex.primary_muscle||ex.target||'Full body';
  const body=ex.body_part||ex.category||'Exercise';
  return `<div class="exercise-search-row ${selected?'selected':''}">${renderExerciseThumbnail(ex,'picker')}<button type="button" class="exercise-result-main ${selected?'selected':''}" data-action="select-exercise" data-id="${safe(ex.id)}"><span class="result-copy"><strong>${safe(ex.name)}</strong><span>${safe(primary)} · ${safe(body)} · ${safe(ex.equipment||'Bodyweight')}</span></span></button><span class="exercise-rest-pill">${n(ex.default_rest_sec)}s</span></div>`;
}

function updateExerciseDetail() {
  const ex=findExercise(activeExerciseSelection);if(!ex)return;
  const host=$('selectedExerciseDetail');
  if(host)host.innerHTML=`${renderExerciseThumbnail(ex,'selected')}<div><strong class="selected-exercise-name">${safe(ex.name)}</strong><small class="selected-exercise-sub">${safe(ex.primary_muscle||ex.target||'Full body')} · ${safe(ex.equipment||'Bodyweight')} · ${n(ex.default_rest_sec)}s default rest</small><small class="selected-exercise-description">${safe(exerciseShortDescription(ex))}</small></div>`;
  if(ex.tracking_metrics?.includes('duration')&&!ex.tracking_metrics.includes('weight')){if($('targetReps')){$('targetReps').value=20;refreshNumberWheel($('targetReps'));}if($('startingWeight')){$('startingWeight').value=0;refreshNumberWheel($('startingWeight'));}}
  updateSetPreview();
}
function openExerciseDetail(id) {
  const ex=findExercise(id);if(!ex)return;
  if($('exerciseSearch')) exerciseDetailReturnState={id:ex.id,query:$('exerciseSearch').value||'',bodyFilter:activeExerciseBodyFilter,equipmentFilter:activeExerciseEquipmentFilter};
  else exerciseDetailReturnState=null;
  const licensed=exerciseHasLicensedMedia(ex);
  const media=licensed
    ? `<div class="exercise-guide-media"><img src="${safe(ex.gif_url)}" alt="${safe(ex.name)} movement animation" loading="eager" onerror="this.hidden=true;this.nextElementSibling.hidden=false"><div class="exercise-media-fallback" hidden><span>${exerciseEmoji(ex.primary_muscle)}</span><strong>Animation could not be loaded</strong><small>Check the licensed media file path.</small></div></div>`
    : `<div class="exercise-guide-media"><div class="exercise-media-fallback"><span>${exerciseEmoji(ex.primary_muscle||ex.target)}</span><strong>${ex.media_status==='needs_license'?'Animation slot ready':'No animation linked yet'}</strong><small>${ex.media_status==='needs_license'?'The source includes the media paths, but Gym Visual images/GIFs are not bundled until reuse rights are confirmed. Add licensed files under exercise-media/ and set this record\'s media_status to licensed.':'This exercise has no demonstration file linked. A licensed thumbnail/GIF can be added later if available.'}</small></div></div>`;
  const bodyPart=ex.body_part||ex.category||'Not specified';
  const target=ex.primary_muscle||ex.target||'Not specified';
  const muscles=(ex.secondary_muscles||[]).filter(Boolean);
  showModal(`${modalHead('EXERCISE GUIDE',ex.name,'Quick movement reference')}${media}<p class="exercise-guide-description">${safe(exerciseShortDescription(ex))}</p><div class="exercise-guide-facts"><div><span>BODY PART</span><strong>${safe(bodyPart)}</strong></div><div><span>TARGET MUSCLE</span><strong>${safe(target)}</strong></div><div><span>EQUIPMENT</span><strong>${safe(ex.equipment||'Bodyweight')}</strong></div><div><span>REST</span><strong>${n(ex.default_rest_sec)?`${n(ex.default_rest_sec)} sec`:'No preset'}</strong></div>${muscles.length?`<div class="wide"><span>SECONDARY MUSCLES</span><strong>${safe(muscles.join(', '))}</strong></div>`:''}</div><div class="exercise-guide-credit">${ex.media_attribution?safe(ex.media_attribution):'Exercise metadata from the Timely Fit master catalogue.'}</div><div class="modal-actions"><button class="save lime" data-action="close-modal">Done</button></div>`);
}
function getEditingExercise() {
  const log=activeLog();
  if(editExerciseLocation?.kind==='history')return log.workout_history?.[editExerciseLocation.sessionIndex]?.exercises?.[editExerciseLocation.exerciseIndex]||null;
  return log.workout_log?.exercises?.[editExerciseIndex]||null;
}
function openEditExercise(index, historySessionIndex=null) {
  editExerciseIndex=index;
  editExerciseLocation=historySessionIndex===null?{kind:'active',exerciseIndex:index}:{kind:'history',sessionIndex:historySessionIndex,exerciseIndex:index};
  const ex=getEditingExercise();if(!ex)return;
  const reference=findExercise(ex.exercise_id)||ex;
  const rows=ex.sets.map((set,i)=>`<div class="set-row edit-set-row"><div class="set-num">SET ${i+1}</div><input class="set-input" type="number" min="0" step="0.5" id="editSetWeight${i}" aria-label="Weight for set ${i+1}" value="${safe(set.weight??0)}"/><input class="set-input" type="number" min="0" step="1" id="editSetReps${i}" aria-label="Reps for set ${i+1}" value="${safe(set.reps??10)}"/><button type="button" class="mini-icon" data-action="edit-remove-set" data-set-index="${i}" aria-label="Remove set ${i+1}" ${ex.sets.length<=1?'disabled':''}>✕</button></div>`).join('');
  const isHistory=editExerciseLocation.kind==='history';
  const desc=isHistory?'Edit this saved workout, including sets, or add sets to its history.':ex.finished?'Reopen this exercise to change finished sets or add another set.':'Change planned sets or edit the exercise details.';
  showModal(`${modalHead('EDIT EXERCISE',safe(ex.name),desc)}
    <div class="selected-food selected-exercise-card">${renderExerciseThumbnail(reference,'selected')}<div><strong class="selected-exercise-name">${safe(ex.name)}</strong><small class="selected-exercise-sub">${safe(ex.primary_muscle||'Full body')} · ${safe(ex.equipment||'Bodyweight')}</small></div></div>
    <div class="sets-header edit-sets-header"><span>SET</span><span>WEIGHT KG</span><span>REPS / MIN</span><span></span></div>
    <div id="editExerciseSetRows">${rows}</div>
    <div class="set-actions"><button type="button" class="outline-button full" data-action="edit-add-set">＋ Add set</button></div>
    <div class="field" style="margin-top:14px"><label for="editRest">REST BETWEEN SETS (SECONDS)</label><input id="editRest" type="number" min="0" max="1800" step="5" value="${safe(n(ex.default_rest_sec))}"/></div>
    <div class="modal-actions"><button class="cancel" data-action="close-modal">Cancel</button><button class="save" data-action="save-exercise-edit">Save changes</button></div>
    <button type="button" class="danger-button" data-action="delete-exercise">🗑 Delete exercise</button>`);
}
function readEditedSets(ex=getEditingExercise()) {
  if(!ex)return;
  ex.sets.forEach((set,i)=>{const w=$('editSetWeight'+i),r=$('editSetReps'+i);if(w)set.weight=Math.max(0,n(w.value));if(r)set.reps=Math.max(0,Math.round(n(r.value)));});
}
function editExerciseAddSet() {
  const ex=getEditingExercise();if(!ex)return;
  readEditedSets(ex);const last=ex.sets[ex.sets.length-1]||{weight:0,reps:10};
  ex.sets.push({set_num:ex.sets.length+1,weight:n(last.weight),reps:n(last.reps),completed:false,completed_at:null});
  if(editExerciseLocation?.kind==='active'&&ex.finished){ex.finished=false;ex.finished_at=null;ex.started=false;}
  scheduleSave();render();openEditExercise(editExerciseIndex,editExerciseLocation?.kind==='history'?editExerciseLocation.sessionIndex:null);
}
function editExerciseRemoveSet(setIndex) {
  const ex=getEditingExercise();if(!ex||ex.sets.length<=1)return;
  readEditedSets(ex);ex.sets.splice(setIndex,1);ex.sets.forEach((set,i)=>{set.set_num=i+1;});
  ex.rest_until=null;ex.last_completed_set=null;
  scheduleSave();render();openEditExercise(editExerciseIndex,editExerciseLocation?.kind==='history'?editExerciseLocation.sessionIndex:null);
}
function saveExerciseEdit() {
  const ex=getEditingExercise();if(!ex)return;
  readEditedSets(ex);if($('editRest'))ex.default_rest_sec=Math.max(0,Math.round(n($('editRest').value)));
  ex.sets.forEach((set,i)=>{set.set_num=i+1;});
  scheduleSave();closeModal();render();toast('Exercise updated.');
}
function deleteExerciseEntry(button) {
  if(button&&button.dataset.armed!=='1'){button.dataset.armed='1';button.textContent='Tap again to delete this exercise';return;}
  const nameEx=getEditingExercise();if(!nameEx)return;const name=nameEx.name;
  if(editExerciseLocation?.kind==='history'){
    const session=activeLog().workout_history?.[editExerciseLocation.sessionIndex];if(!session)return;
    session.exercises.splice(editExerciseLocation.exerciseIndex,1);
  }else{
    const workout=activeLog().workout_log;if(!workout)return;workout.exercises.splice(editExerciseIndex,1);
    if(!workout.exercises.length&&!workout.start_ms)activeLog().workout_log=null;
  }
  editExerciseIndex=null;editExerciseLocation=null;scheduleSave();closeModal();render();toast(`${name} deleted from the log.`);
}
function updateSetPreview() {
  const host=$('setPreview');if(!host)return;const sets=clamp(Math.round(n($('targetSets')?.value)||3),1,20);const start=Math.max(0,n($('startingWeight')?.value)||0);const inc=$('progressiveToggle')?.checked?Math.max(0,n($('weightIncrement')?.value)||0):0;const reps=Math.max(1,Math.round(n($('targetReps')?.value)||10));
  host.innerHTML=Array.from({length:sets},(_,i)=>`Set ${i+1}: <strong>${fmt(start+i*inc,1)} kg × ${reps}</strong>`).join(' &nbsp;·&nbsp; ');
}
function ensureWorkout() {
  const log=activeLog();if(!log.workout_log)log.workout_log={session_id:uid('ws'),start_time:null,end_time:null,start_ms:null,end_ms:null,total_calories_burned:0,exercises:[],status:'planned'};return log.workout_log;
}
function saveExerciseSetup() {
  const ex=findExercise(activeExerciseSelection);if(!ex){toast('Choose an exercise.',true);return;}
  const count=clamp(Math.round(n($('targetSets')?.value)||3),1,20);const reps=Math.max(1,Math.round(n($('targetReps')?.value)||10));const start=Math.max(0,n($('startingWeight')?.value)||0);const increment=$('progressiveToggle')?.checked?Math.max(0,n($('weightIncrement')?.value)||0):0;
  const workout=ensureWorkout();const sets=Array.from({length:count},(_,i)=>({set_num:i+1,weight:round(start+i*increment,2),reps,completed:false}));
  state.recentExerciseIds=recentIds(state.recentExerciseIds,ex.id);
  workout.exercises.push({exercise_id:ex.id,name:ex.name,image:ex.image||null,gif_url:ex.gif_url||null,media_status:ex.media_status||null,primary_muscle:ex.primary_muscle,target:ex.target,body_part:ex.body_part,secondary_muscles:ex.secondary_muscles||[],equipment:ex.equipment,met_value:ex.met_value,default_rest_sec:ex.default_rest_sec,tracking_metrics:ex.tracking_metrics||['weight','reps'],sets,started:false,finished:false,rest_until:null,last_completed_set:null,created_at:new Date().toISOString()});
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
  ex.started=true;ex.start_ms=ex.start_ms||Date.now();set.completed=!set.completed;set.completed_at=set.completed?new Date().toISOString():null;
  if(set.completed&&n(ex.default_rest_sec)>0){ex.rest_until=Date.now()+n(ex.default_rest_sec)*1000;ex.last_completed_set=setIndex;startRestTicker();}
  else if(!set.completed){ex.rest_until=null;ex.last_completed_set=null;}
  scheduleSave();render();
}
function startRestTicker() {
  if(lastRestTick)return;
  lastRestTick=setInterval(()=>{
    const clocks=[...document.querySelectorAll('.rest-clock')];if(!clocks.length){clearInterval(lastRestTick);lastRestTick=null;return;}
    for(const clock of clocks){const until=n(clock.dataset.until);const seconds=Math.max(0,Math.ceil((until-Date.now())/1000));clock.textContent=`${String(Math.floor(seconds/60)).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`;if(seconds<=0){clock.textContent='00:00';clock.style.color='#bb6541';}}
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
  workout.end_ms=end;workout.end_time=new Date(end).toISOString();workout.total_calories_burned=burned;workout.duration_minutes=round((end-workout.start_ms)/60000,1);workout.status='completed';workout.exercises.forEach(ex=>{ex.started=false;if(!ex.finished&&ex.sets.some(s=>s.completed)){ex.finished=true;ex.finished_at=new Date(end).toISOString();ex.start_ms=ex.start_ms||workout.start_ms;}});
  log.workout_history.push(workout);log.workout_log=null;scheduleSave();render();toast(hasCompleteMET?`Session saved · ${fmt(burned)} kcal estimated.`:'Session saved. Calorie estimate unavailable because one or more exercises have no MET values.');
}

// Water and settings
function addWater(amount) {
  if(amount==='custom') { showModal(`${modalHead('HYDRATION','Add custom water','Log the amount you drank.')}<div class="field"><label for="customWaterAmount">AMOUNT (ML)</label><input id="customWaterAmount" type="number" min="1" step="25" placeholder="e.g. 350" autofocus /></div><div class="modal-actions"><button class="cancel" data-action="close-modal">Cancel</button><button class="save lime" data-action="save-custom-water">Add water</button></div>`);return; }
  const ml=Math.round(n(amount));if(ml<=0)return;currentLog().water_log.push({entry_id:uid('water'),timestamp:new Date().toISOString(),amount_ml:ml});scheduleSave();render();toast(`${fmt(ml)} ml water logged.`);
}
function saveCustomWater() { const ml=Math.round(n($('customWaterAmount')?.value));if(ml<=0){toast('Enter an amount above zero.',true);return;}currentLog().water_log.push({entry_id:uid('water'),timestamp:new Date().toISOString(),amount_ml:ml});scheduleSave();closeModal();render();toast(`${fmt(ml)} ml water logged.`); }
function deleteWater(entryId) { const log=activeLog();const idx=log.water_log.findIndex(item=>(item.entry_id||item.timestamp)===entryId);if(idx<0)return;log.water_log.splice(idx,1);scheduleSave();render();toast('Water entry removed.'); }
function toDateTimeLocal(iso) { const d=new Date(iso);const pad=v=>String(v).padStart(2,'0');return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; }
function editWaterEntry(entryId) {
  const item=activeLog().water_log.find(x=>(x.entry_id||x.timestamp)===entryId);if(!item)return;
  showModal(`${modalHead('HYDRATION','Edit water entry','Correct the amount or timestamp. Your daily total updates immediately.')}<div class="field"><label for="editWaterAmount">AMOUNT (ML)</label><input id="editWaterAmount" type="number" min="1" step="25" value="${safe(item.amount_ml)}" /></div><div class="field"><label for="editWaterTime">TIME</label><input id="editWaterTime" type="datetime-local" value="${safe(toDateTimeLocal(item.timestamp))}" /></div><div class="modal-actions"><button class="cancel" data-action="close-modal">Cancel</button><button class="save lime" data-action="save-water-edit" data-id="${safe(entryId)}">Save changes</button></div>`);
}
function saveWaterEdit(entryId) {
  const item=activeLog().water_log.find(x=>(x.entry_id||x.timestamp)===entryId);if(!item)return;const amount=Math.round(n($('editWaterAmount')?.value));const time=$('editWaterTime')?.value;
  if(amount<1||!time||Number.isNaN(new Date(time).getTime())){toast('Enter a valid amount and time.',true);return;}
  item.amount_ml=amount;item.timestamp=new Date(time).toISOString();scheduleSave();closeModal();render();toast('Water entry updated.');
}
function renderSupabaseAccountSection() {
  const config=window.FORMA_SUPABASE_CONFIG||{};const configured=!!(config.url&&config.publishableKey);
  if(!configured)return `<div class="setting-section"><h3>PROFILE ACCOUNT & AUTO SYNC</h3><p>Cloud sync is ready to configure. Add your Supabase project URL and publishable key to <code>supabase-config.js</code>, then run <code>supabase-schema.sql</code> in the Supabase SQL Editor. Never put a service-role key in this app.</p><p>After signing in, local changes are uploaded automatically in the background in batches. Set completions and water taps are grouped with other changes rather than sent one-by-one.</p></div>`;
  if(!supabaseClient)return `<div class="setting-section"><h3>PROFILE ACCOUNT</h3><p>Supabase configuration was found, but its client did not initialize. Check your internet connection and project URL/key.</p></div>`;
  if(authUser)return `<div class="setting-section"><h3>PROFILE ACCOUNT</h3><p>Signed in as <strong>${safe(authUser.email||'Authenticated user')}</strong>.</p><p>Changes sync automatically in the background in small batches.${state.syncMeta?.lastSyncedAt?` Last sync: ${safe(new Date(state.syncMeta.lastSyncedAt).toLocaleString())}.`:''}</p><button class="outline-button" style="width:100%" data-action="auth-signout">Sign out</button></div>`;
  return `<div class="setting-section"><h3>PROFILE ACCOUNT & AUTO SYNC</h3><p>Sign in to restore your own logs on another device. After sign-in, changes are synced in the background in small batches. Set completions and water taps are not sent one-by-one.</p><div class="field"><label for="authEmail">EMAIL</label><input id="authEmail" type="email" autocomplete="email" placeholder="you@example.com" /></div><div class="field"><label for="authPassword">PASSWORD</label><input id="authPassword" type="password" autocomplete="current-password" minlength="8" placeholder="At least 8 characters" /></div><div class="modal-actions"><button class="cancel" data-action="auth-signin">Sign in</button><button class="save lime" data-action="auth-signup">Create account</button></div></div>`;
}
function openSettings() {
  const p=state.profile;
  showModal(`${modalHead('PERSONALIZE TIMELY FIT','Settings & daily targets','Your targets and app preferences.')}
    <div class="setting-section"><h3>APP APPEARANCE</h3><div class="switch-row"><div class="switch-copy"><strong>Dark mode</strong><span>Use a modern dark theme across the app and its dialogs.</span></div><label class="switch"><input type="checkbox" id="darkModeToggle" ${state.preferences?.darkMode?'checked':''}><span class="switch-track"></span></label></div></div>
    <div class="setting-section"><h3>PROFILE</h3><div class="field"><label for="profileWeight">BODY WEIGHT (KG)</label><input id="profileWeight" type="number" min="20" max="350" step="0.1" value="${safe(p.weightKg)}" /></div></div>
    <div class="setting-section"><h3>DAILY TARGETS</h3><div class="field-grid"><div class="field"><label for="targetCalories">CALORIES (KCAL)</label><input id="targetCalories" type="number" min="500" max="10000" step="50" value="${safe(p.calorieTarget)}" /></div><div class="field"><label for="targetProtein">PROTEIN (G)</label><input id="targetProtein" type="number" min="1" max="600" step="5" value="${safe(p.proteinTarget)}" /></div></div><div class="field"><label for="targetWater">WATER (ML)</label><input id="targetWater" type="number" min="250" max="10000" step="250" value="${safe(p.waterTarget)}" /></div></div>
    <div class="setting-section"><h3>ENERGY BALANCE</h3><div class="switch-row"><div class="switch-copy"><strong>Add active calories burned to daily nutrition target</strong><span>When on, your calorie allowance increases by the workout estimate. When off, the target stays fixed.</span></div><label class="switch"><input type="checkbox" id="eatBackToggle" ${p.eatBack?'checked':''}><span class="switch-track"></span></label></div></div>
    ${renderSupabaseAccountSection()}
    <div class="setting-section"><h3>LOCAL-FIRST STORAGE</h3><p>Food and exercise search is local and offline-capable. Active workout sets and water taps never trigger a cloud write. Export a copy before changing devices or clearing browser data.</p><button class="outline-button" style="width:100%" data-action="export-data">↧ Export my data (JSON)</button></div>
    <div class="modal-actions"><button class="cancel" data-action="close-modal">Cancel</button><button class="save lime" data-action="save-settings">Save targets</button></div>`);
}
function saveSettings() {
  const next={weightKg:n($('profileWeight')?.value),calorieTarget:Math.round(n($('targetCalories')?.value)),proteinTarget:Math.round(n($('targetProtein')?.value)),waterTarget:Math.round(n($('targetWater')?.value)),eatBack:!!$('eatBackToggle')?.checked};
  if(next.weightKg<20||next.calorieTarget<500||next.proteinTarget<1||next.waterTarget<250){toast('Check the target values and try again.',true);return;}
  state.profile=next;state.profileUpdatedAt=new Date().toISOString();state.syncMeta.pendingProfile=true;scheduleSave(false);closeModal();render();toast('Your settings have been updated.');
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
      if(!local){const remoteRecipe={...row.data,id:row.id,updated_at:row.updated_at};state.customFoods.push(remoteRecipe);hydrateExternalFoodsFromRecipe(remoteRecipe);}
      else if(!(meta.dirtyFoodIds||[]).includes(row.id)&&remoteTs>localTs){const remoteRecipe={...row.data,id:row.id,updated_at:row.updated_at};state.customFoods[idx]=remoteRecipe;hydrateExternalFoodsFromRecipe(remoteRecipe);}
      else if(localTs>remoteTs&&!(meta.dirtyFoodIds||[]).includes(row.id))meta.dirtyFoodIds=Array.from(new Set([...(meta.dirtyFoodIds||[]),row.id]));
    }
    for(const food of state.customFoods){if(!remoteIds.has(food.id))meta.dirtyFoodIds=Array.from(new Set([...(meta.dirtyFoodIds||[]),food.id]));}
    meta.userId=userId;meta.hasCompletedPull=true;
  } finally { suppressDirtyTracking=false; }
  await persistState();render();refreshSyncStatus();scheduleAutoSync(1600);
}
function hydrateExternalFoodsFromRecipe(recipe) {
  for(const component of recipe?.recipe_ingredients||[]){const snapshot=component?.food_snapshot;if(!snapshot||snapshot.data_source!=='Open Food Facts')continue;if(!state.externalFoods.some(food=>food.id===snapshot.id))state.externalFoods.push(snapshot);}
}
async function syncNow(options={}) {
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
    await persistState();render();refreshSyncStatus();if(!options.quiet)toast(`Sync complete · ${logRows.length} date logs, ${foodRows.length} recipes.`);
  } catch(error) { console.error('Supabase sync failed:',error);setSyncStatus('Sync failed · changes kept locally',true);if(!options.quiet)toast(error.message||'Sync failed. Your local data is safe.',true); }
  finally { syncing=false;refreshSyncStatus(); }
}
function updateAuthGate() {
  const gate=$('authGate'),shell=$('appShell');if(!gate||!shell)return;
  if(authUser||localOnlyMode){gate.classList.add('hidden');shell.classList.remove('hidden');if(localOnlyMode&&!authUser)setSyncStatus('Local only · not synced');return;}
  gate.classList.remove('hidden');shell.classList.add('hidden');
  const configured=supabaseConfigured()&&!!window.supabase?.createClient;
  const localButton=gate.querySelector('[data-action="local-only"]');if(localButton)localButton.classList.toggle('hidden',configured);
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
    case 'open-universal-add': universalAddMode='ingredient';renderUniversalAddModal();break;
    case 'set-universal-add-mode': universalAddMode=button.dataset.mode==='recipe'?'recipe':'ingredient';renderUniversalAddModal();break;
    case 'continue-universal-add': if(universalAddMode==='recipe'){recipeIngredients=[];recipeReturnMeal=activeFoodMeal;openRecipeModal();}else openCustomIngredientModal();break;
    case 'adjust-workout-input': {const input=$(button.dataset.target);if(input){const delta=n(button.dataset.delta);let value=n(input.value)+delta;if(input.id==='targetSets')value=clamp(Math.round(value),1,20);else if(input.id==='startingWeight')value=Math.max(0,round(value,1));input.value=String(value);updateSetPreview();}break;}
    case 'select-food': selectFoodInPicker(button.dataset.id);break;
    case 'toggle-food-kind': { const kind=button.dataset.kind;if(kind==='ingredients'||kind==='recipes'){foodKindFilters[kind]=!foodKindFilters[kind];button.classList.toggle('active',foodKindFilters[kind]);button.setAttribute('aria-pressed',String(foodKindFilters[kind]));renderFoodResults($('foodSearch')?.value||'');}break; }
    case 'clear-food-selection': { activeFoodSelection=null;const panel=$('foodSelectionPanel');if(panel)panel.hidden=true;renderFoodResults($('foodSearch')?.value||'');break; }
    case 'add-custom-ingredient': openCustomIngredientModal();break;
    case 'save-custom-ingredient': saveCustomIngredient();break;
    case 'select-external-food': { const food=externalFoodMatches.find(x=>x.id===button.dataset.id)||(state.externalFoods||[]).find(x=>x.id===button.dataset.id);if(food){const index=state.externalFoods.findIndex(x=>x.id===food.id);if(index>=0)state.externalFoods[index]=food;else state.externalFoods.push(food);selectFoodInPicker(food.id);scheduleSave(false);}break; }
    case 'search-online-foods': await searchOpenFoodFacts($('foodSearch')?.value||'');break;
    case 'lookup-food-barcode': await lookupOpenFoodFactsBarcode($('barcodeSearch')?.value||'');break;
    case 'scan-food-barcode': await startBarcodeScanner();break;
    case 'stop-food-barcode': stopBarcodeScanner();closeModal();break;
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
    case 'select-exercise': activeExerciseSelection=button.dataset.id;renderExerciseResults($('exerciseSearch')?.value||'');updateExerciseDetail();break;
    case 'exercise-body-filter': activeExerciseBodyFilter=button.dataset.filter||'all';renderExerciseFilters();renderExerciseResults($('exerciseSearch')?.value||'');break;
    case 'exercise-equipment-filter': activeExerciseEquipmentFilter=button.dataset.filter||'all';renderExerciseFilters();renderExerciseResults($('exerciseSearch')?.value||'');break;
    case 'open-exercise-detail': openExerciseDetail(button.dataset.id);break;
    case 'edit-exercise': openEditExercise(n(button.dataset.exIndex));break;
    case 'edit-history-exercise': openEditExercise(n(button.dataset.exIndex),n(button.dataset.sessionIndex));break;
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
    case 'local-only': localOnlyMode=true;try{localStorage.setItem('forma_local_only_mode','true');}catch(_){}updateAuthGate();render();toast('Local-only mode enabled. Data stays on this device and will not sync to a cloud account.');break;
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

document.addEventListener('keydown',(event)=>{
  if((event.metaKey||event.ctrlKey)&&String(event.key).toLowerCase()==='k'&&$('foodSearch')){event.preventDefault();$('foodSearch').focus({preventScroll:true});}
});

document.addEventListener('input',(event)=>{
  const target=event.target;
  if(target.id==='foodSearch'){renderFoodResults(target.value);scheduleOnlineFoodSearch(target.value);return;}
  if(target.id==='foodAmount'){updateSelectedFoodPreview();return;}
  if(target.id==='foodUnit'){updateSelectedFoodPreview();return;}
  if(target.dataset.role==='recipe-search'){const i=n(target.dataset.index);const ing=recipeIngredients[i];if(ing){ing.query=target.value;if(findFood(ing.foodId)?.name.toLowerCase()!==target.value.trim().toLowerCase())ing.foodId='';renderRecipeSearchResults(i,target.value);updateRecipePreview();}return;}
  if(target.id==='exerciseSearch'){renderExerciseResults(target.value);return;}
  if(['targetSets','targetReps','startingWeight','weightIncrement'].includes(target.id)||target.id==='progressiveToggle'){updateSetPreview();if(target.id==='progressiveToggle'){const box=$('progressiveSettingsBox');if(box)box.hidden=!target.checked;}return;}
  if(target.id==='recipeYield'){updateRecipePreview();return;}
});
document.addEventListener('change',(event)=>{
  const target=event.target;
  if(target.id==='datePicker'&&target.value){state.activeDate=target.value;currentLog();render();persistState();return;}
  if(target.id==='darkModeToggle'){state.preferences=state.preferences||{};state.preferences.darkMode=!!target.checked;applyTheme();scheduleSave(false);return;}
  if(target.id==='foodMeal'){activeFoodMeal=target.value||'breakfast';return;}
  if(target.id==='foodCategoryFilter'){renderFoodResults($('foodSearch')?.value||'');return;}
  if(target.id==='recipeYield'){updateRecipePreview();return;}
  if(target.id==='progressiveToggle'){const box=$('progressiveSettingsBox');if(box)box.hidden=!target.checked;updateSetPreview();return;}
  if(target.dataset.role==='recipe-unit'){const i=n(target.dataset.index);if(recipeIngredients[i]){recipeIngredients[i].unit=target.value;updateRecipePreview();}return;}
  if(target.dataset.role==='recipe-amount'){const i=n(target.dataset.index);if(recipeIngredients[i]){recipeIngredients[i].amount=Math.max(.01,n(target.value));updateRecipePreview();}return;}
  if(target.dataset.role==='set-weight'||target.dataset.role==='set-reps'){
    const ex=activeLog().workout_log?.exercises?.[n(target.dataset.exIndex)];const set=ex?.sets?.[n(target.dataset.setIndex)];if(!set)return;
    if(target.dataset.role==='set-weight')set.weight=Math.max(0,n(target.value));else set.reps=Math.max(0,Math.round(n(target.value)));
    scheduleSave();return;
  }
  if(target.id==='foodAmount')return;
});
// Swipe horizontally across the active timeline to move Diet → Workout → Hydration.
(function enableDomainSwipe(){
  const main=$('mainContent');if(!main)return;
  main.style.touchAction='pan-y';
  let start=null;
  main.addEventListener('touchstart',event=>{
    if(event.touches.length!==1)return;
    const target=event.target;
    if(target.closest('input,textarea,select,[data-no-domain-swipe],.food-local-results,.food-online-results,.exercise-picker-results,.exercise-filter-strip,.date-options,.chart-scroll'))return;
    start={x:event.touches[0].clientX,y:event.touches[0].clientY,time:Date.now()};
  },{passive:true});
  main.addEventListener('touchend',event=>{
    if(!start||!event.changedTouches.length){start=null;return;}
    const end=event.changedTouches[0],dx=end.clientX-start.x,dy=end.clientY-start.y,duration=Date.now()-start.time;start=null;
    if(Math.abs(dx)<58||Math.abs(dx)<Math.abs(dy)*1.25||duration>1000)return;
    const domains=['diet','workout','water'];const current=domains.indexOf(state.selectedDomain);if(current<0)return;
    const next=clamp(current+(dx<0?1:-1),0,domains.length-1);if(next===current)return;
    event.preventDefault();state.selectedDomain=domains[next];render();persistState();
  },{passive:false});
  main.addEventListener('touchcancel',()=>{start=null;},{passive:true});
})();

$('prevDate').addEventListener('click',()=>{state.activeDate=shiftDate(state.activeDate,-1);currentLog();render();persistState();});
$('nextDate').addEventListener('click',()=>{state.activeDate=shiftDate(state.activeDate,1);currentLog();render();persistState();});
$('settingsButton').addEventListener('click',openSettings);
$('globalAdd').addEventListener('click',openCurrentAdd);
function openCurrentAdd() {
  if(state.selectedTab==='dashboard'){state.selectedTab='timeline';render();persistState();}
  if(state.selectedDomain==='diet')openFoodModal('snacks',null,true);
  else if(state.selectedDomain==='workout')openWorkoutModal();
  else addWater('custom');
}
function toast(message,error=false) {
  const region=$('toastRegion');if(!region)return;const el=document.createElement('div');el.className=`toast ${error?'error':''}`;el.textContent=message;region.appendChild(el);setTimeout(()=>{el.style.opacity='0';el.style.transform='translateY(5px)';setTimeout(()=>el.remove(),220);},2400);
}

// Live timers update labels only: no full render, so inputs and scroll position stay stable.
function applyTheme(){document.documentElement.classList.toggle('theme-dark',!!state.preferences?.darkMode);document.body.classList.toggle('theme-dark',!!state.preferences?.darkMode);const meta=document.querySelector('meta[name="theme-color"]');if(meta)meta.content=state.preferences?.darkMode?'#000000':'#101b17';}
setInterval(()=>{
  const sessionClock=$('session-clock');if(sessionClock)sessionClock.textContent=formatDurationHMS(Date.now()-n(sessionClock.dataset.startMs));
  for(const clock of document.querySelectorAll('.rest-clock')){const seconds=Math.max(0,Math.ceil((n(clock.dataset.until)-Date.now())/1000));clock.textContent=`${String(Math.floor(seconds/60)).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`;if(seconds===0)clock.style.color='var(--orange)';}
},1000);

// Safety net for background sync: edits are debounced immediately and retried at two-minute intervals.
setInterval(()=>{
  const meta=state.syncMeta||{};
  const pending=(meta.dirtyDates||[]).length||(meta.dirtyFoodIds||[]).length||meta.pendingProfile;
  if(authUser&&!syncing&&meta.hasCompletedPull&&pending)syncNow({quiet:true});
},120000);

const supabaseSdkScript=$('supabaseSdk');
if(supabaseSdkScript&&!window.supabase?.createClient){
  supabaseSdkScript.addEventListener('load',async()=>{await initialiseSupabase();render();},{once:true});
  supabaseSdkScript.addEventListener('error',()=>{updateAuthGate();}, {once:true});
}
initialise();
