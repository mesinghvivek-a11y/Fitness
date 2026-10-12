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
- `foods.json` — 1,174 food, ingredient and meal records, including 947 unique imports from the supplied nutrition CSV.
- `exercises.json` — 1,443 searchable movements: the 1,324-record upstream metadata dataset merged with app-specific entries. Exercise metadata is kept lightweight with a short description, body part, target muscles, equipment, rest defaults and tracking metrics.
- `supabase-config.js` — public project URL and publishable-key placeholders.
- `supabase-schema.sql` — Supabase user profile, daily log and custom-food tables plus owner-only RLS policies.
- `manifest.json`, `icon.svg`, `sw.js` — PWA install metadata, icon and offline shell cache.

The catalogues are practical starting libraries, not complete or medically authoritative nutrition databases. The food CSV is source-reported and does not include fibre or recipe instructions. Existing cooked-meal entries and several macros are estimates. Check serving sizes and nutrition values for your own food brands and recipes before relying on precision.

## User experience

- **Dashboard:** Daily / Weekly / Monthly toggle, left/right period navigation, target history for net calories, protein and water, calorie/macro analytics, meal distribution, workout stats and hydration trends. The monthly bar views group days into week-sized buckets to fit a phone screen.
- **Timeline:** Keeps the horizontal date strip/calendar and meal-grouped timeline. The target-history card is not shown here.
- **Food:** Full-width search with Ingredients and Recipes filter pills; matching ingredients are grouped before recipes. The selected item expands to quantity, unit, meal and time. Compact actions let the user add a missing ingredient or create a recipe. Packaged-product results appear below barcode/QR scanning controls. Local search is immediate; Open Food Facts search is debounced and optional online.
- **Recipes:** Open the global plus button while Diet is selected to access recipe creation. Ingredient rows use search and support grams/kilograms and millilitres/litres when the selected ingredient has those units.
- **Workout:** Search-first exercise picker with horizontal body-part and equipment pill rows, compact media thumbnails, a demonstration/details modal, progressive-overload set planning, inline weight/reps, a rest timer, and a session-end calorie estimate when MET values are available. Supersets and circuits are not implemented in V1. Exercise detail descriptions are intentionally brief.
- **Hydration:** One-tap amounts and custom amounts; every water event in the visible/expanded list can be edited or deleted.
- **Local-first operation:** Master JSON is refreshed on startup when online and cached in IndexedDB; the app falls back to cache when offline. Daily logs and recipes remain local in IndexedDB with a localStorage fallback. The global settings menu supports a persistent dark theme. Authenticated edits are debounced into background sync batches; no manual sync button is required.


## Timely Fit interface and state updates

- App identity is Timely Fit; the hydration navigation label is used while the existing `water` domain/storage keys remain stable for backwards compatibility.
- The selected date lives in `state.activeDate`, is persisted with the app state, and is shared by Diet, Workout, Hydration and analytics navigation. Today has its own outlined pill style.
- Global settings contains the dark-mode toggle. Theme preference is stored in `state.preferences.darkMode` and applied to the whole application, modals and the PWA browser theme colour.
- `scheduleSave()` saves locally first and debounces background sync when an authenticated Supabase account has completed its initial pull. A periodic retry catches temporary connection failures. Without a configured Supabase URL and publishable key, the app remains local-first.
- Workout session and rest timers update their displayed clocks once per second without rerendering the form. Finishing a session moves the full workout object into `workout_history`; completed exercise rows render their set detail and image/fallback alongside the active-session UI.
- The implementation stays plain HTML, CSS and JavaScript to keep this PWA deployable as static files and compatible with existing IndexedDB (`forma_local_v1`) and Supabase payloads.

## Authentication-first entry

