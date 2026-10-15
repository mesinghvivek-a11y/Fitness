const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const foods = JSON.parse(fs.readFileSync(path.join(root, 'foods.json'), 'utf8'));
const ids = new Set();
const names = new Set();
for (const food of foods) {
  assert.ok(food.id && typeof food.id === 'string', 'Every food requires a stable ID');
  assert.ok(!ids.has(food.id), `Duplicate ID: ${food.id}`); ids.add(food.id);
  assert.ok(food.name && typeof food.name === 'string', `Missing name: ${food.id}`);
  assert.ok(food.type && ['raw_ingredient','standard_estimate','custom_recipe'].includes(food.type), `Invalid type: ${food.id}`);
  assert.ok(food.macros_per_100g || food.macros_per_100ml || food.macros_per_serving, `Missing macro basis: ${food.id}`);
  for (const basis of ['macros_per_100g','macros_per_100ml','macros_per_serving']) {
    if (!food[basis]) continue;
    for (const key of Object.keys(food[basis])) assert.ok(Number.isFinite(Number(food[basis][key])) && Number(food[basis][key]) >= 0, `Invalid ${basis}.${key} on ${food.id}`);
  }
  // Duplicate exact display names are intentionally avoided in the master catalogue.
  const name = food.name.trim().toLocaleLowerCase('en');
  assert.ok(!names.has(name), `Duplicate food name: ${food.name}`); names.add(name);
}
const imported = foods.filter(food => food.id.startsWith('csv_'));
assert.equal(imported.length, 947, 'Expected 947 unique imports from the supplied CSV');
assert.ok(imported.every(food => ['USDA Foundation', 'INDB Indian'].includes(food.data_source)), 'Imported source provenance should be retained');
assert.ok(imported.every(food => food.macros_per_100g && food.macros_per_100g.calories !== undefined), 'Imported rows should have per-100g calories');
assert.ok(imported.every(food => food.fiber_data_available === false), 'CSV imports must not claim fibre data');
console.log(`Catalogue checks passed: ${foods.length} foods (${imported.length} CSV imports), unique IDs and names, valid macro records.`);
