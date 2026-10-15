import csv, json, pathlib, math
root = pathlib.Path(__file__).resolve().parents[1]
foods = json.loads((root / 'foods.json').read_text(encoding='utf-8'))
rows = list(csv.DictReader((root / 'data_sources/final_master_foods.csv').open(encoding='utf-8-sig', newline='')))
by_name = {food['name'].strip().casefold(): food for food in foods}
assert len(rows) == 950
assert len(foods) == 1174
assert len({f['id'] for f in foods}) == len(foods)
assert len({f['name'].strip().casefold() for f in foods}) == len(foods)
assert sum(f['id'].startswith('csv_') for f in foods) == 947
source_updates = [f for f in foods if f.get('source_record_updated_from_csv')]
assert len(source_updates) == 3
corrected = 0
for row in rows:
    food = by_name[row['food_name'].strip().casefold()]
    assert food['data_source'] == row['source'], (row['food_name'], food['data_source'], row['source'])
    assert food['category'] == row['category'], row['food_name']
    values = food['macros_per_100g']
    for csv_col, key in [('calories', 'calories'), ('protein_g', 'protein'), ('carbs_g', 'carbs'), ('fat_g', 'fat')]:
        expected = float(row[csv_col])
        if key == 'carbs' and expected < 0:
            expected = 0
            corrected += 1
        assert math.isclose(float(values[key]), expected, abs_tol=0.00011), (row['food_name'], key, values[key], expected)
    assert food['fiber_data_available'] is False
assert corrected == 10
assert all(f.get('source_carbs_original', 0) < 0 for f in foods if f.get('source_carbs_original') is not None)
print('Food import verified: 950 CSV rows mapped, 947 added + 3 updated in place, 10 negative carb values transparently normalized, no duplicate IDs/names.')
