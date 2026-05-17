# Gap-Closure Plan — KHARAGOLF vs. Best-in-Class Golf Apps

_Author: Replit Agent · Date: April 20, 2026_

This plan turns every gap from `pre-power-mode-feature-audit.md` into a concrete sequence of work items. Scope: **everything in best-in-class golf apps that KHARAGOLF doesn't already have built, queued, or actively in-flight as of April 18, 2026**. Items already covered by the 5 in-scope queued tasks (#71, #72, #78, #450, #451) are explicitly excluded so we don't double-book.

The plan is organized into **four waves** by what unblocks what, then a **per-area work-item catalogue** so you can see the full list. Severity (from the audit) is preserved as a tag on each item: 🔴 Critical · 🟠 Major · 🟡 Minor · ⚪ Cross-cutting.

---

## How to read this plan

- A **work item** is sized to be ~1 project task in our current planning model. Some are split into A/B/C sub-items where the natural seam is obvious.
- Each item lists: **Gap** (one-line summary) · **Outcome** (what "done" looks like) · **Depends on** (other items or platform investments) · **Effort** (S/M/L — small = days, medium = 1–2 weeks of focused build, large = 3+ weeks or needs multiple sub-tasks).
- "**Platform investment**" means foundational work that unlocks many later items. These are deliberately surfaced separately because they are easy to under-scope.
- Wave numbering is a recommendation, not a hard ordering. The actual sequence depends on which segment we're targeting next (serious players vs. clubs vs. tournament operators vs. coaches).

---

## Closure principles

Five decisions to make once, then reuse across most items:

