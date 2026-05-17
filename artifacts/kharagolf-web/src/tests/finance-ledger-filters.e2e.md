# E2E: Finance ledger filter toolbar

Covers Task #333. Canonical Playwright `runTest` plan for the client-side
filter toolbar on `/finance-ledger` that was added in Task #280 (name
search, created-at range, currency, outstanding-only, and the
"Clear filters" button).

Replay it from any agent notebook with
`runTest({ testReplitAuth: true, testPlan, relevantTechnicalDocumentation })`
using the bodies below.

## Page under test

- File: `artifacts/kharagolf-web/src/pages/finance-ledger.tsx`
- Endpoint: `GET /api/organizations/:orgId/members-360/levies-summary`
- Auth: requires `org_admin` / `super_admin` / `membership_secretary` /
  `treasurer`. `req.user` is read from `sessions.sess.user`, so promoting
  the freshly-logged-in user must patch BOTH `app_users.role` AND the
  cached session blob.
- Test ids exercised here:
  - `ledger-filters` — filter toolbar container
  - `input-filter-name` — name search input
  - `input-filter-from`, `input-filter-to` — created-at date range
  - `select-filter-currency` — currency `<Select>` trigger (Radix)
  - `switch-outstanding-only` — outstanding-only `<Switch>`
  - `button-clear-filters` — the "Clear filters" button (visible only
    while at least one filter is active)
  - `text-filter-count` — "Showing X of Y" caption inside the
    "All levies" card title
  - `row-levy-${id}` — one table row per levy
  - `text-no-matches` — empty state when filters exclude every row

## Test plan

