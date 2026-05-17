# E2E: Coach Workspace — payout-account "Notification history" panel

Covers Task #2116. Canonical Playwright `runTest` plan that signs in
as a coach, opens the Profile tab in `/coach-workspace`, and locks
down the rendered behaviour of the `PayoutNotificationHistory` panel
that Task #1701 added underneath the payout-account card.

The backend endpoint
`GET /api/coach-marketplace/me/payout-account/notification-history`
is already covered at the API level in
`artifacts/api-server/src/tests/coach-payout-notification-history.test.ts`
(401 unauth, `{ entries: [] }` for non-coach, newest-first ordering,
no cross-coach leakage, admin-key filter). This plan locks down the
*client-side* render: per-`historyId` grouping, channel labels &
ordering, the status pill text, the inline reason strings (e.g.
`push_opted_out`, `no_email_on_file`), and the empty- and
error-state branches.

Replay it from any agent notebook with
`runTest({ testReplitAuth: true, testPlan, relevantTechnicalDocumentation })`
using the bodies below.

## Page under test

- File: `artifacts/kharagolf-web/src/pages/coach-workspace.tsx`
  (the `PayoutNotificationHistory` component, mounted by
  `PayoutAccountSection` at the bottom of the **Profile** tab).
- Endpoint exercised:
  - `GET /api/coach-marketplace/me/payout-account/notification-history`
