# E2E: Coach Workspace — Duplicate group action

Covers Task #1711 (regression coverage for Task #1416). Canonical
Playwright `runTest` plan for the "Duplicate group" action inside the
coach Deliver dialog at `/coach-workspace`.

> **Primary executable coverage** lives next to this file at
> `artifacts/kharagolf-web/src/tests/coach-workspace.test.tsx` (the two
> Task #1416 vitest cases starting at "duplicate group copies every
> selected drawing to the playhead, preserving relative offsets" and
> "Cmd/Ctrl+D triggers duplicate group when shapes are selected"). They
> walk the same flow against the real `<DeliverDialog />` component with
> a stubbed fetch backend and are the canonical regression guard.
>
> The `runTest` plan below is supplementary documentation for replaying
> the same scenario as a live browser test (against a real api-server +
> Postgres) from any agent notebook with
> `runTest({ testReplitAuth: true, testPlan, relevantTechnicalDocumentation })`.

## What this test asserts

- The Deliver dialog opens for a paid review queued under the
  authenticated coach's `teaching_pros` row.
- After drawing two `line` shapes at distinct video times (t=1s, t=3s)
  and multi-selecting both via the timeline strip (shift-click on the
  second marker), the selection summary reads `2 shapes · 2 selected`.
- Scrubbing the playhead to t=5s and clicking the "Duplicate group"
  button creates two new shapes such that:
    - the earliest selected source (t=1) is anchored at the new
      playhead (5s), and
    - the second source (t=3) is shifted by the same delta to t=7,
  preserving the 2-second relative offset between the originals.
- The freshly pasted copies become the active selection
  (`4 shapes · 2 selected`) and originals stay put (markers at 10%,
  30% in a 10s clip).
- The `Ctrl+D` keyboard shortcut re-runs the same action against the
  current selection at the (newly scrubbed) playhead, producing one more
  pair of duplicates anchored at the latest playhead.

## Component / endpoints under test

- File: `artifacts/kharagolf-web/src/pages/coach-workspace.tsx`
  - `DeliverDialog` (≈ line 240) and `duplicateGroupToCurrent`
    (≈ line 609).
  - `Cmd/Ctrl+D` keyboard handler (≈ line 789).
  - "Duplicate group" `<Button>` (≈ line 1017).
  - Timeline strip + per-shape markers (≈ lines 944–985).
- Endpoints exercised:
  - `GET /api/swing-reviews/coach/queue` — must return at least one
    `paid` (or `in_review`) row whose `proId` matches the
    authenticated user's `teaching_pros` row.
- Auth: requires the logged-in user to have a `teaching_pros` row
  (`user_id = req.user.id`). The dialog itself doesn't gate on a role
  flag — the queue endpoint is what filters down to the coach.

### Relevant test ids (already in production)

- `deliver-dialog` — dialog container.
- `drawing-timeline-strip` — the per-frame ribbon below the video.
- `drawing-marker-${i}` — one button per shape on the strip; the inline
  style sets `left: ${(t/dur)*100}%` so positions are deterministic
  and assertable. Carries `data-selected="true|false"`.
- `drawing-selection-summary` — text node with
  `${shapes.length} shape(s)[· ${selectedIdxs.length} selected]`.
- `drawing-timeline-box-select` — long-press-then-drag rectangle
  overlay on the strip background (not used by this test, but good
  to know it lives there for sibling tests).

## Test plan

