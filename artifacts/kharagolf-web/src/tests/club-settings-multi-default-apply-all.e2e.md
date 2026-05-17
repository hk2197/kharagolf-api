# E2E: Org notification defaults — multi-default "Apply all divergent" on /club-settings

Covers Task #2084 (the e2e backstop for Task #1673). Canonical Playwright
`runTest` plan that proves the master "Apply all divergent (N)"
affordance and its multi-key confirmation dialog on the
`OrgNotificationDefaultsCard` correctly:

- Surfaces the master button only when 2+ org-wide defaults diverge from
  existing tournaments.
- Opens a confirmation dialog that lists every divergent default with
  its per-key tournament count.
- Submits a single POST to `apply-to-tournaments` carrying every
  divergent key + the org-wide value, applies them all in one shot, and
  refreshes the inheritance summary.
- Surfaces the per-key results-array contract that the UI consumes by
  asserting both DB state and the per-key "applied" badges.

The single-key "Apply to all (N)" path is already covered by
`club-settings-tournament-inheritance.e2e.md`; this plan is purposely
narrow on the multi-key case so a regression in either
`button-apply-all-divergent`, `dialog-confirm-apply-to-tournaments`'s
multi-key body, or the per-key `results: []` contract trips it.

Replay it from any agent notebook with
`runTest({ testPlan, relevantTechnicalDocumentation })` using the bodies
below.

## Page under test

- File: `artifacts/kharagolf-web/src/pages/club-settings.tsx`
  (the `OrgNotificationDefaultsCard` component).
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
  - Per-key inheritance blocks, all under the suffix-naming convention
    used by the registry-driven render. The manual-entry slug is the
    legacy one without a suffix; the other slugs use their `testIdSlug`
    suffix:
      - manual-entry: `block-tournament-inheritance`,
        `badge-inheritance-divergent`,
        `text-inheritance-divergent-count`,
        `badge-inheritance-aligned`,
        `marker-inheritance-divergent-${tournamentId}`
      - schedule-changes: `block-tournament-inheritance-schedule-changes`,
        `badge-inheritance-divergent-schedule-changes`,
        `text-inheritance-divergent-count-schedule-changes`,
        `badge-inheritance-aligned-schedule-changes`,
        `marker-inheritance-divergent-schedule-changes-${tournamentId}`
      - score-corrections: `block-tournament-inheritance-score-corrections`,
        `badge-inheritance-divergent-score-corrections`,
        `text-inheritance-divergent-count-score-corrections`,
        `badge-inheritance-aligned-score-corrections`,
        `marker-inheritance-divergent-score-corrections-${tournamentId}`
  - Multi-default block (only rendered when `divergentBuckets.length > 1`):
      - `block-bulk-apply-all`
      - `button-apply-all-divergent`
  - Confirmation dialog:
      - `dialog-confirm-apply-to-tournaments`
      - `text-confirm-dialog-title`
      - `list-confirm-defaults`
      - `row-confirm-default-manual-entry`,
        `row-confirm-default-schedule-changes`,
        `row-confirm-default-score-corrections`
      - `button-cancel-apply-to-tournaments`
      - `button-confirm-apply-to-tournaments`

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
     ('e2e-multidef-${SUFFIX}@kharagolf-test.local',
      $pw$$2b$10$I1l/Lc1c228eC/w1nRz6H.OhGXfpVh6g8vgUWpJi4eKtLsc6vs8NO$pw$,
      'org_admin', 1, true,
      'E2E MultiDef Admin ${SUFFIX}',
      'e2e_multidef_${SUFFIX}',
      'e2e_multidef_${SUFFIX}',
      NOW(), NOW())
   RETURNING id;
   -- record the returned id as ${TEST_USER_ID}

   IMMEDIATELY verify the row is reachable by the lowercased email lookup
   used by the API:
     SELECT id FROM app_users
      WHERE email = LOWER('e2e-multidef-${SUFFIX}@kharagolf-test.local');
   This MUST return one row with id = ${TEST_USER_ID}. If empty, halt
   and report — ${SUFFIX} contains uppercase characters.

