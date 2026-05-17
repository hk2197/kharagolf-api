# Wave 2 browser smoke test plan

This is the natural-language plan the testing harness (`runTest`) executes
against the running web preview. Re-runs should pick a fresh stamp so that
parallel runs never collide on unique constraints. Replace
`__STAMP__` with `wave2_smoke_<unix_ms>` before passing the file to
`runTest`, or template the value at call time.

──────────────────────────────────────────────────────────────────────
PHASE A — SEED.

1. [DB] INSERT INTO organizations (name, slug)
   VALUES ('Smoke Org __STAMP__', 'smoke-org-__STAMP__') RETURNING id;  → ${orgId}.

2. [API] POST /api/auth/register body:
   {"firstName":"Smoke","lastName":"Player","email":"smoke-player-__STAMP__@example.com","password":"smoke-pass-12345"}
   Expect 201, note returned userId as ${playerUserId}.

3. [API] POST /api/auth/register body:
   {"firstName":"Smoke","lastName":"Admin","email":"smoke-admin-__STAMP__@example.com","password":"smoke-pass-12345"}
   Expect 201, note returned userId as ${adminUserId}.

4. [DB] UPDATE app_users
   SET email_verified=true,
       email_verification_token=NULL,
       email_verification_expiry=NULL,
       organization_id=${orgId}
   WHERE id IN (${playerUserId}, ${adminUserId});
   UPDATE app_users SET role='org_admin' WHERE id=${adminUserId};

   Verification sub-step (added after we hit a flaky run where the role
   update silently lagged): SELECT id, role FROM app_users WHERE id IN
   (${playerUserId}, ${adminUserId}); expect player→'player', admin→'org_admin'.

5. [DB] INSERT INTO courses (organization_id, name, slug, holes, par)
   VALUES (${orgId}, 'Smoke Course __STAMP__', 'smoke-course-__STAMP__', 18, 72)
   RETURNING id;  → ${courseId}.

6. [DB] INSERT INTO tournaments (organization_id, course_id, name, cut_line, rounds)
   VALUES (${orgId}, ${courseId}, 'Smoke Tournament __STAMP__', 10, 3)
   RETURNING id;  → ${tournamentId}.

7. [DB] INSERT INTO players (tournament_id, first_name, last_name, user_id) VALUES
     (${tournamentId}, 'Alice', 'S___STAMP__', ${playerUserId}),
     (${tournamentId}, 'Bob',   'S___STAMP__', NULL),
     (${tournamentId}, 'Carol', 'C___STAMP__', NULL),
     (${tournamentId}, 'Dave',  'C___STAMP__', NULL)
   RETURNING id;  → ${p1},${p2},${p3},${p4}.

8. [DB] INSERT INTO scores (tournament_id, player_id, round, hole_number, strokes) VALUES
     (${tournamentId}, ${p1}, 1, 1, 70),(${tournamentId}, ${p1}, 2, 1, 70),
     (${tournamentId}, ${p2}, 1, 1, 71),(${tournamentId}, ${p2}, 2, 1, 71),
     (${tournamentId}, ${p3}, 1, 1, 82),(${tournamentId}, ${p3}, 2, 1, 78),
     (${tournamentId}, ${p4}, 1, 1, 85),(${tournamentId}, ${p4}, 2, 1, 85);

   These hole-1 strokes encode the round totals the cut handler aggregates:
   Alice 140, Bob 142, Carol 160, Dave 170. With cut_line=10 and par=72 the
   handler computes 72*2 + 10 = 154; Alice and Bob survive, Carol and Dave
   are cut.

