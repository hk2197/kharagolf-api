# E2E: Nested clones in the bulk-action history

Covers Task #331 (regression coverage for Task #267). This is the canonical
Playwright `runTest` plan for the inline grouping of clone bulk-audit entries
under their source bucket inside the club-members admin "Bulk action history"
dialog. Replay it from any agent notebook with
`runTest({ testReplitAuth: true, testPlan, relevantTechnicalDocumentation })`
using the bodies below.

## What this test asserts

- A source bulk action shows a `<n> clones` pill that is initially collapsed.
- Clicking the clones pill reveals each clone inline as a child row tagged
  `Clone`, in chronological order.
- Each clone child is itself expandable into the bulk-audit drill-down.
- An "orphan" clone whose `sourceBucket` doesn't match any returned entry
  remains rendered at the top level of the list (not nested anywhere).

## Component / endpoint under test

- File: `artifacts/kharagolf-web/src/pages/club-members.tsx` →
  `BulkAuditDetails` widget + the bulk-action history dialog rendering inside
  the main `ClubMembers` page (search for `list-bulk-audit`).
- Endpoint: `GET /api/organizations/:orgId/members-360/bulk-audit` returns the
  grouped buckets enriched with `actionType` + `sourceBucket` parsed out of
  reasons matching `^bulk redo-of #<iso>(\s+\(filtered: …\))?$`.
- Drill-down endpoint:
  `GET /api/organizations/:orgId/members-360/bulk-audit/details`
  (called when a row is expanded).
- Auth: requires `org_admin` / `super_admin` / `membership_secretary` /
  `treasurer`. `req.user` is taken from `sessions.sess.user`, so the test must
  patch the cached session JSON in addition to `app_users.role`.

### Relevant test ids

- `button-bulk-audit` – opens the dialog from the page header.
- `list-bulk-audit` – container of top-level rows.
- `bulk-audit-entry-${i}` – top-level row at index i (0-based, in API order).
- `bulk-audit-clone-entry-${i}-c${ci}` – clone child row.
- `button-bulk-audit-clones-toggle-${i}` – the "<n> clones" pill toggle.
- `bulk-audit-clones-${i}` – the inline clones container (rendered when
  expanded).
- `button-bulk-audit-expand-${i}` / `button-bulk-audit-clone-expand-${i}-c${ci}`
  – click-targets for opening drill-down on a row / clone child.
- `bulk-audit-details-loading` / `list-bulk-audit-details` – drill-down
  loading state and rendered list inside an expanded row.

## Test plan

