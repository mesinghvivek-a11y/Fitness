# Timely Fit — offline-first fitness, nutrition and hydration PWA

Timely Fit is a lightweight mobile-first Progressive Web App for meal logging, recipe macro calculation, progressive-overload workouts, hydration events, and date-range dashboard analytics. The current version uses plain HTML/CSS/JavaScript instead of a React/Next.js build, so it can be hosted as static files while the core experience is validated.

## Run locally

Serve this directory over HTTP (do not open `index.html` directly via `file://`):

```bash
python -m http.server 8000
```

Open `http://localhost:8000`. For phone tests on your LAN, use your computer's local IP. PWA service workers require HTTPS except on localhost. GitHub Pages, Cloudflare Pages, and Netlify can host this static app.

## What's included

- `index.html`, `styles.css`, `app.js` — app shell, responsive UI, app logic and analytics.
- `foods.json` — 227 seeded food, liquid ingredient and cooked-meal entries.
- `exercises.json` — 1,443 searchable movements: the 1,324-record upstream metadata dataset merged with Timely Fit-only entries, rectified in v5.1. Each record has a short description, a consolidated `body_part` (16 groups, e.g. Core & Abs, Biceps, Glutes), a consolidated `equipment` (11 groups, e.g. Cable Machine, Plate-Loaded & Pin Machines), target muscles, `muscle_map_slugs` (the body-model regions to highlight), rest defaults and tracking metrics.
- `supabase-config.js` — public project URL and publishable-key placeholders.
- `supabase-schema.sql` — Supabase user profile, daily log and custom-food tables plus owner-only RLS policies.
- `manifest.json`, `icon.svg`, `sw.js` — PWA install metadata, icon and offline shell cache.

The seeded catalogues are intentionally useful starter libraries, not a complete or medically authoritative nutrition database. Cooked meal entries and several macros are estimates. Check serving size and nutrition values for your own food brands and recipes before relying on precision.

## User experience

- **Dashboard:** Daily / Weekly / Monthly toggle, left/right period navigation, target history for net calories, protein and water, calorie/macro analytics, meal distribution, workout stats and hydration trends. The monthly bar views group days into week-sized buckets to fit a phone screen.
- **Timeline:** Keeps the horizontal date strip/calendar and meal-grouped timeline. The target-history card is not shown here.
- **Food:** Search-first picker with three recently used items when the search is empty; per-entry macros are snapshots, so editing does not mutate the master catalogue.
- **Recipes:** Open the global plus button while Diet is selected to access recipe creation. Ingredient rows use search and support grams/kilograms and millilitres/litres when the selected ingredient has those units.
- **Workout:** Search-first exercise picker with up to three recent movements, compact media thumbnails, a demonstration/details modal, progressive-overload set planning, inline weight/reps, a rest timer, and a session-end calorie estimate when MET values are available. Supersets and circuits are not implemented in V1. Exercise detail descriptions are intentionally brief.
- **Water:** One-tap amounts and custom amounts; every water event in the visible/expanded list can be edited or deleted.
- **Local-first operation:** Master JSON is refreshed on startup when online and cached in IndexedDB; the app falls back to cache when offline. Daily logs and recipes remain local in IndexedDB with a localStorage fallback.

## Authentication-first entry

- The main app is hidden by default. A visitor must have a Supabase Auth session to view the timeline or dashboard.
- The sign-in screen supports email/password, account creation, password-reset email, and Google OAuth.
- Because the prototype is hosted as static files, HTML/JS assets themselves remain publicly downloadable. The sign-in gate protects the UI flow, while Supabase Row Level Security protects user rows; do not rely on hiding browser code as a security boundary.
- Returning users can still use their locally cached timeline while offline if their browser has a persisted session; cloud refresh naturally waits until connectivity returns.

## Supabase setup and Google authentication

### 1. Configure the browser client

1. Create a Supabase project.
2. In the Supabase Dashboard, open **Connect** or **Settings → API Keys** and copy the **Project URL** and the **publishable key** (typically `sb_publishable_...`).
3. Paste those two public values into `supabase-config.js`:

   ```js
   window.FORMA_SUPABASE_CONFIG = {
     url: 'https://YOUR_PROJECT_REF.supabase.co',
     publishableKey: 'sb_publishable_YOUR_KEY'
   };
   ```

   The publishable key is expected to be visible in browser code. Supabase Auth identifies the signed-in user, and Row Level Security (RLS) restricts what that user can read and write.