- Auth: requires the caller to be a registered teaching pro
  (`teaching_pros.user_id = req.user.id`); the workspace UI hides
  itself with "You aren't registered as a teaching pro" when `pro` is
  null, so the teaching_pros row must be created before navigating.
  In addition the page-level AuthGuard at `/coach-workspace` bounces
  role IN ('player','spectator') to `/portal`, so the freshly-bypassed
  user must be promoted to a non-player role in BOTH `app_users.role`
  AND the cached `sessions.sess.user.role` (via `jsonb_set`) before
  navigating. The `org_role` enum doesn't include a literal `'coach'`
  value — use `'pro_shop'` (a valid enum member that the AuthGuard
  doesn't bounce). The sibling `coach-workspace-retry-notification.e2e.md`
  plan calls out the same gotcha.
- Test ids exercised here (all rendered by `PayoutNotificationHistory`):
  - `payout-notification-history` — the panel root (only present
    when at least one audit row was returned by the endpoint).
  - `payout-notification-history-empty` — the empty-state hint
    (rendered when `entries.length === 0`).
  - `payout-notification-history-error` — the error-state element
    (rendered when the fetch resolves non-2xx OR throws).
  - `payout-notification-history-row-${historyId}` — one `<li>` per
    grouped `coach_payout_account_history` row. `${historyId}` is
    the integer pulled from `payload.historyId`; rows missing a
    historyId fall under the literal key `unattributed`.
  - `payout-notification-channel-${historyId}-${channel}` — one
    chip per channel inside the row. `${channel}` is the raw value
    from `notification_audit_log.channel` (`email` / `in_app` /
    `push`); the visible label uses the friendlier mapping
    (`Email` / `In-app` / `Push`) and the status text below it is
    the raw status with underscores rendered as spaces (e.g.
    `opted_out` → `opted out`).
  - `payout-notification-reason-${historyId}-${channel}` — only
    rendered when the row carries a non-null `reason` (e.g.
    `push_opted_out`, `no_email_on_file`). The reason string is
    surfaced verbatim — no localisation, no transform.

## Test plan

```text
1. [New Context] Create a new browser context.

2. [OIDC] Configure the next login claims to:
   { sub: "test-coach-payout-notif-hist-" + Date.now(),
     email: "coach-payout-notif-hist-e2e-" + Date.now() + "@example.com",
     first_name: "Coach", last_name: "PayoutNotifHist" }

3. [Browser] Navigate to /api/login?returnTo=%2Fcoach-workspace. Wait
   for the redirect chain to settle (OIDC bypass → /coach-workspace).
   The page may briefly redirect to /portal because the freshly-bypassed
   user defaults to role 'player'; that's expected and step 4 fixes it
   before we navigate again.

4. [DB] Promote the freshly-logged-in user to a non-player role AND
   register them as a teaching pro on their org. As with the sibling
   Try Again plan, the role MUST be patched in BOTH app_users.role
   AND the cached sessions.sess.user.role via jsonb_set, otherwise
   the AuthGuard still sees role='player' and bounces
   /coach-workspace → /portal. Use 'pro_shop' (a valid org_role enum
   member) — the enum has no literal 'coach'.

   -- Pick the freshly-created user.
   SELECT id AS user_id, organization_id AS org_id
     FROM app_users ORDER BY id DESC LIMIT 1;

   -- Promote in app_users.
   UPDATE app_users SET role='pro_shop' WHERE id = ${user_id};

   -- Patch the cached session blob too.
   UPDATE sessions
      SET sess = jsonb_set(sess, '{user,role}', '"pro_shop"')
    WHERE (sess->'user'->>'id')::int = ${user_id};

   -- Wipe any pre-existing coach state in this org so the per-row
   -- assertions are stable. The test owns this org for the run.
   DELETE FROM notification_audit_log
     WHERE user_id = ${user_id};
   DELETE FROM coach_marketplace_profiles
     WHERE organization_id = ${org_id};
   DELETE FROM teaching_pros
     WHERE organization_id = ${org_id} AND user_id = ${user_id};

   -- Make the test user a teaching pro on this org. The marketplace
   -- profile isn't strictly needed for THIS panel (it doesn't read
   -- earnings), but PayoutAccountSection lives inside ProfileTab,
   -- which renders unconditionally for any user with a teaching_pros
   -- row, so a profile row is not required to reach the panel.
   INSERT INTO teaching_pros (organization_id, user_id, display_name)
     VALUES (${org_id}, ${user_id}, 'Coach PayoutNotifHist')
     RETURNING id AS pro_id;

5. [Browser] Navigate to /coach-workspace. Wait for the page to settle
   (the heading "Coach Workspace" should be visible). Click the
   "Profile" tab in the page tab strip (it's a shadcn TabsTrigger;
   identifying it by visible text "Profile" is fine — the label is
   English-only in the tab strip).

6. [Verify] EMPTY STATE — the coach has no
   coach.payout.account.changed.coach audit rows yet, so the panel
   renders the empty-state hint:
   - data-testid="payout-notification-history-empty" IS visible.
     Its text contains "No notifications recorded yet".
   - data-testid="payout-notification-history" does NOT exist (the
     panel root is only rendered for a non-empty entries array).
   - data-testid="payout-notification-history-error" does NOT exist.

7. [DB] Seed two payout-account-change events so the populated branch
   has multiple groups, multiple channels, and a mix of statuses with
   and without a reason string. The newer batch (historyId=200) must
   render first because the panel sorts groups by their newest
   createdAt descending.

   -- Older batch: account-change history row #100. All three legs.
   -- Push leg was opted-out (reason carries the canonical
   -- `push_opted_out` string the API-level test mirrors).
   INSERT INTO notification_audit_log
     (notification_key, user_id, channel, status, reason, payload, created_at)
   VALUES
     ('coach.payout.account.changed.coach', ${user_id},
      'email',  'sent', NULL,
      jsonb_build_object('historyId', 100, 'proId', ${pro_id},
                         'organizationId', ${org_id}),
      now() - interval '10 minutes'),
     ('coach.payout.account.changed.coach', ${user_id},
      'in_app', 'sent', NULL,
      jsonb_build_object('historyId', 100, 'proId', ${pro_id},
                         'organizationId', ${org_id}),
      now() - interval '10 minutes'),
     ('coach.payout.account.changed.coach', ${user_id},
      'push',   'opted_out', 'push_opted_out',
      jsonb_build_object('historyId', 100, 'proId', ${pro_id},
                         'organizationId', ${org_id}),
      now() - interval '10 minutes');

   -- Newer batch: history row #200. Email skipped because the coach
   -- has no email on file (reason `no_email_on_file`); in-app + push
   -- both went out. This batch should render FIRST in the panel.
   INSERT INTO notification_audit_log
     (notification_key, user_id, channel, status, reason, payload, created_at)
   VALUES
     ('coach.payout.account.changed.coach', ${user_id},
      'email',  'no_address', 'no_email_on_file',
      jsonb_build_object('historyId', 200, 'proId', ${pro_id},
                         'organizationId', ${org_id}),
      now()),
     ('coach.payout.account.changed.coach', ${user_id},
      'in_app', 'sent', NULL,
      jsonb_build_object('historyId', 200, 'proId', ${pro_id},
                         'organizationId', ${org_id}),
      now()),
     ('coach.payout.account.changed.coach', ${user_id},
      'push',   'sent', NULL,
      jsonb_build_object('historyId', 200, 'proId', ${pro_id},
                         'organizationId', ${org_id}),
      now());

   -- Cross-coach / cross-key noise that MUST NOT leak into the panel:
   -- (a) the admin-side fanout under the same coach,
   -- (b) a coach-key row attributed to a different user.
   -- We don't assert on these directly here (the API integration test
   -- already does), but seeding them mirrors realistic prod state and
   -- guards against a regression where the panel starts rendering
   -- them.
   INSERT INTO notification_audit_log
     (notification_key, user_id, channel, status, reason, payload, created_at)
   VALUES
     ('coach.payout.account.changed.admin', ${user_id},
      'email', 'sent', NULL,
      jsonb_build_object('historyId', 999, 'proId', ${pro_id},
                         'organizationId', ${org_id}),
      now());

8. [Browser] Reload the /coach-workspace page (the panel re-fetches
   on mount; a full navigation is the simplest way to pick up the
   newly-seeded rows). After the reload click the "Profile" tab again.

9. [Verify] POPULATED STATE — the panel root and both grouped rows
   are visible, ordered newest-first, with the correct channel chips:
   - data-testid="payout-notification-history" IS visible. Its text
     contains "Notification history".
   - data-testid="payout-notification-history-empty" does NOT exist.
   - data-testid="payout-notification-history-error" does NOT exist.

   -- Grouping: one row per historyId.
   - data-testid="payout-notification-history-row-200" IS visible
     and appears BEFORE the row for historyId=100 in DOM order
     (newest-first).
   - data-testid="payout-notification-history-row-100" IS visible.

   -- Newest batch (#200): email skipped + in-app sent + push sent.
   - data-testid="payout-notification-channel-200-email" IS visible.
     Its text contains "Email" (the friendly channel label) and
     "no address" (the raw `no_address` status with the underscore
     rendered as a space). It is rendered BEFORE the in-app and push
     chips inside its row (channel order is email → in_app → push).
   - data-testid="payout-notification-reason-200-email" IS visible
     and its text equals "no_email_on_file" verbatim — the reason
     string is surfaced as-is, not localised.
   - data-testid="payout-notification-channel-200-in_app" IS visible.
     Its text contains "In-app" and "sent".
   - data-testid="payout-notification-reason-200-in_app" does NOT
     exist (no reason string was seeded for this leg).
   - data-testid="payout-notification-channel-200-push" IS visible.
     Its text contains "Push" and "sent".
   - data-testid="payout-notification-reason-200-push" does NOT
     exist.

   -- Older batch (#100): email sent + in-app sent + push opted-out.
   - data-testid="payout-notification-channel-100-email" IS visible.
     Its text contains "Email" and "sent".
   - data-testid="payout-notification-channel-100-in_app" IS visible.
     Its text contains "In-app" and "sent".
   - data-testid="payout-notification-channel-100-push" IS visible.
     Its text contains "Push" and "opted out" (the raw `opted_out`
     status with the underscore rendered as a space).
   - data-testid="payout-notification-reason-100-push" IS visible
     and its text equals "push_opted_out" verbatim.

   -- No leakage from other notification keys: the admin-key row
   -- seeded with historyId=999 must never produce a
   -- payout-notification-history-row-999 element (the endpoint
   -- filters by COACH_PAYOUT_NOTIFY_KEY).
   - data-testid="payout-notification-history-row-999" does NOT
     exist.

10. [Browser] ERROR STATE — register a Playwright route handler so the
    next request to
    /api/coach-marketplace/me/payout-account/notification-history
    is intercepted and answered with HTTP 500 + JSON body
    `{ "error": "boom from the route mock" }`. Then reload the page
    and click the "Profile" tab again. The panel's `useEffect` will
    fire a fresh fetch, see the non-OK response, and switch to the
    error branch.

    Implementation hint for the testing agent: use
    `await page.route('**/api/coach-marketplace/me/payout-account/notification-history',
       route => route.fulfill({ status: 500, contentType: 'application/json',
                                body: JSON.stringify({ error: 'boom from the route mock' }) }));`
    BEFORE navigating, then `await page.reload()`.

11. [Verify] ERROR STATE — the panel is in the error branch:
    - data-testid="payout-notification-history-error" IS visible
      and its text contains "boom from the route mock" (the panel
      surfaces the server-supplied `error` field verbatim, falling
      back to "Failed to load notification history" only when the
      JSON body has no `error` field).
    - data-testid="payout-notification-history" does NOT exist (the
      populated panel root is only rendered when the fetch
      succeeded).
    - data-testid="payout-notification-history-empty" does NOT
      exist (the empty-state branch is gated on a successful fetch
      that returned an empty entries array, NOT on a network error).
    - data-testid="payout-notification-history-row-200" does NOT
      exist anymore (the previous successful fetch's render is
      replaced by the error branch).

12. [Browser] Unroute the interception
    (`await page.unroute('**/api/coach-marketplace/me/payout-account/notification-history')`)
    so the cleanup steps below see real responses again. This also
    keeps the run idempotent if the test plan is replayed back-to-back
    in the same browser context.

13. [DB] Cleanup — wipe the seeded rows so subsequent test runs
    start from a clean slate:
    DELETE FROM notification_audit_log
      WHERE user_id = ${user_id};
    DELETE FROM coach_marketplace_profiles
      WHERE organization_id = ${org_id};
    DELETE FROM teaching_pros
      WHERE organization_id = ${org_id} AND user_id = ${user_id};
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
- The notification-history endpoint itself only requires
  authentication; if the caller isn't a registered teaching pro it
  returns 200 { entries: [] } so the page doesn't have to
  special-case 404. But the workspace page hides its UI ("You aren't
  registered as a teaching pro…") when `me.pro` is null, so the
  teaching_pros row must exist before navigating to /coach-workspace
  for the panel to render at all.

ENDPOINT
- GET /api/coach-marketplace/me/payout-account/notification-history
    → 200 { entries: AuditEntry[] }
    AuditEntry = {
      id: number,
      channel: 'email' | 'in_app' | 'push' | string,
      status: 'sent' | 'failed' | 'skipped' | 'opted_out' |
              'no_address' | string,
      reason: string | null,         // verbatim, e.g. 'push_opted_out',
                                     // 'no_email_on_file'
      historyId: number | null,      // pulled from payload.historyId
      createdAt: string,             // ISO timestamp
    }
    Filtered server-side to:
      notification_audit_log.user_id = req.user.id
      notification_audit_log.notification_key
        = 'coach.payout.account.changed.coach'
    Ordered by created_at DESC, capped at limit=200 by default.
    Returns { entries: [] } (NOT 404) when the caller has no
    teaching_pros row, so the workspace UI never has to special-case
    the "not yet a coach" branch.

CLIENT GROUPING / RENDERING (PayoutNotificationHistory in
artifacts/kharagolf-web/src/pages/coach-workspace.tsx)
- Fires on mount and on every refreshKey bump
  (PayoutAccountSection bumps refreshKey after the coach saves a
  new payout account).
- Rendering states:
    error          → <div data-testid="payout-notification-history-error">
                       {error message text}
                     </div>
                     The error string is whatever the server returned
                     in `error`, falling back to
                     "Failed to load notification history" if the
                     response body had no `error` field, or to the
                     thrown Error.message if the fetch itself rejected.
    loading        → "Loading notification history…"
                     (no data-testid; transient, don't assert on it)
    empty          → <div data-testid="payout-notification-history-empty">
                       "No notifications recorded yet…"
                     </div>
    populated      → <div data-testid="payout-notification-history">
                       <div>"Notification history"</div>
                       <ul>
                         <li data-testid="payout-notification-history-row-${groupKey}"> …
                       </ul>
                     </div>
- Grouping:
    - Entries are bucketed by historyId (entries with historyId=null
      fall under the literal string key 'unattributed'). Each bucket
      becomes one <li>.
    - Buckets are sorted by their newest createdAt DESCENDING and
      sliced to the first 5, so the panel never renders more than
      five history blocks even if the endpoint returns more rows.
    - Within a bucket, channels render in the canonical order
      email → in_app → push, with any unknown channel keys appended
      after.
    - When more than one row exists for the same (historyId, channel)
      tuple, the LATEST row (by createdAt) wins.
- Per-channel chip:
    - data-testid="payout-notification-channel-${groupKey}-${channel}"
    - Visible label uses the friendly map:
        email   → "Email"
        in_app  → "In-app"
        push    → "Push"
        unknown → raw channel key
    - Status line: r.status.replace(/_/g, ' '), capitalised via CSS
      (`capitalize`). So 'opted_out' renders as "opted out",
      'no_address' as "no address", 'sent' as "sent", etc. Assertions
      should match the lowercase raw text — the capitalisation is a
      CSS transform and is NOT in the DOM text content.
    - When `r.reason` is non-null, an inner
      <div data-testid="payout-notification-reason-${groupKey}-${channel}">
      is rendered with the reason string verbatim (no transform, no
      localisation).
- Status tone (CSS classes only — no data-status attr is exposed
  for the chip, so assertions key off testid + text only):
    sent                         → emerald (bg-emerald-900/40 …)
    failed                       → red     (bg-red-900/40 …)
    opted_out / no_address /
       skipped                   → amber   (bg-amber-900/40 …)
    everything else              → zinc    (bg-zinc-800 …)

DB SCHEMA (lib/db/src/schema/golf.ts — only the tables this plan touches)
- app_users(id, replit_user_id, email, role, organization_id, …)
- teaching_pros(id, organization_id, user_id, display_name, …)
- coach_marketplace_profiles(id, pro_id UNIQUE, organization_id, …)
- notification_audit_log(
    id serial primary key,
    notification_key text not null,
    user_id integer references app_users(id) on delete set null,
    channel text not null,
    status text not null,
    reason text,
    payload jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now()
  )
  Channel values used by the coach payout fanout:
    'email' | 'in_app' | 'push'.
  Status values:
    'sent' | 'failed' | 'skipped' | 'opted_out' | 'no_address'.
  payload.historyId is the integer id of the
  coach_payout_account_history row that triggered the fanout.
  notification_key for the coach-side leg is the literal string
  'coach.payout.account.changed.coach' (admin-side is
  'coach.payout.account.changed.admin' — must NOT show up in this
  endpoint).
```

## Last verified

Run on 2026-04-30: status `success`. Empty state: with the freshly-
seeded coach (no audit rows), `payout-notification-history-empty`
rendered and the panel root + error markers were absent. Populated
state: after seeding the historyId=100 (`email sent` / `in_app sent` /
`push opted_out` + `push_opted_out` reason) and historyId=200
(`email no_address` + `no_email_on_file` reason / `in_app sent` /
`push sent`) batches plus the noise admin-key row, the panel rendered
both `payout-notification-history-row-200` (newest-first) and
`payout-notification-history-row-100` with the six expected channel
chips, the two reason chips carrying the verbatim reason strings,
and no row for the admin-key historyId=999. Error state: with the
endpoint route-mocked to a 500 carrying
`{"error":"boom from the route mock"}`, `payout-notification-history-error`
rendered with the server-supplied message and the populated panel
root vanished.