```text
1. [New Context] Create a new browser context.

2. [OIDC] Configure the next login claims to:
   { sub: "test-finledger-" + Date.now(),
     email: "finledger-e2e-" + Date.now() + "@example.com",
     first_name: "Finance", last_name: "Tester" }

3. [Browser] Navigate to /api/login?returnTo=%2F. Wait for the redirect
   chain to settle. Don't visually verify yet.

4. [DB] Promote the freshly-logged-in user to org_admin in BOTH the
   app_users table AND the active session blob (req.user is read from
   sessions.sess.user, not the DB). Then seed an isolated set of
   levies in mixed currencies, statuses and created-at dates so the
   filter assertions are deterministic regardless of any pre-existing
   org data.

   UPDATE app_users SET role='org_admin'
     WHERE id = (SELECT id FROM app_users ORDER BY id DESC LIMIT 1)
     RETURNING id AS user_id, organization_id AS org_id;

   UPDATE sessions
      SET sess = jsonb_set(jsonb_set(sess, '{user,role}', '"org_admin"'),
                            '{user,organizationId}', to_jsonb(${org_id}::int))
    WHERE (sess->'user'->>'id')::int = ${user_id};

   -- Wipe any pre-existing levies in this org so "Showing X of Y" is
   -- predictable. The test owns the org for this run.
   DELETE FROM member_levies WHERE organization_id = ${org_id};

   -- One member is enough; charges drive the per-status totals.
   INSERT INTO club_members (organization_id, first_name, last_name, email)
     VALUES (${org_id}, 'Finance', 'Tester',
             'finledger-member-' || floor(random()*1000000)::int || '@example.com')
     RETURNING id AS member_id;

   -- Stable, searchable suffix so the name filter can target this run
   -- only even if the table later contains other "Annual …" levies.
   -- We surface ${tag} below; reuse it everywhere.
   --   tag = 'FLT' || floor(random()*1000000)::int
   -- Levy A: INR, created OLD (2025-02-15), fully PAID (no outstanding)
   INSERT INTO member_levies
     (organization_id, name, amount, currency, status,
      applied_at, applied_by_user_id, created_at)
     VALUES (${org_id}, 'Annual subscription ' || ${tag},
             '1000.00', 'INR', 'applied',
             '2025-02-15T10:00:00Z', ${user_id},
             '2025-02-15T10:00:00Z')
     RETURNING id AS levy_a_id;

   INSERT INTO member_levy_charges
     (levy_id, club_member_id, amount, paid, status, paid_amount)
     VALUES (${levy_a_id}, ${member_id}, '1000.00', true, 'paid', '1000.00');

   -- Levy B: USD, created RECENT (2025-09-10), UNPAID (outstanding>0)
   INSERT INTO member_levies
     (organization_id, name, amount, currency, status,
      applied_at, applied_by_user_id, created_at)
     VALUES (${org_id}, 'Tournament fee ' || ${tag},
             '50.00', 'USD', 'applied',
             '2025-09-10T10:00:00Z', ${user_id},
             '2025-09-10T10:00:00Z')
     RETURNING id AS levy_b_id;

   INSERT INTO member_levy_charges
     (levy_id, club_member_id, amount, paid, status, paid_amount)
     VALUES (${levy_b_id}, ${member_id}, '50.00', false, 'unpaid', '0');

   -- Levy C: EUR, created RECENT (2025-09-20), PARTIAL (outstanding>0)
   INSERT INTO member_levies
     (organization_id, name, amount, currency, status,
      applied_at, applied_by_user_id, created_at)
     VALUES (${org_id}, 'Locker rental ' || ${tag},
             '200.00', 'EUR', 'applied',
             '2025-09-20T10:00:00Z', ${user_id},
             '2025-09-20T10:00:00Z')
     RETURNING id AS levy_c_id;

   INSERT INTO member_levy_charges
     (levy_id, club_member_id, amount, paid, status, paid_amount)
     VALUES (${levy_c_id}, ${member_id}, '200.00', false, 'partial', '60.00');

   -- Levy D: INR, created OLD (2025-03-01), WAIVED (no outstanding)
   INSERT INTO member_levies
     (organization_id, name, amount, currency, status,
      applied_at, applied_by_user_id, created_at)
     VALUES (${org_id}, 'Range balls ' || ${tag},
             '300.00', 'INR', 'applied',
             '2025-03-01T10:00:00Z', ${user_id},
             '2025-03-01T10:00:00Z')
     RETURNING id AS levy_d_id;

   INSERT INTO member_levy_charges
     (levy_id, club_member_id, amount, paid, status, paid_amount,
      waived_reason)
     VALUES (${levy_d_id}, ${member_id}, '300.00', false, 'waived', '0',
             'goodwill');

5. [Browser] Navigate to /finance-ledger. Wait for the "All levies" card
   to render and for data-testid="text-filter-count" to read
   "Showing 4 of 4". Dismiss any Vite runtime overlay if present.

6. [Verify] BASELINE — no filters active:
   - data-testid="text-filter-count" text equals "Showing 4 of 4".
   - All four rows are present:
       data-testid="row-levy-${levy_a_id}",
       data-testid="row-levy-${levy_b_id}",
       data-testid="row-levy-${levy_c_id}",
       data-testid="row-levy-${levy_d_id}".
   - data-testid="button-clear-filters" does NOT exist (no filter active).

7. [Browser] NAME FILTER — focus data-testid="input-filter-name" and type
   "Tournament" (case-insensitive substring of Levy B's name).

8. [Verify] Name filter narrows the table to Levy B only:
   - data-testid="text-filter-count" text equals "Showing 1 of 4".
   - data-testid="row-levy-${levy_b_id}" IS visible.
   - data-testid="row-levy-${levy_a_id}" does NOT exist.
   - data-testid="row-levy-${levy_c_id}" does NOT exist.
   - data-testid="row-levy-${levy_d_id}" does NOT exist.
   - data-testid="button-clear-filters" IS visible.

9. [Browser] Click data-testid="button-clear-filters" and wait for
   data-testid="text-filter-count" to read "Showing 4 of 4" again.

10. [Verify] CLEAR-FILTERS restored the full table:
    - data-testid="text-filter-count" text equals "Showing 4 of 4".
    - All four data-testid="row-levy-${levy_*_id}" rows are present.
    - data-testid="button-clear-filters" does NOT exist.
    - data-testid="input-filter-name" value is empty.

11. [Browser] DATE-RANGE FILTER — fill data-testid="input-filter-from"
    with "2025-09-01" and data-testid="input-filter-to" with "2025-09-30".
    These are <input type="date">; set the value via .fill("YYYY-MM-DD").

12. [Verify] Created-at range keeps only the September rows (B + C):
    - data-testid="text-filter-count" text equals "Showing 2 of 4".
    - data-testid="row-levy-${levy_b_id}" IS visible.
    - data-testid="row-levy-${levy_c_id}" IS visible.
    - data-testid="row-levy-${levy_a_id}" does NOT exist.
    - data-testid="row-levy-${levy_d_id}" does NOT exist.

13. [Browser] CURRENCY FILTER — open the Radix select by clicking
    data-testid="select-filter-currency", then click the listbox option
    whose visible text is "USD".

14. [Verify] Currency + date combined leaves only Levy B:
    - data-testid="text-filter-count" text equals "Showing 1 of 4".
    - data-testid="row-levy-${levy_b_id}" IS visible.
    - data-testid="row-levy-${levy_a_id}" / ${levy_c_id} / ${levy_d_id}
      do NOT exist.

15. [Browser] Click data-testid="button-clear-filters" and wait for
    data-testid="text-filter-count" to read "Showing 4 of 4".

16. [Browser] OUTSTANDING-ONLY — click data-testid="switch-outstanding-only"
    (the Radix Switch root, an accessible role="switch"). Wait until
    data-testid="text-filter-count" updates.

17. [Verify] Outstanding-only keeps only the unpaid + partial rows:
    - data-testid="text-filter-count" text equals "Showing 2 of 4".
    - data-testid="row-levy-${levy_b_id}" IS visible (unpaid).
    - data-testid="row-levy-${levy_c_id}" IS visible (partial).
    - data-testid="row-levy-${levy_a_id}" does NOT exist (paid).
    - data-testid="row-levy-${levy_d_id}" does NOT exist (waived).

18. [Browser] COMBINED — with outstanding-only still on, also open
    data-testid="select-filter-currency" and choose "EUR".

19. [Verify] Currency + outstanding combined leaves only Levy C:
    - data-testid="text-filter-count" text equals "Showing 1 of 4".
    - data-testid="row-levy-${levy_c_id}" IS visible.
    - data-testid="row-levy-${levy_b_id}" / ${levy_a_id} / ${levy_d_id}
      do NOT exist.

20. [Browser] EMPTY STATE — change the currency select to "INR" (still
    outstanding-only). No INR levy has outstanding > 0, so the table
    body should show the empty state instead of any rows.

21. [Verify] Empty state copy is shown and rows are gone:
    - data-testid="text-filter-count" text equals "Showing 0 of 4".
    - data-testid="text-no-matches" IS visible and contains
      "No levies match the current filters.".
    - data-testid="row-levy-${levy_a_id}" / ${levy_b_id} / ${levy_c_id} /
      ${levy_d_id} do NOT exist.

22. [Browser] Click data-testid="button-clear-filters-empty" inside the
    empty state and wait for data-testid="text-filter-count" to read
    "Showing 4 of 4".

23. [Verify] Empty-state Clear filters fully resets the toolbar:
    - data-testid="text-filter-count" text equals "Showing 4 of 4".
    - All four data-testid="row-levy-${levy_*_id}" rows are present.
    - data-testid="button-clear-filters" does NOT exist.
    - data-testid="text-no-matches" does NOT exist.
    - data-testid="input-filter-name" value is empty.
    - data-testid="input-filter-from" value is empty.
    - data-testid="input-filter-to"   value is empty.
    - data-testid="switch-outstanding-only" is in the unchecked state
      (aria-checked="false").

24. [DB] Cleanup:
    DELETE FROM member_levies WHERE organization_id = ${org_id};
    DELETE FROM club_members  WHERE id = ${member_id};
```

