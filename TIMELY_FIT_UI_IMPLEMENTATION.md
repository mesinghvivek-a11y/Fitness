# Timely Fit UI implementation notes

## Architecture

This repository is a static PWA using plain HTML, CSS and JavaScript. The requested changes are implemented in the existing app rather than introducing a React/Next.js framework, preserving IndexedDB (`forma_local_v1`), the existing daily-log JSON shape, and Supabase table compatibility.

## Main code touchpoints

| Concern | Existing app entry points | State / persistence
|---|---|---|
| Brand and global navigation | `index.html`, `manifest.json` | User-facing app name is Timely Fit; internal storage IDs remain compatible. |
| Cross-tab date selection | `render()`, `renderDates()`, `currentLog()`, `state.activeDate` | Domain/tab changes render against the same active date; choosing a date persists the app state. |
| Dark mode | `openSettings()`, `applyTheme()`, `state.preferences.darkMode`, CSS `theme-dark` rules | Preference is persisted in `app_state`; theme affects the document, dialogs and PWA theme color. |
| Food search and universal Add | `openFoodModal()`, `renderFoodResults()`, `scheduleOnlineFoodSearch()`, `renderUniversalAddModal()` | Ingredients/Recipes are local filters. Open Food Facts search runs independently of the local filter state. The recipe creator validates two or more ingredients. |
| Exercise selector | `openWorkoutModal()`, `renderExerciseFilters()`, `renderExerciseResults()` | Reuses the existing exercise catalogue and current body-part/equipment pill sets; no separate exercise-creation flow. |
| Live session clock and rest timer | `renderWorkout()`, `renderExerciseCard()`, `startRestTicker()`, `formatDurationHMS()` | Clocks update labels once per second without rerendering active inputs. Rest periods are stored as an absolute `rest_until` timestamp and can be adjusted by ±30 seconds. |
| Persistent completed workouts | `finishSession()`, `renderWorkout()` | The full completed session is appended to `workout_history` and remains visible alongside any new active session on the same date. Exercise snapshot metadata retains media references and the set-level record. |
| Background sync | `scheduleSave()`, `scheduleAutoSync()`, `syncNow({ quiet: true })` | Save locally first, debounce cloud uploads after the account has completed its initial pull, then retry pending changes periodically. |

## State conventions

- Use `state.activeDate` as the single date across Diet, Workout, Hydration and dashboard/date navigation. Do not introduce per-tab selected dates.
- Keep persisted workout history inside `state.logs[date].workout_history`. Each session retains `start_ms`, `end_ms`, `duration_minutes`, session metadata, exercise snapshots and set rows.
- Keep local persistence as the source of immediate UI truth. `scheduleSave()` marks changes dirty, stores them locally, and queues cloud sync only for a connected authenticated account.
- Keep clocks out of the main render loop: update text nodes from timestamps so timer ticks do not reset scroll position, set inputs or touch interaction.
- Keep missing nutrition/media metadata missing. A fallback icon may be displayed if an exercise's image/GIF file is not present; a visual placeholder is not a claim that source media exists.

## Key responsive styling

The design tokens and responsive rules live in `styles.css`. It includes a global dark palette, an outlined Today pill, touch-friendly stepper targets, scrollable existing exercise filters, and completed-session rows with a separate far-right completion mark.

## Run and validate

```bash
python -m http.server 8000
```

Open `http://localhost:8000`. Run source and data checks with:

```bash
node --check app.js
node tests/catalog-audit.mjs
node tests/catalogue-check.js
node tests/picker-refresh-check.mjs
node tests/timely-fit-ui-check.mjs
python tests/verify-food-import.py
```

Supabase cloud sync needs the project's URL and publishable key in the existing `supabase-config.js` template and its schema applied. Without credentials the app remains local-only. Browser-based mobile-camera and visual interaction tests must still be performed on an HTTPS deployment/device; syntax and static-data tests do not establish that every real-device interaction has been verified.


## Update: AMOLED theme, swipe navigation, number rollers and history editing
- Dark mode uses a pure `#000000` canvas and app shell for AMOLED displays, with restrained near-black cards, dark controls and lime accents. The browser theme-color meta tag also switches to black.
- Horizontal touch swipes within the main timeline navigate Diet → Workout → Hydration. Inputs and nested result/filter scrollers are excluded to reduce accidental navigation; the selected date remains shared state.
- Numeric quantity/serving and workout setup controls use touch-friendly vertical scroll wheels. Their underlying numeric inputs remain the source of truth and emit normal input/change events.
- Active exercises can be edited and sets added or removed. Completed-history rows also include Edit, opening the same editor against that saved session. Edit actions update the existing log and schedule local persistence/background sync.
- Service worker cache name was bumped to avoid stale UI assets.
