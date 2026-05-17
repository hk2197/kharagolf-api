# E2E: Modifier "Last projection" badge opens the Forecast Accuracy tab

Covers Task #1469. Canonical Playwright `runTest` plan that proves the
"Last projection: ₹X over N days" badge added in Task #1257 on each
demand-modifier card on the admin Dynamic Pricing page:

1. Renders for a modifier that has a recorded
   `publish:modifier-<id>` active-scenario forecast snapshot.
2. When clicked, switches the page to the **Forecast Accuracy** tab so
   admins land where they expect.

The new API endpoint
(`GET /api/organizations/:orgId/tee-pricing/modifiers/publish-snapshots`)
is already covered by a backend test. This e2e adds the missing
user-facing coverage for the badge → fetch → tab-switch wiring.

Replay it from any agent notebook with
`runTest({ testPlan, relevantTechnicalDocumentation })` using the
bodies below.

## Page under test

- File: `artifacts/kharagolf-web/src/pages/dynamic-pricing.tsx`
  (the demand-modifier list, lines ~1053–1118, mounted under the
  `<TabsContent value="modifiers">` block).
- Mounted from: `artifacts/kharagolf-web/src/App.tsx`
  (`<Route path="/dynamic-pricing">`).
- Endpoints exercised:
  - `POST /api/auth/player-login` (cookie session)
  - `GET  /api/organizations/:orgId/tee-pricing/config`
  - `GET  /api/organizations/:orgId/tee-pricing/tiers`
  - `GET  /api/organizations/:orgId/tee-pricing/modifiers`
  - `GET  /api/organizations/:orgId/tee-pricing/audit`
  - `GET  /api/organizations/:orgId/courses`
  - `GET  /api/organizations/:orgId/tee-pricing/rules`
  - `GET  /api/organizations/:orgId`
  - `GET  /api/organizations/:orgId/tee-pricing/tiers/publish-snapshots`
  - `GET  /api/organizations/:orgId/tee-pricing/modifiers/publish-snapshots`
    *(the new Task #1257 endpoint that powers the badge)*
  - `GET  /api/organizations/:orgId/tee-pricing/forecast-accuracy?…`
    (fired when the badge click flips `activeTab` to `accuracy`)
- Auth: `requireOrgAdmin` is enforced on every `tee-pricing/*` route,
  so the seeded user MUST be `org_admin` in the same organization
  that owns the seeded modifier + forecast row. We seed in org 1
  (the same org all the other admin-side e2e plans use).
- Test ids exercised here:
  - `tab-accuracy` — Forecast Accuracy tab trigger (used to assert the
    active tab switched). Radix `<TabsTrigger>` exposes the active
    state via `data-state="active"` on the trigger element.
  - `modifier-${MOD_ID}` — the demand-modifier card (asserts the row
    rendered at all so a missing badge clearly indicates the badge
    wiring is broken, not a missing modifier).
  - `modifier-${MOD_ID}-publish-snapshot` — the badge button itself.

## Test plan

```text
1. [New Context] Create a new browser context.

2. [DB] Insert a verified org_admin test user in org 1. Generate a
   fresh ${SUFFIX} as 6 LOWERCASE hex chars (e.g. nanoid(6).toLowerCase()
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
     ('e2e-modsnap-${SUFFIX}@kharagolf-test.local',
      $pw$$2b$10$I1l/Lc1c228eC/w1nRz6H.OhGXfpVh6g8vgUWpJi4eKtLsc6vs8NO$pw$,
      'org_admin', 1, true,
      'E2E ModSnap Admin ${SUFFIX}',
      'e2e_modsnap_${SUFFIX}',
      'e2e_modsnap_${SUFFIX}',
      NOW(), NOW())
   RETURNING id;
   -- record the returned id as ${TEST_USER_ID}

   IMMEDIATELY verify the row is reachable by the lowercased email lookup
   used by the API:
     SELECT id FROM app_users
      WHERE email = LOWER('e2e-modsnap-${SUFFIX}@kharagolf-test.local');
   This MUST return one row with id = ${TEST_USER_ID}. If empty, halt
   and report — ${SUFFIX} contains uppercase characters.

3. [DB] Insert a fresh active demand modifier in org 1. course_id is
   left NULL on purpose so the badge-click handler reduces to the
   "no course filter" path (m.courseId ?? "" → "") and the test does
   not depend on any specific course existing in the dev DB.

   INSERT INTO tee_dynamic_pricing_modifiers
     (organization_id, course_id, name, kind,
      threshold_min, threshold_max, weather_condition,
      adjustment_type, adjustment_value, apply_to, priority, is_active,
      created_at, updated_at)
   VALUES
     (1, NULL, 'E2E ModSnap ${SUFFIX}', 'utilization',
      '0', '100', NULL,
      'percent', '5', 'any', 0, true,
      NOW(), NOW())
   RETURNING id;
   -- record the returned id as ${MOD_ID}

4. [DB] Insert the matching `publish:modifier-${MOD_ID}` snapshot row
   into tee_pricing_forecasts. We seed this directly (rather than
   relying on the route-side recordPublishForecast() that fires when
   an active modifier is created) so the snapshot row is deterministic
   and present BEFORE the page's reload() request fires — the async
   recordPublishForecast path can race with the page load and is
   covered by its own backend test. Numbers are chosen so the
   rendered text is predictable: ₹12,345 over 30 days.

   INSERT INTO tee_pricing_forecasts
     (organization_id, course_id, actor_user_id, scenario, label,
      horizon_days, window_start, window_end,
      projected_revenue, projected_avg_price,
      projected_seats_booked, projected_seats_total,
      created_at)
   VALUES
     (1, NULL, ${TEST_USER_ID}, 'active',
      'publish:modifier-' || ${MOD_ID},
      30, CURRENT_DATE, CURRENT_DATE + INTERVAL '29 days',
      '12345.00', '500.00', 25, 50,
      NOW())
   RETURNING id;
   -- record the returned id as ${FORECAST_ID}

5. [API] POST /api/auth/player-login with JSON body
   { "email": "e2e-modsnap-${SUFFIX}@kharagolf-test.local",
     "password": "TestPassword123!" }
   using credentials: 'include' so the session cookie is stored on the
   browser context. Expect HTTP 200 and a JSON body whose
   user.role === "org_admin" and user.organizationId === 1.

6. [Browser] Navigate to /dynamic-pricing. Wait for the page to mount
   — concretely, wait until the "Demand Modifiers" tab trigger
   (TabsTrigger with visible text "Demand Modifiers") is visible.
   Dismiss any Vite runtime overlay if present.

7. [Browser] Click the "Demand Modifiers" tab trigger (the Radix
   TabsTrigger whose value is "modifiers" — its visible text is
   "Demand Modifiers"). Wait until data-testid="modifier-${MOD_ID}"
   is visible — that confirms the modifiers list rendered AND our
   seeded modifier is in it.

8. [Verify] BADGE RENDERS for the seeded modifier:
   - data-testid="modifier-${MOD_ID}-publish-snapshot" exists and is
     visible inside data-testid="modifier-${MOD_ID}".
   - Its visible text contains the literal substring "Last projection:".
   - Its visible text contains a rupee amount — the substring "₹12,345"
     (Math.round(12345) → 12345 → toLocaleString() → "12,345").
   - Its visible text contains the substring "30 days".
   - Its `title` attribute contains "Snapshot taken " (the tooltip
     copy that the badge surfaces on hover).

9. [Verify] BASELINE — the Forecast Accuracy tab is NOT yet active.
   The trigger data-testid="tab-accuracy" exists, and its
   `data-state` attribute is NOT "active" (Radix TabsTrigger sets
   `data-state="inactive"` when not selected).

10. [Browser] Click data-testid="modifier-${MOD_ID}-publish-snapshot".
    This calls the inline onClick handler that sets accuracyLabel,
    accuracyScenario, accuracyIncludePending, accuracyTabSeen, and
    flips activeTab to "accuracy".

11. [Verify] TAB SWITCHED to Forecast Accuracy:
    - data-testid="tab-accuracy" now has `data-state="active"`.
    - data-testid="tab-rules" (any sibling tab) has
      `data-state` !== "active" — confirms the tab strip changed
      selection rather than mounting two active tabs.
    - The TabsContent for value="accuracy" is now rendered (use the
      visible heading or any stable text that is unique to the
      accuracy panel — e.g. the "Forecast Accuracy" filter
      controls — to confirm the panel itself swapped in, not just
      the trigger highlight).

12. [DB] Cleanup (run regardless of pass/fail to keep the dev DB tidy.
    Order matters: the forecast row references the modifier's org but
    not the modifier itself, but doing the forecast first is safe and
    keeps the cleanup self-contained even if the modifier delete
    cascades change in the future):
    DELETE FROM tee_pricing_forecasts          WHERE id = ${FORECAST_ID};
    DELETE FROM tee_dynamic_pricing_modifiers  WHERE id = ${MOD_ID};
    DELETE FROM app_users                       WHERE id = ${TEST_USER_ID};
```

## Technical documentation passed alongside the plan

```text
APP UNDER TEST
- kharagolf-web mounted at "/"; the page is /dynamic-pricing.
- api-server at /api/* with cookie sessions. POST /api/auth/player-login
  takes { email, password } and sets the session cookie. The endpoint
  lowercases the email before the DB lookup, so the seeded email row
  MUST already be all-lowercase.

PAGE BEHAVIOUR (artifacts/kharagolf-web/src/pages/dynamic-pricing.tsx)
- DynamicPricingPage reads the active org from useGetMe()
  (user.organizationId). Our seeded user is org 1 → orgId === 1.
- On mount it fires reload() which loads, in parallel:
    /tee-pricing/{config,tiers,modifiers,audit,rules}
    /courses, /organizations/${orgId}
    /tee-pricing/tiers/publish-snapshots
    /tee-pricing/modifiers/publish-snapshots   ← the Task #1257 endpoint
- The modifiers tab maps each modifier row to a <Card data-testid=
  "modifier-${m.id}">. If modifierPublishSnapshots[String(m.id)]
  exists, a <button data-testid="modifier-${m.id}-publish-snapshot">
  is rendered next to the Active/Inactive badges. Its visible text is
  literally:
    "Last projection: ₹{Math.round(projectedRevenue).toLocaleString()} over {horizonDays} days"
  Its onClick handler sets accuracyLabel='publish:modifier-${m.id}',
  accuracyCourseId=(m.courseId ?? ""), accuracyScenario='active',
  accuracyIncludePending=true, accuracyTabSeen=true, and
  activeTab='accuracy' — i.e. it switches tabs.

TAB MARKUP
- The tab strip is a Radix Tabs (`@/components/ui/tabs`). Each
  TabsTrigger renders an element with data-testid set in source
  (tab-rules, tab-forecast, tab-accuracy) and Radix sets
  `data-state="active"` on the currently selected trigger
  (and `data-state="inactive"` on the others). The Tabs root is
  controlled (`value={activeTab}`), so flipping activeTab in the
  onClick handler is what changes the active trigger.

ENDPOINT NEW IN TASK #1257
- GET /api/organizations/:orgId/tee-pricing/modifiers/publish-snapshots
    → { snapshots: { [modifierIdAsString]: { modifierId, label,
        scenario, horizonDays, windowStart, windowEnd,
        projectedRevenue, projectedAvgPrice,
        projectedSeatsBooked, projectedSeatsTotal, createdAt } } }
  Implementation (artifacts/api-server/src/routes/tee-pricing.ts ~529)
  picks the latest active-scenario row per `publish:modifier-<id>`
  label via DISTINCT ON (label) … ORDER BY label, created_at DESC.
  That is why the test's seed row is scenario='active' and label
  exactly 'publish:modifier-' || MOD_ID.

DB SCHEMAS (lib/db/src/schema/golf.ts)
- app_users(id, email, password_hash, role, organization_id,
    email_verified, replit_user_id (NOT NULL), display_name,
    username, ...)
- tee_dynamic_pricing_modifiers(id, organization_id, course_id NULL,
    name, kind tee_pricing_modifier_kind, threshold_min/max numeric,
    weather_condition, adjustment_type tee_pricing_adjustment_type,
    adjustment_value numeric, apply_to tee_pricing_tier_member_type,
    priority int, is_active bool, created_at, updated_at)
- tee_pricing_forecasts(id, organization_id, course_id NULL,
    actor_user_id, scenario text default 'active', label text NULL,
    horizon_days int, window_start date, window_end date,
    projected_revenue numeric(14,2), projected_avg_price numeric,
    projected_seats_booked int, projected_seats_total int,
    projected_revenue_by_day jsonb NULL, assumptions jsonb NULL,
    created_at)

ENVIRONMENT
- The dev DB is shared with the user. NEVER assert absolute counts.
  We assert only on rows we seeded ourselves, keyed by ${MOD_ID}.
- Expected text inside the badge is computed from the seeded numbers
  ("₹12,345" + "30 days") so it is independent of any prior data.
```
