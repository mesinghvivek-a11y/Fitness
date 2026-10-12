# Timely Fit — Supabase Cost and Data-Flow Audit

Audit date: 12 October 2026

## Conclusion

The app is local-first. Food/exercise search, timeline interactions, date changes, set completion, water taps, macro calculations and chart calculations do not issue a Supabase query for each interaction. Supabase is used for authentication and batched user-data synchronization only.

Supabase Free is a reasonable starting tier for a personal tracker or small beta, but no design can guarantee that a public app never exceeds free quotas. Monitor usage before opening it to a large user base.

## Event-to-database map

| User action | Where it executes | Supabase reads | Supabase writes |
|---|---|---:|---:|
| Type one more character into food search | In-memory `foods.json` catalogue | 0 | 0 |
| Type one more character into exercise search | In-memory `exercises.json` catalogue | 0 | 0 |
| Select another date / switch Timeline or Dashboard | Shared JavaScript state and IndexedDB | 0 | 0 |
| Add or edit a meal | Local state + IndexedDB; mark that date dirty | 0 | 0 immediately |
| Complete a workout set / adjust rest timer | Local state + IndexedDB; mark the date dirty | 0 | 0 immediately |
| Add/edit/delete a water event | Local state + IndexedDB; mark the date dirty | 0 | 0 immediately |
| Open a new signed-in session on a device for the first time | Supabase Auth + first cloud reconciliation | Timeline rows paginated in batches of 500, one profile lookup, one custom-recipe list query | 0 by the pull itself |
| Reopen a previously synced account | Incremental daily-log query, one profile lookup, one custom-recipe list query | Daily logs newer than the stored high-water mark (pagination only if needed) plus small auxiliary reads | 0 by the pull itself |
| Automatic background sync | Debounced background uploader | 0 additional read in the write path | One upsert request per 50 dirty daily logs, one profile upsert only if profile is dirty, one upsert request per 50 changed recipes |
| Finish workout session | Marks the date dirty; background batch sends it | No per-set read | Only dirty date/profile/recipe rows are upserted |
| Idle automatic sync (after initial cloud pull) | Debounced sync plus 2-minute safety retry checks dirty flags | 0 when no data pull is requested | 0 when nothing is dirty; batched upserts if dirty |

The SQL API still processes queries, but Supabase's published Free quota table is not a per-row/per-query price list. Key quotas include database size, egress, file storage, and monthly active users.

## Data stored in Supabase

- `user_profiles`: one row per user, containing only goals, body weight and app preferences.
- `daily_logs`: one row per `(user_id, date)`. A compact JSONB payload contains that day's food instances, exercise/session data and water events. `date` and `updated_at` are kept in indexed SQL columns and are omitted from the JSONB copy.
- `user_custom_foods`: one row per user-made recipe. The `id`, `updated_at` and `created_at` metadata are stored outside the JSONB recipe payload where possible.
- `foods.json` and `exercises.json` remain static files; they are not copied to Supabase. The static site's bandwidth may still count toward its hosting provider's limits, but it is not Supabase database egress.

No Realtime subscription, Supabase Storage upload, or Edge Function is used by this build.

## Controls added

1. Local search: no request per keystroke.
2. Local-first edits: user actions write to IndexedDB/local storage; they only mark dirty state.
3. First sync no longer rewrites every date. It sends only local dates/recipes identified as dirty after the initial reconciliation.
4. Later cloud pulls are incremental for daily logs and paginated to avoid silently truncating large histories.
5. A composite `(user_id, updated_at)` index supports incremental daily-log pulls.
6. SQL triggers set `updated_at` using the database clock, avoiding arbitrary client-clock values for newly written cloud rows.
7. RLS is enabled on all user-data tables with owner-only policies based on `auth.uid()`.
8. Authentication screen hides the main UI until Supabase Auth has a session. This client-side screen improves the user flow; RLS, not the screen, is the real boundary protecting cloud data.
9. The browser uses only the publishable API key. Secret/service-role keys never belong in `supabase-config.js`, HTML, JavaScript, or GitHub Pages.

## Operational caveats

- A newly authenticated browser performs a full initial timeline pull so it can restore history. Large accounts necessarily transfer more data on first login.
- The custom-recipe list and single profile row are fetched at sign-in/session restore. They are small for normal personal use, but a very large number of custom recipes would justify an incremental recipe sync cursor too.
- Conflict resolution is timestamp-based, not a transactional multi-device merge. Simultaneous changes to the same day on two devices may need a future conflict screen or server-side merge function.
- Deletions/tombstones for cloud recipes and daily-log records are not yet implemented as a full cross-device deletion protocol.
- Local browser storage is device-specific and can be cleared by the browser. Use **Export my data (JSON)** before switching devices or clearing site data.
- Free plan quotas and policies can change. Review the project's Supabase Usage dashboard and current billing docs before public launch. Free projects can pause when there is very low activity for a week.

Official reference: https://supabase.com/docs/guides/platform/billing-on-supabase
