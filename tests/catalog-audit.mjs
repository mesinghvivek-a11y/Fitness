import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const foods = JSON.parse(fs.readFileSync(path.join(root, 'foods.json'), 'utf8'));
const exercises = JSON.parse(fs.readFileSync(path.join(root, 'exercises.json'), 'utf8'));
const errors = [];

function assert(condition, message) { if (!condition) errors.push(message); }
function uniqueIds(rows, label) {
  const ids = rows.map(row => row.id);
  assert(ids.every(Boolean), `${label}: every item must have an id`);
  assert(new Set(ids).size === ids.length, `${label}: duplicate IDs found`);
}

uniqueIds(foods, 'foods');
uniqueIds(exercises, 'exercises');
assert(foods.length >= 200, 'Expected the expanded food seed (200+ items)');
assert(exercises.length >= 100, 'Expected the expanded exercise seed (100+ items)');

for (const food of foods) {
  assert(typeof food.name === 'string' && food.name.trim(), `Food ${food.id}: missing name`);
  if (food.type === 'raw_ingredient') {
    const macros = food.macros_per_100g ?? food.macros_per_100ml;
    assert(!!macros, `Raw ingredient ${food.id}: missing per-100g/ml macros`);
    for (const field of ['calories', 'protein', 'carbs', 'fat', 'fiber']) {
      assert(Number.isFinite(macros?.[field]) && macros[field] >= 0, `Food ${food.id}: invalid ${field}`);
    }
    assert(['g', 'ml', 'scoop', 'piece', 'clove', 'tsp', 'tbsp', 'cup', 'slice', 'bunch', 'sprig', 'pinch', 'unit', 'small', 'medium', 'large', 'drop'].includes(food.serving_unit), `Food ${food.id}: unexpected serving_unit ${food.serving_unit}`);
  } else {
    const macros = food.macros_per_serving;
    assert(!!macros, `Estimate ${food.id}: missing per-serving macros`);
    for (const field of ['calories', 'protein', 'carbs', 'fat', 'fiber']) assert(Number.isFinite(macros?.[field]) && macros[field] >= 0, `Food ${food.id}: invalid serving ${field}`);
  }
}

for (const exercise of exercises) {
  for (const field of ['name', 'category', 'primary_muscle', 'equipment', 'default_rest_sec', 'met_value', 'tracking_metrics']) assert(exercise[field] !== undefined, `Exercise ${exercise.id}: missing ${field}`);
  assert(Number.isFinite(exercise.default_rest_sec) && exercise.default_rest_sec >= 0, `Exercise ${exercise.id}: invalid rest time`);
  assert(Number.isFinite(exercise.met_value) && exercise.met_value >= 0, `Exercise ${exercise.id}: invalid MET value`);
  assert(Array.isArray(exercise.tracking_metrics), `Exercise ${exercise.id}: tracking_metrics must be an array`);
}

// Sanity-check the serving-scale rules used by the app.
const soya = foods.find(food => food.id === 'food_101');
if (soya) {
  const kcal = soya.macros_per_100g.calories * 50 / 100;
  const protein = soya.macros_per_100g.protein * 50 / 100;
  assert(kcal === 172.5 && protein === 26, 'Soya 50 g scaling regression');
}
const milk = foods.find(food => food.macros_per_100ml && food.serving_unit === 'ml');
if (milk) {
  const kcal250 = milk.macros_per_100ml.calories * 250 / 100;
  const kcalQuarterLitre = milk.macros_per_100ml.calories * 0.25 * 1000 / 100;
  assert(Math.abs(kcal250 - kcalQuarterLitre) < 1e-9, 'ml/L scaling regression');
}

if (errors.length) {
  console.error(`Catalogue audit failed (${errors.length} issue(s)):`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}
console.log(`Catalogue audit passed: ${foods.length} foods (${foods.filter(x => x.type === 'raw_ingredient').length} raw ingredients, ${foods.filter(x => x.type === 'standard_estimate').length} estimates), ${exercises.length} exercises; unique IDs and required schema fields validated.`);
