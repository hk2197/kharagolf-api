# Pre-Power-Mode Feature Audit

_Author: Replit Agent · Date: April 20, 2026_

This report audits every user-facing feature shipped in KHARAGOLF **before "power mode"** was enabled, and benchmarks each one against the best golf app in that specific category. It is written for a non-engineer founder. File paths are included so any engineer can act on the recommendations later.

---

## How the cutoff was determined

The audit horizon is **every project task planned on or before April 18, 2026** (i.e. created at least two days before today). That gives a stable list that won't shift as the new wave of post-power-mode tasks (created from April 19 onward) keeps growing day to day.

KHARAGOLF's task history splits cleanly into two eras, and the date cutoff lines up almost exactly with that boundary:

| Era | Task range | Pattern |
|---|---|---|
| **Pre-power-mode** (planned on/before Apr 18, 2026) | **#1 – #110**, plus a handful of late additions through **#451** | Large, batched feature rollouts. Each task ships an entire vertical (e.g. "Tournament Lifecycle Completions", "Multi-Club SaaS Platform", "India-First Shop Rebuild"). No paired test follow-up was created automatically. No "notify when X happens" follow-up was generated. Most tasks have no automated test files at all. |
| **Post-power-mode** (planned from Apr 19, 2026 onward) | **#769 onward** | Small, surgical tasks (one button, one notification, one bug). Each merge auto-spawns 1–3 follow-ups: usually one test follow-up ("Cover X with automated tests"), one notification or refund follow-up, and one polish follow-up. Tasks consistently include test files in the same diff. **Out of scope for this audit.** |

### Tasks in scope (planned on/before April 18, 2026)

**114 tasks total**, broken down by status:

