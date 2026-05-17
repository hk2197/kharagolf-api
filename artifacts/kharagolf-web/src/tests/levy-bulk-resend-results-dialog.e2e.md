# E2E: Bulk-resend results dialog — per-channel breakdown

Covers Task #646 (which validates Task #508). This is the canonical Playwright
`runTest` plan for the **bulk-resend results dialog** that opens after the
admin confirms the pre-flight on the Member-360 levy detail panel.

It exercises the wiring between
`POST /api/organizations/:orgId/members-360/levies/:id/resend-failed-receipts`
and the `dialog-bulk-resend-receipts-results` UI (per-row channel badges and
the `bulk-resend-results-channel-totals-<channel>` summary widget).

Replay it from any agent notebook with
`runTest({ testReplitAuth: true, testPlan, relevantTechnicalDocumentation })`
using the bodies below.

## Component under test

- File: `artifacts/kharagolf-web/src/pages/club-members.tsx`
  - Bulk-resend trigger button: `data-testid="button-bulk-resend-receipts"`
  - Pre-flight dialog confirm: `data-testid="button-bulk-resend-preview-confirm"`
  - Results dialog: `data-testid="dialog-bulk-resend-receipts-results"`
    - Aggregate counters:
      `bulk-resend-results-attempted`,
      `bulk-resend-results-sent`,
      `bulk-resend-results-skipped`,
      `bulk-resend-results-failed`
    - Per-channel summary widget: `bulk-resend-results-channel-totals` and
      one `bulk-resend-results-channel-totals-<channel>` per channel
      (`email` / `push` / `sms` / `whatsapp`). The `(provider not configured)`
      hint is appended to the SMS/WhatsApp line because in this environment
      those providers are not configured.
    - Per-row channel badges:
      `bulk-resend-results-row-channel-<chargeId>-<channel>`
      with the channel `error` mirrored on the badge `title` (tooltip).
    - Per-row aggregate status badge:
      `bulk-resend-results-row-status-<chargeId>`
- Endpoint: `POST /api/organizations/:orgId/members-360/levies/:id/resend-failed-receipts`
- Auth: requires `org_admin` / `super_admin` / `membership_secretary` /
  `treasurer`. `req.user` is taken from `sessions.sess.user`, so the test
  patches the cached session JSON in addition to `app_users.role` (same
  gotcha as `levy-receipt-notifications.e2e.md`).

## Mixed scenario produced

Two charges in a single fresh levy, both with `lastReceiptStatus='failed'`
and a valid persisted kind so they qualify for the bulk-resend pool:

1. **Member A** — has email + phone, billing comm prefs all enabled.
   Real `sendLevyReceipt` runs against the real providers:
   - `email` → **sent** (Gmail SMTP is configured and accepts the relay to
     a unique `@example.com` address).
   - `push`  → **no_user** (member has no `userId` linked).
   - `sms`   → **skipped** with `error="provider_not_configured"` (no SMS
     provider env in this workspace).
   - `whatsapp` → **skipped** with `error="provider_not_configured"`.
   - Aggregate row status: **sent** (at least one channel delivered).

2. **Member B** — has email + phone, but billing comm prefs all disabled
   (`emailEnabled=false, pushEnabled=false, smsEnabled=false,
   whatsappEnabled=false`).
   - All four channels → **opted_out**.
   - Aggregate row status: **skipped**.

Aggregate response (and what the dialog must render):

- `attempted = 2`, `sent = 1`, `skipped = 1`, `failed = 0`.
- `channelTotals` (rendered in the per-channel summary widget):
  - email: `1 sent, 1 opted out`
  - push:  `0 sent, 1 no user, 1 opted out`
  - sms:   `0 sent, 1 opted out, 1 skipped (provider not configured)`
  - whatsapp: `0 sent, 1 opted out, 1 skipped (provider not configured)`

