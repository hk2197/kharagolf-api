# E2E: Resend countdown survives a page refresh on /club-settings

Covers Task #1093 (regression coverage for Task #947). Canonical Playwright
`runTest` plan that proves the per-row "Resend in Ns" countdown on the
"Schedule-change notifications — last sent" card is re-derived from the
DB row's `last_resend_at + RESEND_COOLDOWN_MS` after a full page refresh,
and that the same button re-enables once the cooldown elapses.

Replay it from any agent notebook with
`runTest({ testPlan, relevantTechnicalDocumentation })` using the bodies
below.

## Page under test

- File: `artifacts/kharagolf-web/src/pages/club-settings.tsx`
- Endpoints exercised:
  - `POST /api/auth/player-login` (cookie session)
  - `GET  /api/organizations/:orgId/bounced-digest-schedule-sends`
- Auth: requires `org_admin` / `super_admin` / `tournament_director`
  on the active organization. The plan seeds a brand-new `org_admin`
  in `app_users` (org 1) and authenticates via local password login,
  so no OIDC/Replit-Auth dance is needed.
- Test ids exercised here:
  - `card-schedule-change-last-send` — the card under test
  - `block-schedule-last-send` — wrapper for the most-recent send row
  - `button-resend-send-${sendId}` — the per-row Resend button
  - `text-resend-cooldown-${sendId}` — the "Resend in Ns" label inside
    the disabled button while a cooldown is active

## Test plan

```text
1. [New Context] Create a new browser context.

2. [DB] Insert a verified org_admin test user belonging to org 1 so
   we can log in. Replace ${SUFFIX} with a fresh nanoid(6) so reruns
   never collide. The PASSWORD_HASH is a bcryptjs hash of the literal
   string "TestPassword123!" — insert it verbatim.

   INSERT INTO app_users
     (email, password_hash, role, organization_id, email_verified,
      display_name, username, created_at, updated_at)
   VALUES
     ('e2e-cooldown-${SUFFIX}@kharagolf-test.local',
      '$2b$10$I1l/Lc1c228eC/w1nRz6H.OhGXfpVh6g8vgUWpJi4eKtLsc6vs8NO',
      'org_admin', 1, true,
      'E2E Cooldown Admin ${SUFFIX}',
      'e2e_cooldown_${SUFFIX}',
      NOW(), NOW())
   RETURNING id;
   -- record the returned id as ${TEST_USER_ID}

3. [DB] Seed a bounced_digest_schedule_sends row that is mid-cooldown.
   RESEND_COOLDOWN_MS = 60_000, so last_resend_at = NOW() - 5s leaves
   ~55s remaining. Use the test user as changed_by_user_id and a
   single fake recipient.

   INSERT INTO bounced_digest_schedule_sends
     (organization_id, sent_at, changed_by_user_id, recipients,
      last_resend_at)
   VALUES
     (1,
      NOW() - INTERVAL '1 hour',
      ${TEST_USER_ID},
      ('[{"userId":' || ${TEST_USER_ID}
        || ',"email":"e2e-cooldown-${SUFFIX}@kharagolf-test.local"'
        || ',"displayName":"Recipient A"}]')::jsonb,
      NOW() - INTERVAL '5 seconds')
   RETURNING id;
   -- record the returned id as ${SEND_ID}

4. [API] POST /api/auth/player-login with JSON body
   { "email": "e2e-cooldown-${SUFFIX}@kharagolf-test.local",
     "password": "TestPassword123!" }
   using credentials: 'include' so the session cookie is stored on
   the browser context. Expect HTTP 200.

5. [Browser] Navigate to /club-settings. Wait for the card
   data-testid="card-schedule-change-last-send" and the row wrapper
   data-testid="block-schedule-last-send" to render.

6. [Verify] INITIAL COOLDOWN — the seeded row is in cooldown:
   - data-testid="button-resend-send-${SEND_ID}" exists and the
     button's `disabled` property is truthy.
   - data-testid="text-resend-cooldown-${SEND_ID}" exists inside that
     button and its text matches /^Resend in \d+s$/.
   - The captured integer N is between 30 and 60 inclusive (proves
     the countdown was derived from the seeded last_resend_at, not
     reset to a fresh full 60s window by the page).

7. [Browser] Reload the current page (full page refresh).

8. [Verify] COUNTDOWN SURVIVED THE REFRESH:
   - data-testid="button-resend-send-${SEND_ID}" is still disabled.
   - data-testid="text-resend-cooldown-${SEND_ID}" is still present
     and its text still matches /^Resend in \d+s$/ with the integer
     between 1 and 60 inclusive.

9. [DB] Fast-forward past the cooldown by re-seeding last_resend_at:
   UPDATE bounced_digest_schedule_sends
      SET last_resend_at = NOW() - INTERVAL '5 minutes'
    WHERE id = ${SEND_ID};

10. [Browser] Reload the current page.

11. [Verify] COOLDOWN OVER:
    - data-testid="button-resend-send-${SEND_ID}" is NOT disabled.
    - The button's text content is exactly "Resend".
    - data-testid="text-resend-cooldown-${SEND_ID}" no longer exists
      in the DOM.

12. [DB] Cleanup (best effort, do not fail the test if these error):
    DELETE FROM bounced_digest_schedule_sends WHERE id = ${SEND_ID};
    DELETE FROM app_users WHERE id = ${TEST_USER_ID};
```

