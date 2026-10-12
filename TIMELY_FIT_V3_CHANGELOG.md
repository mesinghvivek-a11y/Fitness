# Timely Fit v3 — Interaction Update

## Requested changes

1. **Edit exercises and sets:** Active workout exercises expose Edit, and completed-history rows now also expose Edit. The shared editor supports changing saved weight/repetition details, adding/removing sets, editing rest seconds, and deleting an exercise from the selected log. Existing session history remains stored in the selected date's `workout_history` record.
2. **AMOLED dark mode:** The page canvas, app shell, header, date strip and safe-area background are pure `#000000`; cards and controls are near-black with lime accents. The browser theme-color changes to black while dark mode is enabled.
3. **Swipe navigation:** Horizontal touch swipes on the main content switch Diet → Workout → Hydration and back. Form fields and inner result/filter scrollers are excluded. The app's one shared `activeDate` stays unchanged while switching domains.
4. **Vertical number wheels:** Food amounts, recipe ingredient amounts/yield, exercise setup sets/reps/weight/progression, and exercise-edit set values use vertical scroll wheels. The underlying numeric inputs remain the values used by existing save and calculation logic. Keyboard up/down and page-up/page-down are supported while a wheel is focused.

## Validation

- `node --check app.js` — passed
- `node tests/catalogue-check.js` — passed
- `node tests/catalog-audit.mjs` — passed
- `node tests/picker-refresh-check.mjs` — passed
- `node tests/timely-fit-ui-check.mjs` — passed
- `python tests/verify-food-import.py` — passed
- PostCSS CSS parse — passed
- Service-worker shell asset existence checks — passed

An interactive headless-browser smoke test could not be completed because Chromium stalled in this environment. Please verify swiping and roller feel on the target phone/tablet. Camera scanning still depends on browser support and camera permissions.

## Deploy notes

The service-worker cache name is bumped to `timely-fit-shell-v5-amoled-number-wheel-swipe-edit-history` so deployed clients refresh old UI assets. The app remains the existing static HTML/CSS/JavaScript PWA; no framework migration is introduced.
