# E2E: Manual-entry alerts cooldown-active banner pill

Covers Task #2078.

> **Primary executable coverage** lives in
> `artifacts/api-server/src/tests/manual-entry-alert-health-ops-alert.test.ts`
> under the `getManualEntryAlertHealthCooldownStatus (Task #2078)`
> describe block (no-history / in-cooldown+breach / in-cooldown+healthy
> / elapsed-cooldown / snapshot-cooldown precedence). The React Query
> banner pill is exercised by the live server in the plan below.
>
> The `runTest` plan is supplementary documentation for replaying the
> dashboard pill against a real api-server + Postgres from any agent
> notebook with
> `runTest({ testReplitAuth: true, testPlan, relevantTechnicalDocumentation })`.

## What this test asserts

- The PageHistoryBanner renders an extra "cooldown active" pill
  immediately below the "Last paged" line when:
  - a recent row exists in `manual_entry_alert_page_history`,
  - `now() < paged_at + cooldown_hours` (still inside the cooldown),
  - AND at least one delivery-rate / consecutive-zero breach is
    currently firing (so the cron would have paged again if not
    suppressed).
- The pill includes a "Next page eligible in <relative>" label so the
  admin knows when the cron will be allowed to re-page on-call.
- The pill does NOT render when the cooldown has elapsed (even with a
  fresh breach), and it does NOT render when there is no breach.

## Component / endpoints under test

- File: `artifacts/kharagolf-web/src/pages/manual-entry-alerts.tsx`
  - `PageHistoryBanner` component (cooldown pill block)
  - Query key `["/api/super-admin/manual-entry-alerts/cooldown-status"]`
- Endpoints:
  - `GET /api/super-admin/manual-entry-alerts/page-history?limit=N`
  - `GET /api/super-admin/manual-entry-alerts/cooldown-status`
- Auth: `requireSuperAdmin` — must be a `super_admin` user.

### Relevant test ids

- `banner-page-history` — wrapping banner shown when at least one
  page-history row exists.
- `pill-cooldown-active` — the "cooldown active" pill, only present
  when the API reports `active: true`.
- `text-cooldown-active-label` — "Cooldown active — <breaches> would
  page on-call, suppressed." label inside the pill.
- `text-cooldown-next-eligible` — "Next page eligible in 1h 12m" label
  inside the pill.

## Test plan

