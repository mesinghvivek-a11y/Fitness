/* Run: node tests/workout-engine-check.mjs
 * Verifies the four generator rules against the real exercises.json (enriched). */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const E = createRequire(import.meta.url)(path.join(root, 'workout-engine.js'));
const DB = JSON.parse(fs.readFileSync(path.join(root, 'exercises.json'), 'utf8'));

/* Same canonical-muscle mapping the app uses (exercise-generator.js › cmName). */
const cmName = s => { const t = String(s || '').toLowerCase(); return /cardio/.test(t) ? 'Cardio' : /full body/.test(t) ? 'Full Body' : /pector|chest/.test(t) ? 'Chest' : /delt|shoulder/.test(t) ? 'Shoulders' : /^lat/.test(t) ? 'Lats' : /upper back|rhomboid|levator|^back/.test(t) ? 'Upper Back' : /trap/.test(t) ? 'Traps' : /spine|lower back|posterior/.test(t) ? 'Lower Back' : /bicep/.test(t) ? 'Biceps' : /tricep/.test(t) ? 'Triceps' : /forearm|grip/.test(t) ? 'Forearms' : /abs|core|serratus|oblique|waist/.test(t) ? 'Abs & Core' : /hamstring/.test(t) ? 'Hamstrings' : /glute|hip/.test(t) ? 'Glutes' : /adductor|abductor/.test(t) ? 'Hips' : /calve|ankle/.test(t) ? 'Calves' : /quad|leg/.test(t) ? 'Quads' : /neck/.test(t) ? 'Neck' : /arm/.test(t) ? 'Biceps' : null; };
const muscleOf = ex => cmName(ex.primary_muscle || ex.target || ex.body_part || '');
const POOL = DB.filter(e => muscleOf(e));
const MUSCLES = [...new Set(POOL.map(muscleOf))];
const EQUIP = [...new Set(POOL.map(e => e.equipment))];

/* seeded RNG so failures are reproducible */
const seeded = seed => () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const base = (extra = {}) => ({ database: POOL, muscleOf, rng: seeded(7), ...extra });
const key = e => E.varietyKey(e);
let n = 0; const ok = msg => { n++; console.log('  ✓ ' + msg); };

console.log('Data');
assert.ok(DB.every(e => [1, 2, 3].includes(e.tier)), 'every exercise has a tier');
assert.ok(DB.every(e => e.base_family && e.angle && e.mechanic && typeof e.unilateral === 'boolean' && e.equipment_setup), 'every exercise has the enriched metadata');
ok('all ' + DB.length + ' exercises carry tier / base_family / angle / mechanic / unilateral / equipment_setup');

console.log('Rule A — progressive pool + session memory');
{
  const session = E.createGeneratorSession();
  const seenAll = new Set();
  const r1 = session.generate('Glutes', 'Barbell', 3, base());
  assert.equal(r1.exercises.length, 3);
  assert.ok(r1.exercises.every(e => e.tier === 1), 'first batch is Tier 1 only');
  r1.exercises.forEach(e => seenAll.add(e.id));
  const r2 = session.generate('Glutes', 'Barbell', 3, base());
  assert.ok(r2.exercises.every(e => !seenAll.has(e.id)), 'second click never repeats the first batch');
  assert.ok(r2.exercises.every(e => e.tier === 1), 'second batch is still Tier 1 while Tier 1 lasts');
  r2.exercises.forEach(e => seenAll.add(e.id));
  ok('batch 1 and 2 are different Tier 1 exercises');

  let sawFallback = false;
  for (let i = 0; i < 8; i++) {
    const r = session.generate('Glutes', 'Barbell', 3, base());
    if (r.exercises.some(e => e.tier === 2)) sawFallback = true;
    if (r.cycleRestarted) seenAll.clear();   // a new cycle legitimately forgets the old one
    else r.exercises.forEach(e => assert.ok(!seenAll.has(e.id), 'no repeat before the pool is used up'));
    r.exercises.forEach(e => seenAll.add(e.id));
  }
  assert.ok(sawFallback, 'Tier 2 fills in silently once Tier 1 is exhausted');
  ok('Tier 1 exhausted -> silent Tier 2 fallback');

  const fresh = E.createGeneratorSession();
  const a = fresh.generate('Biceps', 'Barbell', 3, base());
  assert.equal(a.exercises[0].id, 'ex_647', 'the only Tier 1 biceps barbell move comes first');
  assert.ok(a.tierBreakdown[1] >= 1);
  ok('Tier 1 is always drawn before Tier 2 (Barbell Curl leads a biceps batch)');

  const none = E.generateExercises('Biceps', 'Barbell', 3, base({ previouslyGeneratedIds: ['ex_647'] }));
  assert.ok(none.exercises.every(e => e.id !== 'ex_647' || none.cycleRestarted));
  ok('previouslyGeneratedIds is honoured');
}