```text
1. [New Context] Create a new browser context.

2. [OIDC] Configure the next login claims to:
   { sub: "test-coach-dupgroup-" + Date.now(),
     email: "coach-dupgroup-e2e-" + Date.now() + "@example.com",
     first_name: "DupGroup", last_name: "Coach" }

3. [Browser] Navigate to /api/login?returnTo=%2Fcoach-workspace. Wait
   for the redirect chain to settle. Don't visually verify yet. NOTE:
   do NOT use returnTo=%2F — the home redirects to /portal which is
   noisy / may bounce; land straight on /coach-workspace.

4. [DB] Promote the freshly-logged-in user into a teaching_pros row in
   their own org so the /coach/queue endpoint accepts them as a coach,
   then seed one paid swing_review_request for them (with the matching
   swing_videos row that the queue inner-joins on). req.user is read
   from sessions.sess.user, but no role bump is needed here — the
   /coach/queue endpoint only checks req.user.id → teaching_pros.user_id.

   SELECT id AS user_id, organization_id AS org_id
     FROM app_users ORDER BY id DESC LIMIT 1;
   -- Capture as ${user_id} / ${org_id}.

   -- A unique tag so the seeded rows can be cleaned up safely and
   -- don't collide with anything else in the org. Note in runner state
   -- as ${tag}, e.g. floor(random()*1e9).

   INSERT INTO teaching_pros
     (organization_id, user_id, display_name)
     VALUES (${org_id}, ${user_id}, 'DupGroup Coach ' || ${tag})
     RETURNING id AS pro_id;

   -- A swing video for the request to point at. video_url can be any
   -- string — the dialog renders an HTMLVideoElement but the test
   -- overrides .duration / .currentTime in step 7 because jsdom-like
   -- browsers won't actually fetch the asset.
   INSERT INTO swing_videos (user_id, organization_id, video_url)
     VALUES (${user_id}, ${org_id},
             'https://example.com/dupgroup-e2e-' || ${tag} || '.mp4')
     RETURNING id AS video_id;

   -- One paid review queued for our coach. price_paise must be >0;
   -- 50000 (₹500) is fine. Status='paid' is what /coach/queue filters
   -- on (the endpoint accepts 'paid' OR 'in_review').
   INSERT INTO swing_review_requests
     (organization_id, pro_id, user_id, swing_video_id,
      price_paise, status, escrow_held, due_at)
     VALUES (${org_id}, ${pro_id}, ${user_id}, ${video_id},
             50000, 'paid', true, now() + interval '1 day')
     RETURNING id AS request_id;

5. [Browser] Reload /coach-workspace so the freshly-seeded queue row
   is picked up. Dismiss any Vite runtime overlay if one appears. Wait
   until a card titled "Review #${request_id}" is visible (it carries
   an "Open" button on the right).

6. [Browser] Click the "Open" button on that card. Wait for
   data-testid="deliver-dialog" to render.

7. [Browser] Seed a deterministic video duration + writable
   `currentTime` on the dialog's <video> element so the timeline
   strip renders markers at predictable percentages and so we can
   "scrub" without needing the asset to actually load. Run inside the
   page (e.g. via page.evaluate or a small JS hop):

     const dialog = document.querySelector('[data-testid="deliver-dialog"]');
     const v = dialog.querySelector('video');
     Object.defineProperty(v, 'duration', { configurable: true, value: 10 });
     v.dispatchEvent(new Event('loadedmetadata'));
     let t = 0;
     Object.defineProperty(v, 'currentTime', {
       configurable: true,
       get: () => t,
       set: (x) => { t = x; },
     });
     // Expose a helper so subsequent steps can scrub from the test:
     window.__setVideoTime = (x) => { t = x; };

8. [Browser] Activate the line tool. Click the toolbar <Button> with
   visible text "line" (Tool: select | line | arrow | circle | angle —
   "line" is the second). The button's variant flips to "default"
   (filled gold) when active.

9. [Browser] Draw shape 0 at t=1 and shape 1 at t=3 against the
   dialog's <canvas>. Use page.evaluate to keep the gesture
   deterministic:

     const dialog = document.querySelector('[data-testid="deliver-dialog"]');
     const canvas = dialog.querySelector('canvas');
     const fire = (type, x, y) =>
       canvas.dispatchEvent(new MouseEvent(type, {
         bubbles: true, cancelable: true, clientX: x, clientY: y,
       }));
     window.__setVideoTime(1);
     fire('mousedown', 10, 10); fire('mouseup', 30, 30);
     window.__setVideoTime(3);
     fire('mousedown', 40, 10); fire('mouseup', 60, 30);

10. [Verify] Two shapes exist on the timeline:
    - data-testid="drawing-selection-summary" text matches /^2 shapes$/
      (no "selected" suffix yet — drawing doesn't auto-select).
    - data-testid="drawing-marker-0" is visible with style.left = "10%"
      (t=1 / dur=10).
    - data-testid="drawing-marker-1" is visible with style.left = "30%"
      (t=3 / dur=10).

11. [Browser] Multi-select both markers. fireEvent in jsdom strips
    `shiftKey` off PointerEvent, so build the events explicitly. From
    page.evaluate:

      const dialog = document.querySelector('[data-testid="deliver-dialog"]');
      const m0 = dialog.querySelector('[data-testid="drawing-marker-0"]');
      const m1 = dialog.querySelector('[data-testid="drawing-marker-1"]');
      const pdown = (el, shift) => el.dispatchEvent(new MouseEvent(
        'pointerdown', { bubbles: true, cancelable: true, shiftKey: shift,
        clientX: 0, clientY: 0 }));
      pdown(m0, false);
      window.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
      pdown(m1, true);
      window.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));

12. [Verify] Both shapes are now in the active selection:
    - data-testid="drawing-selection-summary" text matches
      /2 shapes · 2 selected/.
    - data-testid="drawing-marker-0" has data-selected="true".
    - data-testid="drawing-marker-1" has data-selected="true".

13. [Browser] Scrub the playhead to t=5 (page.evaluate
    `window.__setVideoTime(5)`), then click the toolbar <Button> with
    visible text "Duplicate group" (it carries
    title="Copy every selected drawing to the current time, keeping
    their relative offsets (Ctrl/⌘+D)").

14. [Verify] Group duplicate landed at the playhead with relative
    offsets preserved:
    - data-testid="drawing-selection-summary" text matches
      /4 shapes · 2 selected/.
    - data-testid="drawing-marker-2" exists with style.left = "50%"
      (5/10 — the first paste lands at the playhead because t=1 was
      the earliest selected source and target=5 → 5 + (1-1) = 5).
    - data-testid="drawing-marker-3" exists with style.left = "70%"
      (5/10 + 2/10 — the second paste preserves the 2s offset:
      5 + (3-1) = 7 → 7/10 = 70%).
    - data-testid="drawing-marker-0" still has style.left = "10%" and
      data-selected = "false".
    - data-testid="drawing-marker-1" still has style.left = "30%" and
      data-selected = "false".
    - data-testid="drawing-marker-2" has data-selected = "true".
    - data-testid="drawing-marker-3" has data-selected = "true".

15. [Browser] Re-trigger the action via the keyboard shortcut. The two
    fresh copies are still selected from step 14, so this should add
    two more shapes anchored at the next playhead. Scrub to t=2 first
    so the new pastes land somewhere different (otherwise the math
    overlaps with the existing markers and is harder to read on a
    failing run):

      window.__setVideoTime(2);
      window.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'd', ctrlKey: true, bubbles: true,
      }));

    On macOS-flavoured runners, replace ctrlKey with metaKey — the
    handler accepts either. The earliest selected source is now t=5,
    so the first paste lands at t=2 and the second at t=2+(7-5)=4.

16. [Verify] Ctrl+D fired the same action:
    - data-testid="drawing-selection-summary" text matches
      /6 shapes · 2 selected/.
    - data-testid="drawing-marker-4" exists with style.left = "20%"
      (2/10).
    - data-testid="drawing-marker-5" exists with style.left = "40%"
      (4/10).
    - markers 0..3 keep their previous left% values from step 14
      (the action never moves originals).
    - data-selected: only markers 4 and 5 are true; 0..3 are false.

17. [DB] Cleanup — remove only the rows this test inserted, in
    FK-safe order. swing_review_requests references swing_videos and
    teaching_pros via ON DELETE restrict / cascade respectively, so
    delete the request first.

    DELETE FROM swing_review_requests WHERE id = ${request_id};
    DELETE FROM swing_videos          WHERE id = ${video_id};
    DELETE FROM teaching_pros         WHERE id = ${pro_id};
```