```text
1. [New Context] Create a new browser context.

2. [OIDC] Configure the next login claims to:
   { sub: "test-bulk-clones-" + Date.now(),
     email: "bulk-clones-e2e-" + Date.now() + "@example.com",
     first_name: "BulkClones", last_name: "Tester" }

3. [Browser] Navigate to /api/login?returnTo=%2Fclub-members. Wait for the
   redirect chain to settle. Don't visually verify yet. NOTE: do NOT use
   returnTo=%2F — the home redirects to /portal, which currently has an
   unrelated runtime error and blocks the page. Land straight on
   /club-members.

4. [DB] Promote the freshly-logged-in user to org_admin in BOTH the app_users
   table AND inside the active session blob (req.user is read from
   sessions.sess.user, not the DB). Then seed one source bulk freeze plus
   three clones (two nested, one orphan):

   UPDATE app_users SET role='org_admin'
     WHERE id = (SELECT id FROM app_users ORDER BY id DESC LIMIT 1)
     RETURNING id AS user_id, organization_id AS org_id;

   UPDATE sessions
      SET sess = jsonb_set(jsonb_set(sess, '{user,role}', '"org_admin"'),
                            '{user,organizationId}', to_jsonb(${org_id}::int))
    WHERE (sess->'user'->>'id')::int = ${user_id};

   -- Seed three real club_members so the drill-down can render names.
   INSERT INTO club_members (organization_id, first_name, last_name, email)
     VALUES
       (${org_id}, 'Alpha', 'CloneTest',
        'alpha-' || floor(random()*1000000)::int || '@example.com'),
       (${org_id}, 'Bravo', 'CloneTest',
        'bravo-' || floor(random()*1000000)::int || '@example.com'),
       (${org_id}, 'Charlie', 'CloneTest',
        'charlie-' || floor(random()*1000000)::int || '@example.com')
     RETURNING id AS member_id;
   -- Capture them as ${alpha_id}, ${bravo_id}, ${charlie_id} (in order).

   -- A unique tag so the source/clone reasons are distinguishable per run.
   -- Note in the runner state as ${tag}; pick e.g. floor(random()*1e9).
   --
   -- All seeded rows use far-future created_at so they sort to the top of the
   -- default desc-by-lastAt feed (limit=100). The minute portions are chosen
   -- so each entry falls in its own bucket (different minute):
   --   source       2099-04-18T12:34:56Z   → bucket 12:34:00.000Z
   --   clone same   2099-04-18T12:35:30Z   → bucket 12:35:00.000Z
   --   clone filt   2099-04-18T12:36:30Z   → bucket 12:36:00.000Z
   --   clone orphan 2099-04-18T12:37:30Z   → bucket 12:37:00.000Z
   --
   -- The clone reasons reference the source's bucket ISO
   -- (2099-04-18T12:34:00.000Z) so the UI nests them. The orphan references
   -- a bucket that is NOT in the response (1999-01-01T00:00:00.000Z) so it
   -- stays at the top level.

   -- SOURCE bulk freeze: 3 members.
   INSERT INTO member_audit_log
     (club_member_id, organization_id, actor_user_id, actor_name, actor_role,
      entity, action, reason, created_at)
   VALUES
     (${alpha_id},   ${org_id}, ${user_id}, 'BulkClones Tester', 'org_admin',
      'lifecycle', 'create', 'bulk freeze: e2e-' || ${tag},
      '2099-04-18T12:34:56Z'::timestamptz),
     (${bravo_id},   ${org_id}, ${user_id}, 'BulkClones Tester', 'org_admin',
      'lifecycle', 'create', 'bulk freeze: e2e-' || ${tag},
      '2099-04-18T12:34:56Z'::timestamptz),
     (${charlie_id}, ${org_id}, ${user_id}, 'BulkClones Tester', 'org_admin',
      'lifecycle', 'create', 'bulk freeze: e2e-' || ${tag},
      '2099-04-18T12:34:56Z'::timestamptz);

   -- CLONE 1 (same-cohort redo): 2 members; reason = "bulk redo-of #<src>"
   INSERT INTO member_audit_log
     (club_member_id, organization_id, actor_user_id, actor_name, actor_role,
      entity, action, reason, created_at)
   VALUES
     (${alpha_id}, ${org_id}, ${user_id}, 'BulkClones Tester', 'org_admin',
      'lifecycle', 'create',
      'bulk redo-of #2099-04-18T12:34:00.000Z',
      '2099-04-18T12:35:30Z'::timestamptz),
     (${bravo_id}, ${org_id}, ${user_id}, 'BulkClones Tester', 'org_admin',
      'lifecycle', 'create',
      'bulk redo-of #2099-04-18T12:34:00.000Z',
      '2099-04-18T12:35:30Z'::timestamptz);

   -- CLONE 2 (filtered redo of the same source): 1 member; reason includes
   -- the "(filtered: …)" suffix.
   INSERT INTO member_audit_log
     (club_member_id, organization_id, actor_user_id, actor_name, actor_role,
      entity, action, reason, created_at)
   VALUES
     (${charlie_id}, ${org_id}, ${user_id}, 'BulkClones Tester', 'org_admin',
      'lifecycle', 'create',
      'bulk redo-of #2099-04-18T12:34:00.000Z (filtered: VIP only)',
      '2099-04-18T12:36:30Z'::timestamptz);

   -- ORPHAN CLONE: source bucket isn't present in the response → stays at
   -- the top level.
   INSERT INTO member_audit_log
     (club_member_id, organization_id, actor_user_id, actor_name, actor_role,
      entity, action, reason, created_at)
   VALUES
     (${alpha_id}, ${org_id}, ${user_id}, 'BulkClones Tester', 'org_admin',
      'lifecycle', 'create',
      'bulk redo-of #1999-01-01T00:00:00.000Z (filtered: orphan)',
      '2099-04-18T12:37:30Z'::timestamptz);

5. [Browser] Navigate to /club-members. Wait for the page to render and
   dismiss any Vite runtime overlay. Click data-testid="button-bulk-audit"
   to open the "Bulk action history" dialog. Wait for
   data-testid="list-bulk-audit" to render at least one row.

6. [Verify] In the bulk-action history dialog the seeded entries are at the
   top of the feed (sorted desc by lastAt, our timestamps are in 2099 so they
   win). Specifically:
   - data-testid="bulk-audit-entry-0" exists (this is the orphan clone, the
     newest at 12:37:30Z).
   - data-testid="bulk-audit-entry-1" exists (the filtered clone, 12:36:30Z).
   - data-testid="bulk-audit-entry-2" exists (the same-cohort clone,
     12:35:30Z).
   - data-testid="bulk-audit-entry-3" exists (the SOURCE bulk freeze,
     12:34:56Z).
   - The same-cohort clone (entry-2) and the filtered clone (entry-1) are
     NOT rendered as top-level — they are nested under the source. That means
     bulk-audit-entry-1 / bulk-audit-entry-2 here are children of entry-3 in
     the UI tree only when expanded. (See the next step's reordering check.)
   NOTE: top-level rows render in API desc order, and clones are removed from
   the top-level list. So the expected top-level rows in order are actually:
       [0] orphan clone (top-level, sourceBucket missing)
       [1] source bulk freeze  ← shows the "2 clones" pill
   Re-do the assertions with that grouping in mind:
   - data-testid="bulk-audit-entry-0" contains text "1 member" and "Clone"
     (it is the orphan clone, sourceBucket 1999-… not in the feed).
   - data-testid="bulk-audit-entry-1" contains text "3 members" and the
     reason text starting with "bulk freeze: e2e-${tag}".
   - data-testid="button-bulk-audit-clones-toggle-1" is visible and its text
     contains "2 clones".
   - data-testid="bulk-audit-clones-1" does NOT yet exist (still collapsed).

7. [Browser] Click data-testid="button-bulk-audit-clones-toggle-1" to expand
   the clones pill on the source row.

8. [Verify] Inline clones reveal under the source:
   - data-testid="bulk-audit-clones-1" is now visible.
   - It contains exactly two child rows:
       data-testid="bulk-audit-clone-entry-1-c0"
       data-testid="bulk-audit-clone-entry-1-c1"
   - Children are sorted ascending by time, so c0 = same-cohort clone (text
     contains "2 members" and reason "bulk redo-of #2099-04-18T12:34:00.000Z"
     WITHOUT a filtered suffix), c1 = filtered clone (text contains
     "1 member" and reason includes "(filtered: VIP only)").
   - Each clone child shows the small "Clone" badge.

9. [Browser] Click data-testid="button-bulk-audit-clone-expand-1-c0" to open
   the drill-down on the same-cohort clone child. Wait for either
   data-testid="bulk-audit-details-loading" to disappear or
   data-testid="list-bulk-audit-details" to appear.

10. [Verify] Drill-down for the same-cohort clone:
    - data-testid="list-bulk-audit-details" is visible inside
      bulk-audit-clone-entry-1-c0.
    - It contains exactly two member rows (one per affected member):
      look for two elements whose data-testid starts with
      "bulk-audit-detail-row-".
    - Member names "Alpha CloneTest" and "Bravo CloneTest" are visible inside
      the drill-down (case-insensitive substring match is fine).

11. [Browser] Click data-testid="button-bulk-audit-clone-expand-1-c0" again
    to collapse the drill-down (the dialog only allows one expanded row at a
    time, so we tidy up before the next assertion).

12. [Browser] Click data-testid="button-bulk-audit-expand-0" to open the
    drill-down on the orphan clone (which is rendered as a top-level entry
    because its sourceBucket isn't present in the response).

13. [Verify] Orphan clone drill-down:
    - data-testid="list-bulk-audit-details" is visible inside
      bulk-audit-entry-0.
    - It contains exactly one member row (data-testid starts with
      "bulk-audit-detail-row-").
    - Member name "Alpha CloneTest" is visible.
    - The orphan row's reason text contains
      "(filtered: orphan)".

14. [DB] Cleanup — remove only the rows this test inserted:

    DELETE FROM member_audit_log
     WHERE organization_id = ${org_id}
       AND (reason = 'bulk freeze: e2e-' || ${tag}
            OR reason LIKE 'bulk redo-of #2099-04-18T12:34:00.000Z%'
            OR reason = 'bulk redo-of #1999-01-01T00:00:00.000Z (filtered: orphan)');

    DELETE FROM club_members
     WHERE id IN (${alpha_id}, ${bravo_id}, ${charlie_id});
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
  bulk-audit endpoints return 403.

ENDPOINTS
- GET /api/organizations/:orgId/members-360/bulk-audit
  → groups member_audit_log rows whose reason starts with "bulk " into
    per-(actor, entity, reason, minute-bucket) batches, ordered desc by
    max(created_at). Each row is enriched with:
      actionType   – derived from entity (+ first word of reason for
                     entity=lifecycle, e.g. "freeze" / "suspend" / "reinstate")
      sourceBucket – ISO timestamp parsed out of reasons matching
                     /^bulk\s+redo-of\s+#(<iso-with-ms>)/
- GET /api/organizations/:orgId/members-360/bulk-audit/details
  → drill-down for one bucket (bucket, entity, reason, actorUserId).
- Both require role org_admin / super_admin / membership_secretary / treasurer.

UI GROUPING (artifacts/kharagolf-web/src/pages/club-members.tsx)
- The dialog dedupes clones out of the top-level feed:
  for every entry whose parsed sourceBucket matches another entry's bucket
  (after normalising via new Date(b).toISOString()), the entry is moved
  under the source as a child instead of rendering at top level.
- Source rows with at least one child show a "<n> clone(s)" pill
  (data-testid="button-bulk-audit-clones-toggle-${i}") that toggles the
  inline clones container (data-testid="bulk-audit-clones-${i}").
- Children are sorted ascending by lastAt and use test ids
  bulk-audit-clone-entry-${i}-c${ci} with their own
  button-bulk-audit-clone-expand-${i}-c${ci} for the drill-down.
- A clone whose sourceBucket isn't present in the returned entries (orphan)
  stays at the top level; it still renders the small "Clone" badge.

REASON FORMAT (api-server)
- redoBulk uses reason `bulk redo-of #<bucket-iso>`.
- redoBulkFiltered uses `bulk redo-of #<bucket-iso> (filtered: <label>)`.
- bucket-iso is always date_trunc('minute', source.created_at).toISOString()
  → ends in ":SS.000Z".

DB SCHEMAS (lib/db/src/schema/golf.ts)
- sessions(sid varchar pk, sess jsonb, expire timestamp)
- app_users(id, replit_user_id, email, role, organization_id, ...)
- club_members(id, organization_id, first_name, last_name, email, ...)
- member_audit_log(id, club_member_id, organization_id,
   actor_user_id, actor_name, actor_role,
   entity, entity_id, action, field_changes, reason, metadata,
   ip_address, user_agent, created_at)
```

## Last verified

Authored on 2026-04-18 for Task #331. A first end-to-end run is blocked on
the queued task "Restore the dev test database so existing levy tests can
run" — the dev Postgres in this environment is currently missing the
`member_audit_log`, `club_members`, `app_users`, and related tables, so the
[DB] seed step fails with "relation does not exist". Re-run this plan via
`runTest({ testReplitAuth: true, testPlan, relevantTechnicalDocumentation })`
once the dev DB has been restored from the canonical schema (drizzle push of
`lib/db/src/schema/golf.ts`).
