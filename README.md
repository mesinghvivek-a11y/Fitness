# Forma — offline-first fitness, nutrition and hydration PWA

Forma is a lightweight mobile-first Progressive Web App for meal logging, recipe macro calculation, progressive-overload workouts, hydration events, and date-range dashboard analytics. The current version uses plain HTML/CSS/JavaScript instead of a React/Next.js build, so it can be hosted as static files while the core experience is validated.

## Run locally

Serve this directory over HTTP (do not open `index.html` directly via `file://`):

```bash
python -m http.server 8000
```

Open `http://localhost:8000`. For phone tests on your LAN, use your computer's local IP. PWA service workers require HTTPS except on localhost. GitHub Pages, Cloudflare Pages, and Netlify can host this static app.

## What's included

- `index.html`, `styles.css`, `app.js` — app shell, responsive UI, app logic and analytics.
- `foods.json` — 227 seeded food, liquid ingredient and cooked-meal entries.
- `exercises.json` — 147 seeded strength, cardio, bodyweight, conditioning, core and mobility movements.
- `supabase-config.js` — public project URL and publishable-key placeholders.
- `supabase-schema.sql` — Supabase user profile, daily log and custom-food tables plus owner-only RLS policies.
- `manifest.json`, `icon.svg`, `sw.js` — PWA install metadata, icon and offline shell cache.

The seeded catalogues are intentionally useful starter libraries, not a complete or medically authoritative nutrition database. Cooked meal entries and several macros are estimates. Check serving size and nutrition values for your own food brands and recipes before relying on precision.

## User experience

- **Dashboard:** Daily / Weekly / Monthly toggle, left/right period navigation, target history for net calories, protein and water, calorie/macro analytics, meal distribution, workout stats and hydration trends. The monthly bar views group days into week-sized buckets to fit a phone screen.
- **Timeline:** Keeps the horizontal date strip/calendar and meal-grouped timeline. The target-history card is not shown here.
- **Food:** Search-first picker with three recently used items when the search is empty; per-entry macros are snapshots, so editing does not mutate the master catalogue.
- **Recipes:** Open the global plus button while Diet is selected to access recipe creation. Ingredient rows use search and support grams/kilograms and millilitres/litres when the selected ingredient has those units.
- **Workout:** Search-first exercise picker, recent movements, progressive-overload set planning, inline weight/reps, a rest timer, and a session-end MET-based calorie estimate. Supersets and circuits are not implemented in V1.
- **Water:** One-tap amounts and custom amounts; every water event in the visible/expanded list can be edited or deleted.
- **Local-first operation:** Master JSON is refreshed on startup when online and cached in IndexedDB; the app falls back to cache when offline. Daily logs and recipes remain local in IndexedDB with a localStorage fallback.

## Supabase setup

1. Create a Supabase project.
2. In the Supabase Dashboard, open the project’s Connect or API Keys area. Copy the **Project URL** and the **publishable key** (usually `sb_publishable_...`) into `supabase-config.js`:

   ```js
   window.FORMA_SUPABASE_CONFIG = {
     url: 'https://YOUR_PROJECT_REF.supabase.co',
     publishableKey: 'sb_publishable_YOUR_KEY'
   };
   ```

3. In the Supabase SQL Editor, run all of `supabase-schema.sql`.
4. Configure Authentication → URL Configuration so your deployed site is an allowed site/redirect URL. Decide whether new accounts require email confirmation, and test the confirmation link on your real domain.
5. Deploy the app with HTTPS, create an account in Settings, sign in, and tap **Sync now** once. That first sync deliberately associates this browser's current local logs/profile/recipes with the signed-in account. Verify data in Supabase before using multiple accounts on one device.
6. After the first successful sync, unsynced date logs, profile changes and custom recipes batch-sync roughly every two minutes, and a finished workout triggers a sync. A failed request keeps local edits and dirty markers so the user can retry.

**Never put a Supabase secret key or legacy `service_role` key in this static app.** The browser uses only the publishable key; table access is granted through authenticated RLS policies that restrict each row to `auth.uid()`. Public API keys are not user authentication—the app still requires a user session.

## Data and sync model

- `daily_logs` uses `(user_id, date)` as a primary key and stores a date's full timeline payload as JSONB. Re-uploading the same date performs an upsert rather than creating duplicates.
- `user_profiles` stores each user's targets and body weight. `user_custom_foods` stores user-owned recipe JSON.
- Local logs are marked dirty in state and only sent in batch. No network write is triggered for each set checkbox or each glass of water.
- Master catalogues stay as static JSON and in IndexedDB. They do not consume per-search cloud database reads.
- The cloud adapter uses last-updated timestamps as a lightweight merge heuristic. This is adequate for a single-user prototype, but it is not a full conflict-resolution system for simultaneous edits on multiple devices. A production release should add explicit sync versions/conflict UI, account data separation on shared devices, account deletion workflows, observability, and automated multi-device tests.

## Audit notes and known limitations

- This is not yet migrated to React/Next.js. That migration is optional for the present static deployment, but should happen if code splitting, server routes, type safety, or a larger component ecosystem becomes important.
- Data values and cooked estimates need source-based validation before release. The bundled master list is 227 foods and 147 exercises—not thousands—and should expand through a versioned import pipeline with provenance and licensing checks.
- Workout MET burn is an estimate. Formula used at session finish: mean MET across relevant logged movements × body weight × elapsed hours. The actual energy expenditure can differ materially.
- The chart provides a strength snapshot from the highest logged working weight per exercise, not a validated 1RM calculation. Duration-only movements currently share the general set/reps UI and need a dedicated duration/distance editor before calling the app training-complete.
- Automated end-to-end tests across iOS Safari/Android Chrome, authentication redirect flows, offline startup, IndexedDB eviction/recovery, cross-device conflicts and SQL policy isolation are still required before a production claim.

## Recommended pre-launch checks

1. Test each Supabase RLS policy using two separate accounts and verify one account cannot read or update the other’s rows.
2. Test first-sync behavior on a clean browser, an existing local dataset, and a second account; avoid syncing private local history to the wrong account.
3. Validate the highest-use macro values against trusted nutrition sources and include data source, version and last-reviewed metadata.
4. Add automated tests for grams/kg/ml/L math, recipe yield division, date/month boundaries, Eat-Back calculations, workout duration and sync conflict handling.
5. Add data export/import recovery and an account deletion flow before production use.