- The main app is hidden by default. With Supabase configured, a visitor must have an Auth session; without configuration, the welcome screen offers local-only access.
- The sign-in screen supports email/password, account creation, password-reset email, and Google OAuth.
- Because the prototype is hosted as static files, HTML/JS assets themselves remain publicly downloadable. The sign-in gate protects the UI flow, while Supabase Row Level Security protects user rows; do not rely on hiding browser code as a security boundary.
- Local-only mode keeps entries on this browser/device and never syncs them. Signed-in users can also use locally cached entries offline; cloud refresh waits until connectivity returns.

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

1. Open [Google Cloud Console](https://console.cloud.google.com/), choose or create a project, and open **Google Auth Platform**. Complete the app name, support email, audience, and consent-screen branding. For basic sign-in Forma requests the standard identity/email/profile scopes; do not add extra scopes it does not need.
2. Open **Clients → Create client → OAuth client ID → Web application**.
3. Add your hosted app's origin under **Authorized JavaScript origins**, such as `https://YOUR_ACCOUNT.github.io`. For local testing, add `http://localhost:8000` (and remove or keep it restricted when finished).
4. Under **Authorized redirect URIs**, add the callback URL shown on Supabase's **Authentication → Sign In / Providers → Google** page. It typically resembles `https://YOUR_PROJECT_REF.supabase.co/auth/v1/callback`; use the exact URL supplied by Supabase.
5. Create the OAuth client and copy the Google **Client ID** and **Client Secret** into the Supabase Google provider settings. Enable Google and save.
6. Return to Timely Fit and test **Continue with Google**. Also test the OAuth redirect on your deployed HTTPS URL, not only localhost.

**Security distinction:** there are two different credential types here. The Supabase Project URL + publishable key belong in `supabase-config.js`. The Google OAuth Client Secret belongs in the Supabase dashboard's Google provider configuration only. Do not put that Google Client Secret, a Supabase `sb_secret_...` key, or a legacy `service_role` key in this repository, browser JavaScript, HTML, or GitHub Pages. This static browser app does not need a Supabase secret key.

Email/password accounts can be enabled in **Authentication → Sign In / Providers → Email**. If email confirmation is enabled, users must confirm from email before they can sign in. Configure the redirect/confirmation URLs and verify email delivery before launch.

## Low-cost database architecture

Timely Fit is local-first by design:

- **Search requests: zero Supabase database reads.** `foods.json` and `exercises.json` are fetched and cached in IndexedDB. Typing filters the local catalogue immediately and never queries Supabase. With at least 3 characters, a debounced optional Open Food Facts search can run after 850 ms; this requires internet access and is independent of Supabase billing.
- **Timeline, dates and charts: local reads.** Switching dates, ticking a set, correcting a water amount, or editing a food entry updates the local state and IndexedDB, not a cloud query.
- **One compact cloud record per user/day.** Food entries, workout sessions and water events are stored together in one `daily_logs` JSONB payload per date. Derived daily macro totals are calculated in the app; the master food/exercise catalogues are never copied into Supabase.
- **Small auxiliary tables.** A row stores targets/profile, and custom recipes are stored only when the user creates them.
- **Batched writes only.** After the first successful cloud pull, dirty dates, changed recipes and changed profile data sync automatically in background batches after a short debounce, with a periodic retry while pending. No manual Sync button is required. Individual set completions and water taps are grouped with nearby edits rather than sent one-by-one. Errors leave edits local for retry.
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
- Food values and cooked estimates need source-based validation before release. The bundled catalogue contains 1,174 food records and 1,443 exercise entries (including 1,324 imported exercise records before exact-name reconciliation). Many imported exercises do not have an authoritative MET value; the app keeps these as null rather than inventing calorie factors.
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

- The exercise metadata was imported from [hasaneyldrm/exercises-dataset](https://github.com/hasaneyldrm/exercises-dataset). Upstream data includes exercise name, body part/category, equipment, target/synergist muscles and multilingual instruction text. Forma keeps one concise English sentence in `description`; it does not expose the long step-by-step text in its exercise card.
- The import preserves upstream IDs in `source_id`. Exact-name matches keep Forma's earlier IDs to avoid breaking existing workout references. New IDs use the `ed_` prefix. `source_dataset`, `source_id`, source category, media paths and attribution remain available for provenance.
- `image` and `gif_url` are preconfigured to relative paths under `exercise-media/`. This bundle includes 94 GIFs and 94 thumbnails; files referenced by other exercise records may be missing. The upstream repository's MIT licence covers its metadata/instruction text, but explicitly excludes Gym Visual media. Before using any image/GIF assets publicly, verify the applicable permission/licence for each asset. A record's `media_status: licensed` value controls whether Forma displays the file; the value itself is not evidence of a licence. Missing or unapproved media should remain hidden behind placeholders.
- Imported exercises have `met_value: null` unless an exact-name match already had a known Forma value. Session calorie calculations ignore missing MET values rather than fabricating precision. A future data-review phase can populate METs from a trusted activity reference.
- `EXERCISE-DATA-LICENSE.md` records the metadata licence and media caveat. Retain this file when redistributing the exercise catalogue.

## Food catalogue and nutrition logging (October 2026 update)

- The bundled food catalogue now contains **1,174 records**: the original 227 Forma entries plus 947 unique rows imported from `data_sources/final_master_foods.csv`. Three exact-name duplicates were not added twice.
- `DATA_IMPORT_REPORT.md` records the import counts, available source columns, category totals and limitations. The file's `source` values identify records as “USDA Foundation” or “INDB Indian”; those labels are preserved as supplied rather than independently verified.
- Category browsing and search remain local-first. The master `foods.json` catalogue is cached in IndexedDB and in the PWA service-worker cache for offline use.
- The original app's portion calculator, meal logging, daily macro summaries, custom recipe creator and recipe ingredient search are retained. External product entries used in recipes are saved locally with your app state.
- Optional Open Food Facts search and barcode lookup require internet access. The camera scanner supports barcodes and QR codes: it uses native `BarcodeDetector` where available, with a ZXing browser fallback where needed. Camera permission and HTTPS (or localhost during development) are required. Manual barcode entry remains available as a fallback.
- The uploaded CSV has calories, protein, carbohydrates and fat, but **no fibre field** and no recipe ingredients, quantities, yields or methods. Imported records do not fabricate fibre or recipes. Product database results may also have incomplete nutrition; check package labels for consequential decisions.
- If Supabase is not configured, the welcome screen offers **Continue on this device** for a local-only experience; logs stay in that browser and are not synced. This keeps the app usable without shipping any credentials. To enable account login/cloud sync, put your own Supabase Project URL and publishable key into `supabase-config.js`, then follow the existing “Configure Supabase” section above. No credentials were supplied with this build.

### Validation scripts

Run `node tests/catalogue-check.js`, `node tests/picker-refresh-check.mjs` and `python tests/verify-food-import.py` from the project directory to validate the bundled food JSON, exercise-picker filter matching, key UI hooks and reconciliation of every input CSV row to its catalogue record. A device/browser test is still required to confirm real camera permissions and scanning on target iOS/Android versions.

#### Open Food Facts reuse note

The optional online lookup uses the legacy free-text search endpoint because Open Food Facts' API documentation notes that `/api/v2/search` does not support free-text search. The app uses the product-by-barcode API for barcode lookup. API details can change, so verify behavior before a public release.

- [Open Food Facts API overview](https://openfoodfacts.github.io/documentation/docs/Product-Opener/api/)
- [Open Food Facts search endpoint documentation](https://openfoodfacts.github.io/documentation/docs/Product-Opener/api/ref-v2/#get-/api/v2/search)
- [Open Food Facts licence and attribution guidance](https://openfoodfacts.github.io/documentation/docs/Product-Opener/api/tutorials/license-be-on-the-legal-side/)

Open Food Facts describes its database as ODbL, individual database contents under the Database Contents License, and product images under CC BY-SA; product records are community-submitted and may be incomplete. Forma labels the external source and provides the licence guidance in the online-results panel. Review the current attribution/share-alike requirements before redistributing or launching publicly.