## Technical documentation passed alongside the plan

```text
APP UNDER TEST
- kharagolf-web mounted at "/"; coach workspace is /coach-workspace.
- api-server at /api/* with cookie sessions and Replit OIDC.
- /api/login?returnTo=<safe-path> auto-redirects there after the bypass
  (unless path is "/" or "/login"). Use returnTo=%2Fcoach-workspace.

AUTH GOTCHA
- The auth middleware sets req.user = sessions.sess.user. For the
  /coach/queue endpoint we only need req.user.id to match a
  teaching_pros.user_id row — no role bump is required (no jsonb_set
  on sessions). Just create the teaching_pros row keyed to the
  freshly-logged-in user's id.

ENDPOINT
- GET /api/swing-reviews/coach/queue
    → 401 if unauthenticated, 403 if no teaching_pros row for
      req.user.id. Otherwise returns
      { pro: TeachingProRow,
        queue: Array<{ request: SwingReviewRequestRow,
                       videoUrl, videoThumb, videoFps }> }
      with rows whose status ∈ ('paid', 'in_review'), ordered by
      due_at. (artifacts/api-server/src/routes/swing-reviews.ts ≈ L256.)

DELIVER DIALOG STATE (artifacts/kharagolf-web/src/pages/coach-workspace.tsx)
- shapes: DrawShape[] — one per drawn annotation (line/arrow/circle/
  angle), each with a `t: number` (seconds) capturing the playhead
  time at which the shape was drawn.
- selectedIdxs: number[] — multi-select indices into shapes; the
  "primary" entry is the LAST one (used by single-target Duplicate;
  Duplicate group operates on the entire set).
- duplicateGroupToCurrent (Task #1416, ≈ L609):
    target  = video.currentTime;
    minT    = min(t over selected);
    cap     = video.duration if finite > 0 else +∞;
    copies  = selected.map(sh => ({ ...sh,
              t: clamp(0, cap, target + (sh.t - minT)) }));
    setShapes([...shapes, ...copies]);
    setSelectedIdxs(copies.map((_, k) => shapes.length + k));
  → freshly pasted copies become the active selection; the earliest
    selected source anchors at the playhead; relative offsets between
    selected sources are preserved on the paste; clamped to [0, dur].
- Cmd/Ctrl+D handler (≈ L789): listens on window keydown, triggers
  duplicateGroupToCurrent() iff selectedIdxs.length > 0. Both ctrlKey
  and metaKey are accepted so the same shortcut works on Win/Linux
  and macOS browsers.

TIMELINE STRIP (≈ L944–985)
- One <button data-testid="drawing-marker-${i}"> per shape, with
  inline style.left = `${(shape.t / video.duration) * 100}%`. Carries
  data-selected = "true" | "false". Multi-select supports:
    - plain pointerdown (single-select, replaces selection)
    - shift+pointerdown (toggle membership in current selection)
    - long-press (≥ 400ms) on a marker (enter "multi-select mode";
      subsequent plain taps toggle membership — not used here)
    - long-press-then-drag on the strip background (box-select; not
      used here, but data-testid="drawing-timeline-box-select" is the
      rectangle overlay that appears during a sweep)
- jsdom strips `shiftKey` off React's synthetic PointerEvent; build
  raw MouseEvent('pointerdown', { shiftKey: true }) to drive
  shift-click in tests (the test plan uses page.evaluate to do this
  for parity with the existing vitest test at lines 458–598 of
  coach-workspace.test.tsx).

VIDEO ELEMENT GOTCHA
- The dialog renders a real <video>, but the seeded video_url here
  doesn't actually load in the test browser — `video.duration` stays
  NaN until we `Object.defineProperty` it and dispatch
  'loadedmetadata' (matches the pattern in
  coach-workspace.test.tsx). `video.currentTime` is the source of
  truth read by `duplicateGroupToCurrent` for `target`, so it must be
  patched into a writable getter/setter and stepped from the test.

DB SCHEMAS (lib/db/src/schema/golf.ts)
- sessions(sid varchar pk, sess jsonb, expire timestamp)
- app_users(id, replit_user_id, email, role, organization_id, ...)
- teaching_pros(id, organization_id, user_id, display_name, ...)
    user_id is the FK that /coach/queue keys req.user.id on.
- swing_videos(id, user_id, organization_id, video_url, fps, ...)
- swing_review_requests(id, organization_id, pro_id, user_id,
    swing_video_id, price_paise, status, escrow_held, due_at,
    delivered_at, payout_id, ...)
    status enum includes 'pending_payment' | 'paid' | 'in_review' |
    'delivered'. The /coach/queue endpoint shows 'paid' OR 'in_review'.
```

## Last verified

Authored on 2026-04-30 for Task #1711. Not yet replayed end-to-end —
the canonical regression coverage is the two Task #1416 vitest cases
in `coach-workspace.test.tsx` (which run automatically as part of
`pnpm --filter @workspace/kharagolf-web test`). Re-run this plan via
`runTest({ testReplitAuth: true, testPlan, relevantTechnicalDocumentation })`
once a workspace agent wants live browser confirmation against a real
api-server + Postgres.
