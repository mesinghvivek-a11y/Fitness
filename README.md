# Forma — local-first fitness, food & water PWA

A runnable mobile-first prototype implementing the core Forma flow: diet, workout, hydration, date-scoped daily logs, targets, local search, recipe creation, workout setup/progressive overload, inline set completion/rest timer, and domain-specific analytics.

## Run it

The app uses `fetch()` for the first master-data load and a service worker for offline caching, so serve the folder over localhost rather than opening `index.html` directly as a `file://` URL.

```bash
cd stride-pwa
python -m http.server 8000
```

Open `http://localhost:8000` on desktop or on a phone connected to the same network. For phone testing, use your computer's LAN IP, and remember that service workers generally require HTTPS except on localhost. You can deploy this static folder to any HTTPS static host (for example, GitHub Pages, Cloudflare Pages, or Netlify).

## Included

- `index.html` — app shell and sticky navigation.
- `styles.css` — mobile-first UI and responsive layouts.
- `app.js` — local data model, UI, domain logic, recipe builder, exercise progression, timer, analytics, and export.
- `foods.json` — starter food master data (raw ingredients explicitly separate from cooked estimates).
- `exercises.json` — starter movement master data.
- `manifest.json`, `icon.svg`, `sw.js` — install metadata, app icon and offline shell cache.

## Storage architecture

- On first load, `foods.json` and `exercises.json` are fetched and copied into IndexedDB (`foods` and `exercises` object stores). Search is performed in-browser over those cached arrays; the current prototype uses a lightweight fuzzy-style ranker without an external search dependency.
- Daily logs, targets and custom recipes are persisted to IndexedDB (`kv` store), with a `localStorage` fallback. Logging a set or glass of water never calls a backend.
- Food log entries are snapshots with their own `entry_id`, amount and macro values. Editing an entry never mutates `foods.json` / the master IndexedDB row.
- The custom recipe builder calculates total ingredient macros and divides them by the configured yield.
- Session burn is estimated once at session finish using the specified prototype formula: mean MET of exercises represented in the session × profile body weight × elapsed hours. MET estimates and the use of a mean MET are inherently approximate.
- Export from **Settings → Export my data (JSON)** produces a date-scoped export with daily totals, diet entries, workout logs/history, water events and custom foods.

## Backend connection (not configured yet)

This bundle does **not** claim to sync to Firebase or Supabase. No project URL, keys, authentication setup, security rules or schema migration were supplied. The local storage/export path is functional now; a production integration should add a small `sync adapter` at the boundary where a completed day/session is serialized, not issue writes for every set completion or water tap.

A production adapter should:

1. Authenticate the user and derive `user_id` from the auth session (never from a client-editable field).
2. Upload the current day's normalized payload on an explicit save/finish action or a controlled debounced checkpoint.
3. Use per-user database rules and a date-scoped key such as `(user_id, date)` so a device cannot read or overwrite another user's logs.
4. Resolve conflicts with `updated_at` / `sync_version`, and retain local unsynced edits when a request fails.
5. Move user profiles, user custom foods/recipes and daily logs to backend tables/collections; keep master foods/exercises as versioned static assets or downloadable versioned data.

## Data model notes

- The UI currently supports one active workout session per date plus completed sessions in `workout_history`; this avoids overwriting a prior finished session and makes analytics possible. A cloud adapter can normalize that to the supplied `workout_log` model or a session collection.
- This is a functional starter rather than a medical-grade nutrition database. The bundled food list is intentionally a seed set, not thousands of foods. Expand the JSON seed set and bump the master-data version when distributing updates.
- Progressive overload generates planned starting rows. Before a set is checked complete, users can edit weight/reps. Supersets and circuits are deliberately not implemented in V1.

## Suggested next engineering milestones

1. Add auth plus Firebase/Supabase batch sync, conflict handling and account deletion/export controls.
2. Add an audited, versioned master food library and import flow (CSV/JSON) instead of treating estimated cooked values as authoritative.
3. Add automated tests for macro math, serving units, date boundaries/time zones, set progression, session duration and eat-back calculations.
4. Add accessibility and offline QA on iOS Safari and Android Chrome, including PWA installation and recovery after storage eviction.
