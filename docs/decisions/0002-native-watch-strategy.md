# ADR 0002 — Native watch app strategy

**Status:** Accepted (2026-04-21, Wave 0 / Task #935 W0-5)
**Decision owner:** Founder (KHARAGOLF)
**Supersedes:** none
**Coordinates with:** Task #78 (Native Android, iOS, watchOS & Wearable Apps)

## Context

The roadmap ships a wearable companion (Apple Watch + Wear OS) for live
scoring, GPS distance, and shot tracking. Two paths were on the table:

| Path | Pros | Cons |
|---|---|---|
| Expo native module | One codebase shared with phone, fastest to ship | watchOS/Wear OS complications, glances, and haptics are second-class. JS bridge is a real cost on a tiny CPU. |
| **Separate native Swift (watchOS) + Kotlin (Wear OS) apps** | True platform UX, complications, always-on display, LTE-independent. | Two more codebases to maintain. |

KHARAGOLF positions itself as the *premium* operator-grade golf platform —
the watch experience is part of that promise. We are choosing UX fidelity
over speed-to-market.

## Decision

**Separate native Swift (watchOS) + Kotlin (Wear OS) apps**, each consuming
the existing `/ws/watch` WebSocket endpoint already attached in
`artifacts/api-server/src/index.ts` (see `routes/ws-watch.ts`).

## Layout

```
artifacts/kharagolf-mobile/
├── ios-watch-extension/          # existing — Swift watchOS app + tests
│   └── KHARAGOLFWatchTests/
└── wear-os-app/                  # NEW (W0-5 skeleton)
    └── README.md                 # build instructions, API contract pointers
```

The Expo phone app remains the primary container; both watch apps pair with
it via:

- Bluetooth handshake → phone hands the watch a short-lived `watch_token`
  (`lib/watch-token.ts`).
- WebSocket upgrade to `/ws/watch?token=…` for live state.
- Local persistence on the watch for the offline-first scoring path
  (Wave 1 / W1-C).

## Phone↔watch contract surface

To stop the watch app and the phone app from drifting in lockstep:

- All payloads on `/ws/watch` are versioned (`{ v: 1, type: "...", ... }`).
- The shared types live in `lib/watch-protocol/` (planned in Wave 1) so
  Swift / Kotlin / TypeScript all read from one schema doc — generated
  Swift structs and Kotlin data classes are produced in CI.

## Consequences

- Two more codebases to keep alive — owned by the watch track in Wave 1+.
- True watchOS / Wear OS UX (complications, always-on, haptic-rich).
- The Expo native module path is explicitly **not** taken — when Wave 1 /
  W1-C ships the native watch app, no Expo module spike is needed.

## Coordination with Task #78

Task #78 (Native Android, iOS, watchOS & Wearable Apps) is the next stop
for the watch tracks. It MUST consume the file layout and protocol contract
defined here — see this ADR before opening a new spike.