- **100 merged** features (refs #1 – #110, with a few gaps where tasks were cancelled). These are the shipped pre-power-mode features the audit benchmarks.
- **5 still queued** (PROPOSED but not yet built): **#71** Team entity upgrade, **#72** Tournament & League Admin parity, **#78** Native watch & wearable apps, **#450** Make recap launch notifications survive server restarts, **#451** Render server-side recap images.
- **9 cancelled** (PROPOSED but explicitly de-scoped): **#33** Avatar coverage on mobile, **#34** Shareable scorecards & mobile round viewer, **#35** Enhanced player statistics, **#36** Post-round results notifications & publish pairings, **#37** Mobile tournament registration, **#38** Live hole-by-hole tracker, **#39** AI Golf Rules Assistant, **#273** Levy audit deep-links in CSV/PDF, **#324** Alert admins when scheduled ledger emails keep failing.

The cancelled list is informative on its own — see the "Deliberately deferred" callout immediately below. Several gaps the audit flags were *known* and explicitly chosen not to ship in this era.

### Deliberately deferred (cancelled before April 18, 2026)

These tasks were proposed during the pre-power-mode era and then cancelled. They overlap several of the gaps the audit flags, so the gap is partly a *deliberate* product choice — not an oversight:

| Cancelled task | Audit area it would have addressed | Implication |
|---|---|---|
| #33 Avatar Coverage Across Mobile | #16 Profiles | Visual identity gap on mobile is a known choice. |
| #34 Shareable Scorecards & Mobile Round Viewer | #4 Self-scoring · #16 Profiles | The shareable round-summary artifact gap is a deliberate deferral. |
| #35 Enhanced Player Statistics | #13 Player analytics & shot stats | The Critical analytics gap was scoped and dropped — strong signal it should be revisited. |
| #36 Post-round Results Notifications & Publish Pairings | #15 Comms · #9 Draws/tee sheets | Part of the "patchy notifications" theme is a known deferral. |
| #37 Mobile Tournament Registration | #8 Tournament lifecycle | Mobile-first registration is intentionally not yet built. |
| #38 Live Hole-by-Hole Tracker | #4 Self-scoring · #12 Leaderboards/TV | The hole-by-hole spectator/scoring tracker is intentionally deferred. |
| #39 AI Golf Rules Assistant | #4 AI Caddie / rules | AI rules-assistant was scoped and dropped — directly informs the #4 Critical "rule-mode-aware AI Caddie" recommendation. |
| #273 Levy audit deep-links in exports | #24 Multi-club SaaS (admin reporting) | Deep-link polish on financial exports was deferred. |
| #324 Alert admins when scheduled ledger emails keep failing | #15 Comms (durability) | Scheduled-email failure alerting was deferred. |

To keep the report digestible, the 100 merged features are grouped into **24 feature areas** below. Each area covers all the tasks that contribute to it.

---

## Summary table

The "Severity (raw)" column reflects the gap as if no other work were planned. The "Severity (after in-flight)" column accounts for active and queued tasks that are already chipping away at the gap (see "How active and queued work changes the picture" immediately below this table). When the two differ, in-flight work materially shrinks the gap but does not necessarily close it.

| # | Feature area | Severity (raw) | Severity (after in-flight) | Benchmark app(s) |
|---|---|---|---|---|
| 1 | Course lookup & course data | **Major** | **Major** | GHIN, Hole19, Garmin Golf |
| 2 | Authentication & player portal | Minor | Minor | 18Birdies, Garmin Connect |
| 3 | Live scoring console (operator side) | **Major** | **Major** _(partly addressed by #72)_ | Golf Genius Tournament Management |
| 4 | Player self-scoring & marker flow | **Critical** | **Critical** | Hole19, 18Birdies, Golfshot |
| 5 | Offline scoring & GPS | **Critical** | **Critical** | Garmin Golf, Hole19, Arccos |
| 6 | Apple Watch / Wear OS companion | **Critical** | **Major** _(if #78 ships as scoped)_ | Garmin Approach, Hole19 Watch, Golfshot |
| 7 | Handicap (WHS/GHIN) | **Major** | **Major** | GHIN (USGA), TheGrint |
| 8 | Tournament lifecycle & formats | **Major** | Minor _(if #71 + #72 ship)_ | Golf Genius |
| 9 | Draws, brackets & tee sheets | Minor | Minor | Golf Genius, BlueGolf |
| 10 | Match play & Ryder Cup formats | **Major** | **Major** _(team upgrade #71 helps)_ | Golf Genius Match Play, USGA TM |
| 11 | Club championship & interclub | Minor | Minor | Golf Genius, BlueGolf |
| 12 | Leaderboards & TV display | Minor | Minor | Golf Genius LiveScoring, V1 Sports |
| 13 | Player analytics & shot stats | **Critical** | **Critical** | Arccos, Shot Scope, Golfshot |
| 14 | Achievements & badges | Minor | Minor _(post-power-mode tests + share work in flight)_ | 18Birdies, Strava-as-influence |
| 15 | Communications, notifications & email | **Major** | **Major** _(notification durability + wallet/side-game/coach notify work in flight)_ | 18Birdies, Garmin Connect |
| 16 | Player profiles, avatars & social | Minor | Minor _("Year in Golf" recap + share-tracking + admin leaderboard already shipping)_ | 18Birdies, GolfNow |
| 17 | Social feed & club community | Minor | Minor | 18Birdies, Strava |
| 18 | Sponsors & monetization | Minor | Minor | Golf Genius Sponsor Center |
| 19 | Pro shop, POS & e-commerce | Minor | Minor | Lightspeed Golf, Club Caddie |
| 20 | Tee-time booking & marketplace | **Major** | **Major** | GolfNow, Supreme Golf |
| 21 | Lessons, coach & swing video | **Major** | **Major** _(coach payout notify in flight)_ | V1 Golf, Hudl Technique, Skillest |
| 22 | Operations: F&B, locker, cart, range, rentals, repair | Minor | Minor | Club Caddie, Lightspeed Golf, Foretees |
| 23 | Pace of play, staffing & governance | Minor | Minor | Tagmarshal (pace), Golf Genius (staff) |
| 24 | Multi-club SaaS platform & branding | Minor | Minor _(SEO caching + deleted-account media verification in flight)_ | BlueGolf, USGA TM |

**Counts (raw):** Critical = 4 · Major = 8 · Minor = 12 · Cosmetic = 0.
**Counts (after in-flight):** Critical = 3 · Major = 7 · Minor = 14 · Cosmetic = 0.

---

## How active and queued work changes the picture

Within the audit horizon (planned on/before April 18, 2026), there are **5 still-queued tasks** that materially overlap audit areas. These are the only "in-flight" closers counted here — anything planned from April 19 onward is out of scope for this audit by design.

### Queued project tasks (in scope) that close audit gaps

| Task | Title | Audit area it addresses | What it covers |
|---|---|---|---|
| **#71** | Team entity upgrade — tournaments & leagues | #8 Tournament lifecycle · #10 Match play | First-class team model under tournaments and leagues. Required before team-format Ryder Cup polish and team leaderboards. |
| **#72** | Tournament & League Admin — Professional Parity | #3 Live scoring console · #8 Tournament lifecycle | Direct match for the audit's "Audit each format end-to-end against Golf Genius parity" recommendation. If shipped as titled, this is the single biggest mover for tournaments. |
| **#78** | Native Android, iOS, watchOS & Wearable Apps | #5 Offline/GPS · #6 Watch companion | Direct match for the audit's "Build the native watch artifacts" recommendation. Note: #6 only drops from Critical to Major *if* the watch app actually ships glance-first hole face + rule-mode awareness; building a native shell without those still leaves the gap open. |
| **#450** | Make recap launch notifications survive server restarts | #15 Comms | Closes part of the "fragile email/notification durability" theme for the year-end recap launch. |
| **#451** | Render server-side recap images for richer share previews | #16 Profiles · #15 Comms | Closes part of the "utilitarian share artifact design" gap on the recap. |

### What this means for prioritization

- **What the 5 queued tasks cover well:** tournament-format parity (#8 — pending #72), team-format scaffolding (#10 — pending #71), watch shell (#6 — pending #78, _if_ scope holds), and recap-share polish (#15/#16 — pending #450 + #451).
- **What's still a gap even after all 5 queued tasks ship:**
  - **#4 Player self-scoring & marker flow** — no queued task addresses the layered scoring screen, voice scoring, or rule-mode-aware AI Caddie. Note: cancelled task #39 (AI Golf Rules Assistant) and cancelled #34 (Shareable Scorecards & Mobile Round Viewer) directly map to this gap, so the deficit is partly a deliberate deferral.
  - **#5 Offline & GPS** — no queued task pre-caches course bundles, adds F/C/B + PlaysLike, or documents a battery-aware GPS strategy.
  - **#13 Player analytics & shot stats** — no queued task adds tap-to-drop shot tagging, personal baselines, or weather × performance correlation. Cancelled #35 (Enhanced Player Statistics) maps exactly here — the gap is a deliberate deferral.
  - **#1 Course lookup** — no queued task adds mapped greens, hazard polygons, aerial imagery, or crowd-sourced corrections.
  - **#7 Handicap** — no queued task adds the "your handicap explained" player-facing page or AGS preview.
  - **#20 Tee-times** — no queued task adds the guest-booking flow, waitlist UX, or reminder durability verification.
  - **#15 Comms** — #450 only addresses recap launch notifications. The broader theme (cancelled #36 post-round results notify, cancelled #324 ledger-email failure alerts) still has no queued coverage.
- **The two highest-leverage net-new project tasks to add** (based on what's left after the queued tasks ship):
  1. **Re-platform the in-round scoring screen** on the layered model + add `aiCaddieMode` enforcement (closes #4 Critical, picks up the cancelled #39 work).
  2. **Lightweight shot-tagging + personal baseline analytics** (closes #13 Critical, picks up the cancelled #35 work, and shrinks #1 Major).

> Tasks planned from April 19, 2026 onward (the "post-power-mode" wave from #769 forward) are deliberately excluded from this section. Many of them do close audit gaps in passing — but they're outside the audit horizon and including them would make this document a moving target.

---

## Feature-by-feature audit

### 1. Course lookup & course data
**Source tasks:** #1 (GolfCourseAPI lookup), #26 (lookup activation), #51 (club distance profiling), #53 (multi-course championship), #59 (GHIN player & course lookup)

**What we shipped.** A course catalogue backed by external lookups (originally GolfCourseAPI, later switched to GHIN in #59), surfaced in `artifacts/api-server/src/routes/courses.ts` (~600 lines). Clubs can pull a course, save it, and attach it to events. Hole-level data (par, stroke index, yardage by tee) is stored. Distance profiling (#51) lets a club re-measure its own hole yardages. Multi-course championships (#53) allow rotating venues across rounds.

**Best-in-class benchmark.** **GHIN** (USGA) for authoritative US course/rating data; **Hole19** and **Garmin Golf** for global course coverage with mapped greens, hazards, and aerial imagery; **Hole19** also has crowd-sourced corrections. Garmin's CourseView ships with ~43,000 mapped courses worldwide.

**Gap assessment.**
- No mapped greens, no hazard polygons, no fairway centerline points — KHARAGOLF only stores tabular data (par, SI, yardage). GPS distance to F/C/B of green is therefore approximate at best.
- No aerial/satellite imagery layer for the mobile app.
- No crowd-sourced corrections workflow — a player who notices wrong yardage has no path to flag it.
- No tee-by-tee gender ratings split (only one rating per tee in our schema).
- No cached offline course bundle (player can't pre-download a course before a round).
- No course condition or seasonal yardage adjustments fed back into the live yardage calculation.

**Severity:** Major.

**Suggested direction.**
- Adopt a richer course-data provider (GHIN for US, plus a global hazard/green-polygon source) or build a club-side course mapper using satellite tiles.
- Add a "report incorrect data" button on every hole view that creates a moderation queue.
- Pre-cache the venue's course bundle when a player registers for an event.

---

### 2. Authentication & player portal
**Source tasks:** #2 (custom user auth & player portal), #20 (admin email/password), #22 (role overhaul), #23 (role-aware login UX), #64 (admin password reset)

**What we shipped.** Email/password and player-portal auth with role-based access (super-admin, club-admin, coach, player, marker, etc.). Routes live in `artifacts/api-server/src/routes/auth.ts`, `player-auth.ts`, `portal.ts` (~9,900 lines for the portal alone). Player portal pages at `artifacts/kharagolf-web/src/pages/portal/`.

**Best-in-class benchmark.** **18Birdies** and **Garmin Connect** for frictionless social sign-in (Apple, Google, Facebook), passwordless magic links, and biometric re-auth on mobile. **GHIN** for a "single golf identity" used across multiple apps.

**Gap assessment.**
- Email/password only on the player side; no Apple/Google sign-in, no magic-link, no biometric re-auth on mobile.
- No "login with GHIN ID" — for Indian/global users this is OK, for US adoption it's a friction point.
- No 2FA option for any role, even super-admin.
- Session management is server-side cookies; no visible "active sessions" page where a user can revoke a device.
- Password reset (#64) was a fix on top, not a designed end-to-end flow with throttling, audit, and "you weren't expecting this email" reporting.

**Severity:** Minor (functional, just dated).

**Suggested direction.**
- Add Apple + Google sign-in on mobile and web.
- Add 2FA (TOTP) for any role with admin/financial scope.
- Add an "active sessions" management screen.

---

### 3. Live scoring console (operator side)
**Source tasks:** #3 (web live scorer console), #69 (scorer station — group-centric mobile flow)

**What we shipped.** A web operator console where a tournament/league official enters scores hole-by-hole for any group. Mobile "scorer station" (`artifacts/kharagolf-mobile/app/scorer-station/`, route at `routes/scorer-station.ts`, 306 lines) lets a roving scorer pick up any group and key scores. Real-time leaderboard updates over SSE.

**Best-in-class benchmark.** **Golf Genius Tournament Management** is the de-facto standard for committee-side live scoring at amateur and pro events. It supports phone, tablet, and walking scorer flows side-by-side, with conflict resolution between marker/scorer/operator.

**Gap assessment.**
- No conflict-resolution UI when two sources (marker, official, kiosk) submit different scores for the same hole — last write wins.
- No score "verify" / "attest" step before scores are published to the public leaderboard.
- No visibility into who entered what (audit trail exists in DB but isn't surfaced in the UI).
- No bulk score correction tool for "we had a wrong stroke index on hole 7, recompute everyone's net".
- No keyboard-first interaction model on the web console (everything is mouse-driven, slow for an experienced tournament operator).

**Severity:** Major.

**Suggested direction.**
- Add a conflict queue + attest step before publish.
- Surface the audit trail inline (hover a score → see who submitted it and when).
- Add a recompute-net job for scoring config changes.

---

### 4. Player self-scoring & marker flow
**Source tasks:** #70 (player self-scoring & marker flow), #11 (offline scoring), #50 (interactive round replay map)

**What we shipped.** Player keys their own score on mobile; assigned marker (a fellow competitor) attests it. Marker-live route at `artifacts/api-server/src/routes/marker-live.ts` (284 lines). Round-replay map (#50) shows an animated walk of the round.

**Best-in-class benchmark.** **Hole19**, **18Birdies**, and **Golfshot** — they have spent a decade refining the in-round scoring UX: one-tap par, big-button scoring, putts/fairway/GIR toggles inline, smart formats (stableford, match play, skins) on the same screen, voice scoring, and a peer-attestation flow that doesn't break flow.

**Gap assessment.**
- Scoring screen lacks the layered "always-visible glance strip + one-tap green view + per-shot detail sheet" pattern that the leaders use; everything is on one busy screen.
- No voice scoring ("birdie", "bogey").
- Format-specific scoring views are limited: stroke is solid, stableford and match-play scoreboards are present in the API but the in-round mobile UX doesn't surface them with the same fluency.
- No smart prompts for "lost ball / penalty? guided drop" with rule reference inline.
- No "pick up — max score reached" prompt for stableford/max-score formats.
- Marker attest flow exists but lacks a clear "you have N holes pending attestation" badge surfaced anywhere outside the round itself.
- AI Caddie suggestions (planned) are not yet rule-mode-aware, so a tournament with caddie-disabled rules can't enforce that.

**Severity:** Critical. This is the single most-used screen in any golf app.

**Suggested direction.**
- Re-platform the in-round scoring screen on a layered model (glance bar → one-tap detail → per-shot sheet → post-hole micro-summary).
- Add format-aware scoring widgets (stableford points, match-play "2 UP", skins running totals) on the same screen.
- Add an `aiCaddieMode` flag at the round level so tournaments can lock down advice cleanly.

---

### 5. Offline scoring & GPS
**Source tasks:** #11 (offline scoring, GPS, exports)

**What we shipped.** Mobile scoring that buffers locally and syncs when the network returns, plus GPS distance to green. Round exports (CSV/PDF). Embedded inside the mobile general-play and tournament scoring flows.

**Best-in-class benchmark.** **Garmin Golf** (and Garmin handhelds) for offline-first reliability — entire course bundles are cached on device and the watch works with no phone. **Hole19** and **Arccos** for graceful sync conflict handling.

**Gap assessment.**
- Offline scope is shallow: scores are buffered, but course data, leaderboards, and hole maps may not be. A player on a course with no signal sees a degraded experience.
- No conflict-resolution UI if the same round was edited on two devices while offline.
- GPS distance is to a single point (likely green center), not F/C/B of green; no slope-adjusted "PlaysLike" distance.
- Battery-aware GPS sampling isn't documented anywhere — long rounds can drain phones if GPS polls aggressively.
- Round-export PDF is functional but the design is utilitarian (matches the scorecard era), not the polished shareable artifact 18Birdies/Hole19 produce.

**Severity:** Critical (offline is table-stakes for golf, where signal is unreliable).

**Suggested direction.**
- Pre-cache course bundles + last 7 days of leaderboards when the player opens an event.
- Implement a documented battery-aware GPS strategy (sampling cadence drops between holes).
- Add F/C/B yardage and PlaysLike (when slope is allowed by event mode).

---

### 6. Apple Watch / Wear OS companion
**Source tasks:** #57 (Apple Watch & Wear OS companion app)

**What we shipped.** A wearable companion. Based on the task title and the absence of a separate watchOS/Wear OS artifact directory in the monorepo, the implementation is at minimum a shared API layer with a watch UI sketch — not a fully native, store-shipped wearable app yet (task #78 "Native Android, iOS, watchOS & Wearable Apps" remains unbuilt).

**Best-in-class benchmark.** **Garmin Approach** ecosystem (their watches are the gold standard for on-course glanceability), **Hole19 Apple Watch** (best phone-companion watch app in the App Store), **Golfshot Wear OS**.

**Gap assessment.**
- No native watch app shipped to the App Store / Play Store.
- No glance-first "hole face" with one big yardage number.
- No swipe-based score entry / shot tagging on the watch.
- Watch can't operate independently of the phone (no LTE-only flow).
- No haptic prompts for "your turn", "concede?", or pace-of-play warnings.
- No respect for `aiCaddieMode` — a watch can't yet be locked down for tournament play.

**Severity:** Critical for any serious golfer demographic.

**Suggested direction.**
- Build the native watch artifacts (task #78 already proposed) with a glance-first hole face, swipe entry, and rule-mode awareness.
- Reuse the same `roundContext` API the phone uses so the watch can never leak disallowed advice.

---

### 7. Handicap (WHS/GHIN)
**Source tasks:** #27 (WHS/GHIN posting), #56 (handicap committee tools), #76 (general play & posting), #77 (WHS 2024/2026 compliance + GHIN/IGU)

**What we shipped.** WHS-compliant handicap engine in `artifacts/api-server/src/routes/whs.ts` (904 lines), handicap-cases (peer review, exceptional score reviews) in `routes/handicap-cases.ts` (866 lines). Posts to GHIN/IGU after rounds. Mobile handicap-profile screen. Committee-side review tools at `pages/handicap-committee.tsx` and `annual-handicap-review.tsx`.

**Best-in-class benchmark.** **GHIN (USGA)** is the source-of-truth for US handicaps and is the bar everyone measures against. **TheGrint** for player-friendly UX around the WHS engine.

**Gap assessment.**
- Adjusted Gross Score (AGS) calculation is implemented; surfacing it to the player before posting (so they know what's being submitted) is less clear in the UI.
- No "pre-round handicap simulator" tied to the player's current index for what-if planning (Handicap Simulator exists at #45 but is committee-side, not player-side).
- No clear, per-player visualization of "your last 20 scores, which 8 were used, what your trend looks like" — TheGrint nails this.
- Exceptional-score and committee-review tooling exists, but the player notification flow ("we adjusted your index, here's why") isn't documented.
- IGU integration is built but India-specific edge cases (state/regional posting) likely need real-world soak time.

**Severity:** Major.

**Suggested direction.**
- Add a player-facing "your handicap explained" page (last 20, which 8 counted, trend graph, exceptional flags).
- Surface AGS preview before posting.
- Notify players whenever the committee changes their index, with reason.

---

### 8. Tournament lifecycle & formats
**Source tasks:** #4 (professional tournament features), #14 (tournament lifecycle completions), #43–#46 (Batch 1–4 polish), #60 (sponsors/conditions/scorecards), #61 (scoring events & post-tournament email)

**What we shipped.** Full tournament CRUD + lifecycle (draft → register → draw → live → complete → archive) at `routes/tournaments.ts` (1,803 lines). Sponsor logos on scorecards, results PDF, shotgun UI, fulfillment APIs, course conditions, recap emails. Tournament templates (#45) for re-running the same event annually.

**Best-in-class benchmark.** **Golf Genius Tournament Management** — the dominant TM software at amateur/club level worldwide. They have ~15 years of edge cases baked in.

**Gap assessment.**
- Format coverage is broad on paper but uneven in the UI: stroke, stableford, scrambles, modified Stableford, etc. — not all are equally polished from the player's POV.
- Cut handling (make-the-cut events) is partial.
- Tie-break methodology is configurable (#31) but doesn't expose all the WHS/USGA-recommended methods.
- Historical event re-runs lean on templates (#45) but don't auto-populate prior winners, returning-champion benefits, or year-over-year comparisons.
- Recap emails ship (#44) but the design appears utilitarian — the leaders ship glossy, share-ready event recaps.
- No "post-event survey" baked into the lifecycle (surveys exist as a separate module #016 migration; not auto-wired into the close).

**Severity:** Major.

**Suggested direction.**
- Audit each format end-to-end (registration → draw → live → results) against Golf Genius parity (this is partly task #72, still proposed).
- Wire post-event surveys into the standard close flow.
- Improve recap email/share artifact design.

---

### 9. Draws, brackets & tee sheets
**Source tasks:** #6 (pairings, brackets, tee sheets), #41 (split-tee & multi-hole simultaneous), #42 (PDFKit pocket scorecards), #66 (manual draw slot lock), #67 (bulk flight assignment), #68 (timezone bug)

**What we shipped.** Comprehensive draw engine: pairings, brackets, tee sheets, shotgun, split-tee, manual locks, bulk flight assignment, drag-to-move. Pocket scorecards rendered server-side via PDFKit (#42). Drawer UI on web admin.

**Best-in-class benchmark.** **Golf Genius** and **BlueGolf** for draw flexibility; both handle ~every edge case (mixed-format draws, A/B/C flights with different criteria, last-minute substitutions).

**Gap assessment.**
- Draw quality is among the more polished pre-power-mode areas (multiple iterations).
- Substitutions late in the day still need a clear "swap player X with Y, recompute pairings" tool — currently done via manual lock + manual edit.
- Last-minute walk-up additions to a shotgun aren't auto-balanced.
- Pocket scorecards (PDFKit) look professional but design A/B testing has never been done.

**Severity:** Minor.

**Suggested direction.**
- Add a one-click substitution flow.
- Add a "balance walk-ups" action for shotgun events.

---

### 10. Match play & Ryder Cup formats
**Source tasks:** #79 (match play brackets & Ryder Cup formats)

**What we shipped.** Match-play brackets and Ryder Cup–style team formats at `routes/match-play.ts` (1,527 lines). Mobile bracket viewer at `app/bracket.tsx` (web has both `bracket.tsx` and `pages/bracket.tsx` for spectator).

**Best-in-class benchmark.** **Golf Genius Match Play** module; **USGA Tournament Management** for sanctioned match play.

**Gap assessment.**
- Hole-by-hole match status (1 UP / AS / 2&1) is computed in the API; the live in-round mobile experience for the two players themselves (concession prompts, halve-the-hole, "this hole closed", press detection) needs end-to-end review.
- Ryder Cup formats (foursomes, fourballs, singles) are present; the captain's-pick UI for setting daily orders may be barebones.
- No automated handling of all-square at end of match (sudden death playoff).
- Pre-match "prediction" / "form guide" UI for spectators is absent.

**Severity:** Major (when a club runs match play, this becomes the entire app).

**Suggested direction.**
- End-to-end review of the two-player in-round match-play UX.
- Add captain's-pick scheduler + daily-order publish flow.
- Add a sudden-death extension flow.

---

### 11. Club championship & interclub
**Source tasks:** #80 (club championship & interclub competitions)

**What we shipped.** Club championship multi-round/multi-format event configuration (`routes/club-championship.ts`, 400 lines). Interclub competitions across multiple clubs (`routes/interclub.ts`, 467 lines). Cross-club ladders separately (`routes/cross-club-ladders.ts`).

**Best-in-class benchmark.** **Golf Genius** and **BlueGolf**. Both are heavily used by state golf associations for interclub.

**Gap assessment.**
- Cross-club permission model and result-publishing audit trail are present (recent migration: cross_club_ladder_result_audits) but the admin-side "I disagree with this published result" flow needs review.
- Honours board exists (`pages/honours-board.tsx`) but its visibility from a club's public page or member-portal home is not consistent.
- No automatic "you qualified for the interclub final" notification is documented.

**Severity:** Minor.

**Suggested direction.**
- Tighten the dispute/appeal flow for cross-club results.
- Surface honours board prominently on club home pages and member-portal home.

---

### 12. Leaderboards & TV display
**Source tasks:** #44 (live alerts within Batch 2), #97 (TV leaderboard display board)

**What we shipped.** Mobile + web leaderboards (live, gross/net toggle), plus a kiosk/TV display mode at `pages/leaderboard-display.tsx` and `leaderboard-kiosk.tsx`. Display board route (`routes/display-board.ts`) and broadcast overlays (`routes/broadcast-overlays.ts`).

**Best-in-class benchmark.** **Golf Genius LiveScoring** and **V1 Sports** broadcast tooling. PGA Tour-style overlays are the aspirational bar.

**Gap assessment.**
- TV mode is functional but design is utilitarian; rotation through pages, branded overlays, and sponsor takeovers are not as polished as the leaders.
- No "broadcast quality" lower-thirds or animated transitions between leaderboard rotations.
- No second-screen experience tied to TV mode.
- Live alerts (#44) — birdie/eagle pushes to a club's TV/social — exist; design polish is open.

**Severity:** Minor (functionally fine, visually behind).

**Suggested direction.**
- Hire / generate motion-graphics templates for TV mode.
- Add second-screen QR for spectators on the TV.

---

### 13. Player analytics & shot stats
**Source tasks:** #9 (player analytics, statistics, wearables, achievements), #16 (analytics, stats, weather), #89 (player performance analytics — strokes gained & shot stats)

**What we shipped.** Stats screens (mobile and web), strokes-gained module (#89), trend charts. Wearables data was scoped here originally too. Mobile `app/my-360`, web `pages/member-360.tsx`.

**Best-in-class benchmark.** **Arccos** (auto shot detection via club sensors, true strokes-gained vs. scratch), **Shot Scope** (similar with their own hardware), **Golfshot** (manual but very polished).

**Gap assessment.**
- No first-party shot-detection hardware integration.
- Strokes-gained relies on user-entered (or marker-entered) shot detail; coverage will be sparse without an Arccos-style auto-tag flow.
- No benchmarking of the player against their own historical baseline ("your driving is 0.4 strokes worse than last summer") — current stats are absolute, not relative.
- No proximity-to-pin distribution by club distance (a key Arccos artifact).
- Weather is captured (#16) but not yet correlated with performance ("you score 1.5 strokes worse in 15+ mph wind").

**Severity:** Critical for any serious-golfer segment; this is where Arccos, Shot Scope, and Golfshot win.

**Suggested direction.**
- Build a lightweight shot-tag flow (tap-to-drop pin) with auto-club inference; reduce manual entry burden.
- Add a personal baseline / trend vs. self.
- Cross-tab weather × performance.

---

### 14. Achievements & badges
**Source tasks:** #9 (badges within analytics rollup)

**What we shipped.** Badges catalogue (mobile `app/badges.tsx`, web `pages/portal/...`), achievement engine (`achievement-engine.test.ts`, 11 tests originally; #783 added 10 more). Badge sharing + per-badge social cards were added later (post-power-mode #780/#781), so the core badge engine is pre-power-mode.

**Best-in-class benchmark.** **18Birdies** for breadth and tasteful design; **Strava** as a cross-sport reference for what a great achievements system feels like.

**Gap assessment.**
- The badge catalogue is broad (GIR, fairway, putting, comeback, bogey-free, eagle on par 5, etc.) but the player-facing reveal moment (the "you earned X" celebration) is functional rather than delightful.
- No streaks-as-first-class feature ("3 rounds in a row with sub-90", "10-day login streak").
- No "near miss" prompts ("you were one stroke from earning Bogey-Free Round").
- Pre-power-mode catalogue had no automated tests for several badge rules — added later (#783, #928 follow-up still pending).

**Severity:** Minor (engine is correct; UX moment is what's lacking).

**Suggested direction.**
- Redesign the in-app reveal animation (full-screen takeover with confetti / haptic).
- Add streaks and near-miss prompts.

---

### 15. Communications, notifications & email
**Source tasks:** #5 (invitation system, comms, push), #13 (push notifications & comms preferences), #17 (fix email delivery & full app QA), #44 (recap emails within Batch 2), #61 (post-tournament email within Scoring Events)

**What we shipped.** Multi-channel comms: email (Gmail SMTP via `GMAIL_APP_PASSWORD`), push (Expo push), in-app notifications, comms preferences page, recap emails, post-tournament emails. Routes: `routes/communications.ts`, `routes/notifications` (within portal). Mobile `app/notifications/`.

**Best-in-class benchmark.** **18Birdies** and **Garmin Connect** — granular preferences (per-event-type, per-channel), quiet hours, digest mode, and unsubscribe per category.

**Gap assessment.**
- Comms preferences page exists (#13); unclear if every notification type is represented in the preferences UI (some new types may bypass the prefs check).
- No quiet hours / do-not-disturb window per user.
- No digest mode (one daily/weekly email instead of per-event).
- Email deliverability uses a single Gmail SMTP (GMAIL_APP_PASSWORD secret) — fine for low volume, fragile at scale (no DKIM/SPF/DMARC tied to the brand domain, no provider-level analytics).
- No unsubscribe footer with one-click compliance link in transactional emails.
- No per-message audit trail surfaced to admins ("did the player actually receive their tee-time confirmation?").

**Severity:** Major (deliverability + preferences are foundational).

**Suggested direction.**
- Move transactional email to a deliverability-first provider (Postmark, SendGrid, Resend) on a verified domain.
- Add quiet-hours, digest-mode, and per-type preferences.
- Add a per-message audit trail in the admin.

---

### 16. Player profiles, avatars & social
**Source tasks:** #30 (profile photo & avatar picker), #54 (social activity feed — partly), #63 (avatar crop fix), #47 (shareable round summary card)

**What we shipped.** Player profile with photo, avatar picker with crop & zoom-to-fit. Public profile page on the website (`artifacts/kharagolf-website/src/pages/public-profile.tsx`). Shareable round summary card (#47).

**Best-in-class benchmark.** **18Birdies** and **GolfNow** for player profiles; the leaders show a clean public bio + recent rounds + badges + clubs.

**Gap assessment.**
- Public profile is decent (post-power-mode work hardened share counts and per-badge sharing); the round-summary share card design is utilitarian.
- No "verified handicap badge" on the public profile.
- No following/followers graph for player-to-player relationships outside a club.
- Avatar crop fix (#63) was a remediation, not a designed image-pipeline.

**Severity:** Minor.

**Suggested direction.**
- Add a verified-handicap badge tied to GHIN/IGU.
- Add light social graph (follow / unfollow / mutuals).
- Redesign the round-summary share card.

---

### 17. Social feed & club community
**Source tasks:** #7 (media galleries & tournament chat), #54 (social activity feed), #94 (social wall & club feed)

**What we shipped.** Tournament chat rooms, media galleries, club-wide social feed (`routes/feed.ts` 676 lines, mobile screens). Public peer-review surfaces (`routes/peer-review-public.ts`). Highlights (`routes/highlights.ts`).

**Best-in-class benchmark.** **18Birdies** for the social feed model in golf; **Strava** as the cross-sport benchmark.

**Gap assessment.**
- Feed exists but ranking/personalization is unclear — likely chronological, not "what your friends and your group did".
- No mentions / @-tagging spec is documented.
- Reactions are likely simple (like / count) rather than the multi-emoji + comments-thread model 18Birdies offers.
- No "weekly recap" that summarizes the club's activity into a single shareable card.
- Moderation tooling is split (peer-review-public has its own surface; club admins likely don't have a unified inbox).

**Severity:** Minor.

**Suggested direction.**
- Add a personalized ranking pass (people you played with > club-wide).
- Unify moderation into one admin inbox.
- Add a "club week in review" auto-generated weekly post.

---

### 18. Sponsors & monetization
**Source tasks:** #10 (membership/branding/sponsorship/merch), #43 (sponsor logos within Batch 1), #44 (CTP/LD sponsors within Batch 2), #55 (sponsor analytics dashboard), #91 (sponsor management)

**What we shipped.** Sponsor management (`routes/sponsors.ts`, 1,229 lines), sponsor analytics dashboard, CTP/LD per-event sponsors, sponsor logos on scorecards and recap emails.

**Best-in-class benchmark.** **Golf Genius Sponsor Center** is the closest direct comparison.

**Gap assessment.**
- Sponsor analytics likely measures impressions (logo views) but not deeper engagement (clicks, redemptions, attributable revenue).
- No self-serve sponsor portal for the sponsor themselves to upload assets, see metrics, and renew.
- No A/B testing of sponsor placements.
- No tiering UI for sponsor packages (gold/silver/bronze with auto-applied benefits).

**Severity:** Minor (revenue lever, not user-facing-broken).

**Suggested direction.**
- Build a sponsor-facing self-serve portal.
- Add click and redemption tracking.

---

### 19. Pro shop, POS & e-commerce
**Source tasks:** #12 (online golf shop with dropshipping), #15 (webhooks, wishlist, reviews), #62 (shop admin & player-portal integration), #73 (India-first rebuild — inventory, Shiprocket, GST, COD), #82 (Pro Shop POS)

**What we shipped.** Full e-commerce + POS at `routes/shop.ts` (3,861 lines — the largest single route file), `routes/pos.ts` (1,679 lines), `routes/inventory.ts`, `routes/gst-invoices.ts`. Shiprocket integration, GST invoices, COD support, wishlist, reviews. Mobile `app/shop` flows (some are inside marketplace).

**Best-in-class benchmark.** **Lightspeed Golf** and **Club Caddie** for integrated club POS + e-commerce.

**Gap assessment.**
- E-commerce is the most code-dense pre-power-mode area; depth is real.
- The seam between online shop and in-club POS likely has edge cases (member discounts, dues integration, locker billing) that need a real-world soak.
- Returns flow exists (migration 0021_shop_returns) but the player-facing return UX is undocumented.
- No marketplace recommendations / cross-sell engine.
- No subscription products (e.g. "ball of the month").

**Severity:** Minor (functionally rich; refinement-stage).

**Suggested direction.**
- Run a real-club soak with returns, dues, and POS to find seams.
- Add cross-sell on product detail page.
- Consider subscription SKU support.

---

### 20. Tee-time booking & marketplace
**Source tasks:** #58 (tee-time booking marketplace), #75 (tee-time booking system)

**What we shipped.** Tee-time booking with pricing/policies/windows (`routes/tee-bookings.ts`, `tee-pricing.ts`, `tee-rules.ts`, `tee-times.ts`). Mobile `app/tee-bookings/`. Migrations 0009 (reminders), 0010 (pricing policy), 0020 (tee rules engine).

**Best-in-class benchmark.** **GolfNow** (consumer marketplace), **Supreme Golf** (aggregator), **Foretees** (members-only club bookings).

**Gap assessment.**
- Member booking is solid; the open-marketplace experience (guest / non-member booking with payment) is less mature.
- No dynamic pricing engine surfaced (dynamic-pricing.tsx page exists; configuration depth is unknown without deeper inspection).
- No waitlist for popular tee times (waitlist route exists but UI integration is unclear).
- No GolfNow-style "hot deals" merchandising.
- Reminder emails (migration 0009) are wired; unclear if they survive server restarts (recent post-power-mode task #779-style work suggests this pattern needs attention generally).

**Severity:** Major (booking is a primary club revenue lever).

**Suggested direction.**
- Add a guest booking flow with payment-up-front.
- Surface waitlist UX.
- Verify reminder durability across restarts.

---

### 21. Lessons, coach & swing video
**Source tasks:** #87 (lesson & coaching booking)

**What we shipped.** Lessons booking (`routes/lessons.ts`, 992 lines), coach marketplace (`routes/coach-marketplace.ts`, web `pages/coach-marketplace.tsx`, `coach-workspace.tsx`, `coach-admin.tsx`), swing-videos & swing-reviews (`routes/swing-videos.ts`, `swing-reviews.ts`). Migration 0068_swing_video_fps recently added FPS metadata.

**Best-in-class benchmark.** **V1 Golf** and **Hudl Technique** for swing video review; **Skillest** for the coach-marketplace model.

**Gap assessment.**
- Swing video has FPS metadata but no in-app drawing tools (lines, angles, freeze-frames) that V1 Golf is famous for.
- No side-by-side comparison view (your swing vs. pro reference).
- Coach marketplace likely lacks discovery features (filters by handicap, by region, by specialty) at the polish level Skillest offers.
- Coach payouts (post-power-mode work added a `coach_payout_account_history` table); the original payout flow may have been thin.

**Severity:** Major (this is a high-value, high-margin segment).

**Suggested direction.**
- Add in-app swing drawing & side-by-side compare.
- Add discovery filters and reviews on the coach marketplace.

---

### 22. Operations: F&B, locker, cart, range, rentals, repair
**Source tasks:** #83 (range & bay booking), #84 (cart fleet), #85 (locker room), #86 (F&B on-course ordering), #99 (repair & fitting), #100 (rental equipment)

**What we shipped.** A wide ops layer: F&B (`routes/fb-orders.ts` 1,479 lines), locker (`routes/lockers.ts` 852 lines), cart fleet (`routes/carts.ts` 500 lines), driving range (`routes/range-bookings.ts` 993 lines), rentals (`routes/rentals.ts` 744 lines), repair/fitting (`routes/club-repair.ts` 394 lines).

**Best-in-class benchmark.** **Club Caddie** and **Lightspeed Golf** for integrated club ops; **Foretees** for member-side operations.

**Gap assessment.**
- Each module is correct in isolation; the cross-module experience (a player ordering F&B, paying via wallet, with the charge appearing on dues) is unproven without a live-club soak.
- Range bookings + lessons + coach scheduling don't share a unified "my upcoming" view as cleanly as best-in-class.
- F&B on-course ordering ergonomics on mobile (tap from a hole → order → location detection) need design review against Toast Golf or comparable on-course F&B systems.
- Rentals/repair tracking are functional but customer-side notifications (status changes, ready-for-pickup) need verification.

**Severity:** Minor.

**Suggested direction.**
- Add a unified "my upcoming" view that combines tee-times, lessons, range, F&B orders, and rentals.
- Verify customer notification flow on rentals/repair status.

---

### 23. Pace of play, staffing & governance
**Source tasks:** #90 (event-day staffing — caddies & marshals), #93 (club admin & governance hub), #96 (pace of play tracker)

**What we shipped.** Pace-of-play tracking (`routes/pace-of-play.ts`, 771 lines, page `pages/pace-of-play.tsx`), staffing (`routes/event-staffing.ts` 925 lines, `routes/tournament-staff.ts`, `routes/league-staff.ts`), governance (`routes/governance.ts` 766 lines, `routes/handicap-committee.ts`).

**Best-in-class benchmark.** **Tagmarshal** is the dominant pace-of-play system at clubs. **Golf Genius** for staffing. There is no clear best-in-class for digital golf-club governance (paper + email is still the norm).

**Gap assessment.**
- Pace of play depends on accurate per-group GPS / kiosk pings; without a Tagmarshal-style hardware layer (or aggressive phone GPS), the data quality may be thin.
- No automated marshal alerts ("group 3 is now 12 minutes behind").
- Staffing module is solid; the day-of communication ("marshal X, please go to hole 7") is unproven.
- Governance hub is an opportunity to define the category — no incumbent.

**Severity:** Minor (functional, with depth opportunities).

**Suggested direction.**
- Add automated marshal alerts when a group crosses a pace threshold.
- Build push-channel integration for staffing day-of comms.

---

### 24. Multi-club SaaS platform & branding
**Source tasks:** #10 (club membership/branding/sponsorship/merch), #16 (club branding within analytics rollup), #24 (logo + gold "GOLF" branding), #25 (club contact details), #28 (golf UI polish), #29 (color refresh), #65 (member onboarding & player classification), #74 (multi-club SaaS — onboarding, subscriptions, super-admin, public pages)

**What we shipped.** Multi-tenant SaaS with org-scoped data isolation, super-admin (`routes/super-admin.ts`), club marketing site (`routes/marketing-site.ts`, 2,051 lines, web `pages/club-marketing-site.tsx`), club onboarding wizard (`pages/club-onboarding.tsx`), club settings (`pages/club-settings.tsx`), membership tiers, branding (logo, colors).

**Best-in-class benchmark.** **BlueGolf** for the multi-association/state-golf model; **USGA TM** for sanctioned competition. There is no dominant "club SaaS in a box" — the market is fragmented.

**Gap assessment.**
- Multi-tenancy is real (every recent migration adds an `organization_id` FK with cascade), which is the hardest part to retrofit. Good.
- Branding is shallow: logo + a couple of colors. No theme system (no per-club font, no custom CSS variables exposed to admins, no accent palette beyond gold).
- Public marketing site (per club) exists but design depth varies; the public peer-review and rate-limit work (post-power-mode #784) shows the surface is real and being used by real visitors.
- Sub-tenant per-club analytics (org-scoped dashboards) are present but cross-tenant benchmarking ("how does my club compare to peer clubs") is absent.
- Onboarding wizard (#65, #74) needs to be soak-tested with non-technical club admins.

**Severity:** Minor (foundation is right; depth of theming + admin polish is the gap).

**Suggested direction.**
- Add a theming system (custom font, accent palette, per-club CSS variables).
- Build a peer-club benchmarking dashboard for admins (anonymous, percentile-based).
- Run an onboarding soak with 3 real, non-technical club admins.

---

## Overall themes

Cross-cutting weaknesses observed across most pre-power-mode features:

1. **No automated tests in the original diff.** Tests were added later, sporadically, and only after specific bugs surfaced. Post-power-mode work fixes this by auto-creating a test follow-up for every merge. The pre-power-mode catalogue still has wide test gaps — a chunk of #783 / #928 follow-up scope is exactly closing those gaps.

2. **No analytics instrumentation.** Almost no pre-power-mode feature emits a structured event ("user opened X", "user converted on Y"). We can't measure adoption, drop-off, or which features are loved vs. abandoned. Post-power-mode work has started (e.g. profile-share counters #785), but it's per-feature, not platform-wide.

3. **Design polish is utilitarian, not delightful.** Most features are correct and complete but lack the moments leading apps invest in: full-screen badge celebrations, glossy share cards, animated TV overlays, expressive scoring entry. The engineering is there; the craft pass hasn't happened.

4. **Notifications coverage is patchy.** Many pre-power-mode features create state changes the user would want to know about (booking confirmed, payment posted, score attested, badge earned) but don't reliably trigger a notification. Post-power-mode work has a clear "always pair an action with a notify" pattern; pre-power-mode work doesn't.

5. **Empty / error / loading states are thin.** Spot-checking the mobile and web screens, most pre-power-mode pages render the happy path well but don't deeply consider the empty case ("you have no rounds yet — here's how to start"), the error case (a friendly retry), or the loading shimmer.

6. **Offline support is shallow.** Beyond #11's basic score buffering, pre-power-mode features assume connectivity. For a golf product where signal is unreliable, this is a category-level gap.

7. **Accessibility is undocumented.** No `accessibilityLabel` audit, no dynamic-type test pass, no high-contrast mode, no screen-reader flow walkthrough exists.

8. **Email deliverability is fragile.** Single Gmail SMTP is great for proving features but won't survive growth. Bouncing, deliverability dashboards, and per-message audit are missing.

9. **Cross-feature seams are unverified.** Each module is correct alone; the moments where modules meet (F&B → wallet → dues, lessons → coach payout → tax invoice, tournament close → recap email → social feed → public profile) need real-world soak testing.

10. **No platform-wide design system enforcement.** Branding came in waves (#24, #28, #29). A linted design-token system would prevent future drift; right now consistency depends on the engineer's memory.

---

## What to do with this report

This audit is intentionally non-prescriptive about which gaps to close first. The "Severity" column is a starting point, but the right prioritization depends on:

- Which segment you're targeting next (clubs vs. serious players vs. coaches vs. tournament operators each have a different "Critical").
- Where revenue lives (if e-commerce + tee-times + lessons are the revenue stack, those Major items move up).
- Where the next demo lands (if it's a club admin demo, design-polish themes move up; if it's a serious-golfer demo, scoring + watch + analytics move up).

Suggested next step: pick **one Critical area** and **one Major area** and turn each into a focused implementation task with concrete acceptance criteria. The rest can stay on the roadmap.