console.log('Rule B — variation killer');
{
  let checked = 0;
  for (let i = 0; i < 600; i++) {
    const rng = seeded(1000 + i);
    const pick = a => a[Math.floor(rng() * a.length)];
    const muscles = [pick(MUSCLES)]; if (rng() > .6) muscles.push(pick(MUSCLES));
    const eq = [pick(EQUIP)]; if (rng() > .5) eq.push(pick(EQUIP));
    const r = E.generateExercises(muscles, eq, 2 + Math.floor(rng() * 7), base({
      rng, includeTier23: rng() > .5, includeUnilateral: rng() > .5,
      availableSetups: rng() > .5 ? ['flat_bench', 'incline_bench', 'decline_bench', 'preacher_bench', 'stability_ball', 'box'] : []
    }));
    const keys = r.exercises.map(key);
    assert.equal(new Set(keys).size, keys.length, 'duplicate family+angle in ' + r.exercises.map(e => e.name).join(' | '));
    checked += r.exercises.length;
  }
  ok('600 random batches (' + checked + ' exercises): never two with the same base_family + angle');

  const bench = POOL.filter(e => e.base_family === 'bench_press' && e.angle === 'flat' && e.equipment_setup === 'flat_bench' && e.tier === 1);
  const inc = POOL.find(e => e.base_family === 'bench_press' && e.angle === 'incline' && e.equipment === 'Barbell' && e.mechanic);
  const r = E.generateExercises('Chest', ['Barbell', 'Dumbbell'], 6, base({ availableSetups: ['flat_bench', 'incline_bench', 'decline_bench'], includeTier23: true }));
  assert.ok(r.exercises.filter(e => e.base_family === 'bench_press' && e.angle === 'flat').length <= 1);
  ok('Barbell + Dumbbell flat bench press never appear together (' + bench.length + ' Tier-1 flat bench presses exist); an incline variation may');
  assert.ok(inc);
}

console.log('Rule C — compound first');
for (let i = 0; i < 100; i++) {
  const rng = seeded(5000 + i);
  const r = E.generateExercises(['Chest', 'Triceps', 'Shoulders'], EQUIP, 8, base({ rng, includeTier23: true, includeUnilateral: true, availableSetups: ['flat_bench', 'incline_bench', 'decline_bench'] }));
  const firstIso = r.exercises.findIndex(e => e.mechanic !== 'compound');
  if (firstIso !== -1) assert.ok(r.exercises.slice(firstIso).every(e => e.mechanic !== 'compound'), 'compound after isolation');
}
ok('100 mixed batches: every compound sits above every isolation');
{
  const sorted = E.sortCompoundFirst([{ mechanic: 'isolation', n: 1 }, { mechanic: 'compound', n: 2 }, { mechanic: 'isolation', n: 3 }, { mechanic: 'compound', n: 4 }], x => x);
  assert.deepEqual(sorted.map(x => x.n), [2, 4, 1, 3]);
  ok('sortCompoundFirst is stable');
}

console.log('Rule D — equipment setup filtering');
{
  for (let i = 0; i < 200; i++) {
    const rng = seeded(9000 + i);
    const r = E.generateExercises(MUSCLES.slice(0, 6), EQUIP, 10, base({ rng, includeTier23: true, includeUnilateral: true }));
    assert.ok(r.exercises.every(e => e.equipment_setup === 'none'), 'setup exercise leaked: ' + r.exercises.map(e => e.name + ':' + e.equipment_setup));
  }
  ok('no setup-dependent exercise appears when no setup is selected');
  const withBench = E.generateExercises('Chest', 'Barbell', 4, base({ availableSetups: ['flat_bench'] }));
  assert.ok(withBench.exercises.some(e => e.equipment_setup === 'flat_bench'), 'Barbell Bench Press unlocks with a bench');
  assert.ok(withBench.exercises.every(e => e.equipment_setup === 'none' || e.equipment_setup === 'flat_bench'));
  ok('ticking "flat bench" unlocks bench exercises and only those');
  const noBench = E.generateExercises('Chest', 'Barbell', 4, base());
  assert.ok(noBench.hidden.setups > 0, 'the result reports how many exercises the setup filter hid');
  ok('the result reports what was hidden (' + noBench.hidden.setups + ' chest barbell exercises need a setup)');
}

console.log('Settings — unilateral and tiers');
{
  const off = E.generateExercises(MUSCLES, EQUIP, 12, base({ includeTier23: true }));
  assert.ok(off.exercises.every(e => !e.unilateral));
  ok('unilateral exercises are excluded by default');
  let sawUni = false, sawT3 = false;
  for (let i = 0; i < 80; i++) {
    const r = E.generateExercises(MUSCLES, EQUIP, 14, base({ rng: seeded(300 + i), includeUnilateral: true, includeTier23: true }));
    r.exercises.forEach(e => { if (e.unilateral) sawUni = true; if (e.tier === 3) sawT3 = true; });
  }
  assert.ok(sawUni && sawT3);
  ok('turning the toggles on lets unilateral and Tier 3 exercises through');
  for (let i = 0; i < 80; i++) {
    const r = E.generateExercises(MUSCLES, EQUIP, 14, base({ rng: seeded(700 + i) }));
    assert.ok(r.exercises.every(e => e.tier <= 2));
  }
  ok('Tier 3 never appears unless "Include Tier 2/3" is on');
}

