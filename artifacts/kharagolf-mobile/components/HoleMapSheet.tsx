import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Dimensions,
  Image,
  Linking,
  Modal,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import Svg, { Circle, Ellipse, G, Line, Path, Polygon, Polyline, Rect, Text as SvgText } from "react-native-svg";
import Colors from "@/constants/colors";
import { fetchPublic, BASE_URL } from "@/utils/api";
import { formatRelativeTime } from "@/i18n/relativeTime";
import { buildCorrectionDeepLink } from "@/utils/correctionDeepLink";
import { Feather } from "@expo/vector-icons";
import Green3DView, { type ContourData } from "./Green3DView";
import { WatchBridge } from "@/modules/KharagolfWatchBridge";
import { interpolatePinElevation } from "@/utils/pinElevation";
import {
  loadCachedCourseBundle,
  bundleToHazards,
  bundleToFairways,
} from "@/utils/courseBundle";
import {
  SNAP_THRESHOLD_M,
  pointInRing,
  closestPointOnSegmentM,
  snapToFairway,
  findSnapTarget,
  lieTypeForHazard,
  haversineMeters,
  metersToYards,
  bearingDeg,
  metersPerPixel as sharedMetersPerPixel,
  type FairwayInfo,
  type SnapCandidateGreen,
  type SnapTarget,
} from "@workspace/snap-to-fairway";
import {
  playsLikeBreakdown as sharedPlaysLikeBreakdown,
  playsLikeYards as sharedPlaysLikeYards,
  type PlaysLikeBreakdown as SharedPlaysLikeBreakdown,
} from "@workspace/golf-physics";

// Re-export the shared snap helpers so existing call-sites that import them
// from this module (and the legacy test mocks) keep working unchanged.
export {
  SNAP_THRESHOLD_M,
  pointInRing,
  closestPointOnSegmentM,
  snapToFairway,
  findSnapTarget,
};

function windDegToCompass(deg: number) {
  const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return dirs[Math.round(deg / 45) % 8];
}

// Task #1638 — short relative-time label for the expanded undo history
// rows. Most edits are <60s old (the snackbar's auto-dismiss is 5s when
// collapsed) but the expanded list suspends auto-dismiss so handle
// minutes / hours too. Task #2059 routes this through the shared i18n
// `formatRelativeTime` helper so non-English locales (including Arabic
// counts 2..10, the bug Task #1659 fixed) get correctly-pluralized
// copy via Intl.RelativeTimeFormat instead of the previous English-only
// "Xs/m/h ago" fragments.

// Task #2031 — absolute clock time shown when the player long-presses
// a row in the expanded undo list (e.g. "8:32:14 PM"). The relative
// label keeps ticking on the row, but once it has rolled over to
// "1m ago" / "2m ago" the long-press surfaces the exact moment of the
// edit — closer to a proper audit log without bloating the visible row.
function formatAbsoluteTime(ts: number): string {
  return new Date(ts).toLocaleTimeString();
}

// Per-factor breakdown for plays-like yardage. Re-exported from the shared
// `@workspace/golf-physics` package so the phone scorecard, the watch
// widget, the web Hole Map panel, and the api-server `/playslike` endpoint
// all agree on the shape and the coefficients (Task #1965).
export type PlaysLikeBreakdown = SharedPlaysLikeBreakdown;

// Plays-like breakdown combining wind + elevation + temperature + altitude.
// All four factors live in `@workspace/golf-physics` so any tweak to a
// coefficient flows through to mobile, web, watch and api-server in one
// edit. The wrappers below preserve the historical positional signature
// existing callers and tests use.
//
// windDir: meteorological direction (wind comes FROM)
// bearing: direction from player to target
// elevDiffMeters: greenElevation − playerElevation (positive = uphill)
// temperatureC: ambient air temp; 21°C is reference (cooler = denser = ball flies shorter)
// altitudeMeters: course elevation above sea level (higher = thinner air = ball flies further)
export const playsLikeBreakdown = sharedPlaysLikeBreakdown;

// Thin wrapper that returns just the final yardage. Retained for callers that
// only care about the headline number (the watch bridge, the in-sheet F/C/B
// distance row, the existing test suite). New callers should prefer
// {@link playsLikeBreakdown} so they can render the per-factor breakdown.
export const playsLikeYards = sharedPlaysLikeYards;

// ── Mapbox helpers ──────────────────────────────────────────────────────────
const MAP_ZOOM = 17;
const IMG_W = 600;
const IMG_H = 400;

// At zoom 17, metres per pixel = 156543.03392 * cos(lat * π/180) / 2^17.
// Wraps the shared `metersPerPixel(lat, zoom)` so the rest of this file can
// keep its single-arg call style.
function metersPerPixel(lat: number) {
  return sharedMetersPerPixel(lat, MAP_ZOOM);
}

// Convert lat/lng delta to pixel delta (image coordinates)
// refLat: reference latitude in degrees for longitude scaling
function latLngToPx(
  deltaLat: number, deltaLng: number,
  mpp: number, containerW: number, containerH: number,
  refLat: number
): { x: number; y: number } {
  const pxPerMeter = 1 / mpp;
  const metersPerDegreeLat = 111111;
  const metersPerDegreeLng = 111111 * Math.cos(refLat * Math.PI / 180);
  const x = containerW / 2 + deltaLng * metersPerDegreeLng * pxPerMeter;
  const y = containerH / 2 - deltaLat * metersPerDegreeLat * pxPerMeter;
  return { x, y };
}

// Convert pixel delta to lat/lng delta
// refLat: reference latitude in degrees for longitude scaling
function pxToLatLng(
  deltaX: number, deltaY: number,
  mpp: number,
  refLat: number
): { lat: number; lng: number } {
  const metersPerDegreeLat = 111111;
  const metersPerDegreeLng = 111111 * Math.cos(refLat * Math.PI / 180);
  return {
    lat: -deltaY * mpp / metersPerDegreeLat,
    lng: deltaX * mpp / metersPerDegreeLng,
  };
}

function buildMapboxUrl(lat: number, lng: number, token: string) {
  return `https://api.mapbox.com/styles/v1/mapbox/satellite-v9/static/${lng},${lat},${MAP_ZOOM}/${IMG_W}x${IMG_H}@2x?access_token=${token}`;
}

interface WeatherData {
  windSpeed: number;
  windDirection: number;
  temperature: number;
  weatherCode: number;
}

const STANDARD_CLUBS = ["Dr","3W","5W","7W","2H","3H","4H","5H","3I","4I","5I","6I","7I","8I","9I","PW","GW","SW","LW","Putter"];

interface ShotRow {
  id: number;
  holeNumber: number | null;
  shotNumber: number | null;
  shotType: string | null;
  club: string | null;
  lieType: string | null;
  latitude: string | null;
  longitude: string | null;
  distanceCarried: string | null;
  distanceToPin: string | null;
}

interface HoleInfo {
  holeNumber: number;
  par?: number | null;
  yardageWhite?: number;
  greenCentreLat?: string | null;
  greenCentreLng?: string | null;
  greenFrontLat?: string | null;
  greenFrontLng?: string | null;
  greenBackLat?: string | null;
  greenBackLng?: string | null;
}

interface HazardInfo {
  holeNumber: number;
  hazardType: string;
  lat: string;
  lng: string;
  radiusMeters: number | null;
  name: string | null;
}

interface Props {
  visible: boolean;
  onClose: () => void;
  hole: HoleInfo;
  userLat?: number | null;
  userLng?: number | null;
  weather?: WeatherData | null;
  courseId?: number;
  tournamentId?: number;
  playerId?: number;
  roundNumber?: number;
  generalPlayRoundId?: number;
  token?: string | null;
  savedPinLatOffset?: number;
  savedPinLngOffset?: number;
  onPinSaved?: (latOffset: number, lngOffset: number) => void;
  /** AI Caddie aim-point relative to the pin (lat/lng degrees) plus
   *  longitudinal & lateral dispersion stddev (yards) for the dispersion ellipse. */
  aimPoint?: {
    latOffset: number;
    lngOffset: number;
    lateralStddevYards?: number;
    longitudinalStddevYards?: number;
    club?: string | null;
  } | null;
  /**
   * Task #1332 — fires whenever the sheet's hazard / fairway fetches flip
   * between live data and the cached course bundle. Lets the parent screen
   * surface a single round-level "saved course data" indicator (e.g. on the
   * F/C/B distance row) that stays in sync with the in-sheet banner.
   */
  onUsingCachedCourseChange?: (cached: boolean) => void;
}

