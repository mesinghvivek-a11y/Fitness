import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const bodyStart = source.indexOf('const EXERCISE_BODY_FILTERS = [');
const bodyEnd = source.indexOf('\nfunction updateExerciseDetail()', bodyStart);
assert.ok(bodyStart >= 0 && bodyEnd > bodyStart, 'exercise filter implementation exists');
const context = {};
vm.runInNewContext(`${source.slice(bodyStart, bodyEnd)}\nglobalThis.__filters={exerciseBodyMatches,exerciseEquipmentMatches,EXERCISE_BODY_FILTERS,EXERCISE_EQUIPMENT_FILTERS};`, context);
const filters = context.__filters;
const movement = (body_part, primary_muscle, equipment, category='Compound') => ({body_part, primary_muscle, equipment, category, target:primary_muscle.toLowerCase(), muscle_group:'', secondary_muscles:[]});
assert.equal(filters.exerciseBodyMatches(movement('Chest','Pectorals','Dumbbell'),'chest'), true);
assert.equal(filters.exerciseBodyMatches(movement('Upper Arms','Biceps','Dumbbell'),'arms'), true);
assert.equal(filters.exerciseBodyMatches(movement('Waist','Abs','Bodyweight'),'core'), true);
assert.equal(filters.exerciseEquipmentMatches(movement('Chest','Pectorals','Dumbbells'),'dumbbell'), true);
assert.equal(filters.exerciseEquipmentMatches(movement('Chest','Pectorals','Cable Machine'),'cable'), true);
assert.equal(filters.exerciseEquipmentMatches(movement('Back','Latissimus','Bench'),'bench'), true);
assert.equal(filters.exerciseEquipmentMatches(movement('Back','Latissimus','Rope'),'other'), true);
assert.ok(filters.EXERCISE_BODY_FILTERS.length >= 10, 'body part filter row has useful coverage');
assert.ok(filters.EXERCISE_EQUIPMENT_FILTERS.some(([key])=>key==='bench'), 'bench equipment filter exists');

for (const token of [
  'food-search-hero','food-type-pills','foodSelectionPanel','foodAmount','foodUnit','foodMeal','foodTime',
  'add-custom-ingredient','open-recipe','searchOpenFoodFacts(q)','qr_code','loadZXingFallback',
  'exerciseBodyFilters','exerciseEquipmentFilters','exercise-body-filter','exercise-equipment-filter'
]) assert.ok(source.includes(token), `expected UI feature hook: ${token}`);
const scanStart = source.indexOf('function scannedProductCode(rawValue)');
const scanEnd = source.indexOf('\nasync function handleScannedFoodValue', scanStart);
assert.ok(scanStart >= 0 && scanEnd > scanStart, 'barcode/QR decoder helper exists');
const scanContext = { URL };
vm.runInNewContext(`${source.slice(scanStart, scanEnd)}\nglobalThis.__scannedProductCode=scannedProductCode;`, scanContext);
assert.equal(scanContext.__scannedProductCode('5449000000996'), '5449000000996');
assert.equal(scanContext.__scannedProductCode('https://world.openfoodfacts.org/product/3017620422003'), '3017620422003');
assert.equal(scanContext.__scannedProductCode('not-a-barcode'), '');
assert.ok(!source.includes("data-action='add-custom-exercise'"), 'no exercise-creation flow is introduced');
console.log('Picker refresh checks passed: local food filters, selection detail, online lookup hooks, QR/barcode fallback, and body/equipment filter logic.');
