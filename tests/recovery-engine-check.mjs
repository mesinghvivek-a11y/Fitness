import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { calculateMuscleState, calculateVolumeHeatmap, createAuditIndex, generateRoutine, getAuditedSlugs, getLastUsedWeight } from '../react-reference/recoveryEngine.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const audit = JSON.parse(fs.readFileSync(path.join(root, 'master_exercises_final_audit.json'), 'utf8'));
const assets = JSON.parse(fs.readFileSync(path.join(root, 'muscle_map_assets.json'), 'utf8'));
const appJs = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
assert.equal(audit.length, 1443, 'all audited exercise rows are present');
assert.ok(audit.every((ex) => ex.id && Array.isArray(ex.muscle_map_slugs)), 'each exercise has an explicit slug array');
const idx = createAuditIndex(audit);
for (const ex of audit) for (const slug of ex.muscle_map_slugs) assert.ok(idx.validSlugs.has(slug), `known slug: ${slug}`);
const mapped = new Set([...assets.front, ...assets.back].map((part) => part.slug));
for (const slug of idx.validSlugs) assert.ok(mapped.has(slug), `audited slug has an SVG region: ${slug}`);
assert.match(sw, /master_exercises_final_audit\.json/, 'audited JSON is precached');
assert.match(sw, /muscle_map_assets\.json/, 'SVG data is precached');
assert.match(sw, /timely-fit-shell-v7-visual-recovery-heatmap/, 'cache version bumped');
assert.match(appJs, /function calculateMuscleState\(/, 'integrated app computes recovery state');
assert.match(appJs, /function calculateVolumeHeatmap\(/, 'integrated app computes 30-day volume');
assert.match(appJs, /exercise\.muscle_map_slugs/, 'integrated app only reads slug array from audit');
assert.doesNotMatch(appJs, /sourceSlugsForExercise[\s\S]{0,400}(?:body_part|\.target)/, 'source slugs are not inferred from body-part/target strings');

const absExercise = audit.find((ex) => ex.muscle_map_slugs.includes('abs') && ex.muscle_map_slugs.includes('obliques'));
assert.ok(absExercise, 'fixture exercise includes abs and obliques');
const now = Date.now();
const fixture = (hoursAgo) => ({
  '2026-10-15': {
    date: '2026-10-15', workout_history: [{ start_ms: now - hoursAgo * 3600000, exercises: [{ exercise_id: absExercise.id, name: absExercise.name, sets: [{ completed: true, completed_at: now - hoursAgo * 3600000, weight: 50, reps: 10 }, { completed: true, completed_at: now - hoursAgo * 3600000, weight: 55, reps: 8 }] }] }],
    workout_log: null,
  },
});
let recovery = calculateMuscleState({ logs: fixture(12), auditExercises: audit, mapAssets: assets, now });
assert.equal(recovery.statusBySlug.abs, 'exhausted', 'less than 24 h is red');
recovery = calculateMuscleState({ logs: fixture(24), auditExercises: audit, mapAssets: assets, now });
assert.equal(recovery.statusBySlug.abs, 'recovering', 'exactly 24 h remains yellow');
recovery = calculateMuscleState({ logs: fixture(48), auditExercises: audit, mapAssets: assets, now });
assert.equal(recovery.statusBySlug.abs, 'recovering', 'exactly 48 h remains yellow');
recovery = calculateMuscleState({ logs: fixture(48.01), auditExercises: audit, mapAssets: assets, now });
assert.equal(recovery.statusBySlug.abs, 'fresh', 'more than 48 h is green');
assert.equal(recovery.front.find((part) => part.slug === 'abs')?.color, '#22c55e', 'map output contains color per slug');
const unknownExercise = { exercise_id: 'not-in-audit', name: 'Definitely Unknown', body_part: 'Core & Abs', target: 'abs' };
assert.deepEqual(getAuditedSlugs(unknownExercise, idx), [], 'no slug inference from target or body part');

const logs = fixture(1);
const heat = calculateVolumeHeatmap({ logs, auditExercises: audit, mapAssets: assets, now });
assert.equal(heat.volumeBySlug.abs, 940, 'per-set volume sums weight times reps');
assert.equal(heat.volumeBySlug.obliques, 940, 'exercise volume is credited to each audited slug');
assert.equal(heat.completedWeightedSets, 2, 'only completed weighted sets count');
assert.equal(getLastUsedWeight(absExercise, { logs, auditExercises: audit }), 55, 'last completed set weight is found');
const generated = generateRoutine({ selectedSlugs: ['abs'], statusBySlug: recovery.statusBySlug, equipment: 'Bodyweight', auditExercises: audit, logs, random: () => 0.25 });
assert.ok(generated.routine.length >= 4 && generated.routine.length <= 6, 'routine selects four to six when enough matches exist');
assert.ok(generated.routine.every((item) => item.equipment === 'Bodyweight'), 'equipment filter is exact');
assert.ok(generated.routine.every((item) => item.sets === 4 && item.reps === 12), 'routine defaults to four sets of twelve');
assert.ok(generated.routine.every((item) => item.muscle_map_slugs.every((slug) => idx.validSlugs.has(slug))), 'generated routine has only valid audited slugs');
console.log(`Recovery engine tests passed: ${audit.length} audited exercises, ${idx.validSlugs.size} slugs, exact 24/48-hour thresholds, strict slug mapping, 30-day volume math, historical weight lookup, and equipment-filtered generation.`);
