# E2E: Manual-entry alerts silent-recipients drill-down grouping

Covers Task #1670 (one row per person, even when both channels failed)
and pins the rendered drill-down behaviour the unit suite at
`artifacts/kharagolf-web/src/tests/manual-entry-alerts-silent-recipients-grouping.test.ts`
can't see (badge icons, sort order, header copy, "Unknown user" bucket).

> **Primary executable coverage** for the grouping helper itself lives
> in the vitest unit suite above. This e2e plan exercises the same
> helper through the React Query hook, the lazy-fetch panel, and the
> super-admin dashboard chrome — so a regression in
> `SilentRecipientsPanel`, the row table's expand wiring, or the
> `/silent-recipients` endpoint surfaces here even if the unit test
> still passes.
>
> Replay against the dev api-server + Postgres from any agent notebook
> with `runTest({ testReplitAuth: true, testPlan, relevantTechnicalDocumentation })`.

## What this test asserts

- The "Silent recipients (N people, M of T attempts failed)" header
  reflects the **grouped** person count (3, not the 5 raw failed
  attempts) and the raw "M of T" attempt counts (5 of 6).
- The user with both channels failing renders **once** with a
  `push: failed` badge **and** an `email: opted_out` badge in the same
  row (Task #1670's collapse behaviour).
- That user sorts above the user with only one channel failing
  (descending by failed-channel count).
- Every `userId IS NULL` recipient row collapses into a single
  "Unknown user" entry instead of one row per anonymous slot.

## Component / endpoints under test

- File: `artifacts/kharagolf-web/src/pages/manual-entry-alerts.tsx`
  - `SilentRecipientsPanel` lazy-fetched on row expand
  - `groupSilentRecipientsByUser` collapse helper
- Endpoint:
  - `GET /api/super-admin/manual-entry-alerts/:id/silent-recipients`
- Auth: `requireSuperAdmin` — must be a `super_admin` user.

### Relevant test ids

- `input-tournament-filter` — narrow the rows table to the seeded alert.
- `row-alert-${alertId}` — the alert table row.
- `button-expand-alert-${alertId}` — toggles the silent-recipients drawer.
- `row-alert-${alertId}-expanded` — the drawer container.
- `silent-recipients-list-${alertId}` — drawer body once loaded; the
  header text "Silent recipients (N people, M of T attempts failed)"
  is the first child paragraph inside this container.
- `silent-recipient-${alertId}-${idx}` — one per **person** group.
  The `data-user-id` attribute exposes the resolved userId (empty
  string for the "Unknown user" bucket).
- `silent-recipient-status-${alertId}-${idx}-${channel}` — the per-channel
  badge inside a group; text reads "channel: status"
  (e.g. "push: failed", "email: opted_out").
- `silent-recipient-failure-${alertId}-${idx}-${channel}` — the badge
  + error-message row container; one per failed channel inside a group.

## Test plan

```text
1. [New Context] Create a new browser context.

2. [OIDC] Configure the next login claims to:
   { sub: "test-me-silent-grp-" + Date.now(),
     email: "me-silent-grp-e2e-" + Date.now() + "@example.com",
     first_name: "MESilentGrp", last_name: "Tester" }

3. [Browser] Navigate to /api/login?returnTo=%2Fsuper-admin%2Fmanual-entry-alerts.
   Wait for the OIDC bypass + redirect chain to settle.

4. [DB] Promote the freshly-logged-in user to super_admin in BOTH the
   app_users table AND the active session blob (req.user is read from
   sessions.sess.user, not the DB):

   UPDATE app_users SET role='super_admin'
     WHERE id = (SELECT id FROM app_users ORDER BY id DESC LIMIT 1)
     RETURNING id AS me_user_id;

   UPDATE sessions
      SET sess = jsonb_set(sess, '{user,role}', '"super_admin"')
    WHERE (sess->'user'->>'id')::int = ${me_user_id};

5. [DB] Seed an isolated org / tournament / player / submission / alert
   plus per-recipient rows that exercise all three drill-down shapes.
   The stamp keeps every row uniquely tagged so the cleanup at the end
   only removes what this test created.

   -- Reusable suffix for unique names/usernames/emails.
   -- (Save the chosen string in a variable; we reuse it for cleanup.)
   stamp = "t2085_" + Date.now() + "_" + Math.random().toString(36).slice(2,6)

   INSERT INTO organizations (name, slug)
     VALUES ('T2085_Org_' || ${stamp}, 't2085-org-' || ${stamp})
     RETURNING id AS org_id;

   INSERT INTO tournaments (organization_id, name, start_date, end_date, rounds)
     VALUES (${org_id}, 'T2085_Tourn_' || ${stamp},
             now() - interval '2 days', now() + interval '1 day', 3)
     RETURNING id AS tourn_id;

   INSERT INTO players (tournament_id, first_name, last_name)
     VALUES (${tourn_id}, 'Pat', 'T2085_' || ${stamp})
     RETURNING id AS player_id;

   INSERT INTO round_submissions (tournament_id, player_id, round, status)
     VALUES (${tourn_id}, ${player_id}, 1, 'countersigned')
     RETURNING id AS submission_id;

   -- Alert is fully silent (push_sent=0, email_sent=0) so it shows up
   -- with the "silent" status badge in the rows table; sentAt = -1h
   -- keeps it inside both the 7d and 30d windows.
   INSERT INTO manual_entry_alerts
     (submission_id, tournament_id, player_id, round, manual_pct,
      manual_shots, total_shots, recipient_count,
      push_attempted, push_sent, email_attempted, email_sent, sent_at)
   VALUES
     (${submission_id}, ${tourn_id}, ${player_id}, 1, 73.40, 11, 15,
      3, 3, 0, 3, 0, now() - interval '1 hour')
     RETURNING id AS alert_id;

   -- Seed three named recipients. The display_name picks (Alice / Bob)
   -- AND the failure counts together pin the sort order:
   --   Alice (2 fails) -> Bob (2 fails, but B>A) -> Carol (1 fail).
   -- The "Unknown user" bucket has 2 fails too; B<U alphabetically so
   -- Bob still outranks Unknown after the tie-break.
   INSERT INTO app_users (replit_user_id, username, email, display_name, role, organization_id)
   VALUES
     ('t2085-u-both-'  || ${stamp}, 't2085_uboth_'  || ${stamp},
      'uboth_'  || ${stamp} || '@t2085.test',  'Alice Both Channels',
      'org_admin', ${org_id}),
     ('t2085-u-email-' || ${stamp}, 't2085_uemail_' || ${stamp},
      'uemail_' || ${stamp} || '@t2085.test',  'Carol Email Only',
      'org_admin', ${org_id})
   RETURNING id, username;
   -- Capture them as u_both_id and u_email_id (by username order).

   INSERT INTO manual_entry_alert_recipients
     (alert_id, user_id, channel, status, error_message, created_at)
   VALUES
     -- Alice: BOTH channels silent. push=failed (with error),
     -- email=opted_out. Two badges, one row, sorted to the top.
     (${alert_id}, ${u_both_id},  'push',  'failed',
      'expo unreachable',                now() - interval '50 minutes'),
     (${alert_id}, ${u_both_id},  'email', 'opted_out', NULL,
      now() - interval '49 minutes'),

     -- Carol: ONLY email failed. push=sent, so only the email badge
     -- shows in her row; her group is sorted below Alice & Unknown.
     (${alert_id}, ${u_email_id}, 'push',  'sent',     NULL,
      now() - interval '48 minutes'),
     (${alert_id}, ${u_email_id}, 'email', 'opted_out', NULL,
      now() - interval '47 minutes'),

     -- Two NULL-userId rows. Pre-#1670 they would have rendered as two
     -- separate "Unknown" rows; now they collapse into one bucket
     -- with two badges underneath.
     (${alert_id}, NULL,          'push',  'no_address', NULL,
      now() - interval '46 minutes'),
     (${alert_id}, NULL,          'email', 'no_email',   NULL,
      now() - interval '45 minutes');

   -- Sanity: total raw rows = 6, silent (status<>'sent') = 5.
   -- Distinct grouped people = 3 (Alice + Carol + Unknown bucket).

6. [Browser] Navigate to /super-admin/manual-entry-alerts. Wait for
   data-testid="page-manual-entry-alerts" to appear.

7. [Browser] Type ${tourn_id} into data-testid="input-tournament-filter"
   so the rows table narrows to the seeded alert. Wait for
   data-testid="row-alert-${alert_id}" to be visible (and exactly one
   row in data-testid="table-rows").

8. [Browser] Click data-testid="button-expand-alert-${alert_id}". Wait
   for data-testid="row-alert-${alert_id}-expanded" to appear, then
   for data-testid="silent-recipients-list-${alert_id}" to render
   (the panel is lazy-fetched on first expand).

9. [Verify] Header copy shows GROUPED people, not raw rows:
   - Inside data-testid="silent-recipients-list-${alert_id}", the
     first paragraph's text matches the regex
     /^Silent recipients \(3 people, 5 of 6 attempts failed\)$/.

10. [Verify] Three person-rows rendered, in the right order:
    - data-testid="silent-recipient-${alert_id}-0" exists, visible,
      and its data-user-id attribute equals String(${u_both_id}).
    - data-testid="silent-recipient-${alert_id}-1" exists, visible,
      and its data-user-id attribute equals "" (the "Unknown user"
      bucket — null userId rendered as an empty string).
    - data-testid="silent-recipient-${alert_id}-2" exists, visible,
      and its data-user-id attribute equals String(${u_email_id}).
    - data-testid="silent-recipient-${alert_id}-3" does NOT exist
      (no fourth row — exactly three groups).

11. [Verify] Alice's row carries BOTH channel badges with the right
    push/email order (push first regardless of insertion order):
    - data-testid="silent-recipient-${alert_id}-0" text contains
      "Alice Both Channels".
    - data-testid="silent-recipient-status-${alert_id}-0-push"
      text equals "push: failed".
    - data-testid="silent-recipient-status-${alert_id}-0-email"
      text equals "email: opted_out".
    - The "expo unreachable" error string appears inside
      data-testid="silent-recipient-failure-${alert_id}-0-push".

12. [Verify] The single-channel user shows ONLY the email badge:
    - data-testid="silent-recipient-${alert_id}-2" text contains
      "Carol Email Only".
    - data-testid="silent-recipient-status-${alert_id}-2-email"
      text equals "email: opted_out".
    - data-testid="silent-recipient-status-${alert_id}-2-push"
      does NOT exist (push=sent for Carol, so no failure badge).

13. [Verify] Both NULL-userId rows collapsed into one "Unknown user"
    bucket with two badges:
    - data-testid="silent-recipient-${alert_id}-1" text contains
      "Unknown user".
    - data-testid="silent-recipient-status-${alert_id}-1-push"
      text equals "push: no_address".
    - data-testid="silent-recipient-status-${alert_id}-1-email"
      text equals "email: no_email".

14. [Browser] Click data-testid="button-expand-alert-${alert_id}"
    again. Wait for data-testid="row-alert-${alert_id}-expanded" to
    disappear (sanity check: collapse still works after the lazy
    fetch resolved).

15. [DB] Cleanup — order matters because of FKs (the alert FK on the
    recipients table is ON DELETE CASCADE, so deleting the alert
    sweeps the per-recipient rows too):

    DELETE FROM manual_entry_alerts WHERE id = ${alert_id};
    DELETE FROM round_submissions WHERE id = ${submission_id};
    DELETE FROM players WHERE id = ${player_id};
    DELETE FROM tournaments WHERE id = ${tourn_id};
    DELETE FROM app_users
      WHERE id IN (${u_both_id}, ${u_email_id}, ${me_user_id});
    DELETE FROM organizations WHERE id = ${org_id};
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

ENDPOINT (Task #1386 / Task #1670)
- GET /api/super-admin/manual-entry-alerts/:id/silent-recipients
  → { alertId, totalRecipientRows,
      silentRecipients: [{ userId, displayName, username, email,
                           channel, status, errorMessage,
                           createdAt }, ...] }
  Returns every (recipient, channel) attempt that didn't end in
  'sent'. The dashboard then groups by userId in
  `groupSilentRecipientsByUser` so each PERSON renders exactly once
  with one badge per failing channel.

UI WIRING (artifacts/kharagolf-web/src/pages/manual-entry-alerts.tsx)
- The rows table renders an expand chevron per alert
  (`button-expand-alert-${id}`); clicking it lazy-mounts
  `SilentRecipientsPanel`, which fires the React Query above.
- Group order: descending by failures.length, then alphabetical by
  display name (with "Unknown user" used for the null-userId bucket).
- Inside a group, per-channel failures are stable-sorted push-before-
  email regardless of insertion / DB ordering.
- testids:
    page-manual-entry-alerts
    input-tournament-filter
    table-rows
    row-alert-${alertId}
    button-expand-alert-${alertId}
    row-alert-${alertId}-expanded
    silent-recipients-list-${alertId}
    silent-recipient-${alertId}-${idx}
        — has data-user-id="<userId or empty string>"
    silent-recipient-failure-${alertId}-${idx}-${channel}
    silent-recipient-status-${alertId}-${idx}-${channel}
        — text reads "<channel>: <status>"
        e.g. "push: failed", "email: opted_out"

SCHEMA NOTES
- manual_entry_alert_recipients(channel) is constrained to
  ('push','email'); status is constrained to
  ('sent','failed','no_address','no_email','opted_out','skipped').
- The FK manual_entry_alert_recipients.alert_id → manual_entry_alerts.id
  is ON DELETE CASCADE, so cleanup only needs to delete the alert.
- app_users.display_name is the column that backs `displayName` in the
  drill-down JSON.

GROUPING EXPECTATIONS FOR THE SEED ABOVE
- Alice (u_both_id):  push=failed + email=opted_out  → 2 failures, idx 0
- Unknown bucket:     push=no_address + email=no_email → 2 failures, idx 1
  (tie-break against Alice: "Alice…" < "Unknown user" alphabetically)
- Carol (u_email_id): email=opted_out only             → 1 failure,  idx 2
- Header: "Silent recipients (3 people, 5 of 6 attempts failed)".
```

## Last verified

Authored on 2026-04-30 for Task #2085. Live replay on the same date
via `runTest({ testReplitAuth: true, testPlan, relevantTechnicalDocumentation })`
completed all 15 plan steps in order against the dev api-server +
Postgres: OIDC bypass + super-admin promotion → seed (org → tournament
→ player → submission → alert + 6 per-recipient rows across two
distinct users and a null-userId pair) → dashboard filter + row
expand → header copy assertion ("Silent recipients (3 people, 5 of
6 attempts failed)") → group-order/per-channel-badge assertions
(Alice idx 0, Unknown idx 1, Carol idx 2) → collapse → cleanup. The
test reported zero verification gaps.

## CI counterpart

The same scenario is encoded as a Playwright spec at
`artifacts/api-server/e2e/manual-entry-alerts-silent-recipients-grouping.spec.ts`,
which seeds the same fixture via direct SQL (org → super-admin →
tournament → player → submission → alert + 6 recipient rows) and
asserts the same header copy, group order, and per-channel badges.
It runs under the api-server e2e Playwright project
(`pnpm --filter @workspace/api-server test:e2e --
manual-entry-alerts-silent-recipients-grouping.spec.ts`). This
markdown plan is kept as a higher-level operator-readable narrative
of what the spec exercises and why each assertion exists.
