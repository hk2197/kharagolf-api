# E2E: Coach Workspace — Copy / Paste drawings clipboard

Covers Task #2132 (regression coverage for Task #1712). Canonical
Playwright `runTest` plan for the Copy drawings / Paste drawings
clipboard flow inside the coach Deliver dialog at `/coach-workspace`.

> **Primary executable coverage** lives next to this file at
> `artifacts/kharagolf-web/src/tests/coach-workspace.test.tsx` (the two
> Task #1712 vitest cases starting at "Copy/Paste drawings (selection
> branch): clipboard survives close + reopen, pastes at new playhead
> with offsets preserved" and "Copy/Paste drawings (no-selection
> branch): copy stashes the whole list and paste clamps shapes into
> the new clip's duration"). They walk the same flow against the real
> `<CoachWorkspacePage />` + `<DeliverDialog />` components with a
> stubbed fetch backend and are the canonical regression guard.
>
> The `runTest` plan below is supplementary documentation for replaying
> the same scenario as a live browser test (against a real api-server +
> Postgres) from any agent notebook with
> `runTest({ testReplitAuth: true, testPlan, relevantTechnicalDocumentation })`.

## What this test asserts

- The Deliver dialog opens for paid reviews queued under the
  authenticated coach's `teaching_pros` row.
- After drawing three `line` shapes at distinct video times
  (t=1s, t=3s, t=5s) inside the FIRST review:
    - "copy selection" branch: shift-clicking markers 0 and 1 then
      hitting `data-testid="drawing-copy"` stashes the t=1 and t=3
      shapes (NOT the t=5 one) into a coach-local clipboard. The
      `data-testid="drawing-paste"` button on the same dialog flips
      from disabled to enabled with text matching `Paste drawings (2)`.
    - "copy whole list (no selection)" branch: with no markers
      selected, hitting `drawing-copy` stashes ALL 3 shapes — the
      Paste button reads `Paste drawings (3)`.
- Closing the dialog and opening a DIFFERENT review (a second
  `paid` row queued for the same coach) keeps the Paste button
  enabled with the same `(N)` count — i.e. the clipboard survives
  both the dialog unmount AND the post-close `reload()` flicker
  that unmounts QueueTab. Task #2130 made this work by persisting
  the clipboard to `localStorage` keyed by the coach's pro id, then
  rehydrating from disk inside `useState` on every QueueTab remount.
- Scrubbing the playhead in the SECOND review's dialog and clicking
  `drawing-paste` creates one new shape per clipboard entry such that:
    - the earliest clipboard entry anchors at the playhead, and
    - every other entry shifts by the same delta from that anchor,
      preserving the relative time offsets between markers.
- For the no-selection branch: paste clamps copies that would land
  past the end of the clip back to `duration` (a 5s clip after a
  paste at t=2 with a clipboard whose latest entry is t=5 lands the
  third copy at t=5, not t=6).
- Freshly pasted shapes become the active selection
  (`drawing-marker-${i}` carries `data-selected="true"` and the
  `drawing-selection-summary` text matches `/N shapes · N selected/`).
- The selection-driven controls "Move to current time" and
  "Delete shape" act on the pastes (proves the selection is the
  ACTIVE selection, not just a visual highlight): scrubbing to t=8
  and clicking "Move to current time" collapses both pasted markers
  to the 80% strip position; clicking "Delete shape" then leaves
  the dialog at "0 shapes".

## Component / endpoints under test