3. [DB] Force ALL THREE org-wide notification defaults ON for org 1 so
   the test starts from a known baseline. The "Apply all divergent"
   button only appears when 2+ keys diverge, so we need the org-wide
   value to differ from each seeded tournament's per-key value on at
   least two keys.
     UPDATE organizations
        SET notify_manual_entry_alerts = true,
            notify_schedule_changes    = true,
            notify_score_corrections   = true
      WHERE id = 1;

   ALSO neutralise pre-existing org-1 tournaments so no stale rows
   contribute to the divergent counts and inflate the per-key totals.
   This keeps the per-key counts predictable below.
     UPDATE tournaments
        SET notify_manual_entry_alerts = true,
            notify_schedule_changes    = true,
            notify_score_corrections   = true
      WHERE organization_id = 1;

4. [DB] Seed two tournaments in org 1, each diverging on TWO of the
   three keys, so:
     - notifyManualEntryAlerts diverges on 2 tournaments (both rows)
     - notifyScheduleChanges   diverges on 1 tournament (only ${T_A_ID})
     - notifyScoreCorrections  diverges on 1 tournament (only ${T_B_ID})
   That gives `divergentBuckets.length === 3` and a total divergent
   count of 4 — a clean signal for the "Apply all divergent (4)" button
   and the 3-row dialog list.

   INSERT INTO tournaments
     (organization_id, name, format, status,
      notify_manual_entry_alerts, notify_schedule_changes, notify_score_corrections)
   VALUES (1, 'E2E MultiDef A ${SUFFIX}', 'stroke_play', 'upcoming',
           false, false, true)
   RETURNING id;
   -- record the returned id as ${T_A_ID}

   INSERT INTO tournaments
     (organization_id, name, format, status,
      notify_manual_entry_alerts, notify_schedule_changes, notify_score_corrections)
   VALUES (1, 'E2E MultiDef B ${SUFFIX}', 'stroke_play', 'draft',
           false, true, false)
   RETURNING id;
   -- record the returned id as ${T_B_ID}

   ALSO seed a completed tournament that diverges on every key. The
   apply-to-tournaments endpoint MUST skip terminal-status rows, so its
   per-key flags must remain unchanged after the bulk apply.

   INSERT INTO tournaments
     (organization_id, name, format, status,
      notify_manual_entry_alerts, notify_schedule_changes, notify_score_corrections)
   VALUES (1, 'E2E MultiDef Done ${SUFFIX}', 'stroke_play', 'completed',
           false, false, false)
   RETURNING id;
   -- record the returned id as ${T_DONE_ID}

5. [API] POST /api/auth/player-login with JSON body
   { "email": "e2e-multidef-${SUFFIX}@kharagolf-test.local",
     "password": "TestPassword123!" }
   using credentials: 'include' so the session cookie is stored on the
   browser context. Expect HTTP 200.

6. [Browser] Navigate to /club-settings. Wait for
   data-testid="card-org-notification-defaults" to render.

7. [Verify] PER-KEY DIVERGENT BADGES are present and counts agree with
   the seed. Do NOT assert exact equality on the manual-entry count —
   the dev DB may already have other org-1 tournaments contributing to
   it (we only neutralised the manual-entry / schedule / corrections
   flags above; row counts are still whatever they were). Each per-key
   divergent count MUST be at least the seeded delta:
     - data-testid="text-inheritance-divergent-count" (manual-entry)
       integer text >= 2.
     - data-testid="text-inheritance-divergent-count-schedule-changes"
       integer text >= 1.
     - data-testid="text-inheritance-divergent-count-score-corrections"
       integer text >= 1.
   Each of `badge-inheritance-divergent`,
   `badge-inheritance-divergent-schedule-changes`, and
   `badge-inheritance-divergent-score-corrections` is visible.

