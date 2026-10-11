/* Forma PWA — offline-first, no runtime dependencies. */
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
let state = freshState();
let expandedWaterLog = false;
let activeFoodSelection = null;
let activeFoodMeal = 'breakfast';
let editFoodEntryId = null;
let activeExerciseSelection = null;
let recipeIngredients = [];
let activeRecipeIngredient = null;
let analyticsPeriod = 'weekly';
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
    preferences: { lastMasterSeed: 1 }
  };
}
function toDateKey(date) { const d = new Date(date); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
function parseDateKey(key) { const [y,m,d] = key.split('-').map(Number); return new Date(y,m-1,d,12,0,0); }
function shiftDate(key, days) { const d=parseDateKey(key); d.setDate(d.getDate()+days); return toDateKey(d); }
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
function foodIsRaw(food) { return food?.type==='raw_ingredient'; }
function foodMacros(food, amount) {
  const amountN=Math.max(0,n(amount));
  let base;
  if (food?.macros_per_100g) {
    base = (food.serving_unit==='scoop') ? amountN*n(food.default_serving_size||30) : amountN;
    const result={};
    for (const key of ['calories','protein','carbs','fat','fiber']) result[key]=round(n(food.macros_per_100g[key])*base/100,2);
    return result;
  }
  const per=food?.macros_per_serving||{};
  const result={};
  // For estimates, default_serving_size is the amount represented by one macros_per_serving entry (e.g. 150 g cooked rice). Recipes use one unit per serving.
  const servingScale = food?.type==='custom_recipe' ? amountN : amountN / Math.max(0.001,n(food?.default_serving_size)||1);
  for (const key of ['calories','protein','carbs','fat','fiber']) result[key]=round(n(per[key])*servingScale,2);
  return result;
}
function defaultFoodAmount(food) {
  if (!food) return 1;
  if (food.serving_unit==='scoop') return 1;
  return n(food.default_serving_size)||1;
}
function foodAmountUnit(food) { return food?.serving_unit || (foodIsRaw(food)?'g':'serving'); }
function amountLabel(food, amount) { return `${fmt(amount, amount%1?1:0)} ${foodAmountUnit(food)}${foodAmountUnit(food)==='g'||foodAmountUnit(food)==='ml'||foodAmountUnit(food)==='scoop'?'':'s'}`; }
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
async function readMaster(storeName, fileName) {
  try {
    const cached=await idbRequest(storeName,'getAll');
    if(cached&&cached.length) return cached;
    const response=await fetch(fileName);
    if(!response.ok) throw new Error(`Could not load ${fileName}`);
    const items=await response.json();
    if(db) for(const item of items) await idbRequest(storeName,'put',item);
    return items;
  } catch(error) {
    console.warn('Master data could not be loaded:',error);
    return [];
  }
}
async function persistState() {
  const snapshot=JSON.parse(JSON.stringify(state));
  try {
    if(db) await idbRequest('kv','put',{key:'app_state',value:snapshot});
    try { localStorage.setItem('forma_state_fallback',JSON.stringify(snapshot)); } catch(_) {}
    setSyncStatus('Saved locally',false);
  } catch(error) { console.error(error); setSyncStatus('Local save issue',true); }
}
let saveTimer=null;
function scheduleSave() {
  setSyncStatus('Saving…',false);
  clearTimeout(saveTimer);
  saveTimer=setTimeout(()=>{ saveQueue=saveQueue.then(persistState).catch(console.error); },180);
}
function setSyncStatus(text,error=false) {
  const el=$('syncStatus'); if(!el)return;
  el.innerHTML=`<span class="sync-dot" style="background:${error?'#ef987b':'#9bbd61'}"></span><span>${safe(text)}</span>`;
}
function registerServiceWorker() {
  if ('serviceWorker' in navigator && (location.protocol==='https:'||location.hostname==='localhost'||location.hostname==='127.0.0.1')) {
    navigator.serviceWorker.register('./sw.js').catch(err=>console.info('Offline cache not enabled:',err));
  }
}
async function initialise() {
  try { db=await openDatabase(); } catch(error) { console.warn('IndexedDB unavailable; using local storage',error); }
  const stored = db ? await idbRequest('kv','get','app_state').catch(()=>null) : null;
  if(stored?.value) state={...freshState(),...stored.value,profile:{...DEFAULT_PROFILE,...stored.value.profile}};
  else {
    try { const local=JSON.parse(localStorage.getItem('forma_state_fallback')||'null'); if(local) state={...freshState(),...local,profile:{...DEFAULT_PROFILE,...local.profile}}; } catch(_) {}
  }
  masterFoods=await readMaster('foods','foods.json');
  masterExercises=await readMaster('exercises','exercises.json');
  if(!masterFoods.length) masterFoods=offlineFoodsFallback();
  if(!masterExercises.length) masterExercises=offlineExercisesFallback();
  currentLog(state.activeDate);
  render();
  registerServiceWorker();
  scheduleSave();
}
function offlineFoodsFallback() { return [{id:'food_101',name:'Soya Chunks (Dry/Raw)',type:'raw_ingredient',serving_unit:'g',default_serving_size:50,macros_per_100g:{calories:345,protein:52,carbs:33,fat:.5,fiber:13},tags:['high-protein']},{id:'food_105',name:'Rice (Dry/Raw)',type:'raw_ingredient',serving_unit:'g',default_serving_size:75,macros_per_100g:{calories:365,protein:7.1,carbs:80,fat:.7,fiber:1.3},tags:['pantry']},{id:'food_125',name:'Besan Chilla (Cooked Estimate) *',type:'standard_estimate',serving_unit:'piece',default_serving_size:1,macros_per_serving:{calories:140,protein:7,carbs:18,fat:4.5,fiber:3},tags:['breakfast','estimate']}]; }
function offlineExercisesFallback() { return [{id:'ex_101',name:'Barbell Bench Press',category:'Compound',primary_muscle:'Chest',secondary_muscles:['Triceps'],equipment:'Barbell',default_rest_sec:120,met_value:6,tracking_metrics:['weight','reps']},{id:'ex_102',name:'Barbell Back Squat',category:'Compound',primary_muscle:'Legs/Quadriceps',secondary_muscles:['Glutes'],equipment:'Barbell',default_rest_sec:150,met_value:6,tracking_metrics:['weight','reps']}]; }

function render() {
  document.querySelectorAll('.domain-tab').forEach(btn=>btn.classList.toggle('active',btn.dataset.domain===state.selectedDomain));
  document.querySelectorAll('.bottom-tab').forEach(btn=>btn.classList.toggle('active',btn.dataset.tab===state.selectedTab));
  const datePicker=$('datePicker'); if(datePicker) datePicker.value=state.activeDate;
  renderDates();
  if(state.selectedTab==='timeline') $('mainContent').innerHTML=renderTimeline();
  else $('mainContent').innerHTML=renderAnalytics();
  if(state.selectedDomain==='water'&&state.selectedTab==='timeline') { /* quick actions render as part of water page */ }
}
function renderDates() {
  const host=$('dateOptions'); if(!host)return;
  const dates=[-2,-1,0,1,2].map(offset=>shiftDate(state.activeDate,offset));
  const today=toDateKey(new Date());
  host.innerHTML=dates.map(key=>{
    const d=parseDateKey(key); const day=d.toLocaleDateString('en-IN',{weekday:'short'}).toUpperCase();
    const active=key===state.activeDate; const istoday=key===today;
    return `<button class="date-pill ${active?'active':''} ${istoday?'today':''}" data-action="choose-date" data-date="${key}"><span class="date-day">${active?'SELECTED':istoday?'TODAY':day}</span><strong>${d.toLocaleDateString('en-IN',{month:'short',day:'numeric'})}</strong></button>`;
  }).join('');
}
function renderTimeline() {
  const domain=domainMeta[state.selectedDomain];
  const log=activeLog();
  const totals=logTotals(log);
  let body='';
  if(state.selectedDomain==='diet') body=renderDiet(log,totals);
  else if(state.selectedDomain==='workout') body=renderWorkout(log,totals);
  else body=renderWater(log,totals);
  return `
    <section class="section-heading"><div><div class="eyebrow">${domain.eyebrow}</div><h1 class="page-title">${domain.title}</h1><div class="subtitle">${prettyLongDate(state.activeDate)}</div></div><button class="icon-button" data-action="open-settings" aria-label="Targets and settings">⚙</button></section>
    ${renderStreak(log,totals)}
    ${body}
  `;
}
function renderStreak(log,totals) {
  const calorieGoal=state.profile.calorieTarget+(state.profile.eatBack?totals.burned:0);
  const rem=Math.max(0,state.profile.calorieTarget-totals.net);
  const netLabel=state.profile.eatBack?'NET CALORIES':'CALORIES';
  return `<section class="streak-card">
    <div class="streak-top"><div><div class="streak-label">DAILY TARGETS · ${state.profile.eatBack?'EAT-BACK ON':'EAT-BACK OFF'}</div><div class="streak-headline">Your day, in balance</div><div class="streak-sub">${fmt(rem)} kcal left to your goal</div></div><button class="settings-mini" data-action="open-settings" aria-label="Adjust targets">⚙</button></div>
    <div class="progress-stack">
      <div class="progress-row"><div class="progress-label">${netLabel}</div><div class="progress-track"><div class="progress-fill" style="width:${pct(totals.net,state.profile.calorieTarget)}%"></div></div><div class="progress-value">${fmt(totals.net)} <span>/ ${fmt(state.profile.calorieTarget)}</span></div></div>
      <div class="progress-row"><div class="progress-label">Protein</div><div class="progress-track"><div class="progress-fill protein" style="width:${pct(totals.protein,state.profile.proteinTarget)}%"></div></div><div class="progress-value">${fmt(totals.protein)}g <span>/ ${fmt(state.profile.proteinTarget)}g</span></div></div>
      <div class="progress-row"><div class="progress-label">Water</div><div class="progress-track"><div class="progress-fill water" style="width:${pct(totals.water,state.profile.waterTarget)}%"></div></div><div class="progress-value">${fmt(totals.water)} <span>/ ${fmt(state.profile.waterTarget)}ml</span></div></div>
    </div>
    <div class="eat-back-note"><span class="tiny-dot"></span>${state.profile.eatBack?`Workout allowance includes ${fmt(totals.burned)} active kcal`:'Targets stay fixed; workout calories are not added back'}</div>
  </section>`;
}
function renderDiet(log,totals) {
  const meals=MEALS.map(meal=>{
    const items=log.diet_log[meal.key]||[];
    const kcal=items.reduce((sum,item)=>sum+n(item.macros?.calories),0);
    const itemHTML=items.length?items.map(item=>`<article class="food-entry">
      <div class="food-thumb">${nutritionEmoji(findFood(item.food_id)||item)}</div>
      <div class="food-entry-copy"><div class="food-entry-name">${safe(item.name)}</div><div class="food-entry-meta">${safe(item.amount_label||`${fmt(item.amount)} ${item.unit||''}`)} · P ${fmt(item.macros?.protein,1)}g · C ${fmt(item.macros?.carbs,1)}g</div></div>
      <div class="food-entry-macros">${fmt(item.macros?.calories)}<div class="food-entry-meta">kcal</div></div>
      <div class="entry-tools"><button class="mini-icon" title="Edit entry" data-action="edit-food" data-id="${item.entry_id}">✎</button><button class="mini-icon" title="Delete entry" data-action="delete-food" data-id="${item.entry_id}">×</button></div>
    </article>`).join(''):`<div class="empty-meal"><span>${meal.hint}</span><button data-action="open-food" data-meal="${meal.key}">＋ Add food</button></div>`;
    return `<section class="meal-section"><div class="meal-head"><div class="meal-title"><span class="meal-symbol">${meal.icon}</span>${meal.label}<span class="meal-meta">${items.length?`${items.length} item${items.length>1?'s':''}`:''}</span></div><div style="display:flex;align-items:center;gap:7px"><span class="meal-meta">${kcal?fmt(kcal)+' kcal':''}</span><button class="meal-add" data-action="open-food" data-meal="${meal.key}" aria-label="Add to ${meal.label}">＋</button></div></div><div class="meal-items">${itemHTML}</div></section>`;
  }).join('');
  return `<div class="section-title-row" style="margin-top:2px"><h3>Today’s plate</h3><button class="muted-link" data-action="open-recipe">＋ Create recipe</button></div>
    ${meals}
    <div class="nutri-summary">
      <div class="micro-card"><div class="micro-label">CARBS</div><div class="micro-value">${fmt(totals.carbs,1)}<span style="font-size:10px">g</span></div><div class="micro-unit">of daily intake</div></div>
      <div class="micro-card"><div class="micro-label">FAT</div><div class="micro-value">${fmt(totals.fat,1)}<span style="font-size:10px">g</span></div><div class="micro-unit">of daily intake</div></div>
      <div class="micro-card"><div class="micro-label">FIBER</div><div class="micro-value">${fmt(totals.fiber,1)}<span style="font-size:10px">g</span></div><div class="micro-unit">of daily intake</div></div>
    </div>
    <div style="display:flex;justify-content:space-between;align-items:center;margin:13px 2px 0;color:#94a097;font-size:9px"><span>✳ Estimates marked with * are approximate</span><button class="muted-link" data-action="open-food">＋ Log food</button></div>`;
}
function renderWorkout(log,totals) {
  const workout=log.workout_log;
  const history=(log.workout_history||[]).reduce((sum,s)=>sum+s.exercises.length,0);
  if(!workout) {
    const completed=(log.workout_history||[]).slice().reverse();
    const historyMarkup=completed.map(session=>`<article class="exercise-card"><div class="exercise-card-header"><div class="exercise-icon">✅</div><div class="exercise-main"><div class="exercise-name">Session complete</div><div class="exercise-meta">${session.end_time?timeLabel(session.end_time):'Finished'} · ${fmt(session.duration_minutes||0,1)} min</div></div><span class="exercise-state done">SAVED</span></div><div class="exercise-start-row"><div class="exercise-stats">${(session.exercises||[]).length} exercises · ${(session.exercises||[]).reduce((sum,ex)=>sum+ex.sets.filter(st=>st.completed).length,0)} sets completed</div><strong style="font-size:11px;color:#637b50">${fmt(session.total_calories_burned)} kcal</strong></div><div style="font-size:10px;color:#8d9a90;margin-top:8px">${(session.exercises||[]).map(ex=>safe(ex.name)).join(' · ')}</div></article>`).join('');
    return `<section class="workout-hero"><div><div class="eyebrow">${completed.length?'NICE WORK':'READY WHEN YOU ARE'}</div><h2>${completed.length?'Session in the books.':'Build your session.'}</h2><p>${completed.length?'Make today’s effort your next baseline.':'Log sets. Track progress. Keep it moving.'}</p></div><button class="primary-button" data-action="add-exercise">＋ EXERCISE</button></section>
      ${completed.length?`<div class="section-title-row"><h3>Completed today</h3><span class="meal-meta">${completed.length} session${completed.length===1?'':'s'}</span></div>${historyMarkup}`:`<section class="workout-empty"><div class="empty-graphic">🏋️</div><h3>Nothing logged yet</h3><p>Add an exercise to set your reps, starting weight and progression. Your rest timer will take it from there.</p><button class="primary-button" data-action="add-exercise">＋ Add first exercise</button></section>`}`;
  }
  const isStarted=!!workout.start_ms&&!workout.ended;
  const exerciseCards=(workout.exercises||[]).map((ex,index)=>renderExerciseCard(ex,index,workout)).join('');
  const completed=(workout.exercises||[]).filter(ex=>ex.finished).length;
  const doneSets=(workout.exercises||[]).reduce((sum,ex)=>sum+ex.sets.filter(s=>s.completed).length,0);
  const allSets=(workout.exercises||[]).reduce((sum,ex)=>sum+ex.sets.length,0);
  return `<section class="workout-hero"><div><div class="eyebrow">${isStarted?'SESSION IN PROGRESS':'SESSION BUILDER'}</div><h2>${isStarted?'Stay in your groove.':'Your training plan.'}</h2><p>${isStarted?`${doneSets}/${allSets} sets complete · ${workout.start_ms?durationLabel(Date.now()-workout.start_ms):'just started'}`:'Add exercises, then press start.'}</p></div><button class="primary-button ${isStarted?'lime':''}" data-action="${isStarted?'finish-session':'start-session'}">${isStarted?'⏹ FINISH':'▶ START SESSION'}</button></section>
    <div class="section-title-row"><h3>Exercises <span style="color:#9aa69a;font-weight:500">(${workout.exercises.length})</span></h3><button class="muted-link" data-action="add-exercise">＋ Add exercise</button></div>
    ${exerciseCards}
    <div class="session-summary"><div><strong>${doneSets}/${allSets}</strong><span>SETS DONE</span></div><div><strong>${calcVolume(workout)}</strong><span>VOLUME · KG</span></div><div><strong>${fmt(totals.burned)}</strong><span>KCAL BURNED TODAY</span></div></div>
    ${isStarted?`<button class="finish-button" data-action="finish-session">⏹ FINISH SESSION & CALCULATE CALORIES</button>`:''}
    <div style="font-size:9px;color:#98a499;text-align:center;margin:13px 0 0;line-height:1.5">Session calories are estimated at finish using average exercise MET × body weight × elapsed hours.</div>`;
}
function durationLabel(ms) { const mins=Math.max(0,Math.floor(ms/60000)); return mins>=60?`${Math.floor(mins/60)}h ${mins%60}m`:`${mins} min`; }
function calcVolume(workout) { return fmt((workout.exercises||[]).reduce((sum,ex)=>sum+ex.sets.reduce((s,set)=>s+n(set.weight)*n(set.reps)*(set.completed?1:0),0),0)); }
function renderExerciseCard(ex,index,workout) {
  const started=!!ex.started && !ex.finished;
  const done=!!ex.finished;
  const completedSets=ex.sets.filter(s=>s.completed).length;
  const totalVolume=ex.sets.reduce((sum,s)=>sum+(s.completed?n(s.weight)*n(s.reps):0),0);
  const sets=ex.sets.map((set,sidx)=>`<div class="set-row"><div class="set-num">SET ${sidx+1}</div><input class="set-input" type="number" min="0" step="0.5" aria-label="Weight for set ${sidx+1}" value="${safe(set.weight??0)}" data-role="set-weight" data-ex-index="${index}" data-set-index="${sidx}" ${done?'disabled':''}/><input class="set-input" type="number" min="0" step="1" aria-label="Reps for set ${sidx+1}" value="${safe(set.reps??10)}" data-role="set-reps" data-ex-index="${index}" data-set-index="${sidx}" ${done?'disabled':''}/><button class="set-complete ${set.completed?'checked':''}" data-action="complete-set" data-ex-index="${index}" data-set-index="${sidx}" ${done?'disabled':''} aria-label="Mark set ${sidx+1} complete">${set.completed?'✓':'○'}</button></div>`).join('');
  const restSec=n(ex.default_rest_sec||60);
  return `<article class="exercise-card"><div class="exercise-card-header"><div class="exercise-icon">${exerciseEmoji(ex.primary_muscle)}</div><div class="exercise-main"><div class="exercise-name">${safe(ex.name)}</div><div class="exercise-meta">${safe(ex.primary_muscle||'Full body')} · ${safe(ex.equipment||'Bodyweight')} · ${restSec?`${restSec}s rest`:'no rest preset'}</div></div><span class="exercise-state ${done?'done':''}">${done?'DONE':`${completedSets}/${ex.sets.length} SETS`}</span></div>
    <div class="exercise-start-row"><div class="exercise-stats">${ex.sets.length} sets · ${totalVolume?fmt(totalVolume)+' kg volume':'Ready to lift'}</div><button class="exercise-start ${started?'running':''}" data-action="${started?'toggle-exercise':'start-exercise'}" data-ex-index="${index}" ${done?'disabled':''}>${done?'✓ COMPLETE':started?'⌄ SETS OPEN':'▶ START'}</button></div>
    ${started?`<div class="sets-panel"><div class="sets-header"><span>SET</span><span>WEIGHT KG</span><span>REPS / MIN</span><span>DONE</span></div>${sets}<div class="set-actions"><button class="outline-button full" data-action="add-set" data-ex-index="${index}">＋ Add set</button><button class="outline-button full" data-action="finish-exercise" data-ex-index="${index}">Finish exercise</button></div>${ex.rest_until&&ex.last_completed_set!=null?`<div class="rest-timer"><div class="rest-timer-text">⏱ <span>REST</span> <span class="rest-clock" id="rest-clock" data-until="${ex.rest_until}">--:--</span></div><div class="timer-adjust"><button data-action="adjust-rest" data-ex-index="${index}" data-seconds="-30">−30s</button><button data-action="adjust-rest" data-ex-index="${index}" data-seconds="30">+30s</button></div></div>`:''}</div>`:''}</article>`;
}
function exerciseEmoji(muscle='') { const x=String(muscle).toLowerCase(); if(x.includes('chest'))return '🏋️';if(x.includes('back'))return '🧗';if(x.includes('leg')||x.includes('hamstring')||x.includes('glute'))return '🦵';if(x.includes('arm')||x.includes('bicep')||x.includes('tricep'))return '💪';if(x.includes('core'))return '🧘';if(x.includes('shoulder'))return '🏋️';if(x.includes('full'))return '🏃';return '🏋️'; }
function renderWater(log,totals) {
  const percentage=pct(totals.water,state.profile.waterTarget);
  const quick=`<div class="quick-water"><button class="quick-water-btn" data-action="add-water" data-amount="250">💧 +250 ml<span>Small glass</span></button><button class="quick-water-btn" data-action="add-water" data-amount="500">🥤 +500 ml<span>Large glass</span></button><button class="quick-water-btn custom" data-action="add-water" data-amount="custom">🚰 Custom<span>Enter amount</span></button></div>`;
  const waterRows=[...(log.water_log||[])].sort((a,b)=>String(b.timestamp).localeCompare(String(a.timestamp))).map(item=>`<div class="water-log-row"><div class="water-log-icon">💧</div><div class="water-log-info"><strong>${fmt(item.amount_ml)} ml</strong><span>${timeLabel(item.timestamp)} · logged today</span></div><strong class="water-log-amount">+${fmt(item.amount_ml)} ml</strong><button class="mini-icon" data-action="delete-water" data-id="${item.entry_id||item.timestamp}" aria-label="Delete water entry">×</button></div>`).join('');
  return `${quick}
    <section class="water-hero"><div class="water-hero-top"><div><div class="eyebrow">YOUR HYDRATION GOAL</div><h2>Stay in flow.</h2><p>${percentage>=100?'Goal reached. Keep listening to your body.':`${fmt(Math.max(0,state.profile.waterTarget-totals.water))} ml to go today`}</p></div><button class="water-big-number" data-action="toggle-water-log" aria-label="Manage water entries">${fmt(totals.water)}<span> ml</span></button></div><div class="water-progress"><div style="width:${percentage}%"></div></div><div style="display:flex;justify-content:space-between;margin-top:8px;position:relative;z-index:1;color:#6694a2;font-size:9px"><span>${fmt(percentage)}% completed</span><span>Goal ${fmt(state.profile.waterTarget)} ml</span></div></section>
    <div class="section-title-row"><h3>Water timeline</h3><button class="muted-link" data-action="toggle-water-log">${expandedWaterLog?'Hide details':'Manage entries'}</button></div>
    <div class="water-log-list">${(log.water_log||[]).length?(expandedWaterLog?waterRows:waterRows?((log.water_log||[]).slice().sort((a,b)=>String(b.timestamp).localeCompare(String(a.timestamp))).slice(0,4).map(item=>`<div class="water-log-row"><div class="water-log-icon">💧</div><div class="water-log-info"><strong>${fmt(item.amount_ml)} ml</strong><span>${timeLabel(item.timestamp)} · logged today</span></div><strong class="water-log-amount">+${fmt(item.amount_ml)} ml</strong>${expandedWaterLog?`<button class="mini-icon" data-action="delete-water" data-id="${item.entry_id||item.timestamp}">×</button>`:''}</div>`).join('')):''):`<div class="empty-state"><div class="empty-icon">💦</div>Your first glass is one tap away.</div>`}</div>
    ${!expandedWaterLog&&(log.water_log||[]).length>4?`<button class="outline-button" style="width:100%;margin-top:8px" data-action="toggle-water-log">View all ${log.water_log.length} entries</button>`:''}
    <div style="font-size:9px;color:#98a499;text-align:center;margin:17px 0 0">Hydration events are timestamped on this device and saved locally.</div>`;
}

function periodDates() {
  const end=state.activeDate;
  if(analyticsPeriod==='daily') return [end];
  if(analyticsPeriod==='weekly') return Array.from({length:7},(_,i)=>shiftDate(end,i-6));
  return Array.from({length:30},(_,i)=>shiftDate(end,i-29));
}
function logsForPeriod() { return periodDates().map(date=>({date,log:state.logs[date]||null,totals:state.logs[date]?logTotals(state.logs[date]):{calories:0,protein:0,carbs:0,fat:0,fiber:0,water:0,burned:0,net:0}})); }
function periodLabel() { return analyticsPeriod==='daily'?'Selected day':analyticsPeriod==='weekly'?'Last 7 days':'Last 30 days'; }
function renderAnalytics() {
  const periods=`<div class="period-toggle" role="tablist">${[['daily','Daily'],['weekly','Weekly'],['monthly','Monthly']].map(([key,label])=>`<button class="${analyticsPeriod===key?'active':''}" data-action="set-period" data-value="${key}">${label}</button>`).join('')}</div>`;
  const title=state.selectedDomain==='diet'?'Nutrition overview':state.selectedDomain==='workout'?'Training performance':'Hydration overview';
  const content=state.selectedDomain==='diet'?renderDietAnalytics():state.selectedDomain==='workout'?renderWorkoutAnalytics():renderWaterAnalytics();
  return `<section class="section-heading analytics-top"><div><div class="eyebrow">YOUR PATTERNS, NOT PERFECTION</div><h1 class="page-title">Analyze</h1><div class="subtitle">${periodLabel()} · ending ${prettyShortDate(state.activeDate)}</div></div></section>${periods}<div style="height:15px"></div><div class="section-title-row" style="margin-top:0"><h3>${title}</h3><span class="meal-meta">${analyticsPeriod==='daily'?'1 DAY':analyticsPeriod==='weekly'?'7 DAYS':'30 DAYS'}</span></div>${content}`;
}
function dailyDietMacros() { return logTotals(currentLog(state.activeDate)); }
function renderDietAnalytics() {
  const periods=logsForPeriod(); const totals=periods.reduce((s,x)=>({calories:s.calories+x.totals.calories,protein:s.protein+x.totals.protein,carbs:s.carbs+x.totals.carbs,fat:s.fat+x.totals.fat,fiber:s.fiber+x.totals.fiber,burned:s.burned+x.totals.burned}),{calories:0,protein:0,carbs:0,fat:0,fiber:0,burned:0});
  const d=logTotals(currentLog(state.activeDate));
  const target=state.profile.calorieTarget+(state.profile.eatBack?d.burned:0);
  const macroRing=(name,val,goal,color)=>`<div class="macro-ring-card"><div class="ring" style="background:conic-gradient(${color} ${pct(val,goal)}%,#edf1e9 ${pct(val,goal)}% 100%)"><strong>${fmt(val)}g</strong></div><div class="macro-name">${name}</div><div class="macro-small">${fmt(val/Math.max(1,goal)*100)}% of goal</div></div>`;
  const bars=periods.map((x,i)=>({label:analyticsPeriod==='daily'?'Today':analyticsPeriod==='weekly'?parseDateKey(x.date).toLocaleDateString('en-IN',{weekday:'short'}):String(i+1),value:x.totals.calories,goal:state.profile.calorieTarget}));
  const insights= dietInsight(d, target);
  return `<div class="analysis-card"><div class="analysis-card-head"><div><div class="analysis-card-title">Calories logged</div><div class="analysis-card-sub">${analyticsPeriod==='daily'?'One-day intake':`Total intake · ${periodLabel().toLowerCase()}`}</div></div><span class="card-badge">${fmt(d.calories)} / ${fmt(target)} kcal today</span></div><div class="analysis-number-row"><div class="analysis-number">${fmt(totals.calories)}</div><div class="analysis-unit">kcal logged in period</div></div>${renderBarChart(bars,'orange')}<div class="chart-legend"><div class="legend-item"><span class="legend-dot orange"></span>Calories eaten</div><div class="legend-item"><span class="legend-dot" style="background:#fa9d83"></span>Daily goal: ${fmt(state.profile.calorieTarget)} kcal</div></div></div>
    <div class="analysis-card"><div class="analysis-card-head"><div><div class="analysis-card-title">Today's macro balance</div><div class="analysis-card-sub">Consumed vs your protein goal and macro targets</div></div></div><div class="macro-rings">${macroRing('Protein',d.protein,state.profile.proteinTarget,'#c8f16d')}${macroRing('Carbs',d.carbs,Math.round(state.profile.calorieTarget*.45/4),'#8cd3e9')}${macroRing('Fat',d.fat,Math.round(state.profile.calorieTarget*.30/9),'#ffc5a8')}</div></div>
    <div class="analysis-card"><div class="analysis-card-head"><div><div class="analysis-card-title">Meal distribution</div><div class="analysis-card-sub">Where today's calories came from</div></div></div>${renderMealDonut(currentLog(state.activeDate))}</div>
    ${insights}`;
}
function renderBarChart(items,color='green') {
  const max=Math.max(1,...items.map(i=>i.value||0),...items.map(i=>i.goal||0));
  if(!items.some(i=>i.value)) return `<div class="empty-chart">Log a meal to see your calorie trend here.</div>`;
  return `<div class="bar-chart">${items.map(item=>`<div class="chart-bar-wrap"><span class="chart-bar-value">${item.value?fmt(item.value/1000,1)+'k':''}</span><div style="height:${Math.max(2,pct(item.value,max))}%;width:100%;display:flex;justify-content:center;align-items:end;position:relative"><div class="chart-bar ${color==='blue'?'blue':color==='orange'?'orange':color==='purple'?'purple':''}" style="height:100%;width:min(24px,78%)"></div>${item.goal?`<div style="position:absolute;bottom:${pct(item.goal,max)}%;width:100%;border-top:1px dashed #f39b80"></div>`:''}</div><span class="chart-label">${safe(item.label)}</span></div>`).join('')}</div>`;
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
  return `<section class="insight-card"><div class="insight-kicker">✳ FORMA INSIGHT</div><div class="insight-title">${title}</div><div class="insight-body">${body}</div><div class="insight-foot"><span></span>Simple rule-based coaching · not medical advice</div></section>`;
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
  const volumeTrend=entries.slice(-7).map((x,i)=>({label:parseDateKey(x.date).toLocaleDateString('en-IN',{weekday:'short'}),value:x.log?workoutSessions(x.log).reduce((a,s)=>a+(s.exercises||[]).reduce((v,ex)=>v+ex.sets.reduce((st,set)=>st+(set.completed?n(set.weight)*n(set.reps):0),0),0),0):0}));
  const lineValues=Object.entries(exercisePeaks).slice(-8); const maxPeak=Math.max(1,...lineValues.map(x=>x[1]));
  let line='';
  if(lineValues.length){const coords=lineValues.map((x,i)=>`${10+i*(180/Math.max(1,lineValues.length-1))},${105-(x[1]/maxPeak*80)}`).join(' ');line=`<svg viewBox="0 0 200 120" width="100%" height="130" role="img" aria-label="Highest completed weight by exercise"><path d="M10 105 H190" stroke="#e8eee4" stroke-width="1" fill="none"/><polyline points="${coords}" fill="none" stroke="#80b95a" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>${lineValues.map((x,i)=>`<circle cx="${10+i*(180/Math.max(1,lineValues.length-1))}" cy="${105-(x[1]/maxPeak*80)}" r="3.2" fill="#c7f36c" stroke="#fff" stroke-width="1.5"/>`).join('')}</svg><div class="legend-list">${lineValues.map(x=>`<div class="legend-row"><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${safe(x[0])}</span><strong>${fmt(x[1],1)} kg</strong></div>`).join('')}</div>`;} else line=`<div class="empty-chart">Your top weights appear after you complete sets.</div>`;
  const insights=workoutInsight(totalSets,totalVolume,allWorkouts.length);
  return `<div class="analysis-card"><div class="analysis-card-head"><div><div class="analysis-card-title">Muscle group distribution</div><div class="analysis-card-sub">Completed sets by primary muscle group</div></div></div>${donut}</div>
    <div class="analysis-card"><div class="analysis-card-head"><div><div class="analysis-card-title">Strength snapshot</div><div class="analysis-card-sub">Highest recorded working weight per exercise</div></div><span class="card-badge">${lineValues.length} movements</span></div>${line}</div>
    <div class="analysis-card"><div class="analysis-card-head"><div><div class="analysis-card-title">Total volume load</div><div class="analysis-card-sub">Completed sets × reps × weight · kg</div></div><span class="card-badge">${fmt(totalVolume)} kg</span></div>${totalVolume?`<div class="volume-bars">${volumeTrend.map((item,i)=>`<div><div class="vbar" style="height:${Math.max(3,pct(item.value,Math.max(1,...volumeTrend.map(x=>x.value))))}%"></div><small>${safe(item.label)}</small></div>`).join('')}</div>`:`<div class="empty-chart">Log completed weighted sets to see training volume.</div>`}</div>
    <div class="analysis-card"><div class="analysis-card-head"><div><div class="analysis-card-title">Training summary</div><div class="analysis-card-sub">${periodLabel()}</div></div></div><div class="nutri-summary" style="margin:0"><div class="micro-card"><div class="micro-label">SESSIONS</div><div class="micro-value">${allWorkouts.length}</div><div class="micro-unit">logged</div></div><div class="micro-card"><div class="micro-label">SETS</div><div class="micro-value">${totalSets}</div><div class="micro-unit">completed</div></div><div class="micro-card"><div class="micro-label">BURN</div><div class="micro-value">${fmt(totalBurn)}</div><div class="micro-unit">kcal estimate</div></div></div></div>${insights}`;
}
function workoutInsight(sets,volume,sessions) { let title='Build the base';let body='Add a workout and log completed sets to build a useful training history.';if(sets>=12){title='Strong training consistency';body=`You've completed ${sets} sets and logged ${fmt(volume)} kg of volume in this period. Compare like-for-like exercises across weeks rather than chasing every session.`;}else if(sets>0){title='Every completed set counts';body=`${sets} sets are in the log so far. Aim to record the actual reps and load you complete; a reliable baseline makes progressive overload more meaningful.`;}return `<section class="insight-card"><div class="insight-kicker">✳ TRAINING INSIGHT</div><div class="insight-title">${title}</div><div class="insight-body">${body}</div><div class="insight-foot"><span></span>Based on logged sessions · estimates can vary</div></section>`; }
function renderWaterAnalytics() {
  const periods=logsForPeriod();const consumed=periods.reduce((s,x)=>s+x.totals.water,0);const dailyAvg=consumed/Math.max(1,periods.length);const completed=periods.filter(x=>x.totals.water>=state.profile.waterTarget).length;
  const bars=periods.map((x,i)=>({label:analyticsPeriod==='daily'?'Today':analyticsPeriod==='weekly'?parseDateKey(x.date).toLocaleDateString('en-IN',{weekday:'short'}):String(i+1),value:x.totals.water,goal:state.profile.waterTarget}));
  let title='Make hydration easy';let body='Keep water within reach and use a quick-add button after each glass. Your progress becomes clearer as you log more days.';
  if(consumed){if(completed>0){title=`${completed} goal ${completed===1?'day':'days'} reached`;body=`You hit your ${fmt(state.profile.waterTarget)} ml target on ${completed} ${completed===1?'day':'days'} in this period. Keep the routine realistic and consistent.`;}else{title='Small sips add up';body=`Your average is ${fmt(dailyAvg)} ml per day. You are ${fmt(Math.max(0,state.profile.waterTarget-dailyAvg))} ml below your daily target on average.`;}}
  return `<div class="analysis-card"><div class="analysis-card-head"><div><div class="analysis-card-title">Water intake</div><div class="analysis-card-sub">Daily amount vs target line</div></div><span class="card-badge">Goal ${fmt(state.profile.waterTarget)} ml</span></div><div class="analysis-number-row"><div class="analysis-number">${fmt(consumed/Math.max(1,periods.length))}</div><div class="analysis-unit">ml average per day</div></div>${renderBarChart(bars,'blue')}<div class="chart-legend"><div class="legend-item"><span class="legend-dot blue"></span>Water logged</div><div class="legend-item"><span class="legend-dot orange"></span>Daily target</div></div></div>
    <div class="analysis-card"><div class="analysis-card-head"><div><div class="analysis-card-title">Hydration consistency</div><div class="analysis-card-sub">Days meeting the daily target</div></div></div><div class="analysis-number-row"><div class="analysis-number">${completed}</div><div class="analysis-unit">of ${periods.length} days met target</div></div><div class="progress-track" style="height:9px;margin-top:13px;background:#edf2ef"><div class="progress-fill water" style="width:${pct(completed,periods.length)}%"></div></div></div>
    <section class="insight-card"><div class="insight-kicker">✳ HYDRATION INSIGHT</div><div class="insight-title">${title}</div><div class="insight-body">${body}</div><div class="insight-foot"><span></span>General guidance; individual needs vary</div></section>`;
}

// Modal shell and diet logging
function showModal(html) { $('modalRoot').innerHTML=`<div class="modal-backdrop" data-action="backdrop-close"><section class="modal-sheet" role="dialog" aria-modal="true">${html}</section></div>`; }
function closeModal() { $('modalRoot').innerHTML=''; activeFoodSelection=null; editFoodEntryId=null; activeExerciseSelection=null; activeRecipeIngredient=null; }
function modalHead(kicker,title,description='') { return `<div class="modal-handle"></div><div class="modal-head"><div><div class="eyebrow">${kicker}</div><h2>${title}</h2>${description?`<p>${description}</p>`:''}</div><button class="close-modal" data-action="close-modal" aria-label="Close">×</button></div>`; }
function openFoodModal(meal='breakfast', preselect=null) {
  activeFoodMeal=meal||'breakfast'; activeFoodSelection=preselect||null;
  showModal(`${modalHead('ADD TO YOUR DAY','Log a food','Search thousands of foods locally once your master database grows. These entries are saved as editable snapshots.')}
    <div class="search-box"><span class="search-icon">⌕</span><input id="foodSearch" placeholder="Search food, ingredient or meal…" autocomplete="off" /></div>
    <div id="foodResults" class="search-results"></div>
    <div id="selectedFoodDetail"></div>
    <div class="field-grid"><div class="field"><label for="foodAmount">AMOUNT</label><input id="foodAmount" type="number" min="0.1" step="0.1" value="1" /></div><div class="field"><label for="foodMeal">MEAL</label><select id="foodMeal">${MEALS.map(m=>`<option value="${m.key}" ${m.key===activeFoodMeal?'selected':''}>${m.label}</option>`).join('')}</select></div></div>
    <div class="form-note">Raw ingredients scale from per-100 g nutrition. Cooked estimates marked with * use an approximate serving. Editing a logged entry never changes the master data.</div>
    <div class="modal-actions"><button class="cancel" data-action="close-modal">Cancel</button><button class="save lime" data-action="confirm-add-food">＋ Add to timeline</button></div>
    <div style="text-align:center;margin-top:12px"><button class="muted-link" data-action="open-recipe">＋ Create a custom recipe</button></div>`);
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
  const results=allFoods().map(food=>({food,score:searchScore(query,`${food.name} ${(food.tags||[]).join(' ')}`)})).filter(x=>x.score>0).sort((a,b)=>b.score-a.score||a.food.name.localeCompare(b.food.name)).slice(0,12);
  if(!results.length){host.innerHTML=`<div class="empty-chart" style="height:75px">No match yet. Add it as a custom recipe or grow the master foods.json list.</div>`;return;}
  host.innerHTML=results.map(({food})=>{const selected=activeFoodSelection===food.id;const standard=food.type==='standard_estimate'||food.type==='custom_recipe';const kcal=foodMacros(food,defaultFoodAmount(food)).calories;return `<button class="search-result ${selected?'selected':''}" data-action="select-food" data-id="${food.id}"><span class="result-icon">${nutritionEmoji(food)}</span><span class="result-copy"><strong>${safe(food.name)}</strong><span>${food.type==='raw_ingredient'?'Raw ingredient':food.type==='custom_recipe'?'Your recipe':'Cooked estimate'} · ${safe(foodAmountUnit(food))}</span></span><span class="result-calories">${fmt(kcal)} kcal</span></button>`;}).join('');
}
function selectFoodInPicker(foodId) {
  const food=findFood(foodId); if(!food)return; activeFoodSelection=foodId;
  const amount=$('foodAmount'); if(amount) amount.value=defaultFoodAmount(food);
  const detail=$('selectedFoodDetail');if(detail){const macros=foodMacros(food,defaultFoodAmount(food));detail.innerHTML=`<div class="selected-food"><span class="result-icon">${nutritionEmoji(food)}</span><div style="flex:1"><strong class="selected-food-name">${safe(food.name)}</strong><small>${fmt(macros.calories)} kcal · P ${fmt(macros.protein,1)}g · C ${fmt(macros.carbs,1)}g · F ${fmt(macros.fat,1)}g</small></div><span style="font-size:9px;font-weight:800;color:#65864b">SELECTED</span></div>`;}
  document.querySelectorAll('#foodResults .search-result').forEach(el=>el.classList.toggle('selected',el.dataset.id===foodId));
}
function addSelectedFood() {
  const food=findFood(activeFoodSelection);if(!food){toast('Choose a food first.',true);return;}
  const amount=Math.max(.1,n($('foodAmount')?.value)||defaultFoodAmount(food));const meal=$('foodMeal')?.value||activeFoodMeal;
  const macros=foodMacros(food,amount);const item={entry_id:uid('log'),food_id:food.id,name:food.name,type:food.type,amount,unit:foodAmountUnit(food),amount_label:amountLabel(food,amount),macros:{...macros},logged_at:new Date().toISOString(),tags:[...(food.tags||[])]};
  currentLog().diet_log[meal].push(item);state.selectedDomain='diet';state.selectedTab='timeline';scheduleSave();closeModal();render();toast(`${food.name} added to ${meal}.`);
}
function findFoodEntry(entryId) {
  const log=activeLog();for(const meal of MEALS){const item=(log.diet_log[meal.key]||[]).find(x=>x.entry_id===entryId);if(item)return {item,meal:meal.key};}return null;
}
function openEditFood(entryId) {
  const result=findFoodEntry(entryId);if(!result)return;editFoodEntryId=entryId;const item=result.item;const macros=item.macros||{};
  showModal(`${modalHead('EDIT ENTRY','Tune this portion','Changes apply only to this logged item, not the master database.')}
    <div class="selected-food"><span class="result-icon">${nutritionEmoji(item)}</span><div><strong>${safe(item.name)}</strong><small>Logged in ${result.meal}</small></div></div>
    <div class="field-grid"><div class="field"><label for="editAmount">AMOUNT</label><input id="editAmount" type="number" min="0.1" step="0.1" value="${safe(item.amount??1)}" /></div><div class="field"><label for="editUnit">UNIT LABEL</label><input id="editUnit" value="${safe(item.unit||'g')}" /></div></div>
    <div class="divider-label">Macros for this entry</div><div class="macro-edit-grid">${[['calories','KCAL'],['protein','PROTEIN G'],['carbs','CARBS G'],['fat','FAT G']].map(([key,label])=>`<div class="field"><label for="macro_${key}">${label}</label><input id="macro_${key}" type="number" min="0" step="0.1" value="${safe(macros[key]??0)}" /></div>`).join('')}</div>
    <div class="field" style="margin-top:12px"><label for="macro_fiber">FIBER G</label><input id="macro_fiber" type="number" min="0" step="0.1" value="${safe(macros.fiber??0)}" /></div>
    <div class="modal-actions"><button class="cancel" data-action="close-modal">Cancel</button><button class="save lime" data-action="save-food-edit">Save entry</button></div>`);
}
function saveFoodEdit() {
  const result=findFoodEntry(editFoodEntryId);if(!result)return;const item=result.item;
  const amount=Math.max(.1,n($('editAmount')?.value)||1);item.amount=amount;item.unit=$('editUnit')?.value||item.unit;item.amount_label=`${fmt(amount,amount%1?1:0)} ${item.unit}`;
  item.macros={calories:round(n($('macro_calories')?.value),2),protein:round(n($('macro_protein')?.value),2),carbs:round(n($('macro_carbs')?.value),2),fat:round(n($('macro_fat')?.value),2),fiber:round(n($('macro_fiber')?.value),2)};
  item.edited=true; scheduleSave(); closeModal(); render(); toast('Entry updated. Master food unchanged.');
}
function removeFoodEntry(entryId) {
  const log=activeLog();for(const meal of MEALS){const i=log.diet_log[meal.key].findIndex(x=>x.entry_id===entryId);if(i>=0){log.diet_log[meal.key].splice(i,1);scheduleSave();render();toast('Food entry removed.');return;}}
}

function openRecipeModal() {
  recipeIngredients=[{foodId:masterFoods.find(f=>f.type==='raw_ingredient')?.id||'',amount:100}];
  showModal(`${modalHead('CUSTOM RECIPE','Build your own recipe','Combine raw ingredients, define the finished yield and Forma will calculate nutrition per serving.')}
    <div class="field"><label for="recipeName">RECIPE NAME</label><input id="recipeName" placeholder="e.g. Paneer & soya bowl" maxlength="70" /></div>
    <div class="field"><label for="recipeYield">FINISHED YIELD (SERVINGS)</label><input id="recipeYield" type="number" min="1" step="1" value="2" /></div>
    <div class="divider-label">Raw ingredients</div><div id="recipeIngredients"></div>
    <button class="outline-button" style="width:100%" data-action="recipe-add-ingredient">＋ Add ingredient</button>
    <div id="recipePreview" class="form-note">Ingredient macros will be totalled and divided by servings.</div>
    <div class="modal-actions"><button class="cancel" data-action="close-modal">Cancel</button><button class="save lime" data-action="save-recipe">Save recipe</button></div>`);
  renderRecipeIngredients();
}
function renderRecipeIngredients() {
  const host=$('recipeIngredients');if(!host)return;
  const options=allFoods().filter(f=>f.type==='raw_ingredient').map(f=>`<option value="${f.id}"> ${safe(f.name)}</option>`).join('');
  host.innerHTML=recipeIngredients.map((ingredient,index)=>`<div class="recipe-ingredient"><select data-role="recipe-food" data-index="${index}" aria-label="Ingredient ${index+1}">${options}</select><input type="number" min="0.1" step="0.1" value="${safe(ingredient.amount)}" data-role="recipe-amount" data-index="${index}" aria-label="Ingredient amount in grams"/><button data-action="recipe-remove-ingredient" data-index="${index}" aria-label="Remove ingredient">×</button></div>`).join('');
  recipeIngredients.forEach((ingredient,index)=>{const select=host.querySelector(`[data-role="recipe-food"][data-index="${index}"]`);if(select)select.value=ingredient.foodId;});
  updateRecipePreview();
}
function updateRecipePreview() {
  const host=$('recipePreview');if(!host)return;let total={calories:0,protein:0,carbs:0,fat:0,fiber:0};
  recipeIngredients.forEach(ing=>{const food=findFood(ing.foodId);if(!food)return;const m=foodMacros(food,ing.amount);for(const key of Object.keys(total))total[key]+=m[key]||0;});
  const yieldCount=Math.max(1,n($('recipeYield')?.value)||2);host.innerHTML=`Whole recipe: <strong>${fmt(total.calories)} kcal</strong> · P ${fmt(total.protein,1)}g · C ${fmt(total.carbs,1)}g · F ${fmt(total.fat,1)}g. Per serving (${yieldCount}): <strong>${fmt(total.calories/yieldCount)} kcal</strong>.`;
}
function saveRecipe() {
  const name=$('recipeName')?.value.trim();if(!name){toast('Give your recipe a name first.',true);return;}
  const yieldCount=Math.max(1,Math.round(n($('recipeYield')?.value)||1));let total={calories:0,protein:0,carbs:0,fat:0,fiber:0};const components=[];
  for(const ing of recipeIngredients){const food=findFood(ing.foodId);if(!food){toast('Choose each ingredient.',true);return;}const amount=Math.max(.1,n(ing.amount));const m=foodMacros(food,amount);for(const key of Object.keys(total))total[key]+=m[key]||0;components.push({food_id:food.id,name:food.name,amount,unit:foodAmountUnit(food),macros:m});}
  if(!components.length){toast('Add at least one ingredient.',true);return;}
  const item={id:uid('recipe'),name,type:'custom_recipe',serving_unit:'serving',default_serving_size:1,macros_per_serving:Object.fromEntries(Object.entries(total).map(([k,v])=>[k,round(v/yieldCount,2)])),tags:['custom','recipe','vegetarian'],recipe_ingredients:components,yield:yieldCount,created_at:new Date().toISOString()};
  state.customFoods.push(item);scheduleSave();closeModal();openFoodModal('breakfast',item.id);toast('Recipe saved to your local foods.');
}

// Workout progression & execution
function openWorkoutModal() {
  activeExerciseSelection=masterExercises[0]?.id||null;
  showModal(`${modalHead('SETUP · TOUCH 1','Add an exercise','Choose a movement, then set your target. Progressive overload pre-fills a planned load for each set.')}
    <div class="search-box"><span class="search-icon">⌕</span><input id="exerciseSearch" placeholder="Search exercise or muscle group…" autocomplete="off" /></div>
    <div id="exerciseResults" class="search-results" style="max-height:195px"></div>
    <div class="selected-food" id="selectedExerciseDetail"><span class="result-icon">🏋️</span><div><strong class="selected-exercise-name">Barbell Bench Press</strong><small class="selected-exercise-sub">Chest · Barbell · 120s default rest</small></div></div>
    <div class="field-grid"><div class="field"><label for="targetSets">TARGET SETS</label><input type="number" id="targetSets" min="1" max="20" value="3" /></div><div class="field"><label for="targetReps">REPS PER SET</label><input type="number" id="targetReps" min="1" max="100" value="10" /></div></div>
    <div class="field"><label for="startingWeight">STARTING WEIGHT (KG)</label><input type="number" id="startingWeight" min="0" step="0.5" value="40" /></div>
    <div class="setting-section"><div class="switch-row"><div class="switch-copy"><strong>Progressive overload</strong><span>Increase the planned weight with each set.</span></div><label class="switch"><input type="checkbox" id="progressiveToggle" checked><span class="switch-track"></span></label></div><div class="field" style="margin:0"><label for="weightIncrement">INCREMENT PER SET (KG)</label><input type="number" id="weightIncrement" min="0" step="0.5" value="5" /></div></div>
    <div id="setPreview" class="form-note">Set 1: 40 kg · Set 2: 45 kg · Set 3: 50 kg</div>
    <div class="modal-actions"><button class="cancel" data-action="close-modal">Cancel</button><button class="save lime" data-action="save-exercise">Add to session →</button></div>`);
  renderExerciseResults('');updateExerciseDetail();updateSetPreview();
}
function renderExerciseResults(query) {
  const host=$('exerciseResults');if(!host)return;
  const results=masterExercises.map(ex=>({ex,score:searchScore(query,`${ex.name} ${ex.primary_muscle} ${ex.category} ${ex.equipment}`)})).filter(x=>x.score>0).sort((a,b)=>b.score-a.score||a.ex.name.localeCompare(b.ex.name)).slice(0,10);
  host.innerHTML=results.map(({ex})=>`<button class="search-result ${activeExerciseSelection===ex.id?'selected':''}" data-action="select-exercise" data-id="${ex.id}"><span class="result-icon">${exerciseEmoji(ex.primary_muscle)}</span><span class="result-copy"><strong>${safe(ex.name)}</strong><span>${safe(ex.primary_muscle)} · ${safe(ex.equipment)}</span></span><span class="result-calories">${ex.default_rest_sec}s</span></button>`).join('')||'<div class="empty-chart" style="height:68px">No exercise matched.</div>';
}
function updateExerciseDetail() {
  const ex=findExercise(activeExerciseSelection);if(!ex)return;const name=$('selectedExerciseDetail')?.querySelector('.selected-exercise-name');const sub=$('selectedExerciseDetail')?.querySelector('.selected-exercise-sub');if(name)name.textContent=ex.name;if(sub)sub.textContent=`${ex.primary_muscle} · ${ex.equipment} · ${ex.default_rest_sec}s default rest`;
  if(ex.tracking_metrics?.includes('duration')&&!ex.tracking_metrics.includes('weight')){if($('targetReps'))$('targetReps').value=20;if($('startingWeight'))$('startingWeight').value=0;}
  updateSetPreview();
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
  workout.exercises.push({exercise_id:ex.id,name:ex.name,primary_muscle:ex.primary_muscle,secondary_muscles:ex.secondary_muscles||[],equipment:ex.equipment,met_value:ex.met_value,default_rest_sec:ex.default_rest_sec,tracking_metrics:ex.tracking_metrics||['weight','reps'],sets,started:false,finished:false,rest_until:null,last_completed_set:null,created_at:new Date().toISOString()});
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
  const end=Date.now();const hours=Math.max(0,(end-workout.start_ms)/3600000);const vals=(workout.exercises||[]).filter(ex=>ex.started||ex.finished||ex.sets.some(s=>s.completed)).map(ex=>n(ex.met_value));
  const averageMET=vals.length?vals.reduce((a,b)=>a+b,0)/vals.length:0;const burned=round(averageMET*n(state.profile.weightKg)*hours);
  workout.end_ms=end;workout.end_time=new Date(end).toISOString();workout.total_calories_burned=burned;workout.duration_minutes=round((end-workout.start_ms)/60000,1);workout.status='completed';workout.exercises.forEach(ex=>{ex.started=false;if(!ex.finished&&ex.sets.some(s=>s.completed))ex.finished=true;});
  log.workout_history.push(workout);log.workout_log=null;scheduleSave();render();toast(`Session saved · ${fmt(burned)} kcal estimated.`);
}

// Water and settings
function addWater(amount) {
  if(amount==='custom') { showModal(`${modalHead('HYDRATION','Add custom water','Log the amount you drank.')}<div class="field"><label for="customWaterAmount">AMOUNT (ML)</label><input id="customWaterAmount" type="number" min="1" step="25" placeholder="e.g. 350" autofocus /></div><div class="modal-actions"><button class="cancel" data-action="close-modal">Cancel</button><button class="save lime" data-action="save-custom-water">Add water</button></div>`);return; }
  const ml=Math.round(n(amount));if(ml<=0)return;currentLog().water_log.push({entry_id:uid('water'),timestamp:new Date().toISOString(),amount_ml:ml});scheduleSave();render();toast(`${fmt(ml)} ml water logged.`);
}
function saveCustomWater() { const ml=Math.round(n($('customWaterAmount')?.value));if(ml<=0){toast('Enter an amount above zero.',true);return;}currentLog().water_log.push({entry_id:uid('water'),timestamp:new Date().toISOString(),amount_ml:ml});scheduleSave();closeModal();render();toast(`${fmt(ml)} ml water logged.`); }
function deleteWater(entryId) { const log=activeLog();const idx=log.water_log.findIndex(item=>(item.entry_id||item.timestamp)===entryId);if(idx<0)return;log.water_log.splice(idx,1);scheduleSave();render();toast('Water entry removed.'); }
function openSettings() {
  const p=state.profile;
  showModal(`${modalHead('PERSONALIZE FORMA','Your daily targets','Set practical goals. They can be adjusted at any time.')}
    <div class="setting-section"><h3>PROFILE</h3><div class="field"><label for="profileWeight">BODY WEIGHT (KG)</label><input id="profileWeight" type="number" min="20" max="350" step="0.1" value="${safe(p.weightKg)}" /></div></div>
    <div class="setting-section"><h3>DAILY TARGETS</h3><div class="field-grid"><div class="field"><label for="targetCalories">CALORIES (KCAL)</label><input id="targetCalories" type="number" min="500" max="10000" step="50" value="${safe(p.calorieTarget)}" /></div><div class="field"><label for="targetProtein">PROTEIN (G)</label><input id="targetProtein" type="number" min="1" max="600" step="5" value="${safe(p.proteinTarget)}" /></div></div><div class="field"><label for="targetWater">WATER (ML)</label><input id="targetWater" type="number" min="250" max="10000" step="250" value="${safe(p.waterTarget)}" /></div></div>
    <div class="setting-section"><h3>ENERGY BALANCE</h3><div class="switch-row"><div class="switch-copy"><strong>Add active calories burned to daily nutrition target</strong><span>When on, your calorie allowance increases by the workout estimate. When off, the target stays fixed.</span></div><label class="switch"><input type="checkbox" id="eatBackToggle" ${p.eatBack?'checked':''}><span class="switch-track"></span></label></div></div>
    <div class="setting-section"><h3>LOCAL-FIRST STORAGE</h3><p>Your daily logs and custom recipes are saved to this browser. Master food and exercise searches read from IndexedDB after the first load. Firebase/Supabase sync is not active until you add your own project configuration.</p><button class="outline-button" style="width:100%" data-action="export-data">↧ Export my data (JSON)</button></div>
    <div class="modal-actions"><button class="cancel" data-action="close-modal">Cancel</button><button class="save lime" data-action="save-settings">Save targets</button></div>`);
}
function saveSettings() {
  const next={weightKg:n($('profileWeight')?.value),calorieTarget:Math.round(n($('targetCalories')?.value)),proteinTarget:Math.round(n($('targetProtein')?.value)),waterTarget:Math.round(n($('targetWater')?.value)),eatBack:!!$('eatBackToggle')?.checked};
  if(next.weightKg<20||next.calorieTarget<500||next.proteinTarget<1||next.waterTarget<250){toast('Check the target values and try again.',true);return;}
  state.profile=next;scheduleSave();closeModal();render();toast('Your targets have been updated.');
}
function exportData() {
  const output={exported_at:new Date().toISOString(),schema_version:1,user_profile:state.profile,daily_logs:Object.values(state.logs).map(log=>{const totals=logTotals(log);return {user_id:'local_user',date:log.date,daily_totals:{net_calories:round(totals.net),protein_g:round(totals.protein,2),carbs_g:round(totals.carbs,2),fat_g:round(totals.fat,2),water_ml:Math.round(totals.water),calories_burned:Math.round(totals.burned)},diet_log:log.diet_log,workout_log:log.workout_log,workout_history:log.workout_history,water_log:log.water_log};}),user_custom_foods:state.customFoods};
  const blob=new Blob([JSON.stringify(output,null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=`forma-export-${toDateKey(new Date())}.json`;document.body.appendChild(a);a.click();a.remove();URL.revokeObjectURL(url);toast('Export prepared.');
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
    case 'domain': state.selectedDomain=button.dataset.value;state.selectedTab='timeline';render();scheduleSave();break;
    case 'tab': state.selectedTab=button.dataset.tab;render();scheduleSave();break;
    case 'choose-date': state.activeDate=button.dataset.date;expandedWaterLog=false;currentLog();render();scheduleSave();break;
    case 'open-settings': openSettings();break;
    case 'open-add': openCurrentAdd();break;
    case 'open-food': openFoodModal(button.dataset.meal||'breakfast');break;
    case 'select-food': selectFoodInPicker(button.dataset.id);break;
    case 'confirm-add-food': addSelectedFood();break;
    case 'edit-food': openEditFood(button.dataset.id);break;
    case 'delete-food': removeFoodEntry(button.dataset.id);break;
    case 'save-food-edit': saveFoodEdit();break;
    case 'open-recipe': openRecipeModal();break;
    case 'recipe-add-ingredient': recipeIngredients.push({foodId:masterFoods.find(f=>f.type==='raw_ingredient')?.id||'',amount:50});renderRecipeIngredients();break;
    case 'recipe-remove-ingredient': recipeIngredients.splice(n(button.dataset.index),1);renderRecipeIngredients();break;
    case 'save-recipe': saveRecipe();break;
    case 'add-exercise': openWorkoutModal();break;
    case 'select-exercise': activeExerciseSelection=button.dataset.id;renderExerciseResults($('exerciseSearch')?.value||'');updateExerciseDetail();break;
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
    case 'save-settings': saveSettings();break;
    case 'export-data': exportData();break;
    case 'set-period': analyticsPeriod=button.dataset.value;render();break;
  }
});

document.addEventListener('input',(event)=>{
  const target=event.target;
  if(target.id==='foodSearch'){renderFoodResults(target.value);return;}
  if(target.id==='foodAmount'){const food=findFood(activeFoodSelection);const detail=$('selectedFoodDetail');if(food&&detail){const macros=foodMacros(food,Math.max(.1,n(target.value)||defaultFoodAmount(food)));const small=detail.querySelector('small');if(small)small.textContent=`${fmt(macros.calories)} kcal · P ${fmt(macros.protein,1)}g · C ${fmt(macros.carbs,1)}g · F ${fmt(macros.fat,1)}g`;}return;}
  if(target.id==='exerciseSearch'){renderExerciseResults(target.value);return;}
  if(['targetSets','targetReps','startingWeight','weightIncrement'].includes(target.id)||target.id==='progressiveToggle'){updateSetPreview();return;}
  if(target.id==='recipeYield'){updateRecipePreview();return;}
});
document.addEventListener('change',(event)=>{
  const target=event.target;
  if(target.id==='datePicker'&&target.value){state.activeDate=target.value;currentLog();render();scheduleSave();return;}
  if(target.id==='recipeYield'){updateRecipePreview();return;}
  if(target.id==='progressiveToggle'){updateSetPreview();return;}
  if(target.dataset.role==='recipe-food'){const i=n(target.dataset.index);if(recipeIngredients[i]){recipeIngredients[i].foodId=target.value;updateRecipePreview();}return;}
  if(target.dataset.role==='recipe-amount'){const i=n(target.dataset.index);if(recipeIngredients[i]){recipeIngredients[i].amount=Math.max(.1,n(target.value));updateRecipePreview();}return;}
  if(target.dataset.role==='set-weight'||target.dataset.role==='set-reps'){
    const ex=activeLog().workout_log?.exercises?.[n(target.dataset.exIndex)];const set=ex?.sets?.[n(target.dataset.setIndex)];if(!set)return;
    if(target.dataset.role==='set-weight')set.weight=Math.max(0,n(target.value));else set.reps=Math.max(0,Math.round(n(target.value)));
    scheduleSave();return;
  }
  if(target.id==='foodAmount')return;
});
$('prevDate').addEventListener('click',()=>{state.activeDate=shiftDate(state.activeDate,-1);currentLog();render();scheduleSave();});
$('nextDate').addEventListener('click',()=>{state.activeDate=shiftDate(state.activeDate,1);currentLog();render();scheduleSave();});
$('settingsButton').addEventListener('click',openSettings);
$('globalAdd').addEventListener('click',openCurrentAdd);
function openCurrentAdd() {
  if(state.selectedTab==='analyze'){state.selectedTab='timeline';render();}
  if(state.selectedDomain==='diet')openFoodModal('snacks');
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

initialise();