```text
1. [New Context] Create a new browser context.

2. [OIDC] Configure the next login claims to:
   { sub: "test-me-cooldown-" + Date.now(),
     email: "me-cooldown-e2e-" + Date.now() + "@example.com",
     first_name: "MECooldown", last_name: "Tester" }

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

   -- Make the cooldown-active assertion deterministic — purge any
   -- residual page-history rows so the only row is the one we insert
   -- in step 5.
   DELETE FROM manual_entry_alert_page_history;

   -- Make the breach evaluator deterministic too — wipe the
   -- manual-entry alert table so the 7d summary is empty (the
   -- delivery-rate breach needs alertCount >= minSample, so we'll
   -- seed enough silent alerts below to trip it).
   DELETE FROM manual_entry_alerts;

   -- Reset any DB-stored opsAlertSettings overrides so the resolved
   -- tunables fall back to the hardcoded defaults
   -- (rateThresholdPct=80, minSample=3, consecutiveZero=5).
   UPDATE ops_alert_settings
      SET manual_entry_rate_threshold_pct = NULL,
          manual_entry_min_sample = NULL,
          manual_entry_consecutive_zero = NULL,
          manual_entry_cooldown_hours = NULL
    WHERE id = 1;

5. [DB] Insert a recent page-history row (paged 30 minutes ago, 6h
   cooldown → cooldown lifts ~5h 30m from now) so the cooldown is
   definitively still active when the dashboard reads it back:

   INSERT INTO manual_entry_alert_page_history
     (paged_at, breach_kinds, recipient_count, recipient_emails,
      threshold_pct, cooldown_hours, alert_count_7d,
      any_delivery_rate_7d, zero_delivery_count_7d)
   VALUES
     (now() - interval '30 minutes',
      ARRAY['delivery_rate']::text[], 1,
      ARRAY['ops@example.com']::text[],
      80.00, 6.00, 10, 0.00, 10);

6. [DB] Seed a breaching 7d window — three "sent" alerts that all
   reached zero recipients. With the default 80% threshold and
   minSample=3 the breach evaluator will flag delivery_rate. The 7d
   summary aggregator joins manual_entry_alerts to round_submissions
   so we need an existing submission to reference; we reuse the most
   recent submission to avoid setting up a fresh tournament/player
   chain inside the test.

   WITH any_sub AS (
     SELECT id, tournament_id, player_id, round
       FROM round_submissions
      ORDER BY id DESC
      LIMIT 1
   )
   INSERT INTO manual_entry_alerts
     (submission_id, tournament_id, player_id, round,
      manual_pct, manual_shots, total_shots,
      recipient_count, push_attempted, push_sent,
      email_attempted, email_sent, status, sent_at)
   SELECT id, tournament_id, player_id, round,
          100.00, 18, 18,
          1, 1, 0,
          1, 0, 'sent', now() - (i * interval '1 hour')
     FROM any_sub, generate_series(1, 3) AS s(i);

7. [Browser] Reload /super-admin/manual-entry-alerts. Wait for
   data-testid="banner-page-history" to appear.

8. [Verify] The cooldown-active pill renders inside the banner:
   - data-testid="banner-page-history" is visible.
   - data-testid="pill-cooldown-active" is visible.
   - data-testid="text-cooldown-active-label" text contains
     "Cooldown active" AND "delivery rate".
   - data-testid="text-cooldown-next-eligible" text contains
     "Next page eligible in" AND ("h" OR "m") so we know a relative
     duration was rendered (the exact value depends on the wall clock
     between the seed and the request).

9. [DB] Backdate the page-history row so the cooldown has elapsed
   (paged 12h ago with the same 6h cooldown):

   UPDATE manual_entry_alert_page_history
      SET paged_at = now() - interval '12 hours'
    WHERE recipient_emails && ARRAY['ops@example.com']::text[];

10. [Browser] Reload /super-admin/manual-entry-alerts. Wait for
    data-testid="banner-page-history" to appear.

11. [Verify] The pill no longer renders even with the breach still in
    place:
    - data-testid="banner-page-history" is visible.
    - data-testid="pill-cooldown-active" does NOT exist.

12. [DB] Cleanup — undo the seed + the page-history row + reset the
    ops_alert_settings override (already null but harmless).

    DELETE FROM manual_entry_alert_page_history
     WHERE recipient_emails && ARRAY['ops@example.com']::text[];
    DELETE FROM manual_entry_alerts
     WHERE manual_pct = 100.00 AND push_sent = 0 AND email_sent = 0
       AND sent_at > now() - interval '1 day';
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

ENDPOINT (Task #2078)
- GET /api/super-admin/manual-entry-alerts/cooldown-status
  → { active, latestPagedAt, cooldownHours, nextPageEligibleAt,
       breachKinds, thresholdPct }
  active=true iff the latest manual_entry_alert_page_history row's
  paged_at + cooldown_hours is still in the future AND the live
  breach evaluator currently flags at least one breach.

UI WIRING (artifacts/kharagolf-web/src/pages/manual-entry-alerts.tsx)
- PageHistoryBanner reads cooldownStatusQuery and renders an extra
  pill (testid pill-cooldown-active) immediately under the "Last
  paged" line when active=true.
- Pill testids:
    pill-cooldown-active
    text-cooldown-active-label
    text-cooldown-next-eligible
```

## Last verified

Authored on 2026-04-30 for Task #2078. The api-side describe block in
`artifacts/api-server/src/tests/manual-entry-alert-health-ops-alert.test.ts`
covers the four state transitions deterministically; the runTest plan
above replays the React Query → pill render against a live server.
