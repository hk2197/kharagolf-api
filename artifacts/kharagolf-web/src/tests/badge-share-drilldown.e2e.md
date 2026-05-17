# E2E: Badge Share Leaderboard drill-down

Covers Task #1466 (regression coverage for Task #1248).

> **Primary executable coverage** lives next to this file at
> `artifacts/kharagolf-web/src/tests/badge-share-drilldown.test.tsx` and runs
> automatically as part of `pnpm --filter @workspace/kharagolf-web test`
> (vitest picks up `src/**/*.test.{ts,tsx}`). That file walks the same
> click-through flow against the real `<AnalyticsPage />` component with a
> stubbed fetch backend and is the canonical regression guard.
>
> The `runTest` plan below is supplementary documentation for replaying the
> same scenario as a live browser test (against a real api-server + Postgres)
> from any agent notebook with
> `runTest({ testReplitAuth: true, testPlan, relevantTechnicalDocumentation })`.

## What this test asserts

- The Badge Share Leaderboard card renders for an `org_admin` once the org
  has at least one badge-share event recorded for the current period.
- Clicking a leaderboard row opens the right-side drill-down sheet.
- The drill-down query fires the per-badge endpoint with the correct
  `:badgeType` (encoded) and matching `period`, and the sheet renders one
  row per member who shared that badge with the per-method counts coming
  from `badge_share_events`.
- A second click on a different badge row reopens the sheet against the
  new `:badgeType` (proves the query key reacts to `drilldownBadge`).
- A third click on a badge whose type contains URL-sensitive characters
  (`/`, ` `, `&`) sends the encoded form on the wire (proves
  `encodeURIComponent` on the path segment is intact) and round-trips
  back into the sheet.
- Every drill-down request carries the active `period` query param, so
  changing the period selector also re-keys the sheet's data.

## Component / endpoints under test

- File: `artifacts/kharagolf-web/src/pages/analytics.tsx`
  - `badgeShareLeaderboardQuery` (≈ line 430)
  - `drilldownBadge` state + `badgeShareMembersQuery` (≈ line 438)
  - Leaderboard `<tr>` with `onClick={() => setDrilldownBadge(entry)}`
    (≈ line 822)
  - Drill-down `<Sheet>` (≈ line 1235)
- Endpoints:
  - `GET /api/organizations/:orgId/analytics/badge-share-leaderboard?period=…`
  - `GET /api/organizations/:orgId/analytics/badge-share-leaderboard/:badgeType?period=…`
    (badgeType is URL-encoded by the SPA via `encodeURIComponent`)
- Auth: both endpoints require `super_admin` / `org_admin` /
  `tournament_director` (or an `org_memberships` row with one of the admin
  roles). `req.user` is read from `sessions.sess.user`, so the test must
  patch the cached session blob in addition to `app_users.role`.

### Relevant test ids

- `card-badge-share-leaderboard` — leaderboard card container.
- `row-badge-share-${badgeType}` — one `<tr>` per badge in the leaderboard
  (e.g. `row-badge-share-first_birdie`). Click target.
- `sheet-badge-share-members` — drill-down sheet content. Mounted only
  while `drilldownBadge` is set.
- `row-badge-share-member-${userId}` — one `<tr>` per member in the
  drill-down table.

## Test plan