This satisfies the "mixed scenario" requirement in the task brief: at least
one channel **sent**, at least one **skipped due to `provider_not_configured`**
(so the `(provider not configured)` hint appears next to SMS and WhatsApp),
and at least one **opted_out** (Member B's whole row).

## Test plan

```text
1. [New Context] Create a new browser context.

2. [OIDC] Configure the next login claims to:
   { sub: "test-bulk-results-" + Date.now(),
     email: "bulk-results-e2e-" + Date.now() + "@example.com",
     first_name: "BulkResults", last_name: "Tester" }

3. [Browser] Navigate to /api/login?returnTo=%2F. Wait for the redirect chain
   to settle. Don't visually verify yet.

4. [DB] Promote the freshly-logged-in user to org_admin in BOTH the app_users
   table AND inside the active session blob (req.user is read from
   sessions.sess.user, not the DB). Then seed two members + one fresh levy +
   one failed-receipt charge per member, with the comm-prefs rows that drive
   the desired channel outcomes.

   -- generate a unique stamp once per run for collision-free seed values
   -- (in your runner: const stamp = Date.now())

   UPDATE app_users SET role='org_admin'
     WHERE id = (SELECT id FROM app_users ORDER BY id DESC LIMIT 1)
     RETURNING id AS user_id, organization_id AS org_id;

   UPDATE sessions
      SET sess = jsonb_set(jsonb_set(sess, '{user,role}', '"org_admin"'),
                            '{user,organizationId}', to_jsonb(${org_id}::int))
    WHERE (sess->'user'->>'id')::int = ${user_id};

   -- Member A: contactable, all four billing channels enabled.
   INSERT INTO club_members (organization_id, first_name, last_name, email, phone)
     VALUES (${org_id}, 'BulkResultsA', 'Tester',
             'bulk-results-a-' || ${stamp} || '@example.com',
             '+15555550101')
     RETURNING id AS member_a_id;

   INSERT INTO member_comm_prefs
     (club_member_id, organization_id, category,
      email_enabled, sms_enabled, push_enabled, whatsapp_enabled)
     VALUES (${member_a_id}, ${org_id}, 'billing',
             true, true, true, true);

   -- Member B: opted out of every billing channel.
   INSERT INTO club_members (organization_id, first_name, last_name, email, phone)
     VALUES (${org_id}, 'BulkResultsB', 'OptOut',
             'bulk-results-b-' || ${stamp} || '@example.com',
             '+15555550102')
     RETURNING id AS member_b_id;

   INSERT INTO member_comm_prefs
     (club_member_id, organization_id, category,
      email_enabled, sms_enabled, push_enabled, whatsapp_enabled)
     VALUES (${member_b_id}, ${org_id}, 'billing',
             false, false, false, false);

   INSERT INTO member_levies
     (organization_id, name, amount, currency, status, applied_at, applied_by_user_id)
     VALUES (${org_id}, 'E2E Bulk Results Levy ' || ${stamp},
             '100.00', 'INR', 'applied', now(), ${user_id})
     RETURNING id AS levy_id;

   -- Both charges qualify for the bulk pool (lastReceiptStatus IN
   -- ('failed','skipped') AND a valid persisted kind).
   INSERT INTO member_levy_charges
     (levy_id, club_member_id, amount, paid, status, paid_amount,
      last_receipt_status, last_receipt_kind, last_receipt_amount,
      last_receipt_at)
     VALUES (${levy_id}, ${member_a_id}, '100.00', true, 'paid', '100.00',
             'failed', 'payment', '100.00', now())
     RETURNING id AS charge_a_id;

   INSERT INTO member_levy_charges
     (levy_id, club_member_id, amount, paid, status, paid_amount,
      last_receipt_status, last_receipt_kind, last_receipt_amount,
      last_receipt_at)
     VALUES (${levy_id}, ${member_b_id}, '100.00', true, 'paid', '100.00',
             'failed', 'payment', '100.00', now())
     RETURNING id AS charge_b_id;

5. [Browser] Navigate to /club-members?openLevy=${levy_id}. Wait for the levy
   detail dialog to render its charges table. Dismiss any Vite runtime overlay.

6. [Verify] Inside the levy detail dialog:
   - data-testid="levy-receipt-summary" is visible.
   - data-testid="levy-failed-receipt-count" reads "2".
   - data-testid="button-bulk-resend-receipts" is visible and not disabled.

7. [Browser] Click data-testid="button-bulk-resend-receipts" to open the
   pre-flight dialog. Wait for data-testid="bulk-resend-preview-counts" to
   appear (this means the preview query has resolved and the dialog body
   rendered).

8. [Verify] Inside the pre-flight dialog:
   - data-testid="bulk-resend-preview-total" reads "2".
   - data-testid="bulk-resend-preview-row-${charge_a_id}" exists.
   - data-testid="bulk-resend-preview-row-${charge_b_id}" exists.

8a. [Browser] Member B is classified as `will_skip_opted_out` by the preview
    and so is deselected by default. Click
    data-testid="bulk-resend-preview-row-toggle-${charge_b_id}" to opt
    Member B back IN to the resend so the bulk POST attempts both rows
    (this is what produces the mixed scenario the dialog must render).

8b. [Verify] data-testid="bulk-resend-preview-selected-count" now reflects
    that 2 rows are selected.

9. [Browser] Click data-testid="button-bulk-resend-preview-confirm" to fire
   the bulk POST. Wait for the pre-flight dialog to disappear AND for
   data-testid="dialog-bulk-resend-receipts-results" to appear.

10. [Verify] Aggregate counters in the results dialog:
    - data-testid="bulk-resend-results-attempted" reads "2".
    - data-testid="bulk-resend-results-sent" reads "1".
    - data-testid="bulk-resend-results-skipped" reads "1".
    - data-testid="bulk-resend-results-failed" is NOT present (no failures).

11. [Verify] Per-channel totals widget data-testid="bulk-resend-results-channel-totals":
    - data-testid="bulk-resend-results-channel-totals-email" text contains
      "1 sent" AND "1 opted out".
    - data-testid="bulk-resend-results-channel-totals-push" text contains
      "1 no user" AND "1 opted out".
    - data-testid="bulk-resend-results-channel-totals-sms" text contains
      "1 opted out" AND "1 skipped" AND "(provider not configured)".
    - data-testid="bulk-resend-results-channel-totals-whatsapp" text contains
      "1 opted out" AND "1 skipped" AND "(provider not configured)".

12. [Verify] Member A row data-testid="bulk-resend-results-row-${charge_a_id}":
    - data-testid="bulk-resend-results-row-status-${charge_a_id}" text contains
      "sent".
    - data-testid="bulk-resend-results-row-channel-${charge_a_id}-email"
      text contains "sent" (no "!" suffix because no error).
    - data-testid="bulk-resend-results-row-channel-${charge_a_id}-push"
      text contains "no user".
    - data-testid="bulk-resend-results-row-channel-${charge_a_id}-sms"
      text contains "skipped" AND ends with "!" (channel.error is set, so
      the badge appends a "!" marker), AND its title attribute equals
      "provider_not_configured" (tooltip exposes the raw reason).
    - data-testid="bulk-resend-results-row-channel-${charge_a_id}-whatsapp"
      text contains "skipped" AND ends with "!", AND its title attribute
      equals "provider_not_configured".

13. [Verify] Member B row data-testid="bulk-resend-results-row-${charge_b_id}":
    - data-testid="bulk-resend-results-row-status-${charge_b_id}" text
      contains "skipped".
    - All four channel badges (email/push/sms/whatsapp) text contains
      "opted out" and none of them carry the trailing "!" marker
      (no error on opted_out outcomes).

14. [Browser] Click data-testid="button-bulk-resend-results-close" to dismiss
    the results dialog. The Dialog should close.

15. [DB] Cleanup:
    DELETE FROM member_levies WHERE id = ${levy_id};
    DELETE FROM member_comm_prefs WHERE club_member_id IN (${member_a_id}, ${member_b_id});
    DELETE FROM club_members WHERE id IN (${member_a_id}, ${member_b_id});
```

## Technical documentation passed alongside the plan

```text
APP UNDER TEST
- kharagolf-web mounted at "/"; page is /club-members.
- api-server at /api/* with cookie sessions and Replit OIDC.
- /api/login?returnTo=<safe-path> auto-redirects there after the bypass.

AUTH GOTCHA
- The auth middleware sets req.user = sessions.sess.user. Updating
  app_users.role does NOT change req.user; you MUST also patch
  sessions.sess via jsonb_set as in step 4. Without that the
  resend-failed-receipts endpoint returns 403.

ENDPOINT UNDER TEST
- POST /api/organizations/:orgId/members-360/levies/:id/resend-failed-receipts
  Body: { chargeIds?: number[] }   (optional subset; omitted by the UI when
                                    every preview row is selected.)
  Response shape (Task #508):
    {
      levyId, attempted, sent, skipped, failed,
      channelTotals: {
        email|push|sms|whatsapp: {
          sent, failed, no_address, no_user, opted_out, skipped
        }
      },
      results: [{
        chargeId, clubMemberId, memberName,
        status: "sent"|"skipped"|"failed", reason,
        kind, amount,
        channels: {
          email|push|sms|whatsapp: { status, error? }
        }
      }, ...]
    }

ENVIRONMENT
- Gmail SMTP IS configured (GMAIL_USER + GMAIL_APP_PASSWORD set), so the
  email channel for an opted-in member with an email on file will resolve
  to "sent" — nodemailer.sendMail() resolves once Gmail accepts the relay,
  even for an `@example.com` recipient.
- SMS_PROVIDER and WHATSAPP_PROVIDER are NOT configured. The receipt
  helper detects "(SMS|WHATSAPP)_PROVIDER not configured" errors and
  collapses them to status="skipped" with error="provider_not_configured".
- No push device is registered for the seeded member, and clubMember.userId
  is NULL, so push resolves to status="no_user".

WIDGET CONTRACT (artifacts/kharagolf-web/src/pages/club-members.tsx)
- Trigger: data-testid="button-bulk-resend-receipts" (visible whenever
  failedReceiptCount + skippedReceiptCount > 0 inside the levy dialog).
- Pre-flight: data-testid="dialog-bulk-resend-receipts-preview"-style
  layout. Confirm with data-testid="button-bulk-resend-preview-confirm".
- Results dialog (under test):
    Container       — data-testid="dialog-bulk-resend-receipts-results"
    Aggregate row   — data-testid="bulk-resend-results-aggregate"
                       attempted/sent/skipped/failed spans (skipped/failed
                       omitted when their count is 0).
    Channel totals  — data-testid="bulk-resend-results-channel-totals"
                      with one row per channel
                      data-testid="bulk-resend-results-channel-totals-<k>"
                      whose text reads
                      "<Label>: <N> sent[, <N> failed][, <N> opted out]
                       [, <N> no address][, <N> no user][, <N> skipped]
                       [(<dominant non-sent reason humanised>)]".
                      The dominant-reason hint is computed from each row's
                      channels[k].error field; "provider_not_configured"
                      is rendered as "provider not configured".
    Per-row channel — data-testid="bulk-resend-results-row-channel-<chargeId>-<k>"
                      Inner text = humanised status label
                       ("sent"|"failed"|"no address"|"no user"|"opted out"|"skipped")
                      Suffix " !" iff channels[k].error is truthy.
                      title attribute = channels[k].error (raw string).
    Per-row status  — data-testid="bulk-resend-results-row-status-<chargeId>"
                      Inner text = aggregate row.status (and ` · <reason>`
                      when row.reason is truthy).
    Close button    — data-testid="button-bulk-resend-results-close".

ENTRY POINT
- /club-members?openLevy=<levyId> auto-opens the levy detail dialog.

DB SCHEMAS (lib/db/src/schema/golf.ts)
- member_levies(id, organization_id, name, amount, currency, status,
                applied_at, applied_by_user_id, ...)
- member_levy_charges(id, levy_id, club_member_id, amount, paid, status,
                     paid_amount, last_receipt_status, last_receipt_kind,
                     last_receipt_amount, last_receipt_at, ...)
- club_members(id, organization_id, first_name, last_name, email, phone,
               user_id?, ...)
- member_comm_prefs(club_member_id, organization_id, category,
                    email_enabled, sms_enabled, push_enabled, whatsapp_enabled, ...)
  (unique on (club_member_id, category); category for billing receipts is
  literally 'billing').
- sessions(sid varchar pk, sess jsonb, expire timestamp)
- app_users(id, replit_user_id, email, role, organization_id, ...)
```

## Last verified

Run on 2026-04-19: status `success`. Aggregate read attempted=2, sent=1,
skipped=1; per-channel totals row for SMS / WhatsApp included the
`(provider not configured)` hint; Member A row showed sent / no user /
skipped! / skipped! across the four channels with the raw error surfaced
on the badge title; Member B row showed opted out across all four. Note:
the per-cell error marker renders as `skipped !` (with a space before
`!`), matching the React `{statusLabel[status]}{ch?.error ? ' !' : ''}`
template — the assertions tolerate that exact spacing.
