# E2E: Org notification defaults — show inheritance & one-click apply on /club-settings

Covers Task #1379. Canonical Playwright `runTest` plan that proves the
"Existing tournaments" inheritance block on the
`OrgNotificationDefaultsCard` correctly:

- Lists active org tournaments with their per-row manual-entry alert state
- Excludes terminal-status tournaments (completed / cancelled)
- Marks tournaments that diverge from the org-wide default
- Renders the divergent badge and an "Apply to all (N)" call-to-action
- Bulk-applies the org-wide default to only the divergent rows on confirm
- Replaces the divergent badge with the aligned badge after refetch

Replay it from any agent notebook with
`runTest({ testPlan, relevantTechnicalDocumentation })` using the bodies
below.

## Page under test

- File: `artifacts/kharagolf-web/src/pages/club-settings.tsx`
- Endpoints exercised:
  - `POST /api/auth/player-login` (cookie session)
  - `GET  /api/organizations/:orgId/notification-defaults`
  - `GET  /api/organizations/:orgId/notification-defaults/tournaments`
  - `POST /api/organizations/:orgId/notification-defaults/apply-to-tournaments`
- Auth: requires `org_admin` / `super_admin` / `tournament_director`
  on the active organization. The plan seeds a brand-new `org_admin`
  in `app_users` (org 1) and authenticates via local password login,
  so no OIDC/Replit-Auth dance is needed.
- Test ids exercised here:
  - `card-org-notification-defaults` — the card under test
  - `block-tournament-inheritance` — wrapper for the new block
  - `text-inheritance-summary`,
    `text-inheritance-enabled-count`,
    `text-inheritance-total-count`,
    `text-inheritance-muted-count`,
    `text-inheritance-divergent-count`
  - `badge-inheritance-divergent` / `badge-inheritance-aligned`
  - `button-apply-to-tournaments`,
    `dialog-confirm-apply-to-tournaments`,
    `button-confirm-apply-to-tournaments`
  - `toggle-inheritance-list` (expands the per-tournament `<details>`)
  - `list-inheritance-tournaments`,
    `row-inheritance-tournament-<id>`,
    `badge-inheritance-tournament-state-<id>`,
    `marker-inheritance-divergent-<id>`

## Test plan

```text
1. [New Context] Create a new browser context.

2. [DB] Insert a verified org_admin test user belonging to org 1. Generate
   a fresh ${SUFFIX} as 6 LOWERCASE hex chars (e.g. nanoid(6).toLowerCase()
   or hex(3)) — mixed-case suffixes will break login because the auth
   endpoint lowercases the email before lookup. The bcryptjs hash below
   corresponds to the literal password "TestPassword123!" at cost 10.
   It is wrapped in a dollar-quoted SQL string ($pw$...$pw$) so the literal
   '$' characters in the bcrypt hash are not mistaken for SQL placeholders.
   The replit_user_id column is NOT NULL — populate it.

   INSERT INTO app_users
     (email, password_hash, role, organization_id, email_verified,
      display_name, username, replit_user_id, created_at, updated_at)
   VALUES
     ('e2e-inherit-${SUFFIX}@kharagolf-test.local',
      $pw$$2b$10$I1l/Lc1c228eC/w1nRz6H.OhGXfpVh6g8vgUWpJi4eKtLsc6vs8NO$pw$,
      'org_admin', 1, true,
      'E2E Inherit Admin ${SUFFIX}',
      'e2e_inherit_${SUFFIX}',
      'e2e_inherit_${SUFFIX}',
      NOW(), NOW())
   RETURNING id;
   -- record the returned id as ${TEST_USER_ID}

   IMMEDIATELY verify the row is reachable by the lowercased email lookup
   used by the API:
     SELECT id FROM app_users
      WHERE email = LOWER('e2e-inherit-${SUFFIX}@kharagolf-test.local');
   This MUST return one row with id = ${TEST_USER_ID}. If empty, halt
   and report — ${SUFFIX} contains uppercase characters.

3. [DB] Force the org-wide manual-entry default ON for org 1 so the test
   starts from a known baseline:
     UPDATE organizations SET notify_manual_entry_alerts = true WHERE id = 1;

4. [DB] Seed three tournaments in org 1 with mixed flags and statuses. The
   completed one MUST NOT appear in the inheritance list.

   INSERT INTO tournaments (organization_id, name, format, status, notify_manual_entry_alerts)
   VALUES (1, 'E2E Inherit Match ${SUFFIX}', 'stroke_play', 'draft', true)
   RETURNING id; -- record as ${T_MATCH_ID}

   INSERT INTO tournaments (organization_id, name, format, status, notify_manual_entry_alerts)
   VALUES (1, 'E2E Inherit Diverge ${SUFFIX}', 'stroke_play', 'upcoming', false)
   RETURNING id; -- record as ${T_DIVERGE_ID}

   INSERT INTO tournaments (organization_id, name, format, status, notify_manual_entry_alerts)
   VALUES (1, 'E2E Inherit Done ${SUFFIX}', 'stroke_play', 'completed', false)
   RETURNING id; -- record as ${T_DONE_ID}

5. [API] POST /api/auth/player-login with JSON body
   { "email": "e2e-inherit-${SUFFIX}@kharagolf-test.local",
     "password": "TestPassword123!" }
   using credentials: 'include' so the session cookie is stored on the
   browser context. Expect HTTP 200.

6. [Browser] Navigate to /club-settings. Wait for
   data-testid="card-org-notification-defaults" and
   data-testid="block-tournament-inheritance" to render.

7. [Verify] INHERITANCE SUMMARY shows divergence:
   - data-testid="text-inheritance-summary" exists.
   - data-testid="text-inheritance-divergent-count" integer >= 1.
   - data-testid="badge-inheritance-divergent" is visible.
   - data-testid="button-apply-to-tournaments" is enabled and visible
     text starts with "Apply to all (".

8. [Browser] Click data-testid="toggle-inheritance-list". Wait for
   data-testid="list-inheritance-tournaments".

9. [Verify] PER-TOURNAMENT ROWS only show active events:
   - data-testid="row-inheritance-tournament-${T_MATCH_ID}" exists; the
     badge data-testid="badge-inheritance-tournament-state-${T_MATCH_ID}"
     contains text "Alerts on".
   - data-testid="row-inheritance-tournament-${T_DIVERGE_ID}" exists; the
     badge data-testid="badge-inheritance-tournament-state-${T_DIVERGE_ID}"
     contains text "Muted".
   - data-testid="marker-inheritance-divergent-${T_DIVERGE_ID}" exists.
   - data-testid="row-inheritance-tournament-${T_DONE_ID}" must NOT exist.

10. [Browser] Click data-testid="button-apply-to-tournaments". Wait for the
    confirmation dialog data-testid="dialog-confirm-apply-to-tournaments",
    then click data-testid="button-confirm-apply-to-tournaments".

11. [Verify] APPLY TO ALL succeeded:
    - A toast appears whose title starts with "Applied to".
    - After the list refreshes:
      data-testid="badge-inheritance-aligned" exists.
      data-testid="badge-inheritance-divergent" no longer exists.
      data-testid="marker-inheritance-divergent-${T_DIVERGE_ID}" no longer
      exists in the DOM.

12. [Verify] DB STATE:
    SELECT notify_manual_entry_alerts FROM tournaments WHERE id = ${T_DIVERGE_ID};
    → must be true (was flipped from false to match org-wide default).
    SELECT notify_manual_entry_alerts FROM tournaments WHERE id = ${T_DONE_ID};
    → must STILL be false (completed events left untouched).

13. [DB] Cleanup (best effort):
    DELETE FROM tournaments WHERE id IN (${T_MATCH_ID}, ${T_DIVERGE_ID}, ${T_DONE_ID});
    DELETE FROM app_users WHERE id = ${TEST_USER_ID};
```