```text
1. [New Context] Create a new browser context.

2. [OIDC] Configure the next login claims to:
   { sub: "test-badge-drill-" + Date.now(),
     email: "badge-drill-e2e-" + Date.now() + "@example.com",
     first_name: "BadgeDrill", last_name: "Tester" }

3. [Browser] Navigate to /api/login?returnTo=%2Fanalytics. Wait for the
   redirect chain to settle. Don't visually verify yet. NOTE: do NOT use
   returnTo=%2F — the home redirects to /portal, which currently has an
   unrelated runtime error and would block the run. Land straight on
   /analytics.

4. [DB] Promote the freshly-logged-in user to org_admin in BOTH the
   app_users table AND the active session blob (req.user is read from
   sessions.sess.user, not the DB). Then seed two app_users in the SAME
   organization with distinct public_handles, plus a deterministic mix of
   raw badge_share_events and one badge_share_daily_aggregates row across
   two badge types so the leaderboard + drill-down totals are predictable
   regardless of any pre-existing data in this org:

   UPDATE app_users SET role='org_admin'
     WHERE id = (SELECT id FROM app_users ORDER BY id DESC LIMIT 1)
     RETURNING id AS user_id, organization_id AS org_id;

   UPDATE sessions
      SET sess = jsonb_set(jsonb_set(sess, '{user,role}', '"org_admin"'),
                            '{user,organizationId}', to_jsonb(${org_id}::int))
    WHERE (sess->'user'->>'id')::int = ${user_id};

   -- A unique tag so the seeded handles + badges can be cleaned up safely
   -- and don't collide with anything else in the org. Note in runner state
   -- as ${tag}, e.g. floor(random()*1e9).

   -- Two players in the same org, each with a public_handle. The
   -- analytics endpoints scope events to the org by joining
   -- badge_share_events.handle = app_users.public_handle and filtering
   -- app_users.organization_id = :orgId, so both columns must be set.
   INSERT INTO app_users
     (replit_user_id, username, display_name, role,
      organization_id, public_handle, email_verified)
   VALUES
     ('badge-drill-alpha-' || ${tag}, 'alpha-' || ${tag},
      'Alpha BadgeDrill', 'player', ${org_id},
      'alpha-handle-' || ${tag}, true),
     ('badge-drill-bravo-' || ${tag}, 'bravo-' || ${tag},
      'Bravo BadgeDrill', 'player', ${org_id},
      'bravo-handle-' || ${tag}, true)
   RETURNING id, public_handle;
   -- Capture the two ids/handles as ${alpha_id}/${alpha_handle} and
   -- ${bravo_id}/${bravo_handle} (in INSERT order).

   -- Raw badge_share_events for "first_birdie" (the badge we'll click):
   --   alpha: 2× copy, 1× web_share
   --   bravo: 1× native_share
   -- Plus one daily-aggregate row to prove the UNION path also flows into
   -- the drill-down (alpha: +1 copy via the rollup).
   -- Created today so they fall inside the default "month" period.
   INSERT INTO badge_share_events (handle, badge_type, method, source, created_at)
   VALUES
     (${alpha_handle}, 'first_birdie', 'copy',         'web', now()),
     (${alpha_handle}, 'first_birdie', 'copy',         'web', now()),
     (${alpha_handle}, 'first_birdie', 'web_share',    'web', now()),
     (${bravo_handle}, 'first_birdie', 'native_share', 'web', now());

   INSERT INTO badge_share_daily_aggregates
     (handle, badge_type, method, day, count)
   VALUES
     (${alpha_handle}, 'first_birdie', 'copy',
      date_trunc('day', now())::date, 1);

   -- A second badge so we can prove the drill-down query re-keys on
   -- badgeType when the user clicks a different row. Only alpha shares it.
   INSERT INTO badge_share_events (handle, badge_type, method, source, created_at)
   VALUES
     (${alpha_handle}, 'first_eagle', 'web_share', 'web', now()),
     (${alpha_handle}, 'first_eagle', 'web_share', 'web', now());

5. [Browser] Reload /analytics so the freshly-promoted session and seeded
   data are picked up. Dismiss any Vite runtime overlay if one appears.
   Wait for data-testid="card-badge-share-leaderboard" to render.

6. [Verify] The Badge Share Leaderboard panel renders with our seeded
   badges:
   - data-testid="row-badge-share-first_birdie" is visible inside
     data-testid="card-badge-share-leaderboard".
   - That row's text contains "First Birdie". The leaderboard endpoint
     UNIONs raw badge_share_events with badge_share_daily_aggregates, so
     for "first_birdie" the per-method cells are Copy = 3 (2 raw + 1
     aggregate), Web = 1, Native = 1, and Total = 5. If pre-existing
     data in the org pushes those counts higher, assert "is at least
     3 / 1 / 1" instead — the drill-down assertions below are the
     canonical ones for this test.
   - data-testid="row-badge-share-first_eagle" is visible with text
     containing "First Eagle" and per-method 0 / 2 / 0.
   - data-testid="sheet-badge-share-members" does NOT yet exist (sheet
     is closed).

7. [Browser] Click data-testid="row-badge-share-first_birdie".

8. [Verify] The drill-down sheet opens against the "first_birdie" badge:
   - data-testid="sheet-badge-share-members" is visible.
   - Its header text contains "First Birdie".
   - Its description contains the period label currently active in the
     header `<Select>` (defaults to "This Month").
   - data-testid="row-badge-share-member-${alpha_id}" is visible with
     text containing "Alpha BadgeDrill", and the trailing per-method
     cells read 3 / 1 / 0 (Copy / Web / Native — i.e. 2 raw copies + 1
     copy from the aggregate UNION = 3, 1 web_share, 0 native_share).
   - data-testid="row-badge-share-member-${bravo_id}" is visible with
     text containing "Bravo BadgeDrill" and per-method cells 0 / 0 / 1.
   - Network: at least one GET to
     /api/organizations/${org_id}/analytics/badge-share-leaderboard/first_birdie?period=…
     returned 200. (Asserts the encodeURIComponent path-segment build did
     not break; "first_birdie" round-trips through encodeURIComponent
     unchanged but the path segment must be present and the response must
     be 200, not 404.)

9. [Browser] Close the sheet by pressing Escape (or clicking the sheet's
   close button if Escape is not wired). Then click
   data-testid="row-badge-share-first_eagle".

10. [Verify] The drill-down sheet reopens against the second badge:
    - data-testid="sheet-badge-share-members" is visible again.
    - Its header text contains "First Eagle" (NOT "First Birdie").
    - Exactly one member row is visible in the sheet:
      data-testid="row-badge-share-member-${alpha_id}" — Bravo did NOT
      share this badge in the seed and so must NOT appear.
    - The visible alpha row's per-method cells read 0 / 2 / 0 (matching
      the raw events seeded for first_eagle).

11. [DB] Cleanup — remove only the rows this test inserted, in
    FK-safe order. Note that badge_share_events / aggregates have no FK
    on app_users (they key on the textual handle), so they can be deleted
    independently:

    DELETE FROM badge_share_events
     WHERE handle IN (${alpha_handle}, ${bravo_handle});
    DELETE FROM badge_share_daily_aggregates
     WHERE handle IN (${alpha_handle}, ${bravo_handle});
    DELETE FROM app_users
     WHERE id IN (${alpha_id}, ${bravo_id});
```