- File: `artifacts/kharagolf-web/src/pages/coach-workspace.tsx`
  - `CoachWorkspacePage` owns `drawingClipboard` (≈ line 105) and
    threads it through `QueueTab` (≈ line 201) into `DeliverDialog`
    (≈ line 285).
  - `copyDrawings` (≈ line 681) and `pasteDrawings` (≈ line 700) —
    both re-use the `target + (sh.t - minT)` math from
    `duplicateGroupToCurrent` (Task #1416).
  - `drawing-copy` / `drawing-paste` `<Button>`s (≈ line 1115 and
    1124) inside the toolbar.
  - The `drawingClipboard.length === 0` disabled-state guard on
    Paste is what flips the button label from "Paste drawings" to
    "Paste drawings (N)" when something is stashed.
- Endpoints exercised:
  - `GET /api/swing-reviews/coach/queue` — must return at least
    TWO `paid` (or `in_review`) rows whose `proId` matches the
    authenticated user's `teaching_pros` row, so the test can
    open one, close it, and open the other.
- Auth: same as the duplicate-group test — needs a `teaching_pros`
  row keyed to the freshly-logged-in user. No role bump on the
  session is required.

### Relevant test ids (already in production)

- `deliver-dialog` — dialog container.
- `drawing-copy` — the toolbar Copy drawings button.
- `drawing-paste` — the toolbar Paste drawings button. Its visible
  text reads `Paste drawings` when the clipboard is empty and
  `Paste drawings (${N})` when N entries are stashed.
- `drawing-timeline-strip` — the per-frame ribbon below the video.
- `drawing-marker-${i}` — one button per shape on the strip; the
  inline style sets `left: ${(t/dur)*100}%`. Carries
  `data-selected="true|false"`.
- `drawing-selection-summary` — text node with
  `${shapes.length} shape(s)[· ${selectedIdxs.length} selected]`.

## Test plan

```text
1. [New Context] Create a new browser context.

2. [OIDC] Configure the next login claims to:
   { sub: "test-coach-clipbd-" + Date.now(),
     email: "coach-clipbd-e2e-" + Date.now() + "@example.com",
     first_name: "Clipbd", last_name: "Coach" }

3. [Browser] Navigate to /api/login?returnTo=%2Fcoach-workspace. Wait
   for the redirect chain to settle. Don't visually verify yet. NOTE:
   do NOT use returnTo=%2F — the home redirects to /portal which is
   noisy / may bounce; land straight on /coach-workspace.

4. [DB] Promote the freshly-logged-in user into a teaching_pros row in
   their own org so the /coach/queue endpoint accepts them as a coach,
   then seed TWO paid swing_review_request rows for them so the test
   can close the first dialog and open a second.

   SELECT id AS user_id, organization_id AS org_id
     FROM app_users ORDER BY id DESC LIMIT 1;
   -- Capture as ${user_id} / ${org_id}.

   -- A unique tag so the seeded rows can be cleaned up safely.
   -- Note in runner state as ${tag}, e.g. floor(random()*1e9).

   INSERT INTO teaching_pros
     (organization_id, user_id, display_name)
     VALUES (${org_id}, ${user_id}, 'Clipbd Coach ' || ${tag})
     RETURNING id AS pro_id;

   -- Two distinct swing_videos rows so each request points at its
   -- own (the coach/queue endpoint inner-joins on swing_videos).
   INSERT INTO swing_videos (user_id, organization_id, video_url)
     VALUES (${user_id}, ${org_id},
             'https://example.com/clipbd-e2e-A-' || ${tag} || '.mp4')
     RETURNING id AS video_id_a;
   INSERT INTO swing_videos (user_id, organization_id, video_url)
     VALUES (${user_id}, ${org_id},
             'https://example.com/clipbd-e2e-B-' || ${tag} || '.mp4')
     RETURNING id AS video_id_b;

   -- Two paid reviews queued for our coach. Use distinct due_at so
   -- the queue ordering is deterministic (the endpoint orders by
   -- due_at). Status='paid' is what /coach/queue filters on.
   INSERT INTO swing_review_requests
     (organization_id, pro_id, user_id, swing_video_id,
      price_paise, status, escrow_held, due_at)
     VALUES (${org_id}, ${pro_id}, ${user_id}, ${video_id_a},
             50000, 'paid', true, now() + interval '1 day')
     RETURNING id AS request_id_a;
   INSERT INTO swing_review_requests
     (organization_id, pro_id, user_id, swing_video_id,
      price_paise, status, escrow_held, due_at)
     VALUES (${org_id}, ${pro_id}, ${user_id}, ${video_id_b},
             50000, 'paid', true, now() + interval '2 days')
     RETURNING id AS request_id_b;

5. [Browser] Reload /coach-workspace so the freshly-seeded queue rows
   are picked up. Dismiss any Vite runtime overlay if one appears.
   Wait until cards titled "Review #${request_id_a}" AND
   "Review #${request_id_b}" are both visible (each carries an "Open"
   button on the right).

   ----------------------------------------------------------------
   PART A — "copy selection" branch (multi-select 2 of 3 shapes)
   ----------------------------------------------------------------

6. [Browser] Click the "Open" button on the Review #${request_id_a}
   card. Wait for data-testid="deliver-dialog" to render.

7. [Browser] Seed a deterministic video duration + writable
   `currentTime` on the dialog's <video> element so the timeline
   strip renders markers at predictable percentages and we can
   "scrub" without needing the asset to actually load:

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
     window.__setVideoTime = (x) => { t = x; };

8. [Browser] Activate the line tool (toolbar <Button> with visible
   text "line").

9. [Browser] Draw shape 0 at t=1, shape 1 at t=3, shape 2 at t=5
   against the dialog's <canvas>:

     const dialog = document.querySelector('[data-testid="deliver-dialog"]');
     const canvas = dialog.querySelector('canvas');
     const fire = (type, x, y) =>
       canvas.dispatchEvent(new MouseEvent(type, {
         bubbles: true, cancelable: true, clientX: x, clientY: y,
       }));
     window.__setVideoTime(1); fire('mousedown', 10, 10); fire('mouseup', 30, 30);
     window.__setVideoTime(3); fire('mousedown', 40, 10); fire('mouseup', 60, 30);
     window.__setVideoTime(5); fire('mousedown', 70, 10); fire('mouseup', 90, 30);

10. [Verify] Three shapes exist on the timeline:
    - data-testid="drawing-selection-summary" text matches /^3 shapes$/
    - drawing-marker-0/1/2 visible at left = "10%", "30%", "50%".

11. [Browser] Multi-select markers 0 and 1 (NOT marker 2 — that's
    the differentiator from the no-selection branch). Same hand-built
    MouseEvent dance as the duplicate-group test:

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

12. [Verify] Selection summary now reads /3 shapes · 2 selected/.
    Markers 0 and 1 carry data-selected="true"; marker 2 stays
    data-selected="false".

13. [Browser] Click data-testid="drawing-copy". The Paste button on
    the same dialog should now be enabled with text reading
    `Paste drawings (2)`.

14. [Verify]
    - data-testid="drawing-paste" is no longer disabled.
    - Its visible text matches /^Paste drawings \(2\)$/.

15. [Browser] Close the dialog (click the "Close" button next to the
    "Review #${request_id_a}" heading). Wait until
    data-testid="deliver-dialog" is removed from the DOM.

16. [Browser] Click the "Open" button on the Review #${request_id_b}
    card. Wait for a fresh data-testid="deliver-dialog" to render.

17. [Verify] The Paste button on the FRESH dialog still shows the
    surviving clipboard:
    - data-testid="drawing-paste" is enabled.
    - Its text matches /^Paste drawings \(2\)$/.
    - data-testid="drawing-selection-summary" text matches /^0 shapes$/
      (the dialog has its own empty shape list; only the parent-owned
      clipboard survived).

18. [Browser] Repeat the video-seed + scrub helper from step 7 on the
    new dialog (window.__setVideoTime survives across dialogs because
    it lives on `window`, but the inner getter/setter is per-<video>):

      const dialog = document.querySelector('[data-testid="deliver-dialog"]');
      const v = dialog.querySelector('video');
      Object.defineProperty(v, 'duration', { configurable: true, value: 10 });
      v.dispatchEvent(new Event('loadedmetadata'));
      let t = 0;
      Object.defineProperty(v, 'currentTime', {
        configurable: true,
        get: () => t, set: (x) => { t = x; },
      });
      window.__setVideoTime = (x) => { t = x; };

19. [Browser] Scrub to t=4 and click data-testid="drawing-paste".

      window.__setVideoTime(4);
      document.querySelector('[data-testid="drawing-paste"]').click();

20. [Verify] Paste landed at the playhead with relative offsets
    preserved AND the pastes are the active selection. Clipboard
    minT was t=1 (from review A's marker 0), target is t=4:
    - drawing-selection-summary matches /2 shapes · 2 selected/.
    - drawing-marker-0 has style.left = "40%" (4/10 — first paste
      anchors at the playhead since 4 + (1-1) = 4).
    - drawing-marker-1 has style.left = "60%" (6/10 — second paste
      preserves the 2s offset: 4 + (3-1) = 6).
    - both markers carry data-selected="true".

21. [Browser] Verify "Move to current time" acts on the pastes.
    Scrub to t=8 and click the toolbar <Button> with visible text
    "Move to current time":

      window.__setVideoTime(8);
      [...document.querySelectorAll('[data-testid="deliver-dialog"] button')]
        .find(b => b.textContent.trim() === 'Move to current time').click();

22. [Verify] Both pasted markers collapse to the new playhead:
    - drawing-marker-0 style.left = "80%".
    - drawing-marker-1 style.left = "80%".
    - data-selected stays "true" on both.

23. [Browser] Click the toolbar <Button> with visible text
    "Delete shape" to remove every selected shape:

      [...document.querySelectorAll('[data-testid="deliver-dialog"] button')]
        .find(b => b.textContent.trim() === 'Delete shape').click();

24. [Verify] Deleting the active selection removes both pastes:
    - drawing-selection-summary matches /^0 shapes$/.
    - drawing-marker-0 / drawing-marker-1 are no longer in the DOM.

25. [Browser] Close the dialog (click "Close"). Wait until
    deliver-dialog is removed.

   ----------------------------------------------------------------
   PART B — "copy whole list (no selection)" branch + clamp to dur
   ----------------------------------------------------------------

26. [Browser] Open Review #${request_id_a} again (the same card from
    step 6 — the queue cards are still on screen). Wait for the
    fresh deliver-dialog. Re-seed the <video> element with
    duration=10 and a writable currentTime exactly as in step 7.

27. [Browser] Repeat steps 8 and 9 to draw three line shapes at
    t=1, t=3, t=5. (We're operating on a fresh dialog, so its
    shape list starts empty — there's nothing to clean up from
    Part A.) Verify drawing-selection-summary reads /^3 shapes$/
    with NO "selected" suffix — drawing doesn't auto-select, which
    is exactly the precondition for the no-selection branch.

28. [Browser] Click data-testid="drawing-copy" without selecting
    any markers first.

29. [Verify] The Paste button stashed all 3 shapes (not just the
    selected subset, since there was no selection):
    - drawing-paste is enabled with text /^Paste drawings \(3\)$/.

30. [Browser] Close the dialog. Open Review #${request_id_b}.
    Re-seed the <video> with a SHORTER duration (5s) so we can
    verify the duration clamp:

      const dialog = document.querySelector('[data-testid="deliver-dialog"]');
      const v = dialog.querySelector('video');
      Object.defineProperty(v, 'duration', { configurable: true, value: 5 });
      v.dispatchEvent(new Event('loadedmetadata'));
      let t = 0;
      Object.defineProperty(v, 'currentTime', {
        configurable: true,
        get: () => t, set: (x) => { t = x; },
      });
      window.__setVideoTime = (x) => { t = x; };

31. [Verify] Paste button still survived close + reopen, now with
    a count of 3:
    - drawing-paste enabled, text /^Paste drawings \(3\)$/.

32. [Browser] Scrub to t=2 and click drawing-paste:

      window.__setVideoTime(2);
      document.querySelector('[data-testid="drawing-paste"]').click();

33. [Verify] Three pastes landed; the third clamped to the new
    duration. Clipboard minT = 1, target = 2:
    - drawing-selection-summary matches /3 shapes · 3 selected/.
    - drawing-marker-0 style.left = "40%" (2/5 — first paste at
      target = 2).
    - drawing-marker-1 style.left = "80%" (4/5 — second paste at
      2 + (3-1) = 4).
    - drawing-marker-2 style.left = "100%" (5/5 — third paste
      WOULD land at 2 + (5-1) = 6 but is clamped to dur=5).
    - all three markers carry data-selected="true".

34. [DB] Cleanup — remove only the rows this test inserted, in
    FK-safe order. swing_review_requests references swing_videos and
    teaching_pros via ON DELETE restrict / cascade respectively, so
    delete the requests first.

    DELETE FROM swing_review_requests WHERE id IN (${request_id_a}, ${request_id_b});
    DELETE FROM swing_videos          WHERE id IN (${video_id_a}, ${video_id_b});
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

CLIPBOARD OWNERSHIP (artifacts/kharagolf-web/src/pages/coach-workspace.tsx)
- `drawingClipboard: Shape[]` lives on `CoachWorkspacePage` (≈ L105),
  not `QueueTab` or `DeliverDialog`. This matters because:
    1. The dialog's `onClose` calls `reload()` which sets
       `loading=true`, and the page renders <div>Loading…</div> while
       the loading flag is true. That render UNMOUNTS the entire Tabs
       subtree (including QueueTab) — any state owned by QueueTab
       would be lost between Close and the next Open.
    2. Hoisting `drawingClipboard` to the page-level component
       preserves the state across the loading flicker because the
       component itself is not unmounted (only its children are).
- `copyDrawings` (≈ L681) snapshots either the active selection (if
  selectedIdxs.length > 0) or the entire shapes array (if not),
  spreading each entry so subsequent edits in the source dialog don't
  mutate the clipboard contents.
- `pasteDrawings` (≈ L700):
    target  = video.currentTime;
    minT    = min(t over clipboard);
    cap     = video.duration if finite > 0 else +∞;
    copies  = clipboard.map(sh => ({ ...sh,
              t: clamp(0, cap, target + (sh.t - minT)) }));
    setShapes([...shapes, ...copies]);
    setSelectedIdxs(copies.map((_, k) => shapes.length + k));
    setTool('select');
  → freshly pasted copies become the active selection; the earliest
    clipboard entry anchors at the playhead; relative offsets between
    clipboard entries are preserved on the paste; clamped to
    [0, duration] of the NEW clip (which may be shorter than the
    source clip — that's the clamp branch covered by Part B).

PASTE BUTTON LABEL
- The Paste button's visible text reads `Paste drawings` when the
  clipboard is empty and `Paste drawings (${N})` when N entries are
  stashed. The disabled state mirrors `drawingClipboard.length === 0`.
  Both are read straight off the parent-owned state, so a passing
  Step 14 / 17 assertion is what proves the clipboard survived a
  close + reopen.

TIMELINE STRIP (≈ L944–985)
- One <button data-testid="drawing-marker-${i}"> per shape, with
  inline style.left = `${(shape.t / video.duration) * 100}%`. Carries
  data-selected = "true" | "false". The test relies on these
  positions being deterministic to verify the offset-preservation
  and clamp invariants.

VIDEO ELEMENT GOTCHA
- The dialog renders a real <video>, but the seeded video_url here
  doesn't actually load in the test browser — `video.duration` stays
  NaN until we `Object.defineProperty` it and dispatch
  'loadedmetadata' (matches the pattern in
  coach-workspace-duplicate-group.e2e.md). `video.currentTime` is
  the source of truth read by `pasteDrawings` for `target`, so it
  must be patched into a writable getter/setter and stepped from
  the test. Re-seed on each fresh dialog instance because the
  property descriptor lives on the <video> DOM node, which is
  destroyed when the dialog unmounts.

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

Authored on 2026-04-30 for Task #2132. Not yet replayed end-to-end —
the canonical regression coverage is the two Task #1712 vitest cases
in `coach-workspace.test.tsx` (which run automatically as part of
`pnpm --filter @workspace/kharagolf-web test`). Re-run this plan via
`runTest({ testReplitAuth: true, testPlan, relevantTechnicalDocumentation })`
once a workspace agent wants live browser confirmation against a real
api-server + Postgres.
