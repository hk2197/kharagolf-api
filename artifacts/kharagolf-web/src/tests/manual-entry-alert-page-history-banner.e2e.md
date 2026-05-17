# E2E: Manual-entry alerts page-history banner

Covers Task #1665.

> **Primary executable coverage** lives in
> `artifacts/api-server/src/tests/manual-entry-alert-health-ops-alert.test.ts`
> (the 3 page-history tests use a `pageHistoryWatermarkId` per-test
> watermark on `max(id)` to isolate test rows from any pre-existing
> data) and the React Query banner is exercised by the live server in
> the plan below.
>
> The `runTest` plan is supplementary documentation for replaying the
> dashboard banner against a real api-server + Postgres from any agent
> notebook with
> `runTest({ testReplitAuth: true, testPlan, relevantTechnicalDocumentation })`.

## What this test asserts

- The PageHistoryBanner shows an explicit empty state when
  `manual_entry_alert_page_history` has no rows.
- After rows exist, the banner renders the most recent page (largest
  `paged_at`) with a relative-time label, the breach-kind labels
  ("delivery rate" / "consecutive silent"), and the recipient count.
- The toggle button surfaces the count of all rows returned by
  `GET /api/super-admin/manual-entry-alerts/page-history` and expands an
  inline list with the recipient emails for each historical page.

## Component / endpoints under test

- File: `artifacts/kharagolf-web/src/pages/manual-entry-alerts.tsx`
  - `PageHistoryBanner` component
  - Query key `["/api/super-admin/manual-entry-alerts/page-history"]`
- Endpoint:
  - `GET /api/super-admin/manual-entry-alerts/page-history?limit=N`
- Auth: `requireSuperAdmin` — must be a `super_admin` user.

### Relevant test ids

- `banner-page-history-empty` — shown when API returns `rows: []`.
- `banner-page-history` — shown when at least one row exists.
- `text-page-history-when` — relative-time label for the latest row.
- `text-page-history-breaches` — breach-kind labels for the latest row.
- `text-page-history-recipients` — recipient count for the latest row.
- `button-toggle-page-history` — toggles the expanded list.
- `list-page-history` — expanded list container.
- `row-page-history-${idx}` — one row per historical page in the list.

## Test plan

```text
1. [New Context] Create a new browser context.

2. [OIDC] Configure the next login claims to:
   { sub: "test-me-page-hist-" + Date.now(),
     email: "me-page-hist-e2e-" + Date.now() + "@example.com",
     first_name: "MEPageHist", last_name: "Tester" }

3. [Browser] Navigate to /api/login?returnTo=%2Fsuper-admin%2Fmanual-entry-alerts.
   Wait for the OIDC bypass + redirect chain to settle.

4. [DB] Promote the freshly-logged-in user to super_admin in BOTH the
   app_users table AND the active session blob (req.user is read from
   sessions.sess.user, not the DB):

   UPDATE app_users SET role='super_admin'
     WHERE id = (SELECT id FROM app_users ORDER BY id DESC LIMIT 1)
     RETURNING id AS user_id;

   UPDATE sessions
      SET sess = jsonb_set(sess, '{user,role}', '"super_admin"')
    WHERE (sess->'user'->>'id')::int = ${user_id};

   -- Make the empty-state assertion deterministic.
   DELETE FROM manual_entry_alert_page_history;

5. [Browser] Reload /super-admin/manual-entry-alerts.

6. [Verify] Empty-state banner renders:
   - data-testid="banner-page-history-empty" is visible.
   - Its text contains "On-call has not been auto-paged".
   - data-testid="banner-page-history" does NOT exist.

7. [DB] Insert two page-history rows so the latest is the most-recent:

   INSERT INTO manual_entry_alert_page_history
     (paged_at, breach_kinds, recipient_count, recipient_emails,
      threshold_pct, cooldown_hours, alert_count_7d,
      any_delivery_rate_7d, zero_delivery_count_7d)
   VALUES
     (now() - interval '2 days',
      ARRAY['delivery_rate']::text[], 2,
      ARRAY['old1@example.com','old2@example.com']::text[],
      80.00, 6.00, 8, 50.00, 4),
     (now() - interval '15 minutes',
      ARRAY['delivery_rate','consecutive_zero']::text[], 3,
      ARRAY['ops@example.com','oncall@example.com','admin@example.com']::text[],
      80.00, 6.00, 12, 25.00, 9);

8. [Browser] Reload /super-admin/manual-entry-alerts. Wait for
   data-testid="banner-page-history" to appear.

9. [Verify] Most recent page is shown:
   - data-testid="banner-page-history" is visible.
   - data-testid="banner-page-history-empty" does NOT exist.
   - data-testid="text-page-history-when" text contains "ago".
   - data-testid="text-page-history-breaches" text contains
     "delivery rate" AND "consecutive silent".
   - data-testid="text-page-history-recipients" text contains
     "3 recipients".
   - data-testid="button-toggle-page-history" text contains
     "View history (2)".
   - data-testid="list-page-history" does NOT exist yet.

10. [Browser] Click data-testid="button-toggle-page-history".

11. [Verify] Expanded history list renders:
    - data-testid="list-page-history" is visible.
    - data-testid="row-page-history-0" is visible.
    - data-testid="row-page-history-1" is visible.
    - The list contains text "ops@example.com" AND "old1@example.com".
    - data-testid="button-toggle-page-history" text now contains
      "Hide history".

12. [DB] Cleanup:
    DELETE FROM manual_entry_alert_page_history
     WHERE recipient_emails && ARRAY['ops@example.com','old1@example.com']::text[];
```

## Technical documentation passed alongside the plan

```text
APP UNDER TEST
- kharagolf-web at "/"; manual-entry alerts dashboard route is
  /super-admin/manual-entry-alerts (component:
  artifacts/kharagolf-web/src/pages/manual-entry-alerts.tsx).
- api-server at /api/* with cookie sessions and Replit OIDC.
- /api/login?returnTo=<safe-path> auto-redirects after the OIDC bypass.

AUTH GOTCHA
- req.user is read from sessions.sess.user. UPDATE app_users.role does
  NOT change req.user; you MUST also patch sessions.sess via jsonb_set.
- /super-admin/manual-entry-alerts requires role super_admin.

ENDPOINT (Task #1665)
- GET /api/super-admin/manual-entry-alerts/page-history?limit=N
  → { rows: [{ id, pagedAt, breachKinds, recipientCount,
               recipientEmails, thresholdPct, cooldownHours,
               alertCount7d, anyDeliveryRate7d,
               zeroDeliveryCount7d }, ...] } ordered paged_at DESC.
  Default limit 10, clamped to [1,100].

UI WIRING (artifacts/kharagolf-web/src/pages/manual-entry-alerts.tsx)
- PageHistoryBanner renders just below the page header, before the
  window cards.
- testids:
    banner-page-history-empty
    banner-page-history
    text-page-history-when
    text-page-history-breaches
    text-page-history-recipients
    button-toggle-page-history
    list-page-history
    row-page-history-${idx}
```

## Last verified

Authored on 2026-04-29 for Task #1665. Run via
`runTest({ testReplitAuth: true, testPlan, relevantTechnicalDocumentation })`;
the live run on this date completed all 11 verification steps in order
(empty-state → seed → populated banner → expand → cleanup) on the dev
api-server + Postgres.
