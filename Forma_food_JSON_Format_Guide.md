# Timely Fit food JSON format (current PWA)

These files were prepared against the current Timely Fit static HTML/CSS/JavaScript PWA, not a React/Next.js rewrite.

## 1. Master catalogue: `foods.json`

The app fetches `foods.json` as a **top-level JSON array**. Do not wrap it inside `{"foods": [...]}`. Each array element is one food or ingredient record.

The master catalogue supports three types:

- `raw_ingredient`: nutrition is given per 100 g or per 100 ml (or per 100 g for the app’s special `scoop` unit).
- `standard_estimate`: a prepared food/portion whose nutrition is specified for its `default_serving_size`.
- `custom_recipe`: a complete recipe whose nutrition is given per one serving; it can also include an ingredient breakdown and yield. The picker treats it as a Recipe and the logger scales it by the number of servings.

### Raw solid ingredient (per 100 g)

```json
{
  "id": "food_custom_0001",
  "name": "Your food name",
  "type": "raw_ingredient",
  "serving_unit": "g",
  "default_serving_size": 100,
  "macros_per_100g": {
    "calories": 0,
    "protein": 0,
    "carbs": 0,
    "fat": 0,
    "fiber": 0
  },
  "tags": ["vegetarian", "example-tag"],
  "category": "Pulses & Legumes",
  "data_source": "Name of verified database, package label or source",
  "data_quality": "source-reported",
  "nutrient_fields_available": ["calories", "protein", "carbs", "fat", "fiber"],
  "fiber_data_available": true
}
```

The zero values above are **placeholders only**. Replace them with verified values before using this record.

### Liquid ingredient (per 100 ml)

Use `serving_unit: "ml"` and `macros_per_100ml`. Use litres/L for entering larger liquid amounts; the app converts litres to millilitres when calculating.

```json
{
  "id": "food_custom_0002",
  "name": "Your liquid name",
  "type": "raw_ingredient",
  "serving_unit": "ml",
  "default_serving_size": 200,
  "macros_per_100ml": {
    "calories": 0,
    "protein": 0,
    "carbs": 0,
    "fat": 0,
    "fiber": 0
  },
  "tags": ["liquid"],
  "category": "Dairy",
  "data_source": "Verified source",
  "data_quality": "source-reported",
  "nutrient_fields_available": ["calories", "protein", "carbs", "fat"],
  "fiber_data_available": false
}
```

Again, replace placeholder nutrients. If fibre is **unknown**, do not enter `fiber: 0` as though it were a measured zero. Omit the `fiber` key, omit `fiber` from `nutrient_fields_available`, and set `fiber_data_available` to `false`. The app will signal that fibre data is missing. If fibre truly is zero, include `"fiber": 0` and mark it available.

### Cooked food / portion estimate

For `standard_estimate`, `macros_per_serving` means the nutrients in the amount indicated by `default_serving_size` and `serving_unit`. In the example below, 195 kcal is for 150 g; logging 75 g scales it to half.

```json
{
  "id": "food_custom_0003",
  "name": "Your cooked food name",
  "type": "standard_estimate",
  "serving_unit": "g",
  "default_serving_size": 150,
  "macros_per_serving": {
    "calories": 0,
    "protein": 0,
    "carbs": 0,
    "fat": 0,
    "fiber": 0
  },
  "tags": ["cooked", "estimate"],
  "category": "Grains & Cereals",
  "data_source": "Verified recipe calculation or source",
  "data_quality": "calculated estimate",
  "nutrient_fields_available": ["calories", "protein", "carbs", "fat"],
  "fiber_data_available": false
}
```

For one chapati or one bowl you could use `serving_unit: "piece"` or `"bowl"`, `default_serving_size: 1`, and put the nutrition for one piece/bowl in `macros_per_serving`.

## 2. Required fields and rules

