# E2E: Levy charge receipt notifications widget

Covers Task #308. This is the canonical Playwright `runTest` plan for the
`LevyChargeReceipts` component on the Member 360 levy/charge detail panel.
Replay it from any agent notebook with `runTest({ testReplitAuth: true,
testPlan, relevantTechnicalDocumentation })` using the bodies below.

## Component under test

- File: `artifacts/kharagolf-web/src/pages/club-members.tsx` → `LevyChargeReceipts`
- Endpoint: `GET /api/organizations/:orgId/members-360/levies/:id/charges/:memberId/receipts`
- Auth: requires `org_admin` / `super_admin` / `membership_secretary` / `treasurer`.
  `req.user` is taken from `sessions.sess.user`, so the test must patch the
  cached session JSON in addition to `app_users.role`.
- Test ids:
  - `levy-charge-receipts-${memberId}` – widget container
  - `levy-receipt-attempt-${attemptId}` – one row per attempt
  - `levy-receipt-push-${attemptId}` / `levy-receipt-sms-${attemptId}` – channel badges
  - `levy-receipt-push-exhausted-${attemptId}` / `levy-receipt-sms-exhausted-${attemptId}` – exhaustion pills

## Test plan

```text
1. [New Context] Create a new browser context.

2. [OIDC] Configure the next login claims to:
   { sub: "test-receipts-" + Date.now(),
     email: "receipts-e2e-" + Date.now() + "@example.com",
     first_name: "Receipts", last_name: "Tester" }

3. [Browser] Navigate to /api/login?returnTo=%2F. Wait for the redirect chain
   to settle. Don't visually verify yet.

4. [DB] Promote the freshly-logged-in user to org_admin in BOTH the app_users
   table AND inside the active session blob (req.user is read from
   sessions.sess.user, not the DB). Then seed levy/charge/receipt data:

   UPDATE app_users SET role='org_admin'
     WHERE id = (SELECT id FROM app_users ORDER BY id DESC LIMIT 1)
     RETURNING id AS user_id, organization_id AS org_id;

   UPDATE sessions
      SET sess = jsonb_set(jsonb_set(sess, '{user,role}', '"org_admin"'),
                            '{user,organizationId}', to_jsonb(${org_id}::int))
    WHERE (sess->'user'->>'id')::int = ${user_id};

   INSERT INTO club_members (organization_id, first_name, last_name, email)
     VALUES (${org_id}, 'E2E', 'Receipts',
             'e2e-receipts-' || floor(random()*1000000)::int || '@example.com')
     RETURNING id AS member_id;

   INSERT INTO member_levies
     (organization_id, name, amount, currency, status, applied_at, applied_by_user_id)
     VALUES (${org_id}, 'E2E Receipts Levy ' || floor(random()*100000)::int,
             '100.00', 'INR', 'applied', now(), ${user_id})
     RETURNING id AS levy_id;

   INSERT INTO member_levy_charges
     (levy_id, club_member_id, amount, paid, status, paid_amount)
     VALUES (${levy_id}, ${member_id}, '100.00', false, 'unpaid', '0')
     RETURNING id AS charge_id;

   -- Healthy attempt: push 1/5 sent, sms 1/5 sent
   INSERT INTO member_levy_receipt_attempts
     (organization_id, charge_id, club_member_id, kind, levy_name, currency,
      transaction_amount, new_balance,
      push_status, push_attempts, sms_status, sms_attempts)
     VALUES (${org_id}, ${charge_id}, ${member_id}, 'payment',
             'E2E Receipts Levy', 'INR', '40.00', '60.00',
             'sent', 1, 'sent', 1)
     RETURNING id AS healthy_attempt_id;

   -- Exhausted attempt: push 5/5 failed + push_retry_exhausted_at set,
   -- sms still healthy at 3/5
   INSERT INTO member_levy_receipt_attempts
     (organization_id, charge_id, club_member_id, kind, levy_name, currency,
      transaction_amount, new_balance,
      push_status, push_attempts, last_push_at, last_push_error,
      last_push_retry_at, push_retry_exhausted_at,
      sms_status, sms_attempts)
     VALUES (${org_id}, ${charge_id}, ${member_id}, 'refund',
             'E2E Receipts Levy', 'INR', '20.00', '80.00',
             'failed', 5, now(), 'apns gateway 500', now(), now(),
             'sent', 3)
     RETURNING id AS exhausted_attempt_id;

5. [Browser] Navigate to /club-members?openLevy=${levy_id}. Wait for the levy
   detail dialog to render its charges table. Dismiss any Vite runtime overlay.

6. [Browser] Click data-testid="button-activity-${charge_id}" to expand the
   charge activity panel. Wait until data-testid="levy-charge-receipts-${member_id}"
   has rendered past "Loading receipt notifications…" and shows both rows.

7. [Verify] Inside data-testid="levy-charge-receipts-${member_id}":
   - Heading "Receipt notifications" is visible.
   - Both attempt rows present:
       data-testid="levy-receipt-attempt-${healthy_attempt_id}"
       data-testid="levy-receipt-attempt-${exhausted_attempt_id}"

8. [Verify] HEALTHY row data-testid="levy-receipt-attempt-${healthy_attempt_id}":
   - Kind label = "Payment".
   - data-testid="levy-receipt-push-${healthy_attempt_id}" contains "push: sent" and "1/5".
   - data-testid="levy-receipt-sms-${healthy_attempt_id}"  contains "sms: sent"  and "1/5".
   - data-testid="levy-receipt-push-exhausted-${healthy_attempt_id}" does NOT exist.
   - data-testid="levy-receipt-sms-exhausted-${healthy_attempt_id}"  does NOT exist.

9. [Verify] EXHAUSTED-PUSH row data-testid="levy-receipt-attempt-${exhausted_attempt_id}":
   - Kind label = "Refund".
   - data-testid="levy-receipt-push-${exhausted_attempt_id}" contains "push: failed" and "5/5".
   - data-testid="levy-receipt-push-exhausted-${exhausted_attempt_id}" IS visible
     and contains "push exhausted".
   - data-testid="levy-receipt-sms-${exhausted_attempt_id}"  contains "sms: sent" and "3/5".
   - data-testid="levy-receipt-sms-exhausted-${exhausted_attempt_id}" does NOT exist.

10. [DB] Cleanup:
    DELETE FROM member_levies WHERE id = ${levy_id};
    DELETE FROM club_members  WHERE id = ${member_id};
```