1. **Native client strategy.** Watch + LTE-independent operation requires real native artifacts. Decision: do we build via Expo's native modules (cheaper, slower for true watch UX) or eject to true native (Swift / Kotlin) for the watch only? Queued task #78 forces this decision before Wave 1.
2. **Course-data provider.** Mapped greens, hazard polygons, aerial imagery, and PlaysLike all collapse into one decision: which course-data provider do we license (or do we build a club-side mapper)? Without this, gaps #1, #4, #5, #6 all stay open.
3. **Email deliverability provider.** Quiet hours, digest mode, and per-message audit are cheap once we've migrated off Gmail SMTP onto Postmark / SendGrid / Resend with a verified `kharagolf.com` domain (DKIM/SPF/DMARC). Without that migration, the gap stays open no matter how much UI we build.
4. **Analytics instrumentation contract.** Almost no pre-power-mode feature emits structured events. We need a single event-bus contract (e.g. a thin wrapper that writes to PostHog / Mixpanel / our own table) so Wave 2 instrumentation work can reuse it.
5. **Design-token system.** Branding came in waves; consistency depends on engineer memory. A token system (CSS variables + Tailwind theme + Expo design tokens) prevents drift and unlocks per-club theming (#24).

---

## Wave 0 — Platform investments + queued tasks

These are the prerequisites. Nothing in Wave 1+ closes cleanly without them.

| # | Item | Outcome | Effort |
|---|---|---|---|
| W0-1 | Ship queued tasks **#71** Team entity, **#72** Tournament parity, **#78** Native watch, **#450** Recap notify durability, **#451** Server-side recap images | Already-planned closures land. Audit area #6, #8, #10, #15-recap, #16-recap shrink. | Already scoped |
| W0-2 | **Choose & migrate to a transactional email provider** (Postmark recommended for deliverability + audit trail). Verify `kharagolf.com` with DKIM/SPF/DMARC. Replace Gmail SMTP everywhere. | All transactional mail has provider-level analytics, bounce handling, one-click unsubscribe, per-message audit. | M |
| W0-3 | **Choose course-data provider** (or build club-side mapper). Decision doc + spike ingest. | Hole geometry (greens, hazards, fairway centerlines) available in our schema. Unblocks #1, #4, #5, #6. | M (decision) + L (ingest) |
| W0-4 | **Define analytics event contract.** Single helper `track(eventName, payload)` wired to a chosen sink (PostHog recommended for self-serve dashboards). Migrations land for an `analytics_events` fallback table. | Every Wave 1+ feature emits at least 1 structured event for free. | S |
| W0-5 | **Design-token system.** Define token palette (color, type, spacing, radius, motion) once. Wire to Tailwind config + Expo theme + per-club CSS variable overrides. | Per-club theming unlocked. Future design polish PRs are 30% smaller. Closes part of #24. | M |
| W0-6 | **Native watch artifact decision** (Expo native module vs. Swift/Kotlin watch app). Spike one screen each, pick a path, document. | #78 has a clear technical direction. | S (spike) |
| W0-7 | **Real-club soak partner identified.** One real, non-technical club admin signed up to soak Wave 1+ ops features (#19, #22, #24). | Cross-feature seams (#19, #22) get real-world feedback instead of synthetic. | S (relationship) |

---

## Wave 1 — Close the four Critical gaps

These four are blocking serious-golfer adoption. Each is a multi-task program, not a single task.

### W1-A · Re-platform the in-round scoring screen 🔴 (#4)
- **Gap:** Scoring screen lacks the layered glance-strip + one-tap detail + per-shot sheet pattern. No voice scoring. Format-aware widgets (stableford pts, match-play "2 UP", skins running totals) not surfaced inline. No rules prompts. No max-score "pick up" prompt. No `aiCaddieMode` enforcement.
- **Outcome:** New `RoundScreen` component with: glance bar (player, hole, shot count, score-to-par, format widget) → tappable hole detail → per-shot sheet → post-hole micro-summary. Voice scoring ("birdie", "bogey", "five"). Format-specific widget swaps based on event format. Lost-ball / penalty drop wizard with rule reference. Max-score auto-pickup for stableford. `roundContext.aiCaddieMode` flag (Open / Distance-only / Lockdown) read by both phone and watch with audit logging.
- **Sub-tasks:** W1-A1 layered UI · W1-A2 voice scoring · W1-A3 format-aware widgets · W1-A4 rules wizard · W1-A5 `aiCaddieMode` enforcement (web + mobile + watch).
- **Picks up cancelled work:** #34 (shareable scorecards), #38 (live hole-by-hole tracker), #39 (AI golf rules assistant).
- **Depends on:** W0-3 (course data for accurate yardages used in widgets), W0-4 (event tracking).
- **Effort:** L (3 sub-tasks of M each).

### W1-B · Offline scoring depth + GPS realism 🔴 (#5)
- **Gap:** Offline buffers scores only. No course bundle pre-cache. No leaderboard pre-cache. No sync-conflict UI. GPS to single point only — no F/C/B of green, no PlaysLike. No documented battery-aware GPS strategy. Round-export PDF utilitarian.
- **Outcome:** "Open round" pre-caches course bundle (geometry from W0-3), last 7 days of leaderboards, and player's own historical context. Sync-conflict UI when same round was edited on two offline devices. F/C/B of green yardages with PlaysLike (slope-aware, gated by event mode + `aiCaddieMode`). Documented battery-aware GPS sampler (high cadence on tee, low between holes). Round-export PDF redesigned to share-card quality.
- **Sub-tasks:** W1-B1 course bundle pre-cache · W1-B2 leaderboard pre-cache · W1-B3 sync conflict UI · W1-B4 F/C/B + PlaysLike · W1-B5 battery-aware GPS sampler · W1-B6 round-export redesign.
- **Depends on:** W0-3 (course data).
- **Effort:** L.

### W1-C · Native watch app shipped 🔴 (#6)
- **Gap:** No native watch app shipped to App Store / Play Store. No glance-first hole face. No swipe entry. Watch can't operate without phone. No haptic prompts. No `aiCaddieMode` respect.
- **Outcome:** Native watch artifact (path chosen in W0-6) shipped to TestFlight / Play Internal Track. Glance-first hole face (one big yardage number, configurable F/C/B). Swipe-based score entry + shot tagging. LTE-independent flow (own session, own sync queue). Haptic prompts: your turn, concede, pace warning. Reads `roundContext.aiCaddieMode` from the same API the phone uses.
- **Sub-tasks:** W1-C1 native shell + auth · W1-C2 hole-face glance UI · W1-C3 swipe entry · W1-C4 LTE-independent sync · W1-C5 haptics + `aiCaddieMode`.
- **Depends on:** W0-3, W0-6, queued task #78 (this is the implementation of #78 with detail beyond the title).
- **Effort:** L.

### W1-D · Player analytics & shot stats 🔴 (#13)
- **Gap:** No first-party shot detection. Strokes-gained sparse without auto-tag. No personal baseline ("you're 0.4 strokes worse than last summer"). No proximity-to-pin distribution by club. No weather × performance correlation.
- **Outcome:** Tap-to-drop shot-tagging on the in-round screen with auto-club inference (from prior shots + distance). Personal baseline computed on every round close ("driving SG vs. your trailing-30-day baseline"). Proximity-to-pin distribution chart by club distance bucket. Weather × performance overlay on the analytics screen ("you score 1.5 strokes worse in 15+ mph wind").
- **Sub-tasks:** W1-D1 tap-to-drop shot tag · W1-D2 auto-club inference · W1-D3 personal baseline computation + UI · W1-D4 proximity-by-club chart · W1-D5 weather correlation.
- **Picks up cancelled work:** #35 (Enhanced Player Statistics).
- **Depends on:** W0-3 (course geometry for shot-end coordinates), W0-4 (events for adoption tracking), W1-A (shot tagging lives on the new scoring screen).
- **Effort:** L.

---

## Wave 2 — Close the seven Major gaps

### W2-A · Course lookup depth 🟠 (#1)
- **Gap:** No mapped greens / hazard polygons / aerial imagery. No tee-by-tee gender ratings split. No crowd-sourced corrections. No offline course bundle. No seasonal yardage adjustments.
- **Outcome:** Course view shows mapped greens, hazard polygons, aerial layer (from W0-3 provider). Tee-by-tee gender ratings stored and surfaced. "Report incorrect data" button on every hole view → moderation queue for club admin. Seasonal yardage adjustments (clubs can submit a delta for a date range).
- **Sub-tasks:** W2-A1 ingest geometry · W2-A2 mobile + web hole map · W2-A3 gender ratings split · W2-A4 corrections moderation queue · W2-A5 seasonal adjustments.
- **Depends on:** W0-3.
- **Effort:** M.

### W2-B · Live scoring console parity 🟠 (#3)
- **Gap:** No conflict-resolution UI between sources (marker / official / kiosk). No verify/attest step before publish. Audit trail not surfaced inline. No bulk recompute for scoring config changes. No keyboard-first interaction model.
- **Outcome:** Conflict queue showing every hole with > 1 source disagreement, with "approve marker / approve official / split" actions. Attest step required before scores hit the public leaderboard. Hover any score → see who entered it, when, from which device. Bulk recompute job ("we had wrong SI on hole 7, recompute net for everyone"). Full keyboard model on the web console.
- **Depends on:** queued #72 takes part of this; the conflict queue + attest + audit trail UI is the piece #72 doesn't promise.
- **Effort:** M.

### W2-C · Handicap player-facing 🟠 (#7)
- **Gap:** No "your handicap explained" page (last 20, which 8 counted, trend, exceptional flags). No AGS preview before posting. No notification when committee changes a player's index.
- **Outcome:** New `/portal/handicap` page: last 20 scores with the 8 used highlighted, trend graph, exceptional-score flags, expected next-round delta. AGS preview surfaced inline on the round-close screen ("we're posting an Adjusted Gross Score of 81; here's why"). Notification ("the committee adjusted your index from 12.4 → 11.8 because of an exceptional-score review on April 12") with reason text.
- **Sub-tasks:** W2-C1 explanation page · W2-C2 AGS preview · W2-C3 committee-change notify.
- **Depends on:** W0-2 (notify deliverability).
- **Effort:** M.

### W2-D · Tournament lifecycle polish 🟠 (#8)
- **Gap (after #72):** Cut handling partial. Tie-break methods don't expose all WHS/USGA-recommended methods. Historical re-runs don't auto-populate prior winners / returning-champion benefits / YoY comparisons. Recap email design utilitarian. No post-event survey baked into close flow.
- **Outcome:** Cut handling complete (configurable cut line, automatic regrouping for round 3+). All WHS/USGA tie-break methods available. Re-run a templated event auto-populates prior-winner card, returning-champion benefits config, year-over-year comparison block in the recap. Recap email redesigned (uses W0-5 token system for branding). Post-event survey wired into the close flow with reminder.
- **Depends on:** queued #72 (lifecycle parity), W0-2 (mail), W0-5 (design tokens).
- **Effort:** M.

### W2-E · Match play depth 🟠 (#10)
- **Gap (after #71):** Two-player in-round match-play UX (concession, halve, "this hole closed", press detection) needs E2E review. Captain's-pick UI for daily orders barebones. No automated all-square-at-end-of-match handling (sudden death). No pre-match prediction / form-guide UI for spectators.
- **Outcome:** End-to-end designed two-player match-play flow with concede / halve / "hole closed" / press flows. Captain's-pick scheduler with daily-order publish + diff-from-yesterday view. Automatic sudden-death extension flow with hole rotation. Pre-match form guide ("Player A: 5W 2L vs. Player B in last 7 matches; trend: improving").
- **Depends on:** queued #71 (team entity), W1-A (uses new scoring screen).
- **Effort:** M.

### W2-F · Communications platform 🟠 (#15)
- **Gap (after #450, after W0-2 migration):** Coverage of every notification type in the prefs UI (some new types may bypass prefs). Quiet hours / DND. Digest mode (one daily/weekly email). Per-message audit surfaced to admins. One-click unsubscribe footer. The cancelled #36 (post-round results notify) and #324 (ledger-email failure alerts) themes still uncovered.
- **Outcome:** Comms preferences UI auto-syncs with a notification-type registry (no new type can ship without an entry). Per-user quiet hours window. Digest mode (daily / weekly). Per-message admin audit page ("did Sarah receive her tee-time confirmation?"). One-click unsubscribe link in every transactional email. Post-round results notify shipped (picks up cancelled #36). Scheduled-email-failure alerts shipped (picks up cancelled #324).
- **Picks up cancelled work:** #36, #324.
- **Sub-tasks:** W2-F1 notification-type registry + prefs sync · W2-F2 quiet hours · W2-F3 digest mode · W2-F4 admin audit page · W2-F5 unsubscribe · W2-F6 post-round results notify · W2-F7 scheduled-email-failure alerts.
- **Depends on:** W0-2.
- **Effort:** M (large M).

### W2-G · Tee-time marketplace depth 🟠 (#20)
- **Gap:** Open-marketplace (guest / non-member booking with payment) less mature. Dynamic pricing engine config depth unclear. Waitlist UI integration unclear. No GolfNow-style "hot deals" merchandising. Reminder durability across restarts unverified.
- **Outcome:** Guest booking flow with payment-up-front (Razorpay India + Stripe international). Dynamic-pricing config UI with rule preview ("at this point this slot would cost ₹2400"). Waitlist UX surfaced on every full slot with auto-promote when a cancellation opens up. "Hot deals" home-page section curated by club admin or auto-rule. Tee-time reminders survive server restarts (verification test) and are tracked in the admin per-message audit (W2-F4).
- **Sub-tasks:** W2-G1 guest booking · W2-G2 dynamic-pricing UI · W2-G3 waitlist UX · W2-G4 hot deals · W2-G5 reminder durability.
- **Depends on:** W0-2 (mail), W2-F4 (audit page).
- **Effort:** M.

### W2-H · Lessons & coach depth 🟠 (#21)
- **Gap:** No in-app swing drawing (lines, angles, freeze-frames). No side-by-side comparison view. Coach marketplace lacks discovery filters (handicap / region / specialty) at Skillest polish level. Coach payout flow thin (post-power-mode work added `coach_payout_account_history` but the original payout UX may need polish).
- **Outcome:** Swing-video player with line/angle/freeze-frame drawing tools. Side-by-side compare view (your swing | pro reference, looped). Marketplace filters: handicap range, region, specialty (short game, putting, mental game), price band, language. Coach payout end-to-end flow polished (statement → claim → payout → receipt) with notify (already covered post-cutoff).
- **Sub-tasks:** W2-H1 drawing tools · W2-H2 side-by-side compare · W2-H3 marketplace filters · W2-H4 payout E2E.
- **Effort:** M.

---

## Wave 3 — Close the Minor depth gaps

These are correctness-fine but depth-thin areas. Each is one focused task.

| # | Area | Gap-closing items | Effort |
|---|---|---|---|
| W3-A | #2 Auth & player portal 🟡 | Apple + Google sign-in (mobile + web). 2FA (TOTP) for admin/financial roles. Active-sessions screen with revoke-this-device. | M |
| W3-B | #9 Draws & tee sheets 🟡 | One-click substitution flow. Auto-balance walk-ups for shotgun events. | S |
| W3-C | #11 Club championship & interclub 🟡 | Tighten dispute/appeal flow for cross-club results. Surface honours board on club home + member portal home. Auto-notify "you qualified for the interclub final". | S |
| W3-D | #12 Leaderboards & TV 🟡 | Motion-graphics templates for TV mode (rotation, branded overlays, sponsor takeovers). Second-screen QR for spectators. Animated lower-thirds for live alerts. | M (design-heavy) |
| W3-E | #14 Achievements & badges 🟡 | Full-screen badge celebration with confetti + haptic. Streaks as first-class feature. Near-miss prompts ("you were one stroke from Bogey-Free Round"). | M |
| W3-F | #16 Profiles & social 🟡 | Verified-handicap badge tied to GHIN/IGU. Light social graph (follow / unfollow / mutuals). Round-summary share card redesign (shared with W1-B6). | M |
| W3-G | #17 Social feed 🟡 | Personalized feed ranking (people you played with > club-wide). @-mentions. Multi-emoji reactions + comments thread. Auto-generated "club week in review". Unified moderation inbox. | M |
| W3-H | #18 Sponsors 🟡 | Sponsor self-serve portal (asset upload, metrics, renewal). Click + redemption tracking (uses W0-4 events). A/B placement testing. Tier UI (gold/silver/bronze with auto-applied benefits). | M |
| W3-I | #19 Pro shop & POS 🟡 | Real-club soak with returns + dues + POS to find seams. Cross-sell on product detail page. Subscription SKU support ("ball of the month"). | M |
| W3-J | #22 Operations 🟡 | Unified "my upcoming" view (tee-times + lessons + range + F&B + rentals). Verify customer notification flow on rentals/repair status changes. F&B on-course ergonomics review against Toast Golf. | M |
| W3-K | #23 Pace, staffing, governance 🟡 | Automated marshal alerts (group X is N min behind). Push-channel for staffing day-of comms. Define the governance hub UX (no incumbent — opportunity). | M |
| W3-L | #24 Multi-club SaaS depth 🟡 | Per-club font / accent / logo theming (uses W0-5). Peer-club benchmarking dashboard (anonymous, percentile-based). Onboarding soak with 3 real non-technical admins (uses W0-7). | M |

---

## Wave 4 — Cross-cutting themes

These are the 10 themes from the audit's "Overall themes" section. Each is platform-wide, not per-area.

| # | Theme | Closure |
|---|---|---|
| X-1 | No automated tests in original diff ⚪ | Backfill test coverage area-by-area, prioritized by adoption. Post-power-mode wave already does this for new work; fund a focused backfill quarter for pre-power-mode features (start with #4 scoring, #11 offline, #15 comms). |
| X-2 | No analytics instrumentation ⚪ | W0-4 sets the contract; every Wave 1+ item emits events as part of "done". Backfill the top 20 high-value pre-power-mode flows. |
| X-3 | Design polish utilitarian ⚪ | Hire / contract a motion designer for one quarter to do badge celebration (W3-E), TV mode (W3-D), recap email (W2-D), share cards (W3-F), round-export PDF (W1-B6). |
| X-4 | Notifications coverage patchy ⚪ | W2-F1 notification-type registry forces every state-change to declare a notify channel. New checklist gate in PR template. |
| X-5 | Empty / error / loading states thin ⚪ | Add a "screen states" checklist to the design-token system (W0-5). Audit top 30 screens; fix bottom decile each sprint. |
| X-6 | Offline support shallow ⚪ | W1-B is the player-side fix; also extend offline queue to: portal page navigation cache, lesson video pre-cache, recent receipts cache. |
| X-7 | Accessibility undocumented ⚪ | One-time accessibility audit pass: `accessibilityLabel` coverage, dynamic type, high contrast, screen-reader walkthrough on top 20 screens. |
| X-8 | Email deliverability fragile ⚪ | W0-2 closes this. |
| X-9 | Cross-feature seams unverified ⚪ | W0-7 (real-club soak partner) drives this; commit to one soak cycle per Wave 3 item that touches ops (#19, #22, #24). |
| X-10 | No design-system enforcement ⚪ | W0-5 closes this. |

---

## Dependency graph (rough)

```
W0-2 (mail) ───────────┬─→ W2-C (handicap notify), W2-F (comms platform), W2-G (tee reminders)
                       └─→ X-4 (notifications coverage)

W0-3 (course data) ────┬─→ W1-A (scoring widgets), W1-B (offline + F/C/B), W1-C (watch yardages),
                       └─→ W1-D (shot tagging), W2-A (course depth)

W0-4 (analytics) ──────→ all Wave 1+ items emit events; X-2 backfill

W0-5 (tokens) ─────────┬─→ W2-D (recap design), W3-D (TV templates), W3-L (per-club theming)
                       └─→ X-5, X-10

W0-6 (watch decision) ─→ W1-C

W0-7 (soak partner) ───→ W3-I, W3-J, W3-L · X-9

W1-A (scoring screen) ─→ W1-D (shot tagging), W2-E (match play in-round), W2-G (tee → round)
W1-B (offline) ────────→ W1-C (shared sync queue)
W1-C (watch) ──────────→ (depends on #78 + W0-3 + W0-6)

#71 (queued) ──────────→ W2-E (team contexts)
#72 (queued) ──────────→ W2-B, W2-D
#78 (queued) ──────────→ W1-C
#450, #451 (queued) ───→ partial close of W2-F + #16 share polish
```

---

## Per-area work-item catalogue

This is the full list with no editorializing — useful for turning into a project-tasks queue.

### #1 Course lookup
- W2-A1 Ingest course geometry from chosen provider (W0-3) into our schema
- W2-A2 Mobile + web hole map view with greens, hazards, aerial layer
- W2-A3 Tee-by-tee gender ratings split (schema + UI)
- W2-A4 "Report incorrect data" → moderation queue for club admin
- W2-A5 Seasonal yardage adjustments (date-range deltas)

### #2 Auth & player portal
- W3-A1 Apple sign-in (mobile + web)
- W3-A2 Google sign-in (mobile + web)
- W3-A3 TOTP 2FA for super-admin / org-admin / treasurer roles
- W3-A4 Active-sessions screen with revoke-this-device
- W3-A5 Designed end-to-end password-reset flow (throttling, audit, "you weren't expecting this email" report)

### #3 Live scoring console
- W2-B1 Conflict queue UI (multi-source disagreement resolution)
- W2-B2 Verify / attest step before public-leaderboard publish
- W2-B3 Inline audit trail (hover any score → who/when/device)
- W2-B4 Bulk net-score recompute job for scoring-config changes
- W2-B5 Keyboard-first model on web console

### #4 Player self-scoring (Critical)
- W1-A1 Layered RoundScreen (glance bar → hole detail → per-shot sheet → micro-summary)
- W1-A2 Voice scoring ("birdie", "bogey", "five")
- W1-A3 Format-aware scoring widgets (stableford pts, match-play 2 UP, skins running)
- W1-A4 Lost-ball / penalty drop wizard with rule reference
- W1-A5 `aiCaddieMode` flag (Open / Distance-only / Lockdown), enforced phone + watch + audit log
- W1-A6 Marker-attestation badge surfaced outside the round itself
- W1-A7 Max-score auto-pickup prompt for stableford / max-score formats

### #5 Offline & GPS (Critical)
- W1-B1 Course bundle pre-cache on event open
- W1-B2 Last-7-days leaderboard pre-cache
- W1-B3 Sync-conflict UI for same-round multi-device offline edits
- W1-B4 F/C/B of green + PlaysLike (slope-aware, gated by event mode)
- W1-B5 Battery-aware GPS sampler (documented strategy)
- W1-B6 Round-export PDF redesign (share-card quality)

### #6 Watch (Critical)
- W1-C1 Native shell + auth (path from W0-6)
- W1-C2 Glance-first hole face (one big number, configurable F/C/B)
- W1-C3 Swipe entry + shot tagging
- W1-C4 LTE-independent sync queue
- W1-C5 Haptic prompts (your turn, concede, pace warning) + `aiCaddieMode` enforcement
- W1-C6 Ship to TestFlight + Play Internal Track

### #7 Handicap
- W2-C1 "Your handicap explained" page (last 20, which 8 counted, trend, exceptional flags)
- W2-C2 AGS preview before posting
- W2-C3 Notify when committee changes a player's index, with reason
- W2-C4 IGU India edge-case soak (state/regional posting)

### #8 Tournament lifecycle
- W2-D1 Cut handling complete (configurable cut line, regrouping)
- W2-D2 Full WHS/USGA tie-break method coverage
- W2-D3 Templated re-runs auto-populate prior-winner card + returning-champion benefits + YoY block
- W2-D4 Recap email redesign (uses W0-5)
- W2-D5 Post-event survey wired into close flow with reminder

### #9 Draws
- W3-B1 One-click substitution flow (recompute pairings)
- W3-B2 Auto-balance walk-ups for shotgun events
- W3-B3 Pocket-scorecard design A/B test

### #10 Match play
- W2-E1 E2E two-player in-round flow (concede / halve / hole closed / press)
- W2-E2 Captain's-pick scheduler with daily-order publish + diff view
- W2-E3 Sudden-death extension flow with hole rotation
- W2-E4 Pre-match form guide for spectators

### #11 Club championship & interclub
- W3-C1 Dispute/appeal flow for cross-club results
- W3-C2 Surface honours board on club home + member portal home
- W3-C3 Auto-notify "you qualified for the interclub final"

### #12 Leaderboards & TV
- W3-D1 Motion-graphics templates (rotation, branded overlays, sponsor takeovers)
- W3-D2 Animated lower-thirds for live birdie/eagle alerts
- W3-D3 Second-screen QR for spectators on the TV

### #13 Player analytics (Critical)
- W1-D1 Tap-to-drop shot tagging on the new scoring screen
- W1-D2 Auto-club inference (from prior shots + distance)
- W1-D3 Personal baseline computation + UI ("vs. your trailing-30-day baseline")
- W1-D4 Proximity-to-pin distribution chart by club distance bucket
- W1-D5 Weather × performance correlation overlay

### #14 Badges
- W3-E1 Full-screen badge reveal (confetti + haptic + share button)
- W3-E2 Streaks as a first-class feature (round streaks, login streaks, sub-X streaks)
- W3-E3 Near-miss prompts ("you were one stroke from Bogey-Free Round")

### #15 Comms platform
- W0-2 Email-provider migration (Postmark / SendGrid / Resend)
- W2-F1 Notification-type registry + prefs auto-sync
- W2-F2 Per-user quiet hours / DND
- W2-F3 Digest mode (daily / weekly)
- W2-F4 Per-message admin audit page
- W2-F5 One-click unsubscribe footer
- W2-F6 Post-round results notify (picks up cancelled #36)
- W2-F7 Scheduled-email-failure alerts to admins (picks up cancelled #324)

### #16 Profiles & social
- W3-F1 Verified-handicap badge (tied to GHIN/IGU)
- W3-F2 Light social graph (follow / unfollow / mutuals)
- W3-F3 Round-summary share card redesign (shared with W1-B6)

### #17 Social feed
- W3-G1 Personalized feed ranking (people you played with > club-wide)
- W3-G2 @-mentions
- W3-G3 Multi-emoji reactions + comments thread
- W3-G4 Auto-generated "club week in review"
- W3-G5 Unified moderation inbox

### #18 Sponsors
- W3-H1 Sponsor self-serve portal (asset upload, metrics, renewal)
- W3-H2 Click + redemption tracking (uses W0-4 events)
- W3-H3 A/B placement testing
- W3-H4 Tier UI (gold/silver/bronze with auto-applied benefits)

### #19 Pro shop & POS
- W3-I1 Real-club soak (returns + dues + POS) → seam fixes
- W3-I2 Cross-sell on product detail page
- W3-I3 Subscription SKU support ("ball of the month")

### #20 Tee-times
- W2-G1 Guest booking flow with payment-up-front (Razorpay + Stripe)
- W2-G2 Dynamic-pricing config UI with rule preview
- W2-G3 Waitlist UX with auto-promote on cancellation
- W2-G4 "Hot deals" home-page merchandising
- W2-G5 Reminder durability verification (test that survives server restart)

### #21 Lessons & coach
- W2-H1 In-app swing drawing tools (lines, angles, freeze-frames)
- W2-H2 Side-by-side compare view (your swing | pro reference, looped)
- W2-H3 Marketplace discovery filters (handicap, region, specialty, price, language)
- W2-H4 Coach payout E2E flow polish (statement → claim → payout → receipt)

### #22 Operations
- W3-J1 Unified "my upcoming" view (tee + lesson + range + F&B + rentals)
- W3-J2 Customer notification flow on rentals/repair status changes
- W3-J3 F&B on-course ergonomics review (vs. Toast Golf)

### #23 Pace, staffing, governance
- W3-K1 Automated marshal alerts (group X is N min behind threshold)
- W3-K2 Push-channel for day-of staffing comms ("marshal X, please go to hole 7")
- W3-K3 Define governance hub UX (define the category — no incumbent)

### #24 Multi-club SaaS
- W0-5 Design-token system (foundation)
- W3-L1 Per-club font / accent / logo theming (uses W0-5)
- W3-L2 Peer-club benchmarking dashboard (anonymous, percentile)
- W3-L3 Onboarding soak with 3 real non-technical admins (uses W0-7)

### Cross-cutting (X-themes)
- X-1 Test backfill quarter (start: #4, #11, #15)
- X-2 Analytics-event backfill (top 20 pre-power-mode flows)
- X-3 Motion-design contract quarter (badge, TV, recap email, share cards, PDF)
- X-4 Notification PR-template gate
- X-5 Screen-states checklist + bottom-decile sprint cadence
- X-6 Extend offline queue (portal nav cache, lesson video, receipts)
- X-7 Accessibility audit pass on top 20 screens
- X-8 (= W0-2)
- X-9 Per-Wave-3 ops item soak cycle
- X-10 (= W0-5)

---

## Sequencing recommendation

Pick **one** of these three tracks based on which audience moves the business most in the next 90 days:

1. **Serious-golfer track** — W0-3, W0-4, W0-6, W1-A, W1-B, W1-C, W1-D, W3-A. Closes all 4 Critical gaps. Largest impact on retention with high-handicap-aware players, watch-wearing demographic, and competitive amateurs.
2. **Tournament-operator track** — W0-2, W0-4, W2-B, W2-D, W2-E, W2-F, W3-D. Wins clubs that run real tournaments and need parity with Golf Genius.
3. **Club-SaaS track** — W0-2, W0-5, W0-7, W2-G, W2-H, W3-I, W3-J, W3-L, X-3. Wins clubs evaluating us as a Lightspeed / Club Caddie / Foretees replacement.

All three tracks share **W0-2, W0-4, W0-5**, so do those first regardless. The remaining wave-0 items (W0-3, W0-6, W0-7) are track-specific.

---

## What this plan deliberately doesn't say

- **No estimated dates.** Effort tags (S/M/L) give relative sizing; calendar dates depend on team capacity and which track is chosen.
- **No prioritization between tracks.** That's a business call, not an audit call.
- **Post-April-19 in-flight tasks (#769+)** are not credited as closures here, on purpose. Many of them do close cross-cutting theme items in passing — once any of them merges into Wave 3 territory, fold them into the catalogue.
