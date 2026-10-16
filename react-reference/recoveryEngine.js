/** Pure recovery/volume utilities for a React web port of Timely Fit.
 * Muscle associations are read exclusively from exercise.muscle_map_slugs.
 */
export const RECOVERY_COLORS = Object.freeze({
  exhausted: '#ef4444',
  recovering: '#eab308',
  fresh: '#22c55e',
  selected: '#3b82f6',
});

const DAY_MS = 24 * 60 * 60 * 1000;
const normName = (value) => String(value ?? '').trim().toLocaleLowerCase().replace(/\s+/g, ' ');
const timestamp = (value) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value == null || value === '') return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
};
const dateAtNoon = (key) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(key))) return 0;
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d, 12, 0, 0).getTime();
};
const getSessions = (log) => [
  ...(Array.isArray(log?.workout_history) ? log.workout_history : []),
  ...(log?.workout_log ? [log.workout_log] : []),
];

export function createAuditIndex(auditExercises = []) {
  const byId = new Map();
  const byName = new Map();
  const validSlugs = new Set();
  for (const exercise of auditExercises) {
    if (exercise?.id != null) byId.set(String(exercise.id), exercise);
    const name = normName(exercise?.name);
    if (name) byName.set(name, [...(byName.get(name) || []), exercise]);
    if (Array.isArray(exercise?.muscle_map_slugs)) {
      exercise.muscle_map_slugs.forEach((slug) => {
        if (typeof slug === 'string' && slug.trim()) validSlugs.add(slug.trim());
      });
    }
  }
  return { byId, byName, validSlugs };
}

export function getAuditedRecord(loggedExercise, auditIndex) {
  if (!loggedExercise) return null;
  const id = loggedExercise.exercise_id ?? loggedExercise.id;
  if (id != null && auditIndex.byId.has(String(id))) return auditIndex.byId.get(String(id));
  const matches = auditIndex.byName.get(normName(loggedExercise.name)) || [];
  return matches.length === 1 ? matches[0] : null;
}

export function getAuditedSlugs(loggedExercise, auditIndex) {
  const record = getAuditedRecord(loggedExercise, auditIndex);
  if (!Array.isArray(record?.muscle_map_slugs)) return [];
  return [...new Set(record.muscle_map_slugs.filter((slug) => auditIndex.validSlugs.has(slug)))];
}

function fallbackExerciseTime(log, session, exercise, dateKey) {
  return timestamp(exercise?.finished_at)
    || timestamp(session?.end_ms)
    || timestamp(session?.end_time)
    || timestamp(exercise?.start_ms)
    || timestamp(session?.start_ms)
    || dateAtNoon(log?.date || dateKey);
}

function dataForSide(side, colorsBySlug, mapAssets, validSlugs) {
  const seen = new Set();
  return (mapAssets?.[side] || [])
    .filter((part) => part?.slug && validSlugs.has(part.slug) && !seen.has(part.slug) && seen.add(part.slug))
    .map((part) => ({ slug: part.slug, color: colorsBySlug[part.slug] || '#dce2dd', intensity: 1 }));
}

export function calculateMuscleState({ logs = {}, auditExercises = [], mapAssets = { front: [], back: [] }, now = Date.now() }) {
  const auditIndex = createAuditIndex(auditExercises);
  const lastTrainedAt = Object.create(null);
  for (const [dateKey, log] of Object.entries(logs || {})) {
    for (const session of getSessions(log)) {
      for (const exercise of session?.exercises || []) {
        const completed = (exercise.sets || []).filter((set) => !!set.completed);
        if (!completed.length && !exercise.finished) continue;
        const trainedAt = completed.map((set) => timestamp(set.completed_at || set.completedAt || set.timestamp)).filter(Boolean).reduce((max, value) => Math.max(max, value), 0)
          || fallbackExerciseTime(log || { date: dateKey }, session, exercise, dateKey);
        if (!trainedAt) continue;
        for (const slug of getAuditedSlugs(exercise, auditIndex)) {
          lastTrainedAt[slug] = Math.max(lastTrainedAt[slug] || 0, trainedAt);
        }
      }
    }
  }
  const statusBySlug = Object.create(null);
  const ageHoursBySlug = Object.create(null);
  const colorsBySlug = Object.create(null);
  for (const slug of auditIndex.validSlugs) {
    const last = lastTrainedAt[slug] || 0;
    const ageHours = last ? Math.max(0, (now - last) / 3_600_000) : Infinity;
    const status = !last || ageHours > 48 ? 'fresh' : ageHours < 24 ? 'exhausted' : 'recovering';
    statusBySlug[slug] = status;
    ageHoursBySlug[slug] = ageHours;
    colorsBySlug[slug] = RECOVERY_COLORS[status];
  }
  return {
    front: dataForSide('front', colorsBySlug, mapAssets, auditIndex.validSlugs),
    back: dataForSide('back', colorsBySlug, mapAssets, auditIndex.validSlugs),
    statusBySlug,
    ageHoursBySlug,
    lastTrainedAt,
    colorBySlug: colorsBySlug,
    auditIndex,
  };
}