8. [Verify] MASTER MULTI-DEFAULT BLOCK is rendered:
   - data-testid="block-bulk-apply-all" exists.
   - data-testid="button-apply-all-divergent" is enabled and its visible
     text starts with "Apply all divergent (".

9. [Browser] Click data-testid="button-apply-all-divergent". Wait for
   the confirmation dialog data-testid="dialog-confirm-apply-to-tournaments".

10. [Verify] CONFIRMATION DIALOG lists EVERY divergent default:
    - data-testid="text-confirm-dialog-title" visible text contains
      "Apply 3 club-wide defaults".
    - data-testid="list-confirm-defaults" exists.
    - data-testid="row-confirm-default-manual-entry" exists and its
      visible text contains both "Enable" (org-wide value is true) and
      the spec.shortName "manual-entry alerts".
    - data-testid="row-confirm-default-schedule-changes" exists and its
      visible text contains "Enable" + "schedule-change alerts".
    - data-testid="row-confirm-default-score-corrections" exists and its
      visible text contains "Enable" + "score-correction alerts".

11. [Browser] Click data-testid="button-confirm-apply-to-tournaments".
    Wait for the dialog to close.

12. [Verify] APPLY-ALL succeeded in the UI:
    - A toast appears whose title starts with "Applied 3 default" (the
      multi-key copy uses "Applied N defaults (M updates)") OR with
      "Applied " followed by a digit — the count substring is what
      matters.
    - After the inheritance list refetches, every divergent badge has
      been replaced by its aligned counterpart:
        - data-testid="badge-inheritance-divergent" no longer exists.
        - data-testid="badge-inheritance-divergent-schedule-changes" no
          longer exists.
        - data-testid="badge-inheritance-divergent-score-corrections"
          no longer exists.
        - data-testid="badge-inheritance-aligned" exists.
        - data-testid="badge-inheritance-aligned-schedule-changes" exists.
        - data-testid="badge-inheritance-aligned-score-corrections" exists.
    - The master block disappears (no key still diverges, so
      `divergentBuckets.length === 0 < 2`):
        - data-testid="block-bulk-apply-all" no longer exists.
        - data-testid="button-apply-all-divergent" no longer exists.

13. [Verify] DB STATE confirms the per-key results-array contract was
    honoured AND the status filter was respected:

    SELECT notify_manual_entry_alerts, notify_schedule_changes, notify_score_corrections
      FROM tournaments WHERE id = ${T_A_ID};
    → all three columns must be true.

    SELECT notify_manual_entry_alerts, notify_schedule_changes, notify_score_corrections
      FROM tournaments WHERE id = ${T_B_ID};
    → all three columns must be true.

    SELECT notify_manual_entry_alerts, notify_schedule_changes, notify_score_corrections
      FROM tournaments WHERE id = ${T_DONE_ID};
    → all three columns must STILL be false (completed tournaments are
      left untouched by the bulk apply).

14. [DB] Cleanup (best effort — order matters because the audit table
    has a FK on tournaments(id)):
      DELETE FROM tournament_notification_override_audit
       WHERE tournament_id IN (${T_A_ID}, ${T_B_ID}, ${T_DONE_ID});
      DELETE FROM tournaments
       WHERE id IN (${T_A_ID}, ${T_B_ID}, ${T_DONE_ID});
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

CARD UNDER TEST (artifacts/kharagolf-web/src/pages/club-settings.tsx)
- The card is driven by a registry (`ORG_NOTIFY_DEFAULTS`) of three
  org-wide notification defaults today:
    notifyManualEntryAlerts (slug "manual-entry"),
    notifyScheduleChanges  (slug "schedule-changes"),
    notifyScoreCorrections (slug "score-corrections").
