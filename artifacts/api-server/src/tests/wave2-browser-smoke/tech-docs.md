# Tech docs passed alongside the Wave 2 smoke test plan

These notes are passed to `runTest` as `relevantTechnicalDocumentation` so
the harness understands the codebase conventions it is driving.

## App layout
- Web app (`artifacts/kharagolf-web`): preview path `/`. Wouter SPA router
  — every route refresh works.
- Mobile app (`artifacts/kharagolf-mobile`): preview path `/mobile/`.
  Expo Web build, Expo bypasses the workspace proxy so `/mobile/*` returns
  404 from the harness's browser. `Alert.alert` becomes window.confirm in
  the web build when it can be reached directly.

## Routes touched
- `/portal/course-corrections`  — Player report form.
- `/course-moderation`          — Admin moderation; "Data corrections" tab.
- `/tournaments/:id`            — Apply Cut button uses `window.prompt`.
- `/coach-marketplace`          — Public; filter sidebar gated on toggle.
- `/mobile/tee-bookings`        — Mobile bookings list with Cancel sheet.

## Auth
- POST `/api/auth/player-login` sets a `sid` HTTP-only cookie. Same cookie
  is honoured by `/portal/*` and admin routes when `app_users.role` is
  `org_admin` (or `super_admin`/`tournament_director`).
- `/api/auth/register` hashes with bcrypt; the plan registers users via
  the API and then `UPDATE`s `app_users` to flip `email_verified=true` and
  (for the admin) set `role='org_admin'` + `organization_id`.
- The web app's AuthGuard at `artifacts/kharagolf-web/src/App.tsx`
  redirects users with `role` in `('player','spectator')` to `/portal`,
  which is why the role update in Phase A step 4 *must* land before
  Phase C navigates.

## Marketplace price filter
`artifacts/api-server/src/routes/coach-marketplace.ts` (lines ~142–152)
maps both `priceMin` and `priceMax` to `async_review_price_paise`. The web
form converts the rupee input to paise via `*100` before sending. So
`priceMax=4000` means "async review ≤ ₹4,000". This explains why the
Phase E expectation pins Aarav (async ₹2k) as the survivor and Bina
(async ₹6k) as the one filtered out.

## Endpoints exercised
- POST `/api/portal/course-corrections`                                 (player submit)
- GET  `/api/portal/course-corrections/mine`                            (player list)
- GET  `/api/organizations/:orgId/course-corrections?status=open`       (admin queue)
- POST `/api/organizations/:orgId/course-corrections/:id/resolve`       (admin accept)
- POST `/api/organizations/:orgId/tournaments/:tId/cut`                 (Apply Cut)
- GET  `/api/coach-marketplace/coaches?priceMax=…&specialty=…`          (marketplace)
- POST `/api/portal/tee-bookings/:bookingId/cancel-and-promote`         (mobile cancel)

## Selectors
Course corrections (player):
  `select-course`, `input-hole`, `select-field`, `input-current`,
  `input-proposed`, `input-reason`, `button-submit`, `correction-row-{id}`.
Course moderation (admin):
  `tab-reviews`, `tab-photos`, `tab-data-corrections`,
  `filter-corrections-{open|accepted|rejected}`, `correction-row-{id}`,
  `notes-correction-{id}`, `button-accept-correction-{id}`,
  `button-reject-correction-{id}`.
Tournament detail (admin):
  `button-apply-cut`.
Coach marketplace:
  `button-toggle-filters`, `filter-specialty`, `filter-region`,
  `filter-handicap`, `filter-price-min`, `filter-price-max`,
  `filter-min-rating`.
Mobile bookings:
  No testIDs today — match by visible text "Cancel" on the
  confirmed-upcoming row. (See follow-up to add testIDs.)

## Schema notes the seed depends on
- `tournaments.cut_line` is integer strokes-over-par.
- `scores` has UNIQUE (tournament_id, player_id, round, hole_number);
  the plan only writes to hole_number=1 to encode the round total.
- `course_data_corrections.status` enum: 'open' | 'accepted' | 'rejected'.
- `coach_marketplace_profiles.certifications` is declared text[] but the
  handicap filter reads JSON keys via `->>`. The plan inserts the JSON
  shape the live filter expects.
- `tee_bookings.lead_user_id` is the only person allowed to cancel.