export default function HoleMapSheet({
  visible, onClose, hole, userLat, userLng, weather,
  courseId, tournamentId, playerId, roundNumber, generalPlayRoundId, token,
  savedPinLatOffset = 0, savedPinLngOffset = 0, onPinSaved, aimPoint,
  onUsingCachedCourseChange,
}: Props) {
  const [mapboxToken, setMapboxToken] = useState<string | null>(null);
  const [imageLoading, setImageLoading] = useState(true);
  const [imageError, setImageError] = useState(false);
  const [hazards, setHazards] = useState<HazardInfo[]>([]);
  const [fairways, setFairways] = useState<FairwayInfo[]>([]);
  // Task #1160 — surfaces a small "saved course data" pill when one of the
  // course-data fetches has fallen back to the AsyncStorage course bundle.
  const [usingCachedCourse, setUsingCachedCourse] = useState(false);
  const [elevDiff, setElevDiff] = useState<number | null>(null);
  const [altitude, setAltitude] = useState<number | null>(null);
  // Per-point elevations (metres) at user/front/centre/back, used to
  // interpolate the elevation at the actual pin position rather than just
  // the green centre.
  const [pointElevations, setPointElevations] = useState<{ user: number; front: number; centre: number; back: number } | null>(null);
  const [contour, setContour] = useState<ContourData | null>(null);
  const [contourLoading, setContourLoading] = useState(false);
  const [show3D, setShow3D] = useState(false);

  // Pin position offset from green centre (degrees) — initialised from saved value
  const [pinLatOffset, setPinLatOffset] = useState(savedPinLatOffset);
  const [pinLngOffset, setPinLngOffset] = useState(savedPinLngOffset);

  // Watch-captured shots loaded from the server, plus selection / busy state
  // for the inline editor. Mirrors web's HoleMapPanel.
  const [watchShots, setWatchShots] = useState<ShotRow[]>([]);
  const [selectedShotId, setSelectedShotId] = useState<number | null>(null);
  const [shotEditBusy, setShotEditBusy] = useState(false);
  // Live override applied while a shot marker is being dragged so the SVG
  // marker, hit-target, and trace polyline all follow the finger before the
  // PATCH commits the new lat/lng (Task #705).
  const [shotDragOverride, setShotDragOverride] = useState<{ id: number; lat: number; lng: number } | null>(null);
  // Short-lived "Undo" snackbar shown after a successful shot edit so the
  // player can revert an accidental change (Task #859 for drags, Task #1009
  // for club / lie / shotType edits and deletions). Generic across action
  // types — the per-call `undo` callback knows how to reverse the change.
  //
  // Task #1177 — keeps a small history of recent edits so a player who
  // batches several changes can undo them one at a time. The visible
  // banner always shows the most recent entry; pressing Undo pops it from
  // the stack and reveals the next one (if any). The auto-dismiss timer
  // resets each time a new edit is pushed or an undo is performed.
  // Task #1639 — raised the cap from 3 to 10 so power users in long rounds
  // can reach further back. The expanded list scrolls when entries exceed
  // the visible window; older entries continue to expire on the same TTL
  // rules.
  const UNDO_STACK_LIMIT = 10;
  const UNDO_STACK_TTL_MS = 5000;
  const [undoStack, setUndoStack] = useState<Array<{ message: string; undo: () => void | Promise<unknown>; ts: number }>>([]);
  // Task #1366 — when the player taps the "+N more" badge the snackbar
  // expands to show the full pending stack with per-entry UNDO buttons.
  // The auto-dismiss timer is paused while expanded so the player can take
  // their time picking which edit to revert.
  const [undoExpanded, setUndoExpanded] = useState(false);
  // Task #1638 — bumped every second while the expanded list is open so
  // the per-row relative timestamps ("just now", "5s ago") stay fresh.
  const [undoTick, setUndoTick] = useState(0);
  // Task #2031 — index of the expanded-list row whose absolute clock
  // time bubble is currently visible (long-press to reveal). null when
  // no row is being inspected. Auto-clears after a short delay so the
  // bubble doesn't linger.
  const [undoAbsTimeIdx, setUndoAbsTimeIdx] = useState<number | null>(null);
  const undoAbsTimeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const undoStackRef = useRef<Array<{ message: string; undo: () => void | Promise<unknown>; ts: number }>>([]);
  // Serialise the actual revert PATCHes so that rapid UNDO presses still
  // complete in strict LIFO order even when network latency would let
  // them resolve in a different order (Task #1177).
  const undoChainRef = useRef<Promise<void>>(Promise.resolve());
  // Mirror state into a ref so timer / pop callbacks always read the
  // current stack without re-binding.
  useEffect(() => { undoStackRef.current = undoStack; }, [undoStack]);
  const armUndoTimer = useCallback(() => {
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    undoTimerRef.current = setTimeout(() => {
      undoTimerRef.current = null;
      undoStackRef.current = [];
      setUndoStack([]);
      setUndoExpanded(false);
    }, UNDO_STACK_TTL_MS);
  }, []);
  const dismissUndoToast = useCallback(() => {
    if (undoTimerRef.current) {
      clearTimeout(undoTimerRef.current);
      undoTimerRef.current = null;
    }
    undoStackRef.current = [];
    setUndoStack([]);
    setUndoExpanded(false);
  }, []);
  const pushUndoEntry = useCallback((message: string, undo: () => void) => {
    // Task #1638 — capture push time so the expanded list can render
    // a relative timestamp ("just now", "5s ago") next to each row.
    setUndoStack(prev => {
      const next = [...prev, { message, undo, ts: Date.now() }];
      if (next.length > UNDO_STACK_LIMIT) next.shift();
      undoStackRef.current = next;
      return next;
    });
    armUndoTimer();
  }, [armUndoTimer]);
  const popAndRunUndo = useCallback(() => {
    const stack = undoStackRef.current;
    if (stack.length === 0) return;
    const top = stack[stack.length - 1];
    const next = stack.slice(0, -1);
    undoStackRef.current = next;
    setUndoStack(next);
    if (next.length === 0) {
      if (undoTimerRef.current) {
        clearTimeout(undoTimerRef.current);
        undoTimerRef.current = null;
      }
      setUndoExpanded(false);
    } else if (next.length === 1) {
      // Nothing left to expand; collapse the list view automatically.
      setUndoExpanded(false);
      armUndoTimer();
    } else {
      armUndoTimer();
    }
    // Enqueue the revert PATCH on a serial chain so rapid UNDO taps
    // execute in LIFO order even when the previous PATCH hasn't yet
    // finished (Task #1177).
    undoChainRef.current = undoChainRef.current
      .then(() => Promise.resolve(top.undo()))
      .then(() => undefined)
      .catch(() => undefined);
  }, [armUndoTimer]);
  // Task #1366 — undo a specific entry by stack index (chronological:
  // 0 = oldest, length-1 = newest). Wired to the per-entry UNDO buttons
  // in the expanded list so the player can revert an older edit without
  // first stepping through the newer ones. Reverts ride the same serial
  // chain as popAndRunUndo so rapid taps stay deterministic.
  const runUndoEntry = useCallback((idx: number) => {
    const stack = undoStackRef.current;
    if (idx < 0 || idx >= stack.length) return;
    const entry = stack[idx];
    const next = stack.slice(0, idx).concat(stack.slice(idx + 1));
    undoStackRef.current = next;
    setUndoStack(next);
    if (next.length === 0) {
      if (undoTimerRef.current) {
        clearTimeout(undoTimerRef.current);
        undoTimerRef.current = null;
      }
      setUndoExpanded(false);
    } else if (next.length === 1) {
      setUndoExpanded(false);
      armUndoTimer();
    } else if (!undoExpanded) {
      // Stack still has 2+ entries — only re-arm the auto-dismiss timer
      // when the list is collapsed; while expanded the timer stays
      // suspended (Task #1366).
      armUndoTimer();
    }
    undoChainRef.current = undoChainRef.current
      .then(() => Promise.resolve(entry.undo()))
      .then(() => undefined)
      .catch(() => undefined);
  }, [armUndoTimer, undoExpanded]);
  // Task #2032 — pop the entire pending stack at once and chain every
  // entry's undo callback through the same serial chain in newest → oldest
  // order so each callback runs against the state it expects (the existing
  // single-undo flow already enforces strict LIFO; this just queues the
  // whole stack in one go). The snackbar tears down immediately because
  // the stack is empty after the call, mirroring the single-undo "last
  // entry" behaviour above.
  const undoAll = useCallback(() => {
    const stack = undoStackRef.current;
    if (stack.length === 0) return;
    // Snapshot newest → oldest before clearing so the closures below keep
    // a stable iteration order even if a stray push lands mid-chain.
    const reversed = stack.slice().reverse();
    undoStackRef.current = [];
    setUndoStack([]);
    setUndoExpanded(false);
    if (undoTimerRef.current) {
      clearTimeout(undoTimerRef.current);
      undoTimerRef.current = null;
    }
    for (const entry of reversed) {
      undoChainRef.current = undoChainRef.current
        .then(() => Promise.resolve(entry.undo()))
        .then(() => undefined)
        .catch(() => undefined);
    }
  }, []);
  // While the list is expanded, suspend the auto-dismiss timer; re-arm it
  // when the player collapses the list (or when another edit lands).
  useEffect(() => {
    if (undoExpanded) {
      if (undoTimerRef.current) {
        clearTimeout(undoTimerRef.current);
        undoTimerRef.current = null;
      }
    } else if (undoStackRef.current.length > 0 && !undoTimerRef.current) {
      armUndoTimer();
    }
  }, [undoExpanded, armUndoTimer]);

  // Task #1638 — while the expanded list is open and at least one entry
  // is pending, tick once a second so the per-row relative timestamps
  // ("3s ago" → "4s ago") update without the player needing to interact.
  // Only ticks when expanded — when collapsed the snackbar is short-lived
  // and re-rendering would needlessly churn React.
  useEffect(() => {
    if (!undoExpanded || undoStack.length === 0) return;
    const t = setInterval(() => setUndoTick(n => n + 1), 1000);
    return () => clearInterval(t);
  }, [undoExpanded, undoStack.length]);

  // Task #2031 — show the absolute clock time bubble for `idx` and
  // auto-clear it after a short window so it doesn't linger after the
  // player moves on. Re-pressing a different row replaces the active
  // bubble; re-pressing the same row resets the timer.
  const showUndoAbsTime = useCallback((idx: number) => {
    if (undoAbsTimeTimerRef.current) {
      clearTimeout(undoAbsTimeTimerRef.current);
    }
    setUndoAbsTimeIdx(idx);
    undoAbsTimeTimerRef.current = setTimeout(() => {
      undoAbsTimeTimerRef.current = null;
      setUndoAbsTimeIdx(null);
    }, 2500);
  }, []);
  // Hide the bubble whenever the list collapses or the stack empties so
  // the bubble doesn't reappear stale next time the list opens.
  useEffect(() => {
    if (!undoExpanded || undoStack.length === 0) {
      if (undoAbsTimeTimerRef.current) {
        clearTimeout(undoAbsTimeTimerRef.current);
        undoAbsTimeTimerRef.current = null;
      }
      setUndoAbsTimeIdx(null);
    }
  }, [undoExpanded, undoStack.length]);
  useEffect(() => () => {
    if (undoAbsTimeTimerRef.current) {
      clearTimeout(undoAbsTimeTimerRef.current);
    }
  }, []);

  // Sync saved offsets when hole changes or sheet opens
  useEffect(() => {
    setPinLatOffset(savedPinLatOffset);
    setPinLngOffset(savedPinLngOffset);
  }, [hole.holeNumber, visible, savedPinLatOffset, savedPinLngOffset]);

  // Clear shot selection whenever the hole changes.
  useEffect(() => { setSelectedShotId(null); }, [hole.holeNumber]);

  // Load watch-originated shots for this round.
  const reloadShots = useCallback(() => {
    if (!visible || !token) return;
    const qs = generalPlayRoundId
      ? `generalPlayRoundId=${generalPlayRoundId}`
      : (tournamentId ? `tournamentId=${tournamentId}` : null);
    if (!qs) return;
    fetch(`${BASE_URL}/api/portal/rounds/1/shots?${qs}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.ok ? r.json() : [])
      .then((groups: { hole: number; shots: ShotRow[] }[]) => {
        if (!Array.isArray(groups)) return;
        const flat: ShotRow[] = [];
        for (const g of groups) {
          if (Array.isArray(g.shots)) flat.push(...g.shots);
        }
        setWatchShots(flat);
      })
      .catch(() => {});
  }, [visible, token, generalPlayRoundId, tournamentId]);

  useEffect(() => { reloadShots(); }, [reloadShots]);

  // PATCH a shot field (club / lieType / shotType / latitude / longitude) and
  // reload list. Returns true on a successful PATCH so callers (e.g. the
  // drag handler in Task #859) can decide whether to surface an Undo toast.
  // Successive edits stack onto the undo history (Task #1177) instead of
  // replacing the previous entry.
  const patchShot = useCallback(async (id: number, body: Record<string, unknown>): Promise<boolean> => {
    if (!token) return false;
    setShotEditBusy(true);
    try {
      const res = await fetch(`${BASE_URL}/api/portal/shots/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      if (res.ok) { reloadShots(); return true; }
      Alert.alert("Could not update shot");
      return false;
    } catch {
      Alert.alert("Could not update shot");
      return false;
    } finally { setShotEditBusy(false); }
  }, [token, reloadShots, dismissUndoToast]);

  // PATCH wrapper that also surfaces a 5-second "Undo" snackbar pointing at
  // the previous values for the fields being changed (Task #1009). Used for
  // explicit user edits like setting Club / Mark Fairway / Mark Sand.
  const patchShotWithUndo = useCallback(async (
    id: number, body: Record<string, unknown>, undoMessage: string,
  ) => {
    const prev = watchShots.find(sh => sh.id === id);
    const prevValues: Record<string, unknown> = {};
    if (prev) {
      for (const key of Object.keys(body)) {
        const v = (prev as unknown as Record<string, unknown>)[key];
        if ((key === "latitude" || key === "longitude" || key === "distanceToPin" || key === "distanceCarried") && typeof v === "string") {
          prevValues[key] = parseFloat(v);
        } else {
          prevValues[key] = v ?? null;
        }
      }
    }
    const ok = await patchShot(id, body);
    if (ok && prev) {
      pushUndoEntry(undoMessage, () => patchShot(id, prevValues));
    }
  }, [patchShot, watchShots, pushUndoEntry]);

  // Restore a previously-deleted shot from its full server-row snapshot.
  // Mirrors the web flow — the server reinserts the row at the original
  // shotNumber and bumps any subsequent shots up by one (Task #1009). Itself
  // an undo action — does not push a new undo entry; the stack pop happens
  // upstream in popAndRunUndo.
  const restoreShot = useCallback(async (snapshot: Record<string, unknown>) => {
    if (!token) return;
    setShotEditBusy(true);
    try {
      const res = await fetch(`${BASE_URL}/api/portal/shots/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(snapshot),
      });
      if (res.ok) reloadShots();
      else Alert.alert("Could not restore shot");
    } catch {
      Alert.alert("Could not restore shot");
    } finally { setShotEditBusy(false); }
  }, [token, reloadShots, dismissUndoToast]);

  const deleteShot = useCallback(async (id: number) => {
    if (!token) return;
    setShotEditBusy(true);
    try {
      const res = await fetch(`${BASE_URL}/api/portal/shots/${id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        setSelectedShotId(null);
        reloadShots();
        // Task #1009 — server returns the deleted row so we can offer Undo.
        const snap = (data as { deletedShot?: Record<string, unknown> }).deletedShot;
        if (snap) pushUndoEntry("Shot deleted", () => restoreShot(snap));
      } else Alert.alert("Could not delete shot");
    } catch {
      Alert.alert("Could not delete shot");
    } finally { setShotEditBusy(false); }
  }, [token, reloadShots, pushUndoEntry, restoreShot]);

  // Delete now offers an Undo snackbar (Task #1009), so we no longer need
  // a destructive confirmation dialog — the affordance is more discoverable
  // and the player has 5 seconds to revert. Kept as a thin wrapper for
  // parity with the existing call site.
  const confirmDeleteShot = useCallback((id: number) => {
    void deleteShot(id);
  }, [deleteShot]);

  // Container dimensions
  const screen = Dimensions.get("window");
  const containerW = screen.width;
  const containerH = Math.round(screen.width * (IMG_H / IMG_W));

  const centreLat = hole.greenCentreLat ? parseFloat(hole.greenCentreLat) : null;
  const centreLng = hole.greenCentreLng ? parseFloat(hole.greenCentreLng) : null;
  const frontLat = hole.greenFrontLat ? parseFloat(hole.greenFrontLat) : null;
  const frontLng = hole.greenFrontLng ? parseFloat(hole.greenFrontLng) : null;
  const backLat = hole.greenBackLat ? parseFloat(hole.greenBackLat) : null;
  const backLng = hole.greenBackLng ? parseFloat(hole.greenBackLng) : null;

  const hasGPS = centreLat !== null && centreLng !== null;
  const mpp = hasGPS ? metersPerPixel(centreLat!) : 1;

  // Fetch Mapbox token from server
  useEffect(() => {
    if (!visible || mapboxToken) return;
    fetchPublic<{ token: string | null }>("/map-config")
      .then(cfg => setMapboxToken(cfg.token))
      .catch(() => {});
  }, [visible]);

  // Fetch hazard + fairway overlays for the course. When either request
  // fails (network drop mid-round) we fall back to the cached course bundle
  // pre-fetched at round start (Task #1160) so the hole map keeps drawing.
  useEffect(() => {
    if (!courseId || !visible) return;
    let cancelled = false;
    const fallbackToBundle = async (kind: "hazards" | "fairways") => {
      const bundle = await loadCachedCourseBundle(courseId);
      if (!bundle || cancelled) return;
      if (kind === "hazards") setHazards(bundleToHazards(bundle));
      else setFairways(bundleToFairways(bundle));
      setUsingCachedCourse(true);
    };
    // Reset the cached-course banner whenever we kick off a fresh attempt;
    // it'll flip back on if either request actually falls back below.
    setUsingCachedCourse(false);
    fetchPublic<HazardInfo[]>(`/courses/${courseId}/holes-hazards`)
      .then(data => { if (!cancelled) setHazards(Array.isArray(data) ? data : []); })
      .catch(() => { void fallbackToBundle("hazards"); });
    fetchPublic<FairwayInfo[]>(`/courses/${courseId}/holes-fairways`)
      .then(data => { if (!cancelled) setFairways(Array.isArray(data) ? data : []); })
      .catch(() => { void fallbackToBundle("fairways"); });
    return () => { cancelled = true; };
  }, [courseId, visible]);

  // Task #1332 — bubble the cached-course flag up to the parent screen so a
  // single round-level "saved course data" indicator can drive both the
  // in-sheet banner and the F/C/B distance row at the same time. Routed
  // through a ref so the effect only re-runs on the actual flag flip.
  const onUsingCachedCourseChangeRef = useRef(onUsingCachedCourseChange);
  useEffect(() => {
    onUsingCachedCourseChangeRef.current = onUsingCachedCourseChange;
  }, [onUsingCachedCourseChange]);
  useEffect(() => {
    onUsingCachedCourseChangeRef.current?.(usingCachedCourse);
  }, [usingCachedCourse]);

  // Fetch elevation at user position and front/centre/back of green so we can
  // interpolate the elevation at the actual pin position (not just centre).
  useEffect(() => {
    if (userLat == null || userLng == null) return;
    if (centreLat == null || centreLng == null) return;
    const lats = [userLat, frontLat ?? centreLat, centreLat, backLat ?? centreLat].join(",");
    const lngs = [userLng, frontLng ?? centreLng, centreLng, backLng ?? centreLng].join(",");
    fetch(`https://api.open-meteo.com/v1/elevation?latitude=${lats}&longitude=${lngs}`)
      .then(r => r.json())
      .then((d: { elevation?: number[] }) => {
        if (d.elevation && d.elevation.length === 4) {
          const [user, front, centre, back] = d.elevation;
          setPointElevations({ user, front, centre, back });
          // Default elevDiff (centre−user) for callers that don't have a
          // pin position yet; the playsLike block below refines this to the
          // actual pin elevation when offsets are known.
          setElevDiff(centre - user);
          setAltitude(user);
        }
      })
      .catch(() => {});
  }, [userLat, userLng, centreLat, centreLng, frontLat, frontLng, backLat, backLng]);

  // Fetch green contour data for the 3D view (Task #358).
  // Gracefully no-op if data isn't available — Green3DView shows a 2D fallback.
  useEffect(() => {
    if (!visible || !courseId) return;
    setContourLoading(true);
    setContour(null);
    fetchPublic<ContourData>(`/courses/${courseId}/holes/${hole.holeNumber}/contour`)
      .then(data => setContour(data))
      .catch(() => setContour(null))
      .finally(() => setContourLoading(false));
  }, [visible, courseId, hole.holeNumber]);

  // Load existing pin position
  useEffect(() => {
    if (!visible) return;
    const url = generalPlayRoundId
      ? `/portal/general-play/${generalPlayRoundId}/pin-positions`
      : tournamentId && playerId
        ? `/portal/tournaments/${tournamentId}/players/${playerId}/rounds/${roundNumber}/pin-positions`
        : null;
    if (!url || !token) return;
    fetch(`${BASE_URL}/api${url}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.json())
      .then((data: { holeNumber: number; latOffset: string; lngOffset: string }[]) => {
        const pos = data.find(p => p.holeNumber === hole.holeNumber);
        if (pos) {
          setPinLatOffset(parseFloat(pos.latOffset));
          setPinLngOffset(parseFloat(pos.lngOffset));
        } else {
          setPinLatOffset(0);
          setPinLngOffset(0);
        }
      })
      .catch(() => {});
  }, [visible, hole.holeNumber]);

  // Save pin position
  const savePinPosition = useCallback(async (latOff: number, lngOff: number) => {
    if (!token) return;
    const url = generalPlayRoundId
      ? `${BASE_URL}/api/portal/general-play/${generalPlayRoundId}/hole/${hole.holeNumber}/pin`
      : tournamentId && playerId
        ? `${BASE_URL}/api/portal/tournaments/${tournamentId}/players/${playerId}/rounds/${roundNumber}/hole/${hole.holeNumber}/pin`
        : null;
    if (!url) return;
    try {
      await fetch(url, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ latOffset: latOff, lngOffset: lngOff }),
      });
      onPinSaved?.(latOff, lngOff);
    } catch {
      // silent — local state already updated
    }
  }, [token, generalPlayRoundId, tournamentId, playerId, roundNumber, hole.holeNumber]);

  // Pan responder for dragging the pin
  const pinDragRef = useRef({ startX: 0, startY: 0, startLat: 0, startLng: 0 });

  const pinPanResponder = PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: () => {
      pinDragRef.current = { startX: 0, startY: 0, startLat: pinLatOffset, startLng: pinLngOffset };
    },
    onPanResponderMove: (_, gs) => {
      const delta = pxToLatLng(gs.dx, gs.dy, mpp, centreLat ?? 0);
      setPinLatOffset(pinDragRef.current.startLat + delta.lat);
      setPinLngOffset(pinDragRef.current.startLng + delta.lng);
    },
    onPanResponderRelease: (_, gs) => {
      const delta = pxToLatLng(gs.dx, gs.dy, mpp, centreLat ?? 0);
      const newLat = pinDragRef.current.startLat + delta.lat;
      const newLng = pinDragRef.current.startLng + delta.lng;
      setPinLatOffset(newLat);
      setPinLngOffset(newLng);
      savePinPosition(newLat, newLng);
    },
  });

  // Compute distances to green centre (adjusted by pin offset)
  const pinLat = centreLat !== null ? centreLat + pinLatOffset : null;
  const pinLng = centreLng !== null ? centreLng + pinLngOffset : null;
  const distToPin = (userLat != null && userLng != null && pinLat != null && pinLng != null)
    ? haversineMeters(userLat, userLng, pinLat, pinLng)
    : null;
  const distToPinYards = distToPin ? metersToYards(distToPin) : null;

  // Plays-like yardage (wind + slope/elevation).
  // Use the elevation interpolated to the actual pin position so a
  // back-pin on a sloped green plays appropriately longer/shorter than
  // a front-pin — and so this number agrees with the AI Caddie engine.
  const bearingToPin = (userLat != null && userLng != null && pinLat != null && pinLng != null)
    ? bearingDeg(userLat, userLng, pinLat, pinLng)
    : null;
  const pinElevDiff = (pointElevations && pinLat != null && pinLng != null
      && frontLat != null && frontLng != null && centreLat != null && centreLng != null
      && backLat != null && backLng != null)
    ? interpolatePinElevation(
        pinLat, pinLng,
        frontLat, frontLng,
        centreLat, centreLng,
        backLat, backLng,
        { front: pointElevations.front, centre: pointElevations.centre, back: pointElevations.back },
      ) - pointElevations.user
    : (elevDiff ?? undefined);
  const playsLike = (distToPinYards && weather && bearingToPin !== null)
    ? playsLikeYards(
        distToPinYards,
        weather.windSpeed, weather.windDirection,
        bearingToPin,
        pinElevDiff ?? undefined,
        weather.temperature ?? undefined,
        altitude ?? undefined,
      )
    : null;

  // Push plays-like to the watch whenever it changes (Task #358).
  useEffect(() => {
    if (!visible || !distToPinYards || playsLike == null || !WatchBridge.isAvailable()) return;
    const windAdj = (weather && bearingToPin !== null)
      ? Math.round((-weather.windSpeed * Math.cos((((weather.windDirection + 180) % 360 - bearingToPin) * Math.PI) / 180)) / 10 * (distToPinYards / 100))
      : 0;
    const elevAdj = pinElevDiff != null ? Math.round(pinElevDiff * 1.09361) : 0;
    WatchBridge.pushPlaysLike(hole.holeNumber, distToPinYards, playsLike, windAdj, elevAdj).catch(() => {});
  }, [visible, hole.holeNumber, distToPinYards, playsLike, pinElevDiff, weather?.windSpeed, weather?.windDirection, bearingToPin]);

  // Hazards / fairways for current hole
  const currentHoleHazards = hazards.filter(hz => hz.holeNumber === hole.holeNumber);
  const currentHoleFairways = fairways.filter(fw => fw.holeNumber === hole.holeNumber);

  // Layup distances (100, 150, 200 yards from pin, on the line from user to pin)
  const layupYards = [100, 150, 200];

  // Pixel positions for SVG overlays
  const greenCentreScreen = hasGPS
    ? { x: containerW / 2, y: containerH / 2 }
    : { x: containerW / 2, y: containerH * 0.3 };

  const pinScreen = hasGPS
    ? (() => {
        const px = latLngToPx(pinLatOffset, pinLngOffset, mpp, containerW, containerH, centreLat!);
        return { x: greenCentreScreen.x + (px.x - containerW / 2), y: greenCentreScreen.y + (px.y - containerH / 2) };
      })()
    : greenCentreScreen;

  const userScreen = (hasGPS && userLat != null && userLng != null && centreLat != null && centreLng != null)
    ? latLngToPx(userLat - centreLat, userLng - centreLng, mpp, containerW, containerH, centreLat)
    : null;

  // Watch-originated shots on this hole that have GPS coords, sorted by shot #.
  const holeShots = watchShots
    .filter(s => s.holeNumber === hole.holeNumber && s.latitude !== null && s.longitude !== null)
    .sort((a, b) => (a.shotNumber ?? 0) - (b.shotNumber ?? 0));

  const holeShotPoints = hasGPS
    ? holeShots.map(s => {
        const override = shotDragOverride && shotDragOverride.id === s.id ? shotDragOverride : null;
        const lat = override ? override.lat : parseFloat(s.latitude!);
        const lng = override ? override.lng : parseFloat(s.longitude!);
        const pt = latLngToPx(lat - centreLat!, lng - centreLng!, mpp, containerW, containerH, centreLat!);
        return { shot: s, x: pt.x, y: pt.y, dragging: override !== null };
      })
    : [];

  // Build the green snap-candidate list (centre + front + back if known).
  const greenSnapPoints: SnapCandidateGreen[] = [];
  if (centreLat != null && centreLng != null) greenSnapPoints.push({ lat: centreLat, lng: centreLng, label: "Green centre" });
  if (frontLat != null && frontLng != null) greenSnapPoints.push({ lat: frontLat, lng: frontLng, label: "Green front" });
  if (backLat != null && backLng != null) greenSnapPoints.push({ lat: backLat, lng: backLng, label: "Green back" });

  // Active snap target while a shot is mid-drag — drives the visual hint ring
  // (Task #858). Recomputed every render so it follows the finger.
  const activeSnap: SnapTarget | null = shotDragOverride
    ? findSnapTarget(
        shotDragOverride.lat, shotDragOverride.lng,
        currentHoleHazards.map(h => ({ lat: h.lat, lng: h.lng, hazardType: h.hazardType, radiusMeters: h.radiusMeters, name: h.name })),
        greenSnapPoints,
        currentHoleFairways,
      )
    : null;

  // Commit a dragged shot's new GPS coordinates via PATCH and reload. If a
  // snap target (Task #858) is in range, snap the lat/lng and pre-fill
  // lieType so the server stores the corrected position and lie in one
  // round-trip. On success, push a 5-second "Undo" entry with the ORIGINAL
  // pre-drag coordinates so the player can revert an accidental drop —
  // including any snap that may have shifted the marker (Task #859, #1177).
  const handleShotDragEnd = useCallback(async (id: number, lat: number, lng: number) => {
    setShotDragOverride(null);
    const orig = watchShots.find(sh => sh.id === id);
    const prevLat = orig?.latitude != null ? parseFloat(orig.latitude) : null;
    const prevLng = orig?.longitude != null ? parseFloat(orig.longitude) : null;
    const snap = findSnapTarget(
      lat, lng,
      currentHoleHazards.map(h => ({ lat: h.lat, lng: h.lng, hazardType: h.hazardType, radiusMeters: h.radiusMeters, name: h.name })),
      greenSnapPoints,
      currentHoleFairways,
    );
    const finalLat = snap ? snap.lat : lat;
    const finalLng = snap ? snap.lng : lng;
    if (prevLat != null && prevLng != null
        && Math.abs(prevLat - finalLat) < 1e-9 && Math.abs(prevLng - finalLng) < 1e-9) {
      return; // no-op drop on the same spot
    }
    const body: Record<string, unknown> = { latitude: finalLat, longitude: finalLng };
    if (snap) body.lieType = snap.lieType;
    const ok = await patchShot(id, body);
    if (ok && prevLat != null && prevLng != null) {
      pushUndoEntry("Shot moved", () => patchShot(id, { latitude: prevLat, longitude: prevLng }));
    }
  }, [patchShot, currentHoleHazards, greenSnapPoints, currentHoleFairways, watchShots, pushUndoEntry]);

  // Drop the pending undo when the sheet is closed or when the player
  // navigates to a new hole so the history stays per-hole (Task #1177).
  useEffect(() => {
    if (!visible) dismissUndoToast();
  }, [visible, dismissUndoToast]);
  useEffect(() => { dismissUndoToast(); }, [hole.holeNumber, dismissUndoToast]);
  useEffect(() => () => {
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
  }, []);

  const selectedShot = holeShots.find(s => s.id === selectedShotId) ?? null;

  // Layup position screens: place them along the line from user to pin (or straight up if no user)
  const layupScreens = layupYards.map(yds => {
    if (!distToPin || distToPin <= 0 || !userScreen) return null;
    const fraction = (distToPin - yds * 0.9144) / distToPin; // yds to metres
    if (fraction <= 0 || fraction >= 1) return null;
    const x = pinScreen.x + (userScreen.x - pinScreen.x) * fraction;
    const y = pinScreen.y + (userScreen.y - pinScreen.y) * fraction;
    return { x, y, yds };
  }).filter(Boolean);

  const mapUrl = (hasGPS && mapboxToken && centreLat && centreLng)
    ? buildMapboxUrl(centreLat, centreLng, mapboxToken)
    : null;

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <View style={s.container}>
        {/* Header */}
        <View style={s.header}>
          <View>
            <Text style={s.headerTitle}>Hole {hole.holeNumber} · Par {hole.par}</Text>
            {hole.yardageWhite ? <Text style={s.headerSub}>{hole.yardageWhite} yds</Text> : null}
          </View>
          <Pressable onPress={onClose} style={s.closeBtn} hitSlop={12}>
            <Feather name="x" size={22} color="#fff" />
          </Pressable>
        </View>

        {/*
          Task #1350 — mobile parity for the web "Report an error" deep link
          added in Task #1174. Players spotting wrong par / yardage / hazard
          info on the hole map can launch the portal correction form pre-
          filled with the courseId + holeNumber, instead of having to
          remember the course id and hole number themselves. Field defaults
          to "par" to match the web links; the form lets them switch it.
          Task #1615 — also forward the current par we're showing on this
          sheet (`hole.par`) as `currentValue`, so the portal form pre-fills
          both the "current" and "suggested" inputs and the player only has
          to edit the digit they want to change. Omitted when par is not
          available (e.g. the bundle didn't include it) so we never invent a
          value the player didn't actually see on screen.
        */}
        {courseId != null && BASE_URL ? (
          <Pressable
            onPress={() => {
              const url = buildCorrectionDeepLink({
                baseUrl: BASE_URL,
                courseId,
                hole: hole.holeNumber,
                field: 'par',
                currentValue: hole.par,
              });
              Linking.openURL(url).catch(() => {});
            }}
            style={s.reportLink}
            hitSlop={6}
            accessibilityRole="link"
            accessibilityLabel={`Report an error on hole ${hole.holeNumber}`}
            testID="link-report-hole"
          >
            <Feather name="alert-triangle" size={11} color="#FBBF24" />
            <Text style={s.reportLinkText}>Report an error on hole {hole.holeNumber}</Text>
          </Pressable>
        ) : null}

        {/* Cached-course indicator (Task #1160) — surfaces when hazard /
            fairway data has fallen back to the offline course bundle. */}
        {usingCachedCourse && (
          <View style={s.cachedBanner} accessibilityLabel="Showing saved course data offline">
            <Feather name="cloud-off" size={11} color="#FBBF24" />
            <Text style={s.cachedBannerText}>Offline · saved course data</Text>
          </View>
        )}

        {/* Map area */}
        <View style={[s.mapContainer, { width: containerW, height: containerH }]}>
          {mapUrl ? (
            <>
              <Image
                source={{ uri: mapUrl }}
                style={StyleSheet.absoluteFillObject}
                onLoadStart={() => setImageLoading(true)}
                onLoad={() => setImageLoading(false)}
                onError={() => { setImageLoading(false); setImageError(true); }}
                resizeMode="cover"
              />
              {imageLoading && (
                <View style={[StyleSheet.absoluteFillObject, s.loadingOverlay]}>
                  <ActivityIndicator size="large" color={Colors.primary} />
                  <Text style={s.loadingText}>Loading satellite view...</Text>
                </View>
              )}
            </>
          ) : (
            <View style={[StyleSheet.absoluteFillObject, s.fallbackBg]}>
              <Text style={s.fallbackText}>🗺️ Aerial view</Text>
              {!hasGPS && <Text style={s.fallbackSub}>No GPS coordinates for this hole</Text>}
              {hasGPS && !mapboxToken && <Text style={s.fallbackSub}>Map not configured — contact admin</Text>}
            </View>
          )}

          {/* SVG overlays */}
          <Svg
            width={containerW}
            height={containerH}
            style={StyleSheet.absoluteFillObject}
            pointerEvents="none"
          >
            {/* Fairway overlays — rendered first so hazards / shot markers
                stay on top. Polygons get a soft green fill + outline,
                LineString centrelines render as a thin dashed line. */}
            {hasGPS && currentHoleFairways.map((fw, fi) => {
              const g = fw.geometry;
              if (!g || !g.coordinates) return null;
              const project = (lng: number, lat: number) =>
                latLngToPx(lat - centreLat!, lng - centreLng!, mpp, containerW, containerH, centreLat!);
              const polygons: [number, number][][] = [];
              const lines: [number, number][][] = [];
              if (g.type === "Polygon") {
                const c = g.coordinates as [number, number][][];
                if (Array.isArray(c) && c.length > 0 && Array.isArray(c[0])) polygons.push(c[0]);
              } else if (g.type === "MultiPolygon") {
                const c = g.coordinates as [number, number][][][];
                if (Array.isArray(c)) for (const poly of c) {
                  if (Array.isArray(poly) && poly.length > 0 && Array.isArray(poly[0])) polygons.push(poly[0]);
                }
              } else if (g.type === "LineString") {
                const c = g.coordinates as [number, number][];
                if (Array.isArray(c)) lines.push(c);
              }
              return (
                <G key={`fw-${fi}`}>
                  {polygons.map((ring, ri) => {
                    if (ring.length < 3) return null;
                    const points = ring.map(([lng, lat]) => {
                      const p = project(lng, lat);
                      return `${p.x},${p.y}`;
                    }).join(" ");
                    return (
                      <Polygon
                        key={`fw-${fi}-p-${ri}`}
                        points={points}
                        fill="rgba(34,197,94,0.18)"
                        stroke="rgba(34,197,94,0.55)"
                        strokeWidth={1}
                      />
                    );
                  })}
                  {lines.map((line, li) => {
                    if (line.length < 2) return null;
                    const points = line.map(([lng, lat]) => {
                      const p = project(lng, lat);
                      return `${p.x},${p.y}`;
                    }).join(" ");
                    return (
                      <Polyline
                        key={`fw-${fi}-l-${li}`}
                        points={points}
                        fill="none"
                        stroke="rgba(34,197,94,0.7)"
                        strokeWidth={1.2}
                        strokeDasharray="5 4"
                      />
                    );
                  })}
                </G>
              );
            })}
            {/* Hazard overlays (water=blue, bunker=sand, OB=red, tree_line=green) */}
            {hasGPS && currentHoleHazards.map((hz, i) => {
              const hzLat = parseFloat(hz.lat);
              const hzLng = parseFloat(hz.lng);
              const hzPx = latLngToPx(hzLat - centreLat!, hzLng - centreLng!, mpp, containerW, containerH, centreLat!);
              const r = Math.max(5, (hz.radiusMeters ?? 10) / mpp);
              const fill = hz.hazardType === "water" ? "rgba(59,130,246,0.35)"
                : hz.hazardType === "bunker" ? "rgba(251,191,36,0.45)"
                : hz.hazardType === "ob" ? "rgba(239,68,68,0.35)"
                : "rgba(34,197,94,0.35)";
              const stroke = hz.hazardType === "water" ? "#3B82F6"
                : hz.hazardType === "bunker" ? "#FBBF24"
                : hz.hazardType === "ob" ? "#EF4444"
                : "#22C55E";
              return <Circle key={i} cx={hzPx.x} cy={hzPx.y} r={r} fill={fill} stroke={stroke} strokeWidth={1.5} />;
            })}
            {/* Fairway guide */}
            {userScreen && (
              <Line
                x1={pinScreen.x} y1={pinScreen.y}
                x2={userScreen.x} y2={userScreen.y}
                stroke="rgba(255,255,255,0.3)" strokeWidth={1.5} strokeDasharray="6 4"
              />
            )}
            {/* Green ellipse */}
            <Ellipse
              cx={greenCentreScreen.x} cy={greenCentreScreen.y}
              rx={32} ry={22}
              fill="rgba(34,197,94,0.25)" stroke="rgba(34,197,94,0.7)" strokeWidth={1.5}
            />
            {/* Front/back green markers */}
            {hasGPS && frontLat && frontLng && (() => {
              const fp = latLngToPx(frontLat - centreLat!, frontLng - centreLng!, mpp, containerW, containerH, centreLat!);
              return <Circle cx={fp.x} cy={fp.y} r={5} fill="rgba(251,191,36,0.8)" />;
            })()}
            {hasGPS && backLat && backLng && (() => {
              const bp = latLngToPx(backLat - centreLat!, backLng - centreLng!, mpp, containerW, containerH, centreLat!);
              return <Circle cx={bp.x} cy={bp.y} r={5} fill="rgba(251,191,36,0.8)" />;
            })()}
            {/* AI Caddie aim point (offset from pin) + dispersion ellipse */}
            {hasGPS && aimPoint && (() => {
              const aimAbsLat = pinLat! + aimPoint.latOffset;
              const aimAbsLng = pinLng! + aimPoint.lngOffset;
              const ap = latLngToPx(aimAbsLat - centreLat!, aimAbsLng - centreLng!, mpp, containerW, containerH, centreLat!);
              const yardsToM = 0.9144;
              const lateralM = (aimPoint.lateralStddevYards ?? 8) * yardsToM;
              const longM = (aimPoint.longitudinalStddevYards ?? aimPoint.lateralStddevYards ?? 10) * yardsToM;
              // Orient ellipse along the player→pin axis if we know it.
              const angleDeg = (userLat && userLng && pinLat && pinLng)
                ? bearingDeg(userLat, userLng, pinLat, pinLng)
                : 0;
              const rxPx = Math.max(8, lateralM / mpp);
              const ryPx = Math.max(8, longM / mpp);
              return (
                <G>
                  <G transform={`rotate(${angleDeg} ${ap.x} ${ap.y})`}>
                    <Ellipse
                      cx={ap.x} cy={ap.y}
                      rx={rxPx} ry={ryPx}
                      fill="rgba(201,168,76,0.18)"
                      stroke="rgba(201,168,76,0.55)"
                      strokeWidth={1.2}
                      strokeDasharray="3 3"
                    />
                  </G>
                  {/* Aim crosshair */}
                  <Line x1={ap.x - 10} y1={ap.y} x2={ap.x + 10} y2={ap.y} stroke="#C9A84C" strokeWidth={1.5} />
                  <Line x1={ap.x} y1={ap.y - 10} x2={ap.x} y2={ap.y + 10} stroke="#C9A84C" strokeWidth={1.5} />
                  <Circle cx={ap.x} cy={ap.y} r={4} fill="#C9A84C" stroke="#0a0a0a" strokeWidth={1} />
                  <Rect x={ap.x + 10} y={ap.y - 18} width={36} height={14} rx={3} fill="rgba(0,0,0,0.7)" />
                  <SvgText x={ap.x + 28} y={ap.y - 8} textAnchor="middle" fontSize={9} fontWeight="bold" fill="#C9A84C">AIM</SvgText>
                </G>
              );
            })()}
            {/* User position */}
            {userScreen && (
              <G>
                <Circle cx={userScreen.x} cy={userScreen.y} r={14} fill="rgba(59,130,246,0.2)" />
                <Circle cx={userScreen.x} cy={userScreen.y} r={8} fill="#3B82F6" stroke="#fff" strokeWidth={2} />
              </G>
            )}
            {/* Watch shot trace — polyline connecting consecutive shots */}
            {holeShotPoints.length > 1 && (
              <Polyline
                points={holeShotPoints.map(p => `${p.x},${p.y}`).join(" ")}
                fill="none"
                stroke="#38BDF8"
                strokeWidth={2}
                strokeDasharray="4 3"
                opacity={0.85}
              />
            )}
            {/* Snap-target hint (Task #858) — pulsing ring at the feature the
                dragged shot will snap to on release. */}
            {hasGPS && activeSnap && (() => {
              const sp = latLngToPx(activeSnap.lat - centreLat!, activeSnap.lng - centreLng!, mpp, containerW, containerH, centreLat!);
              const colour = activeSnap.kind === "green" ? "#22C55E"
                : activeSnap.kind === "fairway" ? "#84CC16"
                : "#FBBF24";
              return (
                <G>
                  <Circle cx={sp.x} cy={sp.y} r={18} fill="none" stroke={colour} strokeWidth={2} strokeDasharray="3 3" opacity={0.9} />
                  <Circle cx={sp.x} cy={sp.y} r={4} fill={colour} stroke="#0a0a0a" strokeWidth={1} />
                </G>
              );
            })()}
            {/* Watch shot markers (display only — taps handled by overlay below) */}
            {holeShotPoints.map(p => {
              const isSel = p.shot.id === selectedShotId;
              return (
                <G key={p.shot.id}>
                  <Circle
                    cx={p.x} cy={p.y}
                    r={isSel ? 13 : 10}
                    fill="#0EA5E9"
                    stroke={isSel ? "#fff" : "#082F49"}
                    strokeWidth={2}
                    opacity={0.95}
                  />
                  <SvgText
                    x={p.x} y={p.y + 4}
                    textAnchor="middle"
                    fontSize={11}
                    fontWeight="bold"
                    fill="#fff"
                  >{p.shot.shotNumber ?? "?"}</SvgText>
                </G>
              );
            })}
            {/* Layup badges */}
            {layupScreens.map((ls, i) => ls && (
              <G key={i}>
                <Rect x={ls.x - 18} y={ls.y - 10} width={36} height={20} rx={5}
                  fill="rgba(0,0,0,0.7)" />
                <SvgText x={ls.x} y={ls.y + 4} textAnchor="middle"
                  fontSize={10} fontWeight="bold" fill={Colors.primary}>{ls.yds}y</SvgText>
              </G>
            ))}
          </Svg>

          {/* Watch shot tap/drag targets — tap to select, drag to reposition (Task #705) */}
          {holeShotPoints.map(p => (
            <DraggableShotMarker
              key={p.shot.id}
              shot={p.shot}
              x={p.x}
              y={p.y}
              mpp={mpp}
              refLat={centreLat ?? 0}
              busy={shotEditBusy}
              onSelect={(id) => setSelectedShotId(prev => prev === id ? null : id)}
              onDragMove={(id, lat, lng) => setShotDragOverride({ id, lat, lng })}
              onDragEnd={handleShotDragEnd}
              onDragCancel={() => setShotDragOverride(null)}
            />
          ))}

          {/* Draggable pin (separate View on top of SVG) */}
          <View
            {...pinPanResponder.panHandlers}
            style={[s.pinMarker, { left: pinScreen.x - 16, top: pinScreen.y - 40 }]}
          >
            <Feather name="flag" size={20} color="#EF4444" />
          </View>

          {/* Wind widget overlay */}
          {weather && (
            <View style={s.windWidget}>
              <WindCompass windDir={weather.windDirection} windSpeed={weather.windSpeed} size={54} />
              <Text style={s.windText}>{Math.round(weather.windSpeed)} km/h</Text>
              <Text style={s.windDir}>{windDegToCompass(weather.windDirection)}</Text>
            </View>
          )}

          {/* Drag hint */}
          <View style={s.dragHint}>
            <Feather name="move" size={10} color="rgba(255,255,255,0.6)" />
            <Text style={s.dragHintText}>
              {activeSnap ? `Snap → ${activeSnap.label}` : "Drag flag to set pin · drag a shot marker to move it"}
            </Text>
          </View>

          {/* 3D Green button — opens contour viewer (Task #358) */}
          <Pressable onPress={() => setShow3D(true)} style={s.threeDBtn}>
            <Feather name="layers" size={12} color="#fff" />
            <Text style={s.threeDBtnText}>3D Green</Text>
          </Pressable>
        </View>

        <Green3DView
          visible={show3D}
          onClose={() => setShow3D(false)}
          holeNumber={hole.holeNumber}
          contour={contour}
          loading={contourLoading}
        />

        {/* Distance panel */}
        <View style={s.distPanel}>
          {distToPinYards ? (
            <View style={s.distRow}>
              <View style={s.distItem}>
                <Text style={s.distLabel}>TO PIN</Text>
                <Text style={[s.distVal, { color: Colors.primary }]}>{distToPinYards}</Text>
                <Text style={s.distUnit}>yds</Text>
              </View>
              {playsLike && playsLike !== distToPinYards && (
                <View style={s.distItem}>
                  <Text style={s.distLabel}>PLAYS LIKE</Text>
                  <Text style={[s.distVal, { color: "#FBBF24" }]}>{playsLike}</Text>
                  <Text style={s.distUnit}>yds</Text>
                </View>
              )}
              {layupYards.map(y => distToPinYards > y && (
                <View key={y} style={s.distItemSm}>
                  <Text style={s.distLabelSm}>{y}y</Text>
                  <Text style={s.distValSm}>{metersToYards(haversineMeters(
                    userLat!, userLng!,
                    pinLat! + ((userLat! - pinLat!) / distToPin! * (y * 0.9144)),
                    pinLng! + ((userLng! - pinLng!) / distToPin! * (y * 0.9144))
                  ))}y away</Text>
                </View>
              ))}
            </View>
          ) : (
            <Text style={s.noDistText}>Enable location for distances</Text>
          )}

          {/* Watch shots panel + editor */}
          {holeShots.length > 0 && (
            <View style={s.shotsPanel}>
              <View style={s.shotsHeader}>
                <Feather name="watch" size={14} color="#38BDF8" />
                <Text style={s.shotsHeaderText}>Watch shots · {holeShots.length}</Text>
                <Text style={s.shotsHeaderHint}>tap a marker to edit</Text>
              </View>

              {selectedShot && (
                <View style={s.shotEditor}>
                  <View style={s.shotEditorTitleRow}>
                    <Text style={s.shotEditorTitle}>
                      Edit hole {selectedShot.holeNumber} · shot #{selectedShot.shotNumber}
                    </Text>
                    <Pressable onPress={() => setSelectedShotId(null)} hitSlop={10}>
                      <Feather name="x" size={16} color="rgba(255,255,255,0.6)" />
                    </Pressable>
                  </View>

                  <Text style={s.shotEditorLabel}>Club</Text>
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 4 }}>
                    <View style={s.clubRow}>
                      {STANDARD_CLUBS.map(c => {
                        const active = selectedShot.club === c;
                        return (
                          <Pressable
                            key={c}
                            disabled={shotEditBusy}
                            onPress={() => patchShotWithUndo(selectedShot.id, { club: c }, "Club updated")}
                            style={[s.clubChip, active && s.clubChipActive]}
                          >
                            <Text style={[s.clubChipText, active && s.clubChipTextActive]}>{c}</Text>
                          </Pressable>
                        );
                      })}
                    </View>
                  </ScrollView>

                  <View style={s.shotEditorActions}>
                    <Pressable
                      disabled={shotEditBusy}
                      onPress={() => patchShotWithUndo(selectedShot.id, { lieType: "Fairway" }, "Marked Fairway")}
                      style={[s.editBtn, { borderColor: "rgba(245,158,11,0.45)" }]}
                    >
                      <Text style={[s.editBtnText, { color: "#fbbf24" }]}>Mark Fairway</Text>
                    </Pressable>
                    <Pressable
                      disabled={shotEditBusy}
                      onPress={() => patchShotWithUndo(selectedShot.id, { lieType: "Bunker", shotType: "sand" }, "Marked Sand")}
                      style={[s.editBtn, { borderColor: "rgba(234,179,8,0.45)" }]}
                    >
                      <Text style={[s.editBtnText, { color: "#facc15" }]}>Mark Sand</Text>
                    </Pressable>
                    <Pressable
                      disabled={shotEditBusy}
                      onPress={() => confirmDeleteShot(selectedShot.id)}
                      style={[s.editBtn, { borderColor: "rgba(239,68,68,0.45)", marginLeft: "auto" }]}
                    >
                      <Feather name="trash-2" size={12} color="#fca5a5" />
                      <Text style={[s.editBtnText, { color: "#fca5a5", marginLeft: 4 }]}>Delete</Text>
                    </Pressable>
                  </View>
                </View>
              )}
            </View>
          )}

          {/* Wind info row */}
          {weather && (
            <View style={s.windRow}>
              <Feather name="wind" size={14} color={Colors.muted} />
              <Text style={s.windRowText}>
                {Math.round(weather.windSpeed)} km/h {windDegToCompass(weather.windDirection)}
                {playsLike && distToPinYards && playsLike !== distToPinYards
                  ? `  ·  ${playsLike > distToPinYards ? "Into wind — plays longer" : "Downwind — plays shorter"}`
                  : ""}
              </Text>
            </View>
          )}

          {/* Layup info */}
          <View style={s.layupRow}>
            {layupYards.map(y => (
              <View key={y} style={s.layupBadge}>
                <Text style={s.layupBadgeText}>{y}y</Text>
                {distToPinYards && (
                  <Text style={s.layupBadgeSub}>
                    {distToPinYards > y ? `${distToPinYards - y}y away` : "Past"}
                  </Text>
                )}
              </View>
            ))}
          </View>

          {!hasGPS && (
            <View style={s.noGpsBanner}>
              <Feather name="alert-circle" size={14} color="#FBBF24" />
              <Text style={s.noGpsBannerText}>Green GPS not set — contact club admin to enable map features</Text>
            </View>
          )}
        </View>

        {/* Undo snackbar shown for ~5s after a successful shot edit. Tracks a
            small stack of recent edits (Task #1177) so a player who batched
            several changes can undo them one at a time — the banner shows
            the most recent action plus a "+N more" hint when more entries
            are queued. Tapping "+N more" expands the snackbar to show the
            full pending stack with per-entry UNDO buttons (Task #1366). */}
        {undoStack.length > 0 && (() => {
          const top = undoStack[undoStack.length - 1];
          const extra = undoStack.length - 1;
          if (undoExpanded && extra > 0) {
            // Expanded list — chronological (oldest → newest), per-entry UNDO.
            // Task #1638 — each row also shows a relative timestamp ("just
            // now", "5s ago") so two adjacent rows that share a label
            // (e.g. two "Shot moved" entries) can be told apart. The
            // `undoTick` state ticks every second while expanded so these
            // labels stay fresh without the player needing to interact.
            const now = Date.now();
            void undoTick;
            return (
              <View style={s.undoSnack} pointerEvents="box-none">
                <View style={s.undoSnackExpanded}>
                  <View style={s.undoSnackHeader}>
                    <Feather name="rotate-ccw" size={14} color="#bae6fd" />
                    <Text style={s.undoSnackHeaderText}>Recent edits</Text>
                    {/* Task #2032 — "UNDO ALL" pops the whole pending stack
                        in one tap, reverting in newest → oldest order
                        through the same serial chain as the per-row UNDO
                        buttons. Sits in the header so it's always visible
                        even when the list scrolls. */}
                    <Pressable
                      onPress={undoAll}
                      hitSlop={10}
                      style={s.undoSnackUndoAll}
                      accessibilityLabel={`Undo all ${undoStack.length} pending edits`}
                    >
                      <Text style={s.undoSnackUndoAllText}>UNDO ALL</Text>
                    </Pressable>
                    <Pressable
                      onPress={() => setUndoExpanded(false)}
                      hitSlop={10}
                      style={s.undoSnackHide}
                    >
                      <Text style={s.undoSnackHideText}>HIDE</Text>
                    </Pressable>
                    <Pressable onPress={dismissUndoToast} hitSlop={10} style={s.undoSnackClose}>
                      <Feather name="x" size={14} color="rgba(255,255,255,0.6)" />
                    </Pressable>
                  </View>
                  {/* Task #1639 — cap the visible rows so a long history
                      doesn't push the snackbar off-screen. The ScrollView
                      reveals older entries on swipe; keepScrollPosition
                      defaults to top so the oldest edit is the first one
                      visible (matches the chronological list order). */}
                  <ScrollView
                    style={s.undoSnackScroll}
                    contentContainerStyle={s.undoSnackScrollContent}
                    showsVerticalScrollIndicator={undoStack.length > 5}
                    nestedScrollEnabled
                  >
                    {undoStack.map((entry, idx) => (
                      <View key={idx} style={s.undoSnackRow}>
                        {/* Task #2031 — long-pressing the row reveals the
                            absolute clock time (e.g. "8:32:14 PM") in a
                            small popover so the player can pin down the
                            exact moment of an edit once the relative
                            label has rolled over to "1m ago" / "2m ago".
                            The relative label keeps ticking unchanged. */}
                        <Pressable
                          style={s.undoSnackRowLabel}
                          onLongPress={() => showUndoAbsTime(idx)}
                          delayLongPress={400}
                          hitSlop={6}
                          accessibilityHint="Long-press to see the exact time"
                        >
                          <Text style={s.undoSnackRowText} numberOfLines={1}>
                            {entry.message}
                          </Text>
                          <Text style={s.undoSnackRowTime}>
                            {formatRelativeTime(entry.ts)}
                          </Text>
                          {undoAbsTimeIdx === idx && (
                            <View
                              style={s.undoSnackAbsTimeBubble}
                              pointerEvents="none"
                            >
                              <Text style={s.undoSnackAbsTimeText}>
                                {formatAbsoluteTime(entry.ts)}
                              </Text>
                            </View>
                          )}
                        </Pressable>
                        <Pressable
                          onPress={() => runUndoEntry(idx)}
                          hitSlop={10}
                          style={s.undoSnackRowBtn}
                        >
                          <Text style={s.undoSnackBtnText}>UNDO</Text>
                        </Pressable>
                      </View>
                    ))}
                  </ScrollView>
                </View>
              </View>
            );
          }
          return (
            <View style={s.undoSnack} pointerEvents="box-none">
              <View style={s.undoSnackInner}>
                <Feather name="rotate-ccw" size={14} color="#bae6fd" />
                <Text style={s.undoSnackText}>{top.message}</Text>
                {extra > 0 && (
                  <Pressable
                    onPress={() => setUndoExpanded(true)}
                    hitSlop={6}
                    accessibilityLabel={`Show ${undoStack.length} pending edits`}
                  >
                    <Text style={s.undoSnackBadge}>
                      +{extra} more
                    </Text>
                  </Pressable>
                )}
                <Pressable
                  onPress={popAndRunUndo}
                  hitSlop={10}
                  style={s.undoSnackBtn}
                >
                  {/* Intentionally not gated by `shotEditBusy` (Task #1177)
                      so a player can rapid-fire UNDO through the stack
                      without each press being dropped while a previous
                      revert PATCH is still in flight. */}
                  <Text style={s.undoSnackBtnText}>UNDO</Text>
                </Pressable>
                <Pressable onPress={dismissUndoToast} hitSlop={10} style={s.undoSnackClose}>
                  <Feather name="x" size={14} color="rgba(255,255,255,0.6)" />
                </Pressable>
              </View>
            </View>
          );
        })()}
      </View>
    </Modal>
  );
}

// ── Draggable shot marker (Task #705) ────────────────────────────────────────
// Sits on top of the SVG shot circle; tap toggles selection, drag commits a
// new lat/lng via PATCH /api/portal/shots/:id. Distinguishes tap from drag
// using a small movement threshold so the existing tap-to-edit flow still
// works for users who never drag.
function DraggableShotMarker({
  shot, x, y, mpp, refLat, busy, onSelect, onDragMove, onDragEnd, onDragCancel,
}: {
  shot: ShotRow;
  x: number; y: number;
  mpp: number; refLat: number;
  busy: boolean;
  onSelect: (id: number) => void;
  onDragMove: (id: number, lat: number, lng: number) => void;
  onDragEnd: (id: number, lat: number, lng: number) => void;
  onDragCancel: () => void;
}) {
  const startRef = useRef<{ lat: number; lng: number; moved: boolean }>({ lat: 0, lng: 0, moved: false });
  const responder = React.useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => !busy,
    onMoveShouldSetPanResponder: (_, gs) => !busy && (Math.abs(gs.dx) > 2 || Math.abs(gs.dy) > 2),
    onPanResponderGrant: () => {
      startRef.current = {
        lat: shot.latitude ? parseFloat(shot.latitude) : 0,
        lng: shot.longitude ? parseFloat(shot.longitude) : 0,
        moved: false,
      };
    },
    onPanResponderMove: (_, gs) => {
      if (Math.abs(gs.dx) > 3 || Math.abs(gs.dy) > 3) startRef.current.moved = true;
      const delta = pxToLatLng(gs.dx, gs.dy, mpp, refLat);
      onDragMove(shot.id, startRef.current.lat + delta.lat, startRef.current.lng + delta.lng);
    },
    onPanResponderRelease: (_, gs) => {
      if (!startRef.current.moved) {
        // Tap, not drag — clear any tentative override and toggle selection.
        onDragCancel();
        onSelect(shot.id);
        return;
      }
      const delta = pxToLatLng(gs.dx, gs.dy, mpp, refLat);
      onDragEnd(shot.id, startRef.current.lat + delta.lat, startRef.current.lng + delta.lng);
    },
    onPanResponderTerminate: () => {
      onDragCancel();
    },
  }), [shot.id, shot.latitude, shot.longitude, mpp, refLat, busy, onSelect, onDragMove, onDragEnd, onDragCancel]);

  return (
    <View
      {...responder.panHandlers}
      style={[s.shotHit, { left: x - 16, top: y - 16 }]}
    />
  );
}

// ── Wind Compass Component ──────────────────────────────────────────────────
function WindCompass({ windDir, windSpeed, size = 60 }: { windDir: number; windSpeed: number; size?: number }) {
  const arrowLen = size * 0.38;
  const cx = size / 2, cy = size / 2;
  const angleRad = ((windDir + 180) % 360) * Math.PI / 180; // wind blows TOWARD this direction
  const ax = cx + Math.sin(angleRad) * arrowLen;
  const ay = cy - Math.cos(angleRad) * arrowLen;
  const color = windSpeed > 30 ? "#EF4444" : windSpeed > 15 ? "#FBBF24" : "#10B981";

  return (
    <Svg width={size} height={size}>
      <Circle cx={cx} cy={cy} r={size / 2 - 1} fill="rgba(0,0,0,0.55)" stroke="rgba(255,255,255,0.2)" strokeWidth={1} />
      {/* Cardinal labels */}
      <SvgText x={cx} y={6} textAnchor="middle" fontSize={7} fill="rgba(255,255,255,0.5)">N</SvgText>
      <SvgText x={cx} y={size - 1} textAnchor="middle" fontSize={7} fill="rgba(255,255,255,0.5)">S</SvgText>
      <SvgText x={4} y={cy + 3} textAnchor="middle" fontSize={7} fill="rgba(255,255,255,0.5)">W</SvgText>
      <SvgText x={size - 4} y={cy + 3} textAnchor="middle" fontSize={7} fill="rgba(255,255,255,0.5)">E</SvgText>
      {/* Wind arrow */}
      <Line x1={cx} y1={cy} x2={ax} y2={ay} stroke={color} strokeWidth={2.5} strokeLinecap="round" />
      {/* Arrowhead */}
      <Polygon
        points={`${ax},${ay} ${ax - 4 * Math.cos(angleRad + Math.PI / 6)},${ay + 4 * Math.sin(angleRad + Math.PI / 6)} ${ax - 4 * Math.cos(angleRad - Math.PI / 6)},${ay + 4 * Math.sin(angleRad - Math.PI / 6)}`}
        fill={color}
      />
      {/* Centre dot */}
      <Circle cx={cx} cy={cy} r={3} fill={color} />
    </Svg>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0a0f1a" },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingVertical: 14, paddingTop: 52, borderBottomWidth: 1, borderBottomColor: "rgba(255,255,255,0.1)" },
  headerTitle: { fontSize: 18, fontWeight: "700", color: "#fff" },
  headerSub: { fontSize: 13, color: "rgba(255,255,255,0.5)", marginTop: 1 },
  closeBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: "rgba(255,255,255,0.1)", alignItems: "center", justifyContent: "center" },
  mapContainer: { position: "relative", backgroundColor: "#0a1a0a", overflow: "hidden" },
  loadingOverlay: { alignItems: "center", justifyContent: "center", backgroundColor: "rgba(10,15,26,0.7)" },
  loadingText: { color: "rgba(255,255,255,0.6)", fontSize: 13, marginTop: 8 },
  fallbackBg: { alignItems: "center", justifyContent: "center", backgroundColor: "rgba(0,60,20,0.5)" },
  fallbackText: { fontSize: 28, marginBottom: 8 },
  fallbackSub: { fontSize: 13, color: "rgba(255,255,255,0.5)", textAlign: "center", paddingHorizontal: 32 },
  pinMarker: { position: "absolute", width: 32, height: 40, alignItems: "center", justifyContent: "flex-end" },
  windWidget: { position: "absolute", top: 10, right: 10, alignItems: "center", backgroundColor: "rgba(0,0,0,0.6)", borderRadius: 12, padding: 8, borderWidth: 1, borderColor: "rgba(255,255,255,0.15)" },
  windText: { color: "#fff", fontSize: 10, fontWeight: "700", marginTop: 3 },
  windDir: { color: "rgba(255,255,255,0.5)", fontSize: 9, marginTop: 1 },
  dragHint: { position: "absolute", bottom: 8, left: 0, right: 0, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 4 },
  dragHintText: { color: "rgba(255,255,255,0.5)", fontSize: 10 },
  threeDBtn: { position: "absolute", top: 12, right: 12, flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: "rgba(0,0,0,0.65)", paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6, borderWidth: 1, borderColor: "rgba(255,255,255,0.25)" },
  threeDBtnText: { color: "#fff", fontSize: 11, fontWeight: "600" },
  cachedBanner: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6,
    paddingVertical: 5, paddingHorizontal: 10,
    backgroundColor: "rgba(251,191,36,0.12)",
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "rgba(251,191,36,0.4)",
  },
  cachedBannerText: { color: "#FBBF24", fontSize: 11, fontWeight: "600", letterSpacing: 0.3 },
  // Task #1350 — small "Report an error" deep-link to the portal correction
  // form, shown under the hole header.
  reportLink: {
    flexDirection: "row", alignItems: "center", gap: 4,
    paddingVertical: 6, paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgba(255,255,255,0.05)",
  },
  reportLinkText: {
    color: "rgba(251,191,36,0.85)", fontSize: 11, fontWeight: "600",
    textDecorationLine: "underline",
  },
  distPanel: { flex: 1, padding: 16 },
  distRow: { flexDirection: "row", gap: 12, marginBottom: 12 },
  distItem: { alignItems: "center", minWidth: 72 },
  distItemSm: { alignItems: "center", minWidth: 60 },
  distLabel: { fontSize: 10, color: "rgba(255,255,255,0.5)", letterSpacing: 0.8, marginBottom: 2 },
  distVal: { fontSize: 28, fontWeight: "800" },
  distUnit: { fontSize: 11, color: "rgba(255,255,255,0.5)" },
  distLabelSm: { fontSize: 10, color: "rgba(255,255,255,0.4)" },
  distValSm: { fontSize: 12, color: "rgba(255,255,255,0.5)" },
  noDistText: { color: "rgba(255,255,255,0.4)", fontSize: 14, textAlign: "center", marginVertical: 12 },
  windRow: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 12, backgroundColor: "rgba(255,255,255,0.06)", borderRadius: 8, padding: 10 },
  windRowText: { fontSize: 13, color: "rgba(255,255,255,0.7)", flex: 1 },
  layupRow: { flexDirection: "row", gap: 8, marginBottom: 12 },
  layupBadge: { flex: 1, alignItems: "center", backgroundColor: "rgba(201,168,76,0.12)", borderRadius: 8, paddingVertical: 8, borderWidth: 1, borderColor: "rgba(201,168,76,0.25)" },
  layupBadgeText: { fontSize: 15, fontWeight: "700", color: "#C9A84C" },
  layupBadgeSub: { fontSize: 10, color: "rgba(255,255,255,0.4)", marginTop: 2 },
  noGpsBanner: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: "rgba(251,191,36,0.08)", borderRadius: 8, padding: 10, borderWidth: 1, borderColor: "rgba(251,191,36,0.2)", marginTop: 8 },
  noGpsBannerText: { fontSize: 12, color: "rgba(255,255,255,0.6)", flex: 1 },
  shotHit: { position: "absolute", width: 32, height: 32, borderRadius: 16, backgroundColor: "transparent" },
  shotsPanel: { backgroundColor: "rgba(14,165,233,0.08)", borderRadius: 10, borderWidth: 1, borderColor: "rgba(14,165,233,0.25)", padding: 10, marginBottom: 12 },
  shotsHeader: { flexDirection: "row", alignItems: "center", gap: 6 },
  shotsHeaderText: { color: "#bae6fd", fontSize: 13, fontWeight: "700" },
  shotsHeaderHint: { color: "rgba(255,255,255,0.4)", fontSize: 11, marginLeft: 6 },
  shotEditor: { marginTop: 10, padding: 10, backgroundColor: "rgba(10,20,34,0.7)", borderRadius: 8, borderWidth: 1, borderColor: "rgba(14,165,233,0.3)" },
  shotEditorTitleRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 8 },
  shotEditorTitle: { color: "#fff", fontSize: 13, fontWeight: "700" },
  shotEditorLabel: { color: "rgba(255,255,255,0.5)", fontSize: 11, marginBottom: 4 },
  clubRow: { flexDirection: "row", gap: 6 },
  clubChip: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 14, borderWidth: 1, borderColor: "rgba(255,255,255,0.15)", backgroundColor: "rgba(255,255,255,0.05)" },
  clubChipActive: { backgroundColor: "rgba(201,168,76,0.2)", borderColor: "#C9A84C" },
  clubChipText: { fontSize: 11, color: "rgba(255,255,255,0.7)", fontWeight: "600" },
  clubChipTextActive: { color: "#C9A84C" },
  shotEditorActions: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 10 },
  editBtn: { flexDirection: "row", alignItems: "center", paddingHorizontal: 8, paddingVertical: 6, borderRadius: 6, borderWidth: 1 },
  editBtnText: { fontSize: 11, fontWeight: "600" },
  undoSnack: { position: "absolute", left: 0, right: 0, bottom: 24, alignItems: "center", paddingHorizontal: 16 },
  undoSnackInner: { flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: "rgba(15,23,42,0.96)", borderRadius: 10, paddingVertical: 10, paddingHorizontal: 14, borderWidth: 1, borderColor: "rgba(14,165,233,0.45)", shadowColor: "#000", shadowOpacity: 0.4, shadowRadius: 8, shadowOffset: { width: 0, height: 4 }, elevation: 6 },
  undoSnackText: { color: "#fff", fontSize: 13, fontWeight: "600", marginRight: 4 },
  undoSnackBadge: {
    color: "#bae6fd",
    fontSize: 11,
    fontWeight: "700",
    backgroundColor: "rgba(14,165,233,0.18)",
    borderRadius: 999,
    paddingHorizontal: 6,
    paddingVertical: 2,
    overflow: "hidden",
    marginRight: 2,
  },
  undoSnackBtn: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 6, borderWidth: 1, borderColor: "#0EA5E9", backgroundColor: "rgba(14,165,233,0.15)" },
  undoSnackBtnText: { color: "#bae6fd", fontSize: 12, fontWeight: "700", letterSpacing: 0.6 },
  undoSnackClose: { padding: 4 },
  // Task #1366 — expanded view styles for the per-entry undo list.
  undoSnackExpanded: {
    backgroundColor: "rgba(15,23,42,0.96)",
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: "rgba(14,165,233,0.45)",
    shadowColor: "#000",
    shadowOpacity: 0.4,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
    minWidth: 280,
    maxWidth: 360,
  },
  undoSnackHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingBottom: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgba(255,255,255,0.1)",
    marginBottom: 6,
  },
  undoSnackHeaderText: {
    color: "#fff",
    fontSize: 13,
    fontWeight: "700",
    flex: 1,
  },
  undoSnackHide: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.2)",
  },
  undoSnackHideText: {
    color: "rgba(255,255,255,0.7)",
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 0.6,
  },
  // Task #2032 — "UNDO ALL" affordance in the expanded snackbar header.
  // Visually a touch louder than HIDE since it's the destructive bulk
  // action, but kept compact so it doesn't crowd the row on narrow phones.
  undoSnackUndoAll: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: "rgba(186,230,253,0.45)",
    backgroundColor: "rgba(186,230,253,0.12)",
  },
  undoSnackUndoAllText: {
    color: "#bae6fd",
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 0.6,
  },
  // Task #1639 — caps the expanded list at ~5 visible rows (each ~32pt
  // tall including padding) before scrolling. Keeps the snackbar from
  // pushing the rest of the map UI off-screen when the player has a deep
  // edit history.
  undoSnackScroll: {
    maxHeight: 180,
  },
  undoSnackScrollContent: {
    paddingRight: 2,
  },
  undoSnackRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 6,
  },
  // Task #2031 — wraps the message + relative-time labels in a single
  // long-pressable region so the absolute clock time bubble can anchor
  // above the row. `position: relative` is the anchor for the bubble's
  // absolute positioning.
  undoSnackRowLabel: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    position: "relative",
  },
  undoSnackRowText: {
    color: "rgba(255,255,255,0.9)",
    fontSize: 13,
    flex: 1,
  },
  // Task #1638 — relative timestamp on each expanded-list row
  // ("just now", "5s ago"). Sits between the message and the per-entry
  // UNDO button.
  undoSnackRowTime: {
    color: "rgba(255,255,255,0.55)",
    fontSize: 11,
    fontVariant: ["tabular-nums"],
  },
  // Task #2031 — small popover that appears above a long-pressed row in
  // the expanded undo list, showing the absolute clock time of the edit
  // (e.g. "8:32:14 PM"). Anchored to undoSnackRowLabel via absolute
  // positioning so it floats over the snackbar without reflowing it.
  undoSnackAbsTimeBubble: {
    position: "absolute",
    bottom: "100%",
    left: 0,
    marginBottom: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    backgroundColor: "rgba(15,23,42,0.95)",
    borderWidth: 1,
    borderColor: "rgba(186,230,253,0.35)",
  },
  undoSnackAbsTimeText: {
    color: "#bae6fd",
    fontSize: 11,
    fontVariant: ["tabular-nums"],
  },
  undoSnackRowBtn: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: "#0EA5E9",
    backgroundColor: "rgba(14,165,233,0.15)",
  },
});