## Technical documentation passed alongside the plan

```text
APP UNDER TEST
- kharagolf-web mounted at "/"; page is /club-settings.
- api-server at /api/* with cookie sessions. Local password login at
  POST /api/auth/player-login sets the session cookie used by the page.

ENDPOINTS
- POST /api/auth/player-login
    body: { email, password }
    → 200 + Set-Cookie session on success. The seeded user is
      org_admin in organization_id = 1 and email_verified = true,
      so the login succeeds without an email-verification gate.
- GET  /api/organizations/:orgId/bounced-digest-schedule-sends
    → returns up to 10 most-recent rows with shape
      { id, sentAt, recipients, lastResendAt, resendCooldownSeconds,
        changedBy }.
      lastResendAt + resendCooldownSeconds are exactly the inputs the
      page uses to re-derive the per-row countdown after a refresh.

COOLDOWN MATH (artifacts/api-server/src/routes/organizations.ts)
- RESEND_COOLDOWN_MS = 60_000.
- The /resend endpoint is NOT exercised here — we mutate
  last_resend_at directly so the test deterministically lands inside
  and then outside the cooldown window without sending real emails.

PAGE BEHAVIOUR (artifacts/kharagolf-web/src/pages/club-settings.tsx)
- The "Schedule-change notifications — last sent" card renders the
  most recent row from the GET above.
- Per row:
    data-testid="button-resend-send-${id}"
      disabled when (resending OR remainingSeconds > 0)
    data-testid="text-resend-cooldown-${id}"
      rendered ONLY while remainingSeconds > 0; text is
      `Resend in ${remainingSeconds}s`
- remainingSeconds is recomputed every second from
  lastResendAt + (resendCooldownSeconds ?? 60) - now, so a refresh
  re-derives the same countdown (modulo seconds elapsed during the
  refresh).

DB SCHEMAS (lib/db/src/schema/golf.ts)
- app_users(id, email, password_hash, role, organization_id,
    email_verified, display_name, username, created_at, updated_at, ...)
- bounced_digest_schedule_sends(id, organization_id, sent_at,
    changed_by_user_id, recipients jsonb, last_resend_at timestamptz)
```

## Last verified

Run on 2026-04-23: status `success`. Seeded an org_admin and a
mid-cooldown send row (last_resend_at = NOW() - 5s); first page load
showed the Resend button disabled with "Resend in 55s"; a full page
refresh re-derived the countdown ("Resend in 53s") with the button
still disabled; fast-forwarding last_resend_at by 5 minutes and
refreshing once more re-enabled the button with text "Resend" and
removed the cooldown label from the DOM. Cleanup deletes ran cleanly.