9. [DB] Coach marketplace seed (two distinct orgs so the region filter has
   something to chew on later if extended):

   INSERT INTO organizations (name, slug)
   VALUES ('Bengaluru Smoke __STAMP__', 'beng-smoke-__STAMP__')
   RETURNING id;  → ${coachOrg1}.

   INSERT INTO organizations (name, slug)
   VALUES ('Mumbai Smoke __STAMP__', 'mum-smoke-__STAMP__')
   RETURNING id;  → ${coachOrg2}.

   INSERT INTO teaching_pros (organization_id, display_name, specialisms, is_active)
   VALUES (${coachOrg1}, 'Coach Aarav __STAMP__', ARRAY['short_game','putting'], true)
   RETURNING id;  → ${proA}.

   INSERT INTO teaching_pros (organization_id, display_name, specialisms, is_active)
   VALUES (${coachOrg2}, 'Coach Bina __STAMP__', ARRAY['driving'], true)
   RETURNING id;  → ${proB}.

   INSERT INTO coach_marketplace_profiles
     (pro_id, organization_id, is_listed, years_experience, hourly_rate_paise,
      async_review_price_paise, accepts_in_person, accepts_async,
      async_turnaround_hours, ratings_avg, ratings_count, languages, certifications)
   VALUES
     (${proA}, ${coachOrg1}, true, 12, 500000, 200000, true, true, 24, '4.80', 12,
      ARRAY['en','hi']::text[],
      '{"coachesHandicapMin":0,"coachesHandicapMax":18}'::jsonb),
     (${proB}, ${coachOrg2}, true, 5,  300000, 600000, true, true, 48, '4.20', 4,
      ARRAY['en']::text[],
      '{"coachesHandicapMin":10,"coachesHandicapMax":36}'::jsonb);

   NOTE: `certifications` is declared text[] in the schema but the live
   handicap filter reads JSON keys via `->>`. If the jsonb cast errors at
   runtime, fall back to inserting the JSON as a single-element text array:
   `ARRAY['{"coachesHandicapMin":0,"coachesHandicapMax":18}']::text[]`.

──────────────────────────────────────────────────────────────────────
PHASE B — FLOW 1: PLAYER submits a course-data correction.

10. [API] POST /api/auth/player-login
    body:{"email":"smoke-player-__STAMP__@example.com","password":"smoke-pass-12345"}
    Expect 200 and a Set-Cookie: sid=…
11. [Browser] Navigate to /portal/course-corrections.
12. [Verify] Heading "Report a Course Data Error" visible;
    data-testid="select-course" lists 'Smoke Course __STAMP__'.
13. [Browser] In data-testid="select-course", choose 'Smoke Course __STAMP__'.
14. [Browser] Type "7" into data-testid="input-hole".
15. [Browser] Leave data-testid="select-field" on default ("par").
16. [Browser] Type "4" into data-testid="input-current".
17. [Browser] Type "5" into data-testid="input-proposed".
18. [Browser] Type "Card and signage say par 5 — smoke test"
    into data-testid="input-reason".
19. [Browser] Click data-testid="button-submit".
20. [Verify]
    - A toast with text "Report submitted — your club will review it shortly." appears.
    - A row matching data-testid prefix "correction-row-" shows
      "Smoke Course __STAMP__", "Hole 7", proposed value "5",
      status "Pending review".
21. [DB] SELECT id FROM course_data_corrections
    WHERE course_id=${courseId} AND hole_number=7 AND status='open';
    → ${correctionId}.
22. [Screenshot] *** REQUIRED *** save a screenshot of the page after the toast.

──────────────────────────────────────────────────────────────────────
PHASE C — FLOW 2: ADMIN moderates the correction.

23. [API] POST /api/auth/player-logout
24. [API] POST /api/auth/player-login
    body:{"email":"smoke-admin-__STAMP__@example.com","password":"smoke-pass-12345"}
    Expect 200.

    Sanity sub-step (added after we hit a flaky run where the AuthGuard
    redirected admin to /portal): GET /api/users/me; expect role='org_admin'
    and organizationId=${orgId}. If not, fail fast — Phase C cannot proceed.

25. [Browser] Navigate to /course-moderation.
26. [Verify] "Course Moderation" heading visible; tab triggers
    data-testid="tab-reviews", "tab-photos", "tab-data-corrections" present.
27. [Browser] Click data-testid="tab-data-corrections".
28. [Verify] data-testid="correction-row-${correctionId}" visible with
    "Hole 7" and proposed value "5".
29. [Browser] Type "Confirmed by smoke test" into
    data-testid="notes-correction-${correctionId}".
30. [Browser] Click data-testid="button-accept-correction-${correctionId}".
31. [Verify] Toast "Correction accepted" appears AND the row leaves the
    open queue.
32. [Browser] Click data-testid="filter-corrections-accepted".
33. [Verify] data-testid="correction-row-${correctionId}" is now visible
    in the Accepted filter.
34. [DB] SELECT status, review_notes, reviewed_by_user_id
    FROM course_data_corrections WHERE id=${correctionId};
    Expect status='accepted', review_notes='Confirmed by smoke test',
    reviewed_by_user_id=${adminUserId}.
35. [Screenshot] *** REQUIRED *** save a screenshot of the Accepted filter.