| Field | Rule |
|---|---|
| `id` | Required unique string. Keep it stable after you start using the item. Avoid IDs already in the current catalogue. |
| `name` | Required display name. Include state/preparation where useful, e.g. `Lentils (Dry)` vs `Lentils (Cooked)`. |
| `type` | `raw_ingredient` or `standard_estimate` in the master `foods.json`. |
| `serving_unit` | `g` for solid raw ingredients, `ml` for liquid ingredients, or a unit such as `piece`, `bowl`, `glass`, `slice` for portion estimates. |
| `default_serving_size` | Positive number; the default amount the food picker preselects. For `g`/`ml`, usually 100–250. For `piece`/`bowl`, usually 1. |
| Nutrition basis | Choose **one**: `macros_per_100g`, `macros_per_100ml`, or `macros_per_serving`. Do not include multiple bases in one record. |
| `calories`, `protein`, `carbs`, `fat` | Put verified numeric values in the chosen nutrition basis. Units are kcal and grams. |
| `fiber` | Optional if genuinely unavailable. See the fibre note above. |
| `tags` | Array of searchable keywords, e.g. `["vegetarian", "high-protein", "breakfast"]`. Include important search terms here. |
| `category` | Required. This is the category the current UI uses for filtering, e.g. `Fruits`, `Vegetables`, `Dairy`, `Grains & Cereals`, `Pulses & Legumes`, `Nuts & Seeds`, `Oils & Fats`, `Beverages`, `Snacks`, `Other/Mixed`. You can introduce your own values. |
| `subcategory` | Optional extra metadata. The current app does not yet use this field for separate subcategory filtering. To make the term searchable now, also put it in `tags`. |
| `data_source` | Strongly recommended: source/database name, product label, or a calculation source. |
| `data_quality` | Strongly recommended: e.g. `manufacturer label`, `source-reported`, `calculated from ingredients`, `estimate`, `needs verification`. |
| `nutrient_fields_available` | Recommended list of nutrients with real known values; do not list unknown nutrients. |
| `fiber_data_available` | Set `false` when fibre is missing, `true` when known (including a true zero). |
| `image_url` | Optional URL for the food image. If omitted or unavailable, the UI uses its fallback graphic/emoji. |
| `brand`, `barcode`, `product_quantity` | Optional metadata, mainly useful for packaged products. |

The app has a special `scoop` handling for raw ingredients using `macros_per_100g`: in that case set `default_serving_size` to the grams per scoop (e.g. 30) and the picker quantity is one scoop. For most ingredients, using grams is simpler.

## 3. Recipe data

The in-app recipe creator saves recipes into the user's `customFoods` state (and may sync them through Supabase). The same runtime recipe record shape can also be included as an item inside the master `foods.json` array for a preloaded recipe database. Use `type: "custom_recipe"` and keep `macros_per_serving` as nutrition for **one serving**. The `Forma_recipe_record_example.json` shows the object shape:

- `type: "custom_recipe"`
- `serving_unit: "serving"`, `default_serving_size: 1`
- `macros_per_serving`: nutrition for one finished serving
- `yield`: number of servings the full recipe makes
- `recipe_ingredients`: each component has `food_id`, `name`, `amount`, `unit`, and `macros` (the macros for that ingredient quantity)
- `created_at` and `updated_at`: ISO date-time strings

The app does **not** import a standalone `recipes.json` file. For preloaded recipes, include recipe records directly in the top-level `foods.json` array; they will appear in the Recipes filter and can be logged. The ingredient breakdown is preserved as metadata, but preloaded recipes are not automatically converted into the user-owned recipe-editor state. User-created recipes continue to be editable through the current recipe creator.

## 4. Do not lose the existing catalogue

The running app's master-data loader replaces the cached `foods` store with the contents of `foods.json` when it fetches that file. Therefore:

- `Forma_foods_template.json` is a template/example file, **not a replacement for the complete production `foods.json`**.
- When you upload your edited file back here, tell me whether it is a **full replacement catalogue** or **new/updated records to merge**. For most updates, use the additions-only format; I can merge new IDs, update matching IDs, validate duplicate names and nutrient bases, and retain the rest of the 1,174-record library. Do not replace production `foods.json` with the small example template.
- Remove or rename all `example_...` records and replace all example/zero-placeholder values before using the data in production.
- Save the file as UTF-8 JSON, with double quotes, no comments, no trailing commas, and a top-level `[` ... `]` array.

## 5. Files in this pack

- `Forma_foods_template.json` — valid JSON array with example records for a solid ingredient, liquid ingredient, cooked estimate and recipe. All example records are marked as examples; verify/replace their values before use.
- `Forma_foods_additions_blank.json` — empty top-level array to start an additions-only file; paste your new/updated record objects inside the array. This is not a replacement for the production catalogue.
- `Forma_foods_JSON_schema.json` — JSON Schema validation rules for the master food catalogue.
- `Forma_recipe_record_example.json` — one runtime recipe object example, separate from the master array.
- `Forma_recipe_record_schema.json` — JSON Schema for that runtime recipe object.

**Nutrition note:** sample numbers are included solely to make the schema concrete. They must be replaced/verified against your intended source; this pack is a data-format template, not a nutrition reference.
