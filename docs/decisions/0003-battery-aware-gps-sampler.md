# ADR 0003 — Battery-Aware GPS Sampler

**Status:** Accepted
**Date:** 2026-04-21
**Context:** Wave 1 W1-B — offline / GPS hardening for KHARAGOLF mobile + watch.

## Context

A round of golf takes 4–5 hours. A naive "stream GPS at 1 Hz with full
accuracy for the entire round" implementation drains a phone battery
from 100 % to flat in roughly 2.5 hours and a watch battery in well
under 90 minutes — neither of which survives a tournament. We have
existing background-task infrastructure and an offline shot queue, but
no policy describing **when** the sampler should be high-cadence vs
trickle.

This ADR captures the cadence policy that the GPS sampler (in
`hooks/useGpsTracking.ts` on phone, `LocationManager` on iOS watch,
`FusedLocationProviderClient` on Wear OS) **must** implement.

## Decision

The sampler operates in three modes selected by the player's current
**phase of play** (derived from the score-screen state machine + the
shot-detection feed). Cadence + accuracy budgets per mode:

| Mode             | Phase                                | Cadence  | iOS desired accuracy   | Android priority             | Expected draw |
|------------------|--------------------------------------|----------|------------------------|-------------------------------|---------------|
| **Tee box**      | Player on tee, no shot in last 30 s  | 1 Hz     | `kCLLocationAccuracyBest` (~5 m) | `PRIORITY_HIGH_ACCURACY`     | Highest       |
| **Approach**     | Shot detected within last 60 s, distance to pin > 50 yd | 0.5 Hz | `kCLLocationAccuracyNearestTenMeters` | `PRIORITY_HIGH_ACCURACY`  | Medium        |
| **Idle**         | Walking between holes, > 60 s since last shot, no input | 0.1 Hz (1 sample / 10 s) | `kCLLocationAccuracyHundredMeters` | `PRIORITY_BALANCED_POWER_ACCURACY` | Lowest        |

The **wake transition** (Idle → Tee box) is triggered by:
- player taps "Next hole" / "Start hole N+1" in the score UI, OR
- the phone's pedometer reports the player has stopped (< 0.5 m/s for
  > 5 s) within the next-hole's tee-box geofence (`hole.tee_polygon`
  from the Wave 0 geometry table).

The **sleep transition** (Tee box → Idle) is triggered when:
- score for the current hole has been entered (any source — manual,
  voice, scorer station), AND
- the player has moved > 30 m from the green polygon centroid.

## Power budget (target)

- 5-hour round @ phone, modes mixed in a typical 18-hole proportion
  (10 % tee box / 25 % approach / 65 % idle):
  - estimated draw ≈ 18 % battery (vs ~70 % for 1 Hz-always)
- 5-hour round @ watch (same proportion):
  - estimated draw ≈ 35 % battery (vs flat by hole 12 in 1 Hz-always)

Numbers are derived from CoreLocation / FusedLocation profiles for
Apple Watch Series 7 + Pixel Watch 2; we accept ±5 % drift across
hardware. We will measure real draw via the existing
`HeartRateSampler`-style telemetry hook in Wave 2.

## Implementation contract

The sampler **must** expose:
1. `setMode(mode: 'tee' | 'approach' | 'idle')` — explicit override.
2. An auto-mode driver that subscribes to the score-screen state and
   shot-detection feed.
3. A circuit breaker: if the device reports < 15 % battery, force
   Idle mode regardless of phase. The watch shells additionally drop
   to a "single sample at score-entry" fallback below 10 %.

## Consequences

- **Positive:** survives a full round on standard hardware; respects
  the AI-Caddie `lockdown` mode by short-circuiting all non-Idle
  cadence (since lockdown disables every distance UI).
- **Negative:** F/C/B yardages may be 1–2 sec stale during the
  Approach phase. Acceptable trade — players still call the hole
  before walking up.
- **Followup:** instrument actual battery delta in Wave 2 and
  recalibrate cadences if the projected vs measured gap exceeds 10 %.