export function getLastUsedWeight(exerciseOrId, { logs = {}, auditExercises = [] } = {}) {
  const auditIndex = createAuditIndex(auditExercises);
  const target = typeof exerciseOrId === 'object'
    ? (exerciseOrId?.id != null ? auditIndex.byId.get(String(exerciseOrId.id)) || exerciseOrId : exerciseOrId)
    : auditIndex.byId.get(String(exerciseOrId));
  if (!target) return null;
  let best = null;
  for (const [dateKey, log] of Object.entries(logs || {})) {
    for (const session of getSessions(log)) {
      for (const exercise of session?.exercises || []) {
        const record = getAuditedRecord(exercise, auditIndex);
        if (!record || String(record.id) !== String(target.id)) continue;
        for (const set of exercise.sets || []) {
          if (!set.completed) continue;
          const weight = Number(set.weight);
          if (!Number.isFinite(weight) || weight <= 0) continue;
          const time = timestamp(set.completed_at || set.completedAt || set.timestamp) || fallbackExerciseTime(log || { date: dateKey }, session, exercise, dateKey);
          if (!best || time >= best.time) best = { weight, time };
        }
      }
    }
  }
  return best?.weight ?? null;
}

function shuffle(items, random = Math.random) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

export function generateRoutine({ selectedSlugs = [], statusBySlug = {}, equipment = 'Any equipment', auditExercises = [], logs = {}, random = Math.random }) {
  const auditIndex = createAuditIndex(auditExercises);
  let selected = [...new Set(selectedSlugs.filter((slug) => auditIndex.validSlugs.has(slug)))];
  if (!selected.length) {
    selected = shuffle([...auditIndex.validSlugs].filter((slug) => statusBySlug[slug] === 'fresh'), random).slice(0, 3);
    if (selected.length < 3) throw new Error('Fewer than three fresh muscle groups are available.');
  }
  const selectedSet = new Set(selected);
  const candidates = shuffle(auditExercises.filter((exercise) =>
    Array.isArray(exercise.muscle_map_slugs)
      && exercise.muscle_map_slugs.some((slug) => selectedSet.has(slug) && auditIndex.validSlugs.has(slug))
      && (!equipment || equipment === 'Any equipment' || exercise.equipment === equipment)), random);
  if (!candidates.length) throw new Error('No exercises match these muscles and equipment. Try Any equipment.');
  const numberToUse = Math.min(candidates.length, 4 + Math.floor(random() * 3));
  const routine = candidates.slice(0, numberToUse).map((exercise) => ({
    ...exercise,
    muscle_map_slugs: exercise.muscle_map_slugs.filter((slug) => auditIndex.validSlugs.has(slug)),
    sets: 4,
    reps: 12,
    lastWeight: getLastUsedWeight(exercise, { logs, auditExercises }),
    weightInput: '',
  }));
  return { selectedSlugs: selected, routine };
}

export function calculateVolumeHeatmap({ logs = {}, auditExercises = [], mapAssets = { front: [], back: [] }, now = Date.now() }) {
  const auditIndex = createAuditIndex(auditExercises);
  const cutoff = now - 30 * DAY_MS;
  const volumeBySlug = Object.fromEntries([...auditIndex.validSlugs].map((slug) => [slug, 0]));
  let totalVolume = 0;
  let completedWeightedSets = 0;
  for (const [dateKey, log] of Object.entries(logs || {})) {
    for (const session of getSessions(log)) {
      for (const exercise of session?.exercises || []) {
        const slugs = getAuditedSlugs(exercise, auditIndex);
        if (!slugs.length) continue;
        for (const set of exercise.sets || []) {
          if (!set.completed) continue;
          const time = timestamp(set.completed_at || set.completedAt || set.timestamp) || fallbackExerciseTime(log || { date: dateKey }, session, exercise, dateKey);
          if (!time || time < cutoff) continue;
          const volume = Math.max(0, Number(set.weight) || 0) * Math.max(0, Number(set.reps) || 0);
          if (!volume) continue;
          totalVolume += volume;
          completedWeightedSets += 1;
          slugs.forEach((slug) => { volumeBySlug[slug] = (volumeBySlug[slug] || 0) + volume; });
        }
      }
    }
  }
  const maxVolume = Math.max(0, ...Object.values(volumeBySlug));
  const colorBySlug = Object.create(null);
  for (const slug of auditIndex.validSlugs) {
    const volume = volumeBySlug[slug] || 0;
    colorBySlug[slug] = volume && maxVolume ? `rgba(239,68,68,${Math.max(0.08, volume / maxVolume).toFixed(3)})` : '#28312c';
  }
  return {
    front: dataForSide('front', colorBySlug, mapAssets, auditIndex.validSlugs),
    back: dataForSide('back', colorBySlug, mapAssets, auditIndex.validSlugs),
    volumeBySlug, colorBySlug, maxVolume, totalVolume, completedWeightedSets, cutoff,
  };
}