## Technical documentation passed alongside the plan

```text
APP UNDER TEST
- kharagolf-web mounted at "/"; page is /finance-ledger.
- api-server at /api/* with cookie sessions and Replit OIDC.
- /api/login?returnTo=<safe-path> auto-redirects there after the bypass
  (unless path is "/" or "/login").

AUTH GOTCHA
- The auth middleware sets req.user = sessions.sess.user. Updating
  app_users.role does NOT change req.user; you MUST also patch
  sessions.sess via jsonb_set as in step 4. Without that the
  /levies-summary endpoint returns 403.

ENDPOINT
- GET /api/organizations/:orgId/members-360/levies-summary
  → returns { levies: LevySummary[], totalsByCurrency: {...} }.
- All filtering is CLIENT-SIDE in finance-ledger.tsx; the API call is
  made once on page mount. No request is repeated as filters change.

PAGE FILTER TOOLBAR (artifacts/kharagolf-web/src/pages/finance-ledger.tsx)
- Container: data-testid="ledger-filters".
- Caption: data-testid="text-filter-count" — "Showing X of Y" where
  X = filteredLevies.length, Y = summaryQuery.data.levies.length.
- Inputs:
  - data-testid="input-filter-name" — case-insensitive substring match
    against levy.name.
  - data-testid="input-filter-from" / "input-filter-to" — inclusive
    created-at date range; "to" snaps to 23:59:59.999 of that day.
  - data-testid="select-filter-currency" — Radix Select. Options are
    "All currencies" plus the distinct currencies in the response.
  - data-testid="switch-outstanding-only" — Radix Switch. When on,
    filter keeps levies whose outstanding > 0.
- Buttons:
  - data-testid="button-clear-filters" — only mounted while
    `filtersActive` is true (any filter not at its default).
  - data-testid="button-clear-filters-empty" — same handler, rendered
    inline inside the empty-state copy when no rows match.
- Filter values are mirrored to the URL via history.replaceState; the
  test does not need to assert on the URL.

ROWS
- Each levy renders <tr data-testid="row-levy-${l.id}">.
- Empty state when summary loaded but filteredLevies is empty:
  data-testid="text-no-matches".

DB SCHEMAS (lib/db/src/schema/golf.ts)
- sessions(sid varchar pk, sess jsonb, expire timestamp)
- app_users(id, replit_user_id, email, role, organization_id, ...)
- club_members(id, organization_id, first_name, last_name, email, ...)
- member_levies(id, organization_id, name, amount, currency, scope,
                status, applied_at, applied_by_user_id, created_at, ...)
- member_levy_charges(id, levy_id, club_member_id, amount, paid, status,
                     paid_amount, refunded_amount, waived_reason, ...)
  status ∈ {unpaid, partial, paid, waived, refunded}.

OUTSTANDING SEMANTICS (matches the SQL in /levies-summary)
- A levy contributes to "outstanding" iff it has at least one charge
  whose status is in ('unpaid','partial'), in which case the per-charge
  outstanding = max(amount - paid_amount - refunded_amount, 0).
- Paid, waived and refunded charges contribute 0 → those levies are
  filtered out by the "Outstanding only" switch.
```

## Last verified

Run on 2026-04-19: status `success`. Baseline 4/4 → name filter 1/4 →
clear reset 4/4 → September date range 2/4 → +USD currency 1/4 → reset
→ outstanding-only 2/4 → +EUR 1/4 → +INR empty state with
`text-no-matches` → empty-state Clear filters back to 4/4. DB cleanup
of seeded levies + member ran cleanly.