## Technical documentation passed alongside the plan

```text
APP UNDER TEST
- kharagolf-web mounted at "/"; page is /club-settings.
- api-server at /api/* with cookie sessions. POST /api/auth/player-login
  takes { email, password } and sets the session cookie. The endpoint
  lowercases the email before the DB lookup, so the seeded email row
  MUST already be all-lowercase.

ENDPOINTS NEW IN TASK #1379
- GET /api/organizations/:orgId/notification-defaults/tournaments
    → { tournaments: Array<{ id, name, status, startDate, notifyManualEntryAlerts }> }
    Only returns rows whose status is in {draft, upcoming, active, suspended}.
- POST /api/organizations/:orgId/notification-defaults/apply-to-tournaments
    body: { notifyManualEntryAlerts?: boolean } (defaults to org-wide value)
    → { notifyManualEntryAlerts, updatedCount }
    Bulk-updates every tournament in the org whose status is in the set
    above and whose current flag differs from the target.

CARD UNDER TEST (artifacts/kharagolf-web/src/pages/club-settings.tsx)
- All data-testid hooks are listed in the test plan.

DB SCHEMAS
- organizations(id, notify_manual_entry_alerts boolean default true, ...)
- tournaments(id, organization_id, name, format, status, notify_manual_entry_alerts, ...)
- app_users(id, email, password_hash, role, organization_id, email_verified,
            replit_user_id (NOT NULL), display_name, username, ...)

NOTES
- The dev DB has pre-existing tournaments in org 1. Do NOT assert exact
  total counts — only assert per-row state of seeded rows and that the
  divergent badge disappears after bulk-apply.
- The two known auth pitfalls are: (a) replit_user_id is NOT NULL, must
  be populated; (b) the email column is case-sensitive but the login
  endpoint lowercases the input — so the inserted email must be all-lowercase.
```

## Last verified

Run on 2026-04-24: status `success`. Seeded an org_admin and three
tournaments (draft+true, upcoming+false, completed+false); the first
page load showed the divergent badge with "Apply to all (≥1)" enabled;
expanding the list showed only the active rows with the correct per-row
badges and the "≠ club default" marker on the diverging row, and
excluded the completed row; clicking apply and confirming flipped the
diverging row to true (verified in DB) while leaving the completed row
at false; the UI refetched and replaced the divergent badge with the
aligned badge and removed the per-row divergent marker. Cleanup deletes
ran cleanly.
