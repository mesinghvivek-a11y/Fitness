# Timely Fit picker refresh — October 2026

## Food selection

- Full-width search with independently toggled Ingredients and Recipes pills. Both are active by default. Local matches are separated into Ingredients first, then Recipes.
- Selecting a result reveals the item macro/source detail and quantity, unit, meal and time controls directly beneath the local results. Logged timestamps use the active timeline date plus the selected time.
- The single universal Add control opens an Ingredient/Recipe mode toggle. Ingredient mode opens the form for name, unit/basis, category, known macros, optional fibre, source and tags; blank fibre is preserved as unknown.
- Recipe mode opens the existing ingredient-based recipe builder, which requires at least two ingredients. New recipes return to the meal the user was logging, rather than always returning to breakfast.
- Packaged-product search is debounced (850 ms after at least three characters) against Open Food Facts. Barcode lookup remains available.
- Camera scanning supports QR codes and retail barcodes through native `BarcodeDetector` or a ZXing CDN fallback. Use HTTPS or `localhost`, allow camera permission, and be online for product lookup. Manual barcode entry is the fallback.

## Exercise selection

- Full-width search followed by two horizontally scrollable pill rows: body part and equipment.
- Filter chips combine common anatomical and equipment groupings for easier browsing; the result list updates immediately.
- Uses the existing 1,443-movement catalogue. This picker intentionally does not create new exercise records.

## Food JSON format

- `Forma_food_JSON_Format_Guide.md` explains the app's record shapes and upload workflow.
- `Forma_foods_JSON_schema.json` validates the full top-level array including `raw_ingredient`, `standard_estimate` and preloaded `custom_recipe` records.
- `Forma_foods_template.json` shows all three record types. Values in example records are illustrative and must be verified/replaced.
- `Forma_foods_additions_blank.json` is an empty top-level array to start an additions-only file.
- When returning updated records, upload the additions-only file and ask for a merge unless you intentionally prepared a full replacement. The merge should preserve unrelated existing IDs and entries.

## Verification

- `node --check app.js` — pass.
- `node tests/catalogue-check.js` — pass.
- `python tests/verify-food-import.py` — pass.
- `node tests/picker-refresh-check.mjs` — should pass after packaging.
- A full real-device camera/browser interaction test has not been performed in this build environment; test scanner permissions and result flow on target browsers before public release.