4. In **SQL Editor**, run the whole `supabase-schema.sql` once. It creates `user_profiles`, `daily_logs` and `user_custom_foods`, owner-only RLS policies, and database-clock `updated_at` triggers.
5. In **Authentication → URL Configuration**, set the Site URL to the deployed app URL. Add the exact local and production app URLs to Additional Redirect URLs, for example `http://localhost:8000/**` and `https://YOUR_ACCOUNT.github.io/YOUR_REPO/**` (replace with your actual URLs). The Google button redirects back to the current app path, so that path must be allowed.

### 2. Enable Google sign-in

1. Open [Google Cloud Console](https://console.cloud.google.com/), choose or create a project, and open **Google Auth Platform**. Complete the app name, support email, audience, and consent-screen branding. For basic sign-in Timely Fit requests the standard identity/email/profile scopes; do not add extra scopes it does not need.
2. Open **Clients → Create client → OAuth client ID → Web application**.
3. Add your hosted app's origin under **Authorized JavaScript origins**, such as `https://YOUR_ACCOUNT.github.io`. For local testing, add `http://localhost:8000` (and remove or keep it restricted when finished).
4. Under **Authorized redirect URIs**, add the callback URL shown on Supabase's **Authentication → Sign In / Providers → Google** page. It typically resembles `https://YOUR_PROJECT_REF.supabase.co/auth/v1/callback`; use the exact URL supplied by Supabase.
5. Create the OAuth client and copy the Google **Client ID** and **Client Secret** into the Supabase Google provider settings. Enable Google and save.
6. Return to Timely Fit and test **Continue with Google**. Also test the OAuth redirect on your deployed HTTPS URL, not only localhost.

**Security distinction:** there are two different credential types here. The Supabase Project URL + publishable key belong in `supabase-config.js`. The Google OAuth Client Secret belongs in the Supabase dashboard's Google provider configuration only. Do not put that Google Client Secret, a Supabase `sb_secret_...` key, or a legacy `service_role` key in this repository, browser JavaScript, HTML, or GitHub Pages. This static browser app does not need a Supabase secret key.

Email/password accounts can be enabled in **Authentication → Sign In / Providers → Email**. If email confirmation is enabled, users must confirm from email before they can sign in. Configure the redirect/confirmation URLs and verify email delivery before launch.

## Low-cost database architecture

Timely Fit is local-first by design:

- **Search requests: zero Supabase database reads.** `foods.json` and `exercises.json` are fetched and cached in IndexedDB. Typing `D`, `DE`, `DEA`, `DEAD` or `PA`, `PAN`, `PANEER` searches local data only; no query is sent for each keypress.
- **Timeline, dates and charts: local reads.** Switching dates, ticking a set, correcting a water amount, or editing a food entry updates the local state and IndexedDB, not a cloud query.
- **One compact cloud record per user/day.** Food entries, workout sessions and water events are stored together in one `daily_logs` JSONB payload per date. Derived daily macro totals are calculated in the app; the master food/exercise catalogues are never copied into Supabase.
- **Small auxiliary tables.** A row stores targets/profile, and custom recipes are stored only when the user creates them.
- **Batched writes only.** After the first explicit successful Sync now, dirty dates, changed recipes and changed profile data batch-sync every five minutes while pending. Finishing a workout requests a sync. Individual set completions and water taps never trigger their own writes. Errors leave edits local for retry.
- **Incremental cloud reads.** The first load for an account fetches the account's saved timeline (paginated in 500-row chunks). Later loads request only daily-log rows whose `updated_at` is newer than the local pull cursor. The profile is one small row and the custom-recipe table is fetched as a small list; no query runs during live search.

Supabase Free does **not** charge a direct fee for each SQL read/write operation in the way a per-document-read database product might. The important limits are storage, egress/network data, monthly active users, and shared database resources. Current published Free allowances include 500 MB database size per project, 5 GB egress, 1 GB file storage and 50,000 monthly active users. Free projects can pause after a period of low activity. Check the live [Supabase billing limits](https://supabase.com/docs/guides/platform/billing-on-supabase) before launch because quotas and plan terms can change.

No architecture can guarantee that usage will stay inside the Free tier under every possible amount of traffic. This design minimizes predictable usage, but monitor the project **Usage** dashboard—especially database size and egress—and avoid turning on Realtime for timeline tables unless it is actually needed. On a personal or small beta app, local searching plus one daily row per date should keep database traffic modest. A large public user base can still exceed Free storage/egress quotas even without per-search requests.

## Data and sync model

- `daily_logs` uses `(user_id, date)` as a primary key and stores a date's full timeline payload as JSONB. Re-uploading the same date performs an upsert rather than creating duplicates.
- `user_profiles` stores each user's targets and body weight. `user_custom_foods` stores user-owned recipe JSON.
- Local logs are marked dirty in state and only sent in batch. No network write is triggered for each set checkbox or each glass of water.
- Master catalogues stay as static JSON and in IndexedDB. They do not consume per-search cloud database reads.
- The cloud adapter uses last-updated timestamps as a lightweight merge heuristic. This is adequate for a single-user prototype, but it is not a full conflict-resolution system for simultaneous edits on multiple devices. A production release should add explicit sync versions/conflict UI, account data separation on shared devices, account deletion workflows, observability, and automated multi-device tests.

## Audit notes and known limitations

- This is not yet migrated to React/Next.js. That migration is optional for the present static deployment, but should happen if code splitting, server routes, type safety, or a larger component ecosystem becomes important.
- Food values and cooked estimates need source-based validation before release. The bundled master list contains 227 foods and 1,443 exercise entries (including 1,324 imported source records before exact-name reconciliation). Many imported exercises do not have an authoritative MET value; the app keeps these as null rather than inventing calorie factors.
- Workout MET burn is an estimate. Formula used at session finish: mean MET across relevant logged movements × body weight × elapsed hours. The actual energy expenditure can differ materially.
- The chart provides a strength snapshot from the highest logged working weight per exercise, not a validated 1RM calculation. Duration-only movements currently share the general set/reps UI and need a dedicated duration/distance editor before calling the app training-complete.
- Automated end-to-end tests across iOS Safari/Android Chrome, authentication redirect flows, offline startup, IndexedDB eviction/recovery, cross-device conflicts and SQL policy isolation are still required before a production claim.

## Recommended pre-launch checks

1. Test each Supabase RLS policy using two separate accounts and verify one account cannot read or update the other’s rows.
2. Test first-sync behavior on a clean browser, an existing local dataset, and a second account; avoid syncing private local history to the wrong account.
3. Validate the highest-use macro values against trusted nutrition sources and include data source, version and last-reviewed metadata.
4. Add automated tests for grams/kg/ml/L math, recipe yield division, date/month boundaries, Eat-Back calculations, workout duration and sync conflict handling.
5. Add data export/import recovery and an account deletion flow before production use.


## Expanded exercise catalogue and demonstration media

- The exercise metadata was imported from [hasaneyldrm/exercises-dataset](https://github.com/hasaneyldrm/exercises-dataset). Upstream data includes exercise name, body part/category, equipment, target/synergist muscles and multilingual instruction text. Timely Fit keeps one concise English sentence in `description`; it does not expose the long step-by-step text in its exercise card.
- The import preserves upstream IDs in `source_id`. Exact-name matches keep Timely Fit's earlier IDs to avoid breaking existing workout references. New IDs use the `ed_` prefix. `source_dataset`, `source_id`, source category, media paths and attribution remain available for provenance.
- `image` and `gif_url` are preconfigured to relative paths under `exercise-media/`. **The GIF and thumbnail files are intentionally not included in this bundle.** The upstream repository's MIT licence covers its metadata/instruction text, but explicitly excludes Gym Visual media. Before using those image/GIF assets publicly, obtain the applicable media permission/licence. Once licensed files have been placed at the matching paths, set the corresponding record's `media_status` to `licensed`; the thumbnail and animated detail modal will load them. Until then, Timely Fit shows a placeholder and concise exercise details.
- Imported exercises have `met_value: null` unless an exact-name match already had a known Timely Fit value. Session calorie calculations ignore missing MET values rather than fabricating precision. A future data-review phase can populate METs from a trusted activity reference.
- `EXERCISE-DATA-LICENSE.md` records the metadata licence and media caveat. Retain this file when redistributing the exercise catalogue.

## V3 notes

- **Search:** exercise search matches the name first, then exercises that train the searched muscle (for example "chest" also lists pec work without "chest" in its name), then exercises that use it as a secondary muscle. Food search matches every word in any order.
- **Exercise fields:** each exercise decides which fields it needs. Weighted exercises ask for sets, reps and kg. Body-weight exercises ask for sets and reps. Timed and cardio exercises ask for sets and minutes.
- **Food images:** add an `"image"` path to any item in `foods.json` (for example `"image": "food-media/images/paneer.jpg"`). It then shows in the food list, the picker and the timeline. Items without an image keep their icon.

## V4 design notes

- **Themes:** the app follows the phone's light or dark setting automatically. All colours are CSS variables at the top of `styles.css` (`:root` for light, the `prefers-color-scheme: dark` block for dark).
- **Domain colours:** Diet is green, Workout is violet and Water is blue. The accent changes with the selected tab, with no script involved.
- **Icons:** all interface icons are one SVG sprite at the top of `index.html`. Food and exercise pictures still use their emoji until an image file is linked.
- **Type scale:** 12 / 14 / 16 / 20 / 26 / 32 px. Inputs stay at 16px so iPhones never zoom into a field.

## V5 notes

- **Food rows:** one three-dot menu per row with Edit nutrition, Change meal and Delete (asks first).
- **Online food search:** in Add food, turn on "Search online" to search Open Food Facts. The scan button looks up a barcode, using the camera or a typed number. Nothing is sent to Open Food Facts unless the switch is on or you scan.
- **Sessions:** each session has a three-dot menu (edit, delete one exercise, delete the session, save as template). Finished sessions open and close when tapped, and close again when you change tab.
- **Templates:** saved inside your profile, so they sync with your account. Open them from the Workout tab or the Add exercise dialog.
- **Weights:** pick from 0 kg upward in 2.5 kg steps. New exercises start at 4 sets of 12 reps.
- **Settings:** the dark mode switch is at the top. Profile (name, height, weight, age) sits above the targets.
- **Targets by day:** each change of targets is stored with its start date. Earlier days keep the targets they had.


## v5.1 rectified exercise catalogue

- `body_part` and `equipment` were rectified from `master_exercises_final_audit.json` (843 body-part and 536 equipment values changed; names, IDs, targets, media paths and rest times are unchanged). Examples: Waist/Core → Core & Abs, Upper Arms → Biceps or Triceps, Leverage Machine/Machine/Assisted/Sled Machine → Plate-Loaded & Pin Machines, Cable → Cable Machine, Band → Resistance Band, Dumbbells → Dumbbell, EZ Barbell → Barbell.
- New `muscle_map_slugs` field lists the body-model regions (abs, chest, deltoids, upper-back, quadriceps, …) so a body-map picker can highlight and select muscles.
- All other fields (category, primary_muscle, description, MET, tracking metrics, media fields) are kept as they were, so saved workouts, search and analytics keep working.
- Medicine-ball exercises stay in weight mode even though they now sit under Functional Accessories.
- The service-worker cache is bumped to `timely-fit-shell-v5-1` so installed apps pick up the new catalogue.

## v5.2 exercise generator and muscle workload

- **Add exercise window:** the plus button and every "Add exercise" button now open the generator (`exercise-generator.js`). Tap muscles on the body model (front/back, swipe or toggle), pick equipment, choose how many exercises, and press Generate. Selected muscles glow; muscles trained in the last 48 hours are tinted red/amber (the 48-hour rule can be turned off in the ⋯ menu).
- **Generate transition:** the body model enlarges, rotates to the side holding the selected muscles, and is scanned for about three seconds (tap to skip), then the plan appears.
- **Plan:** 4 x 12 by default (timed exercises 1 x 10 min). Each row expands to adjust weight, sets and reps, lock, swap, favourite or hide. "Add to workout" puts the plan into the current session, where sets are logged as before. The old name search is still available from the ⋯ menu.
- **Weights and variety come from your real logs:** last weight is suggested again, +2.5 kg after a fully completed exercise, about +5% after "Easy", unchanged after "Hard", 5% lighter after an unfinished one, and a 10% deload after four increases in a row. Favourites and hidden exercises are stored in your profile (`genFav`, `genHide`) and sync with your account. Finished exercises in an active session show a How did it feel? row (`feel` on the exercise).
- **Dashboard:** Workout > Muscle workload shows the same body model coloured by sets per muscle for the selected period (light blue to green to amber to red). Tap a muscle for its sets; assisting muscles count half a set.
- **Files:** `body-model.js` (front/back muscle paths, MIT, see `BODY-MODEL-LICENSE.md`), `exercise-generator.js`, styles at the end of `styles.css`. Cache name `timely-fit-shell-v5-2`.

## v5.3 changes

- **Gender:** Settings > ⋯ (edit) > Gender (Male/Female) switches the body model everywhere (add-exercise picker and dashboard). Stored as `profile.gender`.
- **Settings profile:** height, weight, age and gender are shown once; the ⋯ button opens the edit fields.
- **Dashboard:** the period toggle and date range stay pinned under the Diet/Workout/Water tabs while the rest of the page scrolls.
- **Add exercise:** Pick/Plan switch is centred at the top; ✨ Auto cycles through the next-best group of rested muscles (Push, Pull, Legs, Core, Arms, Shoulders & back), putting muscles not yet trained this week first; the body model supports +/- zoom, pinch, drag and swipe so small muscles are easy to hit; a Progressive switch on the plan adds weight on every set (per-exercise "Add per set" in the expanded row); expanding a row shows weight, sets, reps and actions in tidy tiles, tapping the thumbnail previews the animation, and opening one row closes the others.
- **Timeline:** tapping an exercise row expands its sets and collapses any other open exercise (UI only, logged sets are kept).
- Cache name `timely-fit-shell-v5-3`.
