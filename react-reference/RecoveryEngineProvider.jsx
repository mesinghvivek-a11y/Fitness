import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  calculateMuscleState,
  calculateVolumeHeatmap,
  generateRoutine,
  RECOVERY_COLORS,
} from './recoveryEngine.js';

const RecoveryContext = createContext(null);
const DB_NAME = 'forma_local_v1';
const DB_VERSION = 1;
const STATE_KEY = 'app_state';
const AUDIT_CACHE_KEY = 'master_exercises_final_audit_cache_v1';
const MAP_CACHE_KEY = 'muscle_map_assets_cache_v1';

function openFormaDb() {
  if (!('indexedDB' in window)) return Promise.resolve(null);
  return new Promise((resolve) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'key' });
      // Match the complete Timely Fit v1 schema so this adapter never creates an incomplete DB.
      if (!db.objectStoreNames.contains('foods')) db.createObjectStore('foods', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('exercises')) db.createObjectStore('exercises', { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
}

async function readKV(key) {
  const db = await openFormaDb();
  if (!db || !db.objectStoreNames.contains('kv')) return null;
  return new Promise((resolve) => {
    const request = db.transaction('kv', 'readonly').objectStore('kv').get(key);
    request.onsuccess = () => resolve(request.result?.value ?? null);
    request.onerror = () => resolve(null);
  });
}

async function writeKV(key, value) {
  const db = await openFormaDb();
  if (!db || !db.objectStoreNames.contains('kv')) return false;
  return new Promise((resolve) => {
    const transaction = db.transaction('kv', 'readwrite');
    transaction.objectStore('kv').put({ key, value });
    transaction.oncomplete = () => resolve(true);
    transaction.onerror = () => resolve(false);
  });
}

async function readAppState() {
  const fromDb = await readKV(STATE_KEY);
  if (fromDb && typeof fromDb === 'object') return fromDb;
  try {
    const fallback = JSON.parse(localStorage.getItem('forma_state_fallback') || 'null');
    return fallback && typeof fallback === 'object' ? fallback : { activeDate: new Date().toISOString().slice(0, 10), logs: {} };
  } catch {
    return { activeDate: new Date().toISOString().slice(0, 10), logs: {} };
  }
}

async function loadResource(url, key) {
  try {
    const response = await fetch(url, { cache: 'no-cache' });
    if (!response.ok) throw new Error(`Could not load ${url}`);
    const value = await response.json();
    await writeKV(key, value);
    return value;
  } catch (error) {
    const cached = await readKV(key);
    if (cached) return cached;
    throw error;
  }
}

function todayKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function slugArrayForRoutine(item, validSlugs) {
  // Preserve only the source JSON's explicit muscle_map_slugs. Never infer from target/body_part.
  return Array.isArray(item.muscle_map_slugs) ? item.muscle_map_slugs.filter((slug) => validSlugs.has(slug)) : [];
}

export function RecoveryEngineProvider({ children, auditUrl = '/master_exercises_final_audit.json', mapAssetsUrl = '/muscle_map_assets.json', onInjectRoutine }) {
  const [auditExercises, setAuditExercises] = useState([]);
  const [mapAssets, setMapAssets] = useState({ front: [], back: [] });
  const [appState, setAppState] = useState({ activeDate: todayKey(), logs: {} });
  const [selectedSlugs, setSelectedSlugs] = useState([]);
  const [side, setSide] = useState('front');
  const [equipment, setEquipment] = useState('Any equipment');
  const [routine, setRoutine] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const validSlugs = useMemo(() => new Set(auditExercises.flatMap((item) => Array.isArray(item.muscle_map_slugs) ? item.muscle_map_slugs : []).filter((slug) => typeof slug === 'string' && slug.length)), [auditExercises]);

  const refresh = useCallback(async () => {
    try {
      const nextState = await readAppState();
      setAppState(nextState);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read workout logs');
    }
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      try {
        const [audit, assets, storedState] = await Promise.all([
          loadResource(auditUrl, AUDIT_CACHE_KEY),
          loadResource(mapAssetsUrl, MAP_CACHE_KEY),
          readAppState(),
        ]);
        if (!Array.isArray(audit) || !audit.every((item) => item?.id && Array.isArray(item.muscle_map_slugs))) throw new Error('The audited exercise JSON is not valid.');
        if (!Array.isArray(assets?.front) || !Array.isArray(assets?.back)) throw new Error('The body map path JSON is not valid.');
        if (!alive) return;
        setAuditExercises(audit);
        setMapAssets(assets);
        setAppState(storedState);
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : 'Recovery engine failed to load');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    const onVisible = () => { if (document.visibilityState === 'visible') refresh(); };
    window.addEventListener('focus', refresh);
    window.addEventListener('timelyfit:state-updated', refresh);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      window.removeEventListener('focus', refresh);
      window.removeEventListener('timelyfit:state-updated', refresh);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [auditUrl, mapAssetsUrl, refresh]);

  const logs = appState?.logs || {};
  const recovery = useMemo(() => calculateMuscleState({ logs, auditExercises, mapAssets }), [logs, auditExercises, mapAssets]);
  const volumeHeatmap = useMemo(() => calculateVolumeHeatmap({ logs, auditExercises, mapAssets }), [logs, auditExercises, mapAssets]);

  const toggleMuscle = useCallback((slug) => {
    if (!validSlugs.has(slug)) return;
    if (selectedSlugs.includes(slug)) {
      setSelectedSlugs((previous) => previous.filter((value) => value !== slug));
      return;
    }
    if (recovery.statusBySlug[slug] === 'exhausted' && !window.confirm('This muscle is still recovering from a recent workout. Are you sure you want to train it?')) return;
    setSelectedSlugs((previous) => [...new Set([...previous.filter((value) => validSlugs.has(value)), slug])]);
  }, [validSlugs, selectedSlugs, recovery.statusBySlug]);

  const autoSelectFresh = useCallback(() => {
    const fresh = [...validSlugs].filter((slug) => recovery.statusBySlug[slug] === 'fresh');
    for (let i = fresh.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [fresh[i], fresh[j]] = [fresh[j], fresh[i]];
    }
    if (fresh.length < 3) throw new Error('Fewer than three fresh muscle groups are available.');
    const selected = fresh.slice(0, 3);
    setSelectedSlugs(selected);
    return selected;
  }, [validSlugs, recovery.statusBySlug]);

  const generate = useCallback(() => {
    const result = generateRoutine({ selectedSlugs, statusBySlug: recovery.statusBySlug, equipment, auditExercises, logs });
    setSelectedSlugs(result.selectedSlugs);
    setRoutine(result.routine);
    return result;
  }, [selectedSlugs, recovery.statusBySlug, equipment, auditExercises, logs]);

  const updateRoutineWeight = useCallback((exerciseId, weightInput) => {
    setRoutine((previous) => previous.map((item) => String(item.id) === String(exerciseId) ? { ...item, weightInput } : item));
  }, []);

  const injectRoutine = useCallback(async () => {
    if (!routine.length) throw new Error('Generate a routine first.');
    if (onInjectRoutine) {
      await onInjectRoutine(routine, { selectedSlugs, equipment });
      await refresh();
      return;
    }
    const latest = await readAppState();
    const date = latest.activeDate || todayKey();
    const logsCopy = { ...(latest.logs || {}) };
    const log = JSON.parse(JSON.stringify(logsCopy[date] || { date, diet_log: { breakfast: [], lunch: [], dinner: [], snacks: [] }, workout_log: null, workout_history: [], water_log: [] }));
    if (!log.workout_log) log.workout_log = { session_id: `ws_${Date.now().toString(36)}`, start_time: null, end_time: null, start_ms: null, end_ms: null, total_calories_burned: 0, exercises: [], status: 'planned' };
    for (const item of routine) {
      const slugs = slugArrayForRoutine(item, validSlugs);
      if (!slugs.length) continue;
      const bodyweight = String(item.equipment || '').toLowerCase() === 'bodyweight';
      const rawWeight = item.weightInput === '' || item.weightInput == null ? item.lastWeight : Number(item.weightInput);
      const weight = bodyweight ? 0 : Math.max(0, Number(rawWeight) || 0);
      log.workout_log.exercises.push({
        exercise_id: item.id, name: item.name, image: item.image || null, gif_url: item.gifUrl || item.gif_url || null,
        primary_muscle: item.target || '', target: item.target || '', body_part: item.body_part || '', equipment: item.equipment || '',
        default_rest_sec: Number(item.default_rest_sec) || 60, tracking_metrics: ['weight', 'reps'], muscle_map_slugs: slugs,
        sets: Array.from({ length: 4 }, (_, index) => ({ set_num: index + 1, weight, reps: 12, completed: false, completed_at: null })),
        started: false, finished: false, rest_until: null, last_completed_set: null, created_at: new Date().toISOString(),
      });
    }
    logsCopy[date] = log;
    const nextState = { ...latest, logs: logsCopy, syncMeta: { ...(latest.syncMeta || {}), dirtyDates: [...new Set([...(latest.syncMeta?.dirtyDates || []), date])] } };
    const saved = await writeKV(STATE_KEY, nextState);
    let fallbackSaved = false;
    try { localStorage.setItem('forma_state_fallback', JSON.stringify(nextState)); fallbackSaved = true; } catch {}
    if (!saved && !fallbackSaved) throw new Error('Could not save the routine locally.');
    setAppState(nextState);
    window.dispatchEvent(new CustomEvent('timelyfit:state-updated', { detail: { date } }));
  }, [routine, selectedSlugs, equipment, onInjectRoutine, refresh, validSlugs]);

  const value = useMemo(() => ({
    auditExercises, mapAssets, validSlugs, appState, logs, recovery, volumeHeatmap,
    selectedSlugs, setSelectedSlugs, side, setSide, equipment, setEquipment, routine,
    loading, error, refresh, toggleMuscle, autoSelectFresh, generate, updateRoutineWeight, injectRoutine, RECOVERY_COLORS,
  }), [auditExercises, mapAssets, validSlugs, appState, logs, recovery, volumeHeatmap, selectedSlugs, side, equipment, routine, loading, error, refresh, toggleMuscle, autoSelectFresh, generate, updateRoutineWeight, injectRoutine]);

  return <RecoveryContext.Provider value={value}>{children}</RecoveryContext.Provider>;
}

export function useRecoveryEngine() {
  const value = useContext(RecoveryContext);
  if (!value) throw new Error('useRecoveryEngine must be used inside RecoveryEngineProvider.');
  return value;
}