- The manual-entry slug renders WITHOUT a suffix on its test ids for
  back-compat with the original Task #1379 plan; every other key uses
  its testIdSlug suffix (see test-id list in this doc's header).
- The master "Apply all divergent (N)" button + block ONLY appear when
  `divergentBuckets.length > 1`. With only one key diverging, the per-
  row "Apply to all (N)" button is the only affordance — see
  club-settings-tournament-inheritance.e2e.md for that path.
- Clicking the master button opens the same AlertDialog used by the
  per-row affordance, with a multi-row body
  (`list-confirm-defaults`/`row-confirm-default-${slug}`) listing each
  divergent default and its per-key tournament count. Confirming fires
  a single POST to /apply-to-tournaments with one boolean per key.

ENDPOINTS (Task #1673 multi-key contract)
- GET /api/organizations/:orgId/notification-defaults/tournaments
    → { tournaments: Array<{
         id, name, status, startDate,
         notifyManualEntryAlerts: boolean,
         notifyScheduleChanges:   boolean,
         notifyScoreCorrections:  boolean,
       }> }
    Only returns rows whose status is in {draft, upcoming, active, suspended}.
- POST /api/organizations/:orgId/notification-defaults/apply-to-tournaments
    body: explicit booleans, e.g.
      { notifyManualEntryAlerts: true,
        notifyScheduleChanges:   true,
        notifyScoreCorrections:  true }
    → {
         results: [
           { key: "notifyManualEntryAlerts",  value: true, updatedCount: <int> },
           { key: "notifyScheduleChanges",    value: true, updatedCount: <int> },
           { key: "notifyScoreCorrections",   value: true, updatedCount: <int> },
         ],
         // legacy single-key fields kept for back-compat
         notifyManualEntryAlerts?: boolean,
         updatedCount?: number,
       }
    Bulk-updates every tournament in the org whose status is in the set
    above and whose current flag differs from the per-key target. The
    per-key results array is what the multi-default toast and the
    aligned-badge refetch logic on the card consumes.

DB SCHEMAS
- organizations(id, notify_manual_entry_alerts boolean default true,
                    notify_schedule_changes    boolean default true,
                    notify_score_corrections   boolean default true, ...)
- tournaments(id, organization_id, name, format, status,
              notify_manual_entry_alerts boolean default true,
              notify_schedule_changes    boolean default true,
              notify_score_corrections   boolean default true, ...)
- tournament_notification_override_audit(id, tournament_id, setting,
              previous_value, new_value, applied_by_user_id, ...) —
  one row per (changed tournament, key) pair on bulk apply. Cleanup
  must delete audit rows BEFORE the tournament rows because of the FK.
- app_users(id, email, password_hash, role, organization_id, email_verified,
            replit_user_id (NOT NULL), display_name, username, ...)

NOTES
- The dev DB has pre-existing tournaments in org 1. Step 3 neutralises
  every org-1 tournament's three flags to true so the seeded rows are
  the only divergent contributors and per-key divergent counts have a
  predictable lower bound. Do NOT assert exact total counts beyond
  those lower bounds.
- The two known auth pitfalls are: (a) replit_user_id is NOT NULL, must
  be populated; (b) the email column is case-sensitive but the login
  endpoint lowercases the input — so the inserted email must be all-lowercase.
```

## Last verified

Run on 2026-04-30: status `success`. Seeded an org_admin and three
tournaments diverging across all three registry keys (two active rows
contributing 2/1/1 to the per-key divergent counts, plus a completed
row that diverges on all three to prove the status filter still skips
it). The first page load showed all three divergent badges plus the
master "Apply all divergent (4)" block; clicking the master button
opened the multi-key dialog with all three `row-confirm-default-*`
entries listing "Enable" + each spec's shortName; confirming fired the
single multi-key POST and the card refetched to show all three aligned
badges with the master block gone. DB checks confirmed both active
tournaments flipped to true on every key while the completed row
remained false on every key. Cleanup deletes ran cleanly.
