# ADR 0001 — Course-data strategy

**Status:** Accepted (2026-04-21, Wave 0 / Task #935 W0-2)
**Decision owner:** Founder (KHARAGOLF)
**Supersedes:** none

## Context

KHARAGOLF needs hole-level geometry (greens, fairway centerlines, hazards, tee
boxes, cart paths) plus authoritative tee/par/rating/slope data to power:

- Shot tracking & GPS distance-to-front/centre/back
- AI Caddie club recommendations
- Live leaderboards with hole context
- Course pages, marketplace tee discovery
- Tournament setup (scorecards, handicapped competitions)

We evaluated three options:

| Option | Setup cost | Per-club cost | Coverage | Speed | UX fidelity |
|---|---|---|---|---|---|
| Third-party license (Arccos / Garmin / SwingU APIs) | Low | High recurring | Wide (40k+ courses) | Instant | Excellent |
| In-house mapper only | Med | Free | Whatever we draw | Slow | Excellent (we own it) |
| **Hybrid: in-house mapper + GHIN/USGA fallback** | Med | Free + free fallback | Wide (USGA-rated) | Fast for tee data, slow for polygons | Excellent for our clubs, good elsewhere |

## Decision

**Hybrid: in-house mapper + GHIN/USGA fallback.**

- The in-house mapper is the canonical source for polygon geometry on every
  course where a partner club has been onboarded (greens, hazards, fairway
  centerlines, tee boxes, cart paths). Admins draw polygons on a satellite
  map; the result is stored as GeoJSON in `course_hole_geometry`.
- GHIN and USGA are the fallback for tee/par/rating/slope and basic course
  metadata when a course exists in those datasets but hasn't been mapped
  in-house yet. We already have the GHIN integration wired (`lib/ghin.ts`).
- Provider attribution is captured in the `source` column (`in_house | ghin
  | usga | user_drawn`) so the UI can always show a "How accurate is this?"
  affordance.

## Schema

`course_hole_geometry` (migration 0075):

```
id            serial pk
course_id     fk → courses (cascade delete)  -- org scoping is transitive
hole_number   1-36
feature_type  green | fairway | hazard_water | hazard_bunker
              | hazard_oob | tee_box | cart_path
geometry      jsonb  GeoJSON {type, coordinates}
source        in_house | ghin | usga | user_drawn
label         optional human label ("Bunker left of green")
metadata      free-form jsonb
```

Multi-tenancy is enforced transitively via the course → organization cascade.
The `POST /organizations/:orgId/courses/:courseId/geometry` endpoint
double-checks `course.organization_id === :orgId` before any write so the
admin guard cannot be bypassed by guessing course ids.

## API

- `GET  /organizations/:orgId/courses/:courseId/geometry` — public read of all
  features for a course. No auth required (mirrors `hole_details`).
- `POST /organizations/:orgId/courses/:courseId/geometry` — `org_admin` only,
  bulk upsert (replaces the full geometry set by default for atomic mapper
  saves; pass `replace: false` to append-only).

## Consequences

- New courses in the marketplace will show GHIN-sourced tee data
  immediately, and gain in-house polygons as we onboard the club.
- Cost stays at $0/month while we grow — no per-call licensing.
- Polygon coverage is uneven during the ramp-up. The UI must always degrade
  gracefully when geometry is missing (show distance to GHIN green centre
  point only, hide hazard overlays, etc.).
- A future switch to a paid provider for wider polygon coverage is a new
  `source` value plus an importer — the schema does not change.

## First ingest

Wave 0 ships a manually-ingested geometry set for the demo KHARAGOLF
course (course id 1, hole 1) — a single green polygon — as a smoke test
that the table, route, and consumer all wire end-to-end. The seed lives
in `lib/db/drizzle/0075_wave0_foundations_seed.sql` and is idempotent so
post-merge replays don't double-insert.