## Technical documentation passed alongside the plan

```text
APP UNDER TEST
- kharagolf-web mounted at "/"; page is /club-members.
- api-server at /api/* with cookie sessions and Replit OIDC.
- /api/login?returnTo=<safe-path> auto-redirects there after the bypass
  (unless path is "/" or "/login").

AUTH GOTCHA
- The auth middleware sets req.user = sessions.sess.user. Updating
  app_users.role does NOT change req.user; you MUST also patch
  sessions.sess via jsonb_set as in step 4. Without that the
  receipts/charges endpoints return 403.

ENDPOINTS
- GET /api/organizations/:orgId/members-360/levies/:id/charges
  → loads dialog body.
- GET /api/organizations/:orgId/members-360/levies/:id/charges/:memberId/receipts
  → widget under test.
- Both require role org_admin / super_admin / membership_secretary / treasurer.
- Receipts response: { attempts:[...], maxPushAttempts:5, maxSmsAttempts:5, ... }
  ordered by created_at DESC.

WIDGET (artifacts/kharagolf-web/src/pages/club-members.tsx → LevyChargeReceipts)
- Container: data-testid="levy-charge-receipts-${memberId}",
  header "Receipt notifications".
- Each row: data-testid="levy-receipt-attempt-${attemptId}":
  - Kind chip (capitalised): "Payment" | "Refund" | "Partial payment" | "Waiver"
  - Push badge: data-testid="levy-receipt-push-${attemptId}"
       text "push: <status> · <attempts>/<maxPush>"
  - SMS badge:  data-testid="levy-receipt-sms-${attemptId}"
       text "sms: <status> · <attempts>/<maxSms>"
  - Push-exhausted pill (when push_retry_exhausted_at is set):
       data-testid="levy-receipt-push-exhausted-${attemptId}" text "push exhausted"
  - SMS-exhausted pill  (when sms_retry_exhausted_at  is set):
       data-testid="levy-receipt-sms-exhausted-${attemptId}"  text "sms exhausted"
- Max attempts default to 5 → badges read "X/5".

ENTRY POINT
- /club-members?openLevy=<levyId> auto-opens the levy detail dialog
  (setOpenLevyId on mount).
- Each charge row has [data-testid="button-activity-${chargeId}"]
  to expand the activity panel that mounts <LevyChargeReceipts />.

DB SCHEMAS (lib/db/src/schema/golf.ts)
- sessions(sid varchar pk, sess jsonb, expire timestamp)
- app_users(id, replit_user_id, email, role, organization_id, ...)
- club_members(id, organization_id, first_name, last_name, email, ...)
- member_levies(id, organization_id, name, amount, currency, status,
                applied_at, applied_by_user_id, ...)
- member_levy_charges(id, levy_id, club_member_id, amount, paid, status,
                     paid_amount, ...)
- member_levy_receipt_attempts(id, organization_id, charge_id, club_member_id,
   kind, levy_name, currency, transaction_amount, new_balance, note, created_at,
   push_status, push_attempts, last_push_at, last_push_error,
     last_push_retry_at, push_retry_exhausted_at,
   sms_status, sms_attempts, last_sms_at, last_sms_error,
     last_sms_retry_at, sms_retry_exhausted_at, ...)
```

## Last verified

Run on 2026-04-18: status `success`. Healthy row asserted Payment + push:sent
1/5 + sms:sent 1/5; exhausted row asserted Refund + push:failed 5/5 +
push-exhausted pill + sms:sent 3/5.