──────────────────────────────────────────────────────────────────────
PHASE D — FLOW 3: ADMIN clicks Apply Cut.

36. [Browser] Navigate to /tournaments/${tournamentId}.
37. [Verify] data-testid="button-apply-cut" visible (only renders for
    isAdmin === true, which also asserts the admin session is honoured).
38. [Browser] Set up a dialog handler: when window.prompt fires, accept
    and submit "2" (apply cut after round 2).
39. [Browser] Click data-testid="button-apply-cut".
40. [Verify] Toast titled "Cut applied" appears; description includes
    "Score: 154", "2 advanced", and "2 cut".
41. [DB] SELECT id, cut_at FROM players
    WHERE tournament_id=${tournamentId} ORDER BY id;
    Expect cut_at IS NULL for ${p1},${p2}; cut_at IS NOT NULL for ${p3},${p4}.
42. [Screenshot] *** REQUIRED *** save a screenshot after the toast.

──────────────────────────────────────────────────────────────────────
PHASE E — FLOW 4: COACH MARKETPLACE filter sidebar.

The marketplace API maps both `priceMin` and `priceMax` to
`async_review_price_paise` (NOT to hourly rate). Coach Aarav's async price
is ₹2,000 (200,000 paise); Coach Bina's is ₹6,000 (600,000 paise). With
priceMax=4000 (=400,000 paise) Aarav stays and Bina is filtered out.

43. [Browser] Navigate to /coach-marketplace (no login required —
    endpoint is public).
44. [Verify] Both 'Coach Aarav __STAMP__' AND 'Coach Bina __STAMP__'
    are visible.
45. [Browser] Click data-testid="button-toggle-filters".
46. [Verify] Sidebar inputs visible: data-testid "filter-specialty",
    "filter-region", "filter-handicap", "filter-price-min",
    "filter-price-max", "filter-min-rating".
47. [Browser] Type "short_game" into data-testid="filter-specialty".
48. [Verify] After refetch, 'Coach Aarav __STAMP__' visible AND
    'Coach Bina __STAMP__' NOT visible.
49. [Browser] Clear data-testid="filter-specialty".
50. [Browser] Type "4000" into data-testid="filter-price-max".
51. [Verify] After refetch, 'Coach Aarav __STAMP__' visible AND
    'Coach Bina __STAMP__' NOT visible.
52. [Screenshot] *** REQUIRED *** save a screenshot of the filtered list.

──────────────────────────────────────────────────────────────────────
PHASE F — FLOW 5 (REQUIRED): MOBILE booking cancel sheet.

