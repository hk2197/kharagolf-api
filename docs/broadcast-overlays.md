# Broadcast Overlays — Operator Guide

KHARAGOLF can serve transparent, live-updating overlays directly from the
web app, ready to drop into OBS Studio, vMix, Wirecast, ATEM Mini and any
other broadcast tool that supports a Browser Source.

This document explains how to set them up and how to drive them from the
producer control panel during a live golf broadcast.

---

## 1. Producer control panel

1. Sign in as an org admin or tournament director.
2. Open **Broadcast Overlays** from the sidebar (it sits next to **TV
   Display**).
3. Pick the active or upcoming tournament you are broadcasting.

The panel exposes:

| Section            | What it does                                                                  |
| ------------------ | ----------------------------------------------------------------------------- |
| Browser Source URLs| Copy/paste URLs for OBS / vMix Browser Sources.                              |
| Active Overlays    | Toggle which overlays are visible on air right now.                          |
| Live Cues          | Push the current hole, current group, featured player, lower-third caption.  |
| Theme              | Override logo, primary colour, accent colour, sponsor bug position, leaderboard rows, safe-area guides. |

Every change is pushed instantly to all connected overlays via Server-Sent
Events — no refresh required.

---

## 2. Available overlays

| Overlay        | URL pattern                                                       | Typical placement |
| -------------- | ------------------------------------------------------------------ | ----------------- |
| Composite      | `/overlay/{tournamentId}`                                          | Full canvas — renders all currently active overlays |
| Leaderboard    | `/overlay/{tournamentId}?type=leaderboard`                         | Top right         |
| Lower third    | `/overlay/{tournamentId}?type=lower-third`                         | Bottom centre     |
| Current group  | `/overlay/{tournamentId}?type=current-group`                       | Top left          |
| Player card    | `/overlay/{tournamentId}?type=player-card`                         | Bottom left       |
| Hole / Flyover | `/overlay/{tournamentId}?type=hole`                                | Bottom right      |
| Sponsor bug    | `/overlay/{tournamentId}?type=sponsor-bug`                         | Configurable corner |

### Optional query parameters

| Parameter            | Purpose                                                                |
| -------------------- | ---------------------------------------------------------------------- |
| `?safe=1080`         | Show 1080p title-safe / action-safe guides (orange + cyan dashed lines)|
| `?safe=4k`           | Show 4K (2160p) safe-area guides                                       |
| `?primary=#RRGGBB`   | Override the primary colour for that browser source only               |
| `?accent=#RRGGBB`    | Override the accent colour                                             |
| `?logo=https://…`    | Override the logo                                                      |
| `?sponsorPosition=top-left` | Force sponsor bug position (top-left, top-right, bottom-left, bottom-right) |

Query overrides are useful for ad-hoc test scenes; for the live broadcast,
set theme values from the Theme section of the producer panel so every
overlay stays consistent.

---

## 3. OBS Studio setup

1. **Scenes → +** to create a scene named e.g. *Golf Broadcast — Hole 17*.
2. **Sources → + → Browser**.
3. Configure the Browser Source:
   * **URL**: paste the URL from the producer panel
   * **Width**: 1920  *(or 3840 for 4K)*
   * **Height**: 1080 *(or 2160 for 4K)*
   * **Custom CSS**: leave default — the overlay sets `background:
     transparent` itself.
   * Tick **Shutdown source when not visible** (saves CPU).
   * Tick **Refresh browser when scene becomes active**.
4. Drop the source on top of your video feed and resize as needed.
5. Repeat for each overlay you want as its own source — or use the
   **Composite** URL once and toggle individual overlays from the panel.

### Sample OBS scene collection (composite URL)

```
Scene: Live Golf
├─ Group: Overlays
│  └─ Browser Source "Composite Overlay"
│       url    = https://your.kharagolf.app/overlay/123
│       width  = 1920
│       height = 1080
│       refresh_on_active = true
├─ Video Capture: Main Camera
└─ Audio Input: Commentator Mic
```

### Sample OBS scene collection (per-overlay URLs)

Use this when you want to fade overlays in/out independently from OBS or
have different scenes that each show different overlays.

```
Scene: Now on Course
├─ Browser "Leaderboard"     → /overlay/123?type=leaderboard
├─ Browser "Current Group"   → /overlay/123?type=current-group
├─ Browser "Sponsor Bug"     → /overlay/123?type=sponsor-bug
└─ Video Capture: Main Camera

Scene: Player Spotlight
├─ Browser "Player Card"     → /overlay/123?type=player-card
├─ Browser "Lower Third"     → /overlay/123?type=lower-third
├─ Browser "Sponsor Bug"     → /overlay/123?type=sponsor-bug
└─ Video Capture: Main Camera

Scene: Hole Flyover
├─ Browser "Hole"            → /overlay/123?type=hole
├─ Browser "Sponsor Bug"     → /overlay/123?type=sponsor-bug
└─ Media Source: hole_17.mp4 (your own flyover video)
```

---

## 4. vMix setup

1. **Add Input → Web Browser**.
2. **URL**: paste the URL from the producer panel.
3. **Resolution**: 1920×1080 or 3840×2160.
4. **Background**: leave **Transparent** (vMix detects the page's
   `background: transparent`).
5. Add the Web Browser input as an overlay channel (Overlay 1–4) so you
   can fade individual overlays in and out.

---

## 5. Driving the broadcast

1. In the panel, set the *active tournament* and *theme*.
2. Toggle on the overlays you need (Active Overlays card).
3. Cue scenes during the broadcast:
   * Type the current hole number → press **Tab** (auto-cues to all
     `?type=hole` sources).
   * Pick the *current group* from the dropdown to populate the
     Current Group overlay.
   * Pick a *featured player* to populate the Player Card overlay.
   * Type a *lower-third caption* (e.g. *"Now showing: Hole 17"*) and
     press **Enter** — the lower third appears immediately.
4. Press **Hide all overlays** at the end of the broadcast.

---

## 6. Safe-area guides

Producers can enable safe-area guides while framing their scenes — useful
when checking that nothing important is cropped on broadcast TVs.

Enable guides one of two ways:

* Toggle **Show 1080p / 4K safe-area guides** in the Theme card. All
  connected overlays will start drawing the guides.
* Open a single overlay URL with `?safe=1080` or `?safe=4k`.

Two dashed boxes are drawn:

* **Cyan, inset 5%** — title-safe area (text + key graphics)
* **Orange, inset 3.5%** — action-safe area (anything important)

Disable guides before going live.

---

## 7. Out of scope

These overlays are **graphics only**. Video capture, mixing, recording,
and streaming are handled by your broadcast software (OBS, vMix, etc).
KHARAGOLF does not host or transcode video.
