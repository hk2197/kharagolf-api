# E2E: Player Portal landing & handicap calculator

Covers Task #354 — confirms the player portal landing page renders for a fresh
player user and the `PortalHandicapCalc` widget mounts without throwing the
"t is not defined" runtime error that previously blocked /portal.

## Component under test

- File: `artifacts/kharagolf-web/src/pages/portal/index.tsx` → `PortalHandicapCalc`
- Container test id: `portal-handicap-calc`
- Auth: requires a logged-in player (cookie session via
  `POST /api/auth/player-login`). Email verification must be satisfied.

## Test plan

```text
1. [New Context] Create a new browser context.

2. [API] Generate a LOWERCASE unique email
   ("portal-e2e-" + nanoid(10).toLowerCase() + "@example.com" → ${email}) and
   POST /api/auth/player-register with JSON
   { email: ${email}, password: "Password123!",
     firstName: "Portal", lastName: "E2E" }
   The register handler lowercases email before insert, so the value you
   pass to subsequent steps must already be lowercase or the DB lookup in
   step 3 will miss the row.

3. [DB] Mark the new user as email-verified so portal login succeeds:
   UPDATE app_users SET email_verified = true WHERE email = '${email}';

4. [Browser] Navigate to /portal. The unauthenticated landing renders the
   sign-in form.

5. [Browser] Fill the EMAIL ADDRESS field with ${email}, the PASSWORD field
   with "Password123!", and click "Sign In".

6. [Browser] Wait for the portal landing to render (still at /portal, but
   now showing the authenticated dashboard). Dismiss any Vite runtime
   overlay if one appears (it should not).

7. [Verify] Player portal landing renders without the previous crash:
   - No element on the page contains the text "is not defined".
   - No element on the page contains the text "ReferenceError".
   - The element [data-testid="portal-handicap-calc"] is visible.
   - That element contains the text "Handicap What-If Calculator".

8. [Verify] Browser console has no uncaught ReferenceError thrown from
   portal/index.tsx (a 401 on /api/portal/rankings/history is expected and
   benign for a brand-new player with no rounds).
```

## Technical documentation passed alongside the plan

```text
APP UNDER TEST
- kharagolf-web mounted at "/"; player portal route is /portal.
- api-server at /api/* with cookie sessions.

AUTH
- Player register: POST /api/auth/player-register
  body { email, password, firstName, lastName }
- Player login:    POST /api/auth/player-login
  body { email, password }
- Player users have role 'player' and the SPA AuthGuard funnels them to
  /portal after login.

WIDGET (artifacts/kharagolf-web/src/pages/portal/index.tsx → PortalHandicapCalc)
- Rendered unconditionally on the authenticated /portal landing.
- Container: data-testid="portal-handicap-calc".
- Uses useTranslation('portal') for slider labels (portal:calc.*).
  The crash being regression-tested was a missing `const { t } = ... `
  destructure inside this component, which surfaced as a "t is not
  defined" Vite error overlay on /portal for every player user.

DB
- app_users(id, email, password_hash, email_verified, role, ...)
```

## Last verified

Run on 2026-04-19: status `success`. Player registered, marked
email_verified via DB, signed in at /portal, landing rendered, no "is not
defined" overlay, `[data-testid="portal-handicap-calc"]` visible with the
"Handicap What-If Calculator" heading.