## Technical documentation passed alongside the plan

```text
APP UNDER TEST
- kharagolf-web mounted at "/"; analytics page is /analytics, default tab
  is "dashboard" (which contains the Badge Share Leaderboard card).
- api-server at /api/* with cookie sessions and Replit OIDC.
- /api/login?returnTo=<safe-path> auto-redirects there after the bypass
  (unless path is "/" or "/login"). Use returnTo=%2Fanalytics so the test
  doesn't bounce through /portal.

AUTH GOTCHA
- The auth middleware sets req.user = sessions.sess.user. Updating
  app_users.role does NOT change req.user; you MUST also patch
  sessions.sess via jsonb_set as in step 4. Without that the
  /analytics endpoints return 403.
- requireOrgAdmin in artifacts/api-server/src/routes/analytics.ts allows
  super_admin, or (org_admin | tournament_director) when
  user.organizationId === orgId, else falls back to checking
  org_memberships. Promoting role + organizationId on the session is the
  shortest valid path.

ENDPOINTS
- GET /api/organizations/:orgId/analytics/badge-share-leaderboard
    ?period=today|week|month|quarter|year
  → returns { period, from, to, totals:{ total, byMethod }, badges:[…] }
    Each badge has badgeType, label, icon, category, total, byMethod.
- GET /api/organizations/:orgId/analytics/badge-share-leaderboard/:badgeType
    ?period=…
  → returns { period, from, to, badge:{…}, totals:{ total, byMethod },
              members:[{ userId, displayName, username, publicHandle,
                         total, byMethod }] }
  Both UNION the raw badge_share_events with the
  badge_share_daily_aggregates rollup (Task #1096) so that any rollup of
  older rows still flows into the totals. Both join through
  app_users.public_handle to scope by org.

UI WIRING (artifacts/kharagolf-web/src/pages/analytics.tsx)
- badgeShareLeaderboardQuery: queryKey
    ['analytics-badge-share-leaderboard', activeOrgId, period]
- drilldownBadge state: BadgeShareEntry | null. Set by the leaderboard
  row's onClick. The Sheet is open while drilldownBadge !== null.
- badgeShareMembersQuery: queryKey
    ['analytics-badge-share-members', activeOrgId, period,
     drilldownBadge?.badgeType]
  enabled: !!activeOrgId && !!drilldownBadge.
  URL: `/organizations/${orgId}/analytics/badge-share-leaderboard/
       ${encodeURIComponent(drilldownBadge.badgeType)}?period=${period}`
  Regression to guard: if a future refactor drops encodeURIComponent on
  badgeType, the path will break for any badgeType containing a slash or
  special character; the click-through assertion in step 10 (re-keying on
  a second badge) catches "the query never re-fires for the new row".

DB SCHEMAS (lib/db/src/schema/golf.ts)
- sessions(sid varchar pk, sess jsonb, expire timestamp)
- app_users(id, replit_user_id, username, display_name, role,
   organization_id, public_handle, email_verified, …)
- badge_share_events(id, handle, badge_type, method enum
   ('copy'|'web_share'|'native_share'), source, created_at)
- badge_share_daily_aggregates(handle, badge_type, method, day, count) —
   PK is (handle, badge_type, method, day).
- Both share tables key on handle (text) — there is intentionally no FK
  to app_users; the leaderboard joins handle = app_users.public_handle.
```

## Last verified

Authored on 2026-04-29 for Task #1466. A first end-to-end run is blocked
on the queued task "Restore the dev test database so existing levy tests
can run" — the dev Postgres in this environment is currently missing the
`app_users`, `badge_share_events` and `badge_share_daily_aggregates`
tables, so the [DB] seed step fails with "relation does not exist".
Re-run this plan via
`runTest({ testReplitAuth: true, testPlan, relevantTechnicalDocumentation })`
once the dev DB has been restored from the canonical schema (drizzle push
of `lib/db/src/schema/golf.ts`).