The Expo mobile preview lives on its OWN dev domain (the
`$REPLIT_EXPO_DEV_DOMAIN` env var, e.g. `*.expo.picard.replit.dev`) — Expo
bypasses the workspace proxy, so this phase is driven against that
absolute URL rather than `/mobile/*`. As of task #1629 the mobile bookings
list exposes stable testIDs and the cancel handler uses `window.confirm()`
on web (react-native-web's `Alert.alert` is a no-op stub), so Playwright
can drive the cancel flow end-to-end. This phase is REQUIRED: it must
pass for the smoke run to be considered green.

The org's subscription tier MUST be 'starter' (or higher) — the
`/api/organizations/:orgId/tee-bookings/*` routes are gated by
`requireTeeBookingSubscription` and return 403 for free orgs.

53. [DB] Bring the org under a subscription that allows tee booking, then
    seed a confirmed booking owned by the player whose slot is in the
    near future (the cancel button only renders for confirmed AND upcoming
    rows):

      UPDATE organizations SET subscription_tier='starter' WHERE id=${orgId};

      INSERT INTO course_tee_slots (course_id, organization_id, slot_date, slot_time, capacity, status)
      VALUES (${courseId}, ${orgId}, (now() + interval '1 day')::timestamptz, '09:00', 4, 'open')
      RETURNING id;  → ${teeSlotId}.

      INSERT INTO tee_bookings (slot_id, organization_id, lead_user_id, party_size, status, payment_model)
      VALUES (${teeSlotId}, ${orgId}, ${playerUserId}, 1, 'confirmed', 'pay_at_checkin')
      RETURNING id;  → ${bookingId}.

      INSERT INTO tee_booking_players (booking_id, player_type, user_id)
      VALUES (${bookingId}, 'member', ${playerUserId});

      Also ensure an org_memberships row exists for the player so the
      mobile app's org switcher resolves the active club:

      INSERT INTO org_memberships (organization_id, user_id, role)
      SELECT ${orgId}, ${playerUserId}, 'player'
      WHERE NOT EXISTS (
        SELECT 1 FROM org_memberships
        WHERE organization_id=${orgId} AND user_id=${playerUserId}
      );

54. [Browser] Navigate to the Expo dev domain login page using the
    ABSOLUTE URL — the Expo bundle does NOT live on the workspace proxy.
    Use `https://${process.env.REPLIT_EXPO_DEV_DOMAIN}/login`. Wait for
    `[data-testid="login-email-input"]` to be visible. (If the page
    renders the "Something went wrong" error boundary, capture a
    screenshot and FAIL Phase F — the most common cause is a regression
    in the Google sign-in guard that mounted the auth hook without a
    configured client ID; see `artifacts/kharagolf-mobile/app/(auth)/login.tsx`.)

55. [Browser] Log in via the mobile login form testIDs:
      - Type "smoke-player-__STAMP__@example.com" into [data-testid="login-email-input"]
      - Type "smoke-pass-12345" into [data-testid="login-password-input"]
      - Click [data-testid="login-submit-button"]
    [Verify] The browser navigates AWAY from /login and no
    "Invalid email or password" error appears.

56. [Browser] Navigate to `https://${process.env.REPLIT_EXPO_DEV_DOMAIN}/tee-bookings`
    (again, the absolute Expo dev URL — NOT `/portal` and NOT `/mobile`).
    Then click [data-testid="tee-bookings-tab-mine"] to switch to the
    "My Bookings" tab.

57. [Verify] The seeded booking row is visible:
      - [data-testid="tee-booking-${bookingId}"] is visible.
      - [data-testid="tee-booking-status-${bookingId}"] reads "Confirmed".
      - [data-testid="tee-booking-cancel-${bookingId}"] is visible.

58. [Browser] BEFORE clicking the cancel button, register a one-time
    Playwright dialog handler that ACCEPTS the next dialog
    (the cancel handler uses window.confirm() on web):
        page.once('dialog', d => d.accept())
    Then click [data-testid="tee-booking-cancel-${bookingId}"]. Prefer a
    deterministic wait over a fixed sleep — wait for the status locator
    to update, e.g.
        await expect(
          page.getByTestId(`tee-booking-status-${bookingId}`)
        ).toHaveText("Cancelled", { timeout: 10000 });
    rather than `waitForTimeout`.

59. [Verify] The booking status flipped:
      - [data-testid="tee-booking-status-${bookingId}"] now reads "Cancelled".
      - [data-testid="tee-booking-cancel-${bookingId}"] is no longer
        rendered (the button is gated on status === "confirmed").

60. [DB] SELECT status, cancellation_reason, cancelled_at
    FROM tee_bookings WHERE id=${bookingId};
    Expect status='cancelled', cancellation_reason='user_cancelled',
    cancelled_at IS NOT NULL.

61. [Screenshot] *** REQUIRED *** save a screenshot of the My Bookings
    list AFTER the row flipped to "Cancelled".

──────────────────────────────────────────────────────────────────────
PHASE G — TEARDOWN. Always run, even if any phase failed.

57. [DB] FK-safe order:
      DELETE FROM tee_booking_players WHERE booking_id=${bookingId};
      DELETE FROM tee_bookings WHERE id=${bookingId};
      DELETE FROM course_tee_slots WHERE id=${teeSlotId};
      DELETE FROM scores WHERE tournament_id=${tournamentId};
      DELETE FROM players WHERE tournament_id=${tournamentId};
      DELETE FROM course_data_corrections WHERE course_id=${courseId};
      DELETE FROM tournaments WHERE id=${tournamentId};
      DELETE FROM courses WHERE id=${courseId};
      DELETE FROM coach_marketplace_profiles WHERE pro_id IN (${proA},${proB});
      DELETE FROM teaching_pros WHERE id IN (${proA},${proB});
      DELETE FROM sessions
        WHERE sess->'user'->>'id' IN (${playerUserId}::text, ${adminUserId}::text);
      DELETE FROM app_users WHERE id IN (${playerUserId}, ${adminUserId});
      DELETE FROM organizations WHERE id IN (${orgId}, ${coachOrg1}, ${coachOrg2});

──────────────────────────────────────────────────────────────────────
PASS CRITERIA
- Phases A–E all complete with all [Verify] assertions green.
- Phase F is best-effort (Expo preview limitation).
- 4 screenshots — one per Phase B/C/D/E — are captured.