console.log('Edge cases');
{
  const r = E.generateExercises('Biceps', 'Barbell', 4, base());
  assert.ok(r.exercises.length < 4 && r.shortfall === 4 - r.exercises.length && r.reason === 'variation_limited', 'got ' + r.exercises.length + ' ' + r.reason);
  ok('asks for 4, only ' + r.exercises.length + ' distinct movements fit -> returns them with shortfall=' + r.shortfall + ', reason=' + r.reason);
  const relaxed = E.generateExercises('Biceps', 'Barbell', 4, base({ relaxVariation: true }));
  assert.equal(relaxed.exercises.length, 4); assert.ok(relaxed.relaxedUsed);
  assert.equal(new Set(relaxed.exercises.map(e => e.id)).size, 4);
  ok('opt-in relaxVariation tops the batch up to 4 and says it bent Rule B');
  for (const bad of [0, -3, NaN, undefined, 'x', null]) assert.equal(E.generateExercises('Chest', 'Barbell', bad, base()).reason, 'invalid_request');
  ok('invalid counts (0, negative, NaN, undefined, text, null) return an empty, well-shaped result');
  assert.equal(E.generateExercises('Chest', 'Barbell', 3, { database: [] }).reason, 'no_matches');
  assert.equal(E.generateExercises('Nonexistent', 'Barbell', 3, base()).reason, 'no_matches');
  assert.equal(E.generateExercises([], 'Barbell', 3, base()).reason, 'no_matches');
  assert.equal(E.generateExercises('Chest', 'Barbell', 3).reason, 'no_matches');
  ok('empty database, unknown muscle, no muscle, missing settings -> no_matches, never throws');
  const huge = E.generateExercises(MUSCLES, EQUIP, 9999, base({ includeTier23: true, includeUnilateral: true, availableSetups: ['flat_bench', 'incline_bench', 'decline_bench', 'preacher_bench', 'stability_ball', 'box'] }));
  assert.ok(huge.exercises.length <= E.MAX_EXERCISES);
  ok('count is capped at ' + E.MAX_EXERCISES);
  const any = E.generateExercises('Chest', [], 3, base());
  assert.ok(any.exercises.length > 0);
  ok('empty equipment list means any equipment');
  const messy = [{ id: 'a', name: 'Odd Press', primary_muscle: 'Chest', equipment: 'Barbell' }, { id: 'a', name: 'Dup', primary_muscle: 'Chest', equipment: 'Barbell' }, null, { name: 'no id' }];
  const m = E.generateExercises('Chest', 'Barbell', 3, { database: messy, muscleOf });
  assert.equal(m.exercises.length, 1);
  ok('records with no metadata, duplicate ids, null rows and missing ids are handled (missing tier counts as Tier 2)');
  const keepSet = POOL.filter(e => e.id === 'ex_647');
  const withKeep = E.generateExercises('Biceps', 'Barbell', 2, base({ keep: keepSet }));
  assert.ok(withKeep.exercises.every(e => e.id !== 'ex_647' && key(e) !== key(keepSet[0])));
  ok('exercises already in the routine (keep) are never repeated or duplicated by family+angle');
}

console.log('Cycle restart');
{
  const s = E.createGeneratorSession();
  const seen = new Set(); let restarted = false;
  for (let i = 0; i < 12; i++) {
    const r = s.generate('Calves', 'Bodyweight', 2, base({ rng: seeded(40 + i), includeTier23: true }));
    assert.ok(r.exercises.length > 0, 'never returns nothing while eligible exercises exist');
    if (r.cycleRestarted) restarted = true;
    r.exercises.forEach(e => seen.add(e.id));
  }
  assert.ok(restarted, 'the session started a new cycle once the pool was used up');
  ok('pool used up -> session starts a fresh cycle instead of returning an empty list');
}

console.log('Ceiling on batch size with the current metadata (all equipment, Tier 1-3, unilateral + all setups on)');
const all = ['flat_bench', 'incline_bench', 'decline_bench', 'preacher_bench', 'stability_ball', 'box'];
const ceilings = {};
MUSCLES.forEach(m => { ceilings[m] = E.generateExercises(m, [], 50, base({ includeTier23: true, includeUnilateral: true, availableSetups: all })).exercises.length; });
console.log('  ' + Object.entries(ceilings).map(([k, v]) => k + ' ' + v).join(' · '));

console.log('\n' + n + ' checks passed');
