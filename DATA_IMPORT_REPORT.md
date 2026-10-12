# Forma food catalogue import report

## Source file

`data_sources/final_master_foods.csv` was imported as supplied. Its `source` column contains mixed provenance: USDA Foundation and INDB Indian. These labels are preserved as supplied and have not been independently verified.

- Input rows: 950
- New unique catalogue records added: 947
- Exact-name matches with existing Forma items updated using the supplied CSV nutrition/provenance (their IDs were retained): 3 — Mayonnaise, Garam masala, Tomato ketchup
- Existing starter records retained without a matching CSV name: 224 (kept in the separate “Forma starter library” category because the CSV did not provide categories for them)
- Final bundled food catalogue: 1174 records

## Imported fields

Food name, calories, protein, carbohydrates, fat, source and category were incorporated. Nutrients are treated as per 100 g because the file does not specify another basis. Imported items default to 100 g. Fibre was not present in the source; imported/updated records mark fibre unavailable rather than inferring it. No recipes were created from this CSV because it contains no ingredient lists, quantities, yields or recipe method. The app's existing recipe builder remains available to make user recipes from catalogue foods.

## Source record counts (all 950 input rows)

- INDB Indian: 550
- USDA Foundation: 400

## Input records by category

- Beverages: 18
- Dairy: 83
- Fruits: 69
- Grains & Cereals: 75
- Meat & Eggs: 134
- Nuts & Seeds: 34
- Oils & Fats: 22
- Other/Mixed: 378
- Pulses & Legumes: 65
- Vegetables: 72

## Source data quality normalization

Ten records in the supplied CSV have negative carbohydrate values. Those values remain unchanged in `data_sources/final_master_foods.csv`, but the app database sets their carbs to 0 for calculation safety. Each affected app record stores `source_carbs_original` and a `source_data_quality_flags` explanation so the normalization is traceable.

## Data cautions

- Values are used as source-reported nutrition values; they are not medical advice or a guarantee of laboratory-verified composition.
- The CSV has no fibre field. Fibre is therefore unknown for imported records.
- Food descriptions, ingredient lists, allergen claims and recipe yields are not present in the CSV and were not invented.
- Open Food Facts lookup is optional online functionality. Its product data has a separate source label from the imported catalogue and may be incomplete or user-submitted.
