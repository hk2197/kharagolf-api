# E2E: Coach Workspace — "Try again" payout notification button

Covers Task #1915. Canonical Playwright `runTest` plan that signs in
as a coach who has a paid payout with a cap-exhausted push attempt,
clicks the coach-side "Try again" button on the Earnings tab, and
verifies the success toast + cooldown gating.

The backend endpoint
`POST /api/swing-reviews/coach/payouts/:id/retry-notification`
(Task #1543) is already covered at the API level in
`artifacts/api-server/src/tests/coach-admin-payouts.test.ts` (ownership,
cooldown, channel reset, missing-attempt). This plan locks down the
client-side gating logic — when the button shows, when it hides during
the cooldown, and what happens when the request returns 200.

Replay it from any agent notebook with
`runTest({ testReplitAuth: true, testPlan, relevantTechnicalDocumentation })`
using the bodies below.

## Page under test

- File: `artifacts/kharagolf-web/src/pages/coach-workspace.tsx`
- Endpoints exercised:
  - `GET  /api/coach-marketplace/me/coach-profile`
  - `GET  /api/swing-reviews/coach/queue`
  - `GET  /api/swing-reviews/coach/earnings`
  - `GET  /api/swing-reviews/coach/notifications`
  - `POST /api/swing-reviews/coach/payouts/:id/retry-notification`
- Auth: requires the caller to be a registered teaching pro
  (`teaching_pros.user_id = req.user.id`). The retry endpoint itself
  does NOT check role, BUT the page-level AuthGuard at
  /coach-workspace bounces role IN ('player','spectator') to /portal,
  so the freshly-bypassed user must be promoted to a non-player role
  (use `'coach'`) in BOTH `app_users.role` AND the cached
  `sessions.sess.user.role` (via `jsonb_set`) before navigating.
- Test ids exercised here:
  - `row-coach-payout-${payoutId}` — one row per payout in the
    Earnings tab payout history table.
  - `cell-coach-notification-${payoutId}` — the notification cell
    inside that row.
  - `badge-coach-notif-push-${payoutId}` /
    `badge-coach-notif-sms-${payoutId}` — per-channel status badges.
  - `note-coach-notif-both-missed-${payoutId}` — inline "couldn't
    reach you" note (only when BOTH channels are non-sent).
  - `button-coach-notif-retry-${payoutId}` — coach-side "Try again"
    button (Task #1543, this is the one under test).

## Test plan

```text
1. [New Context] Create a new browser context.

2. [OIDC] Configure the next login claims to:
   { sub: "test-coach-retry-" + Date.now(),
     email: "coach-retry-e2e-" + Date.now() + "@example.com",
     first_name: "Coach", last_name: "Retry" }

3. [Browser] Navigate to /api/login?returnTo=%2Fcoach-workspace. Wait
   for the redirect chain to settle (OIDC bypass → /coach-workspace).
   The page may briefly redirect to /portal because the freshly-bypassed
   user defaults to role 'player'; that's expected and step 4 fixes it
   before we navigate again.

4. [DB] Promote the freshly-logged-in user to a coach (so the
   AuthGuard at /coach-workspace lets them through — it redirects only
   role IN ('player','spectator') to /portal) AND register them as a
   teaching pro on their org.

   CRITICAL: req.user is read from sessions.sess.user, NOT app_users,
   so the role MUST be patched in BOTH places via jsonb_set, otherwise
   the AuthGuard still sees 'player' and bounces /coach-workspace →
   /portal. The retry route itself does NOT check role (it only checks
   `teaching_pros.user_id = req.user.id`), but the AuthGuard does.

   -- Pick the freshly-created user.
   SELECT id AS user_id, organization_id AS org_id
     FROM app_users ORDER BY id DESC LIMIT 1;

   -- Promote in app_users.
   UPDATE app_users SET role='coach' WHERE id = ${user_id};

   -- Patch the cached session blob too — without this the AuthGuard
   -- still sees role='player' and bounces /coach-workspace → /portal.
   UPDATE sessions
      SET sess = jsonb_set(sess, '{user,role}', '"coach"')
    WHERE (sess->'user'->>'id')::int = ${user_id};

   -- Wipe any pre-existing coach state in this org so the per-payout
   -- asserts are stable. The test owns this org for the run.
   UPDATE swing_review_requests SET payout_id = NULL
     WHERE organization_id = ${org_id};
   DELETE FROM coach_payout_notification_attempts
     WHERE organization_id = ${org_id};
   DELETE FROM coach_payouts          WHERE organization_id = ${org_id};
   DELETE FROM swing_review_requests  WHERE organization_id = ${org_id};
   DELETE FROM coach_marketplace_profiles WHERE organization_id = ${org_id};
   DELETE FROM teaching_pros          WHERE organization_id = ${org_id}
     AND user_id = ${user_id};

   -- Make the test user a teaching pro on this org.
   INSERT INTO teaching_pros (organization_id, user_id, display_name)
     VALUES (${org_id}, ${user_id}, 'Coach Retry')
     RETURNING id AS pro_id;

   -- Profile is required for /coach/earnings to compute the share %.
   INSERT INTO coach_marketplace_profiles
     (pro_id, organization_id, is_listed, revenue_share_pct,
      async_review_price_paise)
     VALUES (${pro_id}, ${org_id}, true, '70', 50000);

   -- Seed a paid coach_payout for this pro in this org.
   INSERT INTO coach_payouts
     (pro_id, organization_id, period_start, period_end,
      gross_paise, platform_fee_paise, net_payout_paise,
      status, payout_reference, paid_at, paid_notified_at)
     VALUES (${pro_id}, ${org_id}, now() - interval '30 days', now(),
             50000, 0, 35000,
             'paid', 'REF-1915', now(), now())
     RETURNING id AS payout_id;

   -- Seed the notification attempts row in the canonical "missed on
   -- push, can retry" shape exercised by the API-level tests:
   --   push: failed + cap-exhausted (pushAttempts = 5)
   --   sms : sent (so the inline "both missed" note does NOT fire)
   -- coachRetryRequestedAt is NULL → coachPayoutCanCoachRetry = true
   -- and the "Try again" button is rendered.
   INSERT INTO coach_payout_notification_attempts
     (payout_id, pro_id, organization_id, coach_user_id,
      amount_paise, reference,
      push_status, push_attempts, last_push_error,
      push_retry_exhausted_at, push_target_label,
      sms_status, sms_attempts,
      coach_retry_requested_at)
     VALUES (${payout_id}, ${pro_id}, ${org_id}, ${user_id},
             35000, 'REF-1915',
             'failed', 5, 'boom',
             now(), '1 expo device',
             'sent', 1,
             NULL);

5. [Browser] Navigate to /coach-workspace. Wait for the page to settle
   (the heading "Coach Workspace" should be visible). Click the
   "Earnings" tab in the page tab strip (it's a shadcn TabsTrigger;
   identifying it by visible text is fine — the label varies with the
   user's i18n locale but English is the default).

6. [Verify] BASELINE — the seeded payout row + its notification cell
   are rendered in the canonical "missed-on-push, can-retry" shape:
   - data-testid="row-coach-payout-${payout_id}" IS visible.
   - data-testid="cell-coach-notification-${payout_id}" IS visible.
   - data-testid="badge-coach-notif-push-${payout_id}"
     has data-status="failed_exhausted" (text contains "gave up").
   - data-testid="badge-coach-notif-sms-${payout_id}"
     has data-status="sent" (text contains "Sent").
   - data-testid="note-coach-notif-both-missed-${payout_id}"
     does NOT exist (SMS sent → inline note suppressed).
   - data-testid="button-coach-notif-retry-${payout_id}" IS visible
     and its text contains "Try again".

7. [Browser] Click data-testid="button-coach-notif-retry-${payout_id}".
   Wait for the success toast to appear. The toast title is
   "Re-sending your payout notification…" (note the ellipsis is the
   single-character ellipsis "…" rendered by the React component).

8. [Verify] SUCCESS PATH:
   - A toast / status region whose visible text contains
     "Re-sending your payout notification" IS present.
     (Don't rely on a data-testid — the shadcn `useToast` hook renders
     a generic Radix region; matching by visible text is the supported
     contract.)
   - The retry handler in EarningsTab calls reload() after the POST
     resolves, so wait for a second `GET /api/swing-reviews/coach/earnings`
     to land and then assert that
     data-testid="button-coach-notif-retry-${payout_id}"
     does NOT exist anymore — the API server stamped
     `coachRetryRequestedAt = now()` and the shared
     `coachPayoutCanCoachRetry` helper now returns false (cooldown
     active).
   - The surrounding badges still render — only the button vanished:
     data-testid="badge-coach-notif-push-${payout_id}" still exists
     and now has data-status="failed" (cap reset to 0, push_status
     re-armed to 'failed' but no longer exhausted).
     data-testid="badge-coach-notif-sms-${payout_id}" still has
     data-status="sent" (the API server only re-arms `failed`/`skipped`
     channels; `sent` is left alone on purpose).

9. [DB] Verify the retry persisted server-side:
   SELECT push_status, push_attempts, push_retry_exhausted_at,
          sms_status, sms_attempts, coach_retry_requested_at
     FROM coach_payout_notification_attempts
    WHERE payout_id = ${payout_id};
   -- expect:
   --   push_status='failed', push_attempts=0,
   --   push_retry_exhausted_at IS NULL  (cap reset, ready for the cron)
   --   sms_status='sent',    sms_attempts=1 (untouched)
   --   coach_retry_requested_at IS NOT NULL (cooldown stamp set)

10. [DB] Cleanup:
    UPDATE swing_review_requests SET payout_id = NULL
      WHERE organization_id = ${org_id};
    DELETE FROM coach_payout_notification_attempts
      WHERE organization_id = ${org_id};
    DELETE FROM coach_payouts          WHERE organization_id = ${org_id};
    DELETE FROM swing_review_requests  WHERE organization_id = ${org_id};
    DELETE FROM coach_marketplace_profiles WHERE organization_id = ${org_id};
    DELETE FROM teaching_pros          WHERE organization_id = ${org_id}
      AND user_id = ${user_id};
```

## Technical documentation passed alongside the plan

```text
APP UNDER TEST
- kharagolf-web mounted at "/"; page is /coach-workspace.
- api-server at /api/* with cookie sessions and Replit OIDC.
- /api/login?returnTo=<safe-path> auto-redirects there after the bypass
  (unless path is "/" or "/login").

AUTH GOTCHA
- The auth middleware sets req.user = sessions.sess.user. The
  AuthGuard at /coach-workspace bounces role IN ('player','spectator')
  to /portal — so the freshly-bypassed user (defaults to role
  'player') MUST be promoted to a non-player role (use 'coach') in
  BOTH app_users.role AND sessions.sess.user.role via jsonb_set.
  Without the sessions patch the AuthGuard still sees 'player' and
  /coach-workspace → /portal.
- The retry route itself only gates on
  teaching_pros.user_id = req.user.id (no role check), so once the
  AuthGuard lets the user reach /coach-workspace and we have the
  matching teaching_pros row, the POST works.

ENDPOINTS
- GET  /api/coach-marketplace/me/coach-profile
    → { pro: TeachingPro | null, profile: CoachMarketplaceProfile | null }
    The page hides the workspace UI when `pro` is null, so the
    teaching_pros row must exist before navigating to /coach-workspace.
- GET  /api/swing-reviews/coach/earnings
    → { pro, sharePct, summary, payouts: PayoutRow[] }
    Each PayoutRow carries `notification: CoachPayoutNotificationAttempt | null`
    via a left join, so a paid payout legitimately has notification=null
    until the mark-paid path stamps the attempts row.
- POST /api/swing-reviews/coach/payouts/:id/retry-notification
    body: (none)
    → 200 { success: true, resetPush, resetSms } when at least one
      RESETTABLE channel ('failed' or 'skipped') is reset.
    → 400 "Nothing to resend" when both channels are 'sent' / 'no_user' /
      'no_address' / 'opted_out'.
    → 400 "No notification attempt to retry yet" when the payout has
      no attempts row (e.g. still pending).
    → 403 when `teaching_pros.user_id !== req.user.id` OR when the
      caller isn't a registered coach at all.
    → 429 { error: "Please wait...", retryAfterSec } when
      `coachRetryRequestedAt` is within the
      `COACH_PAYOUT_COACH_RETRY_COOLDOWN_MS = 5 * 60 * 1000` window.
    The handler always stamps `coachRetryRequestedAt = now()` on a
    successful 200, which the shared `coachPayoutCanCoachRetry`
    helper then uses to hide the "Try again" button until the
    cooldown elapses.

PAGE LAYOUT (artifacts/kharagolf-web/src/pages/coach-workspace.tsx)
- Three-tab page: Queue / Earnings / Profile (shadcn Tabs).
- The Earnings tab content is the EarningsTab component; it renders
  a "Payouts" card with a `<table>` of payouts, one
  `<tr data-testid="row-coach-payout-${p.id}">` per row.
- The Notification cell inside each row is
  `<td data-testid="cell-coach-notification-${p.id}">` and contains
  the CoachPayoutNotificationCell component.
- CoachPayoutNotificationCell renders, in order:
    badge-coach-notif-push-${payoutId}  (with data-status attr)
    badge-coach-notif-sms-${payoutId}   (with data-status attr)
    note-coach-notif-both-missed-${payoutId}  (only when both channels non-sent)
    button-coach-notif-retry-${payoutId}      (only when canRetry === true)
- canRetry is `coachPayoutCanCoachRetry(notification, Date.now())`
  from `@workspace/coach-payout-labels`. The helper returns true iff:
    - At least one of push/sms is in a RESETTABLE label
      ('failed' / 'failed_exhausted' / 'skipped'), AND
    - notification.coachRetryRequestedAt is null OR > 5 minutes old.
  After a successful 200 the API server stamps
  coachRetryRequestedAt = now(); the next /coach/earnings reload feeds
  that back into the cell, and the helper hides the button.

TOAST
- The handler calls `useToast` (shadcn) with
    title: 'Re-sending your payout notification…'
  on success, or
    title: "Couldn't try again", description: <server error message>,
    variant: 'destructive'
  on a non-2xx response. The shadcn toaster mounts a Radix
  `region[role="status"]` so matching by visible text is the
  recommended way to assert (no per-toast data-testid is set).

DB SCHEMAS (lib/db/src/schema/golf.ts — only the tables this plan touches)
- app_users(id, replit_user_id, email, role, organization_id, ...)
- teaching_pros(id, organization_id, user_id, display_name, ...)
- coach_marketplace_profiles(id, pro_id UNIQUE, organization_id,
    is_listed, revenue_share_pct numeric, async_review_price_paise, ...)
- coach_payouts(id, pro_id, organization_id, period_start, period_end,
    gross_paise, platform_fee_paise, net_payout_paise, status,
    payout_reference, paid_at, paid_notified_at, ...)
    status enum: 'pending' | 'paid' (and friends).
- coach_payout_notification_attempts(id, payout_id UNIQUE, pro_id,
    organization_id, coach_user_id, amount_paise, reference,
    push_status text, push_attempts int, last_push_at, last_push_error,
    last_push_retry_at, push_retry_exhausted_at, push_target_label,
    sms_status text, sms_attempts int, last_sms_at, last_sms_error,
    last_sms_retry_at, sms_retry_exhausted_at, sms_target_masked,
    coach_retry_requested_at, ...).
    Channel statuses: 'sent' | 'failed' | 'skipped' | 'no_user' |
    'no_address' | 'opted_out'.
```

## Mobile parity

The matching mobile flow lives in `artifacts/kharagolf-mobile/app/(tabs)/coach.tsx`
and renders a `Pressable` with `testID="payout-notif-retry-${payoutId}"`
in the same `CoachPayoutNotificationCell`-equivalent component. Both
clients gate the button on the same shared
`coachPayoutCanCoachRetry` helper from
`@workspace/coach-payout-labels`, so a single shared-helper change
flips both surfaces in lockstep.

The mobile button is covered end-to-end against a real `<CoachScreen />`
mount (with mocked fetch + Alert) in
`artifacts/kharagolf-mobile/__tests__/coach-workspace-payout-retry.test.tsx`,
which asserts:
  1. The button renders for a paid payout whose push channel is
     cap-exhausted.
  2. Pressing it POSTs to
     `/api/swing-reviews/coach/payouts/:id/retry-notification`,
     surfaces the "Re-sending your payout notification" `Alert.alert`
     on a 200, and hides the button after the next `/coach/earnings`
     reload returns a fresh `coachRetryRequestedAt`.
  3. A 429 cooldown response surfaces the "Couldn't try again"
     `Alert.alert` carrying the server-supplied error string.

## Last verified

Run on 2026-04-30: status `success`. Baseline assertions passed for
the seeded paid payout (push gave-up badge + SMS sent badge + visible
"Try again" button + no inline "both missed" note). Clicking "Try
again" surfaced the "Re-sending your payout notification" toast, the
EarningsTab reload landed, and the button vanished from the cell while
the surrounding badges remained — push badge flipping to data-status
"failed" and SMS staying "sent". The DB row matched: push_attempts=0,
push_retry_exhausted_at NULL, sms untouched, coach_retry_requested_at
stamped.
