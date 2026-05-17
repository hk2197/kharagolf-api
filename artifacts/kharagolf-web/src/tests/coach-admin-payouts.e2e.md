# E2E: Coach Revenue & Payouts admin screen

Covers Task #765. Canonical Playwright `runTest` plan for the
`/coach-admin` page that walks an org admin through editing a coach's
revenue share %, running a payout batch, and marking the resulting
payout as paid. Mirrors the backend coverage in
`artifacts/api-server/src/tests/coach-admin-payouts.test.ts` (Task #612).

Replay it from any agent notebook with
`runTest({ testReplitAuth: true, testPlan, relevantTechnicalDocumentation })`
using the bodies below.

## Page under test

- File: `artifacts/kharagolf-web/src/pages/coach-admin.tsx`
- Endpoints exercised:
  - `GET  /api/coach-marketplace/admin/coaches`
  - `POST /api/coach-marketplace/pros/:proId/revenue-share`
  - `GET  /api/swing-reviews/admin/payouts`
  - `POST /api/swing-reviews/admin/payouts/run`
  - `POST /api/swing-reviews/admin/payouts/:id/mark-paid`
- Auth: requires `org_admin` / `super_admin`. `req.user` is read from
  `sessions.sess.user`, so promoting the freshly-logged-in user must
  patch BOTH `app_users.role` AND the cached session blob.
- Test ids exercised here:
  - `page-coach-admin` — page container
  - `button-run-payout-batch` — top-right "Run payout batch" button
  - `row-coach-${proId}` — one row per coach
  - `text-coach-name-${proId}` — coach display name cell
  - `text-lifetime-gross-${proId}` / `text-lifetime-net-${proId}` /
    `text-outstanding-${proId}` — totals cells
  - `input-share-${proId}` — revenue-share number input
  - `button-save-share-${proId}` — save button (only visible while editing)
  - `row-payout-${payoutId}` — one row per payout
  - `badge-status-${payoutId}` — pending / paid badge
  - `button-mark-paid-${payoutId}` — opens the mark-paid dialog
  - `dialog-mark-paid` / `input-reference` / `input-notes` /
    `button-confirm-mark-paid` — mark-paid dialog

## Test plan

```text
1. [New Context] Create a new browser context.

2. [OIDC] Configure the next login claims to:
   { sub: "test-coachadmin-" + Date.now(),
     email: "coachadmin-e2e-" + Date.now() + "@example.com",
     first_name: "Coach", last_name: "Admin" }

3. [Browser] Navigate to /api/login?returnTo=%2F. Wait for the redirect
   chain to settle. Don't visually verify yet.

4. [DB] Promote the freshly-logged-in user to org_admin in BOTH the
   app_users table AND the active session blob (req.user is read from
   sessions.sess.user, not the DB). Then seed an isolated org-scoped
   coach + delivered swing-review request so the page has deterministic
   numbers regardless of any pre-existing data.

   UPDATE app_users SET role='org_admin'
     WHERE id = (SELECT id FROM app_users ORDER BY id DESC LIMIT 1)
     RETURNING id AS user_id, organization_id AS org_id;

   UPDATE sessions
      SET sess = jsonb_set(jsonb_set(sess, '{user,role}', '"org_admin"'),
                            '{user,organizationId}', to_jsonb(${org_id}::int))
    WHERE (sess->'user'->>'id')::int = ${user_id};

   -- Wipe any pre-existing coaches/payouts/reviews in this org so the
   -- per-coach asserts and the "Payouts" count are predictable. The
   -- test owns this org for the run.
   UPDATE swing_review_requests SET payout_id = NULL
     WHERE organization_id = ${org_id};
   DELETE FROM coach_payouts          WHERE organization_id = ${org_id};
   DELETE FROM swing_review_requests  WHERE organization_id = ${org_id};
   DELETE FROM coach_marketplace_profiles WHERE organization_id = ${org_id};
   DELETE FROM teaching_pros          WHERE organization_id = ${org_id};

   -- Coach user (not strictly needed for the math, but matches reality
   -- where every teaching_pro has a backing app_users row).
   INSERT INTO app_users (replit_user_id, username, email, display_name,
                          role, organization_id)
     VALUES ('coach-e2e-' || floor(random()*1000000)::int,
             'coach_e2e_' || floor(random()*1000000)::int,
             'coach-e2e-' || floor(random()*1000000)::int || '@example.com',
             'E2E Coach', 'player', ${org_id})
     RETURNING id AS coach_user_id;

   INSERT INTO teaching_pros (organization_id, user_id, display_name)
     VALUES (${org_id}, ${coach_user_id}, 'E2E Coach')
     RETURNING id AS pro_id;

   -- 80% revenue share, NO payout account on file → run-batch will
   -- leave the resulting payout in 'pending' (exactly the path mark-paid
   -- is for).
   INSERT INTO coach_marketplace_profiles
     (pro_id, organization_id, is_listed, revenue_share_pct,
      async_review_price_paise)
     VALUES (${pro_id}, ${org_id}, true, '80', 50000);

   INSERT INTO swing_videos (user_id, organization_id, video_url)
     VALUES (${user_id}, ${org_id}, 'https://example.com/e2e.mp4')
     RETURNING id AS video_id;

   -- One delivered review @ ₹500 (50000 paise).
   INSERT INTO swing_review_requests
     (organization_id, pro_id, user_id, swing_video_id, price_paise,
      status, escrow_held, delivered_at)
     VALUES (${org_id}, ${pro_id}, ${user_id}, ${video_id}, 50000,
             'delivered', true, now());

5. [Browser] Navigate to /coach-admin. Wait for data-testid="page-coach-admin"
   and for data-testid="row-coach-${pro_id}" to render. Dismiss any Vite
   runtime overlay if present.

6. [Verify] BASELINE — coach row reflects the seeded delivered review
   at the seeded 80% share:
   - data-testid="text-coach-name-${pro_id}" text equals "E2E Coach".
   - data-testid="input-share-${pro_id}" value equals "80".
   - data-testid="text-lifetime-gross-${pro_id}" contains "₹500".
   - data-testid="text-lifetime-net-${pro_id}"   contains "₹400".
     (80% of ₹500 = ₹400.)
   - data-testid="text-outstanding-${pro_id}"    contains "₹400".
     (Same review — not yet attached to a payout.)
   - data-testid="text-no-payouts" IS visible (no batches run yet).

7. [Browser] EDIT REVENUE SHARE — focus data-testid="input-share-${pro_id}",
   clear it, type "60", then click data-testid="button-save-share-${pro_id}".
   Wait until the save button disappears (the row leaves edit mode after
   the toast + reload).

8. [Verify] LIFETIME + OUTSTANDING NET RECOMPUTED at the new 60% share:
   - data-testid="input-share-${pro_id}" value equals "60".
   - data-testid="text-lifetime-gross-${pro_id}" still contains "₹500"
     (gross is unchanged — only the share % changed).
   - data-testid="text-lifetime-net-${pro_id}"   contains "₹300".
     (60% of ₹500 = ₹300.)
   - data-testid="text-outstanding-${pro_id}"    contains "₹300".

9. [Browser] RUN PAYOUT BATCH — click data-testid="button-run-payout-batch"
   and wait until a new data-testid^="row-payout-" row appears AND
   data-testid="text-outstanding-${pro_id}" updates to "₹0" (the seeded
   review is now attached to the freshly created payout).

10. [DB] Capture the new payout id so subsequent steps can target it:
    SELECT id AS payout_id, status, net_payout_paise
      FROM coach_payouts
     WHERE organization_id = ${org_id}
     ORDER BY id DESC LIMIT 1;
    Expect status = 'pending' and net_payout_paise = 30000 (₹300).

11. [Verify] OUTSTANDING IS CLEARED + PENDING PAYOUT ROW IS PRESENT:
    - data-testid="text-outstanding-${pro_id}" contains "₹0" and
      "0 unpaid".
    - data-testid="row-payout-${payout_id}" IS visible.
    - data-testid="badge-status-${payout_id}" text contains "Pending".
    - data-testid="button-mark-paid-${payout_id}" IS visible.
    - data-testid="text-no-payouts" does NOT exist.

12. [Browser] OPEN MARK-PAID DIALOG — click
    data-testid="button-mark-paid-${payout_id}". Wait for
    data-testid="dialog-mark-paid" to render.

13. [Browser] Fill the dialog and confirm:
    - data-testid="input-reference" — type "UPI-E2E-${Date.now()}"
      (any non-empty value; remember the literal value used as
      ${reference}).
    - data-testid="input-notes" — type "settled by e2e".
    - Click data-testid="button-confirm-mark-paid". Wait for
      data-testid="dialog-mark-paid" to disappear AND for
      data-testid="badge-status-${payout_id}" text to change from
      "Pending" to "Paid".

14. [Verify] PAYOUT IS NOW MARKED PAID ON THE SCREEN:
    - data-testid="badge-status-${payout_id}" text contains "Paid".
    - data-testid="button-mark-paid-${payout_id}" does NOT exist
      (the action button only renders while status === 'pending').
    - data-testid="text-outstanding-${pro_id}" still contains "₹0"
      (the review stays attached to the now-paid payout).

15. [DB] Verify the mark-paid call persisted the reference + paid_at,
    and that the originating review is still attached to the payout:
    SELECT status, payout_reference, notes, paid_at
      FROM coach_payouts WHERE id = ${payout_id};
    -- expect status='paid', payout_reference='UPI-E2E-…',
    -- notes='settled by e2e', paid_at IS NOT NULL.

    SELECT count(*)::int AS attached
      FROM swing_review_requests
     WHERE organization_id = ${org_id} AND payout_id = ${payout_id};
    -- expect attached = 1.

16. [DB] Cleanup:
    UPDATE swing_review_requests SET payout_id = NULL
      WHERE organization_id = ${org_id};
    DELETE FROM coach_payouts          WHERE organization_id = ${org_id};
    DELETE FROM swing_review_requests  WHERE organization_id = ${org_id};
    DELETE FROM swing_videos           WHERE organization_id = ${org_id};
    DELETE FROM coach_marketplace_profiles WHERE organization_id = ${org_id};
    DELETE FROM teaching_pros          WHERE organization_id = ${org_id};
    DELETE FROM app_users              WHERE id = ${coach_user_id};
```

## Technical documentation passed alongside the plan

```text
APP UNDER TEST
- kharagolf-web mounted at "/"; page is /coach-admin.
- api-server at /api/* with cookie sessions and Replit OIDC.
- /api/login?returnTo=<safe-path> auto-redirects there after the bypass
  (unless path is "/" or "/login").

AUTH GOTCHA
- The auth middleware sets req.user = sessions.sess.user. Updating
  app_users.role does NOT change req.user; you MUST also patch
  sessions.sess via jsonb_set as in step 4. Without that the
  /coach-marketplace/admin/* and /swing-reviews/admin/* endpoints
  return 403.

ENDPOINTS
- GET  /api/coach-marketplace/admin/coaches
    → { coaches: AdminCoach[] } where each row carries lifetimeGrossPaise,
      lifetimeNetPayoutPaise, outstandingGrossPaise,
      outstandingNetPayoutPaise, outstandingCount, deliveredCount,
      revenueSharePct.
    → lifetimeNet = lifetimeGross * revenueSharePct/100 evaluated at
      the *current* share %, so editing the share % immediately changes
      both lifetimeNet and outstandingNet on the next refresh.
- POST /api/coach-marketplace/pros/:proId/revenue-share
    body: { revenueSharePct: number 0–100 }
    → upserts coach_marketplace_profiles.revenue_share_pct.
- GET  /api/swing-reviews/admin/payouts
    → { payouts: PayoutRow[] }, one row per coach_payouts row in the org.
- POST /api/swing-reviews/admin/payouts/run
    → aggregates delivered + payout_id IS NULL swing_review_requests into
      one coach_payouts row per pro. Coaches without a registered payout
      account land in 'pending' with a failureReason set.
- POST /api/swing-reviews/admin/payouts/:id/mark-paid
    body: { reference: string, notes?: string }
    → flips status to 'paid', stamps paid_at + payout_reference + notes.
- All admin routes require role org_admin / super_admin (treasurer is NOT
  accepted on this surface).

PAGE LAYOUT (artifacts/kharagolf-web/src/pages/coach-admin.tsx)
- Container: data-testid="page-coach-admin".
- Top bar: data-testid="button-refresh", data-testid="button-run-payout-batch".
- "Coaches" card → table with one row per coach:
    data-testid="row-coach-${proId}"
      text-coach-name-${proId}, badge-listed-${proId}|badge-unlisted-${proId},
      input-share-${proId}, button-save-share-${proId} (only while editing),
      text-lifetime-gross-${proId}, text-lifetime-net-${proId},
      text-outstanding-${proId}.
    Outstanding cell renders the net + a "${count} unpaid · gross …"
    sub-line, so assertions should use "contains" on the rupee string.
- "Payouts" card → table with one row per payout:
    data-testid="row-payout-${payoutId}"
      badge-status-${payoutId} ("Pending" or "Paid"),
      button-mark-paid-${payoutId} (only while status === 'pending'),
      data-testid="text-no-payouts" empty state when none exist.
- Mark-paid modal: data-testid="dialog-mark-paid"
    input-reference (required, non-empty),
    input-notes (optional),
    button-confirm-mark-paid, button-cancel.

RUPEE FORMATTING
- formatRupees(paise) = `₹${(paise/100).toLocaleString('en-IN')}`, so
  50000 paise → "₹500", 30000 paise → "₹300", 0 paise → "₹0".
- Use "contains" matchers because the cells include extra context lines
  (e.g. "1 delivered" under lifetime gross, "0 unpaid · gross ₹0"
  under outstanding).

DB SCHEMAS (lib/db/src/schema/golf.ts)
- sessions(sid varchar pk, sess jsonb, expire timestamp)
- app_users(id, replit_user_id, email, role, organization_id, ...)
- teaching_pros(id, organization_id, user_id, display_name, ...)
- coach_marketplace_profiles(id, pro_id UNIQUE, organization_id,
    is_listed, revenue_share_pct numeric, async_review_price_paise,
    payout_account_id, ...)
- swing_videos(id, user_id, organization_id, video_url, ...)
- swing_review_requests(id, organization_id, pro_id, user_id,
    swing_video_id, price_paise, status, escrow_held, delivered_at,
    payout_id, ...)  -- status enum includes 'delivered'.
- coach_payouts(id, pro_id, organization_id, period_start, period_end,
    gross_paise, platform_fee_paise, net_payout_paise, status,
    payout_reference, notes, paid_at, failure_reason, ...)
    status enum: 'pending' | 'paid' (and friends).

OUTSTANDING SEMANTICS (matches the SQL behind /admin/coaches)
- Outstanding = sum over swing_review_requests with status='delivered'
  AND payout_id IS NULL.
- Once run-batch links a review to a coach_payouts row via payout_id,
  it leaves "outstanding" but stays in "lifetime gross/net".
```

## Last verified

Run on 2026-04-19: status `success`. Baseline ₹500 gross / ₹400 net /
₹400 outstanding at 80% share → edited share to 60% and recomputed to
₹300 net / ₹300 outstanding → ran payout batch, outstanding cleared to
₹0 and pending payout row appeared → mark-paid dialog accepted reference
+ notes and the badge flipped to "Paid" with no remaining "Mark paid"
button → DB confirmed status=paid, payout_reference + notes + paid_at
persisted, originating review still attached. Cleanup ran cleanly.
